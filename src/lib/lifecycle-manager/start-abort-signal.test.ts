import { expect, test } from 'bun:test';
import type { Logger } from '../logger';
import { sleep } from '../sleep';
import { BaseComponent } from './base-component';
import { ComponentStartTimeoutError } from './errors';
import { claimReports, deferred, setup } from './test-helpers';

// A component that records the signal each `start()` receives and what happened to it.
class Records extends BaseComponent {
  public readonly signals: AbortSignal[] = [];
  public readonly order: string[] = [];
  public stops = 0;

  constructor(logger: Logger, name: string, startupTimeoutMS = 30_000) {
    super(logger, { name, startupTimeoutMS });
  }

  public onStart: (signal: AbortSignal) => void | Promise<void> = () => {};

  public start(signal: AbortSignal): void | Promise<void> {
    this.signals.push(signal);
    signal.addEventListener('abort', () => {
      this.order.push('abort');
    });
    return this.onStart(signal);
  }

  public stop(): void {
    this.stops++;
  }

  public lose(error: Error): void {
    this.reportUnexpectedStop(error);
  }
}

// Declares `start()` with no parameters, as every component written before the signal
// existed does. It must still compile and behave exactly as before.
class IgnoresSignal extends BaseComponent {
  public stops = 0;
  public readonly gate = deferred();

  constructor(logger: Logger, name: string, startupTimeoutMS = 30_000) {
    super(logger, { name, startupTimeoutMS });
  }

  public async start(): Promise<void> {
    await this.gate.promise;
  }

  public stop(): void {
    this.stops++;
  }
}

test('start() receives a fresh AbortSignal that is not aborted when it succeeds', async () => {
  const { logger, manager } = setup();
  const a = new Records(logger, 'a', 50);
  await manager.registerComponent(a);

  expect((await manager.startComponent('a')).success).toBe(true);
  expect((await manager.stopComponent('a')).success).toBe(true);
  expect((await manager.startComponent('a')).success).toBe(true);

  expect(a.signals).toHaveLength(2);
  expect(a.signals[0]).toBeInstanceOf(AbortSignal);
  // One controller per attempt.
  expect(a.signals[1]).not.toBe(a.signals[0]);

  // Not after its own deadline would have passed, nor after a stop.
  await sleep(80);
  expect(a.signals.map((signal) => signal.aborted)).toEqual([false, false]);
  expect(a.order).toEqual([]);

  await manager.stopAllComponents();
  expect(a.signals[1].aborted).toBe(false);
});

test('the signal is aborted on a per-component startup timeout, with the result error as its reason', async () => {
  const { logger, manager } = setup();
  const a = new Records(logger, 'a', 30);
  const gate = deferred();
  a.onStart = () => gate.promise;
  await manager.registerComponent(a);

  const result = await manager.startComponent('a');

  expect(result.success).toBe(false);
  expect(result.code).toBe('component_startup_timeout');
  expect(a.signals).toHaveLength(1);
  const [signal] = a.signals;
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBeInstanceOf(ComponentStartTimeoutError);
  expect(signal.reason).toBe(result.error);
  expect(a.order).toEqual(['abort']);
  expect(manager.getComponentStatus('a')?.state).toBe('starting-timed-out');

  gate.resolve();
  await sleep(10);
});

test('a start that honors the signal settles, and the next attempt gets an unaborted signal', async () => {
  const { logger, manager } = setup();
  const a = new Records(logger, 'a', 30);
  a.onStart = (signal) =>
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => {
        reject(signal.reason as Error);
      });
    });
  await manager.registerComponent(a);

  const result = await manager.startComponent('a');
  expect(result.code).toBe('component_startup_timeout');
  expect(a.signals[0].aborted).toBe(true);
  // The start settled on the abort, so no late cleanup is owed and none ran.
  await sleep(10);
  expect(a.stops).toBe(0);

  a.onStart = () => {};
  expect((await manager.startComponent('a')).success).toBe(true);
  expect(a.signals).toHaveLength(2);
  expect(a.signals[1].aborted).toBe(false);
  await manager.stopAllComponents();
});

test('the signal is aborted when the startAllComponents() deadline abandons the start', async () => {
  const { logger, manager } = setup();
  const a = new Records(logger, 'a', 10_000);
  // Owns its late cleanup, which a bulk deadline overrides.
  Object.defineProperty(a, 'ownsLateStartCleanup', { value: true });
  const gate = deferred();
  a.onStart = () => gate.promise;
  await manager.registerComponent(a);

  const result = await manager.startAllComponents({ timeoutMS: 40 });

  expect(result.code).toBe('startup_timeout');
  // The bulk deadline bounds the start through the start's own timer; the bulk result
  // may be returned a moment before that timer fires.
  await sleep(20);
  expect(a.signals).toHaveLength(1);
  expect(a.signals[0].aborted).toBe(true);
  expect(a.signals[0].reason).toBeInstanceOf(ComponentStartTimeoutError);
  expect(a.order).toEqual(['abort']);

  // Bulk deadlines still clean up a late success, whether or not the component owns it.
  gate.resolve();
  await sleep(20);
  expect(a.stops).toBe(1);
  expect(manager.getComponentStatus('a')?.state).toBe('starting-timed-out');
});

test('the signal is not aborted when start() rejects or throws', async () => {
  const { logger, manager } = setup();
  const rejects = new Records(logger, 'rejects', 30);
  rejects.onStart = () => Promise.reject(new Error('start failed'));
  const throws = new Records(logger, 'throws', 30);
  throws.onStart = () => {
    throw new Error('start threw');
  };
  await manager.registerComponent(rejects);
  await manager.registerComponent(throws);

  expect((await manager.startComponent('rejects')).code).toBe('error');
  expect((await manager.startComponent('throws')).code).toBe('error');

  await sleep(60);
  expect(rejects.signals[0].aborted).toBe(false);
  expect(throws.signals[0].aborted).toBe(false);
});

test('a component that ignores the signal keeps its timeout and late-cleanup behavior', async () => {
  const { logger, manager } = setup();
  const a = new IgnoresSignal(logger, 'a', 30);
  await manager.registerComponent(a);

  const result = await manager.startComponent('a');
  expect(result.code).toBe('component_startup_timeout');

  a.gate.resolve();
  await sleep(20);
  expect(a.stops).toBe(1);
  expect(manager.getComponentStatus('a')?.state).toBe('starting-timed-out');

  const b = new IgnoresSignal(logger, 'b');
  b.gate.resolve();
  await manager.registerComponent(b);
  expect((await manager.startComponent('b')).success).toBe(true);
  await manager.stopAllComponents();
  expect(b.stops).toBe(1);
});

test('a superseded start has its signal aborted at its deadline, and the newer run keeps its own', async () => {
  const { logger, manager } = setup();
  const firstGate = deferred();
  let calls = 0;
  const a = new Records(logger, 'a', 40);
  a.onStart = () => {
    calls++;
    if (calls === 1) {
      a.lose(new Error('lost'));
      return firstGate.promise;
    }
  };
  await manager.registerComponent(a);

  const restarts: Promise<unknown>[] = [];
  manager.once('component:unexpected-stop', () => {
    restarts.push(manager.startComponent('a'));
  });

  const first = manager.startComponent('a');
  await Promise.all(restarts);
  expect(manager.isComponentRunning('a')).toBe(true);

  const result = await first;
  expect(result.success).toBe(false);
  expect(a.signals).toHaveLength(2);
  expect(a.signals[0].aborted).toBe(true);
  expect(a.signals[0].reason).toBeInstanceOf(ComponentStartTimeoutError);
  expect(a.signals[1].aborted).toBe(false);
  expect(manager.isComponentRunning('a')).toBe(true);

  firstGate.resolve();
  await manager.stopAllComponents();
});

test('aborting does not consult an AbortController.prototype.abort replaced after import', async () => {
  const { logger, manager } = setup();
  const a = new Records(logger, 'a', 30);
  const gate = deferred();
  a.onStart = () => gate.promise;
  await manager.registerComponent(a);

  const descriptor = Object.getOwnPropertyDescriptor(
    AbortController.prototype,
    'abort',
  );
  if (descriptor === undefined) {
    throw new Error('AbortController.prototype.abort is missing');
  }
  Object.defineProperty(AbortController.prototype, 'abort', {
    ...descriptor,
    value: () => {
      throw new Error('replaced abort');
    },
  });
  try {
    expect((await manager.startComponent('a')).code).toBe(
      'component_startup_timeout',
    );
  } finally {
    Object.defineProperty(AbortController.prototype, 'abort', descriptor);
  }

  expect(a.signals[0].aborted).toBe(true);
  expect(a.order).toEqual(['abort']);
  gate.resolve();
  await sleep(10);
});

// How a component's throwing abort listener is attached to its start signal.
const THROWING_LISTENERS: [
  string,
  (signal: AbortSignal, thrown: Error) => void,
][] = [
  [
    'function listener',
    (signal, thrown) => {
      signal.addEventListener('abort', () => {
        throw thrown;
      });
    },
  ],
  [
    'handleEvent object',
    (signal, thrown) => {
      signal.addEventListener('abort', {
        handleEvent: () => {
          throw thrown;
        },
      });
    },
  ],
  [
    'onabort handler',
    (signal, thrown) => {
      signal.onabort = () => {
        throw thrown;
      };
    },
  ],
];

// A component whose start signal carries a throwing listener between two that record.
class ThrowsOnAbort extends BaseComponent {
  public readonly order: string[] = [];
  public readonly thrown: Error;
  public stops = 0;
  public late = deferred();

  constructor(
    logger: Logger,
    name: string,
    private readonly attach: (signal: AbortSignal, thrown: Error) => void,
    doesOwnCleanup = false,
  ) {
    super(logger, {
      name,
      startupTimeoutMS: 30,
      ownsLateStartCleanup: doesOwnCleanup,
    });
    this.thrown = new Error(`${name} listener`);
  }

  public start(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => this.order.push('before'));
    this.attach(signal, this.thrown);
    signal.addEventListener('abort', () => this.order.push('after'));
    return this.late.promise;
  }

  public stop(): void {
    this.stops++;
  }
}

// A listener error used to be the runtime's: an uncaught exception, fatal to a process
// with no handler (and to this test, which fails on any uncaught error). It is now
// reported on the manager's failure channel, and nothing else about the timeout changes.
test.each(THROWING_LISTENERS)(
  'a throwing %s is reported, and the timeout result and late cleanup are unaffected',
  async (_, attach) => {
    const { reports, release } = claimReports();
    try {
      const { logger, manager } = setup();
      const owner = new ThrowsOnAbort(logger, 'owner', attach, true);
      const plain = new ThrowsOnAbort(logger, 'plain', attach);
      await manager.registerComponent(owner);
      await manager.registerComponent(plain);

      const results = await Promise.all([
        manager.startComponent('owner'),
        manager.startComponent('plain'),
      ]);

      expect(results.map((result) => result.code)).toEqual([
        'component_startup_timeout',
        'component_startup_timeout',
      ]);
      expect(owner.order).toEqual(['before', 'after']);
      expect(plain.order).toEqual(['before', 'after']);
      expect(manager.getComponentStatus('owner')?.state).toBe(
        'starting-timed-out',
      );
      expect(manager.getComponentStatus('plain')?.state).toBe(
        'starting-timed-out',
      );
      expect(
        reports.map((report) => [
          (report as Error).message,
          (report as Error).cause,
        ]),
      ).toEqual([
        [
          'Error in a callback lifecycle-manager start abort listener for owner',
          owner.thrown,
        ],
        [
          'Error in a callback lifecycle-manager start abort listener for plain',
          plain.thrown,
        ],
      ]);

      // A late success is still cleaned up by the manager, and left alone for a
      // component that owns its late cleanup.
      owner.late.resolve();
      plain.late.resolve();
      await sleep(30);
      expect(plain.stops).toBe(1);
      expect(owner.stops).toBe(0);

      owner.late = deferred();
      owner.late.resolve();
      expect((await manager.startComponent('owner')).success).toBe(true);
      expect((await manager.stopAllComponents()).success).toBe(true);
      expect(owner.stops).toBe(1);
    } finally {
      release();
    }
  },
);

test('the start signal guards its listeners even after EventTarget.prototype.addEventListener is replaced', async () => {
  const { reports, release } = claimReports();
  const descriptor = Object.getOwnPropertyDescriptor(
    EventTarget.prototype,
    'addEventListener',
  );
  if (descriptor === undefined) {
    throw new Error('EventTarget.prototype.addEventListener is missing');
  }
  try {
    const { logger, manager } = setup();
    const a = new ThrowsOnAbort(logger, 'a', (signal, thrown) => {
      signal.addEventListener('abort', () => {
        throw thrown;
      });
    });
    await manager.registerComponent(a);

    Object.defineProperty(EventTarget.prototype, 'addEventListener', {
      ...descriptor,
      value: () => {
        throw new Error('replaced addEventListener');
      },
    });
    let result;
    try {
      result = await manager.startComponent('a');
    } finally {
      Object.defineProperty(
        EventTarget.prototype,
        'addEventListener',
        descriptor,
      );
    }

    expect(result.code).toBe('component_startup_timeout');
    expect(a.order).toEqual(['before', 'after']);
    expect(reports.map((report) => (report as Error).cause)).toEqual([
      a.thrown,
    ]);
    a.late.resolve();
    await sleep(10);
  } finally {
    release();
  }
});
