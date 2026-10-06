import { applyIntrinsic } from './intrinsics';

/**
 * Write to `console.error` without letting it throw.
 *
 * This is the last rung of every reporting path in the library - what runs once a caller's
 * sink error callback, `onFormatError`, logger diagnostic, or `'error'` listener is
 * absent or has itself failed. Being last is precisely what makes an unguarded call here
 * dangerous: there is nothing above it left to catch, so the failure it was reporting is
 * replaced by a second one thrown from the reporter.
 *
 * `console.error` is not a safe call. It is an ordinary mutable property on an ordinary
 * global, and ordinary situations make it throw synchronously:
 *
 * - **A replaced or missing console.** Patching `console.error` to throw so an unexpected
 *   warning fails the build is a common setup, and this package's own `console-test-utils`
 *   replaces it too. A runtime or sandbox without a usable `console` throws on the call.
 * - **A console implementation that throws on write.** A custom console, or a runtime
 *   whose console writes synchronously to a destination that refuses the write, throws
 *   out of the call. That is most likely when this rung runs in a lifecycle library:
 *   sinks are closing, handlers are being torn down, and the process is on its way out.
 *
 * Only a synchronous throw is contained here. On Node, a write to a stdout or stderr pipe
 * whose reader has gone - `| head`, a supervisor that exited first - does not throw: the
 * `EPIPE` arrives later as an `'error'` event on `process.stdout` / `process.stderr`, out
 * of reach of this `try`, exactly as it does for a plain `console.log`. With no listener
 * for that event, Node treats it as an uncaught exception. The library installs no
 * listener on the process's standard streams, since what a broken pipe should mean for
 * the process is the application's decision; an application that runs with its output
 * piped handles it there, for example with `process.stdout.on('error', ...)`.
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
    // Applied rather than spread: a spread goes through the live
    // `Array.prototype[Symbol.iterator]`, and a patched iterator would silently turn
    // off the one reporter that nothing else backs up.
    // eslint-disable-next-line no-console -- this function is the console rung itself
    applyIntrinsic(console.error, console, args);
  } catch {
    // Nothing left to try, which is the whole point of this being the last rung. A
    // missing `console`, a replaced `error` that is not a function, and a console that
    // throws on write all land here, and all of them are quieter than the alternative.
  }
}
