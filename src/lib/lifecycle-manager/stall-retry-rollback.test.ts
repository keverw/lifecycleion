import { describe, test, expect } from 'bun:test';
import { BaseComponent } from './base-component';
import type { Logger } from '../logger';
import { Plain, setup, Stalls } from './test-helpers';
import type { ComponentStallInfo } from './types';

class CountsStops extends Plain {
  public stopCalls = 0;

  public override stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }
}

class FailsStart extends Plain {
  public override start(): Promise<void> {
    return Promise.reject(new Error('start failed'));
  }
}

// No `onShutdownForce`, and a `stop()` that never settles.
class HangsWithoutForce extends BaseComponent {
  constructor(logger: Logger, name: string) {
    super(logger, { name, shutdownGracefulTimeoutMS: 20 });
  }

  public async start(): Promise<void> {}
  public stop(): Promise<void> {
    return new Promise(() => {});
  }
}

// Every `stop()` fails; the force handler fails until `isForceFixed` is set.
class ForceRecovers extends Plain {
  public isForceFixed = false;

  public override stop(): Promise<void> {
    return Promise.reject(new Error('stop failed'));
  }

  public override onShutdownForce(): void {
    if (!this.isForceFixed) {
      throw new Error('force failed');
    }
  }
}

describe('LifecycleManager - stall retry and rollback', () => {
  test('startup rollback leaves the dependency of a stalled dependent running', async () => {
    const { logger, manager } = setup();
    const db = new CountsStops(logger, 'db');
    await manager.registerComponent(db);
    await manager.registerComponent(new Stalls(logger, 'api', ['db']));
    await manager.registerComponent(new FailsStart(logger, 'z', ['api']));

    const result = await manager.startAllComponents();

    expect(result.success).toBe(false);
    expect(manager.getComponentStatus('api')?.state).toBe('stalled');
    expect(db.stopCalls).toBe(0);
    expect(manager.getComponentStatus('db')?.state).toBe('running');
  });

  test('a stall from before the startup does not keep rolled-back work running', async () => {
    const { logger, manager } = setup();
    const db = new CountsStops(logger, 'db');
    await manager.registerComponent(db);
    await manager.registerComponent(new Stalls(logger, 'api', ['db']));
    await manager.startComponent('db');
    await manager.startComponent('api');
    await manager.stopComponent('api');
    expect((await manager.stopComponent('db')).success).toBe(true);
    await manager.registerComponent(new FailsStart(logger, 'z', ['db']));

    const result = await manager.startAllComponents({
      ignoreStalledComponents: true,
    });

    expect(result.success).toBe(false);
    expect(db.stopCalls).toBe(2);
    expect(manager.getComponentStatus('db')?.state).toBe('stopped');
  });

  test('a stalled retry without onShutdownForce keeps the original stall record', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new HangsWithoutForce(logger, 'hang'));
    await manager.startComponent('hang');

    const first = await manager.stopComponent('hang');
    expect(first.code).toBe('component_shutdown_timeout');
    const original = manager.getStalledComponents()[0];
    expect(original.reason).toBe('timeout');
    expect(original.error).toBeDefined();

    const retry = await manager.stopAllComponents();

    expect(retry.success).toBe(false);
    const after = manager.getStalledComponents()[0];
    expect(after).toEqual(original);
    expect(retry.stalledComponents[0]?.reason).toBe('timeout');
  });

  test('a stalled retry whose force phase succeeds emits stalled-resolved', async () => {
    const { logger, manager } = setup();
    const component = new ForceRecovers(logger, 'flaky');
    await manager.registerComponent(component);
    await manager.startComponent('flaky');

    await manager.stopComponent('flaky');
    expect(manager.getStalledComponentNames()).toEqual(['flaky']);

    const resolved: ComponentStallInfo[] = [];
    const events: string[] = [];
    manager.on('component:shutdown-force-completed', () => {
      events.push('force-completed');
    });
    manager.on('component:stalled-resolved', (event) => {
      resolved.push((event as { stallInfo: ComponentStallInfo }).stallInfo);
      events.push('stalled-resolved');
    });
    manager.on('component:stopped', () => {
      events.push('stopped');
    });

    component.isForceFixed = true;
    const retry = await manager.stopAllComponents();

    expect(retry.success).toBe(true);
    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(resolved.map((info) => info.name)).toEqual(['flaky']);
    expect(events).toEqual(['force-completed', 'stalled-resolved', 'stopped']);
  });

  test('detachSignals still announces the detach when a listener removal throws', () => {
    const { manager } = setup();
    let isAttached = true;
    (
      manager as unknown as { processSignalManager: unknown }
    ).processSignalManager = {
      getStatus: () => ({ isAttached }),
      detach: () => {
        isAttached = false;
        throw new Error('removal failed');
      },
    };
    let detachedEvents = 0;
    manager.on('lifecycle-manager:signals-detached', () => {
      detachedEvents++;
    });

    expect(() => manager.detachSignals()).toThrow('removal failed');

    expect(manager.getSignalStatus().isAttached).toBe(false);
    expect(detachedEvents).toBe(1);
  });
});
