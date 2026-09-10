// lpDistribution.js
//
// Pure distribution validation and normalization. Extracted from lpService.js
// so distribution validation can be tested without importing Raydium SDK.

import { PublicKey } from '@solana/web3.js';

/**
 * Validate and normalize a distribution array. Each entry is an object with
 * `sharePercent` (number) and an optional `recipient` (base58 wallet address).
 *
 *   - null / undefined / []  →  [{ sharePercent: 100 }]  (single slice)
 *   - shares must sum to 100 ± 0.01 (tolerates floating-point drift)
 *   - every share must be > 0
 *   - every recipient must be a valid base58 public key
 *
 * Returns the normalized array. Throws on invalid input.
 */
export function normalizeDistribution(distribution) {
  if (!distribution || distribution.length === 0) {
    return [{ sharePercent: 100 }];
  }
  const slices = distribution.map((s) => ({
    sharePercent: Number(s.sharePercent),
    recipient: s.recipient || null,
  }));
  // Non-finite shares must be rejected FIRST and explicitly. NaN (from a
  // missing or non-numeric sharePercent) silently defeats both checks
  // below, because every NaN comparison is false:
  //   Math.abs(NaN - 100) > 0.01  ->  false   (sum check passes)
  //   NaN <= 0                    ->  false   (positive check passes)
  // A NaN share would then flow into position-supply math as a NaN token
  // amount. This is the server-side trust boundary for a request body, so
  // it cannot assume the sender is the app's own UI.
  const badIdx = slices.findIndex((s) => !Number.isFinite(s.sharePercent));
  if (badIdx >= 0) {
    throw new Error(
      `Distribution share #${badIdx + 1} is not a valid number `
      + `(received ${JSON.stringify(distribution[badIdx]?.sharePercent)})`,
    );
  }
  const total = slices.reduce((acc, s) => acc + s.sharePercent, 0);
  if (Math.abs(total - 100) > 0.01) {
    throw new Error(
      `Distribution shares sum to ${total}%, must sum to 100%`,
    );
  }
  if (slices.some((s) => s.sharePercent <= 0)) {
    throw new Error(`All distribution shares must be > 0%`);
  }
  for (const s of slices) {
    if (s.recipient) {
      try {
        new PublicKey(s.recipient);
      } catch (e) {
        throw new Error(`Invalid recipient address: ${s.recipient}`);
      }
    }
  }
  return slices;
}
