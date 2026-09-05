import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { resolveReleaseBuild } from './release-lib.mjs';
import {
  classicArtifactRequiredValues,
  requiredClassicComparisonRowIds,
  v2LaunchProofFingerprint,
  v2TransferEvidenceHash,
} from './v2-proof-integrity.mjs';

export const DEFAULT_V2_RELEASE_EVIDENCE = 'release-evidence/v2/field-verification.json';
export const DEFAULT_V2_RELEASE_ATTESTATION = 'release-evidence/v2/release-attestation.json';

const execFileAsync = promisify(execFile);
const MAX_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const FIELD_REQUIREMENT_IDS = [
  'live-proof',
  'report-proof',
  'classic-comparison',
  'audit',
  'replacement-criteria',
];

const REPLACEMENT_CRITERION_IDS = [
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

const PARITY_AUDIT_IDS = [
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

const TOKEN_AUTHORITY_FIELDS = [
  'mintAuthorityRenounced',
  'freezeAuthorityDisabled',
  'metadataUpdateAuthorityRevoked',
  'metadataImmutable',
];

function fail(message) {
  throw new Error(`Production release gate: ${message}`);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function object(value, label) {
  expect(value && typeof value === 'object' && !Array.isArray(value), `${label} is missing or invalid`);
  return value;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function validTimestamp(value) {
  return nonEmpty(value) && Number.isFinite(Date.parse(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function exactCommit(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function githubHandle(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
}

function exactPassingRows(rows, expectedIds, label, { requireAction = false } = {}) {
  expect(Array.isArray(rows), `${label} rows are missing`);
  expect(rows.length === expectedIds.length, `${label} must contain ${expectedIds.length} rows`);
  rows.forEach((row, index) => {
    const expectedId = expectedIds[index];
    object(row, `${label} row ${expectedId}`);
    expect(row.id === expectedId, `${label} row ${index + 1} must be ${expectedId}`);
    expect(row.pass === true, `${label} row ${expectedId} is not passing`);
    if (requireAction) {
      expect(row.action === 'none', `${label} row ${expectedId} still has an operator action`);
    }
  });
}

function positionRows(pool) {
  return [
    ...(Array.isArray(pool.mainPositions) ? pool.mainPositions : []),
    ...(Array.isArray(pool.ladderPositions) ? pool.ladderPositions : []),
    ...(Array.isArray(pool.supportPositions) ? pool.supportPositions : []),
    ...(pool.bootstrap && typeof pool.bootstrap === 'object' ? [pool.bootstrap] : []),
  ];
}

function validateConcreteLiveProof(proof, fingerprint) {
  expect(proof.demo !== true, 'field evidence is marked as a demo proof');
  expect(proof.source !== 'demo-run', 'field evidence came from the demo runner');
  expect(proof.stage !== 'demo_completed', 'field evidence has a demo terminal stage');
  expect(proof.status === 'completed', 'live proof status must be completed');
  expect(proof.stage === 'transfer_completed', 'live proof must reach transfer_completed');
  expect(nonEmpty(proof.journalId), 'live proof is missing its launch journal id');
  expect(nonEmpty(proof.walletPublicKey), 'live proof is missing its launch wallet');

  const token = object(proof.token, 'live token proof');
  expect(nonEmpty(token.mint), 'live proof is missing the token mint');
  TOKEN_AUTHORITY_FIELDS.forEach((field) => {
    expect(token[field] === true, `live token proof has not confirmed ${field}`);
  });

  const liquidity = object(proof.liquidity, 'live liquidity proof');
  const pools = Array.isArray(liquidity.results) ? liquidity.results : [];
  expect(pools.length > 0, 'live proof has no liquidity pool records');
  expect(Number(liquidity.poolCount) === pools.length, 'liquidity pool count does not match its records');
  const allPositions = [];
  pools.forEach((pool, poolIndex) => {
    object(pool, `liquidity pool ${poolIndex + 1}`);
    expect(nonEmpty(pool.poolId || pool.id), `liquidity pool ${poolIndex + 1} is missing its pool id`);
    expect(
      nonEmpty(pool.txIds?.createPool || pool.createPoolTx),
      `liquidity pool ${poolIndex + 1} is missing its create transaction`,
    );
    const positions = positionRows(pool);
    expect(positions.length > 0, `liquidity pool ${poolIndex + 1} has no position records`);
    positions.forEach((position, positionIndex) => {
      object(position, `liquidity pool ${poolIndex + 1} position ${positionIndex + 1}`);
      expect(
        nonEmpty(position.positionNftMint || position.nftMint || position.positionMint),
        `liquidity pool ${poolIndex + 1} position ${positionIndex + 1} is missing its position NFT`,
      );
      expect(
        nonEmpty(position.txIds?.open || position.openTx),
        `liquidity pool ${poolIndex + 1} position ${positionIndex + 1} is missing its open transaction`,
      );
      expect(position.locked === true, `liquidity pool ${poolIndex + 1} position ${positionIndex + 1} is not locked`);
      expect(
        nonEmpty(position.txIds?.lock || position.lockTx),
        `liquidity pool ${poolIndex + 1} position ${positionIndex + 1} is missing its lock transaction`,
      );
      expect(
        nonEmpty(position.feeKeyNftMint || position.feeKeyMint),
        `liquidity pool ${poolIndex + 1} position ${positionIndex + 1} is missing its Fee Key NFT`,
      );
      if (nonEmpty(position.recipient)) {
        expect(
          position.transferredTo === position.recipient,
          `liquidity pool ${poolIndex + 1} position ${positionIndex + 1} did not reach its Fee Key recipient`,
        );
        expect(
          nonEmpty(position.txIds?.transfer || position.transferTx),
          `liquidity pool ${poolIndex + 1} position ${positionIndex + 1} is missing its Fee Key transfer transaction`,
        );
      }
    });
    allPositions.push(...positions);
  });
  if (liquidity.positionCount != null) {
    expect(Number(liquidity.positionCount) === allPositions.length, 'liquidity position count does not match its records');
  }
  if (liquidity.lockedPositionCount != null) {
    expect(Number(liquidity.lockedPositionCount) === allPositions.length, 'not every liquidity position is recorded as locked');
  }
  if (liquidity.feeKeyCount != null) {
    expect(Number(liquidity.feeKeyCount) === allPositions.length, 'not every locked position has a Fee Key record');
  }

  const transfer = object(proof.transfer, 'terminal sweep proof');
  expect(transfer.walletEmpty === true, 'terminal sweep does not confirm the launch wallet is empty');
  expect(nonEmpty(transfer.destinationWallet), 'terminal sweep is missing its destination wallet');
  expect(transfer.status !== 'planned-before-sweep', 'terminal sweep is only a plan');
  expect(!Array.isArray(transfer.tokenTransferErrors) || transfer.tokenTransferErrors.length === 0, 'terminal token sweep contains errors');
  expect(!Array.isArray(transfer.tokenSweep?.errors) || transfer.tokenSweep.errors.length === 0, 'terminal token sweep contains errors');
  expect(!Array.isArray(transfer.nftTransferErrors) || transfer.nftTransferErrors.length === 0, 'terminal NFT sweep contains errors');
  expect(!Array.isArray(transfer.nftSweep?.errors) || transfer.nftSweep.errors.length === 0, 'terminal NFT sweep contains errors');
  expect(!transfer.solSweepError, 'terminal SOL sweep contains an error');

  const dossier = object(proof.localDossier, 'proof-bound local artifact');
  expect(dossier.status === 'downloaded', 'proof-bound local artifact is not recorded as downloaded');
  expect(dossier.kind === 'local-proof-json', 'release evidence must be the JSON file from Download proof');
  expect(nonEmpty(dossier.filename) && dossier.filename.toLowerCase().endsWith('.json'), 'local proof filename is invalid');
  expect(validTimestamp(dossier.downloadedAt), 'local proof download timestamp is invalid');
  expect(Number.isInteger(Number(dossier.dataVersion)) && Number(dossier.dataVersion) > 0, 'local proof data version is invalid');
  expect(dossier.proofFingerprint === fingerprint, 'local proof fingerprint does not match the field packet');
  expect(dossier.mint === token.mint, 'local proof mint does not match the live token');
  const dossierSweepHash = dossier.sweepEvidenceHash
    || dossier.transferEvidenceHash
    || dossier.finalSweep?.transferEvidenceHash;
  const expectedSweepHash = v2TransferEvidenceHash(transfer);
  expect(nonEmpty(expectedSweepHash), 'terminal sweep evidence hash could not be derived');
  expect(dossierSweepHash === expectedSweepHash, 'local proof terminal sweep hash does not match the transfer record');

  const airdrop = proof.airdrop && typeof proof.airdrop === 'object' ? proof.airdrop : {};
  const plannedAirdrop = Math.max(0, Number(airdrop.plannedRecipientCount || 0));
  if (plannedAirdrop > 0) {
    const recipients = Array.isArray(airdrop.recipients) ? airdrop.recipients : [];
    const transferred = Array.isArray(airdrop.transferred) ? airdrop.transferred : [];
    expect(recipients.length >= plannedAirdrop, 'airdrop proof is missing full recipient rows');
    expect(transferred.length >= plannedAirdrop, 'airdrop proof is missing delivered rows');
    expect(transferred.every((row) => nonEmpty(row?.wallet) && nonEmpty(row?.txId)), 'airdrop proof is missing wallet or transaction evidence');
    expect(Number(airdrop.failedCount || 0) === 0, 'airdrop proof contains failed recipients');
  }

  return { mint: token.mint, poolCount: pools.length, positionCount: allPositions.length };
}

function validateParityAudit(audit, fingerprint) {
  object(audit, 'report parity audit');
  expect(audit.source === 'trebuchet-v2-report-parity-audit', 'report parity audit has the wrong source');
  expect(Number(audit.version) >= 1, 'report parity audit has an unsupported version');
  expect(audit.proofFingerprint === fingerprint, 'report parity audit fingerprint does not match the field packet');
  expect(audit.status === 'pass', 'report parity audit is not passing');
  expect(Number(audit.score) === 100, 'report parity audit score is not 100');
  expect(Number(audit.passCount) === PARITY_AUDIT_IDS.length, 'report parity audit pass count is incomplete');
  expect(Number(audit.itemCount) === PARITY_AUDIT_IDS.length, 'report parity audit item count is incomplete');
  expect(Number(audit.warnCount) === 0, 'report parity audit contains warnings');
  expect(Number(audit.missingCount) === 0, 'report parity audit contains missing checks');
  expect(Array.isArray(audit.items) && audit.items.length === PARITY_AUDIT_IDS.length, 'report parity audit rows are incomplete');
  audit.items.forEach((row, index) => {
    const expectedId = PARITY_AUDIT_IDS[index];
    object(row, `report parity audit row ${expectedId}`);
    expect(row.id === expectedId, `report parity audit row ${index + 1} must be ${expectedId}`);
    expect(row.state === 'pass', `report parity audit row ${expectedId} is not passing`);
  });
}

function validateRetirementGate(gate, fingerprint) {
  object(gate, 'Classic retirement gate');
  expect(gate.source === 'trebuchet-v2-classic-retirement-gate', 'Classic retirement gate has the wrong source');
  expect(gate.proofFingerprint === fingerprint, 'Classic retirement gate fingerprint does not match the field packet');
  expect(gate.auditFingerprint === fingerprint, 'Classic retirement gate is not bound to the report audit');
  expect(gate.state === 'pass', 'Classic retirement gate is not passing');
  expect(gate.badge === 'Ready', 'Classic retirement gate is not marked ready');
  expect(Number(gate.passCount) === FIELD_REQUIREMENT_IDS.length, 'Classic retirement requirement count is incomplete');
  expect(Number(gate.itemCount) === FIELD_REQUIREMENT_IDS.length, 'Classic retirement item count is incomplete');
  expect(Number(gate.criteriaPassCount) === REPLACEMENT_CRITERION_IDS.length, 'Classic replacement criteria are incomplete');
  expect(Number(gate.criteriaItemCount) === REPLACEMENT_CRITERION_IDS.length, 'Classic replacement criteria count is incomplete');
  exactPassingRows(gate.requirements, FIELD_REQUIREMENT_IDS, 'Classic retirement requirement');
  exactPassingRows(gate.replacementCriteria, REPLACEMENT_CRITERION_IDS, 'Classic replacement criterion');
}

function validateFieldPacket(packet) {
  object(packet, 'field verification packet');
  expect(packet.source === 'trebuchet-v2-field-verification', 'field verification packet has the wrong source');
  expect(Number(packet.version) >= 1, 'field verification packet has an unsupported version');
  expect(validTimestamp(packet.generatedAt), 'field verification packet timestamp is invalid');
  expect(nonEmpty(packet.proofFingerprint), 'field verification packet is missing its proof fingerprint');
  expect(packet.state === 'pass', 'field verification packet is not passing');
  expect(packet.ready === true, 'field verification packet is not ready');
  expect(packet.nextAction === 'none', 'field verification packet still has an operator action');
  expect(Number(packet.passCount) === FIELD_REQUIREMENT_IDS.length, 'field verification requirement count is incomplete');
  expect(Number(packet.itemCount) === FIELD_REQUIREMENT_IDS.length, 'field verification item count is incomplete');
  expect(Number(packet.criteriaPassCount) === REPLACEMENT_CRITERION_IDS.length, 'field verification criteria are incomplete');
  expect(Number(packet.criteriaItemCount) === REPLACEMENT_CRITERION_IDS.length, 'field verification criteria count is incomplete');
  expect(Number(packet.blockerCount) === 0, 'field verification packet contains blockers');
  expect(Number(packet.criteriaBlockerCount) === 0, 'field verification packet contains replacement blockers');
  expect(Array.isArray(packet.blockers) && packet.blockers.length === 0, 'field verification blocker rows are not empty');
  expect(Array.isArray(packet.criteriaBlockers) && packet.criteriaBlockers.length === 0, 'field verification criterion blocker rows are not empty');
  exactPassingRows(packet.requirements, FIELD_REQUIREMENT_IDS, 'field verification requirement', { requireAction: true });
  exactPassingRows(packet.replacementCriteria, REPLACEMENT_CRITERION_IDS, 'field verification criterion', { requireAction: true });
  return packet.proofFingerprint;
}

function validateClassicComparison(wrapper, fingerprint, proof) {
  const comparisonWrapper = object(wrapper, 'Classic comparison export');
  const rawArtifact = String(comparisonWrapper.input || '').trim();
  expect(rawArtifact.length >= 256, 'Classic comparison must retain the full raw Classic artifact');
  const result = object(comparisonWrapper.result, 'Classic comparison result');
  expect(result.status === 'pass', 'Classic comparison is not passing');
  expect(
    ['classic', 'classic-or-external'].includes(result.artifactSource),
    'comparison did not use a Classic artifact',
  );
  expect(result.structuredEvidence === true, 'Classic comparison lacks structured evidence');
  expect(result.proofFingerprint === fingerprint, 'Classic comparison fingerprint does not match the field packet');
  expect(Number(result.warnCount) === 0, 'Classic comparison contains warnings');
  expect(Number(result.missingCount) === 0, 'Classic comparison contains missing rows');
  expect(Number(result.mismatchCount) === 0, 'Classic comparison contains mismatches');
  expect(Number(result.fieldCount) > 0, 'Classic comparison contains no fields');
  expect(Number(result.passCount) === Number(result.fieldCount), 'Classic comparison does not pass every field');
  expect(Array.isArray(result.rows) && result.rows.length > 0, 'Classic comparison contains no evidence rows');
  expect(result.rows.every((row) => row?.state === 'pass' && nonEmpty(row?.id)), 'Classic comparison contains a non-passing evidence row');
  expect(Number(result.fieldCount) === result.rows.length, 'Classic comparison field count does not match its evidence rows');
  const rowIds = result.rows.map((row) => row.id);
  expect(new Set(rowIds).size === rowIds.length, 'Classic comparison contains duplicate evidence rows');
  const requiredRows = requiredClassicComparisonRowIds(proof);
  const missingRows = requiredRows.filter((id) => !rowIds.includes(id));
  expect(missingRows.length === 0, `Classic comparison is missing required rows: ${missingRows.join(', ')}`);
  expect(result.classicMint === proof.token.mint, 'Classic comparison mint does not match the live proof');
  const expectedPoolCount = new Set((proof.liquidity.results || []).map((pool) => pool.poolId || pool.id).filter(Boolean)).size;
  expect(Number(result.classicPoolCount) === expectedPoolCount, 'Classic comparison pool count does not match the live proof');
  const missingValues = classicArtifactRequiredValues(proof).filter((value) => !rawArtifact.includes(value));
  expect(missingValues.length === 0, `raw Classic artifact is missing ${missingValues.length} proof value(s)`);
  return { classicArtifactSha256: sha256(Buffer.from(rawArtifact, 'utf8')) };
}

export function parseReleaseTag(tag) {
  const value = String(tag || '').trim();
  const match = value.match(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) fail(`release ref ${value || '(empty)'} is not a semantic v* tag`);
  return {
    tag: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    requiresProductionGate: Number(match[1]) >= 2,
  };
}

export function validateProductionTrust(env = process.env) {
  const mac = resolveReleaseBuild('macos-arm64', env);
  const windows = resolveReleaseBuild('windows', env);
  expect(mac.trust === 'signed and notarized', 'v2+ requires signed and notarized macOS artifacts');
  expect(windows.trust === 'signed', 'v2+ requires signed Windows artifacts');
  return { macOS: mac.trust, windows: windows.trust };
}

export function validateV2ReleaseEvidence(payload) {
  object(payload, 'v2 release evidence');
  expect(payload.schema === 'trebuchet-v2-proof', 'release evidence is not a Trebuchet v2 proof export');
  expect(payload.source === 'trebuchet-v2', 'release evidence has the wrong source');
  expect(Number.isInteger(Number(payload.dataVersion)) && Number(payload.dataVersion) > 0, 'release evidence data version is invalid');
  expect(validTimestamp(payload.exportedAt), 'release evidence export timestamp is invalid');
  expect(!payload.compactForHtml, 'release evidence must be the full JSON proof, not compact HTML evidence');

  const proof = object(payload.proof, 'exported live proof');
  const launchConfig = object(payload.launchConfig, 'exported launch config');
  const launchData = object(payload.launchData, 'exported launch report data');
  expect(launchConfig.schema === 'trebuchet-v2-launch-config', 'launch config is missing its v2 schema');
  expect(launchConfig.source === 'trebuchet-v2', 'launch config has the wrong source');
  expect(isDeepStrictEqual(proof.launchConfig, launchConfig), 'proof launch config does not match the export envelope');
  expect(isDeepStrictEqual(launchData.launchConfig, launchConfig), 'report launch config does not match the export envelope');

  const fingerprint = validateFieldPacket(payload.fieldVerification);
  const independentlyDerivedFingerprint = v2LaunchProofFingerprint(proof);
  expect(
    fingerprint === independentlyDerivedFingerprint,
    'field verification fingerprint does not match independently derived proof evidence',
  );
  validateParityAudit(payload.reportParityAudit, fingerprint);
  validateRetirementGate(payload.classicRetirementGate, fingerprint);
  const classic = validateClassicComparison(payload.classicReportComparison, fingerprint, proof);

  for (const key of ['reportParityAudit', 'classicRetirementGate', 'fieldVerification']) {
    expect(isDeepStrictEqual(launchData[key], payload[key]), `${key} differs between the export envelope and launch report data`);
  }

  const live = validateConcreteLiveProof(proof, fingerprint);
  expect(launchData.source === 'trebuchet-v2', 'launch report data has the wrong source');
  expect(launchData.mint === live.mint, 'launch report mint does not match the live proof');
  expect(launchData.launchWallet === proof.walletPublicKey, 'launch report wallet does not match the live proof');

  return {
    fingerprint,
    mint: live.mint,
    exportedAt: payload.exportedAt,
    poolCount: live.poolCount,
    positionCount: live.positionCount,
    classicArtifactSha256: classic.classicArtifactSha256,
  };
}

async function gitHead(cwd) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd });
  return stdout.trim().toLowerCase();
}

async function gitAncestor(ancestor, descendant, cwd) {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd });
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
}

export async function validateV2ReleaseAttestation(attestation, {
  releaseTag,
  releaseCommit,
  evidenceSha256,
  classicArtifactSha256,
  exportedAt,
  cwd = process.cwd(),
  now = Date.now(),
  isAncestor = gitAncestor,
} = {}) {
  object(attestation, 'v2 release attestation');
  expect(attestation.schema === 'trebuchet-v2-production-attestation', 'release attestation has the wrong schema');
  expect(Number(attestation.version) === 1, 'release attestation has an unsupported version');
  expect(attestation.cluster === 'mainnet-beta', 'release attestation must name mainnet-beta');
  expect(attestation.releaseTag === releaseTag, 'release attestation tag does not match the release');
  expect(attestation.decision === 'approved-for-v2-production', 'release attestation is not approved for production');
  expect(exactSha256(attestation.evidenceSha256), 'release attestation evidence digest is invalid');
  expect(attestation.evidenceSha256 === evidenceSha256, 'release attestation does not match the field evidence bytes');
  expect(exactSha256(attestation.classicArtifactSha256), 'release attestation Classic artifact digest is invalid');
  expect(attestation.classicArtifactSha256 === classicArtifactSha256, 'release attestation does not match the raw Classic artifact');
  expect(exactCommit(attestation.fieldRunCommit), 'release attestation field-run commit is invalid');
  expect(exactCommit(releaseCommit), 'release commit is unavailable or invalid');
  expect(
    await isAncestor(attestation.fieldRunCommit, releaseCommit, cwd),
    'field-run commit is not an ancestor of the release commit',
  );
  expect(githubHandle(attestation.operatedBy), 'release attestation operator is invalid');
  expect(githubHandle(attestation.reviewedBy), 'release attestation reviewer is invalid');
  expect(
    attestation.operatedBy.toLowerCase() !== attestation.reviewedBy.toLowerCase(),
    'field operator and release reviewer must be different people',
  );
  expect(validTimestamp(attestation.fieldRunCompletedAt), 'field-run completion timestamp is invalid');
  expect(validTimestamp(attestation.reviewedAt), 'release review timestamp is invalid');
  expect(validTimestamp(exportedAt), 'field evidence export timestamp is invalid');
  const fieldRunAt = Date.parse(attestation.fieldRunCompletedAt);
  const exportedAtMs = Date.parse(exportedAt);
  const reviewedAt = Date.parse(attestation.reviewedAt);
  expect(fieldRunAt <= exportedAtMs + CLOCK_SKEW_MS, 'field evidence predates the attested field run');
  expect(reviewedAt >= exportedAtMs, 'release review predates the field evidence export');
  expect(exportedAtMs <= now + CLOCK_SKEW_MS, 'field evidence export timestamp is in the future');
  expect(reviewedAt <= now + CLOCK_SKEW_MS, 'release review timestamp is in the future');
  expect(now - exportedAtMs <= MAX_EVIDENCE_AGE_MS, 'field evidence is older than 30 days');
  return {
    operatedBy: attestation.operatedBy,
    reviewedBy: attestation.reviewedBy,
    fieldRunCommit: attestation.fieldRunCommit,
    reviewedAt: attestation.reviewedAt,
  };
}

export async function runProductionReleaseGate({
  tag = process.env.GITHUB_REF_NAME,
  env = process.env,
  cwd = process.cwd(),
  evidencePath = DEFAULT_V2_RELEASE_EVIDENCE,
  attestationPath = DEFAULT_V2_RELEASE_ATTESTATION,
  releaseCommit = process.env.GITHUB_SHA,
  now = Date.now(),
  isAncestor = gitAncestor,
} = {}) {
  const release = parseReleaseTag(tag);
  if (!release.requiresProductionGate) {
    return { release, skipped: true, reason: 'v1 release keeps the existing prerelease trust policy' };
  }

  const trust = validateProductionTrust(env);
  const absoluteEvidencePath = path.resolve(cwd, evidencePath);
  let bytes;
  try {
    bytes = await readFile(absoluteEvidencePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`v2 field evidence is missing at ${evidencePath}`);
    }
    throw error;
  }

  let payload;
  try {
    payload = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail(`v2 field evidence at ${evidencePath} is not valid JSON`);
  }
  const evidence = validateV2ReleaseEvidence(payload);
  const evidenceSha256 = sha256(bytes);
  const absoluteAttestationPath = path.resolve(cwd, attestationPath);
  let attestationBytes;
  try {
    attestationBytes = await readFile(absoluteAttestationPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(`v2 release attestation is missing at ${attestationPath}`);
    }
    throw error;
  }
  let attestationPayload;
  try {
    attestationPayload = JSON.parse(attestationBytes.toString('utf8'));
  } catch {
    fail(`v2 release attestation at ${attestationPath} is not valid JSON`);
  }
  const effectiveReleaseCommit = String(releaseCommit || '').trim().toLowerCase() || await gitHead(cwd);
  const attestation = await validateV2ReleaseAttestation(attestationPayload, {
    releaseTag: release.tag,
    releaseCommit: effectiveReleaseCommit,
    evidenceSha256,
    classicArtifactSha256: evidence.classicArtifactSha256,
    exportedAt: evidence.exportedAt,
    cwd,
    now,
    isAncestor,
  });
  return {
    release,
    skipped: false,
    trust,
    evidence,
    attestation,
    evidencePath,
    attestationPath,
    sha256: evidenceSha256,
  };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const tag = process.argv[2] || process.env.GITHUB_REF_NAME;
  const evidencePath = process.argv[3] || DEFAULT_V2_RELEASE_EVIDENCE;
  const attestationPath = process.argv[4] || DEFAULT_V2_RELEASE_ATTESTATION;
  try {
    const result = await runProductionReleaseGate({ tag, evidencePath, attestationPath });
    if (result.skipped) {
      console.log(`Production release gate skipped for ${result.release.tag}: ${result.reason}.`);
    } else {
      console.log(`Production release gate passed for ${result.release.tag}.`);
      console.log(`Evidence: ${result.evidencePath} (sha256 ${result.sha256})`);
      console.log(`Attestation: ${result.attestationPath} (${result.attestation.reviewedBy})`);
      console.log(`Field proof: ${result.evidence.fingerprint}`);
      console.log(`Trust: macOS ${result.trust.macOS}; Windows ${result.trust.windows}.`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
