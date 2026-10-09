import { expect, test } from 'bun:test';
import type { Logger } from '../logger';
import type { ArraySink } from '../logger/sinks/array';
import { sleep } from '../sleep';
import { BaseComponent } from './base-component';
import {
  ComponentStartTimeoutError,
  StartupInterruptedByShutdownError,
} from './errors';
import type { LifecycleManager } from './lifecycle-manager';
import type { LifecycleManagerOptions } from './types';
import { claimReports, deferred, Plain, setup } from './test-helpers';

// `abortPendingStarts` makes a shutdown pass abort, as it begins, the start signals of
// the starts still in flight - a cue to give up, not the pass giving up on them: it
// still waits for them and keeps their dependencies up until they settle.

class Starts extends BaseComponent {
  public readonly signals: AbortSignal[] = [];
  public readonly order: string[] = [];
  public stops = 0;
  public gate = deferred();

  constructor(
    logger: Logger,
    name: string,
    dependencies: string[] = [],
    startupTimeoutMS = 30_000,
  ) {
    super(logger, { name, dependencies, startupTimeoutMS });
  }

  // By default the start ignores its signal and waits for the gate.
  public onStart: (signal: AbortSignal) => void | Promise<void> = () =>
    this.gate.promise;

  public start(signal: AbortSignal): void | Promise<void> {
    this.signals.push(signal);
    signal.addEventListener('abort', () => {
      this.order.push('abort');
    });
    return this.onStart(signal);
  }

  public stop(): void {
    this.stops++;
    this.order.push('stop');
  }
}

// A start that rejects with the signal's reason as soon as it is aborted.
function honorsSignal(signal: AbortSignal): Promise<void> {
  return new Promise<void>((_, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as Error);
    });
  });
}

async function withPendingStart(
  options: Partial<LifecycleManagerOptions> = {},
): Promise<{
  manager: ReturnType<typeof setup>['manager'];
  database: Plain;
  worker: Starts;
  starting: ReturnType<ReturnType<typeof setup>['manager']['startComponent']>;
}> {
  const { logger, manager } = setup(options);
  const database = new Plain(logger, 'database');
  const worker = new Starts(logger, 'worker', ['database']);
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  expect((await manager.startComponent('database')).success).toBe(true);
  const starting = manager.startComponent('worker');
  return { manager, database, worker, starting };
}

test('by default a shutdown pass does not abort a pending start signal', async () => {
  const { manager, worker, starting } = await withPendingStart();

  const shutdown = manager.stopAllComponents({ timeoutMS: 1000 });
  await sleep(20);
  expect(worker.signals[0].aborted).toBe(false);
  expect(manager.isComponentRunning('database')).toBe(true);

  worker.gate.resolve();
  expect((await starting).code).toBe('shutdown_in_progress');
  expect((await shutdown).success).toBe(true);
  expect(worker.signals[0].aborted).toBe(false);
  expect(worker.order).toEqual(['stop']);
});

test('abortPendingStarts aborts a pending start signal as the pass begins, and the pass still waits for it and protects its dependencies', async () => {
  const { manager, worker, starting } = await withPendingStart();

  const shutdown = manager.stopAllComponents({
    timeoutMS: 1000,
    abortPendingStarts: true,
  });
  // Synchronously, as the pass is accepted.
  expect(worker.signals[0].aborted).toBe(true);
  const reason = worker.signals[0].reason as StartupInterruptedByShutdownError;
  expect(reason).toBeInstanceOf(StartupInterruptedByShutdownError);
  expect(reason.additionalInfo).toEqual({
    componentName: 'worker',
    method: 'manual',
  });
  expect(reason.errCode).toBe('StartupInterrupted');

  // A cue, not abandonment: the start still owns the component, no timeout is
  // recorded, and its dependency stays up while it is pending.
  await sleep(20);
  expect(manager.getComponentStatus('worker')?.state).toBe('starting');
  expect(manager.isComponentRunning('database')).toBe(true);

  // The start honors the cue by rejecting with the reason.
  worker.gate.reject(reason);
  const result = await starting;
  expect(result.success).toBe(false);
  expect(result.code).toBe('shutdown_in_progress');
  expect(result.error).toBe(reason);

  const shutdownResult = await shutdown;
  expect(shutdownResult.success).toBe(true);
  expect(manager.getRunningComponentNames()).toEqual([]);
  expect(worker.stops).toBe(0);
  expect(manager.getComponentStatus('worker')?.state).not.toBe(
    'starting-timed-out',
  );
  expect(worker.order).toEqual(['abort']);
});

// What a start that honors the cue may reject with: the signal's reason itself, a
// library's error carrying it on `cause` (at any depth within the bound), or an
// `AbortError` - the `DOMException` `fetch` and timers reject with, or a library's own.
const LINKED_FAILURES: [string, (reason: unknown) => unknown][] = [
  ['the reason itself', (reason) => reason],
  [
    'an error wrapping the reason',
    (reason) => new Error('connect aborted', { cause: reason }),
  ],
  [
    'an error wrapping the reason two levels down',
    (reason) =>
      new Error('pool failed', {
        cause: new Error('connect aborted', { cause: reason }),
      }),
  ],
  [
    'an AbortError DOMException',
    () => new DOMException('This operation was aborted', 'AbortError'),
  ],
  [
    'an error named AbortError',
    () => Object.assign(new Error('aborted'), { name: 'AbortError' }),
  ],
  [
    'an error wrapping an AbortError',
    () =>
      new Error('request failed', {
        cause: new DOMException('This operation was aborted', 'AbortError'),
      }),
  ],
];

test.each(LINKED_FAILURES)(
  'a start that rejects with %s after the shutdown aborted it is answered shutdown_in_progress',
  async (_, failure) => {
    const { manager, worker, starting } = await withPendingStart();
    const shutdown = manager.stopAllComponents({ abortPendingStarts: true });

    const thrown = failure(worker.signals[0].reason);
    worker.gate.reject(thrown);
    const result = await starting;
    expect(result.code).toBe('shutdown_in_progress');
    expect(result.error).toBe(thrown as Error);
    expect(result.reason).toStartWith(
      'Shutdown interrupted component startup: ',
    );
    expect((await shutdown).success).toBe(true);
  },
);

// Each value is unrelated to the abort, so the failure is reported exactly as it would
// be without the option.
const UNRELATED_FAILURES: [string, (reason: unknown) => unknown][] = [
  ['an unrelated error', () => new Error('connection refused')],
  ['a thrown string', () => 'connection refused'],
  [
    'an error whose cause getter throws',
    () =>
      Object.defineProperty(new Error('connection refused'), 'cause', {
        get(): never {
          throw new Error('hostile cause');
        },
      }),
  ],
  [
    'an error whose name getter throws',
    () =>
      Object.defineProperty(new Error('connection refused'), 'name', {
        get(): never {
          throw new Error('hostile name');
        },
      }),
  ],
  [
    'a cyclic cause chain without the reason',
    () => {
      const first = new Error('connection refused');
      const second = new Error('retry failed', { cause: first });
      Object.assign(first, { cause: second });
      return first;
    },
  ],
  [
    'a self-referencing cause',
    () => {
      const error = new Error('connection refused');
      Object.assign(error, { cause: error });
      return error;
    },
  ],
  [
    'the reason deeper than the cause walk follows',
    (reason) => {
      let error: unknown = reason;
      for (let depth = 0; depth < 20; depth++) {
        error = new Error('connection refused', { cause: error });
      }
      return error;
    },
  ],
];

test.each(UNRELATED_FAILURES)(
  'a start that rejects with %s after the shutdown aborted it is reported as the error it is',
  async (_, failure) => {
    const { logger, manager } = setup();
    const sink = logger.getSinks()[0] as ArraySink;
    const database = new Plain(logger, 'database');
    const worker = new Starts(logger, 'worker', ['database']);
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    const starting = manager.startComponent('worker');
    const shutdown = manager.stopAllComponents({ abortPendingStarts: true });
    expect(worker.signals[0].aborted).toBe(true);

    worker.gate.reject(failure(worker.signals[0].reason));
    const result = await starting;
    expect(result.success).toBe(false);
    expect(result.code).toBe('error');
    expect(result.reason).not.toContain('Shutdown interrupted');
    const startLogs = sink.logs.filter(
      (entry) =>
        entry.message.startsWith('Component failed to start') ||
        entry.message.startsWith('Component startup interrupted'),
    );
    expect(startLogs.map((entry) => entry.type)).toEqual(['error']);
    expect((await shutdown).success).toBe(true);
    expect(manager.getRunningComponentNames()).toEqual([]);
  },
);

test('an unrelated failure reports the same reason with and without abortPendingStarts', async () => {
  const reasons: (string | undefined)[] = [];
  for (const shouldAbortPendingStarts of [false, true]) {
    const { manager, worker, starting } = await withPendingStart();
    const shutdown = manager.stopAllComponents({
      abortPendingStarts: shouldAbortPendingStarts,
    });
    await sleep(5);
    worker.gate.reject(new Error('connection refused'));
    const result = await starting;
    expect(result.code).toBe('error');
    reasons.push(result.reason);
    await shutdown;
  }
  expect(reasons[0]).toBe(reasons[1]);
});

test('a start that ignores the cue and resolves is stopped by the pass, as without the option', async () => {
  const { manager, worker, starting } = await withPendingStart();
  const shutdown = manager.stopAllComponents({ abortPendingStarts: true });
  expect(worker.signals[0].aborted).toBe(true);

  worker.gate.resolve();
  expect((await starting).code).toBe('shutdown_in_progress');
  expect((await shutdown).success).toBe(true);
  expect(worker.order).toEqual(['abort', 'stop']);
  expect(manager.getRunningComponentNames()).toEqual([]);
});

test('a start that honors the abort at once lets the pass stop its dependencies', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Starts(logger, 'worker', ['database']);
  worker.onStart = honorsSignal;
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  const starting = manager.startComponent('worker');

  const shutdown = await manager.stopAllComponents({
    abortPendingStarts: true,
  });

  expect(shutdown.success).toBe(true);
  expect(shutdown.stoppedComponents).toContain('database');
  expect((await starting).code).toBe('shutdown_in_progress');
});

test('startAllComponents() reports shutdown_in_progress when a start honors the abort', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Starts(logger, 'worker', ['database']);
  worker.onStart = honorsSignal;
  await manager.registerComponent(database);
  await manager.registerComponent(worker);

  const startup = manager.startAllComponents();
  await sleep(10);
  expect(manager.getComponentStatus('worker')?.state).toBe('starting');

  const shutdown = await manager.stopAllComponents({
    abortPendingStarts: true,
  });
  const result = await startup;

  expect(result.code).toBe('shutdown_in_progress');
  expect(shutdown.success).toBe(true);
  expect(manager.getRunningComponentNames()).toEqual([]);
});

test('a start that already timed out keeps its timeout abort and is not aborted again', async () => {
  const { logger, manager } = setup();
  const worker = new Starts(logger, 'worker', [], 20);
  await manager.registerComponent(worker);

  const started = await manager.startComponent('worker');
  expect(started.code).toBe('component_startup_timeout');
  expect(worker.signals[0].reason).toBe(started.error);

  const shutdown = await manager.stopAllComponents({
    abortPendingStarts: true,
  });
  expect(shutdown.code).toBe('cleanup_incomplete');
  expect(worker.signals[0].reason).toBeInstanceOf(ComponentStartTimeoutError);
  expect(worker.signals[0].reason).toBe(started.error);
  expect(worker.order).toEqual(['abort']);

  worker.gate.resolve();
  await sleep(10);
  expect(worker.stops).toBe(1);
});

test('a start that times out after the shutdown aborted it keeps the shutdown reason', async () => {
  const { logger, manager } = setup();
  const worker = new Starts(logger, 'worker', [], 40);
  await manager.registerComponent(worker);
  const starting = manager.startComponent('worker');

  const shutdown = manager.stopAllComponents({ abortPendingStarts: true });
  const reason = worker.signals[0].reason as unknown;
  expect(reason).toBeInstanceOf(StartupInterruptedByShutdownError);

  expect((await starting).code).toBe('component_startup_timeout');
  expect(worker.signals[0].reason).toBe(reason);
  // Aborted once: its own timeout does not abort it again.
  expect(worker.order).toEqual(['abort']);
  expect((await shutdown).code).toBe('cleanup_incomplete');
  worker.gate.resolve();
  await sleep(10);
});

test('shutdownOptions.abortPendingStarts sets the default, and a per-call value overrides it', async () => {
  const first = await withPendingStart({
    shutdownOptions: { abortPendingStarts: true },
  });
  const firstShutdown = first.manager.stopAllComponents();
  expect(first.worker.signals[0].aborted).toBe(true);
  first.worker.gate.resolve();
  await first.starting;
  expect((await firstShutdown).success).toBe(true);

  const second = await withPendingStart({
    shutdownOptions: { abortPendingStarts: true },
  });
  const secondShutdown = second.manager.stopAllComponents({
    abortPendingStarts: false,
  });
  await sleep(10);
  expect(second.worker.signals[0].aborted).toBe(false);
  second.worker.gate.resolve();
  await second.starting;
  expect((await secondShutdown).success).toBe(true);
});

test('restartAllComponents() never aborts pending starts, even with shutdownOptions.abortPendingStarts', async () => {
  const { manager, worker, starting } = await withPendingStart({
    shutdownOptions: { abortPendingStarts: true },
  });

  const restart = manager.restartAllComponents();
  await sleep(20);
  expect(worker.signals[0].aborted).toBe(false);

  worker.gate.resolve();
  expect((await starting).code).toBe('shutdown_in_progress');
  const result = await restart;
  expect(result.success).toBe(true);
  expect(worker.signals).toHaveLength(2);
  expect(worker.signals.map((signal) => signal.aborted)).toEqual([
    false,
    false,
  ]);
  await manager.stopAllComponents({ abortPendingStarts: false });
});

// Asks for the shutdown from inside its own `start()`, through its lifecycle handle.
class Requester extends Starts {
  public shutdown: Promise<unknown> | undefined;

  public override start(signal: AbortSignal): Promise<void> {
    this.signals.push(signal);
    this.shutdown = this.lifecycle.stopAllComponents({
      abortPendingStarts: true,
    });
    return this.gate.promise;
  }
}

test('a start that requested the shutdown itself is not aborted; other pending starts are', async () => {
  const { logger, manager } = setup();
  const other = new Starts(logger, 'other');
  const requester = new Requester(logger, 'requester');
  await manager.registerComponent(other);
  await manager.registerComponent(requester);

  const otherStarting = manager.startComponent('other');
  const requesterStarting = manager.startComponent('requester');

  expect(requester.shutdown).toBeDefined();
  expect(other.signals[0].aborted).toBe(true);
  expect(requester.signals[0].aborted).toBe(false);

  other.gate.resolve();
  requester.gate.resolve();
  expect((await otherStarting).code).toBe('shutdown_in_progress');
  expect((await requesterStarting).code).toBe('shutdown_in_progress');
  await requester.shutdown;
  expect(manager.getRunningComponentNames()).toEqual([]);
});

test('with allowStopWithPendingStarts the start is still aborted, and its dependencies are stopped without waiting', async () => {
  const { manager, worker, starting } = await withPendingStart();

  const shutdown = await manager.stopAllComponents({
    abortPendingStarts: true,
    allowStopWithPendingStarts: true,
  });

  expect(worker.signals[0].aborted).toBe(true);
  expect(worker.signals[0].reason).toBeInstanceOf(
    StartupInterruptedByShutdownError,
  );
  expect(manager.isComponentRunning('database')).toBe(false);
  expect(shutdown.code).toBe('cleanup_incomplete');

  worker.gate.reject(worker.signals[0].reason);
  expect((await starting).code).toBe('shutdown_in_progress');
});

test('a throwing abort listener on a start the shutdown aborts is reported, and the pass is unaffected', async () => {
  const { reports, release } = claimReports();
  try {
    const { manager, worker, starting } = await withPendingStart();
    const thrown = new Error('listener');
    worker.onStart = (signal) => {
      signal.addEventListener('abort', () => {
        throw thrown;
      });
      return honorsSignal(signal);
    };
    // The start in `withPendingStart()` already ran; run another one with the listener.
    worker.gate.resolve();
    await starting;
    await manager.stopComponent('worker');
    const again = manager.startComponent('worker');

    const shutdown = await manager.stopAllComponents({
      abortPendingStarts: true,
    });

    expect(shutdown.success).toBe(true);
    expect((await again).code).toBe('shutdown_in_progress');
    expect(
      reports.map((report) => [
        (report as Error).message,
        (report as Error).cause,
      ]),
    ).toEqual([
      [
        'Error in a callback lifecycle-manager start abort listener for worker',
        thrown,
      ],
    ]);
  } finally {
    release();
  }
});

// A pass that a `component:starting` listener begins runs after the start claimed its
// component but before it could be interrupted: the start still gets the pass's cue once
// `start()` has its signal, rather than the pass waiting out a start it never told.
test("a pass begun by the start's own starting listener still aborts it", async () => {
  const { logger, manager } = setup();
  const worker = new Starts(logger, 'worker');
  worker.onStart = honorsSignal;
  await manager.registerComponent(worker);

  let shutdown: Promise<unknown> | undefined;
  manager.once('component:starting', () => {
    shutdown = manager.stopAllComponents({ abortPendingStarts: true });
  });

  const result = await manager.startComponent('worker');
  expect(result.code).toBe('shutdown_in_progress');
  expect(worker.signals[0]?.reason).toBeInstanceOf(
    StartupInterruptedByShutdownError,
  );
  expect(await shutdown).toMatchObject({ success: true });
});

// The same late cue, for a `start()` that settled synchronously: by the time the cue is
// delivered it has nothing left to give up, and a settled start is left alone.
test('a start that settled synchronously is not aborted by a pass its starting listener began', async () => {
  const { logger, manager } = setup();
  const worker = new Starts(logger, 'worker');
  worker.onStart = () => undefined;
  await manager.registerComponent(worker);

  let shutdown: Promise<unknown> | undefined;
  manager.once('component:starting', () => {
    shutdown = manager.stopAllComponents({ abortPendingStarts: true });
  });

  const result = await manager.startComponent('worker');
  expect(result.code).toBe('shutdown_in_progress');
  expect(worker.signals[0]?.aborted).toBe(false);
  expect(await shutdown).toMatchObject({ success: true });
  expect(worker.order).toEqual(['stop']);
});

// Requested through the component's own `lifecycle` handle from its starting listener,
// the pass counts the start as its requester - as one requested from `start()` - and
// leaves it alone, cue included.
test("a pass the start's starting listener requests through its lifecycle handle does not abort it", async () => {
  const { logger, manager } = setup();
  const worker = new Starts(logger, 'worker');
  await manager.registerComponent(worker);

  let shutdown: Promise<unknown> | undefined;
  manager.once('component:starting', () => {
    shutdown = (
      worker as unknown as {
        lifecycle: LifecycleManager;
      }
    ).lifecycle.stopAllComponents({ abortPendingStarts: true });
  });

  const starting = manager.startComponent('worker');
  await sleep(10);
  expect(shutdown).toBeDefined();
  expect(worker.signals[0]?.aborted).toBe(false);

  worker.gate.resolve();
  expect((await starting).code).toBe('shutdown_in_progress');
  await shutdown;
  expect(worker.signals[0]?.aborted).toBe(false);
  expect(manager.getRunningComponentNames()).toEqual([]);
});

// A start the outer attempt's own `getDependencies()` re-enters records its attempt while
// the outer one has published but not yet claimed. That must not release the outer
// attempt's settlement: once it claims, a pass must still find and abort its start.
test('a nested start from getDependencies() leaves the outer attempt abortable by the pass', async () => {
  const { logger, manager } = setup();
  const worker = new Starts(logger, 'worker');
  let shouldReenter = false;
  let nested: Promise<unknown> | undefined;
  worker.getDependencies = (): string[] => {
    if (shouldReenter) {
      shouldReenter = false;
      nested = manager.startComponent('worker');
    }
    return [];
  };
  let startCalls = 0;
  worker.onStart = (): Promise<void> => {
    if (++startCalls === 1) {
      throw new Error('nested start failed');
    }
    return worker.gate.promise;
  };
  await manager.registerComponent(worker);
  shouldReenter = true;

  const starting = manager.startComponent('worker');
  expect(await nested).toMatchObject({ success: false, code: 'error' });
  await sleep(0);
  expect(startCalls).toBe(2);

  const shutdown = manager.stopAllComponents({
    abortPendingStarts: true,
    timeoutMS: 1000,
  });
  expect(worker.signals[1]?.aborted).toBe(true);
  worker.gate.resolve();
  expect((await starting).code).toBe('shutdown_in_progress');
  expect(await shutdown).toMatchObject({ success: true });
  expect(manager.getRunningComponentNames()).toEqual([]);
});
