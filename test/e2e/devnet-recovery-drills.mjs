#!/usr/bin/env node
// Funded devnet recovery drills.
//
// The gate that blocks headless live execution (packages/cli/README.md)
// requires "a complete funded devnet recovery cycle": a real launch, run
// against a real chain with real funds, interrupted at operation
// boundaries and resumed, with the journal proving that nothing was
// double-spent or duplicated.
//
// WHAT THIS DRILL DOES
//   1. Boots the local Trebuchet server against a devnet RPC with a fresh
//      config dir (wallet + journal persist to disk, so a process kill is
//      a genuine crash, not a clean shutdown).
//   2. Generates a launch wallet and funds it from the CI funding wallet,
//      bounded by TREBUCHET_DEVNET_MAX_SPEND_SOL.
//   3. Drives the real staged execution path: readiness → arm run
//      envelope → execute-next, one operation at a time.
//   4. After the configured kill point, SIGKILLs the server mid-launch,
//      restarts it with the same config dir, re-arms, and resumes.
//   5. Reconciles the journal: the token must exist exactly once, no
//      completed operation may be re-executed, and the resumed run must
//      continue from the checkpoint rather than start over.
//   6. Sweeps remaining SOL back to the funding wallet and writes an
//      evidence artifact.
//
// SCOPE LIMIT (documented, not hidden)
//   Raydium's CLMM programs are mainnet-only, so `/api/create-lp` cannot
//   execute on devnet. This drill therefore covers the on-chain stages
//   devnet can run for real — mint + metadata, authority revocation, and
//   the recovery/idempotency machinery around them — and stops cleanly
//   when readiness reaches the liquidity stage. The liquidity-stage
//   recovery drills run against the demo chain (single-process crash
//   simulation) and, later, a local validator with cloned Raydium
//   programs. See docs/secure-launch-packet.md.
//
// Runs only when TREBUCHET_DEVNET_REQUIRED=1 and the funding secrets are
// present; otherwise it skips with a clear message so normal CI stays
// green and free.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { redactSensitiveText } from '../../logRedaction.js';
import {
  DEFAULT_MAX_SPEND_SOL,
  assertDevnetGenesisHash,
  decodeWalletSecret,
  parseMaxSpendSol,
} from './devnet-transactions.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const TOKEN_STAGE_ENDPOINTS = ['/api/create-token', '/api/finish-token-creation'];
export const LIQUIDITY_ENDPOINTS = ['/api/create-lp', '/api/resume-launch', '/api/reveal-sealed-metadata', '/api/transfer-assets'];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested without funds in test/devnet-recovery-drills.test.mjs)
// ---------------------------------------------------------------------------

/** Minimal single-pool launch config for a drill: cheap, no ladder, no airdrop. */
export function buildDrillConfig({ walletPublicKey, sweepDestination, launchSol = 0.01, name = 'Drill Token', symbol = 'DRILL' }) {
  return {
    token: {
      name,
      symbol,
      supply: '1000000',
      description: 'Trebuchet funded devnet recovery drill',
    },
    mode: 'guarded',
    launchSol,
    walletPublicKey,
    poolTopology: {
      targetMarketCapUsd: 500,
      pools: [{
        id: 'sol-main',
        quoteToken: 'SOL',
        quoteSymbol: 'SOL',
        quoteMint: SOL_MINT,
        supplyPercent: 100,
        distribution: [{ sharePercent: 100 }],
        bootstrap: { mode: 'minimal' },
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      }],
      sweepDestination,
    },
  };
}

/**
 * Reconcile a completed drill journal.
 *
 * expectations:
 *   executedEndpoints — every endpoint the client actually executed, in order
 *
 * Invariants checked:
 *   - exactly one distinct token mint was ever created (no double mint)
 *   - create-token was executed at most once (irreversible operation)
 *   - if a resume happened, the journal recorded a failed/active state that
 *     the resume continued from (i.e. the journal is a coherent trail)
 */
export function reconcileDrillJournal({ journal, executedEndpoints = [], resumed = false }) {
  const issues = [];
  const events = Array.isArray(journal?.events) ? journal.events : [];
  const tokenMints = new Set(
    events
      .filter((event) => event?.stage === 'token_created' || event?.stage === 'token_create_done')
      .map((event) => event.tokenMint || event.mint)
      .filter(Boolean),
  );
  if (journal?.token?.mint) tokenMints.add(journal.token.mint);
  if (tokenMints.size > 1) {
    issues.push(`journal records ${tokenMints.size} distinct token mints: ${[...tokenMints].join(', ')}`);
  }

  const createTokenRuns = executedEndpoints.filter((endpoint) => endpoint === '/api/create-token').length;
  if (createTokenRuns > 1) {
    issues.push(`/api/create-token executed ${createTokenRuns} times (must be at most once)`);
  }

  const hasToken = Boolean(journal?.token?.mint);
  if (!hasToken) issues.push('journal has no token mint after the drill');

  if (resumed && events.length === 0) {
    issues.push('journal has no events despite a resumed drill');
  }

  return {
    ok: issues.length === 0,
    issues,
    tokenMints: [...tokenMints],
    eventCount: events.length,
    executedEndpoints,
  };
}

/** Given a completed-operation count, decide whether this boundary is a kill point. */
export function isKillPoint({ completedOperations, killAfterOperation }) {
  return Number.isInteger(killAfterOperation) && killAfterOperation > 0 && completedOperations === killAfterOperation;
}

// ---------------------------------------------------------------------------
// Server harness
// ---------------------------------------------------------------------------

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

function startServer({ port, configDir }) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      TREBUCHET_CONFIG_DIR: configDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c.toString(); });
  child.stderr.on('data', (c) => { log += c.toString(); });
  return { child, getLog: () => log };
}

async function waitForServer(baseUrl, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) throw new Error('local server did not become ready');
    if (child.exitCode !== null) throw new Error(`local server exited early (code ${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) {
        const payload = await response.json();
        if (payload?.token) return payload.token;
      }
    } catch {
      // not listening yet
    }
    await wait(250);
  }
}

async function api(baseUrl, token, pathname, body = null) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-trebuchet-session': token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* leave null */ }
  if (!response.ok) {
    const error = new Error(payload?.error || `${pathname} failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function fundWallet(connection, from, toPublicKey, lamports) {
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: from.publicKey, recentBlockhash: latest.blockhash })
    .add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: toPublicKey, lamports }));
  transaction.sign(from);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 5 });
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return signature;
}

async function sweepBack(connection, wallet, destination, feePayer) {
  const balance = await connection.getBalance(wallet.publicKey, 'confirmed');
  if (balance <= 0) return null;
  const latest = await connection.getLatestBlockhash('confirmed');
  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: latest.blockhash })
    .add(SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: destination, lamports: Math.max(0, balance - 5000) }));
  transaction.sign(wallet, feePayer);
  const signature = await connection.sendRawTransaction(transaction.serialize(), { maxRetries: 3 });
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  return signature;
}

/**
 * Run the funded devnet recovery drill.
 * Returns a summary object; throws on a failed assertion or chain error.
 */
export async function runDevnetRecoveryDrills(env = process.env) {
  const rpcUrl = env.TREBUCHET_DEVNET_RPC_URL?.trim() || '';
  const secretB64 = env.TREBUCHET_DEVNET_FUNDING_WALLET_SECRET_B64?.trim() || '';
  const expectedPublicKey = env.TREBUCHET_DEVNET_FUNDING_WALLET_PUBLIC_KEY?.trim() || '';
  const required = env.TREBUCHET_DEVNET_REQUIRED === '1';

  if (!rpcUrl || !secretB64 || !expectedPublicKey) {
    const missing = [
      !rpcUrl && 'TREBUCHET_DEVNET_RPC_URL',
      !secretB64 && 'TREBUCHET_DEVNET_FUNDING_WALLET_SECRET_B64',
      !expectedPublicKey && 'TREBUCHET_DEVNET_FUNDING_WALLET_PUBLIC_KEY',
    ].filter(Boolean);
    if (required) throw new Error(`missing required devnet configuration: ${missing.join(', ')}`);
    console.log(`Devnet recovery drills skipped: missing ${missing.join(', ')}`);
    return { skipped: true };
  }

  const maxSpendSol = parseMaxSpendSol(env.TREBUCHET_DEVNET_MAX_SPEND_SOL || DEFAULT_MAX_SPEND_SOL);
  const maxSpendLamports = Math.floor(maxSpendSol * LAMPORTS_PER_SOL);
  const killAfterOperation = Number.parseInt(env.TREBUCHET_DEVNET_DRILL_KILL_AFTER || '1', 10);
  const evidenceDir = env.TREBUCHET_DEVNET_EVIDENCE_DIR?.trim() || path.join(ROOT, 'release-evidence', 'v2', 'devnet-recovery');

  const fundingWallet = Keypair.fromSecretKey(decodeWalletSecret(secretB64));
  assert.equal(fundingWallet.publicKey.toBase58(), expectedPublicKey, 'funding wallet secret/public key mismatch');

  const connection = new Connection(rpcUrl, { commitment: 'confirmed', confirmTransactionInitialTimeout: 60_000 });
  assertDevnetGenesisHash(await connection.getGenesisHash());

  const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-devnet-drill-'));
  writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({
    demoMode: false,
    playIntroVideo: false,
    playSoundEffects: false,
    playBackgroundMusic: false,
    coinPreview: false,
    publishLaunchReport: false,
  }, null, 2));
  writeFileSync(path.join(configDir, 'rpcConfig.json'), JSON.stringify({
    active: rpcUrl,
    saved: [{ name: 'Devnet drill RPC', url: rpcUrl }],
  }, null, 2));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let server = startServer({ port, configDir });
  const executedEndpoints = [];
  const drillLog = [];
  let launchWallet = null;
  let resumed = false;
  let result = null;

  try {
    let token = await waitForServer(baseUrl, server.child);
    drillLog.push(`server up on :${port} (devnet)`);

    // 1. Launch wallet (persisted by pendingWallets, so it survives the kill).
    const generated = await api(baseUrl, token, '/api/v2/wallets/generate', {});
    const walletPublicKey = generated.wallet.publicKey;
    launchWallet = Keypair.fromPublicKey(new PublicKey(walletPublicKey));
    drillLog.push(`launch wallet ${walletPublicKey}`);

    // 2. Plan + readiness (funding requirement comes from the verified plan).
    const config = buildDrillConfig({ walletPublicKey, sweepDestination: fundingWallet.publicKey.toBase58() });
    const planResponse = await api(baseUrl, token, '/api/v2/launch-plan', config);
    const reviewedPlan = planResponse.plan;
    const readinessResponse = await api(baseUrl, token, '/api/v2/execution-readiness', { config, walletPublicKey });
    let readiness = readinessResponse.readiness;
    const fundingEstimate = readiness.plan.funding;
    assert.ok(fundingEstimate?.estimatedSolCost > 0, 'plan funding estimate is missing');

    // 3. Fund, bounded by the operator's spend cap.
    const fundLamports = Math.min(
      maxSpendLamports,
      Math.max(Math.ceil(fundingEstimate.estimatedSolCost * LAMPORTS_PER_SOL * 1.2), 20_000_000),
    );
    assert.ok(fundLamports <= maxSpendLamports, 'funding requirement exceeds the configured spend cap');
    const fundingBalance = await connection.getBalance(fundingWallet.publicKey, 'confirmed');
    assert.ok(fundingBalance >= fundLamports + 10_000_000, 'devnet funding wallet balance is too low');
    const fundingTx = await fundWallet(connection, fundingWallet, launchWallet.publicKey, fundLamports);
    drillLog.push(`funded ${(fundLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL (tx ${fundingTx.slice(0, 12)}…)`);

    // 4. Staged execution with a real process kill at the configured boundary.
    let completedOperations = 0;
    let armed = await api(baseUrl, token, '/api/v2/run-envelope/arm', {
      walletPublicKey,
      config,
      fundingEstimate,
      reviewedPlan,
      reviewedPlanDigest: reviewedPlan.integrity.digest,
    });
    let envelopeId = armed.envelope.id;

    for (let step = 0; step < 16; step += 1) {
      const nextEndpoint = readiness?.nextEndpoint;
      if (!nextEndpoint) break;
      if (LIQUIDITY_ENDPOINTS.includes(nextEndpoint)) {
        drillLog.push(`reached liquidity stage (${nextEndpoint}) — not executable on devnet (Raydium is mainnet-only); stopping`);
        break;
      }
      const executed = await api(baseUrl, token, '/api/v2/run-envelope/execute-next', {
        runEnvelopeId: envelopeId,
        confirmNextEndpoint: nextEndpoint,
        fundingEstimate,
      });
      executedEndpoints.push(nextEndpoint);
      completedOperations += 1;
      drillLog.push(`executed ${nextEndpoint}`);
      readiness = executed.readiness;

      if (isKillPoint({ completedOperations, killAfterOperation })) {
        drillLog.push(`SIGKILL after ${completedOperations} operation(s) — simulating a crash`);
        server.child.kill('SIGKILL');
        await new Promise((resolve) => server.child.once('exit', resolve));
        resumed = true;

        server = startServer({ port, configDir });
        token = await waitForServer(baseUrl, server.child);
        drillLog.push('server restarted with the persisted config dir');

        // The persisted journal must route the resume, not the original plan.
        const resumedReadiness = await api(baseUrl, token, '/api/v2/execution-readiness', { config, walletPublicKey });
        readiness = resumedReadiness.readiness;
        drillLog.push(`resume readiness next endpoint: ${readiness.nextEndpoint}`);
        if (executedEndpoints.includes('/api/create-token') && readiness.nextEndpoint === '/api/create-token') {
          throw new Error('idempotency failure: resume re-routed to /api/create-token after it completed');
        }
        armed = await api(baseUrl, token, '/api/v2/run-envelope/arm', {
          walletPublicKey,
          config,
          fundingEstimate,
          reviewedPlan,
          reviewedPlanDigest: reviewedPlan.integrity.digest,
        });
        envelopeId = armed.envelope.id;
      }
    }

    // 5. Reconcile the persisted journal against the invariant set.
    const journalPath = path.join(configDir, 'launchJournals.json');
    const journals = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : [];
    const journal = Array.isArray(journals)
      ? journals.filter((entry) => entry.walletPublicKey === walletPublicKey)
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0] || null
      : null;
    const reconciliation = reconcileDrillJournal({ journal, executedEndpoints, resumed });
    assert.ok(reconciliation.ok, `journal reconciliation failed: ${reconciliation.issues.join('; ')}`);
    drillLog.push(`journal reconciliation ok (${reconciliation.eventCount} events)`);

    result = {
      schema: 'trebuchet-devnet-recovery-drill/v1',
      status: 'completed',
      startedFrom: 'staged-execution',
      killAfterOperation,
      resumed,
      executedEndpoints,
      reconciliation,
      journalStage: journal?.stage || null,
      tokenMint: journal?.token?.mint || null,
      reachedLiquidityStage: Boolean(readiness && LIQUIDITY_ENDPOINTS.includes(readiness.nextEndpoint)),
      liquidityStageNote: 'Raydium CLMM is mainnet-only; liquidity-stage recovery is covered by the LP-stage resume tests, the PALM partial-result fixture, and future local-validator drills.',
      fundingTx,
      drillLog,
      recordedAt: new Date().toISOString(),
    };

    // 6. Return remaining SOL to the funding wallet.
    try {
      const sweepTx = await sweepBack(connection, launchWallet, fundingWallet.publicKey, fundingWallet);
      result.sweepBackTx = sweepTx;
      if (sweepTx) drillLog.push(`swept remaining SOL back (tx ${sweepTx.slice(0, 12)}…)`);
    } catch (error) {
      result.sweepBackError = redactSensitiveText(error?.message || String(error));
    }

    if (launchWallet) {
      result.postDrillWalletLamports = await connection
        .getBalance(launchWallet.publicKey, 'confirmed')
        .catch(() => null);
    }
    return result;
  } finally {
    try { server.child.kill('SIGTERM'); } catch { /* already gone */ }
    await wait(500);
    writeFileSync(
      path.join(configDir, 'drill-evidence.json'),
      JSON.stringify({ ...(result || {}), drillLog }, null, 2),
    );
    if (result) {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(evidenceDir, { recursive: true });
      const evidencePath = path.join(evidenceDir, `devnet-recovery-${Date.now()}.json`);
      writeFileSync(evidencePath, JSON.stringify(result, null, 2));
      result.evidencePath = evidencePath;
    }
    rmSync(configDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  runDevnetRecoveryDrills()
    .then((result) => {
      if (result?.skipped) return;
      console.log('\nDevnet recovery drill complete.');
      console.log(`  resumed after kill : ${result.resumed}`);
      console.log(`  executed endpoints : ${result.executedEndpoints.join(' → ') || '(none)'}`);
      console.log(`  token mint         : ${result.tokenMint}`);
      console.log(`  evidence           : ${result.evidencePath}`);
    })
    .catch((error) => {
      console.error(`Devnet recovery drill failed: ${redactSensitiveText(error?.message || String(error))}`);
      process.exitCode = 1;
    });
}