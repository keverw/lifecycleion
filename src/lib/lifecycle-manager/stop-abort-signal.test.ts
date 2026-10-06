import { expect, test } from 'bun:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { Logger } from '../logger';
import type { ArraySink } from '../logger/sinks/array';
import { sleep } from '../sleep';
import { BaseComponent } from './base-component';
import {
  LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_SUPERSEDED,
  LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
} from './constants';
import {
  ComponentForceTimeoutError,
  ComponentStopTimeoutError,
  ForceShutdownSupersededError,
  lifecycleManagerErrCodes,
} from './errors';
import { claimReports, deferred, setup } from './test-helpers';

type Hook = (signal: AbortSignal) => void | Promise<void>;

// Records the signal each `stop()` and `onShutdownForce()` receives, and the order in
// which their aborts happen.
class Records extends BaseComponent {
  public readonly stopSignals: AbortSignal[] = [];
  public readonly forceSignals: AbortSignal[] = [];
  public readonly order: string[] = [];

  constructor(
    logger: Logger,
    name: string,
    timeouts: { graceful?: number; force?: number } = {},
    dependencies: string[] = [],
  ) {
    super(logger, {
      name,
      dependencies,
      shutdownGracefulTimeoutMS: timeouts.graceful ?? 30_000,
      shutdownForceTimeoutMS: timeouts.force ?? 30_000,
    });
  }

  public onStop: Hook = () => {};
  public onForce: Hook = () => {};

  public start(): void {}

  public stop(signal: AbortSignal): void | Promise<void> {
    this.stopSignals.push(signal);
    signal.addEventListener('abort', () => {
      this.order.push('stop-abort');
    });
    return this.onStop(signal);
  }

  public onShutdownForce(signal: AbortSignal): void | Promise<void> {
    this.forceSignals.push(signal);
    signal.addEventListener('abort', () => {
      this.order.push('force-abort');
    });
    return this.onForce(signal);
  }
}

// No force handler at all, so a failed graceful phase stalls with its own error.
class GracefulOnly extends BaseComponent {
  public readonly stopSignals: AbortSignal[] = [];
  public readonly order: string[] = [];

  constructor(logger: Logger, name: string, gracefulTimeoutMS = 30_000) {
    super(logger, { name, shutdownGracefulTimeoutMS: gracefulTimeoutMS });
  }

  public onStop: Hook = () => {};

  public start(): void {}

  public stop(signal: AbortSignal): void | Promise<void> {
    this.stopSignals.push(signal);
    signal.addEventListener('abort', () => {
      this.order.push('stop-abort');
    });
    return this.onStop(signal);
  }
}

// Declares `stop()` and `onShutdownForce()` without parameters, as every component
// written before the signals existed does. It must still compile and behave as before.
class IgnoresSignals extends BaseComponent {
  public readonly stopGate = deferred();
  public readonly forceGate = deferred();
  public stops = 0;
  public forces = 0;

  constructor(logger: Logger, name: string) {
    super(logger, {
      name,
      shutdownGracefulTimeoutMS: 30,
      shutdownForceTimeoutMS: 30,
    });
  }

  public start(): void {}

  public async stop(): Promise<void> {
    this.stops++;
    await this.stopGate.promise;
  }

  public async onShutdownForce(): Promise<void> {
    this.forces++;
    await this.forceGate.promise;
  }
}

async function started<T extends BaseComponent>(
  manager: ReturnType<typeof setup>['manager'],
  component: T,
): Promise<T> {
  await manager.registerComponent(component);
  expect((await manager.startComponent(component.getName())).success).toBe(
    true,
  );
  return component;
}

test('stop() receives a fresh AbortSignal per attempt that is not aborted when it succeeds', async () => {
  const { logger, manager } = setup();
  const a = await started(manager, new Records(logger, 'a', { graceful: 40 }));

  expect((await manager.stopComponent('a')).success).toBe(true);
  expect((await manager.startComponent('a')).success).toBe(true);
  expect((await manager.stopComponent('a')).success).toBe(true);

  expect(a.stopSignals).toHaveLength(2);
  expect(a.stopSignals[0]).toBeInstanceOf(AbortSignal);
  expect(a.stopSignals[1]).not.toBe(a.stopSignals[0]);

  // Not later either, once the graceful deadline would have passed.
  await sleep(60);
  expect(a.stopSignals.map((signal) => signal.aborted)).toEqual([false, false]);
  expect(a.forceSignals).toHaveLength(0);
  expect(a.order).toEqual([]);
});

test('the stop signal is not aborted when stop() rejects or throws, and the force signal is not aborted when the force phase succeeds', async () => {
  const { logger, manager } = setup();
  const rejects = await started(
    manager,
    new Records(logger, 'rejects', { graceful: 30, force: 30 }),
  );
  rejects.onStop = () => Promise.reject(new Error('stop failed'));
  const throws = await started(
    manager,
    new Records(logger, 'throws', { graceful: 30, force: 30 }),
  );
  throws.onStop = () => {
    throw new Error('stop threw');
  };

  expect((await manager.stopComponent('rejects')).success).toBe(true);
  expect((await manager.stopComponent('throws')).success).toBe(true);

  await sleep(60);
  for (const component of [rejects, throws]) {
    expect(component.stopSignals).toHaveLength(1);
    expect(component.stopSignals[0].aborted).toBe(false);
    // The graceful failure escalated: the force phase got its own signal.
    expect(component.forceSignals).toHaveLength(1);
    expect(component.forceSignals[0]).not.toBe(component.stopSignals[0]);
    expect(component.forceSignals[0].aborted).toBe(false);
    expect(component.order).toEqual([]);
  }
});

test('the force signal is not aborted when onShutdownForce() rejects or throws', async () => {
  const { logger, manager } = setup();
  const rejects = await started(
    manager,
    new Records(logger, 'rejects', { force: 30 }),
  );
  rejects.onForce = () => Promise.reject(new Error('force failed'));
  const throws = await started(
    manager,
    new Records(logger, 'throws', { force: 30 }),
  );
  throws.onForce = () => {
    throw new Error('force threw');
  };

  expect(
    (await manager.stopComponent('rejects', { forceImmediate: true })).code,
  ).toBe('error');
  expect(
    (await manager.stopComponent('throws', { forceImmediate: true })).code,
  ).toBe('error');

  await sleep(60);
  expect(rejects.forceSignals[0].aborted).toBe(false);
  expect(throws.forceSignals[0].aborted).toBe(false);
  expect(rejects.order).toEqual([]);
  expect(throws.order).toEqual([]);
});

test('the stop signal is aborted at the graceful deadline, with the stop timeout error as its reason', async () => {
  const { logger, manager } = setup();
  const a = await started(manager, new GracefulOnly(logger, 'a', 30));
  const gate = deferred();
  a.onStop = () => gate.promise;

  const result = await manager.stopComponent('a');

  // No force handler: the graceful timeout is the stall, and its error is the result's.
  expect(result.success).toBe(false);
  expect(result.code).toBe('component_shutdown_timeout');
  expect(a.stopSignals).toHaveLength(1);
  const [signal] = a.stopSignals;
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBeInstanceOf(ComponentStopTimeoutError);
  expect(signal.reason).toBe(result.error);
  expect(a.order).toEqual(['stop-abort']);

  // A stop that settles late still clears the stall, as before.
  gate.resolve();
  await sleep(10);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
});

test('a stop that honors its signal settles, and the stall is cleared by the late resolution', async () => {
  const { logger, manager } = setup();
  const a = await started(manager, new GracefulOnly(logger, 'a', 30));
  a.onStop = (signal) =>
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        resolve();
      });
    });

  const result = await manager.stopComponent('a');

  // The abort released `stop()` before the deferred deadline rejected: it is the
  // success it is, not a timeout.
  expect(result.success).toBe(true);
  expect(a.stopSignals[0].aborted).toBe(true);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
});

test('the force signal is aborted at the force deadline, with the force timeout error as its reason', async () => {
  const { logger, manager } = setup();
  const a = await started(
    manager,
    new Records(logger, 'a', { graceful: 30, force: 30 }),
  );
  const stopGate = deferred();
  const forceGate = deferred();
  a.onStop = () => stopGate.promise;
  a.onForce = () => forceGate.promise;

  const timeouts: Error[] = [];
  manager.on('component:stop-timeout', (data) => {
    timeouts.push((data as { error: Error }).error);
  });

  const result = await manager.stopComponent('a');

  expect(result.success).toBe(false);
  expect(result.code).toBe('component_shutdown_timeout');
  expect(result.reason).toBe(
    LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
  );
  expect(a.stopSignals).toHaveLength(1);
  expect(a.forceSignals).toHaveLength(1);
  expect(a.forceSignals[0]).not.toBe(a.stopSignals[0]);

  // The graceful signal at the graceful deadline, with the error its event carried.
  expect(a.stopSignals[0].aborted).toBe(true);
  expect(a.stopSignals[0].reason).toBeInstanceOf(ComponentStopTimeoutError);
  expect(timeouts).toEqual([a.stopSignals[0].reason]);

  // The force signal at the force deadline, with the error the result carries.
  expect(a.forceSignals[0].aborted).toBe(true);
  expect(a.forceSignals[0].reason).toBe(result.error);
  const forceReason = a.forceSignals[0].reason as ComponentForceTimeoutError;
  expect(forceReason).toBeInstanceOf(ComponentForceTimeoutError);
  expect(forceReason.errCode).toBe(lifecycleManagerErrCodes.ForceTimeout);
  // The force budget as the component resolved it (its 500ms minimum).
  expect(forceReason.additionalInfo).toEqual({
    componentName: 'a',
    timeoutMS: a.shutdownForceTimeoutMS,
  });
  expect(forceReason.message).toBe(
    LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
  );
  // The stall record keeps the same instance.
  expect(manager.getComponentStatus('a')?.stallInfo?.error).toBe(forceReason);

  expect(a.order).toEqual(['stop-abort', 'force-abort']);
  expect(manager.getComponentStatus('a')?.state).toBe('stalled');

  forceGate.resolve();
  await sleep(10);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  stopGate.resolve();
});

test('a forceImmediate stop hands onShutdownForce() its own signal, aborted at its deadline', async () => {
  const { logger, manager } = setup();
  const a = await started(manager, new Records(logger, 'a', { force: 30 }));
  const forceGate = deferred();
  a.onForce = () => forceGate.promise;

  const result = await manager.stopComponent('a', { forceImmediate: true });

  expect(result.code).toBe('component_shutdown_timeout');
  expect(a.stopSignals).toHaveLength(0);
  expect(a.forceSignals).toHaveLength(1);
  expect(a.forceSignals[0].aborted).toBe(true);
  expect(a.forceSignals[0].reason).toBe(result.error);
  expect(a.order).toEqual(['force-abort']);
  forceGate.resolve();
  await sleep(10);
});

test('a stalled retry gets a fresh force signal, aborted only at its own deadline', async () => {
  const { logger, manager } = setup();
  const a = await started(
    manager,
    new Records(logger, 'a', { graceful: 20, force: 20 }),
  );
  const stopGate = deferred();
  const firstForce = deferred();
  a.onStop = () => stopGate.promise;
  a.onForce = () => firstForce.promise;

  expect((await manager.stopComponent('a')).code).toBe(
    'component_shutdown_timeout',
  );
  expect(manager.getComponentStatus('a')?.state).toBe('stalled');
  expect(a.forceSignals).toHaveLength(1);
  expect(a.forceSignals[0].aborted).toBe(true);

  // The retry goes straight to the force phase, which now succeeds.
  a.onForce = () => {};
  a.order.length = 0;
  const shutdown = await manager.stopAllComponents({ retryStalled: true });

  expect(shutdown.success).toBe(true);
  expect(a.stopSignals).toHaveLength(1);
  expect(a.forceSignals).toHaveLength(2);
  expect(a.forceSignals[1]).not.toBe(a.forceSignals[0]);
  await sleep(40);
  expect(a.forceSignals[1].aborted).toBe(false);
  expect(a.order).toEqual([]);

  firstForce.resolve();
  stopGate.resolve();
});

test('a stalled retry that times out again aborts its own fresh force signal', async () => {
  const { logger, manager } = setup();
  const a = await started(manager, new Records(logger, 'a', { force: 20 }));
  const forceGate = deferred();
  a.onForce = () => forceGate.promise;

  expect(
    (await manager.stopComponent('a', { forceImmediate: true })).code,
  ).toBe('component_shutdown_timeout');
  a.order.length = 0;

  const shutdown = await manager.stopAllComponents({ retryStalled: true });

  expect(shutdown.success).toBe(false);
  expect(a.forceSignals).toHaveLength(2);
  expect(a.forceSignals[1]).not.toBe(a.forceSignals[0]);
  expect(a.forceSignals[1].aborted).toBe(true);
  expect(a.forceSignals[1].reason).toBeInstanceOf(ComponentForceTimeoutError);
  expect(a.forceSignals[1].reason).not.toBe(a.forceSignals[0].reason);
  expect(shutdown.stalledComponents[0]?.error).toBe(a.forceSignals[1].reason);
  expect(a.order).toEqual(['force-abort']);
  forceGate.resolve();
  await sleep(10);
});

// Every path that stops a component runs the same graceful phase.
const STOP_PATHS: [
  string,
  (manager: ReturnType<typeof setup>['manager']) => Promise<unknown>,
][] = [
  ['stopAllComponents()', (manager) => manager.stopAllComponents()],
  ['restartComponent()', (manager) => manager.restartComponent('a')],
  ['unregisterComponent()', (manager) => manager.unregisterComponent('a')],
];

test.each(STOP_PATHS)(
  '%s aborts the stop signal at the graceful deadline',
  async (_, stop) => {
    const { logger, manager } = setup();
    const a = await started(manager, new GracefulOnly(logger, 'a', 20));
    a.onStop = (signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      });

    await stop(manager);

    expect(a.stopSignals).toHaveLength(1);
    expect(a.stopSignals[0].aborted).toBe(true);
    expect(a.stopSignals[0].reason).toBeInstanceOf(ComponentStopTimeoutError);
    expect(a.order).toEqual(['stop-abort']);
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
  },
);

test('a component that ignores the signals keeps its timeout and late-resolution behavior', async () => {
  const { logger, manager } = setup();
  const a = await started(manager, new IgnoresSignals(logger, 'a'));

  const result = await manager.stopComponent('a');

  expect(result.code).toBe('component_shutdown_timeout');
  expect([a.stops, a.forces]).toEqual([1, 1]);
  expect(manager.getComponentStatus('a')?.state).toBe('stalled');

  a.forceGate.resolve();
  await sleep(10);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  a.stopGate.resolve();
});

// How a component's throwing abort listener is attached to a signal.
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

// Both signals carry a throwing listener between two that record.
class ThrowsOnAbort extends BaseComponent {
  public readonly order: string[] = [];
  public readonly stopThrown: Error;
  public readonly forceThrown: Error;
  public readonly stopGate = deferred();
  public readonly forceGate = deferred();

  constructor(
    logger: Logger,
    name: string,
    private readonly attach: (signal: AbortSignal, thrown: Error) => void,
  ) {
    super(logger, {
      name,
      shutdownGracefulTimeoutMS: 20,
      shutdownForceTimeoutMS: 20,
    });
    this.stopThrown = new Error(`${name} stop listener`);
    this.forceThrown = new Error(`${name} force listener`);
  }

  public start(): void {}

  public stop(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => this.order.push('stop-before'));
    this.attach(signal, this.stopThrown);
    signal.addEventListener('abort', () => this.order.push('stop-after'));
    return this.stopGate.promise;
  }

  public onShutdownForce(signal: AbortSignal): Promise<void> {
    signal.addEventListener('abort', () => this.order.push('force-before'));
    this.attach(signal, this.forceThrown);
    signal.addEventListener('abort', () => this.order.push('force-after'));
    return this.forceGate.promise;
  }
}

// Unguarded, a listener error is the runtime's: an uncaught exception, fatal to a process
// with no handler (and to this test, which fails on any uncaught error).
test.each(THROWING_LISTENERS)(
  'a throwing %s on either stop signal is reported, and the timeouts and stall are unaffected',
  async (_, attach) => {
    const { reports, release } = claimReports();
    try {
      const { logger, manager } = setup();
      const a = await started(manager, new ThrowsOnAbort(logger, 'a', attach));

      const result = await manager.stopComponent('a');

      expect(result.code).toBe('component_shutdown_timeout');
      expect(a.order).toEqual([
        'stop-before',
        'stop-after',
        'force-before',
        'force-after',
      ]);
      expect(manager.getComponentStatus('a')?.state).toBe('stalled');
      expect(
        reports.map((report) => [
          (report as Error).message,
          (report as Error).cause,
        ]),
      ).toEqual([
        [
          'Error in a callback lifecycle-manager stop abort listener for a',
          a.stopThrown,
        ],
        [
          'Error in a callback lifecycle-manager force abort listener for a',
          a.forceThrown,
        ],
      ]);

      a.forceGate.resolve();
      a.stopGate.resolve();
      await sleep(10);
      expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    } finally {
      release();
    }
  },
);

// Escalates to a force phase whose `onShutdownForce()` stays pending, then lets the
// graceful `stop()` it escalated from complete late, which ends that force phase first.
async function lateGracefulDuringForce(
  forceTimeoutMS: number,
  onForceSignal: (signal: AbortSignal) => void = () => {},
): Promise<{
  a: Records;
  result: Awaited<
    ReturnType<ReturnType<typeof setup>['manager']['stopComponent']>
  >;
  forceGate: ReturnType<typeof deferred<void>>;
}> {
  const { logger, manager } = setup();
  const a = await started(
    manager,
    new Records(logger, 'a', { graceful: 20, force: forceTimeoutMS }),
  );
  const stopGate = deferred();
  const forceGate = deferred();
  a.onStop = () => stopGate.promise;
  a.onForce = (signal) => {
    onForceSignal(signal);
    return forceGate.promise;
  };

  const stopping = manager.stopComponent('a');
  while (a.forceSignals.length === 0) {
    await sleep(5);
  }
  expect(a.forceSignals[0].aborted).toBe(false);

  stopGate.resolve();
  const result = await stopping;
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  return { a, result, forceGate };
}

test.each([
  ['with a force deadline', 5_000],
  ['with the force timeout disabled', 0],
])(
  'a late graceful completion that ends the force phase first aborts the force signal (%s)',
  async (_, forceTimeoutMS) => {
    const { a, result, forceGate } =
      await lateGracefulDuringForce(forceTimeoutMS);

    expect(result.success).toBe(true);
    expect(a.forceSignals).toHaveLength(1);
    expect(a.forceSignals[0].aborted).toBe(true);
    const reason = a.forceSignals[0].reason as ForceShutdownSupersededError;
    expect(reason).toBeInstanceOf(ForceShutdownSupersededError);
    expect(reason.errCode).toBe(lifecycleManagerErrCodes.ForceSuperseded);
    expect(reason.additionalInfo).toEqual({ componentName: 'a' });
    expect(reason.message).toBe(
      LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_SUPERSEDED,
    );
    expect(a.order).toEqual(['stop-abort', 'force-abort']);

    // Aborted once: a late settlement does not abort it again.
    forceGate.resolve();
    await sleep(10);
    expect(a.forceSignals[0].reason).toBe(reason);
    expect(a.order).toEqual(['stop-abort', 'force-abort']);
  },
);

test.each([
  ['resolves', (): void => {}],
  ['rejects', (): Promise<void> => Promise.reject(new Error('force failed'))],
])(
  'a force call that %s as a late graceful completion lands is not aborted',
  async (_, settle) => {
    const { logger, manager } = setup();
    const a = await started(
      manager,
      new Records(logger, 'a', { graceful: 20, force: 5_000 }),
    );
    const stopGate = deferred();
    a.onStop = () => stopGate.promise;
    // Settles itself and, in the same moment, releases the graceful `stop()`.
    a.onForce = () => {
      stopGate.resolve();
      return settle();
    };

    const result = await manager.stopComponent('a');

    expect(result.success).toBe(true);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    await sleep(10);
    expect(a.forceSignals).toHaveLength(1);
    expect(a.forceSignals[0].aborted).toBe(false);
    expect(a.order).toEqual(['stop-abort']);
  },
);

test.each(THROWING_LISTENERS)(
  'a throwing %s on a force signal a late graceful completion aborts is reported, not uncaught',
  async (_, attach) => {
    const { reports, release } = claimReports();
    try {
      const thrown = new Error('force listener');
      const { a, result, forceGate } = await lateGracefulDuringForce(
        5_000,
        (signal) => {
          attach(signal, thrown);
        },
      );

      expect(result.success).toBe(true);
      expect(a.forceSignals[0].aborted).toBe(true);
      // The recording listener added before it still ran.
      expect(a.order).toEqual(['stop-abort', 'force-abort']);
      expect(
        reports.map((report) => [
          (report as Error).message,
          (report as Error).cause,
        ]),
      ).toEqual([
        [
          'Error in a callback lifecycle-manager force abort listener for a',
          thrown,
        ],
      ]);
      forceGate.resolve();
      await sleep(10);
    } finally {
      release();
    }
  },
);

// Ways a hook honors its signal by rejecting: a cancellable call's `AbortError`, the
// abort reason itself, and an error of its own that carries the reason as its cause.
const HONORS_BY_REJECTING: Array<
  [string, (signal: AbortSignal) => Promise<void>]
> = [
  [
    'an AbortError from a cancellable call',
    (signal) => delay(5_000, undefined, { signal }),
  ],
  [
    'the abort reason itself',
    (signal) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(signal.reason as Error);
        });
      }),
  ],
  [
    'an error caused by the abort reason',
    (signal) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error('cleanup gave up', { cause: signal.reason }));
        });
      }),
  ],
];

test.each(HONORS_BY_REJECTING)(
  'a stop that rejects with %s at its deadline is the graceful timeout',
  async (_, honor) => {
    const { logger, manager } = setup();
    const sink = logger.getSinks()[0] as ArraySink;
    const a = await started(manager, new GracefulOnly(logger, 'a', 30));
    a.onStop = honor;
    const timeouts: Error[] = [];
    manager.on('component:stop-timeout', (data) => {
      timeouts.push((data as { error: Error }).error);
    });

    const result = await manager.stopComponent('a');
    await sleep(10);

    expect(result.success).toBe(false);
    expect(result.code).toBe('component_shutdown_timeout');
    // The event carries the error the signal was aborted with.
    expect(timeouts).toEqual([a.stopSignals[0].reason as Error]);
    expect(result.status?.stallInfo?.reason).toBe('timeout');
    // Reported as a stop that failed once its deadline fired, not as its own failure.
    expect(
      sink.logs.some((entry) =>
        entry.message.startsWith('Graceful shutdown threw error'),
      ),
    ).toBe(false);
    expect(
      sink.logs.some(
        (entry) =>
          entry.message === 'Component stop failed after deadline fired',
      ),
    ).toBe(true);
  },
);

test.each(HONORS_BY_REJECTING)(
  'a force handler that rejects with %s at its deadline is the force timeout',
  async (_, honor) => {
    const { logger, manager } = setup();
    const sink = logger.getSinks()[0] as ArraySink;
    const a = await started(
      manager,
      new Records(logger, 'a', { graceful: 30, force: 30 }),
    );
    a.onStop = honor;
    a.onForce = honor;
    const stopTimeouts: string[] = [];
    const forceTimeouts: string[] = [];
    manager.on('component:stop-timeout', (data) => {
      stopTimeouts.push((data as { name: string }).name);
    });
    manager.on('component:shutdown-force-timeout', (data) => {
      forceTimeouts.push((data as { name: string }).name);
    });

    const result = await manager.stopComponent('a');
    await sleep(10);

    expect(result.success).toBe(false);
    expect(result.code).toBe('component_shutdown_timeout');
    expect(result.reason).toBe(
      LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
    );
    expect(stopTimeouts).toEqual(['a']);
    expect(forceTimeouts).toEqual(['a']);
    // The force phase's own timeout, not a failure after a graceful one (`both`).
    expect(result.status?.stallInfo?.reason).toBe('timeout');
    expect(
      sink.logs.some((entry) =>
        entry.message.startsWith('Force shutdown failed - stalled'),
      ),
    ).toBe(false);
  },
);

test('an unrelated rejection after the deadline fired is still the graceful failure', async () => {
  const { logger, manager } = setup();
  const a = await started(manager, new GracefulOnly(logger, 'a', 30));
  const failure = new Error('cleanup failed');
  a.onStop = (signal) =>
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => {
        reject(failure);
      });
    });

  const result = await manager.stopComponent('a');

  expect(result.code).toBe('error');
  expect(result.error).toBe(failure);
  expect(result.status?.stallInfo?.reason).toBe('error');
});

test.each(HONORS_BY_REJECTING)(
  'a force handler that rejects with %s when a late graceful completion supersedes it is not reported',
  async (_, honor) => {
    const { logger, manager } = setup();
    const sink = logger.getSinks()[0] as ArraySink;
    const a = await started(
      manager,
      new Records(logger, 'a', { graceful: 20, force: 5_000 }),
    );
    const stopGate = deferred();
    a.onStop = () => stopGate.promise;
    a.onForce = honor;

    const stopping = manager.stopComponent('a');
    while (a.forceSignals.length === 0) {
      await sleep(5);
    }
    stopGate.resolve();
    const result = await stopping;
    await sleep(10);

    expect(result.success).toBe(true);
    expect(a.forceSignals[0].reason).toBeInstanceOf(
      ForceShutdownSupersededError,
    );
    expect(
      sink.logs.some((entry) =>
        entry.message.startsWith('Force shutdown failed'),
      ),
    ).toBe(false);
  },
);

test('a force handler that fails for its own reason once superseded is still reported', async () => {
  const { logger, manager } = setup();
  const sink = logger.getSinks()[0] as ArraySink;
  const a = await started(
    manager,
    new Records(logger, 'a', { graceful: 20, force: 5_000 }),
  );
  const stopGate = deferred();
  a.onStop = () => stopGate.promise;
  a.onForce = (signal) =>
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => {
        reject(new Error('cleanup failed'));
      });
    });

  const stopping = manager.stopComponent('a');
  while (a.forceSignals.length === 0) {
    await sleep(5);
  }
  stopGate.resolve();
  expect((await stopping).success).toBe(true);
  await sleep(10);

  const reports = sink.logs.filter((entry) =>
    entry.message.startsWith('Force shutdown failed'),
  );
  expect(reports.map((entry) => [entry.type, entry.message])).toEqual([
    ['warn', 'Force shutdown failed after graceful stop completed'],
  ]);
});
