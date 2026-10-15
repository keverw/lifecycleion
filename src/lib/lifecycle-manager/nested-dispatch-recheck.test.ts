import { expect, test } from 'bun:test';
import type { LifecycleManager } from './lifecycle-manager';
import { Plain, setup } from './test-helpers';

class Reporter extends Plain {
  public calls = 0;
  public reportStop(): boolean {
    return this.reportUnexpectedStop();
  }
  public onMessage<TData>(): TData {
    this.calls++;
    return 'reply' as TData;
  }
  public healthCheck(): boolean {
    this.calls++;
    return true;
  }
  public onReload(): void {
    this.calls++;
  }
}

// Inside a manager event listener the dispatcher only queues the operation's own
// `*-started` notification, so its listeners run after the outer listener returns. The
// final availability check must still follow them: a listener that begins teardown
// synchronously prevents the dispatch, nested or not.
const operations = {
  message: {
    started: 'component:message-sent',
    failed: 'component:message-failed',
    run: (manager: LifecycleManager) =>
      manager.sendMessageToComponent('target', 'payload'),
    code: 'stopped',
  },
  health: {
    started: 'component:health-check-started',
    failed: 'component:health-check-failed',
    run: (manager: LifecycleManager) => manager.checkComponentHealth('target'),
    code: 'stopped',
  },
  reload: {
    started: 'component:reload-started',
    failed: 'component:reload-failed',
    run: async (manager: LifecycleManager) =>
      (await manager.triggerReload()).results[0],
    code: 'unavailable',
  },
} as const;

for (const [operation, spec] of Object.entries(operations)) {
  test(`${operation} from inside another listener rechecks after its started listeners`, async () => {
    const { logger, manager } = setup();
    const component = new Reporter(logger, 'target');
    await manager.registerComponent(component);
    await manager.startComponent('target');
    const events: string[] = [];
    manager.on(spec.started, () => {
      events.push('started');
      expect(component.reportStop()).toBe(true);
    });
    manager.on(spec.failed, () => {
      events.push('failed');
    });
    let pending: Promise<{ code: string } | undefined> | undefined;
    // Any manager notification will do as the outer listener; `component:registered`
    // is delivered while the registration's drain is running.
    manager.once('component:registered', () => {
      pending = spec.run(manager);
    });
    try {
      await manager.registerComponent(new Plain(logger, 'trigger'));
      const result = await pending;
      expect(component.calls).toBe(0);
      expect(result?.code).toBe(spec.code);
      expect(events).toEqual(['started', 'failed']);
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}
