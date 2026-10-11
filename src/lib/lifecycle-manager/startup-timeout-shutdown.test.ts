import { expect, spyOn, test } from 'bun:test';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { deferred, Plain } from './test-helpers';

test.each(['Startup timeout exceeded', 'Startup completed with timeout'])(
  'shutdown started by %s takes precedence over the timeout snapshot',
  async (trigger) => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      sinks: [{ write: (entry) => onLog(entry.message) }],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const first = new Plain(logger, 'first');
    const last = new Plain(logger, 'last');
    const finishStop = deferred();
    first.stop = () => finishStop.promise;
    last.stop = () => finishStop.promise;
    await manager.registerComponent(first);
    await manager.registerComponent(last);
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    last.start = () => {
      now += 100;
      return Promise.resolve();
    };
    let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
    onLog = (message) => {
      if (message.includes(trigger)) {
        onLog = () => {};
        shutdown = manager.stopAllComponents();
      }
    };
    try {
      const result = await manager.startAllComponents({ timeoutMS: 50 });
      expect(shutdown).toBeDefined();
      expect(result.success).toBe(false);
      expect(result.code).toBe('shutdown_in_progress');
      // The shutdown continues after this snapshot is built; do not compare
      // its names against states observed only after awaiting the startup result.
      if (trigger === 'Startup timeout exceeded') {
        expect(result.startedComponents).not.toContain('last');
      }
    } finally {
      clock.mockRestore();
      onLog = () => {};
      finishStop.resolve();
      await shutdown;
      await manager.stopAllComponents();
    }
  },
);

class ReportingComponent extends Plain {
  public reportStopped() {
    this.reportUnexpectedStop();
  }
}

test.each([false, true])(
  'final timeout warning reconciles an unexpected stop (optional: %s)',
  async (isOptional) => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      sinks: [{ write: (entry) => onLog(entry.message) }],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const first = new ReportingComponent(logger, 'first');
    Object.defineProperty(first, 'optional', { value: isOptional });
    const second = new Plain(logger, 'second', ['first']);
    let secondStops = 0;
    second.stop = () => {
      secondStops++;
      return Promise.resolve();
    };
    await manager.registerComponent(first);
    await manager.registerComponent(second);
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    manager.on<{ name: string }>('component:started', ({ name }) => {
      if (name === 'second') {
        now += 100;
      }
    });
    let timeoutReports = 0;
    onLog = (message) => {
      if (message === 'Startup completed with timeout') {
        timeoutReports++;
        first.reportStopped();
      }
    };
    try {
      const result = await manager.startAllComponents({ timeoutMS: 50 });
      expect(timeoutReports).toBe(1);
      expect(result.code).toBe(
        isOptional ? 'startup_timeout' : 'component_unexpected_stop',
      );
      expect(result.startedComponents).toEqual(isOptional ? ['second'] : []);
      expect(result.failedOptionalComponents.map(({ name }) => name)).toEqual(
        isOptional ? ['first'] : [],
      );
      expect(secondStops).toBe(isOptional ? 0 : 1);
      expect(manager.getComponentStatus('second')?.state).toBe(
        isOptional ? 'running' : 'stopped',
      );
    } finally {
      clock.mockRestore();
      onLog = () => {};
      await manager.stopAllComponents();
    }
  },
);

// Reconciliation itself invokes logger sinks. Work reported from those sinks must
// be consumed even when its component was visited earlier in the same scan.
test.each([false, true])(
  'timeout reconciliation drains nested optional-stop logs (keeper optional: %s)',
  async (isKeeperOptional) => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      sinks: [{ write: (entry) => onLog(entry.message) }],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const keeper = new ReportingComponent(logger, 'keeper');
    Object.defineProperty(keeper, 'optional', { value: isKeeperOptional });
    const dependent = new Plain(logger, 'dependent', ['keeper']);
    const optional = new ReportingComponent(logger, 'optional');
    Object.defineProperty(optional, 'optional', { value: true });
    let dependentStops = 0;
    dependent.stop = () => {
      dependentStops++;
      return Promise.resolve();
    };
    await manager.registerComponent(keeper);
    await manager.registerComponent(dependent);
    await manager.registerComponent(optional);
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    manager.on<{ name: string }>('component:started', ({ name }) => {
      if (name === 'optional') {
        now += 100;
      }
    });
    let timeoutReports = 0;
    let optionalReports = 0;
    onLog = (message) => {
      if (message === 'Startup completed with timeout') {
        timeoutReports++;
        optional.reportStopped();
      } else if (
        message.startsWith(
          'Optional component stopped unexpectedly during startup, continuing:',
        )
      ) {
        optionalReports++;
        // Only the first report creates more work. In the optional keeper case,
        // the second report must be observed without emitting the summary again.
        if (optionalReports === 1) {
          keeper.reportStopped();
        }
      }
    };
    try {
      const result = await manager.startAllComponents({ timeoutMS: 50 });
      expect(timeoutReports).toBe(1);
      expect(result.code).toBe(
        isKeeperOptional ? 'startup_timeout' : 'component_unexpected_stop',
      );
      expect(result.startedComponents).toEqual(
        isKeeperOptional ? ['dependent'] : [],
      );
      expect(result.failedOptionalComponents.map(({ name }) => name)).toEqual(
        isKeeperOptional ? ['optional', 'keeper'] : ['optional'],
      );
      expect(optionalReports).toBe(isKeeperOptional ? 2 : 1);
      expect(dependentStops).toBe(isKeeperOptional ? 0 : 1);
      expect(manager.getComponentStatus('dependent')?.state).toBe(
        isKeeperOptional ? 'running' : 'stopped',
      );
    } finally {
      clock.mockRestore();
      onLog = () => {};
      await manager.stopAllComponents();
    }
  },
);

test.each([false, true])(
  'shutdown from timeout reconciliation owns teardown (stopped component optional: %s)',
  async (isOptional) => {
    let onLog = (_message: string): void => {};
    const logger = new Logger({
      sinks: [{ write: (entry) => onLog(entry.message) }],
      callProcessExit: false,
    });
    const manager = new LifecycleManager({
      logger,
      shutdownWarningTimeoutMS: -1,
    });
    const keeper = new Plain(logger, 'keeper');
    const dependent = new Plain(logger, 'dependent', ['keeper']);
    const reporter = new ReportingComponent(logger, 'reporter');
    Object.defineProperty(reporter, 'optional', { value: isOptional });
    const finishStop = deferred();
    let stopCalls = 0;
    dependent.stop = () => {
      stopCalls++;
      return finishStop.promise;
    };
    await manager.registerComponent(keeper);
    await manager.registerComponent(dependent);
    await manager.registerComponent(reporter);
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    manager.on<{ name: string }>('component:started', ({ name }) => {
      if (name === 'reporter') {
        now += 100;
      }
    });
    let shutdown: ReturnType<typeof manager.stopAllComponents> | undefined;
    let timeoutReports = 0;
    let abortReports = 0;
    let runningAtInterruption: string[] = [];
    onLog = (message) => {
      if (message === 'Shutdown signal received during startup, aborting') {
        abortReports++;
      } else if (message === 'Startup completed with timeout') {
        timeoutReports++;
        reporter.reportStopped();
      } else if (
        message.includes('component stopped unexpectedly during startup') &&
        !shutdown
      ) {
        shutdown = manager.stopAllComponents();
        runningAtInterruption = ['keeper', 'dependent'].filter(
          (name) => manager.getComponentStatus(name)?.state === 'running',
        );
      }
    };
    try {
      const result = await manager.startAllComponents({ timeoutMS: 50 });
      expect(shutdown).toBeDefined();
      expect(timeoutReports).toBe(1);
      expect(result.code).toBe('shutdown_in_progress');
      expect(abortReports).toBe(1);
      expect(result.timedOut).not.toBe(true);
      // Shutdown may claim its first stop on a later microtask. Compare against
      // availability at the interruption boundary, not after awaiting startup.
      expect(result.startedComponents).toEqual(runningAtInterruption);
      expect(manager.getComponentStatus('dependent')?.state).toBe('stopping');
      expect(stopCalls).toBe(1);
    } finally {
      clock.mockRestore();
      onLog = () => {};
      finishStop.resolve();
      await shutdown;
      await manager.stopAllComponents();
    }
  },
);
