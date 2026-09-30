import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';

class Component extends BaseComponent {
  public failStop = false;
  public onStart: () => void = () => {};
  public start() {
    this.onStart();
  }
  public stop() {
    if (this.failStop) {
      throw new Error('stop failed');
    }
  }
}

test.each(['success', 'failure', 'timeout'] as const)(
  'stalled skips are reported separately after startup %s',
  async (mode) => {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const stalled = new Component(logger, { name: 'stalled' });
    const next = new Component(logger, { name: 'next' });
    stalled.failStop = true;
    await manager.registerComponent(stalled);
    await manager.registerComponent(next);
    await manager.startComponent('stalled');
    await manager.stopComponent('stalled');
    expect(manager.getComponentStatus('stalled')?.state).toBe('stalled');
    const realNow = Date.now;
    let now = realNow();
    next.onStart = () => {
      if (mode === 'failure') {
        throw new Error('start failed');
      }
      if (mode === 'timeout') {
        now += 1001;
      }
    };
    Date.now = () => now;
    try {
      const result = await manager.startAllComponents({
        ignoreStalledComponents: true,
        timeoutMS: 1000,
      });
      expect(result.success).toBe(mode === 'success');
      if (mode === 'failure') {
        expect(result.code).toBe('required_component_failed');
      }
      if (mode === 'timeout') {
        expect(result.code).toBe('startup_timeout');
      }
      expect(result.skippedDueToStall).toEqual(['stalled']);
      expect(result.skippedDueToDependency).toEqual([]);
      expect(result.startedComponents).not.toContain('stalled');
      expect(result.blockedByStalledComponents).toBeUndefined();
    } finally {
      Date.now = realNow;
      stalled.failStop = false;
      await manager.stopAllComponents();
    }
  },
);
