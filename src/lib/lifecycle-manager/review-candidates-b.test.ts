import { expect, test } from 'bun:test';
import type { LifecycleManager } from './lifecycle-manager';
import type { ComponentOperationResult, ComponentStatus } from './types';
import {
  claimReports,
  deferred,
  Plain,
  sendSignal,
  setup,
} from './test-helpers';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Makes the first status read of a component already recorded as stopped throw, as an
// overridden `getComponentStatus()` might. Returns the original, for the test's own reads.
function failFirstStoppedStatusRead(
  manager: LifecycleManager,
  failure: Error,
): (name: string) => ReturnType<LifecycleManager['getComponentStatus']> {
  const status = manager.getComponentStatus.bind(manager);
  let hasThrown = false;
  manager.getComponentStatus = (name) => {
    if (!hasThrown && status(name)?.state === 'stopped') {
      hasThrown = true;
      throw failure;
    }
    return status(name);
  };
  return status;
}

test('a timed-out shutdown pass does not join pending starts after its deadline', async () => {
  const { logger, manager } = setup();
  const dependency = new Plain(logger, 'dependency');
  const pending = new Plain(logger, 'pending', ['dependency']);
  const slow = new Plain(logger, 'slow');
  const startGate = deferred();
  const stopGate = deferred();
  const stopEntered = deferred();
  pending.start = () => startGate.promise;
  slow.stop = () => {
    stopEntered.resolve();
    return stopGate.promise;
  };
  await manager.registerComponent(dependency);
  await manager.registerComponent(pending);
  await manager.registerComponent(slow);
  await manager.startComponent('dependency');
  await manager.startComponent('slow');
  const starting = manager.startComponent('pending');
  try {
    const result = await manager.stopAllComponents({
      timeoutMS: 20,
      waitForAbandonedStarts: true,
    });
    expect(result.timedOut).toBe(true);
    await stopEntered.promise;

    // The loop moves on to `dependency`, which needs the pending start joined. The pass
    // is over: it halts there rather than wait on a `start()` that has not settled.
    stopGate.resolve();
    await sleep(20);
    expect(manager.isComponentRunning('dependency')).toBe(true);
  } finally {
    stopGate.resolve();
    startGate.resolve();
    await starting;
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a late graceful stop picked up before force still emits stopped when status throws', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const gate = deferred();
  component.stop = () => gate.promise;
  Object.defineProperty(component, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  manager.on('component:stop-timeout', () => gate.resolve());
  let stopped = 0;
  manager.on('component:stopped', () => {
    stopped++;
  });
  const failure = new Error('status failed');
  const status = failFirstStoppedStatusRead(manager, failure);
  const { reports, release } = claimReports();
  try {
    const result = await manager.stopComponent('a', { timeout: 5 });
    expect(result.success).toBe(true);
    expect(result.code).toBeUndefined();
    expect(status('a')?.state).toBe('stopped');
    expect(stopped).toBe(1);
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(failure);
  } finally {
    release();
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('an unexpected stop whose status read throws still emits stopped and does not throw', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  await manager.registerComponent(component);
  await manager.startComponent('a');
  let stopped = 0;
  manager.on('component:stopped', () => {
    stopped++;
  });
  const failure = new Error('status failed');
  const status = failFirstStoppedStatusRead(manager, failure);
  const { reports, release } = claimReports();
  try {
    const report = (): boolean =>
      (
        component as unknown as { reportUnexpectedStop: () => boolean }
      ).reportUnexpectedStop();
    expect(report).not.toThrow();
    expect(status('a')?.state).toBe('stopped');
    expect(stopped).toBe(1);
    expect(reports).toHaveLength(1);
    expect((reports[0] as Error).cause).toBe(failure);
  } finally {
    release();
    await logger.close();
  }
});

for (const phase of ['graceful', 'force'] as const) {
  test(`a ${phase} stop whose status read throws still emits stopped`, async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    if (phase === 'force') {
      component.stop = () => Promise.reject(new Error('stop failed'));
    }
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const events: Array<string | undefined> = [];
    manager.on(
      'component:stopped',
      ({ status }: { status?: ComponentStatus }) => {
        events.push(status?.state);
      },
    );
    const failure = new Error('status failed');
    const status = failFirstStoppedStatusRead(manager, failure);
    const { reports, release } = claimReports();
    try {
      const result = await manager.stopComponent('a');
      expect(result.success).toBe(true);
      expect(status('a')?.state).toBe('stopped');
      // Delivered without the status that could not be read.
      expect(events).toStrictEqual([undefined]);
      expect(reports).toHaveLength(1);
      expect((reports[0] as Error).cause).toBe(failure);
    } finally {
      release();
      await logger.close();
    }
  });
}

test('a component started again before its startup stop is consumed is still rolled back', async () => {
  const { logger, manager } = setup();
  const first = new Plain(logger, 'first');
  const second = new Plain(logger, 'second');
  await manager.registerComponent(first);
  await manager.registerComponent(second);
  let restart: Promise<ComponentOperationResult> | undefined;
  second.start = async () => {
    (
      first as unknown as { reportUnexpectedStop: () => boolean }
    ).reportUnexpectedStop();
    restart = manager.startComponent('first', {
      allowDuringBulkStartup: true,
    });
    await restart;
  };
  try {
    const result = await manager.startAllComponents();
    expect((await restart)?.success).toBe(true);
    expect(result.success).toBe(false);
    expect(result.code).toBe('component_unexpected_stop');
    // The rollback reached it: nothing is left running outside the result.
    expect(manager.isComponentRunning('first')).toBe(false);
    expect(manager.isComponentRunning('second')).toBe(false);
    expect(result.startedComponents).toEqual([]);
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a press counted on a cycle a log sink reset does not force shutdown', async () => {
  let forceCalls = 0;
  const { logger, manager } = setup({
    shutdownOptions: { timeoutMS: 100, retryStalled: false },
    repeatedShutdownRequestPolicy: {
      forceAfterCount: 1,
      withinMS: 5000,
      armedAfterFailureMS: 60_000,
      onForceShutdown: () => {
        forceCalls++;
      },
    },
  });
  const component = new Plain(logger, 'a');
  const stopGate = deferred();
  const stopped = deferred();
  component.stop = async () => {
    await stopGate.promise;
    stopped.resolve();
  };
  await manager.registerComponent(component);
  await manager.startAllComponents();
  // A timed-out pass arms the escalation window. Its stop then finishes, so a startup
  // is not refused for anything left behind.
  expect((await manager.stopAllComponents({ timeoutMS: 10 })).timedOut).toBe(
    true,
  );
  stopGate.resolve();
  await stopped.promise;
  await sleep(0);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

  let startup: ReturnType<typeof manager.startAllComponents> | undefined;
  logger.addSink({
    write(entry) {
      if (
        startup === undefined &&
        entry.message.startsWith('Previous shutdown attempt finished')
      ) {
        // A fresh startup resets escalation under the request being counted.
        startup = manager.startAllComponents();
      }
    },
  });
  try {
    sendSignal(manager, 'SIGINT');
    expect(startup).toBeDefined();
    expect(forceCalls).toBe(0);
  } finally {
    await startup;
    while (manager.getSystemState() === 'shutting-down') {
      await sleep(5);
    }
    await logger.close();
  }
});
