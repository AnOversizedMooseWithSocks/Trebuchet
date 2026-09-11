import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  CustodyError,
  decryptCustodyKeyfile,
  encryptCustodyKeyfile,
  openCustodySession,
  readCustodyKeyfileMeta,
} from '../src/custody.js';

function makeSecretKey() {
  return new Uint8Array(randomBytes(64));
}

test('encrypt → decrypt roundtrip returns the exact key', () => {
  const secretKey = makeSecretKey();
  const keyfile = encryptCustodyKeyfile({ secretKey, passphrase: 'correct horse battery staple' });
  assert.equal(keyfile.schema, 'trebuchet-custody-keyfile/v1');
  assert.deepEqual(keyfile.publicKeyRaw, [...secretKey.slice(32, 64)]);

  const decrypted = decryptCustodyKeyfile(keyfile, { passphrase: 'correct horse battery staple' });
  assert.deepEqual([...decrypted.secretKey], [...secretKey]);
});

test('wrong passphrase fails closed, never returns a wrong key', () => {
  const keyfile = encryptCustodyKeyfile({ secretKey: makeSecretKey(), passphrase: 'right' });
  assert.throws(() => decryptCustodyKeyfile(keyfile, { passphrase: 'wrong' }), CustodyError);
});

test('tampered ciphertext or metadata fails closed', () => {
  const keyfile = encryptCustodyKeyfile({ secretKey: makeSecretKey(), passphrase: 'p' });
  const tamperedCiphertext = { ...keyfile, cipher: { ...keyfile.cipher, ciphertext: Buffer.from('x').toString('base64') } };
  assert.throws(() => decryptCustodyKeyfile(tamperedCiphertext, { passphrase: 'p' }), CustodyError);

  const swappedPublic = { ...keyfile, publicKeyRaw: [...randomBytes(32)] };
  assert.throws(() => decryptCustodyKeyfile(swappedPublic, { passphrase: 'p' }), CustodyError);
});

test('sessions lock and refuse further access', () => {
  const secretKey = makeSecretKey();
  const session = openCustodySession({ secretKey });
  assert.equal(session.locked, false);
  assert.deepEqual([...session.publicKeyRaw], [...secretKey.slice(32, 64)]);
  session.lock();
  assert.equal(session.locked, true);
  assert.throws(() => session.getSecretKey(), CustodyError);
});

test('keyfile writes and reads through the meta helper', async () => {
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-custody-'));
  const file = path.join(dir, 'custody.json');
  const keyfile = encryptCustodyKeyfile({ secretKey: makeSecretKey(), passphrase: 'p' });
  writeFileSync(file, JSON.stringify(keyfile, null, 2));
  const meta = readCustodyKeyfileMeta(file);
  assert.equal(meta.schema, 'trebuchet-custody-keyfile/v1');
  assert.equal(meta.cipher.algorithm, 'aes-256-gcm');
  assert.throws(() => readCustodyKeyfileMeta(path.join(dir, 'nope.json')), Error);
  rmSync(dir, { recursive: true, force: true });
});