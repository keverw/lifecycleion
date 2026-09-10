import { describeError, toError } from '../to-error';
import { reportToHost } from './report-to-host';

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
 * With no handler, the report goes to the standard global `'error'` channel - the same
 * three rungs `safe-handle-callback` uses, so a `logger.registerReportErrorListener()`
 * picks it up and logs it properly, falling through to the console when nothing claims it.
 * That is what anyone with a logger actually wants, and a console line nobody reads is a
 * poor consolation prize.
 *
 * **A caller that runs inside logging must not leave this to the default.** Broadcasting
 * from there is a loop: the listener logs what it hears, logging renders and redacts, and
 * rendering or redacting is what just failed. Every such caller therefore passes a handler
 * always - the user's if they set one, and a console-writing one if they did not - so this
 * function never reaches its broadcast rung on their behalf. `Logger` and `ArraySink` both
 * do exactly that; see `Logger.reportFailureToConsole`.
 *
 * The one gap that leaves is a caller's *own* sink or formatter calling `stringifyValue`
 * directly: that is inside a log call while looking exactly like standalone use, so it
 * would broadcast and could cycle. Documented rather than defended - defending it needs
 * cross-module global state, and the machinery cost more than the hazard.
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

    // `describeError`, not `failure.message`. `toError` returns an `Error` unchanged, so
    // `message` is whatever accessor the caller's own thrown value carries - and a
    // template literal is evaluated *before* the call, so an unguarded read there would
    // throw outside the guard rather than inside it.
    const line = `${label} failed for ${subject}: ${describeError(failure)}`;

    // The standard channel, so a listening logger records this the way it records a
    // callback failure. `reportToHost` ends on the guarded console rung itself when
    // nothing claims the event, so a process with no listener behaves exactly as before.
    // The cause travels on `cause`; the pre-rendered line is for that console rung.
    reportToHost(
      new Error(`${label} failed for ${subject}`, { cause: failure }),
      () => line,
    );
  };
}
