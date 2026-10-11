import { expect, test } from 'bun:test';
import type { ComponentOperationResult } from './types';
import {
  claimReports,
  deferred,
  failStatusReadOnce,
  Plain,
  setup,
} from './test-helpers';

// A start that fails once its component is running stops it again - unless caller code
// the failure ran already began that stop, which then owns it: the reason says so,
// rather than that stopping it again failed as already stopping.

test('a start crash whose report began stopping the component leaves that stop to it', async () => {
  const { logger, manager } = setup();
  const component = new Plain(logger, 'a');
  const stop = deferred();
  component.stop = () => stop.promise;
  await manager.registerComponent(component);

  const restoreStatusRead = failStatusReadOnce(new Error('status exploded'));
  const { release } = claimReports();
  // A host error listener - caller code the crash report runs - stops the component.
  let listenerStop: Promise<ComponentOperationResult> | undefined;
  const onError = (): void => {
    listenerStop ??= manager.stopComponent('a');
  };
  globalThis.addEventListener('error', onError);
  let result;

  try {
    result = await manager.startComponent('a');
  } finally {
    globalThis.removeEventListener('error', onError);
    restoreStatusRead();
    release();
  }

  expect(result.success).toBe(false);
  expect(result.code).toBe('operation_crashed');
  expect(result.reason).toContain('another stop is already stopping it');
  expect(result.reason).not.toContain('also failed');
  expect(manager.getComponentStatus('a')?.state).toBe('stopping');

  stop.resolve();
  expect((await listenerStop)?.success).toBe(true);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
});

test('a signal attach failure whose log began stopping the component leaves that stop to it', async () => {
  let onLog = (_message: string): void => {};
  const { logger, manager } = setup({ attachSignalsOnStart: true });
  logger.addSink({ write: (entry) => onLog(entry.message) });
  const component = new Plain(logger, 'a');
  const stop = deferred();
  component.stop = () => stop.promise;
  await manager.registerComponent(component);

  manager.attachSignals = (): never => {
    throw new Error('attach exploded');
  };
  let sinkStop: Promise<ComponentOperationResult> | undefined;
  onLog = (message) => {
    if (message.includes('process signals could not be attached')) {
      sinkStop ??= manager.stopComponent('a');
    }
  };

  const result = await manager.startComponent('a');

  expect(result.success).toBe(false);
  expect(result.code).toBe('signal_attach_failed');
  expect(result.reason).toBe(
    'Could not attach process signals: attach exploded; another stop is already stopping it',
  );

  stop.resolve();
  expect((await sinkStop)?.success).toBe(true);
  expect(manager.getComponentStatus('a')?.state).toBe('stopped');
});

test('an all-running startup confirms its stalled skips from the registry, not getComponentNames()', async () => {
  let onLog = (_message: string): void => {};
  const { logger, manager } = setup();
  logger.addSink({ write: (entry) => onLog(entry.message) });
  const stalled = new Plain(logger, 'stalled');
  stalled.stop = () => Promise.reject(new Error('stop failed'));
  Object.defineProperty(stalled, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  await manager.registerComponent(new Plain(logger, 'running'));
  await manager.registerComponent(stalled);
  await manager.startAllComponents();
  await manager.stopComponent('stalled');
  expect(manager.getComponentStatus('stalled')?.state).toBe('stalled');

  // An override whose answer changes once the all-running log has run: the post-log
  // check and the reported skips must not take it for a registry change.
  let hasLogged = false;
  const getComponentNames = manager.getComponentNames.bind(manager);
  manager.getComponentNames = (): string[] =>
    hasLogged ? [] : getComponentNames();
  onLog = (message) => {
    if (message === 'All components already running') {
      hasLogged = true;
    }
  };

  const result = await manager.startAllComponents({
    ignoreStalledComponents: true,
  });

  expect(result.success).toBe(true);
  expect(result.code).toBeUndefined();
  expect(result.startedComponents).toEqual(['running']);
  expect(result.skippedDueToStall).toEqual(['stalled']);
});
