// Unit coverage for the devnet recovery drill's pure logic. The funded run
// itself is secret-gated (see test/e2e/devnet-recovery-drills.mjs); these
// tests keep the reconciliation invariants honest in normal CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDrillConfig,
  isKillPoint,
  reconcileDrillJournal,
  TOKEN_STAGE_ENDPOINTS,
} from './e2e/devnet-recovery-drills.mjs';

const WALLET = 'DrillWallet111111111111111111111111111111';

test('drill config is a minimal single-pool guarded launch', () => {
  const config = buildDrillConfig({ walletPublicKey: WALLET, sweepDestination: WALLET });
  assert.equal(config.mode, 'guarded');
  assert.equal(config.poolTopology.pools.length, 1);
  assert.equal(config.poolTopology.pools[0].quoteSymbol, 'SOL');
  assert.equal(config.poolTopology.sweepDestination, WALLET);
  assert.ok(config.launchSol > 0 && config.launchSol <= 0.05);
  assert.deepEqual(
    TOKEN_STAGE_ENDPOINTS,
    ['/api/create-token', '/api/finish-token-creation'],
  );
});

test('kill points land exactly on the configured boundary', () => {
  assert.equal(isKillPoint({ completedOperations: 1, killAfterOperation: 1 }), true);
  assert.equal(isKillPoint({ completedOperations: 2, killAfterOperation: 1 }), false);
  assert.equal(isKillPoint({ completedOperations: 1, killAfterOperation: 0 }), false);
  assert.equal(isKillPoint({ completedOperations: 1, killAfterOperation: null }), false);
});

test('reconciliation accepts a clean single-mint journal', () => {
  const journal = {
    stage: 'token_created',
    token: { mint: 'MintDrill1111111111111111111111111111111' },
    events: [
      { stage: 'wallet_generated' },
      { stage: 'token_create_started' },
      { stage: 'token_created', tokenMint: 'MintDrill1111111111111111111111111111111' },
    ],
  };
  const result = reconcileDrillJournal({
    journal,
    executedEndpoints: ['/api/create-token', '/api/finish-token-creation'],
    resumed: true,
  });
  assert.equal(result.ok, true, result.issues.join('; '));
  assert.deepEqual(result.tokenMints, ['MintDrill1111111111111111111111111111111']);
  assert.equal(result.eventCount, 3);
});

test('reconciliation rejects a double mint', () => {
  const journal = {
    token: { mint: 'MintA111111111111111111111111111111111' },
    events: [
      { stage: 'token_created', tokenMint: 'MintA111111111111111111111111111111111' },
      { stage: 'token_created', tokenMint: 'MintB111111111111111111111111111111111' },
    ],
  };
  const result = reconcileDrillJournal({ journal, executedEndpoints: ['/api/create-token', '/api/create-token'] });
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes('2 distinct token mints')));
  assert.ok(result.issues.some((issue) => issue.includes('executed 2 times')));
});

test('reconciliation rejects a missing token and an empty resumed journal', () => {
  const missing = reconcileDrillJournal({ journal: { events: [] }, executedEndpoints: [], resumed: false });
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.includes('no token mint')));

  const emptyResume = reconcileDrillJournal({
    journal: { token: { mint: 'MintX111111111111111111111111111111111' }, events: [] },
    executedEndpoints: ['/api/create-token'],
    resumed: true,
  });
  assert.equal(emptyResume.ok, false);
  assert.ok(emptyResume.issues.some((issue) => issue.includes('no events despite a resumed drill')));
});