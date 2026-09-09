/**
 * Write to `console.error` without letting it throw.
 *
 * This is the last rung of every reporting path in the library - what runs once a caller's
 * `onSinkError`, `onEventHandlerError`, `onRedactionError`, or `'error'` listener is
 * absent or has itself failed. Being last is precisely what makes an unguarded call here
 * dangerous: there is nothing above it left to catch, so the failure it was reporting is
 * replaced by a second one thrown from the reporter.
 *
 * `console.error` is not a safe call. It is an ordinary mutable property on an ordinary
 * global, and two ordinary situations make it throw:
 *
 * - **A closed or broken stdout.** Node raises `EPIPE` when writing to a pipe whose reader
 *   has gone - `| head`, a supervisor that exited first - and a stream destroyed during
 *   shutdown throws on write. That is exactly when this rung runs in a lifecycle library:
 *   sinks are closing, handlers are being torn down, and the process is on its way out.
 * - **A test harness that replaces it.** Patching `console.error` to throw so an
 *   unexpected warning fails the build is a common setup, and this package's own
 *   `console-test-utils` replaces it too.
 *
 * The escape was real at four call sites and not merely theoretical: `Logger`'s
 * `handleEventHandlerFailure` and `handleSinkError` both reach here from a `catch` that
 * `handleLog` runs synchronously - so a throw left `logger.info()` - and from a
 * `result.catch(...)` on a sink's promise, where it became an unhandled rejection.
 * `Logger`'s global `'error'` listener reached here from the guard whose stated job is to
 * stop a throw terminating the process, and a throw here also skipped the
 * `preventDefault()` below it, leaving the report uncancelled. `NamedPipeSink.handleError`
 * reached here from a Node stream `'error'` handler, where a throw is an uncaught
 * exception, and from `initializePipe`'s promise, which the constructor starts with no
 * `.catch`.
 *
 * Shared rather than a sixth inline `try`/`catch`, for the reason `toError` and
 * `isPlainContainer` are shared: the guarantee is one rule - *reporting a failure may
 * never raise one* - and a copy of it that someone forgets to write is how four of these
 * came to be missing while two had it.
 *
 * @param args Passed through to `console.error` verbatim, so a caller that wants an
 *             `Error` inspected rather than stringified can still hand one over.
 */
export function reportToConsole(...args: unknown[]): void {
  try {
    // eslint-disable-next-line no-console -- this function is the console rung itself
    console.error(...args);
  } catch {
    // Nothing left to try, which is the whole point of this being the last rung. A
    // missing `console`, a replaced `error` that is not a function, and a write to a
    // broken pipe all land here, and all of them are quieter than the alternative.
  }
}
