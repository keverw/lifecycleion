import { errorToString } from './error-to-string';
import { isPromise } from './is-promise';
import { isFunction } from './is-function';
import { toError } from './to-error';
import { DOUBLE_EOL } from './constants';
import { installGlobalEventTarget } from './global-event-target';
import { reportToHost } from './internal/report-to-host';

// Node.js has a global `ErrorEvent` constructor (Node 25+) but does not make `globalThis`
// an EventTarget, so the global event methods must be supplied before anything can be
// dispatched or listened for. No-op in browsers, Bun, and Deno.
installGlobalEventTarget();

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
 * `onFormatError`; the logger then rendered the already-rendered table a second time,
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
    //
    // Renders `report`, not `error`. `errorToString` emits rows only for an object, so a
    // non-object throw - `throw 'boom'`, `throw 42`, a rejected promise carrying a string -
    // rendered as a three-line empty table with the thrown value nowhere in it. The
    // wrapper is always an `Error`, and `errorToString` renders its `cause`, so `'boom'`
    // and `42` come back on the `Cause` row. The two exceptions are `throw null` and
    // `throw undefined`: `addErrorTail` emits the row only for a `cause` that is neither,
    // so those render as the wrapper alone - the message still names the callback.
    () =>
      `Error in a callback ${callbackName}: ${DOUBLE_EOL}${errorToString(report)}`,
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
      //
      // Adopted through `Promise.resolve` rather than calling `result.catch` directly, as
      // `ArraySink` does and for the same reason: `isPromise` accepts any thenable, and a
      // `then`-only one has no `catch`. Calling it threw a `TypeError` that the
      // surrounding `catch` reported *in place of* the real failure - and because `then`
      // was never called, the callback's actual rejection was dropped and went nowhere.
      // Every untrusted-callback surface funnels through here: `safeHandleCallback`,
      // `EventEmitter`, `ProcessSignalManager`, `LRUCache.onChange`,
      // `PromiseProtectedResolver`.
      void Promise.resolve(result).catch(onError);
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
