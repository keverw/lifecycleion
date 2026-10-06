import { expect, test } from 'bun:test';
import { ComponentStopTimeoutError } from './errors';
import { sleep } from '../sleep';
import type { ArraySink } from '../logger/sinks/array';
import { deferred, Plain, setup } from './test-helpers';

for (const shouldDelayNotification of [false, true]) {
  test(`force timeout after graceful completion reports only the real late rejection (delayed notification: ${shouldDelayNotification})`, async () => {
    const { logger, manager } = setup();
    const sink = logger.getSinks()[0] as ArraySink;
    const graceful = deferred();
    const force = deferred();
    const component = new Plain(logger, 'a');
    component.stop = (): Promise<void> => graceful.promise;
    Object.assign(component, {
      shutdownGracefulTimeoutMS: 5,
      shutdownForceTimeoutMS: 5,
      onShutdownForce: (signal: AbortSignal): Promise<void> => {
        signal.addEventListener('abort', () => {
          graceful.resolve();
        });
        return force.promise;
      },
    });
    if (shouldDelayNotification) {
      // Exercise both race winners without changing the real stopped-state writes:
      // graceful completion is recorded, but its force-waiter notification arrives
      // after the force deadline. The catch must not label that deadline a hook error.
      const internals = manager as unknown as {
        createPendingForceStopWaiter: (name: string) => {
          promise: Promise<void>;
          cleanup: () => void;
        };
      };
      const original = internals.createPendingForceStopWaiter.bind(manager);
      internals.createPendingForceStopWaiter = (name) => {
        const waiter = original(name);
        return { ...waiter, promise: waiter.promise.then(() => sleep(25)) };
      };
    }
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const result = await manager.stopComponent('a');
    expect(result.success).toBe(true);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    const failures = () =>
      sink.logs.filter((entry) =>
        entry.message.startsWith('Force shutdown failed'),
      );
    expect(failures()).toHaveLength(0);
    // The abandoned classification must survive a new run replacing stopped state.
    expect((await manager.startComponent('a')).success).toBe(true);
    force.reject(new Error('real late force rejection'));
    await sleep(10);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].type).toBe('warn');
    expect(failures()[0].message).toBe(
      'Force shutdown failed after graceful stop completed',
    );
  });
}

for (const phase of ['graceful', 'force', 'escalated-force'] as const) {
  test(`${phase} rejection from its abort listener has one failure reporter`, async () => {
    const { logger, manager } = setup();
    const sink = logger.getSinks()[0] as ArraySink;
    const pending = deferred();
    const failure = new Error('cleanup rejected during abort');
    const component = new Plain(logger, 'a');
    // Rejects the pending call from its own signal's abort listener.
    const rejectOnAbort = (signal: AbortSignal): Promise<void> => {
      signal.addEventListener('abort', () => {
        pending.reject(failure);
      });
      return pending.promise;
    };
    component.stop = (signal: AbortSignal): Promise<void> =>
      phase === 'escalated-force'
        ? new Promise(() => {})
        : phase === 'graceful'
          ? rejectOnAbort(signal)
          : pending.promise;
    Object.assign(component, {
      shutdownGracefulTimeoutMS: 5,
      shutdownForceTimeoutMS: 5,
      onShutdownForce: phase === 'graceful' ? undefined : rejectOnAbort,
    });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const result = await manager.stopComponent('a', {
      forceImmediate: phase === 'force',
    });
    await sleep(10);
    expect(result.success).toBe(false);
    expect(result.code).toBe('error');
    expect(result.error).toBe(failure);
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
    // The deadline observer owns the actual rejection once installed.
    // The foreground catch must still update state and return the error. A rejection
    // that beat the deferred deadline - in either phase - is labelled as the failure
    // the result records, not as one after the deadline, which the result does not report.
    const reports = sink.logs.filter((entry) =>
      phase === 'graceful'
        ? entry.message.startsWith('Graceful shutdown threw error') ||
          entry.message.startsWith('Component stop failed after')
        : entry.message.startsWith('Force shutdown failed'),
    );
    expect(reports).toHaveLength(1);
    expect(result.status?.stallInfo?.reason).toBe(
      phase === 'escalated-force' ? 'both' : 'error',
    );
    expect(reports[0].type).toBe(phase === 'graceful' ? 'warn' : 'error');
    expect(reports[0].message).toBe(
      phase === 'graceful'
        ? 'Graceful shutdown threw error: cleanup rejected during abort'
        : 'Force shutdown failed - stalled: cleanup rejected during abort',
    );
  });
}

test('a component-created stop timeout error is a hook failure, not this attempt deadline', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const failure = new ComponentStopTimeoutError({
    componentName: 'a',
    timeoutMS: 5,
  });
  component.stop = (): Promise<void> => Promise.reject(failure);
  Object.assign(component, { onShutdownForce: undefined });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const result = await manager.stopComponent('a');
  expect(result.success).toBe(false);
  expect(result.code).toBe('error');
  expect(result.error).toBe(failure);
});

test('same-turn graceful completion and force rejection use abandoned severity after a deadline', async () => {
  const { logger, manager } = setup();
  const sink = logger.getSinks()[0] as ArraySink;
  const graceful = deferred();
  const force = deferred();
  const component = new Plain(logger, 'a');
  component.stop = () => graceful.promise;
  Object.assign(component, {
    shutdownGracefulTimeoutMS: 5,
    shutdownForceTimeoutMS: 5,
    onShutdownForce: (signal: AbortSignal) => {
      signal.addEventListener('abort', () => {
        graceful.resolve();
        force.reject(new Error('abandoned cleanup'));
      });
      return force.promise;
    },
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const result = await manager.stopComponent('a');
  await sleep(0);
  expect(result.success).toBe(true);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  const reports = sink.logs.filter((entry) =>
    entry.message.startsWith('Force shutdown failed'),
  );
  expect(reports).toHaveLength(1);
  expect(reports[0].type).toBe('warn');
  expect(reports[0].message).toBe(
    'Force shutdown failed after graceful stop completed',
  );
});

for (const isForceImmediate of [false, true]) {
  test(`undefined hook rejection before any deadline is not a timeout (force: ${isForceImmediate})`, async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    // Deliberately violate the hook error contract to exercise identity checks
    // before the lazy deadline error exists.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const reject = (): Promise<void> => Promise.reject();
    component.stop = reject;
    Object.assign(component, {
      onShutdownForce: isForceImmediate ? reject : undefined,
    });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const result = await manager.stopComponent('a', {
      forceImmediate: isForceImmediate,
    });
    expect(result.success).toBe(false);
    expect(result.code).toBe('error');
    expect(result.status?.stallInfo?.reason).toBe('error');
  });
}

test('a recorded force timeout keeps its failure severity after late graceful reconciliation', async () => {
  const { logger, manager } = setup();
  const sink = logger.getSinks()[0] as ArraySink;
  const graceful = deferred();
  const force = deferred();
  const component = new Plain(logger, 'a');
  component.stop = () => graceful.promise;
  Object.assign(component, {
    shutdownGracefulTimeoutMS: 5,
    shutdownForceTimeoutMS: 5,
    onShutdownForce: () => force.promise,
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const result = await manager.stopComponent('a');
  expect(result.success).toBe(false);
  expect(result.code).toBe('component_shutdown_timeout');
  expect(result.status?.state).toBe('stalled');
  graceful.resolve();
  await sleep(0);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  force.reject(new Error('failed attempt cleanup'));
  await sleep(0);
  const reports = sink.logs.filter((entry) =>
    entry.message.startsWith('Force shutdown failed'),
  );
  expect(reports).toHaveLength(1);
  expect(reports[0].type).toBe('error');
  expect(result.code).toBe('component_shutdown_timeout');
});
