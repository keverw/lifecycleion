import { describeError, toError } from '../to-error';
import { reportToConsole } from './report-to-console';

/**
 * A caller's handler for one kind of failure, and the reporter that feeds it.
 *
 * Two channels in this library report the same shape - `onRedactionError` and
 * `onRenderError` - and they had the same body written out twice, differing only in two
 * identifiers and two message strings. That is the duplication `report-to-console` argues
 * against for its own rung: *the guarantee is one rule*, and a copy of it that someone
 * forgets to update is how a channel comes to be subtly less safe than its twin.
 *
 * The channels keep their own names, types and documentation - a redaction failure and a
 * render failure are different things to a caller, and `subject` means a redaction entry
 * in one and a path in the other - but the rungs beneath them are this one function.
 */
export type FailureHandler = (error: Error, subject: string) => void;

/** Reports one failure. Never throws, and fires at most once per operation. */
export type ReportFailure = (error: unknown, subject: string) => void;

/**
 * Build a reporter for one operation: a handler, then the console, then nothing.
 *
 * The three rungs every failure channel in this library uses. What varies between callers
 * is only the label in the console line and what `subject` names; the guarantees do not.
 *
 * **Deliberately not the global `'error'` channel**, which is where callback failures go.
 * Reporting there would loop: `logger.registerReportErrorListener()` listens on that
 * channel and logs what it hears, logging renders a message and redacts its params, and
 * rendering or redacting is what just failed. Each pass is a fresh turn, so no re-entrancy
 * guard closes it. A dedicated callback that cannot re-enter the thing that failed is the
 * same answer `onEventHandlerError` reaches for.
 *
 * **Fires at most once per operation**, and that bound is the point rather than a nicety.
 * These failures are raised per *value*, so one broken function or one hostile payload
 * would otherwise report thousands of times, on a path whose whole job is to stay out of
 * the way. The first failure carries the cause and the subject; the markers left in the
 * output show the full extent.
 *
 * **Nothing here may throw.** It runs while something has already gone wrong, often while
 * the process is shutting down and stdout is closing, and every caller reaches it from
 * inside a `catch` whose purpose is to keep a failure from escaping. A throw from the
 * reporter would replace the failure being reported with a second one, raised out of a
 * call that was only trying to describe the first. So the handler is guarded, the console
 * rung is `reportToConsole`, and the normalization is guarded too.
 *
 * @param label   Names the operation in the console line - `'Redaction'`, `'Render'`.
 * @param handler Called with the first failure. Defaults to `console.error`. A handler
 *                that throws falls back to the console, as `onSinkError` does: a handler
 *                for failures must not be able to turn one into two.
 */
export function createFailureReporter(
  label: string,
  handler?: FailureHandler,
): ReportFailure {
  let didReport = false;

  return (error: unknown, subject: string): void => {
    if (didReport) {
      return;
    }

    didReport = true;

    // Normalized rather than trusted: the value reaching here was thrown by caller code -
    // a `redactFunction`, a getter, a trap, a `toString` - and is free to be any value at
    // all, while `FailureHandler` declares an `Error`.
    let failure: Error;

    try {
      failure = toError(error);
    } catch {
      failure = new Error(`${label} failed`);
    }

    if (handler !== undefined) {
      try {
        handler(failure, subject);

        return;
      } catch {
        // Fall through to the console, as `handleSinkError` does for its own callback.
      }
    }

    // The only channel that cannot re-enter here, and guarded by `reportToConsole`: this
    // must not throw out of whatever was logging, rendering or redacting.
    //
    // `describeError`, not `failure.message`. `toError` returns an `Error` unchanged, so
    // `message` is whatever accessor the caller's own thrown value carries - and a
    // template literal is evaluated *before* the call, so an unguarded read there would
    // throw outside `reportToConsole` rather than inside it.
    reportToConsole(`${label} failed for ${subject}: ${describeError(failure)}`);
  };
}
