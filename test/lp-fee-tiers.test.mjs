import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeFeeTierList, FALLBACK_FEE_TIERS } from '../lpFeeTiers.js';

test('normalizes a real-looking Raydium API response (bare array)', () => {
  const raw = [
    { index: 1, tradeFeeRate: 2500, tickSpacing: 60, description: '0.25%' },
    { index: 5, tradeFeeRate: 500, tickSpacing: 1 },
    { index: 4, tradeFeeRate: 100, tickSpacing: 1 },
  ];
  const result = normalizeFeeTierList(raw);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0], { index: 4, tradeFeeRate: 100, tickSpacing: 1 });
  assert.deepEqual(result[1], { index: 5, tradeFeeRate: 500, tickSpacing: 1 });
  assert.deepEqual(result[2], { index: 1, tradeFeeRate: 2500, tickSpacing: 60 });
});

test('normalizes wrapped { data: [...] } response', () => {
  const raw = {
    id: 'clmm-config',
    success: true,
    data: [
      { index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
      { index: 1, tradeFeeRate: 2500, tickSpacing: 60 },
    ],
  };
  const result = normalizeFeeTierList(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].tradeFeeRate, 2500); // sorted ascending
  assert.equal(result[1].tradeFeeRate, 10000);
});

test('sorts by ascending tradeFeeRate regardless of input order', () => {
  const raw = [
    { index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
    { index: 1, tradeFeeRate: 2500, tickSpacing: 60 },
    { index: 5, tradeFeeRate: 500, tickSpacing: 1 },
    { index: 4, tradeFeeRate: 100, tickSpacing: 1 },
  ];
  const result = normalizeFeeTierList(raw);
  const rates = result.map((r) => r.tradeFeeRate);
  assert.deepEqual(rates, [100, 500, 2500, 10000]);
});

test('filters out entries with non-integer index or rate', () => {
  const raw = [
    { index: 1, tradeFeeRate: 2500, tickSpacing: 60 },
    { index: 'bad', tradeFeeRate: 500, tickSpacing: 10 },    // non-integer index
    { index: 4, tradeFeeRate: 100.5, tickSpacing: 1 },       // non-integer rate
    { index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
  ];
  const result = normalizeFeeTierList(raw);
  assert.equal(result.length, 2);
  assert.equal(result[0].index, 1);
  assert.equal(result[1].index, 3);
});

test('falls back when all entries are invalid (non-integer)', () => {
  const raw = [
    { index: 'x', tradeFeeRate: 500, tickSpacing: 10 },
    { index: 4, tradeFeeRate: 100.5, tickSpacing: 1 },
  ];
  const result = normalizeFeeTierList(raw);
  assert.deepEqual(result, FALLBACK_FEE_TIERS);
});

test('falls back on null input', () => {
  assert.deepEqual(normalizeFeeTierList(null), FALLBACK_FEE_TIERS);
});

test('falls back on undefined input', () => {
  assert.deepEqual(normalizeFeeTierList(undefined), FALLBACK_FEE_TIERS);
});

test('falls back on empty array', () => {
  assert.deepEqual(normalizeFeeTierList([]), FALLBACK_FEE_TIERS);
});

test('falls back on empty data wrapper', () => {
  assert.deepEqual(normalizeFeeTierList({ data: [] }), FALLBACK_FEE_TIERS);
});

test('falls back when data is not an array', () => {
  assert.deepEqual(normalizeFeeTierList({ data: 'not-an-array' }), FALLBACK_FEE_TIERS);
});

test('fallback list has the four stable tiers', () => {
  assert.equal(FALLBACK_FEE_TIERS.length, 4);
  const indices = FALLBACK_FEE_TIERS.map((t) => t.index).sort();
  assert.deepEqual(indices, [1, 3, 4, 5]);
});
