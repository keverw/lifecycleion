import { expect, test } from 'bun:test';
import { claimReports, deferred, Plain, setup } from './test-helpers';

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

test('the dependencies held up by a failed stop are reported as not attempted, not as failed stops', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: -1 });
  const database = new Plain(logger, 'database');
  const api = new Plain(logger, 'api', ['database']);
  let databaseStops = 0;
  database.stop = () => {
    databaseStops++;
    return Promise.resolve();
  };
  await manager.registerComponent(database);
  await manager.registerComponent(api);
  await manager.startAllComponents();
  // Refused before cleanup starts: `api` stays running and holds `database` up.
  Object.defineProperty(api, 'shutdownGracefulTimeoutMS', {
    value: -5,
    configurable: true,
  });

  const { release } = claimReports();
  try {
    const result = await manager.stopAllComponents({ haltOnStall: false });

    expect(result).toMatchObject({
      success: false,
      code: 'invalid_options',
      stoppedComponents: [],
    });
    expect(result.reason).toStartWith(
      'Failed to stop: api; Not attempted: database;',
    );
    expect(databaseStops).toBe(0);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
  } finally {
    release();
    Object.defineProperty(api, 'shutdownGracefulTimeoutMS', {
      value: 1000,
      configurable: true,
    });
    await manager.stopAllComponents();
    await logger.close();
  }
});
