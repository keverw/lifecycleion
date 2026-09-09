import { afterEach, describe, expect, test } from 'bun:test';
import {
  breakConsoleError,
  restoreConsoleError,
} from '../internal/console-test-utils';
import { Logger } from './index';
import type { LogSink } from './types';
import { NamedPipeSink } from './sinks/named-pipe';
import { installGlobalEventTarget } from '../global-event-target';
import { sleep } from '../sleep';

/**
 * The last rung of every reporting path is `console.error`, and it is a call that can
 * throw: Node raises `EPIPE` writing to a pipe whose reader has gone, a stream destroyed
 * during shutdown throws on write, and a harness that patches it to fail a build on
 * warnings is an ordinary setup. Every one of those is a *shutdown-time* condition, which
 * is exactly when sinks fail and handlers are torn down.
 *
 * Reporting a failure must never raise one. These drive each site that falls through to
 * that rung with the rung itself broken, and assert the original failure is still the only
 * failure. Every test here fails without the `reportToConsole` guard.
 */

/**
 * Teardown for whatever the current test registered globally.
 *
 * Collected here rather than called at the end of each test, because an inline cleanup is
 * skipped by the very failure these tests exist to catch. With the guard removed, the
 * listener test below throws out of `dispatchEvent`, so an inline
 * `unregisterReportErrorListener()` never ran and a `Logger` whose only sink throws on
 * every write stayed on `globalThis` for the rest of the process - cancelling the `'error'`
 * events that `safe-handle-callback`'s own suite asserts on, and turning one real
 * regression into a cascade of failures pointing at unrelated files. A leaked
 * `'unhandledRejection'` listener is quieter and worse: it suppresses the runtime's
 * default fatal handling process-wide, weakening every later test that depends on an
 * unhandled rejection being observable.
 */
const pendingTeardown: (() => void)[] = [];

afterEach(() => {
  // The console goes back first, so a teardown that reports something still can.
  restoreConsoleError();

  // Drained in reverse, and each one guarded: a teardown that throws must not strand the
  // ones behind it, which is the same failure mode this list exists to prevent.
  while (pendingTeardown.length > 0) {
    const teardown = pendingTeardown.pop();

    try {
      teardown?.();
    } catch {
      // Nothing useful to do here, and the remaining teardowns still have to run.
    }
  }
});

/** Run `teardown` after this test, whether it passes, fails, or throws. */
function afterThisTest(teardown: () => void): void {
  pendingTeardown.push(teardown);
}

/**
 * Collects rejections that nothing handled, so a test can assert there were none.
 *
 * Removes its own listener through {@link afterThisTest}, so a test that fails before it
 * would have stopped the tracker does not leave one behind.
 */
function trackUnhandledRejections(): { seen: unknown[] } {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };

  process.on('unhandledRejection', onUnhandled);

  afterThisTest(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  return { seen };
}

/**
 * A `Logger` whose global `'error'` listener is unregistered after this test.
 *
 * Registering is what makes the listener test meaningful; leaving it registered is what
 * poisons every suite that runs after it.
 */
function registerListener(
  logger: Logger,
): ReturnType<Logger['registerReportErrorListener']> {
  afterThisTest(() => {
    logger.unregisterReportErrorListener();
  });

  return logger.registerReportErrorListener();
}

/**
 * A `NamedPipeSink` that is closed after this test.
 *
 * Closed through {@link afterThisTest} rather than at the end of the test body, so a
 * failure between construction and the close does not leave a half-initialized sink
 * holding a stream for the rest of the run.
 */
function openTrackedPipeSink(
  options: ConstructorParameters<typeof NamedPipeSink>[0],
): NamedPipeSink {
  const sink = new NamedPipeSink(options);

  afterThisTest(() => {
    void sink.close();
  });

  return sink;
}

describe('reporting rungs survive a broken console', () => {
  describe("Logger's own 'logger' handler failures", () => {
    test('a synchronously throwing handler does not escape the log call', () => {
      const logger = new Logger({ sinks: [] });

      logger.on('logger', () => {
        throw new Error('handler boom');
      });

      const calls = breakConsoleError();

      // Without the guard this threw `console.error is broken` out of `emit`, out of
      // `handleLog`, and into the caller's own `logger.info()`.
      expect(() => {
        logger.info('hello');
      }).not.toThrow();

      expect(calls.attempts).toBeGreaterThan(0);
    });

    test('an asynchronously rejecting handler does not become an unhandled rejection', async () => {
      const rejections = trackUnhandledRejections();
      const logger = new Logger({ sinks: [] });

      logger.on('logger', async () => {
        await Promise.resolve();

        throw new Error('async handler boom');
      });

      breakConsoleError();

      logger.info('hello');

      // The rejection is reported in a later microtask, so give it turns to land.
      await sleep(20);

      expect(rejections.seen).toEqual([]);
    });

    test('a throwing onEventHandlerError still falls through without escaping', () => {
      const logger = new Logger({
        sinks: [],
        onEventHandlerError: () => {
          throw new Error('handler-of-handlers boom');
        },
      });

      logger.on('logger', () => {
        throw new Error('handler boom');
      });

      const calls = breakConsoleError();

      expect(() => {
        logger.info('hello');
      }).not.toThrow();

      // The callback threw, so the console rung was reached.
      expect(calls.attempts).toBeGreaterThan(0);
    });
  });

  describe('sink failures', () => {
    test('a synchronously throwing sink does not escape the log call', () => {
      const sink: LogSink = {
        write: (): void => {
          throw new Error('sink boom');
        },
      };

      const logger = new Logger({ sinks: [sink] });
      const calls = breakConsoleError();

      expect(() => {
        logger.info('hello');
      }).not.toThrow();

      expect(calls.attempts).toBeGreaterThan(0);
    });

    test('a rejecting sink does not become an unhandled rejection', async () => {
      const rejections = trackUnhandledRejections();
      const sink: LogSink = {
        write: async (): Promise<void> => {
          await Promise.resolve();

          throw new Error('async sink boom');
        },
      };

      const logger = new Logger({ sinks: [sink] });

      breakConsoleError();

      logger.info('hello');

      await sleep(20);

      expect(rejections.seen).toEqual([]);
    });

    test('a sink that fails to close does not reject close()', async () => {
      const sink: LogSink = {
        write: (): void => {
          // Nothing to do; this suite is about `close`.
        },
        close: (): void => {
          throw new Error('close boom');
        },
      };

      const logger = new Logger({ sinks: [sink] });

      breakConsoleError();

      // `close()` is precisely when stdout is most likely to be gone, so a throw from the
      // console rung here would reject the shutdown that was tidying up after a failure.
      let closeFailure: unknown = null;

      try {
        await logger.close();
      } catch (error) {
        closeFailure = error;
      }

      restoreConsoleError();

      expect(closeFailure).toBeNull();
    });

    test('a throwing onSinkError still falls through without escaping', () => {
      const sink: LogSink = {
        write: (): void => {
          throw new Error('sink boom');
        },
      };

      const logger = new Logger({
        sinks: [sink],
        onSinkError: () => {
          throw new Error('handler-of-sinks boom');
        },
      });

      const calls = breakConsoleError();

      expect(() => {
        logger.info('hello');
      }).not.toThrow();

      expect(calls.attempts).toBeGreaterThan(0);
    });
  });

  describe("the global 'error' listener", () => {
    test('still cancels the event when logging it fails and the console is broken', () => {
      installGlobalEventTarget();

      const sink: LogSink = {
        write: (): void => {
          throw new Error('sink boom');
        },
      };

      const logger = new Logger({ sinks: [sink] });

      expect(registerListener(logger)).toBe('success');

      const calls = breakConsoleError();

      // Cancellation is the observable proof that the listener ran to completion.
      // Without the guard, the sink failure's console rung threw out of `handleLog`, was
      // caught by the listener's own backstop, whose console rung threw in turn and
      // escaped the listener - skipping `preventDefault()` entirely, so this returned
      // `true` and `safe-handle-callback` reported the same failure a second time.
      const event = new ErrorEvent('error', {
        error: new Error('reported failure'),
        message: 'reported failure',
        cancelable: true,
      });

      const wasNotCancelled = globalThis.dispatchEvent(event);

      restoreConsoleError();

      expect(calls.attempts).toBeGreaterThan(0);
      expect(wasNotCancelled).toBe(false);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  describe('NamedPipeSink', () => {
    test.skipIf(process.platform === 'win32')(
      'a failed pipe open does not reject out of the constructor',
      async () => {
        const rejections = trackUnhandledRejections();

        breakConsoleError();

        // No `onError`, so the failure falls straight through to the console rung - from
        // `initializePipe`, whose promise the constructor starts with no `.catch`.
        openTrackedPipeSink({
          pipePath: '/nonexistent-directory-for-test/pipe',
        });

        await sleep(20);

        expect(rejections.seen).toEqual([]);
      },
    );

    test.skipIf(process.platform === 'win32')(
      'a throwing onError still falls through without escaping',
      async () => {
        const rejections = trackUnhandledRejections();

        breakConsoleError();

        openTrackedPipeSink({
          pipePath: '/nonexistent-directory-for-test/pipe',
          onError: () => {
            throw new Error('handler-of-pipes boom');
          },
        });

        await sleep(20);

        expect(rejections.seen).toEqual([]);
      },
    );
  });
});
