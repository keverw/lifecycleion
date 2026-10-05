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

test('restart refuses when an option getter starts shutdown before reading later options', async () => {
  const { logger, manager } = setup();
  const component = new GatedStop(logger, 'component');
  await manager.registerComponent(component);
  await manager.startAllComponents();
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  let laterReads = 0;
  const options = {
    get startupOptions() {
      shutdown = manager.stopAllComponents();
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
  expect(laterReads).toBe(0);
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
