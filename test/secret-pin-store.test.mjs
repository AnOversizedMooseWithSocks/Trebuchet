import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as secretPinStore from '../secretPinStore.js';
import * as secretStore from '../secretStore.js';

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-secret-pin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function useConfigDir(t) {
  const prior = process.env.TREBUCHET_CONFIG_DIR;
  const dir = makeTempConfigDir(t);
  process.env.TREBUCHET_CONFIG_DIR = dir;
  secretPinStore.lock();
  secretPinStore.setSafeStorage(null);
  t.after(() => {
    secretPinStore.lock();
    secretPinStore.setSafeStorage(null);
    if (prior === undefined) delete process.env.TREBUCHET_CONFIG_DIR;
    else process.env.TREBUCHET_CONFIG_DIR = prior;
  });
  return dir;
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext) => Buffer.from(`wrapped:${plaintext}`, 'utf8'),
    decryptString: (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('wrapped:')) throw new Error('bad ciphertext');
      return text.slice('wrapped:'.length);
    },
  };
}

function encryptLegacyPayload(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from([1]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64');
}

test('sets, locks, and unlocks a PIN-encrypted token', (t) => {
  const dir = useConfigDir(t);

  assert.equal(secretPinStore.status().configured, false);

  secretPinStore.setPin('1234');
  assert.equal(existsSync(path.join(dir, '.secretPin.json')), true);
  assert.equal(secretPinStore.status().configured, true);
  assert.equal(secretPinStore.status().unlocked, true);
  assert.equal(secretPinStore.status().locked, false);
  assert.equal(secretPinStore.status().version, 2);
  assert.equal(secretPinStore.status().kdf, 'scrypt');

  const token = secretPinStore.encryptString('launch wallet secret');
  assert.match(token, /^pin:/);
  assert.equal(Buffer.from(token.slice(4), 'base64')[0], 2);
  assert.equal(secretPinStore.decryptString(token), 'launch wallet secret');

  secretPinStore.lock();
  assert.equal(secretPinStore.status().configured, true);
  assert.equal(secretPinStore.status().unlocked, false);
  assert.equal(secretPinStore.status().locked, true);
  assert.equal(secretPinStore.decryptString(token), null);
  assert.equal(secretPinStore.unlock('0000'), false);
  assert.equal(secretPinStore.decryptString(token), null);

  assert.equal(secretPinStore.unlock('1234'), true);
  assert.equal(secretPinStore.decryptString(token), 'launch wallet secret');
});

test('uses safeStorage-protected device secret when available', (t) => {
  const dir = useConfigDir(t);
  secretPinStore.setSafeStorage(fakeSafeStorage());

  secretPinStore.setPin('2222');
  const state = JSON.parse(readFileSync(path.join(dir, '.secretPin.json'), 'utf8'));

  assert.equal(state.version, 2);
  assert.equal(state.kdf, 'scrypt');
  assert.equal(state.deviceSecretProtected, true);
  assert.match(state.deviceSecret, /^enc:/);
  assert.equal(secretPinStore.status().deviceSecretProtected, true);
  assert.equal(secretPinStore.status().deviceSecretAvailable, true);

  const token = secretPinStore.encryptString('device bound');
  secretPinStore.lock();
  secretPinStore.setSafeStorage(null);
  assert.equal(secretPinStore.status().deviceSecretAvailable, false);
  assert.equal(secretPinStore.unlock('2222'), false);

  secretPinStore.setSafeStorage(fakeSafeStorage());
  assert.equal(secretPinStore.unlock('2222'), true);
  assert.equal(secretPinStore.decryptString(token), 'device bound');
});

test('validates PIN shape', (t) => {
  useConfigDir(t);

  assert.throws(() => secretPinStore.setPin('123'), /exactly 4 digits/);
  assert.throws(() => secretPinStore.setPin('12a4'), /exactly 4 digits/);
  assert.throws(() => secretPinStore.unlock('12345'), /exactly 4 digits/);
});

test('secretStore prefers PIN tokens when a PIN is configured', (t) => {
  useConfigDir(t);
  secretStore.setSafeStorage(fakeSafeStorage());

  secretStore.setupSecretPin('9876');
  const token = secretStore.encryptString('pin protected');

  assert.match(token, /^pin:/);
  assert.equal(secretStore.decryptString(token), 'pin protected');
  assert.equal(secretStore.isEncrypting(), true);

  secretStore.lockSecretPin();
  assert.equal(secretStore.isEncrypting(), false);
  assert.equal(secretStore.decryptString(token), null);
  assert.equal(secretStore.unlockSecretPin('9876'), true);
  assert.equal(secretStore.decryptString(token), 'pin protected');
});

test('migrates legacy v1 PIN state and decrypts legacy tokens for rewrap', (t) => {
  const dir = useConfigDir(t);
  secretPinStore.setSafeStorage(fakeSafeStorage());

  const salt = crypto.randomBytes(32);
  const legacyKey = crypto.pbkdf2Sync('1234', salt, 200_000, 32, 'sha256');
  const legacyToken = 'pin:' + encryptLegacyPayload('legacy secret', legacyKey);
  writeFileSync(
    path.join(dir, '.secretPin.json'),
    JSON.stringify({
      version: 1,
      iterations: 200_000,
      salt: salt.toString('base64'),
      verifier: encryptLegacyPayload('TrebuchetSecretPIN:v1', legacyKey),
    }) + '\n',
  );

  assert.equal(secretPinStore.status().version, 1);
  assert.equal(secretPinStore.unlock('1234'), true);
  assert.equal(secretPinStore.status().version, 2);
  assert.equal(secretPinStore.decryptString(legacyToken), 'legacy secret');
  assert.equal(secretPinStore.shouldReencryptToken(legacyToken), true);

  const nextToken = secretPinStore.encryptString('fresh secret');
  assert.equal(Buffer.from(nextToken.slice(4), 'base64')[0], 2);
  assert.equal(secretPinStore.decryptString(nextToken), 'fresh secret');
});
