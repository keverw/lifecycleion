import { errorToString } from './error-to-string';
import { toError } from './to-error';
import { DOUBLE_EOL } from './constants';
import { installGlobalEventTarget } from './global-event-target';
import { reportToHost } from './internal/report-to-host';
import { adoptPromise, isAdoptable } from './internal/adopt-promise';
import { reportThroughHandler } from './internal/failure-reporter';

// Node.js has a global `ErrorEvent` constructor (Node 25+) but does not make `globalThis`
// an EventTarget, so the global event methods must be supplied before anything can be
// dispatched or listened for. No-op in browsers, Bun, and Deno.
installGlobalEventTarget();

// Re-exported so an integrator holding its own structured `Error` can publish it directly.
// `reportCallbackError` is a normalizer for raw thrown values; see `reportToHost`'s own
// docs for when each one applies. Imported above as well, because this module calls it.
export { reportToHost } from './internal/report-to-host';

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
 * **`this` is not preserved.** The callback is invoked without a receiver, so an extracted
 * method such as `logger.info` loses `logger` and any `this.x` inside it throws, arriving
 * as an ordinary callback failure rather than a `TypeError` at the call site. Pass
 * `() => logger.info(a, b)` or `logger.info.bind(logger)`. `runCallbackSafely` takes an
 * explicit `thisArg` if you need to keep using `args`.
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
 * `onError` should not throw, but a throw from it is contained rather than escaping: it
 * runs on the failure path, where there is nothing above it left to catch. A synchronous
 * throw would otherwise surface at an unrelated call site, and one from the promise rung
 * would be an unhandled rejection - fatal under Node's default
 * `--unhandled-rejections=throw`, which is the outcome this helper exists to prevent. Both
 * are caught and sent to the guarded console rung instead.
 *
 * **`this` is not preserved unless you pass `thisArg`.** The callback is invoked with the
 * receiver you supply, and with none by default. Passing an extracted method such as
 * `logger.info` therefore loses `logger`, and any `this.x` inside it throws - which
 * arrives as an ordinary callback failure on `onError`, not as a `TypeError` at the call
 * site, so a method that merely *reports* through this path can look like it ran. Pass
 * `thisArg`, or hand over `() => logger.info(a, b)` or `logger.info.bind(logger)`.
 *
 * @param callbackName Used only for the "is not a function" message.
 * @param callback The untrusted value to invoke.
 * @param args Arguments to pass to the callback.
 * @param onError Receives the thrown value, the rejection reason, or a synthesized
 *                `Error` when `callback` is not callable. It may be `async`: a promise it
 *                returns is followed, and a rejection lands on the console rung like a
 *                throw does.
 * @param thisArg Receiver to invoke `callback` with. Omit for a plain function or a
 *                closure; supply the owning object when passing an extracted method.
 */
export function runCallbackSafely(
  callbackName: string,
  callback: unknown,
  args: unknown[],
  onError: (error: unknown) => void,
  thisArg?: unknown,
): void {
  // `typeof`, not `isFunction()`: its `instanceof Function` fallback reads the value's
  // prototype, which throws for a revoked proxy - outside every guard here. Anything
  // callable is `typeof 'function'` anyway.
  if (typeof callback !== 'function') {
    reportToOnError(
      callbackName,
      new Error(`Callback provided for ${callbackName} is not a function`),
      onError,
    );

    return;
  }

  try {
    // `Reflect.apply` so an extracted method can still be given its receiver - and not
    // `callback.apply(...)`, which reads `apply` off the untrusted callback itself: one
    // with its own `apply` property would run that instead. With `thisArg` omitted this
    // is the same bare call as before.
    const result: unknown = Reflect.apply(
      callback as (...args: unknown[]) => unknown,
      thisArg,
      args,
    );

    if (isAdoptable(result)) {
      // Fire-and-forget: a rejection is reported, never awaited.
      //
      // Adopted through `adoptPromise()`, as `ArraySink` and the logger adopt theirs,
      // rather than calling `result.catch` directly: `isAdoptable` accepts any thenable,
      // and a `then`-only one has no `catch` - calling it threw a `TypeError` that the
      // surrounding `catch` reported *in place of* the real failure, and the callback's
      // actual rejection went nowhere. Nor through `Promise.resolve()`, which hands a
      // native promise back with its own properties, so a no-op own `then` swallowed
      // the rejection. Every untrusted-callback surface funnels through here:
      // `safeHandleCallback`, `EventEmitter`, `ProcessSignalManager`,
      // `LRUCache.onChange`, `PromiseProtectedResolver`.
      void adoptPromise(result).then(undefined, (error: unknown) => {
        reportToOnError(callbackName, error, onError);
      });
    }
  } catch (error) {
    reportToOnError(callbackName, error, onError);
  }
}

/**
 * Hand a callback's failure to `onError`, through the rung every supplied failure handler
 * in this library shares. `onError` is the last rung that can still describe the original
 * failure: a throw or rejection from it goes to the console alongside that failure rather
 * than replacing it or escaping, and a `then` on its return that cannot be read is not
 * mistaken for either. Module-level, so a callback that succeeds - every guarded log line
 * - allocates nothing for a failure it never had.
 */
function reportToOnError(
  callbackName: string,
  error: unknown,
  onError: (error: unknown) => void,
): void {
  reportThroughHandler(
    // Typed `void`, but an `async` handler returns a promise: one that rejects is
    // followed, not dropped as an unhandled rejection.
    () => onError(error),
    // Rendered, not passed raw: `console.error` of the error itself prints every
    // `additionalInfo` and `cause` field in the clear, which the masking in
    // `errorToString` - what `reportCallbackError()` renders with - exists to prevent.
    () =>
      `Error handler for ${callbackName} failed while reporting a failure${DOUBLE_EOL}` +
      `Original failure:${DOUBLE_EOL}${errorToString(error)}`,
    undefined,
    `onError for ${callbackName}`,
  );
}

/**
 * Outcome of {@link safeHandleCallbackAndWait}.
 *
 * A discriminated union, so `if (result.success)` narrows to the branch that carries
 * `value` and the `else` narrows to the one that carries `error`. Neither field needs a
 * non-null assertion after the check.
 *
 * Each branch declares the other's field as optional `undefined` rather than omitting it,
 * so reading `result.value` without narrowing first still type-checks - as `T | undefined`
 * - and existing callers that check `success` some other way keep compiling.
 *
 * `T` cannot be inferred - `callback` is typed `unknown`, so nothing in the call carries
 * the return type - and defaults to `unknown`. Supply it explicitly when you know what the
 * callback returns.
 */
export type CallbackResult<T = unknown> =
  | { success: true; value: T; error?: undefined }
  | { success: false; error: Error; value?: undefined };

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
 * **`this` is not preserved.** The callback is invoked without a receiver, so an extracted
 * method such as `logger.info` loses `logger` and any `this.x` inside it throws, arriving
 * as an ordinary callback failure rather than a `TypeError` at the call site. Pass
 * `() => logger.info(a, b)` or `logger.info.bind(logger)`. `runCallbackSafely` takes an
 * explicit `thisArg` if you need to keep using `args`.
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

  // `typeof`, for the reason `runCallbackSafely()` gives.
  if (typeof callback === 'function') {
    try {
      // `Reflect.apply` and `adoptPromise()`, as `runCallbackSafely()` calls and adopts:
      // one path for how an untrusted callback is invoked and how its promise is read.
      const result: unknown = Reflect.apply(callback, undefined, args);

      if (isAdoptable(result)) {
        // Wait for the async callback to complete
        const value = await adoptPromise<T>(result as PromiseLike<T>);

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
