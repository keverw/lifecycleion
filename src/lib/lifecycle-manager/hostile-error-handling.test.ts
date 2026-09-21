/**
 * Tests for failure paths handed a value that is not a readable `Error`.
 *
 * `throw` accepts any value, so every component callback the manager invokes can hand it
 * one — including an `Error` whose `message` accessor throws, or a value with no
 * prototype chain for `instanceof` to walk. These paths run inside timer callbacks and
 * floating promise chains where there is no caller left to catch anything, so a second
 * failure raised while reporting the first is fatal rather than merely noisy.
 */

import { describe, expect, test, beforeEach, spyOn } from 'bun:test';
import { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import { ArraySink } from '../logger/sinks/array';
import type { LogEntry } from '../logger/types';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { MAX_TIMER_MS } from '../internal/timer-limits';

/** An `Error` whose `message` accessor throws, as a subclass or a `Proxy` can produce. */
function unreadableError(): Error {
  const error = new Error('placeholder');

  Object.defineProperty(error, 'message', {
    get() {
      throw new Error('message getter blew up');
    },
  });

  return error;
}

describe('LifecycleManager - hostile thrown values', () => {
  let logger: Logger;
  let arraySink: ArraySink;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({ sinks: [arraySink], callProcessExit: false });
  });

  test('an unreadable error from reportUnexpectedStop still records and emits', async () => {
    const lifecycle = new LifecycleManager({ logger });

    let reportFn!: (err?: Error) => boolean;

    class SelfStoppingComponent extends BaseComponent {
      public start(): void {
        reportFn = (err?: Error) => this.reportUnexpectedStop(err);
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new SelfStoppingComponent(logger, { name: 'hostile-stop' }),
    );
    await lifecycle.startComponent('hostile-stop');

    const events: string[] = [];

    lifecycle.on('component:unexpected-stop', () => {
      events.push('unexpected-stop');
    });
    lifecycle.on('component:stopped', () => {
      events.push('stopped');
    });

    // The reads sit between the state mutations and the event emissions, so a throw
    // here would leave the manager claiming the component stopped while never saying so.
    expect(() => reportFn(unreadableError())).not.toThrow();

    expect(events).toEqual(['unexpected-stop', 'stopped']);
    expect(lifecycle.isComponentRunning('hostile-stop')).toBe(false);
    expect(lifecycle.getComponentStatus('hostile-stop')?.state).toBe('stopped');

    await lifecycle.stopAllComponents();
  });

  test('an unreadable error reported during start() still returns a result', async () => {
    // The existing coverage reports the stop *after* `startComponent` has resolved. During
    // `start()` the reads sit inside a `try` whose `catch` reads `message` again, so an
    // accessor that throws escaped both and rejected `startComponent` rather than
    // returning the `component_unexpected_stop` result it exists to return.
    const lifecycle = new LifecycleManager({ logger });

    class FailsDuringStart extends BaseComponent {
      public start(): void {
        this.reportUnexpectedStop(unreadableError());
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new FailsDuringStart(logger, { name: 'hostile-start' }),
    );

    const result = await lifecycle.startComponent('hostile-start');

    expect(result.success).toBe(false);
    expect(result.code).toBe('component_unexpected_stop');
    expect(typeof result.reason).toBe('string');

    await lifecycle.stopAllComponents();
  });

  test('a non-Error thrown value from reportUnexpectedStop is normalized', async () => {
    const lifecycle = new LifecycleManager({ logger });

    let reportFn!: (err?: Error) => boolean;

    class SelfStoppingComponent extends BaseComponent {
      public start(): void {
        reportFn = (err?: Error) => this.reportUnexpectedStop(err);
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new SelfStoppingComponent(logger, { name: 'non-error-stop' }),
    );
    await lifecycle.startComponent('non-error-stop');

    let reported: unknown;

    lifecycle.on('component:unexpected-stop', (data) => {
      reported = (data as { error?: unknown }).error;
    });

    // `reportUnexpectedStop` is typed `Error` but is never validated.
    expect(() => reportFn('just a string' as unknown as Error)).not.toThrow();

    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toContain('just a string');
    expect((reported as Error).cause).toBe('just a string');

    await lifecycle.stopAllComponents();
  });

  test('a non-Error self-report does not outrank a real startup failure', async () => {
    // Normalizing what `reportUnexpectedStop` stores must not change the
    // overlapping-failure rule: a self-report that did not carry a real `Error` is a
    // state signal, so the later thrown startup error keeps the more useful diagnostic.
    const lifecycle = new LifecycleManager({ logger });

    class SignalThenThrowComponent extends BaseComponent {
      public start(): void {
        this.reportUnexpectedStop('string signal' as unknown as Error);

        throw new Error('real startup failure');
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new SignalThenThrowComponent(logger, { name: 'signal-then-throw' }),
    );

    const result = await lifecycle.startComponent('signal-then-throw');

    expect(result.success).toBe(false);
    expect(result.reason).toContain('real startup failure');
    expect(result.code).not.toBe('component_unexpected_stop');
  });

  test('a logger that throws during a signal-driven shutdown is not fatal', async () => {
    // The signal handler starts `stopAllComponentsInternal` and lets it float, and that
    // method is `try`/`finally` with no `catch`. A logger that threw while the shutdown
    // was being logged rejected the floating promise with nothing attached: an unhandled
    // rejection on `SIGTERM`, fatal under Node's default, before any component was
    // stopped. The manager guards its own logger at construction, so it cannot.
    const throwingLogger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });

    const realService = throwingLogger.service.bind(throwingLogger);

    throwingLogger.service = (serviceName: string): LoggerService => {
      const service = realService(serviceName);
      const realInfo = service.info.bind(service);

      service.info = (...args: Parameters<typeof service.info>) => {
        if (args[0] === 'Stopping all components') {
          throw new Error('the logger itself is broken');
        }

        return realInfo(...args);
      };

      return service;
    };

    const lifecycle = new LifecycleManager({ logger: throwingLogger });

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    process.on('unhandledRejection', onUnhandled);
    globalThis.addEventListener('error', onError);

    try {
      // The signal handler's own entry point, without raising a real signal.
      (
        lifecycle as unknown as {
          handleShutdownRequest: (method: 'SIGTERM') => void;
        }
      ).handleShutdownRequest('SIGTERM');

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(rejections).toEqual([]);
      expect(reports.length).toBe(1);
      // The manager's logger is guarded, so the shutdown pass carries on instead of
      // rejecting with `isShuttingDown` already latched. The report is labelled by the
      // logger method rather than by the operation, which the guard cannot see.
      expect((reports[0] as Error).message).toContain(
        'lifecycle-manager logger.info',
      );
      expect(((reports[0] as Error).cause as Error).message).toBe(
        'the logger itself is broken',
      );
    } finally {
      globalThis.removeEventListener('error', onError);
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a logger that throws while reporting a late failure is not fatal', async () => {
    // Seven detached `Promise.resolve(x).catch(...)` chains had their previously-empty
    // handler bodies changed to call `this.logger.entity(name).debug/warn(...)`. Nothing
    // retains those chains, so a throw out of the reporting handler becomes an unhandled
    // rejection mid-lifecycle - fatal under Node's default `--unhandled-rejections=throw`.
    // `this.logger` is the caller's own object, so "logging does not throw" is their
    // guarantee to keep, not this file's to assume; the shutdown-warning chain already
    // carried a terminal `.catch()` for exactly this and the other seven did not.
    const throwingLogger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });

    // Everything else on the logger keeps working; only the `entity(...)` call these
    // detached chains report through throws. `LifecycleManager` takes
    // `rootLogger.service(name)` once in its constructor, so the service it is handed is
    // where this goes.
    const realService = throwingLogger.service.bind(throwingLogger);

    // Armed only for the window the late rejection lands in. Broken from the start, the
    // manager's ordinary logging throws too and the test stops being about the detached
    // chain at all.
    let isLoggerBroken = false;

    throwingLogger.service = (serviceName: string): LoggerService => {
      const service = realService(serviceName);
      const realEntity = service.entity.bind(service);

      service.entity = (entityName: string): LoggerService => {
        if (isLoggerBroken) {
          throw new Error('the logger itself is broken');
        }

        return realEntity(entityName);
      };

      return service;
    };

    const lifecycle = new LifecycleManager({ logger: throwingLogger });

    class LateFailingHealthCheck extends BaseComponent {
      public start(): void {}
      public stop(): void {}
      public async healthCheck(): Promise<boolean> {
        // Past `healthCheckTimeoutMS`, then rejects - which is the chain the detached
        // `.catch()` exists to report.
        await new Promise((resolve) => setTimeout(resolve, 120));

        throw new Error('health check failed long after it timed out');
      }
    }

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      await lifecycle.registerComponent(
        new LateFailingHealthCheck(logger, {
          name: 'late-health',
          healthCheckTimeoutMS: 20,
        }),
      );

      await lifecycle.startComponent('late-health');

      // Returns on the timeout, well before the health check itself rejects.
      await lifecycle.checkComponentHealth('late-health');

      isLoggerBroken = true;

      // Long enough for the late rejection, and its reporting handler, to land.
      await new Promise((resolve) => setTimeout(resolve, 250));

      isLoggerBroken = false;

      expect(rejections).toEqual([]);

      await lifecycle.stopAllComponents();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /** The first log with `message`, polled for up to `deadlineMS`; `undefined` past it. */
  async function untilLogged(
    sink: ArraySink,
    message: string,
    deadlineMS: number,
  ): Promise<LogEntry | undefined> {
    const startedAt = Date.now();

    for (;;) {
      const found = sink.logs.find((log) => log.message === message);

      if (found !== undefined || Date.now() - startedAt > deadlineMS) {
        return found;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Make one private step of the manager throw, so a detached chain's *body* fails while
   * the handler that reports the failure still works.
   *
   * These used to inject the failure through a logger that refused one message. The
   * manager guards its own logger now, so no log line can fail a chain body; the step
   * has to be one that does real work.
   */
  function internalStepThatThrows(
    lifecycle: LifecycleManager,
    step: string,
    message: string,
  ): void {
    (lifecycle as unknown as Record<string, () => never>)[step] = (): never => {
      throw new Error(message);
    };
  }

  test('a late stop resolution that fails is logged as such, not dropped or fatal', async () => {
    // `handleLateStopResolution` mutates state in sequence, and a throw partway leaves the
    // component half-transitioned. The chain that runs it reports that through
    // `'Late stop resolution failed'`; without that report the only trace was a stuck
    // state read much later, and without the terminal `.catch` an unhandled rejection.
    const lifecycle = new LifecycleManager({ logger });

    // Called from the middle of that sequence, after the state writes and before the
    // late-resolution log line and its events.
    internalStepThatThrows(
      lifecycle,
      'resolvePendingForceStopWaiters',
      'late stop resolution exploded',
    );

    class SlowStop extends BaseComponent {
      constructor() {
        super(logger, {
          name: 'slow',
          shutdownGracefulTimeoutMS: 1000,
          shutdownForceTimeoutMS: 500,
        });
      }
      public start(): void {}
      public async stop(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      await lifecycle.registerComponent(new SlowStop());
      await lifecycle.startComponent('slow');

      const result = await lifecycle.stopComponent('slow');

      expect(result.code).toBe('component_shutdown_timeout');
      expect(lifecycle.getComponentStatus('slow')?.state).toBe('stalled');

      // Polled rather than slept for a fixed margin: `stop()` resolves 500ms past the
      // graceful timeout, and a loaded CI runner can stretch that.
      const report = await untilLogged(
        arraySink,
        'Late stop resolution failed',
        3000,
      );

      expect(report?.type).toBe('warn');
      expect((report?.params?.['error'] as Error).message).toBe(
        'late stop resolution exploded',
      );
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }, 5000);

  test('a stop rejection after its timeout is logged', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class LateRejectingStop extends BaseComponent {
      constructor() {
        super(logger, {
          name: 'late-stop-rejection',
          shutdownGracefulTimeoutMS: 10,
        });
      }
      public start(): void {}
      public async stop(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('late graceful failure');
      }
    }

    const component = new LateRejectingStop();

    // Keep the regression fast while exercising the same post-timeout branch. The
    // public constructor intentionally clamps this setting to at least one second.
    (
      component as unknown as { shutdownGracefulTimeoutMS: number }
    ).shutdownGracefulTimeoutMS = 10;

    await lifecycle.registerComponent(component);
    await lifecycle.startComponent('late-stop-rejection');
    await lifecycle.stopComponent('late-stop-rejection');

    const report = await untilLogged(
      arraySink,
      'Component stop failed after timeout',
      1000,
    );

    expect((report?.params?.['error'] as Error).message).toBe(
      'late graceful failure',
    );
  });

  test('a force-stop rejection after its timeout is logged', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class LateRejectingForceStop extends BaseComponent {
      constructor() {
        super(logger, {
          name: 'late-force-rejection',
          shutdownForceTimeoutMS: 10,
        });
      }
      public start(): void {}
      public stop(): void {
        throw new Error('enter force phase');
      }
      public async onShutdownForce(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new Error('late force failure');
      }
    }

    const component = new LateRejectingForceStop();

    // As above, bypass only the public minimum so the test need not sleep for 500ms.
    (
      component as unknown as { shutdownForceTimeoutMS: number }
    ).shutdownForceTimeoutMS = 10;

    await lifecycle.registerComponent(component);
    await lifecycle.startComponent('late-force-rejection');
    await lifecycle.stopComponent('late-force-rejection');

    const report = await untilLogged(
      arraySink,
      'Force shutdown failed after timeout',
      1000,
    );

    expect((report?.params?.['error'] as Error).message).toBe(
      'late force failure',
    );
  });

  test('a late startup completion whose handling fails is logged as such, not dropped or fatal', async () => {
    // The recovery body stops a component that finished starting after the manager gave
    // up on it. A failure there means that stop silently did not happen, which is what
    // `'Late startup completion handling ended in a failure'` exists to say.
    const lifecycle = new LifecycleManager({ logger });

    internalStepThatThrows(
      lifecycle,
      'stopComponentInternal',
      'automatic stop exploded',
    );

    class LateStart extends BaseComponent {
      constructor() {
        super(logger, { name: 'late', startupTimeoutMS: 20 });
      }
      public async start(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      public stop(): void {}
    }

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      await lifecycle.registerComponent(new LateStart());

      const result = await lifecycle.startComponent('late');

      expect(result.code).toBe('component_startup_timeout');

      const report = await untilLogged(
        arraySink,
        'Late startup completion handling ended in a failure',
        2000,
      );

      expect(report?.type).toBe('debug');
      expect((report?.params?.['error'] as Error).message).toBe(
        'automatic stop exploded',
      );
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('an unreadable error from onStartupAborted does not escape the timer', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class SlowComponent extends BaseComponent {
      public async start(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      public stop(): void {}
      public onStartupAborted(): void {
        throw unreadableError();
      }
    }

    await lifecycle.registerComponent(
      new SlowComponent(logger, { name: 'slow', startupTimeoutMS: 50 }),
    );

    // The abort callback runs from a timer, where an escaping throw has no caller to
    // catch it and the runtime treats it as uncaught.
    await lifecycle.startComponent('slow');

    expect(
      arraySink.logs.some((log) =>
        log.message.includes('Error in onStartupAborted callback'),
      ),
    ).toBe(true);

    await lifecycle.stopAllComponents();
  });

  test('an async rejection from onStartupAborted is reported, not unhandled', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class SlowComponent extends BaseComponent {
      public async start(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      public stop(): void {}
      public onStartupAborted(): void {
        // TypeScript permits an async implementation at runtime even though the hook is
        // declared `void`; spell that shape without weakening the production interface.
        return Promise.reject(
          new Error('async abort failed'),
        ) as unknown as void;
      }
    }

    await lifecycle.registerComponent(
      new SlowComponent(logger, { name: 'async-abort', startupTimeoutMS: 10 }),
    );

    await lifecycle.startComponent('async-abort');
    await Promise.resolve();

    expect(
      arraySink.logs.some(
        (log) =>
          log.message.includes('Error in onStartupAborted callback') &&
          (log.params?.['error'] as Error | undefined)?.message ===
            'async abort failed',
      ),
    ).toBe(true);

    await lifecycle.stopAllComponents();
  });

  test('an async rejection from onGracefulStopTimeout is reported', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class SlowStop extends BaseComponent {
      public start(): void {}
      public async stop(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      public onGracefulStopTimeout(): void {
        return Promise.reject(
          new Error('async graceful abort failed'),
        ) as unknown as void;
      }
    }

    const component = new SlowStop(logger, { name: 'async-graceful-abort' });

    // Keep the regression quick; the public constructor intentionally clamps this value.
    (
      component as unknown as { shutdownGracefulTimeoutMS: number }
    ).shutdownGracefulTimeoutMS = 10;

    await lifecycle.registerComponent(component);
    await lifecycle.startComponent(component.getName());
    await lifecycle.stopComponent(component.getName());
    await Promise.resolve();

    expect(
      arraySink.logs.some(
        (log) =>
          log.message.includes('Error in onGracefulStopTimeout callback') &&
          (log.params?.['error'] as Error | undefined)?.message ===
            'async graceful abort failed',
      ),
    ).toBe(true);
  });

  test('an async rejection from onShutdownForceAborted is reported', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class SlowForce extends BaseComponent {
      public start(): void {}
      public stop(): void {
        throw new Error('enter force phase');
      }
      public async onShutdownForce(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      public onShutdownForceAborted(): void {
        return Promise.reject(
          new Error('async force abort failed'),
        ) as unknown as void;
      }
    }

    const component = new SlowForce(logger, { name: 'async-force-abort' });

    (
      component as unknown as { shutdownForceTimeoutMS: number }
    ).shutdownForceTimeoutMS = 10;

    await lifecycle.registerComponent(component);
    await lifecycle.startComponent(component.getName());
    await lifecycle.stopComponent(component.getName());
    await Promise.resolve();

    expect(
      arraySink.logs.some(
        (log) =>
          log.message.includes('Error in onShutdownForceAborted callback') &&
          (log.params?.['error'] as Error | undefined)?.message ===
            'async force abort failed',
      ),
    ).toBe(true);
  });

  test('an unreadable error thrown from start() settles as a failure result', async () => {
    // `toError` returns an `Error`-branded value unchanged, so the `catch` in
    // `startComponent` was reading `.message` off the very value whose accessor throws -
    // with nothing above it left to catch, so the start rejected instead of failing.
    const lifecycle = new LifecycleManager({ logger });

    class ThrowsUnreadable extends BaseComponent {
      public start(): void {
        throw unreadableError();
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new ThrowsUnreadable(logger, { name: 'unreadable-start' }),
    );

    const events: string[] = [];

    lifecycle.on('component:start-failed', () => {
      events.push('start-failed');
    });

    const result = await lifecycle.startComponent('unreadable-start');

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.reason).toBe('<error message could not be read>');
    expect(events).toEqual(['start-failed']);
    expect(lifecycle.getComponentStatus('unreadable-start')?.state).toBe(
      'registered',
    );
  });

  test('an unreadable error thrown from stop() settles as a failure result', async () => {
    // Two reads sat on this path: the graceful `catch` building its result, and the
    // force phase reading `gracefulError.message` for a component with no
    // `onShutdownForce` to fall back on.
    const lifecycle = new LifecycleManager({ logger });

    class StopThrowsUnreadable extends BaseComponent {
      public start(): void {}
      public stop(): void {
        throw unreadableError();
      }
    }

    await lifecycle.registerComponent(
      new StopThrowsUnreadable(logger, { name: 'unreadable-stop' }),
    );
    await lifecycle.startComponent('unreadable-stop');

    const events: string[] = [];

    lifecycle.on('component:stalled', () => {
      events.push('stalled');
    });

    const result = await lifecycle.stopComponent('unreadable-stop');

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.reason).toBe('<error message could not be read>');
    expect(events).toEqual(['stalled']);
    expect(lifecycle.getComponentStatus('unreadable-stop')?.state).toBe(
      'stalled',
    );
  });

  test('an unreadable error thrown while registering settles as a rejected result', async () => {
    // The registration `catch` read `err.message` unguarded. `toError` returns a
    // brand-claiming value unchanged, so a `message` accessor that throws reached it and
    // `registerComponent`/`insertComponentAt` *rejected* - out of the one `catch` whose job
    // is to answer with a rejected result instead of throwing.
    const lifecycle = new LifecycleManager({ logger });

    class DependenciesThrowUnreadable extends BaseComponent {
      public getDependencies(): string[] {
        throw unreadableError();
      }
      public start(): void {}
      public stop(): void {}
    }

    const result = await lifecycle.registerComponent(
      new DependenciesThrowUnreadable(logger, { name: 'unreadable-deps' }),
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.reason).toBe('<error message could not be read>');
  });

  test('an unreadable error thrown from onShutdownForce() still marks the component stalled', async () => {
    // The force `catch` compared `err.message` against the timeout text before anything
    // else, so an accessor that throws there skipped the whole stall path: the component
    // was never marked stalled and `component:stalled` never fired.
    const lifecycle = new LifecycleManager({ logger });

    class ForceThrowsUnreadable extends BaseComponent {
      public start(): void {}
      public stop(): void {
        throw new Error('graceful refused');
      }
      public onShutdownForce(): void {
        throw unreadableError();
      }
    }

    await lifecycle.registerComponent(
      new ForceThrowsUnreadable(logger, { name: 'unreadable-force' }),
    );
    await lifecycle.startComponent('unreadable-force');

    const events: string[] = [];

    lifecycle.on('component:stalled', () => {
      events.push('stalled');
    });

    const result = await lifecycle.stopComponent('unreadable-force');

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.reason).toBe('<error message could not be read>');
    expect(events).toEqual(['stalled']);
    expect(lifecycle.getComponentStatus('unreadable-force')?.state).toBe(
      'stalled',
    );
  });
});

describe('LifecycleManager timeouts that a timer cannot keep', () => {
  // `setTimeout` reads `Infinity` and `NaN` as `0`, and anything past 2^31-1 ms as `1`, so
  // every one of these inverts: the longer the wait someone configures, the sooner it
  // happens. For a *timeout* that means the safety net fires on the next tick and tears
  // down a component that was doing nothing wrong.
  test('an Infinity startup timeout does not abort a healthy startup at once', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const lifecycle = new LifecycleManager({ logger });

    class Slow extends BaseComponent {
      constructor() {
        super(logger, { name: 'slow', startupTimeoutMS: Infinity });
      }
      public async start(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(new Slow());

    const result = await lifecycle.startComponent('slow');

    // Before the clamp this was `component_startup_timeout`, fired immediately: the
    // component asking to be given all the time it needed was given none.
    expect(result.code).not.toBe('component_startup_timeout');

    await lifecycle.stopAllComponents();
  });

  test('a NaN startup timeout still arms the bounded safety timer', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const lifecycle = new LifecycleManager({ logger });

    class Immediate extends BaseComponent {
      constructor() {
        super(logger, { name: 'immediate', startupTimeoutMS: Number.NaN });
      }
      public start(): void {}
      public stop(): void {}
    }

    await lifecycle.registerComponent(new Immediate());
    const timeoutSpy = spyOn(globalThis, 'setTimeout');

    try {
      const result = await lifecycle.startComponent('immediate');

      expect(result.success).toBe(true);
      expect(
        timeoutSpy.mock.calls.some((call) => call[1] === MAX_TIMER_MS),
      ).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      await lifecycle.stopAllComponents();
    }
  });

  test('a negative startup timeout still arms the bounded safety timer', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const lifecycle = new LifecycleManager({ logger });

    class Immediate extends BaseComponent {
      constructor() {
        super(logger, { name: 'negative', startupTimeoutMS: -1 });
      }
      public start(): void {}
      public stop(): void {}
    }

    await lifecycle.registerComponent(new Immediate());
    const timeoutSpy = spyOn(globalThis, 'setTimeout');

    try {
      expect((await lifecycle.startComponent('negative')).success).toBe(true);
      expect(
        timeoutSpy.mock.calls.some((call) => call[1] === MAX_TIMER_MS),
      ).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      await lifecycle.stopAllComponents();
    }
  });

  test('a NaN start-all timeout still arms the bounded safety timer', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const lifecycle = new LifecycleManager({ logger });

    class Immediate extends BaseComponent {
      public start(): void {}
      public stop(): void {}
    }

    await lifecycle.registerComponent(
      new Immediate(logger, { name: 'immediate' }),
    );
    const timeoutSpy = spyOn(globalThis, 'setTimeout');

    try {
      const result = await lifecycle.startAllComponents({
        timeoutMS: Number.NaN,
      });

      expect(result.success).toBe(true);
      expect(
        timeoutSpy.mock.calls.some((call) => call[1] === MAX_TIMER_MS),
      ).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      await lifecycle.stopAllComponents();
    }
  });

  test('a NaN signal timeout still arms the bounded safety timer', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const lifecycle = new LifecycleManager({ logger });

    class Reloadable extends BaseComponent {
      public start(): void {}
      public stop(): void {}
      public onReload(): void {}
    }

    await lifecycle.registerComponent(
      new Reloadable(logger, {
        name: 'reloadable',
        signalTimeoutMS: Number.NaN,
      }),
    );
    await lifecycle.startAllComponents();
    const timeoutSpy = spyOn(globalThis, 'setTimeout');

    try {
      const result = await lifecycle.triggerReload();

      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.called).toBe(true);
      expect(result.results[0]?.timedOut).toBe(false);
      expect(
        timeoutSpy.mock.calls.some((call) => call[1] === MAX_TIMER_MS),
      ).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
      await lifecycle.stopAllComponents();
    }
  });

  test('a startup timeout past the 32-bit timer ceiling does not fire on the next tick', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const lifecycle = new LifecycleManager({ logger });

    class Slow extends BaseComponent {
      constructor() {
        // Reads as "about 34 days"; `setTimeout` reads it as 1ms.
        super(logger, { name: 'slow', startupTimeoutMS: 3e9 });
      }
      public async start(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(new Slow());

    const result = await lifecycle.startComponent('slow');

    expect(result.code).not.toBe('component_startup_timeout');

    await lifecycle.stopAllComponents();
  });

  test('an ordinary startup timeout still fires', async () => {
    // The clamp must not turn the safety net off: a component that genuinely overruns is
    // still stopped.
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const lifecycle = new LifecycleManager({ logger });

    class TooSlow extends BaseComponent {
      constructor() {
        super(logger, { name: 'too-slow', startupTimeoutMS: 20 });
      }
      public async start(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      public stop(): void {}
    }

    await lifecycle.registerComponent(new TooSlow());

    const result = await lifecycle.startComponent('too-slow');

    expect(result.code).toBe('component_startup_timeout');

    await lifecycle.stopAllComponents();
  });
});
