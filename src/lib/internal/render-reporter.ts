import { createFailureReporter } from './failure-reporter';

/**
 * Notified when a value could not be rendered.
 *
 * Rendering degrades rather than failing: a value that refuses to be read is replaced with
 * a marker - `<unrenderable: keys>`, `[unrenderable: value]`, `<unserializable: text>` - and the render
 * carries on, so one bad value never costs an error its `message`, `name` and `stack`. The
 * marker says *that* something refused and which half of it did, never *why*, and the
 * thrown error was discarded - so a payload with one throwing accessor left a marker in
 * one cell and nothing to trace it with.
 *
 * This is the diagnostic half, and the pairing is deliberate: the markers stay in the
 * output, the causes come here. Redaction has had this arrangement since
 * `onRedactionError`; rendering was the surface that still dropped its causes.
 *
 * @param error The failure, normalized to an `Error`. The original is on `cause`.
 *              **May contain the value.** It came from the caller's own getter, `toString`,
 *              `Symbol.toPrimitive` or `Proxy` trap, all of which are handed the value and
 *              free to put it in the message - a
 *              `throw new Error('cannot read ' + this.password)` carries it verbatim, and
 *              so does a bare `throw value`. That is precisely why the *marker* never
 *              carries it: a cause in the rendered output would travel to every sink, past
 *              `redactedKeys` and `sensitiveFieldNames`. Here it reaches one handler that
 *              asked for it. The library never puts a value in one of these, and `path` is
 *              always structural, but this handler and the default `console.error` are
 *              only as safe as the caller's own message.
 * @param path  Where it happened, as the renderer addresses it - `additionalInfo.user.token`,
 *              `items[0]`, or a bracketed `<params>`-style name for a whole input. Never a
 *              value, only a location.
 */
export type RenderErrorHandler = (error: Error, path: string) => void;

/** Reports one render failure. Never throws, and fires at most once per operation. */
export type ReportRenderFailure = (error: unknown, path: string) => void;

/**
 * Build the reporter for one render.
 *
 * **Deliberately not the global `'error'` channel**, for the reason `onRedactionError` is
 * not either. Reporting there would loop: `logger.registerReportErrorListener()` listens on
 * that channel and logs what it hears, logging renders a message, and rendering is what
 * just failed. Each pass is a fresh turn, so no re-entrancy guard closes it. A dedicated
 * callback that cannot re-enter the thing that failed is the same answer
 * `onEventHandlerError` and `onRedactionError` already reach for.
 *
 * **Fires at most once per render**, and that bound is the point rather than a nicety. A
 * failure is raised per *value*, so a payload of ten thousand entries behind one broken
 * `Proxy` would otherwise report ten thousand times, on a path whose whole job is to stay
 * out of the way. The first failure carries the cause and the path; the markers left in the
 * output show the full extent.
 *
 * A render, not a log call: `logger.errorObject()` renders twice - once for the error,
 * once for the params - so it can report twice, exactly as it can redact twice. Those are
 * two genuinely different failures in two different values, and collapsing them would hide
 * one.
 *
 * **Nothing here may throw.** This runs while something has already gone wrong, often
 * while the process is shutting down and stdout is closing, and every caller reaches it
 * from inside a `catch` whose whole purpose is to keep a failure from escaping. A throw
 * from the reporter would replace the failure being reported with a second one, out of a
 * `logger.info()` or a `console.error` that was only trying to describe the first. So the
 * handler is guarded, the console rung is `reportToConsole`, and the normalization is
 * guarded too.
 *
 * @param handler Called with the first failure; see `createFailureReporter` for where a
 *                failure goes when none is given. A handler
 *                that throws falls back to the console, as `onSinkError` and
 *                `onRedactionError` do: a handler for failures must not be able to turn
 *                one into two.
 */
export function createRenderReporter(
  handler?: RenderErrorHandler,
): ReportRenderFailure {
  // The shared rungs. What is specific to this channel is its types, its documentation and
  // the label in the console line; the guarantees beneath are one implementation.
  return createFailureReporter('Render', handler);
}

/**
 * A reporter that discards everything, for a render that was given no handler and no need.
 *
 * The default for every internal entry point, so the no-options path allocates nothing:
 * a real reporter is built only where a caller asked for one. Also used where a nested
 * render has already reported, so the same failure is not counted twice against the
 * once-per-render budget.
 */
export const NOOP_RENDER_REPORTER: ReportRenderFailure = () => {
  // Intentionally empty.
};
