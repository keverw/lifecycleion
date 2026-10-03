import { describe, test, expect } from 'bun:test';
import { BaseComponent } from './base-component';
import type { ArraySink, Logger } from '../logger';
import { LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT } from './constants';
import type { LifecycleManager } from './lifecycle-manager';
import { claimReports, Plain, setup, Stalls } from './test-helpers';
import type { ComponentOperationResult, ComponentStallInfo } from './types';

class CountsStops extends Plain {
  public stopCalls = 0;

  public override stop(): Promise<void> {
    this.stopCalls++;
    return Promise.resolve();
  }
}

class FailsStart extends Plain {
  public override start(): Promise<void> {
    return Promise.reject(new Error('start failed'));
  }
}

// No `onShutdownForce`, and a `stop()` that never settles.
class HangsWithoutForce extends BaseComponent {
  constructor(logger: Logger, name: string) {
    super(logger, { name, shutdownGracefulTimeoutMS: 20 });
  }

  public async start(): Promise<void> {}
  public stop(): Promise<void> {
    return new Promise(() => {});
  }
}

// `stop()` never settles and the force handler throws until it is removed.
class HangsThenForceThrows extends BaseComponent {
  constructor(logger: Logger, name: string) {
    super(logger, { name, shutdownGracefulTimeoutMS: 20 });
  }

  public async start(): Promise<void> {}
  public stop(): Promise<void> {
    return new Promise(() => {});
  }
  public onShutdownForce?(): void {
    throw new Error('force failed');
  }
}

// `stop()` and the force handler both hang, so the stall is a force-phase timeout.
class HangsThroughForce extends BaseComponent {
  constructor(logger: Logger, name: string) {
    super(logger, {
      name,
      shutdownGracefulTimeoutMS: 20,
      shutdownForceTimeoutMS: 20,
    });
  }

  public async start(): Promise<void> {}
  public stop(): Promise<void> {
    return new Promise(() => {});
  }
  public onShutdownForce?(): Promise<void> {
    return new Promise(() => {});
  }
}

/** The force-phase retry a shutdown pass runs for a stalled component. */
function retryStalled(
  manager: LifecycleManager,
  name: string,
): Promise<ComponentOperationResult> {
  return (
    manager as unknown as {
      retryStalledComponent(name: string): Promise<ComponentOperationResult>;
    }
  ).retryStalledComponent(name);
}

/**
 * Make the next call of a private manager step throw, as a crash in the stop's own
 * bookkeeping would, then restore it.
 */
function crashNextCall(manager: LifecycleManager, method: string): void {
  Object.defineProperty(manager, method, {
    configurable: true,
    value: (): never => {
      Reflect.deleteProperty(manager, method);
      throw new Error('bookkeeping crashed');
    },
  });
}

function logMessages(logger: Logger): string[] {
  const sink = logger.getSinks()[0] as ArraySink;
  return sink.logs.map((entry) => entry.message);
}

// Every `stop()` fails; the force handler fails until `isForceFixed` is set.
class ForceRecovers extends Plain {
  public isForceFixed = false;

  public override stop(): Promise<void> {
    return Promise.reject(new Error('stop failed'));
  }

  public override onShutdownForce(): void {
    if (!this.isForceFixed) {
      throw new Error('force failed');
    }
  }
}

describe('LifecycleManager - stall retry and rollback', () => {
  test('startup rollback leaves the dependency of a stalled dependent running', async () => {
    const { logger, manager } = setup();
    const db = new CountsStops(logger, 'db');
    await manager.registerComponent(db);
    await manager.registerComponent(new Stalls(logger, 'api', ['db']));
    await manager.registerComponent(new FailsStart(logger, 'z', ['api']));

    const result = await manager.startAllComponents();

    expect(result.success).toBe(false);
    expect(manager.getComponentStatus('api')?.state).toBe('stalled');
    expect(db.stopCalls).toBe(0);
    expect(manager.getComponentStatus('db')?.state).toBe('running');
  });

  test('a stall from before the startup does not keep rolled-back work running', async () => {
    const { logger, manager } = setup();
    const db = new CountsStops(logger, 'db');
    await manager.registerComponent(db);
    await manager.registerComponent(new Stalls(logger, 'api', ['db']));
    await manager.startComponent('db');
    await manager.startComponent('api');
    await manager.stopComponent('api');
    expect((await manager.stopComponent('db')).success).toBe(true);
    await manager.registerComponent(new FailsStart(logger, 'z', ['db']));

    const result = await manager.startAllComponents({
      ignoreStalledComponents: true,
    });

    expect(result.success).toBe(false);
    expect(db.stopCalls).toBe(2);
    expect(manager.getComponentStatus('db')?.state).toBe('stopped');
  });

  test('a stalled retry without onShutdownForce keeps the original stall record', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new HangsWithoutForce(logger, 'hang'));
    await manager.startComponent('hang');

    const first = await manager.stopComponent('hang');
    expect(first.code).toBe('component_shutdown_timeout');
    const original = manager.getStalledComponents()[0];
    expect(original.reason).toBe('timeout');
    expect(original.error).toBeDefined();

    const retry = await manager.stopAllComponents();

    expect(retry.success).toBe(false);
    const after = manager.getStalledComponents()[0];
    expect(after).toEqual(original);
    expect(retry.stalledComponents[0]?.reason).toBe('timeout');
  });

  test('a stalled retry whose force phase succeeds emits stalled-resolved', async () => {
    const { logger, manager } = setup();
    const component = new ForceRecovers(logger, 'flaky');
    await manager.registerComponent(component);
    await manager.startComponent('flaky');

    await manager.stopComponent('flaky');
    expect(manager.getStalledComponentNames()).toEqual(['flaky']);

    const resolved: ComponentStallInfo[] = [];
    const events: string[] = [];
    manager.on('component:shutdown-force-completed', () => {
      events.push('force-completed');
    });
    manager.on('component:stalled-resolved', (event) => {
      resolved.push((event as { stallInfo: ComponentStallInfo }).stallInfo);
      events.push('stalled-resolved');
    });
    manager.on('component:stopped', () => {
      events.push('stopped');
    });

    component.isForceFixed = true;
    const retry = await manager.stopAllComponents();

    expect(retry.success).toBe(true);
    expect(manager.getStalledComponentNames()).toEqual([]);
    expect(resolved.map((info) => info.name)).toEqual(['flaky']);
    expect(events).toEqual(['force-completed', 'stalled-resolved', 'stopped']);
  });

  test('a stalled retry without onShutdownForce keeps a timeout-then-error stall an error', async () => {
    const { logger, manager } = setup();
    const component = new HangsThenForceThrows(logger, 'both');
    await manager.registerComponent(component);
    await manager.startComponent('both');

    const first = await manager.stopComponent('both');
    expect(first.code).toBe('unknown_error');
    expect(manager.getStalledComponents()[0].reason).toBe('both');

    Object.defineProperty(component, 'onShutdownForce', { value: undefined });
    const retry = await retryStalled(manager, 'both');

    expect(retry).toMatchObject({
      success: false,
      code: 'unknown_error',
      reason: first.reason,
    });
    expect(manager.getStalledComponents()[0].reason).toBe('both');
  });

  test('a stalled retry without onShutdownForce does not re-announce the stall', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new HangsWithoutForce(logger, 'hang'));
    await manager.startComponent('hang');
    const first = await manager.stopComponent('hang');

    const stalls: ComponentStallInfo[] = [];
    manager.on(
      'component:stalled',
      (event: { stallInfo: ComponentStallInfo }) => {
        stalls.push(event.stallInfo);
      },
    );
    let forceStarts = 0;
    manager.on('component:shutdown-force', () => {
      forceStarts++;
    });
    const retry = await retryStalled(manager, 'hang');
    await manager.stopAllComponents();

    expect(stalls).toEqual([]);
    // Nothing is attempted, so no force start is announced that nothing would end.
    expect(forceStarts).toBe(0);
    expect(logMessages(logger)).not.toContain(
      'Retrying stalled component shutdown (force phase)',
    );
    expect(logMessages(logger)).toContain(
      'Stalled component has no force handler to retry',
    );
    expect(retry).toMatchObject({
      success: false,
      code: first.code,
      reason: first.reason,
    });
    expect(manager.getComponentStatus('hang')?.state).toBe('stalled');
  });

  test('a reused force-phase stall answers as a force timeout, not a graceful failure', async () => {
    const { logger, manager } = setup();
    const component = new HangsThroughForce(logger, 'force');
    await manager.registerComponent(component);
    await manager.startComponent('force');

    const first = await manager.stopComponent('force');
    expect(first.reason).toBe(
      LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
    );
    expect(manager.getStalledComponents()[0]).toMatchObject({
      phase: 'force',
      reason: 'timeout',
    });

    Object.defineProperty(component, 'onShutdownForce', { value: undefined });
    const before = logMessages(logger).length;
    const retry = await retryStalled(manager, 'force');

    expect(retry).toMatchObject({
      success: false,
      code: 'component_shutdown_timeout',
      reason: LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
    });
    const retryLogs = logMessages(logger).slice(before);
    expect(retryLogs).not.toContain(
      'Component stalled - graceful shutdown failed',
    );
    expect(retryLogs).toContain(
      'Stalled component has no force handler to retry',
    );
  });

  test('a failed retry after graceful and force timeouts still reports both', async () => {
    const { logger, manager } = setup();
    const component = new HangsThroughForce(logger, 'slow');
    await manager.registerComponent(component);
    await manager.startComponent('slow');
    await manager.stopComponent('slow');
    const original = manager.getStalledComponents()[0];
    expect(original).toMatchObject({ phase: 'force', reason: 'timeout' });

    component.onShutdownForce = (): Promise<void> =>
      Promise.reject(new Error('force failed'));
    const contexts: unknown[] = [];
    manager.on('component:shutdown-force', (event: { context: unknown }) => {
      contexts.push(event.context);
    });
    const retry = await retryStalled(manager, 'slow');

    expect(retry).toMatchObject({ success: false, code: 'unknown_error' });
    expect(contexts).toEqual([
      { gracefulPhaseRan: false, gracefulTimedOut: false },
    ]);
    expect(manager.getStalledComponents()[0]).toMatchObject({
      phase: 'force',
      reason: 'both',
      startedAt: original.startedAt,
    });
  });

  test('a stalled retry force event describes only its own attempt', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new HangsThenForceThrows(logger, 'both'));
    await manager.startComponent('both');
    await manager.stopComponent('both');

    const contexts: unknown[] = [];
    manager.on('component:shutdown-force', (event: { context: unknown }) => {
      contexts.push(event.context);
    });
    await retryStalled(manager, 'both');

    expect(contexts).toEqual([
      { gracefulPhaseRan: false, gracefulTimedOut: false },
    ]);
    expect(manager.getStalledComponents()[0].reason).toBe('both');
  });

  test('a failed force retry keeps the original start time and timeout-then-error reason', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new HangsThenForceThrows(logger, 'both'));
    await manager.startComponent('both');
    await manager.stopComponent('both');
    const original = manager.getStalledComponents()[0];
    expect(original.reason).toBe('both');

    await new Promise((resolve) => setTimeout(resolve, 5));
    const retry = await retryStalled(manager, 'both');

    expect(retry).toMatchObject({ success: false, code: 'unknown_error' });
    const after = manager.getStalledComponents()[0];
    expect(after).toMatchObject({
      phase: 'force',
      reason: 'both',
      startedAt: original.startedAt,
    });
    expect(after.stalledAt).toBeGreaterThan(original.stalledAt);
  });

  test('detachSignals still announces the detach when a listener removal throws', () => {
    const { manager } = setup();
    let isAttached = true;
    (
      manager as unknown as { processSignalManager: unknown }
    ).processSignalManager = {
      getStatus: () => ({ isAttached }),
      detach: () => {
        isAttached = false;
        throw new Error('removal failed');
      },
    };
    let detachedEvents = 0;
    manager.on('lifecycle-manager:signals-detached', () => {
      detachedEvents++;
    });

    expect(() => manager.detachSignals()).toThrow('removal failed');

    expect(manager.getSignalStatus().isAttached).toBe(false);
    expect(detachedEvents).toBe(1);
  });
  test('a force-phase crash after a graceful timeout records both, with the stop start time', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new HangsThenForceThrows(logger, 'crash'));
    await manager.startComponent('crash');
    const stalledEvents: unknown[] = [];
    manager.on('component:stalled', (event: { reason?: string }) => {
      stalledEvents.push(event.reason);
    });

    crashNextCall(manager, 'createPendingForceStopWaiter');
    const { reports, release } = claimReports();
    const beforeStop = Date.now();
    let result: ComponentOperationResult;
    try {
      result = await manager.stopComponent('crash');
    } finally {
      release();
    }

    expect(result.code).toBe('unknown_error');
    expect(result.reason).toContain('Stop failed unexpectedly');
    expect(reports).toHaveLength(1);
    const stall = manager.getStalledComponents()[0];
    expect(stall).toMatchObject({ phase: 'force', reason: 'both' });
    expect(stall.startedAt).toBeGreaterThanOrEqual(beforeStop);
    // Includes the graceful phase's 20ms timeout: the stop's start, not the crash's.
    expect(stall.stalledAt - stall.startedAt).toBeGreaterThanOrEqual(15);
    expect(stalledEvents).toEqual(['both']);
  });

  test('a stalled retry that crashes keeps the original stall start time and timeout', async () => {
    const { logger, manager } = setup();
    const component = new HangsThroughForce(logger, 'slow');
    await manager.registerComponent(component);
    await manager.startComponent('slow');
    await manager.stopComponent('slow');
    const original = manager.getStalledComponents()[0];
    expect(original).toMatchObject({ phase: 'force', reason: 'timeout' });

    await new Promise((resolve) => setTimeout(resolve, 5));
    crashNextCall(manager, 'createPendingForceStopWaiter');
    const { release } = claimReports();
    let crashed: ComponentOperationResult;
    try {
      crashed = await retryStalled(manager, 'slow');
    } finally {
      release();
    }

    expect(crashed.reason).toContain('Stop failed unexpectedly');
    expect(manager.getStalledComponents()[0]).toMatchObject({
      phase: 'force',
      reason: 'both',
      startedAt: original.startedAt,
    });

    component.onShutdownForce = (): Promise<void> =>
      Promise.reject(new Error('force failed'));
    await retryStalled(manager, 'slow');

    expect(manager.getStalledComponents()[0]).toMatchObject({
      phase: 'force',
      reason: 'both',
      startedAt: original.startedAt,
    });
  });

  test('a crash between a graceful timeout and the force claim records the timeout', async () => {
    const { logger, manager } = setup();
    const component = new HangsThenForceThrows(logger, 'early');
    await manager.registerComponent(component);
    await manager.startComponent('early');
    Object.defineProperty(component, 'onShutdownForceAborted', {
      configurable: true,
      get(): never {
        throw new Error('abort hook read crashed');
      },
    });

    const stalledCodes: unknown[] = [];
    manager.on('component:stalled', (event) => {
      stalledCodes.push((event as { code?: unknown }).code);
    });
    const { release } = claimReports();
    const beforeStop = Date.now();
    let result: ComponentOperationResult;
    try {
      result = await manager.stopComponent('early');
    } finally {
      release();
    }

    const stall = manager.getStalledComponents()[0];
    expect(stall).toMatchObject({ phase: 'graceful', reason: 'timeout' });
    // Still a crash by code; the reason and status say the timeout came first.
    expect(result).toMatchObject({
      success: false,
      code: 'unknown_error',
      reason:
        'Stop failed unexpectedly after its graceful phase timed out: abort hook read crashed',
      status: {
        state: 'stalled',
        stallInfo: { phase: 'graceful', reason: 'timeout' },
      },
    });
    // The event's code agrees with the timeout reason it carries.
    expect(stalledCodes).toEqual(['component_shutdown_timeout']);
    expect(stall.startedAt).toBeGreaterThanOrEqual(beforeStop);

    // A retry that fails again still knows the graceful phase timed out.
    Reflect.deleteProperty(component, 'onShutdownForceAborted');
    await retryStalled(manager, 'early');
    expect(manager.getStalledComponents()[0]).toMatchObject({
      phase: 'force',
      reason: 'both',
      startedAt: stall.startedAt,
    });
  });

  test('a graceful-phase crash still records an error stall', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'plain'));
    await manager.startComponent('plain');

    crashNextCall(manager, 'createStopPhaseObserver');
    const { release } = claimReports();
    let result: ComponentOperationResult;
    try {
      result = await manager.stopComponent('plain');
    } finally {
      release();
    }

    expect(manager.getStalledComponents()[0]).toMatchObject({
      phase: 'graceful',
      reason: 'error',
    });
    expect(result).toMatchObject({
      code: 'unknown_error',
      reason: 'Stop failed unexpectedly: bookkeeping crashed',
      status: { state: 'stalled', stallInfo: { reason: 'error' } },
    });
  });

  test('a crashed stop whose status cannot be read answers without one', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new Plain(logger, 'plain'));
    await manager.startComponent('plain');

    Object.defineProperty(manager, 'getComponentStatus', {
      configurable: true,
      value: (): never => {
        throw new Error('status read crashed');
      },
    });
    const { release } = claimReports();
    let result: ComponentOperationResult;
    try {
      result = await manager.stopComponent('plain');
    } finally {
      release();
      Reflect.deleteProperty(manager, 'getComponentStatus');
    }

    expect(result).toMatchObject({
      success: false,
      code: 'unknown_error',
      reason: 'Stop failed unexpectedly: status read crashed',
    });
    expect(result.status).toBeUndefined();
  });

  test('a no-handler retry of a crash-recorded stall answers with the crash result', async () => {
    const { logger, manager } = setup();
    const component = new HangsThenForceThrows(logger, 'crash');
    await manager.registerComponent(component);
    await manager.startComponent('crash');

    crashNextCall(manager, 'createPendingForceStopWaiter');
    const { release } = claimReports();
    let crashed: ComponentOperationResult;
    try {
      crashed = await manager.stopComponent('crash');
    } finally {
      release();
    }
    const stall = manager.getStalledComponents()[0];

    component.onShutdownForce = undefined;
    const stalledEvents: unknown[] = [];
    manager.on('component:stalled', (event) => {
      stalledEvents.push(event);
    });
    const retried = await retryStalled(manager, 'crash');

    expect(retried).toMatchObject({
      success: false,
      code: crashed.code,
      reason: crashed.reason,
      error: crashed.error,
    });
    expect(retried.reason).toContain('Stop failed unexpectedly');
    expect(retried.status?.stallInfo).toBe(stall);
    expect(manager.getStalledComponents()[0]).toBe(stall);
    expect(stalledEvents).toEqual([]);
  });

  test('a forceImmediate stop without a force handler records a force-phase stall', async () => {
    const { logger, manager } = setup();
    await manager.registerComponent(new HangsWithoutForce(logger, 'hang'));
    await manager.startComponent('hang');

    const result = await manager.stopComponent('hang', {
      forceImmediate: true,
    });

    expect(result).toMatchObject({
      success: false,
      code: 'unknown_error',
      reason: 'Force shutdown failed',
    });
    expect(manager.getStalledComponents()[0]).toMatchObject({
      phase: 'force',
      reason: 'error',
    });
    expect(logMessages(logger)).toContain(
      'Component stalled - no force handler to run',
    );
    expect(logMessages(logger)).not.toContain(
      'Component stalled - graceful shutdown failed',
    );
  });
});
