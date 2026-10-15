import { expect, test } from 'bun:test';
import { deferred, Plain, setup } from './test-helpers';

for (const hasForce of [false, true]) {
  test(`bare stop resolved by timeout notification completes before force: ${hasForce}`, async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    const gate = deferred<void>();
    component.stop = () => gate.promise;
    let forceCalls = 0;
    Object.defineProperty(component, 'onShutdownForce', {
      value: undefined,
      writable: true,
    });
    if (hasForce) {
      component.onShutdownForce = () => {
        forceCalls++;
        throw new Error('force must not run');
      };
    }
    await manager.registerComponent(component);
    await manager.startComponent('a');
    let stopped = 0;
    manager.on('component:stop-timeout', () => gate.resolve());
    manager.on('component:stopped', () => {
      stopped++;
    });
    try {
      const result = await manager.stopComponent('a', { timeout: 5 });
      expect(result.success).toBe(true);
      expect(manager.getComponentStatus('a')?.state).toBe('stopped');
      expect(stopped).toBe(1);
      expect(forceCalls).toBe(0);
    } finally {
      gate.resolve();
      await manager.stopAllComponents();
      await logger.close();
    }
  });
}
