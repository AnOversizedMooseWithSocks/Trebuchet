// test/price-disambiguation.test.mjs
//
// Unit tests for the price-source disambiguation helpers exported
// from tokenInfoService.js. These exercise the actual logic that
// determines whether a returned USD price is correct, without
// touching the network.
//
// The headline test (Gecko Test 2) is the regression case for the
// bug a real user hit: a flywheel quote token whose top pool has
// it on the quote side. The old code naively read base_token_price_usd
// and returned the OTHER token's price, silently creating pools at
// wildly wrong ratios.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractPriceFromGeckoPools,
  extractPriceFromDexScreenerPairs,
} from '../tokenInfoService.js';

// Synthetic Solana mints (32-char base58 — don't need to be real on chain).
const XLRT  = 'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj';
const SOL   = 'So11111111111111111111111111111111111111112';
const OTHER = 'OTHER1111111111111111111111111111111111111111';

// ---------------------------------------------------------------------------
// Gecko /pools disambiguation
// ---------------------------------------------------------------------------

test('Gecko: our token is BASE — return base_token_price_usd directly', () => {
  const json = {
    data: [{
      type: 'pool',
      attributes: {
        base_token_price_usd:  '0.05',  // XLRT (base) price
        quote_token_price_usd: '150',   // SOL (quote) price
        base_token_price_quote_token: '0.000333',
        quote_token_price_base_token: '3000',
        name: 'XLRT / SOL',
      },
      relationships: {
        base_token:  { data: { id: `solana_${XLRT}` } },
        quote_token: { data: { id: `solana_${SOL}` } },
      },
    }],
  };
  const result = extractPriceFromGeckoPools(XLRT, json);
  assert.ok(result, 'should return a price');
  assert.equal(result.toString(), '0.05');
});

test('Gecko: our token is QUOTE — return quote_token_price_usd, not base (REGRESSION)', () => {
  // This is the historical bug case. Pool name is OTHER/XLRT, XLRT is
  // the quote side. Old code returned $0.05 (OTHER's price). The fix
  // must return $150 (XLRT's price).
  const json = {
    data: [{
      type: 'pool',
      attributes: {
        base_token_price_usd:  '0.05',  // OTHER (base) price
        quote_token_price_usd: '150',   // XLRT (quote) price — what we want
        base_token_price_quote_token: '0.000333',
        quote_token_price_base_token: '3000',
        name: 'OTHER / XLRT',
      },
      relationships: {
        base_token:  { data: { id: `solana_${OTHER}` } },
        quote_token: { data: { id: `solana_${XLRT}` } },
      },
    }],
  };
  const result = extractPriceFromGeckoPools(XLRT, json);
  assert.ok(result, 'should return a price');
  assert.equal(result.toString(), '150', 'must return XLRT (quote-side) price, not OTHER');
});

test('Gecko: pool with missing relationships block is SKIPPED, not guessed', () => {
  // First pool has no relationships — we can't tell which side is ours,
  // so we must skip it. Second pool is clean and gives the answer.
  const json = {
    data: [
      {
        attributes: {
          base_token_price_usd: '99999',  // garbage; arbitrary guessing
                                          // would return this and be wrong
          name: 'BROKEN',
        },
        // relationships intentionally missing
      },
      {
        attributes: {
          base_token_price_usd:  '0.05',
          quote_token_price_usd: '150',
          name: 'OTHER / XLRT',
        },
        relationships: {
          base_token:  { data: { id: `solana_${OTHER}` } },
          quote_token: { data: { id: `solana_${XLRT}` } },
        },
      },
    ],
  };
  const result = extractPriceFromGeckoPools(XLRT, json);
  assert.equal(result.toString(), '150', 'should skip broken pool, use clean one');
});

test('Gecko: derive from cross-ratio when direct USD missing', () => {
  // base_token_price_usd absent; quote side has USD + ratio.
  // 1 XLRT (base) = 0.000333 SOL (quote)
  // SOL = $150
  // XLRT = 150 * 0.000333 = $0.04995
  const json = {
    data: [{
      attributes: {
        // base_token_price_usd: missing
        quote_token_price_usd: '150',
        base_token_price_quote_token: '0.000333',
        name: 'XLRT / SOL',
      },
      relationships: {
        base_token:  { data: { id: `solana_${XLRT}` } },
        quote_token: { data: { id: `solana_${SOL}` } },
      },
    }],
  };
  const result = extractPriceFromGeckoPools(XLRT, json);
  assert.ok(result, 'should derive a price');
  assert.equal(result.toString(), '0.04995');
});

test('Gecko: returns null when all pools have neither relationship match nor data', () => {
  const json = {
    data: [
      { attributes: { base_token_price_usd: '99' } /* no rels */ },
      { attributes: {}, relationships: { base_token: { data: { id: 'solana_OTHER' } } } },
    ],
  };
  const result = extractPriceFromGeckoPools(XLRT, json);
  assert.equal(result, null);
});

test('Gecko: returns null on empty / malformed response', () => {
  assert.equal(extractPriceFromGeckoPools(XLRT, {}), null);
  assert.equal(extractPriceFromGeckoPools(XLRT, { data: [] }), null);
  assert.equal(extractPriceFromGeckoPools(XLRT, null), null);
  assert.equal(extractPriceFromGeckoPools(XLRT, { data: 'not-array' }), null);
});

test('Gecko: skips pool where direct price is zero or negative', () => {
  // A "price" of 0 or negative is a data error. We should treat it
  // as missing and try derivation, then the next pool.
  const json = {
    data: [
      {
        attributes: {
          base_token_price_usd:  '0',   // bad data
          // No quote/ratio either → no derivation possible
          name: 'XLRT / SOL',
        },
        relationships: {
          base_token:  { data: { id: `solana_${XLRT}` } },
          quote_token: { data: { id: `solana_${SOL}` } },
        },
      },
      {
        attributes: {
          base_token_price_usd: '0.05',
          name: 'XLRT / OTHER',
        },
        relationships: {
          base_token:  { data: { id: `solana_${XLRT}` } },
          quote_token: { data: { id: `solana_${OTHER}` } },
        },
      },
    ],
  };
  const result = extractPriceFromGeckoPools(XLRT, json);
  assert.equal(result.toString(), '0.05');
});

// ---------------------------------------------------------------------------
// DexScreener disambiguation
// ---------------------------------------------------------------------------

test('DexScreener: our token is BASE — return priceUsd directly', () => {
  const pairs = [{
    baseToken:  { address: XLRT },
    quoteToken: { address: SOL },
    priceUsd:    '0.05',
    priceNative: '0.000333',
  }];
  const result = extractPriceFromDexScreenerPairs(XLRT, pairs);
  assert.ok(result);
  assert.equal(result.toString(), '0.05');
});

test('DexScreener: our token is QUOTE — derive via priceUsd / priceNative (REGRESSION)', () => {
  // priceUsd is the SOL (base) price. priceNative is "how many XLRT per SOL".
  // Want XLRT's USD price: 150 / 3000 = 0.05.
  const pairs = [{
    baseToken:  { address: SOL },
    quoteToken: { address: XLRT },
    priceUsd:    '150',     // SOL's price
    priceNative: '3000',    // 3000 XLRT per 1 SOL
  }];
  const result = extractPriceFromDexScreenerPairs(XLRT, pairs);
  assert.ok(result);
  assert.equal(result.toString(), '0.05');
});

test('DexScreener: prefer base-side direct over quote-side derived when both available', () => {
  // First pair has our token as quote (would require derivation).
  // Second pair has our token as base (direct). We should prefer the
  // base-side direct value.
  const pairs = [
    {
      baseToken:  { address: SOL },
      quoteToken: { address: XLRT },
      priceUsd:    '150',
      priceNative: '3000',  // would derive 0.05
    },
    {
      baseToken:  { address: XLRT },
      quoteToken: { address: SOL },
      priceUsd:    '0.052',  // tiny difference: confirms we use this
      priceNative: '0.000347',
    },
  ];
  const result = extractPriceFromDexScreenerPairs(XLRT, pairs);
  assert.equal(result.toString(), '0.052');
});

test('DexScreener: returns null when our token only on quote side AND priceNative missing', () => {
  // No safe inversion possible without priceNative — must return null
  // rather than guessing.
  const pairs = [{
    baseToken:  { address: SOL },
    quoteToken: { address: XLRT },
    priceUsd:    '150',
    // priceNative missing
  }];
  const result = extractPriceFromDexScreenerPairs(XLRT, pairs);
  assert.equal(result, null);
});

test('DexScreener: returns null when our token absent from all pairs', () => {
  const pairs = [{
    baseToken:  { address: OTHER },
    quoteToken: { address: SOL },
    priceUsd:    '150',
    priceNative: '0.0001',
  }];
  const result = extractPriceFromDexScreenerPairs(XLRT, pairs);
  assert.equal(result, null);
});

test('DexScreener: returns null on empty / non-array input', () => {
  assert.equal(extractPriceFromDexScreenerPairs(XLRT, []), null);
  assert.equal(extractPriceFromDexScreenerPairs(XLRT, null), null);
  assert.equal(extractPriceFromDexScreenerPairs(XLRT, 'not-array'), null);
  assert.equal(extractPriceFromDexScreenerPairs(XLRT, undefined), null);
});

test('DexScreener: skips pairs where priceUsd or priceNative is non-positive', () => {
  // Bad data in first pair, good data in second.
  const pairs = [
    {
      baseToken:  { address: XLRT },
      quoteToken: { address: SOL },
      priceUsd:    '0',    // bad
      priceNative: '0.000333',
    },
    {
      baseToken:  { address: XLRT },
      quoteToken: { address: OTHER },
      priceUsd:    '0.05',
      priceNative: '1.0',
    },
  ];
  const result = extractPriceFromDexScreenerPairs(XLRT, pairs);
  assert.equal(result.toString(), '0.05');
});

// ===========================================================================
// Liquidity-aware pool selection.
//
// Regression case: a launch whose quote tokens were unverified low-caps
// (Jupiter-unverified, DexScreener-unverified, shown as spam/$0 in
// Phantom). The extractors returned the FIRST indexed pool's price
// regardless of depth, so a dust pool's last-trade price became the launch
// reference. That put one pool at a different market cap than its
// siblings; arbitrage drained the cheap side immediately and the chart
// opened with a crash.
//
// The rule these pin: among candidate pools, the DEEPEST one wins, and the
// selected depth is reported so callers can refuse a price no real market
// backs.
// ===========================================================================

const TOKEN = 'So11111111111111111111111111111111111111112';

function geckoPool({ price, reserve, isBase = true }) {
  return {
    attributes: {
      [isBase ? 'base_token_price_usd' : 'quote_token_price_usd']: String(price),
      reserve_in_usd: reserve == null ? undefined : String(reserve),
    },
    relationships: {
      base_token: { data: { id: isBase ? `solana_${TOKEN}` : 'solana_other' } },
      quote_token: { data: { id: isBase ? 'solana_other' : `solana_${TOKEN}` } },
    },
  };
}

test('Gecko: the deepest pool wins, not the first listed', () => {
  // Dust pool listed first with an absurd price; real market second.
  const json = { data: [
    geckoPool({ price: '999.0', reserve: 25 }),
    geckoPool({ price: '1.50', reserve: 2_000_000 }),
  ] };
  const price = extractPriceFromGeckoPools(TOKEN, json);
  assert.equal(price.toString(), '1.5',
    'a $25 pool must not outrank a $2M pool just by being listed first');
});

test('Gecko: the selected pool\'s liquidity is reported to the caller', () => {
  const json = { data: [geckoPool({ price: '1.50', reserve: 2_000_000 })] };
  const price = extractPriceFromGeckoPools(TOKEN, json);
  assert.ok(price.liquidityUsd, 'liquidityUsd must be attached');
  assert.equal(price.liquidityUsd.toString(), '2000000');
});

test('Gecko: missing reserve data reports zero depth rather than guessing', () => {
  // The launch path treats unknown depth as "cannot prove this is real"
  // and refuses — so it must read as zero, never as absent-but-fine.
  const json = { data: [geckoPool({ price: '1.50', reserve: null })] };
  const price = extractPriceFromGeckoPools(TOKEN, json);
  assert.equal(price.liquidityUsd.toString(), '0');
});

test('Gecko: with no depth data anywhere, original ordering is preserved', () => {
  // Back-compat: responses carrying no reserves behave exactly as before.
  const json = { data: [
    geckoPool({ price: '7.00', reserve: null }),
    geckoPool({ price: '9.00', reserve: null }),
  ] };
  assert.equal(extractPriceFromGeckoPools(TOKEN, json).toString(), '7');
});

test('DexScreener: the deepest pair wins, not the first listed', () => {
  const pairs = [
    { baseToken: { address: TOKEN }, priceUsd: '500.0', liquidity: { usd: 40 } },
    { baseToken: { address: TOKEN }, priceUsd: '2.25', liquidity: { usd: 1_500_000 } },
  ];
  const price = extractPriceFromDexScreenerPairs(TOKEN, pairs);
  assert.equal(price.toString(), '2.25');
  assert.equal(price.liquidityUsd.toString(), '1500000');
});

test('DexScreener: a base-side match still beats a derived quote-side one at equal depth', () => {
  // Ordering within equal depth is preserved, so the direct (pass 1)
  // reading still takes precedence over the derived (pass 2) one.
  const pairs = [
    { quoteToken: { address: TOKEN }, baseToken: { address: 'x' },
      priceUsd: '100', priceNative: '50', liquidity: { usd: 1000 } },
    { baseToken: { address: TOKEN }, priceUsd: '3.00', liquidity: { usd: 1000 } },
  ];
  assert.equal(extractPriceFromDexScreenerPairs(TOKEN, pairs).toString(), '3');
});

test('DexScreener: missing liquidity field reports zero depth', () => {
  const pairs = [{ baseToken: { address: TOKEN }, priceUsd: '3.00' }];
  const price = extractPriceFromDexScreenerPairs(TOKEN, pairs);
  assert.equal(price.liquidityUsd.toString(), '0');
});
