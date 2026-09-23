import { describe, test, expect } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import type { LifecycleManagerOptions } from './types';

// Every public async method answers with a result object rather than a rejection, so a
// caller can fire one without awaiting it. These cover the paths that used to reject -
// and, worse, the ones that rejected with manager state still held.

function setup(options: Partial<LifecycleManagerOptions> = {}) {
  const logger = new Logger({
    sinks: [new ArraySink()],
    callProcessExit: false,
  });

  return {
    logger,
    manager: new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
      ...options,
    }),
  };
}

// Claims every report on the global `'error'` channel until `release()`: asserts they
// were made, and keeps the `console.error` fall-through out of the test output.
function claimReports(): { reports: unknown[]; release: () => void } {
  const reports: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };

  globalThis.addEventListener('error', onError);

  return {
    reports,
    release: () => {
      globalThis.removeEventListener('error', onError);
    },
  };
}

function hasReport(reports: unknown[], text: string): boolean {
  return reports.some((report) => (report as Error).message.includes(text));
}

class Plain extends BaseComponent {
  public forceCalls = 0;

  constructor(logger: Logger, name: string) {
    super(logger, { name, dependencies: [] });
  }

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public onShutdownForce(): void {
    this.forceCalls++;
  }
}

// Stands in for an attached `ProcessSignalManager`, so the auto-detach paths run without
// touching the real process's signal handlers.
function fakeAttachedSignals(manager: LifecycleManager): void {
  (
    manager as unknown as {
      processSignalManager: { getStatus: () => { isAttached: boolean } };
    }
  ).processSignalManager = { getStatus: () => ({ isAttached: true }) };
}

describe('LifecycleManager - public methods never reject', () => {
  test('a signal attach that throws refuses bulk startup without wedging it', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);

    manager.attachSignals = (): never => {
      throw new Error('attach exploded');
    };

    const result = await manager.startAllComponents();

    // A process configured to handle signals does not come up without them, and the
    // refusal happens before anything is started or latched.
    expect(result.success).toBe(false);
    expect(result.code).toBe('signal_attach_failed');
    expect(result.error?.message).toBe('attach exploded');
    expect(result.startedComponents).toEqual([]);
    expect(manager.isComponentRunning('a')).toBe(false);
    expect(manager.getSystemState()).not.toBe('starting');

    // `isStarting` used to stay set for good here, refusing every later start with
    // `already_in_progress`. Once attaching works, startup goes ahead. Faked rather than
    // real, so the test never installs process-wide handlers.
    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
    };

    const retry = await manager.startAllComponents();

    expect(retry.success).toBe(true);
    expect(manager.isComponentRunning('a')).toBe(true);
  });

  test('a signal attach that throws takes the first started component back down', async () => {
    const { logger, manager } = setup({ attachSignalsOnStart: true });
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);

    const events: string[] = [];
    manager.on('component:started', () => {
      events.push('started');
    });
    manager.on('component:stopped', () => {
      events.push('stopped');
    });

    manager.attachSignals = (): never => {
      throw new Error('attach exploded');
    };

    const result = await manager.startComponent('a');

    // `attachSignalsOnStart` still attaches only once a component is actually up. When it
    // cannot, that component does not stay up without signal handling.
    expect(result.success).toBe(false);
    expect(result.code).toBe('signal_attach_failed');
    expect(result.error?.message).toBe('attach exploded');
    expect(result.reason).toContain('component stopped again');
    expect(events).toEqual(['started', 'stopped']);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    expect(manager.isComponentRunning('a')).toBe(false);
  });

  test('a signal attach that throws under attachSignalsOnStart fails bulk startup', async () => {
    const { logger, manager } = setup({ attachSignalsOnStart: true });
    await manager.registerComponent(new Plain(logger, 'a'));

    manager.attachSignals = (): never => {
      throw new Error('attach exploded');
    };

    const result = await manager.startAllComponents();

    expect(result.success).toBe(false);
    expect(result.code).toBe('signal_attach_failed');
    expect(manager.isComponentRunning('a')).toBe(false);
    expect(manager.getSystemState()).not.toBe('starting');
  });

  test('a signal detach that throws does not send a clean stop to the force phase', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');

    fakeAttachedSignals(manager);
    manager.detachSignals = (): never => {
      throw new Error('detach exploded');
    };

    const { reports, release } = claimReports();
    let result;

    try {
      result = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(true);
    expect(component.forceCalls).toBe(0);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
    expect(hasReport(reports, 'signal detach after last component stop')).toBe(
      true,
    );
  });

  test('a signal detach that throws does not fail an unregister that already happened', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    await manager.registerComponent(new Plain(logger, 'a'));

    fakeAttachedSignals(manager);
    manager.detachSignals = (): never => {
      throw new Error('detach exploded');
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.unregisterComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(true);
    expect(manager.hasComponent('a')).toBe(false);
  });

  test('a throwing component getter resolves startComponent with unknown_error', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);

    component.getDependencies = (): never => {
      throw new Error('getter exploded');
    };

    const { reports, release } = claimReports();
    let result;

    try {
      result = await manager.startComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.componentName).toBe('a');
    expect(result.error?.message).toBe('getter exploded');
    expect(hasReport(reports, 'lifecycle-manager component start')).toBe(true);
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });

  test('a getName() that throws after registration no longer reaches the manager', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    // The name was recorded at registration, so nothing asks for it again: every
    // operation that used to re-read it - and crash on it - carries on.
    component.getName = (): never => {
      throw new Error('getter exploded');
    };

    const report = await manager.checkAllHealth();
    expect(report.healthy).toBe(true);
    expect(report.components.map((entry) => entry.name)).toEqual(['a']);

    const broadcast = await manager.broadcastMessage('hi');
    expect(broadcast.map((entry) => entry.name)).toEqual(['a']);

    expect(manager.getComponentNames()).toEqual(['a']);
    expect((await manager.stopAllComponents()).stoppedComponents).toEqual([
      'a',
    ]);
    expect((await manager.unregisterComponent('a')).success).toBe(true);
  });

  test('registering something that is not a component resolves with unknown_error', async () => {
    const { manager } = setup();
    const { release } = claimReports();
    let result;

    try {
      result = await manager.registerComponent(
        null as unknown as BaseComponent,
      );
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.registered).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.componentName).toBe('<unknown>');
    expect(manager.getComponentCount()).toBe(0);
  });

  test('a registration that fails after the commit reports the component as registered', async () => {
    const { logger, manager } = setup();
    const internals = manager as unknown as {
      startComponentInternal: () => Promise<unknown>;
    };

    // Past the commit: the auto-start is the first thing that runs once the component is
    // in the registry.
    internals.startComponentInternal = (): never => {
      throw new Error('auto-start exploded');
    };

    const result = await manager.registerComponent(new Plain(logger, 'a'), {
      autoStart: true,
    });

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.registered).toBe(true);
    expect(result.registrationIndexAfter).toBe(0);
    expect(manager.hasComponent('a')).toBe(true);
  });

  test('a registration that fails after the commit emits registered, not rejected', async () => {
    const { logger, manager } = setup();
    const internals = manager as unknown as {
      startComponentInternal: () => Promise<unknown>;
    };

    internals.startComponentInternal = (): never => {
      throw new Error('auto-start exploded');
    };

    const events: string[] = [];
    manager.on('component:registered', () => {
      events.push('registered');
    });
    manager.on('component:registration-rejected', () => {
      events.push('rejected');
    });

    const result = await manager.registerComponent(new Plain(logger, 'a'), {
      autoStart: true,
    });

    // The event agrees with the registry and the result.
    expect(result.registered).toBe(true);
    expect(events).toEqual(['registered']);
  });

  test('a crash partway through bulk startup rolls back what it started', async () => {
    const { logger, manager } = setup();
    const first = new Plain(logger, 'first');
    const second = new Plain(logger, 'second');
    await manager.registerComponent(first);
    await manager.registerComponent(second);

    // `second` fails to start, and the optional check on that failure path is what
    // throws - after `first` is already running.
    second.start = (): Promise<void> =>
      Promise.reject(new Error('start failed'));
    second.isOptional = (): never => {
      throw new Error('getter exploded');
    };

    const { reports, release } = claimReports();
    let result;

    try {
      result = await manager.startAllComponents();
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.error?.message).toBe('getter exploded');
    // Rolled back, and the result matches: nothing is claimed that is not running, and
    // nothing is left running that is not claimed.
    expect(result.startedComponents).toEqual([]);
    expect(manager.isComponentRunning('first')).toBe(false);
    expect(manager.getSystemState()).not.toBe('starting');
    expect(hasReport(reports, 'lifecycle-manager startAllComponents')).toBe(
      true,
    );
  });

  test('an attachSignalsOnStart failure fails bulk startup even for optional components', async () => {
    const { logger, manager } = setup({ attachSignalsOnStart: true });

    class OptionalPlain extends BaseComponent {
      constructor(name: string) {
        super(logger, { name, dependencies: [], optional: true });
      }

      public async start(): Promise<void> {}
      public async stop(): Promise<void> {}
    }

    await manager.registerComponent(new OptionalPlain('a'));
    await manager.registerComponent(new OptionalPlain('b'));

    let attachCalls = 0;
    manager.attachSignals = (): never => {
      attachCalls++;
      throw new Error('attach exploded');
    };

    let didEmitStarted = false;
    manager.on('lifecycle-manager:started', () => {
      didEmitStarted = true;
    });

    const result = await manager.startAllComponents();

    // Not a failed optional component to skip past: the startup as a whole cannot come
    // up with the signal handling it was configured for.
    expect(result.success).toBe(false);
    expect(result.code).toBe('signal_attach_failed');
    expect(result.error?.message).toBe('attach exploded');
    expect(attachCalls).toBe(1);
    expect(didEmitStarted).toBe(false);
    expect(manager.getRunningComponentNames()).toEqual([]);
  });

  test('a signals-attached listener cannot start a second bulk startup', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    const component = new Plain(logger, 'a');
    let startCalls = 0;
    component.start = (): Promise<void> => {
      startCalls++;

      return Promise.resolve();
    };
    await manager.registerComponent(component);

    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };

    const nested: Promise<{ code?: string }>[] = [];
    manager.once('lifecycle-manager:signals-attached', () => {
      nested.push(manager.startAllComponents());
    });

    const result = await manager.startAllComponents();

    // The latch was already up when the listener ran, so the nested call is refused
    // rather than running alongside this one.
    expect(result.success).toBe(true);
    expect((await nested[0])?.code).toBe('already_in_progress');
    expect(startCalls).toBe(1);
  });

  test('a signals-attached listener cannot start the same component twice', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    const component = new Plain(logger, 'a');
    let startCalls = 0;
    component.start = (): Promise<void> => {
      startCalls++;

      return Promise.resolve();
    };
    await manager.registerComponent(component);

    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };

    const nested: Promise<{ code?: string }>[] = [];
    manager.once('lifecycle-manager:signals-attached', () => {
      nested.push(manager.startComponent('a'));
    });

    const result = await manager.startComponent('a');

    expect(result.success).toBe(true);
    expect((await nested[0])?.code).toBe('component_already_starting');
    expect(startCalls).toBe(1);
  });

  test('a failed signal attach puts the component back as it was', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    await manager.registerComponent(new Plain(logger, 'a'));

    manager.attachSignals = (): never => {
      throw new Error('attach exploded');
    };

    const result = await manager.startComponent('a');

    expect(result.code).toBe('signal_attach_failed');
    expect(manager.getComponentStatus('a')?.state).toBe('registered');
  });

  test('a stop that crashes after claiming the component leaves it stalled, not stopping', async () => {
    const { logger, manager } = setup();

    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');

    // Read once the component is already claimed as `stopping`, outside any `try`.
    Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');

    // `stalled` rather than stuck in `stopping`: it can be retried or unregistered.
    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
    expect(
      (await manager.unregisterComponent('a', { stopIfRunning: false }))
        .success,
    ).toBe(true);
  });

  test('a restart stop phase does not count toward escalation', async () => {
    let forceShutdownCalls = 0;
    const { logger, manager } = setup({
      shutdownOptions: { timeoutMS: 50, retryStalled: false },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 1,
        withinMS: 5000,
        armedAfterFailureMS: 60_000,
        countManualRetriesTowardEscalation: true,
        onForceShutdown: () => {
          forceShutdownCalls++;
        },
      },
    });

    let isStuck = true;
    const component = new Plain(logger, 'a');
    component.stop = (): Promise<void> =>
      isStuck ? new Promise<void>(() => {}) : Promise.resolve();
    await manager.registerComponent(component);
    await manager.startAllComponents();

    expect((await manager.stopAllComponents()).success).toBe(false);
    expect(manager.getShutdownEscalationStatus().isArmed).toBe(true);

    isStuck = false;
    await manager.restartAllComponents();

    // A stop call here would reach `forceAfterCount` and force-kill; a restart must not.
    expect(forceShutdownCalls).toBe(0);
  });

  test('a signals-attached listener that starts a shutdown refuses the bulk startup', async () => {
    const { logger, manager } = setup({ attachSignalsBeforeStartup: true });
    const component = new Plain(logger, 'a');
    let startCalls = 0;
    component.start = (): Promise<void> => {
      startCalls++;

      return Promise.resolve();
    };
    await manager.registerComponent(component);

    manager.attachSignals = (): void => {
      fakeAttachedSignals(manager);
      (
        manager as unknown as {
          lifecycleEvents: { lifecycleManagerSignalsAttached: () => void };
        }
      ).lifecycleEvents.lifecycleManagerSignalsAttached();
    };

    const nested: Promise<unknown>[] = [];
    manager.once('lifecycle-manager:signals-attached', () => {
      nested.push(manager.stopAllComponents());
    });

    const result = await manager.startAllComponents();
    await Promise.all(nested);

    expect(result.code).toBe('shutdown_in_progress');
    expect(startCalls).toBe(0);
    expect(manager.getSystemState()).not.toBe('starting');
  });

  test('a crashed start keeps the state the component had before it', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');
    await manager.stopComponent('a');
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');

    // Read after the component is claimed as `starting`, outside the attempt's `try`.
    Object.defineProperty(component, 'startupTimeoutMS', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.startComponent('a');
    } finally {
      release();
    }

    expect(result.code).toBe('unknown_error');
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('component-scoped messaging resolves on an unexpected failure', async () => {
    const { logger, manager } = setup();
    const sender = new Plain(logger, 'sender');
    const target = new Plain(logger, 'target');
    await manager.registerComponent(sender);
    await manager.registerComponent(target);
    await manager.startAllComponents();

    // Read while the message is being delivered, outside any guard of its own.
    Object.defineProperty(target, 'onMessage', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const lifecycle = (
      sender as unknown as {
        lifecycle: {
          sendMessageToComponent(
            name: string,
            payload: unknown,
          ): Promise<{ code: string; error: Error | null }>;
        };
      }
    ).lifecycle;

    const { release } = claimReports();
    let result;

    try {
      result = await lifecycle.sendMessageToComponent('target', 'hi');
    } finally {
      release();
    }

    expect(result.code).toBe('error');
    expect(result.error?.message).toBe('getter exploded');
  });

  test('a start that crashes after the component is running stops it again', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));

    // The success path builds the component's status once it is already running.
    const originalGetStatus = manager.getComponentStatus.bind(manager);
    let shouldThrow = true;
    manager.getComponentStatus = (
      name: string,
    ): ReturnType<LifecycleManager['getComponentStatus']> => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('status exploded');
      }

      return originalGetStatus(name);
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.startComponent('a');
    } finally {
      release();
    }

    // A failed start means a component that is not running.
    expect(result.success).toBe(false);
    expect(result.code).toBe('unknown_error');
    expect(result.reason).toContain('component stopped again');
    expect(manager.isComponentRunning('a')).toBe(false);
  });

  test('a stop that crashes into a stall still detaches signals after the last component', async () => {
    const { logger, manager } = setup({ detachSignalsOnStop: true });
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');

    fakeAttachedSignals(manager);
    let detachCalls = 0;
    manager.detachSignals = (): void => {
      detachCalls++;
    };

    Object.defineProperty(component, 'shutdownGracefulTimeoutMS', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const { release } = claimReports();

    try {
      await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(manager.getComponentStatus('a')?.state).toBe('stalled');
    expect(detachCalls).toBe(1);
  });

  test('a component that crashes a broadcast only loses its own entry', async () => {
    const { logger, manager } = setup();
    const good = new Plain(logger, 'good');
    const received: unknown[] = [];
    (good as unknown as { onMessage: (payload: unknown) => string }).onMessage =
      (payload: unknown): string => {
        received.push(payload);

        return 'ok';
      };
    const bad = new Plain(logger, 'bad');
    await manager.registerComponent(good);
    await manager.registerComponent(bad);
    await manager.startAllComponents();

    // Fails the message to this one component, after its name has been read.
    (bad as unknown as { onMessage: unknown }).onMessage = undefined;
    Object.defineProperty(bad, 'onMessage', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const { release } = claimReports();
    let results;

    try {
      results = await manager.broadcastMessage('hi');
    } finally {
      release();
    }

    expect(received).toEqual(['hi']);
    expect(results.find((entry) => entry.name === 'good')?.data).toBe('ok');
    expect(results.find((entry) => entry.name === 'bad')?.code).toBe('error');
  });

  test('a restart that crashes after its stop phase keeps the real stop result', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startAllComponents();

    // Read once the stop phase has finished, when the startup phase begins.
    const options = {};
    Object.defineProperty(options, 'startupOptions', {
      get: (): never => {
        throw new Error('options exploded');
      },
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.restartAllComponents(options);
    } finally {
      release();
    }

    expect(result.success).toBe(false);
    expect(result.shutdownResult.success).toBe(true);
    expect(result.shutdownResult.stoppedComponents).toEqual(['a']);
    expect(result.startupResult.code).toBe('unknown_error');
  });

  test('a signal against an expired window during a running pass emits signal:shutdown once', async () => {
    const { logger, manager } = setup({
      shutdownOptions: { timeoutMS: 50, retryStalled: false },
      repeatedShutdownRequestPolicy: {
        forceAfterCount: 5,
        withinMS: 1000,
        armedAfterFailureMS: 60_000,
        onForceShutdown: () => {},
      },
    });
    const component = new Plain(logger, 'a');
    component.stop = (): Promise<void> => new Promise<void>(() => {});
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const internals = manager as unknown as {
      handleShutdownRequest: (method: string) => void;
      repeatedShutdownRequestState: { remainsArmedUntil: number | null };
    };
    const signals: unknown[] = [];
    manager.on('signal:shutdown', (payload) => {
      signals.push(payload);
    });

    // Armed by the failing pass while its latch is still held; lapse the window and
    // send a signal from right there.
    manager.once('lifecycle-manager:shutdown-escalation-armed', () => {
      internals.repeatedShutdownRequestState.remainsArmedUntil = Date.now() - 1;
      internals.handleShutdownRequest('SIGTERM');
    });

    await manager.stopAllComponents();

    expect(signals).toHaveLength(1);
  });

  test('a crashed start of an already-running component leaves it running', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'a'));
    await manager.startComponent('a');

    // The `component_already_running` refusal builds a status; make that throw once.
    const originalGetStatus = manager.getComponentStatus.bind(manager);
    let shouldThrow = true;
    manager.getComponentStatus = (
      name: string,
    ): ReturnType<LifecycleManager['getComponentStatus']> => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('status exploded');
      }

      return originalGetStatus(name);
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.startComponent('a');
    } finally {
      release();
    }

    expect(result.code).toBe('unknown_error');
    // This attempt never ran the component, so it must not stop the run it found.
    expect(manager.isComponentRunning('a')).toBe(true);
  });

  test('a crashed second stop does not stall a stop already in progress', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    let finishStop = (): void => {};
    component.stop = (): Promise<void> =>
      new Promise<void>((resolve) => {
        finishStop = resolve;
      });
    await manager.registerComponent(component);
    await manager.startComponent('a');

    const firstStop = manager.stopComponent('a');
    expect(manager.getComponentStatus('a')?.state).toBe('stopping');

    // The second stop's `component_already_stopping` refusal builds a status.
    const originalGetStatus = manager.getComponentStatus.bind(manager);
    let shouldThrow = true;
    manager.getComponentStatus = (
      name: string,
    ): ReturnType<LifecycleManager['getComponentStatus']> => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error('status exploded');
      }

      return originalGetStatus(name);
    };

    const { release } = claimReports();
    let second;

    try {
      second = await manager.stopComponent('a');
    } finally {
      release();
    }

    expect(second.code).toBe('unknown_error');
    expect(manager.getComponentStatus('a')?.state).toBe('stopping');

    finishStop();
    expect((await firstStop).success).toBe(true);
    expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  });

  test('the broadcast handed to a reload callback cannot reject', async () => {
    let fired: Promise<{ code: string }> | undefined;
    const { manager } = setup({
      onReloadRequested: (broadcast): void => {
        fired = broadcast();
      },
    });

    (
      manager as unknown as { broadcastReload: () => Promise<never> }
    ).broadcastReload = (): Promise<never> =>
      Promise.reject(new Error('broadcast exploded'));

    const { release } = claimReports();

    try {
      await manager.triggerReload();
      expect((await fired)?.code).toBe('error');
    } finally {
      release();
    }
  });

  test('getValue() resolves an unexpected failure as an error result', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startComponent('a');

    Object.defineProperty(component, 'getValue', {
      get: (): never => {
        throw new Error('getter exploded');
      },
    });

    const { reports, release } = claimReports();
    let result;

    try {
      result = manager.getValue('a', 'key');
    } finally {
      release();
    }

    expect(result.code).toBe('error');
    expect(result.error?.message).toBe('getter exploded');
    expect(hasReport(reports, 'lifecycle-manager getValue')).toBe(true);
  });

  test('an unregister hook that throws still removes the component completely', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);

    (
      component as unknown as { _markUnregistered: () => void }
    )._markUnregistered = (): never => {
      throw new Error('hook exploded');
    };

    const { release } = claimReports();
    let result;

    try {
      result = await manager.unregisterComponent('a');
    } finally {
      release();
    }

    expect(result.success).toBe(true);
    expect(manager.hasComponent('a')).toBe(false);
    expect(manager.getComponentStatus('a')).toBeUndefined();
  });

  test('a throwing reload callback resolves triggerReload with an error result', async () => {
    const { manager } = setup({
      onReloadRequested: (): never => {
        throw new Error('reload exploded');
      },
    });

    const { reports, release } = claimReports();
    let result;

    try {
      result = await manager.triggerReload();
    } finally {
      release();
    }

    expect(result.signal).toBe('reload');
    expect(result.code).toBe('error');
    expect(result.error?.message).toBe('reload exploded');
    expect(hasReport(reports, 'reload request callback')).toBe(true);
  });

  test('a rejecting info callback resolves triggerInfo with an error result', async () => {
    const { manager } = setup({
      onInfoRequested: (): Promise<never> =>
        Promise.reject(new Error('info exploded')),
    });

    const { release } = claimReports();
    let result;

    try {
      result = await manager.triggerInfo();
    } finally {
      release();
    }

    expect(result.signal).toBe('info');
    expect(result.code).toBe('error');
  });
});
