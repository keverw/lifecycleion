import { describe, expect, test } from 'bun:test';
import { sleep } from '../sleep';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import type {
  ComponentOperationResult,
  RestartResult,
  StartupResult,
} from './types';
import { deferred, Plain, setup } from './test-helpers';

// A manager whose single sink hands every message to `onLog`, which a test swaps in
// once setup is done.
function setupWithLogHook(): {
  logger: Logger;
  manager: LifecycleManager;
  setOnLog: (onLog: (message: string) => void) => void;
} {
  let onLog: (message: string) => void = () => {};
  const logger = new Logger({
    sinks: [{ write: (entry) => onLog(entry.message) }],
    callProcessExit: false,
  });

  return {
    logger,
    manager: new LifecycleManager({ logger, shutdownWarningTimeoutMS: -1 }),
    setOnLog: (next) => {
      onLog = next;
    },
  };
}

describe('logger exit: a repeat made as the leading exit ends', () => {
  // `depth` microtasks after the `shutdown-completed` listener: the leading exit's hook
  // resumes only a few microtasks after its pass released the latch, and a repeat made
  // in that gap was told to wait for an exit that was already over.
  for (const depth of [0, 1, 2]) {
    for (const isDeferred of [false, true]) {
      test(`stops what a shutdown-completed listener started again (${isDeferred ? 'exit deferred behind a running pass' : 'exit runs its own pass'}, depth ${depth})`, async () => {
        const { logger, manager } = setup({ enableLoggerExitHook: true });
        const component = new Plain(logger, 'a');
        const stopGate = deferred();
        await manager.registerComponent(component);
        expect((await manager.startAllComponents()).success).toBe(true);

        let restart: Promise<StartupResult> | undefined;
        manager.on('lifecycle-manager:shutdown-completed', () => {
          if (restart !== undefined) {
            return;
          }
          const run = (remaining: number): void => {
            if (remaining > 0) {
              queueMicrotask(() => run(remaining - 1));
              return;
            }
            restart = manager.startAllComponents();
            logger.exit(0);
          };
          queueMicrotask(() => run(depth));
        });

        if (isDeferred) {
          component.stop = () => stopGate.promise;
          void manager.stopAllComponents();
          // Deferred behind the running pass.
          logger.exit(0);
          stopGate.resolve();
        } else {
          logger.exit(0);
        }

        for (let i = 0; i < 100 && restart === undefined; i++) {
          await sleep(1);
        }
        expect(restart).toBeDefined();
        // The repeat led its own shutdown, which interrupted the startup the listener
        // began instead of leaving it running.
        expect((await restart)?.code).toBe('shutdown_in_progress');
        for (let i = 0; i < 100 && manager.getSystemState() !== 'ready'; i++) {
          await sleep(1);
        }
        expect(manager.getRunningComponentNames()).toEqual([]);
        expect(manager.getSystemState()).toBe('ready');
      });
    }
  }
});

test('an auto-start whose log line begins a restart is left to that restart', async () => {
  const { logger, manager, setOnLog } = setupWithLogHook();
  await manager.registerComponent(new Plain(logger, 'a'));
  expect((await manager.startAllComponents()).success).toBe(true);

  let restart: Promise<RestartResult> | undefined;
  setOnLog((message) => {
    if (restart === undefined && message.startsWith('AutoStart: starting')) {
      restart = manager.restartAllComponents();
    }
  });
  const b = new Plain(logger, 'b');
  let bStarts = 0;
  b.start = () => {
    bStarts++;
    return Promise.resolve();
  };
  const result = await manager.registerComponent(b, { autoStart: true });

  expect(restart).toBeDefined();
  // Not reported as a failed auto-start (`shutdown_in_progress`) while the restart's
  // startup went on to start it.
  expect(result).toMatchObject({
    success: true,
    autoStartAttempted: false,
    autoStartDeferred: true,
  });
  expect(result.startResult).toBeUndefined();

  const restartResult = await restart;
  expect(restartResult?.success).toBe(true);
  expect(restartResult?.startupResult.startedComponents).toEqual(['a', 'b']);
  expect(bStarts).toBe(1);
  expect(manager.getRunningComponentNames().sort()).toEqual(['a', 'b']);

  await manager.stopAllComponents();
});

test('restartComponent refuses active dependents before reading its timeouts, as stopComponent does', async () => {
  const { logger, manager } = setup();
  const database = new Plain(logger, 'database');
  await manager.registerComponent(database);
  await manager.registerComponent(new Plain(logger, 'api', ['database']));
  expect((await manager.startAllComponents()).success).toBe(true);

  let timeoutReads = 0;
  Object.defineProperty(database, 'startupTimeoutMS', {
    get: () => {
      timeoutReads++;
      return 'not a number';
    },
  });
  Object.defineProperty(database, 'ownsLateStartCleanup', {
    get: () => {
      timeoutReads++;
      return 'not a boolean';
    },
  });

  const stopResult = await manager.stopComponent('database');
  const restartResult = await manager.restartComponent('database');

  expect(stopResult.code).toBe('has_running_dependents');
  expect(restartResult.code).toBe('has_running_dependents');
  expect(restartResult.reason).toContain('api');
  // Neither getter ran for a restart that was never going to happen.
  expect(timeoutReads).toBe(0);
  expect(manager.getRunningComponentNames().sort()).toEqual([
    'api',
    'database',
  ]);

  // With the override, the invalid timeout is still refused before anything stops.
  const overridden = await manager.restartComponent('database', {
    stopOptions: { allowStopWithRunningDependents: true },
  });
  expect(overridden.code).toBe('invalid_options');
  expect(manager.isComponentRunning('database')).toBe(true);

  await manager.stopAllComponents();
});

test('restartComponent reads allowStopWithRunningDependents once', async () => {
  const { logger, manager } = setup();
  await manager.registerComponent(new Plain(logger, 'database'));
  await manager.registerComponent(new Plain(logger, 'api', ['database']));
  expect((await manager.startAllComponents()).success).toBe(true);

  let reads = 0;
  const stopOptions = {
    get allowStopWithRunningDependents(): boolean {
      reads++;
      return true;
    },
  };
  const result = await manager.restartComponent('database', { stopOptions });

  expect(result.success).toBe(true);
  expect(reads).toBe(1);

  await manager.stopAllComponents();
});

test('a restart that claims a late-start cleanup stop starts the component again', async () => {
  const { logger, manager, setOnLog } = setupWithLogHook();
  const worker = new Plain(logger, 'worker');
  const gate = deferred();
  let starts = 0;
  worker.start = () => {
    starts++;
    return starts === 1 ? gate.promise : Promise.resolve();
  };
  // Synchronous: the restart's stop settles as fast as a stop can.
  (worker as unknown as { stop: () => void }).stop = () => {};
  Object.defineProperty(worker, 'startupTimeoutMS', { value: 10 });
  await manager.registerComponent(worker);
  expect((await manager.startComponent('worker')).code).toBe(
    'component_startup_timeout',
  );

  let restart: Promise<ComponentOperationResult> | undefined;
  setOnLog((message) => {
    if (
      restart === undefined &&
      message.includes('completed startup after timeout')
    ) {
      restart = manager.restartComponent('worker');
    }
  });
  gate.resolve();
  for (let i = 0; i < 100 && restart === undefined; i++) {
    await sleep(1);
  }

  expect((await restart)?.success).toBe(true);
  expect(starts).toBe(2);
  expect(manager.getComponentStatus('worker')?.state).toBe('running');

  await manager.stopAllComponents();
});
