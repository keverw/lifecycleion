import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import type { ForceShutdownContext } from './types';
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

class SlowStop extends BaseComponent {
  public stopEntered = false;
  constructor(
    logger: Logger,
    name: string,
    private readonly delayMS: number,
  ) {
    super(logger, { name, dependencies: [] });
  }
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {
    this.stopEntered = true;
    await sleep(this.delayMS);
  }
}

describe('LifecycleManager - triggerShutdown()', () => {
  test('acknowledges immediately while the shutdown runs in the background', async () => {
    const { logger, manager } = setup();
    const component = new SlowStop(logger, 'slow', 120);
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const completed: boolean[] = [];
    manager.on('lifecycle-manager:shutdown-completed', () => {
      completed.push(true);
    });

    const done = shutdownCompleted(manager);
    const ack = await manager.triggerShutdown();

    expect(ack.initiated).toBe(true);
    expect(ack.code).toBe('initiated');
    expect(typeof ack.reason).toBe('string');

    // Acknowledged before the component's stop could have finished. Still mid-stop: a
    // component in `stopping` stays in runningComponents until its stop settles, so the
    // state is the meaningful signal here.
    expect(manager.getComponentStatus('slow')?.state).toBe('stopping');
    expect(component.stopEntered).toBe(true);
    expect(completed.length).toBe(0);

    await done;
    expect(completed.length).toBe(1);
    expect(manager.getComponentStatus('slow')?.state).toBe('stopped');
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  });

  test('reports already_in_progress without starting a second pass', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 120));
    await manager.startAllComponents();

    let initiatedCount = 0;
    manager.on('lifecycle-manager:shutdown-initiated', () => {
      initiatedCount++;
    });

    const done = shutdownCompleted(manager);
    const first = await manager.triggerShutdown();
    const second = await manager.triggerShutdown();

    expect(first.initiated).toBe(true);
    expect(second.initiated).toBe(false);
    expect(second.code).toBe('already_in_progress');

    await done;
    expect(initiatedCount).toBe(1);
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  });

  test('does not emit signal:shutdown for a manual request', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const signals: unknown[] = [];
    manager.on('signal:shutdown', (payload) => {
      signals.push(payload);
    });
    const initiated: unknown[] = [];
    manager.on('lifecycle-manager:shutdown-initiated', (payload) => {
      initiated.push(payload);
    });

    const done = shutdownCompleted(manager);
    await manager.triggerShutdown();
    await done;

    expect(signals.length).toBe(0);
    expect(initiated.length).toBe(1);
  });

  test('a failing shutdown still resolves the acknowledgement', async () => {
    // Short global timeout: the pass must settle inside the test, not 30s later.
    const { logger, manager } = setup(100);

    class Hanging extends BaseComponent {
      public async start(): Promise<void> {}
      public stop(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }

    await manager.registerComponent(
      new Hanging(logger, { name: 'hanging', dependencies: [] }),
    );
    await manager.startAllComponents();

    const done = shutdownCompleted(manager);
    const ack = await manager.triggerShutdown();
    expect(ack.initiated).toBe(true);

    // The acknowledgement says nothing about the outcome; the component is
    // still stopping at this point.
    expect(manager.getComponentStatus('hanging')?.state).toBe('stopping');

    await done;
    expect(manager.getLastShutdownResult()?.success).toBe(false);
  });

  test('a throwing logger neither fails the request nor skips the force handler', async () => {
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
        withinMS: 1000,
        countManualRetriesTowardEscalation: true,
        onForceShutdown: () => {
          forceShutdownCalls++;
        },
      },
    });

    await manager.registerComponent(new SlowStop(logger, 'slow', 120));
    await manager.startAllComponents();
    const done = shutdownCompleted(manager);
    await manager.triggerShutdown();

    // The manager's logger is guarded, and the escalation warns inside
    // `handleRepeatedShutdownRequest` sit between advancing `requestCount` and invoking
    // the force handler, so a throw there must not escape the signal handler or swallow
    // the escalation. Only a signal counts mid-shutdown, so the repeat is a SIGTERM.
    // Assigning through the guard lands on the underlying service, so this really does
    // install a throwing logger.
    const service = (manager as unknown as { logger: { warn: unknown } })
      .logger;
    const originalWarn = service.warn;
    service.warn = (): never => {
      throw new Error('logger exploded');
    };

    // Claiming the report with `preventDefault()` both asserts the guard reported it
    // and keeps the `console.error` fall-through out of the test output.
    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    try {
      (
        manager as unknown as {
          handleShutdownRequest: (method: string) => void;
        }
      ).handleShutdownRequest('SIGTERM');
    } finally {
      service.warn = originalWarn;
      globalThis.removeEventListener('error', onError);
    }

    expect(forceShutdownCalls).toBe(1);
    expect(
      reports.some((report) =>
        (report as Error).message.includes('lifecycle-manager logger.warn'),
      ),
    ).toBe(true);

    await done;
  });

  test('a logger that throws on the first request does not wedge the shutdown latch', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const service = (manager as unknown as { logger: { info: unknown } })
      .logger;
    const originalInfo = service.info;
    service.info = (): never => {
      throw new Error('logger exploded');
    };

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    const done = shutdownCompleted(manager);
    let ack;

    try {
      ack = await manager.triggerShutdown();
    } finally {
      service.info = originalInfo;
      globalThis.removeEventListener('error', onError);
    }

    expect(ack.initiated).toBe(true);
    expect(
      reports.some((report) =>
        (report as Error).message.includes('lifecycle-manager logger.info'),
      ),
    ).toBe(true);

    await done;
    expect(manager.getComponentStatus('slow')?.state).toBe('stopped');
    expect(manager.getSystemState()).not.toBe('shutting-down');
  });
});

describe('LifecycleManager - triggerShutdown() escalation', () => {
  test('manual requests do not count toward escalation by default', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    let forceShutdownCalls = 0;
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 2,
        withinMS: 1000,
        onForceShutdown: () => {
          forceShutdownCalls++;
        },
      },
    });

    await manager.registerComponent(new SlowStop(logger, 'slow', 150));
    await manager.startAllComponents();

    // `countManualRetriesTowardEscalation` defaults to false, so hammering this from
    // concurrent handlers must never reach the force handler.
    const done = shutdownCompleted(manager);
    const acks = [
      await manager.triggerShutdown(),
      await manager.triggerShutdown(),
      await manager.triggerShutdown(),
      await manager.triggerShutdown(),
    ];

    expect(acks[0].initiated).toBe(true);
    expect(
      acks.slice(1).every((ack) => ack.code === 'already_in_progress'),
    ).toBe(true);
    expect(forceShutdownCalls).toBe(0);

    await done;
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  });

  test('manual requests never count while a shutdown is running, even when opted in', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    let forceShutdownCalls = 0;
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 2,
        withinMS: 1000,
        countManualRetriesTowardEscalation: true,
        onForceShutdown: () => {
          forceShutdownCalls++;
        },
      },
    });

    await manager.registerComponent(new SlowStop(logger, 'slow', 150));
    await manager.startAllComponents();

    const done = shutdownCompleted(manager);
    // The flag covers a deliberate retry after a failed pass, not overlapping callers:
    // the same as `stopAllComponents()`, which refuses in this window.
    await manager.triggerShutdown();
    await manager.triggerShutdown();
    await manager.triggerShutdown();

    expect(forceShutdownCalls).toBe(0);
    expect(manager.getShutdownEscalationStatus().requestCount).toBe(0);
    await done;
  });

  test('counts a manual retry once while armed after a failed shutdown', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    let forceShutdownCalls = 0;
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      shutdownOptions: { timeoutMS: 100, retryStalled: false },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 2,
        withinMS: 2000,
        countManualRetriesTowardEscalation: true,
        onForceShutdown: () => {
          forceShutdownCalls++;
        },
      },
    });

    class Hanging extends BaseComponent {
      public async start(): Promise<void> {}
      public stop(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }

    await manager.registerComponent(
      new Hanging(logger, { name: 'hanging', dependencies: [] }),
    );
    await manager.startAllComponents();

    // Fail the first attempt so post-failure escalation is armed.
    const failed = await manager.stopAllComponents({
      timeoutMS: 100,
      retryStalled: false,
    });
    expect(failed.success).toBe(false);
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

    // `acceptShutdownPass` owns the manual-retry-while-armed split, so this
    // must advance the count by exactly one - the same as `stopAllComponents()`.
    // Counting it in the request path too would reach forceAfterCount on this one
    // call and force-kill from a single programmatic request.
    let done = shutdownCompleted(manager);
    await manager.triggerShutdown();

    expect(manager.getShutdownEscalationStatus().requestCount).toBe(1);
    expect(forceShutdownCalls).toBe(0);
    await done;

    // The next armed retry reaches `forceAfterCount`: the force handler runs, and
    // because the retry pass still starts, the acknowledgement is `initiated` - the
    // same as `stopAllComponents()`.
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);
    done = shutdownCompleted(manager);
    const ack = await manager.triggerShutdown();

    expect(forceShutdownCalls).toBe(1);
    expect(ack.code).toBe('initiated');
    await done;
  });

  test('a force handler that triggers shutdown does not get a second concurrent pass', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const nestedAcks: string[] = [];
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      shutdownOptions: { timeoutMS: 100, retryStalled: false },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 2000,
        countManualRetriesTowardEscalation: true,
        // Runs synchronously, from inside the retry's own pre-latch bookkeeping: the
        // pass this starts finds no latch and really does begin stopping.
        onForceShutdown: () => {
          void manager.triggerShutdown().then((ack) => {
            nestedAcks.push(ack.code);
          });
        },
      },
    });

    class Hanging extends BaseComponent {
      public async start(): Promise<void> {}
      public stop(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }

    await manager.registerComponent(
      new Hanging(logger, { name: 'hanging', dependencies: [] }),
    );
    await manager.startAllComponents();

    // Fail the first attempt so post-failure escalation is armed; the retry below is
    // what reaches forceAfterCount.
    const failed = await manager.stopAllComponents();
    expect(failed.success).toBe(false);
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

    let initiatedCount = 0;
    let completedCount = 0;
    manager.on('lifecycle-manager:shutdown-initiated', () => {
      initiatedCount++;
    });
    manager.on('lifecycle-manager:shutdown-completed', () => {
      completedCount++;
    });

    const done = shutdownCompleted(manager);
    const outer = await manager.stopAllComponents();

    // The nested request is the one that owns the pass; the outer call is refused for
    // the shutdown that request started, rather than running a second one alongside it.
    expect(nestedAcks).toEqual(['initiated']);
    expect(outer.code).toBe('already_in_progress');
    expect(outer.stoppedComponents).toEqual([]);
    expect(initiatedCount).toBe(1);

    // Still held by the pass the force handler started, not released by the refusal.
    const internals = manager as unknown as { isShuttingDown: boolean };
    expect(internals.isShuttingDown).toBe(true);
    expect(completedCount).toBe(0);

    await done;

    expect(completedCount).toBe(1);
    expect(initiatedCount).toBe(1);
    expect(internals.isShuttingDown).toBe(false);
  });
});

describe('LifecycleManager - triggerShutdown() hardening', () => {
  test('a throwing logger does not block a request after the armed window lapsed', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      shutdownOptions: { timeoutMS: 100, retryStalled: false },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 5,
        withinMS: 1000,
        armedAfterFailureMS: 60_000,
        onForceShutdown: () => {},
      },
    });

    class Hanging extends BaseComponent {
      public async start(): Promise<void> {}
      public stop(): Promise<void> {
        return new Promise<void>(() => {});
      }
    }

    await manager.registerComponent(
      new Hanging(logger, { name: 'hanging', dependencies: [] }),
    );
    await manager.startAllComponents();

    const failed = await manager.stopAllComponents({
      timeoutMS: 100,
      retryStalled: false,
    });
    expect(failed.success).toBe(false);
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

    // Lapse the window without letting the timer fire, as on a delayed event loop, so
    // the request path is what expires it - through the `warn` that used to be bare.
    (
      manager as unknown as {
        repeatedShutdownRequestState: { remainsArmedUntil: number };
      }
    ).repeatedShutdownRequestState.remainsArmedUntil = Date.now() - 1;

    const service = (manager as unknown as { logger: { warn: unknown } })
      .logger;
    const originalWarn = service.warn;
    service.warn = (): never => {
      throw new Error('logger exploded');
    };

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    const done = shutdownCompleted(manager);
    let ack;

    try {
      ack = await manager.triggerShutdown();
    } finally {
      service.warn = originalWarn;
      globalThis.removeEventListener('error', onError);
    }

    expect(ack.initiated).toBe(true);
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(false);
    expect(
      reports.some((report) =>
        (report as Error).message.includes('lifecycle-manager logger.warn'),
      ),
    ).toBe(true);

    await done;
  });

  test('a logger that rejects asynchronously is reported, not left floating', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const service = (manager as unknown as { logger: { info: unknown } })
      .logger;
    const originalInfo = service.info;
    service.info = (): Promise<never> =>
      Promise.reject(new Error('async logger exploded'));

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    const done = shutdownCompleted(manager);
    let ack;

    try {
      ack = await manager.triggerShutdown();
      await done;
    } finally {
      service.info = originalInfo;
      globalThis.removeEventListener('error', onError);
    }

    expect(ack.initiated).toBe(true);
    expect(
      reports.some((report) =>
        (report as Error).message.includes('lifecycle-manager logger.info'),
      ),
    ).toBe(true);
  });

  test('a throw during shutdown setup releases the shutdown latch', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const done = shutdownCompleted(manager);

    // The setup between setting `isShuttingDown` and stopping components used to sit
    // outside the `try`/`finally` that releases the latch.
    const internals = manager as unknown as {
      isComponentRunning: (name: string) => boolean;
    };
    const original = internals.isComponentRunning;
    internals.isComponentRunning = (): never => {
      throw new Error('setup exploded');
    };

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(manager.stopAllComponents()).rejects.toThrow(
        'setup exploded',
      );
    } finally {
      internals.isComponentRunning = original;
    }

    expect(manager.getSystemState()).not.toBe('shutting-down');

    // The pass had already announced itself, so it owes a result: rejecting the promise
    // alone would leave a listener on `shutdown-completed` waiting forever.
    await done;
    const failed = manager.getLastShutdownResult();
    expect(failed?.success).toBe(false);
    expect(failed?.reason).toContain('setup exploded');

    const retry = await manager.stopAllComponents();
    expect(retry.success).toBe(true);
  });

  test('a pass that dies after it is announced still reports a failed result', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    const internals = manager as unknown as {
      isComponentRunning: (name: string) => boolean;
    };
    const original = internals.isComponentRunning;
    internals.isComponentRunning = (): never => {
      throw new Error('setup exploded');
    };

    const done = shutdownCompleted(manager);
    let ack;

    try {
      ack = await manager.triggerShutdown();
      await done;
    } finally {
      internals.isComponentRunning = original;
      globalThis.removeEventListener('error', onError);
    }

    // `shutdown-initiated` is already out by the time this throws, so the pass did start
    // and the acknowledgement is honest; the outcome arrives on the completed event.
    expect(ack.code).toBe('initiated');
    expect(manager.getLastShutdownResult()?.success).toBe(false);
    expect(
      reports.some((report) =>
        (report as Error).message.includes('shutdown after manual'),
      ),
    ).toBe(true);
    expect(manager.getSystemState()).not.toBe('shutting-down');
  });

  test('a throw at the very start of the pass still reports a failed result', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 3,
        withinMS: 1000,
        onForceShutdown: (): void => {},
      },
    });

    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const events: string[] = [];
    manager.on('lifecycle-manager:shutdown-initiated', () => {
      events.push('initiated');
    });
    manager.on('lifecycle-manager:shutdown-completed', () => {
      events.push('completed');
    });

    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    // Escalation seeding is the earliest thing in the pass that could plausibly throw:
    // it runs after the pass has announced itself to the requester but before the
    // `shutdown-initiated` emit.
    const internals = manager as unknown as {
      seedRepeatedShutdownRequestState: (method: string) => void;
    };
    const original = internals.seedRepeatedShutdownRequestState;
    internals.seedRepeatedShutdownRequestState = (): never => {
      throw new Error('seed exploded');
    };

    const done = shutdownCompleted(manager);
    let ack;

    try {
      ack = await manager.triggerShutdown();
      await done;
    } finally {
      internals.seedRepeatedShutdownRequestState = original;
      globalThis.removeEventListener('error', onError);
    }

    // The pass started, so the acknowledgement is `initiated` and the request never
    // rejects - the outcome arrives on the completed event instead.
    expect(ack.code).toBe('initiated');

    // `shutdown-initiated` never made it out, but the pass still owes a result: a
    // listener with nothing to pair the completion to beats a pass that reports nothing.
    expect(events).toEqual(['completed']);

    const failed = manager.getLastShutdownResult();
    expect(failed?.success).toBe(false);
    expect(failed?.code).toBe('unknown_error');
    expect(failed?.reason).toContain('seed exploded');

    // A failed pass normally arms the escalation window, but seeding is what threw here,
    // so there is no cycle to carry over and nothing to arm.
    expect(manager.getShutdownEscalationStatus().firstRequestAt).toBe(null);
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(false);
    expect(
      reports.some((report) =>
        (report as Error).message.includes('shutdown after manual'),
      ),
    ).toBe(true);

    // The latch is released, so the retry runs a clean pass.
    expect(manager.getSystemState()).not.toBe('shutting-down');

    const retry = await manager.stopAllComponents();
    expect(retry.success).toBe(true);
    expect(events).toEqual(['completed', 'initiated', 'completed']);
  });

  test('a pass that dies mid-flight reports what it stopped and arms its escalation state', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 3,
        withinMS: 1000,
        onForceShutdown: (): void => {},
      },
    });

    await manager.registerComponent(new SlowStop(logger, 'first', 10));
    await manager.registerComponent(new SlowStop(logger, 'second', 10));
    await manager.startAllComponents();

    // Let the first stop through, then blow up inside the stop loop.
    const internals = manager as unknown as {
      stopComponentInternal: (name: string) => Promise<unknown>;
    };
    const original = internals.stopComponentInternal;
    let calls = 0;
    internals.stopComponentInternal = function (
      this: unknown,
      name: string,
    ): Promise<unknown> {
      calls++;

      if (calls > 1) {
        throw new Error('stop loop exploded');
      }

      return original.call(this, name);
    };

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(manager.stopAllComponents()).rejects.toThrow(
        'stop loop exploded',
      );
    } finally {
      internals.stopComponentInternal = original;
    }

    const result = manager.getLastShutdownResult();
    expect(result?.success).toBe(false);
    expect(result?.code).toBe('unknown_error');
    expect(result?.stoppedComponents.length).toBe(1);

    // Scoped to this pass's own stop list, exactly as a pass that finishes scopes it.
    expect(result?.stalledComponents).toEqual([]);

    // A crash ends the pass unsuccessfully, so the window is armed exactly as a stall or
    // a timeout arms it: dropping the cycle here would reseed the operator's next press
    // as a fresh one and put `forceAfterCount` out of reach.
    const escalation = manager.getShutdownEscalationStatus();
    expect(escalation.firstRequestAt).not.toBe(null);
    expect(escalation.isArmed).toBe(true);
  });

  test('a crashed pass leaves escalation reachable for the presses that follow', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const forced: ForceShutdownContext[] = [];
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 2,
        withinMS: 1000,
        onForceShutdown: (context): void => {
          forced.push(context);
        },
      },
    });

    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    // Every pass from here on dies inside the stop loop, so the component never stops
    // and each press has something left to ask for.
    const internals = manager as unknown as {
      stopComponentInternal: (name: string) => Promise<unknown>;
      handleShutdownRequest: (method: string) => void;
    };
    const original = internals.stopComponentInternal;
    internals.stopComponentInternal = (): never => {
      throw new Error('stop loop exploded');
    };

    // Each dead pass rejects the floating promise `startShutdownPass()` holds, which
    // reports it on the global channel; claiming the reports keeps them out of the
    // test output and asserts they were made.
    const reports: unknown[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error);
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    try {
      // The first press seeds the cycle and its pass crashes rather than stalling.
      let done = shutdownCompleted(manager);
      internals.handleShutdownRequest('SIGTERM');
      await done;

      expect(manager.getLastShutdownResult()?.code).toBe('unknown_error');
      expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

      // The second press opens the escalation window at 1 and retries; the third
      // advances the same streak to `forceAfterCount`. When a crash dropped the cycle
      // instead, every press reseeded at 0 and the force handler was unreachable - no
      // escape hatch for the one failure that most needs one.
      done = shutdownCompleted(manager);
      internals.handleShutdownRequest('SIGTERM');
      await done;

      expect(forced.length).toBe(0);

      done = shutdownCompleted(manager);
      internals.handleShutdownRequest('SIGTERM');
      await done;

      // Each pass reports its rejection a microtask after the completed event, so let
      // the last one land while the listener that claims it is still attached.
      await sleep(5);
    } finally {
      internals.stopComponentInternal = original;
      globalThis.removeEventListener('error', onError);
    }

    expect(forced.length).toBe(1);
    expect(forced[0]?.requestCount).toBe(2);
    expect(forced[0]?.firstMethod).toBe('SIGTERM');

    // The threshold was crossed from the post-failure window, not from inside a running
    // pass: the crash is what left that window open.
    expect(forced[0]?.wasArmedAfterFailure).toBe(true);
    expect(forced[0]?.isShuttingDown).toBe(false);
    expect(
      reports.some((report) =>
        (report as Error).message.includes('shutdown after SIGTERM'),
      ),
    ).toBe(true);
  });

  test('a pass that dies before it has a stop list reports no stalls of its own', async () => {
    const { logger, manager } = setup();

    class StallOnStop extends BaseComponent {
      public async start(): Promise<void> {}
      public stop(): Promise<void> {
        return Promise.reject(new Error('stop failed'));
      }
    }

    await manager.registerComponent(
      new StallOnStop(logger, { name: 'stalled', dependencies: [] }),
    );
    await manager.startAllComponents();

    // Leave a stall on record from a pass that has already reported it.
    const first = await manager.stopAllComponents();
    expect(first.success).toBe(false);
    expect(manager.getStalledComponents().length).toBe(1);

    // Kill the next pass while it is still working out what to stop, so it never has a
    // stop list to scope its result to.
    const internals = manager as unknown as {
      isComponentRunning: (name: string) => boolean;
    };
    const original = internals.isComponentRunning;
    internals.isComponentRunning = (): never => {
      throw new Error('setup exploded');
    };

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(manager.stopAllComponents()).rejects.toThrow(
        'setup exploded',
      );
    } finally {
      internals.isComponentRunning = original;
    }

    // The stall predates this pass and was never in its view, so it stays with the
    // result that did report it rather than being restated as this crash's doing.
    const crashed = manager.getLastShutdownResult();
    expect(crashed?.code).toBe('unknown_error');
    expect(crashed?.stalledComponents).toEqual([]);
    expect(manager.getStalledComponents().length).toBe(1);
  });

  test('a crashed pass still reports a component that stopped without it', async () => {
    const logger = new Logger({
      sinks: [new ArraySink()],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: 50,
    });

    let armThrow = (): void => {};

    class SelfStopper extends BaseComponent {
      public async start(): Promise<void> {}
      public async stop(): Promise<void> {}
      // The stop loop never records this one: it stops itself here, and the loop throws
      // before it gets that far.
      public onShutdownWarning(): void {
        this.reportUnexpectedStop();
        armThrow();
      }
    }

    class Plain extends BaseComponent {
      public async start(): Promise<void> {}
      public async stop(): Promise<void> {}
    }

    await manager.registerComponent(
      new SelfStopper(logger, { name: 'first', dependencies: [] }),
    );
    await manager.registerComponent(
      new Plain(logger, { name: 'second', dependencies: [] }),
    );
    await manager.startAllComponents();

    // Shutdown order is the reverse of startup order, so the loop reaches 'second'
    // first and dies there, with 'first' already stopped but unrecorded.
    const internals = manager as unknown as {
      isComponentRunning: (name: string) => boolean;
    };
    const original = internals.isComponentRunning.bind(manager);
    let isArmed = false;

    armThrow = (): void => {
      isArmed = true;
    };
    internals.isComponentRunning = (name: string): boolean => {
      if (isArmed && name === 'second') {
        throw new Error('stop loop exploded');
      }

      return original(name);
    };

    try {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      await expect(manager.stopAllComponents()).rejects.toThrow(
        'stop loop exploded',
      );
    } finally {
      internals.isComponentRunning = original;
    }

    // Both paths run the same reconciliation sweep, so the crash reports what the
    // manager actually has as stopped rather than only what the loop got to announce.
    const crashed = manager.getLastShutdownResult();
    expect(crashed?.code).toBe('unknown_error');
    expect(crashed?.stoppedComponents).toEqual(['first']);
    expect(manager.getComponentStatus('first')?.state).toBe('stopped');
  });

  test('a throw on the request path rejects rather than escaping the promise', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const events: string[] = [];

    manager.on('lifecycle-manager:shutdown-initiated', () => {
      events.push('initiated');
    });
    manager.on('lifecycle-manager:shutdown-completed', () => {
      events.push('completed');
    });

    // The pre-latch half of the request, where a manager bug - an option read that
    // throws, say - would surface. The method is declared to return a promise, so the
    // caller's `.catch()` has to be the thing that sees it.
    const internals = manager as unknown as {
      acceptShutdownPass: (method: string) => unknown;
      isShuttingDown: boolean;
      activeShutdownPass: unknown;
    };
    const original = internals.acceptShutdownPass;

    internals.acceptShutdownPass = (): never => {
      throw new Error('acceptance exploded');
    };

    let didThrowSynchronously = false;
    let rejection: unknown;

    try {
      // Calling without awaiting: a synchronous throw would land here instead of on the
      // promise, which is exactly the shape this guards against.
      const pending = manager.triggerShutdown();
      rejection = await pending.then(
        () => null,
        (error: unknown) => error,
      );
    } catch (error) {
      didThrowSynchronously = true;
      rejection = error;
    } finally {
      internals.acceptShutdownPass = original;
    }

    expect(didThrowSynchronously).toBe(false);
    expect((rejection as Error).message).toBe('acceptance exploded');

    // Fail-fast: the failure is reported as itself, never laundered into an
    // `already_in_progress` acknowledgement for a pass that never existed.
    expect(events).toEqual([]);
    expect(internals.isShuttingDown).toBe(false);
    expect(internals.activeShutdownPass).toBeNull();
    expect(manager.getSystemState()).not.toBe('shutting-down');
    expect(manager.getLastShutdownResult()).toBeNull();

    // The manager is idle, not wedged: the next request runs a pass of its own.
    const done = shutdownCompleted(manager);
    const ack = await manager.triggerShutdown();

    expect(ack.code).toBe('initiated');
    await done;
    expect(events).toEqual(['initiated', 'completed']);
  });

  test('a logger that throws on the final log line does not fail a clean shutdown', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new SlowStop(logger, 'slow', 10));
    await manager.startAllComponents();

    const service = (manager as unknown as { logger: { success: unknown } })
      .logger;
    const originalSuccess = service.success;
    service.success = (): never => {
      throw new Error('logger exploded');
    };

    const onError = (event: Event): void => {
      event.preventDefault();
    };

    globalThis.addEventListener('error', onError);

    let result;

    try {
      result = await manager.stopAllComponents();
    } finally {
      service.success = originalSuccess;
      globalThis.removeEventListener('error', onError);
    }

    expect(result.success).toBe(true);
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  });

  test('a component can trigger shutdown through its lifecycle reference', async () => {
    const { logger, manager } = setup();
    const component = new SlowStop(logger, 'slow', 10);
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const lifecycle = (
      component as unknown as {
        lifecycle: { triggerShutdown(): Promise<{ code: string }> };
      }
    ).lifecycle;
    const done = shutdownCompleted(manager);
    const ack = await lifecycle.triggerShutdown();

    expect(ack.code).toBe('initiated');
    await done;
    expect(manager.getComponentStatus('slow')?.state).toBe('stopped');
  });
});
