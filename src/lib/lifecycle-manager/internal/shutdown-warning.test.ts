import { expect, spyOn, test } from 'bun:test';
import { Logger } from '../../logger';
import { BaseComponent } from '../base-component';
import { LifecycleManagerEvents } from '../events';
import type { ComponentState } from '../types';
import {
  runShutdownWarningPhase,
  type ShutdownWarningContext,
} from './shutdown-warning';

class WarningComponent extends BaseComponent {
  public start() {}
  public stop() {}
}

function fixture() {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const components = new Map<string, BaseComponent>();
  const componentStates = new Map<string, ComponentState>();
  const events: { name: string; payload: unknown }[] = [];
  const pendingStarts = new Set<string>();
  const context: ShutdownWarningContext = {
    getComponent: (name) => components.get(name),
    componentStates,
    isRawStartPending: (name) => pendingStarts.has(name),
    logger: logger.service('warning-test'),
    lifecycleEvents: new LifecycleManagerEvents((name, payload) => {
      events.push({ name, payload });
    }),
  };
  const add = (name: string, hook?: () => unknown) => {
    const component = new WarningComponent(logger, { name });
    if (hook) {
      Object.defineProperty(component, 'onShutdownWarning', { value: hook });
    }
    components.set(name, component);
    componentStates.set(name, 'running');
    return component;
  };
  return { context, add, events, components, componentStates, pendingStarts };
}

test('a stalled component whose start() is still running gets no warning', async () => {
  const { context, add, events, componentStates, pendingStarts } = fixture();
  let calls = 0;
  add('forced', () => {
    calls++;
  });
  componentStates.set('forced', 'stalled');
  pendingStarts.add('forced');

  await runShutdownWarningPhase(context, ['forced'], 100);

  expect(calls).toBe(0);
  expect(events).toEqual([]);
});

async function flushWarnings() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test('disabled, empty, and hookless warning phases publish nothing', async () => {
  const { context, add, events } = fixture();
  add('hookless');
  const lookup = spyOn(context, 'getComponent');
  await runShutdownWarningPhase(context, ['hookless'], -1);
  await runShutdownWarningPhase(context, [], 100);
  expect(lookup).not.toHaveBeenCalled();
  await runShutdownWarningPhase(context, ['hookless', 'missing'], 100);
  expect(events).toEqual([]);
});

test.each([
  'running',
  'stopping',
  'force-stopping',
  'stopped',
  'stalled',
] as const)(
  'selection captures the hook once and rechecks teardown before invocation (state: %s)',
  async (state) => {
    const { context, add, events, componentStates } = fixture();
    const trace: string[] = [];
    const component = add('first');
    Object.defineProperty(component, 'onShutdownWarning', {
      get() {
        trace.push('hook-read');
        componentStates.set('first', state);
        return function (this: BaseComponent) {
          expect(this).toBe(component);
          trace.push('hook-call');
        };
      },
    });
    spyOn(context, 'getComponent').mockImplementation(() => {
      trace.push('lookup');
      return component;
    });
    const originalGet = componentStates.get.bind(componentStates);
    spyOn(componentStates, 'get').mockImplementation((name) => {
      trace.push('state');
      return originalGet(name);
    });
    const phase = runShutdownWarningPhase(context, ['first'], 100);
    expect(trace).toEqual(['lookup', 'state', 'hook-read']);
    expect(events.map(({ name }) => name)).toEqual([
      'lifecycle-manager:shutdown-warning',
      'component:shutdown-warning',
    ]);
    await phase;
    expect(trace).toEqual([
      'lookup',
      'state',
      'hook-read',
      'lookup',
      'state',
      ...(state === 'running' ? ['hook-call'] : []),
    ]);
    expect(events.slice(2)).toEqual([
      ...(state !== 'running'
        ? [
            {
              name: 'component:shutdown-warning-skipped',
              payload: {
                name: 'first',
                reason: 'component_not_available',
                state,
              },
            },
          ]
        : [
            {
              name: 'component:shutdown-warning-completed',
              payload: { name: 'first' },
            },
          ]),
      {
        name: 'lifecycle-manager:shutdown-warning-completed',
        payload: { timeoutMS: 100 },
      },
    ]);
  },
);

test('stopping components still have their hooks read but are not warned', async () => {
  const { context, add, events, componentStates } = fixture();
  let reads = 0;
  for (const state of ['stopping', 'force-stopping'] as const) {
    const component = add(state);
    componentStates.set(state, state);
    Object.defineProperty(component, 'onShutdownWarning', {
      get() {
        reads++;
        return () => {
          throw new Error('must not run');
        };
      },
    });
  }
  await runShutdownWarningPhase(context, ['stopping', 'force-stopping'], 10);
  expect(reads).toBe(2);
  expect(events).toEqual([]);
});

test('zero timeout starts hooks before completing without waiting for their settlement', async () => {
  const { context, add, events } = fixture();
  let resolve!: () => void;
  let wasCalled = false;
  add('pending', () => {
    wasCalled = true;
    expect(
      events.some(
        ({ name }) => name === 'lifecycle-manager:shutdown-warning-completed',
      ),
    ).toBe(false);
    return new Promise<void>((done) => {
      resolve = done;
    });
  });
  const phase = runShutdownWarningPhase(context, ['pending'], 0);
  expect(wasCalled).toBe(false);
  await phase;
  expect(wasCalled).toBe(true);
  expect(events.at(-1)).toEqual({
    name: 'lifecycle-manager:shutdown-warning-completed',
    payload: { timeoutMS: 0 },
  });
  resolve();
  await flushWarnings();
  expect(events.at(-1)).toEqual({
    name: 'component:shutdown-warning-completed',
    payload: { name: 'pending' },
  });
});

test('positive timeout reports only pending components and contains late failures', async () => {
  const { context, add, events } = fixture();
  const warning = spyOn(context.logger, 'warn').mockImplementation(() => {});
  spyOn(context.logger, 'entity').mockReturnValue(context.logger);
  let reject!: (error: Error) => void;
  add('complete', () => Promise.resolve());
  add(
    'pending',
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  await runShutdownWarningPhase(context, ['complete', 'pending'], 10);
  expect(events.slice(-2)).toEqual([
    {
      name: 'component:shutdown-warning-timeout',
      payload: { name: 'pending', timeoutMS: 10 },
    },
    {
      name: 'lifecycle-manager:shutdown-warning-timeout',
      payload: { timeoutMS: 10, pending: ['pending'] },
    },
  ]);
  expect(warning).toHaveBeenCalledWith('Shutdown warning phase timed out', {
    params: { timeoutMS: 10, pending: 1 },
  });
  const error = new Error('late rejection');
  reject(error);
  await flushWarnings();
  expect(warning).toHaveBeenLastCalledWith(
    'Shutdown warning phase failed: {{error.message}}',
    { params: { error } },
  );
  expect(
    events.some(
      ({ name }) => name === 'lifecycle-manager:shutdown-warning-completed',
    ),
  ).toBe(false);
});

test('hook and warning-report failures remain contained in both delivery modes', async () => {
  for (const timeoutMS of [0, 100]) {
    const { context, add, events } = fixture();
    add('failure', () => {
      throw new Error('hook failure');
    });
    const report = spyOn(context.logger, 'entity').mockImplementation(() => {
      throw new Error('report failure');
    });
    await runShutdownWarningPhase(context, ['failure'], timeoutMS);
    await flushWarnings();
    expect(report).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({
      name: 'lifecycle-manager:shutdown-warning-completed',
      payload: { timeoutMS },
    });
    expect(
      events.some(
        ({ name }) => name === 'component:shutdown-warning-completed',
      ),
    ).toBe(false);
  }
});

test('throwing hook getters report their component and allow remaining warnings', async () => {
  const { context, add, events } = fixture();
  const error = new Error('getter failure');
  const reports: Error[] = [];
  const onError = (event: ErrorEvent) => {
    reports.push(event.error as Error);
    event.preventDefault();
  };
  Object.defineProperty(add('broken'), 'onShutdownWarning', {
    get() {
      throw error;
    },
  });
  let wasCalled = false;
  add('healthy', () => {
    wasCalled = true;
  });
  globalThis.addEventListener('error', onError);
  try {
    await runShutdownWarningPhase(context, ['broken', 'healthy'], 100);
  } finally {
    globalThis.removeEventListener('error', onError);
  }
  expect(reports).toHaveLength(1);
  expect(reports[0]?.message).toBe(
    'Error in a callback lifecycle-manager shutdown warning for broken',
  );
  expect(reports[0]?.cause).toBe(error);
  expect(wasCalled).toBe(true);
  expect(
    events.filter(({ name }) => name === 'component:shutdown-warning'),
  ).toEqual([
    { name: 'component:shutdown-warning', payload: { name: 'healthy' } },
  ]);
});

test('an unregistered target is skipped as not found without a state key; a replaced one as changed', async () => {
  const { context, add, events, components, componentStates } = fixture();
  let calls = 0;
  const hook = (): void => {
    calls++;
  };
  add('gone', hook);
  add('swapped', hook);
  const phase = runShutdownWarningPhase(context, ['gone', 'swapped'], 100);
  // Both are selected and announced; the recheck runs a microtask later.
  components.delete('gone');
  componentStates.delete('gone');
  add('swapped', hook);
  await phase;

  expect(calls).toBe(0);
  const skipped = events
    .filter(({ name }) => name === 'component:shutdown-warning-skipped')
    .map(({ payload }) => payload);
  // Strict: `state` is omitted, not present as `undefined`, for an unregistered name.
  expect(skipped).toStrictEqual([
    { name: 'gone', reason: 'component_not_found' },
    { name: 'swapped', reason: 'component_changed', state: 'running' },
  ]);
});

test('a warning hook that resolves after the phase timed out does not also report completion', async () => {
  const { context, add, events } = fixture();
  spyOn(context.logger, 'warn').mockImplementation(() => {});
  spyOn(context.logger, 'entity').mockReturnValue(context.logger);
  let resolve!: () => void;
  add('complete', () => Promise.resolve());
  add(
    'pending',
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  await runShutdownWarningPhase(context, ['complete', 'pending'], 10);
  resolve();
  await flushWarnings();
  // Each component has exactly one outcome: `complete` completed, `pending` timed out.
  expect(
    events
      .filter(({ name }) =>
        [
          'component:shutdown-warning-completed',
          'component:shutdown-warning-timeout',
        ].includes(name),
      )
      .map(({ name, payload }) => ({ name, payload })),
  ).toEqual([
    {
      name: 'component:shutdown-warning-completed',
      payload: { name: 'complete' },
    },
    {
      name: 'component:shutdown-warning-timeout',
      payload: { name: 'pending', timeoutMS: 10 },
    },
  ]);
  expect(events.at(-1)?.name).toBe(
    'lifecycle-manager:shutdown-warning-timeout',
  );
});
