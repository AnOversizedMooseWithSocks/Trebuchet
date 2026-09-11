// Demo-runtime launch execution for the Trebuchet CLI.
//
// Runs a complete launch end-to-end on Trebuchet's built-in demo chain:
// the CLI boots the local Trebuchet server in an isolated temp config
// (demo mode on, no real RPC, no funds), generates a fresh demo-managed
// launch wallet, and drives the server's /api/v2/demo-launch/run
// endpoint with the operator's launch config.
//
// This is deliberately demo-only. Live (mainnet/devnet) execution from
// the CLI stays blocked behind the Core custody gate described in
// packages/cli/README.md: custody, journal, idempotency, and
// non-interactive confirmation contracts must move into Core and pass
// a complete funded devnet recovery cycle first.
//
// The demo launch wallet's secret key lives only inside the spawned
// server process and is destroyed with it. Nothing secret is written
// to disk by the CLI — the run result contains public data only.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLI_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CLI_DIR, '..', '..', '..');

export const DEMO_RUN_SCHEMA = 'trebuchet-demo-launch-run/v1';

export class ExecuteError extends Error {
  constructor(message, { serverLog } = {}) {
    super(message);
    this.name = 'ExecuteError';
    this.serverLog = serverLog;
  }
}

export function resolveServerPath(override) {
  if (override) return path.resolve(override);
  return path.join(REPO_ROOT, 'server.js');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(baseUrl, pathname, { token, method = 'GET', body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { 'x-trebuchet-session': token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    return { status: response.status, ok: response.ok, payload, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a full demo launch. Returns a summary with public fields only.
 *
 * Options:
 *   configPath  path to the launch config (launch.json)
 *   outPath     optional path to write the full run result JSON
 *   serverPath  optional override for server.js (defaults to repo server.js)
 *   timeoutMs   overall run timeout (default 300000)
 *   onLog       optional progress callback: (message: string) => void
 */
export async function runDemoExecute({
  configPath,
  outPath = null,
  serverPath = null,
  timeoutMs = 300_000,
  onLog = () => {},
} = {}) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new ExecuteError(`Could not read launch config: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || typeof config.token !== 'object') {
    throw new ExecuteError('Launch config must contain a token object.');
  }

  const serverFile = resolveServerPath(serverPath);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-cli-execute-'));
  writeFileSync(
    path.join(configDir, 'userPrefs.json'),
    JSON.stringify({
      demoMode: true,
      playIntroVideo: false,
      playSoundEffects: false,
      playBackgroundMusic: false,
      coinPreview: false,
    }, null, 2),
  );

  const server = spawn(process.execPath, [serverFile], {
    cwd: path.dirname(serverFile),
    env: {
      ...process.env,
      PORT: String(port),
      TREBUCHET_CONFIG_DIR: configDir,
      DEMO_TIME_SCALE: '0.01',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  server.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  server.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });
  const serverExit = new Promise((resolve) => server.on('exit', (code, signal) => resolve({ code, signal })));

  try {
    onLog('Booting local Trebuchet server (demo mode)…');

    // Handshake: poll /api/session until the server is ready.
    let token = null;
    const bootDeadline = Date.now() + 60_000;
    for (;;) {
      if (Date.now() > bootDeadline) {
        throw new ExecuteError('Local server did not become ready within 60 seconds.', { serverLog });
      }
      // Did the server already exit? Race the exit promise against a tick
      // so a healthy server keeps the loop going.
      const exited = await Promise.race([
        serverExit.then(() => true),
        wait(0).then(() => false),
      ]);
      if (exited) {
        throw new ExecuteError('Local server exited during startup.', { serverLog });
      }
      let probe = null;
      try {
        probe = await fetchJson(baseUrl, '/api/session', { timeoutMs: 2_000 });
      } catch {
        // Server not listening yet — keep polling.
        await wait(300);
        continue;
      }
      if (probe.ok && probe.payload?.token) {
        token = probe.payload.token;
        break;
      }
      await wait(300);
    }
    onLog('Server ready. Generating a disposable demo launch wallet…');

    const walletResponse = await fetchJson(baseUrl, '/api/v2/wallets/generate', {
      token,
      method: 'POST',
      timeoutMs: 30_000,
    });
    if (!walletResponse.ok || !walletResponse.payload?.wallet?.publicKey) {
      throw new ExecuteError(`Wallet generation failed: ${walletResponse.text?.slice(0, 500)}`, { serverLog });
    }
    const walletPublicKey = walletResponse.payload.wallet.publicKey;

    onLog(`Wallet ${walletPublicKey}. Running the full demo launch…`);
    const runResponse = await fetchJson(baseUrl, '/api/v2/demo-launch/run', {
      token,
      method: 'POST',
      timeoutMs,
      body: {
        config: { ...config, walletPublicKey },
        walletPublicKey,
      },
    });

    if (!runResponse.ok || !runResponse.payload?.success) {
      throw new ExecuteError(
        `Demo launch failed: ${runResponse.payload?.error || runResponse.text?.slice(0, 1000)}`,
        { serverLog },
      );
    }

    const run = runResponse.payload.run;
    const result = {
      schema: DEMO_RUN_SCHEMA,
      runtime: 'demo',
      run,
    };
    const pools = Array.isArray(run?.liquidity?.results) ? run.liquidity.results.length : null;
    const summary = {
      runtime: 'demo',
      runId: run?.id ?? null,
      walletPublicKey,
      tokenMint: run?.token?.tokenMint ?? run?.token?.mint ?? null,
      poolCount: pools,
      sweepDestination: run?.transfer?.destinationWallet ?? null,
      completedAt: run?.completedAt ?? null,
    };

    if (outPath) {
      const { writeJsonFileAtomic } = await import('./files.js');
      summary.outputPath = await writeJsonFileAtomic(outPath, result);
    }
    return summary;
  } finally {
    server.kill('SIGTERM');
    await Promise.race([serverExit, wait(10_000)]);
    rmSync(configDir, { recursive: true, force: true });
  }
}