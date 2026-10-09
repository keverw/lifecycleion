import { describe, expect, test } from 'bun:test';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, hasReport, Plain, setup } from './test-helpers';
import type {
  HealthCheckResult,
  StartupOptions,
  StartupResult,
  SystemState,
} from './types';

const logger = new Logger({ sinks: [], callProcessExit: false });

describe('checkAllHealth() through an overridden checkComponentHealth()', () => {
  for (const mode of ['throws', 'rejects'] as const) {
    test(`an override that ${mode} for one component answers only that entry`, async () => {
      class Failing extends LifecycleManager {
        public override checkComponentHealth(
          name: string,
        ): Promise<HealthCheckResult> {
          if (name === 'bad') {
            if (mode === 'throws') {
              throw new Error('override failed');
            }
            return Promise.reject(new Error('override failed'));
          }
          return super.checkComponentHealth(name);
        }
      }
      const manager = new Failing({ logger, shutdownWarningTimeoutMS: -1 });
      await manager.registerComponent(new Plain(logger, 'good'));
      await manager.registerComponent(new Plain(logger, 'bad'));
      await manager.startAllComponents();

      const { reports, release } = claimReports();
      try {
        const report = await manager.checkAllHealth();
        expect(report.code).toBe('error');
        expect(report.error).toBeUndefined();
        expect(report.components.map(({ name, code }) => [name, code])).toEqual(
          [
            ['good', 'no_handler'],
            ['bad', 'operation_crashed'],
          ],
        );
        expect(report.components[1].error?.message).toBe('override failed');
        expect(reports.length).toBe(1);
        expect(hasReport(reports, 'lifecycle-manager checkAllHealth')).toBe(
          true,
        );
      } finally {
        release();
        await manager.stopAllComponents();
      }
    });
  }

  test('an override entry with an undefined error does not turn the report to error', async () => {
    class Undefined extends LifecycleManager {
      public override async checkComponentHealth(
        name: string,
      ): Promise<HealthCheckResult> {
        const result = await super.checkComponentHealth(name);
        return { ...result, error: undefined } as unknown as HealthCheckResult;
      }
    }
    const manager = new Undefined({ logger, shutdownWarningTimeoutMS: -1 });
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    try {
      const report = await manager.checkAllHealth();
      expect(report.code).toBe('ok');
      expect(report.healthy).toBe(true);
    } finally {
      await manager.stopAllComponents();
    }
  });
});

describe('status getters read the manager state, not other overridable getters', () => {
  test('stopped and start-timed-out names ignore an overridden getComponentNames()', async () => {
    class NoNames extends LifecycleManager {
      public override getComponentNames(): string[] {
        return [];
      }
    }
    const manager = new NoNames({ logger, shutdownWarningTimeoutMS: -1 });
    await manager.registerComponent(new Plain(logger, 'a'));

    expect(manager.getStoppedComponentNames()).toEqual(['a']);
    expect(manager.getStoppedComponentCount()).toBe(1);
    expect(manager.getStatus().components.stopped).toEqual(['a']);
  });

  test('getSystemState() and getStatus() ignore overridden counts, and getStatus() an overridden getSystemState()', async () => {
    // Armed only once started: startup's own preflight asks the public counts.
    let isLying = false;
    class Lying extends LifecycleManager {
      public override getComponentCount(): number {
        return isLying ? 0 : super.getComponentCount();
      }
      public override getRunningComponentCount(): number {
        return isLying ? 0 : super.getRunningComponentCount();
      }
      public override getSystemState(): SystemState {
        return isLying ? 'stalled' : super.getSystemState();
      }
    }
    const manager = new Lying({ logger, shutdownWarningTimeoutMS: -1 });
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    isLying = true;
    try {
      expect(LifecycleManager.prototype.getSystemState.call(manager)).toBe(
        'running',
      );
      expect(manager.getStatus().systemState).toBe('running');
    } finally {
      isLying = false;
      await manager.stopAllComponents();
    }
  });
});

describe('an overridden emit() that throws', () => {
  test('is reported on the global error channel and does not break the operation', async () => {
    class ThrowingEmit extends LifecycleManager {
      protected override emit<T = unknown>(event: string, data?: T): void {
        if (event === 'component:registered') {
          throw new Error('emit failed');
        }
        super.emit(event, data);
      }
    }
    const manager = new ThrowingEmit({ logger, shutdownWarningTimeoutMS: -1 });
    const { reports, release } = claimReports();
    try {
      const result = await manager.registerComponent(new Plain(logger, 'a'));
      expect(result.success).toBe(true);
      expect(reports.length).toBe(1);
      expect(
        hasReport(reports, 'lifecycle-manager emit for component:registered'),
      ).toBe(true);
      expect(((reports[0] as Error).cause as Error).message).toBe(
        'emit failed',
      );
    } finally {
      release();
    }
  });
});

describe('constructor callback options', () => {
  for (const field of [
    'onReloadRequested',
    'onInfoRequested',
    'onDebugRequested',
  ] as const) {
    test(`${field} refuses a non-function`, () => {
      expect(
        () =>
          new LifecycleManager({
            logger,
            [field]: 'not a function' as unknown as () => void,
          }),
      ).toThrow(new TypeError(`${field} must be a function`));
    });

    test(`${field} accepts null and omission as no callback`, () => {
      expect(
        () =>
          new LifecycleManager({
            logger,
            [field]: null as unknown as undefined,
          }),
      ).not.toThrow();
    });
  }

  test.each([undefined, null, 'not a function'])(
    'repeatedShutdownRequestPolicy.onForceShutdown refuses %p',
    (value) => {
      expect(
        () =>
          new LifecycleManager({
            logger,
            repeatedShutdownRequestPolicy: {
              onForceShutdown: value as unknown as () => void,
            },
          }),
      ).toThrow(
        new TypeError(
          'repeatedShutdownRequestPolicy.onForceShutdown must be a function',
        ),
      );
    },
  );

  test('options.logger is read once', () => {
    let reads = 0;
    const options = {
      get logger(): Logger {
        reads++;
        return logger;
      },
    };
    void new LifecycleManager(options);
    expect(reads).toBe(1);
  });
});

describe('unregisterComponent() after its stop', () => {
  test('a replacement registered by an isComponentRunning() override is not removed', async () => {
    const { logger: componentLogger } = setup();
    let calls = 0;
    let isArmed = false;
    let replacement: Plain | undefined;

    class ReplacingManager extends LifecycleManager {
      public override isComponentRunning(name: string): boolean {
        // The post-stop recheck is the third call: before the stop, after it in the
        // stop's answer, and once more before the removal.
        if (isArmed && ++calls === 3) {
          isArmed = false;
          void this.unregisterComponent(name);
          replacement = new Plain(componentLogger, name);
          void this.registerComponent(replacement);
          return false;
        }

        return super.isComponentRunning(name);
      }
    }

    const manager = new ReplacingManager({
      logger: componentLogger,
      shutdownWarningTimeoutMS: -1,
    });
    await manager.registerComponent(new Plain(componentLogger, 'a'));
    await manager.startComponent('a');
    isArmed = true;

    const result = await manager.unregisterComponent('a');

    expect(calls).toBe(3);
    expect(result.success).toBe(false);
    expect(result.code).toBe('component_not_found');
    expect(result.wasStopped).toBe(true);
    expect(manager.getComponentInstance('a')).toBe(replacement);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
    await componentLogger.close();
  });
});

describe('restartAllComponents() crashing after its startup phase', () => {
  test('keeps the startup result that ran', async () => {
    // The startup phase answers, then reading its result throws once: the restart's
    // bookkeeping after the phase crashes with components already started.
    class ThrowsAfterStartup extends LifecycleManager {
      public isArmed = false;

      public override async startAllComponents(
        options?: StartupOptions,
      ): Promise<StartupResult> {
        const result = await super.startAllComponents(options);
        if (!this.isArmed) {
          return result;
        }
        let hasThrown = false;
        return Object.defineProperty({ ...result }, 'success', {
          enumerable: true,
          get: () => {
            if (!hasThrown) {
              hasThrown = true;
              throw new Error('after startup');
            }
            return result.success;
          },
        });
      }
    }
    const manager = new ThrowsAfterStartup({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    manager.isArmed = true;

    const { reports, release } = claimReports();
    try {
      const result = await manager.restartAllComponents();
      expect(result.success).toBe(false);
      expect(result.shutdownResult.success).toBe(true);
      expect(result.startupResult.startedComponents).toEqual(['a']);
      expect(result.startupResult.success).toBe(true);
      expect(manager.isComponentRunning('a')).toBe(true);
      expect(hasReport(reports, 'restartAllComponents')).toBe(true);
    } finally {
      release();
      manager.isArmed = false;
      await manager.stopAllComponents();
    }
  });
});
