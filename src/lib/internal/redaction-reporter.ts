import { describeError, toError } from '../to-error';
import { reportToConsole } from './report-to-console';

/**
 * Notified when redaction fails for a value.
 *
 * Redaction fails closed: the value is replaced with `***REDACTION FAILED***`, never left
 * in place. That marker is deliberately distinct from an ordinary mask, so a broken
 * `redactFunction` cannot hide behind output that looks fine - but it says only *that*
 * redaction failed, never why. The thrown error was discarded, so a redactor that throws
 * for one key out of forty left a marker in one slot and nothing to trace it with.
 *
 * This is the diagnostic half. The marker is unchanged; this is how the cause reaches you.
 *
 * @param error The failure, normalized to an `Error`. The original is on `cause`.
 *              **May contain the value.** It came from the caller's own `redactFunction`,
 *              which was handed the value and is free to put it in the message - a
 *              `throw new Error('cannot mask ' + value)` carries it verbatim, and so does
 *              a bare `throw value`. The library never puts a value in one of these, and
 *              `key` is always the entry as configured, but the handler and the default
 *              `console.error` are only as safe as the redactor's own message.
 * @param key   The redaction entry being applied, as the caller wrote it - `user.password`
 *              rather than the leaf `password`.
 */
export type RedactionErrorHandler = (error: Error, key: string) => void;

/** Reports one redaction failure. Never throws, and fires at most once per operation. */
export type ReportRedactionFailure = (error: unknown, key: string) => void;

/**
 * Build the reporter for one redaction operation.
 *
 * **Deliberately not the global `'error'` channel**, which is where every other failure in
 * this library goes. Reporting there would loop: `logger.registerReportErrorListener()`
 * listens on that channel and logs what it hears, logging renders a message, rendering
 * redacts, and redacting calls the same throwing `redactFunction` again. Each pass is a
 * fresh turn, so no re-entrancy guard closes it. `onEventHandlerError` exists for exactly
 * this shape of problem and takes the same approach: a dedicated callback, defaulting to
 * the console, that cannot re-enter the thing that failed.
 *
 * **Fires at most once per redaction pass**, and that bound is the point rather than a
 * nicety. A failure is raised per *leaf*, so a `redactFunction` that throws
 * unconditionally would otherwise report once for every value inside a named container -
 * thousands of lines for one broken function, on a path whose whole job is to stay out of
 * the way. The first failure carries the cause and the key; the markers left in the output
 * show the full extent.
 *
 * A pass, not a log call: `logger.errorObject()` redacts twice - once rendering the error,
 * once over the params - so it can report twice. Those are two genuinely different
 * failures in two different values, and collapsing them would hide one.
 *
 * @param handler Called with the first failure. Defaults to `console.error`. A handler
 *                that throws falls back to the console, as `onSinkError` does: a handler
 *                for failures must not be able to turn one into two.
 */
export function createRedactionReporter(
  handler?: RedactionErrorHandler,
): ReportRedactionFailure {
  let didReport = false;

  return (error: unknown, key: string): void => {
    if (didReport) {
      return;
    }

    didReport = true;

    // Normalized rather than trusted: a `redactFunction` is user code and free to throw
    // any value at all, and `RedactionErrorHandler` declares an `Error`.
    let failure: Error;

    try {
      failure = toError(error);
    } catch {
      failure = new Error('Redaction failed');
    }

    if (handler !== undefined) {
      try {
        handler(failure, key);

        return;
      } catch {
        // Fall through to the console, as `handleSinkError` does for its own callback.
      }
    }

    // The only channel that cannot re-enter here, and guarded by `reportToConsole`:
    // redaction must not throw out of whatever was logging.
    //
    // `describeError`, not `failure.message`. `toError` returns an `Error` unchanged, so
    // `message` is whatever accessor the caller's own thrown value carries - and a
    // template literal is evaluated *before* the call, so an unguarded read there would
    // throw outside `reportToConsole` rather than inside it.
    reportToConsole(`Redaction failed for ${key}: ${describeError(failure)}`);
  };
}

/**
 * A reporter that discards everything, for a call that was given no handler and no need.
 *
 * Used where a nested walk has already reported, so the same failure is not counted twice
 * against the once-per-operation budget.
 */
export const NOOP_REDACTION_REPORTER: ReportRedactionFailure = () => {
  // Intentionally empty.
};
