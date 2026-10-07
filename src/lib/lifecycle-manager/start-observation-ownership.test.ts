import { expect, test } from 'bun:test';
import { sleep } from '../sleep';
import { deferred, Plain, setup } from './test-helpers';

// Adoption succeeds; the subsequent raw-start observer fails before attaching.
function failSecondConstructorRead(
  promise: Promise<void>,
  failure: Error,
  isPersistent = false,
): Promise<void> {
  let reads = 0;
  void Object.defineProperty(promise, 'constructor', {
    get(): PromiseConstructor {
      if (++reads === 2 || (isPersistent && reads > 2)) {
        throw failure;
      }
      return Promise;
    },
  });
  return promise;
}

// Adoption and the raw-start observer succeed. No later wait/cleanup should need
// another observation of this caller-controlled promise.
function refuseLaterObservations(promise: Promise<void>): Promise<void> {
  let reads = 0;
  void Object.defineProperty(promise, 'constructor', {
    get(): PromiseConstructor {
      if (++reads > 2) {
        throw new Error('later start observation refused');
      }
      return Promise;
    },
  });
  return promise;
}

test.each([0, 1000])(
  'startup with timeout %s owns its resources after later promise observations are refused',
  async (timeoutMS) => {
    const { logger, manager } = setup();
    const gate = deferred();
    const component = new Plain(logger, 'api');
    Object.defineProperty(component, 'startupTimeoutMS', { value: timeoutMS });
    let hasResources = false;
    let stops = 0;
    component.start = () =>
      refuseLaterObservations(
        gate.promise.then(() => {
          hasResources = true;
        }),
      );
    component.stop = () => {
      stops++;
      hasResources = false;
      return Promise.resolve();
    };
    await manager.registerComponent(component);
    try {
      const starting = manager.startComponent('api');
      gate.resolve();
      expect((await starting).success).toBe(true);
      expect(hasResources).toBe(true);
      expect(manager.isComponentRunning('api')).toBe(true);
      expect((await manager.stopAllComponents()).success).toBe(true);
      expect(hasResources).toBe(false);
      expect(stops).toBe(1);
    } finally {
      gate.resolve();
      await manager.stopAllComponents();
      await logger.close();
    }
  },
);

test('timeout keeps late cleanup when the raw start refuses later observations', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const component = new Plain(logger, 'api', ['db']);
  Object.defineProperty(component, 'startupTimeoutMS', { value: 5 });
  let signal: AbortSignal | undefined;
  let hasResources = false;
  let stops = 0;
  component.start = (startSignal) => {
    signal = startSignal;
    return refuseLaterObservations(
      gate.promise.then(() => {
        hasResources = true;
      }),
    );
  };
  component.stop = () => {
    stops++;
    hasResources = false;
    return Promise.resolve();
  };
  await manager.registerComponent(new Plain(logger, 'db'));
  await manager.registerComponent(component);
  await manager.startComponent('db');
  try {
    expect((await manager.startComponent('api')).code).toBe(
      'component_startup_timeout',
    );
    expect(signal?.aborted).toBe(true);
    expect((await manager.stopAllComponents({ timeoutMS: 0 })).code).toBe(
      'cleanup_incomplete',
    );
    expect(manager.isComponentRunning('db')).toBe(true);
    const shutdown = manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    gate.resolve();
    expect((await shutdown).success).toBe(true);
    expect(hasResources).toBe(false);
    expect(stops).toBe(1);
    expect(manager.isComponentRunning('db')).toBe(false);
  } finally {
    gate.resolve();
    await manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    await logger.close();
  }
});

test('shutdown observes an aborted start rejection after later observations are refused', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const component = new Plain(logger, 'api', ['db']);
  Object.defineProperty(component, 'startupTimeoutMS', { value: 0 });
  component.start = (signal) => {
    if (signal === undefined) {
      throw new Error('Missing startup abort signal');
    }
    signal.addEventListener('abort', () => gate.reject(signal.reason));
    return refuseLaterObservations(gate.promise);
  };
  let stops = 0;
  component.stop = () => {
    stops++;
    return Promise.resolve();
  };
  await manager.registerComponent(new Plain(logger, 'db'));
  await manager.registerComponent(component);
  await manager.startComponent('db');
  try {
    const starting = manager.startComponent('api');
    const shutdown = await manager.stopAllComponents({
      timeoutMS: 1000,
      abortPendingStarts: true,
    });
    expect((await starting).code).toBe('shutdown_in_progress');
    expect(shutdown.success).toBe(true);
    expect(stops).toBe(0);
    expect(manager.isComponentRunning('db')).toBe(false);
    expect((await manager.unregisterComponent('api')).success).toBe(true);
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('failed raw-start observation protects dependencies and cleans up resources acquired later', async () => {
  const { logger, manager } = setup();
  const startGate = deferred();
  const stopGate = deferred();
  const stopEntered = deferred();
  const failure = new Error('raw start observation failed');
  const component = new Plain(logger, 'api', ['db']);
  Object.defineProperty(component, 'startupTimeoutMS', { value: 0 });
  let hasResources = false;
  let stopCalls = 0;
  component.start = () =>
    failSecondConstructorRead(
      startGate.promise.then(() => {
        hasResources = true;
      }),
      failure,
    );
  component.stop = async () => {
    stopCalls++;
    stopEntered.resolve();
    await stopGate.promise;
    hasResources = false;
  };
  await manager.registerComponent(new Plain(logger, 'db'));
  await manager.registerComponent(component);
  await manager.startComponent('db');
  try {
    const result = await manager.startComponent('api');
    expect(result).toMatchObject({
      success: false,
      code: 'error',
      error: failure,
    });
    expect(hasResources).toBe(false);
    expect((await manager.startComponent('api')).success).toBe(false);
    expect((await manager.unregisterComponent('api')).success).toBe(false);

    const unresolved = await manager.stopAllComponents({ timeoutMS: 0 });
    expect(unresolved).toMatchObject({
      success: false,
      code: 'cleanup_incomplete',
    });
    expect(unresolved.stoppedComponents).toEqual([]);
    expect(manager.isComponentRunning('db')).toBe(true);
    expect(stopCalls).toBe(0);

    const shutdown = manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    startGate.resolve();
    await stopEntered.promise;
    expect(hasResources).toBe(true);
    expect(manager.isComponentRunning('db')).toBe(true);
    stopGate.resolve();
    expect((await shutdown).success).toBe(true);
    expect(hasResources).toBe(false);
    expect(stopCalls).toBe(1);
    expect(manager.isComponentRunning('db')).toBe(false);
    expect(manager.getComponentStatus('api')?.lastError).toBe(failure);
  } finally {
    startGate.resolve();
    stopGate.resolve();
    await manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    await logger.close();
  }
});

test('a late raw-start rejection releases failed-observation ownership without stopping the component', async () => {
  const { logger, manager } = setup();
  const startGate = deferred();
  const failure = new Error('raw start observation failed');
  const component = new Plain(logger, 'api', ['db']);
  Object.defineProperty(component, 'startupTimeoutMS', { value: 0 });
  component.start = () => failSecondConstructorRead(startGate.promise, failure);
  let stopCalls = 0;
  component.stop = () => {
    stopCalls++;
    return Promise.resolve();
  };
  await manager.registerComponent(new Plain(logger, 'db'));
  await manager.registerComponent(component);
  await manager.startComponent('db');
  try {
    expect((await manager.startComponent('api')).error).toBe(failure);
    const shutdown = manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    startGate.reject(new Error('start failed later'));
    expect((await shutdown).success).toBe(true);
    expect(stopCalls).toBe(0);
    expect(manager.getComponentStatus('api')?.lastError).toBe(failure);
    expect((await manager.unregisterComponent('api')).success).toBe(true);
  } finally {
    await logger.close();
  }
});

test('a raw start whose constructor continues refusing observation remains protected', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const failure = new Error('raw start observation refused');
  const component = new Plain(logger, 'api', ['db']);
  Object.defineProperty(component, 'startupTimeoutMS', { value: 0 });
  component.start = () =>
    failSecondConstructorRead(gate.promise, failure, true);
  await manager.registerComponent(new Plain(logger, 'db'));
  await manager.registerComponent(component);
  await manager.startComponent('db');
  try {
    expect((await manager.startComponent('api')).error).toBe(failure);
    gate.resolve();
    await sleep(0);
    const shutdown = await manager.stopAllComponents({ timeoutMS: 0 });
    expect(shutdown).toMatchObject({
      success: false,
      code: 'cleanup_incomplete',
    });
    expect(manager.isComponentRunning('db')).toBe(true);
    expect((await manager.unregisterComponent('api')).success).toBe(false);
    expect(
      (await manager.registerComponent(new Plain(logger, 'api'))).code,
    ).toBe('duplicate_name');
    const restart = await manager.restartAllComponents();
    expect(restart.success).toBe(false);
    expect(manager.isComponentRunning('db')).toBe(true);
    const bounded = await manager.stopAllComponents({
      timeoutMS: 10,
      waitForAbandonedStarts: true,
    });
    expect(bounded).toMatchObject({ success: false, code: 'shutdown_timeout' });
    expect(manager.isComponentRunning('db')).toBe(true);
  } finally {
    await logger.close();
  }
});

test('late cleanup of a forced start with failed observation retires its stall without inventing a timeout', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const oldStop = deferred();
  const failure = new Error('forced start observation failed');
  const component = new Plain(logger, 'api');
  Object.defineProperties(component, {
    startupTimeoutMS: { value: 0 },
    onShutdownForce: { value: undefined },
  });
  component.stop = () => oldStop.promise;
  await manager.registerComponent(component);
  await manager.startComponent('api');
  expect((await manager.stopComponent('api', { timeout: 5 })).success).toBe(
    false,
  );
  expect(manager.getComponentStatus('api')?.state).toBe('stalled');

  let stops = 0;
  component.stop = () => {
    stops++;
    return Promise.resolve();
  };
  component.start = () => failSecondConstructorRead(gate.promise, failure);
  try {
    const result = await manager.startComponent('api', { forceStalled: true });
    expect(result).toMatchObject({
      success: false,
      code: 'error',
      error: failure,
    });
    expect(manager.getComponentStatus('api')?.state).toBe('stalled');
    const shutdown = manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    gate.resolve();
    expect((await shutdown).success).toBe(true);
    expect(stops).toBe(1);
    expect(manager.getComponentStatus('api')).toMatchObject({
      state: 'stopped',
      lastError: failure,
    });
    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(manager.getStartTimedOutComponentNames()).toEqual([]);
    oldStop.resolve();
    await sleep(0);
    expect(manager.getComponentStatus('api')).toMatchObject({
      state: 'stopped',
      lastError: failure,
    });
  } finally {
    gate.resolve();
    oldStop.resolve();
    await manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    await logger.close();
  }
});

test('unregister cannot orphan a resolved raw start before failed-observation cleanup claims it', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  const failure = new Error('raw start observation failed');
  const component = new Plain(logger, 'api');
  Object.defineProperty(component, 'startupTimeoutMS', { value: 0 });
  let hasResources = false;
  let stops = 0;
  const rawStart = failSecondConstructorRead(
    gate.promise.then(() => {
      hasResources = true;
    }),
    failure,
  );
  component.start = () => rawStart;
  component.stop = () => {
    stops++;
    hasResources = false;
    return Promise.resolve();
  };
  await manager.registerComponent(component);
  try {
    expect((await manager.startComponent('api')).error).toBe(failure);
    // The raw-start marker runs first. This reaction runs before recovery resumes
    // from its owned promise, while raw startup has settled but cleanup has not.
    const unregister = rawStart.then(() => manager.unregisterComponent('api'));
    gate.resolve();
    expect((await unregister).code).toBe('component_starting');
    expect(manager.hasComponent('api')).toBe(true);
    expect(
      (
        await manager.stopAllComponents({
          timeoutMS: 0,
          waitForAbandonedStarts: true,
        })
      ).success,
    ).toBe(true);
    expect(stops).toBe(1);
    expect(hasResources).toBe(false);
    expect((await manager.unregisterComponent('api')).success).toBe(true);
  } finally {
    gate.resolve();
    await manager.stopAllComponents({
      timeoutMS: 0,
      waitForAbandonedStarts: true,
    });
    await logger.close();
  }
});
