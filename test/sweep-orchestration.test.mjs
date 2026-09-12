// test/sweep-orchestration.test.mjs
//
// Behavioral coverage for EVERY branch of the sweep decision logic in
// sweepOrchestrator.js — the code that decides whether the SOL leaves the
// launch wallet. This is the logic behind two real user reports of assets
// left behind, so each branch is asserted on OUTCOMES (was SOL swept? were
// results merged? what did the journal see?), not on source text.
//
// Everything is offline: the orchestrator takes injected collaborators, so
// each test constructs exactly the world it needs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finishSweepWithSolGate,
  hasTokenBalances,
} from '../sweepOrchestrator.js';

// --- tiny builders ---------------------------------------------------------

const emptyBalance = () => ({ sol: 0.0009, tokens: {} });
const balanceWith = (mints) => ({
  sol: 0.5,
  tokens: Object.fromEntries(mints.map((m, i) => [m, {
    amountRaw: '1000', amountUi: 1, decimals: 3, programId: 'p',
    accounts: [{ address: `acct${i}`, amountRaw: '1000' }],
  }])),
});
const cleanSweep = () => ({ transferred: [], errors: [] });

// Standard harness: records every collaborator call, returns configurable
// results. Enumeration results are consumed in order (last repeats).
function harness({
  enumerations = [emptyBalance()],
  enumerationThrows = [],           // indices (0-based) at which enumerate throws
  secondPassNft = cleanSweep(),
  secondPassTokens = cleanSweep(),
  solSweepImpl = async () => ({ solTransferred: 1.23, txId: 'sol-tx' }),
} = {}) {
  const calls = { sweepNfts: 0, sweepTokens: 0, sweepSol: 0, enumerate: 0, events: [] };
  return {
    calls,
    deps: {
      sweepNfts: async () => { calls.sweepNfts += 1; return secondPassNft; },
      sweepTokens: async () => { calls.sweepTokens += 1; return secondPassTokens; },
      sweepSol: async () => { calls.sweepSol += 1; return solSweepImpl(); },
      enumerate: async (_pk, opts) => {
        const idx = calls.enumerate;
        calls.enumerate += 1;
        assert.equal(opts.commitment, 'finalized', 'every enumeration must be at finalized');
        if (enumerationThrows.includes(idx)) throw new Error(`enum boom ${idx}`);
        return enumerations[Math.min(idx, enumerations.length - 1)];
      },
      recordEvent: (e) => { calls.events.push(e.stage); },
    },
  };
}

const runGate = (h, { nftSweep = cleanSweep(), tokenSweep = cleanSweep() } = {}) =>
  finishSweepWithSolGate({
    walletPublicKey: 'WALLET',
    tempWalletSecretKey: [1, 2, 3],
    destinationWallet: 'DEST',
    nftSweep,
    tokenSweep,
    deps: h.deps,
  });

// --- branch 1: clean path --------------------------------------------------

test('clean sweep + verified-empty wallet -> SOL is swept', async () => {
  const h = harness();
  const r = await runGate(h);
  assert.equal(h.calls.sweepSol, 1, 'SOL sweep must run');
  assert.equal(r.solSweep.solTransferred, 1.23);
  assert.equal(r.solSweepSkipped, null);
  assert.equal(r.solSweepError, null);
  assert.equal(r.secondPassRan, false, 'no straggler pass when wallet is clean');
  assert.equal(h.calls.sweepNfts, 0, 'no redundant second pass');
});

// --- branches 2 & 3: sweep errors block the SOL ------------------------------

test('token sweep errors -> SOL skipped, journal told, sweepSol never called', async () => {
  const h = harness();
  const r = await runGate(h, {
    tokenSweep: { transferred: [], errors: [{ mint: 'M', error: 'insufficient funds' }] },
  });
  assert.equal(h.calls.sweepSol, 0, 'the SOL must NOT move');
  assert.match(r.solSweepSkipped, /deliberately NOT swept/);
  assert.match(r.solSweepSkipped, /nothing has been lost/i,
    'the skip message must reassure — users read a silent SOL hold as theft');
  assert.ok(h.calls.events.includes('sol_sweep_skipped_assets_remain'));
});

test('NFT sweep errors -> SOL skipped', async () => {
  const h = harness();
  const r = await runGate(h, {
    nftSweep: { transferred: [], errors: [{ mint: 'FEEKEY', error: 'tx failed' }] },
  });
  assert.equal(h.calls.sweepSol, 0);
  assert.ok(r.solSweepSkipped);
});

// --- branches 4 & 9: straggler pass and error-merge semantics ----------------

test('straggler found -> second pass runs, results merged, then SOL swept', async () => {
  const h = harness({
    enumerations: [balanceWith(['STRAGGLER']), emptyBalance()],
    secondPassTokens: { transferred: [{ mint: 'STRAGGLER', txId: 't2' }], errors: [] },
  });
  const tokenSweep = { transferred: [{ mint: 'FIRST', txId: 't1' }], errors: [] };
  const r = await runGate(h, { tokenSweep });

  assert.equal(r.secondPassRan, true);
  assert.equal(h.calls.sweepNfts, 1, 'second pass includes NFTs');
  assert.equal(h.calls.sweepTokens, 1, 'second pass includes tokens');
  assert.deepEqual(tokenSweep.transferred.map((t) => t.mint), ['FIRST', 'STRAGGLER'],
    'second-pass transfers are APPENDED to the first-pass record');
  assert.equal(h.calls.sweepSol, 1, 'wallet clean after second pass -> SOL moves');
  assert.ok(h.calls.events.includes('sweep_second_pass'));
});

test('first-pass error resolved by the second pass -> not an error, SOL swept', async () => {
  // The subtle merge rule: pass 2 re-attempts everything still present, so
  // its error list REPLACES pass 1's. An item that failed then succeeded is
  // not an error, and blocking the SOL on a stale error would strand it.
  const h = harness({
    enumerations: [balanceWith(['RETRYME']), emptyBalance()],
    secondPassTokens: { transferred: [{ mint: 'RETRYME', txId: 't2' }], errors: [] },
  });
  const tokenSweep = {
    transferred: [],
    errors: [{ mint: 'RETRYME', error: 'transient blip in pass 1' }],
  };
  const r = await runGate(h, { tokenSweep });
  assert.deepEqual(tokenSweep.errors, [], 'resolved error is cleared by the merge');
  assert.equal(h.calls.sweepSol, 1, 'SOL moves once the retry succeeded');
  assert.equal(r.solSweepSkipped, null);
});

// --- branch 5: straggler persists -------------------------------------------

test('asset still present after the second pass -> SOL skipped', async () => {
  const h = harness({
    enumerations: [balanceWith(['STUCK']), balanceWith(['STUCK'])],
    secondPassTokens: { transferred: [], errors: [{ mint: 'STUCK', error: 'still failing' }] },
  });
  const r = await runGate(h);
  assert.equal(r.secondPassRan, true);
  assert.equal(h.calls.sweepSol, 0, 'SOL stays while anything is stuck');
  assert.ok(r.solSweepSkipped);
});

// --- branches 6 & 7: enumeration failures fail CLOSED ------------------------

test('first re-enumeration throws -> unknown is not empty -> SOL skipped', async () => {
  const h = harness({ enumerationThrows: [0] });
  const r = await runGate(h);
  assert.equal(h.calls.sweepSol, 0,
    'if we cannot PROVE the wallet is empty, the SOL must not move');
  assert.ok(r.solSweepSkipped);
  assert.equal(r.secondPassRan, false,
    'an unknown state does not trigger a blind second pass');
});

test('post-second-pass re-enumeration throws -> SOL skipped', async () => {
  const h = harness({
    enumerations: [balanceWith(['X'])],
    enumerationThrows: [1],
    secondPassTokens: { transferred: [{ mint: 'X', txId: 't' }], errors: [] },
  });
  const r = await runGate(h);
  assert.equal(r.secondPassRan, true);
  assert.equal(h.calls.sweepSol, 0);
  assert.ok(r.solSweepSkipped);
});

// --- branch 8: SOL sweep failure after a clean gate --------------------------

test('SOL sweep throws after a clean gate -> reported, not thrown, not skipped', async () => {
  const h = harness({ solSweepImpl: async () => { throw new Error('blockhash expired'); } });
  const r = await runGate(h);
  assert.equal(r.solSweepError, 'blockhash expired');
  assert.equal(r.solSweepSkipped, null, 'a FAILURE is not a deliberate skip');
  assert.equal(r.solSweep.solTransferred, 0);
});

// --- branch 10: dust and malformed balances ----------------------------------

test('zero-balance token accounts count as empty; malformed amounts fail closed', () => {
  assert.equal(hasTokenBalances(null), false);
  assert.equal(hasTokenBalances({ tokens: {} }), false);
  assert.equal(
    hasTokenBalances({ tokens: { M: { amountRaw: '0' } } }), false,
    'empty ATAs left behind are dust, not assets',
  );
  assert.equal(
    hasTokenBalances({ tokens: { M: { amountRaw: '5' } } }), true,
  );
  assert.equal(
    hasTokenBalances({ tokens: { M: { amountRaw: 'garbage' } } }), true,
    'an unparseable balance must count as "assets present" — fail closed',
  );
});

test('dust-only remainder -> gate passes, SOL swept', async () => {
  const h = harness({
    enumerations: [{ sol: 0.3, tokens: { M: { amountRaw: '0' } } }],
  });
  const r = await runGate(h);
  assert.equal(h.calls.sweepSol, 1);
  assert.equal(r.solSweepSkipped, null);
});

// --- journal resilience -------------------------------------------------------

test('a throwing recordEvent never blocks the sweep decision', async () => {
  const h = harness();
  h.deps.recordEvent = () => { throw new Error('journal disk full'); };
  const r = await runGate(h, {
    tokenSweep: { transferred: [], errors: [{ mint: 'M', error: 'x' }] },
  });
  // The skip still happened and was still reported despite the journal error.
  assert.ok(r.solSweepSkipped);
});
