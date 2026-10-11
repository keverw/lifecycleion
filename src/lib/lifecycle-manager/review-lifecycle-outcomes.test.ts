import { expect, test } from 'bun:test';
import { ForceShutdownSupersededError } from './errors';
import {
  claimReports,
  coreOf,
  deferred,
  failStatusReadOnce,
  Plain,
  setup,
  Stalls,
} from './test-helpers';

test('a status failure after shutdown cleans up a resolved start preserves stopped state', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const component = new Plain(logger, 'api');
  component.start = () => gate.promise;
  await manager.registerComponent(component);
  const failure = new Error('result status failed');
  const status = manager.getComponentStatus.bind(manager);
  let shouldThrow = false;
  let failedStarts = 0;
  manager.on('component:start-failed', () => {
    failedStarts++;
  });
  const restoreStatusRead = failStatusReadOnce(failure, () => shouldThrow);
  const { reports, release } = claimReports();
  try {
    const starting = manager.startComponent('api');
    await manager.stopAllComponents({ allowStopWithPendingStarts: true });
    // Armed once the stop has answered: the next read is the start's own result.
    shouldThrow = true;
    gate.resolve();
    expect(await starting).toMatchObject({
      success: false,
      code: 'operation_crashed',
      error: failure,
    });
    expect(status('api')?.state).toBe('stopped');
    expect(failedStarts).toBe(0);
    expect(reports).toHaveLength(1);
  } finally {
    gate.resolve();
    restoreStatusRead();
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a late graceful stop still aborts pending force work when status throws', async () => {
  const { logger, manager } = setup();
  const graceful = deferred();
  const forceEntered = deferred();
  const force = deferred();
  const component = new Plain(logger, 'api');
  let forceSignal: AbortSignal | undefined;
  component.stop = () => graceful.promise;
  // eslint-disable-next-line @typescript-eslint/no-misused-promises -- force stays pending while graceful completion wins
  component.onShutdownForce = (signal) => {
    forceSignal = signal;
    forceEntered.resolve();
    return force.promise;
  };
  await manager.registerComponent(component);
  await manager.startComponent('api');
  const status = manager.getComponentStatus.bind(manager);
  let shouldThrow = false;
  manager.on('component:stopped', () => {
    shouldThrow = true;
  });
  manager.getComponentStatus = (name) => {
    if (shouldThrow) {
      shouldThrow = false;
      throw new Error('late stop status failed');
    }
    return status(name);
  };
  const { reports, release } = claimReports();
  try {
    const stopping = manager.stopComponent('api', { timeout: 5 });
    await forceEntered.promise;
    graceful.resolve();
    expect(await stopping).toMatchObject({ success: true });
    expect(forceSignal?.aborted).toBe(true);
    expect(forceSignal?.reason).toBeInstanceOf(ForceShutdownSupersededError);
    expect(status('api')?.state).toBe('stopped');
    expect(reports).toHaveLength(1);
  } finally {
    graceful.resolve();
    force.resolve();
    manager.getComponentStatus = status;
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test.each([true, false])(
  'a concurrent stop stalling during another stop honors haltOnStall=%s',
  async (shouldHalt) => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const unrelated = new Plain(logger, 'unrelated');
    const stalled = new Stalls(logger, 'api', ['database']);
    const failingStop = deferred();
    stalled.stop = () => failingStop.promise;
    await manager.registerComponent(database);
    await manager.registerComponent(unrelated);
    await manager.registerComponent(stalled);
    await manager.startAllComponents();
    const individual = manager.stopComponent('api');
    unrelated.stop = async () => {
      failingStop.reject(new Error('stop failed'));
      await individual;
    };
    try {
      const result = await manager.stopAllComponents({
        timeoutMS: 0,
        retryStalled: false,
        haltOnStall: shouldHalt,
      });
      expect(result.success).toBe(false);
      expect(result.stalledComponents.map((entry) => entry.name)).toEqual([
        'api',
      ]);
      expect(manager.isComponentRunning('database')).toBe(shouldHalt);
      expect(result.stoppedComponents.includes('database')).toBe(!shouldHalt);
      if (shouldHalt) {
        expect(result.reason).toContain('Not attempted: database');
      }
    } finally {
      failingStop.resolve();
      await individual;
      await manager.stopAllComponents({ haltOnStall: false });
      await logger.close();
    }
  },
);

test('bulk startup retains its crash error when rollback triggers shutdown', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'api');
  await manager.registerComponent(component);
  const internals = coreOf(manager).registry;
  const updateStartedFlag = internals.updateStartedFlag.bind(internals);
  const failure = new Error('startup completion bookkeeping failed');
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  component.stop = () => {
    shutdown = manager.stopAllComponents({ timeoutMS: 0 });
    return Promise.resolve();
  };
  manager.once('component:started', () => {
    internals.updateStartedFlag = () => {
      internals.updateStartedFlag = updateStartedFlag;
      throw failure;
    };
  });
  const { reports, release } = claimReports();
  try {
    expect(await manager.startAllComponents()).toMatchObject({
      success: false,
      code: 'shutdown_in_progress',
      error: failure,
    });
    expect(reports).toHaveLength(1);
    await shutdown;
  } finally {
    internals.updateStartedFlag = updateStartedFlag;
    release();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test.each([0, 10])(
  'a deep protected shutdown keeps timers responsive with timeoutMS=%s',
  async (timeoutMS) => {
    const { logger, manager } = setup();
    const depth = 2500;
    const components = Array.from(
      { length: depth },
      (_, index) =>
        new Plain(logger, `c${index}`, index === 0 ? [] : [`c${index - 1}`]),
    );
    const names = new Map(
      components.map((component) => [component.getName(), component]),
    );
    // As in shutdown-deep-dependencies.integration.test.ts, seed a committed registry
    // to measure shutdown rather than repeatedly sorting a growing registration graph.
    Object.assign((manager as unknown as { state: object }).state, {
      componentEntries: components,
      components,
      componentsByName: names,
      registeredNames: new WeakMap(
        components.map((component) => [component, component.getName()]),
      ),
      componentStates: new Map(
        [...names.keys()].map((name) => [name, 'running']),
      ),
      runningComponents: new Set(names.keys()),
    });
    const gate = deferred();
    const top = components[depth - 1];
    Object.defineProperty(top, 'shutdownGracefulTimeoutMS', { value: 0 });
    top.stop = () => gate.promise;
    const individual = manager.stopComponent(top.getName());
    let didTimerRun = false;
    const timer = setTimeout(() => {
      didTimerRun = true;
    }, 0);
    const shutdown = manager.stopAllComponents({ timeoutMS });
    try {
      if (timeoutMS === 0) {
        // No deadline: the pass waits for the concurrent stop, its dependencies still
        // up, and then stops them.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(didTimerRun).toBe(true);
        expect(manager.isComponentRunning('c0')).toBe(true);
        gate.resolve();
        expect((await shutdown).success).toBe(true);
        expect(manager.isComponentRunning('c0')).toBe(false);
      } else {
        const result = await shutdown;
        expect(didTimerRun).toBe(true);
        expect(result.code).toBe('shutdown_timeout');
        expect(result.stoppedComponents).toEqual([]);
        expect(manager.isComponentRunning('c0')).toBe(true);
      }
    } finally {
      clearTimeout(timer);
      gate.resolve();
      await individual;
      await manager.stopAllComponents({ timeoutMS: 0 });
      await logger.close();
    }
  },
);
