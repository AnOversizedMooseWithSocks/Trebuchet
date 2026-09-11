export const TREBUCHET_CORE_NAME = 'Trebuchet Core';
export const TREBUCHET_CORE_VERSION = '0.1.0';
export const TREBUCHET_ESTIMATE_SCHEMA = 'trebuchet-launch-estimate/v1';
export const TREBUCHET_PROOF_VERIFICATION_SCHEMA = 'trebuchet-proof-verification/v1';

export const TrebuchetCoreErrorCode = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_READY: 'NOT_READY',
  CUSTODY_LOCKED: 'CUSTODY_LOCKED',
  RETRYABLE_DEPENDENCY: 'RETRYABLE_DEPENDENCY',
  RECOVERY_REQUIRED: 'RECOVERY_REQUIRED',
  INTEGRITY_MISMATCH: 'INTEGRITY_MISMATCH',
  INTERNAL: 'INTERNAL',
});

export class TrebuchetCoreError extends Error {
  constructor(code, message, { details = null, cause = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'TrebuchetCoreError';
    this.code = code;
    this.details = details;
  }
}
