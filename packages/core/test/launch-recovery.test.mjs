// Core-boundary test for the launch recovery contract. Deep behavior is
// covered by the app-level regression suite (test/launch-recovery.test.mjs,
// built on a captured real-world journal); this file guards the package
// boundary: the module must be importable from Core with no app
// dependencies and reconstruct partial results from a minimal journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconstructPartialResultsFromEvents,
  mergePriorResults,
} from '../src/launch-recovery.js';

function minimalInterruptedJournal() {
  return {
    id: 'jrnl-core',
    walletPublicKey: 'WALLETcorexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    status: 'failed',
    stage: 'lp_main_positions_failed',
    lp: { results: [], partialResults: [], failedPhase: 'main_positions' },
    events: [
      { ts: '2026-01-01T00:00:00.000Z', stage: 'lp_create_started' },
      { ts: '2026-01-01T00:00:01.000Z', stage: 'pool_create_start', allocationIndex: 0 },
      { ts: '2026-01-01T00:00:02.000Z', stage: 'pool_create_done', allocationIndex: 0, poolId: 'Pool111111111111111111111111111111111', txId: 'createTx1' },
      { ts: '2026-01-01T00:00:03.000Z', stage: 'main_open_start', allocationIndex: 0, sliceIndex: 0 },
      { ts: '2026-01-01T00:00:04.000Z', stage: 'main_open_done', allocationIndex: 0, sliceIndex: 0, nftMint: 'Nft111111111111111111111111111111111111', txId: 'openTx0' },
      { ts: '2026-01-01T00:00:05.000Z', stage: 'lp_main_positions_failed', error: 'boom' },
    ],
  };
}

test('reconstructs a partial allocation with no app dependencies', () => {
  const out = reconstructPartialResultsFromEvents(minimalInterruptedJournal());
  assert.equal(out.length, 1);
  assert.equal(out[0].allocationIndex, 0);
  assert.equal(out[0].poolId, 'Pool111111111111111111111111111111111');
  assert.equal(out[0].txIds.createPool, 'createTx1');
  assert.equal(out[0].mainPositions.length, 1);
  assert.equal(out[0].mainPositions[0].txIds.open, 'openTx0');
});

test('mergePriorResults keeps stored results authoritative and fills gaps', () => {
  const journal = minimalInterruptedJournal();
  const stored = [{ allocationIndex: 1, poolId: 'Pool222222222222222222222222222222222' }];
  const reconstructed = reconstructPartialResultsFromEvents(journal);
  const merged = mergePriorResults(stored, reconstructed);
  const indexes = merged.map((row) => row.allocationIndex).sort();
  assert.deepEqual(indexes, [0, 1]);
  // Stored allocation 1 stays authoritative; allocation 0 was reconstructed.
  const a1 = merged.find((row) => row.allocationIndex === 1);
  assert.equal(a1.poolId, 'Pool222222222222222222222222222222222');
});