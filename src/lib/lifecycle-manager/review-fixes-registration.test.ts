import { describe, expect, spyOn, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { sleep } from '../sleep';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, deferred, Plain, setup } from './test-helpers';
import type {
  ComponentLifecycleRef,
  ComponentOperationResult,
  HealthCheckResult,
  ShutdownResult,
  StopAllOptions,
  StopComponentOptions,
} from './types';

describe('restartComponent() asked to stay down before its stop took the component', () => {
  for (const isReplaced of [false, true]) {
    test(`reports the request${isReplaced ? ' for a replaced registration' : ''}, not the stop's refusal`, async () => {
      const { logger } = setup();
      const gate = deferred();
      let isArmed = false;

      class GatedManager extends LifecycleManager {
        public override async stopComponent(
          name: string,
          options?: StopComponentOptions,
        ): Promise<ComponentOperationResult> {
          if (isArmed) {
            isArmed = false;
            await gate.promise;
          }

          return await super.stopComponent(name, options);
        }
      }

      const manager = new GatedManager({
        logger,
        shutdownWarningTimeoutMS: -1,
      });
      await manager.registerComponent(new Plain(logger, 'a'));
      await manager.startComponent('a');
      isArmed = true;

      const restart = manager.restartComponent('a');
      const shutdown: ShutdownResult = await manager.stopAllComponents();
      expect(shutdown.success).toBe(true);
      expect(manager.isComponentRunning('a')).toBe(false);
      if (isReplaced) {
        await manager.unregisterComponent('a');
        await manager.registerComponent(new Plain(logger, 'a'));
      }
      gate.resolve();

      const result = await restart;

      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_requested_during_restart');
      expect(result.status === undefined).toBe(isReplaced);
      expect(manager.isComponentRunning('a')).toBe(false);
      await logger.close();
    });
  }
});

describe('unregisterComponent() whose stop refused before running stop()', () => {
  test('running dependents answer component_running, not a failed stop', async () => {
    const { logger, manager } = setup();
    let stops = 0;
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => {
      stops++;
      return Promise.resolve();
    };
    await manager.registerComponent(a);
    await manager.registerComponent(new Plain(logger, 'b', ['a']));
    await manager.startAllComponents();

    const result = await manager.unregisterComponent('a');

    expect(result.success).toBe(false);
    expect(result.code).toBe('component_running');
    expect(result.stopFailureReason).toBeUndefined();
    expect(result.wasStopped).toBe(false);
    expect(result.wasRegistered).toBe(true);
    expect(stops).toBe(0);
    expect(manager.hasComponent('a')).toBe(true);
    expect(manager.isComponentRunning('a')).toBe(true);
    await manager.stopAllComponents();
    await logger.close();
  });
});

describe('unregisterComponent() with stopIfRunning: false', () => {
  test('a replacement registered by an isComponentRunning() override is not answered for', async () => {
    const { logger } = setup();
    let isArmed = false;

    class ReplacingManager extends LifecycleManager {
      public override isComponentRunning(name: string): boolean {
        if (isArmed) {
          isArmed = false;
          void this.unregisterComponent(name, { stopIfRunning: false });
          void this.registerComponent(new Plain(logger, name));
          return true;
        }

        return super.isComponentRunning(name);
      }
    }

    const manager = new ReplacingManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const original = new Plain(logger, 'a');
    await manager.registerComponent(original);
    isArmed = true;

    const result = await manager.unregisterComponent('a', {
      stopIfRunning: false,
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('component_not_found');
    expect(result.wasRegistered).toBe(true);
    expect(manager.getComponentInstance('a')).not.toBe(original);
    expect(manager.hasComponent('a')).toBe(true);
    await logger.close();
  });
});

describe('registration refusal reports', () => {
  test('a refusal after rollback orders components its hooks committed', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'x', ['y']));
    const parent = new Plain(logger, 'parent');
    let shutdown: Promise<ShutdownResult> | undefined;
    parent._markRegistered = (): void => {
      void manager.registerComponent(new Plain(logger, 'y'));
      shutdown = manager.stopAllComponents();
    };

    const result = await manager.registerComponent(parent);
    await shutdown;

    expect(result.success).toBe(false);
    expect(result.code).toBe('shutdown_in_progress');
    expect(result.startupOrder).toEqual(['y', 'x']);
    await logger.close();
  });

  test('a removed timeout hook is refused before any dependency list is read', async () => {
    const { logger, manager } = setup();
    let peerReads = 0;
    const peer = new Plain(logger, 'peer');
    await manager.registerComponent(peer);
    peer.getDependencies = (): string[] => {
      peerReads++;
      return [];
    };
    let candidateReads = 0;
    let registeredReads = 0;
    const legacy = new Plain(logger, 'legacy');
    Object.assign(legacy, { onStartupAborted: (): void => {} });
    legacy.getDependencies = (): string[] => {
      candidateReads++;
      return [];
    };
    legacy._isRegisteredWithManager = (): boolean => {
      registeredReads++;
      return false;
    };

    const result = await manager.registerComponent(legacy);

    expect(result.code).toBe('invalid_options');
    expect(result.startupOrder).toEqual([]);
    expect(candidateReads).toBe(0);
    expect(registeredReads).toBe(0);
    expect(peerReads).toBe(0);
    await logger.close();
  });
});

describe('unregister', () => {
  test('a start an isComponentRunning() override begins on a stopped component is refused', async () => {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    let isArmed = false;
    let starting: Promise<ComponentOperationResult> | undefined;
    class Manager extends LifecycleManager {
      public override isComponentRunning(name: string): boolean {
        if (isArmed) {
          isArmed = false;
          starting = this.startComponent(name);
        }
        return super.isComponentRunning(name);
      }
    }
    const manager = new Manager({ logger, shutdownWarningTimeoutMS: -1 });
    const gate = deferred();
    const component = new Plain(logger, 'a');
    component.start = (): Promise<void> => gate.promise;
    await manager.registerComponent(component);

    isArmed = true;
    const result = await manager.unregisterComponent('a');

    expect(result.success).toBe(false);
    expect(result.code).toBe('component_starting');
    expect(manager.hasComponent('a')).toBe(true);

    gate.resolve();
    expect((await starting)?.success).toBe(true);
    expect((await manager.stopComponent('a')).success).toBe(true);
  });

  test("a stopComponent() override's answer is read once, and a non-object is a failed stop", async () => {
    const { logger, manager } = setup();
    let answer: unknown;
    manager.stopComponent = (): Promise<ComponentOperationResult> =>
      Promise.resolve(answer as ComponentOperationResult);
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startComponent('a');

    answer = undefined;
    const nonObject = await manager.unregisterComponent('a');
    expect(nonObject).toMatchObject({
      success: false,
      code: 'stop_failed',
      stopFailureReason: 'error',
      reason: 'Failed to stop component',
      wasStopped: false,
      wasRegistered: true,
    });

    const reads: Record<string, number> = {};
    const counted = (field: string, value: unknown) => ({
      get: () => {
        reads[field] = (reads[field] ?? 0) + 1;
        return value;
      },
      enumerable: true,
    });
    answer = Object.defineProperties(
      {},
      {
        success: counted('success', false),
        code: counted('code', 'component_shutdown_timeout'),
        reason: counted('reason', 'too slow'),
        error: counted('error', undefined),
      },
    );
    const counting = await manager.unregisterComponent('a');
    expect(counting).toMatchObject({
      success: false,
      code: 'stop_failed',
      stopFailureReason: 'timeout',
      reason: 'too slow',
    });
    expect(reads).toEqual({ success: 1, code: 1, reason: 1, error: 1 });
    expect(manager.hasComponent('a')).toBe(true);
  });

  test('a throwing _markUnregistered() that registered the instance again keeps that registration', async () => {
    const { logger, manager } = setup();
    const other: ComponentLifecycleRef = {} as ComponentLifecycleRef;
    class Reregisters extends Plain {
      public override _markUnregistered(): void {
        (this as unknown as { lifecycle: ComponentLifecycleRef }).lifecycle =
          other;
        throw new Error('unmark failed');
      }
    }
    const component = new Reregisters(logger, 'a');
    await manager.registerComponent(component);
    const { reports, release } = claimReports();

    try {
      const result = await manager.unregisterComponent('a');

      expect(result.success).toBe(true);
      expect(manager.hasComponent('a')).toBe(false);
      expect(
        (component as unknown as { lifecycle: ComponentLifecycleRef })
          .lifecycle,
      ).toBe(other);
      expect(component._isRegisteredWithManager()).toBe(true);
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  test('a throwing _markUnregistered() that did not register again is still cleared', async () => {
    const { logger, manager } = setup();
    class Throws extends Plain {
      public override _markUnregistered(): void {
        throw new Error('unmark failed');
      }
    }
    const component = new Throws(logger, 'a');
    await manager.registerComponent(component);
    const { release } = claimReports();

    try {
      expect((await manager.unregisterComponent('a')).success).toBe(true);
      expect(component._isRegisteredWithManager()).toBe(false);
      expect(
        (component as unknown as { lifecycle?: ComponentLifecycleRef })
          .lifecycle,
      ).toBeUndefined();
    } finally {
      release();
    }
  });
});

describe('availability rechecks follow the isComponentRunning() override', () => {
  for (const stopOnCall of [1, 2, 3, 4]) {
    test(`a message never enters a component the override stopped (call ${stopOnCall})`, async () => {
      const logger = new Logger({ sinks: [], callProcessExit: false });
      let calls = 0;
      let isArmed = false;
      class Manager extends LifecycleManager {
        public override isComponentRunning(name: string): boolean {
          if (isArmed && ++calls === stopOnCall) {
            void this.stopComponent(name);
          }
          return super.isComponentRunning(name);
        }
      }
      const manager = new Manager({ logger, shutdownWarningTimeoutMS: -1 });
      const gate = deferred();
      const component = new Plain(logger, 'a');
      component.stop = (): Promise<void> => gate.promise;
      const seen: Array<string | undefined> = [];
      (component as unknown as { onMessage: () => number }).onMessage = () => {
        seen.push(manager.getComponentStatus('a')?.state);
        return 1;
      };
      await manager.registerComponent(component);
      await manager.startComponent('a');

      isArmed = true;
      const result = await manager.sendMessageToComponent('a', 'hi');
      isArmed = false;

      for (const state of seen) {
        expect(state).toBe('running');
      }
      if (calls >= stopOnCall) {
        expect(result.sent).toBe(false);
        expect(seen).toEqual([]);
      }
      gate.resolve();
      await sleep(0);
    });

    test(`a health check never enters a component the override stopped (call ${stopOnCall})`, async () => {
      const logger = new Logger({ sinks: [], callProcessExit: false });
      let calls = 0;
      let isArmed = false;
      class Manager extends LifecycleManager {
        public override isComponentRunning(name: string): boolean {
          if (isArmed && ++calls === stopOnCall) {
            void this.stopComponent(name);
          }
          return super.isComponentRunning(name);
        }
      }
      const manager = new Manager({ logger, shutdownWarningTimeoutMS: -1 });
      const gate = deferred();
      const component = new Plain(logger, 'a');
      component.stop = (): Promise<void> => gate.promise;
      const seen: Array<string | undefined> = [];
      (component as unknown as { healthCheck: () => boolean }).healthCheck =
        () => {
          seen.push(manager.getComponentStatus('a')?.state);
          return true;
        };
      await manager.registerComponent(component);
      await manager.startComponent('a');

      isArmed = true;
      const result = await manager.checkComponentHealth('a');
      isArmed = false;

      for (const state of seen) {
        expect(state).toBe('running');
      }
      if (calls >= stopOnCall) {
        expect(result.code).toBe('stopped');
        expect(seen).toEqual([]);
      }
      gate.resolve();
      await sleep(0);
    });
  }
});

test('checkAllHealth() contains a malformed checkComponentHealth() answer to its own entry', async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const healthyReads = { count: 0 };
  class Manager extends LifecycleManager {
    public override checkComponentHealth(
      name: string,
    ): Promise<HealthCheckResult> {
      if (name === 'missing') {
        return Promise.resolve(undefined as unknown as HealthCheckResult);
      }
      if (name === 'throwing') {
        return Promise.resolve(
          Object.defineProperty({}, 'healthy', {
            get: () => {
              throw new Error('healthy getter');
            },
          }) as HealthCheckResult,
        );
      }
      return super.checkComponentHealth(name).then((result) =>
        Object.defineProperty({ ...result }, 'healthy', {
          get: () => {
            healthyReads.count++;
            return true;
          },
          enumerable: true,
        }),
      );
    }
  }
  const manager = new Manager({ logger, shutdownWarningTimeoutMS: -1 });
  for (const name of ['missing', 'throwing', 'fine']) {
    await manager.registerComponent(new Plain(logger, name));
  }
  await manager.startAllComponents();
  const { reports, release } = claimReports();

  try {
    const report = await manager.checkAllHealth();

    expect(report.code).toBe('error');
    expect(report.components.map((entry) => [entry.name, entry.code])).toEqual([
      ['missing', 'operation_crashed'],
      ['throwing', 'operation_crashed'],
      ['fine', 'no_handler'],
    ]);
    expect(report.components[2]?.healthy).toBe(true);
    expect(healthyReads.count).toBe(1);
    expect(reports).toHaveLength(2);
  } finally {
    release();
    await manager.stopAllComponents();
  }
});

test("a start awaiting its handle's stopAllComponents() is not joined by the pass an awaiting override runs", async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  class Manager extends LifecycleManager {
    public override async stopAllComponents(options?: StopAllOptions) {
      await sleep(0);
      return await super.stopAllComponents(options);
    }
  }
  const manager = new Manager({ logger, shutdownWarningTimeoutMS: -1 });
  class RequestsStop extends Plain {
    public override async start(): Promise<void> {
      await this.lifecycle.stopAllComponents();
    }
  }
  const component = new RequestsStop(logger, 'a');
  Object.defineProperty(component, 'startupTimeoutMS', { value: 5000 });
  await manager.registerComponent(component);

  const started = await Promise.race([
    manager.startComponent('a'),
    sleep(1000).then(() => 'hung' as const),
  ]);

  expect(started).not.toBe('hung');
});

describe('constructor name', () => {
  const logger = (): Logger =>
    new Logger({ sinks: [new ArraySink()], callProcessExit: false });

  test.each([42, '', {}, true])('refuses %p', (name) => {
    expect(
      () =>
        new LifecycleManager({
          logger: logger(),
          name: name as unknown as string,
        }),
    ).toThrow(new TypeError('name must be a non-empty string'));
  });

  test('null or omitted is the default, and the service logger is built from it', () => {
    for (const name of [null, undefined, 'my-app']) {
      const root = logger();
      const service = spyOn(root, 'service');
      new LifecycleManager({
        logger: root,
        name: name as unknown as string,
      });
      expect(service).toHaveBeenCalledWith(name ?? 'lifecycle-manager');
    }
  });

  test('an invalid option is refused before the service logger is built', () => {
    const root = logger();
    const service = spyOn(root, 'service');
    expect(
      () =>
        new LifecycleManager({
          logger: root,
          messageTimeoutMS: Number.NaN,
        }),
    ).toThrow();
    expect(service).not.toHaveBeenCalled();
  });
});
