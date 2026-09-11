// Signed confirmation contract for Trebuchet Core.
//
// A confirmation is the operator's explicit, signature-backed authorization
// of a launch: the plan digest, the network it may run on, a spend ceiling,
// the launch wallet (when known), and an expiry. Nothing may execute live
// without a valid confirmation for the exact plan it runs.
//
// Signatures are Ed25519 (crypto.verify), so the operator's confirmation
// key can be any Solana keypair — the same 32-byte seed / 64-byte secret
// key format the app and CLI already use. The contract is deliberately
// free of Solana dependencies: Core verifies math, not blockchains.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

export const TREBUCHET_CONFIRMATION_SCHEMA = 'trebuchet-confirmation/v1';
export const CONFIRMATION_NETWORKS = new Set(['demo', 'devnet', 'mainnet']);

// DER prefix for a raw Ed25519 private key (seed) in PKCS#8.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const HEX_64_RE = /^[0-9a-f]{64}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function secretKeyToEd25519Material(secretKey) {
  const bytes = Uint8Array.from(secretKey || []);
  const seed = bytes.length === 64 ? bytes.slice(0, 32) : bytes;
  if (seed.length !== 32) {
    throw new Error('Confirmation secret key must be a 32-byte seed or a 64-byte Solana secret key');
  }
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const rawPublicKey = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  return { privateKey, publicKey, rawPublicKey, seed };
}

export function normalizeConfirmationPayload(input = {}) {
  const planDigest = String(input.planDigest || '').trim().toLowerCase();
  if (!HEX_64_RE.test(planDigest)) {
    throw new Error('Confirmation requires a 64-hex-character plan digest');
  }
  const network = String(input.network || '').trim().toLowerCase();
  if (!CONFIRMATION_NETWORKS.has(network)) {
    throw new Error(`Confirmation network must be one of: ${[...CONFIRMATION_NETWORKS].join(', ')}`);
  }
  const maxSpendSol = Number(input.maxSpendSol);
  if (!Number.isFinite(maxSpendSol) || maxSpendSol <= 0) {
    throw new Error('Confirmation requires a positive --max-spend-sol ceiling');
  }
  const walletPublicKey = input.walletPublicKey == null || input.walletPublicKey === ''
    ? null
    : String(input.walletPublicKey).trim();
  if (walletPublicKey && !BASE58_RE.test(walletPublicKey)) {
    throw new Error('Confirmation wallet public key does not look like a Solana address');
  }
  const expiresAt = String(input.expiresAt || '').trim();
  const expiresMs = Date.parse(expiresAt);
  if (!expiresAt || Number.isNaN(expiresMs)) {
    throw new Error('Confirmation requires an ISO-8601 expiresAt');
  }
  return {
    planDigest,
    planDigestAlgorithm: String(input.planDigestAlgorithm || 'sha256'),
    network,
    maxSpendSol,
    walletPublicKey,
    expiresAt,
    tool: String(input.tool || 'trebuchet-cli'),
  };
}

// Canonical JSON: fixed key order, no whitespace. The digest and signature
// are computed over exactly these bytes, so any implementation can reproduce
// them.
export function canonicalConfirmationJson(payload) {
  const ordered = {};
  for (const key of ['planDigest', 'planDigestAlgorithm', 'network', 'maxSpendSol', 'walletPublicKey', 'expiresAt', 'tool']) {
    ordered[key] = payload[key];
  }
  return JSON.stringify(ordered);
}

export function confirmationPayloadDigest(payload) {
  return createHash('sha256').update(canonicalConfirmationJson(payload)).digest('hex');
}

export function signConfirmation(input, secretKey) {
  const payload = normalizeConfirmationPayload(input);
  const { privateKey, rawPublicKey } = secretKeyToEd25519Material(secretKey);
  const signature = edSign(null, Buffer.from(canonicalConfirmationJson(payload), 'utf8'), privateKey);
  return {
    schema: TREBUCHET_CONFIRMATION_SCHEMA,
    payload,
    payloadDigest: confirmationPayloadDigest(payload),
    signature: signature.toString('base64'),
    signerRawPublicKey: [...rawPublicKey],
    signedAt: new Date().toISOString(),
  };
}

export function verifyConfirmation(confirmation, { now = new Date(), expectNetwork, expectPlanDigest, expectSignerRawPublicKey } = {}) {
  const errors = [];
  const fail = (code, message) => errors.push({ code, message });

  if (!confirmation || confirmation.schema !== TREBUCHET_CONFIRMATION_SCHEMA) {
    return { valid: false, errors: [{ code: 'SCHEMA', message: `Expected ${TREBUCHET_CONFIRMATION_SCHEMA}` }], payload: null, digest: null };
  }

  let payload;
  try {
    payload = normalizeConfirmationPayload(confirmation.payload || {});
  } catch (error) {
    return { valid: false, errors: [{ code: 'PAYLOAD', message: error.message }], payload: null, digest: null };
  }

  const digest = confirmationPayloadDigest(payload);
  if (confirmation.payloadDigest !== digest) {
    fail('DIGEST', 'Confirmation payload digest does not match its contents');
  }

  let signatureOk = false;
  try {
    // Rebuild the verifying key directly from the stated raw public key:
    // the SPKI wrapper for a raw Ed25519 public key is a fixed 12-byte prefix.
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(confirmation.signerRawPublicKey || [])]);
    const verifyKey = createPublicKey({ key: spki, format: 'der', type: 'spki' });
    signatureOk = edVerify(
      null,
      Buffer.from(canonicalConfirmationJson(payload), 'utf8'),
      verifyKey,
      Buffer.from(confirmation.signature || '', 'base64'),
    );
  } catch {
    signatureOk = false;
  }
  if (!signatureOk) fail('SIGNATURE', 'Confirmation signature is invalid');

  const nowMs = now.getTime();
  if (nowMs > Date.parse(payload.expiresAt)) {
    fail('EXPIRED', `Confirmation expired at ${payload.expiresAt}`);
  }

  if (expectNetwork && payload.network !== expectNetwork) {
    fail('NETWORK', `Confirmation authorizes ${payload.network}, not ${expectNetwork}`);
  }
  if (expectPlanDigest && payload.planDigest !== expectPlanDigest.toLowerCase()) {
    fail('PLAN_DIGEST', 'Confirmation was signed for a different plan');
  }
  if (expectSignerRawPublicKey) {
    const expected = Uint8Array.from(expectSignerRawPublicKey);
    const actual = Uint8Array.from(confirmation.signerRawPublicKey || []);
    if (expected.length !== actual.length || !expected.every((b, i) => b === actual[i])) {
      fail('SIGNER', 'Confirmation was signed by a different key');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    payload,
    digest,
    signerRawPublicKey: confirmation.signerRawPublicKey || null,
  };
}