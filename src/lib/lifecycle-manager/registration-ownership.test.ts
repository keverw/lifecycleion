import { describe, expect, test } from 'bun:test';
import {
  claimReports,
  coreOf,
  deferred,
  fakeSignals,
  Plain,
  setup,
} from './test-helpers';
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

test('individual start refuses dependencies read before the same instance was re-registered', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const dependency = new Plain(logger, 'b');
  await manager.registerComponent(component);
  await manager.registerComponent(dependency);

  let startCalls = 0;
  component.start = (): Promise<void> => {
    startCalls++;
    return Promise.resolve();
  };
  let didReRegister = false;
  let removal: ReturnType<typeof manager.unregisterComponent> | undefined;
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  Object.defineProperty(component, 'startupTimeoutMS', {
    get(): number {
      if (!didReRegister) {
        didReRegister = true;
        component.dependencies.push('b');
        removal = manager.unregisterComponent('a');
        registration = manager.registerComponent(component);
      }
      return 1000;
    },
  });

  const staleStart = await manager.startComponent('a');
  expect((await removal)?.success).toBe(true);
  expect((await registration)?.registered).toBe(true);
  expect(staleStart.code).toBe('component_not_found');
  expect(startCalls).toBe(0);
  expect(manager.getRunningComponentNames()).toEqual([]);

  // The new registration must enforce the dependency the rejected start missed.
  expect((await manager.startComponent('a')).code).toBe(
    'dependency_not_running',
  );
  expect((await manager.startComponent('b')).success).toBe(true);
  expect((await manager.startComponent('a')).success).toBe(true);
  expect(startCalls).toBe(1);
  await manager.stopAllComponents();
});

test('individual start does not reuse optionality from an earlier dependency registration', async () => {
  const { logger, manager } = setup();
  const dependency = new Plain(logger, 'b');
  const component = new Plain(logger, 'a', ['b']);
  await manager.registerComponent(dependency);
  await manager.registerComponent(component);

  let startCalls = 0;
  component.start = (): Promise<void> => {
    startCalls++;
    return Promise.resolve();
  };
  let didReRegister = false;
  let removal: ReturnType<typeof manager.unregisterComponent> | undefined;
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  dependency.isOptional = (): boolean => {
    if (!didReRegister) {
      didReRegister = true;
      removal = manager.unregisterComponent('b');
      dependency.isOptional = () => false;
      registration = manager.registerComponent(dependency);
    }
    return true;
  };

  const staleStart = await manager.startComponent('a');
  expect((await removal)?.success).toBe(true);
  expect((await registration)?.registered).toBe(true);
  expect(staleStart.code).toBe('dependency_not_running');
  expect(startCalls).toBe(0);

  expect((await manager.startComponent('b')).success).toBe(true);
  expect((await manager.startComponent('a')).success).toBe(true);
  expect(startCalls).toBe(1);
  await manager.stopAllComponents();
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

test('nested registration reports only committed names when its outer hook rolls back', async () => {
  const { logger, manager } = setup();
  const { release } = claimReports();
  const outer = new Plain(logger, 'outer');
  const nested = new Plain(logger, 'nested');
  let result: ReturnType<typeof manager.registerComponent> | undefined;
  const orders: string[][] = [];
  manager.on('component:registered', (event) => {
    orders.push((event as { startupOrder: string[] }).startupOrder);
  });
  outer._markRegistered = (): void => {
    result = manager.registerComponent(nested);
    throw new Error('outer failed');
  };
  try {
    await manager.registerComponent(outer);
    expect((await result)?.startupOrder).toEqual(['nested']);
    expect((await result)?.registrationIndexAfter).toBe(0);
    expect(orders).toEqual([['nested']]);
    expect(manager.getComponentNames()).toEqual(['nested']);
  } finally {
    release();
  }
});

test('insertion targets must be committed even within registration hooks', async () => {
  const { logger, manager } = setup();
  const outer = new Plain(logger, 'outer');
  let result: ReturnType<typeof manager.insertComponentAt> | undefined;
  outer._markRegistered = (): void => {
    result = manager.insertComponentAt(
      new Plain(logger, 'sidecar'),
      'after',
      'outer',
    );
  };
  await manager.registerComponent(outer);
  expect((await result)?.code).toBe('target_not_found');
  expect(
    (
      await manager.insertComponentAt(
        new Plain(logger, 'sidecar'),
        'after',
        'outer',
      )
    ).success,
  ).toBe(true);
  expect(manager.getComponentNames()).toEqual(['outer', 'sidecar']);
});

test('a failure during provisional map writes releases the name and instance', async () => {
  const { logger, manager } = setup();
  const { release } = claimReports();
  const component = new Plain(logger, 'a');
  // Inject a failure while publishing state after the registration hooks.
  // Partial publication must still release the reserved name and instance.
  const timestamps = (
    manager as unknown as {
      state: { componentTimestamps: Map<string, unknown> };
    }
  ).state.componentTimestamps;
  const set = timestamps.set.bind(timestamps);
  let shouldThrow = true;
  timestamps.set = (name, value): typeof timestamps => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('map write failed');
    }
    return set(name, value);
  };
  try {
    expect((await manager.registerComponent(component)).registered).toBe(false);
    expect(manager.hasComponent('a')).toBe(false);
    expect((await manager.registerComponent(component)).registered).toBe(true);
    expect(manager.hasComponent('a')).toBe(true);
  } finally {
    release();
  }
});

test('registration rolls back when its hook starts shutdown', async () => {
  const { logger, manager } = setup();
  const peer = new Plain(logger, 'peer');
  const gate = deferred();
  peer.stop = (): Promise<void> => gate.promise;
  await manager.registerComponent(peer);
  await manager.startComponent('peer');
  const component = new Plain(logger, 'a');
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  component._markRegistered = (): void => {
    shutdown = manager.stopAllComponents();
  };
  try {
    const result = await manager.registerComponent(component);
    expect(result.code).toBe('shutdown_in_progress');
    expect(result.registered).toBe(false);
    expect(manager.hasComponent('a')).toBe(false);
  } finally {
    gate.resolve();
    await shutdown;
  }
  component._markRegistered = (): void => {};
  expect((await manager.registerComponent(component)).registered).toBe(true);
});

for (const hook of ['_markRegistered', 'lifecycle'] as const) {
  test(`${hook} cannot publish a dependency into a startup it began`, async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'peer', ['a']));
    const component = new Plain(logger, 'a');
    let bulk: ReturnType<typeof manager.startAllComponents> | undefined;
    const begin = (): void => {
      bulk = manager.startAllComponents();
    };
    if (hook === '_markRegistered') {
      component._markRegistered = begin;
    } else {
      Object.defineProperty(component, 'lifecycle', { set: begin });
    }
    const result = await manager.registerComponent(component);
    await bulk;
    expect(result.code).toBe('startup_in_progress');
    expect(result.registered).toBe(false);
    expect(manager.hasComponent('a')).toBe(false);
  });
}

test('registration reports startup begun by its hook even without dependents', async () => {
  const { logger, manager } = setup();
  const peer = new Plain(logger, 'peer');
  const gate = deferred();
  peer.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(peer);
  const component = new Plain(logger, 'a');
  let bulk: ReturnType<typeof manager.startAllComponents> | undefined;
  component._markRegistered = (): void => {
    bulk = manager.startAllComponents();
  };
  try {
    const result = await manager.registerComponent(component);
    expect(result.registered).toBe(true);
    expect(result.duringStartup).toBe(true);
  } finally {
    gate.resolve();
    await bulk;
    await manager.stopAllComponents();
  }
});

test('after placement stays adjacent across an interleaved provisional entry', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.registerComponent(new Plain(logger, 'b'));
  const provisional = new Plain(logger, 'p');
  let inserted: ReturnType<typeof manager.insertComponentAt> | undefined;
  provisional._markRegistered = (): void => {
    inserted = manager.insertComponentAt(new Plain(logger, 'x'), 'after', 'a');
  };
  await manager.insertComponentAt(provisional, 'after', 'a');
  expect((await inserted)?.registered).toBe(true);
  expect(manager.getComponentNames()).toEqual(['a', 'x', 'p', 'b']);
});

test('a value fallback does not report a provisional component as found', async () => {
  const { logger, manager } = setup();
  const { release } = claimReports();
  const component = new Plain(logger, 'a');
  let result: ReturnType<typeof manager.getValue> | undefined;
  component._markRegistered = (): void => {
    result = manager.getValue('a', 'key', {
      get includeStopped(): boolean {
        throw new Error('bad option');
      },
    });
  };
  try {
    await manager.registerComponent(component);
    expect(result?.code).toBe('operation_crashed');
    expect(result?.componentFound).toBe(false);
  } finally {
    release();
  }
});

test('a provisional name is reserved but is not an insertion target', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  let duplicate: ReturnType<typeof manager.registerComponent> | undefined;
  let inserted: ReturnType<typeof manager.insertComponentAt> | undefined;
  component._markRegistered = (): void => {
    duplicate = manager.registerComponent(new Plain(logger, 'a'));
    inserted = manager.insertComponentAt(new Plain(logger, 'b'), 'after', 'a');
  };
  await manager.registerComponent(component);
  expect((await duplicate)?.code).toBe('duplicate_name');
  expect((await duplicate)?.registrationIndexBefore).toBeNull();
  expect((await inserted)?.code).toBe('target_not_found');
});

for (const shouldRegisterPeer of [true, false]) {
  test(`post-hook startup check uses the pass snapshot for a ${shouldRegisterPeer ? 'new' : 'changed'} dependent`, async () => {
    const { logger, manager } = setup();
    const peer = new Plain(logger, 'peer');
    if (!shouldRegisterPeer) {
      await manager.registerComponent(peer);
    }
    const component = new Plain(logger, 'a');
    let registered: ReturnType<typeof manager.registerComponent> | undefined;
    let bulk: ReturnType<typeof manager.startAllComponents> | undefined;
    component._markRegistered = (): void => {
      peer.getDependencies = (): string[] => ['a'];
      if (shouldRegisterPeer) {
        registered = manager.registerComponent(peer);
      }
      bulk = manager.startAllComponents();
    };
    const result = await manager.registerComponent(component);
    await Promise.all([registered, bulk]);
    expect(result.code).toBe('startup_in_progress');
    expect(result.registered).toBe(false);
    expect(manager.hasComponent('a')).toBe(false);
  });
}

test('post-hook check allows a dependency of a pending follow-up batch', async () => {
  const { logger, manager } = setup();
  const peer = new Plain(logger, 'peer');
  const gate = deferred();
  peer.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(peer);
  const component = new Plain(logger, 'a');
  let bulk: ReturnType<typeof manager.startAllComponents> | undefined;
  let dependent: ReturnType<typeof manager.registerComponent> | undefined;
  component._markRegistered = (): void => {
    bulk = manager.startAllComponents();
    dependent = manager.registerComponent(
      new Plain(logger, 'dependent', ['a']),
      { autoStart: true },
    );
  };
  try {
    const result = await manager.registerComponent(component);
    // This dependent has not joined a fixed batch yet, so its dependency can commit.
    expect(result.registered).toBe(true);
    expect((await dependent)?.autoStartDeferred).toBe(true);
  } finally {
    gate.resolve();
    await Promise.all([bulk, dependent]);
    await manager.stopAllComponents();
  }
});

test('a pending follow-up does not freeze dependency obligations before its batch', async () => {
  const { logger, manager } = setup();
  const peer = new Plain(logger, 'peer');
  const gate = deferred();
  peer.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(peer);
  const component = new Plain(logger, 'a');
  let bulk: ReturnType<typeof manager.startAllComponents> | undefined;
  let dependent: ReturnType<typeof manager.registerComponent> | undefined;
  const dependentComponent = new Plain(logger, 'dependent');
  dependentComponent._markRegistered = (): void => {
    dependentComponent.getDependencies = (): string[] => ['a'];
  };
  component._markRegistered = (): void => {
    bulk = manager.startAllComponents();
    dependent = manager.registerComponent(dependentComponent, {
      autoStart: true,
    });
  };
  try {
    const result = await manager.registerComponent(component);
    // The follow-up is deferred and has no fixed order yet. Its dependency
    // may still commit before that batch is planned.
    expect(result.registered).toBe(true);
  } finally {
    gate.resolve();
    await Promise.all([bulk, dependent]);
    await manager.stopAllComponents();
  }
});

test('registration reports nested commits and their final manual placement', async () => {
  const { logger, manager } = setup();
  const parent = new Plain(logger, 'parent');
  let nested: ReturnType<typeof manager.registerComponent> | undefined;
  const reports: {
    name: string;
    startupOrder: string[];
    manualPositionRespected: boolean;
  }[] = [];
  manager.on('component:registered', (event) => {
    reports.push(event as (typeof reports)[number]);
  });
  parent._markRegistered = (): void => {
    nested = manager.registerComponent(new Plain(logger, 'nested'));
  };
  const result = await manager.insertComponentAt(parent, 'end');
  await nested;
  expect(result.startupOrder).toEqual(['parent', 'nested']);
  expect(result.manualPositionRespected).toBe(false);
  expect(
    reports.find((event) => event.name === 'parent')?.startupOrder,
  ).toEqual(result.startupOrder);
  expect(
    reports.find((event) => event.name === 'parent')?.manualPositionRespected,
  ).toBe(false);
});

test('a refused public start override cannot add dependencies to the bulk pass', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const peer = new Plain(logger, 'peer');
  peer.start = (): Promise<void> => gate.promise;
  const component = new Plain(logger, 'x');
  await manager.registerComponent(peer);
  await manager.registerComponent(component);
  const bulk = manager.startAllComponents();
  component.getDependencies = (): string[] => ['d'];
  try {
    const refused = await manager.startComponent('x', {
      allowDuringBulkStartup: true,
    });
    expect(refused.code).toBe('missing_dependency');
    expect(
      (await manager.registerComponent(new Plain(logger, 'd'))).registered,
    ).toBe(true);
  } finally {
    gate.resolve();
    await bulk;
    await manager.stopAllComponents();
  }
});

test('a stale stalled retry keeps not-running for a component now starting', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const gate = deferred();
  component.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(component);
  const start = manager.startComponent('a');
  try {
    const result =
      await coreOf(manager).componentStop.retryStalledComponent('a');
    expect(result.code).toBe('component_not_running');
    expect(manager.getComponentStatus('a')?.state).toBe('starting');
  } finally {
    gate.resolve();
    await start;
    await manager.stopAllComponents();
  }
});

test('registration report ignores dependency reads from a peer previous registration', async () => {
  const { logger, manager } = setup();
  const peer = new Plain(logger, 'peer');
  await manager.registerComponent(peer);
  const parent = new Plain(logger, 'parent');
  let removed: ReturnType<typeof manager.unregisterComponent> | undefined;
  let inserted: ReturnType<typeof manager.insertComponentAt> | undefined;
  parent._markRegistered = (): void => {
    removed = manager.unregisterComponent('peer');
    peer.getDependencies = (): string[] => ['parent'];
    inserted = manager.insertComponentAt(peer, 'start');
  };
  const result = await manager.registerComponent(parent);
  await Promise.all([removed, inserted]);
  expect(result.startupOrder).toEqual(['parent', 'peer']);
});

test('mixed-time dependency reads cannot fail an already published registration', async () => {
  const { logger, manager } = setup();
  const x = new Plain(logger, 'x', ['y']);
  await manager.registerComponent(x);
  const parent = new Plain(logger, 'parent');
  let nested: ReturnType<typeof manager.registerComponent> | undefined;
  parent._markRegistered = (): void => {
    x.getDependencies = (): string[] => [];
    nested = manager.registerComponent(new Plain(logger, 'y', ['x']));
  };
  const { reports, release } = claimReports();
  try {
    const result = await manager.insertComponentAt(parent, 'end');
    await nested;
    expect(result.success).toBe(true);
    expect(result.registered).toBe(true);
    expect(result.startupOrder).toEqual([]);
    expect(result.manualPositionRespected).toBeUndefined();
    expect(reports).toHaveLength(0);
    expect(manager.getComponentNames()).toEqual(['x', 'parent', 'y']);
  } finally {
    release();
  }
});

test('a deferred registration and a refused explicit start do not update pass reads', async () => {
  const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
  fakeSignals(manager);
  const gate = deferred();
  const peer = new Plain(logger, 'peer');
  peer.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(peer);
  const bulk = manager.startAllComponents();
  manager.detachSignals();
  manager.attachSignals = (): never => {
    throw new Error('attach failed');
  };
  const joined = new Plain(logger, 'joined');
  try {
    const result = await manager.registerComponent(joined, { autoStart: true });
    expect(result.autoStartDeferred).toBe(true);
    // Explicit starts still exercise the pre-ownership signal-attachment refusal.
    expect(
      (await manager.startComponent('joined', { allowDuringBulkStartup: true }))
        .code,
    ).toBe('signal_attach_failed');
    const reads = (
      manager as unknown as {
        state: { activeBulkStartup: { dependencyReads: Map<Plain, unknown> } };
      }
    ).state.activeBulkStartup.dependencyReads;
    expect(reads.has(joined)).toBe(false);
  } finally {
    gate.resolve();
    await bulk;
    await manager.stopAllComponents();
  }
});

test('registration hooks have no provisional lifecycle state map entries', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const maps = (
    manager as unknown as {
      state: {
        componentStates: Map<string, unknown>;
        componentTimestamps: Map<string, unknown>;
        componentErrors: Map<string, unknown>;
        componentStartAttemptTokens: Map<string, unknown>;
      };
    }
  ).state;
  let observed: boolean[] = [];
  component._markRegistered = (): void => {
    observed = [
      maps.componentStates,
      maps.componentTimestamps,
      maps.componentErrors,
      maps.componentStartAttemptTokens,
    ].map((map) => map.has('a'));
  };
  expect((await manager.registerComponent(component)).success).toBe(true);
  expect(observed).toEqual([false, false, false, false]);
  expect(maps.componentStates.get('a')).toBe('registered');
});

test('registration recomputes committed order from validated reads', async () => {
  const { logger, manager } = setup();
  const ordering = coreOf(manager).startupOrdering;
  const order = ordering.getStartupOrderInternal.bind(ordering);
  let calls = 0;
  ordering.getStartupOrderInternal = (...args): string[] => {
    calls++;
    return order(...args);
  };
  expect(
    (await manager.registerComponent(new Plain(logger, 'a'))).startupOrder,
  ).toEqual(['a']);
  // Filtering the pre-hook order is insufficient when pending nodes constrain it.
  expect(calls).toBe(2);
});

for (const shouldReuseInstance of [true, false]) {
  test(`rollback keeps its reservation against ${shouldReuseInstance ? 'same-instance' : 'same-name'} registration`, async () => {
    const { logger, manager } = setup();
    const { release } = claimReports();
    const component = new Plain(logger, 'a');
    const mark = component._markRegistered.bind(component);
    const unmark = component._markUnregistered.bind(component);
    let nested: ReturnType<typeof manager.registerComponent> | undefined;
    component._markRegistered = (): void => {
      mark();
      throw new Error('hook failed');
    };
    component._markUnregistered = (): void => {
      unmark();
      component._markRegistered = mark;
      nested = manager.registerComponent(
        shouldReuseInstance ? component : new Plain(logger, 'a'),
      );
    };
    try {
      expect((await manager.registerComponent(component)).registered).toBe(
        false,
      );
      expect((await nested)?.code).toBe(
        shouldReuseInstance ? 'duplicate_instance' : 'duplicate_name',
      );
      expect(manager.hasComponent('a')).toBe(false);
      expect((await manager.registerComponent(component)).registered).toBe(
        true,
      );
    } finally {
      release();
    }
  });
}

test('rollback reservations do not contribute dependency reads to cleanup registrations', async () => {
  const { logger, manager } = setup();
  const { release } = claimReports();
  const component = new Plain(logger, 'a');
  let isRollingBack = false;
  let rollbackReads = 0;
  component.getDependencies = (): string[] => {
    if (isRollingBack) {
      rollbackReads++;
    }
    return [];
  };
  component._markRegistered = (): never => {
    throw new Error('registration failed');
  };
  const unmark = component._markUnregistered.bind(component);
  let nested: ReturnType<typeof manager.registerComponent> | undefined;
  component._markUnregistered = (): void => {
    unmark();
    isRollingBack = true;
    // Raw registry readers must not need a special rollback filter. Reservations
    // live separately until this hook returns; the duplicate tests above cover them.
    expect(
      Reflect.get(
        (manager as unknown as { state: object }).state,
        'componentEntries',
      ),
    ).toEqual([]);
    nested = manager.registerComponent(new Plain(logger, 'b'));
  };
  try {
    await manager.registerComponent(component);
    expect((await nested)?.registered).toBe(true);
    expect(rollbackReads).toBe(0);
    expect(manager.getComponentNames()).toEqual(['b']);
  } finally {
    release();
  }
});

test('a refused insertion does not claim its position was reordered', async () => {
  const { logger, manager } = setup();
  const result = await manager.insertComponentAt(
    new Plain(logger, 'a'),
    'after',
    'missing',
  );
  expect(result.code).toBe('target_not_found');
  expect(result.manualPositionRespected).toBeUndefined();
});

test('nested registration reports committed ordering without pending dependency edges', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'y', ['a']));
  await manager.registerComponent(new Plain(logger, 'z'));
  const outer = new Plain(logger, 'a', ['z']);
  let nested: ReturnType<typeof manager.registerComponent> | undefined;
  let eventOrder: unknown;
  manager.on('component:registered', (event) => {
    const report = event as { name: string; startupOrder: string[] };
    if (report.name === 'b') {
      eventOrder = report.startupOrder;
    }
  });
  outer._markRegistered = (): void => {
    nested = manager.registerComponent(new Plain(logger, 'b'));
  };
  await manager.insertComponentAt(outer, 'start');
  expect((await nested)?.startupOrder).toEqual(['y', 'z', 'b']);
  expect(eventOrder).toEqual(['y', 'z', 'b']);
});

test('a joined start with a newly declared missing dependency never reaches starting callbacks', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const peer = new Plain(logger, 'peer');
  peer.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(peer);
  const bulk = manager.startAllComponents();
  const joined = new Plain(logger, 'joined');
  joined._markRegistered = (): void => {
    joined.getDependencies = (): string[] => ['cache'];
  };
  let startingCalls = 0;
  manager.on('component:starting', (event) => {
    if ((event as { name: string }).name === 'joined') {
      startingCalls++;
    }
  });
  try {
    const result = await manager.registerComponent(joined, { autoStart: true });
    // The deferred registration has no start result; failure belongs to the batch.
    expect(result.autoStartDeferred).toBe(true);
    gate.resolve();
    expect((await bulk).code).toBe('required_component_failed');
    expect(startingCalls).toBe(0);
  } finally {
    gate.resolve();
    await bulk;
    await manager.stopAllComponents();
  }
});

test('getValue reads then once without starting deferred work it refuses', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  let reads = 0;
  let calls = 0;
  (component as unknown as { getValue: () => unknown }).getValue = () => ({
    get then() {
      if (++reads > 1) {
        return undefined;
      }
      return (resolve: () => void): void => {
        calls++;
        resolve();
      };
    },
  });
  await manager.registerComponent(component);
  const result = manager.getValue('a', 'key', { includeStopped: true });
  expect(result.code).toBe('error');
  await Promise.resolve();
  await Promise.resolve();
  expect(reads).toBe(1);
  expect(calls).toBe(0);
});

test('a violated committed-read invariant yields an unavailable registration report', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'peer'));
  coreOf(manager).registry.currentReadOf = (): undefined => undefined;
  const result = await manager.insertComponentAt(
    new Plain(logger, 'next'),
    'end',
  );
  expect(result.registered).toBe(true);
  expect(result.startupOrder).toEqual([]);
  expect(result.manualPositionRespected).toBeUndefined();
});

describe('LifecycleManager unregister instance ownership', () => {
  test('a replacement registered from the stopIfRunning getter keeps its state', async () => {
    const { logger, manager } = setup();
    const original = new Plain(logger, 'a');
    const replacement = new Plain(logger, 'a');
    await manager.registerComponent(original);

    const unregistered: string[] = [];
    manager.on('component:unregistered', (event: { name: string }) => {
      unregistered.push(event.name);
    });

    let didReenter = false;
    const result = await manager.unregisterComponent('a', {
      // Read after the instance is captured and before anything is removed: the only
      // place a caller can swap the registration out with no `await` to re-check it.
      get stopIfRunning(): boolean {
        if (!didReenter) {
          didReenter = true;
          void manager.unregisterComponent('a', { stopIfRunning: false });
          void manager.registerComponent(replacement);
        }

        return false;
      },
    });

    expect(didReenter).toBe(true);
    expect(result.success).toBe(false);
    expect(result.code).toBe('component_not_found');
    expect(result.wasStopped).toBe(false);
    expect(result.wasRegistered).toBe(true);
    // Exactly one removal happened, so exactly one event describes it.
    expect(unregistered).toEqual(['a']);
    expect(manager.hasComponent('a')).toBe(true);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');

    // The replacement still owns the name: its state was not wiped out from under it,
    // so a start it owns still runs and a second registration is still a duplicate.
    const duplicate = await manager.registerComponent(new Plain(logger, 'a'));
    expect(duplicate.registered).toBe(false);
    expect(duplicate.code).toBe('duplicate_name');

    const started = await manager.startComponent('a');
    expect(started.success).toBe(true);
    expect(manager.isComponentRunning('a')).toBe(true);

    await manager.stopComponent('a');
    const removed = await manager.unregisterComponent('a');
    expect(removed.success).toBe(true);
    expect(manager.hasComponent('a')).toBe(false);
  });

  test('a bulk shutdown started from the stopIfRunning getter is refused', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));

    let didReenter = false;
    const result = await manager.unregisterComponent('a', {
      get stopIfRunning(): boolean {
        if (!didReenter) {
          didReenter = true;
          void manager.stopAllComponents();
        }

        return false;
      },
    });

    expect(didReenter).toBe(true);
    expect(result.success).toBe(false);
    expect(result.code).toBe('bulk_operation_in_progress');
    expect(manager.hasComponent('a')).toBe(true);
  });
});

describe('LifecycleManager unregister acts only on its own instance', () => {
  class Crashes extends Plain {
    public crash(): boolean {
      return this.reportUnexpectedStop();
    }
  }

  test('a replacement starting from the stopIfRunning getter is not answered for', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    const replacement = new Plain(logger, 'a');
    const gate = deferred();
    replacement.start = (): Promise<void> => gate.promise;

    let replacementStart: Promise<unknown> | undefined;
    const result = await manager.unregisterComponent('a', {
      get stopIfRunning(): boolean {
        if (replacementStart === undefined) {
          void manager.unregisterComponent('a', { stopIfRunning: false });
          void manager.registerComponent(replacement);
          replacementStart = manager.startComponent('a');
        }

        return true;
      },
    });

    expect(manager.getComponentStatus('a')?.state).toBe('starting');
    // The refusal is about this call's instance, not the replacement's start.
    expect(result).toMatchObject({
      success: false,
      code: 'component_not_found',
      wasStopped: false,
      wasRegistered: true,
    });

    gate.resolve();
    expect(await replacementStart).toMatchObject({ success: true });
    expect(manager.isComponentRunning('a')).toBe(true);
  });

  test('a replacement registered from the forceStop getter is not stopped', async () => {
    const { logger, manager } = setup();
    const original = new Crashes(logger, 'a');
    await manager.registerComponent(original);
    await manager.startComponent('a');
    const replacement = new Plain(logger, 'a');
    const gate = deferred();
    replacement.start = (): Promise<void> => gate.promise;
    let replacementStops = 0;
    replacement.stop = (): Promise<void> => {
      replacementStops++;
      return Promise.resolve();
    };

    let replacementStart: Promise<unknown> | undefined;
    const result = await manager.unregisterComponent('a', {
      get forceStop(): boolean {
        if (replacementStart === undefined) {
          // Read with `stopIfRunning`, before the replacement check: take the
          // original down, swap the registration, and start the replacement.
          original.crash();
          void manager.unregisterComponent('a', { stopIfRunning: false });
          void manager.registerComponent(replacement);
          replacementStart = manager.startComponent('a');
        }

        return false;
      },
    });

    expect(result).toMatchObject({
      success: false,
      code: 'component_not_found',
      wasStopped: false,
      wasRegistered: true,
    });

    gate.resolve();
    expect(await replacementStart).toMatchObject({ success: true });
    expect(replacementStops).toBe(0);
    expect(manager.isComponentRunning('a')).toBe(true);
  });
});
