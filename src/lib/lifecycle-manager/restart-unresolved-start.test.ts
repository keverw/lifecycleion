import { expect, test } from 'bun:test';
import { deferred, Plain, setup } from './test-helpers';

for (const hasAbortHook of [false, true]) {
  test(`restart refuses before stopping anything while a timed-out start is unresolved (abort hook: ${hasAbortHook})`, async () => {
    const { logger, manager } = setup();
    const database = new Plain(logger, 'database');
    const unrelated = new Plain(logger, 'unrelated');
    const worker = new Plain(logger, 'worker', ['database']);
    const gate = deferred();
    let unrelatedStops = 0;
    let databaseStops = 0;
    unrelated.stop = () => {
      unrelatedStops++;
      return Promise.resolve();
    };
    database.stop = () => {
      databaseStops++;
      return Promise.resolve();
    };
    await manager.registerComponent(database);
    await manager.registerComponent(unrelated);
    await manager.registerComponent(worker);
    await manager.startComponent('database');
    await manager.startComponent('unrelated');
    worker.start = () => gate.promise;
    if (hasAbortHook) {
      worker.onStartupAborted = () => {};
    }
    Object.defineProperty(worker, 'startupTimeoutMS', { value: 10 });
    expect((await manager.startComponent('worker')).code).toBe(
      'component_startup_timeout',
    );

    try {
      const result = await manager.restartAllComponents({
        shutdownTimeoutMS: 500,
      });

      expect(result.success).toBe(false);
      expect(result.shutdownResult).toMatchObject({
        success: false,
        code: 'cleanup_incomplete',
        stoppedComponents: [],
        stalledComponents: [],
        durationMS: 0,
      });
      expect(result.shutdownResult.reason).toContain(
        'Timed-out start still unresolved for: worker',
      );
      expect(result.startupResult.code).toBe('partial_state');
      expect(result.startupResult.reason).toContain('startup skipped');
      // Nothing was stopped: the application is left as it was, not half down.
      expect(unrelatedStops).toBe(0);
      expect(databaseStops).toBe(0);
      expect(manager.getRunningComponentNames().sort()).toEqual([
        'database',
        'unrelated',
      ]);
      // No shutdown pass ran.
      expect(manager.getLastShutdownResult()).toBeNull();
    } finally {
      gate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}
