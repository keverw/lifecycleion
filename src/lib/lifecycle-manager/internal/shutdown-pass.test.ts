import { expect, test } from 'bun:test';
import { sleep } from '../../sleep';
import { Plain, setup } from '../test-helpers';

test('a dependency protected while a start cleans up is stopped once that cleanup ends', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const worker = new Plain(logger, 'worker', ['database']);
  const cache = new Plain(logger, 'cache');
  const unrelated = new Plain(logger, 'unrelated');
  worker.start = () => sleep(2);
  worker.stop = () => sleep(50);
  cache.stop = () => sleep(100);
  unrelated.stop = () => sleep(5);
  for (const component of [database, worker, cache, unrelated]) {
    await manager.registerComponent(component);
  }
  for (const name of ['database', 'cache', 'unrelated']) {
    await manager.startComponent(name);
  }
  const starting = manager.startComponent('worker');

  const result = await manager.stopAllComponents({
    timeoutMS: 3000,
    allowStopWithPendingStarts: true,
  });
  await starting;

  expect(result.success).toBe(true);
  expect(result.stoppedComponents).toContain('database');
  expect(manager.getComponentStatus('database')?.state).toBe('stopped');
  await logger.close();
});

test('a pass waits for a concurrent stop, then stops the dependencies it held', async () => {
  const { logger, manager } = setup();
  const dependency = new Plain(logger, 'dependency');
  const dependent = new Plain(logger, 'dependent', ['dependency']);
  dependent.stop = () => sleep(100);
  await manager.registerComponent(dependency);
  await manager.registerComponent(dependent);
  await manager.startAllComponents();

  const individualStop = manager.stopComponent('dependent');
  const result = await manager.stopAllComponents({ timeoutMS: 3000 });

  expect(result.success).toBe(true);
  expect(result.stoppedComponents).toContain('dependency');
  expect(manager.getComponentStatus('dependency')?.state).toBe('stopped');
  expect((await individualStop).success).toBe(true);
  await logger.close();
});

test('a pass does not wait for a stop whose component requested it through its own handle', async () => {
  const { logger, manager } = setup();
  const dependency = new Plain(logger, 'dependency');
  const requester = new Plain(logger, 'requester', ['dependency']);
  // Its stop awaits the pass it begins, so the pass waiting for that stop would hold
  // both until the stop's own timeout.
  requester.stop = async (): Promise<void> => {
    await (
      requester as unknown as {
        lifecycle: { stopAllComponents: () => Promise<unknown> };
      }
    ).lifecycle.stopAllComponents();
  };
  await manager.registerComponent(dependency);
  await manager.registerComponent(requester);
  await manager.startAllComponents();

  const result = await manager.stopComponent('requester');

  expect(result.success).toBe(true);
  expect(manager.getComponentStatus('requester')?.state).toBe('stopped');
  // Left up by the pass, as a dependency of a stop it did not wait for.
  expect(manager.isComponentRunning('dependency')).toBe(true);
  await manager.stopAllComponents();
  await logger.close();
});
