import { errorToString } from './error-to-string';
import { isPromise } from './is-promise';
import { isFunction } from './is-function';
import { DOUBLE_EOL } from './constants';

/**
 * Safely handles a callback function by catching any errors and reporting them
 * using the global `reportError` event (standard API available in Node.js 15+, Bun, Deno, and browsers).
 * This function can seamlessly handle both synchronous and asynchronous (Promise-based) callback functions.
 *
 * Errors are dispatched as ErrorEvent objects with type 'reportError' via `globalThis.dispatchEvent()`.
 * You can listen for these errors using `globalThis.addEventListener('reportError', handler)`.
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
    // Dispatch error using the standard reportError event API
    // Available in Node.js 15+, Bun, Deno, and browsers
    if (
      typeof (globalThis as Record<string, unknown>).dispatchEvent ===
      'function'
    ) {
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
 * Safely handles a callback function by catching any errors and reporting them
 * using the global `reportError` event (standard API available in Node.js 15+, Bun, Deno, and browsers).
 * This function can seamlessly handle both synchronous and asynchronous (Promise-based) callback
 * functions, and it waits for the callback to complete before returning the result or an error.
 *
 * Errors are dispatched as ErrorEvent objects with type 'reportError' via `globalThis.dispatchEvent()`.
 * You can listen for these errors using `globalThis.addEventListener('reportError', handler)`.
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
    // Dispatch error using the standard reportError event API
    // Available in Node.js 15+, Bun, Deno, and browsers
    if (
      typeof (globalThis as Record<string, unknown>).dispatchEvent ===
      'function'
    ) {
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
