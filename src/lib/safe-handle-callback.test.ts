import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from './internal/console-test-utils';
import {
  reportCallbackError,
  runCallbackSafely,
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

describe('runCallbackSafely', () => {
  // The extension seam `EventEmitterProtected.emit` builds on: every way a callback can
  // fail reaches `onError`, and nothing reaches the global channel unless `onError` sends
  // it there.
  it('calls the callback with its arguments and reports nothing on success', () => {
    const received: unknown[][] = [];
    const failures: unknown[] = [];

    runCallbackSafely(
      'cb',
      (...args: unknown[]) => {
        received.push(args);
      },
      [1, 'two'],
      (error) => failures.push(error),
    );

    expect(received).toEqual([[1, 'two']]);
    expect(failures).toEqual([]);
  });

  it('reports a rejected native promise that carries its own no-op then', async () => {
    const failures: unknown[] = [];
    const thrown = new Error('rejected');
    const promise: object = Promise.reject(thrown);
    Object.defineProperty(promise, 'then', { value: () => undefined });

    runCallbackSafely(
      'cb',
      () => promise,
      [],
      (error) => failures.push(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failures).toEqual([thrown]);
  });

  it('reports a rejected native promise that carries its own throwing then and catch', async () => {
    const failures: unknown[] = [];
    const thrown = new Error('rejected');
    const promise: object = Promise.reject(thrown);
    Object.defineProperty(promise, 'then', {
      value: (): never => {
        throw new Error('then exploded');
      },
    });
    Object.defineProperty(promise, 'catch', {
      value: (): never => {
        throw new Error('catch exploded');
      },
    });

    runCallbackSafely(
      'cb',
      () => promise,
      [],
      (error) => failures.push(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(failures).toEqual([thrown]);
  });

  it('reports a revoked proxy as not a function instead of throwing', () => {
    const failures: unknown[] = [];
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() => {
      runCallbackSafely('cb', proxy, [], (error) => failures.push(error));
    }).not.toThrow();
    expect(failures).toHaveLength(1);
  });

  it('routes a then-only thenable rejection to onError', async () => {
    // `isPromise` accepts any thenable, and a `then`-only one has no `catch`. Calling
    // `result.catch` threw a `TypeError` that was reported *instead of* the real failure,
    // and because `then` was never called the actual rejection went nowhere. Every
    // untrusted-callback surface funnels through here.
    const failures: unknown[] = [];
    const thrown = new Error('async');

    runCallbackSafely(
      'cb',
      () => ({
        then: (
          _onFulfilled: (value: unknown) => void,
          onRejected: (reason: unknown) => void,
        ): void => {
          queueMicrotask(() => onRejected(thrown));
        },
      }),
      [],
      (error) => failures.push(error),
    );

    await sleep(10);

    expect(failures).toEqual([thrown]);
  });

  it('routes a synchronous throw to onError', () => {
    const failures: unknown[] = [];
    const thrown = new Error('sync');

    runCallbackSafely(
      'cb',
      () => {
        throw thrown;
      },
      [],
      (error) => failures.push(error),
    );

    expect(failures).toEqual([thrown]);
  });

  it('routes a rejection to onError without awaiting it', async () => {
    const failures: unknown[] = [];
    const rejection = new Error('async');

    runCallbackSafely(
      'cb',
      () => Promise.reject(rejection),
      [],
      (error) => failures.push(error),
    );

    // Not yet: the rejection is reported when it lands, never awaited here.
    expect(failures).toEqual([]);

    await sleep(1);

    expect(failures).toEqual([rejection]);
  });

  it('routes a non-function to onError with the same message safeHandleCallback used', () => {
    const failures: unknown[] = [];

    runCallbackSafely('myHook', 'not callable', [], (error) =>
      failures.push(error),
    );

    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe(
      'Callback provided for myHook is not a function',
    );
  });

  it('keeps a non-Error throw as the value it was', () => {
    const failures: unknown[] = [];

    runCallbackSafely(
      'cb',
      () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- a non-Error throw is the case
        throw 'boom';
      },
      [],
      (error) => failures.push(error),
    );

    expect(failures).toEqual(['boom']);
  });

  it('does not touch the global error channel on its own', () => {
    const events: unknown[] = [];
    const onGlobalError = (event: Event): void => {
      events.push(event);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onGlobalError);

    try {
      runCallbackSafely(
        'cb',
        () => {
          throw new Error('kept local');
        },
        [],
        () => {},
      );

      expect(events).toEqual([]);
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });
});

describe('reportCallbackError', () => {
  it('dispatches a cancelable ErrorEvent wrapping the thrown value as cause', () => {
    const events: ErrorEvent[] = [];
    const onGlobalError = (event: Event): void => {
      events.push(event as ErrorEvent);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onGlobalError);

    try {
      const thrown = new Error('inner');

      reportCallbackError('myHook', thrown);

      expect(events).toHaveLength(1);
      expect(events[0]?.cancelable).toBe(true);
      expect(events[0]?.error).toBeInstanceOf(Error);
      expect((events[0]?.error as Error).message).toBe(
        'Error in a callback myHook',
      );
      expect((events[0]?.error as Error).cause).toBe(thrown);
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });

  it('carries a non-object throw on cause rather than dropping it', () => {
    const events: ErrorEvent[] = [];
    const onGlobalError = (event: Event): void => {
      events.push(event as ErrorEvent);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onGlobalError);

    try {
      reportCallbackError('myHook', 42);

      expect((events[0]?.error as Error).cause).toBe(42);
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }
  });

  it('falls through to console.error naming the callback when nothing claims it', () => {
    const captured = muteConsoleError();

    reportCallbackError('myHook', new Error('inner'));

    expect(captured.some((line) => line.includes('myHook'))).toBe(true);
    expect(captured.some((line) => line.includes('inner'))).toBe(true);
  });

  it('never throws, even for a value that cannot be rendered', () => {
    muteConsoleError();

    const hostile = new Error('hostile');

    Object.defineProperty(hostile, 'stack', {
      get() {
        throw new Error('no stack for you');
      },
    });

    expect(() => reportCallbackError('myHook', hostile)).not.toThrow();
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

  it('renders a non-object throw through the wrapper, not bare', () => {
    // The console rung used to render the *thrown value*, and `errorToString` emits rows
    // only for an object - so `throw 'boom-string'` printed a three-line empty table with
    // the value nowhere in it. The wrapper is always an `Error` and `errorToString` renders
    // its `cause`, which is where the value belongs.
    for (const value of ['boom-string', 42, Symbol('sigil')]) {
      const captured = withCapturedConsoleError((entries) => {
        safeHandleCallback('nonObjectThrowCallback', () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- the point of the test
          throw value;
        });

        return entries;
      });

      expect(captured.length).toBe(1);

      const line = String(captured[0][0]);

      expect(line).toContain('nonObjectThrowCallback');
      expect(line).toContain('| Cause');
      expect(line).toContain(String(value));
    }
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
      //
      // Counted by the lines that name the callback rather than by every line written:
      // rendering a value whose own members refuse to be read now says so on the render
      // channel too - `hostileStack`'s `stack` getter throws, and that diagnosis reaches
      // the console alongside the report instead of being swallowed. One report is still
      // one report.
      const named = captured.filter((entry) =>
        String(entry[0]).includes('unrenderableCallback'),
      );

      expect(named.length).toBe(1);

      // Everything else is a render diagnosis, and there is at most one: the format
      // reporter fires once per kind per render. Bounded so a future regression that
      // floods the console cannot pass by being filtered out.
      expect(captured.length).toBeLessThanOrEqual(2);
      expect(
        captured
          .filter((entry) => !String(entry[0]).includes('unrenderableCallback'))
          .every((entry) => String(entry[0]).startsWith('Render failed for ')),
      ).toBe(true);
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

describe('runCallbackSafely - thisArg', () => {
  class Greeter {
    public readonly prefix = '[app] ';
    public seen: string[] = [];

    public record(message: string): void {
      // Throws with no receiver, which is exactly the silent-degradation case.
      this.seen.push(this.prefix + message);
    }
  }

  it('invokes an extracted method with the supplied receiver', () => {
    const greeter = new Greeter();
    const errors: unknown[] = [];

    runCallbackSafely(
      'greeter.record',
      // Deliberately unbound: supplying `thisArg` is what makes this work, and is the
      // behaviour under test. `unbound-method` is flagging the very hazard being covered.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      greeter.record,
      ['hello'],
      (error) => errors.push(error),
      greeter,
    );

    expect(errors).toEqual([]);
    expect(greeter.seen).toEqual(['[app] hello']);
  });

  it('reports the failure when an extracted method is passed without a receiver', () => {
    const greeter = new Greeter();
    const errors: unknown[] = [];

    runCallbackSafely(
      'greeter.record',
      // Deliberately unbound and with no `thisArg`, so the call fails the way an
      // integrator's would.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      greeter.record,
      ['hello'],
      (error) => errors.push(error),
    );

    expect(errors.length).toBe(1);
    expect(greeter.seen).toEqual([]);
  });

  it('leaves a plain function unaffected when thisArg is omitted', () => {
    const calls: unknown[][] = [];

    runCallbackSafely(
      'plain',
      (...args: unknown[]) => calls.push(args),
      [1, 2],
      () => {
        throw new Error('should not be reached');
      },
    );

    expect(calls).toEqual([[1, 2]]);
  });

  it('calls the callback itself, not an apply property it carries', () => {
    const calls: unknown[][] = [];
    const callback = Object.assign((...args: unknown[]) => calls.push(args), {
      // Shadows `Function.prototype.apply`. Reading it off the callback would run this
      // instead of the callback.
      apply: (): void => {},
    });

    runCallbackSafely('shadowed-apply', callback, [1, 2], () => {
      throw new Error('should not be reached');
    });

    expect(calls).toEqual([[1, 2]]);
  });
});

describe('runCallbackSafely - a throwing onError is contained', () => {
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

  it('does not let a synchronous onError throw escape to the caller', () => {
    const captured = withCapturedConsoleError((entries) => {
      expect(() => {
        runCallbackSafely(
          'cb',
          () => {
            throw new Error('original failure');
          },
          [],
          () => {
            throw new Error('reporter failure');
          },
        );
      }).not.toThrow();

      return entries;
    });

    expect(captured.length).toBe(1);
    // Both the reporter's failure and the original are handed to the console rung.
    expect(String(captured[0][0])).toContain('cb');
  });

  it('renders both errors through the masking renderer, not raw', () => {
    const captured = withCapturedConsoleError((entries) => {
      runCallbackSafely(
        'cb',
        () => {
          throw Object.assign(new Error('original failure'), {
            additionalInfo: { password: 'hunter2-secret' },
            sensitiveFieldNames: ['password'],
          });
        },
        [],
        () => {
          throw new Error('reporter failure');
        },
      );

      return entries;
    });

    // No raw error reaches the console: Node's `console.error` prints an error's own
    // fields - `additionalInfo` included - unmasked.
    expect(captured[0]?.some((arg) => arg instanceof Error)).toBe(false);

    const printed = Bun.inspect(captured);
    expect(printed).toContain('reporter failure');
    expect(printed).toContain('original failure');
    expect(printed).not.toContain('hunter2-secret');
  });

  it('does not let a rejected-promise onError throw become an unhandled rejection', async () => {
    // The sync helper restores `console.error` as soon as `run` returns, so an async body
    // would finish reporting after the swap was undone. Captured inline instead.
    const captured: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]): void => {
      captured.push(args);
    };

    try {
      runCallbackSafely(
        'cb',
        () => Promise.reject(new Error('original failure')),
        [],
        () => {
          throw new Error('reporter failure');
        },
      );

      await sleep(20);
    } finally {
      console.error = original;
    }

    expect(captured.length).toBe(1);
    expect(String(captured[0][0])).toContain('cb');
  });

  it('contains a throwing onError on the not-a-function path', () => {
    const captured = withCapturedConsoleError((entries) => {
      expect(() => {
        runCallbackSafely('cb', 'not callable', [], () => {
          throw new Error('reporter failure');
        });
      }).not.toThrow();

      return entries;
    });

    expect(captured.length).toBe(1);
  });
});

describe('CallbackResult narrowing', () => {
  it('narrows to value on success and error on failure', async () => {
    const ok = await safeHandleCallbackAndWait<number>('ok', () => 42);

    if (ok.success) {
      // No non-null assertion needed here.
      const value: number = ok.value;
      expect(value).toBe(42);
    } else {
      throw new Error('expected success');
    }

    const failed = await safeHandleCallbackAndWait<number>('bad', () => {
      throw new Error('boom');
    });

    if (failed.success) {
      throw new Error('expected failure');
    } else {
      const error: Error = failed.error;
      expect(error.message).toBe('boom');
    }
  });
});
