import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { sleep } from '../sleep';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function setup() {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  return {
    logger,
    manager: new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 }),
  };
}

describe('LifecycleManager hardening regressions', () => {
  test.each(['triggerReload', 'triggerInfo', 'triggerDebug'] as const)(
    '%s skips stop in flight after bulk timeout',
    async (trigger) => {
      const { logger, manager } = setup();
      const gate = deferred();
      let calls = 0;
      class Component extends BaseComponent {
        public start() {}
        public stop() {
          return gate.promise;
        }
        public onReload() {
          calls++;
        }
        public onInfo() {
          calls++;
        }
        public onDebug() {
          calls++;
        }
      }
      await manager.registerComponent(
        new Component(logger, { name: 'target', shutdownGracefulTimeoutMS: 0 }),
      );
      await manager.startAllComponents();
      const shutdown = await manager.stopAllComponents({ timeoutMS: 15 });
      try {
        expect(shutdown.timedOut).toBe(true);
        expect(manager.getComponentStatus('target')?.state).toBe('stopping');
        expect((await manager[trigger]()).results).toEqual([]);
        expect(calls).toBe(0);
      } finally {
        gate.resolve();
        await sleep(10);
      }
    },
  );

  test('broadcast rechecks targets after earlier callbacks and synchronous events', async () => {
    const { logger, manager } = setup();
    const first = deferred();
    let calls = 0;
    class Component extends BaseComponent {
      public start() {}
      public stop() {}
      public onReload() {
        if (this.getName() === 'first') {
          return first.promise;
        }
        calls++;
      }
    }
    await manager.registerComponent(new Component(logger, { name: 'first' }));
    await manager.registerComponent(new Component(logger, { name: 'second' }));
    await manager.startAllComponents();
    const broadcast = manager.triggerReload();
    await sleep(1);
    await manager.stopComponent('second');
    first.resolve();
    await broadcast;
    expect(calls).toBe(0);
    await manager.startComponent('second');
    manager.on<{ name: string }>('component:reload-started', ({ name }) => {
      if (name === 'second') {
        void manager.stopComponent(name);
      }
    });
    await manager.triggerReload();
    expect(calls).toBe(0);
    await manager.stopAllComponents();
  });

  test.each(
    [false, true].flatMap((hasAbort) =>
      (['cleanup', 'restart', 'bulk-restart', 'replace'] as const).map(
        (recovery) => ({ hasAbort, recovery }),
      ),
    ),
  )(
    'bulk deadline permits recovery and handles late completion (%p)',
    async ({ hasAbort, recovery }) => {
      const { logger, manager } = setup();
      const gate = deferred();
      let starts = 0,
        stops = 0,
        aborts = 0;
      class Component extends BaseComponent {
        public start() {
          starts++;
          return starts === 1 ? gate.promise : undefined;
        }
        public stop() {
          stops++;
        }
      }
      const component = new Component(logger, {
        name: 'hung',
        startupTimeoutMS: 0,
      });
      if (hasAbort) {
        component.onStartupAborted = () => {
          aborts++;
        };
      }
      await manager.registerComponent(component);
      const startedAt = Date.now();
      const result = await manager.startAllComponents({ timeoutMS: 20 });
      try {
        // Returns at its deadline rather than waiting on the hung start, which never
        // settles on its own. Loose, for slow CI runners: a macOS runner took 288ms.
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(result).toMatchObject({
          success: false,
          timedOut: true,
          code: 'startup_timeout',
          startedComponents: [],
        });
        await sleep(10);
        expect(starts).toBe(1);
        expect(aborts).toBe(hasAbort ? 1 : 0);
        if (recovery === 'replace') {
          expect((await manager.unregisterComponent('hung')).success).toBe(
            true,
          );
          await manager.registerComponent(
            new Component(logger, { name: 'hung' }),
          );
        }
        if (recovery === 'bulk-restart') {
          expect((await manager.startAllComponents()).success).toBe(true);
        } else if (recovery !== 'cleanup') {
          expect((await manager.startComponent('hung')).success).toBe(true);
        }
        expect(stops).toBe(0);
      } finally {
        gate.resolve();
        await sleep(20);
      }
      if (recovery === 'cleanup') {
        expect(stops).toBe(1);
        expect(manager.isComponentRunning('hung')).toBe(false);
        expect((await manager.startComponent('hung')).success).toBe(true);
      } else {
        // The old completion must not stop the retry or replacement instance.
        expect(starts).toBe(2);
        expect(stops).toBe(0);
        expect(manager.isComponentRunning('hung')).toBe(true);
      }
      await manager.stopAllComponents();
    },
  );

  test('bulk deadline preserves prior successes and stops initiating dependents', async () => {
    const { logger, manager } = setup();
    const gate = deferred();
    const starts: string[] = [];
    class Component extends BaseComponent {
      public start() {
        starts.push(this.getName());
        if (this.getName() === 'hung') {
          return gate.promise;
        }
      }
      public stop() {}
    }
    await manager.registerComponent(new Component(logger, { name: 'ready' }));
    await manager.registerComponent(
      new Component(logger, {
        name: 'hung',
        dependencies: ['ready'],
        startupTimeoutMS: 0,
      }),
    );
    await manager.registerComponent(
      new Component(logger, { name: 'next', dependencies: ['hung'] }),
    );
    try {
      const result = await manager.startAllComponents({ timeoutMS: 20 });
      expect(result.startedComponents).toEqual(['ready']);
      expect(starts).toEqual(['ready', 'hung']);
      expect(manager.isComponentRunning('ready')).toBe(true);
    } finally {
      gate.resolve();
      await sleep(20);
      await manager.stopAllComponents();
    }
  });

  test('failure rollback outlives the startup deadline, blocks overlap, and preserves the failure', async () => {
    const { logger, manager } = setup();
    const gate = deferred();
    const rollbackStarted = deferred();
    class Component extends BaseComponent {
      public start() {
        if (this.getName() === 'fails') {
          throw new Error('startup failed');
        }
      }
      public stop() {
        rollbackStarted.resolve();
        return gate.promise;
      }
    }
    await manager.registerComponent(
      new Component(logger, { name: 'ready', shutdownGracefulTimeoutMS: 0 }),
    );
    await manager.registerComponent(
      new Component(logger, { name: 'fails', dependencies: ['ready'] }),
    );
    let isSettled = false;
    const startup = manager
      .startAllComponents({ timeoutMS: 20 })
      .then((result) => {
        isSettled = true;
        return result;
      });
    try {
      await rollbackStarted.promise;
      await sleep(40);
      expect(isSettled).toBe(false);
      expect((await manager.startAllComponents()).code).toBe(
        'already_in_progress',
      );
    } finally {
      gate.resolve();
      await startup;
    }
    expect(await startup).toMatchObject({
      success: false,
      code: 'required_component_failed',
    });
    expect((await startup).error?.message).toBe('startup failed');
    expect(manager.isComponentRunning('ready')).toBe(false);
  });

  test('includeStopped cannot enter startup handlers', async () => {
    const { logger, manager } = setup();
    const gate = deferred();
    let calls = 0;
    class Component extends BaseComponent {
      public start() {
        return gate.promise;
      }
      public stop() {}
      public onMessage<T>() {
        calls++;
        return undefined as T;
      }
      public getValue<T>() {
        calls++;
        return { found: true, value: 1 as T };
      }
    }
    await manager.registerComponent(
      new Component(logger, { name: 'starting' }),
    );
    const start = manager.startComponent('starting');
    try {
      expect(
        (
          await manager.sendMessageToComponent(
            'starting',
            {},
            { includeStopped: true },
          )
        ).sent,
      ).toBe(false);
      expect(
        manager.getValue('starting', 'value', { includeStopped: true }).found,
      ).toBe(false);
      expect(calls).toBe(0);
    } finally {
      gate.resolve();
      await start;
      await manager.stopAllComponents();
    }
  });

  test('a throwing shutdown notification logger does not consume the signal', async () => {
    const { logger } = setup();
    const service = logger.service.bind(logger);
    let stops = 0;
    logger.service = (name) => {
      const scoped = service(name);
      const info = scoped.info.bind(scoped);
      scoped.info = (...args) => {
        if (args[0] === 'Shutdown signal received') {
          throw new Error('logger failed');
        }
        return info(...args);
      };
      return scoped;
    };
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    class Component extends BaseComponent {
      public start() {}
      public stop() {
        stops++;
      }
    }
    await manager.registerComponent(new Component(logger, { name: 'target' }));
    await manager.startAllComponents();
    const reports: Event[] = [];
    const onError = (event: Event) => {
      reports.push(event);
      event.preventDefault();
    };
    globalThis.addEventListener('error', onError);
    manager.attachSignals();
    try {
      process.emit('SIGTERM', 'SIGTERM');
      await sleep(20);
      expect(stops).toBe(1);
      expect(reports).toHaveLength(1);
    } finally {
      manager.detachSignals();
      globalThis.removeEventListener('error', onError);
      await manager.stopAllComponents();
    }
  });
});

test('late cleanup still runs when an abort hook immediately resolves start', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  let stops = 0;
  class Component extends BaseComponent {
    public start() {
      return gate.promise;
    }
    public onStartupAborted() {
      gate.resolve();
    }
    public stop() {
      stops++;
    }
  }
  await manager.registerComponent(
    new Component(logger, { name: 'abort-resolves', startupTimeoutMS: 0 }),
  );
  expect((await manager.startAllComponents({ timeoutMS: 10 })).code).toBe(
    'startup_timeout',
  );
  await sleep(20);
  expect(stops).toBe(1);
  expect(manager.isComponentRunning('abort-resolves')).toBe(false);
});

test('bulk deadline skips later components after synchronous work exhausts the budget', async () => {
  const { logger, manager } = setup();
  const starts: string[] = [];
  class Component extends BaseComponent {
    public start() {
      starts.push(this.getName());
      const end = Date.now() + 25;
      while (Date.now() < end) {
        /* Simulate synchronous startup work. */
      }
    }
    public stop() {}
  }
  await manager.registerComponent(new Component(logger, { name: 'first' }));
  await manager.registerComponent(
    new Component(logger, { name: 'second', dependencies: ['first'] }),
  );
  try {
    const result = await manager.startAllComponents({ timeoutMS: 10 });
    expect(result.code).toBe('startup_timeout');
    expect(result.startedComponents).toEqual([]);
    await sleep(10);
    expect(manager.isComponentRunning('first')).toBe(false);
    expect(starts).toEqual(['first']);
  } finally {
    await manager.stopAllComponents();
  }
});

test('signals skip force-stop work still in flight', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  let calls = 0;
  class Component extends BaseComponent {
    public start() {}
    public stop() {
      throw new Error('force required');
    }
    public onShutdownForce() {
      return gate.promise;
    }
    public onReload() {
      calls++;
    }
  }
  await manager.registerComponent(
    new Component(logger, { name: 'force', shutdownForceTimeoutMS: 0 }),
  );
  await manager.startAllComponents();
  const stop = manager.stopComponent('force');
  try {
    await sleep(5);
    expect(manager.getComponentStatus('force')?.state).toBe('force-stopping');
    await manager.triggerReload();
    expect(calls).toBe(0);
  } finally {
    gate.resolve();
    await stop;
  }
});

test('a start resolving between the outer bulk deadline and inner timer is cleaned up', async () => {
  const { logger } = setup();
  const gate = deferred();
  let stops = 0;
  const service = logger.service.bind(logger);
  logger.service = (name) => {
    const scoped = service(name);
    const warn = scoped.warn.bind(scoped);
    scoped.warn = (...args) => {
      if (args[0] === 'Startup timeout exceeded, returning partial results') {
        gate.resolve();
      }
      return warn(...args);
    };
    return scoped;
  };
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  class Component extends BaseComponent {
    public start() {
      const end = Date.now() + 10;
      while (Date.now() < end) {
        /* Shift inner timer registration past the outer timer. */
      }
      return gate.promise;
    }
    public stop() {
      stops++;
    }
  }
  await manager.registerComponent(
    new Component(logger, { name: 'deadline-race', startupTimeoutMS: 0 }),
  );
  try {
    const result = await manager.startAllComponents({ timeoutMS: 30 });
    expect(result.code).toBe('startup_timeout');
    expect(result.startedComponents).toEqual([]);
    await sleep(20);
    expect(manager.isComponentRunning('deadline-race')).toBe(false);
    expect(stops).toBe(1);
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
  }
});

test('a throwing signal:shutdown listener is contained and shutdown continues', async () => {
  const { logger, manager } = setup();
  let stops = 0;
  class Component extends BaseComponent {
    public start() {}
    public stop() {
      stops++;
    }
  }
  await manager.registerComponent(new Component(logger, { name: 'target' }));
  await manager.startAllComponents();
  manager.on('signal:shutdown', () => {
    throw new Error('listener failed');
  });
  const reports: Event[] = [];
  const onError = (event: Event) => {
    reports.push(event);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  manager.attachSignals();
  try {
    process.emit('SIGTERM', 'SIGTERM');
    await sleep(10);
    expect(stops).toBe(1);
    expect(reports).toHaveLength(1);
  } finally {
    manager.detachSignals();
    globalThis.removeEventListener('error', onError);
    await manager.stopAllComponents();
  }
});

test.each([false, true])(
  'records a promoted component before an expired timer can snapshot startup (microtask delay=%p)',
  async (useMicrotaskDelay) => {
    const { logger, manager } = setup();
    let didTimerRun = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    class Component extends BaseComponent {
      public start() {}
      public stop() {}
    }
    await manager.registerComponent(
      new Component(logger, { name: 'finished' }),
    );
    await manager.registerComponent(
      new Component(logger, { name: 'next', dependencies: ['finished'] }),
    );
    manager.once('component:started', () => {
      // Cross the deadline after the inner start has checked it. In the
      // microtask case this work sits ahead of the parent's await continuation.
      const exhaustBudget = (): void => {
        const end = Date.now() + 120;
        while (Date.now() < end) {
          // Model expensive completion observers while a timer becomes due.
        }
      };
      if (useMicrotaskDelay) {
        queueMicrotask(exhaustBudget);
      } else {
        exhaustBudget();
      }
      timer = setTimeout(() => {
        didTimerRun = true;
      }, 0);
    });
    try {
      const result = await manager.startAllComponents({ timeoutMS: 100 });
      expect(result.code).toBe('startup_timeout');
      expect(result.startedComponents).toEqual(['finished']);
      expect(manager.isComponentRunning('finished')).toBe(true);
      expect(manager.isComponentRunning('next')).toBe(false);
      expect(didTimerRun).toBe(false);
    } finally {
      clearTimeout(timer);
      await manager.stopAllComponents();
    }
  },
);
