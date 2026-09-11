#!/usr/bin/env node
// Sealed launch runner — the operator-owned execution environment.
//
// DEPLOYMENT MODEL
//   Each operator deploys their own runner (one `fly launch`), guarded
//   by a per-deployment bearer token. The static public site attaches to
//   the runner the operator points it at. The runner never hosts the
//   public site and the public site never holds keys: wallets are
//   generated inside the runner's ephemeral state dir and destroyed
//   with the machine.
//
// CURRENT STATE (honest gate)
//   Packet upload + full hash verification is live. Launch execution is
//   deliberately NOT wired yet: it stays behind the Core custody gate
//   (signed confirmation contract, custody backend, idempotency state
//   machine, funded devnet recovery cycle — see
//   docs/secure-launch-packet.md). Until that lands, POST /v1/launches
//   answers 503 NOT_READY with the gate description. The API contract
//   below is the surface the execution work will fill in.
//
// API (all routes except /v1/health require `Authorization: Bearer <TREBUCHET_RUNNER_TOKEN>`):
//   GET  /v1/health            public liveness + capability report
//   POST /v1/attach           operator handshake; returns runner identity
//   POST /v1/packets          upload a launch packet archive (tar.gz);
//                             verifies every manifest hash before storing
//   POST /v1/launches         { packetId } — gated: 503 until the Core
//                             custody gate opens
//   GET  /v1/launches/:id     launch status (none can exist yet)
//   GET  /v1/launches/:id/proof   proof download (none can exist yet)

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TREBUCHET_CORE_VERSION } from '@trebuchet/core';
import { extractPacketArchive, verifyPacketDir, locatePacketRoot, PacketError } from './packet.js';

export const RUNNER_SCHEMA = 'trebuchet-sealed-runner/v1';
export const LIVE_GATE_MESSAGE =
  'Launch execution is not wired yet: the signed confirmation contract, custody backend, '
  + 'idempotency state machine, and a complete funded devnet recovery cycle must land in Core first '
  + '(docs/secure-launch-packet.md). Packet upload and verification are live.';

const MAX_PACKET_BYTES = 20 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;

function tokenMatches(expected, provided) {
  if (!expected || !provided) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error(`request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function readJsonBody(req, limit = MAX_JSON_BYTES) {
  return readBody(req, limit).then((buf) => {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      throw new Error('request body is not valid JSON');
    }
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * Create the runner HTTP server. Options:
 *   token       bearer token required on all non-health routes (required)
 *   stateDir    ephemeral packet/launch state (default: /tmp/trebuchet-runner)
 *   coreVersion override reported Core version (tests)
 */
export function createRunnerServer({ token, stateDir, coreVersion = TREBUCHET_CORE_VERSION } = {}) {
  if (!token || typeof token !== 'string') {
    throw new Error('createRunnerServer requires a token');
  }
  const state = path.resolve(stateDir || '/tmp/trebuchet-runner');
  fs.mkdirSync(path.join(state, 'packets'), { recursive: true });

  const runnerId = `runner_${crypto.randomUUID().slice(0, 12)}`;
  const launches = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://runner.local');
    const route = `${req.method} ${url.pathname}`;

    try {
      if (route === 'GET /v1/health') {
        return sendJson(res, 200, {
          ok: true,
          schema: RUNNER_SCHEMA,
          runnerId,
          coreVersion,
          capabilities: ['attach', 'packet-verify'],
          liveExecution: { enabled: false, gate: LIVE_GATE_MESSAGE },
        });
      }

      // Everything below requires the runner token.
      const provided = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tokenMatches(token, provided)) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }

      if (route === 'POST /v1/attach') {
        return sendJson(res, 200, {
          ok: true,
          schema: RUNNER_SCHEMA,
          runnerId,
          coreVersion,
          capabilities: ['attach', 'packet-verify'],
          note: 'Packet upload and verification are live. Launch execution is gated.',
          liveExecution: { enabled: false, gate: LIVE_GATE_MESSAGE },
        });
      }

      if (route === 'POST /v1/packets') {
        const archive = await readBody(req, MAX_PACKET_BYTES);
        if (!archive.length) return sendJson(res, 400, { ok: false, error: 'empty body' });
        const packetId = crypto.createHash('sha256').update(archive).digest('hex').slice(0, 24);
        const dir = path.join(state, 'packets', packetId);
        fs.mkdirSync(dir, { recursive: true });
        const archivePath = path.join(dir, 'packet.tar.gz');
        await fsp.writeFile(archivePath, archive, { mode: 0o600 });
        try {
          const extractDir = path.join(dir, 'extract');
          fs.mkdirSync(extractDir, { recursive: true });
          await extractPacketArchive(archivePath, extractDir);
          const verified = await verifyPacketDir(locatePacketRoot(extractDir));
          return sendJson(res, 201, {
            ok: true,
            packetId,
            planDigest: verified.digest,
            token: verified.launchConfig?.token
              ? {
                name: verified.launchConfig.token.name ?? null,
                symbol: verified.launchConfig.token.symbol ?? null,
              }
              : null,
            files: verified.files,
          });
        } catch (error) {
          // A packet that fails verification is deleted immediately and
          // never becomes launchable.
          await fsp.rm(dir, { recursive: true, force: true });
          const status = error instanceof PacketError ? 422 : 500;
          return sendJson(res, status, { ok: false, error: error.message });
        }
      }

      if (route === 'POST /v1/launches') {
        const body = await readJsonBody(req).catch(() => null);
        const packetId = String(body?.packetId || '').trim();
        if (!packetId) return sendJson(res, 400, { ok: false, error: 'packetId required' });
        if (!fs.existsSync(path.join(state, 'packets', packetId))) {
          return sendJson(res, 404, { ok: false, error: 'unknown packetId — upload it first' });
        }
        // The gate: execution is not wired until the Core contracts land.
        return sendJson(res, 503, {
          ok: false,
          error: { code: 'NOT_READY', message: LIVE_GATE_MESSAGE },
          packetId,
        });
      }

      const launchMatch = url.pathname.match(/^\/v1\/launches\/([^/]+)$/);
      if (launchMatch) {
        const launch = launches.get(launchMatch[1]);
        if (!launch) return sendJson(res, 404, { ok: false, error: 'unknown launch' });
        return sendJson(res, 200, { ok: true, launch });
      }
      const proofMatch = url.pathname.match(/^\/v1\/launches\/([^/]+)\/proof$/);
      if (proofMatch) {
        if (!launches.get(proofMatch[1])) return sendJson(res, 404, { ok: false, error: 'unknown launch' });
        return sendJson(res, 404, { ok: false, error: 'no proof yet — execution is gated' });
      }

      return sendJson(res, 404, { ok: false, error: 'not found' });
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: error.message || 'unexpected runner failure' });
    }
  });

  return { server, runnerId, stateDir: state, launches };
}

// --- CLI entry ---------------------------------------------------------

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const token = process.env.TREBUCHET_RUNNER_TOKEN;
  if (!token) {
    console.error('TREBUCHET_RUNNER_TOKEN is required. Generate one with, for example:');
    console.error('  fly secrets set TREBUCHET_RUNNER_TOKEN="$(openssl rand -hex 32)"');
    process.exit(2);
  }
  const port = Number(process.env.PORT || 8080);
  const { server, runnerId } = createRunnerServer({ token });
  server.listen(port, '0.0.0.0', () => {
    console.log(`Trebuchet sealed runner ${runnerId} listening on :${port} (packet verification live, launches gated)`);
  });
}