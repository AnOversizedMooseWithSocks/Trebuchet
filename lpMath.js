// Pure CLMM geometry helpers. Kept separate from lpService.js so unit tests
// can exercise launch-range math without importing Raydium SDK dependencies.

export const MIN_TICK = -443636;
export const MAX_TICK = 443636;
export const MINIMAL_BOOTSTRAP_WIDTH_PCT = 30;

// Default depth (in %) for support positions: position covers launch
// price down to -SUPPORT_DEPTH_PCT_DEFAULT% below it. Single-sided in
// the quote, so the user contributes quote-side funds only — no token
// supply is required to back the range.
export const SUPPORT_DEPTH_PCT_DEFAULT = 10;

export function floorToSpacing(tick, tickSpacing) {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

export function ceilToSpacing(tick, tickSpacing) {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

// CLMM tick arrays span TICK_ARRAY_SIZE * tickSpacing ticks each. A position
// open only touches the two arrays its bounds fall in (lower, upper); arrays
// in between are initialized lazily by swaps, not at open time. Matches the
// pinned SDK (clmm utils: TICK_ARRAY_SIZE = 60, getTickArrayStartIndexByTick).
export const TICK_ARRAY_SIZE = 60;

// Start tick of the tick array a given tick belongs to. Integer math copied
// verbatim from the SDK's getTickArrayBitIndex/getTickArrayStartIndexByTick:
// negatives floor toward -inf via the ceil(i)-1 branch, not JS truncation.
// Used by the funding estimator to count how many distinct arrays a launch
// will initialize (each one is rent the launch wallet pays).
export function tickArrayStartIndex(tick, tickSpacing) {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  let bitIndex = tick / span;
  if (tick < 0 && tick % span !== 0) {
    bitIndex = Math.ceil(bitIndex) - 1;
  } else {
    bitIndex = Math.floor(bitIndex);
  }
  return bitIndex * span;
}

/**
 * Compute the main position's tick range, asymmetric based on which side the
 * launched token sorted to. The position starts 100% launched-token.
 */
export function computeMainTicks({ currentTick, tickSpacing, launchedIsMintA }) {
  const maxAligned = floorToSpacing(MAX_TICK, tickSpacing);
  const minAligned = ceilToSpacing(MIN_TICK, tickSpacing);

  if (launchedIsMintA) {
    return {
      tickLower: ceilToSpacing(currentTick + 1, tickSpacing),
      tickUpper: maxAligned,
    };
  }

  return {
    tickLower: minAligned,
    tickUpper: floorToSpacing(currentTick - 1, tickSpacing),
  };
}

/**
 * Minimal bootstrap: fixed percentage-width band around currentTick.
 * Custom bootstrap: full valid tick range.
 */
export function computeBootstrapTicks({ currentTick, tickSpacing, mode }) {
  if (mode === 'custom') {
    return {
      tickLower: ceilToSpacing(MIN_TICK, tickSpacing),
      tickUpper: floorToSpacing(MAX_TICK, tickSpacing),
    };
  }

  const halfWidthFactor = 1 + MINIMAL_BOOTSTRAP_WIDTH_PCT / 200;
  const idealTicks = Math.log(halfWidthFactor) / Math.log(1.0001);
  const ticksEachSide = Math.ceil(idealTicks / tickSpacing) * tickSpacing;
  const center = floorToSpacing(currentTick, tickSpacing);
  return {
    tickLower: center - ticksEachSide,
    tickUpper: center + ticksEachSide,
  };
}

/**
 * Compute evenly spaced ladder bands up to ceilingMultiplier times launch
 * price. For mintB launches, the bands mirror below currentTick.
 */
export function computeLadderTicks({
  currentTick,
  tickSpacing,
  bandCount,
  ceilingMultiplier,
  launchedIsMintA,
}) {
  const totalLogSpan = Math.log(ceilingMultiplier);
  const perUnitLog = totalLogSpan / (2 * bandCount - 1);
  const logBase = Math.log(1.0001);
  const perUnitTicks = perUnitLog / logBase;

  const minAlignedLower = ceilToSpacing(MIN_TICK, tickSpacing);
  const maxAlignedUpper = floorToSpacing(MAX_TICK, tickSpacing);

  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    const idealLowerOffset = 2 * i * perUnitTicks;
    const idealUpperOffset = (2 * i + 1) * perUnitTicks;

    let tickLower;
    let tickUpper;
    if (launchedIsMintA) {
      const launchTick = currentTick + tickSpacing;
      tickLower = Math.min(
        ceilToSpacing(launchTick + idealLowerOffset, tickSpacing),
        maxAlignedUpper - tickSpacing,
      );
      tickUpper = Math.min(
        floorToSpacing(launchTick + idealUpperOffset, tickSpacing),
        maxAlignedUpper,
      );
    } else {
      const launchTick = currentTick - tickSpacing;
      tickUpper = Math.max(
        floorToSpacing(launchTick - idealLowerOffset, tickSpacing),
        minAlignedLower + tickSpacing,
      );
      tickLower = Math.max(
        ceilToSpacing(launchTick - idealUpperOffset, tickSpacing),
        minAlignedLower,
      );
    }

    const finalUpper = tickUpper > tickLower ? tickUpper : tickLower + tickSpacing;
    bands.push({ tickLower, tickUpper: finalUpper });
  }
  return bands;
}

/**
 * Compute tick ranges for explicit manual ladder bands. Multipliers are
 * relative to launch price and mirror below currentTick for mintB launches.
 */
export function computeLadderTicksManual({
  currentTick,
  tickSpacing,
  bands,
  launchedIsMintA,
}) {
  const logBase = Math.log(1.0001);
  const minAlignedLower = ceilToSpacing(MIN_TICK, tickSpacing);
  const maxAlignedUpper = floorToSpacing(MAX_TICK, tickSpacing);
  const result = [];

  for (const b of bands) {
    const lowerLogOffset = Math.log(Number(b.lowerMultiplier)) / logBase;
    const upperLogOffset = Math.log(Number(b.upperMultiplier)) / logBase;
    let tickLower;
    let tickUpper;

    if (launchedIsMintA) {
      const launchTick = currentTick + tickSpacing;
      tickLower = Math.min(
        ceilToSpacing(launchTick + lowerLogOffset, tickSpacing),
        maxAlignedUpper - tickSpacing,
      );
      tickUpper = Math.min(
        floorToSpacing(launchTick + upperLogOffset, tickSpacing),
        maxAlignedUpper,
      );
    } else {
      const launchTick = currentTick - tickSpacing;
      tickUpper = Math.max(
        floorToSpacing(launchTick - lowerLogOffset, tickSpacing),
        minAlignedLower + tickSpacing,
      );
      tickLower = Math.max(
        ceilToSpacing(launchTick - upperLogOffset, tickSpacing),
        minAlignedLower,
      );
    }

    const finalUpper = tickUpper > tickLower ? tickUpper : tickLower + tickSpacing;
    result.push({ tickLower, tickUpper: finalUpper });
  }

  return result;
}

/**
 * Compute the tick range for a single-sided support position. The position
 * holds 100% quote at deposit time (no launched-token supply required),
 * covering the price band from 1 tickSpacing below launch price down to
 * (100 - depthPct)% of launch price. For mintB launches, the range mirrors
 * above currentTick.
 *
 *   launchedIsMintA: launched_price = P (the pool price). Price drops →
 *     P drops → tick drops. So the support range lives BELOW currentTick.
 *     A position below currentTick holds 100% mintB (quote). ✓
 *
 *   launchedIsMintB: launched_price = 1/P. Launched price drops → P rises
 *     → tick rises. So the support range lives ABOVE currentTick. A
 *     position above currentTick holds 100% mintA (quote). ✓
 *
 * `depthPct` defaults to SUPPORT_DEPTH_PCT_DEFAULT. Range collapses are
 * guarded by ensuring at least one tickSpacing of width — this matters
 * for high-tickSpacing fee tiers (1% has tickSpacing=200, a 1% depth
 * would round to 0 spacings without the guard).
 */
export function computeSupportTicks({
  currentTick,
  tickSpacing,
  launchedIsMintA,
  depthPct = SUPPORT_DEPTH_PCT_DEFAULT,
}) {
  const logBase = Math.log(1.0001);
  // Tick distance corresponding to a price change of -depthPct%. Always
  // expressed as a positive integer; the sign is applied per-branch below.
  const factor = (100 - depthPct) / 100;
  const tickDelta = Math.abs(Math.round(Math.log(factor) / logBase));

  if (launchedIsMintA) {
    // Range below currentTick: tickUpper just below current, tickLower at
    // currentTick − tickDelta. Position holds 100% mintB (quote) until
    // launched price drops into the range.
    let tickUpper = floorToSpacing(currentTick - 1, tickSpacing);
    let tickLower = ceilToSpacing(currentTick - tickDelta, tickSpacing);
    if (tickLower >= tickUpper) {
      // Degenerate range — happens when depthPct is small relative to the
      // pool's tickSpacing. Expand to one full tickSpacing of width so the
      // position is still openable.
      tickLower = tickUpper - tickSpacing;
    }
    return { tickLower, tickUpper };
  }

  // launchedIsMintB: range above currentTick.
  let tickLower = ceilToSpacing(currentTick + 1, tickSpacing);
  let tickUpper = floorToSpacing(currentTick + tickDelta, tickSpacing);
  if (tickUpper <= tickLower) {
    tickUpper = tickLower + tickSpacing;
  }
  return { tickLower, tickUpper };
}

// ===========================================================================
// Price drift helpers
// ===========================================================================
//
// Used by the Milestone A drift guard in lpService.js to compare a
// just-in-time Raydium probe against the price the user committed to
// at funding-estimate time. Kept here (no SDK dependencies) so the
// logic can be unit-tested in isolation, separate from the network-
// touching probe code.

// Compute the symmetric drift ratio between two positive numbers. Always
// returns >= 1; exactly 1 means the two values are identical, larger
// values mean more drift. The "symmetric" part: ratio(0.8, 1.0) and
// ratio(1.0, 0.8) both return 1.25, since drift is bidirectional —
// the user committing at $1 and seeing live market at $0.80 is the
// same magnitude of concern as committing at $0.80 and seeing live
// market at $1.
//
// Inputs are plain numbers. Caller is responsible for ensuring they're
// positive and finite; this function returns Infinity/NaN for invalid
// inputs (e.g. one side is zero) so calling code can spot the problem
// rather than the function silently doing the wrong thing.
export function measurePriceDrift(a, b) {
  if (!isFinite(a) || !isFinite(b) || a <= 0 || b <= 0) return NaN;
  return a > b ? a / b : b / a;
}

// Boolean: does the drift between a and b exceed the threshold? The
// threshold is expressed as a ratio (e.g. 1.25 means "abort if either
// value is more than 25% larger than the other"). Returns false on
// invalid input — caller's job to validate inputs separately if they
// want to distinguish "no drift" from "input was bad."
export function driftExceedsThreshold(a, b, thresholdRatio) {
  if (!isFinite(thresholdRatio) || thresholdRatio < 1) return false;
  const ratio = measurePriceDrift(a, b);
  return isFinite(ratio) && ratio > thresholdRatio;
}

// Signed drift as a percent: how much higher (positive) or lower
// (negative) `current` is than `reference`. Used for the human-
// readable "Price is N% higher than the funding estimate" message
// in the pre-commit confirmation modal.
//
// Returns NaN on invalid input.
export function driftPercent(current, reference) {
  if (!isFinite(current) || !isFinite(reference) || reference <= 0) return NaN;
  return ((current - reference) / reference) * 100;
}
