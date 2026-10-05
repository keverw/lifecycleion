import { describe, expect, test } from 'bun:test';
import { sleep } from '../sleep';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import {
  claimReports,
  fakeSignals,
  Plain,
  setup,
  Stalls,
} from './test-helpers';

// Regressions for a review of the lifecycle-hardening branch: each test pins one
// behavior the fix changed.

function reportUnexpectedStop(component: Plain, error?: Error): boolean {
  return (
    component as unknown as {
      reportUnexpectedStop: (error?: Error) => boolean;
    }
  ).reportUnexpectedStop(error);
}

describe('start failure re-entry', () => {
  test('a restart from _clearUnexpectedStopHandler in a failed start is not clobbered', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    let starts = 0;
    let isArmed = false;
    a.start = (): Promise<void> => {
      starts++;
      if (starts === 1) {
        isArmed = true;
        return Promise.reject(new Error('start failed'));
      }

      // The restarted run stays in `start()`, so a third start would overlap it.
      return new Promise<void>(() => {});
    };
    const clear = a._clearUnexpectedStopHandler.bind(a);
    a._clearUnexpectedStopHandler = (): void => {
      if (isArmed) {
        isArmed = false;
        // Still this attempt's handler: the component reports a stop, and a listener
        // starts it again before the failed attempt writes its outcome.
        reportUnexpectedStop(a);
      }
      clear();
    };
    let restart: Promise<unknown> | undefined;
    manager.on('component:unexpected-stop', () => {
      restart ??= manager.startComponent('a');
    });
    await manager.registerComponent(a);

    const first = await manager.startComponent('a');
    await sleep(1);

    expect(restart).toBeDefined();
    expect(first.success).toBe(false);
    expect(first.code).toBe('component_unexpected_stop');
    // The restarted attempt still owns the component.
    expect(manager.getComponentStatus('a')?.state).toBe('starting');

    const third = await manager.startComponent('a');
    expect(third.code).toBe('component_already_starting');
    expect(starts).toBe(2);
  });
});

describe('failed restart state', () => {
  test('a failed restart of a stopped component keeps it stopped, not registered', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    expect((await manager.startComponent('a')).success).toBe(true);
    expect((await manager.stopComponent('a')).success).toBe(true);

    a.start = (): Promise<void> => Promise.reject(new Error('no restart'));
    const result = await manager.startComponent('a');

    expect(result.code).toBe('error');
    const status = manager.getComponentStatus('a');
    expect(status?.state).toBe('stopped');
    expect(status?.startedAt).not.toBeNull();
    expect(status?.stoppedAt).not.toBeNull();
    expect(status?.lastError?.message).toBe('no restart');
  });

  test('a failed first start still answers registered', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    a.start = (): Promise<void> => Promise.reject(new Error('no start'));
    await manager.registerComponent(a);

    expect((await manager.startComponent('a')).code).toBe('error');
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });
});

class Counted extends Plain {
  public starts = 0;
  public stops = 0;
  public override start(): Promise<void> {
    this.starts++;
    return Promise.resolve();
  }
  public override stop(): Promise<void> {
    this.stops++;
    return Promise.resolve();
  }
}

describe('haltOnStall break', () => {
  test('names the components a halt never reached as not attempted', async () => {
    const { logger, manager } = setup();
    const a = new Counted(logger, 'a');
    await manager.registerComponent(a);
    await manager.registerComponent(new Stalls(logger, 'b'));
    await manager.registerComponent(new Counted(logger, 'c'));
    await manager.startAllComponents();

    const { release } = claimReports();
    let result;
    try {
      result = await manager.stopAllComponents({ haltOnStall: true });
    } finally {
      release();
    }

    // Reverse order: `c` stopped, `b` stalled, and the halt never reached `a`.
    expect(result.success).toBe(false);
    expect(result.code).toBe('partial_state');
    expect(result.reason).toBe('Stalled: b; Not attempted: a');
    expect(a.stops).toBe(0);
  });

  test('a restart whose stop phase halted skips startup instead of reporting a partial start', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const a = new Counted(logger, 'a');
    const c = new Counted(logger, 'c');
    await manager.registerComponent(a);
    await manager.registerComponent(new Stalls(logger, 'b'));
    await manager.registerComponent(c);
    await manager.startAllComponents();

    const { release } = claimReports();
    let result;
    try {
      result = await manager.restartAllComponents({
        startupOptions: { ignoreStalledComponents: true },
      });
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.shutdownResult.code).toBe('partial_state');
    expect(result.startupResult.code).toBe('partial_state');
    expect(result.startupResult.reason).toBe(
      'Restart shutdown phase left components running; startup skipped',
    );
    // `a` was never stopped, so it was never restarted either: not reported as started.
    expect(result.startupResult.startedComponents).toEqual([]);
    expect(a.starts).toBe(1);
    expect(c.starts).toBe(1);
    expect(
      sink.logs.some(
        (entry) =>
          entry.type === 'warn' &&
          entry.message.startsWith('Restart abandoned: Restart shutdown phase'),
      ),
    ).toBe(true);
  });
});

describe('startup completion', () => {
  test('a shutdown begun by a lifecycle-manager:started listener is not reported as a successful startup', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    let shutdown: Promise<unknown> | undefined;
    let stateAfterShutdownBegan: string | undefined;
    manager.once('lifecycle-manager:started', () => {
      shutdown = manager.stopAllComponents();
      stateAfterShutdownBegan = manager.getSystemState();
    });

    const result = await manager.startAllComponents();

    expect(stateAfterShutdownBegan).toBe('shutting-down');
    expect(result.success).toBe(false);
    expect(result.code).toBe('shutdown_in_progress');
    expect(result.reason).toBe('Shutdown triggered as startup completed');
    await shutdown;
    expect(manager.isComponentRunning('a')).toBe(false);
  });

  test('a restart whose startup is shut down by a started listener does not report success', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    let shutdown: Promise<unknown> | undefined;
    manager.once('lifecycle-manager:started', () => {
      shutdown = manager.stopAllComponents();
    });

    const result = await manager.restartAllComponents();
    await shutdown;

    expect(result.success).toBe(false);
    expect(result.startupResult.code).toBe('shutdown_in_progress');
  });
});

describe('deferred auto-starts handed to a newer startup', () => {
  test('are not reported as unattempted when a startup begun from the detach takes them over', async () => {
    const sink = new ArraySink();
    let startup2: Promise<unknown> | undefined;
    let isArmed = false;
    // eslint-disable-next-line prefer-const -- assigned after the sink that reads it
    let manager!: LifecycleManager;
    const logger = new Logger({
      sinks: [
        sink,
        {
          write: (entry): void => {
            if (
              isArmed &&
              entry.message.startsWith('Auto-detached process signals after')
            ) {
              isArmed = false;
              startup2 = manager.startAllComponents();
            }
          },
        },
      ],
      callProcessExit: false,
    });
    manager = new LifecycleManager({
      logger,
      attachSignalsBeforeStartup: true,
      detachSignalsOnStop: true,
      shutdownWarningTimeoutMS: -1,
    });
    fakeSignals(manager);
    const late = new Counted(logger, 'late');
    const root = new Plain(logger, 'root');
    let rootStarts = 0;
    root.start = async (): Promise<void> => {
      rootStarts++;
      if (rootStarts === 1) {
        // Registered after the first startup froze its order: deferred to it.
        await manager.registerComponent(late, { autoStart: true });
      }
    };
    const bad = new Plain(logger, 'bad');
    let badStarts = 0;
    bad.start = (): Promise<void> => {
      badStarts++;
      return badStarts === 1
        ? Promise.reject(new Error('first startup fails'))
        : Promise.resolve();
    };
    await manager.registerComponent(root);
    await manager.registerComponent(bad);

    isArmed = true;
    const first = await manager.startAllComponents();
    expect(first.code).toBe('required_component_failed');
    expect(startup2).toBeDefined();
    const second = (await startup2) as { success: boolean };

    expect(second.success).toBe(true);
    expect(late.starts).toBe(1);
    expect(
      sink.logs.some((entry) =>
        entry.message.includes('deferred auto-starts were not attempted'),
      ),
    ).toBe(false);
    await manager.stopAllComponents();
    manager.detachSignals();
  });
});

describe('unregister ownership', () => {
  test('an unregister does not remove the same instance registered again during its stop', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    await manager.startComponent('a');
    let inner: Promise<unknown[]> | undefined;
    manager.once('component:stopped', () => {
      inner = Promise.all([
        manager.unregisterComponent('a', { stopIfRunning: false }),
        manager.registerComponent(a),
      ]);
    });

    const outer = await manager.unregisterComponent('a');
    const [innerUnregister, innerRegister] = (await inner) as [
      { success: boolean },
      { success: boolean },
    ];

    expect(innerUnregister.success).toBe(true);
    expect(innerRegister.success).toBe(true);
    // The registration made during the stop is a new one: not this call's to remove.
    expect(outer.success).toBe(false);
    expect(outer.code).toBe('component_not_found');
    expect(manager.getComponentInstance('a')).toBe(a);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });
});

describe('validateDependencies', () => {
  test('a chain deeper than the call stack validates instead of throwing', () => {
    const { logger, manager } = setup();
    // Registering this many through the public API takes far too long for a test, so
    // the committed registry is seeded directly: the depth is what matters here. The
    // cycle walk used to recurse once per link and overflowed around 50k components.
    const depth = 200_000;
    const components: Plain[] = [];
    for (let index = 0; index < depth; index++) {
      components.push(
        new Plain(logger, `c${index}`, index === 0 ? [] : [`c${index - 1}`]),
      );
    }
    Object.assign(manager, {
      componentEntries: components,
      components,
    });

    const result = manager.validateDependencies();

    expect(result.valid).toBe(true);
    expect(result.circularCycles).toEqual([]);
    expect(result.cycleCheckError).toBeUndefined();
  });
});

describe('start finishing after shutdown began', () => {
  test('emits component:started before the stop that follows', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    let releaseStart!: () => void;
    let didEnterStart!: () => void;
    const entered = new Promise<void>((resolve) => {
      didEnterStart = resolve;
    });
    a.start = (): Promise<void> =>
      new Promise<void>((resolve) => {
        releaseStart = resolve;
        didEnterStart();
      });
    await manager.registerComponent(a);
    const events: string[] = [];
    for (const event of [
      'component:starting',
      'component:started',
      'component:stopping',
      'component:stopped',
    ] as const) {
      manager.on(event, () => {
        events.push(event);
      });
    }

    const start = manager.startComponent('a');
    await entered;
    const shutdown = manager.stopAllComponents();
    releaseStart();
    const result = await start;
    await shutdown;

    expect(result.code).toBe('shutdown_in_progress');
    expect(result.reason).toBe('Shutdown triggered during component startup');
    expect(events).toEqual([
      'component:starting',
      'component:started',
      'component:stopping',
      'component:stopped',
    ]);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });
});

describe('graceful timeout crash', () => {
  test('a throw building the graceful-timeout result keeps the stall classified as a timeout', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    Object.assign(a, { shutdownGracefulTimeoutMS: 10 });
    a.stop = (): Promise<void> => new Promise<void>(() => {});
    await manager.registerComponent(a);
    await manager.startComponent('a');
    const getComponentStatus = manager.getComponentStatus.bind(manager);
    let isArmed = false;
    manager.getComponentStatus = (name: string) => {
      if (isArmed) {
        isArmed = false;
        throw new Error('status exploded');
      }
      return getComponentStatus(name);
    };
    manager.once('component:stop-timeout', () => {
      isArmed = true;
    });

    const { release } = claimReports();
    let result;
    try {
      result = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.code).toBe('operation_crashed');
    const [stall] = manager.getStalledComponents();
    expect(stall?.name).toBe('a');
    expect(stall?.reason).toBe('timeout');
  });
});

describe('rollback meeting a shutdown', () => {
  test('a rollback stop refused by a shutdown begun in its preparation is not logged as a failure', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const a = new Counted(logger, 'a');
    let shutdown: Promise<unknown> | undefined;
    let isArmed = false;
    Object.defineProperty(a, 'shutdownGracefulTimeoutMS', {
      get: (): number => {
        if (isArmed) {
          isArmed = false;
          shutdown = manager.stopAllComponents();
        }
        return 1000;
      },
    });
    const b = new Plain(logger, 'b');
    b.start = (): Promise<void> => {
      isArmed = true;
      return Promise.reject(new Error('b failed'));
    };
    await manager.registerComponent(a);
    await manager.registerComponent(b);

    const result = await manager.startAllComponents();
    await shutdown;

    expect(shutdown).toBeDefined();
    expect(result.code).toBe('shutdown_in_progress');
    // The shutdown stopped `a`, not the rollback.
    expect(a.stops).toBe(1);
    expect(
      sink.logs.some((entry) =>
        entry.message.startsWith('Failed to stop component during rollback'),
      ),
    ).toBe(false);
  });
});

describe('component startup detach label', () => {
  test('a successful start whose started listener stops it is not called a failed startup', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      attachSignalsBeforeStartup: true,
      detachSignalsOnStop: true,
      shutdownWarningTimeoutMS: -1,
    });
    const signals = fakeSignals(manager);
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    manager.once('component:started', () => {
      reportUnexpectedStop(a);
    });

    const result = await manager.startComponent('a');

    expect(result.success).toBe(true);
    expect(signals.isAttached()).toBe(false);
    const detachMessages = sink.logs
      .map((entry) => entry.message)
      .filter((message) => message.startsWith('Auto-detached process signals'));
    expect(detachMessages).toHaveLength(1);
    expect(detachMessages[0]).not.toContain('failed component startup');
  });
});

test('a start finishing after a timed-out shutdown pass names its detach as interrupted', async () => {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    attachSignalsBeforeStartup: true,
    detachSignalsOnStop: true,
    shutdownWarningTimeoutMS: -1,
  });
  const signals = fakeSignals(manager);
  const a = new Plain(logger, 'a');
  let releaseStart!: () => void;
  a.start = (): Promise<void> =>
    new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
  await manager.registerComponent(a);

  const start = manager.startComponent('a');
  await sleep(1);
  const shutdown = await manager.stopAllComponents({ timeoutMS: 5 });
  expect(shutdown.timedOut).toBe(true);
  releaseStart();
  const result = await start;

  expect(result.code).toBe('shutdown_in_progress');
  expect(signals.isAttached()).toBe(false);
  const detachMessages = sink.logs
    .map((entry) => entry.message)
    .filter((message) => message.startsWith('Auto-detached process signals'));
  expect(
    detachMessages.some((message) =>
      message.includes('failed component startup'),
    ),
  ).toBe(false);
});

describe('late-start cleanup availability', () => {
  test('a component under late-start cleanup is not entered by getValue, health checks or signals', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    let hookCalls = 0;
    let starts = 0;
    let stops = 0;
    let resolveLateStart!: () => void;
    let resolveOldStop!: () => void;
    a.start = (): Promise<void> => {
      starts++;
      return starts === 2
        ? new Promise<void>((resolve) => {
            resolveLateStart = resolve;
          })
        : Promise.resolve();
    };
    a.stop = (): Promise<void> => {
      stops++;
      return stops === 1
        ? new Promise<void>((resolve) => {
            resolveOldStop = resolve;
          })
        : Promise.resolve();
    };
    Object.assign(a, {
      getValue: (): unknown => {
        hookCalls++;
        return { found: true, value: 'live' };
      },
      healthCheck: (): boolean => {
        hookCalls++;
        return true;
      },
      onReload: (): void => {
        hookCalls++;
      },
    });
    Object.defineProperty(a, 'onShutdownForce', { value: undefined });
    Object.defineProperty(a, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(a);
    await manager.startComponent('a');
    await manager.stopComponent('a', { timeout: 5 });
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');

    let value: ReturnType<LifecycleManager['getValue']> | undefined;
    let checks:
      | Promise<
          [
            Awaited<ReturnType<LifecycleManager['checkComponentHealth']>>,
            Awaited<ReturnType<LifecycleManager['triggerReload']>>,
          ]
        >
      | undefined;
    manager.on('component:stalled-resolved', (event) => {
      if ((event as { reason?: string }).reason !== 'late-start-cleanup') {
        return;
      }
      value = manager.getValue('a', 'key', { includeStopped: true });
      checks = Promise.all([
        manager.checkComponentHealth('a'),
        manager.triggerReload(),
      ]);
    });

    try {
      expect(
        (await manager.startComponent('a', { forceStalled: true })).code,
      ).toBe('component_startup_timeout');
      resolveLateStart();
      await sleep(20);

      expect(checks).toBeDefined();
      const [health, reload] = await (checks as NonNullable<typeof checks>);
      expect(value?.code).toBe('stopped');
      expect(health.code).toBe('stopped');
      expect(reload.results.some((row) => row.name === 'a')).toBe(false);
      expect(hookCalls).toBe(0);
    } finally {
      resolveOldStop?.();
      await sleep(1);
      await manager.stopAllComponents();
    }
  });
});
