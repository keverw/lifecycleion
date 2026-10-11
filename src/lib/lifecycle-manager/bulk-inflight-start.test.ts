import { expect, test } from 'bun:test';
import { Logger } from '../logger';
import { LifecycleManager } from './lifecycle-manager';
import { BaseComponent } from './base-component';
import { deferred } from './test-helpers';

class Component extends BaseComponent {
  public starts = 0;
  public stops = 0;
  public onStart: () => void | Promise<void> = () => {};
  public async start() {
    this.starts++;
    await this.onStart();
  }
  public stop() {
    this.stops++;
  }
}
function setup() {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const manager = new LifecycleManager({
    logger,
    shutdownWarningTimeoutMS: -1,
  });
  const component = (name: string, isOptional = false) =>
    new Component(logger, { name, optional: isOptional });
  return { manager, component };
}

test.each([false, true])(
  'a bulk startup refuses a completion auto-start and preserves running names (earlier start succeeded: %s)',
  async (didEarlierSucceed) => {
    const { manager, component } = setup();
    const optional = component('optional', true);
    optional.onStart = () => {
      if (!didEarlierSucceed) {
        throw new Error('optional failed');
      }
    };
    const pending = component('pending');
    const gate = deferred();
    pending.onStart = () => gate.promise;
    await manager.registerComponent(optional);
    let registration: ReturnType<typeof manager.registerComponent> | undefined;
    manager.once('lifecycle-manager:started', () => {
      registration = manager.registerComponent(pending, { autoStart: true });
    });
    try {
      expect((await manager.startAllComponents()).success).toBe(true);
      expect(manager.getComponentStatus('pending')?.state).toBe('starting');
      const result = await manager.startAllComponents({ timeoutMS: 0 });
      expect(result).toMatchObject({
        success: false,
        code: 'partial_state',
        startedComponents: didEarlierSucceed ? ['optional'] : [],
        failedOptionalComponents: [],
      });
      expect(result.reason).toContain('still starting: pending');
      expect(optional.starts).toBe(1);
      expect(optional.stops).toBe(0);
      expect(result.startedComponents).toEqual(
        manager.getRunningComponentNames(),
      );
      expect(pending.starts).toBe(1);
      expect(pending.stops).toBe(0);
      expect(manager.getComponentStatus('pending')?.state).toBe('starting');
    } finally {
      gate.resolve();
      await registration;
      await manager.stopAllComponents();
    }
  },
);

test.each([false, true])(
  'an independent start encountered by a follow-up returns partial state without rollback (optional: %s)',
  async (isOptional) => {
    const { manager, component } = setup();
    const root = component('root');
    const pending = component('pending', isOptional);
    const unattempted = component('unattempted');
    const gate = deferred();
    pending.onStart = () => gate.promise;
    let independent: ReturnType<typeof manager.startComponent> | undefined;
    root.onStart = async () => {
      expect(
        await manager.registerComponent(pending, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
      expect(
        await manager.registerComponent(unattempted, { autoStart: true }),
      ).toMatchObject({ autoStartDeferred: true });
      independent = manager.startComponent('pending', {
        allowDuringBulkStartup: true,
      });
    };
    await manager.registerComponent(root);
    try {
      const result = await manager.startAllComponents({ timeoutMS: 0 });
      expect(result).toMatchObject({
        success: false,
        code: 'partial_state',
        startedComponents: ['root'],
        failedOptionalComponents: [],
        skippedDueToDependency: [],
      });
      expect(result.reason).toContain('pending');
      expect(root.stops).toBe(0);
      expect(pending.starts).toBe(1);
      expect(pending.stops).toBe(0);
      expect(unattempted.starts).toBe(0);
      expect(manager.getComponentStatus('pending')?.state).toBe('starting');
      expect(manager.getRunningComponentNames()).toEqual(['root']);
    } finally {
      gate.resolve();
      expect((await independent)?.success).toBe(true);
      await manager.stopAllComponents();
    }
  },
);

test('late timeout cleanup already stopping at entry refuses bulk startup before any starts', async () => {
  const { manager, component } = setup();
  const first = component('first');
  const blocked = component('blocked');
  Object.defineProperty(blocked, 'startupTimeoutMS', { value: 20 });
  const startGate = deferred();
  const stopEntered = deferred();
  const finishStop = deferred();
  const stopped = deferred();
  blocked.onStart = () => startGate.promise;
  Object.defineProperty(blocked, 'stop', {
    value: async () => {
      blocked.stops++;
      stopEntered.resolve();
      await finishStop.promise;
    },
  });
  manager.once('component:stopped', () => stopped.resolve());
  await manager.registerComponent(first);
  await manager.registerComponent(blocked);
  try {
    expect((await manager.startComponent('blocked')).code).toBe(
      'component_startup_timeout',
    );
    startGate.resolve();
    await stopEntered.promise;
    expect(manager.getComponentStatus('blocked')?.state).toBe('stopping');

    const result = await manager.startAllComponents();

    expect(result).toMatchObject({
      success: false,
      code: 'partial_state',
      startedComponents: [],
      failedOptionalComponents: [],
      reason: 'Components are still stopping: blocked',
    });
    expect(first.starts).toBe(0);
    expect(first.stops).toBe(0);
    expect(manager.getComponentStatus('first')?.state).toBe('registered');
    expect(blocked.starts).toBe(1);
    expect(blocked.stops).toBe(1);
    expect(manager.getComponentStatus('blocked')?.state).toBe('stopping');
  } finally {
    startGate.resolve();
    finishStop.resolve();
    await stopped.promise;
    await manager.stopAllComponents();
  }
});

test('late timeout cleanup keeps its reason and does not roll back the new pass', async () => {
  const { manager, component } = setup();
  const first = component('first');
  const blocked = component('blocked');
  Object.defineProperty(blocked, 'startupTimeoutMS', { value: 20 });
  const startGate = deferred();
  const stopEntered = deferred();
  const finishStop = deferred();
  blocked.onStart = () => startGate.promise;
  Object.defineProperty(blocked, 'stop', {
    value: async () => {
      blocked.stops++;
      stopEntered.resolve();
      await finishStop.promise;
    },
  });
  first.onStart = async () => {
    startGate.resolve();
    await stopEntered.promise;
  };
  await manager.registerComponent(first);
  await manager.registerComponent(blocked);
  try {
    expect((await manager.startComponent('blocked')).code).toBe(
      'component_startup_timeout',
    );
    expect(manager.getComponentStatus('blocked')?.state).toBe(
      'starting-timed-out',
    );
    const result = await manager.startAllComponents();
    expect(result).toMatchObject({
      success: false,
      code: 'partial_state',
      startedComponents: ['first'],
      failedOptionalComponents: [],
      reason:
        'Component "blocked": Timed-out startup is still awaiting completion or cleanup',
    });
    expect(first.stops).toBe(0);
    expect(manager.getComponentStatus('first')?.state).toBe('running');
    expect(blocked.starts).toBe(1);
  } finally {
    finishStop.resolve();
    await manager.stopAllComponents();
  }
});
