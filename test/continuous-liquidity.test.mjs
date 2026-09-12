// test/continuous-liquidity.test.mjs
//
// The wide main position is the pool's full-range base; ladder/custom
// bands stack on top of it. The base is GLUE, not a reserve:
//   - bands with GAPS between them need a base of >= 1 whole token, or
//     price teleports across the empty stretch with nothing to swap against
//   - contiguous bands need no base at all
//   - a THIN base is a warning (high impact between bands), never a block
// The app used to allow a gapped ladder with NO main position.

import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { checkContinuousLiquidity, findBandGaps } from '../lpService.js';
import { MIN_BASE_TOKENS_WHEN_GAPPED, THIN_BASE_WARN_BPS } from '../lpConstants.js';

const DEC = 9;
const ONE = new BN(10).pow(new BN(DEC));
const SUPPLY = ONE.mul(new BN(1_000_000)); // 1M whole tokens

// Bands as the customize UI specifies them: launch-price multipliers.
const TOUCHING = [
  { lowerMultiplier: 1.0, upperMultiplier: 2 }, { lowerMultiplier: 2, upperMultiplier: 4 }, { lowerMultiplier: 4, upperMultiplier: 10 },
];
const GAPPED = [
  { lowerMultiplier: 1.0, upperMultiplier: 2 }, { lowerMultiplier: 4, upperMultiplier: 10 }, // nothing 2x -> 4x
];

const args = ({ bands, ladderMode = 'manual', baseTokens, bootstrapMode = 'minimal' }) => {
  const wide = ONE.mul(new BN(Math.floor(baseTokens))).add(new BN(Math.round((baseTokens % 1) * 1e9)));
  return {
    mainBaseRaw: SUPPLY, wideBaseRaw: wide, ladderTotalBaseRaw: SUPPLY.sub(wide),
    ladderMode, bands, bootstrapMode, tokenDecimals: DEC, poolLabel: 'Pool 1 (SOL)', allocIdx: 0,
  };
};

// ---- gap detection ----------------------------------------------------------

test('findBandGaps: touching bands have no gaps', () => {
  assert.equal(findBandGaps({ ladderMode: 'manual', bands: TOUCHING }).hasGaps, false);
});

test('findBandGaps: a stretch no band covers is a gap, reported in multiples of launch', () => {
  const r = findBandGaps({ ladderMode: 'manual', bands: GAPPED });
  assert.equal(r.hasGaps, true);
  assert.equal(r.gaps[0].to, 4);
});

test('findBandGaps: tick-alignment slivers within tolerance are not gaps', () => {
  const almost = [{ lowerMultiplier: 1.0, upperMultiplier: 2 }, { lowerMultiplier: 2.005, upperMultiplier: 4 }];
  assert.equal(findBandGaps({ ladderMode: 'manual', bands: almost }).hasGaps, false);
});

test('findBandGaps: a band starting above the minimal bootstrap edge leaves a gap below it', () => {
  // Minimal bootstrap covers launch ±15%; a first band at 1.5x leaves 1.15x -> 1.5x empty.
  const r = findBandGaps({ ladderMode: 'manual', bands: [{ lowerMultiplier: 1.5, upperMultiplier: 3 }] });
  assert.equal(r.hasGaps, true);
});

test('findBandGaps: a custom (full-range) bootstrap means nothing can be a gap', () => {
  assert.equal(findBandGaps({ ladderMode: 'manual', bands: GAPPED, bootstrapMode: 'custom' }).hasGaps, false);
});

test('findBandGaps: the simple ladder is gapped by design', () => {
  assert.equal(findBandGaps({ ladderMode: 'simple', bands: [{}] }).hasGaps, true);
});

test('findBandGaps: ladder off -> no gaps', () => {
  assert.equal(findBandGaps({ ladderMode: 'off', bands: GAPPED }).hasGaps, false);
});

// ---- the rule ---------------------------------------------------------------

test('contiguous bands with an EMPTY base are allowed — no glue needed', () => {
  const r = checkContinuousLiquidity(args({ bands: TOUCHING, baseTokens: 0 }));
  assert.equal(r.hasGaps, false);
  assert.equal(r.warning, null);
});

test('gapped bands with an empty base are refused, naming the gap and the fix', () => {
  assert.throws(
    () => checkContinuousLiquidity(args({ bands: GAPPED, baseTokens: 0 })),
    (e) => {
      assert.equal(e.failedPhase, 'pre_flight');
      assert.match(e.message, /2\.00× → 4\.00×/, 'names where the gap is');
      assert.match(e.message, /at least 1 token/, 'names the minimal fix');
      assert.match(e.message, /No SOL was spent/);
      return true;
    },
  );
});

test('gapped bands with just under one token in the base are refused', () => {
  assert.throws(() => checkContinuousLiquidity(args({ bands: GAPPED, baseTokens: 0.999 })), /less than 1 token/);
});

test('gapped bands with exactly one token in the base are ALLOWED — with a thin-base warning', () => {
  const r = checkContinuousLiquidity(args({ bands: GAPPED, baseTokens: MIN_BASE_TOKENS_WHEN_GAPPED }));
  assert.equal(r.hasGaps, true);
  assert.match(r.warning, /under 0\.5% of supply/, 'one token is glue, not depth — say so');
  assert.match(r.warning, /small order will move the price/);
});

test('gapped bands with a comfortable base produce no warning', () => {
  // 1% of a 1M-token supply = 10,000 tokens, above the 0.5% thin threshold.
  const r = checkContinuousLiquidity(args({ bands: GAPPED, baseTokens: 10_000 }));
  assert.equal(r.hasGaps, true);
  assert.equal(r.warning, null);
});

test('the simple ladder needs the base too, since its bands are spaced apart', () => {
  assert.throws(() => checkContinuousLiquidity(args({ bands: [{}], ladderMode: 'simple', baseTokens: 0 })), /no liquidity between/);
  assert.doesNotThrow(() => checkContinuousLiquidity(args({ bands: [{}], ladderMode: 'simple', baseTokens: 5 })));
});

test('constants are the product rule: 1 token when gapped, warn under 0.5%', () => {
  assert.equal(MIN_BASE_TOKENS_WHEN_GAPPED, 1);
  assert.equal(THIN_BASE_WARN_BPS, 50);
});
