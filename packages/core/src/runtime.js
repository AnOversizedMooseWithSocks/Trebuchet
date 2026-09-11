import {
  buildV2LaunchPlan,
  TREBUCHET_CORE_PROTOCOL_VERSION,
  verifyLaunchPlan,
} from './launch-plan.js';
import { verifyTrebuchetProof } from './proof-verification.js';
import {
  TREBUCHET_CORE_NAME,
  TREBUCHET_CORE_VERSION,
  TREBUCHET_ESTIMATE_SCHEMA,
  TrebuchetCoreError,
  TrebuchetCoreErrorCode,
} from './contracts.js';

function normalizeClockValue(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TrebuchetCoreError(TrebuchetCoreErrorCode.INTERNAL, 'Core clock returned an invalid date.');
  }
  return date.toISOString();
}

export function createTrebuchetCore({ clock = () => new Date() } = {}) {
  if (typeof clock !== 'function') throw new TypeError('Trebuchet Core clock must be a function.');

  const planLaunch = (intent = {}, options = {}) => {
    try {
      return buildV2LaunchPlan(intent, {
        ...options,
        now: options.now || normalizeClockValue(clock),
      });
    } catch (error) {
      if (error instanceof TrebuchetCoreError) throw error;
      throw new TrebuchetCoreError(
        TrebuchetCoreErrorCode.INVALID_INPUT,
        error.message || 'Launch intent is invalid.',
        { cause: error },
      );
    }
  };
  const verifyPlan = (plan = {}) => verifyLaunchPlan(plan);
  const estimateLaunch = (intentOrPlan = {}, options = {}) => {
    const plan = intentOrPlan?.schema
      ? intentOrPlan
      : planLaunch(intentOrPlan, options);
    const verification = verifyLaunchPlan(plan);
    if (!verification.valid) {
      throw new TrebuchetCoreError(
        TrebuchetCoreErrorCode.INTEGRITY_MISMATCH,
        'Launch plan failed integrity verification.',
        { details: verification.errors },
      );
    }
    return {
      schema: TREBUCHET_ESTIMATE_SCHEMA,
      protocolVersion: TREBUCHET_CORE_PROTOCOL_VERSION,
      planDigest: verification.digest,
      launchSol: Number(plan.funding?.launchSol || 0),
      estimatedSolCost: Number(plan.funding?.estimatedSolCost || 0),
      publishReportCostSol: Number(plan.funding?.publishReportCostSol || 0),
      operationCount: Array.isArray(plan.operations) ? plan.operations.length : 0,
    };
  };
  const verifyProof = (payload = {}) => verifyTrebuchetProof(payload);

  return Object.freeze({
    name: TREBUCHET_CORE_NAME,
    version: TREBUCHET_CORE_VERSION,
    protocolVersion: TREBUCHET_CORE_PROTOCOL_VERSION,

    planLaunch,
    verifyPlan,
    estimateLaunch,
    verifyProof,
  });
}
