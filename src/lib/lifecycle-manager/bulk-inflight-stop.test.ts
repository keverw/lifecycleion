import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import { deferred, fakeSignals, Plain, Stalls } from './test-helpers';

test.each([false, true])(
  'follow-up automatic signal-attachment cleanup returns partial state without rollback (optional: %s)',
  async (isOptional) => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      attachSignalsOnStart: true,
      shutdownWarningTimeoutMS: -1,
    });
    const root = new Plain(logger, 'root');
    const followup = new Plain(logger, 'followup');
    const unattempted = new Plain(logger, 'unattempted');
    followup.isOptional = () => isOptional;
    const stopGate = deferred();
    const stopEntered = deferred();
    let rootStops = 0;
    let followupStops = 0;
    root.stop = () => {
      rootStops++;
      return Promise.resolve();
    };
    followup.stop = async () => {
      followupStops++;
      stopEntered.resolve();
      await stopGate.promise;
    };
    fakeSignals(manager);
    const attach = manager.attachSignals.bind(manager);
    let attachAttempts = 0;
    // Fail the first transport attachment. The real public startup path performs
    // its automatic stop; no private stop guard or component state is bypassed.
    manager.attachSignals = () => {
      if (++attachAttempts === 1) {
        throw new Error('signal transport unavailable once');
      }
      attach();
    };
    let independent: ReturnType<typeof manager.startComponent> | undefined;
    root.start = async () => {
      expect(
        await manager.registerComponent(followup, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
      expect(
        await manager.registerComponent(unattempted, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
      independent = manager.startComponent('followup', {
        allowDuringBulkStartup: true,
      });
      await stopEntered.promise;
    };
    await manager.registerComponent(root);
    try {
      const result = await manager.startAllComponents({ timeoutMS: 0 });
      expect(result).toMatchObject({
        success: false,
        code: 'partial_state',
        startedComponents: ['root'],
        failedOptionalComponents: [],
      });
      expect(result.reason).toContain('independent stop');
      expect(rootStops).toBe(0);
      expect(followupStops).toBe(1);
      expect(manager.getComponentStatus('followup')?.state).toBe('stopping');
      expect(manager.getComponentStatus('unattempted')?.state).toBe(
        'registered',
      );
      const warning = sink.logs.find((entry) =>
        entry.message.includes('deferred auto-starts were not attempted'),
      );
      expect(warning?.params).toMatchObject({
        components: ['unattempted'],
        reason: 'was interrupted by independent component stop',
      });
    } finally {
      stopGate.resolve();
      expect((await independent)?.code).toBe('signal_attach_failed');
      await manager.stopAllComponents();
      manager.detachSignals();
    }
  },
);

test('a concurrent stop that stalls during the pass is reported as stalled, not still in progress', async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const slow = new Plain(logger, 'slow');
  const stalls = new Stalls(logger, 'stalls');
  // Still stopping `slow` when the concurrent stop of `stalls` fails and stalls.
  slow.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
  stalls.stop = () =>
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('stop failed')), 20),
    );
  await manager.registerComponent(slow);
  await manager.registerComponent(stalls);
  await manager.startAllComponents();

  const individual = manager.stopComponent('stalls');
  const result = await manager.stopAllComponents({
    timeoutMS: 0,
    haltOnStall: false,
  });

  expect((await individual).success).toBe(false);
  expect(result).toMatchObject({
    success: false,
    code: 'partial_state',
    reason: 'Stalled: stalls',
    stoppedComponents: ['slow'],
  });
  expect(result.stalledComponents.map((info) => info.name)).toEqual(['stalls']);
});

test('a dependency of a concurrent stop that stalled mid-pass is stopped, not held as still in progress', async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const database = new Plain(logger, 'database');
  const slow = new Plain(logger, 'slow', ['database']);
  const stalls = new Stalls(logger, 'stalls', ['database']);
  // The pass reaches `stalls` while its concurrent stop is still running, then spends
  // long enough on `slow` for that stop to stall before it reaches `database`.
  slow.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
  stalls.stop = () =>
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('stop failed')), 20),
    );
  await manager.registerComponent(database);
  await manager.registerComponent(slow);
  await manager.registerComponent(stalls);
  await manager.startAllComponents();

  const individual = manager.stopComponent('stalls');
  const result = await manager.stopAllComponents({
    timeoutMS: 0,
    haltOnStall: false,
  });

  expect((await individual).success).toBe(false);
  expect(result).toMatchObject({
    success: false,
    code: 'partial_state',
    reason: 'Stalled: stalls',
  });
  expect([...result.stoppedComponents].sort()).toEqual(['database', 'slow']);
  expect(result.stalledComponents.map((info) => info.name)).toEqual(['stalls']);
  expect(manager.getComponentStatus('database')?.state).toBe('stopped');
});

test('a dependency skipped for a concurrent stop keeps its own dependencies up after that stop stalls', async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const database = new Plain(logger, 'database');
  const slow = new Plain(logger, 'slow', ['database']);
  const cache = new Plain(logger, 'cache', ['database']);
  const stalls = new Stalls(logger, 'stalls', ['cache']);
  // `cache` is skipped while the concurrent stop of `stalls` runs; that stop then
  // stalls while the pass is on `slow`, before it reaches `database`.
  slow.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
  stalls.stop = () =>
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('stop failed')), 20),
    );
  let wasCacheRunningAtDatabaseStop: boolean | undefined;
  database.stop = () => {
    wasCacheRunningAtDatabaseStop = manager.isComponentRunning('cache');
    return Promise.resolve();
  };
  await manager.registerComponent(database);
  await manager.registerComponent(slow);
  await manager.registerComponent(cache);
  await manager.registerComponent(stalls);
  await manager.startAllComponents();

  const individual = manager.stopComponent('stalls');
  const result = await manager.stopAllComponents({
    timeoutMS: 0,
    haltOnStall: false,
  });

  expect((await individual).success).toBe(false);
  // Nothing is stopping `cache` or `database` once `stalls` has stalled: both are
  // left running, not still in progress.
  expect(result).toMatchObject({
    success: false,
    code: 'partial_state',
    reason: 'Stalled: stalls; Failed to stop: cache, database',
  });
  expect(wasCacheRunningAtDatabaseStop).toBeUndefined();
  expect(manager.getComponentStatus('cache')?.state).toBe('running');
  expect(manager.getComponentStatus('database')?.state).toBe('running');
  expect(result.stalledComponents.map((info) => info.name)).toEqual(['stalls']);
});

test('a skipped dependency whose own concurrent stop is still running keeps its dependencies in progress', async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const database = new Plain(logger, 'database');
  const slow = new Plain(logger, 'slow', ['database']);
  const cache = new Plain(logger, 'cache', ['database']);
  const api = new Plain(logger, 'api', ['cache']);
  // The pass skips `cache` for the concurrent stop of `api`, which then finishes
  // while the pass is on `slow`; the concurrent stop of `cache` is still running.
  slow.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
  api.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  cache.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 500));
  await manager.registerComponent(database);
  await manager.registerComponent(slow);
  await manager.registerComponent(cache);
  await manager.registerComponent(api);
  await manager.startAllComponents();

  const apiStop = manager.stopComponent('api');
  const cacheStop = manager.stopComponent('cache', {
    allowStopWithRunningDependents: true,
  });
  const result = await manager.stopAllComponents({
    timeoutMS: 0,
    haltOnStall: false,
  });

  expect(result).toMatchObject({
    success: false,
    code: 'cleanup_incomplete',
    reason: 'Shutdown is still in progress for: cache, database',
  });
  expect(manager.getComponentStatus('database')?.state).toBe('running');
  expect((await apiStop).success).toBe(true);
  expect((await cacheStop).success).toBe(true);
});
