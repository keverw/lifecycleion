import { describe, expect, test } from 'bun:test';
import {
  claimReports,
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
    manager as unknown as { componentTimestamps: Map<string, unknown> }
  ).componentTimestamps;
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
    expect(result?.code).toBe('error');
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

test('post-hook check includes a dependent committed after bulk ordering', async () => {
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
    expect(result.code).toBe('startup_in_progress');
    expect(result.registered).toBe(false);
  } finally {
    gate.resolve();
    await Promise.all([bulk, dependent]);
    await manager.stopAllComponents();
  }
});

test('a refused joined start does not change the pass dependency snapshot', async () => {
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
    // The joined attempt fails its missing-dependency check; that refused read
    // must not become an obligation of the active pass. Registration may commit.
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
    const result = await (
      manager as unknown as {
        retryStalledComponent: (
          name: string,
        ) => Promise<ComponentOperationResult>;
      }
    ).retryStalledComponent('a');
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

test('a joined start refused during signal attachment does not update pass reads', async () => {
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
    expect(result.startResult?.code).toBe('signal_attach_failed');
    const reads = (
      manager as unknown as {
        activeBulkStartup: { dependencyReads: Map<Plain, unknown> };
      }
    ).activeBulkStartup.dependencyReads;
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
  const maps = manager as unknown as {
    componentStates: Map<string, unknown>;
    componentTimestamps: Map<string, unknown>;
    componentErrors: Map<string, unknown>;
    componentStartAttemptTokens: Map<string, unknown>;
  };
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

test('unchanged registration reuses its validated startup order', async () => {
  const { logger, manager } = setup();
  const internals = manager as unknown as {
    getStartupOrderInternal: (...args: unknown[]) => string[];
  };
  const order = internals.getStartupOrderInternal.bind(manager);
  let calls = 0;
  internals.getStartupOrderInternal = (...args): string[] => {
    calls++;
    return order(...args);
  };
  expect(
    (await manager.registerComponent(new Plain(logger, 'a'))).startupOrder,
  ).toEqual(['a']);
  expect(calls).toBe(1);
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
