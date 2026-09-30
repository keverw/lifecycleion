import { expect, test } from 'bun:test';
import { claimReports, deferred, Plain, setup } from './test-helpers';

for (const hasStartupTimedOut of [false, true]) {
  for (const timeoutMS of [0, 1000]) {
    test(`explicit pending-start override stops dependencies without waiting (timed out: ${hasStartupTimedOut}, budget: ${timeoutMS})`, async () => {
      const { logger, manager } = setup({ shutdownWarningTimeoutMS: 100 });
      const database = new Plain(logger, 'database');
      const worker = new Plain(logger, 'worker', ['database']);
      const gate = deferred();
      const stopped = deferred();
      const order: string[] = [];
      let warnings = 0;
      database.onShutdownWarning = () => {
        warnings++;
      };
      database.stop = () => {
        order.push('database');
        return Promise.resolve();
      };
      worker.start = () => gate.promise;
      worker.stop = () => {
        order.push('worker');
        stopped.resolve();
        return Promise.resolve();
      };
      Object.defineProperty(worker, 'startupTimeoutMS', {
        value: hasStartupTimedOut ? 5 : 0,
      });
      await manager.registerComponent(database);
      await manager.registerComponent(worker);
      await manager.startComponent('database');
      const starting = manager.startComponent('worker');
      if (hasStartupTimedOut) {
        await starting;
      }
      const shutdown = manager.stopAllComponents({
        timeoutMS,
        allowStopWithPendingStarts: true,
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          shutdown,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error('shutdown waited for pending start')),
              250,
            );
          }),
        ]);
        expect(result.code).toBe('cleanup_incomplete');
        expect(result.success).toBe(false);
        expect(result.timedOut).not.toBe(true);
        expect(result.stoppedComponents).toContain('database');
        expect(result.reason).toContain('worker');
        expect(order).toEqual(['database']);
        expect(warnings).toBe(1);
        gate.resolve();
        await stopped.promise;
        await starting;
        expect(order).toEqual(['database', 'worker']);
      } finally {
        clearTimeout(deadline);
        gate.resolve();
        await starting;
        await shutdown;
        await manager.stopAllComponents();
        await logger.close();
      }
    });
  }
}

test('pending-start override still waits for automatic stop cleanup already underway', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const start = deferred();
  const cleanup = deferred();
  const cleaning = deferred();
  worker.start = () => start.promise;
  worker.stop = () => {
    cleaning.resolve();
    return cleanup.promise;
  };
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  await manager.startComponent('worker');
  start.resolve();
  await cleaning.promise;
  const shutdown = manager.stopAllComponents({
    timeoutMS: 1000,
    allowStopWithPendingStarts: true,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    cleanup.resolve();
    expect((await shutdown).success).toBe(true);
    expect(manager.getComponentStatus('database')?.state).toBe('stopped');
  } finally {
    cleanup.resolve();
    await shutdown;
    await logger.close();
  }
});

test('throwing pending-start option is refused before shutdown begins', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'database'));
  await manager.startComponent('database');
  const { release } = claimReports();
  try {
    const result = await manager.stopAllComponents({
      get allowStopWithPendingStarts(): boolean {
        throw new Error('bad option');
      },
    });
    expect(result.success).toBe(false);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    expect((await manager.stopAllComponents()).success).toBe(true);
  } finally {
    release();
    await logger.close();
  }
});

for (const allowStopWithPendingStarts of [undefined, false]) {
  test(`configured override respects a per-call false: ${allowStopWithPendingStarts}`, async () => {
    const { logger, manager } = setup({
      shutdownOptions: { allowStopWithPendingStarts: true },
    });
    const database = new Plain(logger, 'database');
    const worker = new Plain(logger, 'worker', ['database']);
    const gate = deferred();
    worker.start = () => gate.promise;
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    const starting = manager.startComponent('worker');
    const shutdown = manager.stopAllComponents({
      timeoutMS: 1000,
      allowStopWithPendingStarts,
    });
    try {
      if (allowStopWithPendingStarts === false) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(manager.getComponentStatus('database')?.state).toBe('running');
        gate.resolve();
        expect((await shutdown).success).toBe(true);
      } else {
        expect((await shutdown).code).toBe('cleanup_incomplete');
        expect(manager.getComponentStatus('database')?.state).toBe('stopped');
      }
    } finally {
      gate.resolve();
      await starting;
      await shutdown;
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test('pending-start override does not bypass an independently stopping dependent', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const service = new Plain(logger, 'service', ['database']);
  const gate = deferred();
  service.stop = () => gate.promise;
  await manager.registerComponent(database);
  await manager.registerComponent(service);
  await manager.startAllComponents();
  const stopping = manager.stopComponent('service');
  try {
    const result = await manager.stopAllComponents({
      allowStopWithPendingStarts: true,
      haltOnStall: false,
    });
    expect(result.success).toBe(false);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
  } finally {
    gate.resolve();
    await stopping;
    await manager.stopAllComponents();
    await logger.close();
  }
});

for (const hasStartupTimedOut of [false, true]) {
  test(`restart does not inherit the pending-start override (timed out: ${hasStartupTimedOut})`, async () => {
    const { logger, manager } = setup({
      shutdownOptions: { allowStopWithPendingStarts: true },
    });
    const database = new Plain(logger, 'database');
    const worker = new Plain(logger, 'worker', ['database']);
    const gate = deferred();
    let databaseStops = 0;
    let workerStarts = 0;
    database.stop = () => {
      databaseStops++;
      return Promise.resolve();
    };
    worker.start = () => {
      workerStarts++;
      return gate.promise;
    };
    Object.defineProperty(worker, 'startupTimeoutMS', {
      value: hasStartupTimedOut ? 5 : 0,
    });
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    const starting = manager.startComponent('worker');
    if (hasStartupTimedOut) {
      await starting;
    }
    try {
      const result = await manager.restartAllComponents({
        shutdownTimeoutMS: 30,
      });
      expect(result.success).toBe(false);
      expect(result.shutdownResult.code).toBe(
        hasStartupTimedOut ? 'cleanup_incomplete' : 'shutdown_timeout',
      );
      expect(result.startupResult.success).toBe(false);
      expect(databaseStops).toBe(0);
      expect(workerStarts).toBe(1);
      expect(manager.getComponentStatus('database')?.state).toBe('running');
    } finally {
      gate.resolve();
      await starting;
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

for (const hasStartupTimedOut of [false, true]) {
  for (const timeoutMS of [0, 1000]) {
    test(`pending-start override preserves remaining dependencies when cleanup begins between stops (timed out: ${hasStartupTimedOut}, budget: ${timeoutMS})`, async () => {
      const { logger, manager } = setup();
      const database = new Plain(logger, 'database');
      const cache = new Plain(logger, 'cache');
      const worker = new Plain(logger, 'worker', ['database', 'cache']);
      const start = deferred();
      const cleanup = deferred();
      const cleaning = deferred();
      const order: string[] = [];
      worker.start = () => start.promise;
      worker.stop = () => {
        order.push('worker');
        cleaning.resolve();
        return cleanup.promise;
      };
      Object.defineProperty(worker, 'startupTimeoutMS', {
        value: hasStartupTimedOut ? 5 : 0,
      });
      cache.stop = async () => {
        order.push('cache');
        start.resolve();
        await cleaning.promise;
      };
      database.stop = () => {
        order.push('database');
        return Promise.resolve();
      };
      await manager.registerComponent(database);
      await manager.registerComponent(cache);
      await manager.registerComponent(worker);
      await manager.startComponent('database');
      await manager.startComponent('cache');
      const starting = manager.startComponent('worker');
      if (hasStartupTimedOut) {
        await starting;
      }
      const shutdown = manager.stopAllComponents({
        timeoutMS,
        allowStopWithPendingStarts: true,
      });
      try {
        const result = await shutdown;
        expect(result.success).toBe(false);
        expect(result.code).toBe('cleanup_incomplete');
        expect(result.timedOut).not.toBe(true);
        expect(order).toEqual(['cache', 'worker']);
        expect(manager.getComponentStatus('database')?.state).toBe('running');
        cleanup.resolve();
        await starting;
        expect((await manager.stopAllComponents()).success).toBe(true);
      } finally {
        start.resolve();
        cleanup.resolve();
        await starting;
        await shutdown;
        await manager.stopAllComponents();
        await logger.close();
      }
    });
  }
}

test('pending-start override preserves dependencies when automatic cleanup stalls between stops', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const cache = new Plain(logger, 'cache');
  const worker = new Plain(logger, 'worker', ['database', 'cache']);
  const start = deferred();
  worker.start = () => start.promise;
  worker.stop = () => Promise.reject(new Error('cleanup failed'));
  worker.onShutdownForce = () => {
    throw new Error('force cleanup failed');
  };
  await manager.registerComponent(database);
  await manager.registerComponent(cache);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  await manager.startComponent('cache');
  const starting = manager.startComponent('worker');
  cache.stop = async () => {
    start.resolve();
    await starting;
  };
  try {
    const result = await manager.stopAllComponents({
      allowStopWithPendingStarts: true,
      haltOnStall: false,
      retryStalled: false,
    });
    expect(result.success).toBe(false);
    expect(result.stalledComponents.map(({ name }) => name)).toContain(
      'worker',
    );
    expect(manager.getComponentStatus('database')?.state).toBe('running');
  } finally {
    start.resolve();
    await starting;
    worker.onShutdownForce = () => {};
    await manager.stopAllComponents({ retryStalled: true });
    await logger.close();
  }
});

for (const isForceImmediate of [false, true]) {
  test(`pending forced start preserves its stall and refuses another stop (force immediate: ${isForceImmediate})`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const worker = new Plain(logger, 'worker', ['database']);
    const oldStop = deferred();
    const start = deferred();
    const order: string[] = [];
    database.stop = () => {
      order.push('database');
      return Promise.resolve();
    };
    worker.stop = () => oldStop.promise;
    Object.defineProperty(worker, 'onShutdownForce', {
      value: undefined,
      writable: true,
    });
    Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startAllComponents();
    await manager.stopComponent('worker', { timeout: 5 });
    worker.start = () => start.promise;
    expect(
      (await manager.startComponent('worker', { forceStalled: true })).code,
    ).toBe('component_startup_timeout');
    expect(manager.getComponentStatus('worker')?.state).toBe('stalled');
    const { release } = claimReports();
    try {
      // Public individual stops cannot create a stopping/force-stopping state
      // over this stalled start. A forced stop still refuses the existing stall.
      const retry = await manager.stopComponent('worker', {
        forceImmediate: isForceImmediate,
      });
      expect(retry.code).toBe('component_stalled');
      expect(manager.getComponentStatus('worker')?.state).toBe('stalled');
      const result = await manager.stopAllComponents({
        timeoutMS: 100,
        retryStalled: false,
        haltOnStall: false,
        allowStopWithPendingStarts: true,
      });
      expect(result.success).toBe(false);
      expect(result.stoppedComponents).not.toContain('database');
      expect(manager.getComponentStatus('database')?.state).toBe('running');
      expect(order).toEqual([]);
    } finally {
      start.reject(new Error('test releases abandoned start'));
      oldStop.resolve();
      // Let the abandoned start observer and late stop finalize before another pass.
      await new Promise((resolve) => setTimeout(resolve, 0));
      worker.onShutdownForce = () => {};
      await manager.stopAllComponents({ retryStalled: true });
      release();
      await logger.close();
    }
  });
}

for (const allowStopWithPendingStarts of [false, true]) {
  test(`hook-aborted pending start honors dependency override: ${allowStopWithPendingStarts}`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const worker = new Plain(logger, 'worker', ['database']);
    const start = deferred();
    let aborts = 0;
    let databaseStops = 0;
    let workerStops = 0;
    database.stop = () => {
      databaseStops++;
      return Promise.resolve();
    };
    worker.start = () => start.promise;
    worker.stop = () => {
      workerStops++;
      return Promise.resolve();
    };
    worker.onStartupAborted = () => {
      aborts++;
    };
    Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(database);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    const starting = await manager.startComponent('worker');
    try {
      expect(starting.code).toBe('component_startup_timeout');
      expect(aborts).toBe(1);
      const result = await manager.stopAllComponents({
        timeoutMS: 100,
        allowStopWithPendingStarts,
      });
      expect(result.code).toBe('cleanup_incomplete');
      expect(result.timedOut).not.toBe(true);
      expect(databaseStops).toBe(allowStopWithPendingStarts ? 1 : 0);
      expect(workerStops).toBe(0);
      expect(manager.getComponentStatus('database')?.state).toBe(
        allowStopWithPendingStarts ? 'stopped' : 'running',
      );
      // An abort hook owns the late cleanup; the manager must not add a stop.
      start.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect((await manager.stopAllComponents()).success).toBe(true);
      expect(workerStops).toBe(0);
    } finally {
      start.resolve();
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test('override joins cleanup that begins during the shutdown warning before stopping dependencies', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 1000 });
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const start = deferred();
  const cleaning = deferred();
  const cleanup = deferred();
  const warned = deferred();
  const order: string[] = [];
  worker.start = () => start.promise;
  worker.stop = () => {
    order.push('worker');
    cleaning.resolve();
    return cleanup.promise;
  };
  database.stop = () => {
    order.push('database');
    return Promise.resolve();
  };
  database.onShutdownWarning = async () => {
    start.resolve();
    await cleaning.promise;
    warned.resolve();
  };
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  const starting = manager.startComponent('worker');
  const shutdown = manager.stopAllComponents({
    timeoutMS: 1000,
    allowStopWithPendingStarts: true,
  });
  let didFinish = false;
  void shutdown.then(() => {
    didFinish = true;
  });
  try {
    await warned.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(didFinish).toBe(false);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    cleanup.resolve();
    expect((await shutdown).success).toBe(true);
    expect(order).toEqual(['worker', 'database']);
  } finally {
    start.resolve();
    cleanup.resolve();
    await starting;
    await shutdown;
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('override rechecks transitive dependencies added after cleanup protection begins', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const changer = new Plain(logger, 'changer');
  const trigger = new Plain(logger, 'trigger');
  const bridge = new Plain(logger, 'bridge');
  const worker = new Plain(logger, 'worker', ['bridge']);
  // This second pending start puts the stop hooks behind the initial join.
  // The first hook can then begin worker cleanup before later stop checkpoints.
  const another = new Plain(logger, 'another', [
    'database',
    'changer',
    'trigger',
  ]);
  const anotherStart = deferred();
  another.start = () => anotherStart.promise;
  const start = deferred();
  const cleaning = deferred();
  const cleanup = deferred();
  let bridgeDependencies: string[] = [];
  let databaseStops = 0;
  bridge.getDependencies = () => bridgeDependencies;
  database.stop = () => {
    databaseStops++;
    return Promise.resolve();
  };
  worker.start = () => start.promise;
  worker.stop = () => {
    cleaning.resolve();
    return cleanup.promise;
  };
  trigger.stop = async () => {
    start.resolve();
    await cleaning.promise;
  };
  changer.stop = () => {
    // The preceding stop let worker enter cleanup, protecting bridge. Its
    // dependency list can still change before database's stop boundary.
    bridgeDependencies = ['database'];
    return Promise.resolve();
  };
  for (const component of [
    database,
    bridge,
    changer,
    trigger,
    worker,
    another,
  ]) {
    await manager.registerComponent(component);
  }
  for (const name of ['database', 'changer', 'trigger', 'bridge']) {
    await manager.startComponent(name);
  }
  const starting = manager.startComponent('worker');
  const anotherStarting = manager.startComponent('another');
  try {
    const result = await manager.stopAllComponents({
      allowStopWithPendingStarts: true,
      timeoutMS: 1000,
    });
    expect(result.code).toBe('cleanup_incomplete');
    expect(databaseStops).toBe(0);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    expect(manager.getComponentStatus('bridge')?.state).toBe('running');
  } finally {
    start.resolve();
    cleanup.resolve();
    anotherStart.resolve();
    await starting;
    await anotherStarting;
    await manager.stopAllComponents();
    await logger.close();
  }
});
