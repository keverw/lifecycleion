import { describe, test, expect } from 'bun:test';
import { LifecycleManager } from './lifecycle-manager';
import {
  claimReports,
  coreOf,
  fakeSignals,
  hasReport,
  Plain,
  setup,
} from './test-helpers';
import type { ComponentOperationResult, StartupResult } from './types';
import { LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING } from './constants';

describe('bulk startup review fixes', () => {
  test('a member started again after its own unexpected stop during start() is rolled back', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const b = new Plain(logger, 'b', ['a']);
    let restart: Promise<ComponentOperationResult> | undefined;
    let starts = 0;
    a.start = async (): Promise<void> => {
      starts++;
      if (starts > 1) {
        return;
      }
      (
        a as unknown as { reportUnexpectedStop: () => boolean }
      ).reportUnexpectedStop();
      restart = manager.startComponent('a', { allowDuringBulkStartup: true });
      await restart;
    };
    await manager.registerComponent(a);
    await manager.registerComponent(b);

    try {
      const result = await manager.startAllComponents();
      expect((await restart)?.success).toBe(true);
      expect(result).toMatchObject({
        success: false,
        code: 'component_unexpected_stop',
        startedComponents: [],
      });
      // The rollback reached the component the listener brought back up.
      expect(manager.isComponentRunning('a')).toBe(false);
      expect(manager.isComponentRunning('b')).toBe(false);
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });

  test('a startup begun from an overridden name getter during preflight is the only one', async () => {
    let nested: Promise<StartupResult> | undefined;
    let hasStartedNested = false;
    // The first read starts a startup of its own and answers with no names, so the
    // outer preflight finds nothing still starting and goes ahead.
    class Reentrant extends LifecycleManager {
      public override getComponentNames(): string[] {
        if (!hasStartedNested && this.getComponentCount() > 0) {
          hasStartedNested = true;
          nested = this.startAllComponents();
          return [];
        }
        return super.getComponentNames();
      }
    }
    const { logger } = setup();
    const manager = new Reentrant({ logger, shutdownWarningTimeoutMS: -1 });
    const a = new Plain(logger, 'a');
    let starts = 0;
    a.start = (): Promise<void> => {
      starts++;
      return Promise.resolve();
    };
    await manager.registerComponent(a);

    try {
      const outer = await manager.startAllComponents();
      expect(outer).toMatchObject({
        success: false,
        code: 'already_in_progress',
      });
      expect((await nested)?.success).toBe(true);
      expect(starts).toBe(1);
      expect(manager.isComponentRunning('a')).toBe(true);
    } finally {
      await manager.stopAllComponents();
      await logger.close();
    }
  });

  test('a member refused for a logger exit with no shutdown pass rolls back what started', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const b = new Plain(logger, 'b');
    await manager.registerComponent(a);
    await manager.registerComponent(b);
    const loggerExit = coreOf(manager).loggerExit;
    const isLoggerExitInProgress =
      loggerExit.isLoggerExitInProgress.bind(loggerExit);
    // From once `a` is up: `b`'s start meets the process-exiting gate, and no shutdown
    // pass begins to own what this startup started.
    manager.once('component:started', () => {
      loggerExit.isLoggerExitInProgress = (): boolean => true;
    });

    try {
      const result = await manager.startAllComponents();
      expect(result).toMatchObject({
        success: false,
        code: 'shutdown_in_progress',
        reason: LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
        startedComponents: [],
      });
      expect(manager.isComponentRunning('a')).toBe(false);
      expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    } finally {
      loggerExit.isLoggerExitInProgress = isLoggerExitInProgress;
      await manager.stopAllComponents();
      await logger.close();
    }
  });
});

describe('component start review fixes', () => {
  test('a resolved start whose bookkeeping crashes announces started before it is stopped', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    const internals = coreOf(manager).componentStart as unknown as {
      markComponentRunning: (name: string) => void;
    };
    const original = internals.markComponentRunning.bind(internals);
    let hasCrashed = false;
    internals.markComponentRunning = (name: string): void => {
      if (!hasCrashed) {
        hasCrashed = true;
        throw new Error('bookkeeping exploded');
      }
      original(name);
    };
    const events: string[] = [];
    for (const event of [
      'component:starting',
      'component:started',
      'component:stopping',
      'component:stopped',
    ] as const) {
      manager.on(event, () => {
        events.push(event);
      });
    }

    const { reports, release } = claimReports();
    try {
      const result = await manager.startComponent('a');
      expect(result).toMatchObject({
        success: false,
        code: 'operation_crashed',
      });
      expect(hasReport(reports, 'component start')).toBe(true);
      expect(events).toEqual([
        'component:starting',
        'component:started',
        'component:stopping',
        'component:stopped',
      ]);
    } finally {
      release();
      await logger.close();
    }
  });

  test('signals a start attached are detached when its claim crashes after the attach', async () => {
    const { logger, manager } = setup({
      attachSignalsBeforeStartup: true,
      detachSignalsOnStop: true,
    });
    const signals = fakeSignals(manager);
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    const settlements = coreOf(manager).startSettlements;
    const recordStartAttempt = settlements.recordStartAttempt.bind(settlements);
    settlements.recordStartAttempt = (): never => {
      throw new Error('claim bookkeeping exploded');
    };

    const { reports, release } = claimReports();
    try {
      const result = await manager.startComponent('a');
      expect(result).toMatchObject({
        success: false,
        code: 'operation_crashed',
      });
      expect(hasReport(reports, 'component start')).toBe(true);
      expect(signals.attachCalls()).toBe(1);
      expect(signals.isAttached()).toBe(false);
      expect(manager.getComponentStatus('a')?.state).toBe('registered');
    } finally {
      settlements.recordStartAttempt = recordStartAttempt;
      release();
      await logger.close();
    }
  });
});
