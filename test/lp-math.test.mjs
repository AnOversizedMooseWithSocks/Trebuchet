import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ceilToSpacing,
  computeBootstrapTicks,
  computeLadderTicks,
  computeLadderTicksManual,
  computeMainTicks,
  computeSupportTicks,
  floorToSpacing,
  MAX_TICK,
  MIN_TICK,
  SUPPORT_DEPTH_PCT_DEFAULT,
  TICK_ARRAY_SIZE,
  tickArrayStartIndex,
} from '../lpMath.js';

test('snaps ticks to Raydium spacing in both directions', () => {
  assert.equal(floorToSpacing(121, 120), 120);
  assert.equal(ceilToSpacing(121, 120), 240);
  assert.equal(floorToSpacing(-121, 120), -240);
  assert.equal(ceilToSpacing(-121, 120), -120);
});

test('main position starts single-sided on either mint ordering', () => {
  assert.deepEqual(
    computeMainTicks({ currentTick: 0, tickSpacing: 120, launchedIsMintA: true }),
    { tickLower: 120, tickUpper: 443520 },
  );

  assert.deepEqual(
    computeMainTicks({ currentTick: 0, tickSpacing: 120, launchedIsMintA: false }),
    { tickLower: -443520, tickUpper: -120 },
  );
});

test('minimal bootstrap keeps a consistent percentage width after snapping', () => {
  assert.deepEqual(
    computeBootstrapTicks({ currentTick: 123, tickSpacing: 120, mode: 'minimal' }),
    { tickLower: -1320, tickUpper: 1560 },
  );
});

test('custom bootstrap uses the full aligned Raydium tick range', () => {
  assert.deepEqual(
    computeBootstrapTicks({ currentTick: 123, tickSpacing: 120, mode: 'custom' }),
    {
      tickLower: ceilToSpacing(MIN_TICK, 120),
      tickUpper: floorToSpacing(MAX_TICK, 120),
    },
  );
});

test('simple ladder bands extend above launch price for mintA', () => {
  const bands = computeLadderTicks({
    currentTick: 0,
    tickSpacing: 120,
    bandCount: 3,
    ceilingMultiplier: 10,
    launchedIsMintA: true,
  });

  assert.equal(bands.length, 3);
  for (const band of bands) {
    assert.equal(Math.abs(band.tickLower % 120), 0);
    assert.equal(Math.abs(band.tickUpper % 120), 0);
    assert.ok(band.tickLower > 0);
    assert.ok(band.tickUpper > band.tickLower);
  }
  assert.ok(bands[1].tickLower > bands[0].tickUpper);
  assert.ok(bands[2].tickLower > bands[1].tickUpper);
});

test('simple ladder bands mirror below launch price for mintB', () => {
  const bands = computeLadderTicks({
    currentTick: 0,
    tickSpacing: 120,
    bandCount: 3,
    ceilingMultiplier: 10,
    launchedIsMintA: false,
  });

  assert.equal(bands.length, 3);
  for (const band of bands) {
    assert.equal(Math.abs(band.tickLower % 120), 0);
    assert.equal(Math.abs(band.tickUpper % 120), 0);
    assert.ok(band.tickUpper < 0);
    assert.ok(band.tickUpper > band.tickLower);
  }
  assert.ok(bands[1].tickUpper < bands[0].tickLower);
  assert.ok(bands[2].tickUpper < bands[1].tickLower);
});

test('manual ladder uses explicit multipliers and mirrors direction', () => {
  const inputBands = [
    { lowerMultiplier: 1, upperMultiplier: 2 },
    { lowerMultiplier: 3, upperMultiplier: 5 },
  ];

  const mintA = computeLadderTicksManual({
    currentTick: 0,
    tickSpacing: 120,
    bands: inputBands,
    launchedIsMintA: true,
  });
  const mintB = computeLadderTicksManual({
    currentTick: 0,
    tickSpacing: 120,
    bands: inputBands,
    launchedIsMintA: false,
  });

  assert.equal(mintA[0].tickLower, 120);
  assert.ok(mintA[0].tickUpper > mintA[0].tickLower);
  assert.ok(mintA[1].tickLower > mintA[0].tickUpper);

  assert.equal(mintB[0].tickUpper, -120);
  assert.ok(mintB[0].tickUpper > mintB[0].tickLower);
  assert.ok(mintB[1].tickUpper < mintB[0].tickLower);
});

// computeSupportTicks: single-sided quote position sitting just on the
// other side of currentTick, covering a configurable depth below the
// launch price (above for mintB-side launches). Behavior parallels
// computeLadderTicks but inverted in direction.

test('support range sits below currentTick when launched is mintA', () => {
  // depthPct=10, tickSpacing=120 → tickDelta ≈ 1054. Snapping puts
  // tickUpper just below current (≤ -120) and tickLower one full
  // delta below that, snapped to spacing.
  const ticks = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
    depthPct: 10,
  });
  assert.ok(ticks.tickUpper < 0, 'tickUpper must be below currentTick=0');
  assert.ok(ticks.tickLower < ticks.tickUpper, 'tickLower must be below tickUpper');
  // Both ticks aligned to spacing. abs() avoids the JS -0 vs 0 quirk
  // (negative modulo produces -0 which doesn't strict-equal 0).
  assert.equal(Math.abs(ticks.tickLower % 120), 0);
  assert.equal(Math.abs(ticks.tickUpper % 120), 0);
});

test('support range sits above currentTick when launched is mintB', () => {
  const ticks = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: false,
    depthPct: 10,
  });
  assert.ok(ticks.tickLower > 0, 'tickLower must be above currentTick=0');
  assert.ok(ticks.tickUpper > ticks.tickLower, 'tickUpper must be above tickLower');
  assert.equal(Math.abs(ticks.tickLower % 120), 0);
  assert.equal(Math.abs(ticks.tickUpper % 120), 0);
});

test('support range is approximately symmetric across mint ordering', () => {
  // For currentTick=0, the two mintA/mintB cases should be mirror images:
  // mintA range is [-D, -1*spacing], mintB range is [+1*spacing, +D].
  const mintA = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
    depthPct: 10,
  });
  const mintB = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: false,
    depthPct: 10,
  });
  assert.equal(-mintA.tickUpper, mintB.tickLower);
  assert.equal(-mintA.tickLower, mintB.tickUpper);
});

test('support range uses default depth when depthPct is not provided', () => {
  // Calling without depthPct should match calling with the explicit
  // default. Keeps the public API safe for callers who omit the arg.
  const withDefault = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
  });
  const explicit = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 120,
    launchedIsMintA: true,
    depthPct: SUPPORT_DEPTH_PCT_DEFAULT,
  });
  assert.deepEqual(withDefault, explicit);
});

test('support range expands when depthPct increases', () => {
  // Larger depth = wider range. Each output should be at least as wide
  // as the previous one (monotonic in depthPct).
  let lastWidth = 0;
  for (const depthPct of [1, 5, 10, 25, 50]) {
    const ticks = computeSupportTicks({
      currentTick: 0,
      tickSpacing: 60,
      launchedIsMintA: true,
      depthPct,
    });
    const width = ticks.tickUpper - ticks.tickLower;
    assert.ok(
      width >= lastWidth,
      `depthPct=${depthPct} width=${width} should be >= prior width ${lastWidth}`,
    );
    lastWidth = width;
  }
});

test('support range guards against degenerate widths at high tickSpacing', () => {
  // 1% fee tier has tickSpacing=200. A 1% depth (tickDelta ≈ 100) would
  // round to less than one spacing of width without the degenerate
  // guard. Verify the guard produces a position with at least one full
  // tickSpacing of width on both mint orderings.
  const mintA = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 200,
    launchedIsMintA: true,
    depthPct: 1,
  });
  assert.equal(mintA.tickUpper - mintA.tickLower, 200);
  assert.ok(mintA.tickUpper < 0);

  const mintB = computeSupportTicks({
    currentTick: 0,
    tickSpacing: 200,
    launchedIsMintA: false,
    depthPct: 1,
  });
  assert.equal(mintB.tickUpper - mintB.tickLower, 200);
  assert.ok(mintB.tickLower > 0);
});

test('support range snaps to spacing on non-zero currentTick', () => {
  // currentTick that isn't a multiple of spacing — output ticks must
  // still snap to multiples of tickSpacing. This catches a class of
  // off-by-one bugs where the snapping math gets the modulo wrong on
  // negative deltas.
  const ticks = computeSupportTicks({
    currentTick: 12345,
    tickSpacing: 60,
    launchedIsMintA: true,
    depthPct: 10,
  });
  assert.equal(Math.abs(ticks.tickLower % 60), 0);
  assert.equal(Math.abs(ticks.tickUpper % 60), 0);
  // Must stay below currentTick so the position is single-sided in quote.
  assert.ok(ticks.tickUpper < 12345);
});

// --- tick-array start index (drives the funding estimator's rent count) ---

// Independent re-implementation of the SDK's getTickArrayStartIndexByTick,
// used here purely as a test oracle so the helper can't silently drift.
function sdkTickArrayStart(tick, tickSpacing) {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  let bitIndex = tick / span;
  if (tick < 0 && tick % span !== 0) bitIndex = Math.ceil(bitIndex) - 1;
  else bitIndex = Math.floor(bitIndex);
  return bitIndex * span;
}

test('tickArrayStartIndex matches the SDK formula across signs and spacings', () => {
  for (const tickSpacing of [1, 10, 60, 120]) {
    for (const tick of [MIN_TICK, -154257, -120000, -901, -1, 0, 1, 901, 99040, MAX_TICK]) {
      assert.equal(
        tickArrayStartIndex(tick, tickSpacing),
        sdkTickArrayStart(tick, tickSpacing),
        `mismatch at tick=${tick} spacing=${tickSpacing}`,
      );
    }
  }
});

test('ticks within one array share a start; crossing the boundary advances it', () => {
  const tickSpacing = 60;
  const span = TICK_ARRAY_SIZE * tickSpacing; // 3600
  // Start index is always a multiple of the array span.
  assert.equal(tickArrayStartIndex(0, tickSpacing) % span, 0);
  // First and last tick of the array at [0, span) share the same start.
  assert.equal(tickArrayStartIndex(0, tickSpacing), 0);
  assert.equal(tickArrayStartIndex(span - tickSpacing, tickSpacing), 0);
  // One array up.
  assert.equal(tickArrayStartIndex(span, tickSpacing), span);
  // Negative side floors toward -inf, not toward zero.
  assert.equal(tickArrayStartIndex(-1, tickSpacing), -span);
});

test('a laddered launch spans many distinct tick arrays, not two', () => {
  // The bug this guards: budgeting a flat two tick arrays per pool. A wide
  // main + bootstrap + several ladder bands + support land in many distinct
  // arrays, each one rent the launch wallet must pay. Assert the distinct
  // count is well above two so a regression to the flat-two budget is caught.
  const currentTick = -154257;
  const tickSpacing = 60;
  const launchedIsMintA = true;
  const bounds = [];
  const main = computeMainTicks({ currentTick, tickSpacing, launchedIsMintA });
  bounds.push(main.tickLower, main.tickUpper);
  const boot = computeBootstrapTicks({ currentTick, tickSpacing, mode: 'minimal' });
  bounds.push(boot.tickLower, boot.tickUpper);
  const bands = computeLadderTicksManual({
    currentTick,
    tickSpacing,
    bands: [
      { lowerMultiplier: 4, upperMultiplier: 8 },
      { lowerMultiplier: 8, upperMultiplier: 40 },
      { lowerMultiplier: 40, upperMultiplier: 200 },
      { lowerMultiplier: 200, upperMultiplier: 1200 },
      { lowerMultiplier: 1200, upperMultiplier: 33333 },
    ],
    launchedIsMintA,
  });
  bands.forEach((b) => bounds.push(b.tickLower, b.tickUpper));
  const sup = computeSupportTicks({
    currentTick, tickSpacing, launchedIsMintA, depthPct: SUPPORT_DEPTH_PCT_DEFAULT,
  });
  bounds.push(sup.tickLower, sup.tickUpper);
  const distinct = new Set(bounds.map((t) => tickArrayStartIndex(t, tickSpacing)));
  assert.ok(
    distinct.size >= 6,
    `expected many distinct arrays, got ${distinct.size}`,
  );
});

test('a default two-position launch needs at most three tick arrays on the 1% tier (four on finer tiers)', () => {
  // Guards the funding estimate's tick-array budget. The estimate sweeps the
  // launch tick and budgets the WORST-CASE distinct-array count per fee tier
  // rather than a flat "2 x positions" ceiling. For the default single-slice
  // shape (wide main + bootstrap) the launch never touches more than three
  // arrays on the 1% / 120-spacing tier: the main's lower bound and the
  // bootstrap's upper bound always share the array straddling the launch tick
  // (~1300 ticks apart, well inside one 7200-tick array). Narrower tiers have
  // smaller arrays where those two can split, so the true max there is four.
  // The count is periodic in the launch tick with period = one array span, so a
  // single-span sweep sees every case.
  const launchedIsMintA = true;
  const sweepMax = (tickSpacing) => {
    const span = TICK_ARRAY_SIZE * tickSpacing;
    let mx = 0;
    for (let currentTick = 0; currentTick < span; currentTick++) {
      const bounds = [];
      const main = computeMainTicks({ currentTick, tickSpacing, launchedIsMintA });
      bounds.push(main.tickLower, main.tickUpper);
      const boot = computeBootstrapTicks({ currentTick, tickSpacing, mode: 'minimal' });
      bounds.push(boot.tickLower, boot.tickUpper);
      const d = new Set(bounds.map((t) => tickArrayStartIndex(t, tickSpacing))).size;
      if (d > mx) mx = d;
    }
    return mx;
  };
  assert.equal(sweepMax(120), 3, 'default 1% tier: at most three arrays');
  assert.equal(sweepMax(60), 3, '0.25% tier: at most three arrays');
  assert.equal(sweepMax(10), 4, '0.05% tier: narrower arrays can split to four');
  assert.equal(sweepMax(1), 4, '0.01% tier: narrower arrays can split to four');
});
