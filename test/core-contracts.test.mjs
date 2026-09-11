import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createTrebuchetCore,
  v2LaunchProofFingerprint,
  v2TransferEvidenceHash,
} from '@trebuchet/core';
import { buildV2LaunchPlan as compatibilityPlanBuilder } from '../v2LaunchPlan.js';

const fixture = JSON.parse(await readFile(
  new URL('../packages/core/test/fixtures/guided-sol-plan.json', import.meta.url),
  'utf8',
));

function planSummary(plan) {
  return {
    schema: plan.schema,
    protocolVersion: plan.protocolVersion,
    contractVersion: plan.contractVersion,
    id: plan.id,
    generatedAt: plan.generatedAt,
    configFingerprint: plan.v2LaunchConfigFingerprint,
    walletFingerprint: plan.v2LaunchWalletFingerprint,
    estimatedSolCost: plan.funding.estimatedSolCost,
    operationIds: plan.operations.map(({ id }) => id),
    integrityDigest: plan.integrity.digest,
  };
}

function completeProof() {
  const proof = {
    status: 'completed',
    stage: 'transfer_completed',
    journalId: 'journal-core-1',
    walletPublicKey: '11111111111111111111111111111115',
    token: {
      mint: '11111111111111111111111111111117',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: ['11111111111111111111111111111118'],
      results: [{
        poolId: '11111111111111111111111111111118',
        createPoolTx: 'create-pool-tx',
        mainPositions: [{
          positionNftMint: '11111111111111111111111111111119',
          feeKeyNftMint: '1111111111111111111111111111111A',
          locked: true,
          openTx: 'open-position-tx',
          lockTx: 'lock-position-tx',
        }],
      }],
    },
    airdrop: { plannedRecipientCount: 0, deliveredCount: 0, failedCount: 0 },
    transfer: {
      status: 'completed',
      destinationWallet: '11111111111111111111111111111116',
      walletEmpty: true,
      solTxId: 'sweep-sol-tx',
      tokenTransferErrors: [],
      nftTransferErrors: [],
    },
  };
  proof.terminalTransferEvidenceHash = v2TransferEvidenceHash(proof.transfer);
  return proof;
}

test('Core plan contract matches the committed Guided SOL golden fixture', () => {
  const core = createTrebuchetCore({ clock: () => new Date(fixture.expected.generatedAt) });
  const plan = core.planLaunch(fixture.intent);
  assert.deepEqual(planSummary(plan), fixture.expected);
  assert.equal(core.verifyPlan(plan).valid, true);
  assert.equal(
    compatibilityPlanBuilder(fixture.intent, { now: fixture.expected.generatedAt }).integrity.digest,
    plan.integrity.digest,
  );
});

test('Core rejects a plan whose normalized contents were modified', () => {
  const core = createTrebuchetCore({ clock: () => new Date(fixture.expected.generatedAt) });
  const plan = structuredClone(core.planLaunch(fixture.intent));
  plan.funding.estimatedSolCost += 1;
  const result = core.verifyPlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'COST_MISMATCH'));
  assert.ok(result.errors.some(({ code }) => code === 'INTEGRITY_MISMATCH'));
});

test('Core estimate is detached from the runtime object receiver', () => {
  const { planLaunch, estimateLaunch } = createTrebuchetCore({
    clock: () => new Date(fixture.expected.generatedAt),
  });
  const estimate = estimateLaunch(planLaunch(fixture.intent));
  assert.equal(estimate.schema, 'trebuchet-launch-estimate/v1');
  assert.equal(estimate.estimatedSolCost, fixture.expected.estimatedSolCost);
  assert.equal(estimate.operationCount, fixture.expected.operationIds.length);
});

test('Core independently verifies stored proof fingerprints', () => {
  const core = createTrebuchetCore();
  const proof = completeProof();
  const fingerprint = v2LaunchProofFingerprint(proof);
  const payload = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    proof,
    fieldVerification: { proofFingerprint: fingerprint },
  };
  assert.equal(core.verifyProof(payload).valid, true);
  payload.fieldVerification.proofFingerprint = 'tampered';
  const invalid = core.verifyProof(payload);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(({ code }) => code === 'FINGERPRINT_MISMATCH'));
});

test('terminal transfer evidence uses a full SHA-256 digest', () => {
  const transfer = {
    destinationWallet: 'Destination111',
    status: 'completed',
    walletEmpty: true,
  };
  const canonicalEvidence = JSON.stringify({
    destinationWallet: 'Destination111',
    status: 'completed',
    walletEmpty: true,
    rows: [],
  });
  const expected = crypto.createHash('sha256').update(canonicalEvidence).digest('hex');

  assert.equal(v2TransferEvidenceHash(transfer), expected);
  assert.match(expected, /^[a-f0-9]{64}$/);
});

test('Core rejects fabricated, incomplete, and unbound proof objects', () => {
  const core = createTrebuchetCore();
  const fabricated = core.verifyProof({ token: {}, liquidity: {} });
  assert.equal(fabricated.valid, false);
  assert.ok(fabricated.errors.some(({ code }) => code === 'PROVENANCE_MISMATCH'));
  assert.ok(fabricated.errors.some(({ code }) => code === 'PROOF_INCOMPLETE'));

  const proof = completeProof();
  const unbound = core.verifyProof({ schema: 'trebuchet-v2-proof', source: 'trebuchet-v2', proof });
  assert.equal(unbound.valid, false);
  assert.ok(unbound.errors.some(({ code }) => code === 'FINGERPRINT_MISSING'));
});
