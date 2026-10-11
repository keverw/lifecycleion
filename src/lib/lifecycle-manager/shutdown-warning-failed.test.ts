import { expect, test } from 'bun:test';
import type { LifecycleManagerEventMap } from './events';
import type { LifecycleManager } from './lifecycle-manager';
import { Plain, deferred, setup } from './test-helpers';

// Records every per-component warning event and the phase's own outcome, in order.
function recordWarningEvents(manager: LifecycleManager): {
  events: string[];
  failures: LifecycleManagerEventMap['component:shutdown-warning-failed'][];
  timeouts: LifecycleManagerEventMap['lifecycle-manager:shutdown-warning-timeout'][];
} {
  const events: string[] = [];
  const failures: LifecycleManagerEventMap['component:shutdown-warning-failed'][] =
    [];
  const timeouts: LifecycleManagerEventMap['lifecycle-manager:shutdown-warning-timeout'][] =
    [];

  manager.on<LifecycleManagerEventMap['component:shutdown-warning']>(
    'component:shutdown-warning',
    ({ name }) => {
      events.push(`selected:${name}`);
    },
  );
  manager.on<LifecycleManagerEventMap['component:shutdown-warning-completed']>(
    'component:shutdown-warning-completed',
    ({ name }) => {
      events.push(`completed:${name}`);
    },
  );
  manager.on<LifecycleManagerEventMap['component:shutdown-warning-failed']>(
    'component:shutdown-warning-failed',
    (event) => {
      failures.push(event);
      events.push(`failed:${event.name}`);
    },
  );
  manager.on<LifecycleManagerEventMap['component:shutdown-warning-skipped']>(
    'component:shutdown-warning-skipped',
    ({ name }) => {
      events.push(`skipped:${name}`);
    },
  );
  manager.on<LifecycleManagerEventMap['component:shutdown-warning-timeout']>(
    'component:shutdown-warning-timeout',
    ({ name }) => {
      events.push(`timeout:${name}`);
    },
  );
  manager.on<
    LifecycleManagerEventMap['lifecycle-manager:shutdown-warning-completed']
  >('lifecycle-manager:shutdown-warning-completed', () => {
    events.push('phase-completed');
  });
  manager.on<
    LifecycleManagerEventMap['lifecycle-manager:shutdown-warning-timeout']
  >('lifecycle-manager:shutdown-warning-timeout', (event) => {
    timeouts.push(event);
    events.push('phase-timeout');
  });

  return { events, failures, timeouts };
}

test.each([0, 100])(
  'a warning hook that throws synchronously emits component:shutdown-warning-failed (timeout: %s)',
  async (shutdownWarningTimeoutMS) => {
    const { logger, manager } = setup({ shutdownWarningTimeoutMS });
    const component = new Plain(logger, 'component');
    const error = new Error('sync warning failure');
    component.onShutdownWarning = () => {
      throw error;
    };
    const { events, failures } = recordWarningEvents(manager);

    await manager.registerComponent(component);
    await manager.startAllComponents();
    expect((await manager.stopAllComponents()).success).toBe(true);

    expect(failures).toEqual([{ name: 'component', error }]);
    expect(failures[0].error).toBe(error);
    // Detached mode publishes the phase completion once hooks have started; the
    // synchronous throw has already been reported by then.
    expect(events).toEqual([
      'selected:component',
      'failed:component',
      'phase-completed',
    ]);
  },
);

test('a warning hook that rejects emits component:shutdown-warning-failed once', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 100 });
  const component = new Plain(logger, 'component');
  component.onShutdownWarning = () =>
    Promise.reject(new Error('async failure'));
  const { events, failures } = recordWarningEvents(manager);

  await manager.registerComponent(component);
  await manager.startAllComponents();
  expect((await manager.stopAllComponents()).success).toBe(true);

  expect(failures).toHaveLength(1);
  expect(failures[0].name).toBe('component');
  expect(failures[0].error).toBeInstanceOf(Error);
  expect(failures[0].error.message).toBe('async failure');
  expect(events).toEqual([
    'selected:component',
    'failed:component',
    'phase-completed',
  ]);
});

test('a non-Error rejection is normalized to an Error on the failed event', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 100 });
  const component = new Plain(logger, 'component');
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  component.onShutdownWarning = () => Promise.reject('plain string');
  const { failures } = recordWarningEvents(manager);

  await manager.registerComponent(component);
  await manager.startAllComponents();
  await manager.stopAllComponents();

  expect(failures).toHaveLength(1);
  expect(failures[0].error).toBeInstanceOf(Error);
  expect(failures[0].error.cause).toBe('plain string');
});

test('a detached (timeout 0) warning hook that rejects later still emits failed', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 0 });
  const component = new Plain(logger, 'component');
  const hook = deferred();
  component.onShutdownWarning = () => hook.promise;
  const { events, failures } = recordWarningEvents(manager);

  await manager.registerComponent(component);
  await manager.startAllComponents();
  expect((await manager.stopAllComponents()).success).toBe(true);
  expect(events).toEqual(['selected:component', 'phase-completed']);

  hook.reject(new Error('late detached failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(failures.map(({ error }) => error.message)).toEqual([
    'late detached failure',
  ]);
  expect(events).toEqual([
    'selected:component',
    'phase-completed',
    'failed:component',
  ]);
});

test('a hook that rejects before the deadline is left out of the timeout, a pending one is not', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 30 });
  const failing = new Plain(logger, 'failing');
  const pending = new Plain(logger, 'pending');
  const pendingHook = deferred();
  failing.onShutdownWarning = () => Promise.reject(new Error('early failure'));
  pending.onShutdownWarning = () => pendingHook.promise;
  const { events, failures, timeouts } = recordWarningEvents(manager);

  await manager.registerComponent(failing);
  await manager.registerComponent(pending);
  await manager.startAllComponents();
  expect((await manager.stopAllComponents()).success).toBe(true);

  expect(failures.map(({ name }) => name)).toEqual(['failing']);
  expect(timeouts).toEqual([{ timeoutMS: 30, pending: ['pending'] }]);
  expect(events.filter((event) => event.endsWith(':failing'))).toEqual([
    'selected:failing',
    'failed:failing',
  ]);
  expect(events.filter((event) => event.endsWith(':pending'))).toEqual([
    'selected:pending',
    'timeout:pending',
  ]);
  expect(events).not.toContain('phase-completed');
  pendingHook.resolve();
});

test('a hook that rejects after its timeout was announced emits no second terminal event', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 20 });
  const component = new Plain(logger, 'component');
  const hook = deferred();
  component.onShutdownWarning = () => hook.promise;
  const { events, failures, timeouts } = recordWarningEvents(manager);

  await manager.registerComponent(component);
  await manager.startAllComponents();
  expect((await manager.stopAllComponents()).success).toBe(true);
  expect(timeouts).toEqual([{ timeoutMS: 20, pending: ['component'] }]);

  hook.reject(new Error('late failure'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(failures).toEqual([]);
  expect(events).toEqual([
    'selected:component',
    'timeout:component',
    'phase-timeout',
  ]);
});

test('a hook that rejects between the deadline firing and the timeout report gets only failed', async () => {
  const { logger, manager } = setup({ shutdownWarningTimeoutMS: 20 });
  const component = new Plain(logger, 'component');
  const hook = deferred();
  component.onShutdownWarning = () => hook.promise;
  const { events, timeouts } = recordWarningEvents(manager);

  // Reject the hook in the deadline's own timer turn, just before the deadline fires.
  // The timeout then wins the race, but the hook's rejection reaches its handler
  // before the phase resumes from its await to report pending components: the gap in
  // which a failure used to be reported and then announced as timed out as well.
  const realSetTimeout = globalThis.setTimeout;
  let isArmed = false;
  globalThis.setTimeout = ((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) =>
    realSetTimeout(
      (...callbackArgs: unknown[]) => {
        if (delay === 20 && !isArmed) {
          isArmed = true;
          hook.reject(new Error('racing failure'));
        }
        callback(...callbackArgs);
      },
      delay,
      ...args,
    )) as typeof setTimeout;

  try {
    await manager.registerComponent(component);
    await manager.startAllComponents();
    expect((await manager.stopAllComponents()).success).toBe(true);
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }

  expect(isArmed).toBe(true);
  // Exactly one terminal event for the component, and the phase's pending list agrees.
  expect(events).toEqual([
    'selected:component',
    'failed:component',
    'phase-timeout',
  ]);
  expect(timeouts).toEqual([{ timeoutMS: 20, pending: [] }]);
});
