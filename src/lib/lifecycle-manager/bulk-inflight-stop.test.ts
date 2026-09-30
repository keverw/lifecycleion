import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import { deferred, fakeSignals, Plain } from './test-helpers';

test.each([false, true])(
  'follow-up automatic signal-attachment cleanup returns partial state without rollback (optional: %s)',
  async (isOptional) => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      attachSignalsOnStart: true,
      shutdownWarningTimeoutMS: -1,
    });
    const root = new Plain(logger, 'root');
    const followup = new Plain(logger, 'followup');
    const unattempted = new Plain(logger, 'unattempted');
    followup.isOptional = () => isOptional;
    const stopGate = deferred();
    const stopEntered = deferred();
    let rootStops = 0;
    let followupStops = 0;
    root.stop = () => {
      rootStops++;
      return Promise.resolve();
    };
    followup.stop = async () => {
      followupStops++;
      stopEntered.resolve();
      await stopGate.promise;
    };
    fakeSignals(manager);
    const attach = manager.attachSignals.bind(manager);
    let attachAttempts = 0;
    // Fail the first transport attachment. The real public startup path performs
    // its automatic stop; no private stop guard or component state is bypassed.
    manager.attachSignals = () => {
      if (++attachAttempts === 1) {
        throw new Error('signal transport unavailable once');
      }
      attach();
    };
    let independent: ReturnType<typeof manager.startComponent> | undefined;
    root.start = async () => {
      expect(
        await manager.registerComponent(followup, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
      expect(
        await manager.registerComponent(unattempted, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
      independent = manager.startComponent('followup', {
        allowDuringBulkStartup: true,
      });
      await stopEntered.promise;
    };
    await manager.registerComponent(root);
    try {
      const result = await manager.startAllComponents({ timeoutMS: 0 });
      expect(result).toMatchObject({
        success: false,
        code: 'partial_state',
        startedComponents: ['root'],
        failedOptionalComponents: [],
      });
      expect(result.reason).toContain('independent stop');
      expect(rootStops).toBe(0);
      expect(followupStops).toBe(1);
      expect(manager.getComponentStatus('followup')?.state).toBe('stopping');
      expect(manager.getComponentStatus('unattempted')?.state).toBe(
        'registered',
      );
      const warning = sink.logs.find((entry) =>
        entry.message.includes('deferred auto-starts were not attempted'),
      );
      expect(warning?.params).toMatchObject({
        components: ['unattempted'],
        reason: 'was interrupted by independent component stop',
      });
    } finally {
      stopGate.resolve();
      expect((await independent)?.code).toBe('signal_attach_failed');
      await manager.stopAllComponents();
      manager.detachSignals();
    }
  },
);
