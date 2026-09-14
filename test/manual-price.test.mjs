// test/manual-price.test.mjs
//
// When no market source can price a quote token, the user is asked for the
// current USD price and that number becomes the pool's price source of
// last resort. Before this, the launch path threw with "set a price
// manually in the Advanced override field" — but the override was only the
// drift-guard REFERENCE, never a source, so following the instruction
// still could not launch. Also pins: the demo preflight handler, and the
// second-opinion check that replaced a vacuous cross-pool check.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Decimal from 'decimal.js';
import * as lp from '../lpService.js';
import * as demo from '../demoChainService.js';
import { MIN_QUOTE_LIQUIDITY_USD, MAX_SECOND_OPINION_SPREAD_PCT } from '../lpConstants.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const QUOTE = { address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', symbol: 'LOWCAP', decimals: 6 };
const SOL_USD = new Decimal(200);
const noRoute = () => { const e = new Error('no route'); e.code = 'NO_ROUTE'; throw e; };
const withDepth = (price, liq) => { const d = new Decimal(price); d.liquidityUsd = liq == null ? undefined : new Decimal(liq); return d; };

test.afterEach(() => lp.resetTestFactories());

// ---- launch path ---------------------------------------------------------------

test('no route, no aggregator, no user price -> refused with a typed error', async () => {
  lp.setLaunchProbeForTests(noRoute);
  lp.setLaunchOracleForTests(async () => null);
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: {}, solUsd: SOL_USD }),
    (e) => e.code === 'NO_PRICE_SOURCE' && /Enter its current USD price/.test(e.message),
  );
});

test('no route, no aggregator, USER-ENTERED price -> used, source "user"', async () => {
  lp.setLaunchProbeForTests(noRoute);
  lp.setLaunchOracleForTests(async () => null);
  const r = await lp.resolveQuoteUsdForCreate({
    quoteToken: QUOTE, alloc: { quoteUsdOverride: 0.0042, priceEnteredByUser: true }, solUsd: SOL_USD,
  });
  assert.equal(r.source, 'user');
  assert.equal(r.quoteUsd.toString(), '0.0042');
});

test('an override WITHOUT the user-entered flag is still only a drift reference, not a source', async () => {
  // A resolved price echoed back as quoteUsdOverride must not become a
  // source on its own — that would defeat "no source -> refuse".
  lp.setLaunchProbeForTests(noRoute);
  lp.setLaunchOracleForTests(async () => null);
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({ quoteToken: QUOTE, alloc: { quoteUsdOverride: 0.0042 }, solUsd: SOL_USD }),
    (e) => e.code === 'NO_PRICE_SOURCE',
  );
});

test('a dust-market aggregator price is rescued by a user-entered price', async () => {
  lp.setLaunchProbeForTests(noRoute);
  lp.setLaunchOracleForTests(async () => withDepth('9.99', MIN_QUOTE_LIQUIDITY_USD / 100));
  const r = await lp.resolveQuoteUsdForCreate({
    quoteToken: QUOTE, alloc: { quoteUsdOverride: 0.5, priceEnteredByUser: true }, solUsd: SOL_USD,
  });
  assert.equal(r.source, 'user');
  assert.equal(r.quoteUsd.toString(), '0.5', 'the dust price is not used');
});

test('a thin Raydium probe is rescued by a user-entered price', async () => {
  lp.setLaunchProbeForTests(async () => ({ effectiveQuoteUsd: new Decimal('9.99'), priceImpactPct: 40 }));
  const r = await lp.resolveQuoteUsdForCreate({
    quoteToken: QUOTE, alloc: { quoteUsdOverride: 0.5, priceEnteredByUser: true }, solUsd: SOL_USD,
  });
  assert.equal(r.source, 'user');
});

test('when a market source exists, it wins over the user price and the drift guard applies', async () => {
  lp.setLaunchProbeForTests(async () => ({ effectiveQuoteUsd: new Decimal('0.42'), priceImpactPct: 0.3 }));
  const r = await lp.resolveQuoteUsdForCreate({
    quoteToken: QUOTE, alloc: { quoteUsdOverride: 0.41, priceEnteredByUser: true }, solUsd: SOL_USD,
  });
  assert.equal(r.source, 'raydium-probe', 'a real market beats a typed number');
  await assert.rejects(
    () => lp.resolveQuoteUsdForCreate({
      quoteToken: QUOTE, alloc: { quoteUsdOverride: 1.26, priceEnteredByUser: true }, solUsd: SOL_USD,
    }),
    /drift|differs|moved/i, 'a typed number far from the market is refused, not silently overridden',
  );
});

test('the user-entered flag rides the allocation payload from the funding step', () => {
  assert.match(read('public/modules/funding.js'), /priceEnteredByUser: p\.priceEnteredByUser === true/);
});

// ---- second opinion (replaces the vacuous cross-pool check) --------------------

test('the old cross-pool market-cap check is gone (it could never fire)', () => {
  const src = read('lpService.js');
  assert.doesNotMatch(src, /Pools would open at different market caps/);
  assert.match(src, /Second-opinion check/);
});

test('constant: second-opinion spread is generous but catches a 3x error', () => {
  assert.equal(MAX_SECOND_OPINION_SPREAD_PCT, 25);
});

// ---- demo preflight -------------------------------------------------------------

test('demo preflight prices any quote token synthetically, mirroring the real shape', () => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  demo.handlePreflightCreateLp({ body: {
    tokenTotalSupply: '1000000000', targetMarketCapUsd: '100000',
    allocations: [{ quoteToken: 'SOL', supplyPercent: 50 }, { quoteToken: 'SomeCustomMint111', supplyPercent: 50 }],
  } }, res);
  assert.equal(res.code, 200);
  const rp = res.body.preflight.resolvedPrices;
  assert.equal(rp.length, 2);
  for (const p of rp) for (const k of ['allocationIndex', 'quoteMint', 'quoteSymbol', 'quoteUsd', 'source', 'driftPct', 'initialPrice']) assert.ok(k in p, `missing ${k}`);
  assert.equal(rp[0].source, 'sol');
  assert.ok(Number(rp[1].initialPrice) > 0);
});

test('demo preflight honours a user-entered price', () => {
  const res = { body: null, status() { return this; }, json(b) { this.body = b; return this; } };
  demo.handlePreflightCreateLp({ body: {
    tokenTotalSupply: '1000000000', targetMarketCapUsd: '100000',
    allocations: [{ quoteToken: 'SomeCustomMint111', supplyPercent: 100, quoteUsdOverride: 0.25, priceEnteredByUser: true }],
  } }, res);
  assert.equal(res.body.preflight.resolvedPrices[0].source, 'user');
  assert.equal(res.body.preflight.resolvedPrices[0].quoteUsd, '0.25');
});

test('server routes preflight to the demo handler in demo mode', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/preflight-create-lp'");
  assert.match(server.slice(idx, idx + 400), /if \(isDemoMode\(\)\) return demoChainService\.handlePreflightCreateLp\(req, res\)/);
});

// ---- dialog wiring ---------------------------------------------------------------

test('the editor asks for a price when none resolves, once per token, and labels it user-set', () => {
  const src = read('public/modules/pool-editor.js');
  const html = read('public/index.html');
  assert.match(html, /id="manualPriceModal"/);
  assert.match(src, /function maybePromptForManualPrice\(pool\)/);
  assert.match(src, /manualPricePromptedFor === pool\.quoteToken/, 'asks once per token');
  assert.match(src, /pool\.priceEnteredByUser = true;/);
  assert.match(src, /data-action="enterPrice"/, 'the card offers a way to (re)enter it');
  assert.match(src, /click "Enter price" on the pool card/, 'the blocking reason says how to proceed');
});
