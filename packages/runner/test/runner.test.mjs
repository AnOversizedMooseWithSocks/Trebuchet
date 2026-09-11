import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildV2LaunchPlan } from '@trebuchet/core/launch-plan';
import { createRunnerServer } from '../src/server.mjs';
import { verifyPacketDir } from '../src/packet.js';

const ROOT = path.resolve(path.dirname(import.meta.url), '..', '..', '..');
const TOKEN = 'test-runner-token';

function makeDir(name) {
  return mkdtempSync(path.join(tmpdir(), `trebuchet-runner-${name}-`));
}

async function startRunner(t) {
  const stateDir = makeDir('state');
  const { server, runnerId } = createRunnerServer({ token: TOKEN, stateDir });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const authed = (pathname, init = {}) => ({
    ...init,
    headers: {
      ...(init.headers || {}),
      authorization: `Bearer ${TOKEN}`,
      ...(init.body && !(init.body instanceof Buffer) ? { 'content-type': 'application/json' } : {}),
    },
  });
  return { base, stateDir, runnerId, authed };
}

const launchIntent = {
  token: {
    name: 'Runner Test',
    symbol: 'RUNT',
    supply: '1000000',
    description: 'runner packet test',
  },
  mode: 'dry-run',
  launchSol: 1,
  walletPublicKey: '11111111111111111111111111111115',
  poolTopology: {
    targetMarketCapUsd: 250000,
    pools: [{
      quoteSymbol: 'SOL',
      quoteMint: 'So11111111111111111111111111111111111111112',
      supplyPercent: 100,
      distribution: [{ sharePercent: 100 }],
      ladder: { mode: 'off' },
      support: { mode: 'off' },
    }],
    sweepDestination: '11111111111111111111111111111116',
  },
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function buildPacketArchive(dir, { tamper = null } = {}) {
  const packetDir = path.join(dir, 'packet');
  mkdirSync(packetDir, { recursive: true });
  const plan = buildV2LaunchPlan(launchIntent);
  const config = launchIntent;
  const files = [];
  const addFile = (name, contents) => {
    writeFileSync(path.join(packetDir, name), contents);
    files.push({ path: name, bytes: contents.length, sha256: sha256(contents) });
  };
  const manifest = {
    schema: 'trebuchet-launch-packet/v1',
    packet: 'runner-test',
    created: new Date().toISOString(),
    token: { name: launchIntent.token.name, symbol: launchIntent.token.symbol },
    planDigest: plan.integrity.digest,
    files,
    security: { containsPrivateKeys: false },
  };
  addFile('launch.json', Buffer.from(JSON.stringify(config, null, 2)));
  addFile('plan.json', Buffer.from(JSON.stringify(plan, null, 2)));
  // manifest itself is hashed after being written
  const manifestContents = Buffer.from(JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(packetDir, 'manifest.json'), manifestContents);

  if (tamper === 'plan') {
    // Rewrite plan.json so its bytes no longer match the manifest hash.
    const broken = JSON.parse(readFileSync(path.join(packetDir, 'plan.json'), 'utf8'));
    broken.funding.estimatedSolCost += 1;
    writeFileSync(path.join(packetDir, 'plan.json'), JSON.stringify(broken, null, 2));
  }

  const archive = path.join(dir, 'packet.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', dir, 'packet']);
  return archive;
}

test('health is public and reports the execution gate', async (t) => {
  const { base } = await startRunner(t);
  const response = await fetch(`${base}/v1/health`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schema, 'trebuchet-sealed-runner/v1');
  assert.equal(payload.liveExecution.enabled, false);
  assert.match(payload.liveExecution.gate, /devnet recovery cycle/);
  assert.deepEqual(payload.capabilities, ['attach', 'packet-verify']);
});

test('non-health routes reject missing or wrong bearer tokens', async (t) => {
  const { base } = await startRunner(t);
  const noToken = await fetch(`${base}/v1/attach`, { method: 'POST' });
  assert.equal(noToken.status, 401);
  const wrongToken = await fetch(`${base}/v1/attach`, {
    method: 'POST',
    headers: { authorization: 'Bearer nope' },
  });
  assert.equal(wrongToken.status, 401);
});

test('a valid packet uploads, verifies, and becomes launchable input', async (t) => {
  const work = makeDir('work');
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const archive = buildPacketArchive(work);
  const { base, authed, stateDir } = await startRunner(t);

  const upload = await fetch(`${base}/v1/packets`, authed('/v1/packets', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(archive),
  }));
  assert.equal(upload.status, 201);
  const payload = await upload.json();
  assert.ok(payload.packetId);
  assert.equal(payload.token.symbol, 'RUNT');
  assert.ok(payload.planDigest);
  assert.deepEqual(payload.files.sort(), ['launch.json', 'plan.json'].sort());
  assert.ok(
    readFileSync(path.join(stateDir, 'packets', payload.packetId, 'extract', 'packet', 'manifest.json'), 'utf8').length > 0,
  );

  // A tampered packet (bytes no longer match manifest hashes) is rejected
  // and deleted, never stored as launchable input.
  const tamperedArchive = buildPacketArchive(mktemp(path.join(work, 'tamper-')), { tamper: 'plan' });
  const rejected = await fetch(`${base}/v1/packets`, authed('/v1/packets', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(tamperedArchive),
  }));
  assert.equal(rejected.status, 422);
  const rejection = await rejected.json();
  assert.match(rejection.error, /hash mismatch/);
});

test('launch requests hit the custody gate with NOT_READY, unknown packets 404', async (t) => {
  const { base, authed } = await startRunner(t);
  const unknown = await fetch(`${base}/v1/launches`, authed('/v1/launches', {
    method: 'POST',
    body: JSON.stringify({ packetId: 'does-not-exist' }),
  }));
  assert.equal(unknown.status, 404);

  const work = makeDir('gate');
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const archive = buildPacketArchive(work);
  const upload = await fetch(`${base}/v1/packets`, authed('/v1/packets', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: readFileSync(archive),
  }));
  const { packetId } = await upload.json();

  const gated = await fetch(`${base}/v1/launches`, authed('/v1/launches', {
    method: 'POST',
    body: JSON.stringify({ packetId }),
  }));
  assert.equal(gated.status, 503);
  const payload = await gated.json();
  assert.equal(payload.error.code, 'NOT_READY');
  assert.match(payload.error.message, /devnet recovery cycle/);
});

test('verifyPacketDir rejects manifests that claim to carry private keys', async (t) => {
  const dir = makeDir('pk');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const plan = buildV2LaunchPlan(launchIntent);
  const configContents = Buffer.from(JSON.stringify(launchIntent));
  const planContents = Buffer.from(JSON.stringify(plan));
  writeFileSync(path.join(dir, 'launch.json'), configContents);
  writeFileSync(path.join(dir, 'plan.json'), planContents);
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema: 'trebuchet-launch-packet/v1',
    planDigest: plan.integrity.digest,
    files: [
      { path: 'launch.json', bytes: configContents.length, sha256: sha256(configContents) },
      { path: 'plan.json', bytes: planContents.length, sha256: sha256(planContents) },
    ],
    security: { containsPrivateKeys: true },
  }));
  await assert.rejects(() => verifyPacketDir(dir), /private keys/);
});

function mktemp(prefix) {
  return mkdtempSync(prefix);
}