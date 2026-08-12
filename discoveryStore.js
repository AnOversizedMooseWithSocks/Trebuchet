import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const STORE_VERSION = 1;
const MAX_LABEL_LENGTH = 48;
const MAX_SNAPSHOT_TOKENS = 250;

function configDir() {
  return process.env.TREBUCHET_CONFIG_DIR || __dirname;
}

function storeFile() {
  return path.join(configDir(), 'personalDiscovery.json');
}

function emptyStore() {
  return {
    version: STORE_VERSION,
    wallets: [],
    snapshot: null,
  };
}

function normalizeLabel(label, fallback = 'Tracked wallet') {
  const value = String(label || '').trim().replace(/\s+/g, ' ');
  return (value || fallback).slice(0, MAX_LABEL_LENGTH);
}

function normalizeWallet(wallet = {}) {
  const publicKey = String(wallet.publicKey || '').trim();
  if (!publicKey) return null;
  const createdAt = Number.isFinite(Date.parse(wallet.createdAt))
    ? new Date(wallet.createdAt).toISOString()
    : new Date().toISOString();
  const updatedAt = Number.isFinite(Date.parse(wallet.updatedAt))
    ? new Date(wallet.updatedAt).toISOString()
    : createdAt;
  return {
    publicKey,
    label: normalizeLabel(wallet.label),
    source: wallet.source === 'managed' ? 'managed' : 'watch-only',
    enabled: wallet.enabled !== false,
    createdAt,
    updatedAt,
  };
}

function normalizeWallets(wallets = []) {
  const byPublicKey = new Map();
  wallets.map(normalizeWallet).filter(Boolean).forEach((wallet) => {
    const existing = byPublicKey.get(wallet.publicKey);
    if (!existing || (wallet.source === 'managed' && existing.source !== 'managed')) {
      byPublicKey.set(wallet.publicKey, wallet);
    }
  });
  return [...byPublicKey.values()];
}

function normalizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const completedAt = Date.parse(snapshot.completedAt || '');
  if (!Number.isFinite(completedAt)) return null;
  return {
    ...snapshot,
    completedAt: new Date(completedAt).toISOString(),
    knownTokens: Array.isArray(snapshot.knownTokens) ? snapshot.knownTokens.slice(0, MAX_SNAPSHOT_TOKENS) : [],
    candidates: Array.isArray(snapshot.candidates) ? snapshot.candidates.slice(0, MAX_SNAPSHOT_TOKENS) : [],
    warnings: Array.isArray(snapshot.warnings) ? snapshot.warnings.slice(0, 50).map(String) : [],
  };
}

function load() {
  try {
    if (!fs.existsSync(storeFile())) return emptyStore();
    const parsed = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyStore();
    return {
      version: STORE_VERSION,
      wallets: Array.isArray(parsed.wallets)
        ? normalizeWallets(parsed.wallets)
        : [],
      snapshot: normalizeSnapshot(parsed.snapshot),
    };
  } catch (error) {
    console.warn('discoveryStore: failed to read, using an empty personal graph:', error.message);
    return emptyStore();
  }
}

function persist(store) {
  fs.mkdirSync(configDir(), { recursive: true });
  const target = storeFile();
  const temporary = `${target}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Preserve the original write failure.
    }
    const wrapped = new Error('Trebuchet could not save personal Discovery data.');
    wrapped.code = 'DISCOVERY_PERSIST_FAILED';
    wrapped.statusCode = 500;
    wrapped.cause = error;
    throw wrapped;
  }
}

export function listWallets() {
  return load().wallets.map((wallet) => ({ ...wallet }));
}

export function upsertWallet(publicKey, options = {}) {
  const address = String(publicKey || '').trim();
  if (!address) throw new Error('Tracked wallet public key is required.');
  const store = load();
  const now = new Date().toISOString();
  const existing = store.wallets.find((wallet) => wallet.publicKey === address);
  if (existing) {
    const nextLabel = normalizeLabel(options.label, existing.label);
    const nextSource = options.source === 'managed' ? 'managed' : existing.source;
    const nextEnabled = typeof options.enabled === 'boolean' ? options.enabled : existing.enabled;
    const changed = existing.label !== nextLabel
      || existing.source !== nextSource
      || existing.enabled !== nextEnabled;
    if (!changed) return { ...existing };
    existing.label = nextLabel;
    existing.source = nextSource;
    existing.enabled = nextEnabled;
    existing.updatedAt = now;
    store.snapshot = null;
    persist(store);
    return { ...existing };
  }
  const source = options.source === 'managed' ? 'managed' : 'watch-only';
  const wallet = normalizeWallet({
    publicKey: address,
    label: options.label,
    source: options.source,
    enabled: options.enabled,
    createdAt: now,
    updatedAt: now,
  });
  store.wallets.push(wallet);
  store.snapshot = null;
  persist(store);
  return { ...wallet };
}

export function syncManagedWallets(wallets = []) {
  const store = load();
  const now = new Date().toISOString();
  const existingByPublicKey = new Map(store.wallets.map((wallet) => [wallet.publicKey, wallet]));
  const requested = normalizeWallets((Array.isArray(wallets) ? wallets : []).map((wallet) => ({
    publicKey: wallet?.publicKey,
    label: wallet?.label,
    source: 'managed',
    enabled: wallet?.enabled,
  })));
  let changed = false;

  requested.forEach((wallet) => {
    const existing = existingByPublicKey.get(wallet.publicKey);
    if (existing) {
      if (existing.source !== 'managed') {
        existing.source = 'managed';
        existing.updatedAt = now;
        changed = true;
      }
      return;
    }
    const added = { ...wallet, source: 'managed', createdAt: now, updatedAt: now };
    store.wallets.push(added);
    existingByPublicKey.set(added.publicKey, added);
    changed = true;
  });

  if (changed) {
    store.snapshot = null;
    persist(store);
  }
  return requested
    .map((wallet) => existingByPublicKey.get(wallet.publicKey))
    .filter(Boolean)
    .map((wallet) => ({ ...wallet }));
}

export function setWalletEnabled(publicKey, enabled) {
  const store = load();
  const wallet = store.wallets.find((entry) => entry.publicKey === publicKey);
  if (!wallet) return null;
  if (wallet.enabled === (enabled === true)) return { ...wallet };
  wallet.enabled = enabled === true;
  wallet.updatedAt = new Date().toISOString();
  store.snapshot = null;
  persist(store);
  return { ...wallet };
}

export function removeWallet(publicKey) {
  const store = load();
  const nextWallets = store.wallets.filter((wallet) => wallet.publicKey !== publicKey);
  if (nextWallets.length === store.wallets.length) return false;
  store.wallets = nextWallets;
  store.snapshot = null;
  persist(store);
  return true;
}

export function getSnapshot() {
  return normalizeSnapshot(load().snapshot);
}

export function saveSnapshot(snapshot) {
  const store = load();
  store.snapshot = normalizeSnapshot(snapshot);
  if (!store.snapshot) throw new Error('Personal Discovery snapshot is invalid.');
  persist(store);
  return store.snapshot;
}

export const PERSONAL_DISCOVERY_STORE_VERSION = STORE_VERSION;
// Compatibility exports remain present, but null now explicitly means that
// Trebuchet does not impose a product-level wallet tracking limit.
export const PERSONAL_DISCOVERY_MAX_WATCH_ONLY_WALLETS = null;
export const PERSONAL_DISCOVERY_MAX_WALLETS = null;
