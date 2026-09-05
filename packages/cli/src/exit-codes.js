import { TrebuchetCoreErrorCode } from '@trebuchet/core';

export const CliExitCode = Object.freeze({
  SUCCESS: 0,
  INVALID_INPUT: 2,
  NOT_READY: 3,
  CUSTODY_LOCKED: 4,
  RETRYABLE_DEPENDENCY: 5,
  RECOVERY_REQUIRED: 6,
  INTEGRITY_MISMATCH: 7,
  INTERNAL: 70,
});

const CORE_EXIT_CODES = Object.freeze({
  [TrebuchetCoreErrorCode.INVALID_INPUT]: CliExitCode.INVALID_INPUT,
  [TrebuchetCoreErrorCode.NOT_READY]: CliExitCode.NOT_READY,
  [TrebuchetCoreErrorCode.CUSTODY_LOCKED]: CliExitCode.CUSTODY_LOCKED,
  [TrebuchetCoreErrorCode.RETRYABLE_DEPENDENCY]: CliExitCode.RETRYABLE_DEPENDENCY,
  [TrebuchetCoreErrorCode.RECOVERY_REQUIRED]: CliExitCode.RECOVERY_REQUIRED,
  [TrebuchetCoreErrorCode.INTEGRITY_MISMATCH]: CliExitCode.INTEGRITY_MISMATCH,
});

export function exitCodeForError(error) {
  return CORE_EXIT_CODES[error?.code] || CliExitCode.INTERNAL;
}
