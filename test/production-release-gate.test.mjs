import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_V2_RELEASE_ATTESTATION,
  DEFAULT_V2_RELEASE_EVIDENCE,
  parseReleaseTag,
  runProductionReleaseGate,
  validateProductionTrust,
  validateV2ReleaseAttestation,
  validateV2ReleaseEvidence,
} from '../scripts/production-release-gate.mjs';
import {
  requiredClassicComparisonRowIds,
  v2LaunchProofFingerprint,
  v2TransferEvidenceHash,
} from '../scripts/v2-proof-integrity.mjs';

const REQUIREMENT_IDS = [
  'live-proof',
  'report-proof',
  'classic-comparison',
  'audit',
  'replacement-criteria',
];

const CRITERION_IDS = [
  'demo-end-to-end',
  'wallet-lifecycle',
  'vanity-options',
  'token-config-parity',
  'charts-and-viewport',
  'pool-config-parity',
  'funding-and-quote',
  'held-reserve-backing',
  'run-and-resume',
  'sweep-report-proof',
  'classic-artifact-comparison',
  'proof-audit',
];

const AUDIT_IDS = [
  'token-proof',
  'launch-config-proof',
  'authority-proof',
  'pool-proof',
  'position-proof',
  'lock-proof',
  'fee-key-proof',
  'airdrop-proof',
  'recovery-proof',
  'terminal-journal-proof',
  'report-proof',
  'sweep-proof',
  'classic-comparison',
];

const TRUSTED_ENV = {
  CSC_LINK: 'base64-p12',
  CSC_KEY_PASSWORD: 'mac-password',
  APPLE_API_KEY: 'private-api-key',
  APPLE_API_KEY_ID: 'api-key-id',
  APPLE_API_ISSUER: 'api-issuer',
  WIN_CSC_LINK: 'base64-pfx',
  WIN_CSC_KEY_PASSWORD: 'windows-password',
};

const FIELD_RUN_COMMIT = 'a'.repeat(40);
const RELEASE_COMMIT = 'b'.repeat(40);
const EXPORTED_AT = '2026-07-16T12:00:00.000Z';
const NOW = Date.parse('2026-07-16T15:00:00.000Z');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function passingRows(ids, { actions = false } = {}) {
  return ids.map((id) => ({
    id,
    label: id,
    pass: true,
    ...(actions ? { action: 'none' } : {}),
    detail: 'Proof attached.',
  }));
}

function completeV2Evidence() {
  const launchConfig = {
    schema: 'trebuchet-v2-launch-config',
    source: 'trebuchet-v2',
    token: { name: 'Production', symbol: 'PROD', supply: '1000000', decimals: 9 },
    poolTopology: {
      sweepDestination: 'Destination111111111111111111111111111111',
      pools: [{
        id: 'pool-plan-1',
        quoteToken: 'SOL',
        quoteMint: 'So11111111111111111111111111111111111111112',
        supplyPercent: 100,
      }],
    },
  };
  const proof = {
    source: 'launch-journal',
    status: 'completed',
    stage: 'transfer_completed',
    journalId: 'journal-live-1',
    walletPublicKey: 'LaunchWallet11111111111111111111111111111',
    token: {
      mint: 'Mint111111111111111111111111111111111111',
      symbol: 'PROD',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolCount: 1,
      poolIds: ['Pool111111111111111111111111111111111111'],
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'Pool111111111111111111111111111111111111',
        quoteMint: 'So11111111111111111111111111111111111111112',
        supplyPercent: 100,
        tickSpacing: 60,
        initialPrice: '0.000001',
        launchedSide: 'mintA',
        txIds: { createPool: 'CreatePoolTx111' },
        mainPositions: [{
          sliceIndex: 0,
          sharePercent: 100,
          tickLower: 60,
          tickUpper: 443580,
          positionNftMint: 'PositionNft1111111111111111111111111111',
          feeKeyNftMint: 'FeeKeyNft11111111111111111111111111111',
          locked: true,
          recipient: 'FeeRecipient111111111111111111111111111',
          transferredTo: 'FeeRecipient111111111111111111111111111',
          txIds: {
            open: 'OpenPositionTx111',
            lock: 'LockPositionTx111',
            transfer: 'TransferFeeKeyTx111',
          },
        }],
      }],
    },
    airdrop: {
      plannedRecipientCount: 1,
      deliveredCount: 1,
      failedCount: 0,
      recipients: [{ wallet: 'AirdropWallet11111111111111111111111111', tokens: 100, amountRaw: '100000000000' }],
      transferred: [{
        wallet: 'AirdropWallet11111111111111111111111111',
        tokens: 100,
        amountRaw: '100000000000',
        txId: 'AirdropTx111',
      }],
      failed: [],
    },
    transfer: {
      status: 'completed',
      destinationWallet: launchConfig.poolTopology.sweepDestination,
      walletEmpty: true,
      solTransferred: 0.01,
      solTxId: 'SweepSolTx111',
      tokenTransferErrors: [],
      nftTransferErrors: [],
    },
    launchConfig,
  };
  const fingerprint = v2LaunchProofFingerprint(proof);
  proof.localDossier = {
    status: 'downloaded',
    kind: 'local-proof-json',
    filename: 'trebuchet-prod-proof.json',
    downloadedAt: EXPORTED_AT,
    dataVersion: 13,
    proofFingerprint: fingerprint,
    mint: proof.token.mint,
    sweepEvidenceHash: v2TransferEvidenceHash(proof.transfer),
  };
  const reportParityAudit = {
    version: 1,
    source: 'trebuchet-v2-report-parity-audit',
    generatedAt: EXPORTED_AT,
    proofFingerprint: fingerprint,
    status: 'pass',
    score: 100,
    passCount: AUDIT_IDS.length,
    warnCount: 0,
    missingCount: 0,
    itemCount: AUDIT_IDS.length,
    items: AUDIT_IDS.map((id) => ({ id, label: id, state: 'pass', detail: 'Proof attached.' })),
  };
  const classicRetirementGate = {
    id: 'classic-retirement',
    source: 'trebuchet-v2-classic-retirement-gate',
    proofFingerprint: fingerprint,
    auditFingerprint: fingerprint,
    title: 'Classic can be retired',
    state: 'pass',
    badge: 'Ready',
    passCount: REQUIREMENT_IDS.length,
    itemCount: REQUIREMENT_IDS.length,
    requirements: passingRows(REQUIREMENT_IDS),
    replacementCriteria: passingRows(CRITERION_IDS),
    criteriaPassCount: CRITERION_IDS.length,
    criteriaItemCount: CRITERION_IDS.length,
  };
  const fieldVerification = {
    version: 1,
    source: 'trebuchet-v2-field-verification',
    generatedAt: EXPORTED_AT,
    proofFingerprint: fingerprint,
    state: 'pass',
    ready: true,
    passCount: REQUIREMENT_IDS.length,
    itemCount: REQUIREMENT_IDS.length,
    criteriaPassCount: CRITERION_IDS.length,
    criteriaItemCount: CRITERION_IDS.length,
    blockerCount: 0,
    criteriaBlockerCount: 0,
    nextAction: 'none',
    nextDetail: 'Field verification is complete.',
    requirements: passingRows(REQUIREMENT_IDS, { actions: true }),
    blockers: [],
    replacementCriteria: passingRows(CRITERION_IDS, { actions: true }),
    criteriaBlockers: [],
  };
  const rawClassicArtifact = JSON.stringify({
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      launchWallet: proof.walletPublicKey,
      destinationWallet: proof.transfer.destinationWallet,
      token: proof.token,
      liquidity: proof.liquidity,
      airdrop: proof.airdrop,
      transfer: proof.transfer,
    },
  });
  const comparisonRowIds = requiredClassicComparisonRowIds(proof);
  const classicReportComparison = {
    input: rawClassicArtifact,
    comparedAt: EXPORTED_AT,
    error: null,
    result: {
      status: 'pass',
      comparedAt: EXPORTED_AT,
      artifactKind: 'json',
      artifactSource: 'classic-or-external',
      structuredEvidence: true,
      proofFingerprint: fingerprint,
      passCount: comparisonRowIds.length,
      warnCount: 0,
      missingCount: 0,
      mismatchCount: 0,
      fieldCount: comparisonRowIds.length,
      classicMint: proof.token.mint,
      classicPoolCount: 1,
      rows: comparisonRowIds.map((id) => ({
        id,
        label: id,
        state: 'pass',
        detail: 'Exact structured match.',
      })),
    },
  };
  const launchData = {
    dataVersion: 13,
    source: 'trebuchet-v2',
    generatedAt: EXPORTED_AT,
    launchConfig,
    launchWallet: proof.walletPublicKey,
    mint: proof.token.mint,
    reportParityAudit,
    classicRetirementGate,
    fieldVerification,
  };
  return {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    dataVersion: 13,
    exportedAt: EXPORTED_AT,
    proof,
    launchConfig,
    launchData,
    reportParityAudit,
    classicRetirementGate,
    fieldVerification,
    classicReportComparison,
  };
}

function evidenceBytes(evidence) {
  return Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
}

function completeAttestation(bytes, evidence) {
  return {
    schema: 'trebuchet-v2-production-attestation',
    version: 1,
    cluster: 'mainnet-beta',
    releaseTag: 'v2.0.0',
    decision: 'approved-for-v2-production',
    evidenceSha256: digest(bytes),
    classicArtifactSha256: digest(Buffer.from(evidence.classicReportComparison.input.trim(), 'utf8')),
    fieldRunCommit: FIELD_RUN_COMMIT,
    fieldRunCompletedAt: '2026-07-16T11:55:00.000Z',
    operatedBy: 'field-operator',
    reviewedAt: '2026-07-16T13:00:00.000Z',
    reviewedBy: 'release-reviewer',
  };
}

const ancestorCheck = async (ancestor, descendant) => (
  ancestor === FIELD_RUN_COMMIT && descendant === RELEASE_COMMIT
);

test('production gate identifies v2+ semantic release tags', () => {
  assert.equal(parseReleaseTag('v1.0.49').requiresProductionGate, false);
  assert.equal(parseReleaseTag('v2.0.0').requiresProductionGate, true);
  assert.equal(parseReleaseTag('v3.1.0-rc.1').major, 3);
  assert.throws(() => parseReleaseTag('main'), /not a semantic v\* tag/);
});

test('v1 release gate preserves the existing prerelease trust policy', async () => {
  const result = await runProductionReleaseGate({ tag: 'v1.0.49', env: {}, cwd: '/does-not-exist' });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /v1 release/);
});

test('v2 release trust requires notarized macOS and signed Windows plans', () => {
  assert.deepEqual(validateProductionTrust(TRUSTED_ENV), {
    macOS: 'signed and notarized',
    windows: 'signed',
  });
  assert.throws(() => validateProductionTrust({}), /requires signed and notarized macOS artifacts/);
  assert.throws(
    () => validateProductionTrust({ ...TRUSTED_ENV, WIN_CSC_KEY_PASSWORD: '' }),
    /Incomplete Windows signing configuration/,
  );
});

test('v2 release evidence independently verifies the full non-demo parity packet', () => {
  const result = validateV2ReleaseEvidence(completeV2Evidence());
  assert.equal(result.mint, 'Mint111111111111111111111111111111111111');
  assert.equal(result.poolCount, 1);
  assert.equal(result.positionCount, 1);
  assert.match(result.fingerprint, /^\{/);
  assert.match(result.classicArtifactSha256, /^[a-f0-9]{64}$/);

  const serverShapedProof = clone(completeV2Evidence());
  delete serverShapedProof.proof.liquidity.positionCount;
  assert.equal(validateV2ReleaseEvidence(serverShapedProof).positionCount, 1);

  const demo = clone(completeV2Evidence());
  demo.proof.demo = true;
  assert.throws(() => validateV2ReleaseEvidence(demo), /marked as a demo proof/);

  const tamperedTransaction = clone(completeV2Evidence());
  tamperedTransaction.proof.liquidity.results[0].mainPositions[0].txIds.open = 'TamperedOpenTx';
  assert.throws(() => validateV2ReleaseEvidence(tamperedTransaction), /independently derived proof evidence/);

  const staleComparison = clone(completeV2Evidence());
  staleComparison.classicReportComparison.result.proofFingerprint = 'stale-proof';
  assert.throws(() => validateV2ReleaseEvidence(staleComparison), /Classic comparison fingerprint/);

  const thinComparison = clone(completeV2Evidence());
  thinComparison.classicReportComparison.result.rows = thinComparison.classicReportComparison.result.rows.slice(0, 2);
  thinComparison.classicReportComparison.result.passCount = 2;
  thinComparison.classicReportComparison.result.fieldCount = 2;
  assert.throws(() => validateV2ReleaseEvidence(thinComparison), /missing required rows/);

  const rawArtifactMissingTx = clone(completeV2Evidence());
  rawArtifactMissingTx.classicReportComparison.input = rawArtifactMissingTx.classicReportComparison.input.replace('OpenPositionTx111', 'MissingTx');
  assert.throws(() => validateV2ReleaseEvidence(rawArtifactMissingTx), /raw Classic artifact is missing/);

  const wrongSweepHash = clone(completeV2Evidence());
  wrongSweepHash.proof.localDossier.sweepEvidenceHash = 'forged-sweep-hash';
  assert.throws(() => validateV2ReleaseEvidence(wrongSweepHash), /does not match the transfer record/);
});

test('v2 release attestation binds hashes, ancestry, freshness, and two-person review', async () => {
  const evidence = completeV2Evidence();
  const bytes = evidenceBytes(evidence);
  const attestation = completeAttestation(bytes, evidence);
  const options = {
    releaseTag: 'v2.0.0',
    releaseCommit: RELEASE_COMMIT,
    evidenceSha256: digest(bytes),
    classicArtifactSha256: digest(Buffer.from(evidence.classicReportComparison.input.trim(), 'utf8')),
    exportedAt: evidence.exportedAt,
    now: NOW,
    isAncestor: ancestorCheck,
  };
  const result = await validateV2ReleaseAttestation(attestation, options);
  assert.equal(result.reviewedBy, 'release-reviewer');

  const wrongHash = { ...attestation, evidenceSha256: 'c'.repeat(64) };
  await assert.rejects(() => validateV2ReleaseAttestation(wrongHash, options), /does not match the field evidence bytes/);

  const samePerson = { ...attestation, reviewedBy: attestation.operatedBy };
  await assert.rejects(() => validateV2ReleaseAttestation(samePerson, options), /must be different people/);

  await assert.rejects(
    () => validateV2ReleaseAttestation(attestation, { ...options, isAncestor: async () => false }),
    /not an ancestor/,
  );

  await assert.rejects(
    () => validateV2ReleaseAttestation(attestation, { ...options, now: NOW + (31 * 24 * 60 * 60 * 1000) }),
    /older than 30 days/,
  );
});

test('v2 release gate refuses to build without archived field evidence', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trebuchet-release-gate-'));
  try {
    await assert.rejects(
      () => runProductionReleaseGate({ tag: 'v2.0.0', env: TRUSTED_ENV, cwd }),
      /field evidence is missing/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('v2 release gate refuses evidence without a reviewed attestation', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trebuchet-release-gate-'));
  try {
    const evidenceFile = path.join(cwd, DEFAULT_V2_RELEASE_EVIDENCE);
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, evidenceBytes(completeV2Evidence()));
    await assert.rejects(
      () => runProductionReleaseGate({
        tag: 'v2.0.0',
        env: TRUSTED_ENV,
        cwd,
        releaseCommit: RELEASE_COMMIT,
        now: NOW,
        isAncestor: ancestorCheck,
      }),
      /release attestation is missing/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('v2 release gate validates evidence, attestation, ancestry, and trust together', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trebuchet-release-gate-'));
  try {
    const evidence = completeV2Evidence();
    const bytes = evidenceBytes(evidence);
    const evidenceFile = path.join(cwd, DEFAULT_V2_RELEASE_EVIDENCE);
    const attestationFile = path.join(cwd, DEFAULT_V2_RELEASE_ATTESTATION);
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, bytes);
    await writeFile(attestationFile, `${JSON.stringify(completeAttestation(bytes, evidence), null, 2)}\n`);
    const result = await runProductionReleaseGate({
      tag: 'v2.0.0',
      env: TRUSTED_ENV,
      cwd,
      releaseCommit: RELEASE_COMMIT,
      now: NOW,
      isAncestor: ancestorCheck,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.evidencePath, DEFAULT_V2_RELEASE_EVIDENCE);
    assert.equal(result.attestationPath, DEFAULT_V2_RELEASE_ATTESTATION);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.attestation.reviewedBy, 'release-reviewer');
    assert.equal(result.trust.macOS, 'signed and notarized');
    assert.equal(result.trust.windows, 'signed');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
