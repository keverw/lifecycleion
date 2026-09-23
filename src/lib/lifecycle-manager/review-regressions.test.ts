import { describe, test, expect } from 'bun:test';
import { sleep } from '../sleep';
import {
  claimReports,
  deferred,
  fakeSignals,
  Plain,
  sendSignal,
  setup,
  Stalls,
} from './test-helpers';
import type { ForceShutdownContext } from './types';

describe('LifecycleManager - review regressions', () => {
  test('a stall cleared by a late stop after a failed forced restart detaches signals', async () => {
    const { logger, manager } = setup({
      attachSignalsOnStart: true,
      detachSignalsOnStop: true,
    });
    const signals = fakeSignals(manager);
    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => stopGate.promise;
    (a as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    await manager.registerComponent(a);
    await manager.registerComponent(new Plain(logger, 'b'));
    await manager.startComponent('a');
    await manager.startComponent('b');
    expect(signals.isAttached()).toBe(true);

    const { release } = claimReports();

    try {
      await manager.stopComponent('a', { timeout: 10 });
      expect(manager.getComponentStatus('a')?.state).toBe('stalled');

      a.start = (): Promise<void> => Promise.reject(new Error('no'));
      const forced = await manager.startComponent('a', { forceStalled: true });
      expect(forced.success).toBe(false);

      await manager.stopComponent('b');
      stopGate.resolve();
      await sleep(10);
    } finally {
      release();
    }

    expect(manager.getRunningComponentNames()).toEqual([]);
    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(signals.isAttached()).toBe(false);
  });

  test('a component a late-startup cleanup stopped mid-pass does not halt the pass', async () => {
    const { logger, manager } = setup({ shutdownWarningTimeoutMS: 500 });
    const stopGate = deferred();
    const d = new Plain(logger, 'd');
    let dStopCalls = 0;
    d.stop = (): Promise<void> => {
      dStopCalls++;
      return Promise.resolve();
    };
    (
      d as unknown as { onShutdownWarning: () => Promise<void> }
    ).onShutdownWarning = async (): Promise<void> => {
      stopGate.resolve();
      await sleep(10);
    };
    const x = new Plain(logger, 'x', ['d']);
    Object.assign(x, { optional: true, startupTimeoutMS: 20 });
    x.start = (): Promise<void> => sleep(40);
    x.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(d);
    await manager.registerComponent(x);

    const startup = await manager.startAllComponents();
    expect(startup.success).toBe(true);

    // `x` finishes starting late and its cleanup stop is in flight.
    await sleep(40);
    expect(manager.getComponentStatus('x')?.state).toBe('stopping');

    const result = await manager.stopAllComponents();

    expect(dStopCalls).toBe(1);
    expect(result.success).toBe(true);
  });

  test('a failed restart does not arm escalation on its own behalf', async () => {
    const forces: ForceShutdownContext[] = [];
    const { logger, manager } = setup({
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        onForceShutdown: (context): void => {
          forces.push(context);
        },
      },
    });
    await manager.registerComponent(new Stalls(logger, 'a'));
    await manager.startAllComponents();

    const { release } = claimReports();

    try {
      const restart = await manager.restartAllComponents();
      expect(restart.success).toBe(false);

      // Nobody asked the process to go down, so there is no cycle to keep armed.
      expect(manager.getShutdownEscalationStatus().isArmed).toBe(false);

      // The operator's first Ctrl+C starts a cycle; it is not press one of the restart's.
      sendSignal(manager, 'SIGINT');
      await sleep(20);
    } finally {
      release();
    }

    expect(forces).toEqual([]);
    expect(manager.getShutdownEscalationStatus().firstMethod).toBe('SIGINT');
  });

  test('a signal raised from onForceShutdown does not reseed the cycle', async () => {
    const forces: ForceShutdownContext[] = [];
    const { logger, manager } = setup({
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        onForceShutdown: (context): void => {
          forces.push(context);
          sendSignal(manager, 'SIGTERM');
        },
      },
    });
    await manager.registerComponent(new Stalls(logger, 'a'));
    await manager.startAllComponents();

    const { release } = claimReports();

    try {
      sendSignal(manager, 'SIGINT');
      await sleep(20);
      // Armed after the failed pass: this press forces, and the handler signals again.
      sendSignal(manager, 'SIGINT');
      await sleep(20);
      expect(forces).toHaveLength(1);

      // Force fires once per cycle: the nested signal continued it rather than wiping it.
      sendSignal(manager, 'SIGINT');
      await sleep(20);
    } finally {
      release();
    }

    expect(forces).toHaveLength(1);
  });

  test("a start that finishes during another start's attach rollback still attaches", async () => {
    const { logger, manager } = setup({ attachSignalsOnStart: true });
    const signals = fakeSignals(manager);
    const fakeAttach = manager.attachSignals.bind(manager);
    let attachCalls = 0;
    manager.attachSignals = (): void => {
      attachCalls++;
      if (attachCalls === 1) {
        throw new Error('attach exploded');
      }
      fakeAttach();
    };

    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => stopGate.promise;
    const bStartGate = deferred();
    const b = new Plain(logger, 'b');
    b.start = (): Promise<void> => bStartGate.promise;
    await manager.registerComponent(a);
    await manager.registerComponent(b);

    const bStart = manager.startComponent('b');
    const aStart = manager.startComponent('a');
    await sleep(5);

    // `a` failed to attach and is being stopped again; `b` comes up meanwhile.
    bStartGate.resolve();
    const bResult = await bStart;
    stopGate.resolve();
    const aResult = await aStart;

    expect(aResult.code).toBe('signal_attach_failed');
    expect(bResult.success).toBe(true);
    expect(manager.isComponentRunning('b')).toBe(true);
    expect(signals.isAttached()).toBe(true);
  });

  test('a clean pass detaches signals before shutdown-completed listeners run', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    const signals = fakeSignals(manager);
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    manager.attachSignals();

    let wasAttachedInListener: boolean | null = null;
    manager.once('lifecycle-manager:shutdown-completed', () => {
      wasAttachedInListener = signals.isAttached();
      // A listener that attaches again is not undone once the pass ends.
      manager.attachSignals();
    });

    const result = await manager.stopAllComponents();

    expect(result.success).toBe(true);
    expect(wasAttachedInListener).toBe(false);
    expect(signals.isAttached()).toBe(true);
  });

  test('stopping the last running component while another starts keeps signals', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    const signals = fakeSignals(manager);
    const startGate = deferred();
    const b = new Plain(logger, 'b');
    b.start = (): Promise<void> => startGate.promise;
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(b);
    await manager.startComponent('a');
    manager.attachSignals();

    const bStart = manager.startComponent('b');
    await manager.stopComponent('a');

    // `b` is still starting: it may yet be running, so the handlers stay.
    expect(signals.isAttached()).toBe(true);

    startGate.resolve();
    expect((await bStart).success).toBe(true);
    expect(signals.isAttached()).toBe(true);
  });

  test('a detach deferred for an in-flight start runs once that start fails', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    const signals = fakeSignals(manager);
    const startGate = deferred();
    const b = new Plain(logger, 'b');
    b.start = (): Promise<void> => startGate.promise;
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(b);
    await manager.startComponent('a');
    manager.attachSignals();

    const bStart = manager.startComponent('b');
    await manager.stopComponent('a');
    expect(signals.isAttached()).toBe(true);

    startGate.reject(new Error('no'));
    expect((await bStart).success).toBe(false);
    expect(signals.isAttached()).toBe(false);
  });
});
