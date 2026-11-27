import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, deferred } from './test-helpers';

const logger = new Logger({ sinks: [], callProcessExit: false });

class Counted extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public gate: Promise<void> | undefined;
  public async start(): Promise<void> {
    this.starts++;
    await this.gate;
  }
  public stop(): void {
    this.stops++;
  }
}

// The restart's stop pass also stops a component whose start is still in flight - once
// that start settles. Its stop budgets are read then, so they are validated up front with
// the running components', not discovered after everything else is already down.
test('restart validates the stop budget of a component whose start is in flight', async () => {
  const manager = new LifecycleManager({ logger });
  const running = new Counted(logger, { name: 'running' });
  const starting = new Counted(logger, { name: 'starting' });
  await manager.registerComponent(running);
  await manager.registerComponent(starting);
  await manager.startComponent('running');

  const gate = deferred();
  starting.gate = gate.promise;
  const pendingStart = manager.startComponent('starting');
  let timeout = -1;
  Object.defineProperty(starting, 'shutdownGracefulTimeoutMS', {
    get: () => timeout,
  });

  // Without the preflight the stop pass takes `running` down and then waits on the
  // in-flight start; let it settle then, so the failure shows up as a result.
  manager.on('component:stopped', ({ name }: { name: string }) => {
    if (name === 'running') {
      gate.resolve();
    }
  });

  const { reports, release } = claimReports();
  let restart: Awaited<ReturnType<typeof manager.restartAllComponents>>;
  try {
    restart = await manager.restartAllComponents();
    gate.resolve();
    expect(reports).toEqual([]);
  } finally {
    release();
  }

  expect(restart.success).toBe(false);
  expect(restart.shutdownResult.code).toBe('invalid_options');
  expect(restart.shutdownResult.error?.message).toContain(
    'starting.shutdownGracefulTimeoutMS',
  );
  expect(restart.startupResult.code).toBe('invalid_options');
  expect(running.stops).toBe(0);
  expect(manager.getComponentStatus('running')?.state).toBe('running');

  expect((await pendingStart).success).toBe(true);
  expect(starting.stops).toBe(0);
  expect(manager.getComponentStatus('starting')?.state).toBe('running');

  timeout = 1000;
  const stopped = await manager.stopAllComponents();
  expect(stopped.success).toBe(true);
});
