import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { BaseComponent } from './base-component';
import { LifecycleManager } from './lifecycle-manager';
import { claimReports, coreOf } from './test-helpers';

class Component extends BaseComponent {
  public starts = 0;
  public onStart: () => void | Promise<void> = () => {};
  public async start() {
    this.starts++;
    await this.onStart();
  }
  public stop() {}
}

function setup() {
  const sink = new ArraySink();
  const logger = new Logger({ sinks: [sink], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    startupTimeoutMS: 10_000,
    shutdownWarningTimeoutMS: -1,
  });
  const component = (name: string) => new Component(logger, { name });
  const warnings = () =>
    sink.logs.filter((log) =>
      log.message.includes('deferred auto-starts were not attempted'),
    );
  return { manager, component, warnings };
}

test.each(['timeout', 'required failure', 'shutdown'] as const)(
  'unattempted frozen follow-up members are reported after %s',
  async (mode) => {
    const { manager, component, warnings } = setup();
    const root = component('root');
    const first = component('first');
    const remaining = component('remaining');
    let shutdown: Promise<unknown> | undefined;
    const realNow = Date.now;
    let now = realNow();
    root.onStart = async () => {
      for (const child of [first, remaining]) {
        expect(
          await manager.registerComponent(child, { autoStart: true }),
        ).toMatchObject({ autoStartDeferred: true });
      }
    };
    first.onStart = () => {
      if (mode === 'timeout') {
        now += 10_001;
      }
      if (mode === 'required failure') {
        throw new Error('follow-up failed');
      }
      if (mode === 'shutdown') {
        shutdown = manager.stopAllComponents();
      }
    };
    await manager.registerComponent(root);
    Date.now = () => now;
    try {
      const result = await manager.startAllComponents();
      await shutdown;
      expect(result.code).toBe(
        mode === 'timeout'
          ? 'startup_timeout'
          : mode === 'shutdown'
            ? 'shutdown_in_progress'
            : 'required_component_failed',
      );
      expect(first.starts).toBe(1);
      expect(remaining.starts).toBe(0);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0].params?.components).toEqual(['remaining']);
      expect(warnings()[0].params?.reason).toBe(
        mode === 'timeout'
          ? 'timed out'
          : mode === 'shutdown'
            ? 'was interrupted by shutdown'
            : 'failed and rolled back',
      );
    } finally {
      Date.now = realNow;
      await manager.stopAllComponents();
    }
  },
);

test('queued auto-starts report a timeout after the original batch has already started', async () => {
  const { manager, component, warnings } = setup();
  const root = component('root');
  const queued = component('queued');
  const trigger = component('trigger');
  const realNow = Date.now;
  let now = realNow();
  trigger.onStart = async () => {
    await manager.registerComponent(queued, { autoStart: true });
    now += 10_001;
  };
  await manager.registerComponent(root);
  await manager.registerComponent(trigger);
  Date.now = () => now;
  try {
    expect(await manager.startAllComponents()).toMatchObject({
      code: 'startup_timeout',
      startedComponents: ['root'],
    });
    expect(queued.starts).toBe(0);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].params?.reason).toBe('timed out');
  } finally {
    Date.now = realNow;
    await manager.stopAllComponents();
  }
});

test('an empty follow-up order violates the progress invariant and rolls back immediately', async () => {
  const { manager, component, warnings } = setup();
  const root = component('root');
  const queued = component('queued');
  let isFollowupReady = false;
  root.onStart = async () => {
    await manager.registerComponent(queued, { autoStart: true });
    isFollowupReady = true;
  };
  await manager.registerComponent(root);
  // Fault injection only: public registration cannot currently lose a queued name.
  // The second follow-up call throws to bound the unfixed loop without a deadline.
  const internal = coreOf(manager).startupOrdering;
  const order = internal.getStartupOrderInternal.bind(internal);
  let calls = 0;
  internal.getStartupOrderInternal = (...args) => {
    if (!isFollowupReady) {
      return order(...args);
    }
    calls++;
    if (calls === 1) {
      return [];
    }
    throw new Error('follow-up ordering made no progress twice');
  };
  const { reports, release } = claimReports();
  try {
    const result = await manager.startAllComponents({ timeoutMS: 0 });
    expect(result.code).toBe('operation_crashed');
    expect(result.error?.message).toBe(
      'Deferred auto-starts were absent from the follow-up startup order',
    );
    expect(calls).toBe(1);
    expect(manager.getRunningComponentNames()).toEqual([]);
    expect(queued.starts).toBe(0);
    expect(reports).toHaveLength(1);
    expect(warnings()).toHaveLength(1);
  } finally {
    internal.getStartupOrderInternal = order;
    release();
    await manager.stopAllComponents();
  }
});
