import {
  v2LaunchProofFingerprint,
  v2TransferEvidenceHash,
} from './proof-integrity.js';
import { TREBUCHET_PROOF_VERIFICATION_SCHEMA } from './contracts.js';

const COMPATIBLE_PROOF_MARKERS = new Set([
  'trebuchet-v2',
  'trebuchet-v2-proof',
  'trebuchet-v2-field-verification',
]);

const REQUIRED_AUTHORITY_FIELDS = [
  'mintAuthorityRenounced',
  'freezeAuthorityDisabled',
  'metadataUpdateAuthorityRevoked',
  'metadataImmutable',
];

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function proofPositions(results = []) {
  return (Array.isArray(results) ? results : []).flatMap((pool) => {
    if (Array.isArray(pool?.positions) && pool.positions.length) return pool.positions;
    return [
      ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
      ...(pool?.bootstrap && typeof pool.bootstrap === 'object' ? [pool.bootstrap] : []),
    ];
  });
}

function terminalTransferComplete(transfer) {
  const tokenErrors = Array.isArray(transfer?.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer?.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer?.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer?.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  return Boolean(
    transfer
      && typeof transfer === 'object'
      && nonEmpty(transfer.destinationWallet)
      && transfer.walletEmpty === true
      && transfer.status !== 'planned-before-sweep'
      && tokenErrors.length === 0
      && nftErrors.length === 0
      && !transfer.solSweepError
  );
}

function proofCompletenessIssues(proof = {}) {
  const issues = [];
  if (proof.status !== 'completed') issues.push('status is not completed');
  if (!nonEmpty(proof.journalId)) issues.push('launch journal id is missing');
  if (!nonEmpty(proof.walletPublicKey)) issues.push('launch wallet is missing');
  if (!nonEmpty(proof?.token?.mint)) issues.push('token mint is missing');
  REQUIRED_AUTHORITY_FIELDS.forEach((field) => {
    if (proof?.token?.[field] !== true) issues.push(`${field} is not confirmed`);
  });
  if (proof?.token?.mintFormat === 'token-2022'
      && proof?.token?.metadataPointerAuthorityRevoked !== true) {
    issues.push('metadataPointerAuthorityRevoked is not confirmed');
  }

  const pools = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
  if (!pools.length) issues.push('liquidity pool evidence is missing');
  pools.forEach((pool, index) => {
    if (!nonEmpty(pool?.poolId || pool?.id)) issues.push(`pool ${index + 1} id is missing`);
    if (!nonEmpty(pool?.createPoolTx || pool?.txIds?.createPool)) {
      issues.push(`pool ${index + 1} create transaction is missing`);
    }
  });
  const positions = proofPositions(pools);
  if (!positions.length) issues.push('liquidity position evidence is missing');
  positions.forEach((position, index) => {
    if (!nonEmpty(position?.positionNftMint || position?.nftMint || position?.positionMint)) {
      issues.push(`position ${index + 1} NFT is missing`);
    }
    if (!nonEmpty(position?.feeKeyNftMint || position?.feeKeyMint)) {
      issues.push(`position ${index + 1} Fee Key is missing`);
    }
    if (position?.locked !== true) issues.push(`position ${index + 1} is not confirmed locked`);
    if (!nonEmpty(position?.openTx || position?.txIds?.open)) {
      issues.push(`position ${index + 1} open transaction is missing`);
    }
    if (!nonEmpty(position?.lockTx || position?.txIds?.lock)) {
      issues.push(`position ${index + 1} lock transaction is missing`);
    }
  });

  if (!terminalTransferComplete(proof.transfer)) issues.push('terminal wallet-empty transfer is incomplete');
  const plannedAirdrops = Math.max(0, Number(proof?.airdrop?.plannedRecipientCount || 0));
  const deliveredAirdrops = Math.max(0, Number(proof?.airdrop?.deliveredCount || 0));
  const failedAirdrops = Math.max(0, Number(proof?.airdrop?.failedCount || 0));
  if (failedAirdrops > 0 || deliveredAirdrops < plannedAirdrops) {
    issues.push('airdrop delivery is incomplete');
  }
  return issues;
}

function markerValues(payload = {}) {
  return [payload?.source, payload?.schema, payload?.kind]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function proofFromPayload(payload = {}) {
  if (payload?.proof && typeof payload.proof === 'object') return payload.proof;
  if (payload?.launchData?.proof && typeof payload.launchData.proof === 'object') return payload.launchData.proof;
  if (payload?.token && payload?.liquidity) return payload;
  return null;
}

function fingerprintRecords(payload = {}, proof = {}) {
  return [
    ['fieldVerification.proofFingerprint', payload?.fieldVerification?.proofFingerprint],
    ['classicRetirementGate.proofFingerprint', payload?.classicRetirementGate?.proofFingerprint],
    ['reportParityAudit.proofFingerprint', payload?.reportParityAudit?.proofFingerprint],
    ['classicReportComparison.proofFingerprint', payload?.classicReportComparison?.proofFingerprint],
    ['classicReportComparison.result.proofFingerprint', payload?.classicReportComparison?.result?.proofFingerprint],
    ['proof.reportPublish.proofFingerprint', proof?.reportPublish?.proofFingerprint],
    ['proof.localDossier.proofFingerprint', proof?.localDossier?.proofFingerprint],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
}

function transferHashRecords(payload = {}, proof = {}) {
  return [
    ['proof.terminalTransferEvidenceHash', proof?.terminalTransferEvidenceHash],
    ['launchData.terminalTransferEvidenceHash', payload?.launchData?.terminalTransferEvidenceHash],
    ['launchData.finalSweep.transferEvidenceHash', payload?.launchData?.finalSweep?.transferEvidenceHash],
  ].filter(([, value]) => typeof value === 'string' && value.trim());
}

export function verifyTrebuchetProof(payload = {}) {
  const checks = [];
  const errors = [];
  const addCheck = (id, pass, detail) => {
    checks.push({ id, pass, detail });
    if (!pass) errors.push({ code: id, message: detail });
  };

  const markers = markerValues(payload);
  const proof = proofFromPayload(payload);
  const compatibleMarker = markers.some((marker) => COMPATIBLE_PROOF_MARKERS.has(marker));
  addCheck(
    'PROVENANCE_MISMATCH',
    compatibleMarker,
    compatibleMarker
      ? 'Trebuchet proof provenance is present.'
      : 'Proof is missing a compatible Trebuchet provenance marker.',
  );
  addCheck(
    'PROOF_MISSING',
    Boolean(proof),
    proof ? 'Launch proof payload is present.' : 'Launch proof payload is missing.',
  );

  if (!proof) {
    return {
      valid: false,
      schema: TREBUCHET_PROOF_VERIFICATION_SCHEMA,
      fingerprint: null,
      transferEvidenceHash: null,
      checks,
      errors,
    };
  }

  const completenessIssues = proofCompletenessIssues(proof);
  addCheck(
    'PROOF_INCOMPLETE',
    completenessIssues.length === 0,
    completenessIssues.length
      ? `Launch proof is incomplete: ${completenessIssues.join('; ')}.`
      : 'Launch proof contains concrete completed launch evidence.',
  );

  const fingerprint = v2LaunchProofFingerprint(proof);
  const storedFingerprints = fingerprintRecords(payload, proof);
  addCheck(
    'FINGERPRINT_MISSING',
    storedFingerprints.length > 0,
    storedFingerprints.length
      ? 'Stored proof fingerprint evidence is present.'
      : 'Proof has no stored fingerprint to verify independently.',
  );
  const fingerprintMismatches = storedFingerprints
    .filter(([, value]) => value !== fingerprint)
    .map(([path]) => path);
  addCheck(
    'FINGERPRINT_MISMATCH',
    fingerprintMismatches.length === 0,
    fingerprintMismatches.length
      ? `Stored proof fingerprint differs at ${fingerprintMismatches.join(', ')}.`
      : 'Stored proof fingerprints match independently derived evidence.',
  );

  const transferEvidenceHash = v2TransferEvidenceHash(proof.transfer);
  const transferHashMismatches = transferHashRecords(payload, proof)
    .filter(([, value]) => value !== transferEvidenceHash)
    .map(([path]) => path);
  addCheck(
    'TRANSFER_HASH_MISMATCH',
    transferHashMismatches.length === 0,
    transferHashMismatches.length
      ? `Stored transfer evidence hash differs at ${transferHashMismatches.join(', ')}.`
      : 'Stored transfer evidence hashes match independently derived evidence.',
  );

  return {
    valid: errors.length === 0,
    schema: TREBUCHET_PROOF_VERIFICATION_SCHEMA,
    fingerprint,
    transferEvidenceHash,
    checks,
    errors,
  };
}
