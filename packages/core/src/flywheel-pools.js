// Flywheel pool registry for Trebuchet Core.
//
// A flywheel is a launch paired against another memecoin so trading pressure
// circulates between the two. Until now Trebuchet had exactly one meme
// flywheel mint baked in. Instead, the meme flywheel is a *pool* of mints:
// the default selection is random from the pool, and operators can curate the
// pool (add the tokens they believe in, remove ones they do not).
//
// The pool is data, not policy: a plan is always built from the mint that was
// actually selected, so plan digests stay deterministic.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const FLYWHEEL_KINDS = Object.freeze(['meme', 'reserve']);

// Seeded samples. The first entry is the long-standing default so existing
// configs and plans keep working.
export const DEFAULT_MEME_FLYWHEEL_MINTS = Object.freeze([
  'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r', // $seige — original default
  'FLFLJp1XTPrY7iLoKXZ9ZVZHGfxZMQMdPZtZCxfjHtsm',
  '2vGfseKJFt6iakqFrWoeDdSz8dweWYk5xPXV9uvVXRAT',
  'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY', // $FLYBRAIN
]);

export const DEFAULT_RESERVE_FLYWHEEL_MINTS = Object.freeze([
  'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',
]);

export function defaultFlywheelMints(kind) {
  if (kind === 'reserve') return [...DEFAULT_RESERVE_FLYWHEEL_MINTS];
  return [...DEFAULT_MEME_FLYWHEEL_MINTS];
}

export function isValidFlywheelMint(value) {
  return BASE58_RE.test(String(value ?? '').trim());
}

export function normalizeFlywheelMints(value, kind = 'meme') {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set();
  const out = [];
  for (const entry of list) {
    const mint = String(entry ?? '').trim();
    if (!isValidFlywheelMint(mint) || seen.has(mint)) continue;
    seen.add(mint);
    out.push(mint);
  }
  return out.length ? out : defaultFlywheelMints(kind);
}

/**
 * Pick a flywheel mint. Random by default; `last` is avoided when the pool has
 * alternatives, so consecutive shuffles visibly change the pairing.
 */
export function pickFlywheelMint(mints, { random = Math.random, exclude = [], last = null } = {}) {
  const valid = [];
  const seen = new Set();
  for (const entry of Array.isArray(mints) ? mints : []) {
    const mint = String(entry ?? '').trim();
    if (!isValidFlywheelMint(mint) || seen.has(mint)) continue;
    seen.add(mint);
    valid.push(mint);
  }
  const excluded = new Set([...(Array.isArray(exclude) ? exclude : [])]);
  if (last) excluded.add(String(last));
  let candidates = valid.filter((mint) => !excluded.has(mint));
  if (!candidates.length) candidates = valid;
  if (!candidates.length) return null;
  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  return candidates[index];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeState(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const lastPick = source.lastPick && typeof source.lastPick === 'object'
    ? clone(source.lastPick)
    : {};
  return {
    schema: 'trebuchet-flywheel-pools/v1',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
    meme: normalizeFlywheelMints(source.meme, 'meme'),
    reserve: normalizeFlywheelMints(source.reserve, 'reserve'),
    ...(Object.keys(lastPick).length ? { lastPick } : {}),
  };
}

/**
 * Create a flywheel pool store bound to one JSON file. Missing or invalid
 * entries fall back to the seeded defaults, so the feature works with no setup.
 */
export function createFlywheelPoolStore({ filePath, onWarn = () => {}, onError = () => {} } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('createFlywheelPoolStore requires a filePath');
  }
  const file = path.resolve(filePath);

  const load = () => {
    try {
      if (!fs.existsSync(file)) return normalizeState(null);
      return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      onWarn(`flywheelPools: failed to read, using defaults: ${error.message}`);
      return normalizeState(null);
    }
  };

  const persist = (state) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (error) {
      onError(`flywheelPools: failed to save: ${error.message}`);
    }
  };

  const kindOf = (kind) => (FLYWHEEL_KINDS.includes(kind) ? kind : 'meme');

  return {
    filePath: file,

    get(kind = 'meme') {
      const state = load();
      return clone(state[kindOf(kind)]);
    },

    all() {
      const state = load();
      return { meme: clone(state.meme), reserve: clone(state.reserve), updatedAt: state.updatedAt };
    },

    add(kind, mint) {
      const k = kindOf(kind);
      const value = String(mint ?? '').trim();
      if (!isValidFlywheelMint(value)) {
        throw new Error(`Not a valid Solana mint address: ${value || '(empty)'}`);
      }
      const state = load();
      if (!state[k].includes(value)) state[k].push(value);
      state.updatedAt = new Date().toISOString();
      persist(state);
      return clone(state[k]);
    },

    remove(kind, mint) {
      const k = kindOf(kind);
      const value = String(mint ?? '').trim();
      const state = load();
      const next = state[k].filter((entry) => entry !== value);
      if (next.length === state[k].length) return false;
      if (!next.length) {
        throw new Error('A flywheel pool must keep at least one mint.');
      }
      state[k] = next;
      state.updatedAt = new Date().toISOString();
      persist(state);
      return true;
    },

    pick(kind = 'meme', options = {}) {
      const k = kindOf(kind);
      const mint = pickFlywheelMint(load()[k], options);
      if (mint) {
        // Remember the last pick so the next random selection can avoid it.
        const state = load();
        state.lastPick = { ...(state.lastPick || {}), [k]: mint, at: new Date().toISOString() };
        persist(state);
      }
      return mint;
    },

    lastPick(kind = 'meme') {
      const state = load();
      return state.lastPick?.[kindOf(kind)] || null;
    },
  };
}
