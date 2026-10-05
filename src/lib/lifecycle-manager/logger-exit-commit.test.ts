import { describe, expect, spyOn, test } from 'bun:test';
import { sleep } from '../sleep';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import type { LogSink } from '../logger/types';
import { LifecycleManager } from './lifecycle-manager';
import { LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING } from './constants';
import { deferred, Plain, sendSignal } from './test-helpers';

// A sink whose close is held open, so the window between a logger exit proceeding and
// `process.exit()` - the logger closes its sinks in between - stays open for the test.
function gatedSink(): { sink: LogSink; release: () => void } {
  const gate = deferred();

  return {
    sink: {
      write: (): void => {},
      close: (): Promise<void> => gate.promise,
    },
    release: () => gate.resolve(),
  };
}

async function poll(condition: () => boolean): Promise<boolean> {
  for (let i = 0; i < 200 && !condition(); i++) {
    await sleep(5);
  }

  return condition();
}

async function waitFor(condition: () => boolean): Promise<void> {
  expect(await poll(condition)).toBe(true);
}

// Runs `body` with `process.exit` stubbed. The stub stays in place until the logger's
// exit has called it, even when an assertion fails first: restoring it while that exit
// is still on its way would hand it the real `process.exit` and end the test runner.
async function withStubbedExit(
  body: (exits: unknown[], release: () => void, sink: LogSink) => Promise<void>,
): Promise<void> {
  const exits: unknown[] = [];
  const exitSpy = spyOn(process, 'exit').mockImplementation(((
    code?: number,
  ) => {
    exits.push(code);
  }) as typeof process.exit);
  const { sink, release } = gatedSink();

  try {
    await body(exits, release, sink);
  } finally {
    release();
    await poll(() => exits.length > 0);
    exitSpy.mockRestore();
  }
}

// A component whose stop fails and says so the documented way: a log line carrying an
// exit code.
class FailsOnStop extends Plain {
  constructor(
    logger: Logger,
    name: string,
    private readonly beforeFailing: Promise<void> = Promise.resolve(),
  ) {
    super(logger, name);
  }

  public override async stop(): Promise<void> {
    await this.beforeFailing;
    this.logger.error('Could not flush pending writes', { exitCode: 1 });
  }
}

function recordExitProcess(logger: Logger): number[] {
  const processed: number[] = [];
  logger.on<{ eventType: string; code: number }>(
    'logger',
    ({ eventType, code }) => {
      if (eventType === 'exit-process') {
        processed.push(code);
      }
    },
  );

  return processed;
}

function realExitManager(sink: LogSink): {
  logger: Logger;
  manager: LifecycleManager;
} {
  const logger = new Logger({
    sinks: [new ArraySink(), sink],
    callProcessExit: true,
  });

  return {
    logger,
    manager: new LifecycleManager({
      logger,
      enableLoggerExitHook: true,
      shutdownWarningTimeoutMS: -1,
    }),
  };
}

describe('LifecycleManager - logger exit commits the process to ending', () => {
  test('starts are refused while the logger closes before process.exit()', async () => {
    await withStubbedExit(async (exits, release, sink) => {
      const { logger, manager } = realExitManager(sink);
      await manager.registerComponent(new Plain(logger, 'a'));
      await manager.startAllComponents();

      logger.exit(0);
      await waitFor(() => logger.didExit);

      // The exit proceeded and the logger is closing its sinks; process.exit() has not
      // run yet. Nothing may start underneath it.
      expect(exits).toEqual([]);
      expect(manager.isComponentRunning('a')).toBe(false);

      const bulk = await manager.startAllComponents();
      expect(bulk.success).toBe(false);
      expect(bulk.code).toBe('shutdown_in_progress');
      expect(bulk.reason).toBe(LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING);

      const single = await manager.startComponent('a');
      expect(single.success).toBe(false);
      expect(single.code).toBe('shutdown_in_progress');
      expect(single.reason).toBe(LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING);

      const restart = await manager.restartAllComponents();
      expect(restart.startupResult.success).toBe(false);
      expect(restart.startupResult.reason).toBe(
        LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
      );
      expect(manager.isComponentRunning('a')).toBe(false);

      release();
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
    });
  });

  test('an exit that starts its own shutdown commits as that pass ends', async () => {
    await withStubbedExit(async (exits, release, sink) => {
      const { logger, manager } = realExitManager(sink);
      await manager.registerComponent(new Plain(logger, 'a'));
      await manager.startAllComponents();

      // A start deferred out of `shutdown-completed`, as the docs suggest for listeners:
      // it runs once the pass has released its latch, before the exit resumes.
      let queuedStart:
        Promise<{ success: boolean; reason?: string }> | undefined;
      manager.on('lifecycle-manager:shutdown-completed', () => {
        queueMicrotask(() => {
          queuedStart = manager.startAllComponents();
        });
      });

      logger.exit(0);
      await waitFor(() => logger.didExit);

      const queued = await queuedStart;
      expect(queued?.success).toBe(false);
      expect(queued?.reason).toBe(LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING);
      expect(manager.isComponentRunning('a')).toBe(false);

      release();
      await waitFor(() => exits.length > 0);
      expect(exits).toEqual([0]);
    });
  });

  test('an exit deferred behind a running shutdown commits as that pass ends', async () => {
    const stopGate = deferred();

    await withStubbedExit(async (exits, release, sink) => {
      // Release the stop inside the stubbed scope: the deferred exit commits only
      // once this pass ends, and the helper waits for it before restoring the stub.
      try {
        const { logger, manager } = realExitManager(sink);
        const a = new Plain(logger, 'a');
        a.stop = (): Promise<void> => stopGate.promise;
        await manager.registerComponent(a);
        await manager.startAllComponents();

        const stopping = manager.stopAllComponents();
        logger.exit(3);
        await sleep(5);
        expect(logger.didExit).toBe(false);

        let queuedStart:
          Promise<{ success: boolean; reason?: string }> | undefined;
        manager.on('lifecycle-manager:shutdown-completed', () => {
          queueMicrotask(() => {
            queuedStart = manager.startAllComponents();
          });
        });

        stopGate.resolve();
        await stopping;
        await waitFor(() => logger.didExit);

        const queued = await queuedStart;
        expect(queued?.success).toBe(false);
        expect(queued?.reason).toBe(LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING);
        expect(manager.isComponentRunning('a')).toBe(false);

        release();
        await waitFor(() => exits.length > 0);
        expect(exits).toEqual([3]);
      } finally {
        stopGate.resolve();
      }
    });
  });

  test('an exit a sink makes from close() after the commit is ignored', async () => {
    // The logger reports the ignored failure exit on the console once; asserted below
    // rather than left in the test output.
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withStubbedExit(async (exits, release, gated) => {
        const exitingOnClose: LogSink = {
          write: (): void => {},
          close: (): void => {
            logger.exit(5);
          },
        };
        const logger = new Logger({
          sinks: [new ArraySink(), gated, exitingOnClose],
          callProcessExit: true,
        });
        const manager = new LifecycleManager({
          logger,
          enableLoggerExitHook: true,
          shutdownWarningTimeoutMS: -1,
        });
        let passes = 0;
        manager.on('lifecycle-manager:shutdown-initiated', () => {
          passes++;
        });
        await manager.registerComponent(new Plain(logger, 'a'));
        await manager.startAllComponents();

        logger.exit(0);
        await waitFor(() => logger.didExit);
        release();
        await waitFor(() => exits.length > 0);
        await sleep(20);

        // No second shutdown pass, and the first exit's code is the one used.
        expect(passes).toBe(1);
        expect(exits).toEqual([0]);
      });
      expect(
        output.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.includes('Logger exit(5) ignored')),
      ).toHaveLength(1);
    } finally {
      output.mockRestore();
    }
  });

  test('a component failing while a success exit stops it makes the process exit non-zero', async () => {
    // The manager answers 'wait' for the failure's exit, since the success exit is
    // already stopping components; the logger keeps its code for the pending exit.
    const output = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await withStubbedExit(async (exits, release, sink) => {
        const { logger, manager } = realExitManager(sink);
        const processed = recordExitProcess(logger);
        await manager.registerComponent(new FailsOnStop(logger, 'a'));
        await manager.startAllComponents();

        logger.exit(0);
        await waitFor(() => logger.didExit);
        release();
        await waitFor(() => exits.length > 0);

        expect(manager.isComponentRunning('a')).toBe(false);
        expect(processed).toEqual([1]);
        expect(logger.exitCode).toBe(1);
        expect(exits).toEqual([1]);
      });
      expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
        'Logger exit(1) replaces the pending exit code 0',
      ]);
    } finally {
      output.mockRestore();
    }
  });

  test('a component failing during a SIGTERM shutdown a success exit waits for makes the process exit non-zero', async () => {
    const stopGate = deferred();
    const output = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withStubbedExit(async (exits, release, sink) => {
        // Released inside the stubbed scope: the exit proceeds only once this pass ends.
        try {
          const { logger, manager } = realExitManager(sink);
          const processed = recordExitProcess(logger);
          await manager.registerComponent(
            new FailsOnStop(logger, 'a', stopGate.promise),
          );
          await manager.startAllComponents();

          // SIGTERM starts the shutdown; the application's handler exits 0 behind it.
          sendSignal(manager, 'SIGTERM');
          logger.exit(0);
          await sleep(5);
          expect(logger.didExit).toBe(false);

          stopGate.resolve();
          await waitFor(() => logger.didExit);
          release();
          await waitFor(() => exits.length > 0);

          expect(processed).toEqual([1]);
          expect(logger.exitCode).toBe(1);
          expect(exits).toEqual([1]);
        } finally {
          stopGate.resolve();
        }
      });
      expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
        'Logger exit(1) replaces the pending exit code 0',
      ]);
    } finally {
      output.mockRestore();
    }
  });

  test('a sink exiting from the forced exit line does not recurse', async () => {
    const stopGate = deferred();
    let isArmed = false;
    let writes = 0;
    const exitingOnWrite: LogSink = {
      write: (): void => {
        if (isArmed) {
          writes++;
          logger.exit(1);
        }
      },
    };
    const logger = new Logger({
      sinks: [new ArraySink(), exitingOnWrite],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      enableLoggerExitHook: true,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        onForceShutdown: (): void => {
          isArmed = true;
          logger.exit(1);
        },
      },
    });
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(a);
    await manager.startAllComponents();

    try {
      sendSignal(manager, 'SIGINT');
      await sleep(5);
      sendSignal(manager, 'SIGINT');
      await waitFor(() => logger.didExit);

      // The forced exit's log line re-entered once and was told to wait.
      expect(writes).toBe(1);
    } finally {
      isArmed = false;
      stopGate.resolve();
      await sleep(10);
    }
  });

  test('a component failing during a SIGTERM shutdown gives a simulated exit the same non-zero code', async () => {
    // How a test checks shutdown: `callProcessExit: false`. It exited 0 here while the
    // real exit exited 1, so the test passed where production failed.
    const stopGate = deferred();
    const output = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const logger = new Logger({
        sinks: [new ArraySink()],
        callProcessExit: false,
      });
      const manager = new LifecycleManager({
        logger,
        enableLoggerExitHook: true,
        shutdownWarningTimeoutMS: -1,
      });
      const processed = recordExitProcess(logger);
      await manager.registerComponent(
        new FailsOnStop(logger, 'a', stopGate.promise),
      );
      await manager.startAllComponents();

      sendSignal(manager, 'SIGTERM');
      logger.exit(0);
      await sleep(5);
      expect(logger.didExit).toBe(false);

      stopGate.resolve();
      await waitFor(() => logger.didExit);

      expect(processed).toEqual([1]);
      expect(logger.exitCode).toBe(1);
      expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
        'Logger exit(1) replaces the pending exit code 0',
      ]);
    } finally {
      stopGate.resolve();
      output.mockRestore();
    }
  });

  test('a simulated exit after an earlier one completed settles its own code', async () => {
    const output = spyOn(console, 'error').mockImplementation(() => {});

    try {
      const logger = new Logger({
        sinks: [new ArraySink()],
        callProcessExit: false,
      });
      const manager = new LifecycleManager({
        logger,
        enableLoggerExitHook: true,
        shutdownWarningTimeoutMS: -1,
      });
      const processed = recordExitProcess(logger);
      let shouldFail = true;
      const a = new Plain(logger, 'a');
      a.stop = (): Promise<void> => {
        if (shouldFail) {
          logger.error('Could not flush pending writes', { exitCode: 1 });
        }
        return Promise.resolve();
      };
      await manager.registerComponent(a);
      await manager.startAllComponents();

      logger.exit(0);
      await waitFor(() => processed.length === 1);
      expect(logger.exitCode).toBe(1);

      // The process kept running, so the next exit stops the components again and
      // starts from its own code rather than the failure the last one settled on.
      shouldFail = false;
      await manager.startAllComponents();
      logger.exit(0);
      await waitFor(() => processed.length === 2);

      expect(manager.isComponentRunning('a')).toBe(false);
      expect(processed).toEqual([1, 0]);
      expect(logger.exitCode).toBe(0);
      expect(output.mock.calls.map((call) => String(call[0]))).toEqual([
        'Logger exit(1) replaces the pending exit code 0',
      ]);
    } finally {
      output.mockRestore();
    }
  });

  test('a simulated exit leaves later starts allowed', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      enableLoggerExitHook: true,
      shutdownWarningTimeoutMS: -1,
    });
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();

    logger.exit(0);
    await waitFor(() => logger.didExit);
    expect(manager.isComponentRunning('a')).toBe(false);

    const result = await manager.startAllComponents();
    expect(result.success).toBe(true);
    expect(manager.isComponentRunning('a')).toBe(true);

    await manager.stopAllComponents();
  });
});
