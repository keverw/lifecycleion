import { describe, test, expect } from 'bun:test';
import { sleep } from '../sleep';
import {
  claimReports,
  deferred,
  hasReport,
  fakeSignals,
  Plain,
  sendSignal,
  setup,
  Stalls,
} from './test-helpers';
import type { ForceShutdownContext } from './types';
import { LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT } from './constants';

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

  test('a stop released by its own timeout hook succeeds rather than stalling', async () => {
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

    // `stop()` did finish, as the timeout fired: a stop that succeeded, not a stall.
    expect(result.success).toBe(true);
    await sleep(10);

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

  test('a bulk startup refused on a component its late-startup cleanup is stopping keeps it stopping', async () => {
    const { logger, manager } = setup();
    const p = new Plain(logger, 'p');
    const t = new Plain(logger, 't');
    Object.assign(t, { optional: true, startupTimeoutMS: 30 });
    const firstStart = deferred();
    let tStartCalls = 0;
    t.start = (): Promise<void> => {
      tStartCalls++;
      return tStartCalls === 1 ? firstStart.promise : Promise.resolve();
    };
    let tStopCalls = 0;
    t.stop = async (): Promise<void> => {
      tStopCalls++;
      await sleep(150);
    };
    await manager.registerComponent(p);
    await manager.registerComponent(t);

    await manager.startAllComponents();
    await manager.stopAllComponents();

    // The second startup is still on `p` when `t`'s first start finishes late and its
    // cleanup starts stopping it.
    p.start = (): Promise<void> => sleep(60);
    const secondStartup = manager.startAllComponents();
    await sleep(20);
    firstStart.resolve();
    await secondStartup;

    expect(manager.getComponentStatus('t')?.state).toBe('stopping');

    const stop = await manager.stopComponent('t');
    expect(stop.code).toBe('component_already_stopping');
    expect(tStopCalls).toBe(1);

    await sleep(200);
  });

  test('unregister does not orphan a component a stopped listener starts again', async () => {
    const { logger, manager } = setup();
    const startGate = deferred();
    const db = new Plain(logger, 'db');
    let startCalls = 0;
    db.start = (): Promise<void> => {
      startCalls++;
      return startCalls === 1 ? Promise.resolve() : startGate.promise;
    };
    await manager.registerComponent(db);
    await manager.startComponent('db');

    const restarts: Promise<unknown>[] = [];
    manager.once('component:stopped', () => {
      restarts.push(manager.startComponent('db'));
    });

    const unregister = await manager.unregisterComponent('db');

    // The restart owns the component now; removing it would orphan whatever its
    // `start()` brings up.
    expect(unregister.success).toBe(false);
    expect(unregister.code).toBe('component_starting');
    expect(unregister.wasStopped).toBe(true);

    startGate.resolve();
    await Promise.all(restarts);
    expect(manager.hasComponent('db')).toBe(true);
    expect(manager.isComponentRunning('db')).toBe(true);
    expect(startCalls).toBe(2);
  });

  test('unregister during a graceful stop is refused as component_stopping', async () => {
    const { logger, manager } = setup();
    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const stop = manager.stopComponent('a');
    const unregister = await manager.unregisterComponent('a');

    expect(unregister.code).toBe('component_stopping');

    stopGate.resolve();
    await stop;
  });

  test('a start that throws after a listener restarted it leaves the restart alone', async () => {
    const { logger, manager } = setup();
    const secondStart = deferred();
    let startCalls = 0;

    class Flaky extends Plain {
      public override start(): Promise<void> {
        startCalls++;
        if (startCalls === 1) {
          this.reportUnexpectedStop(new Error('lost'));
          return Promise.reject(new Error('start failed'));
        }
        return secondStart.promise;
      }
    }

    const component = new Flaky(logger, 'a');
    await manager.registerComponent(component);

    const restarts: Promise<unknown>[] = [];
    manager.once('component:unexpected-stop', () => {
      restarts.push(manager.startComponent('a'));
    });
    let startFailedEvents = 0;
    manager.on('component:start-failed', () => {
      startFailedEvents++;
    });

    const first = await manager.startComponent('a');
    expect(first.success).toBe(false);

    // The restart still owns the component: still starting, no spurious failure.
    expect(manager.getComponentStatus('a')?.state).toBe('starting');
    expect(startFailedEvents).toBe(0);

    secondStart.resolve();
    await Promise.all(restarts);
    expect(manager.isComponentRunning('a')).toBe(true);
  });

  test('a throwing onShutdownWarning getter does not abort the shutdown pass', async () => {
    const { logger, manager } = setup({ shutdownWarningTimeoutMS: 50 });
    const hostile = new Plain(logger, 'hostile');
    Object.defineProperty(hostile, 'onShutdownWarning', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(hostile);
    await manager.startAllComponents();

    const { reports, release } = claimReports();
    let result;

    try {
      result = await manager.stopAllComponents();
    } finally {
      release();
    }

    expect(result.success).toBe(true);
    expect(manager.getRunningComponentNames()).toEqual([]);
    expect(reports).toHaveLength(1);
  });

  test('a stop deferred out of shutdown-completed with queueMicrotask still cancels the restart', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();

    const passes: Promise<unknown>[] = [];
    manager.once('lifecycle-manager:shutdown-completed', () => {
      queueMicrotask(() => {
        passes.push(manager.stopAllComponents());
      });
    });

    const restart = await manager.restartAllComponents();
    await Promise.all(passes);

    expect(restart.success).toBe(false);
    expect(restart.startupSkippedByShutdownRequest).toBe(true);
    expect(restart.startupResult.code).toBe(
      'shutdown_requested_during_restart',
    );
    expect(manager.isComponentRunning('a')).toBe(false);
  });

  test('an onShutdownForce rejection carrying the timeout text is not a timeout', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => Promise.reject(new Error('stop failed'));
    (a as unknown as { onShutdownForce: () => Promise<void> }).onShutdownForce =
      (): Promise<void> =>
        Promise.reject(
          new Error(LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT),
        );
    await manager.registerComponent(a);
    await manager.startComponent('a');

    let forceTimeoutEvents = 0;
    manager.on('component:shutdown-force-timeout', () => {
      forceTimeoutEvents++;
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(result.code).toBe('unknown_error');
    expect(manager.getStalledComponents()[0]?.reason).toBe('error');
    expect(forceTimeoutEvents).toBe(0);
  });

  test('a broadcast that crashes partway keeps the answers already collected', async () => {
    const { logger, manager } = setup();
    for (const name of ['a', 'b']) {
      const component = new Plain(logger, name);
      (component as unknown as { onMessage: () => string }).onMessage =
        (): string => `from ${name}`;
      await manager.registerComponent(component);
    }
    await manager.startAllComponents();

    const internals = manager as unknown as {
      sendMessageSettled: (...args: unknown[]) => Promise<unknown>;
    };
    const original = internals.sendMessageSettled.bind(manager);
    let calls = 0;
    internals.sendMessageSettled = (...args: unknown[]): Promise<unknown> => {
      calls++;
      if (calls === 2) {
        throw new Error('crash mid-broadcast');
      }
      return original(...args);
    };

    const { release } = claimReports();
    let results;

    try {
      results = await manager.broadcastMessage('hi');
    } finally {
      release();
    }

    expect(results.map((result) => result.name)).toEqual(['a']);
    expect(results[0]?.data).toBe('from a');
  });

  test('a start or stop releases its claim once it settles, crash paths included', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    const internals = manager as unknown as {
      componentClaims: Map<string, unknown>;
      issueStopAttemptToken: () => string;
    };

    await manager.startComponent('a');
    expect(internals.componentClaims.size).toBe(0);

    // A step that runs once the stop has claimed the component.
    internals.issueStopAttemptToken = (): never => {
      throw new Error('step exploded');
    };

    const { release } = claimReports();

    try {
      const stop = await manager.stopComponent('a');
      expect(stop.code).toBe('unknown_error');
    } finally {
      release();
    }

    expect(internals.componentClaims.size).toBe(0);
  });

  test('a getDependencies() that throws while protecting a component in flight does not abort the pass', async () => {
    const { logger, manager } = setup({ shutdownWarningTimeoutMS: 50 });
    let isBroken = false;
    const db = new Plain(logger, 'db');
    // Ordering is done by the time the warning phase runs; break the read after it.
    (db as unknown as { onShutdownWarning: () => void }).onShutdownWarning =
      (): void => {
        isBroken = true;
      };
    const stopGate = deferred();
    const api = new Plain(logger, 'api', ['db']);
    api.stop = (): Promise<void> => stopGate.promise;
    const realGetDependencies = api.getDependencies.bind(api);
    api.getDependencies = (): string[] => {
      if (isBroken) {
        throw new Error('getDependencies exploded');
      }
      return realGetDependencies();
    };
    await manager.registerComponent(db);
    await manager.registerComponent(api);
    await manager.startAllComponents();

    // A concurrent stop owns `api`, so the pass protects its dependencies.
    const apiStop = manager.stopComponent('api');

    const { reports, release } = claimReports();
    let result;

    try {
      result = await manager.stopAllComponents();
    } finally {
      stopGate.resolve();
      await apiStop;
      release();
    }

    expect(result.code).not.toBe('unknown_error');
    expect(hasReport(reports, 'shutdown dependencies of api')).toBe(true);
  });

  test('logger.exit() from a signal:shutdown listener still waits for the shutdown', async () => {
    const { logger, manager } = setup({ enableLoggerExitHook: true });
    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(a);
    await manager.startAllComponents();

    manager.on(
      'signal:shutdown',
      (data: { isAlreadyShuttingDown: boolean }) => {
        if (!data.isAlreadyShuttingDown) {
          logger.exit(0);
        }
      },
    );

    try {
      sendSignal(manager, 'SIGTERM');
      await sleep(20);

      // Not a force: the exit waits for the components to stop.
      expect(logger.didExit).toBe(false);
    } finally {
      stopGate.resolve();
      await sleep(10);
    }

    expect(logger.didExit).toBe(true);
  });

  test('a stop that settles right as it stalls does not halt the pass', async () => {
    const { logger, manager } = setup();
    const x = new Plain(logger, 'x');
    const stopGate = deferred();
    x.stop = async (): Promise<void> => {
      await stopGate.promise;
    };
    (x as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    (
      x as unknown as { onGracefulStopTimeout: () => void }
    ).onGracefulStopTimeout = (): void => {
      stopGate.resolve();
    };
    Object.assign(x, { shutdownGracefulTimeoutMS: 10 });
    const a = new Plain(logger, 'a');
    let aStopCalls = 0;
    a.stop = (): Promise<void> => {
      aStopCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(a);
    await manager.registerComponent(new Plain(logger, 'x-dependent-free'));
    await manager.registerComponent(x);
    await manager.startAllComponents();

    const result = await manager.stopAllComponents();

    expect(aStopCalls).toBe(1);
    expect(result.success).toBe(true);
    expect(manager.getComponentStatus('x')?.state).toBe('stopped');
  });

  test('a graceful stop released by its timeout hook skips a hanging force phase', async () => {
    const { logger, manager } = setup();
    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = async (): Promise<void> => {
      await stopGate.promise;
    };
    (
      a as unknown as { onGracefulStopTimeout: () => void }
    ).onGracefulStopTimeout = (): void => {
      stopGate.resolve();
    };
    (a as unknown as { onShutdownForce: () => Promise<void> }).onShutdownForce =
      (): Promise<void> => new Promise<void>(() => {});
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const startedAt = Date.now();
    const result = await manager.stopComponent('a', { timeout: 10 });

    expect(result.success).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  test('a force handler is called as read, not read a second time', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => Promise.reject(new Error('stop failed'));
    let reads = 0;
    let forceCalls = 0;
    Object.defineProperty(a, 'onShutdownForce', {
      get: (): (() => void) | undefined => {
        reads++;
        return reads === 1
          ? (): void => {
              forceCalls++;
            }
          : undefined;
      },
    });
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const { release } = claimReports();

    try {
      const result = await manager.stopComponent('a');
      expect(result.success).toBe(true);
    } finally {
      release();
    }

    expect(forceCalls).toBe(1);
  });

  test('a settlement left from an earlier stop does not end a later stall as stopped', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    let stopCalls = 0;
    let release: (() => void) | null = null;
    a.stop = async (): Promise<void> => {
      stopCalls++;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    (
      a as unknown as { onGracefulStopTimeout: () => void }
    ).onGracefulStopTimeout = (): void => {
      release?.();
    };
    (a as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    await manager.registerComponent(a);
    await manager.startComponent('a');

    // Settled by its own timeout hook: succeeds, leaving nothing behind.
    expect((await manager.stopComponent('a', { timeout: 10 })).success).toBe(
      true,
    );

    await manager.startComponent('a');

    // No force handler, so an immediate force stalls - `stop()` never runs.
    const { release: releaseReports } = claimReports();

    try {
      const forced = await manager.stopComponent('a', { forceImmediate: true });
      expect(forced.success).toBe(false);
    } finally {
      releaseReports();
    }

    expect(stopCalls).toBe(1);
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
  });

  test('a force retry released by its own abort hook stops rather than staying stalled', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => Promise.reject(new Error('stop failed'));
    let forceCalls = 0;
    let releaseForce: (() => void) | null = null;
    (a as unknown as { onShutdownForce: () => Promise<void> }).onShutdownForce =
      async (): Promise<void> => {
        forceCalls++;
        if (forceCalls === 1) {
          throw new Error('force failed');
        }
        await new Promise<void>((resolve) => {
          releaseForce = resolve;
        });
      };
    (
      a as unknown as { onShutdownForceAborted: () => void }
    ).onShutdownForceAborted = (): void => {
      releaseForce?.();
    };
    Object.assign(a, { shutdownForceTimeoutMS: 10 });
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const { release } = claimReports();

    try {
      await manager.stopComponent('a');
      expect(manager.getComponentStatus('a')?.state).toBe('stalled');

      await manager.stopAllComponents();
      await sleep(10);
    } finally {
      release();
    }

    expect(forceCalls).toBe(2);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    expect(manager.getStalledComponentNames()).toEqual([]);
  });

  test('a start that lands mid-pass and stalls stopping fails the pass', async () => {
    const { logger, manager } = setup();
    const aStopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => aStopGate.promise;
    const x = new Plain(logger, 'x');
    x.start = (): Promise<void> => sleep(5);
    x.stop = (): Promise<void> => Promise.reject(new Error('stop failed'));
    (x as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    await manager.registerComponent(a);
    await manager.registerComponent(x);
    await manager.startComponent('a');

    const { release } = claimReports();
    let result;

    try {
      const xStart = manager.startComponent('x');
      const pass = manager.stopAllComponents();
      await sleep(20);
      aStopGate.resolve();
      result = await pass;
      await xStart;
    } finally {
      release();
    }

    expect(manager.getStalledComponentNames()).toEqual(['x']);
    expect(result.success).toBe(false);
    expect(result.stalledComponents.map((stall) => stall.name)).toEqual(['x']);
  });

  test('startAllComponents() does not count a component still stopping as running', async () => {
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

    const stop = manager.stopComponent('a');
    const startup = await manager.startAllComponents();

    expect(startup.success).toBe(false);
    expect(startup.code).toBe('partial_state');
    expect(startup.startedComponents).toEqual([]);
    expect(startCalls).toBe(1);

    stopGate.resolve();
    await stop;
  });

  test('unregister does not remove a component a stopped listener already restarted', async () => {
    const { logger, manager } = setup();
    const db = new Plain(logger, 'db');
    let startCalls = 0;
    db.start = (): Promise<void> => {
      startCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(db);
    await manager.startComponent('db');

    const restarts: Promise<unknown>[] = [];
    manager.once('component:stopped', () => {
      restarts.push(manager.startComponent('db'));
    });

    const unregister = await manager.unregisterComponent('db');
    await Promise.all(restarts);

    expect(startCalls).toBe(2);
    expect(unregister.success).toBe(false);
    expect(unregister.wasStopped).toBe(true);
    expect(manager.hasComponent('db')).toBe(true);
    expect(manager.isComponentRunning('db')).toBe(true);
  });

  test('a force retry is not run over an in-flight forceStalled start', async () => {
    const { logger, manager } = setup();
    const x = new Stalls(logger, 'x');
    await manager.registerComponent(x);
    await manager.startComponent('x');

    const { release } = claimReports();

    try {
      await manager.stopComponent('x');
      expect(manager.getComponentStatus('x')?.state).toBe('stalled');
      const forceCallsAfterStall = x.forceCalls;

      // A forced restart whose `start()` is slow.
      let stopCalls = 0;
      x.start = (): Promise<void> => sleep(20);
      x.stop = (): Promise<void> => {
        stopCalls++;
        return Promise.resolve();
      };
      const forcedStart = manager.startComponent('x', { forceStalled: true });
      await sleep(1);

      await manager.stopAllComponents();
      await forcedStart;
      await sleep(10);

      // The pass did not force it mid-start; the start path stopped it once it was up.
      expect(x.forceCalls).toBe(forceCallsAfterStall);
      expect(stopCalls).toBe(1);
      expect(manager.isComponentRunning('x')).toBe(false);
    } finally {
      release();
    }
  });

  test('a stall that clears mid-pass does not halt the loop', async () => {
    const { logger, manager } = setup({
      shutdownOptions: { retryStalled: true },
    });
    const oldStop = deferred();
    const a = new Plain(logger, 'a');
    let aStopCalls = 0;
    a.stop = (): Promise<void> => {
      aStopCalls++;
      return Promise.resolve();
    };
    const x = new Plain(logger, 'x');
    x.stop = (): Promise<void> => oldStop.promise;
    (x as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    const b = new Plain(logger, 'b');
    // `x`'s old stop settles while the pass is stopping `b`.
    b.stop = async (): Promise<void> => {
      oldStop.resolve();
      await sleep(5);
    };
    await manager.registerComponent(a);
    await manager.registerComponent(x);
    await manager.registerComponent(b);
    await manager.startAllComponents();

    const { release } = claimReports();
    let result;

    try {
      await manager.stopComponent('x', { timeout: 10 });
      x.start = (): Promise<void> => Promise.reject(new Error('no'));
      await manager.startComponent('x', { forceStalled: true });
      expect(manager.getStalledComponentNames()).toEqual(['x']);

      result = await manager.stopAllComponents();
    } finally {
      release();
    }

    expect(aStopCalls).toBe(1);
    expect(result.success).toBe(true);
  });

  test('a component auto-started during a bulk startup is rolled back with it', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    c.start = (): Promise<void> =>
      sleep(10).then(() => {
        throw new Error('c failed');
      });
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(c);

    const registrations: Promise<unknown>[] = [];
    manager.once('component:started', () => {
      registrations.push(
        manager.registerComponent(new Plain(logger, 'late', ['a']), {
          autoStart: true,
        }),
      );
    });

    const startup = await manager.startAllComponents();
    await Promise.all(registrations);

    expect(startup.success).toBe(false);
    expect(manager.getRunningComponentNames()).toEqual([]);
  });

  test('a forceImmediate stop whose force getter throws keeps the unexpected-stop handler', async () => {
    const { logger, manager } = setup();

    class Reporter extends Plain {
      public crash(): boolean {
        return this.reportUnexpectedStop(new Error('crashed'));
      }
    }

    const a = new Reporter(logger, 'a');
    Object.defineProperty(a, 'shutdownForceTimeoutMS', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const { release } = claimReports();

    try {
      const stop = await manager.stopComponent('a', { forceImmediate: true });
      expect(stop.code).toBe('unknown_error');
    } finally {
      release();
    }

    expect(manager.getComponentStatus('a')?.state).toBe('running');
    expect(a.crash()).toBe(true);
    expect(manager.isComponentRunning('a')).toBe(false);
  });

  test('a throwing _clearUnexpectedStopHandler does not lose a start timeout', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    Object.assign(a, { startupTimeoutMS: 10 });
    a.start = (): Promise<void> => new Promise<void>(() => {});
    const original = a._clearUnexpectedStopHandler.bind(a);
    let clears = 0;
    a._clearUnexpectedStopHandler = (): void => {
      clears++;
      if (clears === 1) {
        throw new Error('hook exploded');
      }
      original();
    };
    await manager.registerComponent(a);

    const { release } = claimReports();
    let result;

    try {
      result = await manager.startComponent('a');
    } finally {
      release();
    }

    expect(result.code).toBe('component_startup_timeout');
    expect(manager.getComponentStatus('a')?.state).toBe('starting-timed-out');
  });

  test('a throwing getDependencies() at registration reaches the global channel', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    const hostile = new Plain(logger, 'hostile');
    hostile.getDependencies = (): never => {
      throw new Error('getDependencies exploded');
    };

    const { reports, release } = claimReports();

    try {
      const registration = await manager.registerComponent(hostile);
      expect(registration.code).toBe('unknown_error');
      expect(hasReport(reports, 'lifecycle-manager registerComponent')).toBe(
        true,
      );
    } finally {
      release();
    }
  });

  test('a rollback that could not stop a component still reports it as started', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const b = new Plain(logger, 'b');
    b.start = (): Promise<void> => Promise.reject(new Error('b failed'));
    await manager.registerComponent(a);
    await manager.registerComponent(b);

    // Read before the stop claims it: the rollback's stop of `a` fails, `a` still up.
    manager.once('component:started', () => {
      Object.defineProperty(a, 'shutdownGracefulTimeoutMS', {
        get: (): never => {
          throw new Error('getter exploded');
        },
      });
    });

    const { release } = claimReports();
    let startup;

    try {
      startup = await manager.startAllComponents();
    } finally {
      release();
    }

    expect(startup.code).toBe('required_component_failed');
    expect(manager.isComponentRunning('a')).toBe(true);
    expect(startup.startedComponents).toEqual(['a']);
  });

  test('a crashed unregister reports wasRegistered as of the call, without public lookups', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));

    const internals = manager as unknown as {
      refuseUnregisterWhileInFlight: () => never;
      hasComponent: () => never;
    };
    internals.refuseUnregisterWhileInFlight = (): never => {
      throw new Error('crash mid-unregister');
    };
    internals.hasComponent = (): never => {
      throw new Error('hasComponent exploded');
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.unregisterComponent('a');
    } finally {
      release();
    }

    expect(result.code).toBe('unknown_error');
    expect(result.wasRegistered).toBe(true);
  });

  test('one component with a throwing getDependencies() does not block stopping another', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(hostile);
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    hostile.getDependencies = (): never => {
      throw new Error('getDependencies exploded');
    };

    const { release } = claimReports();
    let stop;

    try {
      stop = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(stop.success).toBe(true);
  });

  test('a component another stop owned that ended outside stopped still settles the pass', async () => {
    const { logger, manager } = setup({
      shutdownOptions: { haltOnStall: false },
    });
    const xStopGate = deferred();
    const x = new Plain(logger, 'x');
    Object.assign(x, { optional: true, startupTimeoutMS: 20 });
    x.start = (): Promise<void> => sleep(40);
    x.stop = (): Promise<void> => xStopGate.promise;
    const slow = new Plain(logger, 'slow');
    // `x`'s cleanup stop finishes while the pass is stopping `slow`.
    slow.stop = async (): Promise<void> => {
      xStopGate.resolve();
      await sleep(20);
    };
    await manager.registerComponent(slow);
    await manager.registerComponent(x);
    await manager.startAllComponents();

    await sleep(40);
    expect(manager.getComponentStatus('x')?.state).toBe('stopping');

    const result = await manager.stopAllComponents();

    // Back to `failed` - what the timed-out optional start left - not `stopped`.
    expect(manager.getComponentStatus('x')?.state).toBe('failed');
    expect(result.success).toBe(true);
  });

  test('a throwing getValue getter still pairs value-requested with value-returned', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    await manager.startComponent('a');
    Object.defineProperty(a, 'getValue', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const events: string[] = [];
    manager.on('component:value-requested', () => {
      events.push('requested');
    });
    manager.on('component:value-returned', () => {
      events.push('returned');
    });

    const { release } = claimReports();

    try {
      expect(manager.getValue('a', 'k').code).toBe('error');
    } finally {
      release();
    }

    expect(events).toEqual(['requested', 'returned']);
  });
});
