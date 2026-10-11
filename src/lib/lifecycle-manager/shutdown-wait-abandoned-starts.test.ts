import { expect, test } from 'bun:test';
import type { Logger } from '../logger';
import type { LifecycleManager } from './lifecycle-manager';
import { deferred, Plain, setup } from './test-helpers';

// `waitForAbandonedStarts` opts a shutdown pass back into waiting for a start whose
// `startupTimeoutMS` has passed but whose `start()` is still unresolved. By default the
// pass stops waiting and answers `cleanup_incomplete`; with the option it waits, within
// its budget, whether the start timed out before the pass began or while it ran.

function twoComponents(
  logger: Logger,
  manager: LifecycleManager,
): {
  order: string[];
  start: ReturnType<typeof deferred<void>>;
  register: () => Promise<void>;
} {
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const start = deferred();
  const order: string[] = [];
  worker.start = () => start.promise;
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 10 });
  worker.stop = () => {
    order.push('worker');
    return Promise.resolve();
  };
  database.stop = () => {
    order.push('database');
    return Promise.resolve();
  };

  return {
    order,
    start,
    register: async () => {
      await manager.registerComponent(database);
      await manager.registerComponent(worker);
      await manager.startComponent('database');
    },
  };
}

for (const isTimedOutBeforePass of [false, true]) {
  test(`waitForAbandonedStarts waits for a start that timed out ${isTimedOutBeforePass ? 'before' : 'during'} the pass, then stops its dependencies`, async () => {
    const { logger, manager } = setup();
    const { order, start, register } = twoComponents(logger, manager);
    await register();
    const starting = manager.startComponent('worker');
    try {
      if (isTimedOutBeforePass) {
        expect((await starting).code).toBe('component_startup_timeout');
      }
      const shutdown = manager.stopAllComponents({
        timeoutMS: 1000,
        waitForAbandonedStarts: true,
      });
      if (!isTimedOutBeforePass) {
        expect((await starting).code).toBe('component_startup_timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(order).toEqual([]);
      expect(manager.getComponentStatus('database')?.state).toBe('running');

      start.resolve();
      const result = await shutdown;
      expect(result.success).toBe(true);
      expect(order).toEqual(['worker', 'database']);
      expect(manager.getRunningComponentNames()).toEqual([]);
    } finally {
      start.resolve();
      await starting;
      await manager.stopAllComponents();
    }
  });
}

test('waitForAbandonedStarts still ends at the shutdown budget', async () => {
  const { logger, manager } = setup();
  const { order, start, register } = twoComponents(logger, manager);
  await register();
  const starting = manager.startComponent('worker');
  try {
    expect((await starting).code).toBe('component_startup_timeout');
    const result = await manager.stopAllComponents({
      timeoutMS: 50,
      waitForAbandonedStarts: true,
    });
    expect(result.code).toBe('shutdown_timeout');
    expect(order).toEqual([]);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
  } finally {
    start.resolve();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.stopAllComponents();
  }
});

test('waitForAbandonedStarts can be the manager default and is overridden per call', async () => {
  const { logger, manager } = setup({
    shutdownOptions: { waitForAbandonedStarts: true },
  });
  const { start, register } = twoComponents(logger, manager);
  await register();
  const starting = manager.startComponent('worker');
  try {
    expect((await starting).code).toBe('component_startup_timeout');
    const result = await manager.stopAllComponents({
      timeoutMS: 1000,
      waitForAbandonedStarts: false,
    });
    expect(result.code).toBe('cleanup_incomplete');

    const waiting = manager.stopAllComponents({ timeoutMS: 1000 });
    start.resolve();
    expect((await waiting).success).toBe(true);
  } finally {
    start.resolve();
    await starting;
    await manager.stopAllComponents();
  }
});

test('allowStopWithPendingStarts takes precedence over waitForAbandonedStarts', async () => {
  const { logger, manager } = setup();
  const { order, start, register } = twoComponents(logger, manager);
  await register();
  const starting = manager.startComponent('worker');
  try {
    expect((await starting).code).toBe('component_startup_timeout');
    const result = await manager.stopAllComponents({
      timeoutMS: 1000,
      waitForAbandonedStarts: true,
      allowStopWithPendingStarts: true,
    });
    expect(result.code).toBe('cleanup_incomplete');
    expect(order).toEqual(['database']);
  } finally {
    start.resolve();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.stopAllComponents();
  }
});

test('restartAllComponents does not wait for abandoned starts even when shutdownOptions does', async () => {
  const { logger, manager } = setup({
    shutdownOptions: { waitForAbandonedStarts: true },
  });
  const { order, start, register } = twoComponents(logger, manager);
  await register();
  const starting = manager.startComponent('worker');
  try {
    // Still in flight as the restart begins, so its preflight lets it through; it
    // times out while the stop phase waits on it.
    const restart = await manager.restartAllComponents({
      shutdownTimeoutMS: 500,
    });
    expect((await starting).code).toBe('component_startup_timeout');
    expect(restart.shutdownResult.code).toBe('cleanup_incomplete');
    expect(restart.startupResult.code).toBe('partial_state');
    expect(order).toEqual([]);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
  } finally {
    start.resolve();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.stopAllComponents();
  }
});

test('waitForAbandonedStarts waits for start() itself when the component owns its late-start cleanup', async () => {
  const { logger, manager } = setup();
  const { order, start, register } = twoComponents(logger, manager);
  await register();
  const worker = manager.getComponentInstance('worker');
  Object.defineProperty(worker, 'ownsLateStartCleanup', { value: true });
  const starting = manager.startComponent('worker');
  try {
    expect((await starting).code).toBe('component_startup_timeout');
    let didSettle = false;
    const shutdown = manager
      .stopAllComponents({ timeoutMS: 1000, waitForAbandonedStarts: true })
      .finally(() => {
        didSettle = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The manager does not clean this start up, but its `start()` is still pending:
    // the pass keeps waiting rather than end `cleanup_incomplete` straight away.
    expect(didSettle).toBe(false);
    expect(manager.getComponentStatus('database')?.state).toBe('running');

    start.resolve();
    const result = await shutdown;
    expect(result.code).not.toBe('cleanup_incomplete');
    // The component undoes its own late start; the manager stops only the dependency.
    expect(order).toEqual(['database']);
    expect(manager.getComponentStatus('database')?.state).toBe('stopped');
  } finally {
    start.resolve();
    await starting;
    await manager.stopAllComponents();
  }
});
