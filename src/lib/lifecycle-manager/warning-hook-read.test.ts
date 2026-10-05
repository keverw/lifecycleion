import { expect, test } from 'bun:test';
import { Plain, setup } from './test-helpers';
import { sleep } from '../sleep';

for (const shutdownWarningTimeoutMS of [0, 100]) {
  test(`warning selection invokes its captured hook once (timeout ${shutdownWarningTimeoutMS})`, async () => {
    const { logger, manager } = setup({ shutdownWarningTimeoutMS });
    const component = new Plain(logger, 'a');
    let reads = 0;
    let calls = 0;
    const receivers: unknown[] = [];
    const events: string[] = [];
    Object.defineProperty(component, 'onShutdownWarning', {
      get: () => {
        reads++;
        return reads === 1
          ? function (this: unknown) {
              calls++;
              receivers.push(this);
            }
          : undefined;
      },
    });
    manager.on('component:shutdown-warning-completed', () => {
      events.push('completed');
    });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    expect((await manager.stopAllComponents()).success).toBe(true);
    await sleep(0);
    expect(reads).toBe(1);
    expect(calls).toBe(1);
    expect(receivers[0]).toBe(component);
    expect(events).toEqual(['completed']);
  });
}

for (const shutdownWarningTimeoutMS of [0, 100]) {
  test(`non-callable warning values are not selected (timeout ${shutdownWarningTimeoutMS})`, async () => {
    const { logger, manager } = setup({ shutdownWarningTimeoutMS });
    const component = new Plain(logger, 'a');
    Object.defineProperty(component, 'onShutdownWarning', { value: {} });
    let warnings = 0;
    manager.on('component:shutdown-warning', () => {
      warnings++;
    });
    await manager.registerComponent(component);
    await manager.startComponent('a');
    expect((await manager.stopAllComponents()).success).toBe(true);
    expect(warnings).toBe(0);
  });
}
