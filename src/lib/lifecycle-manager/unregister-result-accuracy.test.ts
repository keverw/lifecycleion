import { describe, expect, test } from 'bun:test';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, coreOf, Plain, setup } from './test-helpers';

// A component whose unexpected stop a test can report from outside, as its own
// monitoring would.
class Reporting extends Plain {
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

describe('LifecycleManager - unregister result accuracy', () => {
  test('a component stopped before the unregister stop ran is not reported as stopped by it', async () => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      sinks: [{ write: (entry) => onLog(entry.message) }],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const component = new Reporting(logger, 'a');
    let stopCalls = 0;
    component.stop = (): Promise<void> => {
      stopCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(component);
    await manager.startComponent('a');

    onLog = (message) => {
      if (message === 'Unregistering running component; stopping it first') {
        onLog = () => {};
        component.reportStop();
      }
    };

    const result = await manager.unregisterComponent('a');

    expect(stopCalls).toBe(0);
    expect(result.success).toBe(true);
    expect(result.wasStopped).toBe(false);
    expect(manager.hasComponent('a')).toBe(false);
  });

  test('a registration made by the component unmark hook is announced after the removal', async () => {
    const { logger, manager } = setup();
    const events: string[] = [];
    manager.on('component:registered', (data) => {
      events.push(`registered:${(data as { name: string }).name}`);
    });
    manager.on('component:unregistered', (data) => {
      events.push(`unregistered:${(data as { name: string }).name}`);
    });

    const component = new Plain(logger, 'a');
    let isArmed = false;
    const unmark = component._markUnregistered.bind(component);
    component._markUnregistered = (): void => {
      unmark();
      if (isArmed) {
        isArmed = false;
        void manager.registerComponent(component);
      }
    };
    await manager.registerComponent(component);
    events.length = 0;
    isArmed = true;

    const result = await manager.unregisterComponent('a');

    expect(result.success).toBe(true);
    expect(manager.hasComponent('a')).toBe(true);
    expect(events).toEqual(['unregistered:a', 'registered:a']);
  });

  test('a failure after the removal says the component was unregistered', async () => {
    const { logger, manager } = setup();
    const events: string[] = [];
    manager.on('component:unregistered', (data) => {
      events.push((data as { name: string }).name);
    });
    await manager.registerComponent(new Plain(logger, 'a'));

    coreOf(manager).signals.detachSignalsAfterLastStop = (): never => {
      throw new Error('cleanup exploded');
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.unregisterComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.code).toBe('operation_crashed');
    expect(result.reason).toStartWith('Component was unregistered, but ');
    expect(result.wasRegistered).toBe(true);
    expect(manager.hasComponent('a')).toBe(false);
    expect(events).toEqual(['a']);
  });
});

describe('LifecycleManager - registration and count reads', () => {
  test('registerComponent() resolves when insertComponentAt() would', async () => {
    const { logger, manager } = setup();
    const order: string[] = [];

    const registering = manager
      .registerComponent(new Plain(logger, 'a'))
      .then(() => {
        order.push('register');
      });
    const inserting = manager
      .insertComponentAt(new Plain(logger, 'b'), 'end')
      .then(() => {
        order.push('insert');
      });
    await Promise.all([registering, inserting]);

    expect(order).toEqual(['register', 'insert']);
  });

  test('registerComponent() answers without the insert-only fields', async () => {
    const { logger, manager } = setup();

    const result = await manager.registerComponent(new Plain(logger, 'a'));

    expect(result.action).toBe('register');
    expect('requestedPosition' in result).toBe(false);
    expect('actualPosition' in result).toBe(false);
    expect('manualPositionRespected' in result).toBe(false);
    expect('targetFound' in result).toBe(false);
  });

  test('the stopped and start-timed-out counts are read from state, as getStatus() reads them', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(new Plain(logger, 'b'));
    await manager.startComponent('a');

    manager.getStoppedComponentNames = (): string[] => {
      throw new Error('not consulted');
    };
    manager.getStartTimedOutComponentNames = (): string[] => {
      throw new Error('not consulted');
    };

    expect(manager.getStoppedComponentCount()).toBe(1);
    expect(manager.getStartTimedOutComponentCount()).toBe(0);
    expect(manager.getStatus().counts.stopped).toBe(1);

    await manager.stopAllComponents();
  });
});
