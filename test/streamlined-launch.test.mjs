// test/streamlined-launch.test.mjs
//
// Deterministic tests for the greenfield v2 streamlined launch model.
// The v2 model is pure CPMM on Token-2022 native metadata — there is no
// CLMM alternative, no tick arrays, no per-range positions, no Burn & Earn.
// Tests are frozen against the constant ledger. No network, no chain.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStreamlinedLedger,
  buildStreamlinedPlan,
  buildClassicReferenceLedger,
  STREAMLINED_DEFAULT_POOL_COUNT,
  verifyStreamlinedPlan,
} from '../packages/core/src/streamlined-launch.js';

function defaultPlan() {
  return buildStreamlinedPlan({
    token: { name: 'Streamlined Test', symbol: 'STST' },
    solUsd: 150,
  });
}

const EPSILON = 1e-6;

test('default plan is CPMM on Token-2022 with one SOL pool', () => {
  const plan = defaultPlan();
  assert.equal(plan.topology.poolCount, STREAMLINED_DEFAULT_POOL_COUNT);
  assert.equal(plan.token.mintFormat, 'token-2022');
  assert.equal(plan.topology.pools[0].sol, true);
  // Pure CPMM: no tick arrays, no per-range positions.
  assert.equal(plan.topology.pools[0].tickArrays, 0);
  assert.equal(plan.topology.pools[0].positionCount, 0);
  assert.ok(
    plan.batch.txs[0].instructions.some((instruction) => instruction.kind === 'create-mint' && instruction.program === 'token-2022'),
    'mint instruction is a Token-2022 native create',
  );
  assert.ok(
    plan.batch.txs[0].instructions.every((instruction) => instruction.program !== 'raydium-clmm'),
    'no CLMM instructions exist in the streamlined batch',
  );
});

test('single-pool CP-2022 plan is the ~0.12 SOL recipe', () => {
  const plan = defaultPlan();
  // Pool state 0.062 + LP mint/vaults 0.004 + deposit/lock 0.001 + network
  // 0.001 + SOL dust 0.001 + native mint 0.05 = 0.119 subtotal, +2% = 0.1214.
  assert.ok(Math.abs(plan.ledger.subtotalSol - 0.119) < EPSILON);
  assert.ok(Math.abs(plan.ledger.totalSol - 0.12138) < EPSILON);
});

test('comparison vs classic 8-pool reference at $150/SOL', () => {
  const plan = defaultPlan();
  assert.equal(plan.classicReference.poolCount, 8);
  assert.ok(Math.abs(plan.classicReference.totalSol - 3.48776) < 1e-4);
  // Pure CP-2022 comes in ~96.5% under the moose classic reference.
  assert.ok(plan.comparison.savingPct > 96, `saving was ${plan.comparison.savingPct}%`);
});

test('classic ledger reproduces the moose 8-pool accounting', () => {
  const ledger = buildClassicReferenceLedger({ classicPoolCount: 8, solUsd: 150 });
  const goods = ledger.lines.reduce((sum, line) => sum + line.sol, 0);
  assert.ok(Math.abs(ledger.subtotalSol - goods) < EPSILON);
  // subtotal 2.9064 + 20% buffer = 3.4878.
  assert.ok(Math.abs(ledger.totalSol - 3.48776) < 2e-3, `classic total was ${ledger.totalSol}`);
});

test('8 CP-2022 pools cost ~0.61 SOL total (no tick arrays)', () => {
  const plan = buildStreamlinedPlan({
    token: { name: 'Eight', symbol: 'EIGHT' },
    poolCount: 8,
    quotes: ['SOL', 'USDC', 'USDT', 'USDC', 'USDC', 'USDC', 'USDC', 'USDC'],
    solUsd: 150,
  });
  assert.equal(plan.topology.poolCount, 8);
  assert.ok(Math.abs(plan.ledger.totalSol - 0.654502) < 2e-3, `total was ${plan.ledger.totalSol}`);
});

test('second pool adds an exact quote purchase line', () => {
  const plan = buildStreamlinedPlan({
    token: { name: 'Two Pools', symbol: 'TWO' },
    poolCount: 2,
    quotes: ['SOL', 'USDC'],
    solUsd: 150,
  });
  assert.equal(plan.topology.nonSolPoolCount, 1);
  const quoteLine = plan.ledger.lines.find((line) => /USDC.*quote-side/.test(line.label));
  assert.ok(quoteLine, 'non-SOL pool has a quote-purchase line');
  // Exact $1 quote budget at $150/SOL: 1/150 = 0.006667 (no oversize).
  assert.ok(Math.abs(quoteLine.sol - 0.006667) < 1e-5);
});

test('verifier accepts the generated plan and rejects tampering', () => {
  const plan = defaultPlan();
  assert.equal(verifyStreamlinedPlan(plan).valid, true);

  const tamperedLines = JSON.parse(JSON.stringify(plan));
  tamperedLines.ledger.lines[0].sol += 0.001;
  const lineError = verifyStreamlinedPlan(tamperedLines);
  assert.equal(lineError.valid, false);
  assert.ok(lineError.errors.some((e) => e.code === 'LEDGER_MISMATCH'));

  const tamperedDigest = JSON.parse(JSON.stringify(plan));
  tamperedDigest.integrity.digest = 'deadbeef'.repeat(8);
  const digestError = verifyStreamlinedPlan(tamperedDigest);
  assert.equal(digestError.valid, false);
  assert.ok(digestError.errors.some((e) => e.code === 'INTEGRITY_MISMATCH'));
});

test('integrity digest is stable across JSON round trips', () => {
  const plan = defaultPlan();
  const roundTripped = JSON.parse(JSON.stringify(plan));
  assert.deepEqual(roundTripped, plan);
  assert.equal(
    verifyStreamlinedPlan(roundTripped).digest,
    verifyStreamlinedPlan(plan).digest,
  );
});

test('fees are optional and route through the program fee wrapper', () => {
  const plain = defaultPlan();
  assert.equal(plain.fees.enabled, false);
  assert.ok(!plain.batch.txs[0].instructions.some((instruction) => instruction.id === 'fee-wrapper'));

  const treasury = 'AkQ7oB2w4WM2V5oWBSD7ZwkSZwinZyTxbWJ7Ko9TJZDj';
  const taxed = buildStreamlinedPlan({
    token: { name: 'Taxed', symbol: 'TAX' },
    solUsd: 150,
    fees: { buyBps: 500, sellBps: 100, transferBps: 0, treasury },
  });
  assert.equal(taxed.fees.enabled, true);
  assert.equal(taxed.fees.buyBps, 500);
  assert.equal(taxed.fees.mode, 'program-fee-wrapper');
  // The fee costs 0 SOL: it is a surcharge, not a spend — pool net stays exact.
  assert.equal(taxed.ledger.totalSol, 0.12138);
  const feeLine = taxed.ledger.lines.find((line) => /^Swap fees /.test(line.label));
  assert.ok(feeLine && feeLine.sol === 0, 'ledger shows the fee policy with zero base cost');
  assert.ok(
    taxed.batch.txs[0].instructions.some((instruction) => instruction.id === 'fee-wrapper'),
    'batch includes the fee-wrapper instruction',
  );
  const check = taxed.checks.find((entry) => entry.id === 'swap-fee-routing');
  assert.match(check.detail, /treasury/);
  assert.equal(verifyStreamlinedPlan(taxed).valid, true);
});

test('fees require a treasury and clamp to the bps ceiling', () => {
  assert.throws(
    () => buildStreamlinedPlan({
      token: { name: 'Tax', symbol: 'TAX' },
      fees: { buyBps: 100 },
    }),
    /treasury/,
  );
  const clamped = buildStreamlinedPlan({
    token: { name: 'Tax', symbol: 'TAX' },
    fees: { buyBps: 50000, treasury: 'AkQ7oB2w4WM2V5oWbSD7ZkQmZwinZyTxbWJ7o9TJZDj' },
  });
  assert.equal(clamped.fees.buyBps, 10000);
});

test('one-signature batch blueprint: user-signed, no custody, no sweep', () => {
  const plan = defaultPlan();
  const batch = plan.batch;
  assert.equal(batch.policy.signers, 'user');
  assert.equal(batch.policy.batchSignatureCount, 1);
  assert.equal(batch.policy.stagingCustody, 'none');
  assert.equal(batch.policy.sweep, 'none');
  assert.equal(batch.txs.length, 1);
  assert.equal(batch.txs[0].signatureCount, 1);

  // CPMM pool: create + deposit + transfer-lock = 3 steps per pool;
  // Token-2022 mint is 1 step.
  const ids = batch.txs[0].instructions.map((instruction) => instruction.id);
  assert.ok(ids.includes('create-token-2022-mint'));
  assert.ok(ids.includes('pool-1-create'));
  assert.ok(ids.includes('pool-1-deposit'));
  assert.ok(ids.includes('pool-1-lock'));
  assert.equal(ids.length, 1 + 3);
});