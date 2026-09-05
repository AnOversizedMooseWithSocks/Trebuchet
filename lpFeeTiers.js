// lpFeeTiers.js
//
// Pure fee tier normalization logic. Extracted from lpService.js so the
// normalization and fallback logic can be tested without network access.

// Hardcoded fallback for when the Raydium API is unreachable. Keep these
// aligned with https://api-v3.raydium.io/main/clmm-config; a stale config
// index can select the wrong on-chain AmmConfig or make pool creation fail.
export const FALLBACK_FEE_TIERS = [
  { index: 4, tradeFeeRate:   100, tickSpacing:   1 }, // 0.01%
  { index: 5, tradeFeeRate:   500, tickSpacing:   1 }, // 0.05%
  { index: 1, tradeFeeRate:  2500, tickSpacing:  60 }, // 0.25%
  { index: 3, tradeFeeRate: 10000, tickSpacing: 120 }, // 1%
];

/**
 * Normalize a raw fee tier list from the Raydium CLMM config API into
 * a sorted array of { index, tradeFeeRate, tickSpacing } objects.
 *
 *   - Accepts either a bare array or { data: [...] } wrapper
 *   - Filters out entries with non-integer index or rate
 *   - Sorts by ascending tradeFeeRate
 *   - Returns FALLBACK_FEE_TIERS if the input is empty or invalid
 */
export function normalizeFeeTierList(raw) {
  const list = Array.isArray(raw) ? raw : (raw && raw.data ? raw.data : null);
  if (!Array.isArray(list) || list.length === 0) {
    return FALLBACK_FEE_TIERS;
  }
  const normalized = list
    .map((c) => ({
      index: c.index,
      tradeFeeRate: c.tradeFeeRate,
      tickSpacing: c.tickSpacing,
    }))
    .filter((c) => Number.isInteger(c.index) && Number.isInteger(c.tradeFeeRate));
  if (normalized.length === 0) {
    return FALLBACK_FEE_TIERS;
  }
  return normalized.sort((a, b) => a.tradeFeeRate - b.tradeFeeRate);
}
