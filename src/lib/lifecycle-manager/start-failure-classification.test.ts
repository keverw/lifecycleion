import { expect, test } from 'bun:test';
import { ComponentStartTimeoutError } from './errors';
import { claimReports, deferred, Plain, setup } from './test-helpers';

test.each([false, true])(
  'forced-start events distinguish success from shutdown cleanup (shutdown began: %s)',
  async (hasShutdownBegun) => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const oldStop = deferred<void>();
    const start = deferred<void>();
    let stops = 0;
    component.stop = () =>
      ++stops === 1 ? oldStop.promise : Promise.resolve();
    Object.defineProperty(component, 'onShutdownForce', { value: undefined });
    Object.defineProperty(component, 'startupTimeoutMS', { value: 0 });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    await manager.stopComponent('a', { timeout: 5 });
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
    const events: string[] = [];
    manager.on('component:started', () => {
      events.push('started');
    });
    manager.on('component:stopped', () => {
      events.push('stopped');
    });
    manager.on('component:stalled-resolved', () => {
      events.push('stalled-resolved');
    });
    component.start = () => start.promise;
    const starting = manager.startComponent('a', { forceStalled: true });
    const shutdown = hasShutdownBegun
      ? manager.stopAllComponents({ timeoutMS: 0 })
      : undefined;
    try {
      start.resolve();
      const result = await starting;
      await shutdown;
      expect(result.success).toBe(!hasShutdownBegun);
      if (hasShutdownBegun) {
        expect(result.code).toBe('shutdown_in_progress');
      }
      expect(events).toEqual([hasShutdownBegun ? 'stopped' : 'started']);
      expect(manager.getComponentStatus('a')?.state).toBe(
        hasShutdownBegun ? 'stopped' : 'running',
      );
      expect(manager.getComponentStatus('a')?.stallInfo).toBeNull();
      oldStop.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual([hasShutdownBegun ? 'stopped' : 'started']);
    } finally {
      start.resolve();
      oldStop.resolve();
      await starting;
      await shutdown;
      await manager.stopAllComponents();
      await logger.close();
    }
  },
);

test.each(['rejection', 'timeout'] as const)(
  'failed forceStalled start preserves late stop ownership: %s',
  async (mode) => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const stop = deferred<void>();
    component.stop = () => stop.promise;
    Object.defineProperty(component, 'onShutdownForce', { value: undefined });
    Object.defineProperty(component, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    await manager.stopComponent('a', { timeout: 5 });
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
    component.start =
      mode === 'rejection'
        ? () => Promise.reject(new Error('failed'))
        : () => new Promise(() => {});
    let resolved = 0;
    let stopped = 0;
    manager.on('component:stalled-resolved', () => {
      resolved++;
    });
    manager.on('component:stopped', () => {
      stopped++;
    });
    const { release } = claimReports();
    try {
      const result = await manager.startComponent('a', { forceStalled: true });
      expect(result.success).toBe(false);
      expect(manager.getComponentStatus('a')?.state).toBe('stalled');
      expect(manager.getStartTimedOutComponentNames()).toEqual([]);
      stop.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(manager.getComponentStatus('a')?.state).toBe('stopped');
      expect(resolved).toBe(1);
      expect(stopped).toBe(1);
    } finally {
      stop.resolve();
      await manager.unregisterComponent('a');
      release();
      await logger.close();
    }
  },
);

test('component-thrown startup timeout error is a handler failure', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const failure = new ComponentStartTimeoutError({
    componentName: 'a',
    timeoutMS: 60000,
  });
  component.start = () => Promise.reject(failure);
  await manager.registerComponent(component);
  let timeouts = 0;
  manager.on('component:start-timeout', () => {
    timeouts++;
  });
  const { release } = claimReports();
  try {
    const result = await manager.startComponent('a');
    expect(result.code).toBe('unknown_error');
    expect(result.error).toBe(failure);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
    expect(timeouts).toBe(0);
  } finally {
    release();
    await logger.close();
  }
});

test.each([false, true])(
  'timed-out forceStalled start receives cleanup after old stop settled: %s',
  async (hasOldStopSettled) => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const oldStop = deferred<void>();
    const lateStart = deferred<void>();
    const cleanup = deferred<void>();
    let stops = 0;
    const retired: Array<string | undefined> = [];
    manager.on('component:stalled-resolved', (event) => {
      retired.push((event as { reason?: string }).reason);
    });
    component.stop = () => (++stops === 1 ? oldStop.promise : cleanup.promise);
    Object.defineProperty(component, 'onShutdownForce', { value: undefined });
    Object.defineProperty(component, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    await manager.stopComponent('a', { timeout: 5 });
    component.start = () => lateStart.promise;
    try {
      const startResult = await manager.startComponent('a', {
        forceStalled: true,
      });
      expect(startResult.code).toBe('component_startup_timeout');
      expect(startResult.error).toBeInstanceOf(ComponentStartTimeoutError);
      expect(manager.getComponentStatus('a')?.state).toBe('stalled');
      if (hasOldStopSettled) {
        oldStop.resolve();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(manager.getComponentStatus('a')?.state).toBe('stopped');
      }
      lateStart.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(retired).toEqual([
        hasOldStopSettled ? undefined : 'late-start-cleanup',
      ]);
      expect(stops).toBe(2);
      expect(manager.getComponentStatus('a')?.state).toBe('stopping');
      cleanup.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(manager.getComponentStatus('a')?.state).toBe(
        hasOldStopSettled ? 'stopped' : 'starting-timed-out',
      );
      expect(manager.getComponentStatus('a')?.stallInfo).toBeNull();
      expect(manager.getComponentStatus('a')?.lastError).toBe(
        hasOldStopSettled ? null : startResult.error,
      );
      oldStop.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(retired).toHaveLength(1);
    } finally {
      oldStop.resolve();
      cleanup.resolve();
      lateStart.resolve();
      await manager.unregisterComponent('a');
      await logger.close();
    }
  },
);

test('old force completion cannot overwrite late startup after automatic cleanup refuses invalid options', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const oldForce = deferred<void>();
  const lateStart = deferred<void>();
  const retired = deferred<void>();
  const { release } = claimReports();
  let starts = 0;
  let stops = 0;
  let forces = 0;
  let shouldFailStop = true;
  component.start = () =>
    ++starts === 2 ? lateStart.promise : Promise.resolve();
  component.stop = () => {
    stops++;
    return shouldFailStop
      ? Promise.reject(new Error('graceful stop failed'))
      : Promise.resolve();
  };
  Object.defineProperty(component, 'onShutdownForce', {
    value: () => {
      forces++;
      return oldForce.promise;
    },
  });
  Object.defineProperty(component, 'shutdownForceTimeoutMS', { value: 5 });
  Object.defineProperty(component, 'startupTimeoutMS', { value: 5 });
  const gracefulTimeout = component.shutdownGracefulTimeoutMS;
  manager.on('component:stalled-resolved', (event) => {
    if ((event as { reason?: string }).reason === 'late-start-cleanup') {
      Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
        value: -1,
        configurable: true,
      });
      retired.resolve();
    }
  });
  try {
    await manager.registerComponent(component);
    expect((await manager.startComponent('a')).success).toBe(true);
    expect((await manager.stopComponent('a')).code).toBe(
      'component_shutdown_timeout',
    );
    expect(
      (await manager.startComponent('a', { forceStalled: true })).code,
    ).toBe('component_startup_timeout');
    lateStart.resolve();
    await retired.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.getComponentStatus('a')?.state).toBe('running');
    expect(manager.getComponentStatus('a')?.stallInfo).toBeNull();
    expect(stops).toBe(1);
    expect(forces).toBe(1);
    oldForce.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.getComponentStatus('a')?.state).toBe('running');
    expect(manager.getComponentStatus('a')?.stallInfo).toBeNull();
    expect(manager.getComponentInstance('a')).toBe(component);
    expect(starts).toBe(2);
    expect(stops).toBe(1);
    expect(forces).toBe(1);
  } finally {
    oldForce.resolve();
    lateStart.resolve();
    shouldFailStop = false;
    Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
      value: gracefulTimeout,
      configurable: true,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await manager.stopAllComponents();
    release();
    await logger.close();
  }
});

test.each(['restart', 'replacement'] as const)(
  'retirement listener %s leaves the later run untouched by stale cleanup',
  async (mode) => {
    const { logger, manager } = setup();
    const original = new Plain(logger, 'a');
    const replacement = new Plain(logger, 'a');
    const oldStop = deferred<void>();
    const lateStart = deferred<void>();
    const retired = deferred<void>();
    let starts = 0;
    let stops = 0;
    let replacementStops = 0;
    original.start = () => {
      starts++;
      return starts === 2 ? lateStart.promise : Promise.resolve();
    };
    original.stop = () => {
      stops++;
      return stops === 1 ? oldStop.promise : Promise.resolve();
    };
    replacement.stop = () => {
      replacementStops++;
      return Promise.resolve();
    };
    Object.defineProperty(original, 'onShutdownForce', { value: undefined });
    Object.defineProperty(original, 'startupTimeoutMS', { value: 5 });
    await manager.registerComponent(original);
    await manager.startComponent('a');
    await manager.stopComponent('a', { timeout: 5 });
    let reentry: Promise<void> | undefined;
    manager.on('component:stalled-resolved', (event) => {
      if ((event as { reason?: string }).reason !== 'late-start-cleanup') {
        return;
      }
      // Direct replacement is blocked while the old start owns cleanup. A
      // restart can claim that cleanup stop, then start once its guard clears.
      const unregister = manager.unregisterComponent('a', {
        stopIfRunning: false,
      });
      const restart = manager.restartComponent('a');
      reentry = (async () => {
        expect(await unregister).toMatchObject({
          success: false,
          code: 'bulk_operation_in_progress',
        });
        expect((await restart).success).toBe(true);
        if (mode === 'replacement') {
          expect((await manager.unregisterComponent('a')).success).toBe(true);
          expect((await manager.registerComponent(replacement)).success).toBe(
            true,
          );
          expect((await manager.startComponent('a')).success).toBe(true);
        }
      })();
      retired.resolve();
    });
    try {
      expect(
        (await manager.startComponent('a', { forceStalled: true })).success,
      ).toBe(false);
      lateStart.resolve();
      await retired.promise;
      await reentry;
      expect(starts).toBe(3);
      const current = mode === 'replacement' ? replacement : original;
      expect(manager.getComponentInstance('a')).toBe(current);
      expect(manager.getComponentStatus('a')?.state).toBe('running');
      const completedStops = stops;
      oldStop.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(manager.getComponentInstance('a')).toBe(current);
      expect(manager.getComponentStatus('a')?.state).toBe('running');
      expect(manager.getComponentStatus('a')?.stallInfo).toBeNull();
      expect(stops).toBe(completedStops);
      expect(replacementStops).toBe(0);
    } finally {
      oldStop.resolve();
      lateStart.resolve();
      await reentry?.catch(() => {});
      await manager.stopAllComponents();
      await logger.close();
    }
  },
);
