// Flywheel rotation schedule contract for Trebuchet Core.
//
// A rotating flywheel means the quote allocation does not stay where the
// launch put it: fees are claimed, swapped into the paired memecoin, and the
// pools are re-weighted toward a target. That is a *running* process, so it
// needs a contract that says when it may act and how much it may spend.
//
// This module is that contract, and it is intentionally pure: it takes the
// schedule, the observed state, and a clock, and returns a decision. Both
// execution paths implement the same decision —
//
//   Path A (keeper): a sealed runner calls decideCrank(), then executes
//     claim -> swap -> add liquidity with spend caps and a journal.
//   Path B (program): an on-chain crank instruction enforces the same rules,
//     so no keeper key is trusted.
//
// Nothing here signs, spends, or touches a chain. It is the policy half of
// the flywheel, testable without a validator.

export const FLYWHEEL_SCHEDULE_SCHEMA = 'trebuchet-flywheel-schedule/v1';
export const FLYWHEEL_MODES = new Set(['static', 'rotating']);

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  minIntervalSec: [60, 7 * 24 * 3600],
  driftThresholdPct: [0.5, 50],
  maxSpendSolPerCrank: [0, 10],
  maxSpendSolPerDay: [0, 100],
  slippageBps: [10, 2000],
  cooldownAfterFailureSec: [60, 7 * 24 * 3600],
  maxCranksPerDay: [1, 288],
});

function numeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bounded(value, [min, max], fallback) {
  const parsed = numeric(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

function parseTime(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Validate and normalise a rotation schedule. Throws with a clear message so
 * an operator learns what is wrong instead of getting a silent default.
 *
 * `static` is the default and the safe state: an explicit mode is required to
 * let anything move.
 */
export function normalizeFlywheelSchedule(input = {}) {
  if (input == null) {
    return { schema: FLYWHEEL_SCHEDULE_SCHEMA, mode: 'static' };
  }
  if (typeof input !== 'object') {
    throw new Error('Flywheel schedule must be an object');
  }
  const mode = String(input.mode || 'static').trim().toLowerCase();
  if (!FLYWHEEL_MODES.has(mode)) {
    throw new Error(`Flywheel mode must be one of: ${[...FLYWHEEL_MODES].join(', ')}`);
  }

  const targets = Array.isArray(input.targets) ? input.targets : [];
  const seen = new Set();
  const normalizedTargets = targets.map((target, index) => {
    if (!target || typeof target !== 'object') {
      throw new Error(`Flywheel target ${index + 1} must be an object`);
    }
    const poolId = String(target.poolId || '').trim();
    if (!poolId) throw new Error(`Flywheel target ${index + 1} is missing poolId`);
    if (seen.has(poolId)) throw new Error(`Flywheel target ${poolId} is duplicated`);
    seen.add(poolId);
    const weightPct = numeric(target.weightPct, NaN);
    if (!Number.isFinite(weightPct) || weightPct < 0 || weightPct > 100) {
      throw new Error(`Flywheel target ${poolId} needs a weight between 0 and 100`);
    }
    return { poolId, weightPct: Math.round(weightPct * 10) / 10 };
  });

  if (mode === 'rotating') {
    if (!normalizedTargets.length) {
      throw new Error('A rotating flywheel needs at least one target');
    }
    const total = normalizedTargets.reduce((sum, target) => sum + target.weightPct, 0);
    if (Math.abs(total - 100) > 0.1) {
      throw new Error(`Flywheel target weights must sum to 100 (got ${total})`);
    }
  }

  return {
    schema: FLYWHEEL_SCHEDULE_SCHEMA,
    mode,
    targets: normalizedTargets,
    minIntervalSec: bounded(input.minIntervalSec, LIMITS.minIntervalSec, 900),
    driftThresholdPct: bounded(input.driftThresholdPct, LIMITS.driftThresholdPct, 3),
    maxSpendSolPerCrank: bounded(input.maxSpendSolPerCrank, LIMITS.maxSpendSolPerCrank, 0.05),
    maxSpendSolPerDay: bounded(input.maxSpendSolPerDay, LIMITS.maxSpendSolPerDay, 0.5),
    slippageBps: Math.round(bounded(input.slippageBps, LIMITS.slippageBps, 100)),
    cooldownAfterFailureSec: bounded(input.cooldownAfterFailureSec, LIMITS.cooldownAfterFailureSec, 1800),
    maxCranksPerDay: Math.round(bounded(input.maxCranksPerDay, LIMITS.maxCranksPerDay, 12)),
    killSwitch: input.killSwitch === true,
    createdAt: typeof input.createdAt === 'string' ? input.createdAt : null,
  };
}

export function verifyFlywheelSchedule(schedule) {
  const errors = [];
  try {
    normalizeFlywheelSchedule(schedule);
  } catch (error) {
    errors.push({ code: 'INVALID_SCHEDULE', message: error.message });
  }
  return { valid: errors.length === 0, errors };
}

/** Largest drift between the observed weights and the targets, in points. */
export function maxDriftPct(targets = [], pools = []) {
  const byId = new Map(pools.map((pool) => [String(pool.poolId), numeric(pool.currentWeightPct, 0)]));
  let worst = 0;
  for (const target of targets) {
    const current = byId.has(target.poolId) ? byId.get(target.poolId) : 0;
    worst = Math.max(worst, Math.abs(current - target.weightPct));
  }
  return Math.round(worst * 100) / 100;
}

/**
 * Decide whether the flywheel may act.
 *
 * `state` is what the keeper (or the program) observed:
 *   { lastCrankAt, lastCrankStatus, failedAt, cranksToday, spendTodaySol,
 *     pools: [{ poolId, currentWeightPct }] }
 *
 * Returns { action: 'crank' | 'wait' | 'pause', reason, targets?, spendCeilingSol? }.
 * `pause` means an operator must intervene; `wait` means trying again later is
 * expected to succeed.
 */
export function decideCrank({ schedule, state = {}, now = new Date() } = {}) {
  const normalized = normalizeFlywheelSchedule(schedule);
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (Number.isNaN(nowMs)) {
    return { action: 'pause', reason: 'Invalid clock' };
  }

  if (normalized.mode !== 'rotating') {
    return { action: 'pause', reason: 'Schedule is static; nothing is allowed to move' };
  }
  if (normalized.killSwitch) {
    return { action: 'pause', reason: 'Kill switch is engaged' };
  }

  const cranksToday = Math.max(0, Math.floor(numeric(state.cranksToday, 0)));
  if (cranksToday >= normalized.maxCranksPerDay) {
    return { action: 'pause', reason: `Daily crank budget reached (${normalized.maxCranksPerDay})` };
  }
  const spendTodaySol = Math.max(0, numeric(state.spendTodaySol, 0));
  const dayRemaining = Math.max(0, normalized.maxSpendSolPerDay - spendTodaySol);
  if (dayRemaining <= 0) {
    return { action: 'pause', reason: 'Daily spend ceiling reached' };
  }

  const lastCrankMs = parseTime(state.lastCrankAt);
  if (lastCrankMs != null && nowMs - lastCrankMs < normalized.minIntervalSec * 1000) {
    const waitSec = Math.ceil((normalized.minIntervalSec * 1000 - (nowMs - lastCrankMs)) / 1000);
    return { action: 'wait', reason: `Minimum interval not elapsed (${waitSec}s left)` };
  }

  if (String(state.lastCrankStatus || '').toLowerCase() === 'failed') {
    const failedMs = parseTime(state.failedAt);
    if (failedMs != null && nowMs - failedMs < normalized.cooldownAfterFailureSec * 1000) {
      const waitSec = Math.ceil((normalized.cooldownAfterFailureSec * 1000 - (nowMs - failedMs)) / 1000);
      return { action: 'wait', reason: `Cooling down after a failed crank (${waitSec}s left)` };
    }
  }

  const drift = maxDriftPct(normalized.targets, state.pools || []);
  if (drift < normalized.driftThresholdPct) {
    return { action: 'wait', reason: `Drift ${drift}% is below the ${normalized.driftThresholdPct}% threshold` };
  }

  return {
    action: 'crank',
    reason: `Drift ${drift}% exceeds the ${normalized.driftThresholdPct}% threshold`,
    targets: normalized.targets.map((target) => ({ ...target })),
    slippageBps: normalized.slippageBps,
    spendCeilingSol: Math.round(Math.min(normalized.maxSpendSolPerCrank, dayRemaining) * 1e6) / 1e6,
  };
}
