import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import { LifecycleManager } from '../lifecycle-manager';
import { deferred, Plain } from '../test-helpers';
import type {
  ComponentOperationResult,
  StartComponentOptions,
  StartupOptions,
  StartupResult,
  StopComponentOptions,
} from '../types';

const logger = new Logger({ sinks: [], callProcessExit: false });

// An override that answers with something other than a result is caller data, not a
// crash: the restart answers it as a phase that failed without saying why.
test('restartComponent() answers a stop override that returns undefined as a failed stop', async () => {
  class UndefinedStop extends LifecycleManager {
    public override stopComponent(
      _name: string,
      _options?: StopComponentOptions,
    ): Promise<ComponentOperationResult> {
      return Promise.resolve(undefined as unknown as ComponentOperationResult);
    }
  }
  const manager = new UndefinedStop({ logger, shutdownWarningTimeoutMS: -1 });
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.startComponent('a');

  const result = await manager.restartComponent('a');

  expect(result.success).toBe(false);
  expect(result.code).toBe('restart_stop_failed');
  expect(result.reason).toBe('Failed to stop: no reason given');
  await manager.stopAllComponents();
});

test('restartComponent() answers a start override that returns undefined as a failed start', async () => {
  class UndefinedStart extends LifecycleManager {
    public isArmed = false;

    public override async startComponent(
      name: string,
      options?: StartComponentOptions,
    ): Promise<ComponentOperationResult> {
      if (!this.isArmed) {
        return await super.startComponent(name, options);
      }
      return undefined as unknown as ComponentOperationResult;
    }
  }
  const manager = new UndefinedStart({ logger, shutdownWarningTimeoutMS: -1 });
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.startComponent('a');
  manager.isArmed = true;

  const result = await manager.restartComponent('a');

  expect(result.success).toBe(false);
  expect(result.code).toBe('restart_start_failed');
  expect(result.reason).toBe('Failed to start: no reason given');
});

test('restartAllComponents() answers a startup override that returns undefined as a crashed startup', async () => {
  class UndefinedStartup extends LifecycleManager {
    public isArmed = false;

    public override async startAllComponents(
      options?: StartupOptions,
    ): Promise<StartupResult> {
      if (!this.isArmed) {
        return await super.startAllComponents(options);
      }
      return undefined as unknown as StartupResult;
    }
  }
  const manager = new UndefinedStartup({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.startAllComponents();
  manager.isArmed = true;

  const result = await manager.restartAllComponents();

  expect(result.success).toBe(false);
  expect(result.shutdownResult.success).toBe(true);
  expect(result.startupResult).toMatchObject({
    success: false,
    code: 'operation_crashed',
    reason:
      'Startup phase answered no result: startAllComponents() did not return a result object',
  });
  expect(result.startupResult.error).toBeInstanceOf(TypeError);
  expect(result.startupResult.error?.message).toBe(
    'startAllComponents() answered undefined, not a result object',
  );
});

test('restartComponent() answers a stop refusal it passes through from its snapshot, not the override object', async () => {
  const gate = deferred();
  let isArmed = false;
  let reasonReads = 0;
  let answered: ComponentOperationResult | undefined;
  class GatedManager extends LifecycleManager {
    public override async stopComponent(
      name: string,
      options?: StopComponentOptions,
    ): Promise<ComponentOperationResult> {
      if (isArmed) {
        isArmed = false;
        await gate.promise;
      }
      const result = await super.stopComponent(name, options);
      answered = new Proxy(result, {
        get: (target, key, receiver): unknown => {
          if (key === 'reason') {
            reasonReads++;
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      return answered;
    }
  }
  const manager = new GatedManager({ logger, shutdownWarningTimeoutMS: -1 });
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.startComponent('a');
  isArmed = true;

  // Asked to stay down before its stop took the component: the stop refuses before
  // claiming it, and that refusal is passed through.
  const restart = manager.restartComponent('a');
  await manager.stopAllComponents();
  gate.resolve();
  const result = await restart;

  expect(result).not.toBe(answered);
  expect(result.code).toBe('shutdown_requested_during_restart');
  expect(reasonReads).toBe(1);
});
