// secretPinStore.js
//
// PIN-backed vault for Trebuchet recovery secrets.
//
// v2 design:
//   - A random data key encrypts wallet/Vanity CA secrets.
//   - The data key is wrapped by scrypt(PIN + per-install device secret).
//   - The device secret is stored with Electron safeStorage when available.
//   - The PIN itself is never persisted.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STATE_FILE = '.secretPin.json';
const TOKEN_PREFIX = 'pin:';
const VERIFY_MARKER = 'TrebuchetSecretPIN:v2';
const LEGACY_VERIFY_MARKER = 'TrebuchetSecretPIN:v1';
const STATE_VERSION = 2;
const TOKEN_VERSION = 2;
const LEGACY_TOKEN_VERSION = 1;
const PBKDF2_ITERATIONS = 200_000;
const SCRYPT = {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};
const SALT_BYTES = 32;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

let _safeStorage = null;
let _dataKey = null;
let _legacyKeys = [];

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

function stateFile() {
  return path.join(configDir(), STATE_FILE);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  }
}

function writePrivateJson(file, data) {
  const dir = path.dirname(file);
  ensurePrivateDir(dir);
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}.json`);
  const text = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  }
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    throw new Error('PIN must be exactly 4 digits');
  }
}

function safeStorageProtectsSecrets() {
  if (!_safeStorage || typeof _safeStorage.isEncryptionAvailable !== 'function') return false;
  if (!_safeStorage.isEncryptionAvailable()) return false;
  if (process.platform === 'linux') {
    try {
      if (_safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
    } catch {
      // Older Electron versions do not expose the backend; trust availability.
    }
  }
  return (
    typeof _safeStorage.encryptString === 'function' &&
    typeof _safeStorage.decryptString === 'function'
  );
}

function encryptDeviceSecret(deviceSecret) {
  const encoded = deviceSecret.toString('base64');
  if (safeStorageProtectsSecrets()) {
    try {
      return {
        token: 'enc:' + _safeStorage.encryptString(encoded).toString('base64'),
        protected: true,
      };
    } catch (e) {
      console.warn('secretPinStore: safeStorage device-secret wrap failed:', e.message);
    }
  }
  console.warn(
    'secretPinStore: safeStorage unavailable; Recovery PIN device secret ' +
    'will use a local fallback. Desktop builds with Keychain/DPAPI/libsecret ' +
    'get stronger offline protection.',
  );
  return {
    token: 'plain:' + encoded,
    protected: false,
  };
}

function decryptDeviceSecret(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  try {
    if (token.startsWith('plain:')) {
      const secret = Buffer.from(token.slice(6), 'base64');
      return secret.length === KEY_BYTES ? secret : null;
    }
    if (token.startsWith('enc:')) {
      if (!safeStorageProtectsSecrets()) return null;
      const wrapped = Buffer.from(token.slice(4), 'base64');
      const decoded = _safeStorage.decryptString(wrapped);
      const secret = Buffer.from(decoded, 'base64');
      return secret.length === KEY_BYTES ? secret : null;
    }
  } catch (e) {
    console.warn('secretPinStore: device-secret unwrap failed:', e.message);
  }
  return null;
}

function deriveLegacyKey(pin, salt, iterations = PBKDF2_ITERATIONS) {
  return crypto.pbkdf2Sync(pin, salt, iterations, KEY_BYTES, 'sha256');
}

function deriveWrapKey(pin, salt, deviceSecret, params = SCRYPT) {
  const pinBytes = Buffer.from(pin, 'utf8');
  const password = Buffer.concat([pinBytes, Buffer.from([0]), deviceSecret]);
  return crypto.scryptSync(password, salt, KEY_BYTES, params);
}

function encryptPayload(plaintext, key, version = TOKEN_VERSION) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
  const ciphertext = Buffer.concat([
    cipher.update(input),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    Buffer.from([version]),
    iv,
    tag,
    ciphertext,
  ]).toString('base64');
}

function decryptPayload(payload, key, { raw = false } = {}) {
  const blob = Buffer.from(payload, 'base64');
  if (blob.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('invalid PIN secret blob');
  }
  const version = blob[0];
  if (version !== TOKEN_VERSION && version !== LEGACY_TOKEN_VERSION) {
    throw new Error('unsupported PIN secret blob version');
  }
  const ivStart = 1;
  const tagStart = ivStart + IV_BYTES;
  const bodyStart = tagStart + TAG_BYTES;
  const iv = blob.subarray(ivStart, tagStart);
  const tag = blob.subarray(tagStart, bodyStart);
  const ciphertext = blob.subarray(bodyStart);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return raw ? plaintext : plaintext.toString('utf8');
}

function pinTokenVersion(token) {
  if (!isPinToken(token)) return null;
  try {
    const blob = Buffer.from(token.slice(TOKEN_PREFIX.length), 'base64');
    return blob.length > 0 ? blob[0] : null;
  } catch {
    return null;
  }
}

function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.version === STATE_VERSION) {
      if (raw.kdf !== 'scrypt') return null;
      if (typeof raw.salt !== 'string') return null;
      if (typeof raw.deviceSecret !== 'string') return null;
      if (typeof raw.wrappedDataKey !== 'string') return null;
      if (typeof raw.verifier !== 'string') return null;
      const salt = Buffer.from(raw.salt, 'base64');
      if (salt.length !== SALT_BYTES) return null;
      return {
        version: STATE_VERSION,
        kdf: raw.kdf,
        scrypt: {
          N: Number(raw.scrypt?.N) || SCRYPT.N,
          r: Number(raw.scrypt?.r) || SCRYPT.r,
          p: Number(raw.scrypt?.p) || SCRYPT.p,
          maxmem: Number(raw.scrypt?.maxmem) || SCRYPT.maxmem,
        },
        salt,
        deviceSecret: raw.deviceSecret,
        deviceSecretProtected: raw.deviceSecretProtected === true,
        wrappedDataKey: raw.wrappedDataKey,
        verifier: raw.verifier,
      };
    }
    if (raw.version === 1) {
      if (!Number.isInteger(raw.iterations) || raw.iterations <= 0) return null;
      if (typeof raw.salt !== 'string' || typeof raw.verifier !== 'string') return null;
      const salt = Buffer.from(raw.salt, 'base64');
      if (salt.length !== SALT_BYTES) return null;
      return {
        version: 1,
        iterations: raw.iterations,
        salt,
        verifier: raw.verifier,
      };
    }
  } catch {
    return null;
  }
  return null;
}

function writeV2State({ pin, dataKey }) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const deviceSecret = crypto.randomBytes(KEY_BYTES);
  const device = encryptDeviceSecret(deviceSecret);
  const wrapKey = deriveWrapKey(pin, salt, deviceSecret);
  try {
    writePrivateJson(stateFile(), {
      version: STATE_VERSION,
      kdf: 'scrypt',
      scrypt: SCRYPT,
      salt: salt.toString('base64'),
      deviceSecret: device.token,
      deviceSecretProtected: device.protected,
      wrappedDataKey: encryptPayload(dataKey, wrapKey, TOKEN_VERSION),
      verifier: encryptPayload(VERIFY_MARKER, dataKey, TOKEN_VERSION),
      createdAt: new Date().toISOString(),
    });
  } finally {
    wrapKey.fill(0);
    deviceSecret.fill(0);
  }
}

function wipeBuffer(buf) {
  if (Buffer.isBuffer(buf)) {
    try { buf.fill(0); } catch { /* ignore */ }
  }
}

function wipeKeys() {
  wipeBuffer(_dataKey);
  for (const key of _legacyKeys) wipeBuffer(key);
  _dataKey = null;
  _legacyKeys = [];
}

function deviceSecretStatus(state) {
  if (!state || state.version !== STATE_VERSION) {
    return {
      deviceSecretProtected: false,
      deviceSecretAvailable: true,
    };
  }
  const protectedBySafeStorage = state.deviceSecretProtected === true
    && typeof state.deviceSecret === 'string'
    && state.deviceSecret.startsWith('enc:');
  return {
    deviceSecretProtected: protectedBySafeStorage,
    deviceSecretAvailable: protectedBySafeStorage
      ? safeStorageProtectsSecrets()
      : true,
  };
}

function unlockV2State(pin, state) {
  const deviceSecret = decryptDeviceSecret(state.deviceSecret);
  if (!deviceSecret) return false;
  const wrapKey = deriveWrapKey(pin, state.salt, deviceSecret, state.scrypt);
  let dataKey;
  try {
    dataKey = decryptPayload(state.wrappedDataKey, wrapKey, { raw: true });
    if (dataKey.length !== KEY_BYTES) return false;
    if (decryptPayload(state.verifier, dataKey) !== VERIFY_MARKER) return false;
  } catch {
    wipeBuffer(dataKey);
    return false;
  } finally {
    wrapKey.fill(0);
    deviceSecret.fill(0);
  }
  wipeKeys();
  _dataKey = dataKey;
  return true;
}

function unlockLegacyState(pin, state) {
  const legacyKey = deriveLegacyKey(pin, state.salt, state.iterations);
  try {
    if (decryptPayload(state.verifier, legacyKey) !== LEGACY_VERIFY_MARKER) {
      legacyKey.fill(0);
      return false;
    }
  } catch {
    legacyKey.fill(0);
    return false;
  }

  const dataKey = crypto.randomBytes(KEY_BYTES);
  try {
    writeV2State({ pin, dataKey });
  } catch (e) {
    console.warn('secretPinStore: failed to migrate PIN state to v2:', e.message);
    dataKey.fill(0);
    wipeKeys();
    _dataKey = legacyKey;
    return true;
  }

  wipeKeys();
  _dataKey = dataKey;
  _legacyKeys = [legacyKey];
  return true;
}

export function setSafeStorage(safeStorage) {
  _safeStorage = safeStorage || null;
}

export function hasPin() {
  return !!readState();
}

export function isUnlocked() {
  return Buffer.isBuffer(_dataKey);
}

export function isLocked() {
  return hasPin() && !isUnlocked();
}

export function status() {
  const state = readState();
  const configured = !!state;
  const unlocked = configured && isUnlocked();
  return {
    configured,
    unlocked,
    locked: configured && !unlocked,
    version: state?.version || null,
    kdf: state?.version === STATE_VERSION ? 'scrypt' : (state?.version === 1 ? 'pbkdf2' : null),
    ...deviceSecretStatus(state),
  };
}

export function setPin(pin) {
  validatePin(pin);
  wipeKeys();
  const dataKey = crypto.randomBytes(KEY_BYTES);
  try {
    writeV2State({ pin, dataKey });
  } catch (e) {
    dataKey.fill(0);
    throw e;
  }
  _dataKey = dataKey;
  return status();
}

export function rotateUnlockedPin(pin) {
  validatePin(pin);
  if (!isUnlocked()) {
    throw new Error('Secret PIN is locked; unlock before changing the PIN');
  }
  writeV2State({ pin, dataKey: _dataKey });
  return status();
}

export function unlock(pin) {
  validatePin(pin);
  const state = readState();
  if (!state) return false;
  if (state.version === STATE_VERSION) return unlockV2State(pin, state);
  if (state.version === 1) return unlockLegacyState(pin, state);
  return false;
}

export function lock() {
  wipeKeys();
}

export function reset() {
  wipeKeys();
  try {
    fs.unlinkSync(stateFile());
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return status();
}

export function isPinToken(token) {
  return typeof token === 'string' && token.startsWith(TOKEN_PREFIX);
}

export function encryptString(plaintext) {
  if (!isUnlocked()) {
    throw new Error('Secret PIN is locked; unlock before storing wallet secrets');
  }
  return TOKEN_PREFIX + encryptPayload(String(plaintext), _dataKey, TOKEN_VERSION);
}

export function decryptString(token) {
  if (!isPinToken(token) || !isUnlocked()) return null;
  const payload = token.slice(TOKEN_PREFIX.length);
  for (const key of [_dataKey, ..._legacyKeys]) {
    try {
      return decryptPayload(payload, key);
    } catch {
      // Try the next known key. Legacy v1 tokens are re-encrypted after unlock.
    }
  }
  console.warn('secretPinStore: decryptString failed');
  return null;
}

export function shouldReencryptToken(token) {
  if (!hasPin() || !isUnlocked() || typeof token !== 'string') return false;
  if (!isPinToken(token)) return true;
  return pinTokenVersion(token) !== TOKEN_VERSION;
}
