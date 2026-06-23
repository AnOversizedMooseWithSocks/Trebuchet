// test/launch-lifecycle.test.mjs
//
// Integration tests for the Raydium CLMM launch phases, driven through the
// mock SDK with NO network. Exercises the per-phase helpers that lpService's
// orchestrator composes (createSinglePool's create-pool step, the lock phase,
// and the fee-key transfer phase), and asserts RECOVERABLE state on partial
// failure rather than just "it logged an error" — matching issue #4's
// acceptance criterion.
//
// Why the phase helpers rather than the full createPoolsAndPositions(): the
// orchestrator interleaves heavy tick/USD/quote math with the SDK calls; the
// phase helpers (exposed via __testHooks) are the exact units that own the
// recoverable-state bookkeeping (lockFailures / transferFailures collectors
// and in-place mutation of `results`). Driving them directly gives precise,
// non-flaky assertions on what completed vs. what didn't.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import BN from 'bn.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'treb-launch-'));
process.env.TREBUCHET_CONFIG_DIR = TMP;

const journal = await import('../launchJournal.js');
const lp = await import('../lpService.js');
const { makeMockRaydium, makeResultEntry } = await import('./helpers/mockRaydium.mjs');

const hooks = lp.__testHooks;

// A valid base58 recipient pubkey for fee-key transfer tests.
const RECIPIENT = 'So11111111111111111111111111111111111111112';

test('lpService exposes test-only DI seams without affecting production defaults', () => {
  assert.equal(typeof lp.setSdkFactoryForTests, 'function');
  assert.equal(typeof lp.setConnectionFactoryForTests, 'function');
  assert.equal(typeof lp.resetTestFactories, 'function');
  assert.equal(typeof hooks.lockAllPositions, 'function');
  assert.equal(typeof hooks.transferFeeKeys, 'function');
  // Resetting is a no-op-safe operation.
  assert.doesNotThrow(() => lp.resetTestFactories());
});

// ---------------------------------------------------------------------------
// Phase 3 (lock) — happy path
// ---------------------------------------------------------------------------
test('lock phase happy path: all positions + bootstrap lock, txIds recorded, zero failures', async () => {
  const raydium = makeMockRaydium();
  const results = [makeResultEntry({ mainCount: 2, withBootstrap: true })];

  const stages = [];
  const { lockFailures } = await hooks.lockAllPositions({
    raydium,
    results,
    onProgress: (e) => stages.push(e.stage),
  });

  assert.equal(lockFailures.length, 0, 'no lock failures on happy path');
  for (const pos of results[0].mainPositions) {
    assert.equal(pos.locked, true, 'each main position locked');
    assert.ok(pos.txIds.lock, 'lock txId recorded for main position');
  }
  assert.equal(results[0].bootstrap.locked, true, 'bootstrap locked');
  assert.ok(results[0].bootstrap.txIds.lock, 'bootstrap lock txId recorded');
  assert.ok(stages.includes('phase3_start') && stages.includes('phase3_done'));
});

// ---------------------------------------------------------------------------
// Phase 3 (lock) — partial failure leaves RECOVERABLE state
// ---------------------------------------------------------------------------
test('lock phase partial failure: one lock fails, recoverable state recorded (what locked vs not)', async () => {
  // Inject a single lockPosition failure. lockAllPositions is fail-soft, so it
  // collects the failure and keeps locking the rest. We don't hardcode WHICH
  // slice fails (the mock counts call sites); instead we assert the recoverable
  // invariant: exactly one failure, the failed slice stays unlocked, and every
  // other position locks — which is precisely the "what completed vs what
  // didn't" recovery state the resume flow relies on.
  const raydium = makeMockRaydium({ fail: { lockPosition: 1 } });
  const results = [makeResultEntry({ mainCount: 2, withBootstrap: true })];

  const { lockFailures } = await hooks.lockAllPositions({ raydium, results });

  assert.equal(lockFailures.length, 1, 'exactly one lock failure collected (fail-soft, did not abort)');
  const f = lockFailures[0];
  assert.ok(['main', 'bootstrap'].includes(f.positionType), 'failure identifies the position TYPE that did not lock');
  assert.ok(f.error, 'failure carries an error message for the user');

  // RECOVERABLE STATE: count locked vs unlocked across all positions.
  const allPositions = [...results[0].mainPositions, results[0].bootstrap];
  const unlocked = allPositions.filter((p) => p && !p.locked);
  const locked = allPositions.filter((p) => p && p.locked);
  assert.equal(unlocked.length, 1, 'exactly one position remains unlocked (the retryable failure)');
  assert.equal(locked.length, allPositions.length - 1, 'every other position locked successfully');
  // The unlocked one is the one the resume flow must re-attempt.
  assert.ok(unlocked[0], 'the unlocked position is preserved for resume');
});

// ---------------------------------------------------------------------------
// Phase 1 (createSinglePool) — pool-create step happy path
// ---------------------------------------------------------------------------
test('createSinglePool create-step happy path: returns a pool id and create tx', async () => {
  // We drive only as far as the SDK calls the create + RPC-read steps require;
  // createSinglePool then proceeds into tick math which needs realistic pool
  // info. The mock returns plausible pool info, so we assert the create step
  // produced a poolId and a createPool txId via the progress events.
  const raydium = makeMockRaydium();
  const launchedToken = { address: '__LAUNCHED__', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const quoteToken = { address: 'So11111111111111111111111111111111111111112', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  const stages = [];
  let createPoolEvent = null;
  try {
    await hooks.createSinglePool({
      raydium,
      ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
      ammConfig: { id: 'mock-config', tickSpacing: 60 },
      launchedToken,
      quoteToken,
      initialPrice: 0.0001,
      wideBaseRaw: 1000n,
      bootstrapBaseRaw: 1n,
      bootstrapMode: 'minimal',
      distribution: [100],
      ladderMode: 'off',
      ladderBands: [],
      ladderCeiling: 1,
      onProgress: (e) => {
        stages.push(e.stage);
        if (e.stage === 'pool_create_done') createPoolEvent = e;
      },
    });
  } catch (e) {
    // Tick/liquidity math beyond the SDK surface may not complete against the
    // simplified mock; that's fine — we only assert the create step landed.
    void e;
  }

  assert.ok(stages.includes('pool_create_start'), 'pool create started');
  assert.ok(createPoolEvent, 'pool_create_done emitted');
  assert.ok(createPoolEvent.poolId, 'poolId returned from createPool');
  assert.ok(createPoolEvent.txId, 'createPool tx id returned');
});

// ---------------------------------------------------------------------------
// Phase 1 (createSinglePool) — mintB-path happy case
//
// When the launched token's pubkey sorts LARGER than the quote mint's,
// Raydium assigns it to mintB instead of mintA. lpService is supposed
// to detect this via `poolInfo.mintA.address === launchedToken.address`
// and branch every downstream math/SDK call accordingly. This test
// exercises that path by configuring the mock to return mintA=SOL,
// mintB=launched (the realistic ~97% case without a sort constraint).
//
// We verify two things concretely:
//   1. The pool create step still lands the same way.
//   2. The openPositionFromBase call lpService makes for the launched-
//      side position carries `base: 'MintB'` — proving lpService picked
//      the correct branch given the layout the mock reported.
//
// If this test fails after a change, the bidirectional code in
// lpService is broken for real mintB launches and must be fixed before
// removing the mintA-only enforcement gate in tokenService.js.
// ---------------------------------------------------------------------------
test('createSinglePool create-step mintB path: launched-as-mintB detected and base:"MintB" used on position open', async () => {
  const raydium = makeMockRaydium({ launchedAsMintB: true });
  const launchedToken = { address: '__LAUNCHED__', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const quoteToken = { address: 'So11111111111111111111111111111111111111112', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  const stages = [];
  let createPoolEvent = null;
  try {
    await hooks.createSinglePool({
      raydium,
      ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
      ammConfig: { id: 'mock-config', tickSpacing: 60 },
      launchedToken,
      quoteToken,
      initialPrice: 0.0001,
      // wideBaseRaw needs to be big enough that the per-slice slack reserve
      // (1 whole token × distribution.length = 1e9 raw for 9-decimal tokens)
      // still leaves something to slice. With 1 slice that's 1e9 reserved;
      // pass 2e9 raw so slicableRaw is 1e9 and the slice loop actually runs.
      wideBaseRaw: new BN('2000000000'),
      bootstrapBaseRaw: 1n,
      bootstrapMode: 'minimal',
      // The lpService code expects each slice to be an object with a
      // numeric sharePercent — `slice.sharePercent` on a bare integer
      // yields undefined, which becomes NaN through Math.round and
      // explodes the BN constructor. This is the canonical shape every
      // real caller uses (see lpService.js:3715 and line 723).
      distribution: [{ sharePercent: 100 }],
      ladderMode: 'off',
      ladderBands: [],
      ladderCeiling: 1,
      onProgress: (e) => {
        stages.push(e.stage);
        if (e.stage === 'pool_create_done') createPoolEvent = e;
      },
    });
  } catch (e) {
    // Same caveat as the mintA happy-path test: simplified mock can't
    // complete deep tick math, but the bidirectional branching happens
    // BEFORE that — we still get the openPositionFromBase recorded
    // calls we need to assert on.
    void e;
  }

  // Same baseline assertions as the mintA happy path.
  assert.ok(stages.includes('pool_create_start'), 'pool create started');
  assert.ok(createPoolEvent, 'pool_create_done emitted');
  assert.ok(createPoolEvent.poolId, 'poolId returned from createPool');
  assert.ok(createPoolEvent.txId, 'createPool tx id returned');

  // The critical bidirectional-correctness assertion: at least one
  // openPositionFromBase call must have used base:'MintB' (the launched
  // side), and NONE should have used base:'MintA' (the quote side, since
  // we never deposit launched tokens on the quote side).
  const opens = raydium.recordedCalls.openPositionFromBase;
  assert.ok(opens.length > 0, 'at least one openPositionFromBase call recorded');
  const mintBOpens = opens.filter((c) => c.base === 'MintB');
  const mintAOpens = opens.filter((c) => c.base === 'MintA');
  assert.ok(
    mintBOpens.length > 0,
    `expected at least one base:'MintB' open (launched is mintB), got ${mintBOpens.length}; ` +
    `all bases: ${JSON.stringify(opens.map((c) => c.base))}`,
  );
  assert.equal(
    mintAOpens.length,
    0,
    `expected zero base:'MintA' opens (launched is mintB, not mintA), got ${mintAOpens.length}; ` +
    `all bases: ${JSON.stringify(opens.map((c) => c.base))}`,
  );
});

// ---------------------------------------------------------------------------
// Phase 1 (createSinglePool) — createPool failure is surfaced, nothing locked
// ---------------------------------------------------------------------------
test('createSinglePool create-step failure: pool creation throws, no recoverable position state created', async () => {
  const raydium = makeMockRaydium({ fail: { createPool: true } });
  const launchedToken = { address: '__LAUNCHED__', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const quoteToken = { address: 'So11111111111111111111111111111111111111112', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  const stages = [];
  await assert.rejects(() => hooks.createSinglePool({
    raydium,
    ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
    ammConfig: { id: 'mock-config', tickSpacing: 60 },
    launchedToken,
    quoteToken,
    initialPrice: 0.0001,
    wideBaseRaw: 1000n,
    bootstrapBaseRaw: 1n,
    bootstrapMode: 'minimal',
    distribution: [100],
    ladderMode: 'off',
    ladderBands: [],
    ladderCeiling: 1,
    onProgress: (e) => stages.push(e.stage),
  }), /createPool failed/);

  // Recoverable: it never emitted pool_create_done, so no pool/positions exist
  // to track — the caller retries the whole allocation cleanly.
  assert.ok(!stages.includes('pool_create_done'), 'no pool reported created on failure');
});

test('createSinglePool emits main_open_failed with context before throwing', async () => {
  const raydium = makeMockRaydium({
    fail: {
      openPosition: true,
      messages: { openPosition: 'simulated RPC timeout during open' },
    },
  });
  const launchedToken = { address: '__LAUNCHED__', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
  const quoteToken = { address: 'So11111111111111111111111111111111111111112', decimals: 9, programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };

  const events = [];
  await assert.rejects(() => hooks.createSinglePool({
    raydium,
    ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
    ammConfig: { id: 'mock-config', tickSpacing: 60 },
    launchedToken,
    quoteToken,
    initialPrice: 0.0001,
    wideBaseRaw: new BN('2000000000'),
    bootstrapBaseRaw: 1n,
    bootstrapMode: 'minimal',
    distribution: [{ sharePercent: 100, recipient: null }],
    ladderMode: 'off',
    ladderBands: [],
    ladderCeiling: 1,
    onProgress: (e) => events.push(e),
  }), /simulated RPC timeout during open/);

  const createDone = events.find((e) => e.stage === 'pool_create_done');
  const failed = events.find((e) => e.stage === 'main_open_failed');
  assert.ok(createDone, 'pool creation was recorded before the open failure');
  assert.ok(failed, 'main_open_failed event emitted before throw');
  assert.equal(failed.poolId, createDone.poolId, 'failure names the already-created pool');
  assert.equal(failed.sliceIndex, 0, 'failure identifies the slice');
  assert.equal(failed.baseAmountRaw, '1000000000', 'failure records the attempted raw amount');
  assert.match(failed.error, /simulated RPC timeout during open/, 'failure carries the thrown error message');
  assert.equal(typeof failed.tickLower, 'number', 'failure records tickLower');
  assert.equal(typeof failed.tickUpper, 'number', 'failure records tickUpper');
});

// ---------------------------------------------------------------------------
// Phase 4 (transferFeeKeys) — transfer failure leaves Fee Key recoverable
// ---------------------------------------------------------------------------
test('transfer phase: unlocked position cannot transfer Fee Key, surfaced as recoverable failure', async () => {
  const raydium = makeMockRaydium();
  // Position has a recipient but is NOT locked -> no Fee Key exists yet.
  const results = [makeResultEntry({ mainCount: 1, withBootstrap: false, recipients: [RECIPIENT] })];
  results[0].mainPositions[0].locked = false;

  const { transferFailures } = await hooks.transferFeeKeys({
    raydium,
    ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
    results,
  });

  assert.equal(transferFailures.length, 1, 'transfer failure collected for unlocked position');
  assert.equal(transferFailures[0].recipient, RECIPIENT, 'failure names the intended recipient');
  assert.match(transferFailures[0].error, /not locked/, 'failure explains no Fee Key exists');
  // Recoverable: the position is untouched (transferredTo still null), so the
  // final sweep / a retry can still deliver the Fee Key.
  assert.equal(results[0].mainPositions[0].transferredTo, null, 'no transfer recorded (recoverable)');
});

test('transfer phase: no recipients short-circuits cleanly (no failures)', async () => {
  const raydium = makeMockRaydium();
  const results = [makeResultEntry({ mainCount: 2, withBootstrap: true })]; // no recipients
  const stages = [];
  const { transferFailures } = await hooks.transferFeeKeys({
    raydium,
    ownerKeypair: { publicKey: { toBase58: () => 'owner' } },
    results,
    onProgress: (e) => stages.push(e.stage),
  });
  assert.equal(transferFailures.length, 0);
  assert.ok(stages.includes('phase4_skipped'), 'phase 4 skipped when nothing to transfer');
});

// ---------------------------------------------------------------------------
// Journal: a partial launch failure is persisted as recoverable state.
// This mirrors how server.js records the orchestrator's failedPhase +
// partialResults so a crash/close leaves an audit/recovery trail.
// ---------------------------------------------------------------------------
test('journal records a recoverable partial-launch (failedPhase=locks) rather than only logging', () => {
  const walletPk = `LpWallet${Math.random().toString(36).slice(2, 10)}`;
  journal.start({ walletPublicKey: walletPk });

  // Simulate what the orchestrator throws on a lock-phase partial failure and
  // what the server persists from it.
  const partialResults = [makeResultEntry({ mainCount: 2, withBootstrap: true })];
  partialResults[0].mainPositions[1].locked = false; // one slice didn't lock

  journal.upsertForWallet(
    walletPk,
    {
      stage: 'lp_failed',
      lp: { failedPhase: 'locks', partialResults },
      error: '1 position(s) failed to lock; retry to complete the locks.',
    },
    { stage: 'lp_partial_failure', failedPhase: 'locks' },
  );

  const j = journal.activeForWallet(walletPk);
  assert.ok(j, 'journal entry persisted');
  assert.notEqual(j.status, 'completed', 'partial failure is NOT completed');
  assert.equal(j.lp.failedPhase, 'locks', 'failed phase recorded for recovery');
  assert.ok(Array.isArray(j.lp.partialResults), 'partialResults persisted for resume');
  assert.equal(j.lp.partialResults[0].mainPositions[1].locked, false,
    'recoverable detail: which slice still needs locking is preserved');
  assert.ok(j.error, 'human-readable error recorded');
});

test('journal persists structured error details and strips secret-looking fields', () => {
  const walletPk = `ErrWallet${Math.random().toString(36).slice(2, 10)}`;
  journal.start({ walletPublicKey: walletPk });

  const err = new Error('RPC timeout while opening slice 3');
  err.code = 'RPC_TIMEOUT';
  err.secretKey = [1, 2, 3];
  const details = journal.errorDetails(err, {
    route: 'create-lp',
    failedPhase: 'main_positions',
    failedAllocationIndex: 0,
  });

  journal.upsertForWallet(
    walletPk,
    {
      stage: 'lp_main_positions_failed',
      status: 'failed',
      error: journal.errorMessage(err),
      errorDetails: details,
    },
    {
      stage: 'main_open_failed',
      sliceIndex: 2,
      error: journal.errorMessage(err),
      secretKey: [1, 2, 3],
    },
  );

  const j = journal.activeForWallet(walletPk);
  assert.equal(j.error, 'RPC timeout while opening slice 3');
  assert.equal(j.errorDetails.message, 'RPC timeout while opening slice 3');
  assert.equal(j.errorDetails.code, 'RPC_TIMEOUT');
  assert.equal(j.errorDetails.secretKey, undefined, 'secret-looking fields are removed from errorDetails');
  const lastEvent = j.events.at(-1);
  assert.equal(lastEvent.stage, 'main_open_failed');
  assert.equal(lastEvent.error, 'RPC timeout while opening slice 3');
  assert.equal(lastEvent.secretKey, undefined, 'secret-looking fields are removed from events');
});
