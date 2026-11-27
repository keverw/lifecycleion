import { afterEach, expect, spyOn, test } from 'bun:test';
import { sleep } from '../sleep';
import type { LifecycleManagerEventMap } from './events';
import { claimReports, coreOf, deferred, Plain, setup } from './test-helpers';

const realSetTimeout = globalThis.setTimeout;
let captured: Array<{
  callback: () => void;
  ms: number | undefined;
  handle: ReturnType<typeof setTimeout>;
}> = [];

// Captures every timer created while installed, so a test fires them itself. Each still
// gets a real (never-firing) handle, so `clearTimeout()` keeps working.
function captureTimers(): void {
  captured = [];
  globalThis.setTimeout = ((callback: () => void, ms?: number) => {
    const handle = realSetTimeout(() => {}, 2 ** 31 - 1);
    captured.push({ callback, ms, handle });
    return handle;
  }) as typeof setTimeout;
}

function restoreTimers(): void {
  globalThis.setTimeout = realSetTimeout;
  for (const timer of captured) {
    clearTimeout(timer.handle);
  }
  captured = [];
}

afterEach(() => {
  restoreTimers();
});

test('a timed-out start that completes after a failed retry is still stopped', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  Object.defineProperty(component, 'startupTimeoutMS', { value: 20 });
  const gate = deferred();
  const retryFailure = new Error('retry failed');
  let starts = 0;
  let stops = 0;
  let hasResources = false;
  component.start = async () => {
    starts++;
    if (starts === 1) {
      await gate.promise;
      hasResources = true;
      return;
    }
    throw retryFailure;
  };
  component.stop = () => {
    stops++;
    hasResources = false;
    return Promise.resolve();
  };
  await manager.registerComponent(component);
  try {
    expect((await manager.startComponent('a')).code).toBe(
      'component_startup_timeout',
    );
    expect((await manager.startComponent('a')).error).toBe(retryFailure);

    gate.resolve();
    await sleep(20);

    expect(stops).toBe(1);
    expect(hasResources).toBe(false);
    expect(manager.isComponentRunning('a')).toBe(false);
    expect(manager.getComponentStatus('a')).toMatchObject({
      state: 'registered',
      lastError: retryFailure,
    });
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a timed-out start that completes while a retry is running leaves the retry up', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  Object.defineProperty(component, 'startupTimeoutMS', { value: 20 });
  const gate = deferred();
  let starts = 0;
  let stops = 0;
  component.start = async () => {
    starts++;
    if (starts === 1) {
      await gate.promise;
    }
  };
  component.stop = () => {
    stops++;
    return Promise.resolve();
  };
  await manager.registerComponent(component);
  try {
    await manager.startComponent('a');
    expect((await manager.startComponent('a')).success).toBe(true);

    gate.resolve();
    await sleep(20);

    expect(stops).toBe(0);
    expect(manager.isComponentRunning('a')).toBe(true);
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

for (const hasStoppedBefore of [false, true]) {
  test(`a retry of a timed-out start that fails leaves it ${hasStoppedBefore ? 'stopped' : 'registered'}, not timed out`, async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    Object.defineProperty(component, 'startupTimeoutMS', { value: 20 });
    const failure = new Error('retry failed');
    await manager.registerComponent(component);
    if (hasStoppedBefore) {
      await manager.startComponent('a');
      await manager.stopComponent('a');
    }
    component.start = () => new Promise<void>(() => {});
    try {
      expect((await manager.startComponent('a')).code).toBe(
        'component_startup_timeout',
      );
      expect(manager.getStartTimedOutComponentNames()).toEqual(['a']);

      component.start = () => Promise.reject(failure);
      expect((await manager.startComponent('a')).error).toBe(failure);

      expect(manager.getStartTimedOutComponentNames()).toEqual([]);
      expect(manager.getComponentStatus('a')).toMatchObject({
        state: hasStoppedBefore ? 'stopped' : 'registered',
        lastError: failure,
      });
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test('a crash after component:starting still ends in component:start-failed', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'a'));
  const events: string[] = [];
  manager.on('component:starting', () => {
    events.push('starting');
  });
  manager.on('component:start-failed', (data) => {
    const { error } =
      data as LifecycleManagerEventMap['component:start-failed'];
    events.push(`start-failed: ${error.message}`);
  });
  const settlements = coreOf(manager).startSettlements;
  const spy = spyOn(settlements, 'recordStartAttempt').mockImplementation(
    () => {
      throw new Error('bookkeeping exploded');
    },
  );
  const { reports, release } = claimReports();
  try {
    const result = await manager.startComponent('a');

    expect(result.code).toBe('operation_crashed');
    expect(events).toEqual(['starting', 'start-failed: bookkeeping exploded']);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
    expect(reports).toHaveLength(1);
  } finally {
    release();
    spy.mockRestore();
    await logger.close();
  }
});

test('a start that beats its own timeout but not an expired bulk deadline reports the bulk budget', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  Object.defineProperty(component, 'startupTimeoutMS', { value: 50 });
  const gate = deferred();
  component.start = () => gate.promise;
  await manager.registerComponent(component);
  const timeouts: Array<number | undefined> = [];
  manager.on('component:start-timeout', (data) => {
    timeouts.push(
      (data as LifecycleManagerEventMap['component:start-timeout']).timeoutMS,
    );
  });

  captureTimers();
  const pending = manager.startAllComponents({ timeoutMS: 10_000 });
  const bulkTimer = captured[0];
  expect(bulkTimer?.ms).toBe(10_000);
  while (!captured.some((timer) => timer.ms === 50)) {
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 0);
    });
  }

  // The bulk deadline expires; `start()` then resolves before its own timeout fires.
  bulkTimer?.callback();
  gate.resolve();
  restoreTimers();

  try {
    const result = await pending;
    expect(result.code).toBe('startup_timeout');
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0]).not.toBe(50);
    expect(timeouts[0]).toBeGreaterThan(9_000);
    expect(timeouts[0]).toBeLessThanOrEqual(10_000);
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a startup a shutdown cut short lists a member a listener started again after its unexpected stop', async () => {
  // A shutdown warning held open keeps the pass from stopping anything yet.
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 1000 });
  const warningGate = deferred();
  const a = new Plain(logger, 'a');
  Object.assign(a, { onShutdownWarning: () => warningGate.promise });
  await manager.registerComponent(a);
  await manager.registerComponent(new Plain(logger, 'b', ['a']));
  const internals = coreOf(manager).componentStart as unknown as {
    startComponentInternal: (
      name: string,
      ...args: unknown[]
    ) => Promise<{ success: boolean; componentName: string }>;
  };
  const start = internals.startComponentInternal.bind(internals);
  let shutdown: Promise<unknown> | undefined;
  const spy = spyOn(internals, 'startComponentInternal').mockImplementation(
    async (name, ...args) => {
      const result = await start(name, ...args);
      if (name !== 'b') {
        return result;
      }
      // `b` is up - as after an unexpected stop a listener started it again from -
      // and a shutdown has begun by the time the startup accounts for it.
      shutdown = manager.stopAllComponents();
      return {
        success: false,
        componentName: 'b',
        code: 'component_unexpected_stop',
        reason: 'stopped unexpectedly, then started again',
      };
    },
  );
  try {
    const result = await manager.startAllComponents();
    expect(result.code).toBe('shutdown_in_progress');
    expect(manager.isComponentRunning('b')).toBe(true);
    expect(result.startedComponents).toEqual(['a', 'b']);
  } finally {
    spy.mockRestore();
    warningGate.resolve();
    await shutdown;
    await manager.stopAllComponents();
    await logger.close();
  }
});
