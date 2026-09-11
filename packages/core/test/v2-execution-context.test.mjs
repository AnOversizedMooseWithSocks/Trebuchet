// Core-boundary tests for the v2 execution context fold. Deep replay
// behavior is covered app-side (test/launch-wiring-audit.test.mjs and the
// PALM regression suite in test/launch-recovery.test.mjs); this file pins
// the contract a headless runner will consume: journal → idempotent
// execution decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLpEventToResults,
  buildV2ExecutionContext,
  isResumeCheckpointResult,
  priorResultsFromJournal,
  v2TransferHasWalletEmptyFinalSweepEvidence,
} from '../src/v2-execution-context.js';

const WALLET = 'WalletCtx111111111111111111111111111111111';

function interruptedLpJournal() {
  return {
    id: 'jrnl-ctx',
    walletPublicKey: WALLET,
    status: 'failed',
    stage: 'lp_main_positions_failed',
    token: { mint: 'MintCtx1111111111111111111111111111111111', mintAuthorityRenounced: true, isSafe: true },
    poolPlan: {
      allocations: [{
        quoteSymbol: 'SOL',
        quoteMint: 'So11111111111111111111111111111111111111112',
        supplyPercent: 100,
        distribution: [{ sharePercent: 98 }, { sharePercent: 1 }, { sharePercent: 1 }],
      }],
    },
    lp: { results: [], partialResults: [], failedPhase: 'main_positions' },
    events: [
      { stage: 'supply_minted' },
      { stage: 'metadata_account_created' },
      { stage: 'pool_create_done', allocationIndex: 0, poolId: 'PoolCtx111111111111111111111111111111111', txId: 'createTx' },
      { stage: 'main_open_done', allocationIndex: 0, sliceIndex: 0, nftMint: 'NftCtx000000000000000000000000000000000000000', txId: 'openTx0' },
      { stage: 'main_lock_done', allocationIndex: 0, sliceIndex: 0, nftMint: 'NftCtx000000000000000000000000000000000000000', feeKeyNftMint: 'FeeCtx0000000000000000000000000000000000000', txId: 'lockTx0' },
      { stage: 'lp_main_positions_failed', error: 'boom' },
    ],
  };
}

test('fold reconstructs prior results and flags a resume for an interrupted launch', () => {
  const context = buildV2ExecutionContext({ journal: interruptedLpJournal(), body: {} });
  assert.equal(context.resume, true);
  assert.equal(context.failedLaunch, true);
  assert.equal(context.liquidityComplete, false);
  assert.equal(context.tokenMint, 'MintCtx1111111111111111111111111111111111');
  assert.equal(context.tokenCreated, true);
  assert.equal(context.tokenNeedsFinish, false);
  assert.equal(context.priorResults.length, 1);
  const [a0] = context.priorResults;
  assert.equal(a0.poolId, 'PoolCtx111111111111111111111111111111111');
  assert.equal(a0.mainPositions.length, 1);
  assert.equal(a0.mainPositions[0].locked, true);
  assert.equal(a0.mainPositions[0].feeKeyNftMint, 'FeeCtx0000000000000000000000000000000000000');
  assert.equal(a0.mainPositions[0].txIds.lock, 'lockTx0');
});

test('a fresh wallet with no journal starts clean', () => {
  const context = buildV2ExecutionContext({ journal: null, body: {} });
  assert.equal(context.tokenCreated, false);
  assert.equal(context.resume, false);
  assert.equal(context.liquidityComplete, false);
  assert.equal(context.transferComplete, false);
  assert.equal(context.priorResults, undefined);
});

test('structured LP results plus a recoverable stage mark liquidity complete', () => {
  const journal = {
    ...interruptedLpJournal(),
    status: 'active',
    stage: 'transfer_started',
    lp: {
      results: [{ allocationIndex: 0, poolId: 'PoolCtx111111111111111111111111111111111', phase1Complete: true, mainPositions: [] }],
      partialResults: [],
    },
  };
  const context = buildV2ExecutionContext({ journal, body: {} });
  assert.equal(context.liquidityComplete, true);
  assert.equal(context.resume, false);
});

test('transferComplete requires an empty wallet and zero sweep errors', () => {
  const transfer = { status: 'completed', destinationWallet: 'DestCtx11111111111111111111111111111111', walletEmpty: true };
  assert.equal(v2TransferHasWalletEmptyFinalSweepEvidence(transfer), true);
  assert.equal(v2TransferHasWalletEmptyFinalSweepEvidence({ ...transfer, tokenTransferErrors: [{ x: 1 }] }), false);
  assert.equal(v2TransferHasWalletEmptyFinalSweepEvidence({ ...transfer, walletEmpty: false }), false);
  assert.equal(v2TransferHasWalletEmptyFinalSweepEvidence(null), false);

  const journal = {
    ...interruptedLpJournal(),
    status: 'completed',
    stage: 'transfer_completed',
    lp: { results: [{ allocationIndex: 0, poolId: 'P', phase1Complete: true }], failedPhase: null },
    transfer,
  };
  const context = buildV2ExecutionContext({ journal, body: {} });
  assert.equal(context.transferComplete, true);
});

test('event replay merges lock evidence into opened positions', () => {
  const results = [];
  const journal = interruptedLpJournal();
  for (const event of journal.events) applyLpEventToResults(results, event, journal);
  assert.equal(results.length, 1);
  assert.equal(isResumeCheckpointResult(results[0]), true);
  const position = results[0].mainPositions[0];
  assert.equal(position.locked, true);
  assert.equal(position.txIds.open, 'openTx0');
  assert.equal(position.txIds.lock, 'lockTx0');
  assert.deepEqual(
    priorResultsFromJournal(journal).map((r) => r.poolId),
    ['PoolCtx111111111111111111111111111111111'],
  );
});