import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
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
    const ack = await manager.triggerShutdown();
    expect(ack.initiated).toBe(false);
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

  test('a signal during the stop phase still counts toward escalation', async () => {
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

    // Escalation counting is untouched by the cancellation: a repeat signal against the
    // restart's stop phase still reaches the force handler exactly as it does today.
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

    const ack = await manager.triggerShutdown();
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

    const done = shutdownCompleted(manager);
    const ack = await manager.triggerShutdown();
    expect(ack.initiated).toBe(true);
    expect(ack.code).toBe('initiated');

    first.releaseStart();
    const result = await restart;
    await done;

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

    const ack = await manager.triggerShutdown();
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

    const ack = await manager.triggerShutdown();
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
    await manager.triggerShutdown();
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

  test('a restart starting after the latch drops does not take over the open window', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const first = manager.restartAllComponents();
    await component.stopping.promise;

    const ack = await manager.triggerShutdown();
    expect(ack.code).toBe('already_in_progress');

    // The narrow gap the latch does not cover: the stop pass releases `isShuttingDown`
    // in its `finally`, and the first restart only closes its window once its own
    // `await` resumes. A microtask queued from a listener that ran inside the pass lands
    // in between, with the latch already off and the window still open.
    const followUps: Array<Promise<unknown>> = [];

    manager.once('lifecycle-manager:shutdown-completed', () => {
      queueMicrotask(() => {
        followUps.push(manager.restartAllComponents());
      });
    });

    component.releaseStop();
    const firstResult = await first;

    // The request recorded above belongs to the first restart, and only the first
    // restart may close the window it is recorded in.
    expect(firstResult.startupSkippedByShutdownRequest).toBe(true);
    expect(followUps.length).toBe(1);
    await Promise.all(followUps);
  });

  test('a restart whose stop phase throws leaves no window behind', async () => {
    const { logger, manager } = setup();
    const component = new GatedStop(logger, 'gated');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    // Kills the stop pass while it is still working out what to stop, so the restart
    // never reaches the call that closes its window on the normal path.
    const internals = manager as unknown as {
      isComponentRunning: (name: string) => boolean;
      restartStopPhaseToken: string | null;
    };
    const original = internals.isComponentRunning;

    internals.isComponentRunning = (): never => {
      throw new Error('stop phase exploded');
    };

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(manager.restartAllComponents()).rejects.toThrow(
        'stop phase exploded',
      );
    } finally {
      internals.isComponentRunning = original;
    }

    // The `finally` closed it, so the next restart owns a window of its own rather than
    // being refused by a leaked one.
    expect(internals.restartStopPhaseToken).toBeNull();

    // The throw landed before stop() was ever called, so open the gate for the pass that
    // does reach it.
    component.releaseStop();

    const second = await manager.restartAllComponents();

    expect(second.startupSkippedByShutdownRequest).toBeUndefined();
    expect(second.success).toBe(true);
    expect(manager.isComponentRunning('gated')).toBe(true);
  });
});
