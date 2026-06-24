import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  reconstructPartialResultsFromEvents,
  mergePriorResults,
} from '../launchRecovery.js';

// ---------------------------------------------------------------------------
// launchRecovery regression tests.
//
// These pin the contract that makes a mid-Phase-1 launch recoverable: when a
// launch creates a pool and opens some positions but dies before the
// allocation completes, no `phase1_pool_done` is emitted, so the structured
// results stay empty. reconstructPartialResultsFromEvents must rebuild that
// allocation from the granular event log so the orchestrator can adopt the
// orphaned pool and finish, and mergePriorResults must let authoritative
// stored results win while filling only the gaps.
//
// The headline case is the real launch that motivated this work: token PALM,
// a SOL pool created, main slices 1 and 2 of 3 opened, then slice 3 failed —
// nothing recorded in the structured results.
// ---------------------------------------------------------------------------

// Real on-chain identifiers from the PALM launch (allocation 0 = SOL pool).
const PALM_POOL = 'FgNmgjQt3hy1SD6b2dbD27TG1nf1k2b3rKHbhpJFKUxK';
const PALM_SLICE0_NFT = 'HwWFLaDHv9JTeLmWqa4XUgbKr9KHxg3Ri2HyxTkt6fze';
const PALM_SLICE1_NFT = 'HghY5y9uxp44FG6jsSZYncbYjoafsYEbdS7ayfBGe15A';

// A journal shaped like the PALM failure: pool created + two main slices
// opened on allocation 0, then the launch stopped (slice 3 never landed, no
// phase1_pool_done, no Phase-2/3 events). Allocation 1 (the second pool) never
// started. Structured results are empty — the whole point.
function palmJournal() {
  return {
    id: 'jrnl-palm',
    walletPublicKey: 'WALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    status: 'failed',
    stage: 'lp_main_positions_failed',
    lp: { results: [], partialResults: [], failedPhase: 'main_positions' },
    events: [
      { ts: '2026-06-23T00:00:00.000Z', stage: 'lp_create_started' },
      { ts: '2026-06-23T00:00:01.000Z', stage: 'pool_create_start', allocationIndex: 0 },
      { ts: '2026-06-23T00:00:02.000Z', stage: 'pool_create_done', allocationIndex: 0, poolId: PALM_POOL, txId: 'createTxAAA' },
      { ts: '2026-06-23T00:00:03.000Z', stage: 'main_open_start', allocationIndex: 0, sliceIndex: 0 },
      { ts: '2026-06-23T00:00:04.000Z', stage: 'main_open_done', allocationIndex: 0, sliceIndex: 0, nftMint: PALM_SLICE0_NFT, txId: 'openTx0' },
      { ts: '2026-06-23T00:00:05.000Z', stage: 'main_open_start', allocationIndex: 0, sliceIndex: 1 },
      { ts: '2026-06-23T00:00:06.000Z', stage: 'main_open_done', allocationIndex: 0, sliceIndex: 1, nftMint: PALM_SLICE1_NFT, txId: 'openTx1' },
      // slice 3 (sliceIndex 2) failed: no event recorded.
      { ts: '2026-06-23T00:00:16.000Z', stage: 'lp_main_positions_failed', error: 'open slice 3 failed', failedPhase: 'main_positions' },
    ],
  };
}

test('PALM: reconstructs the orphaned allocation from events', () => {
  const out = reconstructPartialResultsFromEvents(palmJournal());
  assert.equal(out.length, 1, 'only allocation 0 reached a pool');

  const a0 = out[0];
  assert.equal(a0.allocationIndex, 0);
  assert.equal(a0.poolId, PALM_POOL);
  assert.equal(a0.txIds.createPool, 'createTxAAA');

  // Both opened slices recovered, in order, with their open tx ids preserved
  // so the orchestrator can re-attach them.
  assert.equal(a0.mainPositions.length, 2);
  assert.deepEqual(a0.mainPositions.map((p) => p.sliceIndex), [0, 1]);
  assert.equal(a0.mainPositions[0].nftMint, PALM_SLICE0_NFT);
  assert.equal(a0.mainPositions[0].txIds.open, 'openTx0');
  assert.equal(a0.mainPositions[1].nftMint, PALM_SLICE1_NFT);
  assert.equal(a0.mainPositions[1].txIds.open, 'openTx1');

  // Nothing past the failure point exists.
  assert.deepEqual(a0.ladderPositions, []);
  assert.deepEqual(a0.supportPositions, []);
  assert.equal(a0.bootstrap, null);
});

test('PALM: merge fills the gap when stored results are empty', () => {
  const journal = palmJournal();
  const stored = []; // lp.results / lp.partialResults are empty
  const reconstructed = reconstructPartialResultsFromEvents(journal);
  const merged = mergePriorResults(stored, reconstructed);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].poolId, PALM_POOL);
  assert.equal(merged[0].mainPositions.length, 2);
});

test('allocations without a pool event are dropped (nothing to adopt)', () => {
  // A launch that failed in pre-flight: an allocation index appears in events
  // but no pool was ever created for it.
  const journal = {
    events: [
      { stage: 'main_open_done', allocationIndex: 0, sliceIndex: 0, nftMint: 'orphanNoPool', txId: 'tx' },
    ],
  };
  assert.deepEqual(reconstructPartialResultsFromEvents(journal), []);
});

test('stored result overrides reconstructed for the same allocation', () => {
  // Authoritative stored result carries lock/transfer state the open events
  // don't. It must win over the sparser reconstructed entry.
  const stored = [
    {
      allocationIndex: 0,
      poolId: PALM_POOL,
      mainPositions: [
        { sliceIndex: 0, nftMint: PALM_SLICE0_NFT, locked: true, txIds: { open: 'openTx0', lock: 'lockTx0' } },
      ],
      bootstrap: { nftMint: 'bsMint', locked: true, txIds: { open: 'bsOpen', lock: 'bsLock' } },
    },
  ];
  const reconstructed = reconstructPartialResultsFromEvents(palmJournal());
  const merged = mergePriorResults(stored, reconstructed);

  assert.equal(merged.length, 1);
  // The stored object wins verbatim — lock state preserved, not clobbered by
  // the reconstructed (locked: false) copy.
  assert.equal(merged[0].mainPositions[0].locked, true);
  assert.equal(merged[0].mainPositions[0].txIds.lock, 'lockTx0');
  assert.equal(merged[0].bootstrap.locked, true);
});

test('merge keeps stored alloc 0 and reconstructed alloc 1 together, sorted', () => {
  // A two-pool launch where pool 0 finished (stored) but pool 1 died
  // mid-Phase-1 (reconstructed only).
  const stored = [{ allocationIndex: 0, poolId: 'POOL0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mainPositions: [] }];
  const reconstructed = [{ allocationIndex: 1, poolId: 'POOL1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', mainPositions: [], ladderPositions: [], supportPositions: [], txIds: { createPool: 'c1' } }];
  const merged = mergePriorResults(stored, reconstructed);

  assert.deepEqual(merged.map((r) => r.allocationIndex), [0, 1]);
  assert.equal(merged[0].poolId, 'POOL0aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.equal(merged[1].poolId, 'POOL1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
});

test('a re-resume skip preserves the original open tx id', () => {
  // First attempt opened slice 0 (done, with tx). A later resume carried it
  // forward (skip, no tx). The original open tx id must survive so the audit
  // record stays complete.
  const journal = {
    events: [
      { stage: 'pool_create_done', allocationIndex: 0, poolId: PALM_POOL, txId: 'createTx' },
      { stage: 'main_open_done', allocationIndex: 0, sliceIndex: 0, nftMint: PALM_SLICE0_NFT, txId: 'originalOpenTx' },
      { stage: 'main_open_skip', allocationIndex: 0, sliceIndex: 0, nftMint: PALM_SLICE0_NFT },
    ],
  };
  const out = reconstructPartialResultsFromEvents(journal);
  assert.equal(out.length, 1);
  assert.equal(out[0].mainPositions.length, 1, 'skip updates the same slice, not a duplicate');
  assert.equal(out[0].mainPositions[0].txIds.open, 'originalOpenTx');
});

test('a skip with no prior done still records the carried position (null tx)', () => {
  // The original open landed in a PRIOR session whose event was trimmed from
  // the journal window; only the resume's skip survives. The position is still
  // real on-chain, so it must be carried (nftMint known) even without a tx id.
  const journal = {
    events: [
      { stage: 'pool_adopted', allocationIndex: 0, poolId: PALM_POOL, txId: null },
      { stage: 'main_open_skip', allocationIndex: 0, sliceIndex: 0, nftMint: PALM_SLICE0_NFT },
    ],
  };
  const out = reconstructPartialResultsFromEvents(journal);
  assert.equal(out.length, 1);
  assert.equal(out[0].poolId, PALM_POOL, 'pool_adopted establishes the pool id like pool_create_done');
  assert.equal(out[0].mainPositions[0].nftMint, PALM_SLICE0_NFT);
  assert.equal(out[0].mainPositions[0].txIds.open, null);
});

test('reconstructs ladder, support, and bootstrap with correct keys/ranges', () => {
  const journal = {
    events: [
      { stage: 'pool_create_done', allocationIndex: 0, poolId: PALM_POOL, txId: 'c' },
      // Ladder bands arrive out of order to prove sorting.
      { stage: 'ladder_open_done', allocationIndex: 0, bandIndex: 2, nftMint: 'band2', txId: 'lb2' },
      { stage: 'ladder_open_done', allocationIndex: 0, bandIndex: 0, nftMint: 'band0', txId: 'lb0' },
      { stage: 'ladder_open_done', allocationIndex: 0, bandIndex: 1, nftMint: 'band1', txId: 'lb1' },
      { stage: 'support_open_done', allocationIndex: 0, nftMint: 'supportMint', txId: 'sup' },
      { stage: 'bootstrap_open_done', allocationIndex: 0, nftMint: 'bsMint', txId: 'bs', tickLower: -120, tickUpper: 240 },
    ],
  };
  const out = reconstructPartialResultsFromEvents(journal);
  assert.equal(out.length, 1);
  const a = out[0];

  assert.deepEqual(a.ladderPositions.map((p) => p.bandIndex), [0, 1, 2]);
  assert.equal(a.ladderPositions[2].nftMint, 'band2');
  assert.equal(a.ladderPositions[2].txIds.open, 'lb2');

  assert.equal(a.supportPositions.length, 1);
  assert.equal(a.supportPositions[0].nftMint, 'supportMint');
  assert.equal(a.supportPositions[0].txIds.open, 'sup');

  assert.equal(a.bootstrap.nftMint, 'bsMint');
  assert.equal(a.bootstrap.tickLower, -120);
  assert.equal(a.bootstrap.tickUpper, 240);
  assert.equal(a.bootstrap.txIds.open, 'bs');
  assert.equal(a.bootstrap.locked, false);
});

test('robust against missing/garbage input', () => {
  assert.deepEqual(reconstructPartialResultsFromEvents(null), []);
  assert.deepEqual(reconstructPartialResultsFromEvents({}), []);
  assert.deepEqual(reconstructPartialResultsFromEvents({ events: 'nope' }), []);
  assert.deepEqual(reconstructPartialResultsFromEvents({ events: [null, 7, { stage: 5 }, { foo: 1 }] }), []);
  assert.deepEqual(mergePriorResults(null, null), []);
  assert.deepEqual(mergePriorResults(undefined, undefined), []);
});

test('merge filters out any entry that lacks a pool id', () => {
  const stored = [{ allocationIndex: 0, poolId: null, mainPositions: [] }];
  const reconstructed = [];
  assert.deepEqual(mergePriorResults(stored, reconstructed), []);
});
