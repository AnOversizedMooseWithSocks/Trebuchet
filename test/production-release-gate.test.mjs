import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_V2_RELEASE_EVIDENCE,
  parseReleaseTag,
  runProductionReleaseGate,
  validateProductionTrust,
  validateV2ReleaseEvidence,
} from '../scripts/production-release-gate.mjs';

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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
  const fingerprint = 'live-proof-fingerprint-111';
  const exportedAt = '2026-07-16T12:00:00.000Z';
  const launchConfig = {
    schema: 'trebuchet-v2-launch-config',
    source: 'trebuchet-v2',
    token: { name: 'Production', symbol: 'PROD', supply: '1000000', decimals: 9 },
    poolTopology: {
      sweepDestination: 'Destination111111111111111111111111111111',
      pools: [{ id: 'pool-plan-1', quoteToken: 'SOL', supplyPercent: 100 }],
    },
  };
  const proof = {
    source: 'live-run',
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
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'Pool111111111111111111111111111111111111',
        txIds: { createPool: 'CreatePoolTx111' },
        mainPositions: [{
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
      recipients: [{ wallet: 'AirdropWallet11111111111111111111111111', amount: '100' }],
      transferred: [{ wallet: 'AirdropWallet11111111111111111111111111', amount: '100', txId: 'AirdropTx111' }],
      failed: [],
    },
    transfer: {
      status: 'completed',
      destinationWallet: launchConfig.poolTopology.sweepDestination,
      walletEmpty: true,
      tokenTransferErrors: [],
      nftTransferErrors: [],
    },
    localDossier: {
      status: 'downloaded',
      kind: 'local-proof-json',
      filename: 'trebuchet-prod-proof.json',
      downloadedAt: exportedAt,
      dataVersion: 13,
      proofFingerprint: fingerprint,
      mint: 'Mint111111111111111111111111111111111111',
      sweepEvidenceHash: 'terminal-sweep-hash-111',
    },
    launchConfig,
  };
  const reportParityAudit = {
    version: 1,
    source: 'trebuchet-v2-report-parity-audit',
    generatedAt: exportedAt,
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
    generatedAt: exportedAt,
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
  const classicReportComparison = {
    input: '{"source":"classic"}',
    comparedAt: exportedAt,
    error: null,
    result: {
      status: 'pass',
      comparedAt: exportedAt,
      artifactKind: 'json',
      artifactSource: 'classic-or-external',
      structuredEvidence: true,
      proofFingerprint: fingerprint,
      passCount: 2,
      warnCount: 0,
      missingCount: 0,
      mismatchCount: 0,
      fieldCount: 2,
      classicMint: proof.token.mint,
      classicPoolCount: 1,
      rows: [
        { id: 'mint', label: 'Token mint', state: 'pass', detail: 'Exact match.' },
        { id: 'poolIds', label: 'Pool IDs', state: 'pass', detail: 'Exact match.' },
      ],
    },
  };
  const launchData = {
    dataVersion: 13,
    source: 'trebuchet-v2',
    generatedAt: exportedAt,
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
    exportedAt,
    proof,
    launchConfig,
    launchData,
    reportParityAudit,
    classicRetirementGate,
    fieldVerification,
    classicReportComparison,
  };
}

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

test('v2 release evidence requires the complete non-demo parity packet', () => {
  const result = validateV2ReleaseEvidence(completeV2Evidence());
  assert.equal(result.mint, 'Mint111111111111111111111111111111111111');
  assert.equal(result.poolCount, 1);
  assert.equal(result.positionCount, 1);

  const serverShapedProof = clone(completeV2Evidence());
  delete serverShapedProof.proof.liquidity.positionCount;
  assert.equal(validateV2ReleaseEvidence(serverShapedProof).positionCount, 1);

  const demo = clone(completeV2Evidence());
  demo.proof.demo = true;
  assert.throws(() => validateV2ReleaseEvidence(demo), /marked as a demo proof/);

  const staleComparison = clone(completeV2Evidence());
  staleComparison.classicReportComparison.result.proofFingerprint = 'stale-proof';
  assert.throws(() => validateV2ReleaseEvidence(staleComparison), /Classic comparison fingerprint/);

  const missingSweepHash = clone(completeV2Evidence());
  delete missingSweepHash.proof.localDossier.sweepEvidenceHash;
  assert.throws(() => validateV2ReleaseEvidence(missingSweepHash), /terminal sweep hash/);
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

test('v2 release gate validates the archived artifact and returns its digest', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'trebuchet-release-gate-'));
  try {
    const evidenceFile = path.join(cwd, DEFAULT_V2_RELEASE_EVIDENCE);
    await mkdir(path.dirname(evidenceFile), { recursive: true });
    await writeFile(evidenceFile, `${JSON.stringify(completeV2Evidence(), null, 2)}\n`);
    const result = await runProductionReleaseGate({ tag: 'v2.0.0', env: TRUSTED_ENV, cwd });
    assert.equal(result.skipped, false);
    assert.equal(result.evidencePath, DEFAULT_V2_RELEASE_EVIDENCE);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.trust.macOS, 'signed and notarized');
    assert.equal(result.trust.windows, 'signed');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
