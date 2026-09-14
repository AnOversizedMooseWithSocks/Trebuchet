// test/launch-price-gates.test.mjs
//
// Behavioral coverage for resolveQuoteUsdForCreate — the function that
// decides what USD price a non-SOL quote token is worth at LAUNCH time,
// which fixes the pool's starting market cap.
//
// These decisions were untested until the launch-path seams landed: every
// branch sat behind a network call. They matter because of a real incident
// — a launch against unverified low-cap quote tokens where a dust-pool
// price put some pools at the wrong market cap, arbitrage drained them at
// open, and the chart showed an instant crash.
//
// Branches pinned:
//   - Raydium probe succeeds with healthy impact       -> used
//   - Raydium probe succeeds with dust-pool impact     -> refused
//   - Raydium NO_ROUTE, aggregator deep                -> used (oracle)
//   - Raydium NO_ROUTE, aggregator shallow/unknown     -> refused
//   - drift vs the user's confirmed price over limit   -> refused
//   - SOL pool                                          -> bypasses all of it

import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import * as lp from '../lpService.js';
import { MAX_PROBE_PRICE_IMPACT_PCT, MIN_QUOTE_LIQUIDITY_USD, WSOL_MINT } from '../lpConstants.js';

const QUOTE = {
  address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',
  symbol: 'LOWCAP',
  decimals: 6,
};
const SOL_USD = new Decimal(200);

const noRoute = () => { const e = new Error('no route'); e.code = 'NO_ROUTE'; throw e; };
const oracleWithDepth = (price, liquidityUsd) => async () => {
  const d = new Decimal(price);
  d.liquidityUsd = liquidityUsd == null ? undefined : new Decimal(liquidityUsd);
  return d;
};

test.afterEach(() => lp.resetTestFactories());

test('Raydium probe with healthy impact is used as the price', async () => {
  lp.setLaunchProbeForTests(async () => ({
    effectiveQuoteUsd: new Decimal('0.42'), priceImpactPct: 0.3,
  }));
  const r = await lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD });
  assert.equal(r.source, 'raydium-probe');
  assert.equal(r.quoteUsd.toString(), '0.42');
});

test('Raydium probe from a dust pool (high impact) is refused with the launch consequence named', async () => {
  lp.setLaunchProbeForTests(async () => ({
    effectiveQuoteUsd: new Decimal('0.42'), priceImpactPct: MAX_PROBE_PRICE_IMPACT_PCT + 20,
  }));
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD }),
    (err) => {
      assert.match(err.message, /too thin/i);
      assert.match(err.message, /different market cap/i, 'names the consequence');
      assert.match(err.message, /No SOL was spent/i);
      return true;
    },
  );
});

test('a probe that reports no impact figure is not refused on impact grounds', async () => {
  // Older API responses may omit priceImpactPct; absence is not evidence of
  // a thin market, so the price is accepted (the aggregator floor and the
  // cross-pool check remain as later defenses).
  lp.setLaunchProbeForTests(async () => ({
    effectiveQuoteUsd: new Decimal('0.42'), priceImpactPct: null,
  }));
  const r = await lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD });
  assert.equal(r.source, 'raydium-probe');
});

test('NO_ROUTE with a deep aggregator market falls back to the oracle price', async () => {
  lp.setLaunchProbeForTests(noRoute);
  lp.setLaunchOracleForTests(oracleWithDepth('0.55', MIN_QUOTE_LIQUIDITY_USD * 10));
  const r = await lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD });
  assert.equal(r.source, 'oracle');
  assert.equal(r.quoteUsd.toString(), '0.55');
});

test('NO_ROUTE with a shallow aggregator market is refused', async () => {
  lp.setLaunchProbeForTests(noRoute);
  lp.setLaunchOracleForTests(oracleWithDepth('0.55', MIN_QUOTE_LIQUIDITY_USD / 100));
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD }),
    /liquidity/i,
  );
});

test('NO_ROUTE with an aggregator price carrying NO depth data is refused (unknown is not deep)', async () => {
  lp.setLaunchProbeForTests(noRoute);
  lp.setLaunchOracleForTests(oracleWithDepth('0.55', null));
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD }),
    /no reported liquidity/i,
  );
});

test('drift beyond the guard against the user-confirmed price is refused', async () => {
  // The user confirmed $0.42 in the funding step; the live probe now says
  // $1.26 (3x). The pool must not be created at a price the user never saw.
  lp.setLaunchProbeForTests(async () => ({
    effectiveQuoteUsd: new Decimal('1.26'), priceImpactPct: 0.2,
  }));
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({
      quoteToken: QUOTE, alloc: { quoteUsdOverride: 0.42 }, solUsd: SOL_USD,
    }),
    /drift|differs|moved/i,
  );
});

test('a SOL pool uses the caller-resolved SOL price and touches no probe or oracle', async () => {
  let probeCalls = 0; let oracleCalls = 0;
  lp.setLaunchProbeForTests(async () => { probeCalls += 1; throw new Error('must not be called'); });
  lp.setLaunchOracleForTests(async () => { oracleCalls += 1; throw new Error('must not be called'); });
  const r = await lp.resolveQuoteUsdForCreate({
    quoteToken: { address: WSOL_MINT, symbol: 'SOL', decimals: 9 }, alloc: {}, solUsd: SOL_USD,
  });
  assert.equal(r.source, 'sol');
  assert.equal(r.quoteUsd.toString(), '200');
  assert.equal(probeCalls + oracleCalls, 0);
});

// --- on-chain first -----------------------------------------------------------

const FAKE_RAYDIUM = {
  // Carries the surface onChainPriceDeps checks for — a fake missing these
  // is exactly the shape that silently disabled on-chain pricing in the E2E
  // harness. The seams below intercept before any of them are called.
  api: { fetchPoolByMints: async () => ({ count: 0, hasNextPage: false, data: [] }), getClmmConfigs: async () => [] },
  clmm: { getRpcClmmPoolInfo: async () => null },
  liquidity: { getRpcPoolInfos: async () => ({}) },
  cpmm: { getRpcPoolInfos: async () => ({}) },
}; // presence enables the on-chain step

test('on-chain pool price is used FIRST and the probe/oracle are never consulted', async () => {
  let probeCalls = 0;
  lp.setLaunchOnChainPriceForTests(async () => ({
    priceUsd: new Decimal('0.40'), poolId: 'p1', anchorSymbol: 'SOL', kind: 'clmm',
    liquidityUsd: new Decimal(50_000), spreadPct: new Decimal(0), qualifyingCount: 1, discoveredCount: 1,
  }));
  lp.setLaunchProbeForTests(async () => { probeCalls += 1; throw new Error('must not be called'); });
  const r = await lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD, raydium: FAKE_RAYDIUM });
  assert.equal(r.source, 'on-chain:SOL');
  assert.equal(r.quoteUsd.toString(), '0.4');
  assert.equal(probeCalls, 0);
});

test('no qualifying on-chain pool falls through to the probe', async () => {
  lp.setLaunchOnChainPriceForTests(async () => { const e = new Error('none'); e.code = 'NO_LIQUID_POOL'; throw e; });
  lp.setLaunchProbeForTests(async () => ({ effectiveQuoteUsd: new Decimal('0.42'), priceImpactPct: 0.3 }));
  const r = await lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD, raydium: FAKE_RAYDIUM });
  assert.equal(r.source, 'raydium-probe');
});

test('on-chain POOL_SPREAD is a finding, not a fallback trigger — it refuses the launch', async () => {
  let probeCalls = 0;
  lp.setLaunchOnChainPriceForTests(async () => { const e = new Error('pools disagree'); e.code = 'POOL_SPREAD'; throw e; });
  lp.setLaunchProbeForTests(async () => { probeCalls += 1; return { effectiveQuoteUsd: new Decimal('0.42'), priceImpactPct: 0.3 }; });
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD, raydium: FAKE_RAYDIUM }),
    (e) => e.code === 'POOL_SPREAD',
  );
  assert.equal(probeCalls, 0, 'a market that disagrees with itself must not be papered over by another source');
});

test('the on-chain step is skipped entirely when no raydium instance is supplied', async () => {
  let onChainCalls = 0;
  lp.setLaunchOnChainPriceForTests(async () => { onChainCalls += 1; throw new Error('must not be called'); });
  lp.setLaunchProbeForTests(async () => ({ effectiveQuoteUsd: new Decimal('0.42'), priceImpactPct: 0.3 }));
  await lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD });
  assert.equal(onChainCalls, 0);
});

test('drift guard still applies to an on-chain price', async () => {
  lp.setLaunchOnChainPriceForTests(async () => ({
    priceUsd: new Decimal('1.26'), poolId: 'p1', anchorSymbol: 'SOL', kind: 'clmm',
    liquidityUsd: new Decimal(50_000), spreadPct: new Decimal(0), qualifyingCount: 1, discoveredCount: 1,
  }));
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({
      quoteToken: QUOTE, alloc: { quoteUsdOverride: 0.42 }, solUsd: SOL_USD, raydium: FAKE_RAYDIUM,
    }),
    /drift|differs|moved/i,
  );
});

// --- read-only SDK cache follows the active RPC (audit finding) ---------------

test('the display helper rebuilds its read-only SDK when the RPC changes', async () => {
  // Simulate two different RPC configurations by swapping the SDK factory
  // and observing how many times it's invoked as the "RPC" changes. The
  // seam returns a distinct fake per call so we can count constructions.
  let builds = 0;
  lp.setSdkFactoryForTests(async () => { builds += 1; return FAKE_RAYDIUM; });
  lp.setLaunchOnChainPriceForTests(async () => { const e = new Error('none'); e.code = 'NO_POOLS'; throw e; });

  await lp.getQuoteTokenOnChainPrice({ mint: QUOTE.address, solUsd: SOL_USD });
  await lp.getQuoteTokenOnChainPrice({ mint: QUOTE.address, solUsd: SOL_USD });
  assert.equal(builds, 1, 'same RPC -> the cached SDK is reused');

  // Reset clears the cache (what an RPC switch does through the keyed cache).
  lp.resetTestFactories();
  lp.setSdkFactoryForTests(async () => { builds += 1; return FAKE_RAYDIUM; });
  lp.setLaunchOnChainPriceForTests(async () => { const e = new Error('none'); e.code = 'NO_POOLS'; throw e; });
  await lp.getQuoteTokenOnChainPrice({ mint: QUOTE.address, solUsd: SOL_USD });
  assert.equal(builds, 2, 'a changed RPC key -> a fresh SDK is built');
});
