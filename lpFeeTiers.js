// lpFeeTiers.js
//
// Pure fee tier normalization logic. Extracted from lpService.js so the
// normalization and fallback logic can be tested without network access.

// Hardcoded fallback for when the Raydium API is unreachable. These are
// the indices that have been stable since CLMM launched.
export const FALLBACK_FEE_TIERS = [
  { index: 0, tradeFeeRate:  2500, tickSpacing:  60 }, // 0.25%
  { index: 1, tradeFeeRate:   500, tickSpacing:  10 }, // 0.05%
  { index: 2, tradeFeeRate:   100, tickSpacing:   1 }, // 0.01%
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
    // Exclude dynamic-fee configs (Raydium CLMM upgrade, May 2026). Every
    // downstream consumer — the fee-tier picker, the funding estimate, the
    // Fee Key income projection, the "what is a fee tier" glossary — treats
    // tradeFeeRate as the pool's FIXED fee. A dynamic config's rate is only
    // its baseline; the pool charges more under volatility. Offering one as
    // if it were static would misstate the fee to the user and misprice the
    // estimate. The API surfaces the control field on newer responses;
    // configs that don't carry it are static by definition.
    .filter((c) => !isDynamicFeeConfig(c))
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

// A config is dynamic-fee when its control flag is set (non-zero / true).
// Tolerant of the field's absence and of either numeric or boolean forms,
// since the API shape may differ from the on-chain decode.
export function isDynamicFeeConfig(c) {
  if (!c || typeof c !== 'object') return false;
  const v = c.dynamicFeeControl ?? c.dynamic_fee_control ?? c.dynamicFee ?? null;
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  const n = Number(v);
  return Number.isFinite(n) && n !== 0;
}
