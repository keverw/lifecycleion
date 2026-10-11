import { expect, test } from 'bun:test';
import type { LifecycleManagerOptions } from './types';
import { sleep } from '../sleep';
import { deferred, Plain, setup } from './test-helpers';

// `x` depends on `db`; `x`'s stop fails and it has no force handler, so it stalls.
function stallingPlain(
  ...args: ConstructorParameters<typeof Plain>
): Plain & { failStop: (error: Error) => void } {
  const component = new Plain(...args);
  const stop = deferred();
  component.stop = () => stop.promise;
  Object.defineProperty(component, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  return Object.assign(component, { failStop: stop.reject });
}

async function setupStalledDependent(
  options: Partial<LifecycleManagerOptions> = {},
): Promise<
  ReturnType<typeof setup> & {
    warnings: string[];
    cleanup: () => Promise<void>;
  }
> {
  const context = setup(options);
  const { logger, manager } = context;
  const warnings: string[] = [];
  const db = new Plain(logger, 'db');
  const unrelated = new Plain(logger, 'unrelated');
  const x = stallingPlain(logger, 'x', ['db']);
  for (const component of [db, unrelated, x]) {
    component.onShutdownWarning = () => {
      warnings.push(component.getName());
    };
  }
  await manager.registerComponent(db);
  await manager.registerComponent(unrelated);
  await manager.registerComponent(x);
  await manager.startAllComponents();
  const stopping = manager.stopComponent('x');
  x.failStop(new Error('stop failed'));
  await stopping;
  expect(manager.getComponentStatus('x')?.state).toBe('stalled');
  return {
    ...context,
    warnings,
    cleanup: async () => {
      await manager.unregisterComponent('x', { forceStop: true });
      await manager.stopAllComponents();
      await logger.close();
    },
  };
}

test('dependencies a held stall keeps up are not sent the shutdown warning', async () => {
  const { manager, warnings, cleanup } = await setupStalledDependent({
    shutdownWarningTimeoutMS: 100,
  });
  try {
    const result = await manager.stopAllComponents({ retryStalled: false });
    expect(result.reason).toBe('Stalled: x; Not attempted: db');
    expect(manager.isComponentRunning('db')).toBe(true);
    expect(warnings).toEqual(['unrelated']);
  } finally {
    await cleanup();
  }
});

test('a stall a pass reaches without retrying it is held, not a failure that halts', async () => {
  const { logger, manager } = setup();
  const later = new Plain(logger, 'later');
  const db = new Plain(logger, 'db');
  const x = stallingPlain(logger, 'x', ['db']);
  const first = new Plain(logger, 'first');
  await manager.registerComponent(later);
  await manager.registerComponent(db);
  await manager.registerComponent(x);
  await manager.registerComponent(first);
  await manager.startAllComponents();
  // In flight as the pass begins, and stalled by the time its loop reaches `x`.
  const individual = manager.stopComponent('x');
  first.stop = async () => {
    x.failStop(new Error('stop failed'));
    await individual;
  };
  try {
    const result = await manager.stopAllComponents({ retryStalled: false });
    expect(result.success).toBe(false);
    expect(result.stalledComponents.map((stall) => stall.name)).toEqual(['x']);
    expect(result.reason).toBe('Stalled: x; Not attempted: db');
    expect(manager.isComponentRunning('db')).toBe(true);
    expect(manager.getComponentStatus('later')?.state).toBe('stopped');
    expect(manager.getComponentStatus('first')?.state).toBe('stopped');
  } finally {
    await individual;
    await manager.unregisterComponent('x', { forceStop: true });
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('an individual stop or restart refuses while a dependent is stalled', async () => {
  const { manager, cleanup } = await setupStalledDependent();
  try {
    const stopped = await manager.stopComponent('db');
    expect(stopped.success).toBe(false);
    expect(stopped.code).toBe('has_running_dependents');
    expect(stopped.reason).toContain('stalled dependents: x');
    expect(manager.isComponentRunning('db')).toBe(true);

    const restarted = await manager.restartComponent('db');
    expect(restarted.success).toBe(false);
    expect(restarted.code).toBe('has_running_dependents');
    expect(manager.isComponentRunning('db')).toBe(true);

    const unregistered = await manager.unregisterComponent('db');
    expect(unregistered.success).toBe(false);
    expect(unregistered.code).toBe('component_running');
    expect(manager.isComponentRunning('db')).toBe(true);

    const forced = await manager.stopComponent('db', {
      allowStopWithRunningDependents: true,
    });
    expect(forced.success).toBe(true);
  } finally {
    await cleanup();
  }
});

test('an isComponentRunning() override does not hide a running dependent from a stop', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'db'));
  await manager.registerComponent(new Plain(logger, 'api', ['db']));
  await manager.startAllComponents();
  Object.defineProperty(manager, 'isComponentRunning', {
    configurable: true,
    value: (): boolean => false,
  });
  try {
    const result = await manager.stopComponent('db');
    expect(result.code).toBe('has_running_dependents');
    expect(result.reason).toContain('running dependents: api');
  } finally {
    Reflect.deleteProperty(manager, 'isComponentRunning');
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a stall a retry attempted nothing for, cleared after its dependency was skipped, releases that dependency', async () => {
  const { logger, manager } = setup();
  const later = new Plain(logger, 'later');
  const db = new Plain(logger, 'db');
  const x = new Plain(logger, 'x', ['db']);
  const xStop = deferred();
  x.stop = () => xStop.promise;
  Object.defineProperty(x, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  Object.assign(x, { shutdownGracefulTimeoutMS: 5 });
  await manager.registerComponent(later);
  await manager.registerComponent(db);
  await manager.registerComponent(x);
  await manager.startAllComponents();
  // Timed out with its `stop()` still pending: stalled, until that stop finishes late.
  await manager.stopComponent('x');
  expect(manager.getComponentStatus('x')?.state).toBe('stalled');

  const order: string[] = [];
  db.stop = () => {
    order.push('db');
    return Promise.resolve();
  };
  // Reached after `db` was skipped for the held stall: the stall clears here, so only
  // the pass's second look at `db` can stop it.
  later.stop = async () => {
    order.push('later');
    xStop.resolve();
    await sleep(0);
    expect(manager.getComponentStatus('x')?.state).toBe('stopped');
  };

  try {
    // `retryStalled` retries `x`, which has no force handler: nothing attempted, so the
    // stall is held - under `haltOnStall` - rather than halting the pass.
    const result = await manager.stopAllComponents();
    expect(order).toEqual(['later', 'db']);
    expect(result.success).toBe(true);
    expect(manager.getComponentStatus('db')?.state).toBe('stopped');
  } finally {
    xStop.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});
