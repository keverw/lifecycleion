import { expect, test } from 'bun:test';
import { BaseComponent } from './base-component';
import { Plain, deferred, setup } from './test-helpers';

// A shutdown pass with `retryStalled` that begins while a forced start of a stalled
// component is in flight joins that start. If the start fails and leaves the component
// stalled again, the pass retries the stall as it would any other.

test('retryStalled retries a stall whose in-flight forced start failed', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  let startCalls = 0;
  let forceCalls = 0;

  class Component extends BaseComponent {
    constructor() {
      super(logger, { name: 'forced', shutdownGracefulTimeoutMS: 20 });
    }

    public async start(): Promise<void> {
      startCalls++;
      if (startCalls === 2) {
        await gate.promise;
        throw new Error('forced start failed');
      }
    }

    public async stop(): Promise<void> {
      // Never finishes, leaving the component stalled.
      await new Promise<void>(() => {});
    }

    public onShutdownForce(): void {
      forceCalls++;
      if (forceCalls === 1) {
        throw new Error('first force failed');
      }
    }
  }

  await manager.registerComponent(new Component());
  await manager.startComponent('forced');
  await manager.stopComponent('forced');
  expect(manager.getComponentStatus('forced')?.state).toBe('stalled');

  const pendingStart = manager.startComponent('forced', { forceStalled: true });
  await Promise.resolve();
  const pendingStop = manager.stopAllComponents({ retryStalled: true });
  gate.resolve();

  expect((await pendingStart).success).toBe(false);
  const result = await pendingStop;
  expect(forceCalls).toBe(2);
  expect(result.success).toBe(true);
  expect(manager.getComponentStatus('forced')?.state).toBe('stopped');
});

test('a retried stall does not leave its dependencies protected', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  let startCalls = 0;
  let forceCalls = 0;

  class Component extends BaseComponent {
    constructor() {
      super(logger, {
        name: 'forced',
        dependencies: ['db'],
        shutdownGracefulTimeoutMS: 20,
      });
    }

    public async start(): Promise<void> {
      startCalls++;
      if (startCalls === 2) {
        await gate.promise;
        throw new Error('forced start failed');
      }
    }

    public async stop(): Promise<void> {
      await new Promise<void>(() => {});
    }

    public onShutdownForce(): void {
      forceCalls++;
      if (forceCalls === 1) {
        throw new Error('first force failed');
      }
    }
  }

  await manager.registerComponent(new Plain(logger, 'db'));
  await manager.registerComponent(new Component());
  await manager.startAllComponents();
  await manager.stopComponent('forced');
  expect(manager.getComponentStatus('forced')?.state).toBe('stalled');

  const pendingStart = manager.startComponent('forced', { forceStalled: true });
  await Promise.resolve();
  const pendingStop = manager.stopAllComponents({ retryStalled: true });
  gate.resolve();

  expect((await pendingStart).success).toBe(false);
  const result = await pendingStop;
  expect(result.success).toBe(true);
  expect(manager.getComponentStatus('forced')?.state).toBe('stopped');
  expect(manager.getComponentStatus('db')?.state).toBe('stopped');
});
