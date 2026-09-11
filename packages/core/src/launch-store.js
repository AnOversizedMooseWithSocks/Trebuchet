// Saved launch store for Trebuchet Core.
//
// A saved launch is the operator's planned launch configuration — token,
// supply, pools, vanity target — persisted so it survives an app restart
// and can be created programmatically (CLI, sealed runner, scripts)
// instead of being retyped into the UI every session.
//
// This is deliberately NOT the journal: a journal records what a launch
// DID (checkpoints, tx ids, outcomes). A saved launch records what the
// operator INTENDS to launch. The app shows saved launches like it shows
// saved vanity CA candidates; the CLI writes them directly.
//
// Storage is a JSON array of entries in one file, written atomically.
// Secret-like keys are stripped by the same sanitizer the journal uses, so
// a wallet secret can never be persisted here.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  normalizeTokenDescription,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeVanityTargetBase58,
  normalizeWholeTokenSupply,
} from './validators.js';

export const SAVED_LAUNCH_SCHEMA = 'trebuchet-saved-launch/v1';

const MAX_SAVED_LAUNCHES = 100;
const MAX_NAME_BYTES = 64;

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `launch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const SECRET_KEY_RE = /(secret|private|mnemonic)/i;

// Fields the launch form does not model. When an existing saved launch is
// updated from the form (auto-save), these must survive: losing the selected
// vanity CA or a quote price override would silently change the launch.
const PRESERVE_WHEN_ABSENT_TOP_LEVEL = ['walletPublicKey'];
const PRESERVE_WHEN_ABSENT_VANITY = ['selectedPublicKey'];
const PRESERVE_WHEN_ABSENT_POOL = [
  'quoteUsdOverride',
  'quoteDecimalsOverride',
  'quotePriceSource',
  'quoteCompatibility',
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function poolIdentity(pool = {}) {
  return String(pool.quoteMint || pool.quoteToken || pool.quoteSymbol || '').trim();
}

/**
 * Merge a form-derived config over the previously stored one. The form is a
 * lossy view of a launch: it has no field for the selected vanity CA or quote
 * price overrides, so a naive replace silently degrades the saved launch.
 * Preserve those specific fields when the incoming config omits them.
 */
export function mergeSavedLaunchConfig(stored, incoming) {
  if (!isPlainObject(stored)) return incoming;
  if (!isPlainObject(incoming)) return stored;
  const merged = { ...stored, ...incoming };

  for (const key of PRESERVE_WHEN_ABSENT_TOP_LEVEL) {
    if ((incoming[key] === undefined || incoming[key] === null) && stored[key]) {
      merged[key] = stored[key];
    }
  }

  if (isPlainObject(stored.vanity) || isPlainObject(incoming.vanity)) {
    const storedVanity = isPlainObject(stored.vanity) ? stored.vanity : {};
    const incomingVanity = isPlainObject(incoming.vanity) ? incoming.vanity : {};
    merged.vanity = { ...storedVanity, ...incomingVanity };
    for (const key of PRESERVE_WHEN_ABSENT_VANITY) {
      if (!incomingVanity[key] && storedVanity[key]) merged.vanity[key] = storedVanity[key];
    }
  }

  const storedPools = stored.poolTopology?.pools;
  const incomingPools = incoming.poolTopology?.pools;
  if (Array.isArray(storedPools) && Array.isArray(incomingPools) && incomingPools.length) {
    const storedByQuote = new Map(storedPools.map((pool) => [poolIdentity(pool), pool]));
    merged.poolTopology = {
      ...(isPlainObject(stored.poolTopology) ? stored.poolTopology : {}),
      ...(isPlainObject(incoming.poolTopology) ? incoming.poolTopology : {}),
      pools: incomingPools.map((pool, index) => {
        const prior = storedByQuote.get(poolIdentity(pool)) || storedPools[index] || null;
        if (!prior) return pool;
        const next = { ...prior, ...pool };
        for (const key of PRESERVE_WHEN_ABSENT_POOL) {
          if (pool[key] === undefined && prior[key] !== undefined) next[key] = prior[key];
        }
        return next;
      }),
    };
  }

  return merged;
}

/**
 * Strip secret-like keys from a saved launch before it is persisted.
 * Unlike the journal sanitizer this does NOT truncate long strings: a saved
 * launch legitimately carries a logo data URL, and truncating it would
 * corrupt the stored artwork.
 */
export function sanitizeSavedLaunchConfig(value, depth = 0) {
  if (depth > 12 || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeSavedLaunchConfig(item, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key)) continue;
    out[key] = sanitizeSavedLaunchConfig(item, depth + 1);
  }
  return out;
}

/**
 * Validate and normalize a launch configuration for storage. Throws with a
 * clear message so the CLI and API can surface a useful error instead of
 * persisting something the launch engine will later reject.
 */
export function normalizeSavedLaunchConfig(config = {}) {
  if (!config || typeof config !== 'object') {
    throw new Error('Saved launch requires a config object');
  }
  const token = config.token || {};
  const normalizedToken = {
    ...clone(token),
    name: normalizeTokenName(token.name),
    symbol: normalizeTokenSymbol(token.symbol),
    supply: normalizeWholeTokenSupply(token.supply),
    description: normalizeTokenDescription(token.description),
  };
  const poolTopology = config.poolTopology && typeof config.poolTopology === 'object'
    ? clone(config.poolTopology)
    : null;
  if (!poolTopology || !Array.isArray(poolTopology.pools) || poolTopology.pools.length === 0) {
    throw new Error('Saved launch requires at least one pool in poolTopology.pools');
  }
  const { prefix, suffix } = normalizeVanityTargetBase58(
    config.vanity?.prefix,
    config.vanity?.suffix,
  );
  const selectedPublicKey = String(config.vanity?.selectedPublicKey || '').trim() || null;
  return {
    ...clone(config),
    token: normalizedToken,
    poolTopology,
    vanity: { prefix, suffix, selectedPublicKey },
  };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  try {
    return {
      schema: SAVED_LAUNCH_SCHEMA,
      id: String(raw.id),
      name: String(raw.name || raw.config?.token?.name || 'Untitled launch').slice(0, MAX_NAME_BYTES),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
      source: typeof raw.source === 'string' ? raw.source : 'app',
      config: normalizeSavedLaunchConfig(raw.config || {}),
    };
  } catch {
    // Corrupt or legacy entries are skipped rather than crashing the list.
    return null;
  }
}

/**
 * Create a saved-launch store bound to one JSON file.
 *
 * Options:
 *   filePath  absolute path of the store file (required)
 *   onWarn/onError  reporting callbacks for non-fatal storage problems
 */
export function createLaunchStore({ filePath, onWarn = () => {}, onError = () => {} } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('createLaunchStore requires a filePath');
  }
  const file = path.resolve(filePath);

  const load = () => {
    try {
      if (!fs.existsSync(file)) return [];
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeEntry).filter(Boolean).slice(0, MAX_SAVED_LAUNCHES);
    } catch (error) {
      onWarn(`launchStore: failed to read, treating as empty: ${error.message}`);
      return [];
    }
  };

  const persist = (list) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list.slice(-MAX_SAVED_LAUNCHES), null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (error) {
      onError(`launchStore: failed to save: ${error.message}`);
    }
  };

  return {
    filePath: file,

    list() {
      return load()
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .map(clone);
    },

    get(id) {
      if (!id) return null;
      const entry = load().find((item) => item.id === id);
      return entry ? clone(entry) : null;
    },

    /**
     * Create or update a saved launch. When `id` matches an existing entry
     * the entry keeps its createdAt; otherwise a new entry is created.
     */
    save({ id = null, name = null, config, source = 'app' } = {}) {
      const normalizedConfig = normalizeSavedLaunchConfig(config);
      const list = load();
      const label = String(name || normalizedConfig.token.name || 'Untitled launch').slice(0, MAX_NAME_BYTES);
      const existingIndex = id ? list.findIndex((item) => item.id === id) : -1;
      const ts = nowIso();
      if (existingIndex >= 0) {
        const existing = list[existingIndex];
        list[existingIndex] = {
          ...existing,
          name: label,
          config: sanitizeSavedLaunchConfig(mergeSavedLaunchConfig(existing.config, normalizedConfig)),
          updatedAt: ts,
          source: String(source || existing.source || 'app'),
        };
        persist(list);
        return clone(list[existingIndex]);
      }
      const entry = {
        schema: SAVED_LAUNCH_SCHEMA,
        id: id || newId(),
        name: label,
        createdAt: ts,
        updatedAt: ts,
        source: String(source || 'app'),
        config: sanitizeSavedLaunchConfig(normalizedConfig),
      };
      list.push(entry);
      persist(list);
      return clone(entry);
    },

    remove(id) {
      if (!id) return false;
      const list = load();
      const next = list.filter((item) => item.id !== id);
      if (next.length === list.length) return false;
      persist(next);
      return true;
    },
  };
}