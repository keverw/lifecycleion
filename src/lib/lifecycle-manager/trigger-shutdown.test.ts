import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { sleep } from '../sleep';

function setup() {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });
  return {
    logger,
    manager: new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 }),
  };
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

    const startedAt = Date.now();
    const ack = await manager.triggerShutdown();
    const ackDurationMS = Date.now() - startedAt;

    expect(ack.initiated).toBe(true);
    expect(ack.code).toBe('initiated');
    expect(typeof ack.reason).toBe('string');

    // Returned well before the component's stop could have finished.
    expect(ackDurationMS).toBeLessThan(100);
    // Still mid-stop: a component in `stopping` stays in runningComponents
    // until its stop settles, so the state is the meaningful signal here.
    expect(manager.getComponentStatus('slow')?.state).toBe('stopping');
    expect(component.stopEntered).toBe(true);
    expect(completed.length).toBe(0);

    await sleep(250);
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

    const first = await manager.triggerShutdown();
    const second = await manager.triggerShutdown();

    expect(first.initiated).toBe(true);
    expect(second.initiated).toBe(false);
    expect(second.code).toBe('already_in_progress');

    await sleep(250);
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

    await manager.triggerShutdown();
    await sleep(120);

    expect(signals.length).toBe(0);
    expect(initiated.length).toBe(1);
  });

  test('a failing shutdown still resolves the acknowledgement', async () => {
    const { logger, manager } = setup();

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

    const ack = await manager.triggerShutdown();
    expect(ack.initiated).toBe(true);

    // The acknowledgement says nothing about the outcome; the component is
    // still stopping at this point.
    expect(manager.getComponentStatus('hanging')?.state).toBe('stopping');
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
    await manager.triggerShutdown();

    // `this.logger` is a caller-supplied `LoggerService`. The escalation warns inside
    // `handleRepeatedShutdownRequest` sit between advancing `requestCount` and invoking
    // the force handler, so a throw there must not reject the acknowledgement or
    // swallow the escalation.
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

    let ack;

    try {
      ack = await manager.triggerShutdown();
    } finally {
      service.warn = originalWarn;
      globalThis.removeEventListener('error', onError);
    }

    expect(ack.initiated).toBe(false);
    expect(ack.code).toBe('already_in_progress');
    expect(forceShutdownCalls).toBe(1);
    expect(
      reports.some((report) =>
        (report as Error).message.includes(
          'shutdown notification after manual',
        ),
      ),
    ).toBe(true);

    await sleep(250);
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
        (report as Error).message.includes(
          'shutdown notification after manual',
        ),
      ),
    ).toBe(true);

    await sleep(150);
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

    await sleep(250);
    expect(manager.getLastShutdownResult()?.success).toBe(true);
  });

  test('manual requests count toward escalation when opted in', async () => {
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

    await manager.triggerShutdown();
    await manager.triggerShutdown();
    await manager.triggerShutdown();

    expect(forceShutdownCalls).toBe(1);
    await sleep(250);
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

    // `stopAllComponentsInternal` owns the manual-retry-while-armed split, so this
    // must advance the count by exactly one - the same as `stopAllComponents()`.
    // Counting it in the request path too would reach forceAfterCount on this one
    // call and force-kill from a single programmatic request.
    await manager.triggerShutdown();

    expect(manager.getShutdownEscalationStatus().requestCount).toBe(1);
    expect(forceShutdownCalls).toBe(0);
  });
});
