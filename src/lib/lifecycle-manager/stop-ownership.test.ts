import { describe, expect, test } from 'bun:test';
import { claimReports, deferred, Plain, setup, Stalls } from './test-helpers';
import type { ComponentOperationResult, StopComponentOptions } from './types';

class Reporter extends Plain {
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

describe('LifecycleManager stop ownership after caller property reads', () => {
  for (const property of ['shutdownGracefulTimeoutMS', 'timeout'] as const) {
    test(`a re-entrant ${property} getter cannot make two stops own the component`, async () => {
      const { logger, manager } = setup();
      const component = new Plain(logger, 'a');
      const gate = deferred();
      let stopCalls = 0;
      component.stop = (): Promise<void> => {
        stopCalls++;
        return gate.promise;
      };
      await manager.registerComponent(component);
      await manager.startComponent('a');
      const options: StopComponentOptions = {};
      let nested: Promise<ComponentOperationResult> | undefined;
      let didReenter = false;
      Object.defineProperty(
        property === 'timeout' ? options : component,
        property,
        {
          configurable: true,
          get: () => {
            if (!didReenter) {
              didReenter = true;
              nested = manager.stopComponent('a');
            }
            return 0;
          },
        },
      );
      const outer = manager.stopComponent('a', options);
      try {
        // The nested stop owns the pending hook. Refusing the outer attempt must
        // neither invoke stop twice nor escalate the other attempt into force.
        expect(stopCalls).toBe(1);
        expect((await outer).code).toBe('component_already_stopping');
        expect(component.forceCalls).toBe(0);
        expect(manager.getComponentStatus('a')?.state).toBe('stopping');
      } finally {
        gate.resolve();
        await Promise.all([outer, nested]);
      }
      expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    });
  }

  test('clearing the unexpected-stop handler cannot re-enter ahead of the claim', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const gate = deferred();
    let stopCalls = 0;
    component.stop = (): Promise<void> => {
      stopCalls++;
      return gate.promise;
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const clear = component._clearUnexpectedStopHandler.bind(component);
    let nested: Promise<ComponentOperationResult> | undefined;
    let didReenter = false;
    component._clearUnexpectedStopHandler = (): void => {
      if (!didReenter) {
        didReenter = true;
        nested = manager.stopComponent('a');
      }
      clear();
    };
    const outer = manager.stopComponent('a');
    try {
      expect(stopCalls).toBe(1);
      expect((await nested)?.code).toBe('component_already_stopping');
      expect(component.forceCalls).toBe(0);
    } finally {
      gate.resolve();
      await outer;
    }
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('a timeout getter that unregisters and replaces its stopped component cannot stop the replacement', async () => {
    const { logger, manager } = setup();
    const original = new Reporter(logger, 'a');
    const replacement = new Plain(logger, 'a');
    let stopCalls = 0;
    original.stop = (): Promise<void> => {
      stopCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(original);
    await manager.startComponent('a');
    let unregister: ReturnType<typeof manager.unregisterComponent> | undefined;
    let register: ReturnType<typeof manager.registerComponent> | undefined;
    Object.defineProperty(original, 'shutdownGracefulTimeoutMS', {
      get: () => {
        original.reportStop();
        unregister = manager.unregisterComponent('a');
        register = manager.registerComponent(replacement);
        return 0;
      },
    });
    const result = await manager.stopComponent('a');
    await Promise.all([unregister, register]);
    expect(result.code).toBe('component_not_found');
    expect(stopCalls).toBe(0);
    expect(original.forceCalls).toBe(0);
    expect(manager.getComponentInstance('a')).toBe(replacement);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });
});

describe('LifecycleManager force ownership after caller property reads', () => {
  for (const property of [
    'onShutdownForce',
    'shutdownForceTimeoutMS',
    'forceImmediate',
    '_clearUnexpectedStopHandler',
  ] as const) {
    test(`re-entry through ${property} cannot run concurrent force handlers`, async () => {
      const { logger, manager } = setup();
      const component = new Plain(logger, 'a');
      const gate = deferred();
      let calls = 0;
      const force = (): Promise<void> => {
        calls++;
        return gate.promise;
      };
      Object.defineProperty(component, 'onShutdownForce', {
        value: force,
        configurable: true,
      });
      await manager.registerComponent(component);
      await manager.startComponent('a');
      let nested: Promise<ComponentOperationResult> | undefined;
      let didEnter = false;
      const reenter = (): void => {
        if (!didEnter) {
          didEnter = true;
          nested = manager.stopComponent('a', { forceImmediate: true });
        }
      };
      const options: StopComponentOptions = { forceImmediate: true };
      if (property === '_clearUnexpectedStopHandler') {
        const clear = component._clearUnexpectedStopHandler.bind(component);
        component._clearUnexpectedStopHandler = (): void => {
          reenter();
          clear();
        };
      } else {
        Object.defineProperty(
          property === 'forceImmediate' ? options : component,
          property,
          {
            get: () => {
              reenter();
              if (property === 'onShutdownForce') {
                return force;
              }
              if (property === 'forceImmediate') {
                return true;
              }
              return 0;
            },
          },
        );
      }
      const outer = manager.stopComponent('a', options);
      try {
        expect(calls).toBe(1);
        // Property getters run before ownership; clearing runs after ownership.
        // Whichever attempt claimed first must be the only force handler running.
        const refused =
          property === '_clearUnexpectedStopHandler' ? nested : outer;
        expect((await refused)?.code).toBe('component_already_stopping');
        expect(manager.getComponentStatus('a')?.state).toBe('force-stopping');
      } finally {
        gate.resolve();
        await Promise.all([outer, nested]);
      }
      expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    });
  }

  test('a force getter cannot stop an unregistered replacement', async () => {
    const { logger, manager } = setup();
    const original = new Reporter(logger, 'a');
    const replacement = new Plain(logger, 'a');
    await manager.registerComponent(original);
    await manager.startComponent('a');
    let unregister: ReturnType<typeof manager.unregisterComponent> | undefined;
    let register: ReturnType<typeof manager.registerComponent> | undefined;
    Object.defineProperty(original, 'shutdownForceTimeoutMS', {
      get: () => {
        original.reportStop();
        unregister = manager.unregisterComponent('a');
        register = manager.registerComponent(replacement);
        return 0;
      },
    });
    const result = await manager.stopComponent('a', { forceImmediate: true });
    await Promise.all([unregister, register]);
    expect(result.code).toBe('component_not_found');
    expect(original.forceCalls).toBe(0);
    expect(manager.getComponentInstance('a')).toBe(replacement);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });
});

test('a stalled retry getter cannot claim an unregistered replacement', async () => {
  const { logger, manager } = setup();
  const original = new Stalls(logger, 'a');
  const replacement = new Plain(logger, 'a');
  const { release } = claimReports();
  try {
    await manager.registerComponent(original);
    await manager.startComponent('a');
    await manager.stopComponent('a');
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
    const calls = original.forceCalls;
    let unregister: ReturnType<typeof manager.unregisterComponent> | undefined;
    let register: ReturnType<typeof manager.registerComponent> | undefined;
    Object.defineProperty(original, 'shutdownForceTimeoutMS', {
      get: () => {
        unregister = manager.unregisterComponent('a', { stopIfRunning: false });
        register = manager.registerComponent(replacement);
        return 0;
      },
    });
    // Exercise the per-component retry independently of the bulk registration
    // gate, so a property getter can replace the instance before the force claim.
    const result = await (
      manager as unknown as {
        retryStalledComponent: (
          name: string,
        ) => Promise<ComponentOperationResult>;
      }
    ).retryStalledComponent('a');
    expect(result.code).toBe('component_not_found');
    await Promise.all([unregister, register]);
    expect(original.forceCalls).toBe(calls);
    expect(manager.getComponentInstance('a')).toBe(replacement);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  } finally {
    release();
  }
});

describe('individual stop dependency safety after preflight', () => {
  for (const isForceImmediate of [false, true]) {
    for (const allowStopWithRunningDependents of [false, true]) {
      test(`force=${isForceImmediate}, override=${allowStopWithRunningDependents}: force getter starts a dependent`, async () => {
        const { logger, manager } = setup();
        const database = new Plain(logger, 'database');
        const worker = new Plain(logger, 'worker', ['database']);
        const gate = deferred();
        worker.start = () => gate.promise;
        let stopCalls = 0;
        database.stop = () => {
          stopCalls++;
          return Promise.resolve();
        };
        await manager.registerComponent(database);
        await manager.registerComponent(worker);
        await manager.startComponent('database');
        let starting: Promise<ComponentOperationResult> | undefined;
        Object.defineProperty(database, 'onShutdownForce', {
          configurable: true,
          get: () => {
            starting ??= manager.startComponent('worker');
            return () => {
              stopCalls++;
              return Promise.resolve();
            };
          },
        });
        try {
          const result = await manager.stopComponent('database', {
            forceImmediate: isForceImmediate,
            allowStopWithRunningDependents,
          });
          // The dependent has acquired its start claim but is not in the running
          // set yet. The stop must protect it before either shutdown hook runs.
          expect(manager.getComponentStatus('worker')?.state).toBe('starting');
          expect(result.success).toBe(allowStopWithRunningDependents);
          if (!allowStopWithRunningDependents) {
            expect(result.code).toBe('has_running_dependents');
            expect(manager.getComponentStatus('database')?.state).toBe(
              'running',
            );
          }
          expect(stopCalls).toBe(allowStopWithRunningDependents ? 1 : 0);
        } finally {
          gate.resolve();
          await starting;
          await manager.stopAllComponents();
        }
      });
    }
  }
});

for (const isForceImmediate of [false, true]) {
  test(`force=${isForceImmediate}: dependency read registers an in-flight dependent before the stop claim`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const trigger = new Plain(logger, 'trigger');
    const worker = new Plain(logger, 'worker', ['database']);
    const gate = deferred();
    worker.start = () => gate.promise;
    let stopCalls = 0;
    database.stop = () => {
      stopCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(database);
    await manager.registerComponent(trigger);
    await manager.startComponent('database');
    // Only active components' dependency getters participate in stop checks.
    await manager.startComponent('trigger');
    let isArmed = false;
    let registration: ReturnType<typeof manager.registerComponent> | undefined;
    Object.defineProperty(database, 'onShutdownForce', {
      get: () => {
        isArmed = true;
        return () => {
          stopCalls++;
        };
      },
    });
    trigger.getDependencies = () => {
      if (isArmed && registration === undefined) {
        // Only mutate the registry during the final dependency check, after
        // force preparation. Disarm before registration reads this getter again.
        isArmed = false;
        registration = manager.registerComponent(worker, { autoStart: true });
      }
      return [];
    };
    try {
      const result = await manager.stopComponent('database', {
        forceImmediate: isForceImmediate,
      });
      expect(registration).toBeDefined();
      expect(manager.getComponentStatus('worker')?.state).toBe('starting');
      expect(result.code).toBe('has_running_dependents');
      expect(result.success).toBe(false);
      expect(manager.getComponentStatus('database')?.state).toBe('running');
      expect(stopCalls).toBe(0);
    } finally {
      gate.resolve();
      await registration;
      await manager.stopAllComponents();
    }
  });
}
