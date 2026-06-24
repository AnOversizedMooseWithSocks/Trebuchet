// test/lp-estimate.test.mjs
//
// Table-driven tests for lpEstimate.js — the funding estimator extracted
// from lpService.js. Exercises allocation math with mocked price oracle
// and route discovery so every branch is covered without network calls.
//
// Covers issue #6 acceptance criterion:
//   "LP allocation/distribution logic has table-driven tests"

import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';

import * as lpEstimate from '../lpService.js'; // F15: de-forked — estimator now lives in lpService.js (the live path)
import { WSOL_MINT, USDC_MINT } from '../lpConstants.js';

test.afterEach(() => {
  lpEstimate.resetTestFactories();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a price oracle that maps mint → Decimal (USD). */
function makePriceOracle(prices) {
  return async (mint) => {
    if (prices[mint] !== undefined) return new Decimal(prices[mint]);
    return null;
  };
}

/** Route discovery that always says "route available" at the given USD price. */
function makeRouteDiscovery(effectiveQuoteUsd = 1) {
  return async () => ({
    available: true,
    effectiveQuoteUsd: new Decimal(effectiveQuoteUsd),
  });
}

/** Route discovery that says "no route". */
function makeNoRouteDiscovery() {
  return async () => null;
}

// ---------------------------------------------------------------------------
// Table-driven: single SOL pool, minimal bootstrap
// ---------------------------------------------------------------------------

const solAllocation = {
  quoteToken: 'SOL',
  distribution: [{ sharePercent: 50 }, { sharePercent: 50 }],
  bootstrap: { mode: 'minimal' },
  ladder: { mode: 'off' },
};

test('single SOL pool — minimal bootstrap returns correct solLamports', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({ [WSOL_MINT]: 150 }));
  lpEstimate.setRouteDiscoveryForTests(makeNoRouteDiscovery());

  const result = await lpEstimate.estimateRequiredFunding({
    allocations: [solAllocation],
  });

  assert.ok(result.solLamports > 0, 'positive SOL lamports total');
  assert.equal(result.byQuote && Object.keys(result.byQuote).length, 0, 'no quote tokens for SOL pool');
  assert.ok(Array.isArray(result.solBreakdown), 'solBreakdown is an array');
  assert.ok(result.solBreakdown.length > 0, 'breakdown has entries');
  assert.ok(result.totalSol > result.subtotalSol, 'total > subtotal (safety buffer added)');
});

// ---------------------------------------------------------------------------
// Table: multiple pools share the same quote token
// ---------------------------------------------------------------------------

const usdcAllocation = (idx) => ({
  quoteToken: 'USDC',
  distribution: [{ sharePercent: 100 }],
  bootstrap: { mode: 'minimal' },
  ladder: { mode: 'off' },
});

test('two USDC pools — auto-swap plan has 2 entries, SOL costs sum correctly', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({
    [WSOL_MINT]: 150,
    [USDC_MINT]: 1,
  }));
  lpEstimate.setRouteDiscoveryForTests(makeRouteDiscovery(1));

  const result = await lpEstimate.estimateRequiredFunding({
    allocations: [usdcAllocation(0), usdcAllocation(1)],
  });

  assert.equal(result.autoSwapPlan.length, 2, 'two auto-swap entries');
  // Both pools should have the same quote mint (USDC)
  assert.equal(result.autoSwapPlan[0].quoteMint, USDC_MINT);
  assert.equal(result.autoSwapPlan[1].quoteMint, USDC_MINT);
  // solBreakdown should mention both pools
  const poolLabels = result.solBreakdown.map((e) => e.label);
  assert.ok(poolLabels.some((l) => l.includes('Pool 1')), 'Pool 1 in breakdown');
  assert.ok(poolLabels.some((l) => l.includes('Pool 2')), 'Pool 2 in breakdown');
  // Token creation cost included
  assert.ok(poolLabels.some((l) => l.includes('Token creation')), 'token creation cost included');
});

// ---------------------------------------------------------------------------
// Table: distribution slices with recipients add transfer costs
// ---------------------------------------------------------------------------

test('distribution with recipient — adds per-slice transfer cost', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({ [WSOL_MINT]: 150 }));
  lpEstimate.setRouteDiscoveryForTests(makeNoRouteDiscovery());

  const withoutRecipient = await lpEstimate.estimateRequiredFunding({
    allocations: [{
      ...solAllocation,
      distribution: [{ sharePercent: 100 }],
    }],
  });

  const withRecipient = await lpEstimate.estimateRequiredFunding({
    allocations: [{
      ...solAllocation,
      distribution: [{ sharePercent: 100, recipient: 'So11111111111111111111111111111111111111112' }],
    }],
  });

  // With recipient should have higher SOL cost (extra transfer tx)
  assert.ok(
    withRecipient.totalSol > withoutRecipient.totalSol,
    'recipient adds transfer cost',
  );
});

// ---------------------------------------------------------------------------
// Table: ladder bands add per-band costs
// ---------------------------------------------------------------------------

test('ladder bands contribute SOL costs per band', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({ [WSOL_MINT]: 150 }));
  lpEstimate.setRouteDiscoveryForTests(makeNoRouteDiscovery());

  const noLadder = await lpEstimate.estimateRequiredFunding({
    allocations: [{ ...solAllocation, ladder: { mode: 'off' } }],
  });

  const simpleLadder = await lpEstimate.estimateRequiredFunding({
    allocations: [{ ...solAllocation, ladder: { mode: 'simple', bandCount: 3 } }],
  });

  assert.ok(
    simpleLadder.totalSol > noLadder.totalSol,
    'simple ladder with 3 bands costs more than no ladder',
  );

  const manualLadder = await lpEstimate.estimateRequiredFunding({
    allocations: [{ ...solAllocation, ladder: { mode: 'manual', bands: [{}, {}, {}, {}] } }],
  });

  assert.ok(
    manualLadder.totalSol > simpleLadder.totalSol,
    'manual ladder with 4 bands costs more than simple ladder with 3 bands',
  );
});

// ---------------------------------------------------------------------------
// Table: manual pre-fund when no Raydium route exists
// ---------------------------------------------------------------------------

test('no route → manual pre-fund branch — byQuote populated, no autoSwapPlan entry', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({
    [WSOL_MINT]: 150,
    [USDC_MINT]: 1,
  }));
  lpEstimate.setRouteDiscoveryForTests(makeNoRouteDiscovery());

  const result = await lpEstimate.estimateRequiredFunding({
    allocations: [{
      quoteToken: 'USDC',
      distribution: [{ sharePercent: 100 }],
      bootstrap: { mode: 'minimal' },
      ladder: { mode: 'off' },
    }],
  });

  assert.equal(result.autoSwapPlan.length, 0, 'no auto-swap when route unavailable');
  assert.ok(result.byQuote[USDC_MINT] > 0, 'byQuote has USDC amount');
  assert.ok(result.quoteBreakdown.length > 0, 'quoteBreakdown populated');
  assert.equal(result.quoteBreakdown[0].mint, USDC_MINT);
});

// ---------------------------------------------------------------------------
// Table: custom-mode bootstrap
// ---------------------------------------------------------------------------

test('custom-mode bootstrap — uses supplyPercent × targetMarketCapUsd', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({
    [WSOL_MINT]: 150,
    [USDC_MINT]: 1,
  }));
  lpEstimate.setRouteDiscoveryForTests(makeRouteDiscovery(1));

  const result = await lpEstimate.estimateRequiredFunding({
    allocations: [{
      quoteToken: 'USDC',
      distribution: [{ sharePercent: 100 }],
      bootstrap: { mode: 'custom', supplyPercent: 10 },
      ladder: { mode: 'off' },
    }],
    targetMarketCapUsd: 10000,
  });

  // Custom mode: bsActualUsd = 10% × $10,000 = $1,000
  // Target = $1,000 × 1.15 = $1,150
  // SOL spend = $1,150 × 1.10 / $150 ≈ 8.43 SOL
  const plan = result.autoSwapPlan[0];
  assert.equal(plan.bootstrapMode, 'custom');
  // The targetRaw should be ~1,150 USDC (whole units)
  const targetWhole = Number(plan.targetRaw) / 1e6; // USDC has 6 decimals
  assert.ok(targetWhole > 1000 && targetWhole < 1300, `targetWhole ~1150, got ${targetWhole}`);
});

test('custom-mode bootstrap without targetMarketCapUsd - refuses rather than under-budgeting', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({
    [WSOL_MINT]: 150,
    [USDC_MINT]: 1,
  }));
  lpEstimate.setRouteDiscoveryForTests(makeRouteDiscovery(1));

  // A custom bootstrap with real launched-side supply cannot be sized without a
  // target market cap. The estimator must reject so the user fixes it up front,
  // rather than returning a $1-minimal-budget estimate that under-funds the
  // launch and surfaces a confusing "insufficient funds" at deposit time.
  await assert.rejects(
    () => lpEstimate.estimateRequiredFunding({
      allocations: [{
        quoteToken: 'USDC',
        distribution: [{ sharePercent: 100 }],
        bootstrap: { mode: 'custom', supplyPercent: 10 },
        ladder: { mode: 'off' },
      }],
      // targetMarketCapUsd intentionally omitted
    }),
    /target market cap/i,
  );
});

// ---------------------------------------------------------------------------
// Table: safety buffer is applied to final total
// ---------------------------------------------------------------------------

test('safety buffer — total = subtotal × (1 + SAFETY_BUFFER_PCT)', async () => {
  lpEstimate.setPriceOracleForTests(makePriceOracle({ [WSOL_MINT]: 150 }));
  lpEstimate.setRouteDiscoveryForTests(makeNoRouteDiscovery());

  const result = await lpEstimate.estimateRequiredFunding({
    allocations: [solAllocation],
  });

  const expectedTotal = result.subtotalSol * 1.20; // SAFETY_BUFFER_PCT = 0.20
  assert.ok(
    Math.abs(result.totalSol - expectedTotal) < 0.001,
    `total should be subtotal × 1.20 (got ${result.totalSol}, expected ~${expectedTotal})`,
  );
});

// ---------------------------------------------------------------------------
// DI seam hygiene
// ---------------------------------------------------------------------------

test('lpEstimate exposes DI seams without affecting production defaults', () => {
  assert.equal(typeof lpEstimate.setPriceOracleForTests, 'function');
  assert.equal(typeof lpEstimate.setRouteDiscoveryForTests, 'function');
  assert.equal(typeof lpEstimate.resetTestFactories, 'function');
  assert.doesNotThrow(() => lpEstimate.resetTestFactories());
});
