import { describe, test, expect } from 'bun:test';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { coreOf, deferred, Plain, setup } from './test-helpers';
import type { ComponentOperationResult } from './types';
import type { Logger } from '../logger';
import { sleep } from '../sleep';

// A component whose first `start()` waits on `first`, and every later one on `retry`.
class TwoStarts extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public readonly first = deferred();
  public readonly retry = deferred();

  constructor(logger: Logger) {
    super(logger, { name: 'c', startupTimeoutMS: 30 });
  }

  public async start(): Promise<void> {
    this.starts++;
    await (this.starts === 1 ? this.first.promise : this.retry.promise);
  }

  public stop(): Promise<void> {
    this.stops++;
    return Promise.resolve();
  }
}

describe('late start deferring to a retry of the same registration', () => {
  test('is cleaned up once a retry still in flight fails', async () => {
    const { logger, manager } = setup();
    const c = new TwoStarts(logger);
    await manager.registerComponent(c);
    try {
      expect((await manager.startComponent('c')).code).toBe(
        'component_startup_timeout',
      );
      const retry = manager.startComponent('c');
      c.first.resolve();
      await sleep(5);
      expect(c.stops).toBe(0);
      c.retry.reject(new Error('EADDRINUSE'));
      expect((await retry).success).toBe(false);
      await sleep(10);
      expect(c.stops).toBe(1);
      expect(manager.isComponentRunning('c')).toBe(false);
      expect(manager.getComponentStatus('c')?.state).toBe('registered');
    } finally {
      c.first.resolve();
      c.retry.resolve();
      await manager.stopAllComponents();
      await logger.close();
    }
  });

  test('is cleaned up once a retry that timed out too has its start() reject', async () => {
    const { logger, manager } = setup();
    const c = new TwoStarts(logger);
    await manager.registerComponent(c);
    try {
      expect((await manager.startComponent('c')).code).toBe(
        'component_startup_timeout',
      );
      expect((await manager.startComponent('c')).code).toBe(
        'component_startup_timeout',
      );
      c.first.resolve();
      await sleep(5);
      expect(c.stops).toBe(0);
      c.retry.reject(new Error('EADDRINUSE'));
      await sleep(10);
      expect(c.stops).toBe(1);
      expect(manager.isComponentRunning('c')).toBe(false);
      expect(manager.getComponentStatus('c')?.state).toBe('starting-timed-out');
    } finally {
      c.first.resolve();
      c.retry.resolve();
      await manager.stopAllComponents();
      await logger.close();
    }
  });

  test('is left alone when the retry comes up', async () => {
    const { logger, manager } = setup();
    const c = new TwoStarts(logger);
    await manager.registerComponent(c);
    try {
      await manager.startComponent('c');
      const retry = manager.startComponent('c');
      c.first.resolve();
      await sleep(5);
      c.retry.resolve();
      expect((await retry).success).toBe(true);
      await sleep(10);
      expect(c.stops).toBe(0);
      expect(manager.isComponentRunning('c')).toBe(true);
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });
});

describe('start and restart read whether a component runs from internal state', () => {
  // Answers running only for a component marked healthy.
  class HealthGated extends LifecycleManager {
    public readonly healthy = new Set<string>();
    public override isComponentRunning(name: string): boolean {
      return super.isComponentRunning(name) && this.healthy.has(name);
    }
  }

  test('a second start of a running component is refused without calling start() again', async () => {
    const { logger } = setup();
    const manager = new HealthGated({ logger, shutdownWarningTimeoutMS: -1 });
    const a = new Plain(logger, 'a');
    let starts = 0;
    a.start = (): Promise<void> => {
      starts++;
      return Promise.resolve();
    };
    await manager.registerComponent(a);
    try {
      expect((await manager.startComponent('a')).success).toBe(true);
      expect(await manager.startComponent('a')).toMatchObject({
        success: false,
        code: 'component_already_running',
      });
      expect(starts).toBe(1);
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });

  test('a restart of an idle running component is not refused as already starting', async () => {
    const { logger } = setup();
    const manager = new HealthGated({ logger, shutdownWarningTimeoutMS: -1 });
    const a = new Plain(logger, 'a');
    let starts = 0;
    let stops = 0;
    a.start = (): Promise<void> => {
      starts++;
      return Promise.resolve();
    };
    a.stop = (): Promise<void> => {
      stops++;
      return Promise.resolve();
    };
    await manager.registerComponent(a);
    try {
      await manager.startComponent('a');
      expect((await manager.restartComponent('a')).success).toBe(true);
      expect({ starts, stops }).toEqual({ starts: 2, stops: 1 });
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });
});

test('a required member a listener is starting again after its unexpected stop ends the pass as partial_state', async () => {
  const { logger, manager } = setup();
  const a = new Plain(logger, 'a');
  const b = new Plain(logger, 'b', ['a']);
  const gate = deferred();
  let restart: Promise<ComponentOperationResult> | undefined;
  let starts = 0;
  b.start = async (): Promise<void> => {
    starts++;
    if (starts > 1) {
      await gate.promise;
      return;
    }
    (
      b as unknown as { reportUnexpectedStop: () => boolean }
    ).reportUnexpectedStop();
  };
  manager.on('component:unexpected-stop', () => {
    restart ??= manager.startComponent('b', { allowDuringBulkStartup: true });
  });
  await manager.registerComponent(a);
  await manager.registerComponent(b);
  try {
    const startup = manager.startAllComponents();
    const result = await startup;
    expect(restart).toBeDefined();
    expect(result).toMatchObject({
      success: false,
      code: 'partial_state',
      startedComponents: ['a'],
    });
    // Not rolled back: the start in flight may need `a`.
    expect(manager.isComponentRunning('a')).toBe(true);
    gate.resolve();
    expect((await restart)?.success).toBe(true);
    expect(manager.getRunningComponentNames()).toEqual(['a', 'b']);
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('the startup preflight reads the registry, not the overridable count and name getters', async () => {
  let nameReads = 0;
  class Lying extends LifecycleManager {
    public override getComponentCount(): number {
      return 0;
    }
    public override getRunningComponentCount(): number {
      return 0;
    }
    public override getComponentNames(): string[] {
      nameReads++;
      return [];
    }
  }
  const { logger } = setup();
  const manager = new Lying({ logger, shutdownWarningTimeoutMS: -1 });
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.registerComponent(new Plain(logger, 'b'));
  try {
    expect((await manager.startAllComponents()).success).toBe(true);
    // All running, as the registry says - not "none registered".
    expect(await manager.startAllComponents()).toMatchObject({
      success: true,
      startedComponents: ['a', 'b'],
    });
    expect(nameReads).toBe(0);
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a per-name current start settlement agrees with the full map', async () => {
  const { logger, manager } = setup();
  const a = new Plain(logger, 'a');
  const gate = deferred();
  a.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(a);
  await manager.registerComponent(new Plain(logger, 'b'));
  const settlements = coreOf(manager).startSettlements;
  try {
    const starting = manager.startComponent('a');
    await sleep(0);
    expect(settlements.currentStartSettlementOf('a')).toBeDefined();
    for (const name of ['a', 'b']) {
      expect(settlements.currentStartSettlementOf(name)).toBe(
        settlements.currentStartSettlements().get(name),
      );
    }
    gate.resolve();
    await starting;
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a required member reconciled after a listener began starting it again ends the pass as partial_state', async () => {
  const { logger, manager } = setup();
  const a = new Plain(logger, 'a');
  const b = new Plain(logger, 'b', ['a']);
  const c = new Plain(logger, 'c');
  const gate = deferred();
  let restart: Promise<ComponentOperationResult> | undefined;
  let starts = 0;
  b.start = async (): Promise<void> => {
    starts++;
    if (starts > 1) {
      await gate.promise;
    }
  };
  // `b` was counted as started; its stop is met by reconciliation after `c`.
  c.start = (): Promise<void> => {
    (
      b as unknown as { reportUnexpectedStop: () => boolean }
    ).reportUnexpectedStop();
    return Promise.resolve();
  };
  manager.on('component:unexpected-stop', () => {
    restart ??= manager.startComponent('b', { allowDuringBulkStartup: true });
  });
  await manager.registerComponent(a);
  await manager.registerComponent(b);
  await manager.registerComponent(c);
  try {
    const result = await manager.startAllComponents();
    expect(restart).toBeDefined();
    expect(result).toMatchObject({
      success: false,
      code: 'partial_state',
      startedComponents: ['a', 'c'],
    });
    // Not rolled back: the start in flight may need `a`.
    expect(manager.getRunningComponentNames()).toEqual(['a', 'c']);
    gate.resolve();
    expect((await restart)?.success).toBe(true);
    expect(manager.getRunningComponentNames()).toEqual(['a', 'c', 'b']);
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

// Reconciliation scans in startup order: `d` either before `b` or, depending on it,
// after it.
test.each([
  ['before', [] as string[], ['a', 'd', 'b']],
  ['after', ['b'], ['a', 'b', 'd']],
])(
  'a required stop reconciled %s a member a listener is starting again still rolls back',
  async (_order, dDependencies, startupOrder) => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const d = new Plain(logger, 'd', dDependencies);
    const b = new Plain(logger, 'b', ['a']);
    const c = new Plain(logger, 'c', ['b', 'd']);
    const gate = deferred();
    const failure = new Error('d went away');
    let restart: Promise<ComponentOperationResult> | undefined;
    let starts = 0;
    b.start = async (): Promise<void> => {
      starts++;
      if (starts > 1) {
        await gate.promise;
      }
    };
    // `d` and `b` were counted as started; both stops are met by one reconciliation.
    c.start = (): Promise<void> => {
      (
        d as unknown as { reportUnexpectedStop: (error: Error) => boolean }
      ).reportUnexpectedStop(failure);
      (
        b as unknown as { reportUnexpectedStop: () => boolean }
      ).reportUnexpectedStop();
      return Promise.resolve();
    };
    manager.on('component:unexpected-stop', (data) => {
      if ((data as { name: string }).name === 'b') {
        restart ??= manager.startComponent('b', {
          allowDuringBulkStartup: true,
        });
      }
    });
    await manager.registerComponent(a);
    await manager.registerComponent(d);
    await manager.registerComponent(b);
    await manager.registerComponent(c);
    expect(manager.getStartupOrder()).toMatchObject({
      startupOrder: [...startupOrder, 'c'],
    });
    try {
      const result = await manager.startAllComponents();
      expect(restart).toBeDefined();
      // `d`'s failure is not dropped for `b`'s start in flight.
      expect(result).toMatchObject({
        success: false,
        code: 'component_unexpected_stop',
        error: failure,
      });
      // Rolled back, except `a`: the start in flight keeps its dependency protection.
      expect(manager.getRunningComponentNames()).toEqual(['a']);
    } finally {
      gate.resolve();
      await restart;
      await manager.stopAllComponents();
      await logger.close();
    }
  },
);
