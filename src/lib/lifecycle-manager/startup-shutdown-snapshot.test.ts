import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { deferred, Plain } from './test-helpers';

test('startup interrupted by shutdown excludes components already in teardown', async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const first = new Plain(logger, 'first');
  const second = new Plain(logger, 'second');
  const stopEntered = deferred();
  const finishStop = deferred();
  first.stop = async () => {
    stopEntered.resolve();
    await finishStop.promise;
  };
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  second.start = async () => {
    shutdown = manager.stopAllComponents();
    await stopEntered.promise;
  };
  await manager.registerComponent(first);
  await manager.registerComponent(second);
  try {
    const result = await manager.startAllComponents();
    expect(manager.getComponentStatus('first')?.state).toBe('stopping');
    expect(result).toMatchObject({
      success: false,
      code: 'shutdown_in_progress',
      startedComponents: [],
    });
  } finally {
    finishStop.resolve();
    await shutdown;
    await manager.stopAllComponents();
  }
});
