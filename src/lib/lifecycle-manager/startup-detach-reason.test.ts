import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import { fakeSignals, Plain } from './test-helpers';

function setup() {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    attachSignalsBeforeStartup: true,
    detachSignalsOnStop: true,
    shutdownWarningTimeoutMS: -1,
  });
  const signals = fakeSignals(manager);
  const detachMessages = () =>
    sink.logs
      .map((entry) => entry.message)
      .filter((message) =>
        message.startsWith('Auto-detached process signals after '),
      );
  return { logger, manager, signals, detachMessages };
}

test.each([true, false])(
  'idle startup detachment reflects its result when a component fails (optional: %s)',
  async (isOptional) => {
    const { logger, manager, signals, detachMessages } = setup();
    const component = new Plain(logger, 'component');
    component.isOptional = () => isOptional;
    component.start = () => {
      throw new Error('start failed');
    };
    await manager.registerComponent(component);
    try {
      const result = await manager.startAllComponents();
      expect(result.success).toBe(isOptional);
      expect(result.startedComponents).toEqual([]);
      expect(signals.isAttached()).toBe(false);
      expect(signals.detachCalls()).toBe(1);
      expect(detachMessages()).toEqual([
        `Auto-detached process signals after ${isOptional ? 'completed' : 'failed'} bulk startup`,
      ]);
    } finally {
      manager.detachSignals();
    }
  },
);

test('startup interrupted by a public shutdown uses an interrupted detachment reason', async () => {
  const { logger, manager, signals, detachMessages } = setup();
  const component = new Plain(logger, 'component');
  component.start = async () => {
    await manager.stopAllComponents({ timeoutMS: 0 });
  };
  await manager.registerComponent(component);
  try {
    const result = await manager.startAllComponents();
    expect(result).toMatchObject({
      success: false,
      code: 'shutdown_in_progress',
    });
    expect(signals.isAttached()).toBe(false);
    expect(signals.detachCalls()).toBe(1);
    expect(detachMessages()).toEqual([
      'Auto-detached process signals after interrupted bulk startup',
    ]);
  } finally {
    manager.detachSignals();
  }
});
