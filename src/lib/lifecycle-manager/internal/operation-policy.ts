import { describeError, toError } from '../../to-error';
import { reportCallbackError } from '../../safe-handle-callback';
import { readMember } from '../../internal/read-member';
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

// The members of a public result that hold further results, or entries with an `error`.
// Only these are walked: everything else a result carries - `data`, `value`, a health
// check's `details` - is the caller's, and reading into it would run caller code.
const NESTED_RESULT_KEYS = [
  'startResult',
  'shutdownResult',
  'startupResult',
  'components',
  'results',
  'failedOptionalComponents',
  'stalledComponents',
] as const;

/**
 * Drop the brand from every refusal a public result hands its caller. The brand only
 * routes a refusal through this manager's own settlement; once the error is the
 * caller's, it is a value like any other. Rethrown from a getter or hook, it is that
 * code's failure - reported and answered `operation_crashed` - not this manager's option
 * refusal. The result keeps the same error instance.
 */
function releaseRefusalBrands(result: unknown, depth = 0): void {
  if (depth > 3 || typeof result !== 'object' || result === null) {
    return;
  }
  if (Array.isArray(result)) {
    for (const entry of result) {
      releaseRefusalBrands(entry, depth + 1);
    }
    return;
  }
  const record = result as Record<string, unknown>;
  operationOptionRefusals.delete(record.error as Error);
  for (const key of NESTED_RESULT_KEYS) {
    releaseRefusalBrands(record[key], depth + 1);
  }
}

/** How many `cause` links {@link isLinkedToAbort} follows past the thrown value itself. */
const ABORT_LINK_MAX_CAUSE_HOPS = 16;

/**
 * Whether a hook's failure is the abort of the signal it was handed - so the manager may
 * answer it as the interruption it asked for, rather than as a failure of its own. Linked
 * means the thrown value is `reason` itself, or an `AbortError` (`name`; the
 * `DOMException` `fetch` and timers reject with, or a library's own), or carries either
 * on its `cause` chain - a library wrapping the reason, or the `AbortError` its own
 * cancellable call threw. Anything else is a failure unrelated to the abort, and is
 * reported as it would be had the signal never aborted.
 *
 * The thrown value is the component's, so every member is read through `readMember()`:
 * a getter that throws, or a `Proxy` that refuses, reads as absent - not linked - and
 * ends the walk. The walk follows at most {@link ABORT_LINK_MAX_CAUSE_HOPS} links, and
 * stops at a value it has already visited, so a cyclic or endless chain cannot hold the
 * failure path. A reason buried deeper than that is not recognized: the failure is
 * reported as the error it reads as.
 */
export function isLinkedToAbort(thrown: unknown, reason: unknown): boolean {
  const visited: unknown[] = [];
  let current = thrown;
  for (let hop = 0; ; hop++) {
    if (current === reason) {
      return true;
    }
    if (
      current === null ||
      (typeof current !== 'object' && typeof current !== 'function')
    ) {
      return false;
    }
    // Compared by identity: a cycle ends the walk without reading its links again.
    for (const seen of visited) {
      if (seen === current) {
        return false;
      }
    }
    visited.push(current);
    if (readMember(current, 'name') === 'AbortError') {
      return true;
    }
    if (hop === ABORT_LINK_MAX_CAUSE_HOPS) {
      return false;
    }
    current = readMember(current, 'cause');
  }
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
 * A component's boolean option as the operation about to use it reads it - `true` or
 * `false`, nothing else. The constructor validates it too, but the property is the
 * component's and can be redefined after construction: anything other than a boolean
 * is refused as this manager's own option refusal (`invalid_options`), as an invalid
 * component timeout is, rather than read as truthy or falsy.
 */
export function toOperationFlag(requested: unknown, label: string): boolean {
  if (typeof requested !== 'boolean') {
    throw invalidOperationOptionError(`${label} must be a boolean`);
  }
  return requested;
}

/**
 * The `ShutdownResult` for a stop that stopped nothing at all: no component stopped or
 * stalled, and a code and reason saying why. By default, the refusal
 * `acceptShutdownPass()` returns when it will not run a pass because one is already
 * running - whether the latch was already set on entry or was taken by a nested request
 * while this one was still being set up. Shared so the refusals cannot drift into
 * reporting different things for the same situation.
 */
export function refusedShutdownResult(
  code: NonNullable<ShutdownResult['code']> = 'already_in_progress',
  reason = 'Shutdown already in progress',
): ShutdownResult {
  return {
    success: false,
    stoppedComponents: [],
    stalledComponents: [],
    durationMS: 0,
    reason,
    code,
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
 * refusal. A refusal stops being one once it is handed back: the brand is dropped from
 * the errors the result carries (see {@link releaseRefusalBrands}).
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
    const result = await run();
    releaseRefusalBrands(result);
    return result;
  } catch (error) {
    // Classified once, here, beside the decision not to report: a builder that chose
    // its own code could label an unreported refusal as a crash.
    if (settledFailureCode(error) === 'invalid_options') {
      operationOptionRefusals.delete(error as Error);
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
type SettledFailureCode = 'invalid_options' | 'operation_crashed';

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
