/**
 * Tests for the guard the manager puts around its own logger.
 *
 * The caller supplies the `Logger`, so every line `LifecycleManager` writes runs code it
 * does not own - inside OS signal handlers, timer callbacks, and the middle of startup
 * and shutdown passes. The guard's job is that none of that can fail or derail an
 * operation, and that the failure still gets said somewhere.
 */

import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { createGuardedLoggerService } from './guarded-logger';
import { LifecycleManager } from './lifecycle-manager';

/** The `void`-returning log methods, in the order the guard declares them. */
const LOG_METHODS = [
  'debug',
  'error',
  'errorObject',
  'info',
  'notice',
  'raw',
  'success',
  'warn',
] as const;

/**
 * Collect every report on the global `'error'` channel while `run()` executes.
 *
 * `preventDefault()` claims each one: it asserts the report was dispatched at all, and
 * keeps the `console.error` fall-through out of the test output.
 */
async function collectReports(
  run: () => Promise<void> | void,
): Promise<Error[]> {
  const reports: Error[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error as Error);
    event.preventDefault();
  };

  globalThis.addEventListener('error', onError);

  try {
    await run();
    // Let a rejected promise adopted by the guard settle before the listener comes off.
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    globalThis.removeEventListener('error', onError);
  }

  return reports;
}

/** A `Logger` whose service loggers fail in `mode` on every method, `entity` included. */
function hostileLogger(mode: 'throw' | 'reject'): Logger {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });

  const fail = (methodName: string): unknown => {
    const error = new Error(`hostile logger ${methodName}`);

    if (mode === 'throw') {
      throw error;
    }

    return Promise.reject(error);
  };

  logger.service = (): LoggerService => {
    const service: Record<string, unknown> = {
      entity: (): unknown => fail('entity'),
    };

    for (const methodName of LOG_METHODS) {
      service[methodName] = (): unknown => fail(methodName);
    }

    return service as unknown as LoggerService;
  };

  return logger;
}

class Simple extends BaseComponent {
  public startCount = 0;
  public stopCount = 0;

  constructor(logger: Logger, name: string) {
    super(logger, { name, dependencies: [] });
  }

  public start(): Promise<void> {
    this.startCount++;
    return Promise.resolve();
  }

  public stop(): Promise<void> {
    this.stopCount++;
    return Promise.resolve();
  }
}

describe('createGuardedLoggerService', () => {
  test('passes messages and params through unchanged', () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const guarded = createGuardedLoggerService(logger.service('svc'));

    guarded.info('plain line', { params: { a: 1 } });
    guarded.entity('ent').warn('entity line', { params: { b: 2 } });

    const [plain, entity] = sink.logs;

    expect(plain?.message).toBe('plain line');
    expect(plain?.type).toBe('info');
    expect(plain?.params?.['a']).toBe(1);
    expect(entity?.message).toBe('entity line');
    expect(entity?.type).toBe('warn');
    expect(entity?.params?.['b']).toBe(2);
    expect(entity?.entityName).toBe('ent');
  });

  test('a method that throws is contained and reported under its own name', async () => {
    const guarded = createGuardedLoggerService(
      hostileLogger('throw').service('svc'),
    );

    for (const methodName of LOG_METHODS) {
      const reports = await collectReports(() => {
        expect(() => {
          (guarded[methodName] as (message: string) => void)('line');
        }).not.toThrow();
      });

      expect(reports.length).toBe(1);
      expect(reports[0]?.message).toContain(
        `lifecycle-manager logger.${methodName}`,
      );
      // The thrown value travels on `cause`, never rendered into the label.
      expect((reports[0]?.cause as Error).message).toBe(
        `hostile logger ${methodName}`,
      );
    }
  });

  test('a method that returns a rejecting promise is reported, not left floating', async () => {
    const guarded = createGuardedLoggerService(
      hostileLogger('reject').service('svc'),
    );

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      for (const methodName of LOG_METHODS) {
        const reports = await collectReports(() => {
          (guarded[methodName] as (message: string) => void)('line');
        });

        expect(reports.length).toBe(1);
        expect(reports[0]?.message).toContain(
          `lifecycle-manager logger.${methodName}`,
        );
      }

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('entity() that throws still hands back something callable', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    service.entity = (): never => {
      throw new Error('entity exploded');
    };

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      // The whole `entity(name).info(...)` chain, which is how the manager logs
      // per-component lines.
      expect(() => {
        guarded.entity('ent').info('still logged');
      }).not.toThrow();
    });

    expect(reports.length).toBe(1);
    expect(reports[0]?.message).toContain('lifecycle-manager logger.entity');

    // Falls back to the parent, so the line lands without the entity name.
    expect(sink.logs[0]?.message).toBe('still logged');
    expect(sink.logs[0]?.entityName).toBeUndefined();
  });

  test('entity() is called itself, not a call property it carries', () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');
    const originalEntity = service.entity.bind(service);

    // Shadows `Function.prototype.call`. Reading it off `entity` would run this, and
    // its return value would become the child logger.
    service.entity = Object.assign(
      (name: string): LoggerService => originalEntity(name),
      { call: (): LoggerService => null as unknown as LoggerService },
    );

    createGuardedLoggerService(service).entity('ent').info('entity line');

    expect(sink.logs[0]?.entityName).toBe('ent');
  });

  test('entity() that returns a non-logger is reported and falls back', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    service.entity = (): LoggerService => null as unknown as LoggerService;

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('still logged');
    });

    expect(reports.length).toBe(1);
    expect(reports[0]?.message).toContain('lifecycle-manager logger.entity');
    expect(sink.logs[0]?.message).toBe('still logged');
  });

  test('entity() that returns undefined is reported and falls back', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    // Indistinguishable from a throw by the returned value alone, which is how it used
    // to go unreported: returning nothing is still a logger handing back a non-logger.
    service.entity = (): LoggerService => undefined as unknown as LoggerService;

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('still logged');
    });

    expect(reports.length).toBe(1);
    expect((reports[0]?.cause as Error).message).toBe(
      'lifecycle-manager logger.entity did not return a logger',
    );
    expect(sink.logs[0]?.message).toBe('still logged');
  });

  test('entity() that returns a resolving promise is reported and falls back', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    // A rejection was already reported by the guard that adopted it; a promise that
    // resolves reported nothing, so the chain silently lost its entity name.
    service.entity = (): LoggerService =>
      Promise.resolve({}) as unknown as LoggerService;

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('still logged');
    });

    expect(reports.length).toBe(1);
    expect((reports[0]?.cause as Error).message).toBe(
      'lifecycle-manager logger.entity did not return a logger',
    );

    // Falls back to the parent, so the line lands without the entity name.
    expect(sink.logs[0]?.message).toBe('still logged');
    expect(sink.logs[0]?.entityName).toBeUndefined();
  });

  test('entity() that returns a rejecting promise is reported once, with the reason', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    service.entity = (): LoggerService =>
      Promise.reject(new Error('entity rejected')) as unknown as LoggerService;

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('still logged');
    });

    // One failure, one report - and the rejection reason is the useful half of it, so
    // that is the one that travels rather than a generic "not a logger".
    expect(reports.length).toBe(1);
    expect(reports[0]?.message).toContain('lifecycle-manager logger.entity');
    expect((reports[0]?.cause as Error).message).toBe('entity rejected');
    expect(sink.logs[0]?.message).toBe('still logged');
  });

  test('entity() that returns an object whose then getter throws is contained', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    // Detecting a thenable reads `then`; that read is the logger's code to break.
    service.entity = (): LoggerService =>
      ({
        get then(): never {
          throw new Error('then getter exploded');
        },
      }) as unknown as LoggerService;

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      expect(() => {
        guarded.entity('ent').info('still logged');
      }).not.toThrow();
    });

    expect(reports.length).toBe(1);
    expect((reports[0]?.cause as Error).message).toBe('then getter exploded');
    expect(sink.logs[0]?.message).toBe('still logged');
    expect(sink.logs[0]?.entityName).toBeUndefined();
  });

  test('entity() that returns a thenable whose then getter throws on adoption is contained', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    // The first read (detection) sees a function; the second (adoption by
    // `Promise.resolve`) throws. Both reads happen synchronously.
    let reads = 0;
    service.entity = (): LoggerService =>
      ({
        get then(): unknown {
          reads++;

          if (reads > 1) {
            throw new Error('then getter exploded on adoption');
          }

          return (): void => {};
        },
      }) as unknown as LoggerService;

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      expect(() => {
        guarded.entity('ent').info('still logged');
      }).not.toThrow();
    });

    expect(reports.length).toBe(1);
    expect((reports[0]?.cause as Error).message).toBe(
      'then getter exploded on adoption',
    );
    expect(sink.logs[0]?.message).toBe('still logged');
  });

  test('a method behind a throwing getter is contained and reported', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    // The read happens before there is a wrapper to route the call through, so the
    // guard has to contain it itself.
    Object.defineProperty(service, 'warn', {
      configurable: true,
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      expect(() => {
        guarded.warn('dropped');
      }).not.toThrow();
    });

    expect(reports.length).toBe(1);
    expect(reports[0]?.message).toContain('lifecycle-manager logger.warn');
    expect((reports[0]?.cause as Error).message).toBe('getter exploded');
    expect(sink.logs).toEqual([]);
  });

  test('an entity() behind a throwing getter still hands back something callable', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    Object.defineProperty(service, 'entity', {
      configurable: true,
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      expect(() => {
        guarded.entity('ent').info('still logged');
      }).not.toThrow();
    });

    expect(reports.length).toBe(1);
    expect(reports[0]?.message).toContain('lifecycle-manager logger.entity');
    expect((reports[0]?.cause as Error).message).toBe('getter exploded');

    // Falls back to the parent, exactly as a throwing `entity()` call does.
    expect(sink.logs[0]?.message).toBe('still logged');
    expect(sink.logs[0]?.entityName).toBeUndefined();
  });

  test('a swapped-in method is picked up, and swapping the original back does not recurse', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);

    // What the hostile-logger tests do: capture through the guard, install a throwing
    // method, then put the captured one back. The capture is a wrapper, so a guard that
    // re-read the method when called would find itself.
    // The guard hands back a standalone wrapper, not a method needing its receiver.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const captured = guarded.info;

    guarded.info = (): never => {
      throw new Error('swapped in');
    };

    const reports = await collectReports(() => {
      guarded.info('dropped');
    });

    expect(reports.length).toBe(1);
    expect((reports[0]?.cause as Error).message).toBe('swapped in');

    guarded.info = captured;
    guarded.info('logged again');

    expect(sink.logs.map((entry) => entry.message)).toEqual(['logged again']);
  });

  test('wrapping adds nothing to the service it wraps', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const keysBefore = Object.keys(service);

    const guarded = createGuardedLoggerService(service);

    guarded.info('a line');
    guarded.entity('ent').info('another line');

    expect(Object.keys(service)).toEqual(keysBefore);
  });

  test('assignment through the guard lands on the underlying service', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);
    const replacement = (): void => {};

    guarded.info = replacement;

    expect(Object.hasOwn(service, 'info')).toBe(true);
    expect((service as unknown as { info: unknown }).info).toBe(replacement);
  });
});

describe('LifecycleManager - a logger that cannot be trusted', () => {
  for (const mode of ['throw', 'reject'] as const) {
    test(`a logger that ${mode}s on every method does not derail startup, shutdown, or restart`, async () => {
      const logger = hostileLogger(mode);
      const manager = new LifecycleManager({
        logger,
        shutdownWarningTimeoutMS: -1,
      });
      const component = new Simple(logger, 'simple');

      const rejections: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        rejections.push(reason);
      };

      process.on('unhandledRejection', onUnhandled);

      try {
        const reports = await collectReports(async () => {
          await manager.registerComponent(component);

          const started = await manager.startAllComponents();
          expect(started.success).toBe(true);
          expect(manager.isComponentRunning('simple')).toBe(true);

          const restarted = await manager.restartAllComponents();
          expect(restarted.success).toBe(true);
          expect(component.startCount).toBe(2);

          const stopped = await manager.stopAllComponents();
          expect(stopped.success).toBe(true);
          expect(stopped.stalledComponents).toEqual([]);
          expect(manager.isComponentRunning('simple')).toBe(false);
          expect(manager.getComponentStatus('simple')?.state).toBe('stopped');
        });

        // Every line the manager wrote failed, and every failure was said out loud on
        // the global channel rather than swallowed or routed back through the logger.
        expect(reports.length).toBeGreaterThan(0);
        expect(
          reports.every((report) =>
            report.message.startsWith(
              'Error in a callback lifecycle-manager logger.',
            ),
          ),
        ).toBe(true);
        expect(rejections).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  }

  test("the caller's logger object is neither wrapped nor modified", () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    // Compared by identity below, never called.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const serviceBefore = logger.service;
    const keysBefore = Object.keys(logger);

    const manager = new LifecycleManager({ logger });

    const internals = manager as unknown as {
      rootLogger: Logger;
      logger: LoggerService;
    };

    // `enableLoggerExitHook`, `exit()`, and every component's own logger go through this
    // object, so it has to stay exactly what the caller passed in - same identity, same
    // methods, nothing added.
    expect(internals.rootLogger).toBe(logger);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- identity again.
    expect(logger.service).toBe(serviceBefore);
    expect(Object.keys(logger)).toEqual(keysBefore);

    // Only the manager's own service logger is the stand-in.
    expect(internals.logger).not.toBe(logger);
  });
});
