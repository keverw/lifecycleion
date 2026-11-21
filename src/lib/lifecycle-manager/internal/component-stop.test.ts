import { expect, test } from 'bun:test';
import { BaseComponent } from '../base-component';
import type { LifecycleManager } from '../lifecycle-manager';
import { claimReports, coreOf, Plain, setup } from '../test-helpers';

class NoForceHandler extends BaseComponent {
  public start(): void {}
  public stop(): Promise<void> {
    return Promise.reject(new Error('stop failed'));
  }
}

// Records, at each status read, whether a `component:stalled` listener had already run.
function watchStallAnnouncement(manager: LifecycleManager): boolean[] {
  const readsAfterListener: boolean[] = [];
  let hasListenerRun = false;
  manager.on('component:stalled', () => {
    hasListenerRun = true;
  });
  const getStatus = manager.getComponentStatus.bind(manager);
  Object.defineProperty(manager, 'getComponentStatus', {
    configurable: true,
    value: (name: string) => {
      readsAfterListener.push(hasListenerRun);
      return getStatus(name);
    },
  });
  return readsAfterListener;
}

test('a stall without a force handler is recorded, announced and answered in one transition', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(
    new NoForceHandler(logger, { name: 'component' }),
  );
  await manager.startComponent('component');
  const readsAfterListener = watchStallAnnouncement(manager);

  const result = await manager.stopComponent('component');

  expect(result.status?.state).toBe('stalled');
  expect(readsAfterListener.length).toBeGreaterThan(0);
  expect(readsAfterListener).not.toContain(true);
  await logger.close();
});

test('a stop crash is stalled, announced and answered in one transition', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'component'));
  await manager.startComponent('component');
  const componentStop = coreOf(manager).componentStop;
  Object.defineProperty(componentStop, 'createStopPhaseObserver', {
    configurable: true,
    value: (): never => {
      Reflect.deleteProperty(componentStop, 'createStopPhaseObserver');
      throw new Error('bookkeeping crashed');
    },
  });
  const readsAfterListener = watchStallAnnouncement(manager);

  const { release } = claimReports();
  try {
    const result = await manager.stopComponent('component');
    expect(result.code).toBe('operation_crashed');
    expect(result.status?.state).toBe('stalled');
  } finally {
    release();
  }
  expect(readsAfterListener.length).toBeGreaterThan(0);
  expect(readsAfterListener).not.toContain(true);
  await logger.close();
});
