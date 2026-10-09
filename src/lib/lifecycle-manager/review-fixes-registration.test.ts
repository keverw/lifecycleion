import { describe, expect, test } from 'bun:test';
import { LifecycleManager } from './lifecycle-manager';
import { Plain, deferred, setup } from './test-helpers';
import type {
  ComponentOperationResult,
  ShutdownResult,
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
