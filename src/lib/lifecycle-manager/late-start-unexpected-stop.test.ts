import { expect, test } from 'bun:test';
import { BaseComponent } from './base-component';
import { deferred, setup } from './test-helpers';
import { sleep } from '../sleep';

// A start that reports an unexpected stop and then times out answers
// `component_unexpected_stop`. If its `start()` later fulfills anyway, whatever it brought
// up is owned by nothing, so late cleanup stops it - for a plain start as for a forced one.

test('plain start: unexpected stop, timeout, late fulfilment is cleaned up', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  let stopCalls = 0;

  class Component extends BaseComponent {
    constructor() {
      super(logger, { name: 'plain', startupTimeoutMS: 30 });
    }

    public async start(): Promise<void> {
      this.reportUnexpectedStop(new Error('died'));
      await gate.promise;
    }

    public stop(): Promise<void> {
      stopCalls++;
      return Promise.resolve();
    }
  }

  await manager.registerComponent(new Component());
  const result = await manager.startComponent('plain');
  expect(result.code).toBe('component_unexpected_stop');
  expect(manager.getComponentStatus('plain')?.state).toBe('stopped');
  expect(stopCalls).toBe(0);

  gate.resolve();
  await sleep(50);

  expect(stopCalls).toBe(1);
  expect(manager.getComponentStatus('plain')?.state).toBe('stopped');
  expect(manager.isComponentRunning('plain')).toBe(false);
});

test('forced start (control): unexpected stop, timeout, late fulfilment is cleaned up', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  let startCalls = 0;
  let stopCalls = 0;

  class Component extends BaseComponent {
    constructor() {
      super(logger, {
        name: 'forced',
        startupTimeoutMS: 30,
        shutdownGracefulTimeoutMS: 20,
      });
    }

    public async start(): Promise<void> {
      startCalls++;
      if (startCalls === 2) {
        this.reportUnexpectedStop(new Error('died'));
        await gate.promise;
      }
    }

    public async stop(): Promise<void> {
      stopCalls++;
      if (stopCalls === 1) {
        // The first stop never finishes, leaving the component stalled.
        await new Promise<void>(() => {});
      }
    }
  }

  await manager.registerComponent(new Component());
  await manager.startComponent('forced');
  expect((await manager.stopComponent('forced')).code).toBe(
    'component_shutdown_timeout',
  );
  expect(manager.getComponentStatus('forced')?.state).toBe('stalled');

  const result = await manager.startComponent('forced', { forceStalled: true });
  expect(result.code).toBe('component_unexpected_stop');
  expect(stopCalls).toBe(1);

  gate.resolve();
  await sleep(50);

  expect(stopCalls).toBe(2);
  expect(manager.getComponentStatus('forced')?.state).toBe('stopped');
  expect(manager.isComponentRunning('forced')).toBe(false);
});
