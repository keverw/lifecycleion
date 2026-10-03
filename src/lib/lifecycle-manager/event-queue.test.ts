import { describe, expect, test } from 'bun:test';
import type { LifecycleManager } from './lifecycle-manager';
import { claimReports, Plain, setup, Stalls } from './test-helpers';
import type { ComponentStatus, ShutdownResult } from './types';
import type { LifecycleManagerEventMap } from './events';

class Reporter extends Plain {
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
}

// Exercise the real attach/detach methods and their events without installing OS
// handlers. Replacing the public methods would bypass the transition under test.
function stubSignals(manager: LifecycleManager): void {
  let isAttached = false;
  (
    manager as unknown as { processSignalManager: unknown }
  ).processSignalManager = {
    attach: (): void => {
      isAttached = true;
    },
    detach: (): void => {
      isAttached = false;
    },
    getStatus: () => ({ isAttached }),
  };
}

describe('LifecycleManager event transition queue', () => {
  test('a detach listener sees the complete unexpected stop before restarting', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    stubSignals(manager);
    const component = new Reporter(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');
    manager.attachSignals();
    const eventOrder: string[] = [];
    manager.on('component:unexpected-stop', () => {
      eventOrder.push('unexpected');
    });
    manager.on('component:starting', () => {
      eventOrder.push('starting');
    });
    let atDetach: ComponentStatus | undefined;
    let stopped: ComponentStatus | undefined;
    let restart: ReturnType<typeof manager.startComponent> | undefined;
    manager.once('lifecycle-manager:signals-detached', () => {
      eventOrder.push('detached');
      atDetach = manager.getComponentStatus('a');
      restart = manager.startComponent('a');
    });
    manager.once(
      'component:stopped',
      (event: LifecycleManagerEventMap['component:stopped']) => {
        eventOrder.push('stopped');
        stopped = event.status;
      },
    );

    component.reportStop();
    expect(eventOrder).toEqual([
      'detached',
      'unexpected',
      'stopped',
      'starting',
    ]);
    expect(atDetach?.state).toBe('stopped');
    expect(atDetach?.stoppedAt).toBeNumber();
    // The terminal payload was captured before the queued detach listener restarted
    // the component. Reading live state later may legitimately say starting/running.
    expect(stopped?.state).toBe('stopped');
    expect(stopped?.stoppedAt).toBe(atDetach?.stoppedAt);
    expect((await restart)?.success).toBe(true);
    await manager.stopAllComponents();
  });

  test('nested registration waits behind every listener, including after a throwing listener', async () => {
    const { logger, manager } = setup();
    const order: string[] = [];
    let nested: ReturnType<typeof manager.registerComponent> | undefined;
    const { release, reports } = claimReports();
    manager.on(
      'component:registered',
      (event: LifecycleManagerEventMap['component:registered']) => {
        order.push(`first:${event.name}`);
        if (event.name === 'a') {
          nested = manager.registerComponent(new Plain(logger, 'b'));
          throw new Error('listener failed after re-entry');
        }
      },
    );
    manager.on(
      'component:registered',
      (event: LifecycleManagerEventMap['component:registered']) => {
        order.push(`second:${event.name}`);
      },
    );
    try {
      expect(
        (await manager.registerComponent(new Plain(logger, 'a'))).success,
      ).toBe(true);
      expect((await nested)?.success).toBe(true);
      expect(order).toEqual(['first:a', 'second:a', 'first:b', 'second:b']);
      expect(reports.length).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  test('shutdown completion sees settled escalation while retaining the pass latch', async () => {
    const { logger, manager } = setup({
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 3,
        withinMS: 1000,
        armedAfterFailureMS: 60_000,
        onForceShutdown: () => {},
      },
    });
    await manager.registerComponent(new Stalls(logger, 'a'));
    await manager.startAllComponents();
    let armedUntil: number | null | undefined;
    let nested: Promise<ShutdownResult> | undefined;
    const order: string[] = [];
    manager.once('lifecycle-manager:shutdown-completed', () => {
      armedUntil = manager.getShutdownEscalationStatus().armedUntil;
      nested = manager.stopAllComponents();
      order.push('completed');
    });
    manager.once('lifecycle-manager:shutdown-escalation-armed', () => {
      order.push('armed');
    });
    await manager.stopAllComponents();
    expect(armedUntil).toBeNumber();
    expect((await nested)?.code).toBe('already_in_progress');
    expect(order).toEqual(['completed', 'armed']);
  });

  test('a force-timeout restart queues behind the original stalled event', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    Object.defineProperty(component, 'onShutdownForce', {
      value: (): Promise<void> => new Promise(() => {}),
    });
    Object.defineProperty(component, 'shutdownForceTimeoutMS', { value: 5 });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    const order: string[] = [];
    let restart: ReturnType<typeof manager.startComponent> | undefined;
    manager.once('component:shutdown-force-timeout', () => {
      order.push('timeout');
      restart = manager.startComponent('a', { forceStalled: true });
    });
    manager.once('component:stalled', () => {
      order.push('stalled');
    });
    manager.once('component:starting', () => {
      order.push('starting');
    });
    const stopped = await manager.stopComponent('a', { forceImmediate: true });
    expect(stopped.success).toBe(false);
    expect((await restart)?.success).toBe(true);
    expect(order).toEqual(['timeout', 'stalled', 'starting']);
    await manager.stopAllComponents();
  });

  test('an exceptional terminal transition still drains its events and releases depth', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    stubSignals(manager);
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startComponent('a');
    manager.attachSignals();
    const order: string[] = [];
    const timestamps = (
      manager as unknown as {
        componentTimestamps: Map<string, unknown>;
      }
    ).componentTimestamps;
    const originalSet = timestamps.set.bind(timestamps);
    timestamps.set = (name, value) => {
      timestamps.set = originalSet;
      order.push('failure');
      throw new Error(`timestamp write failed for ${name}: ${String(value)}`);
    };
    manager.once('lifecycle-manager:signals-detached', () => {
      order.push('detached');
    });
    const { release } = claimReports();
    try {
      await manager.stopComponent('a');
      manager.once('lifecycle-manager:signals-attached', () => {
        order.push('attached');
      });
      manager.attachSignals();
      manager.attachSignals(); // Early return must release its depth too.
      manager.once('lifecycle-manager:signals-detached', () => {
        order.push('detached-again');
      });
      manager.detachSignals();
      expect(order).toEqual([
        'failure',
        'detached',
        'attached',
        'detached-again',
      ]);
    } finally {
      timestamps.set = originalSet;
      release();
      manager.detachSignals();
    }
  });
});
