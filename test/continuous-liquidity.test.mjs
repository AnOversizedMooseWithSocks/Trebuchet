// test/continuous-liquidity.test.mjs
//
// The full-range main position is the pool's continuous base; ladder and
// custom bands stack on top of it. If bands consume all the supply, the
// pool has zero liquidity between bands and above the top band — price
// teleports through those regions with nothing to swap against. The app
// used to ALLOW that ("no wide main positions to open ... bands will
// provide all liquidity"). This pins the guard that refuses it.

import test from 'node:test';
import assert from 'node:assert/strict';
import BN from 'bn.js';
import { assertWideBaseKept } from '../lpService.js';
import { MIN_WIDE_BASE_BPS } from '../lpConstants.js';

const SUPPLY = new BN('1000000000000'); // 1e12 raw

const scenario = (bandsBps, mode = 'manual') => {
  const ladder = SUPPLY.mul(new BN(bandsBps)).div(new BN(10_000));
  return { mainBaseRaw: SUPPLY, ladderTotalBaseRaw: ladder, wideBaseRaw: SUPPLY.sub(ladder), ladderMode: mode };
};

test('no bands -> nothing to check (the main is the whole supply)', () => {
  assert.doesNotThrow(() => assertWideBaseKept(scenario(10_000, 'off')));
});

test('bands taking 80% leave a healthy base -> allowed', () => {
  assert.doesNotThrow(() => assertWideBaseKept(scenario(8_000)));
});

test('bands taking exactly the floor complement -> allowed (limit is inclusive)', () => {
  assert.doesNotThrow(() => assertWideBaseKept(scenario(10_000 - MIN_WIDE_BASE_BPS)));
});

test('bands taking ALL the supply -> refused, naming the consequence and the fix', () => {
  assert.throws(
    () => assertWideBaseKept({ ...scenario(10_000), poolLabel: 'Pool 2 (USDC)', allocIdx: 1 }),
    (e) => {
      assert.equal(e.failedPhase, 'pre_flight');
      assert.equal(e.failedAllocationIndex, 1);
      assert.match(e.message, /Pool 2 \(USDC\)/);
      assert.match(e.message, /100\.00%/, 'reports what the bands took');
      assert.match(e.message, /NO liquidity between bands/i, 'names the consequence');
      assert.match(e.message, /No SOL was spent/);
      return true;
    },
  );
});

test('bands leaving less than the floor -> refused', () => {
  assert.throws(() => assertWideBaseKept(scenario(10_000 - MIN_WIDE_BASE_BPS + 1)), /full-range base/);
});

test('simple ladder mode is guarded the same way as manual', () => {
  assert.throws(() => assertWideBaseKept(scenario(10_000, 'simple')), /full-range base/);
});

test('the floor is the product rule: 0.5% of the pool supply', () => {
  assert.equal(MIN_WIDE_BASE_BPS, 50);
});
