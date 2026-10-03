import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { deferred } from './test-helpers';

class Component extends BaseComponent {
  public start() {}
  public stop() {}
}

test.each([
  'starting',
  'all running',
  'partial',
  'partial with registration',
] as const)(
  'startup snapshots exclude a sibling stopped by the %s preflight log',
  async (mode) => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      callProcessExit: false,
      sinks: [{ write: (entry) => onLog(entry.message) }],
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const first = new Component(logger, { name: 'first' });
    const sibling = new Component(logger, { name: 'sibling' });
    const pending = new Component(logger, { name: 'pending' });
    await manager.registerComponent(first);
    await manager.registerComponent(sibling);
    await manager.startAllComponents();
    if (mode !== 'all running') {
      await manager.registerComponent(pending);
    }
    const stopGate = deferred();
    const startGate = deferred();
    Object.defineProperty(sibling, 'stop', { value: () => stopGate.promise });
    Object.defineProperty(pending, 'start', { value: () => startGate.promise });
    const start =
      mode === 'starting' ? manager.startComponent('pending') : undefined;
    let stop: ReturnType<typeof manager.stopComponent> | undefined;
    const trigger =
      mode === 'starting'
        ? 'Cannot start: components are still starting'
        : mode === 'all running'
          ? 'All components already running'
          : 'components already running. Call stopAllComponents()';
    onLog = (message) => {
      if (message.includes(trigger)) {
        onLog = () => {};
        stop = manager.stopComponent('sibling');
        if (mode === 'partial with registration') {
          void manager.registerComponent(
            new Component(logger, { name: 'added' }),
          );
        }
      }
    };
    try {
      const result = await manager.startAllComponents();
      expect(stop).toBeDefined();
      expect(manager.getComponentStatus('sibling')?.state).toBe('stopping');
      expect(result).toMatchObject({
        success: false,
        code: 'partial_state',
        startedComponents: ['first'],
      });
      if (mode === 'partial with registration') {
        expect(result.reason).toBe(
          'Startup refused because 2 of 3 components were already running. ' +
            'Currently 1 of 4 components are running.',
        );
      }
      if (mode === 'partial') {
        expect(result.reason).toBe(
          'Startup refused because 2 of 3 components were already running. ' +
            'Currently 1 of 3 components are running.',
        );
      }
      expect(manager.getComponentStatus('first')?.state).toBe('running');
    } finally {
      onLog = () => {};
      stopGate.resolve();
      startGate.resolve();
      await Promise.all([stop, start]);
      await manager.stopAllComponents();
    }
  },
);

// A refusal remains a refusal after logging. Its reason separates the original
// decision from the current snapshot, including a new bulk owner with unchanged
// component counts; the callback must not turn this call into another startup.
test.each(['unchanged', 'registration', 'shutdown', 'stopped'] as const)(
  'partial startup refusal explains the %s post-log state',
  async (mode) => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      callProcessExit: false,
      sinks: [{ write: (entry) => onLog(entry.message) }],
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const running = new Component(logger, { name: 'running' });
    const idle = new Component(logger, { name: 'idle' });
    let idleStarts = 0;
    idle.start = () => {
      idleStarts++;
    };
    await manager.registerComponent(running);
    await manager.startComponent('running');
    await manager.registerComponent(idle);
    const stopGate = deferred();
    Object.defineProperty(running, 'stop', { value: () => stopGate.promise });
    let cleanup: Promise<unknown> | undefined;
    onLog = (message) => {
      if (
        !message.includes(
          'components already running. Call stopAllComponents()',
        )
      ) {
        return;
      }
      onLog = () => {};
      if (mode === 'registration') {
        void manager.registerComponent(
          new Component(logger, { name: 'added' }),
        );
      } else if (mode === 'shutdown') {
        cleanup = manager.stopAllComponents();
      } else if (mode === 'stopped') {
        cleanup = manager.stopComponent('running');
      }
    };
    try {
      const result = await manager.startAllComponents();
      const reasons = {
        unchanged: '1 of 2 components already running',
        registration:
          'Startup refused because 1 of 2 components were already running. Currently 1 of 3 components are running.',
        shutdown:
          'Startup refused because 1 of 2 components were already running. Currently 1 of 2 components are running. A shutdown is now in progress.',
        stopped:
          'Startup refused because 1 of 2 components were already running. Currently 0 of 2 components are running.',
      };
      expect(result).toMatchObject({
        success: false,
        code: 'partial_state',
        reason: reasons[mode],
        startedComponents: mode === 'stopped' ? [] : ['running'],
      });
      expect(idleStarts).toBe(0);
    } finally {
      onLog = () => {};
      stopGate.resolve();
      await cleanup;
      await manager.stopAllComponents();
    }
  },
);
