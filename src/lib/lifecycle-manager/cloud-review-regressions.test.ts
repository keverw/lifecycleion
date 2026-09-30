import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, deferred, Plain, setup } from './test-helpers';

class Reporter extends Plain {
  public reportStopped(): void {
    this.reportUnexpectedStop();
  }
}

test('unregister cancels an auto-start reserved in the restart gap', async () => {
  const { logger, manager } = setup();
  const first = new Plain(logger, 'first');
  await manager.registerComponent(first);
  await manager.startComponent('first');
  let registration: ReturnType<typeof manager.registerComponent> | undefined;
  let removal: ReturnType<typeof manager.unregisterComponent> | undefined;
  manager.once('lifecycle-manager:shutdown-completed', () => {
    queueMicrotask(() => {
      registration = manager.registerComponent(new Plain(logger, 'late'), {
        autoStart: true,
      });
      removal = manager.unregisterComponent('late');
    });
  });
  const reports = claimReports();
  try {
    const result = await manager.restartAllComponents();
    expect((await registration)?.autoStartDeferred).toBe(true);
    expect((await removal)?.success).toBe(true);
    expect(result.success).toBe(true);
    expect(manager.getRunningComponentNames()).toEqual(['first']);
    expect(reports.reports).toEqual([]);
  } finally {
    reports.release();
    await manager.stopAllComponents();
  }
});

test('a shutdown started by the starting log is observed by the start attempt', async () => {
  let onLog = (_message: string): void => {};
  const logger = new Logger({
    sinks: [{ write: (entry) => onLog(entry.message) }],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const component = new Plain(logger, 'x');
  let stopCalls = 0;
  component.stop = () => {
    stopCalls++;
    return Promise.resolve();
  };
  await manager.registerComponent(component);
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  onLog = (message) => {
    if (message === 'Starting component') {
      onLog = () => {};
      shutdown = manager.stopAllComponents();
    }
  };
  const gate = deferred();
  component.start = () => gate.promise;
  const starting = manager.startComponent('x');
  gate.resolve();
  const result = await starting;
  expect((await shutdown)?.success).toBe(true);
  expect(result.code).toBe('shutdown_in_progress');
  expect(manager.getRunningComponentNames()).toEqual([]);
  expect(stopCalls).toBe(1);
});

test('an obsolete start deadline never aborts the newer run', async () => {
  const { logger, manager } = setup();
  const component = new Reporter(logger, 'x');
  const oldStart = deferred();
  let calls = 0;
  let abortCalls = 0;
  component.start = () =>
    ++calls === 1 ? oldStart.promise : Promise.resolve();
  component.onStartupAborted = () => {
    abortCalls++;
  };
  await manager.registerComponent(component);
  Object.defineProperty(component, 'startupTimeoutMS', { value: 10 });
  const first = manager.startComponent('x');
  component.reportStopped();
  expect((await manager.startComponent('x')).success).toBe(true);
  await first;
  expect(abortCalls).toBe(0);
  expect(manager.getComponentStatus('x')?.state).toBe('running');
  oldStart.resolve();
  await manager.stopAllComponents();
});

for (const trigger of [
  'Required component failed to start',
  'Component failed to start',
]) {
  test(`shutdown from ${trigger} owns cleanup instead of startup rollback`, async () => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      sinks: [{ write: (entry) => onLog(entry.message) }],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const a = new Plain(logger, 'a');
    const b = new Plain(logger, 'b', ['a']);
    const stop = deferred();
    a.stop = () => stop.promise;
    b.start = () => Promise.reject(new Error('failed'));
    await manager.registerComponent(a);
    await manager.registerComponent(b);
    let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
    onLog = (message) => {
      if (message.startsWith(trigger)) {
        onLog = () => {};
        shutdown = manager.stopAllComponents();
      }
    };
    try {
      const startup = manager.startAllComponents();
      // Awaiting startup must not await a second rollback's stop gate.
      const result = await Promise.race([
        startup,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('startup waited for rollback')),
            100,
          ),
        ),
      ]);
      expect(shutdown).toBeDefined();
      expect(result.code).toBe('shutdown_in_progress');
    } finally {
      stop.resolve();
      await shutdown;
      await manager.stopAllComponents();
    }
  });
}

test('shutdown preserves dependencies of an in-flight start and reports incomplete cleanup', async () => {
  const { logger, manager } = setup();
  const a = new Plain(logger, 'a');
  const c = new Plain(logger, 'c', ['a']);
  const e = new Plain(logger, 'e', ['c']);
  const gate = deferred();
  e.start = () => gate.promise;
  await manager.registerComponent(a);
  await manager.registerComponent(c);
  await manager.registerComponent(e);
  await manager.startComponent('a');
  await manager.startComponent('c');
  const starting = manager.startComponent('e');
  try {
    const result = await manager.stopAllComponents({ timeoutMS: 10 });
    expect(result.success).toBe(false);
    expect(result.code).toBe('shutdown_timeout');
    expect(result.stoppedComponents).toEqual([]);
    expect(manager.getComponentStatus('a')?.state).toBe('running');
    expect(manager.getComponentStatus('c')?.state).toBe('running');
  } finally {
    gate.resolve();
    await starting;
    await manager.stopAllComponents();
  }
});

test('startup rollback preserves dependencies of independently started work', async () => {
  const { logger, manager } = setup();
  const a = new Plain(logger, 'a');
  const b = new Plain(logger, 'b', ['a']);
  const z = new Plain(logger, 'z', ['a']);
  const gate = deferred();
  z.start = () => gate.promise;
  let independent: ReturnType<typeof manager.startComponent> | undefined;
  b.start = () => {
    independent = manager.startComponent('z', { allowDuringBulkStartup: true });
    return Promise.reject(new Error('required failure'));
  };
  await manager.registerComponent(a);
  await manager.registerComponent(b);
  await manager.registerComponent(z);
  try {
    const result = await manager.startAllComponents();
    expect(result.success).toBe(false);
    expect(result.startedComponents).toContain('a');
    expect(manager.getComponentStatus('a')?.state).toBe('running');
  } finally {
    gate.resolve();
    await independent;
    await manager.stopAllComponents();
  }
});

test('restart skips startup when its stop phase reaches the deadline', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 1000 });
  const a = new Plain(logger, 'a');
  const warning = deferred();
  a.onShutdownWarning = () => warning.promise;
  let starts = 0;
  a.start = () => {
    starts++;
    return Promise.resolve();
  };
  await manager.registerComponent(a);
  await manager.startComponent('a');
  try {
    const result = await manager.restartAllComponents({
      shutdownTimeoutMS: 10,
    });
    expect(result.shutdownResult.code).toBe('shutdown_timeout');
    expect(result.startupResult.success).toBe(false);
    expect(result.startupResult.reason).toContain('startup skipped');
    expect(starts).toBe(1);
  } finally {
    warning.resolve();
    await manager.stopAllComponents();
  }
});

test('a real signals-detached listener reattaches before the auto-detach log decision', async () => {
  const messages: string[] = [];
  const logger = new Logger({
    sinks: [
      {
        write: (entry) => {
          messages.push(entry.message);
        },
      },
    ],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    attachSignalsOnStart: true,
    detachSignalsOnStop: true,
  });
  const a = new Plain(logger, 'a');
  await manager.registerComponent(a);
  await manager.startComponent('a');
  manager.once('lifecycle-manager:signals-detached', () =>
    manager.attachSignals(),
  );
  try {
    await manager.stopComponent('a');
    expect(manager.getSignalStatus().isAttached).toBe(true);
    expect(
      messages.some((line) => line.includes('Auto-detached process signals')),
    ).toBe(false);
  } finally {
    manager.detachSignals();
  }
});

test('shutdown from a rollback force getter owns the stop claim', async () => {
  const { logger, manager } = setup();
  const a = new Plain(logger, 'a');
  const b = new Plain(logger, 'b', ['a']);
  const stop = deferred();
  a.stop = () => stop.promise;
  b.start = () => Promise.reject(new Error('failed'));
  await manager.registerComponent(a);
  await manager.registerComponent(b);
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  Object.defineProperty(a, 'onShutdownForce', {
    get: () => {
      shutdown ??= manager.stopAllComponents();
      return undefined;
    },
  });
  try {
    const startup = manager.startAllComponents();
    const result = await Promise.race([
      startup,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('rollback stole shutdown')), 100),
      ),
    ]);
    expect(result.code).toBe('shutdown_in_progress');
  } finally {
    stop.resolve();
    await shutdown;
    await manager.stopAllComponents();
  }
});

test('a bulk deadline callback cannot abort the replacement start it triggers', async () => {
  let onLog = (_message: string): void => {};
  const logger = new Logger({
    sinks: [{ write: (entry) => onLog(entry.message) }],
    callProcessExit: false,
  });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const component = new Reporter(logger, 'x');
  const gate = deferred();
  let starts = 0;
  let aborts = 0;
  component.start = () => (++starts === 1 ? gate.promise : Promise.resolve());
  component.onStartupAborted = () => {
    aborts++;
  };
  await manager.registerComponent(component);
  let replacement: ReturnType<typeof manager.startComponent> | undefined;
  onLog = (message) => {
    if (message.startsWith('Startup timed out, stopping')) {
      onLog = () => {};
      component.reportStopped();
      replacement = manager.startComponent('x', {
        allowDuringBulkStartup: true,
      });
    }
  };
  try {
    await manager.startAllComponents({ timeoutMS: 10 });
    expect((await replacement)?.success).toBe(true);
    expect(aborts).toBe(0);
  } finally {
    gate.resolve();
    await manager.stopAllComponents();
  }
});

test('reconciled required-stop rollback yields to shutdown from its preparation getter', async () => {
  const { logger, manager } = setup();
  const a = new Reporter(logger, 'a');
  const b = new Plain(logger, 'b');
  const stop = deferred();
  b.start = () => {
    a.reportStopped();
    return Promise.resolve();
  };
  b.stop = () => stop.promise;
  await manager.registerComponent(a);
  await manager.registerComponent(b);
  let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
  Object.defineProperty(b, 'onShutdownForce', {
    get: () => {
      shutdown ??= manager.stopAllComponents();
      return undefined;
    },
  });
  try {
    const result = await manager.startAllComponents();
    expect(result.code).toBe('shutdown_in_progress');
  } finally {
    stop.resolve();
    await shutdown;
    await manager.stopAllComponents();
  }
});
