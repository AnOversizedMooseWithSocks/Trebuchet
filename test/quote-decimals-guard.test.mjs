// test/quote-decimals-guard.test.mjs
//
// Guards against the "some pools opened at the wrong market cap" failure.
//
// Quote-token decimals feed priceToSqrtPriceX64, so being wrong by N scales
// a pool's starting price by 10^N. Because each pool is priced
// independently, one bad decimals value lands ONE pool at a wildly wrong
// market cap while its siblings are correct — arbitrage then drains the
// cheap side the instant trading opens and the chart shows a crash.
//
// SPL mint decimals are immutable, so a caller-supplied override that
// disagrees with the authoritative value is definitively wrong, never
// merely stale. These tests pin that it is refused rather than trusted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQuoteToken } from '../lpService.js';

// The known-quote branch (SOL/USDC/USDT) needs no RPC — decimals come from
// the module's own table. It was the most dangerous branch precisely
// because there is no on-chain read there to contradict a bad override.
const NO_CONNECTION = null;

test('known quote resolves its canonical decimals with no override', async () => {
  const sol = await resolveQuoteToken(NO_CONNECTION, 'SOL');
  assert.equal(sol.decimals, 9, 'SOL is 9 decimals');
  const usdc = await resolveQuoteToken(NO_CONNECTION, 'USDC');
  assert.equal(usdc.decimals, 6, 'USDC is 6 decimals');
});

test('an override that MATCHES the canonical decimals is accepted', async () => {
  const sol = await resolveQuoteToken(NO_CONNECTION, 'SOL', { decimals: 9 });
  assert.equal(sol.decimals, 9);
});

test('an override that CONTRADICTS the canonical decimals is refused', async () => {
  // 9 -> 6 would scale the pool's starting price by 1000x.
  await assert.rejects(
    () => resolveQuoteToken(NO_CONNECTION, 'SOL', { decimals: 6 }),
    /decimals/i,
  );
  await assert.rejects(
    () => resolveQuoteToken(NO_CONNECTION, 'USDC', { decimals: 9 }),
    /decimals/i,
  );
});

test('the refusal explains the impact and states no SOL was spent', async () => {
  // The user needs to know this is recoverable and what to change; a bare
  // "invalid decimals" would read as a crash mid-launch.
  await assert.rejects(
    () => resolveQuoteToken(NO_CONNECTION, 'SOL', { decimals: 6 }),
    (err) => {
      assert.match(err.message, /market cap/i, 'names the consequence');
      assert.match(err.message, /Advanced settings/i, 'says where to fix it');
      assert.match(err.message, /No SOL was spent/i, 'reassures nothing was lost');
      return true;
    },
  );
});

test('non-integer and garbage overrides are refused, not coerced', async () => {
  for (const bad of [9.5, 'nine', NaN, Infinity, {}]) {
    await assert.rejects(
      () => resolveQuoteToken(NO_CONNECTION, 'SOL', { decimals: bad }),
      /decimals/i,
      `override ${JSON.stringify(bad)} must be refused`,
    );
  }
});

test('a symbol override is still allowed — only decimals are load-bearing', async () => {
  const t = await resolveQuoteToken(NO_CONNECTION, 'SOL', { symbol: 'wSOL' });
  assert.equal(t.symbol, 'wSOL');
  assert.equal(t.decimals, 9, 'decimals remain canonical');
});
