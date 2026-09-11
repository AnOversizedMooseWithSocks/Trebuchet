import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  canonicalConfirmationJson,
  confirmationPayloadDigest,
  secretKeyToEd25519Material,
  signConfirmation,
  verifyConfirmation,
} from '../src/confirmation.js';

function makeOperatorKey() {
  const seed = new Uint8Array(randomBytes(32));
  const { rawPublicKey } = secretKeyToEd25519Material(seed);
  return { secretKey: new Uint8Array([...seed, ...rawPublicKey]), rawPublicKey };
}

const basePayload = {
  planDigest: 'a'.repeat(64),
  network: 'mainnet',
  maxSpendSol: 1.5,
  walletPublicKey: null,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  tool: 'trebuchet-cli/test',
};

test('canonical JSON is order-stable and whitespace-free', () => {
  const a = canonicalConfirmationJson(basePayload);
  const b = canonicalConfirmationJson({
    tool: basePayload.tool,
    expiresAt: basePayload.expiresAt,
    walletPublicKey: basePayload.walletPublicKey,
    maxSpendSol: basePayload.maxSpendSol,
    network: basePayload.network,
    planDigest: basePayload.planDigest,
  });
  assert.equal(a, b);
  assert.equal(a.includes(' '), false);
  assert.equal(confirmationPayloadDigest(basePayload), confirmationPayloadDigest(JSON.parse(a)));
});

test('sign → verify roundtrip validates', () => {
  const op = makeOperatorKey();
  const confirmation = signConfirmation(basePayload, op.secretKey);
  const result = verifyConfirmation(confirmation, { expectNetwork: 'mainnet' });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.payload.planDigest, basePayload.planDigest);
  assert.deepEqual(Uint8Array.from(confirmation.signerRawPublicKey), op.rawPublicKey);
});

test('accepts a 32-byte seed as well as a 64-byte secret key', () => {
  const seed = new Uint8Array(randomBytes(32));
  const fromSeed = signConfirmation(basePayload, seed);
  const fromFull = signConfirmation(basePayload, secretKeyToEd25519Material(seed).rawPublicKey && new Uint8Array([...seed, ...secretKeyToEd25519Material(seed).rawPublicKey]));
  assert.equal(fromSeed.signerRawPublicKey.join(','), fromFull.signerRawPublicKey.join(','));
});

test('tampered payloads and payloads without a matching digest fail', () => {
  const op = makeOperatorKey();
  const confirmation = signConfirmation(basePayload, op.secretKey);
  assert.equal(verifyConfirmation(confirmation).valid, true);

  const tampered = { ...confirmation, payload: { ...confirmation.payload, maxSpendSol: 100 } };
  const tamperedResult = verifyConfirmation(tampered);
  assert.equal(tamperedResult.valid, false);
  assert.ok(tamperedResult.errors.some((e) => e.code === 'DIGEST' || e.code === 'SIGNATURE'));

  const noDigest = { ...confirmation, payloadDigest: undefined };
  assert.equal(verifyConfirmation(noDigest).valid, false);

  const badSignature = { ...confirmation, signature: Buffer.from('garbage').toString('base64') };
  const badSigResult = verifyConfirmation(badSignature);
  assert.equal(badSigResult.valid, false);
  assert.ok(badSigResult.errors.some((e) => e.code === 'SIGNATURE'));
});

test('expiry, network, plan, and signer expectations are enforced', () => {
  const op = makeOperatorKey();
  const confirmation = signConfirmation(
    { ...basePayload, expiresAt: new Date(Date.now() - 1000).toISOString() },
    op.secretKey,
  );
  const expired = verifyConfirmation(confirmation);
  assert.equal(expired.valid, false);
  assert.ok(expired.errors.some((e) => e.code === 'EXPIRED'));

  const fresh = signConfirmation(basePayload, op.secretKey);
  assert.equal(verifyConfirmation(fresh, { expectNetwork: 'devnet' }).valid, false);
  assert.equal(verifyConfirmation(fresh, { expectPlanDigest: 'b'.repeat(64) }).valid, false);
  assert.equal(verifyConfirmation(fresh, { expectSignerRawPublicKey: new Uint8Array(32) }).valid, false);
  assert.equal(verifyConfirmation(fresh, { expectNetwork: 'mainnet', expectPlanDigest: basePayload.planDigest, expectSignerRawPublicKey: op.rawPublicKey }).valid, true);
});

test('payload validation rejects malformed inputs', () => {
  assert.throws(() => signConfirmation({ ...basePayload, planDigest: 'xyz' }, makeOperatorKey().secretKey), /plan digest/);
  assert.throws(() => signConfirmation({ ...basePayload, network: 'carpetnet' }, makeOperatorKey().secretKey), /network/);
  assert.throws(() => signConfirmation({ ...basePayload, maxSpendSol: -1 }, makeOperatorKey().secretKey), /max-spend/);
  assert.throws(() => signConfirmation({ ...basePayload, walletPublicKey: 'not a key' }, makeOperatorKey().secretKey), /Solana address/);
});