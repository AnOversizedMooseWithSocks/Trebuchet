// Headless custody keyfile for Trebuchet Core.
//
// A custody keyfile is the CLI/runner equivalent of the desktop app's
// OS-keychain secret store: one Ed25519 keypair, encrypted at rest with a
// passphrase (scrypt + AES-256-GCM), readable only while unlocked. The
// keyfile never leaves the operator's machine; the runner and CLI hold the
// decrypted secret in memory only for the duration of a command and zero
// it afterwards.
//
// File format (trebuchet-custody-keyfile/v1):
// {
//   "schema": "trebuchet-custody-keyfile/v1",
//   "createdAt": "<iso>",
//   "publicKeyRaw": [32 bytes],
//   "kdf": { "algorithm": "scrypt", "N": 32768, "r": 8, "p": 1, "salt": "<b64>" },
//   "cipher": { "algorithm": "aes-256-gcm", "iv": "<b64>", "authTag": "<b64>", "ciphertext": "<b64>" }
// }
//
// publicKeyRaw is stored in the clear on purpose: it is a public key, and
// keeping it outside the ciphertext lets tooling identify a keyfile without
// asking for the passphrase.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import fs from 'node:fs';

export const TREBUCHET_CUSTODY_KEYFILE_SCHEMA = 'trebuchet-custody-keyfile/v1';

const KDF_PARAMS = Object.freeze({ N: 2 ** 15, r: 8, p: 1, keyLength: 32 });
const SCRYPT_MAXMEM = 96 * 1024 * 1024;

export class CustodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CustodyError';
  }
}

function deriveKey(passphrase, saltB64) {
  const salt = Buffer.from(saltB64, 'base64');
  if (salt.length < 16) throw new CustodyError('Custody keyfile salt is too short');
  return scryptSync(String(passphrase), salt, KDF_PARAMS.keyLength, {
    N: KDF_PARAMS.N,
    r: KDF_PARAMS.r,
    p: KDF_PARAMS.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/**
 * Encrypt a 64-byte Solana secret key (seed || public key) into the
 * keyfile structure. Returns the JSON-serializable keyfile object.
 */
export function encryptCustodyKeyfile({ secretKey, passphrase }) {
  const bytes = Uint8Array.from(secretKey || []);
  if (bytes.length !== 64) throw new CustodyError('Custody secret key must be 64 bytes (seed || public key)');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(String(passphrase), salt, KDF_PARAMS.keyLength, {
    N: KDF_PARAMS.N, r: KDF_PARAMS.r, p: KDF_PARAMS.p, maxmem: SCRYPT_MAXMEM,
  });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({ secretKey: [...bytes] }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    schema: TREBUCHET_CUSTODY_KEYFILE_SCHEMA,
    createdAt: new Date().toISOString(),
    publicKeyRaw: [...bytes.slice(32, 64)],
    kdf: {
      algorithm: 'scrypt',
      N: KDF_PARAMS.N,
      r: KDF_PARAMS.r,
      p: KDF_PARAMS.p,
      salt: salt.toString('base64'),
    },
    cipher: {
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    },
  };
}

/**
 * Decrypt a keyfile. Throws CustodyError on a wrong passphrase or a
 * tampered file (GCM auth tag failure) — never returns a wrong key.
 */
export function decryptCustodyKeyfile(keyfile, { passphrase }) {
  if (!keyfile || keyfile.schema !== TREBUCHET_CUSTODY_KEYFILE_SCHEMA) {
    throw new CustodyError(`Expected ${TREBUCHET_CUSTODY_KEYFILE_SCHEMA}`);
  }
  if (keyfile.kdf?.algorithm !== 'scrypt') throw new CustodyError('Unsupported keyfile KDF');
  if (keyfile.cipher?.algorithm !== 'aes-256-gcm') throw new CustodyError('Unsupported keyfile cipher');
  const key = deriveKey(passphrase, keyfile.kdf.salt);
  let plaintext;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(keyfile.cipher.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(keyfile.cipher.authTag, 'base64'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(keyfile.cipher.ciphertext, 'base64')),
      decipher.final(),
    ]);
  } catch {
    throw new CustodyError('Custody keyfile could not be decrypted — wrong passphrase or tampered file');
  }
  let parsed;
  try {
    parsed = JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new CustodyError('Custody keyfile plaintext is corrupt');
  }
  const secretKey = Uint8Array.from(parsed.secretKey || []);
  if (secretKey.length !== 64) throw new CustodyError('Custody keyfile does not contain a 64-byte secret key');
  const stated = Uint8Array.from(keyfile.publicKeyRaw || []);
  const embedded = secretKey.slice(32, 64);
  if (stated.length !== 32 || !stated.every((b, i) => b === embedded[i])) {
    throw new CustodyError('Custody keyfile public key does not match its secret key');
  }
  return { secretKey, publicKeyRaw: embedded, createdAt: keyfile.createdAt || null };
}

/**
 * An in-memory custody session. `lock()` zeroes the secret key buffer;
 * after locking, the session is unusable.
 */
export function openCustodySession({ secretKey, publicKeyRaw, createdAt = null } = {}) {
  const sk = Uint8Array.from(secretKey || []);
  if (sk.length !== 64) throw new CustodyError('Custody session requires a 64-byte secret key');
  const pk = Uint8Array.from(publicKeyRaw || sk.slice(32, 64));
  let locked = false;
  return {
    get locked() { return locked; },
    createdAt,
    publicKeyRaw: pk,
    getSecretKey() {
      if (locked) throw new CustodyError('Custody session is locked');
      return sk;
    },
    lock() {
      locked = true;
      sk.fill(0);
    },
  };
}

/** Read a keyfile from disk (public metadata only; no passphrase needed). */
export function readCustodyKeyfileMeta(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (parsed?.schema !== TREBUCHET_CUSTODY_KEYFILE_SCHEMA) {
    throw new CustodyError(`Expected ${TREBUCHET_CUSTODY_KEYFILE_SCHEMA}`);
  }
  return parsed;
}