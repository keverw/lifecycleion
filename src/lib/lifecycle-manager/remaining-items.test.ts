import { describe, expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, Plain, setup } from './test-helpers';

describe('Refusals handed out before a bulk operation settles', () => {
  // A component's invalid option is answered inline, then its error is logged and
  // announced while the bulk operation is still running. Held by caller code and rethrown
  // from a later component's getter, it is that getter's crash - reported, answered
  // `operation_crashed` - not this manager's option refusal.
  class Optional extends BaseComponent {
    constructor(logger: Logger, name: string) {
      super(logger, { name, optional: true });
    }

    public start(): Promise<void> {
      return Promise.resolve();
    }

    public stop(): Promise<void> {
      return Promise.resolve();
    }
  }

  test('a start refusal rethrown by a later component start is a crash', async () => {
    const { manager, logger } = setup();
    let held: Error | undefined;
    manager.on('component:start-failed-optional', (data: { error: Error }) => {
      held ??= data.error;
    });

    const refuses = new Optional(logger, 'refuses');
    Object.defineProperty(refuses, 'ownsLateStartCleanup', { value: 'yes' });
    const rethrows = new Optional(logger, 'rethrows');
    Object.defineProperty(rethrows, 'startupTimeoutMS', {
      get: () => {
        if (held !== undefined) {
          throw held;
        }
        return 1000;
      },
    });
    await manager.registerComponent(refuses);
    await manager.registerComponent(rethrows);

    const { reports, release } = claimReports();
    try {
      const result = await manager.startAllComponents();

      expect(held).toBeInstanceOf(TypeError);
      expect(result.failedOptionalComponents.map(({ name }) => name)).toEqual([
        'refuses',
        'rethrows',
      ]);
      expect(reports.some((report) => (report as Error).cause === held)).toBe(
        true,
      );
    } finally {
      release();
    }
  });

  test('a stop refusal rethrown by a later rollback stop is a crash', async () => {
    let held: Error | undefined;
    const logger = new Logger({
      sinks: [
        {
          write: (entry): void => {
            if (
              entry.template.startsWith(
                'Failed to stop component during rollback',
              )
            ) {
              held ??= entry.params?.error as Error | undefined;
            }
          },
        },
      ],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });

    // Rolled back in reverse: `refuses` first, then `rethrows`.
    const rethrows = new Plain(logger, 'rethrows');
    Object.defineProperty(rethrows, 'shutdownGracefulTimeoutMS', {
      get: () => {
        if (held !== undefined) {
          throw held;
        }
        return 1000;
      },
    });
    const refuses = new Plain(logger, 'refuses');
    class FailsToStart extends Plain {
      public override start(): Promise<void> {
        Object.defineProperty(refuses, 'shutdownGracefulTimeoutMS', {
          value: Number.NaN,
        });
        return Promise.reject(new Error('start failed'));
      }
    }
    await manager.registerComponent(rethrows);
    await manager.registerComponent(refuses);
    await manager.registerComponent(new FailsToStart(logger, 'fails'));

    const { reports, release } = claimReports();
    try {
      const result = await manager.startAllComponents();

      expect(result.code).toBe('required_component_failed');
      expect(held).toBeInstanceOf(TypeError);
      expect(reports.some((report) => (report as Error).cause === held)).toBe(
        true,
      );
    } finally {
      release();
    }
  });
});
