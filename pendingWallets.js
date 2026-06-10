// pendingWallets.js
//
// Persists the secret keys of temporary wallets that are mid-launch, so
// that if the app crashes or the user closes it before the final
// transfer step completes, they can still recover any SOL/tokens left
// in the wallet rather than losing access forever.
//
// Lifecycle:
//   1. /api/generate-wallet   → add(publicKey, secretKey, mnemonic)
//   2. ...launch proceeds...
//   3. /api/transfer-assets   → on success AND after verifying the
//                                wallet is on-chain empty, remove(pk).
//
// At-rest encryption: secret material (the secretKey byte array and the
// mnemonic) goes through secretStore before being written to disk. In
// the Electron desktop build that means OS-keychain-backed encryption;
// in `npm run web` mode it falls back to plaintext with a warning.
// On-disk format:
//   {
//     publicKey:    "...",
//     createdAt:    "ISO timestamp",
//     secretKeyEnc: "enc:base64..." | "plain:[byte,array,...]",
//     mnemonicEnc:  "enc:base64..." | "plain:word word word..."
//   }
//
// Pre-encryption legacy entries (plain `secretKey` array or `mnemonic`
// string fields) are still readable, and get migrated to the encrypted
// form on the next load.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as secretStore from './secretStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Same env-var convention as rpcConfig.js. main.js sets this to
// app.getPath('userData') in the Electron build; left unset by the web
// build so writes land alongside the source.
const CONFIG_DIR = process.env.TREBUCHET_CONFIG_DIR || __dirname;
const FILE = path.join(CONFIG_DIR, 'pendingWallets.json');

// ---------------------------------------------------------------------------
// Encoding/decoding between in-memory and on-disk representations.
// ---------------------------------------------------------------------------

// Decrypt one disk entry into the in-memory shape used by the rest of
// the app. Tolerates legacy plaintext fields (secretKey: [...] /
// mnemonic: "...") so an upgrade doesn't lose anyone's recovery info.
function decodeEntry(raw) {
  const out = {
    publicKey: raw.publicKey,
    createdAt: raw.createdAt,
  };

  // Secret key (byte array). Encrypted form serialises through JSON.
  if (typeof raw.secretKeyEnc === 'string') {
    const json = secretStore.decryptString(raw.secretKeyEnc);
    if (json) {
      try { out.secretKey = JSON.parse(json); }
      catch { /* corrupted entry — leave secretKey undefined */ }
    }
  } else if (Array.isArray(raw.secretKey)) {
    out.secretKey = raw.secretKey;        // legacy plaintext
  }

  // Mnemonic (string).
  if (typeof raw.mnemonicEnc === 'string') {
    const text = secretStore.decryptString(raw.mnemonicEnc);
    if (text) out.mnemonic = text;
  } else if (typeof raw.mnemonic === 'string') {
    out.mnemonic = raw.mnemonic;          // legacy plaintext
  }

  return out;
}

// Encrypt one in-memory entry into the on-disk shape.
function encodeEntry(decoded) {
  const out = {
    publicKey: decoded.publicKey,
    createdAt: decoded.createdAt,
  };
  if (Array.isArray(decoded.secretKey)) {
    out.secretKeyEnc = secretStore.encryptString(JSON.stringify(decoded.secretKey));
  }
  if (typeof decoded.mnemonic === 'string' && decoded.mnemonic.length > 0) {
    out.mnemonicEnc = secretStore.encryptString(decoded.mnemonic);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File I/O. Failures are non-fatal — we'd rather skip the safety-net
// silently than crash the launch flow because of a disk hiccup.
// ---------------------------------------------------------------------------

function readRaw() {
  try {
    if (!fs.existsSync(FILE)) return [];
    const txt = fs.readFileSync(FILE, 'utf8');
    const parsed = JSON.parse(txt);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn('pendingWallets: failed to read, treating as empty:', e.message);
    return [];
  }
}

function load() {
  const raw = readRaw();
  const decoded = raw.map(decodeEntry);

  // One-shot migration: re-persist encrypted in two cases:
  //   (a) Legacy plaintext fields (secretKey: [...] / mnemonic: "...")
  //       from before this module wrote *Enc fields at all.
  //   (b) "plain:" tokens written when encryption was unavailable
  //       (e.g. `npm run web` mode), now that we can actually encrypt.
  // (b) is mostly a polish thing for users who switch from web mode to
  // the desktop build, but it costs nothing to handle correctly.
  const hasLegacyPlaintext = raw.some((e) =>
    Array.isArray(e.secretKey) || typeof e.mnemonic === 'string'
  );
  const hasPlainTokens = raw.some((e) =>
    (typeof e.secretKeyEnc === 'string' && e.secretKeyEnc.startsWith('plain:')) ||
    (typeof e.mnemonicEnc  === 'string' && e.mnemonicEnc.startsWith('plain:'))
  );
  if (hasLegacyPlaintext || (hasPlainTokens && secretStore.isEncrypting())) {
    try {
      persist(decoded);
      console.log('pendingWallets: migrated entries to encrypted form');
    } catch (e) {
      console.warn('pendingWallets: migration write failed (non-fatal):', e.message);
    }
  }

  return decoded;
}

function persist(list) {
  try {
    // mkdirSync with recursive:true is a no-op if the dir exists.
    // Necessary on first run when CONFIG_DIR is a userData path that
    // hasn't been touched yet.
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const encoded = list.map(encodeEntry);
    fs.writeFileSync(FILE, JSON.stringify(encoded, null, 2) + '\n');
  } catch (e) {
    console.error('pendingWallets: failed to save:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Record a wallet as in-progress. secretKey is the 64-byte array form
// returned by @solana/web3.js. mnemonic is the BIP39 recovery phrase if
// available — optional because older cached entries from before
// mnemonic support won't have one, and we want them to keep working.
// Idempotent: if the same publicKey is added twice, we keep the first
// entry's createdAt timestamp.
export function add(publicKey, secretKey, mnemonic) {
  const list = load();
  if (list.some((w) => w.publicKey === publicKey)) return;
  const entry = {
    publicKey,
    secretKey,
    createdAt: new Date().toISOString(),
  };
  if (mnemonic) entry.mnemonic = mnemonic;
  list.push(entry);
  persist(list);
}

// Drop a wallet from the recovery list. Used when the launch finishes
// cleanly (and the wallet is verified on-chain empty), or when the
// user manually dismisses an entry.
export function remove(publicKey) {
  const list = load();
  const filtered = list.filter((w) => w.publicKey !== publicKey);
  if (filtered.length !== list.length) persist(filtered);
}

// Return a single pending wallet by public key, decrypted, or null if not
// found. Convenience over list().find(...) for the common "I have the pubkey,
// give me the recoverable secret" lookup (resume, and the server-side signer
// resolution that F5 moves toward — letting the client send a pubkey instead
// of round-tripping the secret key through the renderer).
export function get(publicKey) {
  return load().find((w) => w.publicKey === publicKey) || null;
}

// Return all currently-pending wallets, decrypted into the in-memory shape
// ({ publicKey, secretKey, mnemonic, createdAt }). Server routes expose only
// metadata by default; secret material is revealed per-wallet on explicit user
// action.
export function list() {
  return load();
}
