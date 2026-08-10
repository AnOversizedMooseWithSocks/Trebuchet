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
  const directProof = payload === proof;
  addCheck(
    'PROVENANCE_MISMATCH',
    compatibleMarker || directProof,
    compatibleMarker || directProof
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

  const fingerprint = v2LaunchProofFingerprint(proof);
  const fingerprintMismatches = fingerprintRecords(payload, proof)
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
