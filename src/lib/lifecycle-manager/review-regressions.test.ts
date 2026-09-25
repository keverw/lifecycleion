import { describe, test, expect } from 'bun:test';
import { sleep } from '../sleep';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import {
  claimReports,
  deferred,
  fakeAttachedSignals,
  hasReport,
  fakeSignals,
  Plain,
  sendSignal,
  setup,
  Stalls,
} from './test-helpers';
import type { ForceShutdownContext } from './types';
import { LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT } from './constants';

// Makes the first `component:registered` emit throw - a failure after a registration
// has committed, which nothing in the manager produces on purpose.
function crashFirstRegisteredEvent(
  manager: LifecycleManager,
  // Only this component's event, when given.
  name?: string,
): void {
  const events = (
    manager as unknown as {
      lifecycleEvents: { componentRegistered: (...args: unknown[]) => void };
    }
  ).lifecycleEvents;
  const original = events.componentRegistered.bind(events);
  let hasCrashed = false;
  events.componentRegistered = (...args: unknown[]): void => {
    const isTarget =
      name === undefined || (args[0] as { name?: string }).name === name;

    if (!hasCrashed && isTarget) {
      hasCrashed = true;
      throw new Error('crash after commit');
    }

    original(...args);
  };
}

// After a component's auto-start, fails the success path - describing the position
// throws - and the registration's catch, which describes it again and must contain it.
function breakCatchAfterAutoStart(manager: LifecycleManager): void {
  manager.once('component:started', () => {
    (
      manager as unknown as { describeRegistryPosition: () => never }
    ).describeRegistryPosition = (): never => {
      throw new Error('position exploded');
    };
  });
}

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

  test('an auto-start still pending when its bulk startup rolls back is stopped too', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    c.start = (): Promise<void> =>
      sleep(5).then(() => {
        throw new Error('c failed');
      });
    const late = new Plain(logger, 'late', ['a']);
    late.start = (): Promise<void> => sleep(40);
    let lateStopCalls = 0;
    late.stop = (): Promise<void> => {
      lateStopCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(c);

    const registrations: Promise<unknown>[] = [];
    manager.once('component:started', () => {
      registrations.push(manager.registerComponent(late, { autoStart: true }));
    });

    const startup = await manager.startAllComponents();
    const [registration] = (await Promise.all(registrations)) as Array<{
      startResult?: { code?: string };
    }>;

    expect(startup.success).toBe(false);
    expect(registration.startResult?.code).toBe('startup_rolled_back');
    expect(manager.getRunningComponentNames()).toEqual([]);
    expect(lateStopCalls).toBe(1);
  });

  test('a start() promise with its own no-op then still fails the start promptly', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    Object.assign(a, { startupTimeoutMS: 2000 });
    a.start = (): Promise<void> => {
      const promise: object = Promise.reject(new Error('start failed'));
      Object.defineProperty(promise, 'then', { value: () => undefined });

      return promise as Promise<void>;
    };
    await manager.registerComponent(a);

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    const startedAt = Date.now();
    let result;

    try {
      result = await manager.startComponent('a');
      await sleep(10);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('start failed');
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(rejections).toEqual([]);
  });

  test('an async getValue handler answers error and its rejection is handled', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    (a as unknown as { getValue: () => Promise<never> }).getValue =
      (): Promise<never> => Promise.reject(new Error('x'));
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    let result;

    try {
      result = manager.getValue('a', 'k');
      await sleep(10);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(result.code).toBe('error');
    expect(rejections).toEqual([]);
  });

  test('a throwing options getter still records a stay-down request during a restart', async () => {
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

    const restart = manager.restartAllComponents();
    await sleep(5);

    const stop = await manager.stopAllComponents({
      get timeoutMS(): number {
        throw new Error('options exploded');
      },
    });
    stopGate.resolve();
    const result = await restart;

    expect(stop.code).toBe('already_in_progress');
    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(startCalls).toBe(1);
  });

  test('an unregister refused for a bulk operation does not call hasComponent()', async () => {
    const { logger, manager } = setup();
    const stopGate = deferred();
    const a = new Plain(logger, 'a');
    a.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(a);
    await manager.startAllComponents();

    const pass = manager.stopAllComponents();
    (manager as unknown as { hasComponent: () => never }).hasComponent =
      (): never => {
        throw new Error('hasComponent exploded');
      };

    const { release } = claimReports();

    try {
      const unregister = await manager.unregisterComponent('a');
      expect(unregister.code).toBe('bulk_operation_in_progress');
      expect(unregister.wasRegistered).toBe(true);
    } finally {
      stopGate.resolve();
      await pass;
      release();
    }
  });

  test('onMessage is read once and called as read', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    let reads = 0;
    Object.defineProperty(a, 'onMessage', {
      get: (): (() => string) | undefined => {
        reads++;
        return reads === 1 ? (): string => 'pong' : undefined;
      },
    });
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const result = await manager.sendMessageToComponent('a', 'ping');

    expect(result.code).toBe('sent');
    expect(result.data).toBe('pong');
  });

  test('an auto-start joining a bulk startup is held to its deadline', async () => {
    const { logger, manager } = setup();
    const b = new Plain(logger, 'b');
    b.start = (): Promise<void> => sleep(45);
    const late = new Plain(logger, 'late');
    late.start = (): Promise<void> => sleep(60);
    let lateStopCalls = 0;
    late.stop = (): Promise<void> => {
      lateStopCalls++;
      return Promise.resolve();
    };
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(b);

    const registrations: Promise<unknown>[] = [];
    manager.once('component:started', () => {
      registrations.push(manager.registerComponent(late, { autoStart: true }));
    });

    const startup = await manager.startAllComponents({ timeoutMS: 30 });
    const startedAtReturn = [...startup.startedComponents];
    await Promise.all(registrations);
    // Past `late`'s own start, so its late cleanup has run.
    await sleep(80);

    expect(startup.code).toBe('startup_timeout');
    // Timed out with the rest, and cleaned up when it finished late.
    expect(manager.isComponentRunning('late')).toBe(false);
    expect(lateStopCalls).toBe(1);
    expect(startup.startedComponents).toEqual(startedAtReturn);
  });

  test('a component that stops from its started listener does not get signals attached', async () => {
    const { logger, manager } = setup({
      attachSignalsOnStart: true,
      detachSignalsOnStop: true,
    });
    const signals = fakeSignals(manager);

    class Reporter extends Plain {
      public crash(): boolean {
        return this.reportUnexpectedStop(new Error('crashed'));
      }
    }

    const a = new Reporter(logger, 'a');
    await manager.registerComponent(a);
    manager.once('component:started', () => {
      a.crash();
    });

    await manager.startComponent('a');

    expect(manager.isComponentRunning('a')).toBe(false);
    expect(signals.isAttached()).toBe(false);
  });

  test('validateDependencies() does not throw for a component whose getters throw', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(hostile);
    await manager.registerComponent(new Plain(logger, 'a', ['missing']));
    hostile.getDependencies = (): never => {
      throw new Error('getDependencies exploded');
    };

    const { reports, release } = claimReports();
    let result;

    try {
      result = manager.validateDependencies();
    } finally {
      release();
    }

    expect(result.missingDependencies).toHaveLength(1);
    // Startup would fail on it, so the graph is not valid.
    expect(result.valid).toBe(false);
    expect(
      result.unreadableDependencies.map((entry) => entry.componentName),
    ).toEqual(['hostile']);
    expect(
      hasReport(reports, 'validateDependencies dependencies of hostile'),
    ).toBe(true);
  });

  test('an auto-start registered from signals-attached is left to the bulk startup', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };
    const y = new Plain(logger, 'y');
    let startCalls = 0;
    y.start = (): Promise<void> => {
      startCalls++;
      return sleep(10);
    };
    await manager.registerComponent(new Plain(logger, 'a'));

    const registrations: Promise<unknown>[] = [];
    const registeredEvents: Array<{ autoStartDeferred?: boolean }> = [];
    manager.on(
      'component:registered',
      (event: { name: string; autoStartDeferred?: boolean }) => {
        if (event.name === 'y') {
          registeredEvents.push(event);
        }
      },
    );
    manager.once('lifecycle-manager:signals-attached', () => {
      registrations.push(
        manager.insertComponentAt(y, 'start', undefined, { autoStart: true }),
      );
    });

    const startup = await manager.startAllComponents();
    const [registration] = (await Promise.all(registrations)) as Array<{
      autoStartAttempted?: boolean;
      autoStartDeferred?: boolean;
    }>;

    expect(registration.autoStartAttempted).toBe(false);
    expect(registration.autoStartDeferred).toBe(true);
    expect(registeredEvents[0]?.autoStartDeferred).toBe(true);
    expect(startup.success).toBe(true);
    expect(startCalls).toBe(1);
    expect(manager.isComponentRunning('y')).toBe(true);
  });

  test('healthCheck is read once and called as read', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    let reads = 0;
    Object.defineProperty(a, 'healthCheck', {
      get: (): (() => boolean) | undefined => {
        reads++;
        return reads === 1 ? (): boolean => true : undefined;
      },
    });
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const report = await manager.checkComponentHealth('a');

    expect(report.healthy).toBe(true);
    expect(report.code).not.toBe('error');
  });

  test('a getDependencies() returning undefined is read as none, not thrown on', async () => {
    const { logger, manager } = setup();
    const broken = new Plain(logger, 'broken');
    await manager.registerComponent(broken);
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    broken.getDependencies = (): string[] => undefined as unknown as string[];

    const { release } = claimReports();

    try {
      expect(() => manager.validateDependencies()).not.toThrow();
      expect((await manager.stopComponent('a')).success).toBe(true);
    } finally {
      release();
    }
  });

  test('a throwing healthCheck or onMessage getter still emits the failed event', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    await manager.startComponent('a');
    for (const hook of ['healthCheck', 'onMessage']) {
      Object.defineProperty(a, hook, {
        get: (): never => {
          throw new Error(`${hook} getter exploded`);
        },
      });
    }

    const failed: string[] = [];
    manager.on('component:health-check-started', () => {
      failed.push('health-started');
    });
    manager.on('component:health-check-failed', () => {
      failed.push('health');
    });
    manager.on('component:message-sent', () => {
      failed.push('message-sent');
    });
    manager.on('component:message-failed', () => {
      failed.push('message');
    });

    const { release } = claimReports();

    try {
      expect((await manager.checkComponentHealth('a')).code).toBe('error');
      expect((await manager.sendMessageToComponent('a', 'hi')).code).toBe(
        'error',
      );
    } finally {
      release();
    }

    // The health check is paired with its opening event. The message never went out,
    // so it has no `message-sent` - matching its `sent: false` result.
    expect(failed).toEqual(['health-started', 'health', 'message']);
  });

  test('a stop that settles just after its timeout is recorded as a late stop, not a permanent stall', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    let release: (() => void) | null = null;
    a.stop = (): Promise<void> =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    (a as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    // Released on a later timer than the timeout's own rejection.
    (
      a as unknown as { onGracefulStopTimeout: () => void }
    ).onGracefulStopTimeout = (): void => {
      setTimeout(() => release?.(), 1);
    };
    await manager.registerComponent(a);
    await manager.startComponent('a');

    await manager.stopComponent('a', { timeout: 10 });
    await sleep(20);

    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('dependencies with hostile array behaviour are copied inside the guard', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(hostile);
    await manager.startAllComponents();

    class HostileArray extends Array<string> {
      public override includes(): boolean {
        throw new Error('includes exploded');
      }
    }

    hostile.getDependencies = (): string[] => HostileArray.from(['a']);

    const { release } = claimReports();

    try {
      expect(() => manager.validateDependencies()).not.toThrow();
      // `hostile` depends on `a`, so stopping `a` is refused - not crashed.
      const stop = await manager.stopComponent('a');
      expect(stop.code).toBe('has_running_dependents');
    } finally {
      release();
    }
  });

  test('an auto-start does not join a bulk startup that is rolling back', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    const cStop = deferred();
    // `a` fails, so the startup rolls back `c` - slowly.
    c.stop = (): Promise<void> => cStop.promise;
    const a = new Plain(logger, 'a');
    a.start = (): Promise<void> => Promise.reject(new Error('a failed'));
    await manager.registerComponent(c);
    await manager.registerComponent(a);

    let lateStarts = 0;
    const late = new Plain(logger, 'late');
    late.start = (): Promise<void> => {
      lateStarts++;
      return Promise.resolve();
    };
    const registrations: Promise<unknown>[] = [];
    manager.once('component:startup-rollback', () => {
      registrations.push(manager.registerComponent(late, { autoStart: true }));
    });

    const startup = manager.startAllComponents();
    await sleep(10);
    cStop.resolve();
    await startup;
    const [registration] = (await Promise.all(registrations)) as Array<{
      startResult?: { code?: string };
    }>;

    expect(registration.startResult?.code).toBe('startup_rolled_back');
    expect(lateStarts).toBe(0);
  });

  test('a required dependency registered before the bulk loop begins is accepted', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };
    await manager.registerComponent(new Plain(logger, 'api', ['db']));

    const registrations: Promise<{ success: boolean }>[] = [];
    manager.once('lifecycle-manager:signals-attached', () => {
      registrations.push(manager.registerComponent(new Plain(logger, 'db')));
    });

    const startup = await manager.startAllComponents();
    const [registration] = await Promise.all(registrations);

    expect(registration.success).toBe(true);
    expect(startup.success).toBe(true);
    expect(manager.getRunningComponentNames().sort()).toEqual(['api', 'db']);
  });

  test('a stalled retry decides its token bump from the same read it calls', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const stopGate = deferred();
    a.stop = (): Promise<void> => stopGate.promise;
    (a as unknown as { onShutdownForce: undefined }).onShutdownForce =
      undefined;
    await manager.registerComponent(a);
    await manager.startComponent('a');

    const { release } = claimReports();

    try {
      await manager.stopComponent('a', { timeout: 10 });
      expect(manager.getComponentStatus('a')?.state).toBe('stalled');

      // A truthy non-function: no handler will run, so the retry must not bump the
      // token and orphan the floating `stop()`.
      (a as unknown as { onShutdownForce: unknown }).onShutdownForce = 'yes';
      await manager.stopAllComponents();

      stopGate.resolve();
      await sleep(10);
    } finally {
      release();
    }

    // The floating stop still cleared the stall.
    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('validateDependencies flags non-string dependency entries, and reads a throwing isOptional as required', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const b = new Plain(logger, 'b');
    await manager.registerComponent(a);
    await manager.registerComponent(b);
    a.getDependencies = (): string[] => ['b', undefined as unknown as string];
    b.isOptional = (): never => {
      throw new Error('isOptional exploded');
    };

    const { release } = claimReports();
    let result;

    try {
      result = manager.validateDependencies();
    } finally {
      release();
    }

    expect(result.valid).toBe(false);
    expect(
      result.unreadableDependencies.map((entry) => entry.componentName),
    ).toEqual(['a']);
    expect(result.summary.totalUnreadableDependencies).toBe(1);
  });

  test('a dependency list reporting an implausible length is rejected, not iterated', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(hostile);
    hostile.getDependencies = (): string[] =>
      new Proxy<string[]>([], {
        get: (target, property, receiver): unknown =>
          property === 'length'
            ? Number.POSITIVE_INFINITY
            : Reflect.get(target, property, receiver),
      });

    const { release } = claimReports();
    let result;

    try {
      result = manager.validateDependencies();
    } finally {
      release();
    }

    expect(result.valid).toBe(false);
    expect(result.unreadableDependencies[0]?.componentName).toBe('hostile');
  });

  test('a deferred auto-start whose startup is refused is warned about', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      attachSignalsBeforeStartup: true,
    });
    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };
    await manager.registerComponent(new Plain(logger, 'a'));

    const pending: Promise<unknown>[] = [];
    manager.once('lifecycle-manager:signals-attached', () => {
      pending.push(
        manager.registerComponent(new Plain(logger, 'late'), {
          autoStart: true,
        }),
      );
      pending.push(manager.stopAllComponents());
    });

    const startup = await manager.startAllComponents();
    await Promise.all(pending);

    expect(startup.code).toBe('shutdown_in_progress');
    expect(
      sink.logs.some((log) =>
        log.message.includes('deferred auto-starts were not attempted'),
      ),
    ).toBe(true);
  });

  test(
    'an infinite-length dependency list fails registration instead of hanging',
    async () => {
      const { logger, manager } = setup();
      const hostile = new Plain(logger, 'hostile');
      hostile.getDependencies = (): string[] =>
        new Proxy<string[]>([], {
          get: (target, property, receiver): unknown =>
            property === 'length'
              ? Number.POSITIVE_INFINITY
              : Reflect.get(target, property, receiver),
        });

      const { release } = claimReports();
      let registration;

      try {
        registration = await manager.registerComponent(hostile);
      } finally {
        release();
      }

      expect(registration.success).toBe(false);
      expect(registration.code).toBe('unknown_error');
    },
    { timeout: 2000 },
  );

  test('a throwing _clearUnexpectedStopHandler does not derail a stop', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    await manager.startComponent('a');
    a._clearUnexpectedStopHandler = (): never => {
      throw new Error('hook exploded');
    };

    const { release } = claimReports();
    let stop;

    try {
      stop = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(stop.success).toBe(true);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('a component with several unreadable getters is listed once', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    a.isOptional = (): never => {
      throw new Error('isOptional exploded');
    };
    a.getDependencies = (): never => {
      throw new Error('getDependencies exploded');
    };

    const { release } = claimReports();
    let result;

    try {
      result = manager.validateDependencies();
    } finally {
      release();
    }

    expect(result.unreadableDependencies).toHaveLength(1);
    expect(result.summary.totalUnreadableDependencies).toBe(1);
  });

  test('a broken getDependencies() is reported once, not on every read', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(hostile);
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    hostile.getDependencies = (): never => {
      throw new Error('getDependencies exploded');
    };

    const { reports, release } = claimReports();

    try {
      for (let index = 0; index < 3; index++) {
        await manager.stopComponent('a');
        await manager.startComponent('a');
      }
    } finally {
      release();
    }

    expect(
      reports.filter((report) =>
        (report as Error).message.includes('dependencies of hostile'),
      ),
    ).toHaveLength(1);
  });

  test('a signal handler is called with its component, not through its own bind', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const receivers: unknown[] = [];
    const onReload = function (this: unknown): void {
      receivers.push(this);
    };
    Object.defineProperty(onReload, 'bind', {
      value: (): (() => void) => () => {
        receivers.push('hijacked');
      },
    });
    (a as unknown as { onReload: () => void }).onReload = onReload;
    await manager.registerComponent(a);
    await manager.startComponent('a');

    await manager.triggerReload();

    expect(receivers).toEqual([a]);
  });

  test("one component's bad dependency entry does not break the startup or shutdown order", async () => {
    const { logger, manager } = setup();
    const stopOrder: string[] = [];
    const api = new Plain(logger, 'api', ['db']);
    api.stop = (): Promise<void> => {
      stopOrder.push('api');
      return Promise.resolve();
    };
    const db = new Plain(logger, 'db');
    db.stop = (): Promise<void> => {
      stopOrder.push('db');
      return Promise.resolve();
    };
    const broken = new Plain(logger, 'broken');
    Object.assign(broken, { optional: true });
    broken.getDependencies = (): string[] => [undefined as unknown as string];
    await manager.registerComponent(api);
    await manager.registerComponent(db);
    await manager.registerComponent(broken);

    const { release } = claimReports();

    try {
      const startup = await manager.startAllComponents();

      // The optional component fails its own start; the rest start in order.
      expect(startup.success).toBe(true);
      expect(startup.failedOptionalComponents.map((f) => f.name)).toEqual([
        'broken',
      ]);

      // An unrelated registration is unaffected.
      expect(
        (await manager.registerComponent(new Plain(logger, 'other'))).success,
      ).toBe(true);

      await manager.stopAllComponents();
    } finally {
      release();
    }

    expect(stopOrder).toEqual(['api', 'db']);
  });

  test('a dependency entry String() cannot render does not discard the valid ones', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(hostile);
    await manager.startAllComponents();
    hostile.getDependencies = (): string[] => [
      'a',
      Object.create(null) as string,
    ];

    const { release } = claimReports();

    try {
      // `a` is still known to have a running dependent.
      expect((await manager.stopComponent('a')).code).toBe(
        'has_running_dependents',
      );
    } finally {
      release();
    }
  });

  test('a re-registered instance has a broken dependency list reported again', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(hostile);
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    hostile.getDependencies = (): string[] => [7 as unknown as string];

    const { reports, release } = claimReports();

    try {
      await manager.stopComponent('a');
      await manager.stopComponent('hostile');
      await manager.unregisterComponent('hostile');
      await manager.registerComponent(hostile);
      await manager.startComponent('a');
      await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(
      reports.filter((report) =>
        (report as Error).message.includes('dependencies of hostile'),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  test('a broken own dependency list fails its start as missing_dependency, reported once', async () => {
    const { logger, manager } = setup();
    const broken = new Plain(logger, 'broken');
    await manager.registerComponent(broken);
    broken.getDependencies = (): string[] => undefined as unknown as string[];

    const { reports, release } = claimReports();

    try {
      for (let index = 0; index < 3; index++) {
        const result = await manager.startComponent('broken');
        expect(result.code).toBe('missing_dependency');
      }
    } finally {
      release();
    }

    expect(
      reports.filter((report) =>
        (report as Error).message.includes('dependencies of broken'),
      ),
    ).toHaveLength(1);
  });

  test('a running component whose dependency list broke answers already running', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    await manager.startComponent('a');
    a.getDependencies = (): never => {
      throw new Error('getDependencies exploded');
    };

    const { release } = claimReports();

    try {
      expect((await manager.startComponent('a')).code).toBe(
        'component_already_running',
      );
    } finally {
      release();
    }
  });

  test('a healthy dependency whose isOptional() throws does not fail the startup', async () => {
    const { logger, manager } = setup();
    const db = new Plain(logger, 'db');
    db.isOptional = (): never => {
      throw new Error('isOptional exploded');
    };
    await manager.registerComponent(db);
    await manager.registerComponent(new Plain(logger, 'api', ['db']));

    const { release } = claimReports();
    let startup;

    try {
      startup = await manager.startAllComponents();
    } finally {
      release();
    }

    expect(startup.success).toBe(true);
  });

  test('a registration candidate with a non-string dependency entry is reported', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    c.getDependencies = (): string[] => ['db', 42 as unknown as string];

    const { reports, release } = claimReports();

    try {
      expect((await manager.registerComponent(c)).success).toBe(true);
    } finally {
      release();
    }

    expect(hasReport(reports, 'registration dependencies of c')).toBe(true);
  });

  test('validateDependencies() reports a broken list once across calls', async () => {
    const { logger, manager } = setup();
    const hostile = new Plain(logger, 'hostile');
    await manager.registerComponent(hostile);
    hostile.getDependencies = (): never => {
      throw new Error('getDependencies exploded');
    };

    const { reports, release } = claimReports();

    try {
      for (let index = 0; index < 3; index++) {
        expect(manager.validateDependencies().valid).toBe(false);
      }
    } finally {
      release();
    }

    expect(
      reports.filter((report) =>
        (report as Error).message.includes('dependencies of hostile'),
      ),
    ).toHaveLength(1);
  });

  test('a start re-entered from its own getDependencies() runs start() once', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    let startCalls = 0;
    let hasReentered = false;
    let innerStart: Promise<unknown> | undefined;
    c.start = async (): Promise<void> => {
      startCalls++;
      await sleep(5);
    };
    await manager.registerComponent(c);
    c.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        innerStart = manager.startComponent('c');
      }

      return [];
    };

    const outer = await manager.startComponent('c');
    const inner = (await innerStart) as { success: boolean; code?: string };

    // Whichever claims first starts it; the other is refused as starting.
    expect(startCalls).toBe(1);
    expect([outer.success, inner.success].sort()).toEqual([false, true]);
    expect([outer.code, inner.code]).toContain('component_already_starting');
  });

  test('a start whose component was unregistered by its own getDependencies() is refused', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    let startCalls = 0;
    c.start = (): Promise<void> => {
      startCalls++;

      return Promise.resolve();
    };
    await manager.registerComponent(c);
    c.getDependencies = (): string[] => {
      void manager.unregisterComponent('c');

      return [];
    };

    const result = await manager.startComponent('c');

    expect(result.code).toBe('component_not_found');
    expect(startCalls).toBe(0);
  });

  test("a registration refused as a cycle does not spend the next registration's report", async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a', ['b']));
    const b = new Plain(logger, 'b');
    b.getDependencies = (): string[] => ['a', 5 as unknown as string];

    const { reports, release } = claimReports();

    const reportsOfB = (): number =>
      reports.filter((report) =>
        (report as Error).message.includes('dependencies of b'),
      ).length;

    try {
      expect((await manager.registerComponent(b)).code).toBe(
        'dependency_cycle',
      );
      expect(reportsOfB()).toBe(0);

      await manager.unregisterComponent('a');
      expect((await manager.registerComponent(b)).success).toBe(true);
      expect(reportsOfB()).toBe(1);
    } finally {
      release();
    }
  });

  test('validateDependencies() reads a throwing isOptional() as required, as startup does', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    a.isOptional = (): never => {
      throw new Error('isOptional exploded');
    };
    await manager.registerComponent(a);

    const { reports, release } = claimReports();
    let result;

    try {
      result = manager.validateDependencies();
      manager.validateDependencies();
    } finally {
      release();
    }

    expect(result.valid).toBe(true);
    expect(result.unreadableDependencies).toHaveLength(0);
    expect(
      reports.filter((report) =>
        (report as Error).message.includes('isOptional of a'),
      ),
    ).toHaveLength(1);
    expect((await manager.startAllComponents()).success).toBe(true);
  });

  test("allowNonRunningDependencies does not read a dependency's isOptional()", async () => {
    const { logger, manager } = setup();
    const db = new Plain(logger, 'db');
    let isOptionalCalls = 0;
    db.isOptional = (): boolean => {
      isOptionalCalls++;
      throw new Error('isOptional exploded');
    };
    await manager.registerComponent(db);
    await manager.registerComponent(new Plain(logger, 'api', ['db']));
    isOptionalCalls = 0;

    const { reports, release } = claimReports();

    try {
      const result = await manager.startComponent('api', {
        allowNonRunningDependencies: true,
      });
      expect(result.success).toBe(true);
    } finally {
      release();
    }

    expect(isOptionalCalls).toBe(0);
    expect(reports).toHaveLength(0);
  });

  test('a bulk startup reads each dependency list once, for its order, loop and start', async () => {
    const { logger, manager } = setup();
    const api = new Plain(logger, 'api');
    await manager.registerComponent(api);
    let reads = 0;
    api.getDependencies = (): string[] => {
      reads++;

      return [];
    };

    expect((await manager.startAllComponents()).success).toBe(true);
    // One read, shared by the startup order, the loop's skip check and the start.
    expect(reads).toBe(1);
  });

  test('a start reads each of its options once', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'c'));
    const reads: Record<string, number> = {};
    const options = {};

    for (const key of [
      'allowDuringBulkStartup',
      'forceStalled',
      'allowNonRunningDependencies',
    ]) {
      Object.defineProperty(options, key, {
        get: (): boolean => {
          reads[key] = (reads[key] ?? 0) + 1;

          return false;
        },
      });
    }

    expect((await manager.startComponent('c', options)).success).toBe(true);
    expect(Object.values(reads).every((count) => count <= 1)).toBe(true);
  });

  test('a start whose component was replaced by its own getDependencies() is refused', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    const replacement = new Plain(logger, 'c');
    let startCalls = 0;
    const countStart = (): Promise<void> => {
      startCalls++;

      return Promise.resolve();
    };
    c.start = countStart;
    replacement.start = countStart;
    await manager.registerComponent(c);
    c.getDependencies = (): string[] => {
      void manager.unregisterComponent('c');
      void manager.registerComponent(replacement);

      return [];
    };

    const result = await manager.startComponent('c');

    expect(manager.getComponentInstance('c')).toBe(replacement);
    expect(result.code).toBe('component_not_found');
    expect(startCalls).toBe(0);
  });

  test('a registration made from inside a dependency read does not corrupt the order', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    await manager.registerComponent(new Plain(logger, 'b', ['a']));
    let hasRegistered = false;
    a.getDependencies = (): string[] => {
      if (!hasRegistered) {
        hasRegistered = true;
        void manager.insertComponentAt(new Plain(logger, 'z'), 'start');
        void manager.registerComponent(new Plain(logger, 'y'));
      }

      return [];
    };

    const order = manager.getStartupOrder();

    expect(order.success).toBe(true);
    expect(order.startupOrder).toEqual(['a', 'b']);
  });

  test('a dependency that is stopping does not count as running for a start', async () => {
    const { logger, manager } = setup();
    const db = new Plain(logger, 'db');
    const stopGate = deferred();
    db.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(db);
    await manager.registerComponent(new Plain(logger, 'api', ['db']));
    await manager.startComponent('db');

    const stopping = manager.stopComponent('db');
    const result = await manager.startComponent('api');
    stopGate.resolve();
    await stopping;

    expect(result.code).toBe('dependency_not_running');
    expect(manager.isComponentRunning('api')).toBe(false);
  });

  test('a dependency stopped by a getter read before the claim blocks the start', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'db'));
    const api = new Plain(logger, 'api', ['db']);
    await manager.registerComponent(api);
    await manager.startComponent('db');
    let stopping: Promise<unknown> | undefined;
    Object.defineProperty(api, 'startupTimeoutMS', {
      get: (): number => {
        stopping ??= manager.stopComponent('db');

        return 1_000;
      },
    });

    const result = await manager.startComponent('api');
    await stopping;

    expect(result.code).toBe('dependency_not_running');
    expect(manager.isComponentRunning('api')).toBe(false);
  });

  test('a registration re-entered under the same name does not register it twice', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    let hasReentered = false;
    a.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void manager.registerComponent(new Plain(logger, 'x'));
      }

      return [];
    };

    const result = await manager.registerComponent(new Plain(logger, 'x'));

    expect(result.code).toBe('duplicate_name');
    expect(manager.getComponentNames()).toEqual(['a', 'x']);
  });

  test('an insert whose target is unregistered by a dependency read is refused', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    await manager.registerComponent(new Plain(logger, 'b'));
    let hasReentered = false;
    a.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void manager.unregisterComponent('b');
      }

      return [];
    };

    const result = await manager.insertComponentAt(
      new Plain(logger, 'c'),
      'before',
      'b',
    );

    expect(result.code).toBe('target_not_found');
    expect(manager.getComponentNames()).toEqual(['a']);
  });

  test('a registration survives lazy wiring that registers a helper when read', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    let isInside = false;
    let count = 0;
    a.getDependencies = (): string[] => {
      if (!isInside) {
        isInside = true;
        void manager.registerComponent(new Plain(logger, `extra-${count++}`));
        isInside = false;
      }

      return [];
    };

    const result = await manager.registerComponent(new Plain(logger, 'x'));

    expect(result.success).toBe(true);
    expect(manager.getComponentNames()).toContain('x');
  });

  test('a registry that every read keeps growing refuses the registration', async () => {
    const { logger, manager } = setup();
    let isInside = false;
    let count = 0;

    // Each link's read registers the next link, whose read registers the next.
    class Link extends Plain {
      public override getDependencies(): string[] {
        if (!isInside) {
          isInside = true;
          void manager.registerComponent(new Link(logger, `link-${count++}`));
          isInside = false;
        }

        return [];
      }
    }

    isInside = true;
    await manager.registerComponent(new Link(logger, 'first'));
    isInside = false;

    const { reports, release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(new Plain(logger, 'x'));
    } finally {
      release();
    }

    expect(result.code).toBe('unknown_error');
    expect(result.reason).toContain('kept changing');
    expect(manager.getComponentNames()).not.toContain('x');
    expect(hasReport(reports, 'lifecycle-manager registerComponent')).toBe(
      true,
    );
  });

  test('a registration refuses once a shutdown begins during its dependency reads', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    let shutdown: Promise<unknown> | undefined;
    a.getDependencies = (): string[] => {
      shutdown ??= manager.stopAllComponents();

      return [];
    };

    const result = await manager.registerComponent(new Plain(logger, 'x'));
    await shutdown;

    expect(result.code).toBe('shutdown_in_progress');
    expect(manager.getComponentNames()).toEqual(['a']);
  });

  test('a cycle found against a registry that moved is checked again', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a', ['x']);
    await manager.registerComponent(a);
    let hasReentered = false;
    a.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void manager.unregisterComponent('a');
      }

      return ['x'];
    };

    // `a` depends on `x` and `x` on `a` - a cycle, until `a` is gone.
    const result = await manager.registerComponent(
      new Plain(logger, 'x', ['a']),
    );

    expect(result.success).toBe(true);
    expect(manager.getComponentNames()).toEqual(['x']);
  });

  test('an optional answer does not carry over to an instance that replaced it', async () => {
    const { logger, manager } = setup();
    const optionalCache = new Plain(logger, 'cache');
    optionalCache.isOptional = (): boolean => true;
    await manager.registerComponent(optionalCache);
    const api = new Plain(logger, 'api', ['cache']);
    await manager.registerComponent(api);
    let hasSwapped = false;
    Object.defineProperty(api, 'startupTimeoutMS', {
      get: (): number => {
        // Swapped for a required instance under the same name, after the optional
        // one's answer was read.
        if (!hasSwapped) {
          hasSwapped = true;
          void manager.unregisterComponent('cache');
          void manager.registerComponent(new Plain(logger, 'cache'));
        }

        return 1_000;
      },
    });

    const result = await manager.startComponent('api');

    expect(result.code).toBe('dependency_not_running');
    expect(manager.isComponentRunning('api')).toBe(false);
  });

  test('validateDependencies() checks the registry as it is once its reads settle', async () => {
    const { logger, manager } = setup();
    const x = new Plain(logger, 'x');
    await manager.registerComponent(x);
    await manager.registerComponent(new Plain(logger, 'db'));
    await manager.registerComponent(new Plain(logger, 'api', ['db']));
    let hasReentered = false;
    x.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void manager.unregisterComponent('db');
      }

      return [];
    };

    const result = manager.validateDependencies();

    expect(manager.getComponentNames()).toEqual(['x', 'api']);
    expect(result.valid).toBe(false);
    expect(result.missingDependencies).toEqual([
      {
        componentName: 'api',
        componentIsOptional: false,
        missingDependency: 'db',
      },
    ]);
  });

  test('a registration made while dependents are listed does not list one twice', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a', ['db']);
    await manager.registerComponent(new Plain(logger, 'db'));
    await manager.registerComponent(a);
    let hasReentered = false;
    a.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void manager.insertComponentAt(new Plain(logger, 'z'), 'start');
      }

      return ['db'];
    };

    const dependents = (
      manager as unknown as { getDependents: (name: string) => string[] }
    ).getDependents('db');

    expect(dependents).toEqual(['a']);
  });

  test('a throwing _isRegisteredWithManager() still emits registration-rejected', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    c._isRegisteredWithManager = (): never => {
      throw new Error('isRegistered exploded');
    };
    const rejected: unknown[] = [];
    manager.on('component:registration-rejected', (event) => {
      rejected.push(event);
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(c);
    } finally {
      release();
    }

    expect(result.code).toBe('unknown_error');
    expect(rejected).toHaveLength(1);
  });

  test('a component registered by _isRegisteredWithManager() is checked with the rest', async () => {
    const { logger, manager } = setup();
    const trigger = new Plain(logger, 'trigger');
    const db = new Plain(logger, 'db');
    let registration: Promise<{ code?: string }> | undefined;
    db._isRegisteredWithManager = (): boolean => {
      // Registers a component that requires `db`, mid-startup.
      void manager.registerComponent(new Plain(logger, 'api', ['db']));

      return false;
    };
    trigger.start = (): Promise<void> => {
      registration = manager.registerComponent(db);

      return Promise.resolve();
    };
    await manager.registerComponent(trigger);

    await manager.startAllComponents();
    const result = await registration;

    expect(result?.code).toBe('startup_in_progress');
  });

  test("a registration refused during a shutdown reads no component's list for its checks", async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const stopGate = deferred();
    a.stop = (): Promise<void> => stopGate.promise;
    await manager.registerComponent(a);
    await manager.startAllComponents();
    let registeredReads = 0;
    a.getDependencies = (): string[] => {
      registeredReads++;

      return [];
    };
    let candidateReads = 0;
    const candidate = new Plain(logger, 'x');
    candidate.getDependencies = (): string[] => {
      candidateReads++;

      return [];
    };

    const shutdown = manager.stopAllComponents();
    // Only the registration's reads: the shutdown pass reads lists to order its stops.
    registeredReads = 0;
    const result = await manager.registerComponent(candidate);
    stopGate.resolve();
    await shutdown;

    expect(result.code).toBe('shutdown_in_progress');
    expect(candidateReads).toBe(0);
    // One read, for the startup order the refusal result reports - not a snapshot too.
    expect(registeredReads).toBe(1);
  });

  test('an instance registered with another manager by its own read is refused', async () => {
    const { logger, manager } = setup();
    const other = setup().manager;
    const c = new Plain(logger, 'c');
    let hasReentered = false;
    c.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void other.registerComponent(c);
      }

      return [];
    };

    const result = await manager.registerComponent(c);

    expect(result.code).toBe('duplicate_instance');
    expect(manager.getComponentNames()).toEqual([]);
  });

  test('a list that answers differently per read cannot split the order from the start', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(new Plain(logger, 'b'));
    const c = new Plain(logger, 'c');
    // First in the registry, so the order puts it right after its first answer.
    await manager.insertComponentAt(c, 'start');
    let reads = 0;
    c.getDependencies = (): string[] => (reads++ === 0 ? ['a'] : ['b']);

    expect((await manager.startAllComponents()).success).toBe(true);
  });

  test('a message handler that times out emits message-failed', async () => {
    const { logger, manager } = setup({ messageTimeoutMS: 20 });
    const c = new Plain(logger, 'c');
    (c as unknown as { onMessage: () => Promise<void> }).onMessage = () =>
      new Promise<void>(() => {});
    await manager.registerComponent(c);
    await manager.startComponent('c');
    const failures: unknown[] = [];
    manager.on('component:message-failed', (event: unknown) => {
      failures.push(event);
    });

    const result = await manager.sendMessageToComponent('c', 'ping');

    expect(result.code).toBe('timeout');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ timedOut: true, code: 'timeout' });
  });

  test('a failure after the commit reports the auto-start that ran', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    let startCalls = 0;
    c.start = (): Promise<void> => {
      startCalls++;

      return Promise.resolve();
    };
    crashFirstRegisteredEvent(manager);

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(c, { autoStart: true });
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(startCalls).toBe(1);
    expect(result.registered).toBe(true);
    expect(result.autoStartAttempted).toBe(true);
    expect(result.autoStartSucceeded).toBe(true);
  });

  test('a failure after the commit of an insert reports where it landed', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.registerComponent(new Plain(logger, 'b'));
    const events: Array<{ name: string; targetFound?: boolean }> = [];
    manager.on(
      'component:registered',
      (event: { name: string; targetFound?: boolean }) => {
        events.push(event);
      },
    );
    crashFirstRegisteredEvent(manager);

    const { release } = claimReports();
    let result;

    try {
      result = await manager.insertComponentAt(
        new Plain(logger, 'c'),
        'after',
        'a',
      );
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.registered).toBe(true);
    expect(result.targetFound).toBe(true);
    expect(result.manualPositionRespected).toBe(true);
    expect(result.actualPosition?.index).toBe(1);
    expect(events.find((event) => event.name === 'c')?.targetFound).toBe(true);
  });

  test('a failure after the commit reports an auto-start left to the bulk startup', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };
    await manager.registerComponent(new Plain(logger, 'a'));
    const events: Array<{ name: string; autoStartDeferred?: boolean }> = [];
    manager.on(
      'component:registered',
      (event: { name: string; autoStartDeferred?: boolean }) => {
        events.push(event);
      },
    );
    let registration: Promise<{ autoStartDeferred?: boolean }> | undefined;
    manager.once('lifecycle-manager:signals-attached', () => {
      crashFirstRegisteredEvent(manager);
      registration = manager.insertComponentAt(
        new Plain(logger, 'y'),
        'start',
        undefined,
        { autoStart: true },
      );
    });

    const { release } = claimReports();

    try {
      await manager.startAllComponents();
      expect((await registration)?.autoStartDeferred).toBe(true);
    } finally {
      release();
    }

    expect(events.find((event) => event.name === 'y')?.autoStartDeferred).toBe(
      true,
    );
  });

  test('a bulk startup stops reading lists once a read begins a shutdown', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const b = new Plain(logger, 'b');
    await manager.registerComponent(a);
    await manager.registerComponent(b);
    let shutdown: Promise<unknown> | undefined;
    let isArmed = false;
    a.getDependencies = (): string[] => {
      if (isArmed) {
        isArmed = false;
        shutdown = manager.stopAllComponents();
      }

      return [];
    };
    let startupReadsOfB = 0;
    b.getDependencies = (): string[] => {
      if (new Error().stack?.includes('startAllComponents') === true) {
        startupReadsOfB++;
      }

      return [];
    };

    isArmed = true;
    const startup = await manager.startAllComponents();
    await shutdown;

    expect(startup.code).toBe('shutdown_in_progress');
    expect(startupReadsOfB).toBe(0);
  });

  test('an instance registered elsewhere by a list read after its last answer is refused', async () => {
    const { logger, manager } = setup();
    const other = setup().manager;
    // A list to read, so the instance is asked again once the reads settle.
    await manager.registerComponent(new Plain(logger, 'seed'));
    let hasFired = false;
    const helper = new Plain(logger, 'helper');
    let calls = 0;

    class Candidate extends Plain {
      public override _isRegisteredWithManager(): boolean {
        // The second answer registers a helper, whose list is read after it.
        if (calls++ === 1) {
          void manager.registerComponent(helper);
        }

        return super._isRegisteredWithManager();
      }
    }

    const candidate = new Candidate(logger, 'candidate');
    helper.getDependencies = (): string[] => {
      // Once the helper is registered: its read registers the candidate elsewhere.
      if (!hasFired && manager.getComponentNames().includes('helper')) {
        hasFired = true;
        void other.registerComponent(candidate);
      }

      return [];
    };

    const result = await manager.registerComponent(candidate);

    expect(hasFired).toBe(true);
    expect(result.code).toBe('duplicate_instance');
    expect(manager.getComponentNames()).not.toContain('candidate');
  });

  test('registration stops reading lists once a read begins a shutdown', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const b = new Plain(logger, 'b');
    await manager.registerComponent(a);
    await manager.registerComponent(b);
    await manager.startAllComponents();
    let shutdown: Promise<unknown> | undefined;
    a.getDependencies = (): string[] => {
      if (new Error().stack?.includes('readRegistry') === true) {
        shutdown ??= manager.stopAllComponents();
      }

      return [];
    };
    let registrationReadsOfB = 0;
    b.getDependencies = (): string[] => {
      if (new Error().stack?.includes('readRegistry') === true) {
        registrationReadsOfB++;
      }

      return [];
    };

    const result = await manager.registerComponent(new Plain(logger, 'x'));
    await shutdown;

    expect(result.code).toBe('shutdown_in_progress');
    expect(registrationReadsOfB).toBe(0);
  });

  test('a component auto-started by a list read during a bulk startup does not fail it', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    let registration: Promise<{ success: boolean }> | undefined;
    let hasRegistered = false;
    a.getDependencies = (): string[] => {
      // Flagged before the call: the registration reads this list too.
      if (!hasRegistered) {
        hasRegistered = true;
        registration = manager.registerComponent(new Plain(logger, 'helper'), {
          autoStart: true,
        });
      }

      return [];
    };

    const startup = await manager.startAllComponents();

    expect(startup.success).toBe(true);
    expect((await registration)?.success).toBe(true);
    expect(manager.isComponentRunning('helper')).toBe(true);
  });

  test('a successful registration reports where it is after its auto-start', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    c.start = async (): Promise<void> => {
      await manager.insertComponentAt(new Plain(logger, 'other'), 'start');
    };

    const result = await manager.insertComponentAt(c, 'end', undefined, {
      autoStart: true,
    });

    expect(result.success).toBe(true);
    expect(manager.getComponentNames()).toEqual(['other', 'c']);
    expect(result.registrationIndexAfter).toBe(1);
    expect(result.actualPosition).toEqual({
      index: 1,
      description: 'at end, after other',
    });
  });

  test('a failure after the commit describes the position as it is then', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    c.start = async (): Promise<void> => {
      await manager.registerComponent(new Plain(logger, 'b'));
    };
    crashFirstRegisteredEvent(manager, 'c');

    const { release } = claimReports();
    let result;

    try {
      result = await manager.insertComponentAt(c, 'end', undefined, {
        autoStart: true,
      });
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.actualPosition).toEqual({
      index: 0,
      description: 'at start, before b',
    });
  });

  test('registration asks the instance once when nothing was read', async () => {
    const { logger, manager } = setup();
    let calls = 0;

    class Counted extends Plain {
      public override _isRegisteredWithManager(): boolean {
        calls++;

        return super._isRegisteredWithManager();
      }
    }

    expect(
      (await manager.registerComponent(new Counted(logger, 'c'))).success,
    ).toBe(true);
    expect(calls).toBe(1);
  });

  test('the last startup read beginning a shutdown warns about deferred auto-starts', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      attachSignalsBeforeStartup: true,
    });
    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    let shutdown: Promise<unknown> | undefined;
    let isArmed = false;
    // `late` is registered at the start, so `a` - the last read - begins the shutdown.
    a.getDependencies = (): string[] => {
      if (
        isArmed &&
        new Error().stack?.includes('startAllComponents') === true
      ) {
        isArmed = false;
        shutdown = manager.stopAllComponents();
      }

      return [];
    };
    const pending: Promise<unknown>[] = [];
    manager.once('lifecycle-manager:signals-attached', () => {
      pending.push(
        manager.insertComponentAt(
          new Plain(logger, 'late'),
          'start',
          undefined,
          {
            autoStart: true,
          },
        ),
      );
      isArmed = true;
    });

    const startup = await manager.startAllComponents();
    await Promise.all(pending);
    await shutdown;

    expect(startup.code).toBe('shutdown_in_progress');
    expect(
      sink.logs.some((log) =>
        log.message.includes('deferred auto-starts were not attempted'),
      ),
    ).toBe(true);
  });

  test('a registration that fails before its own commit does not claim a re-entrant one', async () => {
    const { logger, manager } = setup();
    let calls = 0;

    class Candidate extends Plain {
      public override _isRegisteredWithManager(): boolean {
        // The outer registration's ask, after the inner one committed.
        if (++calls === 2) {
          throw new Error('isRegistered exploded');
        }

        return super._isRegisteredWithManager();
      }
    }

    const c = new Candidate(logger, 'c');
    let hasReentered = false;
    c.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void manager.registerComponent(c);
      }

      return [];
    };
    const registered: unknown[] = [];
    manager.on('component:registered', (event: { name: string }) => {
      if (event.name === 'c') {
        registered.push(event);
      }
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(c);
    } finally {
      release();
    }

    expect(manager.getComponentNames()).toEqual(['c']);
    expect(result.success).toBe(false);
    expect(result.registered).toBe(false);
    expect(registered).toHaveLength(1);
  });

  test('a failure right after the commit still reports the order it computed', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    (
      manager as unknown as { isManualPositionRespected: () => never }
    ).isManualPositionRespected = (): never => {
      throw new Error('crash after commit');
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(new Plain(logger, 'c', ['a']));
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.registered).toBe(true);
    expect(result.startupOrder).toEqual(['a', 'c']);
  });

  test('components registered by the startup order reads are ordered and started', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    await manager.registerComponent(a);
    let hasRegistered = false;
    a.getDependencies = (): string[] => {
      if (
        !hasRegistered &&
        new Error().stack?.includes('startAllComponents') === true
      ) {
        hasRegistered = true;
        void manager.registerComponent(new Plain(logger, 'auto', ['a']), {
          autoStart: true,
        });
        void manager.registerComponent(new Plain(logger, 'plain', ['a']));
      }

      return [];
    };

    const startup = await manager.startAllComponents();

    expect(startup.success).toBe(true);
    expect(startup.startedComponents).toEqual(['a', 'auto', 'plain']);
    expect(manager.isComponentRunning('auto')).toBe(true);
    expect(manager.isComponentRunning('plain')).toBe(true);
  });

  test('a successful registration reports its own instance, not one under its name', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'c');
    const replacement = new Plain(logger, 'c');
    // Stands in for the component being unregistered and another registered under its
    // name while its auto-start finished - which a real unregister cannot do mid-start.
    manager.once('component:started', () => {
      (manager as unknown as { components: Plain[] }).components = [
        replacement,
      ];
    });

    const result = await manager.insertComponentAt(c, 'end', undefined, {
      autoStart: true,
    });

    expect(result.success).toBe(true);
    expect(result.registrationIndexAfter).toBeNull();
    expect(result.actualPosition).toBeUndefined();
  });

  test('the safety net answers registered as the registration would', async () => {
    const { logger, manager } = setup();
    let calls = 0;

    class Candidate extends Plain {
      public override _isRegisteredWithManager(): boolean {
        // The outer registration's ask, after the inner one committed.
        if (++calls === 2) {
          throw new Error('isRegistered exploded');
        }

        return super._isRegisteredWithManager();
      }
    }

    const c = new Candidate(logger, 'c');
    let hasReentered = false;
    c.getDependencies = (): string[] => {
      if (!hasReentered) {
        hasReentered = true;
        void manager.registerComponent(c);
      }

      return [];
    };
    // The outer call's rejection event throws, past its own catch, into the net.
    const events = (
      manager as unknown as {
        lifecycleEvents: { componentRegistrationRejected: () => void };
      }
    ).lifecycleEvents;
    events.componentRegistrationRejected = (): void => {
      throw new Error('rejection event exploded');
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(c);
    } finally {
      release();
    }

    expect(manager.getComponentNames()).toEqual(['c']);
    expect(result.code).toBe('unknown_error');
    expect(result.registered).toBe(false);
    expect(result.registrationIndexAfter).toBeNull();
  });

  test('a failure after an auto-start reports it, though reporting hits a failure too', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    breakCatchAfterAutoStart(manager);

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(new Plain(logger, 'c'), {
        autoStart: true,
      });
    } finally {
      release();
    }

    expect(manager.isComponentRunning('c')).toBe(true);
    expect(result.success).toBe(false);
    // The failure that broke the registration, not the one met reporting it.
    expect(result.error?.message).toBe('position exploded');
    // The failure that broke the registration, answered by its own guarded catch -
    // the position read failing there too is contained, not a second failure.
    expect(result.reason).toBe('position exploded');
    expect(result.registered).toBe(true);
    expect(result.autoStartAttempted).toBe(true);
    expect(result.autoStartSucceeded).toBe(true);
    expect(result.startResult?.success).toBe(true);
  });

  test('a failure after the commit announces the registration and reports what it computed', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    const registered: Array<{ name: string; targetFound?: boolean }> = [];
    manager.on(
      'component:registered',
      (event: { name: string; targetFound?: boolean }) => {
        registered.push(event);
      },
    );
    breakCatchAfterAutoStart(manager);

    const { release } = claimReports();
    let result;

    try {
      result = await manager.insertComponentAt(
        new Plain(logger, 'c'),
        'after',
        'a',
        { autoStart: true },
      );
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.registered).toBe(true);
    expect(result.startupOrder).toEqual(['a', 'c']);
    expect(result.targetFound).toBe(true);
    expect(result.manualPositionRespected).toBe(true);
    expect(result.registrationIndexAfter).toBe(1);
    expect(registered.filter((event) => event.name === 'c')).toHaveLength(1);
    expect(registered.find((event) => event.name === 'c')?.targetFound).toBe(
      true,
    );
  });

  test('a slow auto-start that joined a bulk startup reports it, though it outlasted it', async () => {
    const { logger, manager } = setup();
    const a = new Plain(logger, 'a');
    const late = new Plain(logger, 'late');
    late.start = (): Promise<void> => sleep(30);
    let registration:
      Promise<{ duringStartup?: boolean; success: boolean }> | undefined;
    const events: Array<{ name: string; duringStartup?: boolean }> = [];
    manager.on(
      'component:registered',
      (event: { name: string; duringStartup?: boolean }) => {
        events.push(event);
      },
    );
    // Registered from inside the bulk loop, whose auto-start joins the startup - which
    // does not wait for it, and returns first.
    a.start = (): Promise<void> => {
      registration = manager.registerComponent(late, { autoStart: true });

      return Promise.resolve();
    };
    await manager.registerComponent(a);

    expect((await manager.startAllComponents()).success).toBe(true);

    const result = await registration;

    expect(result?.success).toBe(true);
    expect(result?.duringStartup).toBe(true);
    expect(events.find((event) => event.name === 'late')?.duringStartup).toBe(
      true,
    );
  });

  test.each([
    ['answering a non-string', (): string => 42 as unknown as string],
    [
      'that throws',
      (): string => {
        throw new Error('getName exploded');
      },
    ],
  ] as const)(
    'a getName() %s is announced as a rejection',
    async (_label, getName) => {
      const { logger, manager } = setup();
      const c = new Plain(logger, 'c');
      c.getName = getName;
      const rejected: unknown[] = [];
      manager.on('component:registration-rejected', (event: unknown) => {
        rejected.push(event);
      });

      const { release } = claimReports();
      let result;

      try {
        result = await manager.registerComponent(c);
      } finally {
        release();
      }

      expect(result.code).toBe('unknown_error');
      expect(rejected).toHaveLength(1);
    },
  );

  test('a re-registered instance whose getName() now fails is not named by its old name', async () => {
    const { logger, manager } = setup();
    const c = new Plain(logger, 'db');
    await manager.registerComponent(c);
    await manager.unregisterComponent('db');
    let calls = 0;
    c.getName = (): string => {
      calls++;
      throw new Error('getName exploded');
    };
    const rejected: Array<{ name: string }> = [];
    manager.on('component:registration-rejected', (event: { name: string }) => {
      rejected.push(event);
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(c);
    } finally {
      release();
    }

    expect(result.componentName).toBe('<unknown>');
    expect(rejected.map((event) => event.name)).toEqual(['<unknown>']);
    // Asked once - the failure is not answered by running it again.
    expect(calls).toBe(1);
  });

  test('a deferred auto-start left by a failed signal attach is warned about', async () => {
    const sink = new ArraySink();
    const logger = new Logger({ sinks: [sink], callProcessExit: false });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      attachSignalsBeforeStartup: true,
    });
    await manager.registerComponent(new Plain(logger, 'a'));
    let registration: Promise<{ autoStartDeferred?: boolean }> | undefined;
    // The attach's failure is where caller code runs - a sink, here the stub itself -
    // and registers an auto-start the startup will never reach.
    manager.attachSignals = (): void => {
      registration = manager.registerComponent(new Plain(logger, 'late'), {
        autoStart: true,
      });
      throw new Error('attach failed');
    };

    const { release } = claimReports();
    let startup;

    try {
      startup = await manager.startAllComponents();
    } finally {
      release();
    }

    expect(startup.code).toBe('signal_attach_failed');
    expect((await registration)?.autoStartDeferred).toBe(true);
    expect(
      sink.logs.some((log) =>
        log.message.includes('deferred auto-starts were not attempted'),
      ),
    ).toBe(true);
  });
});
