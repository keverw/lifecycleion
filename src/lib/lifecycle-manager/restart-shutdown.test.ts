import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import type { RestartResult, ShutdownResult } from './types';
import { sleep } from '../sleep';

function setup(shutdownTimeoutMS?: number) {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  return {
    logger,
    manager: new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      ...(shutdownTimeoutMS === undefined
        ? {}
        : { shutdownOptions: { timeoutMS: shutdownTimeoutMS } }),
    }),
  };
}

// Resolves when the next shutdown pass settles. Subscribe before triggering: waiting
// on the event rather than sleeping keeps these tests off wall-clock margins.
function shutdownCompleted(manager: LifecycleManager): Promise<void> {
  return new Promise<void>((resolve) => {
    manager.once('lifecycle-manager:shutdown-completed', () => {
      resolve();
    });
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

// Sends a signal down the same private entry point the OS handlers use.
function sendSignal(manager: LifecycleManager, method: string): void {
  (
    manager as unknown as {
      handleShutdownRequest: (method: string) => void;
    }
  ).handleShutdownRequest(method);
}

/**
 * Parks inside stop() until released, so a test can act with the restart held in its
 * stop phase instead of racing a timer.
 */
class GatedStop extends BaseComponent {
  public startCount = 0;
  public readonly stopping = deferred();
  private readonly gate = deferred();

  constructor(logger: Logger, name: string) {
    super(logger, { name, dependencies: [] });
  }

  public start(): Promise<void> {
    this.startCount++;
    return Promise.resolve();
  }

  public async stop(): Promise<void> {
    this.stopping.resolve();
    await this.gate.promise;
  }

  public releaseStop(): void {
    this.gate.resolve();
  }
}

/** Same idea for the startup phase: start() parks until released. */
class GatedStart extends BaseComponent {
  public startCount = 0;
  public starting = deferred();
  private gate = deferred();

  constructor(logger: Logger, name: string) {
    super(logger, { name, dependencies: [] });
  }

  public async start(): Promise<void> {
    this.startCount++;
    this.starting.resolve();
    await this.gate.promise;
  }

  public async stop(): Promise<void> {}

  /** Arms a fresh gate so the next start parks again. */
  public rearm(): void {
    this.starting = deferred();
    this.gate = deferred();
  }

  public releaseStart(): void {
    this.gate.resolve();
  }
}

describe('LifecycleManager - shutdown during restartAllComponents()', () => {
  test('a manual request during the stop phase cancels the startup phase', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();
    expect(component.startCount).toBe(1);

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    // The restart's own stop phase is the shutdown this caller gets, so the request is
    // still refused - what changes is that the restart no longer starts everything back up.
    const ack = await manager.stopAllComponents();
    expect(ack.success).toBe(false);
    expect(ack.code).toBe('already_in_progress');

    component.releaseStop();
    const result = await restart;

    expect(result.shutdownResult.success).toBe(true);
    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(result.startupResult.success).toBe(false);
    expect(result.startupResult.code).toBe('shutdown_requested_during_restart');
    expect(result.startupResult.startedComponents).toEqual([]);
    expect(result.success).toBe(false);

    // The point of the fix: the component the operator asked to stop stays stopped.
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);
    expect(manager.getComponentStatus('gated')?.state).toBe('stopped');
  });

  test('a signal during the stop phase cancels the startup phase', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const signals: unknown[] = [];
    manager.on('signal:shutdown', (payload) => {
      signals.push(payload);
    });

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    sendSignal(manager, 'SIGTERM');

    component.releaseStop();
    const result = await restart;

    // Signal bookkeeping is untouched: still emitted exactly once, still marked as
    // landing on a shutdown that was already running.
    expect(signals.length).toBe(1);
    expect(signals[0]).toEqual({
      method: 'SIGTERM',
      isAlreadyShuttingDown: true,
    });

    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(result.startupResult.code).toBe('shutdown_requested_during_restart');
    expect(result.success).toBe(false);
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);
  });

  test('a repeat signal during the stop phase counts toward escalation', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    let forceShutdownCalls = 0;
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 5000,
        onForceShutdown: (): void => {
          forceShutdownCalls++;
        },
      },
    });

    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    // The first signal is the operator's initial request - it cancels the restart and
    // seeds the cycle, uncounted. A repeat is a press like any other.
    sendSignal(manager, 'SIGTERM');
    expect(forceShutdownCalls).toBe(0);

    sendSignal(manager, 'SIGTERM');
    expect(forceShutdownCalls).toBe(1);

    component.releaseStop();
    const result = await restart;

    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(component.startCount).toBe(1);
  });

  test('stopAllComponents() during the stop phase cancels the startup phase', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    const stopResult = manager.stopAllComponents();

    component.releaseStop();
    const [result, stop] = await Promise.all([restart, stopResult]);

    // Refused as before - it expresses the same intent, so it cancels the startup too.
    expect(stop.code).toBe('already_in_progress');
    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(component.startCount).toBe(1);
  });

  test('a failed stop phase plus a request still skips startup', async () => {
    // Short global timeout so the stalled pass settles inside the test.
    const { logger, manager } = setup(100);

    class Hanging extends BaseComponent {
      public startCount = 0;
      public readonly stopping = deferred();
      public start(): Promise<void> {
        this.startCount++;
        return Promise.resolve();
      }
      public stop(): Promise<void> {
        this.stopping.resolve();
        return new Promise<void>(() => {});
      }
      public onShutdownForce(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }

    const component = new Hanging(logger, {
      name: 'hanging',
      dependencies: [],
    });
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    const ack = await manager.stopAllComponents();
    expect(ack.code).toBe('already_in_progress');

    const result = await restart;

    // The stop phase failed, and startup would have refused on stalled components
    // anyway. The recorded request is the stronger statement, so it is what gets reported.
    expect(result.shutdownResult.success).toBe(false);
    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(result.startupResult.code).toBe('shutdown_requested_during_restart');
    expect(result.startupResult.blockedByStalledComponents).toBeUndefined();
    expect(result.success).toBe(false);
    expect(component.startCount).toBe(1);
  });

  test('a restart with no shutdown request behaves as before', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const restart = manager.restartAllComponents();
    await component.stopping.promise;
    component.releaseStop();

    const result = await restart;

    expect(result.success).toBe(true);
    expect(result.startupSkippedByShutdownRequest).toBeUndefined();
    expect(result.shutdownResult.success).toBe(true);
    expect(result.startupResult.success).toBe(true);
    expect(result.startupResult.startedComponents).toEqual(['gated']);
    expect(component.startCount).toBe(2);
    expect(manager.isComponentRunning('gated')).toBe(true);
  });

  test('a request during the startup phase aborts that startup', async () => {
    const { logger, manager } = setup();

    class Plain extends BaseComponent {
      public startCount = 0;
      public start(): Promise<void> {
        this.startCount++;
        return Promise.resolve();
      }
      public async stop(): Promise<void> {}
    }

    const first = new GatedStart(logger, 'first');
    const second = new Plain(logger, {
      name: 'second',
      dependencies: ['first'],
    });
    await manager.registerComponent(first);
    await manager.registerComponent(second);

    const initial = manager.startAllComponents();
    await first.starting.promise;
    first.releaseStart();
    await initial;
    expect(second.startCount).toBe(1);

    first.rearm();
    const restart = manager.restartAllComponents();

    // Park inside the restart's startup phase: the stop phase is long over, so
    // `isShuttingDown` is false and the request starts a real pass of its own.
    await first.starting.promise;

    // Started without awaiting: this pass has to wait on the start parked below.
    const done = shutdownCompleted(manager);
    const pending = manager.stopAllComponents();

    first.releaseStart();
    const result = await restart;
    await done;
    expect((await pending).code).not.toBe('already_in_progress');

    // Nothing was recorded during the stop phase - this case belongs to
    // `startAllComponents()`, which aborts the pass through `shutdownToken`.
    expect(result.startupSkippedByShutdownRequest).toBeUndefined();
    expect(result.startupResult.success).toBe(false);
    expect(result.startupResult.code).toBe('shutdown_in_progress');
    expect(result.success).toBe(false);

    // The dependent never started, and nothing is left running.
    expect(second.startCount).toBe(1);
    expect(manager.isComponentRunning('second')).toBe(false);
    expect(manager.isComponentRunning('first')).toBe(false);
  });

  test('logger.exit() during the stop phase cancels the startup phase', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();
    manager.enableLoggerExitHook();

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    // The exit hook refuses on its own "already shutting down" branch rather than going
    // through `stopAllComponents()`, so it has to record the request itself - otherwise
    // the restart starts everything back up behind a process that is on its way out.
    logger.exit(3);

    component.releaseStop();
    const result = await restart;

    expect(result.startupSkippedByShutdownRequest).toBe(true);
    expect(result.startupResult.code).toBe('shutdown_requested_during_restart');
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);

    // The deferred exit is released once the stop phase settles.
    await sleep(5);
    expect(logger.didExit).toBe(true);
    expect(logger.exitCode).toBe(3);
  });

  test('a restart that starts during a plain shutdown is not reported as canceled', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const stop = manager.stopAllComponents();
    await component.stopping.promise;

    // No restart owns a stop phase here, so this restart's own refused stop call must
    // not be mistaken for somebody asking the process to stay down.
    const restart = manager.restartAllComponents();

    component.releaseStop();
    const [stopResult, result] = await Promise.all([stop, restart]);

    expect(stopResult.success).toBe(true);
    expect(result.shutdownResult.code).toBe('already_in_progress');
    expect(result.startupSkippedByShutdownRequest).toBeUndefined();
    expect(result.startupResult.code).toBe('shutdown_in_progress');
    expect(result.success).toBe(false);
  });

  test('a second restart during the first stop phase reports nothing of its own', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const first = manager.restartAllComponents();
    await component.stopping.promise;

    // The first restart owns the window; this one is refused outright and behaves as a
    // restart did before the window existed.
    const second = await manager.restartAllComponents();

    expect(second.shutdownResult.code).toBe('already_in_progress');
    expect(second.startupSkippedByShutdownRequest).toBeUndefined();
    expect(second.startupResult.code).toBe('shutdown_in_progress');

    component.releaseStop();
    const firstResult = await first;

    expect(firstResult.startupSkippedByShutdownRequest).toBeUndefined();
    expect(firstResult.success).toBe(true);
    expect(component.startCount).toBe(2);
    expect(manager.isComponentRunning('gated')).toBe(true);
  });

  test('a second restart does not clear the request recorded for the first', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const first = manager.restartAllComponents();
    await component.stopping.promise;

    const ack = await manager.stopAllComponents();
    expect(ack.code).toBe('already_in_progress');

    await manager.restartAllComponents();

    component.releaseStop();
    const firstResult = await first;

    expect(firstResult.startupSkippedByShutdownRequest).toBe(true);
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);
  });

  test('a second restart leaves the first stop-phase window armed', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const first = manager.restartAllComponents();
    await component.stopping.promise;

    // The second restart has come and gone; the first is still stopping, so a request
    // arriving now must still cancel its startup.
    await manager.restartAllComponents();

    const ack = await manager.stopAllComponents();
    expect(ack.code).toBe('already_in_progress');

    component.releaseStop();
    const firstResult = await first;

    expect(firstResult.startupSkippedByShutdownRequest).toBe(true);
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);
  });

  test('the recorded request does not leak into a later restart', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const firstRestart = manager.restartAllComponents();
    await component.stopping.promise;
    await manager.stopAllComponents();
    component.releaseStop();

    const firstResult = await firstRestart;
    expect(firstResult.startupSkippedByShutdownRequest).toBe(true);
    expect(manager.isComponentRunning('gated')).toBe(false);

    // Nothing asks for a shutdown this time, so the flag must be clear again.
    const secondResult = await manager.restartAllComponents();

    expect(secondResult.startupSkippedByShutdownRequest).toBeUndefined();
    expect(secondResult.success).toBe(true);
    expect(secondResult.startupResult.startedComponents).toEqual(['gated']);
    expect(manager.isComponentRunning('gated')).toBe(true);
    expect(component.startCount).toBe(2);
  });

  test('a restart starting after the latch drops does not clear the request', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const first = manager.restartAllComponents();
    await component.stopping.promise;

    const ack = await manager.stopAllComponents();
    expect(ack.code).toBe('already_in_progress');

    // The narrow gap the latch does not cover: the stop pass releases `isShuttingDown`
    // in its `finally`, and the first restart only reads its pass's flag once its own
    // `await` resumes. A microtask queued from a listener that ran inside the pass lands
    // in between, with the latch already off.
    const followUps: Array<Promise<unknown>> = [];

    manager.once('lifecycle-manager:shutdown-completed', () => {
      queueMicrotask(() => {
        followUps.push(manager.restartAllComponents());
      });
    });

    component.releaseStop();
    const firstResult = await first;

    // The request recorded above belongs to the first restart's pass, which nothing
    // starting afterwards can touch.
    expect(firstResult.startupSkippedByShutdownRequest).toBe(true);
    expect(followUps.length).toBe(1);
    await Promise.all(followUps);
  });

  test('a restart that starts after the latch drops can still be canceled', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    // The same gap as above, from the other side. The second restart runs a real stop
    // pass - the latch is free by the time it starts - so a request landing in that pass
    // has to cancel *that* restart. Recording the request against the first restart
    // instead left the second one to start everything back up behind it.
    const followUps: Array<Promise<RestartResult>> = [];

    manager.once('lifecycle-manager:shutdown-completed', () => {
      queueMicrotask(() => {
        followUps.push(manager.restartAllComponents());
      });
    });

    const acks: Array<Promise<ShutdownResult>> = [];
    let passCount = 0;

    manager.on('lifecycle-manager:shutdown-initiated', () => {
      passCount++;

      // The second pass is the follow-up restart's own stop phase.
      if (passCount === 2) {
        acks.push(manager.stopAllComponents());
      }
    });

    const first = manager.restartAllComponents();
    await component.stopping.promise;
    component.releaseStop();

    const firstResult = await first;

    // Nothing asked the first restart to stay down: the request belongs to the pass the
    // follow-up restart started, which is a pass the first restart does not own.
    expect(firstResult.startupSkippedByShutdownRequest).toBeUndefined();
    expect(followUps.length).toBe(1);

    const followUpResult = await followUps[0];
    const ack = await acks[0];

    expect(ack.code).toBe('already_in_progress');
    expect(followUpResult.startupSkippedByShutdownRequest).toBe(true);
    expect(followUpResult.startupResult.code).toBe(
      'shutdown_requested_during_restart',
    );

    // The point of the fix: nothing is running once both restarts have settled.
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);
    expect(manager.getComponentStatus('gated')?.state).toBe('stopped');
  });

  test('a throw in the acceptance step starts no pass and leaves no latch', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const events: string[] = [];

    manager.on('lifecycle-manager:shutdown-initiated', () => {
      events.push('initiated');
    });
    manager.on('lifecycle-manager:shutdown-completed', () => {
      events.push('completed');
    });

    // The bookkeeping the acceptance step runs before it takes the latch. A throw there
    // is a manager bug, and it reaches the caller as one - an `unknown_error` result
    // carrying the thrown value - rather than as a pass that started or a refusal that
    // did not happen.
    const internals = manager as unknown as {
      normalizeRepeatedShutdownRequestStateArmedStatus: () => boolean;
      isShuttingDown: boolean;
      activeShutdownPass: unknown;
    };
    const original = internals.normalizeRepeatedShutdownRequestStateArmedStatus;

    internals.normalizeRepeatedShutdownRequestStateArmedStatus = (): never => {
      throw new Error('acceptance exploded');
    };

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    let crashed: ShutdownResult;

    try {
      crashed = await manager.stopAllComponents();
    } finally {
      internals.normalizeRepeatedShutdownRequestStateArmedStatus = original;
      globalThis.removeEventListener('error', onError);
    }

    expect(crashed.success).toBe(false);
    expect(crashed.code).toBe('unknown_error');
    expect(crashed.error?.message).toBe('acceptance exploded');
    expect(crashed.stoppedComponents).toEqual([]);
    expect(
      reports.some((report) =>
        (report as Error).message.includes(
          'lifecycle-manager stopAllComponents',
        ),
      ),
    ).toBe(true);

    // No pass was accepted, so there is nothing to announce, nothing that owes a result,
    // and nothing latched.
    expect(events).toEqual([]);
    expect(internals.isShuttingDown).toBe(false);
    expect(internals.activeShutdownPass).toBeNull();
    expect(manager.getSystemState()).not.toBe('shutting-down');

    component.releaseStop();

    const retry = await manager.stopAllComponents();

    expect(retry.success).toBe(true);
    expect(events).toEqual(['initiated', 'completed']);
  });

  test('a restart started by escalation bookkeeping still sees the request that caused it', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const restarts: Array<Promise<RestartResult>> = [];
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      shutdownOptions: { timeoutMS: 50, retryStalled: false },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 2000,
        countManualRetriesTowardEscalation: true,
        // Runs synchronously from inside the retry's own pre-latch bookkeeping, so the
        // stop phase this restart starts is already latched by the time the retry
        // reaches the second latch check and is refused by it.
        onForceShutdown: (): void => {
          restarts.push(manager.restartAllComponents());
        },
      },
    });

    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    // Time the first pass out so escalation arms, then let the stop finish: the
    // component ends up cleanly stopped with no stall on record, so nothing but the
    // recorded request can keep the restart below from starting it again.
    const failed = await manager.stopAllComponents();

    expect(failed.timedOut).toBe(true);
    component.releaseStop();
    await sleep(20);

    expect(manager.getComponentStatus('gated')?.state).toBe('stopped');
    expect(manager.getStalledComponents()).toEqual([]);
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

    // The manual retry reaches `forceAfterCount`, whose handler restarts. The retry is
    // then refused by the restart's own stop phase - and that refusal is the request the
    // restart has to hear, or it starts everything back up under an operator who is
    // still asking for the process to go down.
    const retry = await manager.stopAllComponents();

    expect(retry.code).toBe('already_in_progress');
    expect(restarts.length).toBe(1);

    const restart = await restarts[0];

    expect(restart.shutdownResult.success).toBe(true);
    expect(restart.startupSkippedByShutdownRequest).toBe(true);
    expect(restart.startupResult.code).toBe(
      'shutdown_requested_during_restart',
    );
    expect(restart.success).toBe(false);

    // Never started again, and still down.
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);
  });

  test('a signal refused by a restart the force handler started still cancels it', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const restarts: Array<Promise<RestartResult>> = [];
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      shutdownOptions: { timeoutMS: 50, retryStalled: false },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 2000,
        onForceShutdown: (): void => {
          restarts.push(manager.restartAllComponents());
        },
      },
    });

    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    // Same shape as the manual case above, reached through the signal path: the press
    // that crosses the threshold is refused by the restart its own force handler
    // started, and that refusal is the only place the request can be recorded.
    const failed = await manager.stopAllComponents();

    expect(failed.timedOut).toBe(true);
    component.releaseStop();
    await sleep(20);

    expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

    sendSignal(manager, 'SIGTERM');

    expect(restarts.length).toBe(1);

    const restart = await restarts[0];

    expect(restart.startupSkippedByShutdownRequest).toBe(true);
    expect(component.startCount).toBe(1);
    expect(manager.isComponentRunning('gated')).toBe(false);
  });

  test('a restart whose stop phase throws leaves no pass behind', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    // Kills the stop pass while it is still working out what to stop, so the restart
    // never reaches the point where it reads its pass's flag.
    const internals = manager as unknown as {
      isComponentRunning: (name: string) => boolean;
      isShuttingDown: boolean;
      activeShutdownPass: unknown;
    };
    const original = internals.isComponentRunning;

    internals.isComponentRunning = (): never => {
      throw new Error('stop phase exploded');
    };

    const onError = (event: Event): void => {
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    let crashed: RestartResult;

    try {
      crashed = await manager.restartAllComponents();
    } finally {
      internals.isComponentRunning = original;
      globalThis.removeEventListener('error', onError);
    }

    // Resolves rather than rejects, with the pass's own failure, and never starts
    // anything on top of a stop phase nobody can vouch for.
    expect(crashed.success).toBe(false);
    expect(crashed.shutdownResult.code).toBe('unknown_error');
    expect(crashed.shutdownResult.error?.message).toBe('stop phase exploded');
    expect(crashed.startupResult.code).toBe('unknown_error');
    expect(crashed.startupResult.startedComponents).toEqual([]);
    expect(component.startCount).toBe(1);

    // The pass's `finally` dropped it along with the latch, so the next restart runs a
    // pass of its own rather than being refused by a leaked one.
    expect(internals.isShuttingDown).toBe(false);
    expect(internals.activeShutdownPass).toBeNull();

    // The throw landed before stop() was ever called, so open the gate for the pass that
    // does reach it.
    component.releaseStop();

    const second = await manager.restartAllComponents();

    expect(second.startupSkippedByShutdownRequest).toBeUndefined();
    expect(second.success).toBe(true);
    expect(manager.isComponentRunning('gated')).toBe(true);
  });

  test('the first signal during a restart stop phase starts the escalation cycle', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const forced: Array<{ requestCount: number; firstMethod: string | null }> =
      [];
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 2,
        withinMS: 5000,
        onForceShutdown: (context): void => {
          forced.push({
            requestCount: context.requestCount,
            firstMethod: context.firstMethod,
          });
        },
      },
    });
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    // The first press cancels the restart and is where the operator's shutdown begins:
    // it seeds the cycle, the way a signal that starts a pass does, and is not counted.
    sendSignal(manager, 'SIGINT');
    expect(manager.getShutdownEscalationStatus().requestCount).toBe(0);
    expect(manager.getShutdownEscalationStatus().firstMethod).toBe('SIGINT');

    sendSignal(manager, 'SIGINT');
    expect(forced).toEqual([]);

    sendSignal(manager, 'SIGINT');
    expect(forced).toEqual([{ requestCount: 2, firstMethod: 'SIGINT' }]);

    component.releaseStop();
    expect((await restart).startupSkippedByShutdownRequest).toBe(true);
  });

  test('a manual stop before the first signal does not stop that signal starting the cycle', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 3,
        withinMS: 5000,
        onForceShutdown: (): void => {},
      },
    });
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const restart = manager.restartAllComponents();
    await component.stopping.promise;

    // A stay-down request, but not a press: the signal after it is still the first one.
    await manager.stopAllComponents();
    sendSignal(manager, 'SIGINT');

    expect(manager.getShutdownEscalationStatus().firstMethod).toBe('SIGINT');
    expect(manager.getShutdownEscalationStatus().requestCount).toBe(0);

    component.releaseStop();
    await restart;
  });

  test('a restart after a cycle whose force already fired can force again', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    let forceShutdownCalls = 0;
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      shutdownOptions: { timeoutMS: 50 },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 5000,
        // A force handler that does not exit the process.
        onForceShutdown: (): void => {
          forceShutdownCalls++;
        },
      },
    });

    class Hanging extends BaseComponent {
      public start(): Promise<void> {
        return Promise.resolve();
      }
      public stop(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }

    await manager.registerComponent(
      new Hanging(logger, { name: 'hanging', dependencies: [] }),
    );
    await manager.startAllComponents();

    // The first cycle: a signal starts a pass that hangs, a repeat forces it.
    const firstDone = shutdownCompleted(manager);
    sendSignal(manager, 'SIGINT');
    sendSignal(manager, 'SIGINT');
    expect(forceShutdownCalls).toBe(1);
    await firstDone;

    // Force already fired, so nothing armed: the state that is left belongs to a
    // finished cycle. A later restart starts a fresh one, so a press against it still
    // reaches the force handler.
    const restart = manager.restartAllComponents();
    sendSignal(manager, 'SIGINT');
    sendSignal(manager, 'SIGINT');

    expect(forceShutdownCalls).toBe(2);
    await restart;
  });
});
