import { expect, test } from 'bun:test';
import type { LifecycleManagerEventMap } from './events';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { Plain, Stalls } from './test-helpers';

class Reporter extends Plain {
  public reportStopped() {
    return this.reportUnexpectedStop();
  }
}

test.each([0, 100])(
  'a selected warning gets a skipped event when its listener reports the component stopped (timeout: %s)',
  async (shutdownWarningTimeoutMS) => {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const manager = new LifecycleManager({ logger, shutdownWarningTimeoutMS });
    const component = new Reporter(logger, 'component');
    let calls = 0;
    component.onShutdownWarning = () => {
      calls++;
    };
    const events: string[] = [];
    manager.on<LifecycleManagerEventMap['component:shutdown-warning']>(
      'component:shutdown-warning',
      ({ name }) => {
        events.push(`selected:${name}`);
        component.reportStopped();
      },
    );
    manager.on<
      LifecycleManagerEventMap['component:shutdown-warning-completed']
    >('component:shutdown-warning-completed', ({ name }) => {
      events.push(`completed:${name}`);
    });
    manager.on<LifecycleManagerEventMap['component:shutdown-warning-skipped']>(
      'component:shutdown-warning-skipped',
      (event) => {
        expect(event).toEqual({
          name: 'component',
          reason: 'component_not_available',
          state: 'stopped',
        });
        events.push(`skipped:${event.name}`);
      },
    );
    await manager.registerComponent(component);
    await manager.startAllComponents();
    expect((await manager.stopAllComponents()).success).toBe(true);
    expect(calls).toBe(0);
    expect(events).toEqual(['selected:component', 'skipped:component']);
  },
);

test('warning selection excludes a component already stopped by an earlier warning getter', async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: 100,
  });
  const target = new Reporter(logger, 'target');
  const trigger = new Plain(logger, 'trigger');
  const calls: string[] = [];
  target.onShutdownWarning = () => {
    calls.push('target');
  };
  Object.defineProperty(trigger, 'onShutdownWarning', {
    get() {
      target.reportStopped();
      return () => {
        calls.push('trigger');
      };
    },
  });
  const selected: string[] = [];
  manager.on<LifecycleManagerEventMap['component:shutdown-warning']>(
    'component:shutdown-warning',
    ({ name }) => {
      selected.push(name);
    },
  );
  await manager.registerComponent(target);
  await manager.registerComponent(trigger);
  await manager.startAllComponents();
  expect((await manager.stopAllComponents()).success).toBe(true);
  expect(calls).toEqual(['trigger']);
  expect(selected).toEqual(['trigger']);
});

test('a deliberately retried stalled component retains its warning hook', async () => {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: 100,
  });
  const component = new Stalls(logger, 'component');
  let calls = 0;
  component.onShutdownWarning = () => {
    calls++;
  };
  await manager.registerComponent(component);
  await manager.startAllComponents();
  await manager.stopAllComponents();
  expect(manager.getComponentStatus('component')?.state).toBe('stalled');
  expect(calls).toBe(1);
  component.onShutdownForce = () => {};
  expect(
    (await manager.stopAllComponents({ retryStalled: true })).success,
  ).toBe(true);
  expect(calls).toBe(2);
});
