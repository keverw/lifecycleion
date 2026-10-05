import { describeError, toError } from '../../to-error';
import { reportCallbackError } from '../../safe-handle-callback';
import {
  isTimeoutValidationError,
  resolveTimeoutMS,
  toTimerDelayMS,
} from '../../internal/timer-limits';
import type {
  StartupResult,
  ShutdownResult,
  SignalBroadcastResult,
  HealthCheckResult,
  HealthReport,
  ComponentOperationResult,
} from '../types';

// Errors from this manager's own option validation: its timeout validator calls and
// {@link invalidOperationOptionError}. The shared timer marker also covers validation
// performed by callers inside their getters and hooks; only this manager's own calls are
// expected configuration refusals, and caller failures retain the normal error channel.
const operationOptionRefusals = new WeakSet<Error>();

function validateLifecycleDuration<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (isTimeoutValidationError(error)) {
      operationOptionRefusals.add(error);
    }
    throw error;
  }
}

/**
 * A `TypeError` for a malformed caller option this manager validates itself. Branded as
 * the timeout refusals are, so settlement answers `invalid_options` without a
 * callback-error report rather than calling the manager's own refusal a crash.
 */
export function invalidOperationOptionError(message: string): TypeError {
  const error = new TypeError(message);
  operationOptionRefusals.add(error);
  return error;
}

/** Whether this manager's own option validation (timeouts included) refused `error`. */
export function isOperationOptionRefusal(error: unknown): error is Error {
  return operationOptionRefusals.has(error as Error);
}

export function resolveOperationTimeoutMS(
  requested: number | null | undefined,
  defaultMS: number,
  label = 'Timeout',
): number {
  return validateLifecycleDuration(() =>
    resolveTimeoutMS(requested, defaultMS, label),
  );
}

export function toOperationTimerDelayMS(
  requested: number,
  label = 'Timeout',
): number {
  return validateLifecycleDuration(() => toTimerDelayMS(requested, label));
}

/**
 * The refusal `acceptShutdownPass()` returns when it will not run a pass because one
 * is already running - whether the latch was already set on entry or was taken by a
 * nested request while this one was still being set up. Shared so the two refusals
 * cannot drift into reporting different things for the same situation.
 */
export function refusedShutdownResult(): ShutdownResult {
  return {
    success: false,
    stoppedComponents: [],
    stalledComponents: [],
    durationMS: 0,
    reason: 'Shutdown already in progress',
    code: 'already_in_progress',
  };
}

/**
 * The safety net under every public async method: whatever `run` throws or rejects with
 * comes back as the failed result `toFailure` builds. Our own option refusals are
 * expected; unexpected failures are reported on the global error channel.
 *
 * The public methods answer with result objects rather than rejections, so a caller can
 * start one without awaiting it - `const pending = manager.stopAllComponents()` - and read
 * the outcome whenever it likes, or drop it with `void`. A rejection would break that:
 * with nothing attached it is an unhandled rejection, fatal under Node's default
 * `--unhandled-rejections=throw`. Only errors branded by our own validation (timeouts, and
 * {@link invalidOperationOptionError}) become `invalid_options`, without a callback-error
 * report. Inline failure paths inside an operation apply the same split: a branded
 * refusal met before the operation claimed anything is `invalid_options`, unreported;
 * once it has acted, any failure is reported and answered `operation_crashed`. Ordinary
 * TypeError/RangeError values from caller getters remain unexpected failures:
 * recognizing every error of those types would hide actual bugs behind a configuration
 * refusal.
 *
 * `toFailure` runs on the failure path with nothing left above it, so it must build its
 * result fields from manager-owned data, without unguarded caller reads. Guarded
 * diagnostics are allowed when the result is already independent of any registry
 * changes they can cause: broadcast's constant empty-array refusal is one example.
 */
export async function settleOperation<T>(
  operation: string,
  run: () => Promise<T>,
  toFailure: (error: Error, reason: string, code: SettledFailureCode) => T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    // Classified once, here, beside the decision not to report: a builder that chose
    // its own code could label an unreported refusal as a crash.
    if (settledFailureCode(error) === 'invalid_options') {
      return toFailure(
        error as Error,
        `${operation}() refused: ${describeError(error)}`,
        'invalid_options',
      );
    }
    reportCallbackError(`lifecycle-manager ${operation}`, error);

    return toFailure(
      toError(error),
      `${operation}() failed unexpectedly: ${describeError(error)}`,
      'operation_crashed',
    );
  }
}

/** The code {@link settleOperation} hands its failure builder. */
export type SettledFailureCode = 'invalid_options' | 'operation_crashed';

/**
 * The one classification {@link settleOperation} and every failure builder's caller
 * share: a refusal from our own option validation, or a crash. Builders take the code
 * rather than deriving it, so they cannot disagree with the report decision.
 */
export function settledFailureCode(error: unknown): SettledFailureCode {
  return isOperationOptionRefusal(error)
    ? 'invalid_options'
    : 'operation_crashed';
}

/**
 * The `StartupResult` for a startup that failed unexpectedly - crashed, or skipped
 * because the shutdown it followed did - carrying the error. A bulk startup's own crash
 * spreads it and adds what it had started.
 */
export function crashedStartupResult(
  error: Error | undefined,
  reason: string,
  code: SettledFailureCode,
  durationMS = 0,
): StartupResult {
  return {
    ...refusedStartupResult(code, reason, durationMS),
    error,
  };
}

/**
 * The `ShutdownResult` for a shutdown call that crashed before any pass could report its
 * own result - so nothing stopped that this call knows of. A pass that dies reports
 * itself from inside `runShutdownPass()` instead, with what it did stop.
 */
export function crashedShutdownResult(
  error: Error,
  reason: string,
  code: SettledFailureCode,
): ShutdownResult {
  return {
    success: false,
    stoppedComponents: [],
    stalledComponents: [],
    durationMS: 0,
    reason,
    code,
    error,
  };
}

/**
 * The aggregate code for an operation that takes no caller options - `trigger*()` and
 * `checkAllHealth()` - settling a failure. Each component's own timeout is classified
 * inside the loop, as that component's entry, so an option refusal reaching the
 * operation's safety net would be the manager breaking its own invariant: a crash. Its
 * result type has no `invalid_options`, and the report {@link settleOperation} skipped
 * for an expected refusal is made here, as it is for every other crash.
 */
function optionlessFailureCode(
  operation: string,
  error: Error,
  code: SettledFailureCode,
): 'operation_crashed' {
  if (code === 'invalid_options') {
    reportCallbackError(`lifecycle-manager ${operation}`, error);
  }
  return 'operation_crashed';
}

/**
 * The `SignalBroadcastResult` for a `trigger*()` call that crashed as a whole, so there
 * are no per-component results to report.
 */
export function crashedSignalBroadcastResult(
  signal: SignalBroadcastResult['signal'],
  error: Error,
  code: SettledFailureCode,
): SignalBroadcastResult {
  return {
    signal,
    results: [],
    timedOut: false,
    code: optionlessFailureCode(`${signal} broadcast`, error, code),
    error,
  };
}

/**
 * The `HealthReport` for a `checkAllHealth()` call that crashed as a whole. Each
 * component's check is settled on its own, so there are no entries to report.
 */
export function crashedHealthReport(
  error: Error,
  code: SettledFailureCode,
): HealthReport {
  return {
    healthy: false,
    components: [],
    checkedAt: Date.now(),
    durationMS: 0,
    timedOut: false,
    code: optionlessFailureCode('checkAllHealth', error, code),
    error,
  };
}

/**
 * The `SignalBroadcastResult` for a `trigger*()` call whose custom `on*Requested`
 * callback threw or rejected: the caller's own code failed, so `error`, not a crash.
 */
export function failedSignalCallbackResult(
  signal: SignalBroadcastResult['signal'],
  error: Error,
): SignalBroadcastResult {
  return { signal, results: [], timedOut: false, code: 'error', error };
}

/**
 * The `HealthCheckResult` for a health check that crashed outside the component's own
 * `healthCheck()` - which is timed and caught on its own.
 */
export function crashedHealthCheckResult(
  name: string,
  error: Error,
  code: SettledFailureCode,
): HealthCheckResult {
  return {
    name,
    healthy: false,
    checkedAt: Date.now(),
    durationMS: 0,
    error,
    timedOut: false,
    code,
  };
}

/**
 * The `ComponentOperationResult` for a per-component operation that crashed. Carries no
 * `status`: building one reads component state through code that may be what threw. A
 * caller that can read it safely adds it, as a crashed stop does.
 */
export function crashedComponentResult(
  name: string,
  error: Error,
  reason: string,
  code: SettledFailureCode,
): ComponentOperationResult {
  return {
    success: false,
    componentName: name,
    reason,
    code,
    error,
  };
}

/**
 * The `StartupResult` a startup path returns when it starts nothing at all: no
 * component started, none failed, none skipped, and a code and reason saying why.
 * Shared for the same reason as {@link refusedShutdownResult}, so the refusals cannot
 * drift into reporting different shapes for the same kind of answer.
 *
 * A result carrying more - an `error`, or what a failed startup had started - spreads
 * this as its base and adds those fields, so the empty lists and code stay in one
 * place.
 */
export function refusedStartupResult(
  code: NonNullable<StartupResult['code']>,
  reason: string,
  durationMS = 0,
): StartupResult {
  return {
    success: false,
    startedComponents: [],
    failedOptionalComponents: [],
    skippedDueToDependency: [],
    reason,
    code,
    durationMS,
  };
}
