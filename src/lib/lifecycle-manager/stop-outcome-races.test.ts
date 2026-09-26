import { expect, test } from 'bun:test';
import type { ArraySink } from '../logger/sinks/array';
import { sleep } from '../sleep';
import { deferred, Plain, setup } from './test-helpers';

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
            isLate ? 'component_shutdown_timeout' : 'unknown_error',
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
              entry.message === 'Component stop failed after timeout'
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

test('synchronous force failure retains its result snapshot when graceful reconciles before the caller resumes', async () => {
  const { logger, manager } = setup();
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
  const result = await manager.stopComponent('a');
  expect(result.success).toBe(false);
  expect(result.error).toBe(failure);
  expect(result.status?.state).toBe('stalled');
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
});
