import { describeError } from '../to-error';
import { createFailureReporter, type FailureHandler } from './failure-reporter';
import { reportToConsole } from './report-to-console';

/**
 * Which stage of formatting a value failed.
 *
 * Redaction and rendering used to be two callbacks, `onRedactionError` and
 * `onRenderError`, and the split did not survive inspection: both were handed
 * `(error, path)`, both built that path the same way - dot-joined segments, array indices
 * included, `<bracketed>` names for whole inputs - and both fired from the same walk over
 * the same value. The only thing that actually differed was *which stage* threw, which is
 * a discriminator rather than a second callback.
 *
 * Not `phase` or `stage`: those imply an order, and these interleave. A walk redacts a
 * container, renders its leaves, and descends to redact again.
 *
 * Which kinds a surface can raise depends on what it does. `errorToString`,
 * `stringifyValue`, `serializeError`, `curlyBrackets` and `Logger` raise `'redaction'` and
 * `'render'`; `'transform'` comes only from `ArraySink`, whose transformer runs after the
 * entry is otherwise formatted.
 */
export type FormatFailureKind = 'redaction' | 'render' | 'transform';

/**
 * Notified when a value could not be formatted for output.
 *
 * Formatting degrades rather than failing: a value that refuses to be read or masked is
 * replaced with a marker - `***REDACTION FAILED***`, `<unrenderable: keys>`,
 * `[unrenderable: value]`, `<unserializable: text>` - and the work carries on, so one bad
 * value never costs an error its `message`, `name` and `stack`, and a broken
 * `redactFunction` can never hide behind output that looks fine. The marker says *that*
 * something refused and which half of it did, never *why*, and the thrown error used to be
 * discarded - so a payload with one throwing accessor left a marker in one cell and nothing
 * to trace it with.
 *
 * This is the diagnostic half, and the pairing is deliberate: the markers stay in the
 * output, the causes come here.
 *
 * **Fires at most once per kind per operation.** The bound is the point rather than a
 * nicety: these failures are raised per *value*, so one broken function or one hostile
 * payload would otherwise report thousands of times, on a path whose whole job is to stay
 * out of the way. The first failure of each kind carries the cause and the path; the
 * markers left in the output show the full extent. A single render that fails both ways
 * therefore calls this twice - once with `'redaction'`, once with `'render'` - because
 * those are two genuinely different failures and collapsing them would hide one.
 *
 * @param error The failure, normalized to an `Error`. The original is on `cause`.
 *              **May contain the value.** It came from the caller's own `redactFunction`,
 *              getter, `toString`, `Symbol.toPrimitive` or `Proxy` trap, all of which are
 *              handed the value and free to put it in the message - a
 *              `throw new Error('cannot mask ' + value)` carries it verbatim, and so does a
 *              bare `throw value`. That is precisely why the *marker* never carries it: a
 *              cause in the formatted output would travel to every sink, past
 *              `redactedKeys` and `sensitiveFieldNames`. Here it reaches one handler that
 *              asked for it. The library never puts a value in one of these, and `path` is
 *              always structural, but this handler and the console fallback are only as
 *              safe as the caller's own message.
 * @param kind  Which stage threw. See {@link FormatFailureKind}.
 * @param path  Where it happened, as the walk addresses it - `additionalInfo.user.token`,
 *              `items.0`, or a bracketed `<params>`-style name for a whole input. Never a
 *              value, only a location.
 */
export type FormatErrorHandler = (
  error: Error,
  kind: FormatFailureKind,
  path: string,
) => void;

/** Reports one formatting failure. Never throws, and fires at most once per operation. */
export type ReportFormatFailure = (error: unknown, path: string) => void;

/** What the console rung calls each kind. */
const LABELS: Record<FormatFailureKind, string> = {
  redaction: 'Redaction',
  render: 'Render',
  transform: 'Transform',
};

/**
 * Build the reporter for one formatting operation.
 *
 * **Deliberately not the global `'error'` channel** when a handler is given, and see
 * `createFailureReporter` for where a failure goes when none is. Reporting there from
 * inside a log call would loop: `logger.registerReportErrorListener()` listens on that
 * channel and logs what it hears, logging redacts and renders, and redacting or rendering
 * is what just failed. Each pass is a fresh turn, so no re-entrancy guard closes it. A
 * dedicated callback that cannot re-enter the thing that failed is the same answer
 * `onEventHandlerError` reaches for.
 *
 * An operation, not a log call: `logger.errorObject()` formats twice - once for the error,
 * once for the params - so it can report twice per kind.
 *
 * **Nothing here may throw.** This runs while something has already gone wrong, often while
 * the process is shutting down and stdout is closing, and every caller reaches it from
 * inside a `catch` whose whole purpose is to keep a failure from escaping. A throw from the
 * reporter would replace the failure being reported with a second one, raised out of a call
 * that was only trying to describe the first. So the handler is guarded, the console rung is
 * `reportToConsole`, and the normalization is guarded too.
 *
 * @param kind    Which stage this reporter speaks for.
 * @param handler Called with the first failure. A handler that throws falls back to the
 *                console, as `onSinkError` does: a handler for failures must not be able to
 *                turn one into two.
 */
export function createFormatReporter(
  kind: FormatFailureKind,
  handler?: FormatErrorHandler,
): ReportFormatFailure {
  // The shared rungs. What is specific to this channel is its kind, its documentation and
  // the label in the console line; the guarantees beneath are one implementation.
  const bound: FailureHandler | undefined =
    handler === undefined
      ? undefined
      : (error: Error, path: string): void => {
          handler(error, kind, path);
        };

  return createFailureReporter(LABELS[kind], bound);
}

/**
 * A handler that writes to the console, for a caller that must always supply one.
 *
 * Anything running *inside* a log call has to pass a handler rather than leave the default
 * routing to decide: the no-handler rung reports on the global `'error'` channel, a
 * listening logger records what it hears, and logging redacts, renders and writes to sinks
 * - which is what just failed.
 */
export function consoleFormatHandler(): FormatErrorHandler {
  return (error: Error, kind: FormatFailureKind, path: string): void => {
    reportToConsole(
      `${LABELS[kind]} failed for ${path}: ${describeError(error)}`,
    );
  };
}

/**
 * A reporter that discards everything, for an operation given no handler and no need.
 *
 * The default for every internal entry point, so the no-options path allocates nothing: a
 * real reporter is built only where a caller asked for one. Also used where a nested walk
 * has already reported, so the same failure is not counted twice against the
 * once-per-operation budget.
 */
export const NOOP_FORMAT_REPORTER: ReportFormatFailure = () => {
  // Intentionally empty.
};
