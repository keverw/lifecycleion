import { expect, test } from 'bun:test';
import type { ArraySink } from '../logger/sinks/array';
import { sleep } from '../sleep';
import { claimReports, deferred, Plain, setup } from './test-helpers';

for (const phase of ['graceful', 'force'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    for (const window of [
      'before',
      'abort',
      'stalled',
      'restart',
      'retry',
    ] as const) {
      test(`${phase} ${outcome} in ${window} window preserves reporting and state ownership`, async () => {
        const { logger, manager } = setup();
        const sink = logger.getSinks()[0] as ArraySink;
        const pending = deferred();
        const failure = new Error('original hook failure');
        const settle = () =>
          outcome === 'resolve' ? pending.resolve() : pending.reject(failure);
        const component = new Plain(logger, 'a');
        component.stop = () => pending.promise;
        Object.assign(component, {
          shutdownGracefulTimeoutMS: window === 'before' ? 100 : 5,
          shutdownForceTimeoutMS: window === 'before' ? 100 : 5,
          onShutdownForce:
            phase === 'force' ? () => pending.promise : undefined,
          [phase === 'graceful'
            ? 'onGracefulStopTimeout'
            : 'onShutdownForceAborted']:
            window === 'abort' ? settle : undefined,
        });
        let stopped = 0;
        let stalled = 0;
        manager.on('component:stopped', () => {
          stopped++;
        });
        manager.on('component:stalled', () => {
          stalled++;
        });
        await manager.registerComponent(component);
        await manager.startComponent('a');
        const stopping = manager.stopComponent('a', {
          forceImmediate: phase === 'force',
        });
        if (window === 'before') {
          settle();
        }
        const result = await stopping;
        const isLate = window !== 'before' && window !== 'abort';
        expect(result.success).toBe(!isLate && outcome === 'resolve');
        expect(stalled).toBe(result.success ? 0 : 1);
        if (!result.success) {
          expect(result.code).toBe(
            isLate ? 'component_shutdown_timeout' : 'error',
          );
          if (!isLate) {
            expect(result.error).toBe(failure);
          }
        }
        const snapshotState = result.status?.state;
        const retry = deferred();
        let retryResult:
          ReturnType<typeof manager.stopAllComponents> | undefined;
        if (window === 'restart') {
          expect(
            (await manager.startComponent('a', { forceStalled: true })).success,
          ).toBe(true);
        } else if (window === 'retry') {
          Object.assign(component, {
            onShutdownForce: () => retry.promise,
            shutdownForceTimeoutMS: 0,
          });
          retryResult = manager.stopAllComponents({ retryStalled: true });
          // Let the bulk warning phase hand off to the new force generation.
          await sleep(0);
          expect(manager.getComponentStatus('a')?.state).toBe('force-stopping');
        }
        if (isLate) {
          settle();
        }
        await sleep(0);
        const expectedState =
          window === 'restart'
            ? 'running'
            : window === 'retry'
              ? 'force-stopping'
              : outcome === 'resolve'
                ? 'stopped'
                : 'stalled';
        expect(manager.getComponentStatus('a')?.state).toBe(expectedState);
        expect(result.status?.state).toBe(snapshotState);
        expect(result.success).toBe(!isLate && outcome === 'resolve');
        expect(stalled).toBe(result.success ? 0 : 1);
        expect(stopped).toBe(expectedState === 'stopped' ? 1 : 0);
        const failures = sink.logs.filter((entry) =>
          phase === 'graceful'
            ? entry.message.startsWith('Graceful shutdown threw error') ||
              entry.message === 'Component stop failed after deadline fired'
            : entry.message.startsWith('Force shutdown failed'),
        );
        expect(failures).toHaveLength(outcome === 'reject' ? 1 : 0);
        if (retryResult) {
          retry.resolve();
          expect((await retryResult).success).toBe(true);
          expect(manager.getComponentStatus('a')?.state).toBe('stopped');
          expect(stopped).toBe(1);
        }
      });
    }
  }
}

for (const timeoutMS of [0, 100]) {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`abandoned force ${outcome} with timeout ${timeoutMS} reports without changing a restarted run`, async () => {
      const { logger, manager } = setup();
      const sink = logger.getSinks()[0] as ArraySink;
      const graceful = deferred();
      const force = deferred();
      const component = new Plain(logger, 'a');
      component.stop = () => graceful.promise;
      Object.assign(component, {
        shutdownGracefulTimeoutMS: 5,
        shutdownForceTimeoutMS: timeoutMS,
        onShutdownForce: () => {
          graceful.resolve();
          return force.promise;
        },
      });
      let stopped = 0;
      manager.on('component:stopped', () => {
        stopped++;
      });
      await manager.registerComponent(component);
      await manager.startComponent('a');
      const result = await manager.stopComponent('a');
      expect(result.success).toBe(true);
      expect(result.status?.state).toBe('stopped');
      expect((await manager.startComponent('a')).success).toBe(true);
      if (outcome === 'resolve') {
        force.resolve();
      } else {
        force.reject(new Error('abandoned failure'));
      }
      await sleep(0);
      expect(manager.getComponentStatus('a')?.state).toBe('running');
      expect(result.status?.state).toBe('stopped');
      expect(stopped).toBe(1);
      expect(
        sink.logs.filter((entry) =>
          entry.message.startsWith('Force shutdown failed'),
        ),
      ).toHaveLength(outcome === 'reject' ? 1 : 0);
    });
  }
}

test('synchronous force failure answers as a returned rejection when graceful reconciles first', async () => {
  const { logger, manager } = setup();
  const sink = logger.getSinks()[0] as ArraySink;
  const graceful = deferred();
  const component = new Plain(logger, 'a');
  const failure = new Error('force failed while releasing graceful');
  component.stop = () => graceful.promise;
  Object.assign(component, {
    shutdownGracefulTimeoutMS: 5,
    onShutdownForce: () => {
      graceful.resolve();
      throw failure;
    },
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const stalled: string[] = [];
  manager.on('component:stalled', ({ name }: { name: string }) => {
    stalled.push(name);
  });
  const result = await manager.stopComponent('a');
  // The same outcome as `force-late-reporting`'s same-turn rejection: the graceful
  // stop it released completed, and the failure is reported as abandoned cleanup.
  expect(result.success).toBe(true);
  expect(result.status?.state).toBe('stopped');
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
  expect(stalled).toEqual([]);
  const reports = sink.logs.filter((entry) =>
    entry.message.startsWith('Force shutdown failed'),
  );
  expect(reports.map((entry) => [entry.type, entry.message])).toEqual([
    ['warn', 'Force shutdown failed after graceful stop completed'],
  ]);
});

test('a failure after force shutdown resolved is a crash, not an abandoned force failure', async () => {
  const { logger, manager } = setup();
  const sink = logger.getSinks()[0] as ArraySink;
  const graceful = deferred();
  const component = new Plain(logger, 'a');
  component.stop = () => graceful.promise;
  const bookkeepingFailure = new Error('status read failed');
  const readStatus = manager.getComponentStatus.bind(manager);
  let shouldFailStatus = false;
  manager.getComponentStatus = (name) => {
    if (shouldFailStatus) {
      shouldFailStatus = false;
      throw bookkeepingFailure;
    }
    return readStatus(name);
  };
  Object.assign(component, {
    shutdownGracefulTimeoutMS: 5,
    onShutdownForce: () => {
      // Fails the force success path's first status read, after markComponentStopped.
      shouldFailStatus = true;
      return Promise.resolve();
    },
  });
  await manager.registerComponent(component);
  await manager.startComponent('a');

  const { reports, release } = claimReports();
  let result;
  try {
    result = await manager.stopComponent('a');
  } finally {
    release();
  }

  expect(result.success).toBe(false);
  expect(result.code).toBe('operation_crashed');
  expect(
    reports.some((report) => (report as Error).cause === bookkeepingFailure),
  ).toBe(true);
  expect(
    sink.logs.filter((entry) =>
      entry.message.startsWith('Force shutdown failed'),
    ),
  ).toEqual([]);
});
