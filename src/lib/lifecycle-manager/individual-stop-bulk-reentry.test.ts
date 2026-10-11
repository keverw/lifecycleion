import { expect, test } from 'bun:test';
import { ArraySink } from '../logger/sinks/array';
import { deferred, Plain, setup } from './test-helpers';
import type { StopComponentOptions } from './types';

for (const operation of ['stop', 'restart'] as const) {
  for (const field of [
    'allowStopWithRunningDependents',
    'forceImmediate',
    'timeout',
    'shutdownGracefulTimeoutMS',
  ] as const) {
    test(`${operation} refuses when ${field} starts bulk shutdown before its claim`, async () => {
      const { logger, manager } = setup({ shutdownWarningTimeoutMS: 1000 });
      const sink = new ArraySink();
      logger.addSink(sink);
      const target = new Plain(logger, 'target');
      const gate = deferred();
      let stops = 0;
      target.stop = (): Promise<void> => {
        stops++;
        return Promise.resolve();
      };
      await manager.registerComponent(target);
      await manager.startComponent('target');
      target.onShutdownWarning = (): Promise<void> => gate.promise;
      let nested: Promise<unknown> | undefined;
      const reenter = (): void => {
        nested ??= manager.stopAllComponents();
      };
      const options: StopComponentOptions = {};
      Object.defineProperty(
        field === 'shutdownGracefulTimeoutMS' ? target : options,
        field,
        {
          configurable: true,
          get: () => {
            reenter();
            return field === 'allowStopWithRunningDependents' ||
              field === 'forceImmediate'
              ? true
              : 0;
          },
        },
      );
      try {
        const result = await (operation === 'stop'
          ? manager.stopComponent('target', options)
          : manager.restartComponent('target', { stopOptions: options }));
        expect(result.success).toBe(false);
        expect(result.code).toBe('shutdown_in_progress');
        expect(sink.logs.filter((entry) => entry.type === 'warn')).toEqual([
          expect.objectContaining({
            entityName: 'target',
            message:
              operation === 'restart'
                ? 'Cannot restart component during bulk operation'
                : 'Cannot stop component during shutdown',
            params:
              operation === 'restart'
                ? { isStarting: false, isShuttingDown: true }
                : { isShuttingDown: true },
          }),
        ]);
        expect(manager.getStatus().isShuttingDown).toBe(true);
        expect(stops).toBe(0);
        expect(target.forceCalls).toBe(0);
        expect(manager.getComponentStatus('target')?.state).toBe('running');
      } finally {
        gate.resolve();
        await nested;
        await manager.stopAllComponents();
      }
    });
  }
}

test('bulk shutdown still claims its own internal stops', async () => {
  const { logger, manager } = setup();
  const target = new Plain(logger, 'target');
  await manager.registerComponent(target);
  await manager.startComponent('target');
  expect((await manager.stopAllComponents()).success).toBe(true);
  expect(manager.getComponentStatus('target')?.state).toBe('stopped');
});

test('an individual graceful claim still escalates after bulk shutdown begins', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 1000 });
  const target = new Plain(logger, 'target');
  const other = new Plain(logger, 'other');
  const gate = deferred();
  let nested: Promise<unknown> | undefined;
  target.stop = (): Promise<void> => {
    nested = manager.stopAllComponents();
    return Promise.reject(new Error('graceful failure'));
  };
  other.onShutdownWarning = (): Promise<void> => gate.promise;
  await manager.registerComponent(target);
  await manager.startComponent('target');
  await manager.registerComponent(other);
  await manager.startComponent('other');
  let isBulkActiveDuringForce = false;
  target.onShutdownForce = (): void => {
    target.forceCalls++;
    isBulkActiveDuringForce = manager.getStatus().isShuttingDown;
  };
  try {
    expect((await manager.stopComponent('target')).success).toBe(true);
    expect(target.forceCalls).toBe(1);
    expect(isBulkActiveDuringForce).toBe(true);
    expect(manager.getComponentStatus('target')?.state).toBe('stopped');
  } finally {
    gate.resolve();
    await nested;
    await manager.stopAllComponents();
  }
});
