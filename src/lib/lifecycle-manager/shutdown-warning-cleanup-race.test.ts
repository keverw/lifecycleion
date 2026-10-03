import { expect, test } from 'bun:test';
import type { LifecycleManagerEventMap } from './events';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { deferred, Plain } from './test-helpers';

test.each([0, 100])(
  'shutdown warning does not enter automatic attachment cleanup after target selection (timeout: %s)',
  async (shutdownWarningTimeoutMS) => {
    const logger = new Logger({ sinks: [], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      attachSignalsOnStart: true,
      shutdownWarningTimeoutMS,
    });
    const component = new Plain(logger, 'component');
    const stopEntered = deferred();
    const finishStop = deferred();
    const warningSkipped = deferred();
    let warningCalls = 0;
    let warningSelectedEvents = 0;
    let warningCompletedEvents = 0;
    let warningSkippedEvents = 0;
    component.onShutdownWarning = () => {
      warningCalls++;
    };
    component.stop = async () => {
      stopEntered.resolve();
      await finishStop.promise;
    };
    // Exercise the real failed-attachment rollback. The public stop API is guarded
    // during shutdown, but automatic cleanup of a failed start must still run.
    manager.attachSignals = () => {
      throw new Error('signal transport unavailable');
    };
    let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
    manager.once('component:started', () => {
      shutdown = manager.stopAllComponents({ timeoutMS: 0 });
    });
    manager.on('component:shutdown-warning', () => {
      warningSelectedEvents++;
    });
    manager.on<LifecycleManagerEventMap['component:shutdown-warning-skipped']>(
      'component:shutdown-warning-skipped',
      ({ name, reason, state }) => {
        expect({ name, reason, state }).toEqual({
          name: 'component',
          reason: 'component_not_available',
          state: 'stopping',
        });
        warningSkippedEvents++;
        warningSkipped.resolve();
      },
    );
    manager.on('component:shutdown-warning-completed', () => {
      warningCompletedEvents++;
    });
    await manager.registerComponent(component);
    const startup = manager.startComponent('component');
    try {
      await stopEntered.promise;
      expect(manager.getComponentStatus('component')?.state).toBe('stopping');
      // The warning is skipped without waiting for cleanup or invoking the hook.
      // Zero-deadline shutdown still joins that cleanup before it can finish.
      await warningSkipped.promise;
      expect(warningSelectedEvents).toBe(1);
      expect(warningCalls).toBe(0);
      expect(warningCompletedEvents).toBe(0);
      expect(warningSkippedEvents).toBe(1);
      expect(manager.getComponentStatus('component')?.state).toBe('stopping');
      finishStop.resolve();
      expect((await shutdown)?.success).toBe(true);
    } finally {
      finishStop.resolve();
      expect((await startup).code).toBe('signal_attach_failed');
      await shutdown;
      await manager.stopAllComponents();
    }
  },
);
