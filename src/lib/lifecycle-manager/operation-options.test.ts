import { describe, expect, test } from 'bun:test';
import type { Logger } from '../logger';
import { claimReports, Plain, setup } from './test-helpers';

/**
 * An options object whose every field is a getter that records its read in `log`, under
 * `prefix` + its name, and answers `values[name]`.
 */
function recordingOptions<T>(
  log: string[],
  values: Record<string, unknown>,
  prefix = '',
): T {
  const options = {};
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(options, key, {
      enumerable: true,
      get: () => {
        log.push(`${prefix}${key}`);
        return value;
      },
    });
  }
  return options as T;
}

/** Records every log line, as caller code a sink runs. */
function recordLogs(logger: Logger, log: string[]): void {
  logger.addSink({
    write(entry) {
      log.push(`log: ${entry.message}`);
    },
  });
}

/**
 * Every option read exactly once, in `fields` order, and all of them before any other
 * caller code `log` recorded - of which there must be some, or the order says nothing.
 */
function expectReadOnceFirst(log: string[], fields: string[]): void {
  expect(log.slice(0, fields.length)).toEqual(fields);
  expect(log.filter((entry) => fields.includes(entry))).toEqual(fields);
  expect(log.length).toBeGreaterThan(fields.length);
}

/** A component that records its `start()`, `stop()` and dependency reads in `log`. */
function recordingComponent(
  logger: Logger,
  name: string,
  log: string[],
  dependencies: string[] = [],
): Plain {
  const component = new Plain(logger, name, dependencies);
  component.start = (): Promise<void> => {
    log.push(`start ${name}`);
    return Promise.resolve();
  };
  component.stop = (): Promise<void> => {
    log.push(`stop ${name}`);
    return Promise.resolve();
  };
  component.getDependencies = (): string[] => {
    log.push(`getDependencies ${name}`);
    return dependencies;
  };
  return component;
}

describe('each operation reads its options once, before other caller code', () => {
  test('startAllComponents', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    recordLogs(logger, log);
    log.length = 0;

    const result = await manager.startAllComponents(
      recordingOptions(log, {
        ignoreStalledComponents: false,
        timeoutMS: 1000,
      }),
    );

    expect(result.success).toBe(true);
    expectReadOnceFirst(log, ['ignoreStalledComponents', 'timeoutMS']);
    await manager.stopAllComponents();
  });

  test('stopAllComponents', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    await manager.startAllComponents();
    recordLogs(logger, log);
    log.length = 0;

    const result = await manager.stopAllComponents(
      recordingOptions(log, {
        timeoutMS: 1000,
        retryStalled: true,
        haltOnStall: true,
        allowStopWithPendingStarts: false,
        waitForAbandonedStarts: false,
        abortPendingStarts: false,
      }),
    );

    expect(result.success).toBe(true);
    expectReadOnceFirst(log, [
      'timeoutMS',
      'retryStalled',
      'haltOnStall',
      'allowStopWithPendingStarts',
      'waitForAbandonedStarts',
      'abortPendingStarts',
    ]);
  });

  test('restartAllComponents', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    await manager.startAllComponents();
    recordLogs(logger, log);
    log.length = 0;

    const result = await manager.restartAllComponents(
      recordingOptions(log, {
        startupOptions: recordingOptions(
          log,
          { timeoutMS: 1000, ignoreStalledComponents: false },
          'startupOptions.',
        ),
        shutdownTimeoutMS: 1000,
      }),
    );

    expect(result.success).toBe(true);
    expectReadOnceFirst(log, [
      'startupOptions',
      'startupOptions.timeoutMS',
      'startupOptions.ignoreStalledComponents',
      'shutdownTimeoutMS',
    ]);
    await manager.stopAllComponents();
  });

  test('startComponent', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    recordLogs(logger, log);
    log.length = 0;

    const result = await manager.startComponent(
      'a',
      recordingOptions(log, {
        allowDuringBulkStartup: false,
        forceStalled: false,
        allowNonRunningDependencies: false,
      }),
    );

    expect(result.success).toBe(true);
    expectReadOnceFirst(log, [
      'allowDuringBulkStartup',
      'forceStalled',
      'allowNonRunningDependencies',
    ]);
    await manager.stopAllComponents();
  });

  test('stopComponent', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    await manager.startComponent('a');
    recordLogs(logger, log);
    log.length = 0;

    const result = await manager.stopComponent(
      'a',
      recordingOptions(log, {
        allowStopWithRunningDependents: false,
        forceImmediate: false,
        timeout: 1000,
      }),
    );

    expect(result.success).toBe(true);
    expectReadOnceFirst(log, [
      'allowStopWithRunningDependents',
      'forceImmediate',
      'timeout',
    ]);
    expect(log).toContain('stop a');
  });

  test('restartComponent', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    await manager.startComponent('a');
    recordLogs(logger, log);
    log.length = 0;

    const result = await manager.restartComponent(
      'a',
      recordingOptions(log, {
        stopOptions: recordingOptions(
          log,
          {
            allowStopWithRunningDependents: false,
            forceImmediate: false,
            timeout: 1000,
          },
          'stopOptions.',
        ),
        startOptions: recordingOptions(
          log,
          {
            allowDuringBulkStartup: false,
            forceStalled: false,
            allowNonRunningDependencies: false,
          },
          'startOptions.',
        ),
      }),
    );

    expect(result.success).toBe(true);
    expectReadOnceFirst(log, [
      'stopOptions',
      'startOptions',
      'startOptions.allowDuringBulkStartup',
      'startOptions.forceStalled',
      'startOptions.allowNonRunningDependencies',
      'stopOptions.allowStopWithRunningDependents',
      'stopOptions.forceImmediate',
      'stopOptions.timeout',
    ]);
    expect(log).toContain('stop a');
    expect(log).toContain('start a');
    await manager.stopAllComponents();
  });

  for (const method of ['registerComponent', 'insertComponentAt'] as const) {
    test(method, async () => {
      const { logger, manager } = setup();
      const log: string[] = [];
      recordLogs(logger, log);
      const component = recordingComponent(logger, 'a', log);
      const options = recordingOptions<{ autoStart: boolean }>(log, {
        autoStart: false,
      });

      const result =
        method === 'registerComponent'
          ? await manager.registerComponent(component, options)
          : await manager.insertComponentAt(
              component,
              'end',
              undefined,
              options,
            );

      expect(result.success).toBe(true);
      // The name is read first, as the component's own; the option before any of the
      // component's other code.
      expectReadOnceFirst(log, ['autoStart']);
    });
  }

  test('unregisterComponent', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    await manager.startComponent('a');
    recordLogs(logger, log);
    log.length = 0;

    const result = await manager.unregisterComponent(
      'a',
      recordingOptions(log, { stopIfRunning: true, forceStop: false }),
    );

    expect(result.success).toBe(true);
    expectReadOnceFirst(log, ['stopIfRunning', 'forceStop']);
    expect(log).toContain('stop a');
  });

  test('sendMessageToComponent', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    const component = recordingComponent(logger, 'a', log);
    (component as unknown as { onMessage: () => string }).onMessage = () => {
      log.push('onMessage');
      return 'ok';
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');
    manager.on('component:message-sent', () => {
      log.push('message-sent');
    });
    log.length = 0;

    const result = await manager.sendMessageToComponent(
      'a',
      'hi',
      recordingOptions(log, {
        includeStopped: false,
        includeStalled: false,
        timeout: 1000,
      }),
    );

    expect(result.sent).toBe(true);
    expectReadOnceFirst(log, ['includeStopped', 'includeStalled', 'timeout']);
    expect(log).toContain('onMessage');
    await manager.stopAllComponents();
  });

  test('broadcastMessage', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    const component = recordingComponent(logger, 'a', log);
    (component as unknown as { onMessage: () => string }).onMessage = () => {
      log.push('onMessage');
      return 'ok';
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');
    manager.on('component:broadcast-started', () => {
      log.push('broadcast-started');
    });
    log.length = 0;

    const results = await manager.broadcastMessage(
      'hi',
      recordingOptions(log, {
        componentNames: ['a'],
        includeStopped: false,
        includeStalled: false,
        timeout: 1000,
      }),
    );

    expect(results.map((result) => result.sent)).toEqual([true]);
    expectReadOnceFirst(log, [
      'componentNames',
      'includeStopped',
      'includeStalled',
      'timeout',
    ]);
    await manager.stopAllComponents();
  });

  test('getValue', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    const component = recordingComponent(logger, 'a', log);
    (
      component as unknown as {
        getValue: () => { found: boolean; value: string };
      }
    ).getValue = () => {
      log.push('getValue');
      return { found: true, value: 'v' };
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');
    manager.on('component:value-requested', () => {
      log.push('value-requested');
    });
    log.length = 0;

    const result = manager.getValue(
      'a',
      'key',
      recordingOptions(log, { includeStopped: false, includeStalled: false }),
    );

    expect(result.found).toBe(true);
    expectReadOnceFirst(log, ['includeStopped', 'includeStalled']);
    expect(log).toContain('getValue');
    await manager.stopAllComponents();
  });
});

describe('options are read after the refusals that need none', () => {
  test('stopComponent reads every option before refusing for running dependents', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(
      recordingComponent(logger, 'database', log),
    );
    await manager.registerComponent(
      recordingComponent(logger, 'api', log, ['database']),
    );
    await manager.startAllComponents();
    log.length = 0;

    const result = await manager.stopComponent(
      'database',
      recordingOptions(log, {
        allowStopWithRunningDependents: false,
        forceImmediate: false,
        timeout: 1000,
      }),
    );

    expect(result.code).toBe('has_running_dependents');
    expect(log.slice(0, 3)).toEqual([
      'allowStopWithRunningDependents',
      'forceImmediate',
      'timeout',
    ]);
    expect(log).not.toContain('stop database');
    await manager.stopAllComponents();
  });

  test('a stopComponent timeout getter that throws fails before the claim', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    await manager.startComponent('a');
    log.length = 0;
    let stopping = 0;
    manager.on('component:stopping', () => {
      stopping++;
    });

    const { reports, release } = claimReports();
    try {
      const result = await manager.stopComponent('a', {
        get timeout(): number {
          throw new Error('timeout exploded');
        },
      });

      expect(result.code).toBe('operation_crashed');
      expect(reports).toHaveLength(1);
    } finally {
      release();
    }
    expect(stopping).toBe(0);
    expect(log).not.toContain('stop a');
    expect(manager.getComponentStatus('a')?.state).toBe('running');
    await manager.stopAllComponents();
  });

  test('stopComponent during a bulk startup refuses without reading options', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    const slow = recordingComponent(logger, 'slow', log);
    let release!: () => void;
    slow.start = (): Promise<void> =>
      new Promise((resolve) => {
        release = resolve;
      });
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    await manager.registerComponent(slow);
    const startup = manager.startAllComponents();
    await new Promise((resolve) => setTimeout(resolve, 0));
    log.length = 0;

    const result = await manager.stopComponent(
      'a',
      recordingOptions(log, {
        allowStopWithRunningDependents: true,
        forceImmediate: false,
        timeout: 1000,
      }),
    );

    expect(result.code).toBe('startup_in_progress');
    expect(log).toEqual([]);
    release();
    expect((await startup).success).toBe(true);
    await manager.stopAllComponents();
  });

  test('unregisterComponent reads forceStop for a component that is not running', async () => {
    const { logger, manager } = setup();
    const log: string[] = [];
    await manager.registerComponent(recordingComponent(logger, 'a', log));
    log.length = 0;

    const result = await manager.unregisterComponent(
      'a',
      recordingOptions(log, { stopIfRunning: true, forceStop: false }),
    );

    expect(result.success).toBe(true);
    expect(log).toEqual(['stopIfRunning', 'forceStop']);
  });

  test('sendMessageToComponent to a missing component reads no options', async () => {
    const { manager } = setup();
    const log: string[] = [];

    const result = await manager.sendMessageToComponent(
      'missing',
      'hi',
      recordingOptions(log, {
        includeStopped: false,
        includeStalled: false,
        timeout: 1000,
      }),
    );

    expect(result.code).toBe('not_found');
    expect(log).toEqual([]);
  });
});
