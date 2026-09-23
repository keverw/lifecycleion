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
    expect(hasReport(reports, 'lifecycle-manager startComponent')).toBe(true);
  });

  test('a throwing component getter resolves checkAllHealth with an error report', async () => {
    const { logger, manager } = setup();
    const component = new Plain(logger, 'a');
    await manager.registerComponent(component);
    await manager.startAllComponents();

    const originalGetName = component.getName.bind(component);
    component.getName = (): never => {
      throw new Error('getter exploded');
    };

    const { release } = claimReports();
    let report;

    try {
      report = await manager.checkAllHealth();
    } finally {
      component.getName = originalGetName;
      release();
    }

    expect(report.healthy).toBe(false);
    expect(report.code).toBe('error');
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
