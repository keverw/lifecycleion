import { expect, test } from 'bun:test';
import { Plain, setup, deferred, claimReports, Stalls } from './test-helpers';

class GatedStop extends Plain {
  public readonly entered = deferred();
  public readonly release = deferred();
  public stops = 0;

  public override stop(): Promise<void> {
    this.stops++;
    this.entered.resolve();
    return this.release.promise;
  }
}

test('second restart during shutdown reads no options or component timeout and does not cancel the first', async () => {
  const { logger, manager } = setup();
  const component = new GatedStop(logger, 'component');
  await manager.registerComponent(component);
  await manager.startAllComponents();
  const first = manager.restartAllComponents();
  await component.entered.promise;
  let optionReads = 0;
  let componentReads = 0;
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: () => {
      componentReads++;
      return NaN;
    },
  });
  const options = {
    get startupOptions(): never {
      optionReads++;
      throw new Error('unused startup options');
    },
    get shutdownTimeoutMS(): never {
      optionReads++;
      throw new Error('unused shutdown timeout');
    },
  };
  const { reports, release } = claimReports();
  try {
    const second = await manager.restartAllComponents(options);
    expect(second.shutdownResult.code).toBe('already_in_progress');
    expect(second.startupResult.code).toBe('shutdown_in_progress');
    expect(second.startupSkippedByShutdownRequest).toBeUndefined();
    expect(optionReads).toBe(0);
    expect(componentReads).toBe(0);
    expect(reports).toEqual([]);
  } finally {
    release();
    component.release.resolve();
  }
  const firstResult = await first;
  expect(firstResult.success).toBe(true);
  expect(firstResult.startupSkippedByShutdownRequest).toBeUndefined();
  expect(manager.getComponentStatus('component')?.state).toBe('running');
});

test('restart reads every option once and then refuses a shutdown an option getter started', async () => {
  const { logger, manager } = setup();
  const component = new GatedStop(logger, 'component');
  await manager.registerComponent(component);
  await manager.startAllComponents();
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  let startupReads = 0;
  let laterReads = 0;
  let componentReads = 0;
  Object.defineProperty(component, 'startupTimeoutMS', {
    get: () => {
      componentReads++;
      return 1000;
    },
  });
  const options = {
    get startupOptions() {
      startupReads++;
      shutdown = manager.stopAllComponents();
      // Invalid, but never validated: the refusal comes first.
      return { timeoutMS: NaN };
    },
    get shutdownTimeoutMS() {
      laterReads++;
      return 1000;
    },
  };

  const result = await manager.restartAllComponents(options);
  expect(result.shutdownResult.code).toBe('already_in_progress');
  expect(result.startupResult.code).toBe('shutdown_in_progress');
  // Each option is read once, all of them before the one re-entry check; no component
  // getter runs for a restart that check refused.
  expect(startupReads).toBe(1);
  expect(laterReads).toBe(1);
  expect(componentReads).toBe(0);
  component.release.resolve();
  expect((await shutdown)?.success).toBe(true);
});

test('restart refuses when a component timeout getter starts shutdown before validating it', async () => {
  const { logger, manager } = setup();
  const first = new GatedStop(logger, 'first');
  const second = new Plain(logger, 'second');
  await manager.registerComponent(first);
  await manager.registerComponent(second);
  await manager.startAllComponents();
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  let laterReads = 0;
  Object.defineProperty(first, 'startupTimeoutMS', {
    get: () => {
      shutdown = manager.stopAllComponents();
      return NaN;
    },
  });
  Object.defineProperty(second, 'startupTimeoutMS', {
    get: () => {
      laterReads++;
      return 1000;
    },
  });

  const result = await manager.restartAllComponents();
  expect(result.shutdownResult.code).toBe('already_in_progress');
  expect(result.startupResult.code).toBe('shutdown_in_progress');
  expect(laterReads).toBe(0);
  first.release.resolve();
  expect((await shutdown)?.success).toBe(true);
});

test('restart refuses before its phases when the restart info sink starts shutdown', async () => {
  const { logger, manager } = setup();
  const component = new GatedStop(logger, 'component');
  await manager.registerComponent(component);
  await manager.startAllComponents();
  const messages: string[] = [];
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  logger.addSink({
    write(entry) {
      messages.push(entry.message);
      if (entry.message === 'Restarting all components') {
        shutdown = manager.stopAllComponents();
      }
    },
  });
  try {
    const result = await manager.restartAllComponents();
    expect(result.shutdownResult.code).toBe('already_in_progress');
    expect(result.startupResult.code).toBe('shutdown_in_progress');
    expect(result.startupSkippedByShutdownRequest).toBeUndefined();
    // A refused restart owns neither phase. In particular, it must not enter
    // startup merely to have that operation refuse the sink's active shutdown.
    expect(messages).not.toContain(
      'Cannot start all components: shutdown in progress',
    );
    expect(messages).not.toContain('Restart completed');
  } finally {
    component.release.resolve();
    expect((await shutdown)?.success).toBe(true);
  }
});

test('restart refusal during shutdown warns without taking ownership of the pass', async () => {
  const { logger, manager } = setup();
  const component = new GatedStop(logger, 'component');
  await manager.registerComponent(component);
  await manager.startAllComponents();
  const shutdown = manager.stopAllComponents();
  await component.entered.promise;
  const warnings: string[] = [];
  logger.addSink({
    write(entry) {
      if (entry.type === 'warn') {
        warnings.push(entry.message);
      }
    },
  });
  try {
    const result = await manager.restartAllComponents();
    expect(result.shutdownResult.code).toBe('already_in_progress');
    expect(result.startupResult.code).toBe('shutdown_in_progress');
    expect(result.startupSkippedByShutdownRequest).toBeUndefined();
    expect(warnings).toEqual(['Cannot restart all components during shutdown']);
    expect(component.stops).toBe(1);
  } finally {
    component.release.resolve();
    expect((await shutdown).success).toBe(true);
  }
});

test('restart refuses without starting when its stop phase is refused mid-acceptance', async () => {
  const { logger, manager } = setup({
    repeatedShutdownRequestPolicy: {
      forceAfterCount: 3,
      withinMS: 1000,
      armedAfterFailureMS: 60_000,
      onForceShutdown: () => {},
    },
  });
  await manager.registerComponent(new Stalls(logger, 'a'));
  await manager.startAllComponents();
  // A failed stop arms escalation; its expiry, found lapsed by the restart's own stop
  // phase acceptance, logs through the sink below after every earlier restart check.
  await manager.stopAllComponents();
  (
    manager as unknown as {
      repeatedShutdownRequestState: { remainsArmedUntil: number };
    }
  ).repeatedShutdownRequestState.remainsArmedUntil = Date.now() - 1;
  const messages: string[] = [];
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  logger.addSink({
    write(entry) {
      messages.push(entry.message);
      if (
        entry.template ===
        'Repeated shutdown escalation window expired, clearing previous shutdown state'
      ) {
        shutdown = manager.stopAllComponents();
      }
    },
  });
  const result = await manager.restartAllComponents();
  expect(shutdown).toBeDefined();
  expect(result.success).toBe(false);
  expect(result.shutdownResult.code).toBe('already_in_progress');
  expect(result.startupResult.code).toBe('shutdown_in_progress');
  expect(result.startupSkippedByShutdownRequest).toBeUndefined();
  // One refusal for the one request: the restart's, not also its stop phase's.
  expect(messages.filter((message) => message.startsWith('Cannot '))).toEqual([
    'Cannot restart all components during shutdown',
  ]);
  expect(messages).not.toContain('Restart completed');
  await shutdown;
});

test('restart refuses during an active bulk startup without stopping anything', async () => {
  const { logger, manager } = setup();
  const running = new GatedStop(logger, 'running');
  const slow = new Plain(logger, 'slow');
  const gate = deferred();
  slow.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(running);
  await manager.registerComponent(slow);
  const startup = manager.startAllComponents();
  await sleepTick();

  const result = await manager.restartAllComponents();
  expect(result.success).toBe(false);
  expect(result.startupResult.code).toBe('already_in_progress');
  expect(result.shutdownResult).toMatchObject({
    code: 'partial_state',
    stoppedComponents: [],
  });
  expect(running.stops).toBe(0);

  gate.resolve();
  expect((await startup).success).toBe(true);
});

test('restart refuses when a preparation getter begins a bulk startup', async () => {
  const { logger, manager } = setup();
  const component = new GatedStop(logger, 'component');
  const gate = deferred();
  component.start = (): Promise<void> => gate.promise;
  await manager.registerComponent(component);
  let startup: ReturnType<typeof manager.startAllComponents> | undefined;

  const result = await manager.restartAllComponents({
    get startupOptions() {
      startup = manager.startAllComponents();
      return undefined;
    },
  });
  expect(result.startupResult.code).toBe('already_in_progress');
  expect(result.shutdownResult.stoppedComponents).toEqual([]);
  expect(component.stops).toBe(0);

  gate.resolve();
  expect((await startup)?.success).toBe(true);
  expect(manager.isComponentRunning('component')).toBe(true);
});

test('a registration from the escalation expiry log is caught by restart preflight', async () => {
  const { logger, manager } = setup({
    repeatedShutdownRequestPolicy: {
      forceAfterCount: 3,
      withinMS: 10_000,
      onForceShutdown: () => {},
    },
  });
  const component = new GatedStop(logger, 'component');
  await manager.registerComponent(component);
  await manager.startAllComponents();
  // A lapsed post-failure window, which the restart expires before stopping anything.
  const state = (
    manager as unknown as {
      repeatedShutdownRequestState: {
        firstMethod: string | null;
        firstRequestAt: number | null;
        remainsArmedUntil: number | null;
      };
    }
  ).repeatedShutdownRequestState;
  state.firstMethod = 'SIGINT';
  state.firstRequestAt = Date.now() - 10;
  state.remainsArmedUntil = Date.now() - 1;
  let registration: Promise<unknown> | undefined;
  logger.addSink({
    write(entry) {
      if (
        entry.message.startsWith('Repeated shutdown escalation window expired')
      ) {
        registration = manager.registerComponent(new Plain(logger, 'late'));
      }
    },
  });

  const result = await manager.restartAllComponents();
  await registration;
  expect(result.shutdownResult).toMatchObject({
    code: 'partial_state',
    stoppedComponents: [],
  });
  expect(result.shutdownResult.reason).toBe(
    'Component "late" changed while restart was being prepared',
  );
  expect(component.stops).toBe(0);
});

function sleepTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
