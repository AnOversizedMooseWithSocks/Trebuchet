// test/priority-fees.test.mjs
//
// Unit tests for priorityFees.js — the shared priority-fee sampler and
// ComputeBudget instruction builders used by walletHelpers.js and
// tokenService.js. All offline: the sampler takes a plain connection-shaped
// object, so a stub with getRecentPrioritizationFees is all we need.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  samplePriorityFeeMicroLamports,
  computeBudgetIxs,
  priorityFeeLamports,
  umiComputeBudgetIxs,
  PRIORITY_FEE_FLOOR_MICROLAMPORTS,
  PRIORITY_FEE_CEIL_MICROLAMPORTS,
  SWEEP_FEE_PAD_LAMPORTS,
} from '../priorityFees.js';

// Helper: a connection stub whose fee lookup returns the given slot fees.
function connWithFees(fees) {
  return {
    getRecentPrioritizationFees: async () =>
      fees.map((f, i) => ({ slot: 1000 + i, prioritizationFee: f })),
  };
}

// ---------------------------------------------------------------------------
// samplePriorityFeeMicroLamports
// ---------------------------------------------------------------------------

test('sampler: returns floor when the RPC lacks the method entirely', async () => {
  const fee = await samplePriorityFeeMicroLamports({});
  assert.equal(fee, PRIORITY_FEE_FLOOR_MICROLAMPORTS, 'missing method falls back to floor');
});

test('sampler: returns floor when the lookup throws', async () => {
  const conn = {
    getRecentPrioritizationFees: async () => { throw new Error('boom'); },
  };
  const fee = await samplePriorityFeeMicroLamports(conn);
  assert.equal(fee, PRIORITY_FEE_FLOOR_MICROLAMPORTS, 'lookup error falls back to floor');
});

test('sampler: returns floor when every sampled slot is zero (no contention)', async () => {
  const fee = await samplePriorityFeeMicroLamports(connWithFees([0, 0, 0, 0]));
  assert.equal(fee, PRIORITY_FEE_FLOOR_MICROLAMPORTS);
});

test('sampler: zero-fee slots are dropped before the percentile', async () => {
  // Non-zero fees: [400_000]. With zeros included, p75 of the sorted set
  // [0,0,0,400_000] would land on a zero and the clamp would give the
  // floor — masking real contention. Dropping zeros must yield 400k.
  const fee = await samplePriorityFeeMicroLamports(connWithFees([0, 0, 0, 400_000]));
  assert.equal(fee, 440_000, 'p75 of non-zero fees, with 10% headroom');
});

test('sampler: takes the 75th percentile of non-zero fees', async () => {
  // sorted non-zero: [100k, 200k, 300k, 400k]; idx = floor(4 * 0.75) = 3 -> 400k
  const fee = await samplePriorityFeeMicroLamports(
    connWithFees([300_000, 100_000, 400_000, 200_000]),
  );
  // p75 of [100k,200k,300k,400k] is 400k; the bid adds 10% headroom.
  assert.equal(fee, 440_000);
});

test('sampler: clamps to the floor from below', async () => {
  const fee = await samplePriorityFeeMicroLamports(connWithFees([1, 2, 3, 4]));
  assert.equal(fee, PRIORITY_FEE_FLOOR_MICROLAMPORTS, 'tiny fees clamp up to floor');
});

test('sampler: clamps to the ceiling from above', async () => {
  const fee = await samplePriorityFeeMicroLamports(connWithFees([50_000_000, 90_000_000]));
  assert.equal(fee, PRIORITY_FEE_CEIL_MICROLAMPORTS, 'spike fees clamp down to ceiling');
});

test('sampler: custom floor/ceil are honored', async () => {
  const fee = await samplePriorityFeeMicroLamports(connWithFees([500_000]), {
    floor: 10_000,
    ceil: 100_000,
  });
  assert.equal(fee, 100_000, 'custom ceiling clamps the sample');
});

test('sampler: passes lockedWritableAccounts through when scoped', async () => {
  let seenArg = 'unset';
  const conn = {
    getRecentPrioritizationFees: async (arg) => { seenArg = arg; return []; },
  };
  await samplePriorityFeeMicroLamports(conn, { writableAccounts: ['someAccount'] });
  assert.deepEqual(seenArg, { lockedWritableAccounts: ['someAccount'] });

  await samplePriorityFeeMicroLamports(conn);
  assert.equal(seenArg, undefined, 'unscoped call passes no filter');
});

// ---------------------------------------------------------------------------
// priorityFeeLamports — sweep cushion math
// ---------------------------------------------------------------------------

test('priorityFeeLamports: exact division', () => {
  // 20_000 CU * 50_000 uL / 1e6 = 1000 lamports exactly
  assert.equal(priorityFeeLamports(20_000, 50_000), 1000);
});

test('priorityFeeLamports: rounds UP, never down', () => {
  // 20_000 * 50_001 / 1e6 = 1000.02 -> a 1000-lamport reserve would be
  // short; the cushion must round up so the sweep can always pay itself.
  assert.equal(priorityFeeLamports(20_000, 50_001), 1001);
});

// ---------------------------------------------------------------------------
// computeBudgetIxs — web3.js instruction shape
// ---------------------------------------------------------------------------

test('computeBudgetIxs: two ComputeBudget instructions, limit first', () => {
  const ixs = computeBudgetIxs({ units: 120_000, microLamports: 75_000 });
  assert.equal(ixs.length, 2);
  for (const ix of ixs) {
    assert.equal(
      ix.programId.toBase58(),
      'ComputeBudget111111111111111111111111111111',
    );
  }
  // Discriminators: SetComputeUnitLimit = 2, SetComputeUnitPrice = 3.
  // Limit must come first (a limit set after the app ixs is too late).
  assert.equal(ixs[0].data[0], 2, 'first ix is SetComputeUnitLimit');
  assert.equal(ixs[1].data[0], 3, 'second ix is SetComputeUnitPrice');
  // Payload check: u32 LE units, u64 LE microLamports.
  assert.equal(new DataView(Uint8Array.from(ixs[0].data).buffer).getUint32(1, true), 120_000);
  assert.equal(new DataView(Uint8Array.from(ixs[1].data).buffer).getBigUint64(1, true), 75_000n);
});

// ---------------------------------------------------------------------------
// umiComputeBudgetIxs — hand-rolled umi instruction shape
// ---------------------------------------------------------------------------

test('umiComputeBudgetIxs: matches the ComputeBudget wire format', () => {
  const ixs = umiComputeBudgetIxs({ units: 300_000, microLamports: 1_000_000 });
  assert.equal(ixs.length, 2);
  for (const wrapped of ixs) {
    assert.equal(String(wrapped.instruction.programId), 'ComputeBudget111111111111111111111111111111');
    assert.deepEqual(wrapped.instruction.keys, [], 'ComputeBudget ixs take no accounts');
    assert.deepEqual(wrapped.signers, []);
    assert.equal(wrapped.bytesCreatedOnChain, 0);
  }
  const limit = ixs[0].instruction.data;
  const price = ixs[1].instruction.data;
  assert.equal(limit[0], 0x02);
  assert.equal(new DataView(limit.buffer).getUint32(1, true), 300_000);
  assert.equal(price[0], 0x03);
  assert.equal(new DataView(price.buffer).getBigUint64(1, true), 1_000_000n);
});

test('umi and web3 builders encode identical instruction data', () => {
  // Both shapes must hit the same program with the same bytes — this pins
  // the hand-rolled umi encoding to web3.js's reference implementation.
  const web3 = computeBudgetIxs({ units: 42_000, microLamports: 123_456 });
  const umi = umiComputeBudgetIxs({ units: 42_000, microLamports: 123_456 });
  assert.deepEqual(Array.from(web3[0].data), Array.from(umi[0].instruction.data));
  assert.deepEqual(Array.from(web3[1].data), Array.from(umi[1].instruction.data));
});

// ---------------------------------------------------------------------------
// Round-up / overestimate guarantees
// ---------------------------------------------------------------------------

test('sampler: bids 10% over the sample, rounded UP, never exactly at it', async () => {
  // 100_001 * 1.1 = 110_001.1 -> must round up to 110_002, not truncate.
  const fee = await samplePriorityFeeMicroLamports(connWithFees([100_001]));
  assert.equal(fee, 110_002, 'headroom is applied with Math.ceil');
  // The bid must always be strictly greater than the sample when the
  // sample is above the floor and below the ceiling.
  assert.ok(fee > 100_001, 'never bid exactly the observed rate');
});

test('sampler: headroom never pushes the bid past the ceiling', async () => {
  // 950_000 * 1.1 = 1_045_000 -> clamped back to the 1M ceiling.
  const fee = await samplePriorityFeeMicroLamports(connWithFees([950_000]));
  assert.equal(fee, PRIORITY_FEE_CEIL_MICROLAMPORTS);
});

test('sweep pad: exported, positive, and keeps the leftover under the dust threshold', () => {
  assert.ok(Number.isInteger(SWEEP_FEE_PAD_LAMPORTS) && SWEEP_FEE_PAD_LAMPORTS > 0);
  // Worst-case sweep leftover must stay "effectively empty" per
  // walletRecovery.js (SOL_DUST_THRESHOLD = 0.001 SOL = 1_000_000
  // lamports), or swept wallets would never clear the recovery panel:
  //   rent(0 bytes) 890_880 + base fee 5_000
  //   + max priority ceil(CU_SOL_TRANSFER * ceiling / 1e6) + pad
  const worstLeftover = 890_880 + 5_000
    + priorityFeeLamports(20_000, PRIORITY_FEE_CEIL_MICROLAMPORTS)
    + SWEEP_FEE_PAD_LAMPORTS;
  assert.ok(
    worstLeftover < 1_000_000,
    `worst-case sweep leftover ${worstLeftover} must stay under the 0.001 SOL dust threshold`,
  );
});
