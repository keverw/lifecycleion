import { expect, test } from 'bun:test';
import { sleep } from '../sleep';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import type { LogEntry } from '../logger/types';
import { LifecycleManager } from './lifecycle-manager';
import {
  claimReports,
  deferred,
  failStatusReadOnce,
  fakeSignals,
  hasReport,
  Plain,
  sendSignal,
  setup,
} from './test-helpers';

// Regressions for review follow-ups: each test pins one behavior the fix changed.

test('an auto-start is skipped when a sink replaces the registration before it runs', async () => {
  // eslint-disable-next-line prefer-const -- assigned after the sink that reads it
  let manager!: LifecycleManager;
  let isArmed = false;
  const entries: LogEntry[] = [];
  const logger = new Logger({
    sinks: [
      {
        write: (entry): void => {
          entries.push(entry);
          if (isArmed && entry.message === 'Component registered') {
            isArmed = false;
            void manager.unregisterComponent('a', { stopIfRunning: false });
            void manager.registerComponent(replacement);
          }
        },
      },
    ],
    callProcessExit: false,
  });
  manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 });
  const original = new Plain(logger, 'a');
  const replacement = new Plain(logger, 'a');
  let replacementStarts = 0;
  replacement.start = (): Promise<void> => {
    replacementStarts++;
    return Promise.resolve();
  };

  isArmed = true;
  const result = await manager.registerComponent(original, { autoStart: true });
  await sleep(1);

  // The replacement was registered without autoStart: nothing starts it, and this
  // registration does not report the replacement's start as its own.
  expect(manager.getComponentInstance('a')).toBe(replacement);
  expect(result.autoStartAttempted).toBe(false);
  expect(result.startResult).toBeUndefined();
  expect(replacementStarts).toBe(0);
  expect(manager.isComponentRunning('a')).toBe(false);
  expect(
    entries.some(
      (entry) =>
        entry.message ===
        'AutoStart: skipped, the component was unregistered during its registration',
    ),
  ).toBe(true);
  await logger.close();
});

test('targetFound reports the target found at insertion, even if a hook removes it', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'target'));
  const inserted = new Plain(logger, 'inserted');
  const markRegistered = inserted._markRegistered.bind(inserted);
  inserted._markRegistered = (): void => {
    markRegistered();
    void manager.unregisterComponent('target', { stopIfRunning: false });
  };

  const result = await manager.insertComponentAt(inserted, 'after', 'target');

  expect(result.success).toBe(true);
  expect(manager.hasComponent('target')).toBe(false);
  expect(result.targetFound).toBe(true);
});

test('an auto-start is skipped when a sink re-registers the same instance before it runs', async () => {
  // eslint-disable-next-line prefer-const -- assigned after the sink that reads it
  let manager!: LifecycleManager;
  let isArmed = false;
  const logger = new Logger({
    sinks: [
      {
        write: (entry): void => {
          if (isArmed && entry.message === 'Component registered') {
            isArmed = false;
            void manager.unregisterComponent('a', { stopIfRunning: false });
            // The same instance, registered again without autoStart.
            void manager.registerComponent(component);
          }
        },
      },
    ],
    callProcessExit: false,
  });
  manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 });
  const component = new Plain(logger, 'a');
  let starts = 0;
  component.start = (): Promise<void> => {
    starts++;
    return Promise.resolve();
  };

  isArmed = true;
  const result = await manager.registerComponent(component, {
    autoStart: true,
  });
  await sleep(1);

  // The name holds the same instance, but under the later registration, which asked
  // for no auto-start.
  expect(manager.getComponentInstance('a')).toBe(component);
  expect(result.autoStartAttempted).toBe(false);
  expect(result.startResult).toBeUndefined();
  expect(starts).toBe(0);
  expect(manager.isComponentRunning('a')).toBe(false);
  await logger.close();
});

test('targetFound reports a found target when the candidate getDependencies() throws', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'db'));
  const rejected: Array<{ name: string; targetFound?: boolean }> = [];
  manager.on(
    'component:registration-rejected',
    (event: { name: string; targetFound?: boolean }) => {
      rejected.push(event);
    },
  );
  const candidate = new Plain(logger, 'c');
  candidate.getDependencies = (): string[] => {
    throw new Error('dependencies unavailable');
  };

  const { reports, release } = claimReports();
  let result;

  try {
    result = await manager.insertComponentAt(candidate, 'before', 'db');
  } finally {
    release();
  }

  expect(result.success).toBe(false);
  expect(result.code).toBe('operation_crashed');
  expect(result.error?.message).toBe('dependencies unavailable');
  expect(hasReport(reports, 'registerComponent')).toBe(true);
  expect(result.targetFound).toBe(true);
  expect(rejected.find((event) => event.name === 'c')?.targetFound).toBe(true);
});

test('a forced start finishing after shutdown began reports a re-stop that failed', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const oldStop = deferred();
  const start = deferred();
  let stops = 0;
  component.stop = (): Promise<void> =>
    ++stops === 1 ? oldStop.promise : Promise.resolve();
  Object.defineProperty(component, 'onShutdownForce', { value: undefined });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  await manager.stopComponent('a', { timeout: 5 });
  expect(manager.getComponentStatus('a')?.state).toBe('stalled');

  const resolved: (string | undefined)[] = [];
  manager.on('component:stalled-resolved', (data: { reason?: string }) => {
    resolved.push(data.reason);
  });
  component.start = (): Promise<void> => start.promise;
  const starting = manager.startComponent('a', { forceStalled: true });
  const shutdown = manager.stopAllComponents({ timeoutMS: 50 });
  // The stop that follows the start reads this, and refuses it.
  let gracefulTimeoutMS = Number.NaN;
  Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
    get: () => gracefulTimeoutMS,
  });
  start.resolve();
  const result = await starting;

  try {
    expect(result.success).toBe(false);
    expect(result.code).toBe('shutdown_in_progress');
    expect(result.reason).toStartWith(
      'Shutdown triggered during component startup; stopping it again failed: ',
    );
    expect(result.error).toBeDefined();
    // The stall was retired by the forced start, and announced as such.
    expect(resolved).toEqual(['forced-start']);
  } finally {
    gracefulTimeoutMS = 1000;
    oldStop.resolve();
    await shutdown;
    await manager.stopAllComponents();
  }
});

test('auto-starts abandoned by a failed startup are not lost to a startup its detach began', async () => {
  const sink = new ArraySink();
  // eslint-disable-next-line prefer-const -- assigned after the sink that reads it
  let manager!: LifecycleManager;
  let followUp: ReturnType<LifecycleManager['startAllComponents']> | undefined;
  const logger = new Logger({
    sinks: [
      sink,
      {
        write: (entry): void => {
          if (
            followUp === undefined &&
            entry.message ===
              'Auto-detached process signals after failed bulk startup'
          ) {
            followUp = manager.startAllComponents();
          }
        },
      },
    ],
    callProcessExit: false,
  });
  manager = new LifecycleManager({
    logger,
    attachSignalsBeforeStartup: true,
    detachSignalsOnStop: true,
    shutdownWarningTimeoutMS: -1,
  });
  fakeSignals(manager);
  const bad = new Plain(logger, 'bad');
  const deferredStart = new Plain(logger, 'deferred');
  let deferredStarts = 0;
  deferredStart.start = (): Promise<void> => {
    deferredStarts++;
    return Promise.resolve();
  };
  let badStarts = 0;
  bad.start = async (): Promise<void> => {
    if (++badStarts === 1) {
      await manager.registerComponent(deferredStart, { autoStart: true });
    }
    throw new Error('bad start');
  };
  await manager.registerComponent(bad);

  try {
    const first = await manager.startAllComponents();
    expect(first.code).toBe('required_component_failed');
    expect(followUp).toBeDefined();
    const second = await followUp;
    expect(second?.code).toBe('required_component_failed');
    await sleep(1);

    // Neither startup reached it, so one of them says so.
    expect(deferredStarts).toBe(0);
    const warnings = sink.logs.filter((entry) =>
      entry.message.includes('deferred auto-starts were not attempted'),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0].params?.components).toEqual(['deferred']);
  } finally {
    manager.detachSignals();
    await manager.stopAllComponents();
  }
});

test('a stall cleared within the same millisecond logs its 0ms duration', async () => {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const component = new Plain(logger, 'a');
  const stop = deferred();
  component.stop = (): Promise<void> => stop.promise;
  Object.defineProperty(component, 'onShutdownForce', { value: undefined });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  await manager.stopComponent('a', { timeout: 5 });
  expect(manager.getStalledComponentNames()).toEqual(['a']);
  const stalledAt = manager.getStalledComponents()[0].stalledAt;

  const realNow = Date.now;
  Date.now = (): number => stalledAt;
  try {
    stop.resolve();
    await sleep(0);
    await sleep(0);
  } finally {
    Date.now = realNow;
  }

  const line = sink.logs.find(
    (entry) =>
      entry.message === 'Stalled component completed stop late, stall cleared',
  );
  expect(line?.params).toEqual({ stalledDurationMS: 0 });
  await logger.close();
});

test('a refused start attempt runs a detach deferred while it held its claim', async () => {
  const { logger, manager } = setup({
    attachSignalsBeforeStartup: true,
    detachSignalsOnStop: true,
  });
  const signals = fakeSignals(manager);
  const fakeAttach = manager.attachSignals.bind(manager);
  let shouldFailAttach = false;
  manager.attachSignals = (): void => {
    if (shouldFailAttach) {
      throw new Error('attach failed');
    }
    fakeAttach();
  };
  await manager.registerComponent(new Plain(logger, 'a'));
  await manager.registerComponent(new Plain(logger, 'other'));
  logger.addSink({
    write: (entry): void => {
      if (
        !shouldFailAttach &&
        entry.message === 'Auto-attaching process signals on component startup'
      ) {
        // Caller code under the claim: handlers attached, then the last other
        // component removed - its detach waits on this attempt's `starting`.
        fakeAttach();
        shouldFailAttach = true;
        void manager.unregisterComponent('other', { stopIfRunning: false });
      }
    },
  });

  const result = await manager.startComponent('a');

  expect(result.code).toBe('signal_attach_failed');
  expect(manager.getComponentStatus('a')?.state).toBe('registered');
  expect(manager.hasComponent('other')).toBe(false);
  expect(signals.isAttached()).toBe(false);
});

test('a signal reseeding a cleared cycle mid-pass is not logged as a restart', async () => {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
    repeatedShutdownRequestPolicy: {
      forceAfterCount: 3,
      withinMS: 1000,
      onForceShutdown: () => {},
    },
  });
  const component = new Plain(logger, 'a');
  const stop = deferred();
  component.stop = (): Promise<void> => stop.promise;
  await manager.registerComponent(component);
  await manager.startAllComponents();

  const shutdown = manager.stopAllComponents();
  // The pass's cycle is cleared under it: a lapsed armed window, expired by the first
  // signal. That signal then finds no cycle on an ordinary pass and seeds one, and the
  // next counts against it.
  (
    manager as unknown as {
      state: { repeatedShutdownRequestState: { remainsArmedUntil: number } };
    }
  ).state.repeatedShutdownRequestState.remainsArmedUntil = Date.now() - 1;
  sendSignal(manager, 'SIGINT');
  expect(manager.getShutdownEscalationStatus().firstMethod).toBe('SIGINT');
  sendSignal(manager, 'SIGTERM');
  expect(manager.getShutdownEscalationStatus()).toMatchObject({
    firstMethod: 'SIGINT',
    requestCount: 1,
  });
  stop.resolve();
  await shutdown;

  const messages = sink.logs.map((entry) => entry.message);
  expect(messages).not.toContain('Shutdown signal received during restart');
  expect(messages).toContain(
    'Shutdown signal received during shutdown, starting its escalation cycle',
  );
  await logger.close();
});

test('an unregister whose stop failed does not report a replacement as stopped', async () => {
  const { logger, manager } = setup();
  const original = new Plain(logger, 'a');
  original.stop = (): Promise<void> => Promise.reject(new Error('stop failed'));
  Object.defineProperty(original, 'onShutdownForce', { value: undefined });
  await manager.registerComponent(original);
  await manager.startComponent('a');

  // `unregisterComponent()` stops through the public method, which is the caller's to
  // override: this one replaces the component, and leaves the replacement stopped.
  const stopComponent = manager.stopComponent.bind(manager);
  manager.stopComponent = async (name, options) => {
    const stopResult = await stopComponent(name, options);
    await manager.unregisterComponent('a', { stopIfRunning: false });
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startComponent('a');
    await stopComponent('a');
    return stopResult;
  };

  const result = await manager.unregisterComponent('a');

  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  expect(result.success).toBe(false);
  expect(result.code).toBe('component_not_found');
  expect(result.wasStopped).toBe(false);
});

test('a branded option refusal thrown after the claim is a crash, reported once', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'a'));
  // A refusal our own validation branded, rethrown later from caller code.
  const refused = await manager.stopAllComponents({ timeoutMS: Number.NaN });
  expect(refused.code).toBe('invalid_options');
  expect(refused.error).toBeInstanceOf(Error);
  const brandedError = refused.error as Error;

  // Fails the success path's status read, after the component is marked running.
  const restoreStatusRead = failStatusReadOnce(brandedError, (name) =>
    manager.isComponentRunning(name),
  );

  const { reports, release } = claimReports();
  let result;
  try {
    result = await manager.startComponent('a');
  } finally {
    restoreStatusRead();
    release();
  }

  expect(result.success).toBe(false);
  expect(result.code).toBe('operation_crashed');
  expect(result.reason).toStartWith(
    'Start failed unexpectedly after the component was running',
  );
  expect(reports).toHaveLength(1);
  expect(hasReport(reports, 'component start')).toBe(true);
  expect(manager.isComponentRunning('a')).toBe(false);
});
