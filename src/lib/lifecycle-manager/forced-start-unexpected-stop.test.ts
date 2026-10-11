import { expect, test } from 'bun:test';
import { BaseComponent } from './base-component';
import type { ComponentState } from './types';
import { deferred, setup } from './test-helpers';

// A forced start of a stalled component that reports an unexpected stop ends only the new
// run: the stop that stalled is still unfinished, so the component is `stalled` again. It
// is announced that way at once - `component:unexpected-stop` with the state already
// `stalled`, and no `component:stopped` - rather than reported stopped and then put back
// to `stalled` silently once `start()` settled.

test('forced start: an unexpected stop is announced with the stalled state it leaves', async () => {
  const { logger, manager } = setup();
  const gate = deferred();
  let startCalls = 0;

  class Component extends BaseComponent {
    constructor() {
      super(logger, { name: 'forced', shutdownGracefulTimeoutMS: 20 });
    }

    public async start(): Promise<void> {
      startCalls++;
      if (startCalls === 2) {
        this.reportUnexpectedStop(new Error('died'));
        await gate.promise;
      }
    }

    public async stop(): Promise<void> {
      // Never finishes, leaving the component stalled.
      await new Promise<void>(() => {});
    }
  }

  await manager.registerComponent(new Component());
  await manager.startComponent('forced');
  expect((await manager.stopComponent('forced')).code).toBe(
    'component_shutdown_timeout',
  );
  expect(manager.getComponentStatus('forced')?.state).toBe('stalled');

  const events: Array<[string, ComponentState | undefined]> = [];
  for (const event of [
    'component:unexpected-stop',
    'component:stopped',
    'component:stalled',
    'component:stalled-resolved',
  ] as const) {
    manager.on(event, ({ name }: { name: string }) => {
      if (name === 'forced') {
        events.push([event, manager.getComponentStatus('forced')?.state]);
      }
    });
  }

  const pending = manager.startComponent('forced', { forceStalled: true });
  await Promise.resolve();
  expect(events).toEqual([['component:unexpected-stop', 'stalled']]);
  expect(manager.getComponentStatus('forced')?.state).toBe('stalled');

  gate.resolve();
  const result = await pending;
  expect(result.code).toBe('component_unexpected_stop');
  expect(result.error?.message).toBe('died');
  expect(events).toEqual([['component:unexpected-stop', 'stalled']]);
  expect(manager.getComponentStatus('forced')?.state).toBe('stalled');
  expect(manager.getStalledComponents().map(({ name }) => name)).toEqual([
    'forced',
  ]);
});

test('forced start: an unexpected stop from a start() that then resolves stays stalled', async () => {
  const { logger, manager } = setup();
  let startCalls = 0;

  class Component extends BaseComponent {
    constructor() {
      super(logger, { name: 'forced', shutdownGracefulTimeoutMS: 20 });
    }

    public start(): void {
      startCalls++;
      if (startCalls === 2) {
        this.reportUnexpectedStop();
      }
    }

    public async stop(): Promise<void> {
      await new Promise<void>(() => {});
    }
  }

  await manager.registerComponent(new Component());
  await manager.startComponent('forced');
  await manager.stopComponent('forced');
  const stopped: string[] = [];
  manager.on('component:stopped', ({ name }: { name: string }) => {
    stopped.push(name);
  });

  const result = await manager.startComponent('forced', { forceStalled: true });
  expect(result.code).toBe('component_unexpected_stop');
  expect(stopped).toEqual([]);
  expect(manager.getComponentStatus('forced')?.state).toBe('stalled');
  expect(manager.isComponentRunning('forced')).toBe(false);
});
