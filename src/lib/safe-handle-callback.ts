import { errorToString } from './error-to-string';
import { isPromise } from './is-promise';
import { isFunction } from './is-function';
import { toError } from './to-error';
import { DOUBLE_EOL } from './constants';
import { installGlobalEventTarget } from './global-event-target';
import { reportToConsole } from './internal/report-to-console';

// Node.js has a global `ErrorEvent` constructor (Node 25+) but does not make `globalThis`
// an EventTarget, so the global event methods must be supplied before anything can be
// dispatched or listened for. No-op in browsers, Bun, and Deno.
installGlobalEventTarget();

/**
 * Read a global without trusting it: a global can be an accessor that throws, and these
 * run on an error path that must not raise one of its own.
 */
function readGlobal(name: string): unknown {
  try {
    return (globalThis as unknown as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * Outcome of the `ErrorEvent` dispatch rung.
 *
 * - `handled` - dispatched, and a listener called `preventDefault()`.
 * - `unhandled` - dispatched, but nothing claimed it.
 * - `unavailable` - the primitives are missing, or dispatching threw.
 */
type DispatchOutcome = 'handled' | 'unhandled' | 'unavailable';

/**
 * Dispatch `error` as a standard `'error'` `ErrorEvent` on the global object.
 *
 * `cancelable: true` is required, not decorative: `EventInit.cancelable` defaults to
 * `false`, and `preventDefault()` on an uncancelable event is a no-op that leaves
 * `dispatchEvent()` returning `true` no matter what a listener does. Without it every
 * dispatch would read as `'unhandled'` and a consumer that logs the error itself — such
 * as `logger.registerReportErrorListener()` — could not suppress the console line.
 */
function dispatchErrorEvent(error: Error): DispatchOutcome {
  const dispatchEvent = readGlobal('dispatchEvent');
  const errorEventConstructor = readGlobal('ErrorEvent');

  if (
    !isFunction(dispatchEvent) ||
    typeof errorEventConstructor !== 'function'
  ) {
    return 'unavailable';
  }

  let event: Event;

  try {
    event = new (
      errorEventConstructor as new (type: string, init: ErrorEventInit) => Event
    )('error', {
      error,
      message: error.message,
      cancelable: true,
    });
  } catch {
    // The probe passed but the constructor is not one we can use, so nothing was
    // dispatched and the next rung should be tried.
    return 'unavailable';
  }

  try {
    // `.call` rather than a bare call: the polyfilled methods are already bound, but a
    // native `dispatchEvent` needs the global object as its receiver.
    return (dispatchEvent as (this: unknown, event: Event) => boolean).call(
      globalThis,
      event,
    ) === false
      ? 'handled'
      : 'unhandled';
  } catch {
    // Reported as `'unhandled'`, not `'unavailable'`: the event was constructed and
    // handed to `dispatchEvent`, so listeners may well have run. A throwing listener is
    // not what gets here — per spec a listener's exception does not propagate back into
    // `dispatchEvent`, and browsers, Bun 1.3.14 and Node 25 all honour that — but an
    // environment actively fighting us can still reject the event outright. Falling to
    // the console tail reports the error exactly once; falling to
    // `globalThis.reportError()` instead would report it a second time to whatever
    // already saw the dispatch.
    //
    // "Does not propagate" is not the same as "is harmless": outside a browser the
    // runtime treats that exception as uncaught and dies. Measured on Bun 1.3.14 and
    // Node 25.9.0, a listener that throws exits the process with code 1 while
    // `dispatchEvent` still returns normally. That is why every listener this library
    // installs catches its own failures rather than relying on the runtime to absorb
    // them; see `Logger.registerReportErrorListener`.
    return 'unhandled';
  }
}

/**
 * Report an error to the host on the standard `'error'` channel, dispatch first.
 *
 * The rungs, in order:
 *
 * 1. Dispatch `new ErrorEvent('error', { cancelable: true })` when the global object has
 *    `dispatchEvent` and `ErrorEvent`. A listener that calls `preventDefault()` owns the
 *    report and nothing further is written.
 * 2. `globalThis.reportError(error)` when dispatch is unavailable but the runtime provides
 *    the WHATWG reporting function.
 * 3. `console.error(error)`.
 *
 * Dispatch leads deliberately, rather than trying `reportError()` first as the WHATWG
 * "report an exception" algorithm would suggest:
 *
 * - Bun (measured on 1.3.14) provides `globalThis.reportError` but it writes to stderr
 *   without dispatching an `'error'` event, so a `reportError()`-first order would make
 *   Lifecycleion's own callback failures invisible to `addEventListener('error', ...)` —
 *   including `logger.registerReportErrorListener()` — on that runtime.
 * - In browsers, calling `reportError()` *after* a dispatch would notify the same
 *   listeners twice, since the native call dispatches an `'error'` event of its own.
 *
 * An unclaimed dispatch still falls through to `console.error`, mirroring the console
 * output a native `reportError()` produces when no listener cancels the event.
 */
function reportToHost(error: Error, renderForConsole?: () => string): void {
  // Also installed at module load, above. Repeating it here costs a few typeof checks on
  // an error path and makes reporting independent of whether a bundler kept that
  // top-level call, so a failure can never be swallowed for a packaging reason.
  installGlobalEventTarget();

  const outcome = dispatchErrorEvent(error);

  if (outcome === 'handled') {
    return;
  }

  if (outcome === 'unavailable') {
    const reportError = readGlobal('reportError');

    if (isFunction(reportError)) {
      try {
        (reportError as (this: unknown, error: unknown) => void).call(
          globalThis,
          // Rendered, like the console rung below it, and for the same reason: this rung
          // is only reached when dispatch is unavailable, so there is no listener to hand
          // the structured failure to - only a host that will print it. Handing over the
          // wrapper would hand over its `cause`, and a runtime's error inspection prints
          // an error's own properties, so an `additionalInfo` this library exists to mask
          // would reach stderr in the clear.
          renderedReport(error, renderForConsole),
        );

        return;
      } catch {
        // Fall through to the console: a reporting function that throws has not
        // reported anything.
      }
    }
  }

  // The last reporting rung, by design, and guarded by `reportToConsole`: neither
  // `safeHandleCallback` nor `safeHandleCallbackAndWait` may throw from this path.
  // `renderedReport` guards its own rendering and falls back to the error itself.
  reportToConsole(renderedReport(error, renderForConsole));
}

/**
 * What a rung that only prints should be handed.
 *
 * Rendering happens at these rungs and not in what gets dispatched. A rung that prints has
 * no `redactFunction` of its own, so it needs the rendered form; a listener does, and
 * handing it a pre-rendered string is what stopped a consumer from applying its own
 * redaction settings to the failure.
 */
function renderedReport(
  error: Error,
  renderForConsole?: () => string,
): string | Error {
  if (!renderForConsole) {
    return error;
  }

  try {
    return renderForConsole();
  } catch {
    // Fall back to the error itself rather than reporting nothing.
    return error;
  }
}

/**
 * Report a callback failure on the standard `'error'` channel. See {@link reportToHost}.
 *
 * Exported so a caller that catches its own callback failures can report them exactly the
 * way `safeHandleCallback` does — and so a caller that must *not* use this channel, such
 * as `Logger` reporting failures of its own `'logger'` handlers, has something concrete to
 * opt out of.
 *
 * `error` is `unknown`: `throw` and promise rejection both accept any value, and
 * `errorToString` renders whatever it is given.
 *
 * The thrown value travels on `cause` rather than rendered into the message. Rendering it
 * here settled questions that belong to whoever receives the report: it applied this
 * module's default masking, so a `Logger` with its own `redactFunction` could not use it;
 * it sent a broken `sensitiveFieldNames` to `console.error` instead of that logger's
 * `onRedactionError`; the logger then rendered the already-rendered table a second time,
 * one table nested inside another; and a structured sink reading `entry.error` had no way
 * back to the original. `errorToString` renders `cause`, so the wrapper still says
 * everything the pre-rendered form did - under the settings of whoever renders it.
 */
export function reportCallbackError(
  callbackName: string,
  error: unknown,
): void {
  const report = new Error(`Error in a callback ${callbackName}`, {
    cause: error,
  });

  reportToHost(
    report,
    // Only the console rung renders, and only if it is reached. `errorToString` guards
    // its own reads of the thrown value and returns `<error could not be rendered>`
    // rather than throwing; `reportToHost` catches regardless, because rendering must
    // never turn one failure into a second one thrown out of `safeHandleCallback`,
    // `safeHandleCallbackAndWait`, or `EventEmitterProtected.emit`.
    () =>
      `Error in a callback ${callbackName}: ${DOUBLE_EOL}${errorToString(error)}`,
  );
}

/**
 * Safely handles a callback function by catching any errors and reporting them on the
 * standard `'error'` channel (see {@link reportToHost}).
 * This function can seamlessly handle both synchronous and asynchronous (Promise-based) callback functions.
 *
 * Errors are dispatched as `ErrorEvent` objects of type `'error'` through
 * `globalThis.dispatchEvent()`. Listen for them with
 * `globalThis.addEventListener('error', handler)`, and call `event.preventDefault()` to
 * claim the report and suppress the `console.error` fall-through.
 *
 * Browsers, Bun, and Deno expose these globals natively. Node.js provides `ErrorEvent` (Node 25+)
 * but not the global event methods, so importing this module installs them via a shared
 * `EventTarget` (see `global-event-target`) without overwriting existing implementations.
 *
 * This function is a "fire-and-forget" type of function, meaning it doesn't wait
 * for the callback to complete and doesn't return any result or error. If you need
 * to handle the result or error of the callback, consider using the
 * `safeHandleCallbackAndWait` function instead.
 *
 * @param {string} callbackName - The name of the callback function, used for error reporting.
 * @param {unknown} callback - The callback function to be executed. It can be either a
 *                             synchronous function or a function that returns a Promise.
 * @param {...unknown[]} args - Additional arguments to pass to the callback function.
 */

export function safeHandleCallback(
  callbackName: string,
  callback: unknown,
  ...args: unknown[]
): void {
  runCallbackSafely(callbackName, callback, args, (error) => {
    reportCallbackError(callbackName, error);
  });
}

/**
 * Invoke a callback and route every way it can fail to `onError`.
 *
 * The one place that knows how to call an untrusted callback: it rejects a non-function,
 * catches a synchronous throw, and reports a rejection from a returned promise without
 * awaiting it. `safeHandleCallback` pairs it with {@link reportCallbackError}, and
 * `EventEmitterProtected.emit` pairs it with its own overridable reporter, so an emitter
 * that must stay off the global `'error'` channel (`Logger`) does not need a second copy
 * of this body.
 *
 * `onError` must not throw: it runs on the failure path, and there is nothing above it
 * left to catch.
 *
 * @param callbackName Used only for the "is not a function" message.
 * @param callback The untrusted value to invoke.
 * @param args Arguments to pass to the callback.
 * @param onError Receives the thrown value, the rejection reason, or a synthesized
 *                `Error` when `callback` is not callable.
 */
export function runCallbackSafely(
  callbackName: string,
  callback: unknown,
  args: unknown[],
  onError: (error: unknown) => void,
): void {
  if (!isFunction(callback)) {
    onError(
      new Error(`Callback provided for ${callbackName} is not a function`),
    );

    return;
  }

  try {
    // We need to cast callback to the appropriate function type now
    const result = (callback as (...args: unknown[]) => unknown)(...args);

    if (isPromise(result)) {
      // Fire-and-forget: a rejection is reported, never awaited.
      result.catch(onError);
    }
  } catch (error) {
    onError(error);
  }
}

interface CallbackResult<T> {
  success: boolean;
  value?: T;
  error?: Error;
}

/**
 * Safely handles a callback function by catching any errors and reporting them on the
 * standard `'error'` channel (see {@link reportToHost}).
 * This function can seamlessly handle both synchronous and asynchronous (Promise-based) callback
 * functions, and it waits for the callback to complete before returning the result or an error.
 *
 * Errors are dispatched as `ErrorEvent` objects of type `'error'` through
 * `globalThis.dispatchEvent()`. Listen for them with
 * `globalThis.addEventListener('error', handler)`.
 *
 * Browsers, Bun, and Deno expose these globals natively. Node.js provides `ErrorEvent` (Node 25+)
 * but not the global event methods, so importing this module installs them via a shared
 * `EventTarget` (see `global-event-target`) without overwriting existing implementations.
 *
 * @param {string} callbackName - The name of the callback function, used for error reporting.
 * @param {unknown} callback - The callback function to be executed. It can be either a
 *                             synchronous function or a function that returns a Promise.
 * @param {...unknown[]} args - Additional arguments to pass to the callback function.
 * @returns {Promise<CallbackResult<unknown>>} - A promise that resolves with an object containing
 *                                               the success status, value (if any), and error (if any).
 */

export async function safeHandleCallbackAndWait<T>(
  callbackName: string,
  callback: unknown,
  ...args: unknown[]
): Promise<CallbackResult<T>> {
  const handleError = (error: unknown): CallbackResult<T> => {
    reportCallbackError(callbackName, error);

    // Normalized, not cast: `CallbackResult.error` is declared `Error`, but `throw` and
    // promise rejection both accept any value, so a callback that throws `null` would
    // otherwise hand the caller a `null` typed as an `Error` and break
    // `result.error.message`. The original value stays reachable as `cause`.
    return { success: false, error: toError(error) };
  };

  if (isFunction(callback)) {
    try {
      // We need to cast callback to the appropriate function type now
      const result = (callback as (...args: unknown[]) => unknown)(...args);

      if (isPromise(result)) {
        // Wait for the async callback to complete
        const value = await (result as Promise<T>);

        return { success: true, value };
      } else {
        return { success: true, value: result as T };
      }
    } catch (error) {
      return handleError(error);
    }
  } else {
    return handleError(
      new Error(`Callback provided for ${callbackName} is not a function`),
    );
  }
}
