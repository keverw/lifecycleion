import { expect, test } from 'bun:test';
import { deferred, Plain, setup } from './test-helpers';
import type { ComponentLifecycleRef } from './types';

for (const timeoutMS of [0, 1000]) {
  for (const hasLateTimeout of [false, true]) {
    test(`shutdown joins startup and its cleanup before stopping dependencies (late timeout: ${hasLateTimeout}, budget: ${timeoutMS})`, async () => {
      const { logger, manager } = setup();
      const database = new Plain(logger, 'database');
      const worker = new Plain(logger, 'worker', ['database']);
      const start = deferred();
      const stop = deferred();
      const stopping = deferred();
      const order: string[] = [];
      worker.start = () => start.promise;
      Object.defineProperty(worker, 'startupTimeoutMS', {
        value: hasLateTimeout ? 10 : 1000,
      });
      worker.stop = async () => {
        order.push('worker');
        stopping.resolve();
        await stop.promise;
      };
      database.stop = () => {
        order.push('database');
        return Promise.resolve();
      };
      await manager.registerComponent(database);
      await manager.registerComponent(worker);
      await manager.startComponent('database');
      const starting = manager.startComponent('worker');
      const shutdown = manager.stopAllComponents({ timeoutMS });
      try {
        if (hasLateTimeout) {
          expect((await starting).code).toBe('component_startup_timeout');
        }
        expect(order).toEqual([]);
        expect(manager.getComponentStatus('database')?.state).toBe('running');
        if (hasLateTimeout && timeoutMS === 0) {
          expect((await shutdown).code).toBe('cleanup_incomplete');
          expect(manager.getComponentStatus('database')?.state).toBe('running');
        }
        start.resolve();
        await stopping.promise;
        expect(order).toEqual(['worker']);
        expect(manager.getComponentStatus('database')?.state).toBe('running');
        stop.resolve();
        const result =
          hasLateTimeout && timeoutMS === 0
            ? await manager.stopAllComponents({ timeoutMS: 0 })
            : await shutdown;
        expect(result.success).toBe(true);
        expect(order).toEqual(['worker', 'database']);
        expect(manager.getRunningComponentNames()).toEqual([]);
      } finally {
        start.resolve();
        stop.resolve();
        await starting;
        await shutdown;
        await manager.stopAllComponents();
      }
    });
  }
}

test('an expired shutdown does not resume stopping dependencies after startup settles', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const gate = deferred();
  worker.start = () => gate.promise;
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  const starting = manager.startComponent('worker');
  try {
    const result = await manager.stopAllComponents({ timeoutMS: 10 });
    expect(result.code).toBe('shutdown_timeout');
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    gate.resolve();
    await starting;
    await Promise.resolve();
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    expect((await manager.stopAllComponents()).success).toBe(true);
  } finally {
    gate.resolve();
    await starting;
    await manager.stopAllComponents();
  }
});

for (const timeoutMS of [0, 10]) {
  test(`shutdown preserves dependencies of an already timed-out start (budget: ${timeoutMS})`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const worker = new Plain(logger, 'worker', ['database']);
    const gate = deferred();
    worker.start = () => gate.promise;
    const cleanupEntered = deferred();
    const cleanupGate = deferred();
    worker.stop = () => {
      cleanupEntered.resolve();
      return cleanupGate.promise;
    };
    Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    expect((await manager.startComponent('worker')).code).toBe(
      'component_startup_timeout',
    );
    try {
      const result = await manager.stopAllComponents({ timeoutMS });
      expect(result.success).toBe(false);
      expect(manager.getComponentStatus('database')?.state).toBe('running');
      expect(result.timedOut).toBeUndefined();
      gate.resolve();
      await cleanupEntered.promise;
      const finishing = manager.stopAllComponents({ timeoutMS: 1000 });
      cleanupGate.resolve();
      expect((await finishing).success).toBe(true);
      expect(manager.getRunningComponentNames()).toEqual([]);
    } finally {
      gate.resolve();
      cleanupGate.resolve();
      await manager.stopAllComponents();
    }
  });
}

test('shutdown with no deadline avoids a start hook self-wait', async () => {
  const { logger, manager } = setup();
  const worker = new Plain(logger, 'worker');
  worker.start = async () => {
    const result = await manager.stopAllComponents({ timeoutMS: 0 });
    expect(result.success).toBe(false);
  };
  await manager.registerComponent(worker);
  expect((await manager.startComponent('worker')).code).toBe(
    'shutdown_in_progress',
  );
  expect(manager.getRunningComponentNames()).toEqual([]);
});

test('shutdown from the started event stops the newly running component in the same pass', async () => {
  const { logger, manager } = setup();
  const worker = new Plain(logger, 'worker');
  let stopCalls = 0;
  worker.stop = () => {
    stopCalls++;
    return Promise.resolve();
  };
  await manager.registerComponent(worker);
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  manager.once('component:started', () => {
    shutdown = manager.stopAllComponents({ timeoutMS: 1000 });
  });
  await manager.startComponent('worker');
  expect((await shutdown)?.success).toBe(true);
  expect(stopCalls).toBe(1);
  expect(manager.getRunningComponentNames()).toEqual([]);
});

for (const action of ['unregister', 'restart'] as const) {
  test(`abandoned start settlement is released on ${action}`, async () => {
    const { logger, manager } = setup();
    const worker = new Plain(logger, 'worker');
    worker.start = () => new Promise<void>(() => {});
    Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(worker);
    expect((await manager.startComponent('worker')).code).toBe(
      'component_startup_timeout',
    );
    const settlements = (
      manager as unknown as {
        startSettlements: Map<symbol, { promise: Promise<void> }>;
      }
    ).startSettlements;
    expect(settlements.size).toBe(1);
    const abandoned = [...settlements.values()][0].promise;
    if (action === 'unregister') {
      expect((await manager.unregisterComponent('worker')).success).toBe(true);
    } else {
      worker.start = () => Promise.resolve();
      expect((await manager.startComponent('worker')).success).toBe(true);
    }
    await abandoned;
    expect(settlements.size).toBe(0);
    await manager.stopAllComponents();
  });
}

test('failed automatic cleanup preserves dependencies after the start has settled', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const gate = deferred();
  worker.start = () => gate.promise;
  worker.stop = () => {
    throw new Error('stop failed');
  };
  worker.onShutdownForce = () => {
    throw new Error('force failed');
  };
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  const starting = manager.startComponent('worker');
  const shutdown = manager.stopAllComponents({ timeoutMS: 1000 });
  gate.resolve();
  await starting;
  expect((await shutdown).success).toBe(false);
  expect(manager.getComponentStatus('worker')?.state).toBe('stalled');
  expect(manager.getComponentStatus('database')?.state).toBe('running');
});

test('a pending late start without dependencies is still incomplete with no shutdown deadline', async () => {
  const { logger, manager } = setup();
  const worker = new Plain(logger, 'worker');
  const gate = deferred();
  worker.start = () => gate.promise;
  const cleanupEntered = deferred();
  const cleanupGate = deferred();
  worker.stop = () => {
    cleanupEntered.resolve();
    return cleanupGate.promise;
  };
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
  await manager.registerComponent(worker);
  await manager.startComponent('worker');
  try {
    expect((await manager.stopAllComponents({ timeoutMS: 0 })).success).toBe(
      false,
    );
    gate.resolve();
    await cleanupEntered.promise;
    const shutdown = manager.stopAllComponents({ timeoutMS: 1000 });
    cleanupGate.resolve();
    expect((await shutdown).success).toBe(true);
  } finally {
    gate.resolve();
    cleanupGate.resolve();
    await manager.stopAllComponents();
  }
});

for (const timeoutMS of [undefined, 100, 0]) {
  test(`a start can await its own shutdown request without consuming the deadline (${timeoutMS ?? 'default'})`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const worker = new Plain(logger, 'worker', ['database']);
    let shutdownResult:
      Awaited<ReturnType<typeof manager.stopAllComponents>> | undefined;
    let databaseStateAtReturn: string | undefined;
    worker.start = async () => {
      shutdownResult = await manager.stopAllComponents({ timeoutMS });
      databaseStateAtReturn = manager.getComponentStatus('database')?.state;
    };
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    expect((await manager.startComponent('worker')).code).toBe(
      'shutdown_in_progress',
    );
    expect(shutdownResult?.success).toBe(false);
    expect(shutdownResult?.timedOut).toBeUndefined();
    expect(shutdownResult?.code).not.toBe('shutdown_timeout');
    expect(databaseStateAtReturn).toBe('running');
    expect(manager.getComponentStatus('worker')?.state).toBe('stopped');
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    expect((await manager.stopAllComponents()).success).toBe(true);
  });
}

for (const timeoutMS of [undefined, 100, 0]) {
  test(`a start that yields can await its own shutdown through its lifecycle handle (${timeoutMS ?? 'default'})`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const worker = new Plain(logger, 'worker', ['database']);
    // With every deadline disabled, joining this start would wait forever.
    Object.defineProperty(worker, 'startupTimeoutMS', { value: 0 });
    let shutdownResult:
      Awaited<ReturnType<typeof manager.stopAllComponents>> | undefined;
    let databaseStateAtReturn: string | undefined;
    worker.start = async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const { lifecycle } = worker as unknown as {
        lifecycle: ComponentLifecycleRef;
      };
      shutdownResult = await lifecycle.stopAllComponents({ timeoutMS });
      databaseStateAtReturn = manager.getComponentStatus('database')?.state;
    };
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    expect((await manager.startComponent('worker')).code).toBe(
      'shutdown_in_progress',
    );
    expect(shutdownResult?.success).toBe(false);
    expect(shutdownResult?.timedOut).toBeUndefined();
    expect(shutdownResult?.code).not.toBe('shutdown_timeout');
    expect(databaseStateAtReturn).toBe('running');
    expect(manager.getComponentStatus('worker')?.state).toBe('stopped');
    expect((await manager.stopAllComponents()).success).toBe(true);
  });
}

test('shutdown requested after a start hook yields is bounded by its deadline', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const timeoutMS = 100;
  let shutdownResult:
    Awaited<ReturnType<typeof manager.stopAllComponents>> | undefined;
  let databaseStateAtReturn: string | undefined;
  let elapsedMS = 0;
  worker.start = async () => {
    // Leave the synchronous invocation guard before requesting shutdown.
    await Promise.resolve();
    const startedAt = performance.now();
    shutdownResult = await manager.stopAllComponents({ timeoutMS });
    elapsedMS = performance.now() - startedAt;
    databaseStateAtReturn = manager.getComponentStatus('database')?.state;
  };
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  try {
    const result = await manager.startComponent('worker');
    expect(shutdownResult).toMatchObject({
      success: false,
      code: 'shutdown_timeout',
      timedOut: true,
    });
    // Allow timer precision and loaded CI runners without asserting exact timing.
    expect(elapsedMS).toBeGreaterThanOrEqual(timeoutMS - 10);
    expect(elapsedMS).toBeLessThan(1000);
    expect(result.code).toBe('shutdown_in_progress');
    expect(databaseStateAtReturn).toBe('running');
    expect(manager.getComponentStatus('worker')?.state).toBe('stopped');
    expect((await manager.stopAllComponents()).success).toBe(true);
    expect(manager.getRunningComponentNames()).toEqual([]);
  } finally {
    await manager.stopAllComponents();
  }
});

test('repeated shutdowns promptly protect dependencies of a never-settling timed-out start', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const unrelated = new Plain(logger, 'unrelated');
  worker.start = () => new Promise<void>(() => {});
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.registerComponent(unrelated);
  await manager.startComponent('database');
  await manager.startComponent('unrelated');
  expect((await manager.startComponent('worker')).code).toBe(
    'component_startup_timeout',
  );
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await manager.stopAllComponents({ timeoutMS: 1000 });
      expect(result.success).toBe(false);
      expect(result.timedOut).toBeUndefined();
      expect(result.reason).toContain('Shutdown is still in progress for:');
      expect(manager.getComponentStatus('database')?.state).toBe('running');
      expect(manager.getComponentStatus('unrelated')?.state).toBe('stopped');
    }
  } finally {
    await manager.unregisterComponent('worker');
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('stop rechecks dependency getter changes without a registration change', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker');
  let hasDependency = false;
  worker.getDependencies = () => (hasDependency ? ['database'] : []);
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startAllComponents();
  Object.defineProperty(database, 'onShutdownForce', {
    get() {
      hasDependency = true;
      return undefined;
    },
  });
  try {
    expect((await manager.stopComponent('database')).code).toBe(
      'has_running_dependents',
    );
    expect(manager.getComponentStatus('database')?.state).toBe('running');
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('shutdown promptly reports an unresolved bulk-timed-out start with nothing running', async () => {
  const { logger, manager } = setup();
  const worker = new Plain(logger, 'worker');
  worker.start = () => new Promise<void>(() => {});
  await manager.registerComponent(worker);
  expect((await manager.startAllComponents({ timeoutMS: 5 })).code).toBe(
    'startup_timeout',
  );
  expect(manager.getRunningComponentNames()).toEqual([]);
  try {
    const result = await manager.stopAllComponents({ timeoutMS: 1000 });
    expect(result.success).toBe(false);
    expect(result.timedOut).toBeUndefined();
    expect(result.reason).toContain('worker');
  } finally {
    await manager.unregisterComponent('worker');
    await manager.stopAllComponents();
    await logger.close();
  }
});

for (const hasDependency of [false, true]) {
  test(`shutdown promptly reports a hung optional start (dependency: ${hasDependency})`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const cache = new Plain(logger, 'cache', hasDependency ? ['database'] : []);
    const api = new Plain(logger, 'api', ['database']);
    cache.isOptional = () => true;
    cache.start = () => new Promise<void>(() => {});
    Object.defineProperty(cache, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(database);
    await manager.registerComponent(cache);
    await manager.registerComponent(api);
    expect((await manager.startAllComponents()).success).toBe(true);
    expect(manager.getComponentStatus('cache')?.state).toBe('failed');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await manager.stopAllComponents({ timeoutMS: 50 });
        expect(result.timedOut).toBeUndefined();
        expect(result.success).toBe(false);
        expect(result.reason).toContain('cache');
        expect(manager.getComponentStatus('database')?.state).toBe(
          hasDependency ? 'running' : 'stopped',
        );
        expect(manager.getComponentStatus('api')?.state).toBe('stopped');
      }
    } finally {
      await manager.unregisterComponent('cache');
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test.each([0, 1000])(
  'shutdown joins late cleanup of an optional start recorded as failed (budget: %s)',
  async (timeoutMS) => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const cache = new Plain(logger, 'cache', ['database']);
    const startGate = deferred();
    const cleanupEntered = deferred();
    const cleanupGate = deferred();
    cache.isOptional = () => true;
    cache.start = () => startGate.promise;
    const order: string[] = [];
    database.stop = () => {
      order.push('database');
      return Promise.resolve();
    };
    cache.stop = async () => {
      cleanupEntered.resolve();
      await cleanupGate.promise;
      order.push('cache');
    };
    Object.defineProperty(cache, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(database);
    await manager.registerComponent(cache);
    await manager.startAllComponents();
    try {
      expect(manager.getComponentStatus('cache')?.state).toBe('failed');
      startGate.resolve();
      await cleanupEntered.promise;
      const stopping = manager.stopAllComponents({ timeoutMS });
      expect(manager.getComponentStatus('database')?.state).toBe('running');
      cleanupGate.resolve();
      expect((await stopping).success).toBe(true);
      expect(order).toEqual(['cache', 'database']);
      expect(manager.getRunningComponentNames()).toEqual([]);
    } finally {
      startGate.resolve();
      cleanupGate.resolve();
      await manager.stopAllComponents();
      await logger.close();
    }
  },
);

for (const hasDependency of [false, true]) {
  test(`restart skips startup while optional late recovery is pending (dependency: ${hasDependency})`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const cache = new Plain(logger, 'cache', hasDependency ? ['database'] : []);
    let startCalls = 0;
    cache.isOptional = () => true;
    cache.start = () => {
      startCalls++;
      return new Promise<void>(() => {});
    };
    Object.defineProperty(cache, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(database);
    await manager.registerComponent(cache);
    await manager.startAllComponents();
    try {
      const result = await manager.restartAllComponents({
        shutdownTimeoutMS: 1000,
      });
      expect(result.shutdownResult.code).toBe('cleanup_incomplete');
      expect(result.startupResult.success).toBe(false);
      expect(result.startupResult.reason).toContain('startup skipped');
      expect(startCalls).toBe(1);
    } finally {
      await manager.unregisterComponent('cache');
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test('individual stop protects dependencies throughout optional late startup recovery', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const cache = new Plain(logger, 'cache', ['database']);
  const startGate = deferred();
  const cleanupEntered = deferred();
  const cleanupGate = deferred();
  const order: string[] = [];
  cache.isOptional = () => true;
  cache.start = () => startGate.promise;
  cache.stop = async () => {
    cleanupEntered.resolve();
    await cleanupGate.promise;
    order.push('cache');
  };
  database.stop = () => {
    order.push('database');
    return Promise.resolve();
  };
  Object.defineProperty(cache, 'startupTimeoutMS', { value: 5 });
  await manager.registerComponent(database);
  await manager.registerComponent(cache);
  await manager.startAllComponents();
  try {
    expect((await manager.stopComponent('database')).code).toBe(
      'has_running_dependents',
    );
    startGate.resolve();
    await cleanupEntered.promise;
    expect((await manager.stopComponent('database')).code).toBe(
      'has_running_dependents',
    );
    const stopping = manager.stopAllComponents({ timeoutMS: 1000 });
    cleanupGate.resolve();
    expect((await stopping).success).toBe(true);
    expect(order).toEqual(['cache', 'database']);
  } finally {
    startGate.resolve();
    cleanupGate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('synchronous logger exit followed by a start throw still stops dependencies', async () => {
  const { logger, manager } = setup({ enableLoggerExitHook: true });
  const database = new Plain(logger, 'database');
  const api = new Plain(logger, 'api', ['database']);
  const exited = deferred();
  const order: string[] = [];
  logger.on('logger', (event) => {
    if ((event as { eventType: string }).eventType === 'exit-process') {
      exited.resolve();
    }
  });
  database.stop = () => {
    order.push('database');
    return Promise.resolve();
  };
  api.start = () => {
    logger.error('fatal startup', { exitCode: 1 });
    return Promise.reject(new Error('startup failed'));
  };
  await manager.registerComponent(database);
  await manager.registerComponent(api);
  await manager.startComponent('database');
  try {
    await manager.startComponent('api');
    await exited.promise;
    expect(order).toEqual(['database']);
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('concurrent shutdown retains its established refusal reason', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const entered = deferred();
  const gate = deferred();
  database.stop = () => {
    entered.resolve();
    return gate.promise;
  };
  await manager.registerComponent(database);
  await manager.startComponent('database');
  const shutdown = manager.stopAllComponents();
  try {
    await entered.promise;
    const refused = await manager.stopAllComponents();
    expect(refused.code).toBe('already_in_progress');
    expect(refused.reason).toBe('Shutdown already in progress');
  } finally {
    gate.resolve();
    await shutdown;
    await logger.close();
  }
});

test('zero-deadline shutdown releases its latch when a live start times out and never settles', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  worker.start = () => new Promise<void>(() => {});
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 10 });
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  const starting = manager.startComponent('worker');
  try {
    const result = await manager.stopAllComponents({ timeoutMS: 0 });
    expect(result.code).toBe('cleanup_incomplete');
    expect(result.timedOut).toBeUndefined();
    expect((await starting).code).toBe('component_startup_timeout');
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    const next = await manager.stopAllComponents({ timeoutMS: 0 });
    expect(next.code).toBe('cleanup_incomplete');
  } finally {
    await manager.unregisterComponent('worker');
    await manager.stopAllComponents();
    await logger.close();
  }
}, 1000);
