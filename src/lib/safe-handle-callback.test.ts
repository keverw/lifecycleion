import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from './internal/console-test-utils';
import {
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from './safe-handle-callback';
import { sleep } from './sleep';

// These suites deliberately drive the paths that fall through to `console.error` when
// nothing claims the report. Captured rather than printed so a real failure in the run
// output still stands out; flip `DEBUG` in the helper to see them.
beforeEach(() => {
  muteConsoleError();
});

afterEach(() => {
  restoreConsoleError();
});

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

      // The thrown error itself, on `cause` rather than rendered into the message, so
      // whoever receives the report renders it under their own settings.
      expect(((event as ErrorEvent).error.cause as Error).message).toBe(
        'Sync error',
      );

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

      expect(((event as ErrorEvent).error.cause as Error).message).toBe(
        'Async error',
      );

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

      expect(((event as ErrorEvent).error.cause as Error).message).toContain(
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
      expect(((event as ErrorEvent).error.cause as Error).message).toBe(
        'Sync error',
      );
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

      expect(((event as ErrorEvent).error.cause as Error).message).toBe(
        'Async error',
      );
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

      // Dispatched by hand from `result.error`, which is the failure itself and not the
      // wrapper `reportCallbackError` builds, so the message is the message.
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
    expect((event.error.cause as Error).message).toBe('Cancelable boom');
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
    // The console rung is the one that renders, so it receives the rendered text.
    expect(String(captured[0][0])).toContain('Unclaimed boom');
  });

  it('reports a value it cannot render instead of throwing out of the callback', () => {
    // Rendering the thrown value runs code this library does not own: `errorToString`
    // reads `message`/`stack` off it and walks `additionalInfo`. Each of these makes
    // that throw. Before the render was guarded, the resulting error escaped
    // `safeHandleCallback` itself — the "safe" wrapper threw, and for the async form it
    // became an unhandled rejection.
    const { proxy, revoke } = Proxy.revocable({}, {});

    revoke();

    const hostileStack = new Error('hostile stack');

    Object.defineProperty(hostileStack, 'stack', {
      get(): never {
        throw new Error('stack getter boom');
      },
    });

    const cyclic = new Error('cyclic') as Error & {
      additionalInfo?: unknown;
    };

    const loop: Record<string, unknown> = {};
    loop.self = loop;
    cyclic.additionalInfo = loop;

    for (const value of [proxy, hostileStack, cyclic]) {
      const captured = withCapturedConsoleError((entries) => {
        expect(() => {
          safeHandleCallback('unrenderableCallback', () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
            throw value;
          });
        }).not.toThrow();

        return entries;
      });

      // Still reported, and still named, even though the value itself could not be
      // described.
      expect(captured.length).toBe(1);
      expect(String(captured[0][0])).toContain('unrenderableCallback');
    }
  });

  it('returns a real Error from safeHandleCallbackAndWait for a non-Error throw', async () => {
    // `CallbackResult.error` is declared `Error`, so a callback that throws `null` must
    // not hand the caller a `null` typed as one: `result.error.message` would throw.
    const captured: unknown[][] = [];
    const original = console.error;

    console.error = (...args: unknown[]): void => {
      captured.push(args);
    };

    let result: Awaited<ReturnType<typeof safeHandleCallbackAndWait>>;

    try {
      result = await safeHandleCallbackAndWait('nonErrorThrow', () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
        throw null;
      });
    } finally {
      console.error = original;
    }

    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toBe('Non-error value thrown: null');

    // The value actually thrown stays reachable.
    expect(result.error?.cause).toBe(null);
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
    const reported: (string | Error)[] = [];

    const throwingErrorEvent = (): never => {
      throw new Error('ErrorEvent unavailable');
    };

    const captured = withGlobalReplaced('ErrorEvent', throwingErrorEvent, () =>
      withGlobalReplaced(
        'reportError',
        (error: string | Error) => reported.push(error),
        () =>
          withCapturedConsoleError((entries) => {
            safeHandleCallback('constructorFailureCallback', () => {
              throw new Error('Constructor rung boom');
            });

            return entries;
          }),
      ),
    );

    // Nothing was dispatched, so the next rung is the host reporting function. It only
    // prints, so it is handed the rendered form rather than the wrapper - whose `cause`
    // a runtime's error inspection would print unmasked.
    expect(reported.length).toBe(1);
    expect(typeof reported[0]).toBe('string');
    expect(String(reported[0])).toContain('Constructor rung boom');
    expect(String(reported[0])).toContain('constructorFailureCallback');

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
    expect(String(captured[0][0])).toContain('Dispatch rung boom');
  });

  it('does not dispatch into a partial environment where nothing can listen', () => {
    // `installGlobalEventTarget` leaves a partial environment as it found it, so
    // `dispatchEvent` can be callable while no listener of ours could have registered
    // through it. A foreign `dispatchEvent` answering `false` there read as `'handled'`,
    // and the report was dropped with no console line and no listener that saw it.
    const reported: (string | Error)[] = [];
    let dispatched = 0;

    const claimingDispatch = (): boolean => {
      dispatched++;

      return false;
    };

    const captured = withGlobalReplaced('addEventListener', undefined, () =>
      withGlobalReplaced('dispatchEvent', claimingDispatch, () =>
        withGlobalReplaced(
          'reportError',
          (error: string | Error) => reported.push(error),
          () =>
            withCapturedConsoleError((entries) => {
              safeHandleCallback('partialEnvironmentCallback', () => {
                throw new Error('Partial rung boom');
              });

              return entries;
            }),
        ),
      ),
    );

    expect(dispatched).toBe(0);
    expect(reported.length).toBe(1);
    expect(String(reported[0])).toContain('Partial rung boom');
    expect(captured.length).toBe(0);
  });
});
