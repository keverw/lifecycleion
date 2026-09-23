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

    const attachedInListener: boolean[] = [];
    manager.once('lifecycle-manager:shutdown-completed', () => {
      attachedInListener.push(signals.isAttached());
      // A listener that attaches again is not undone once the pass ends.
      manager.attachSignals();
    });

    const result = await manager.stopAllComponents();

    expect(result.success).toBe(true);
    expect(attachedInListener).toEqual([false]);
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

  test('a component whose getName() returns a non-string is refused at registration', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    let calls = 0;
    component.getName = (): string => {
      calls++;
      if (calls === 1) {
        return undefined as unknown as string;
      }
      throw new Error('getName exploded');
    };

    const { release } = claimReports();
    let registration;

    try {
      registration = await manager.registerComponent(component);
    } finally {
      release();
    }

    expect(registration.success).toBe(false);
    expect(registration.code).toBe('unknown_error');
    expect(manager.getComponentNames()).toEqual([]);

    // Nothing recorded, so nothing later can fall through to the throwing getName().
    const unregister = await manager.unregisterComponent('a');
    expect(unregister.success).toBe(false);
  });

  test('unregister is refused while the component is starting', async () => {
    const { logger, manager } = setup();
    const startGate = deferred();
    const a = new Plain(logger, 'a');
    a.start = (): Promise<void> => startGate.promise;
    await manager.registerComponent(a);

    const start = manager.startComponent('a');
    const unregister = await manager.unregisterComponent('a');

    expect(unregister.success).toBe(false);
    expect(unregister.code).toBe('component_starting');

    startGate.resolve();
    expect((await start).success).toBe(true);
    expect(manager.hasComponent('a')).toBe(true);
    expect((await manager.stopAllComponents()).stoppedComponents).toEqual([
      'a',
    ]);
  });

  test('a start superseded by a restart from an unexpected-stop listener does not mark it running', async () => {
    const { logger, manager } = setup();
    const startGate = deferred();
    let startCalls = 0;

    class Flaky extends Plain {
      public override start(): Promise<void> {
        startCalls++;
        if (startCalls === 1) {
          this.reportUnexpectedStop(new Error('lost'));
          return startGate.promise;
        }
        return Promise.reject(new Error('restart failed'));
      }
    }

    await manager.registerComponent(new Flaky(logger, 'a'));

    const restarts: Promise<unknown>[] = [];
    manager.once('component:unexpected-stop', () => {
      restarts.push(manager.startComponent('a'));
    });

    const first = manager.startComponent('a');
    await Promise.all(restarts);
    startGate.resolve();
    const result = await first;

    expect(result.success).toBe(false);
    expect(manager.isComponentRunning('a')).toBe(false);
  });

  test('a stop released by its own timeout hook clears the stall that follows', async () => {
    const { logger, manager } = setup();
    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = async (): Promise<void> => {
      await stopGate.promise;
    };
    (a as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    (
      a as unknown as { onGracefulStopTimeout: () => void }
    ).onGracefulStopTimeout = (): void => {
      stopGate.resolve();
    };
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const result = await manager.stopComponent('a', { timeout: 10 });
    expect(result.success).toBe(false);
    await sleep(10);

    // `stop()` did finish, so the stall resolves as any late stop does.
    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('a force retry still running is not started again by the next pass', async () => {
    const { logger, manager } = setup();
    const forceGate = deferred();
    const a = new Stalls(logger, 'a');
    (a as unknown as { onShutdownForce: () => Promise<void> }).onShutdownForce =
      (): Promise<void> => {
        a.forceCalls++;
        if (a.forceCalls === 1) {
          return Promise.reject(new Error('force failed'));
        }
        return forceGate.promise;
      };
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const { release } = claimReports();

    try {
      await manager.stopComponent('a');
      expect(manager.getComponentStatus('a')?.state).toBe('stalled');

      // The retry's `onShutdownForce()` hangs past the pass timeout.
      const first = await manager.stopAllComponents({ timeoutMS: 20 });
      expect(first.timedOut).toBe(true);

      await manager.stopAllComponents({ timeoutMS: 20 });
      expect(a.forceCalls).toBe(2);
    } finally {
      forceGate.resolve();
      await sleep(10);
      release();
    }
  });

  test('a force attempt resuming after a late graceful stop and a restart leaves the restart alone', async () => {
    const { logger, manager } = setup();
    const stopGate = deferred();
    const forceGate = deferred();
    const forceEntered = deferred();
    const a = new Plain(logger, 'a');
    let stopCalls = 0;
    a.stop = async (): Promise<void> => {
      stopCalls++;
      if (stopCalls === 1) {
        await stopGate.promise;
      }
    };
    (a as unknown as { onShutdownForce: () => Promise<void> }).onShutdownForce =
      (): Promise<void> => {
        forceEntered.resolve();
        return forceGate.promise;
      };
    Object.assign(a, { shutdownGracefulTimeoutMS: 10 });
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const restarts: Promise<unknown>[] = [];
    let stoppedEvents = 0;
    manager.on('component:stopped', () => {
      stoppedEvents++;
      if (stoppedEvents === 1) {
        restarts.push(manager.startComponent('a'));
      }
    });

    const stop = manager.stopComponent('a');
    await forceEntered.promise;

    // The graceful stop finishes late; a listener starts the component again.
    stopGate.resolve();
    await sleep(5);
    await Promise.all(restarts);
    await stop;

    expect(manager.getComponentStatus('a')?.state).toBe('running');
    expect(manager.isComponentRunning('a')).toBe(true);
    expect(stoppedEvents).toBe(1);

    forceGate.resolve();
    await manager.stopAllComponents();
  });

  test('logger.exit() from onForceShutdown exits without waiting out the pass', async () => {
    const stopGate = deferred();
    const { logger, manager } = setup({
      enableLoggerExitHook: true,
      shutdownOptions: { timeoutMS: 5000 },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        onForceShutdown: (): void => {
          logger.exit(1);
        },
      },
    });
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(a);
    await manager.startAllComponents();

    try {
      sendSignal(manager, 'SIGINT');
      await sleep(5);
      sendSignal(manager, 'SIGINT');
      await sleep(20);

      // The pass is still waiting on `stop()`, but the force already exited.
      expect(manager.getSystemState()).toBe('shutting-down');
      expect(logger.didExit).toBe(true);
    } finally {
      stopGate.resolve();
      await sleep(10);
    }
  });

  test('a haltOnStall break names the stalled component as well as the ones it skipped', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'db'));
    await manager.registerComponent(new Stalls(logger, 'api', ['db']));
    await manager.startAllComponents();

    const { release } = claimReports();
    let result;

    try {
      result = await manager.stopAllComponents();
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.reason).toBe('Stalled: api; Failed to stop: db');
  });

  test('a restart whose stop phase timed out does not report a startup that never ran', async () => {
    const { logger, manager } = setup();
    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    let startCalls = 0;
    a.start = (): Promise<void> => {
      startCalls++;
      return Promise.resolve();
    };
    a.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(a);
    await manager.startAllComponents();

    const restart = await manager.restartAllComponents({
      shutdownTimeoutMS: 20,
    });

    expect(restart.success).toBe(false);
    expect(restart.startupResult.success).toBe(false);
    expect(restart.startupResult.startedComponents).toEqual([]);
    expect(startCalls).toBe(1);

    stopGate.resolve();
    await sleep(10);
  });

  test('a restart whose stop phase crashed carries the error on its startup result', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();

    (
      manager as unknown as { runShutdownWarningPhase: () => Promise<never> }
    ).runShutdownWarningPhase = (): Promise<never> =>
      Promise.reject(new Error('warning phase exploded'));

    const { release } = claimReports();
    let restart;

    try {
      restart = await manager.restartAllComponents();
    } finally {
      release();
    }

    expect(restart.shutdownResult.code).toBe('unknown_error');
    expect(restart.startupResult.code).toBe('unknown_error');
    expect(restart.startupResult.error).toBeInstanceOf(Error);
  });

  test('a shutdown started from a component:starting listener stops the component once it is up', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    // Still starting when the pass - with nothing running to stop - has ended.
    a.start = (): Promise<void> => sleep(20);
    await manager.registerComponent(a);

    const passes: Promise<unknown>[] = [];
    manager.once('component:starting', () => {
      passes.push(manager.stopAllComponents());
    });

    await manager.startComponent('a');
    await Promise.all(passes);
    await sleep(10);

    expect(manager.isComponentRunning('a')).toBe(false);
  });

  test('options read up front: a throwing getter announces nothing', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    (a as unknown as { onMessage: () => string }).onMessage = (): string =>
      'ok';
    (a as unknown as { getValue: () => string }).getValue = (): string => 'v';
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const events: string[] = [];
    manager.on('component:message-sent', () => {
      events.push('message-sent');
    });
    manager.on('component:value-requested', () => {
      events.push('value-requested');
    });
    const hostileOptions = {
      get timeout(): number {
        throw new Error('options exploded');
      },
      get includeStopped(): boolean {
        throw new Error('options exploded');
      },
    };

    const { release } = claimReports();

    try {
      const message = await manager.sendMessageToComponent(
        'a',
        'hi',
        hostileOptions,
      );
      const value = manager.getValue('a', 'k', hostileOptions);
      expect(message.sent).toBe(false);
      expect(value.found).toBe(false);
    } finally {
      release();
    }

    expect(events).toEqual([]);
  });

  test("a shutdown started from the last component's start-failed-optional listener fails the startup", async () => {
    const { logger, manager } = setup();
    const optional = new Plain(logger, 'optional');
    Object.assign(optional, { optional: true });
    optional.start = (): Promise<void> => Promise.reject(new Error('no'));
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(optional);

    const passes: Promise<unknown>[] = [];
    let startedEvents = 0;
    manager.once('component:start-failed-optional', () => {
      passes.push(manager.stopAllComponents());
    });
    manager.on('lifecycle-manager:started', () => {
      startedEvents++;
    });

    const startup = await manager.startAllComponents();
    await Promise.all(passes);

    expect(startup.success).toBe(false);
    expect(startup.code).toBe('shutdown_in_progress');
    expect(startedEvents).toBe(0);
  });

  test('autoStart during a bulk startup, after its first component is up, starts the component', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(new Plain(logger, 'b'));

    const registrations: Promise<{ autoStartSucceeded?: boolean }>[] = [];
    manager.once('component:started', () => {
      registrations.push(
        manager.registerComponent(new Plain(logger, 'late'), {
          autoStart: true,
        }),
      );
    });

    await manager.startAllComponents();
    const [registration] = await Promise.all(registrations);

    expect(registration.autoStartSucceeded).toBe(true);
    expect(manager.isComponentRunning('late')).toBe(true);
  });

  test('an unregister whose _markUnregistered throws can still be registered again', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);

    const original = component._markUnregistered.bind(component);
    component._markUnregistered = (): never => {
      throw new Error('hook exploded');
    };

    const { release } = claimReports();

    try {
      expect((await manager.unregisterComponent('a')).success).toBe(true);
    } finally {
      release();
    }

    component._markUnregistered = original;
    const again = await manager.registerComponent(component);
    expect(again.success).toBe(true);
  });

  test('force getters are not read for a component without a force handler', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => Promise.reject(new Error('stop failed'));
    (a as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    Object.defineProperty(a, 'shutdownForceTimeoutMS', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });
    await manager.registerComponent(a);
    await manager.startComponent('a');

    let forceEvents = 0;
    manager.on('component:shutdown-force', () => {
      forceEvents++;
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.reason).toBe('stop failed');
    expect(forceEvents).toBe(1);
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
  });

  test('broadcastMessage reads componentNames once', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();

    let reads = 0;
    const options = {
      get componentNames(): string[] {
        reads++;
        return ['a'];
      },
    };

    await manager.broadcastMessage('hi', options);
    expect(reads).toBe(1);
  });
});
