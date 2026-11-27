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
import type { LifecycleManagerEventMap } from './events';
import { coreOf } from './test-helpers';
import { MAX_TIMER_MS } from '../internal/timer-limits';
import {
  ComponentStartTimeoutError,
  ComponentStopTimeoutError,
} from './errors';

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
    // The signal handler starts the shutdown pass and lets it float, and that pass was
    // once `try`/`finally` with no `catch`. A logger that threw while the shutdown
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
      coreOf(lifecycle).shutdownEscalation.handleShutdownRequest('SIGTERM');

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

  test('a logger that throws while reporting a late failure is contained and reported', async () => {
    // Detached chains report late failures through `this.logger.entity(name)`, and
    // nothing retains them, so a throw out of the reporting handler would be an unhandled
    // rejection mid-lifecycle - fatal under Node's default `--unhandled-rejections=throw`.
    // The manager wraps its logger once (`createGuardedLoggerService`), so the throw is
    // caught inside the logger call and reported on the global `'error'` channel; it
    // never reaches the chain's own terminal `.catch()`. Assert that report, so the test
    // fails if the guard stops containing it.
    const throwingLogger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });

    // Everything else on the logger keeps working; only the entity loggers these
    // detached chains report through throw. `LifecycleManager` takes
    // `rootLogger.service(name)` once in its constructor, so the service it is handed is
    // where this goes. The entity *child's* methods are what break, not `entity()`
    // itself: the manager keeps one guarded child per name, built the first time the
    // component is logged about - long before the window below - so a broken
    // `entity()` would never be called again and the test would pass without reaching
    // the path it is about.
    const realService = throwingLogger.service.bind(throwingLogger);

    // Armed only for the window the late rejection lands in. Broken from the start, the
    // manager's ordinary logging throws too and the test stops being about the detached
    // chain at all.
    let isLoggerBroken = false;
    let brokenCalls = 0;

    throwingLogger.service = (serviceName: string): LoggerService => {
      const service = realService(serviceName);
      const realEntity = service.entity.bind(service);

      service.entity = (entityName: string): LoggerService => {
        const child = realEntity(entityName);

        for (const method of ['debug', 'info', 'warn', 'error'] as const) {
          const realMethod = child[method].bind(child);

          child[method] = (
            ...args: Parameters<LoggerService['info']>
          ): void => {
            if (isLoggerBroken) {
              brokenCalls++;
              throw new Error('the logger itself is broken');
            }

            realMethod(...args);
          };
        }

        return child;
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

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    process.on('unhandledRejection', onUnhandled);
    globalThis.addEventListener('error', onError);

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

      // The late rejection's report went through the broken logger.
      expect(brokenCalls).toBeGreaterThan(0);
      expect(rejections).toEqual([]);
      // Each broken call was contained by the guarded logger and reported, labelled by
      // the logger method.
      expect(reports).toHaveLength(brokenCalls);
      for (const report of reports) {
        expect((report as Error).message).toContain(
          'lifecycle-manager logger.',
        );
        expect(((report as Error).cause as Error).message).toBe(
          'the logger itself is broken',
        );
      }

      await lifecycle.stopAllComponents();
    } finally {
      globalThis.removeEventListener('error', onError);
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
   * Make one private step of the manager - on one of its subsystems - throw, so a
   * detached chain's *body* fails while the handler that reports the failure still works.
   *
   * These used to inject the failure through a logger that refused one message. The
   * manager guards its own logger now, so no log line can fail a chain body; the step
   * has to be one that does real work.
   */
  function internalStepThatThrows(
    owner: object,
    step: string,
    message: string,
  ): void {
    (owner as Record<string, () => never>)[step] = (): never => {
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
      coreOf(lifecycle).stopOutcomes,
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
      'Component stop failed after deadline fired',
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
      'Force shutdown failed after deadline fired',
      1000,
    );

    expect((report?.params?.['error'] as Error).message).toBe(
      'late force failure',
    );
  });

  test('a late startup completion whose handling fails is reported, not dropped or fatal', async () => {
    // The recovery body stops a component that finished starting after the manager gave
    // up on it. A failure there means that stop may not have happened, so it is logged
    // as a warning and reported on the global channel.
    const lifecycle = new LifecycleManager({ logger });

    internalStepThatThrows(
      coreOf(lifecycle).componentStop,
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
    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    process.on('unhandledRejection', onUnhandled);
    globalThis.addEventListener('error', onError);

    try {
      await lifecycle.registerComponent(new LateStart());

      const result = await lifecycle.startComponent('late');

      expect(result.code).toBe('component_startup_timeout');

      const report = await untilLogged(
        arraySink,
        'Late startup completion handling failed',
        2000,
      );

      expect(report?.type).toBe('warn');
      expect((report?.params?.['error'] as Error).message).toBe(
        'automatic stop exploded',
      );
      expect(
        reports.some((entry) =>
          (entry as Error).message.includes(
            'lifecycle-manager late startup cleanup',
          ),
        ),
      ).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      globalThis.removeEventListener('error', onError);
    }
  });

  test('a failure while finishing late startup cleanup is reported without an unhandled rejection', async () => {
    const lifecycle = new LifecycleManager({ logger, startupTimeoutMS: 20 });
    const startup = Promise.withResolvers<void>();
    class LateStart extends BaseComponent {
      public start(): Promise<void> {
        return startup.promise;
      }
      public stop(): void {}
    }
    const signals = coreOf(lifecycle).signals;
    const original = signals.runDeferredSignalDetach.bind(signals);
    signals.runDeferredSignalDetach = (trigger): void => {
      if (trigger === 'late startup cleanup') {
        throw new Error('late detach failed');
      }
      original(trigger);
    };
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
      await lifecycle.registerComponent(
        new LateStart(logger, { name: 'late', startupTimeoutMS: 20 }),
      );
      expect((await lifecycle.startComponent('late')).code).toBe(
        'component_startup_timeout',
      );
      startup.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(
        reports.some(
          (report) =>
            (report as Error).message.includes(
              'late startup cleanup finalization',
            ) &&
            ((report as Error).cause as Error)?.message ===
              'late detach failed',
        ),
      ).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      globalThis.removeEventListener('error', onError);
    }
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
    expect(result.code).toBe('error');
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
    expect(result.code).toBe('error');
    expect(result.reason).toBe('<error message could not be read>');
    expect(events).toEqual(['stalled']);
    expect(lifecycle.getComponentStatus('unreadable-stop')?.state).toBe(
      'stalled',
    );
  });

  test('a start getter that throws is a reported crash, not a failed start()', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class Plain extends BaseComponent {
      public start(): void {}
      public stop(): void {}
    }

    const component = new Plain(logger, { name: 'start-getter' });
    await lifecycle.registerComponent(component);
    Object.defineProperty(component, 'start', {
      get: (): never => {
        throw new Error('start getter exploded');
      },
    });

    const reported: string[] = [];
    const onGlobalError = (event: Event): void => {
      event.preventDefault();
      reported.push(String(((event as ErrorEvent).error as Error)?.message));
    };
    globalThis.addEventListener('error', onGlobalError);

    let result;
    try {
      result = await lifecycle.startComponent('start-getter');
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }

    expect(result.success).toBe(false);
    expect(result.code).toBe('operation_crashed');
    expect(result.reason).toBe('start getter exploded');
    expect(reported).toEqual([
      'Error in a callback lifecycle-manager component start',
    ]);
    expect(lifecycle.getComponentStatus('start-getter')?.state).toBe(
      'registered',
    );
  });

  test('a stop getter that throws is a reported crash, not a failed stop()', async () => {
    const lifecycle = new LifecycleManager({ logger });

    class Plain extends BaseComponent {
      public start(): void {}
      public stop(): void {}
    }

    const component = new Plain(logger, { name: 'stop-getter' });
    await lifecycle.registerComponent(component);
    await lifecycle.startComponent('stop-getter');
    Object.defineProperty(component, 'stop', {
      get: (): never => {
        throw new Error('stop getter exploded');
      },
    });

    const reported: string[] = [];
    const onGlobalError = (event: Event): void => {
      event.preventDefault();
      reported.push(String(((event as ErrorEvent).error as Error)?.message));
    };
    globalThis.addEventListener('error', onGlobalError);

    let result;
    try {
      result = await lifecycle.stopComponent('stop-getter');
    } finally {
      globalThis.removeEventListener('error', onGlobalError);
    }

    expect(result.success).toBe(false);
    expect(result.code).toBe('operation_crashed');
    expect(reported).toEqual([
      'Error in a callback lifecycle-manager component stop',
    ]);
    expect(lifecycle.getComponentStatus('stop-getter')?.state).toBe('stalled');
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
    expect(result.code).toBe('operation_crashed');
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
    expect(result.code).toBe('error');
    expect(result.reason).toBe('<error message could not be read>');
    expect(events).toEqual(['stalled']);
    expect(lifecycle.getComponentStatus('unreadable-force')?.state).toBe(
      'stalled',
    );
  });
});

describe('LifecycleManager timeouts that a timer cannot keep', () => {
  for (const requestedTimeout of [Infinity, 3e9]) {
    for (const useOverride of [false, true]) {
      test(`stop timeout ${String(requestedTimeout)} from ${useOverride ? 'override' : 'component'} reports the armed timer budget`, async () => {
        const logger = new Logger({
          sinks: [new ArraySink()],
          callProcessExit: false,
        });
        const lifecycle = new LifecycleManager({ logger });
        let finishStop!: () => void;
        class Pending extends BaseComponent {
          public start(): void {}
          public stop(): Promise<void> {
            return new Promise<void>((resolve) => {
              finishStop = resolve;
            });
          }
        }
        const component = new Pending(logger, { name: 'pending' });
        Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
          value: useOverride ? 0 : requestedTimeout,
        });
        await lifecycle.registerComponent(component);
        await lifecycle.startComponent('pending');
        let eventTimeout: number | undefined;
        let eventError: Error | undefined;
        lifecycle.on('component:stop-timeout', (event) => {
          const timeoutEvent =
            event as LifecycleManagerEventMap['component:stop-timeout'];
          eventTimeout = timeoutEvent.timeoutMS;
          eventError = timeoutEvent.error;
        });
        const originalSetTimeout = globalThis.setTimeout;
        const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
          callback: () => void,
          delay?: number,
        ) =>
          originalSetTimeout(
            callback,
            delay === MAX_TIMER_MS ? 0 : delay,
          )) as typeof setTimeout);
        try {
          const result = await lifecycle.stopComponent(
            'pending',
            useOverride ? { timeout: requestedTimeout } : undefined,
          );
          const armedDelay = timeoutSpy.mock.calls.find(
            (call) => call[1] === MAX_TIMER_MS,
          )?.[1];
          expect(armedDelay).toBe(MAX_TIMER_MS);
          if (armedDelay === undefined) {
            throw new Error('Expected the bounded stop timer to be armed');
          }
          expect(result.code).toBe('component_shutdown_timeout');
          expect(result.error).toBeInstanceOf(ComponentStopTimeoutError);
          if (!(result.error instanceof ComponentStopTimeoutError)) {
            throw new Error('Expected a component stop timeout');
          }
          expect(result.error.additionalInfo.timeoutMS).toBe(armedDelay);
          expect(result.error.message).toBe(
            `Component "pending" stop timed out after ${String(armedDelay)}ms`,
          );
          expect(eventTimeout).toBe(armedDelay);
          expect(eventError).toBe(result.error);
        } finally {
          timeoutSpy.mockRestore();
          finishStop();
          await lifecycle.stopAllComponents();
        }
      });
    }
    for (const operation of ['health', 'message'] as const) {
      test(`${operation} timeout ${String(requestedTimeout)} warns with the armed timer budget`, async () => {
        const sink = new ArraySink();
        const logger = new Logger({ sinks: [sink], callProcessExit: false });
        const lifecycle = new LifecycleManager({ logger });
        class Pending extends BaseComponent {
          public start(): void {}
          public stop(): void {}
          public healthCheck(): Promise<boolean> {
            return new Promise(() => {});
          }
          public onMessage<TData = unknown>(): Promise<TData> {
            return new Promise(() => {});
          }
        }
        await lifecycle.registerComponent(
          new Pending(logger, {
            name: 'pending',
            healthCheckTimeoutMS: requestedTimeout,
          }),
        );
        await lifecycle.startComponent('pending');
        const originalSetTimeout = globalThis.setTimeout;
        const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
          callback: () => void,
          delay?: number,
        ) =>
          originalSetTimeout(
            callback,
            delay === MAX_TIMER_MS ? 0 : delay,
          )) as typeof setTimeout);
        try {
          const result =
            operation === 'health'
              ? await lifecycle.checkComponentHealth('pending')
              : await lifecycle.sendMessageToComponent('pending', null, {
                  timeout: requestedTimeout,
                });
          const armedDelay = timeoutSpy.mock.calls.find(
            (call) => call[1] === MAX_TIMER_MS,
          )?.[1];
          expect(armedDelay).toBe(MAX_TIMER_MS);
          expect(result.timedOut).toBe(true);
          const warning = sink.logs.find(
            (entry) =>
              entry.message ===
              (operation === 'health'
                ? 'Health check timed out'
                : 'Message handler timed out'),
          );
          expect(warning?.params?.timeoutMS).toBe(armedDelay);
        } finally {
          timeoutSpy.mockRestore();
          await lifecycle.stopAllComponents();
        }
      });
    }
  }

  for (const requestedTimeout of [Infinity, 3e9]) {
    for (const operation of ['bulk startup', 'force', 'signal'] as const) {
      test(`${operation} timeout ${String(requestedTimeout)} reports the armed timer budget`, async () => {
        const sink = new ArraySink();
        const logger = new Logger({ sinks: [sink], callProcessExit: false });
        const lifecycle = new LifecycleManager({ logger });
        class Pending extends BaseComponent {
          public start(): void | Promise<void> {
            if (operation === 'bulk startup') {
              return new Promise(() => {});
            }
          }
          public stop(): void {}
          public onShutdownForce(): Promise<void> {
            return new Promise(() => {});
          }
          public onReload(): Promise<void> {
            return new Promise(() => {});
          }
        }
        const component = new Pending(logger, {
          name: 'pending',
          startupTimeoutMS: 0,
          signalTimeoutMS: requestedTimeout,
        });
        // Component subclasses can expose raw values despite the base constructor's defaults.
        Object.defineProperty(component, 'shutdownForceTimeoutMS', {
          value: requestedTimeout,
        });
        await lifecycle.registerComponent(component);
        if (operation !== 'bulk startup') {
          await lifecycle.startComponent('pending');
        }
        let forceEventTimeout: number | undefined;
        lifecycle.on('component:shutdown-force-timeout', (event) => {
          forceEventTimeout = (
            event as LifecycleManagerEventMap['component:shutdown-force-timeout']
          ).timeoutMS;
        });
        const originalSetTimeout = globalThis.setTimeout;
        const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
          callback: () => void,
          delay?: number,
        ) =>
          // Bulk startup also arms its component's remaining budget, a few ms below the ceiling.
          originalSetTimeout(
            callback,
            delay !== undefined && delay > 1e9 ? 0 : delay,
          )) as typeof setTimeout);
        try {
          const result =
            operation === 'bulk startup'
              ? await lifecycle.startAllComponents({
                  timeoutMS: requestedTimeout,
                })
              : operation === 'force'
                ? await lifecycle.stopComponent('pending', {
                    forceImmediate: true,
                  })
                : await lifecycle.triggerReload();
          const armedDelay = timeoutSpy.mock.calls.find(
            (call) => call[1] === MAX_TIMER_MS,
          )?.[1];
          expect(armedDelay).toBe(MAX_TIMER_MS);
          const report = sink.logs.find(
            (entry) =>
              entry.message ===
              (operation === 'bulk startup'
                ? 'Startup timeout exceeded, returning partial results'
                : operation === 'force'
                  ? 'Force shutdown timed out - stalled'
                  : 'Reload handler timed out'),
          );
          expect(report?.params?.timeoutMS).toBe(armedDelay);
          if (operation === 'bulk startup') {
            expect(result.code).toBe('startup_timeout');
            expect('reason' in result ? result.reason : undefined).toBe(
              `Startup timeout exceeded (${String(armedDelay)}ms)`,
            );
          } else if (operation === 'force') {
            expect(result.code).toBe('component_shutdown_timeout');
            expect(forceEventTimeout).toBe(armedDelay);
          } else {
            expect(result.code).toBe('timeout');
          }
        } finally {
          timeoutSpy.mockRestore();
          if (operation === 'signal') {
            await lifecycle.stopAllComponents();
          }
        }
      });
    }
  }

  for (const startupTimeoutMS of [Infinity, 3e9]) {
    test(`startup timeout ${String(startupTimeoutMS)} reports the armed timer budget`, async () => {
      const logger = new Logger({
        sinks: [new ArraySink()],
        callProcessExit: false,
      });
      const lifecycle = new LifecycleManager({ logger });

      class Pending extends BaseComponent {
        public start(): Promise<void> {
          return new Promise<void>(() => {});
        }
        public stop(): void {}
      }

      await lifecycle.registerComponent(
        new Pending(logger, {
          name: 'pending',
          startupTimeoutMS,
          ownsLateStartCleanup: true,
        }),
      );
      const originalSetTimeout = globalThis.setTimeout;
      const timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: () => void,
        delay?: number,
      ) => {
        // Exercise the deadline without waiting for the 32-bit timer ceiling.
        return originalSetTimeout(callback, delay === MAX_TIMER_MS ? 0 : delay);
      }) as typeof setTimeout);

      try {
        const result = await lifecycle.startComponent('pending');
        const armedDelay = timeoutSpy.mock.calls.find(
          (call) => call[1] === MAX_TIMER_MS,
        )?.[1];

        expect(armedDelay).toBe(MAX_TIMER_MS);
        if (armedDelay === undefined) {
          throw new Error('Expected the bounded startup timer to be armed');
        }
        expect(result.code).toBe('component_startup_timeout');
        expect(result.error).toBeInstanceOf(ComponentStartTimeoutError);
        if (!(result.error instanceof ComponentStartTimeoutError)) {
          throw new Error('Expected a component startup timeout');
        }
        expect(result.error.additionalInfo.timeoutMS).toBe(armedDelay);
        expect(result.error.message).toBe(
          `Component "pending" start timed out after ${String(armedDelay)}ms`,
        );
        expect(result.reason).toBe(result.error.message);
      } finally {
        timeoutSpy.mockRestore();
        await lifecycle.stopAllComponents();
      }
    });
  }

  // `setTimeout` reads `Infinity` as `0`, and anything past 2^31-1 ms as `1`, so
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
