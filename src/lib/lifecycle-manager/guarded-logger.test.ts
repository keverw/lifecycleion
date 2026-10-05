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
import { LoggerService } from '../logger/logger-service';
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

  test('a non-method accessor that throws is contained and reported', async () => {
    const service = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    }).service('svc');
    Object.defineProperty(service, 'then', {
      get: (): never => {
        throw new Error('then accessor exploded');
      },
    });
    const guarded = createGuardedLoggerService(service);
    let then: unknown = 'unread';

    const reports = await collectReports(() => {
      expect(() => {
        then = (guarded as unknown as { then: unknown }).then;
      }).not.toThrow();
    });

    expect(then).toBeUndefined();
    expect(reports.length).toBe(1);
    expect(reports[0]?.message).toContain('lifecycle-manager logger.then');
    expect((reports[0]?.cause as Error).message).toBe('then accessor exploded');
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

  test('reuses a method wrapper until the method it wraps changes', () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);

    // Read through `Reflect.get`: this is about the identity of what a read returns,
    // not a call, so detaching the method is the point.
    const readInfo = (): unknown => Reflect.get(guarded, 'info');
    const first = readInfo();
    expect(readInfo()).toBe(first);

    const seen: string[] = [];
    service.info = (message: string): void => {
      seen.push(message);
    };

    // A new method gets a wrapper of its own, and it is the one that runs.
    expect(readInfo()).not.toBe(first);
    guarded.info('after swap');
    expect(seen).toEqual(['after swap']);
  });

  test('reuses a guarded entity child per name until entity() changes', () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');
    const originalEntity = service.entity.bind(service);
    const guarded = createGuardedLoggerService(service);

    const first = guarded.entity('ent');
    expect(guarded.entity('ent')).toBe(first);
    expect(guarded.entity('other')).not.toBe(first);

    const names: string[] = [];
    service.entity = (name: string): LoggerService => {
      names.push(name);

      return originalEntity(name);
    };

    // A new `entity` starts a fresh cache, so it is actually called.
    guarded.entity('ent').info('after swap');
    expect(names).toEqual(['ent']);
    expect(sink.logs.at(-1)?.entityName).toBe('ent');
  });

  test('custom entity factories refresh context for a reused name', () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');
    let generation = 1;
    service.entity = (name: string): LoggerService =>
      logger.service(`generation-${generation}`).entity(name);
    const guarded = createGuardedLoggerService(service);
    guarded.entity('worker').info('first registration');
    generation = 2;
    guarded.entity('worker').info('second registration');
    expect(sink.logs.map((entry) => entry.serviceName)).toEqual([
      'generation-1',
      'generation-2',
    ]);
  });

  test('the built-in entity cache is bounded and least recently used', () => {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const guarded = createGuardedLoggerService(logger.service('svc'));
    const oldest = guarded.entity('job-0');
    const next = guarded.entity('job-1');
    for (let index = 2; index < 256; index++) {
      guarded.entity(`job-${index}`);
    }
    expect(guarded.entity('job-0')).toBe(oldest);
    const newest = guarded.entity('job-256');
    expect(guarded.entity('job-256')).toBe(newest);
    expect(guarded.entity('job-0')).toBe(oldest);
    expect(guarded.entity('job-1')).not.toBe(next);
  });

  test('a frozen log method is still guarded', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');
    const originalWarn = service.warn.bind(service);

    Object.defineProperty(service, 'warn', {
      value: originalWarn,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(service, 'error', {
      value: (): never => {
        throw new Error('error exploded');
      },
      writable: false,
      configurable: false,
    });

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.warn('still logged');
      guarded.warn('logged again');
      guarded.error('lost');
    });

    expect(sink.logs.map((log) => log.message)).toEqual([
      'still logged',
      'logged again',
    ]);
    // The throwing one is contained and reported like any other.
    expect(reports.length).toBe(1);
  });

  test('a frozen setter-only log method does not throw at the call site', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');

    Object.defineProperty(service, 'warn', {
      set: (): void => {},
      configurable: false,
    });

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.warn('nowhere to go');
    });

    // `warn` reads as `undefined`, which the wrapper reports as not a function.
    expect(reports.length).toBe(1);
  });

  test('a fully frozen service is guarded', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    service.info = (): never => {
      throw new Error('info exploded');
    };
    Object.freeze(service);

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.info('one');
    });

    expect(reports.length).toBe(1);
    expect(guarded instanceof service.constructor).toBe(true);
  });

  test('an entity child with hostile traps does not throw from entity()', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const hostileChild = new Proxy(
      {},
      {
        getPrototypeOf: (): never => {
          throw new Error('trap exploded');
        },
        get: (): never => {
          throw new Error('trap exploded');
        },
      },
    );
    service.entity = (): LoggerService => hostileChild as LoggerService;

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('one');
    });

    // Only the `info` read fails, and that inside the guard.
    expect(reports.length).toBe(1);
  });

  test('a rejected native promise with a no-op then from entity() is still reported', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const thrown = new Error('entity rejected');
    service.entity = (): LoggerService => {
      const promise: object = Promise.reject(thrown);
      Object.defineProperty(promise, 'then', { value: () => undefined });

      return promise as unknown as LoggerService;
    };

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('one');
    });

    expect(
      reports.some(
        (report) => report instanceof Error && report.cause === thrown,
      ),
    ).toBe(true);
  });

  test('a native promise with a throwing then from entity() is contained', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    service.entity = (): LoggerService => {
      const promise: object = Promise.resolve();
      Object.defineProperty(promise, 'then', {
        value: (): never => {
          throw new Error('then exploded');
        },
      });

      return promise as unknown as LoggerService;
    };

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('one');
    });

    expect(reports.length).toBeGreaterThanOrEqual(1);
  });

  test('a failed entity() is not cached, so every failure is reported', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    service.entity = (): never => {
      throw new Error('entity exploded');
    };

    const guarded = createGuardedLoggerService(service);

    const reports = await collectReports(() => {
      guarded.entity('ent').info('one');
      guarded.entity('ent').info('two');
    });

    expect(reports.length).toBe(2);
  });

  test('a failed entity method can recover without being replaced', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');
    const original = service.entity.bind(service);
    let calls = 0;
    service.entity = (name: string): LoggerService => {
      if (++calls === 1) {
        throw new Error('transient entity failure');
      }
      return original(name);
    };
    const guarded = createGuardedLoggerService(service);
    const reports = await collectReports(() => {
      guarded.entity('ent').info('fallback');
      guarded.entity('ent').info('recovered');
      guarded.entity('ent').info('refreshed');
    });
    expect(reports).toHaveLength(1);
    expect(calls).toBe(3);
    expect(
      sink.logs.find((entry) => entry.message === 'recovered')?.entityName,
    ).toBe('ent');
    expect(
      sink.logs.find((entry) => entry.message === 'refreshed')?.entityName,
    ).toBe('ent');
    await logger.close();
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
    expect(((reports[0]?.cause as Error).cause as Error).message).toBe(
      'then getter exploded',
    );
    expect(sink.logs[0]?.message).toBe('still logged');
    expect(sink.logs[0]?.entityName).toBeUndefined();
  });

  test('entity() adopts a thenable from one getter read', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const service = logger.service('svc');

    // A second detection/adoption read would throw instead of invoking the captured
    // method. Async children are still rejected as a logger contract violation.
    let reads = 0;
    service.entity = (): LoggerService =>
      ({
        get then(): unknown {
          reads++;

          if (reads > 1) {
            throw new Error('then getter exploded on adoption');
          }

          return (resolve: () => void): void => {
            resolve();
          };
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
      'lifecycle-manager logger.entity did not return a logger',
    );
    expect(reads).toBe(1);
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

  test('a definition through the guard lands on the underlying service', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);
    const lines: unknown[][] = [];

    Object.defineProperty(guarded, 'level', {
      value: 'x',
      configurable: true,
      writable: true,
    });
    // Configurability left unstated, so nothing holds the proxy to the value.
    Object.defineProperty(guarded, 'tag', { value: 'y' });
    Object.defineProperty(guarded, 'info', {
      value: (...args: unknown[]): void => {
        lines.push(args);
      },
      configurable: true,
    });

    expect((service as unknown as { level: unknown }).level).toBe('x');
    expect((guarded as unknown as { level: unknown }).level).toBe('x');
    expect((service as unknown as { tag: unknown }).tag).toBe('y');
    expect((guarded as unknown as { tag: unknown }).tag).toBe('y');
    guarded.info('a line');
    expect(lines).toEqual([['a line']]);

    (service as unknown as { level: unknown }).level = 'z';
    expect((guarded as unknown as { level: unknown }).level).toBe('z');
  });

  test('a definition that leaves configurability unstated does not lock the property on the service', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);
    const lines: unknown[][] = [];
    const first = (...args: unknown[]): void => {
      lines.push(['first', ...args]);
    };
    const second = (...args: unknown[]): void => {
      lines.push(['second', ...args]);
    };

    Object.defineProperty(guarded, 'warn', { value: first });

    expect(Object.getOwnPropertyDescriptor(service, 'warn')).toMatchObject({
      value: first,
      configurable: true,
    });
    guarded.warn('a line');
    // Still configurable, so it can be redefined and deleted through the guard.
    Object.defineProperty(guarded, 'warn', { value: second, writable: true });
    guarded.warn('another line');
    expect(Reflect.deleteProperty(guarded, 'warn')).toBe(true);
    expect(Object.hasOwn(service, 'warn')).toBe(false);
    expect(lines).toEqual([
      ['first', 'a line'],
      ['second', 'another line'],
    ]);
  });

  test('a definition that leaves configurability unstated keeps an existing property as it was', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);
    Object.defineProperty(service, 'fixed', {
      value: 'a',
      configurable: false,
      writable: true,
    });

    Object.defineProperty(guarded, 'fixed', { value: 'b' });

    expect(Object.getOwnPropertyDescriptor(service, 'fixed')).toMatchObject({
      value: 'b',
      configurable: false,
    });
  });

  test("lists and describes the service's own properties, including one defined through it", () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);

    Object.defineProperty(guarded, 'x', {
      value: 1,
      enumerable: true,
      configurable: true,
    });

    expect((guarded as unknown as { x: unknown }).x).toBe(1);
    expect(Object.keys(guarded)).toEqual(Object.keys(service));
    expect(Object.keys(guarded)).toContain('x');
    expect(Reflect.ownKeys(guarded)).toEqual(Reflect.ownKeys(service));
    expect(Object.getOwnPropertyDescriptor(guarded, 'x')).toEqual({
      value: 1,
      writable: false,
      enumerable: true,
      configurable: true,
    });
    expect(Object.hasOwn(guarded, 'x')).toBe(true);

    // A descriptor read back restores what was defined, as a spy helper would.
    const saved = Object.getOwnPropertyDescriptor(guarded, 'x');
    Object.defineProperty(guarded, 'x', { value: 2, configurable: true });
    Object.defineProperty(guarded, 'x', saved as PropertyDescriptor);
    expect(Object.getOwnPropertyDescriptor(service, 'x')?.value).toBe(1);

    expect(Reflect.deleteProperty(guarded, 'x')).toBe(true);
    expect(Object.keys(guarded)).not.toContain('x');
    expect(Object.getOwnPropertyDescriptor(guarded, 'x')).toBeUndefined();
  });

  test('describes a log method as its guarded wrapper, so a descriptor copy stays guarded', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const throwing = (): void => {
      throw new Error('warn blew up');
    };
    service.warn = throwing;
    const guarded = createGuardedLoggerService(service);

    const descriptor = Object.getOwnPropertyDescriptor(guarded, 'warn');
    expect(descriptor?.value).toBe(Reflect.get(guarded, 'warn'));
    expect(descriptor?.value).not.toBe(throwing);
    expect(descriptor?.configurable).toBe(true);

    const copy = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(guarded),
    ) as { warn: (message: string) => void };
    const errors: unknown[] = [];
    const onError = (event: Event): void => {
      errors.push((event as ErrorEvent).error);
      event.preventDefault();
    };
    globalThis.addEventListener('error', onError);
    try {
      expect(() => {
        copy.warn('through a copy');
      }).not.toThrow();
    } finally {
      globalThis.removeEventListener('error', onError);
    }
    expect(errors).toHaveLength(1);
  });

  test("describes a frozen service's properties without throwing", () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    Object.defineProperty(service, 'fixed', {
      value: 'a',
      enumerable: true,
    });
    Object.freeze(service);
    const guarded = createGuardedLoggerService(service);

    expect(Object.keys(guarded)).toEqual(Object.keys(service));
    // Reported configurable: the proxy may not report a non-configurable property
    // that its own target does not hold.
    expect(Object.getOwnPropertyDescriptor(guarded, 'fixed')).toEqual({
      value: 'a',
      writable: false,
      enumerable: true,
      configurable: true,
    });
    expect((guarded as unknown as { fixed: unknown }).fixed).toBe('a');
  });

  test('refuses to be frozen, so later definitions and reflection still work', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);

    expect(() => Object.freeze(guarded)).toThrow(TypeError);
    expect(Object.isExtensible(guarded)).toBe(true);
    expect(Object.isExtensible(service)).toBe(true);

    Object.defineProperty(guarded, 'later', {
      value: 'b',
      enumerable: true,
      configurable: true,
    });
    expect(Object.keys(guarded)).toContain('later');
    expect(Object.getOwnPropertyDescriptor(guarded, 'later')?.value).toBe('b');
  });

  test('a non-configurable definition is refused and leaves every read working', () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const service = logger.service('svc');
    const guarded = createGuardedLoggerService(service);

    expect(() =>
      Object.defineProperty(guarded, 'level', {
        value: 'x',
        configurable: false,
        writable: false,
      }),
    ).toThrow(TypeError);
    expect(
      Reflect.defineProperty(guarded, 'warn', {
        value: (): void => {},
        configurable: false,
      }),
    ).toBe(false);

    expect(Object.hasOwn(service, 'level')).toBe(false);
    expect(Object.hasOwn(service, 'warn')).toBe(false);
    expect((guarded as unknown as { level: unknown }).level).toBeUndefined();
    expect(() => {
      guarded.warn('still guarded');
    }).not.toThrow();
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

test('passthrough accessors preserve the service receiver', () => {
  class Service extends LoggerService {
    #value = 42;
    public get value(): number {
      return this.#value;
    }
  }
  const service = new Service(
    () => {},
    () => '',
    'test',
  );
  const guarded = createGuardedLoggerService(service);
  expect(Reflect.get(guarded, 'value')).toBe(42);
});

for (const outcome of ['resolve', 'reject']) {
  test(`async entity ${outcome} contains a throwing failure reporter`, () => {
    // Fault injection stays in a child so a regressed floating rejection cannot
    // terminate the test runner or leave a module spy installed in other suites.
    // Resolved from this file, so the child does not depend on the runner's cwd.
    const callbacksURL = new URL('../safe-handle-callback.ts', import.meta.url)
      .href;
    const guardedLoggerURL = new URL('./guarded-logger.ts', import.meta.url)
      .href;
    const child = Bun.spawnSync(
      [
        process.execPath,
        '-e',
        `
      import { spyOn } from 'bun:test';
      import * as callbacks from ${JSON.stringify(callbacksURL)};
      import { createGuardedLoggerService } from ${JSON.stringify(guardedLoggerURL)};
      let reports = 0;
      let unhandled = 0;
      process.on('unhandledRejection', () => { unhandled++; });
      spyOn(callbacks, 'reportCallbackError').mockImplementation(() => {
        reports++;
        throw new Error('reporter failed');
      });
      const guarded = createGuardedLoggerService({
        entity() { return ${outcome === 'resolve' ? 'Promise.resolve({})' : "Promise.reject(new Error('entity failed'))"}; },
      });
      guarded.entity('test');
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (reports !== 1 || unhandled !== 0) {
        console.error(JSON.stringify({ reports, unhandled }));
        process.exit(1);
      }
    `,
      ],
      { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' },
    );
    expect(child.stderr.toString()).toBe('');
    expect(child.exitCode).toBe(0);
  });
}
