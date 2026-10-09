import { describe, expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, coreOf, Plain } from './test-helpers';

function setupWithSink(): {
  logger: Logger;
  manager: LifecycleManager;
  sink: ArraySink;
} {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });

  return {
    logger,
    manager: new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 }),
    sink,
  };
}

describe('LifecycleManager - review cleanups', () => {
  test('a sweep over more registered components than the entity cap reuses each child', async () => {
    const { logger, manager } = setupWithSink();
    const names = Array.from({ length: 300 }, (_, index) => `c-${index}`);

    for (const name of names) {
      await manager.registerComponent(new Plain(logger, name));
    }

    const managerLogger = coreOf(manager).logger;
    const firstSweep = names.map((name) => managerLogger.entity(name));
    const secondSweep = names.map((name) => managerLogger.entity(name));

    expect(
      secondSweep.every((child, index) => child === firstSweep[index]),
    ).toBe(true);
  });

  test('unregistering a running component logs that it is stopped first', async () => {
    const { logger, manager, sink } = setupWithSink();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startComponent('a');

    const result = await manager.unregisterComponent('a');

    expect(result.success).toBe(true);
    expect(
      sink.logs.some(
        (entry) =>
          entry.entityName === 'a' &&
          entry.message ===
            'Unregistering running component; stopping it first',
      ),
    ).toBe(true);
  });

  test('a rollback after a throwing lifecycle setter leaves what the setter set', async () => {
    const { logger, manager } = setupWithSink();
    const component = new Plain(logger, 'a');
    // What another manager would leave: its own handle, and the registered flag.
    const otherHandle = { owner: 'another manager' };
    let stored: unknown;

    Object.defineProperty(component, 'lifecycle', {
      configurable: true,
      get: () => stored,
      set: (): never => {
        stored = otherHandle;
        component._markRegistered();
        throw new Error('setter exploded');
      },
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(component);
    } finally {
      release();
    }

    expect(result.registered).toBe(false);
    expect(manager.hasComponent('a')).toBe(false);
    expect(component._isRegisteredWithManager()).toBe(true);
    expect(stored).toBe(otherHandle);
  });

  test('a rollback after a throwing lifecycle setter clears the handle it assigned', async () => {
    const { logger, manager } = setupWithSink();
    const component = new Plain(logger, 'a');
    let stored: unknown;

    Object.defineProperty(component, 'lifecycle', {
      configurable: true,
      get: () => stored,
      set: (value: unknown): never => {
        stored = value;
        throw new Error('setter exploded');
      },
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(component);
    } finally {
      release();
    }

    expect(result.registered).toBe(false);
    expect(stored).toBeUndefined();
    expect(component._isRegisteredWithManager()).toBe(false);
  });

  test('a neighbour named with the empty string is described', async () => {
    const { logger, manager } = setupWithSink();
    const unnamed = new Plain(logger, 'unnamed');
    unnamed.getName = (): string => '';
    await manager.registerComponent(unnamed);

    const result = await manager.insertComponentAt(
      new Plain(logger, 'b'),
      'end',
    );

    expect(result.actualPosition?.description).toBe('at end, after ');
  });

  test('a stop whose bookkeeping throws after marking it stopped still answers its status', async () => {
    const { logger, manager } = setupWithSink();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startComponent('a');

    const events = coreOf(manager).lifecycleEvents;
    const failure = new Error('bookkeeping failed');
    events.componentStopped = (): void => {
      throw failure;
    };

    const { reports, release } = claimReports();
    let result;
    try {
      result = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(true);
    expect(result.status?.state).toBe('stopped');
    expect(reports.length).toBeGreaterThan(0);
  });
});
