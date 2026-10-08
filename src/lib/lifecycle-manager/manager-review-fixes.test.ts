import { describe, expect, test } from 'bun:test';
import { sleep } from '../sleep';
import { BaseComponent } from './base-component';
import type { Logger } from '../logger';
import { invalidOperationOptionError } from './internal/operation-policy';
import type { ForceShutdownContext } from './types';
import {
  claimReports,
  deferred,
  fakeSignals,
  Plain,
  sendSignal,
  setup,
} from './test-helpers';

// A start that resolves (or rejects) only when the test says so, past a short deadline,
// and a stop that never settles - so the late-start cleanup's stop stalls.
class LateStart extends BaseComponent {
  public readonly gate = deferred();

  constructor(logger: Logger, name = 'late') {
    super(logger, {
      name,
      startupTimeoutMS: 20,
    });
    // Below the constructor's floors, so a stalled stop settles within the test.
    Object.defineProperty(this, 'shutdownGracefulTimeoutMS', { value: 20 });
    Object.defineProperty(this, 'shutdownForceTimeoutMS', { value: 20 });
  }

  public start(): Promise<void> {
    return this.gate.promise;
  }

  public stop(): Promise<void> {
    return new Promise(() => {});
  }
}

describe('signals while a timed-out start is still pending', () => {
  test('stay attached so a stalled late-start cleanup can still be reached', async () => {
    const { logger, manager } = setup({
      attachSignalsBeforeStartup: true,
      detachSignalsOnStop: true,
    });
    const signals = fakeSignals(manager);
    const component = new LateStart(logger);
    await manager.registerComponent(component);

    const result = await manager.startComponent('late');
    expect(result.code).toBe('component_startup_timeout');
    // Nothing is running, but the abandoned start may still come up.
    expect(signals.isAttached()).toBe(true);

    component.gate.resolve();
    await sleep(120);

    expect(manager.getComponentStatus('late')?.state).toBe('stalled');
    expect(signals.isAttached()).toBe(true);
    expect(signals.detachCalls()).toBe(0);
  });

  test('come off once the abandoned start rejects', async () => {
    const { logger, manager } = setup({
      attachSignalsBeforeStartup: true,
      detachSignalsOnStop: true,
    });
    const signals = fakeSignals(manager);
    const component = new LateStart(logger);
    await manager.registerComponent(component);

    await manager.startComponent('late');
    expect(signals.isAttached()).toBe(true);

    component.gate.reject(new Error('late failure'));
    await sleep(20);

    expect(manager.getComponentStatus('late')?.state).toBe(
      'starting-timed-out',
    );
    expect(signals.isAttached()).toBe(false);
    expect(signals.detachCalls()).toBe(1);
  });
});

// A stop that settles only when the test says so, and a force handler that never does,
// both past short deadlines - so every stop of it stalls until the original stop ends.
class SlowStop extends BaseComponent {
  public readonly stopGate = deferred();
  public forceCalls = 0;

  constructor(logger: Logger) {
    super(logger, { name: 'slow' });
    Object.defineProperty(this, 'shutdownGracefulTimeoutMS', { value: 20 });
    Object.defineProperty(this, 'shutdownForceTimeoutMS', { value: 20 });
  }

  public async start(): Promise<void> {}

  public stop(): Promise<void> {
    return this.stopGate.promise;
  }

  public onShutdownForce(): Promise<void> {
    this.forceCalls++;
    return new Promise(() => {});
  }
}

describe('late resolution across a stalled retry', () => {
  test('the original stop finishing after the retry stalled again clears the stall', async () => {
    const { logger, manager } = setup();
    const component = new SlowStop(logger);
    const resolvedStalls: string[] = [];
    manager.on('component:stalled-resolved', (data: { name: string }) => {
      resolvedStalls.push(data.name);
    });
    await manager.registerComponent(component);
    await manager.startComponent('slow');

    const stop = await manager.stopComponent('slow');
    expect(stop.success).toBe(false);
    expect(manager.getComponentStatus('slow')?.state).toBe('stalled');

    const retry = await manager.stopAllComponents({ retryStalled: true });
    expect(retry.success).toBe(false);
    expect(component.forceCalls).toBe(2);
    expect(manager.getComponentStatus('slow')?.state).toBe('stalled');

    component.stopGate.resolve();
    await sleep(10);

    expect(manager.getComponentStatus('slow')?.state).toBe('stopped');
    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(resolvedStalls).toEqual(['slow']);
  });

  test('the original stop finishing while the retry runs ends the retry as stopped', async () => {
    const { logger, manager } = setup();
    const component = new SlowStop(logger);
    await manager.registerComponent(component);
    await manager.startComponent('slow');
    await manager.stopComponent('slow');
    expect(manager.getComponentStatus('slow')?.state).toBe('stalled');

    const retry = manager.stopAllComponents({ retryStalled: true });
    await sleep(5);
    expect(manager.getComponentStatus('slow')?.state).toBe('force-stopping');
    component.stopGate.resolve();

    const result = await retry;
    expect(result.success).toBe(true);
    expect(manager.getComponentStatus('slow')?.state).toBe('stopped');
    expect(manager.getStalledComponentNames()).toEqual([]);
  });
});

describe('a start that finishes after a shutdown began', () => {
  test('leaves a stop a started listener began alone instead of failing to stop it again', async () => {
    const { logger, manager } = setup();
    const gate = deferred();
    const component = new (class extends BaseComponent {
      public stopCalls = 0;
      public start(): Promise<void> {
        return gate.promise;
      }
      public stop(): void {
        this.stopCalls++;
      }
    })(logger, { name: 'late' });
    await manager.registerComponent(component);

    const start = manager.startComponent('late');
    await sleep(1);
    // Begins and ends a shutdown while `start()` is still pending.
    await manager.stopAllComponents({ allowStopWithPendingStarts: true });

    let listenerStop: Promise<unknown> | undefined;
    manager.on('component:started', () => {
      listenerStop = manager.stopComponent('late');
    });
    gate.resolve();

    const result = await start;
    expect(result.code).toBe('shutdown_in_progress');
    expect(result.reason).toBe('Shutdown triggered during component startup');
    expect(await listenerStop).toMatchObject({ success: true });
    expect(component.stopCalls).toBe(1);
    expect(manager.getComponentStatus('late')?.state).toBe('stopped');
  });
});

describe('a shutdown signal counted against a running pass with an armed window', () => {
  test('neither refreshes the window nor reports it as armed after failure', async () => {
    const forced: ForceShutdownContext[] = [];
    const { logger, manager } = setup({
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 10_000,
        onForceShutdown: (context) => {
          forced.push(context);
        },
      },
    });
    const component = new Plain(logger, 'a');
    const stop = deferred();
    component.stop = (): Promise<void> => stop.promise;
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const shutdown = manager.stopAllComponents();
    try {
      // As a failed pass leaves it just before its latch comes down.
      const internals = (
        manager as unknown as {
          state: {
            repeatedShutdownRequestState: { remainsArmedUntil: number | null };
            repeatedShutdownExpiryTimer: unknown;
          };
        }
      ).state;
      const armedUntil = Date.now() + 60_000;
      internals.repeatedShutdownRequestState.remainsArmedUntil = armedUntil;

      sendSignal(manager, 'SIGINT');

      expect(internals.repeatedShutdownExpiryTimer).toBeNull();
      expect(internals.repeatedShutdownRequestState.remainsArmedUntil).toBe(
        armedUntil,
      );
      expect(forced).toHaveLength(1);
      expect(forced[0]).toMatchObject({
        isShuttingDown: true,
        wasArmedAfterFailure: false,
      });
    } finally {
      stop.resolve();
      await shutdown;
    }
  });
});

describe('late-start cleanup', () => {
  test('its component:stopped carries the state the component is left in', async () => {
    const { logger, manager } = setup();
    const gate = deferred();
    const component = new (class extends BaseComponent {
      public start(): Promise<void> {
        return gate.promise;
      }
      public async stop(): Promise<void> {}
    })(logger, { name: 'late', startupTimeoutMS: 20 });
    const stoppedStates: Array<string | undefined> = [];
    manager.on('component:stopped', (data: { status?: { state: string } }) => {
      stoppedStates.push(data.status?.state);
    });
    await manager.registerComponent(component);

    const result = await manager.startComponent('late');
    expect(result.code).toBe('component_startup_timeout');

    gate.resolve();
    await sleep(20);

    const status = manager.getComponentStatus('late');
    expect(status?.state).toBe('starting-timed-out');
    expect(status?.lastError).toBe(result.error ?? null);
    expect(stoppedStates).toEqual(['starting-timed-out']);
  });
});

describe('a shutdown pass whose bookkeeping throws before its completed event', () => {
  test('still emits lifecycle-manager:shutdown-completed', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();
    const completed: Array<{ code?: string }> = [];
    manager.on(
      'lifecycle-manager:shutdown-completed',
      (data: { code?: string }) => {
        completed.push(data);
      },
    );
    // The clean pass's own detach runs ahead of its completed event.
    (
      manager as unknown as { detachSignalsIfIdle: (trigger: string) => void }
    ).detachSignalsIfIdle = (trigger: string): void => {
      if (trigger === 'shutdown') {
        throw new Error('detach bookkeeping exploded');
      }
    };

    const { reports, release } = claimReports();
    let result;
    try {
      result = await manager.stopAllComponents();
    } finally {
      release();
    }

    expect(reports).toHaveLength(1);
    expect(result.code).toBe('operation_crashed');
    expect(completed).toHaveLength(1);
    expect(completed[0].code).toBe('operation_crashed');
  });
});

describe('an option refusal thrown after an attempt claimed its component', () => {
  test('is a crash even once another claim superseded it', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    const internals = manager as unknown as {
      state: { componentClaims: Map<string, unknown> };
      clearUnexpectedStopHandler: (component: unknown, context: string) => void;
    };
    // Runs right after the start claims `a`: hands the claim to someone else, then
    // throws a branded option refusal.
    internals.clearUnexpectedStopHandler = (): void => {
      internals.state.componentClaims.set('a', {
        claim: Symbol('other'),
        previousState: 'registered',
      });
      throw invalidOperationOptionError('late option refusal');
    };

    const { reports, release } = claimReports();
    let result;
    try {
      result = await manager.startComponent('a');
    } finally {
      release();
    }

    expect(result.code).toBe('operation_crashed');
    expect(reports).toHaveLength(1);
  });
});

describe('an optional component whose failed start carries no error', () => {
  test('is reported with one error in the event and the result', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'cache');
    component.isOptional = () => true;
    await manager.registerComponent(component);
    // A refusal that answers without an `error`, as `dependency_not_running` does.
    (
      manager as unknown as {
        startComponentInternal: (name: string) => Promise<unknown>;
      }
    ).startComponentInternal = (name: string) =>
      Promise.resolve({
        success: false,
        componentName: name,
        code: 'dependency_not_running',
        reason: 'Dependency "db" is not running',
      });
    const events: Array<{ error: Error }> = [];
    manager.on('component:start-failed-optional', (data: { error: Error }) => {
      events.push(data);
    });

    const result = await manager.startAllComponents();

    expect(result.success).toBe(true);
    expect(result.failedOptionalComponents).toHaveLength(1);
    const reported = result.failedOptionalComponents[0].error;
    expect(reported.message).toBe('Dependency "db" is not running');
    expect(events).toHaveLength(1);
    expect(events[0].error).toBe(reported);
  });
});
