import { expect, test } from 'bun:test';
import type { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { deferred, Plain, setup } from './test-helpers';

test('a start that times out during a finite shutdown pass does not consume its budget', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  const other = new Plain(logger, 'other');
  const worker = new Plain(logger, 'worker', ['database']);
  const gate = deferred();
  worker.start = () => gate.promise;
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 20 });
  await manager.registerComponent(database);
  await manager.registerComponent(other);
  await manager.registerComponent(worker);
  await manager.startComponent('database');
  await manager.startComponent('other');
  const starting = manager.startComponent('worker');
  try {
    const shutdownStartedAt = Date.now();
    const result = await manager.stopAllComponents({ timeoutMS: 1000 });
    // Abandoned mid-pass, the start is treated as one already timed out when the pass
    // began: its dependency stays up for the late cleanup, and the pass reports that
    // instead of waiting out the budget.
    expect(Date.now() - shutdownStartedAt).toBeLessThan(500);
    expect(result.timedOut).toBeUndefined();
    expect(result.code).toBe('cleanup_incomplete');
    expect(result.stoppedComponents).toEqual(['other']);
    expect(manager.getComponentStatus('database')?.state).toBe('running');
    expect((await starting).code).toBe('component_startup_timeout');
  } finally {
    gate.resolve();
    await starting;
    await manager.stopAllComponents();
  }
});

class NoForce extends BaseComponent {
  constructor(logger: Logger, name: string) {
    super(logger, { name });
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}

  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

test('a refused stop whose component went down by another path does not name the pass', async () => {
  const { logger, manager } = setup();
  const b = new NoForce(logger, 'b');
  const a = new NoForce(logger, 'a');
  const hang = deferred();
  Object.defineProperty(b, 'shutdownGracefulTimeoutMS', { value: 20 });
  b.stop = async () => {
    a.reportStop();
    await hang.promise;
  };
  await manager.registerComponent(b);
  await manager.registerComponent(a);
  await manager.startAllComponents();
  Object.defineProperty(a, 'shutdownGracefulTimeoutMS', { value: NaN });
  try {
    const result = await manager.stopAllComponents({ haltOnStall: false });
    expect(result.stoppedComponents).toEqual(['a']);
    expect(result.stalledComponents.map((stall) => stall.name)).toEqual(['b']);
    expect(result.code).toBe('partial_state');
    expect(result.error).toBeUndefined();
  } finally {
    hang.resolve();
  }
});

test('a refused stop still names the pass while its component is left running', async () => {
  const { logger, manager } = setup();
  const a = new NoForce(logger, 'a');
  await manager.registerComponent(a);
  await manager.startAllComponents();
  Object.defineProperty(a, 'shutdownGracefulTimeoutMS', { value: NaN });
  const result = await manager.stopAllComponents();
  expect(result.code).toBe('invalid_options');
  expect(result.error).toBeInstanceOf(Error);
  expect(manager.getComponentStatus('a')?.state).toBe('running');
  Object.defineProperty(a, 'shutdownGracefulTimeoutMS', { value: 1000 });
  expect((await manager.stopAllComponents()).success).toBe(true);
});

test('a restart that fails on its own during a shutdown pass is not reported as stopped by it', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'c');
  await manager.registerComponent(component);
  await manager.startComponent('c');
  await manager.stopComponent('c');
  component.start = async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    throw new Error('start failed');
  };
  const starting = manager.startComponent('c');
  const result = await manager.stopAllComponents();
  expect((await starting).success).toBe(false);
  expect(manager.getComponentStatus('c')?.state).toBe('stopped');
  expect(result.success).toBe(true);
  expect(result.stoppedComponents).toEqual([]);
});

test('a start that comes up during a shutdown pass and is stopped by it is reported as stopped', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'c');
  const gate = deferred();
  await manager.registerComponent(component);
  await manager.startComponent('c');
  await manager.stopComponent('c');
  component.start = () => gate.promise;
  const starting = manager.startComponent('c');
  const shutdown = manager.stopAllComponents();
  gate.resolve();
  const result = await shutdown;
  expect((await starting).code).toBe('shutdown_in_progress');
  expect(result.success).toBe(true);
  expect(result.stoppedComponents).toEqual(['c']);
});
