import { describe, expect, test } from 'bun:test';
import { claimReports, deferred, Plain, setup } from './test-helpers';
import type { ComponentOperationResult } from './types';

describe('LifecycleManager uncommitted registration', () => {
  for (const hook of ['_markRegistered', 'lifecycle'] as const) {
    for (const shouldThrow of [true, false]) {
      test(`${hook} cannot start the provisional component before ${shouldThrow ? 'rollback' : 'commit'}`, async () => {
        const { logger, manager } = setup();
        const { release } = claimReports();
        const component = new Plain(logger, 'a');
        const gate = deferred();
        let startCalls = 0;
        let stopCalls = 0;
        component.start = (): Promise<void> => {
          startCalls++;
          return gate.promise;
        };
        component.stop = (): Promise<void> => {
          stopCalls++;
          return Promise.resolve();
        };
        let nested: Promise<ComponentOperationResult> | undefined;
        const reenter = (): void => {
          nested = manager.startComponent('a', {
            forceStalled: true,
            allowDuringBulkStartup: true,
            allowNonRunningDependencies: true,
          });
          if (shouldThrow) {
            throw new Error('registration hook failed');
          }
        };
        const mark = component._markRegistered.bind(component);
        if (hook === '_markRegistered') {
          component._markRegistered = (): void => {
            mark();
            reenter();
          };
        } else {
          Object.defineProperty(component, 'lifecycle', {
            configurable: true,
            set: reenter,
          });
        }
        try {
          const registration = await manager.registerComponent(component);
          // Check before resolving the gate: on the buggy code start() has already
          // acquired resources, and rollback erases the only cleanup bookkeeping.
          expect(startCalls).toBe(0);
          expect((await nested)?.code).toBe('component_not_found');
          expect(registration.registered).toBe(!shouldThrow);
          expect(manager.hasComponent('a')).toBe(!shouldThrow);
        } finally {
          gate.resolve();
          await nested;
          release();
        }
        const shutdown = await manager.stopAllComponents();
        expect(shutdown.success).toBe(true);
        expect(stopCalls).toBe(0);

        // The guard must be gone after either exit, so the same instance can be
        // registered again after rollback and can then start and stop normally.
        component._markRegistered = mark;
        if (hook === 'lifecycle') {
          Object.defineProperty(component, 'lifecycle', {
            configurable: true,
            writable: true,
            value: undefined,
          });
        }
        if (shouldThrow) {
          expect((await manager.registerComponent(component)).registered).toBe(
            true,
          );
        }
        expect((await manager.startComponent('a')).success).toBe(true);
        expect(startCalls).toBe(1);
        expect((await manager.stopAllComponents()).success).toBe(true);
        expect(stopCalls).toBe(1);
      });
    }
  }
});
