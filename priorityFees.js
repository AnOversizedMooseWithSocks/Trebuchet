// priorityFees.js
//
// Shared priority-fee plumbing for every transaction path OUTSIDE the
// Raydium LP pipeline. (lpService.js has its own equivalent sampler,
// lpPriorityFeeMicroLamports, tuned and proven for the launch path; it is
// deliberately left untouched. This module brings the REST of the app —
// mint/metadata creation, sweeps, airdrops, transfers — up to the same
// standard, because a transaction with no priority fee is the first thing
// dropped during congestion.)
//
// Background (Solana fee mechanics):
//   - Every tx pays a base fee of 5000 lamports per signature.
//   - A tx may additionally bid a PRIORITY fee, expressed as micro-lamports
//     per compute unit (CU), via two ComputeBudget program instructions:
//       SetComputeUnitLimit(units)        — cap the CU the tx may consume
//       SetComputeUnitPrice(microLamports) — the per-CU bid
//   - Total priority cost = units * microLamports / 1_000_000 lamports,
//     charged on the REQUESTED units, not the consumed units. So the CU
//     limit should have margin (a tx that exceeds its limit fails) but not
//     be gratuitously huge (that inflates the bid).
//   - Validators fill blocks in bid-priority order. During congestion, a
//     zero-bid tx is exactly the one that never lands.
//
// Sampling strategy: getRecentPrioritizationFees over the last ~150 blocks,
// drop the zero-fee slots (idle slots pull the estimate toward 0 — the
// wrong direction when we're pricing for contention), take the 75th
// percentile of what remains, clamp to [floor, ceil]. This mirrors the
// battle-tested logic in lpService.js and matches current ecosystem
// guidance (p50–p75 of non-zero fees; higher only for extreme load).
// Any failure in the lookup falls back to the floor — a fee estimate must
// never be the reason an operation aborts.

import { ComputeBudgetProgram } from '@solana/web3.js';
import { publicKey as umiPublicKey } from '@metaplex-foundation/umi';

// Floor: 50k micro-lamports/CU is a meaningful bid in quiet conditions and
// costs almost nothing (50k uL * 100k CU = 5000 lamports = 0.000005 SOL).
// Ceiling: 1M uL/CU caps the worst-case spend at 0.0001 SOL per 100k CU —
// congestion protection without ever being able to drain a wallet.
// Same values as lpService.js.
export const PRIORITY_FEE_FLOOR_MICROLAMPORTS = 50_000;
export const PRIORITY_FEE_CEIL_MICROLAMPORTS = 1_000_000;

// Headroom on the sampled bid: pay 10% over the observed p75, rounded UP.
// The sample is a rear-view mirror — it prices the LAST ~150 blocks, and a
// rising market means the going rate when OUR tx lands is higher than what
// we measured. Bidding exactly the sample is cutting the corner; the 10%
// costs fractions of a cent (bounded by the ceiling either way) and buys
// margin against exactly the drift that gets transactions dropped.
// Implemented as integer math, ceil(sample * 11 / 10), in the samplers —
// this constant documents the ratio for readers and tests.
export const PRIORITY_FEE_HEADROOM_MULTIPLIER = 1.1;

// Flat safety pad, in lamports, added to every sweep's fee reserve on top
// of the exact base-fee + priority-fee cost. The exact reserve is
// mathematically sufficient today, but "exactly enough" is one fee-structure
// change, one extra signature, or one rounding assumption away from an
// insufficient-lamports failure on the very last transaction of a launch.
// 10k lamports (0.00001 SOL) of dust left behind is nothing; a failed final
// sweep is a support ticket. Sized so the worst-case leftover
// (rent 890,880 + base 5,000 + max priority 20,000 + this pad) stays
// comfortably under the 0.001 SOL "effectively empty" threshold in
// walletRecovery.js — if that threshold ever changes, re-check this.
export const SWEEP_FEE_PAD_LAMPORTS = 10_000;

// Compute-unit limits per operation shape. Measured costs run well under
// these; the margin exists because a tx that EXCEEDS its CU limit fails
// outright, which is the exact failure mode this module exists to prevent.
// The margin costs a little extra priority fee (see cost math above) and
// that trade is deliberate: overpaying fractions of a cent beats a failed
// transaction every time.
export const CU_SOL_TRANSFER = 20_000;     // SystemProgram.transfer (~450 CU used)
export const CU_TOKEN_TRANSFER = 120_000;  // idempotent ATA create + transferChecked
export const CU_MINT_OPS = 120_000;        // createAccount+initMint / mintTo / setAuthority
export const CU_METADATA_OPS = 300_000;    // Metaplex createV1 / updateV1 (CPI-heavy)

/**
 * Sample recent on-chain priority fees and return a clamped micro-lamports
 * per-CU bid. Optionally scoped to `writableAccounts` (an array of
 * PublicKey / base58 strings): the RPC then reports fees paid by txs
 * contending for THOSE accounts — a far better predictor of what it costs
 * to land a tx that locks them, since Solana fee markets are per-account,
 * not global.
 *
 * Never throws. Any lookup problem (RPC without the method, network error,
 * empty response) returns the floor.
 */
export async function samplePriorityFeeMicroLamports(connection, {
  writableAccounts,
  floor = PRIORITY_FEE_FLOOR_MICROLAMPORTS,
  ceil = PRIORITY_FEE_CEIL_MICROLAMPORTS,
} = {}) {
  try {
    const scoped = Array.isArray(writableAccounts) && writableAccounts.length > 0;
    const recent = await connection.getRecentPrioritizationFees(
      scoped ? { lockedWritableAccounts: writableAccounts } : undefined,
    );
    if (Array.isArray(recent) && recent.length > 0) {
      const fees = recent
        .map((r) => Number(r.prioritizationFee) || 0)
        .filter((f) => f > 0)     // drop idle slots (see header comment)
        .sort((a, b) => a - b);
      if (fees.length === 0) return floor; // no contention anywhere: floor is right
      const idx = Math.min(fees.length - 1, Math.floor(fees.length * 0.75));
      // Bid slightly OVER the observed rate, rounded up — never exactly at
      // it (see PRIORITY_FEE_HEADROOM_MULTIPLIER). Integer math (×11 ÷10)
      // rather than ×1.1: float multiply turns 400_000 into
      // 440_000.00000000006 and ceil then overshoots by a stray unit —
      // harmless in direction, but fee math should be deterministic.
      const bid = Math.ceil((fees[idx] * 11) / 10);
      return Math.max(floor, Math.min(ceil, bid));
    }
  } catch (e) {
    console.warn(`samplePriorityFeeMicroLamports: fee lookup failed, using floor (${e.message})`);
  }
  return floor;
}

/**
 * The two ComputeBudget instructions for a web3.js Transaction. Add these
 * FIRST — the CU limit must be set before the app instructions run, or a
 * heavy step can blow the default budget before the limit applies.
 *
 *   tx.add(...computeBudgetIxs({ units, microLamports }), <app ixs...>)
 */
export function computeBudgetIxs({ units, microLamports }) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
  ];
}

/**
 * The priority-fee cost of a tx in whole lamports, rounded UP. Used to size
 * the SOL cushion left behind by sweeps: a sweep that reserves only the
 * 5000-lamport base fee will itself fail with "insufficient lamports" the
 * moment a priority fee is attached, so the reserve must include this.
 */
export function priorityFeeLamports(units, microLamports) {
  return Math.ceil((units * microLamports) / 1_000_000);
}

// ---------------------------------------------------------------------------
// Umi variants — for the Metaplex createV1/updateV1 builders in
// tokenService.js. We build the two ComputeBudget instructions by hand in
// umi's instruction shape rather than pulling in @metaplex-foundation/
// mpl-toolbox as a new dependency: the wire format is two tiny fixed
// layouts and hand-rolling them keeps the dependency tree (and the supply-
// chain surface of a key-handling app) unchanged.
//
// ComputeBudget program instruction data layouts (little-endian):
//   SetComputeUnitLimit: [0x02][u32 units]
//   SetComputeUnitPrice: [0x03][u64 microLamports]
// ---------------------------------------------------------------------------

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

function umiIx(data) {
  // Umi "wrapped instruction" shape, as accepted by TransactionBuilder
  // .prepend()/.add(): the raw instruction plus signer + rent metadata.
  return {
    instruction: {
      programId: umiPublicKey(COMPUTE_BUDGET_PROGRAM_ID),
      keys: [],
      data,
    },
    signers: [],
    bytesCreatedOnChain: 0,
  };
}

/**
 * Umi-shaped ComputeBudget instructions to prepend to a Metaplex builder:
 *
 *   await createV1(umi, {...})
 *     .prepend(...umiComputeBudgetIxs({ units, microLamports }))
 *     .sendAndConfirm(umi);
 */
export function umiComputeBudgetIxs({ units, microLamports }) {
  const limitData = new Uint8Array(5);
  limitData[0] = 0x02;
  new DataView(limitData.buffer).setUint32(1, units, true); // little-endian u32

  const priceData = new Uint8Array(9);
  priceData[0] = 0x03;
  new DataView(priceData.buffer).setBigUint64(1, BigInt(microLamports), true); // LE u64

  return [umiIx(limitData), umiIx(priceData)];
}
