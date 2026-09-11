// Launch journal contract for Trebuchet Core.
//
// Persists non-secret launch state so a crash or close after an on-chain
// transaction leaves an audit/recovery trail. This module NEVER stores
// secret keys: values whose keys look secret-bearing (secret, private,
// mnemonic) are dropped by sanitizeForJournal before anything is
// persisted or returned.
//
// Unlike the legacy app-level launchJournal.js, this Core module is
// instance-based: callers inject the storage file path, so the same
// contract serves the desktop app (TREBUCHET_CONFIG_DIR), the CLI
// (temp config dirs), and tests. Storage is a JSON array of journal
// records written atomically (write-to-temp, rename).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const LAUNCH_JOURNAL_MAX_EVENTS = 200;
const MAX_STRING_LENGTH = 8000;
const MAX_STACK_LINES = 20;
const TERMINAL_STATUSES = new Set(['completed', 'archived']);
const SECRET_KEY_RE = /(secret|private|mnemonic)/i;

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `launch_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function truncateString(value, maxLength = MAX_STRING_LENGTH) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...[truncated ${value.length - maxLength} chars]`;
}

export function sanitizeForJournal(value, depth = 0) {
  if (depth > 10) return '[max depth]';
  if (value == null) return value;
  if (typeof value === 'string') return truncateString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeForJournal(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(key)) continue;
      const sanitized = sanitizeForJournal(item, depth + 1);
      if (sanitized !== undefined) out[key] = sanitized;
    }
    return out;
  }
  return undefined;
}

export function errorMessage(error) {
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) return error;
  if (error == null) return 'Unknown error';
  try {
    const json = JSON.stringify(sanitizeForJournal(error));
    if (json && json !== '{}') return json;
  } catch (_) {
    // Fall through to String(error).
  }
  return String(error || 'Unknown error');
}

export function errorDetails(error, context = {}) {
  const details = {
    ...context,
    message: errorMessage(error),
  };

  if (error && typeof error === 'object') {
    for (const key of [
      'name',
      'code',
      'status',
      'statusCode',
      'failedPhase',
      'failedAllocationIndex',
      'probeCode',
      'signature',
      'transactionMessage',
      'instructionError',
      'logs',
    ]) {
      if (error[key] !== undefined) details[key] = error[key];
    }
    if (error.stack) {
      details.stack = truncateString(
        String(error.stack).split('\n').slice(0, MAX_STACK_LINES).join('\n'),
      );
    }
    if (error.cause) {
      details.cause = errorDetails(error.cause);
    }
  }

  return sanitizeForJournal(details);
}

// A successful finish-token recovery can adopt metadata that landed on-chain
// immediately before an RPC propagation error. In that case the original
// metadata_account_created progress callback may never have reached the
// journal, even though the subsequent recovery verified the token and marked
// it safe. Treat that verified repair state as metadata evidence so readiness
// does not keep routing an already-finished mint back through repair.
export function tokenCreationComplete(journal, tokenMint = journal?.token?.mint) {
  const mint = String(tokenMint || '').trim();
  if (!mint || journal?.token?.mintAuthorityRenounced !== true) return false;

  const events = Array.isArray(journal?.events) ? journal.events : [];
  const supplyRecorded = events.some((event) => event?.stage === 'supply_minted');
  const metadataRecorded = events.some((event) => event?.stage === 'metadata_account_created');
  const metadataAdoptedBySafeRepair = journal?.token?.isSafe === true;

  return supplyRecorded && (metadataRecorded || metadataAdoptedBySafeRepair);
}

function normalizeJournal(raw) {
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : nowIso();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  return {
    id: typeof raw.id === 'string' ? raw.id : newId(),
    walletPublicKey: raw.walletPublicKey,
    status: typeof raw.status === 'string' ? raw.status : 'active',
    stage: typeof raw.stage === 'string' ? raw.stage : 'wallet_generated',
    createdAt,
    updatedAt,
    completedAt: raw.completedAt || null,
    archivedAt: raw.archivedAt || null,
    launchConfig: raw.launchConfig && typeof raw.launchConfig === 'object' ? raw.launchConfig : null,
    token: raw.token && typeof raw.token === 'object' ? raw.token : null,
    poolPlan: raw.poolPlan && typeof raw.poolPlan === 'object' ? raw.poolPlan : null,
    lp: raw.lp && typeof raw.lp === 'object' ? raw.lp : null,
    transfer: raw.transfer && typeof raw.transfer === 'object' ? raw.transfer : null,
    airdrop: raw.airdrop && typeof raw.airdrop === 'object' ? raw.airdrop : null,
    reportPublish: raw.reportPublish && typeof raw.reportPublish === 'object' ? raw.reportPublish : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    errorDetails: raw.errorDetails && typeof raw.errorDetails === 'object' ? raw.errorDetails : null,
    events: Array.isArray(raw.events) ? raw.events.slice(-LAUNCH_JOURNAL_MAX_EVENTS) : [],
  };
}

function findActiveForWallet(list, walletPublicKey) {
  return list.find(
    (journal) =>
      journal.walletPublicKey === walletPublicKey &&
      !TERMINAL_STATUSES.has(journal.status),
  );
}

function mergeKnownFields(journal, patch) {
  const sanitized = sanitizeForJournal(patch) || {};
  for (const [key, value] of Object.entries(sanitized)) {
    if (key === 'id' || key === 'walletPublicKey' || key === 'createdAt') continue;
    if (key === 'launchConfig') {
      // A launch recipe is an immutable configuration snapshot, not a
      // collection of incremental execution facts. Replace it atomically so
      // stale nested pool rows cannot survive a newly armed plan.
      journal[key] = value && typeof value === 'object' ? value : null;
    } else if (['token', 'poolPlan', 'lp', 'transfer'].includes(key)) {
      journal[key] = {
        ...(journal[key] && typeof journal[key] === 'object' ? journal[key] : {}),
        ...(value && typeof value === 'object' ? value : {}),
      };
    } else {
      journal[key] = value;
    }
  }
}

function applyEvent(journal, event) {
  const sanitizedEvent = sanitizeForJournal(event);
  journal.events.push({ ts: nowIso(), ...sanitizedEvent });
  journal.events = journal.events.slice(-LAUNCH_JOURNAL_MAX_EVENTS);
}

function touch(journal) {
  journal.updatedAt = nowIso();
  if (journal.status === 'completed' && !journal.completedAt) journal.completedAt = journal.updatedAt;
}

/**
 * Create a launch journal store bound to one JSON file.
 *
 * Options:
 *   filePath  absolute path of the journal file (required)
 *   onWarn    callback for non-fatal storage read problems
 *   onError   callback for non-fatal storage write problems
 *
 * Storage failures never throw: the journal is a best-effort audit trail,
 * and launch execution must not die because a sidecar file was unreadable.
 * Problems are reported through onWarn/onError so hosts can surface them.
 */
export function createLaunchJournalStore({ filePath, onWarn = () => {}, onError = () => {} } = {}) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('createLaunchJournalStore requires a filePath');
  }
  const file = path.resolve(filePath);

  const readRaw = () => {
    try {
      if (!fs.existsSync(file)) return [];
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      onWarn(`launchJournal: failed to read, treating as empty: ${errorMessage(error)}`);
      return [];
    }
  };

  const load = () => readRaw()
    .map(normalizeJournal)
    .filter((journal) => typeof journal.walletPublicKey === 'string' && journal.walletPublicKey);

  const persist = (list) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (error) {
      onError(`launchJournal: failed to save: ${errorMessage(error)}`);
    }
  };

  return {
    filePath: file,

    start({ walletPublicKey } = {}) {
      if (!walletPublicKey) return null;
      const list = load();
      const existing = findActiveForWallet(list, walletPublicKey);
      if (existing) return clone(existing);

      const ts = nowIso();
      const journal = {
        id: newId(),
        walletPublicKey,
        status: 'active',
        stage: 'wallet_generated',
        createdAt: ts,
        updatedAt: ts,
        completedAt: null,
        archivedAt: null,
        launchConfig: null,
        token: null,
        poolPlan: null,
        lp: null,
        transfer: null,
        error: null,
        errorDetails: null,
        events: [{ ts, stage: 'wallet_generated', walletPublicKey }],
      };
      list.push(journal);
      persist(list);
      return clone(journal);
    },

    get(id) {
      if (!id) return null;
      const journal = load().find((entry) => entry.id === id);
      return journal ? clone(journal) : null;
    },

    activeForWallet(walletPublicKey) {
      if (!walletPublicKey) return null;
      const journal = findActiveForWallet(load(), walletPublicKey);
      return journal ? clone(journal) : null;
    },

    update(id, patch = {}, event = null) {
      if (!id) return null;
      const list = load();
      const journal = list.find((entry) => entry.id === id);
      if (!journal) return null;
      mergeKnownFields(journal, patch);
      if (event) applyEvent(journal, event);
      touch(journal);
      persist(list);
      return clone(journal);
    },

    upsertForWallet(walletPublicKey, patch = {}, event = null) {
      if (!walletPublicKey) return null;
      const list = load();
      let journal = findActiveForWallet(list, walletPublicKey);
      if (!journal) {
        const ts = nowIso();
        journal = {
          id: newId(),
          walletPublicKey,
          status: 'active',
          stage: 'wallet_generated',
          createdAt: ts,
          updatedAt: ts,
          completedAt: null,
          archivedAt: null,
          launchConfig: null,
          token: null,
          poolPlan: null,
          lp: null,
          transfer: null,
          airdrop: null,
          reportPublish: null,
          error: null,
          errorDetails: null,
          events: [],
        };
        list.push(journal);
      }

      mergeKnownFields(journal, patch);
      if (event) applyEvent(journal, event);
      touch(journal);
      persist(list);
      return clone(journal);
    },

    recordEvent(walletPublicKey, event) {
      const stage = typeof event?.stage === 'string' ? event.stage : undefined;
      return this.upsertForWallet(
        walletPublicKey,
        stage ? { stage } : {},
        event,
      );
    },

    list({ includeCompleted = false, includeArchived = false } = {}) {
      return load()
        .filter((journal) => includeCompleted || journal.status !== 'completed')
        .filter((journal) => includeArchived || journal.status !== 'archived')
        .map(clone);
    },

    archive(id) {
      const list = load();
      const journal = list.find((entry) => entry.id === id);
      if (!journal) return false;
      const ts = nowIso();
      journal.status = 'archived';
      journal.archivedAt = ts;
      journal.updatedAt = ts;
      journal.events.push({ ts, stage: 'journal_archived' });
      journal.events = journal.events.slice(-LAUNCH_JOURNAL_MAX_EVENTS);
      persist(list);
      return true;
    },
  };
}