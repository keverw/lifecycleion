import { expect, test } from 'bun:test';
import { deferred, Plain, setup } from './test-helpers';

for (const isDatabaseFirst of [false, true]) {
  test(`unrelated shutdown work precedes startup joins (database first: ${isDatabaseFirst})`, async () => {
    const { logger, manager } = setup();
    const cache = new Plain(logger, 'cache');
    const database = new Plain(logger, 'database');
    const api = new Plain(logger, 'api', ['database']);
    const gate = deferred();
    const stopped: string[] = [];
    api.start = () => gate.promise;
    Object.defineProperty(api, 'startupTimeoutMS', { value: 0 });
    cache.stop = () => {
      stopped.push('cache');
      return Promise.resolve();
    };
    database.stop = () => {
      stopped.push('database');
      return Promise.resolve();
    };
    for (const component of isDatabaseFirst
      ? [database, cache, api]
      : [cache, database, api]) {
      await manager.registerComponent(component);
    }
    await manager.startComponent('cache');
    await manager.startComponent('database');
    const starting = manager.startComponent('api');
    try {
      const result = await manager.stopAllComponents({ timeoutMS: 30 });
      expect(result.code).toBe('shutdown_timeout');
      expect(result.stoppedComponents).toContain('cache');
      expect(stopped).toEqual(['cache']);
      expect(manager.getComponentStatus('database')?.state).toBe('running');
    } finally {
      gate.resolve();
      await starting;
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}

test('a timeout abort hook that settles startup leaves no incomplete cleanup', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const api = new Plain(logger, 'api', ['database']);
  const gate = deferred();
  api.start = () => gate.promise;
  api.onStartupAborted = () => gate.reject(new Error('aborted'));
  Object.defineProperty(api, 'startupTimeoutMS', { value: 10 });
  await manager.registerComponent(database);
  await manager.registerComponent(api);
  await manager.startComponent('database');
  const starting = manager.startComponent('api');
  try {
    const result = await manager.stopAllComponents({ timeoutMS: 1000 });
    expect((await starting).code).toBe('component_startup_timeout');
    expect(result.success).toBe(true);
    expect(result.stoppedComponents).toContain('database');
    expect(result.code).toBeUndefined();
    expect(manager.getRunningComponentNames()).toEqual([]);
  } finally {
    gate.resolve();
    await starting;
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('known protected dependencies do not receive shutdown warnings', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 100 });
  const database = new Plain(logger, 'database');
  const api = new Plain(logger, 'api', ['database']);
  const gate = deferred();
  let warnings = 0;
  database.onShutdownWarning = () => {
    warnings++;
  };
  api.start = () => gate.promise;
  Object.defineProperty(api, 'startupTimeoutMS', { value: 5 });
  await manager.registerComponent(database);
  await manager.registerComponent(api);
  await manager.startComponent('database');
  await manager.startComponent('api');
  try {
    for (let pass = 0; pass < 2; pass++) {
      expect((await manager.stopAllComponents()).code).toBe(
        'cleanup_incomplete',
      );
      expect(warnings).toBe(0);
      expect(manager.getComponentStatus('database')?.state).toBe('running');
    }
  } finally {
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('an abort hook that leaves startup pending retains protection across shutdown passes', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const api = new Plain(logger, 'api', ['database']);
  const gate = deferred();
  api.start = () => gate.promise;
  api.onStartupAborted = () => {};
  Object.defineProperty(api, 'startupTimeoutMS', { value: 10 });
  await manager.registerComponent(database);
  await manager.registerComponent(api);
  await manager.startComponent('database');
  const starting = manager.startComponent('api');
  try {
    expect((await manager.stopAllComponents()).code).toBe('cleanup_incomplete');
    await starting;
    expect((await manager.stopAllComponents()).code).toBe('cleanup_incomplete');
    expect((await manager.stopComponent('database')).code).toBe(
      'has_running_dependents',
    );
    expect(manager.getComponentStatus('database')?.state).toBe('running');
  } finally {
    gate.reject(new Error('aborted'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await manager.stopAllComponents()).success).toBe(true);
    await logger.close();
  }
});
