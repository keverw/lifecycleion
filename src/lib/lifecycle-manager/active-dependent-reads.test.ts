import { expect, test } from 'bun:test';
import { deferred, Plain, setup } from './test-helpers';

test('stop reads only active dependency lists and finds a dependent activated during a read', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'db');
  const dormant = new Plain(logger, 'dormant');
  const worker = new Plain(logger, 'worker', ['db']);
  const trigger = new Plain(logger, 'trigger');
  const gate = deferred<void>();
  worker.start = () => gate.promise;
  let dormantReads = 0;
  dormant.getDependencies = () => {
    dormantReads++;
    return [];
  };
  let shouldActivate = false;
  let starting: ReturnType<typeof manager.startComponent> | undefined;
  trigger.getDependencies = () => {
    if (shouldActivate) {
      shouldActivate = false;
      starting = manager.startComponent('worker');
    }
    return [];
  };
  for (const component of [database, dormant, worker, trigger]) {
    await manager.registerComponent(component);
  }
  await manager.startComponent('db');
  await manager.startComponent('trigger');
  dormantReads = 0;
  shouldActivate = true;
  try {
    const result = await manager.stopComponent('db');
    expect(result.code).toBe('has_running_dependents');
    expect(result.reason).toContain('starting dependents: worker');
    expect(dormantReads).toBe(0);
    expect(manager.getComponentStatus('db')?.state).toBe('running');
  } finally {
    gate.resolve();
    await starting;
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('pending timed-out dependent is described as pending startup work', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'db');
  const worker = new Plain(logger, 'worker', ['db']);
  worker.start = () => new Promise(() => {});
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 5 });
  await manager.registerComponent(database);
  await manager.registerComponent(worker);
  await manager.startComponent('db');
  await manager.startComponent('worker');
  try {
    const result = await manager.stopComponent('db');
    expect(result.code).toBe('has_running_dependents');
    expect(result.reason).toContain('pending startup work: worker');
    expect(result.reason).not.toContain('running dependents: worker');
  } finally {
    await manager.unregisterComponent('worker');
    await manager.stopAllComponents();
    await logger.close();
  }
});
