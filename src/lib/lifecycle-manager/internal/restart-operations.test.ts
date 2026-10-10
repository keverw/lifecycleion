import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import { LifecycleManager } from '../lifecycle-manager';
import { Plain } from '../test-helpers';
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

test('restartAllComponents() answers a startup override that returns undefined as a failed startup', async () => {
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
  expect(result.startupResult.success).toBe(false);
  expect(result.startupResult.code).toBeUndefined();
});
