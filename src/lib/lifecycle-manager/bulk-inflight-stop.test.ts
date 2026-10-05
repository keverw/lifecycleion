import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import {
  claimReports,
  deferred,
  fakeSignals,
  Plain,
  Stalls,
} from './test-helpers';

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

test('a dependency skipped for a concurrent stop that stalled is stopped after it, before its own dependencies', async () => {
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
  // Once `stalls` has stalled nothing needs `cache` or `database`: the pass goes back
  // to them, still in dependency order.
  expect(result).toMatchObject({
    success: false,
    code: 'partial_state',
    reason: 'Stalled: stalls',
  });
  expect(wasCacheRunningAtDatabaseStop).toBe(false);
  expect(manager.getComponentStatus('cache')?.state).toBe('stopped');
  expect(manager.getComponentStatus('database')?.state).toBe('stopped');
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

test('the dependencies of a component whose own stop failed and left it running are reported as not stopped', async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const database = new Plain(logger, 'database');
  const api = new Plain(logger, 'api', ['database']);
  await manager.registerComponent(database);
  await manager.registerComponent(api);
  await manager.startAllComponents();

  // Read before the stop claims `api`, so it fails and leaves `api` running.
  Object.defineProperty(api, 'shutdownGracefulTimeoutMS', {
    get: (): never => {
      throw new Error('getter exploded');
    },
  });

  const { release } = claimReports();
  let result;
  try {
    result = await manager.stopAllComponents({ haltOnStall: false });
  } finally {
    release();
  }

  // `api` holds `database` up, but nothing is still stopping or starting either.
  expect(result).toMatchObject({
    success: false,
    code: 'partial_state',
    reason: 'Failed to stop: api, database',
  });
  expect(manager.getComponentStatus('api')?.state).toBe('running');
  expect(manager.getComponentStatus('database')?.state).toBe('running');
});

// Stops everything while a concurrent stop of `cache` is still running, so every one of
// its `count` dependencies is skipped on its account and still marked stopping at the
// end of the pass. Returns how often the pass read the dependencies of `cache`.
async function countOwnerDependencyReads(count: number): Promise<number> {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const names = Array.from({ length: count }, (_, index) => `db${index + 1}`);
  for (const name of names) {
    await manager.registerComponent(new Plain(logger, name));
  }
  const cache = new Plain(logger, 'cache', names);
  const cacheGate = deferred();
  cache.stop = (): Promise<void> => cacheGate.promise;
  await manager.registerComponent(cache);
  await manager.startAllComponents();

  const cacheStop = manager.stopComponent('cache');
  let reads = 0;
  const readDependencies = cache.getDependencies.bind(cache);
  cache.getDependencies = (): string[] => {
    reads++;
    return readDependencies();
  };
  const result = await manager.stopAllComponents({
    timeoutMS: 0,
    haltOnStall: false,
  });
  const passReads = reads;

  expect(result).toMatchObject({
    success: false,
    code: 'cleanup_incomplete',
    reason: `Shutdown is still in progress for: cache, ${[...names].reverse().join(', ')}`,
  });
  cacheGate.resolve();
  expect((await cacheStop).success).toBe(true);
  await logger.close();

  return passReads;
}

test('final accounting reads the dependencies of an owner still in progress once, not once per skipped dependency', async () => {
  // Only the stop loop's own check of each skip still scales with the dependency count:
  // one read per extra dependency, since each check re-reads the live getters. Final
  // accounting adds none.
  const oneDependency = await countOwnerDependencyReads(1);
  const threeDependencies = await countOwnerDependencyReads(3);

  expect(threeDependencies - oneDependency).toBe(2);
});

test("a failed owner's dependencies are re-read at each check, not cached for the stop loop", async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const database = new Plain(logger, 'database');
  const cache = new Plain(logger, 'cache');
  const worker = new Plain(logger, 'worker');
  const api = new Plain(logger, 'api', ['database']);
  await manager.registerComponent(database);
  await manager.registerComponent(cache);
  await manager.registerComponent(worker);
  await manager.registerComponent(api);
  await manager.startAllComponents();

  let cacheStops = 0;
  cache.stop = (): Promise<void> => {
    cacheStops++;
    return Promise.resolve();
  };
  // Checked for `worker` first, which walks `api`'s dependencies; `worker`'s stop then
  // makes `api` depend on `cache` too, before `cache` is checked.
  worker.stop = (): Promise<void> => {
    api.dependencies.push('cache');
    return Promise.resolve();
  };
  // Read before the stop claims `api`, so it fails and leaves `api` running.
  Object.defineProperty(api, 'shutdownGracefulTimeoutMS', {
    get: (): never => {
      throw new Error('getter exploded');
    },
  });

  const { release } = claimReports();
  try {
    await manager.stopAllComponents({ haltOnStall: false });
  } finally {
    release();
  }

  expect(manager.getComponentStatus('api')?.state).toBe('running');
  expect(cacheStops).toBe(0);
  expect(manager.getComponentStatus('cache')?.state).toBe('running');
});

// Stops everything while a concurrent stop of `cache` is still running, so `database` is
// skipped on its account, then reaches `count` unrelated components. Returns how often
// the pass read the dependencies of `database`.
async function countSharedDependencyReads(count: number): Promise<number> {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  // Registered first, so they start first and are stopped after `database` is skipped.
  for (let index = 1; index <= count; index++) {
    await manager.registerComponent(new Plain(logger, `extra${index}`));
  }
  const database = new Plain(logger, 'database');
  await manager.registerComponent(database);
  const cache = new Plain(logger, 'cache', ['database']);
  const cacheGate = deferred();
  cache.stop = (): Promise<void> => cacheGate.promise;
  await manager.registerComponent(cache);
  await manager.startAllComponents();

  const cacheStop = manager.stopComponent('cache');
  let reads = 0;
  const readDependencies = database.getDependencies.bind(database);
  database.getDependencies = (): string[] => {
    reads++;
    return readDependencies();
  };
  await manager.stopAllComponents({ timeoutMS: 0, haltOnStall: false });
  const passReads = reads;

  expect(manager.getComponentStatus('database')?.state).toBe('running');
  for (let index = 1; index <= count; index++) {
    expect(manager.getComponentStatus(`extra${index}`)?.state).toBe('stopped');
  }
  cacheGate.resolve();
  expect((await cacheStop).success).toBe(true);
  await logger.close();

  return passReads;
}

test('a check reads a skip reached through its owner once, not again as an owner of its own', async () => {
  // Each unrelated component is checked twice - before and after its log line - and
  // each check walks `cache` down to `database` and then `database` as a skip. Shared
  // across both, `database`'s dependencies are read once per check.
  const oneExtra = await countSharedDependencyReads(1);
  const threeExtras = await countSharedDependencyReads(3);

  expect(threeExtras - oneExtra).toBe(4);
});

test('dependencies skipped for a concurrent stop that succeeds are stopped once it has', async () => {
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
  // `cache` and `database` are skipped for the concurrent stop of `api`, which then
  // finishes while the pass is on `slow`.
  slow.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
  api.stop = () => new Promise<void>((resolve) => setTimeout(resolve, 20));
  await manager.registerComponent(database);
  await manager.registerComponent(slow);
  await manager.registerComponent(cache);
  await manager.registerComponent(api);
  await manager.startAllComponents();

  const apiStop = manager.stopComponent('api');
  const result = await manager.stopAllComponents({
    timeoutMS: 0,
    haltOnStall: false,
  });

  expect((await apiStop).success).toBe(true);
  expect(result).toMatchObject({ success: true });
  expect(manager.getComponentStatus('cache')?.state).toBe('stopped');
  expect(manager.getComponentStatus('database')?.state).toBe('stopped');
});

test('a concurrent stop does not halt the pass before unrelated components', async () => {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const a = new Plain(logger, 'a');
  const b = new Plain(logger, 'b');
  const bGate = deferred();
  b.stop = (): Promise<void> => bGate.promise;
  await manager.registerComponent(a);
  await manager.registerComponent(b);
  await manager.startAllComponents();

  const bStop = manager.stopComponent('b');
  // Default `haltOnStall: true`.
  const result = await manager.stopAllComponents({ timeoutMS: 0 });

  expect(result).toMatchObject({
    success: false,
    code: 'cleanup_incomplete',
    reason: 'Shutdown is still in progress for: b',
  });
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  bGate.resolve();
  expect((await bStop).success).toBe(true);
});
