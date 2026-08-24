import { errorToString } from './error-to-string';
import { isPromise } from './is-promise';
import { isFunction } from './is-function';
import { DOUBLE_EOL } from './constants';
import { installGlobalEventTarget } from './global-event-target';

// Node.js has a global `ErrorEvent` constructor (Node 25+) but does not make `globalThis`
// an EventTarget, so the global event methods must be supplied before anything can be
// dispatched or listened for. No-op in browsers, Bun, and Deno.
installGlobalEventTarget();

/**
 * Report a callback failure using Lifecycleion's `'reportError'` convention: an `ErrorEvent`
 * dispatched through `globalThis.dispatchEvent()`.
 *
 * Silently does nothing when the environment provides neither native nor polyfilled global
 * event primitives (see `global-event-target`).
 */
function reportCallbackError(callbackName: string, error: Error): void {
  const globalRecord = globalThis as unknown as Record<string, unknown>;

  if (
    typeof globalRecord.dispatchEvent !== 'function' ||
    typeof globalRecord.ErrorEvent !== 'function'
  ) {
    return;
  }

  (
    globalThis as unknown as {
      dispatchEvent: (event: Event) => void;
    }
  ).dispatchEvent(
    new ErrorEvent('reportError', {
      error: new Error(
        `Error in a callback ${callbackName}: ${DOUBLE_EOL}${errorToString(error)}`,
      ),
    }),
  );
}

/**
 * Safely handles a callback function by catching any errors and reporting them via
 * Lifecycleion's `'reportError'` reporting convention, built from web-standard primitives
 * (`ErrorEvent` + global `EventTarget` methods).
 * This function can seamlessly handle both synchronous and asynchronous (Promise-based) callback functions.
 *
 * Errors are dispatched as ErrorEvent objects with type 'reportError' via `globalThis.dispatchEvent()`.
 * You can listen for these errors using `globalThis.addEventListener('reportError', handler)`.
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
  const handleError = (error: Error): void => {
    reportCallbackError(callbackName, error);
  };

  if (isFunction(callback)) {
    try {
      // We need to cast callback to the appropriate function type now
      const result = (callback as (...args: unknown[]) => unknown)(...args);

      if (isPromise(result)) {
        // Fire-and-forget async callback
        result.catch((error: unknown) => {
          handleError(error as Error);
        });
      }
    } catch (error) {
      handleError(error as Error);
    }
  } else {
    handleError(
      new Error(`Callback provided for ${callbackName} is not a function`),
    );
  }
}

interface CallbackResult<T> {
  success: boolean;
  value?: T;
  error?: Error;
}

/**
 * Safely handles a callback function by catching any errors and reporting them via
 * Lifecycleion's `'reportError'` reporting convention, built from web-standard primitives
 * (`ErrorEvent` + global `EventTarget` methods).
 * This function can seamlessly handle both synchronous and asynchronous (Promise-based) callback
 * functions, and it waits for the callback to complete before returning the result or an error.
 *
 * Errors are dispatched as ErrorEvent objects with type 'reportError' via `globalThis.dispatchEvent()`.
 * You can listen for these errors using `globalThis.addEventListener('reportError', handler)`.
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
  const handleError = (error: Error): CallbackResult<T> => {
    reportCallbackError(callbackName, error);

    return { success: false, error };
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
      return handleError(error as Error);
    }
  } else {
    return handleError(
      new Error(`Callback provided for ${callbackName} is not a function`),
    );
  }
}
