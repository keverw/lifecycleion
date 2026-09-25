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

for (const isOptional of [false, true]) {
  test(`bulk startup excludes a provisional ${isOptional ? 'optional' : 'required'} component`, async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'peer'));
    const component = new Plain(logger, 'a');
    component.isOptional = (): boolean => isOptional;
    let startCalls = 0;
    component.start = (): Promise<void> => {
      startCalls++;
      return Promise.resolve();
    };
    let bulk: ReturnType<typeof manager.startAllComponents> | undefined;
    const mark = component._markRegistered.bind(component);
    component._markRegistered = (): void => {
      mark();
      bulk = manager.startAllComponents();
    };
    expect((await manager.registerComponent(component)).registered).toBe(true);
    expect((await bulk)?.success).toBe(true);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
    expect(startCalls).toBe(0);
    expect((await manager.startComponent('a')).success).toBe(true);
    await manager.stopAllComponents();
  });
}

test('registration hooks cannot unregister or re-register their reserved instance', async () => {
  const { logger, manager } = setup();
  const { release } = claimReports();
  const component = new Plain(logger, 'a');
  let unregister: ReturnType<typeof manager.unregisterComponent> | undefined;
  let register: ReturnType<typeof manager.registerComponent> | undefined;
  let nestedStart: ReturnType<typeof manager.startComponent> | undefined;
  let didReenter = false;
  let starts = 0;
  component.start = (): Promise<void> => {
    starts++;
    return Promise.resolve();
  };
  component._markRegistered = (): void => {
    if (didReenter) {
      return;
    }
    didReenter = true;
    unregister = manager.unregisterComponent('a');
    register = manager.registerComponent(component);
    nestedStart = manager.startComponent('a');
    throw new Error('outer registration failed');
  };
  const events: string[] = [];
  manager.on('component:unregistered', () => {
    events.push('unregistered');
  });
  try {
    expect((await manager.registerComponent(component)).registered).toBe(false);
    expect((await unregister)?.code).toBe('component_not_found');
    expect((await register)?.code).toBe('duplicate_instance');
    expect((await nestedStart)?.code).toBe('component_not_found');
    expect(starts).toBe(0);
    expect(events).toEqual([]);
    expect((await manager.stopAllComponents()).success).toBe(true);
  } finally {
    release();
  }
});

test('provisional registration is invisible to lookup, health and unregister', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const observations: unknown[] = [];
  let health: ReturnType<typeof manager.checkComponentHealth> | undefined;
  let unregister: ReturnType<typeof manager.unregisterComponent> | undefined;
  component._markRegistered = (): void => {
    observations.push(
      manager.getComponentStatus('a'),
      manager.getComponentInstance('a'),
      manager.getComponentNames(),
    );
    health = manager.checkComponentHealth('a');
    unregister = manager.unregisterComponent('a');
  };
  expect((await manager.registerComponent(component)).registered).toBe(true);
  expect(observations).toEqual([undefined, undefined, []]);
  expect((await health)?.code).toBe('not_found');
  expect((await unregister)?.code).toBe('component_not_found');
  expect(manager.hasComponent('a')).toBe(true);
});

test('nested registration preserves reserved entries and detects cycles through them', async () => {
  const { logger, manager } = setup();
  const outer = new Plain(logger, 'outer', ['cycle']);
  const nested = new Plain(logger, 'nested');
  const cycle = new Plain(logger, 'cycle', ['outer']);
  let nestedResult: ReturnType<typeof manager.registerComponent> | undefined;
  let cycleResult: ReturnType<typeof manager.registerComponent> | undefined;
  let names: string[] = [];
  outer._markRegistered = (): void => {
    nestedResult = manager.registerComponent(nested);
    cycleResult = manager.registerComponent(cycle);
    names = manager.getComponentNames();
  };
  expect((await manager.registerComponent(outer)).registered).toBe(true);
  expect((await nestedResult)?.registered).toBe(true);
  expect((await cycleResult)?.code).toBe('dependency_cycle');
  expect(names).toEqual(['nested']);
  expect(manager.getComponentNames()).toEqual(['outer', 'nested']);
});
