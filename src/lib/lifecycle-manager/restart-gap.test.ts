import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import type { RegisterComponentResult } from './types';
import { claimReports } from './test-helpers';

class Counted extends BaseComponent {
  public starts = 0;
  public start() {
    this.starts++;
  }
  public stop() {}
}

function setup() {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  return { sink, logger, manager };
}

test.each([false, true])(
  'auto-start in the restart gap joins the upcoming startup (dependency: %s)',
  async (hasDependency) => {
    const { logger, manager } = setup();
    const first = new Counted(logger, { name: 'first' });
    const late = new Counted(logger, {
      name: 'late',
      dependencies: hasDependency ? ['first'] : [],
    });
    await manager.registerComponent(first);
    await manager.startAllComponents();
    let registration: Promise<RegisterComponentResult> | undefined;
    manager.once('lifecycle-manager:shutdown-completed', () => {
      queueMicrotask(() => {
        registration = manager.registerComponent(late, { autoStart: true });
      });
    });
    const restart = await manager.restartAllComponents();
    expect(await registration).toMatchObject({
      success: true,
      autoStartDeferred: true,
    });
    expect(restart.success).toBe(true);
    expect(restart.startupResult.startedComponents).toEqual(['first', 'late']);
    expect(first.starts).toBe(2);
    expect(late.starts).toBe(1);
    await manager.stopAllComponents();
  },
);

test.each(['cancel', 'throw', 'refuse'] as const)(
  'a %s in the restart gap abandons deferred auto-starts and clears its reservation',
  async (mode) => {
    const { sink, logger, manager } = setup();
    const first = new Counted(logger, { name: 'first' });
    const late = new Counted(logger, { name: 'late' });
    await manager.registerComponent(first);
    await manager.startAllComponents();
    let registration: Promise<RegisterComponentResult> | undefined;
    let stop: Promise<unknown> | undefined;
    const getCount = manager.getComponentCount.bind(manager);
    manager.once('lifecycle-manager:shutdown-completed', () => {
      queueMicrotask(() => {
        registration = manager.registerComponent(late, { autoStart: true });
        if (mode === 'cancel') {
          stop = manager.stopAllComponents();
        }
        if (mode === 'throw') {
          manager.getComponentCount = () => {
            throw new Error('gap failure');
          };
        }
        if (mode === 'refuse') {
          manager.getComponentCount = () => 0;
        }
      });
    });
    const { reports, release } = claimReports();
    const result = await manager.restartAllComponents().finally(() => {
      manager.getComponentCount = getCount;
      release();
    });
    expect(reports.length).toBe(mode === 'throw' ? 1 : 0);
    await stop;
    expect(result.success).toBe(false);
    expect(result.startupResult.code).toBe(
      mode === 'cancel'
        ? 'shutdown_requested_during_restart'
        : mode === 'throw'
          ? 'unknown_error'
          : 'no_components_registered',
    );
    expect(await registration).toMatchObject({
      success: true,
      autoStartDeferred: true,
      autoStartAttempted: false,
    });
    expect(late.starts).toBe(0);
    expect(manager.getComponentStatus('late')?.state).toBe('registered');
    expect(
      sink.logs.some((log) =>
        log.message.includes('deferred auto-starts were not attempted'),
      ),
    ).toBe(true);
    const after = new Counted(logger, { name: 'after' });
    expect(
      await manager.registerComponent(after, { autoStart: true }),
    ).toMatchObject({ autoStartAttempted: true, autoStartSucceeded: true });
    expect(after.starts).toBe(1);
    await manager.stopAllComponents();
  },
);

test('another startup claims gap registrations and releases the reservation at its latch', async () => {
  const { logger, manager } = setup();
  const first = new Counted(logger, { name: 'first' });
  const late = new Counted(logger, { name: 'late' });
  const after = new Counted(logger, { name: 'after' });
  await manager.registerComponent(first);
  await manager.startAllComponents();
  let registration: Promise<RegisterComponentResult> | undefined;
  let afterRegistration: Promise<RegisterComponentResult> | undefined;
  let startup: Promise<unknown> | undefined;
  manager.once('lifecycle-manager:shutdown-completed', () => {
    queueMicrotask(() => {
      registration = manager.registerComponent(late, { autoStart: true });
      startup = manager.startAllComponents().then(() => {
        afterRegistration = manager.registerComponent(after, {
          autoStart: true,
        });
      });
    });
  });
  await manager.restartAllComponents();
  await startup;
  expect(await registration).toMatchObject({ autoStartDeferred: true });
  expect(await afterRegistration).toMatchObject({
    autoStartAttempted: true,
    autoStartSucceeded: true,
  });
  expect(late.starts).toBe(1);
  expect(after.starts).toBe(1);
  await manager.stopAllComponents();
});

test('restart preflight refusal leaves no auto-start reservation', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Counted(logger, { name: 'first' }));
  await manager.startAllComponents();
  expect(
    (
      await manager.restartAllComponents({
        startupOptions: { timeoutMS: Number.NaN },
      })
    ).success,
  ).toBe(false);
  const late = new Counted(logger, { name: 'late' });
  expect(
    await manager.registerComponent(late, { autoStart: true }),
  ).toMatchObject({ autoStartAttempted: true, autoStartSucceeded: true });
  expect(late.starts).toBe(1);
  await manager.stopAllComponents();
});

test('an older restart finalizer does not discard a nested restart handoff', async () => {
  const { logger, manager } = setup();
  const first = new Counted(logger, { name: 'first' });
  const late = new Counted(logger, { name: 'late' });
  await manager.registerComponent(first);
  await manager.startAllComponents();
  let nested: ReturnType<LifecycleManager['restartAllComponents']> | undefined;
  let registration: Promise<RegisterComponentResult> | undefined;
  manager.once('lifecycle-manager:shutdown-completed', () => {
    queueMicrotask(() => {
      manager.once('lifecycle-manager:shutdown-completed', () => {
        queueMicrotask(() => {
          registration = manager.registerComponent(late, { autoStart: true });
        });
      });
      nested = manager.restartAllComponents();
    });
  });
  await manager.restartAllComponents();
  const nestedResult = await nested;
  expect(await registration).toMatchObject({ autoStartDeferred: true });
  expect(nestedResult?.success).toBe(true);
  expect(first.starts).toBe(2);
  expect(late.starts).toBe(1);
  await manager.stopAllComponents();
});
