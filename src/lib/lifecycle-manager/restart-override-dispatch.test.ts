import { describe, expect, test } from 'bun:test';
import type { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { Plain, setup } from './test-helpers';
import type {
  ComponentOperationResult,
  ShutdownResult,
  StartComponentOptions,
  StartupOptions,
  StartupResult,
  StopAllOptions,
  StopComponentOptions,
} from './types';

// A restart stops and starts through the manager's public `stopComponent()`,
// `startComponent()` and `startAllComponents()`, so a subclass override or an instance
// patch of one runs for a restart too. The options a restart hands them carry its own
// context: forwarded to the original, the restart keeps its guarantees; replaced by a
// new object, the call is a plain start or stop.

class Counted extends Plain {
  public starts = 0;

  public override start(): Promise<void> {
    this.starts++;

    return Promise.resolve();
  }
}

/** Records every call of the overridable lifecycle methods, then forwards it. */
class RecordingManager extends LifecycleManager {
  public readonly calls: string[] = [];
  public readonly received: unknown[] = [];

  public override startComponent(
    name: string,
    options?: StartComponentOptions,
  ): Promise<ComponentOperationResult> {
    this.calls.push(`start:${name}`);
    this.received.push(options);

    return super.startComponent(name, options);
  }

  public override stopComponent(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    this.calls.push(`stop:${name}`);
    this.received.push(options);

    return super.stopComponent(name, options);
  }

  public override startAllComponents(
    options?: StartupOptions,
  ): Promise<StartupResult> {
    this.calls.push('startAll');
    this.received.push(options);

    return super.startAllComponents(options);
  }

  public override stopAllComponents(
    options?: StopAllOptions,
  ): Promise<ShutdownResult> {
    this.calls.push('stopAll');
    this.received.push(options);

    return super.stopAllComponents(options);
  }
}

function recordingSetup(): { logger: Logger; manager: RecordingManager } {
  const { logger } = setup();

  return {
    logger,
    manager: new RecordingManager({ logger, shutdownWarningTimeoutMS: -1 }),
  };
}

describe('restart dispatch through overridable methods', () => {
  test('restartComponent() stops and starts through the overrides, with the same result', async () => {
    const { logger, manager } = recordingSetup();
    const { manager: plainManager } = setup();
    for (const target of [manager, plainManager]) {
      await target.registerComponent(new Plain(logger, 'a'));
      await target.startComponent('a');
    }
    manager.calls.length = 0;
    manager.received.length = 0;

    const options = {
      stopOptions: { timeout: 1234 },
      startOptions: { allowNonRunningDependencies: true },
    };
    const result = await manager.restartComponent('a', options);
    const plainResult = await plainManager.restartComponent('a', options);

    expect(manager.calls).toEqual(['stop:a', 'start:a']);
    // The restart's own options, read once before the stop.
    expect(manager.received).toEqual([
      {
        allowStopWithRunningDependents: false,
        forceImmediate: false,
        timeout: 1234,
      },
      {
        allowDuringBulkStartup: false,
        forceStalled: false,
        allowNonRunningDependencies: true,
      },
    ]);
    expect(manager.received.every((value) => Object.isFrozen(value))).toBe(
      true,
    );
    expect(result.success).toBe(true);
    expect(result.componentName).toBe('a');
    expect(result.status?.state).toBe('running');
    expect({ ...result, status: undefined }).toEqual({
      ...plainResult,
      status: undefined,
    });
    await logger.close();
  });

  test('restartComponent() keeps its failure codes through the overrides', async () => {
    const { logger, manager } = recordingSetup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');
    component.start = (): Promise<void> =>
      Promise.reject(new Error('start failed'));
    manager.calls.length = 0;

    const result = await manager.restartComponent('a');

    expect(manager.calls).toEqual(['stop:a', 'start:a']);
    expect(result.success).toBe(false);
    expect(result.code).toBe('restart_start_failed');
    expect(result.reason).toBe('Failed to start: start failed');
    await logger.close();
  });

  test('restartAllComponents() runs its startup phase through startAllComponents()', async () => {
    const { logger, manager } = recordingSetup();
    await manager.registerComponent(new Plain(logger, 'db'));
    await manager.registerComponent(new Plain(logger, 'api', ['db']));
    await manager.startAllComponents();
    manager.calls.length = 0;
    manager.received.length = 0;

    const result = await manager.restartAllComponents({
      startupOptions: { timeoutMS: 4321 },
    });

    // The stop phase is the restart's own shutdown pass, as it always was: not a
    // `stopAllComponents()` call, which would be a request to stay down. The startup
    // phase starts each component internally, as `startAllComponents()` does.
    expect(manager.calls).toEqual(['startAll']);
    expect(manager.received).toEqual([
      { ignoreStalledComponents: false, timeoutMS: 4321 },
    ]);
    expect(result.success).toBe(true);
    expect(result.shutdownResult.success).toBe(true);
    expect(result.startupResult.success).toBe(true);
    expect(result.startupResult.startedComponents).toEqual(['db', 'api']);
    expect(result.startupSkippedByShutdownRequest).toBeUndefined();
    await logger.close();
  });
});

describe('the restart context through an override', () => {
  // Replaces the component from inside the restart's start, before handing it on.
  async function restartWithReplacingStart(
    passOptions: (
      options: StartComponentOptions | undefined,
    ) => StartComponentOptions | undefined,
  ): Promise<{
    result: ComponentOperationResult;
    original: Counted;
    replacement: Counted;
    manager: LifecycleManager;
  }> {
    const { logger } = setup();
    const original = new Counted(logger, 'a');
    const replacement = new Counted(logger, 'a');
    let isArmed = false;

    class ReplacingManager extends LifecycleManager {
      public override async startComponent(
        name: string,
        options?: StartComponentOptions,
      ): Promise<ComponentOperationResult> {
        if (isArmed) {
          isArmed = false;
          await this.unregisterComponent(name, { stopIfRunning: false });
          await this.registerComponent(replacement);
        }

        return await super.startComponent(name, passOptions(options));
      }
    }

    const manager = new ReplacingManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    await manager.registerComponent(original);
    await manager.startComponent('a');
    isArmed = true;

    const result = await manager.restartComponent('a');

    return { result, original, replacement, manager };
  }

  test('a forwarding override keeps the same-registration check', async () => {
    const { result, original, replacement, manager } =
      await restartWithReplacingStart((options) => options);

    expect(result.success).toBe(false);
    expect(result.code).toBe('restart_start_failed');
    expect(result.reason).toBe(
      'Failed to start: Component "a" was unregistered or replaced while its start was being prepared',
    );
    expect(original.starts).toBe(1);
    expect(replacement.starts).toBe(0);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });

  test('an override that builds new options restarts as a plain start', async () => {
    const { result, original, replacement, manager } =
      await restartWithReplacingStart(() => ({}));

    // A plain start of whatever holds the name: the replacement.
    expect(result.success).toBe(true);
    expect(result.status?.state).toBe('running');
    expect(original.starts).toBe(1);
    expect(replacement.starts).toBe(1);
    expect(manager.getComponentInstance('a')).toBe(replacement);
    await manager.stopAllComponents();
  });

  test('an override that builds new stop options still restarts', async () => {
    const { logger } = setup();
    const calls: string[] = [];

    class FreshStopManager extends LifecycleManager {
      public override stopComponent(
        name: string,
        options?: StopComponentOptions,
      ): Promise<ComponentOperationResult> {
        calls.push(`stop:${name}`);

        return super.stopComponent(name, { timeout: options?.timeout });
      }
    }

    const manager = new FreshStopManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const component = new Counted(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');

    const result = await manager.restartComponent('a');

    expect(calls).toEqual(['stop:a']);
    expect(result.success).toBe(true);
    expect(component.starts).toBe(2);
    await manager.stopAllComponents();
    await logger.close();
  });

  test('a replacement registered while a stop override awaits is never stopped', async () => {
    const { logger } = setup();
    const original = new Counted(logger, 'a');
    const replacement = new Counted(logger, 'a');
    let replacementStops = 0;
    replacement.stop = (): Promise<void> => {
      replacementStops++;

      return Promise.resolve();
    };
    let isArmed = false;

    class ReplacingStopManager extends LifecycleManager {
      public override async stopComponent(
        name: string,
        options?: StopComponentOptions,
      ): Promise<ComponentOperationResult> {
        if (isArmed) {
          isArmed = false;
          await this.unregisterComponent(name);
          await this.registerComponent(replacement);
          await this.startComponent(name);
        }

        return await super.stopComponent(name, options);
      }
    }

    const manager = new ReplacingStopManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    await manager.registerComponent(original);
    await manager.startComponent('a');
    isArmed = true;

    const result = await manager.restartComponent('a');

    expect(result).toMatchObject({
      success: false,
      code: 'component_not_found',
    });
    expect(replacementStops).toBe(0);
    expect(replacement.starts).toBe(1);
    expect(manager.getComponentInstance('a')).toBe(replacement);
    expect(manager.isComponentRunning('a')).toBe(true);
    await manager.stopAllComponents();
    await logger.close();
  });

  // The stop phase makes `db`'s startup timeout invalid. Restart validated it before
  // stopping anything and starts unchanged registrations with that saved value.
  async function restartAllAfterTimeoutBreaks(
    passOptions: (options: StartupOptions | undefined) => StartupOptions,
  ): Promise<{
    result: Awaited<ReturnType<LifecycleManager['restartAllComponents']>>;
    calls: number;
  }> {
    const { logger } = setup();
    let calls = 0;

    class StartupOverride extends LifecycleManager {
      public override startAllComponents(
        options?: StartupOptions,
      ): Promise<StartupResult> {
        calls++;

        return super.startAllComponents(passOptions(options));
      }
    }

    class BreaksOnStop extends Plain {
      public override stop(): Promise<void> {
        Object.defineProperty(this, 'startupTimeoutMS', { value: Number.NaN });

        return Promise.resolve();
      }
    }

    const manager = new StartupOverride({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    await manager.registerComponent(new BreaksOnStop(logger, 'db'));
    await manager.startComponent('db');
    calls = 0;

    const result = await manager.restartAllComponents();
    await manager.stopAllComponents();
    await logger.close();

    return { result, calls };
  }

  test('a forwarding startAllComponents() override keeps the saved startup timeouts', async () => {
    const { result, calls } = await restartAllAfterTimeoutBreaks(
      (options) => options ?? {},
    );

    expect(calls).toBe(1);
    expect(result.success).toBe(true);
    expect(result.startupResult.startedComponents).toEqual(['db']);
  });

  test('a startAllComponents() override with new options runs a plain startup', async () => {
    const { result, calls } = await restartAllAfterTimeoutBreaks(() => ({}));

    // A plain startup reads the component's timeout as it is now.
    expect(calls).toBe(1);
    expect(result.success).toBe(false);
    expect(result.startupResult.success).toBe(false);
    expect(result.startupResult.startedComponents).toEqual([]);
  });
});

test('instance patches of the lifecycle methods run for restarts', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.startAllComponents();
  const calls: string[] = [];

  const startComponent = manager.startComponent.bind(manager);
  const stopComponent = manager.stopComponent.bind(manager);
  const startAllComponents = manager.startAllComponents.bind(manager);
  manager.startComponent = (name, options) => {
    calls.push(`start:${name}`);

    return startComponent(name, options);
  };
  manager.stopComponent = (name, options) => {
    calls.push(`stop:${name}`);

    return stopComponent(name, options);
  };
  manager.startAllComponents = (options) => {
    calls.push('startAll');

    return startAllComponents(options);
  };

  const single = await manager.restartComponent('a');
  const all = await manager.restartAllComponents();

  expect(calls).toEqual(['stop:a', 'start:a', 'startAll']);
  expect(single.success).toBe(true);
  expect(all.success).toBe(true);
  await manager.stopAllComponents();
  await logger.close();
});

describe('the restart context outside the restart call', () => {
  test('restartComponent() skips its start when a shutdown ran while an override awaited', async () => {
    const { logger } = setup();
    let isArmed = false;

    class AwaitingManager extends LifecycleManager {
      public override async startComponent(
        name: string,
        options?: StartComponentOptions,
      ): Promise<ComponentOperationResult> {
        if (isArmed) {
          isArmed = false;
          await this.stopAllComponents();
        }

        return await super.startComponent(name, options);
      }
    }

    const manager = new AwaitingManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const component = new Counted(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');
    isArmed = true;

    const result = await manager.restartComponent('a');

    expect(result.success).toBe(false);
    expect(result.code).toBe('shutdown_requested_during_restart');
    expect(component.starts).toBe(1);
    expect(manager.isComponentRunning('a')).toBe(false);
    await logger.close();
  });

  test('restartAllComponents() skips its startup when a shutdown ran while an override awaited', async () => {
    const { logger } = setup();
    let isArmed = false;

    class AwaitingManager extends LifecycleManager {
      public override async startAllComponents(
        options?: StartupOptions,
      ): Promise<StartupResult> {
        if (isArmed) {
          isArmed = false;
          await this.stopAllComponents();
        }

        return await super.startAllComponents(options);
      }
    }

    const manager = new AwaitingManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const component = new Counted(logger, 'a');
    await manager.registerComponent(component);
    await manager.startAllComponents();
    isArmed = true;

    const result = await manager.restartAllComponents();

    expect(result.success).toBe(false);
    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(result.startupResult.code).toBe('shutdown_requested_during_restart');
    expect(component.starts).toBe(1);
    expect(manager.isComponentRunning('a')).toBe(false);
    await logger.close();
  });

  test("another manager handed a restart's options makes a plain call", async () => {
    const { logger } = setup();
    const other = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const otherComponent = new Counted(logger, 'a');
    await other.registerComponent(otherComponent);
    const otherResults: ComponentOperationResult[] = [];
    let isArmed = false;

    class ForwardingManager extends LifecycleManager {
      public override async startComponent(
        name: string,
        options?: StartComponentOptions,
      ): Promise<ComponentOperationResult> {
        if (isArmed) {
          otherResults.push(await other.startComponent(name, options));
        }

        return await super.startComponent(name, options);
      }
    }

    const manager = new ForwardingManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const component = new Counted(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');
    isArmed = true;

    const result = await manager.restartComponent('a');

    // The other manager starts its own `a`, not against this restart's snapshot, and
    // leaves the restart's context for this manager's start.
    expect(otherResults.map((value) => value.success)).toEqual([true]);
    expect(otherComponent.starts).toBe(1);
    expect(result.success).toBe(true);
    expect(component.starts).toBe(2);
    await other.stopAllComponents();
    await manager.stopAllComponents();
    await logger.close();
  });

  test("a restart's options replayed after the restart returned make a plain call", async () => {
    const { logger } = setup();
    let saved: StartComponentOptions | undefined;

    class SavingManager extends LifecycleManager {
      public override startComponent(
        name: string,
        options?: StartComponentOptions,
      ): Promise<ComponentOperationResult> {
        saved ??= options;

        return super.startComponent(name, { ...options });
      }
    }

    const manager = new SavingManager({ logger, shutdownWarningTimeoutMS: -1 });
    const original = new Counted(logger, 'a');
    await manager.registerComponent(original);
    await manager.startComponent('a');
    saved = undefined;
    expect((await manager.restartComponent('a')).success).toBe(true);
    expect(saved).toBeDefined();

    await manager.stopComponent('a');
    await manager.unregisterComponent('a');
    const replacement = new Counted(logger, 'a');
    await manager.registerComponent(replacement);

    // Not the restart's start, whose snapshot names the unregistered original.
    const replay = await manager.startComponent('a', saved);

    expect(replay.success).toBe(true);
    expect(replacement.starts).toBe(1);
    expect(original.starts).toBe(2);
    await manager.stopAllComponents();
    await logger.close();
  });
});
