import { expect, test } from 'bun:test';
import type { ArraySink } from '../logger/sinks/array';
import type { ComponentStallInfo } from './types';
import { deferred, Plain, setup, Stalls } from './test-helpers';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test('a stalled retry with no force handler does not halt the pass before later components', async () => {
  const { logger, manager } = setup();
  const y = new Plain(logger, 'y');
  const x = new Plain(logger, 'x');
  x.stop = () => Promise.reject(new Error('stop failed'));
  Object.defineProperty(x, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  await manager.registerComponent(y);
  await manager.registerComponent(x);
  await manager.startAllComponents();
  try {
    // The stall itself halts the pass that met it, before `y`.
    const first = await manager.stopAllComponents();
    expect(first.success).toBe(false);
    expect(first.reason).toBe('Stalled: x; Not attempted: y');
    expect(manager.isComponentRunning('y')).toBe(true);

    // The retry has nothing to run: `x` stays stalled and is reported so, and `y` is
    // stopped rather than left untried on every later pass.
    const second = await manager.stopAllComponents();
    expect(second.success).toBe(false);
    expect(second.reason).toBe('Stalled: x');
    expect(second.stalledComponents.map((stall) => stall.name)).toEqual(['x']);
    expect(manager.getComponentStatus('y')?.state).toBe('stopped');
    expect(manager.getComponentStatus('x')?.state).toBe('stalled');
  } finally {
    await manager.unregisterComponent('x', { forceStop: true });
    await logger.close();
  }
});

// A stall the pass leaves as it found it - no force handler to retry, or not retried -
// keeps its dependencies up under `haltOnStall`, while unrelated components are stopped.
async function setupHeldStall(): Promise<
  ReturnType<typeof setup> & { cleanup: () => Promise<void> }
> {
  const context = setup();
  const { logger, manager } = context;
  const db = new Plain(logger, 'db');
  const unrelated = new Plain(logger, 'unrelated');
  const x = new Plain(logger, 'x', ['db']);
  x.stop = () => Promise.reject(new Error('stop failed'));
  Object.defineProperty(x, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  await manager.registerComponent(db);
  await manager.registerComponent(unrelated);
  await manager.registerComponent(x);
  await manager.startAllComponents();
  await manager.stopComponent('x');
  expect(manager.getComponentStatus('x')?.state).toBe('stalled');
  return {
    ...context,
    cleanup: async () => {
      await manager.unregisterComponent('x', { forceStop: true });
      await manager.stopAllComponents();
      await logger.close();
    },
  };
}

for (const shouldRetryStalled of [true, false]) {
  test(`a held stall keeps its dependencies up and does not halt the pass (retryStalled: ${shouldRetryStalled})`, async () => {
    const { manager, cleanup } = await setupHeldStall();
    try {
      const result = await manager.stopAllComponents({
        retryStalled: shouldRetryStalled,
      });
      expect(result.success).toBe(false);
      expect(result.code).toBe('partial_state');
      expect(result.reason).toBe('Stalled: x; Not attempted: db');
      expect(manager.getComponentStatus('unrelated')?.state).toBe('stopped');
      expect(manager.isComponentRunning('db')).toBe(true);
      expect(manager.getComponentStatus('x')?.state).toBe('stalled');
    } finally {
      await cleanup();
    }
  });
}

test('with haltOnStall: false a held stall releases its dependencies', async () => {
  const { manager, cleanup } = await setupHeldStall();
  try {
    const result = await manager.stopAllComponents({ haltOnStall: false });
    expect(result.reason).toBe('Stalled: x');
    expect(manager.getComponentStatus('unrelated')?.state).toBe('stopped');
    expect(manager.getComponentStatus('db')?.state).toBe('stopped');
  } finally {
    await cleanup();
  }
});

test('a held stall that clears mid-pass releases the dependencies skipped for it', async () => {
  const { logger, manager } = setup();
  const unrelated = new Plain(logger, 'unrelated');
  const db = new Plain(logger, 'db');
  const x = new Plain(logger, 'x', ['db']);
  const stuckStop = deferred();
  x.stop = () => stuckStop.promise;
  Object.defineProperty(x, 'onShutdownForce', {
    value: undefined,
    writable: true,
  });
  // Stopped after `db` was skipped: the stalled stop finishes while the pass runs.
  unrelated.stop = async () => {
    stuckStop.resolve();
    await sleep(0);
  };
  await manager.registerComponent(unrelated);
  await manager.registerComponent(db);
  await manager.registerComponent(x);
  await manager.startAllComponents();
  try {
    await manager.stopComponent('x', { timeout: 20 });
    expect(manager.getComponentStatus('x')?.state).toBe('stalled');

    const result = await manager.stopAllComponents({ retryStalled: false });
    expect(result.success).toBe(true);
    expect(manager.getComponentStatus('x')?.state).toBe('stopped');
    expect(manager.getComponentStatus('db')?.state).toBe('stopped');
    expect(manager.getComponentStatus('unrelated')?.state).toBe('stopped');
  } finally {
    stuckStop.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});

test('a failed stalled retry replaces the stall record without resolving it', async () => {
  const { logger, manager } = setup();
  const component = new Stalls(logger, 'a');
  await manager.registerComponent(component);
  await manager.startComponent('a');
  const events: Array<{ event: string; stallInfo: ComponentStallInfo }> = [];
  manager.on('component:stalled', (data) => {
    const { stallInfo } = data as { stallInfo: ComponentStallInfo };
    events.push({ event: 'stalled', stallInfo });
  });
  manager.on('component:stalled-resolved', (data) => {
    const { stallInfo } = data as { stallInfo: ComponentStallInfo };
    events.push({ event: 'resolved', stallInfo });
  });
  try {
    await manager.stopComponent('a');
    await manager.stopAllComponents();
    expect(events.map(({ event }) => event)).toEqual(['stalled', 'stalled']);
    expect(events[1].stallInfo).not.toBe(events[0].stallInfo);

    // The stall continues under the latest record, and one resolution ends it.
    component.onShutdownForce = (): void => {};
    const result = await manager.stopAllComponents();
    expect(result.success).toBe(true);
    expect(events.map(({ event }) => event)).toEqual([
      'stalled',
      'stalled',
      'resolved',
    ]);
    expect(events[2].stallInfo).toEqual(events[1].stallInfo);
  } finally {
    await logger.close();
  }
});

test('a timed-out pass logs its deadline once, not again when its stop loop ends later', async () => {
  const { logger, manager } = setup();
  const sink = logger.getSinks()[0] as ArraySink;
  const first = new Plain(logger, 'first');
  const slow = new Plain(logger, 'slow');
  const stopGate = deferred();
  const stopEntered = deferred();
  slow.stop = () => {
    stopEntered.resolve();
    return stopGate.promise;
  };
  await manager.registerComponent(first);
  await manager.registerComponent(slow);
  await manager.startAllComponents();
  try {
    const result = await manager.stopAllComponents({ timeoutMS: 20 });
    expect(result.timedOut).toBe(true);
    await stopEntered.promise;
    const loggedByPass = sink.logs.length;

    // The loop resumes after the pass answered, and halts at `first` without a word.
    stopGate.resolve();
    await sleep(20);
    expect(
      sink.logs.slice(loggedByPass).filter((entry) => entry.type === 'warn'),
    ).toEqual([]);
    expect(
      sink.logs.filter((entry) => entry.message.includes('Shutdown timeout')),
    ).toHaveLength(1);
    expect(manager.isComponentRunning('first')).toBe(true);
  } finally {
    stopGate.resolve();
    await manager.stopAllComponents();
    await logger.close();
  }
});
