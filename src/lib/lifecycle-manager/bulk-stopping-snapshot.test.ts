import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { deferred } from './test-helpers';

class Component extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public start() {
    this.starts++;
  }
  public stop() {
    this.stops++;
  }
}

test.each([false, true])(
  'bulk startup refusal retains running siblings but excludes teardown and pending starts (force: %s)',
  async (isForce) => {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const first = new Component(logger, { name: 'first' });
    const stopping = new Component(logger, { name: 'stopping' });
    const last = new Component(logger, { name: 'last' });
    const pending = new Component(logger, { name: 'pending' });
    for (const component of [first, stopping, last, pending]) {
      await manager.registerComponent(component);
    }
    for (const name of ['first', 'stopping', 'last']) {
      expect((await manager.startComponent(name)).success).toBe(true);
    }
    const stopGate = deferred();
    const stopEntered = deferred();
    const startGate = deferred();
    Object.defineProperty(stopping, isForce ? 'onShutdownForce' : 'stop', {
      value: () => {
        stopEntered.resolve();
        return stopGate.promise;
      },
    });
    Object.defineProperty(pending, 'start', { value: () => startGate.promise });
    const stop = manager.stopComponent('stopping', { forceImmediate: isForce });
    await stopEntered.promise;
    const start = manager.startComponent('pending');
    try {
      expect(manager.getComponentStatus('stopping')?.state).toBe(
        isForce ? 'force-stopping' : 'stopping',
      );
      expect(manager.getComponentStatus('pending')?.state).toBe('starting');
      const result = await manager.startAllComponents();
      expect(result).toMatchObject({
        success: false,
        code: 'partial_state',
        startedComponents: ['first', 'last'],
      });
      expect(result.reason).toContain('still stopping: stopping');
      expect([first.starts, last.starts]).toEqual([1, 1]);
      expect([first.stops, last.stops]).toEqual([0, 0]);
      expect(manager.getComponentStatus('pending')?.state).toBe('starting');
    } finally {
      stopGate.resolve();
      startGate.resolve();
      await Promise.all([stop, start]);
      await manager.stopAllComponents();
    }
  },
);
