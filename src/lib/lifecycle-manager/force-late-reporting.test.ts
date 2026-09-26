import { expect, test } from 'bun:test';
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
      onShutdownForce: (): Promise<void> => force.promise,
      onShutdownForceAborted: (): void => {
        graceful.resolve();
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
    force.reject(new Error('real late force rejection'));
    await sleep(10);
    expect(failures()).toHaveLength(1);
    expect(failures()[0].message).toBe('Force shutdown failed after timeout');
  });
}
