import { describeError, toError } from '../to-error';
import { reportToConsole } from './report-to-console';
import { reportToHost } from './report-to-host';

/**
 * A caller's handler for one kind of failure, and the reporter that feeds it.
 *
 * The rungs every failure channel in this library stands on, written once. Redaction and
 * rendering each had this body copied out, differing only in two identifiers and two
 * message strings, which is the duplication `report-to-console` argues against for its own
 * rung: *the guarantee is one rule*, and a copy of it that someone forgets to update is how
 * a channel comes to be subtly less safe than its twin. Those two are now one public
 * callback - see `format-reporter` - and this stays the shared floor beneath it and beneath
 * `onSinkError` and `onEventHandlerError`.
 *
 * `subject` is whatever the caller's channel names a failure by: a redaction entry, a
 * render path, a sink context.
 */
export type FailureHandler = (error: Error, subject: string) => void;

/** Reports one failure. Never throws, and fires at most once per operation. */
export type ReportFailure = (error: unknown, subject: string) => void;

/**
 * The handler rung, for a channel whose handler does not take `(error, subject)`.
 *
 * `onSinkError` is handed `(error, context, sink)` and `onEventHandlerError` `(error,
 * event)`, so neither fits {@link ReportFailure} - but the rung beneath them is the same
 * rule as everywhere else, and it was hand-written once per channel. `invoke` is a closure
 * the caller builds over its own arguments, so the shape stays theirs and only the
 * guarantee is shared.
 *
 * Those two channels never reach a broadcast rung, and that is structural rather than an
 * omission: a sink failure and a `'logger'` handler failure can only happen *during* a log
 * call, and reporting from there anywhere a logger might hear it is how one failure becomes
 * a cycle - the listener logs it, logging writes to sinks and emits events, and that is
 * what just failed.
 *
 * @param invoke The caller's handler, already bound to its own arguments, or `undefined`
 *               when none was set.
 * @param line   What the console rung should say. Built by the caller, since only it knows
 *               what its arguments mean. Evaluated lazily so an unset handler that
 *               succeeds costs nothing.
 */
export function reportThroughHandler(
  invoke: (() => void) | undefined,
  line: () => string,
): void {
  if (invoke !== undefined) {
    try {
      invoke();

      return;
    } catch (handlerError) {
      // Both failures, not one. The handler's own throw is the news - it means the channel
      // the caller chose is broken and every later report will be lost the same way - but
      // the failure it was told about is what they actually needed, and reporting only the
      // handler's error would swallow it. `FileSink` said one and `Logger` said the other;
      // saying both is what neither did.
      //
      // The console, never a channel a logger might hear: a handler that just threw is no
      // argument for reaching past the caller for a louder rung.
      reportToConsole(
        `${line()} (the failure handler also threw: ${describeError(handlerError)})`,
      );

      return;
    }
  }

  reportToConsole(line());
}

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
 * **A caller that runs inside logging should not leave this to the default**, and the
 * reason is routing rather than danger. Broadcasting from there sends the report out to
 * the global channel and straight back into the logger that was already running, which is
 * a long way around to reach a rung the caller could have named itself - and it lands the
 * failure wherever a listener decides rather than where the caller asked for it. Every
 * such caller therefore passes a handler always - the user's if they set one, and a
 * console-writing one if they did not - so this function never reaches its broadcast rung
 * on their behalf. `Logger` and `ArraySink` both do exactly that; see
 * `Logger.formatErrorHandler`.
 *
 * What that leaves is bounded rather than open. A caller's *own* sink or formatter calling
 * `stringifyValue` directly is inside a log call while looking exactly like standalone use,
 * so it does broadcast - but `Logger`'s listener holds `_isHandlingReportedError` across
 * the whole of its own logging, so a report raised while it logs is dropped instead of
 * logged again. Verified: a sink whose formatter fails on every value it is given costs
 * two sink writes and stops.
 *
 * That guard is per-logger, so it does not bound *several* loggers that have each
 * registered a listener - each blocks only its own re-entry, and one failing log call then
 * costs `a(n) = n * a(n-1) + 1` sink writes, synchronously: 5 at two loggers, 326 at five,
 * 109,601 at eight. Left undefended on purpose. Registering the global listener is a
 * deliberate opt-in and only one listener can usefully claim a report, so one per process
 * is the ordinary shape; bounding the rest needs a process-wide re-entrancy flag on the
 * broadcast rung, which is machinery for a shape nobody builds.
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
 * @param handler Called with the first failure. A handler that throws falls back to the
 *                console - not to the channel below, which a handler's own failure is no
 *                reason to reach for - as `onSinkError` does: a handler for failures must
 *                not be able to turn one into two. With no handler at all, see the routing
 *                above.
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
      // The shared rung, so a handler that throws is answered the same way here as it is
      // for `onSinkError` and `onEventHandlerError`: the console, never the channel below.
      // A handler that just threw is no argument for broadcasting, and the caller who set
      // it has already said where they wanted these to go.
      reportThroughHandler(
        () => handler(failure, subject),
        () => `${label} failed for ${subject}: ${describeError(failure)}`,
      );

      return;
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
