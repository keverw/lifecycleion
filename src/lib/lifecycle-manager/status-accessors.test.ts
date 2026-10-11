import { expect, test } from 'bun:test';
import { LifecycleManager } from './lifecycle-manager';
import { deferred, Plain, setup } from './test-helpers';

test('a manager without a root logger is refused', () => {
  expect(
    () =>
      new LifecycleManager(
        {} as ConstructorParameters<typeof LifecycleManager>[0],
      ),
  ).toThrow('LifecycleManager requires a root logger');
});

test('the system state is starting while a bulk start is in flight', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const gate = deferred();
  component.start = () => gate.promise;
  await manager.registerComponent(component);
  try {
    const starting = manager.startAllComponents();

    expect(manager.getSystemState()).toBe('starting');
    expect(manager.getStatus().systemState).toBe('starting');

    gate.resolve();
    expect((await starting).success).toBe(true);
    expect(manager.getSystemState()).toBe('running');
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('the system state is stalled while a component is stalled', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'x');
  const stop = deferred();
  component.stop = () => stop.promise;
  Object.defineProperty(component, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  await manager.registerComponent(component);
  await manager.startAllComponents();
  try {
    const stopping = manager.stopComponent('x');
    stop.reject(new Error('stop failed'));
    await stopping;

    expect(manager.getComponentStatus('x')?.state).toBe('stalled');
    expect(manager.getSystemState()).toBe('stalled');
    expect(manager.getStatus().systemState).toBe('stalled');
    expect(manager.getStoppedComponentCount()).toBe(0);
  } finally {
    await manager.unregisterComponent('x', { forceStop: true });
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a timed-out start is counted as timed out and as stopped', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  Object.defineProperty(component, 'startupTimeoutMS', { value: 20 });
  component.start = () => new Promise<void>(() => {});
  await manager.registerComponent(component);
  await manager.registerComponent(new Plain(logger, 'b'));
  try {
    expect((await manager.startComponent('b')).success).toBe(true);
    expect((await manager.startComponent('a')).code).toBe(
      'component_startup_timeout',
    );

    expect(manager.getStartTimedOutComponentNames()).toEqual(['a']);
    expect(manager.getStartTimedOutComponentCount()).toBe(1);
    expect(manager.getStoppedComponentNames()).toEqual(['a']);
    expect(manager.getStoppedComponentCount()).toBe(1);
  } finally {
    await manager.stopAllComponents();
    await logger.close();
  }
});
