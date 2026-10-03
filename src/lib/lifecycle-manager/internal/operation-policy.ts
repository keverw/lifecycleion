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
  ComponentOperationResult,
} from '../types';

// The shared timer marker also covers validation performed by callers inside their
// getters and hooks. Only errors thrown by this manager's own validator calls are
// expected configuration refusals; caller failures retain the normal error channel.
const lifecycleTimeoutValidationErrors = new WeakSet<Error>();

function validateLifecycleDuration<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    if (isTimeoutValidationError(error)) {
      lifecycleTimeoutValidationErrors.add(error);
    }
    throw error;
  }
}

export function isOperationTimeoutValidationError(
  error: unknown,
): error is Error {
  return lifecycleTimeoutValidationErrors.has(error as Error);
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
 * comes back as the failed result `toFailure` builds. Known timeout validation errors
 * are expected refusals; unexpected failures are reported on the global error channel.
 *
 * The public methods answer with result objects rather than rejections, so a caller can
 * start one without awaiting it - `const pending = manager.stopAllComponents()` - and read
 * the outcome whenever it likes, or drop it with `void`. A rejection would break that:
 * with nothing attached it is an unhandled rejection, fatal under Node's default
 * `--unhandled-rejections=throw`. Only errors branded by our timeout validator become
 * `invalid_options`, without a callback-error report. Ordinary TypeError/RangeError
 * values from caller getters remain unexpected failures: recognizing every error of
 * those types would hide actual bugs behind a configuration refusal.
 *
 * `toFailure` runs on the failure path with nothing left above it, so it must build its
 * result fields from manager-owned data, without unguarded caller reads. Guarded
 * diagnostics are allowed when the result is already independent of any registry
 * changes they can cause: broadcast's constant empty-array refusal is one example.
 */
export async function settleOperation<T>(
  operation: string,
  run: () => Promise<T>,
  toFailure: (error: Error, reason: string) => T,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isOperationTimeoutValidationError(error)) {
      return toFailure(
        error,
        `${operation}() refused: ${describeError(error)}`,
      );
    }
    reportCallbackError(`lifecycle-manager ${operation}`, error);

    return toFailure(
      toError(error),
      `${operation}() failed unexpectedly: ${describeError(error)}`,
    );
  }
}

/**
 * The `StartupResult` for a startup that failed unexpectedly - crashed, or skipped
 * because the shutdown it followed did - carrying the error. A bulk startup's own crash
 * spreads it and adds what it had started.
 */
export function crashedStartupResult(
  error: Error | undefined,
  reason: string,
  durationMS = 0,
): StartupResult {
  return {
    ...refusedStartupResult(
      isOperationTimeoutValidationError(error)
        ? 'invalid_options'
        : 'operation_crashed',
      reason,
      durationMS,
    ),
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
): ShutdownResult {
  return {
    success: false,
    stoppedComponents: [],
    stalledComponents: [],
    durationMS: 0,
    reason,
    code: isOperationTimeoutValidationError(error)
      ? 'invalid_options'
      : 'operation_crashed',
    error,
  };
}

/**
 * The `SignalBroadcastResult` for a `trigger*()` call that failed as a whole - its
 * custom `on*Requested` callback threw or rejected, or the call itself crashed - so
 * there are no per-component results to report.
 */
export function crashedSignalBroadcastResult(
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
): HealthCheckResult {
  return {
    name,
    healthy: false,
    checkedAt: Date.now(),
    durationMS: 0,
    error,
    timedOut: false,
    code: 'error',
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
): ComponentOperationResult {
  return {
    success: false,
    componentName: name,
    reason,
    code: isOperationTimeoutValidationError(error)
      ? 'invalid_options'
      : 'operation_crashed',
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
