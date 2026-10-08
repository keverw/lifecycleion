import { describe, expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import type { ComponentValueResult } from './types';
import { claimReports, Plain, setup } from './test-helpers';

describe('Hook reads after Reflect.get is replaced', () => {
  // The manager reads every hook through the `Reflect.get` captured at load. One that
  // application code installs later must not change which hook runs, or how a
  // `getValue()` answer is read.
  test('start, stop, onMessage and getValue still resolve to the component hooks', async () => {
    const { manager, logger } = setup();
    const calls: string[] = [];
    const answered = new WeakSet<object>();

    class Tracked extends Plain {
      public override start(): Promise<void> {
        calls.push('start');
        return Promise.resolve();
      }

      public override stop(): Promise<void> {
        calls.push('stop');
        return Promise.resolve();
      }

      public onMessage<TData = unknown>(payload: unknown): TData {
        calls.push('onMessage');
        return { echoed: payload } as TData;
      }

      public getValue<T = unknown>(key: string): ComponentValueResult<T> {
        calls.push('getValue');
        const result = { found: true, value: `real ${key}` as T };
        answered.add(result);
        return result;
      }
    }

    const component = new Tracked(logger, 'tracked');
    expect((await manager.registerComponent(component)).success).toBe(true);

    const decoy = (): unknown => {
      calls.push('decoy');
      return undefined;
    };
    const originalGet = Reflect.get;
    Reflect.get = ((
      target: object,
      property: PropertyKey,
      receiver?: unknown,
    ) => {
      if (target === component && typeof property === 'string') {
        if (['start', 'stop', 'onMessage', 'getValue'].includes(property)) {
          return decoy;
        }
      }
      if (answered.has(target) && property === 'found') {
        return 'not a boolean';
      }
      if (answered.has(target) && property === 'value') {
        return 'decoy value';
      }
      return originalGet(target, property, receiver);
    }) as typeof Reflect.get;

    try {
      const startResult = await manager.startComponent('tracked');
      const messageResult = await manager.sendMessageToComponent('tracked', 1);
      const valueResult = manager.getValue('tracked', 'status');
      const stopResult = await manager.stopComponent('tracked');

      expect(startResult.success).toBe(true);
      expect(messageResult.sent).toBe(true);
      expect(messageResult.data).toEqual({ echoed: 1 });
      expect(valueResult.found).toBe(true);
      expect(valueResult.value).toBe('real status');
      expect(stopResult.success).toBe(true);
      expect(calls).toEqual(['start', 'onMessage', 'getValue', 'stop']);
    } finally {
      Reflect.get = originalGet;
    }
  });
});

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
