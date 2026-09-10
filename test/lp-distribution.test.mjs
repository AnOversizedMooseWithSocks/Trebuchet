import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey } from '@solana/web3.js';

import { normalizeDistribution } from '../lpDistribution.js';

// Deterministic valid key for recipient tests
const VALID_KEY = 'DRpbCBMxVnDK7maPMoGQFix5grYex3WcBL5NerXWkJBi';

test('null/undefined → single 100% slice', () => {
  assert.deepEqual(normalizeDistribution(null), [{ sharePercent: 100 }]);
  assert.deepEqual(normalizeDistribution(undefined), [{ sharePercent: 100 }]);
  assert.deepEqual(normalizeDistribution([]), [{ sharePercent: 100 }]);
});

test('single slice with no recipient → normalized', () => {
  assert.deepEqual(
    normalizeDistribution([{ sharePercent: 100 }]),
    [{ sharePercent: 100, recipient: null }],
  );
});

test('two slices that sum to 100', () => {
  assert.deepEqual(
    normalizeDistribution([
      { sharePercent: 60 },
      { sharePercent: 40 },
    ]),
    [
      { sharePercent: 60, recipient: null },
      { sharePercent: 40, recipient: null },
    ],
  );
});

test('three unequal slices that sum to 100', () => {
  const result = normalizeDistribution([
    { sharePercent: 50 },
    { sharePercent: 30 },
    { sharePercent: 20 },
  ]);
  assert.equal(result.length, 3);
  assert.equal(result.reduce((a, s) => a + s.sharePercent, 0), 100);
});

test('tolerates floating-point drift within 0.01', () => {
  // 33.33 + 33.33 + 33.34 = 100.00 — should pass
  assert.doesNotThrow(() =>
    normalizeDistribution([
      { sharePercent: 33.33 },
      { sharePercent: 33.33 },
      { sharePercent: 33.34 },
    ]),
  );

  // 33.333 + 33.333 + 33.334 = 100.000 — still within tolerance
  assert.doesNotThrow(() =>
    normalizeDistribution([
      { sharePercent: 100 / 3 },
      { sharePercent: 100 / 3 },
      { sharePercent: 100 / 3 },
    ]),
  );
});

test('rejects shares that do not sum to 100', () => {
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 50 }, { sharePercent: 40 }]),
    { message: /sum to 90%.*must sum to 100%/ },
  );

  assert.throws(
    () => normalizeDistribution([{ sharePercent: 60 }, { sharePercent: 50 }]),
    { message: /sum to 110%.*must sum to 100%/ },
  );

  // Just outside the 0.01 tolerance
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 99.98 }]),
    { message: /sum to 99\.98%.*must sum to 100%/ },
  );
});

test('rejects zero or negative shares', () => {
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 0 }, { sharePercent: 100 }]),
    { message: /must be > 0%/ },
  );

  assert.throws(
    () => normalizeDistribution([{ sharePercent: -10 }, { sharePercent: 110 }]),
    { message: /must be > 0%/ },
  );
});

test('accepts valid recipient addresses', () => {
  const result = normalizeDistribution([
    { sharePercent: 50, recipient: VALID_KEY },
    { sharePercent: 50 },
  ]);
  assert.equal(result[0].recipient, VALID_KEY);
  assert.equal(result[1].recipient, null);
});

test('rejects invalid recipient addresses', () => {
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 100, recipient: 'not-a-key' }]),
    { message: /Invalid recipient address: not-a-key/ },
  );

  // Empty string is falsy, treated as no recipient — not an error

  // Characters outside base58 alphabet
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 100, recipient: '0OIl' }]),
    { message: /Invalid recipient address/ },
  );
});

test('converts sharePercent strings to numbers', () => {
  const result = normalizeDistribution([
    { sharePercent: '60' },
    { sharePercent: '40' },
  ]);
  assert.equal(typeof result[0].sharePercent, 'number');
  assert.equal(result[0].sharePercent, 60);
  assert.equal(result[1].sharePercent, 40);
});

test('null recipient → null (not string "null")', () => {
  const result = normalizeDistribution([{ sharePercent: 100, recipient: null }]);
  assert.equal(result[0].recipient, null);
});

// ---------------------------------------------------------------------------
// Non-finite share regression.
//
// normalizeDistribution is the SERVER-SIDE trust boundary: it runs on
// request-body data, so it cannot assume the sender is the app's own UI.
// A NaN share (missing field, or a non-numeric value) silently defeated
// both guards, because every NaN comparison is false:
//     Math.abs(NaN - 100) > 0.01  ->  false  (sum check passed)
//     NaN <= 0                    ->  false  (positive check passed)
// A NaN share would then reach position-supply math as a NaN token amount.
// ---------------------------------------------------------------------------

test('normalizeDistribution rejects a NaN share instead of silently accepting it', () => {
  assert.throws(
    () => normalizeDistribution([{ sharePercent: NaN }, { sharePercent: 100 }]),
    /not a valid number/,
  );
});

test('normalizeDistribution rejects a missing sharePercent', () => {
  // Number(undefined) is NaN — the exact shape a malformed request body
  // (or a future UI regression) would produce.
  assert.throws(
    () => normalizeDistribution([{ recipient: null }, { sharePercent: 100 }]),
    /not a valid number/,
  );
});

test('normalizeDistribution rejects non-numeric and non-finite share values', () => {
  assert.throws(() => normalizeDistribution([{ sharePercent: 'abc' }]), /not a valid number/);
  assert.throws(() => normalizeDistribution([{ sharePercent: Infinity }]), /not a valid number/);
  assert.throws(() => normalizeDistribution([{ sharePercent: -Infinity }]), /not a valid number/);
  assert.throws(() => normalizeDistribution([{ sharePercent: null }, { sharePercent: 100 }]),
    /must be > 0%/, 'null coerces to 0 — caught by the positive-share guard');
});

test('normalizeDistribution error names which slice is bad', () => {
  // The user needs to know WHICH slice to fix, not just that one is wrong.
  assert.throws(
    () => normalizeDistribution([{ sharePercent: 50 }, { sharePercent: NaN }]),
    /#2/,
  );
});

test('normalizeDistribution still accepts valid distributions unchanged', () => {
  // Guard against the new check being over-eager.
  assert.deepEqual(
    normalizeDistribution([{ sharePercent: 33.33 }, { sharePercent: 33.33 }, { sharePercent: 33.34 }]),
    [
      { sharePercent: 33.33, recipient: null },
      { sharePercent: 33.33, recipient: null },
      { sharePercent: 33.34, recipient: null },
    ],
  );
  assert.deepEqual(normalizeDistribution([{ sharePercent: '50' }, { sharePercent: '50' }]),
    [{ sharePercent: 50, recipient: null }, { sharePercent: 50, recipient: null }],
    'numeric strings remain acceptable');
});
