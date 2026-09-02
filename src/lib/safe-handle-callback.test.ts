import { describe, expect, it } from 'bun:test';
import {
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from './safe-handle-callback';
import { sleep } from './sleep';

describe('safeHandleCallback', () => {
  it('should call a synchronous callback successfully', () => {
    let resultSaved = 0;

    const callbackName = 'syncCallback';

    const callback = (value: number): void => {
      resultSaved = value;
    };

    safeHandleCallback(callbackName, callback, 5);

    expect(resultSaved).toBe(5);
  });

  it('should call an asynchronous callback successfully', async () => {
    let resultSaved = 0;

    const callbackName = 'asyncCallback';

    const callback = async (A: number, B: number): Promise<void> => {
      await sleep(1);
      resultSaved = A + B;
    };

    safeHandleCallback(callbackName, callback, 5, 10);

    while (resultSaved === 0) {
      // Wait for the callback to be executed
      await sleep(1);
    }

    expect(resultSaved).toBe(15);
  });

  it('should handle errors in a synchronous callback', (done) => {
    const callbackName = 'syncCallbackWithError';

    const callback = (): void => {
      throw new Error('Sync error');
    };

    const errorHandler = (event: Event): void => {
      event.preventDefault();

      expect((event as ErrorEvent).error.message).toContain(
        'Error in a callback syncCallbackWithError',
      );

      expect((event as ErrorEvent).error.message).toContain('Sync error');

      done();
    };

    globalThis.addEventListener('error', errorHandler);

    safeHandleCallback(callbackName, callback);

    globalThis.removeEventListener('error', errorHandler);
  });

  it('should handle errors in an asynchronous callback', (done) => {
    const callbackName = 'asyncCallbackWithError';

    const callback = (): Promise<void> =>
      Promise.reject(new Error('Async error'));

    const errorHandler = (event: Event): void => {
      event.preventDefault();

      expect((event as ErrorEvent).error.message).toContain(
        'Error in a callback asyncCallbackWithError',
      );

      expect((event as ErrorEvent).error.message).toContain('Async error');

      globalThis.removeEventListener('error', errorHandler);
      done();
    };

    globalThis.addEventListener('error', errorHandler);
    safeHandleCallback(callbackName, callback);
  });

  it('should handle a non-function callback', (done) => {
    const callbackName = 'nonFunctionCallback';
    const callback = 123;

    const errorHandler = (event: Event): void => {
      event.preventDefault();

      expect((event as ErrorEvent).error.message).toContain(
        'Error in a callback nonFunctionCallback',
      );

      expect((event as ErrorEvent).error.message).toContain(
        'Callback provided for nonFunctionCallback is not a function',
      );

      done();
    };

    globalThis.addEventListener('error', errorHandler);

    safeHandleCallback(callbackName, callback);

    globalThis.removeEventListener('error', errorHandler);
  });
});

describe('safeHandleCallbackAndWait', () => {
  it('should call a synchronous callback successfully', async () => {
    const callbackName = 'syncCallback';

    const callback = (value: number): number => {
      return value * 2;
    };

    const result = await safeHandleCallbackAndWait(callbackName, callback, 5);

    expect(result.success).toBe(true);
    expect(result.value).toBe(10);
  });

  it('should call an asynchronous callback successfully', async () => {
    const callbackName = 'asyncCallback';

    const callback = async (A: number, B: number): Promise<number> => {
      await sleep(1);

      return A + B;
    };

    const result = await safeHandleCallbackAndWait(
      callbackName,
      callback,
      5,
      10,
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe(15);
  });

  it('should handle errors in a synchronous callback', async () => {
    const callbackName = 'syncCallbackWithError';

    const callback = (): void => {
      throw new Error('Sync error');
    };

    const errorHandler = (event: Event): void => {
      event.preventDefault();

      expect((event as ErrorEvent).error.message).toContain(
        'Error in a callback syncCallbackWithError',
      );
      expect((event as ErrorEvent).error.message).toContain('Sync error');
    };

    globalThis.addEventListener('error', errorHandler);

    const result = await safeHandleCallbackAndWait(callbackName, callback);

    globalThis.removeEventListener('error', errorHandler);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Sync error');
  });

  it('should handle errors in an asynchronous callback', async () => {
    const callbackName = 'asyncCallbackWithError';

    const callback = async (): Promise<void> => {
      await sleep(1);
      throw new Error('Async error');
    };

    const errorHandler = (event: Event): void => {
      event.preventDefault();

      expect((event as ErrorEvent).error.message).toContain(
        'Error in a callback asyncCallbackWithError',
      );

      expect((event as ErrorEvent).error.message).toContain('Async error');
    };

    globalThis.addEventListener('error', errorHandler);

    const result = await safeHandleCallbackAndWait(callbackName, callback);

    globalThis.removeEventListener('error', errorHandler);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Async error');
  });

  it('should handle a non-function callback', async () => {
    const callbackName = 'nonFunctionCallback';
    const callback = 123;

    const result = await safeHandleCallbackAndWait(callbackName, callback);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toBe(
      'Callback provided for nonFunctionCallback is not a function',
    );

    // Check if the error is reported on the standard 'error' channel
    const errorHandler = (event: Event): void => {
      event.preventDefault();

      const errorMessage = (event as ErrorEvent).error.message;
      expect(errorMessage).toContain(
        'Callback provided for nonFunctionCallback is not a function',
      );
    };

    globalThis.addEventListener('error', errorHandler);

    // Trigger the error event
    globalThis.dispatchEvent(new ErrorEvent('error', { error: result.error }));

    globalThis.removeEventListener('error', errorHandler);
  });
});

describe('safeHandleCallback error channel', () => {
  /**
   * `console.error` is swapped rather than `dispatchEvent`: a stubbed dispatch would
   * report whatever boolean the stub chose, so code that forgot `cancelable: true` would
   * pass against it. These assertions run against the real global EventTarget.
   */
  function withCapturedConsoleError<T>(run: (captured: unknown[][]) => T): T {
    const captured: unknown[][] = [];
    const original = console.error;

    console.error = (...args: unknown[]): void => {
      captured.push(args);
    };

    try {
      return run(captured);
    } finally {
      console.error = original;
    }
  }

  it('dispatches a cancelable ErrorEvent of type "error"', () => {
    let seen: ErrorEvent | null = null;

    const listener = (event: Event): void => {
      event.preventDefault();
      seen = event as ErrorEvent;
    };

    globalThis.addEventListener('error', listener);

    withCapturedConsoleError(() => {
      safeHandleCallback('cancelableDispatchCallback', () => {
        throw new Error('Cancelable boom');
      });
    });

    globalThis.removeEventListener('error', listener);

    const event = seen as unknown as ErrorEvent;

    expect(event).not.toBeNull();
    expect(event.type).toBe('error');

    // Without `cancelable: true` this is `false` and `preventDefault()` is a silent
    // no-op, which would make the console fall-through unsuppressable.
    expect(event.cancelable).toBe(true);
    expect(event.error.message).toContain('Cancelable boom');
  });

  it('skips the console fall-through when a listener claims the report', () => {
    const listener = (event: Event): void => {
      event.preventDefault();
    };

    globalThis.addEventListener('error', listener);

    const captured = withCapturedConsoleError((entries) => {
      safeHandleCallback('claimedReportCallback', () => {
        throw new Error('Claimed boom');
      });

      return entries;
    });

    globalThis.removeEventListener('error', listener);

    expect(captured.length).toBe(0);
  });

  it('falls through to console.error when nothing claims the report', () => {
    const captured = withCapturedConsoleError((entries) => {
      safeHandleCallback('unclaimedReportCallback', () => {
        throw new Error('Unclaimed boom');
      });

      return entries;
    });

    expect(captured.length).toBe(1);
    expect((captured[0][0] as Error).message).toContain('Unclaimed boom');
  });

  /**
   * These two stub `globalThis.dispatchEvent` deliberately, which is legitimate here and
   * a trap in the tests above: the question is what *this* code does when a dispatch
   * fails, not what a real dispatch returns. Cancellation still has to be measured
   * against the platform, which is why the tests above never stub it.
   */
  function withGlobalReplaced<T>(
    name: string,
    value: unknown,
    run: () => T,
  ): T {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const original = globalRecord[name];

    globalRecord[name] = value;

    try {
      return run();
    } finally {
      globalRecord[name] = original;
    }
  }

  it('reports to globalThis.reportError when the event cannot be constructed', () => {
    const reported: Error[] = [];

    const throwingErrorEvent = (): never => {
      throw new Error('ErrorEvent unavailable');
    };

    const captured = withGlobalReplaced('ErrorEvent', throwingErrorEvent, () =>
      withGlobalReplaced(
        'reportError',
        (error: Error) => reported.push(error),
        () =>
          withCapturedConsoleError((entries) => {
            safeHandleCallback('constructorFailureCallback', () => {
              throw new Error('Constructor rung boom');
            });

            return entries;
          }),
      ),
    );

    // Nothing was dispatched, so the next rung is the host reporting function...
    expect(reported.length).toBe(1);
    expect(reported[0].message).toContain('Constructor rung boom');

    // ...and the console is not also written to.
    expect(captured.length).toBe(0);
  });

  it('reports to the console, not reportError, when the dispatch itself throws', () => {
    const reported: Error[] = [];

    const throwingDispatch = (): never => {
      throw new Error('dispatch rejected the event');
    };

    const captured = withGlobalReplaced('dispatchEvent', throwingDispatch, () =>
      withGlobalReplaced(
        'reportError',
        (error: Error) => reported.push(error),
        () =>
          withCapturedConsoleError((entries) => {
            safeHandleCallback('dispatchFailureCallback', () => {
              throw new Error('Dispatch rung boom');
            });

            return entries;
          }),
      ),
    );

    // The event was handed over, so listeners may have run: reporting it again through
    // the host function would be a second report of one failure.
    expect(reported.length).toBe(0);

    expect(captured.length).toBe(1);
    expect((captured[0][0] as Error).message).toContain('Dispatch rung boom');
  });
});
