import { expect, spyOn, test } from 'bun:test';
import { Logger } from '../../logger';
import { BaseComponent } from '../base-component';
import { LifecycleManagerEvents } from '../events';
import type {
  ComponentStallInfo,
  ComponentState,
  HealthCheckResult,
  HealthReport,
} from '../types';
import type { ComponentAccessContext } from './component-access-context';
import {
  broadcastMessageInternal,
  getValueInternal,
  sendMessageInternal,
} from './component-messaging';
import { isOperationOptionRefusal } from './operation-policy';
import { isComponentEnterable } from './component-dispatch';
import { claimReports } from '../test-helpers';
import {
  checkAllHealthOperation,
  checkComponentHealthOperation,
  runSignalBroadcast,
} from './component-inspection';

class AccessComponent extends BaseComponent {
  public start() {}
  public stop() {}
}

function fixture() {
  const logger = new Logger({ sinks: [], callProcessExit: false });
  const state = { components: [] as BaseComponent[] };
  const componentStates = new Map<string, ComponentState>();
  const runningComponents = new Set<string>();
  const events: string[] = [];
  const stalledComponents = new Map<string, ComponentStallInfo>();
  const pendingStarts = new Set<string>();
  const cleanupPending = new Set<string>();
  const context: ComponentAccessContext = {
    get components() {
      return state.components;
    },
    componentStates,
    stalledComponents,
    isStarting: false,
    messageTimeoutMS: 0,
    logger: logger.service('access-test'),
    lifecycleEvents: new LifecycleManagerEvents((name) => {
      events.push(name);
    }),
    nameOf: (component) => component.getName(),
    isComponentRunning: (name) => runningComponents.has(name),
    getComponent: (name) =>
      state.components.find((component) => component.getName() === name),
    isRawStartPending: (name) => pendingStarts.has(name),
    isLateStartCleanupPending: (name) => cleanupPending.has(name),
    sendMessageSettled: (name, payload, from, options) =>
      sendMessageInternal(context, name, payload, from, options),
    checkComponentHealth: (name) =>
      checkComponentHealthOperation(context, name),
    observeFailureAfterTimeout: () => {},
  };
  const add = (name: string) => {
    const component = new AccessComponent(logger, {
      name,
      healthCheckTimeoutMS: 0,
      signalTimeoutMS: 0,
    });
    state.components.push(component);
    componentStates.set(name, 'running');
    runningComponents.add(name);
    return component;
  };
  return {
    context,
    state,
    add,
    events,
    componentStates,
    runningComponents,
    stalledComponents,
    pendingStarts,
    cleanupPending,
  };
}

test('includeStalled does not enter a stalled component whose start() is still running', async () => {
  const {
    context,
    add,
    componentStates,
    runningComponents,
    stalledComponents,
    pendingStarts,
  } = fixture();
  const component = add('forced');
  let calls = 0;
  Object.defineProperty(component, 'onMessage', {
    value: () => {
      calls++;
    },
  });
  Object.defineProperty(component, 'getValue', {
    value: () => {
      calls++;
      return { found: true, value: 1 };
    },
  });
  componentStates.set('forced', 'stalled');
  runningComponents.delete('forced');
  stalledComponents.set('forced', {
    name: 'forced',
    phase: 'graceful',
    reason: 'timeout',
    startedAt: 0,
    stalledAt: 0,
  });
  pendingStarts.add('forced');

  const message = await sendMessageInternal(context, 'forced', 'hi', null, {
    includeStalled: true,
  });
  const value = getValueInternal(context, 'forced', 'key', null, {
    includeStalled: true,
  });

  expect(message.sent).toBe(false);
  expect(value.found).toBe(false);
  expect(calls).toBe(0);
  // Refused, but still labelled `stalled` - as health and the broadcast skip label it -
  // whether or not the caller opted into stalled components.
  expect(message.code).toBe('stalled');
  expect(value.code).toBe('stalled');
  for (const allowStalled of [false, true]) {
    const [row] = await broadcastMessageInternal(context, 'hi', null, {
      componentNames: ['forced'],
      includeStalled: allowStalled,
    });
    expect(row.code).toBe('stalled');
    expect(
      (
        await sendMessageInternal(context, 'forced', 'hi', null, {
          includeStalled: allowStalled,
        })
      ).code,
    ).toBe('stalled');
  }
  expect(calls).toBe(0);

  pendingStarts.delete('forced');
  const allowed = await sendMessageInternal(context, 'forced', 'hi', null, {
    includeStalled: true,
  });
  expect(allowed.sent).toBe(true);
  expect(calls).toBe(1);
});

test('message dispatch reads its handler once and preserves its receiver and async result', async () => {
  const { context, add, events } = fixture();
  const component = add('recipient');
  let reads = 0;
  Object.defineProperty(component, 'onMessage', {
    get() {
      reads++;
      return function (this: BaseComponent, payload: unknown, from: unknown) {
        expect(this).toBe(component);
        expect(from).toBe('sender');
        return Promise.resolve(payload);
      };
    },
  });
  const payload = { message: 'hello' };
  const result = await sendMessageInternal(
    context,
    'recipient',
    payload,
    'sender',
  );
  expect(result.code).toBe('sent');
  expect(result.data).toBe(payload);
  expect(reads).toBe(1);
  expect(events).toEqual(['component:message-sent']);
});

test.each([false, true])(
  'broadcast does not deliver to a replacement registered under a selected name mid-broadcast (includeStopped: %p)',
  async (shouldIncludeStopped) => {
    const { context, state, add, componentStates, runningComponents } =
      fixture();
    const first = add('first');
    const oldSecond = add('second');
    const replacement = add('replacement');
    // The replacement takes the same registered identity, without changing the
    // broadcast's original target snapshot.
    const recordedNames = new Map<BaseComponent, string>([
      [first, 'first'],
      [oldSecond, 'second'],
      [replacement, 'second'],
    ]);
    state.components = [first, oldSecond];
    const liveContext: ComponentAccessContext = {
      ...context,
      get components() {
        return state.components;
      },
      nameOf: (component) => recordedNames.get(component) ?? '',
      // Both lookup paths use the registration's recorded identity in the manager.
      getComponent: (name) =>
        state.components.find(
          (component) => recordedNames.get(component) === name,
        ),
      sendMessageSettled: (name, payload, from, options) =>
        sendMessageInternal(liveContext, name, payload, from, options),
    };
    let replacementCalls = 0;
    Object.defineProperty(first, 'onMessage', {
      value: () => {
        state.components = [first, replacement];
        // A freshly registered replacement is not running yet; `includeStopped`
        // would otherwise admit it under the selected target's name.
        componentStates.set('second', 'registered');
        runningComponents.delete('second');
        return Promise.resolve('first-result');
      },
    });
    Object.defineProperty(oldSecond, 'onMessage', {
      value: () => {
        throw new Error('The removed recipient must not be called');
      },
    });
    Object.defineProperty(replacement, 'onMessage', {
      value: () => {
        replacementCalls++;
        return Promise.resolve('replacement-result');
      },
    });
    const results = await broadcastMessageInternal(liveContext, 'hello', null, {
      includeStopped: shouldIncludeStopped,
    });
    expect(
      results.map((row) => ({
        name: row.name,
        sent: row.sent,
        data: row.data,
        code: row.code,
      })),
    ).toEqual([
      { name: 'first', sent: true, data: 'first-result', code: 'sent' },
      // The selected instance was unregistered mid-broadcast.
      { name: 'second', sent: false, data: undefined, code: 'stopped' },
    ]);
    expect(replacementCalls).toBe(0);
  },
);

test('value access reads a provider once and retains its receiver', () => {
  const { context, add, events } = fixture();
  const component = add('provider');
  let reads = 0;
  Object.defineProperty(component, 'getValue', {
    get() {
      reads++;
      return function (this: BaseComponent, key: string, from: unknown) {
        expect(this).toBe(component);
        expect(key).toBe('answer');
        expect(from).toBe(null);
        return { found: true, value: 42 };
      };
    },
  });
  expect(
    getValueInternal<number>(context, 'provider', 'answer', null),
  ).toMatchObject({
    code: 'found',
    value: 42,
  });
  expect(reads).toBe(1);
  expect(events).toEqual([
    'component:value-requested',
    'component:value-returned',
  ]);
});

test('health inspection reads its hook and timeout once, preserving asynchronous results', async () => {
  const { context, add, events } = fixture();
  const component = add('healthy');
  let handlerReads = 0;
  let timeoutReads = 0;
  Object.defineProperty(component, 'healthCheck', {
    get() {
      handlerReads++;
      return function (this: BaseComponent) {
        expect(this).toBe(component);
        return Promise.resolve({ healthy: true, message: 'ready' });
      };
    },
  });
  Object.defineProperty(component, 'healthCheckTimeoutMS', {
    get() {
      timeoutReads++;
      return 0;
    },
  });
  const report = await checkAllHealthOperation(context);
  expect(report.code).toBe('ok');
  expect(report.components[0]).toMatchObject({
    name: 'healthy',
    healthy: true,
    message: 'ready',
  });
  expect(handlerReads).toBe(1);
  expect(timeoutReads).toBe(1);
  expect(events).toEqual([
    'component:health-check-started',
    'component:health-check-completed',
  ]);
});

test('signal inspection rechecks availability after the started callback', async () => {
  const { context, add, componentStates, runningComponents } = fixture();
  const component = add('signal-target');
  let handlerReads = 0;
  let timeoutReads = 0;
  let calls = 0;
  const failed: string[] = [];
  Object.defineProperty(component, 'signalTimeoutMS', {
    get() {
      timeoutReads++;
      return 0;
    },
  });
  const result = await runSignalBroadcast(context, {
    signal: 'reload',
    pickHandler: (target) => {
      expect(target).toBe(component);
      handlerReads++;
      return () => {
        calls++;
      };
    },
    startupLog: 'starting',
    timeoutLog: 'timeout',
    errorLog: 'failed',
    emitStarted: (name) => {
      componentStates.set(name, 'stopping');
      runningComponents.delete(name);
    },
    emitCompleted: () => {
      throw new Error('Unavailable handler must not complete');
    },
    emitFailed: (name) => {
      failed.push(name);
    },
  });
  expect(result.results).toEqual([
    {
      name: 'signal-target',
      called: false,
      error: expect.any(Error),
      timedOut: false,
      code: 'unavailable',
    },
  ]);
  expect(result.code).toBe('error');
  expect(failed).toEqual(['signal-target']);
  expect(handlerReads).toBe(1);
  expect(timeoutReads).toBe(1);
  expect(calls).toBe(0);
});

test.each([
  ['a non-boolean found', { found: 'no', value: 1 }],
  ['a missing found', { value: 1 }],
  ['a non-object result', 'found'],
])('value access refuses %s as a handler error', (_label, answer) => {
  const { context, add } = fixture();
  const component = add('provider');
  Object.defineProperty(component, 'getValue', { value: () => answer });
  const result = getValueInternal(context, 'provider', 'key', null);
  expect(result).toMatchObject({
    found: false,
    value: undefined,
    handlerImplemented: true,
    code: 'error',
  });
  expect(result.error).toBeInstanceOf(TypeError);
});

test('value access reads found and value once each', () => {
  const { context, add } = fixture();
  const component = add('provider');
  const reads: string[] = [];
  Object.defineProperty(component, 'getValue', {
    value: () => ({
      get found() {
        reads.push('found');
        return true;
      },
      get value() {
        reads.push('value');
        return 7;
      },
    }),
  });
  expect(getValueInternal(context, 'provider', 'key', null)).toMatchObject({
    found: true,
    value: 7,
    code: 'found',
  });
  expect(reads).toEqual(['found', 'value']);
});

test('broadcast copies its componentNames once without calling the array methods', async () => {
  const { context, add } = fixture();
  for (const name of ['first', 'second', 'third']) {
    Object.defineProperty(add(name), 'onMessage', { value: () => name });
  }
  class HostileNames extends Array<string> {
    public override includes(): boolean {
      throw new Error('includes must not be called');
    }
  }
  const names = HostileNames.from(['third', 'first']) as HostileNames;
  const reads: PropertyKey[] = [];
  const proxy = new Proxy(names, {
    get(target, property, receiver) {
      reads.push(property);
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const results = await broadcastMessageInternal(context, 'hi', null, {
    componentNames: proxy,
  });
  // Registration order, filtered by the copied names.
  expect(results.map(({ name, data }) => ({ name, data }))).toEqual([
    { name: 'first', data: 'first' },
    { name: 'third', data: 'third' },
  ]);
  expect(reads).toEqual(['length', '0', '1']);
});

/** Run `operation`, collecting what it reports on the global error channel. */
async function captureReports<T>(
  operation: () => T | Promise<T>,
): Promise<{ result: T; reports: Error[] }> {
  const reports: Error[] = [];
  const onError = (event: ErrorEvent) => {
    reports.push(event.error as Error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  try {
    return { result: await operation(), reports };
  } finally {
    globalThis.removeEventListener('error', onError);
  }
}

/** Takes `name` out of service the way a stop that settled would. */
function stopIn(fixtureState: ReturnType<typeof fixture>, name: string): void {
  fixtureState.componentStates.set(name, 'stopped');
  fixtureState.runningComponents.delete(name);
}

test('a message handler getter that stops its component is answered as stopped, not no_handler', async () => {
  const state = fixture();
  const component = state.add('recipient');
  Object.defineProperty(component, 'onMessage', {
    get() {
      stopIn(state, 'recipient');
      return undefined;
    },
  });
  const result = await sendMessageInternal(
    state.context,
    'recipient',
    'hi',
    null,
  );
  expect(result).toMatchObject({
    sent: false,
    componentFound: true,
    componentRunning: false,
    handlerImplemented: false,
    code: 'stopped',
  });
  expect(state.events).toEqual([]);
});

test('a message handler getter that unregisters and throws is answered as not_found, but still reported', async () => {
  const state = fixture();
  const component = state.add('recipient');
  const error = new Error('getter failure');
  Object.defineProperty(component, 'onMessage', {
    get() {
      state.state.components = [];
      throw error;
    },
  });
  const { result, reports } = await captureReports(() =>
    sendMessageInternal(state.context, 'recipient', 'hi', null),
  );
  expect(result).toMatchObject({
    sent: false,
    componentFound: false,
    componentRunning: false,
    code: 'not_found',
    error: null,
  });
  // Nothing was announced, so nothing is left unpaired.
  expect(state.events).toEqual([]);
  expect(reports.map((report) => report.cause)).toEqual([error]);
});

test('a health check getter that stops its component is not counted healthy', async () => {
  const state = fixture();
  const component = state.add('checked');
  Object.defineProperty(component, 'healthCheck', {
    get() {
      stopIn(state, 'checked');
      return undefined;
    },
  });
  const report = await checkAllHealthOperation(state.context);
  expect(report.healthy).toBe(false);
  expect(report.components).toEqual([
    expect.objectContaining({
      name: 'checked',
      healthy: false,
      code: 'stopped',
      error: null,
    }),
  ]);
  expect(state.events).toEqual([]);
});

test('a health check getter that unregisters and throws is answered as not_found, but still reported', async () => {
  const state = fixture();
  const component = state.add('checked');
  const error = new Error('getter failure');
  Object.defineProperty(component, 'healthCheck', {
    get() {
      state.state.components = [];
      throw error;
    },
  });
  const { result, reports } = await captureReports(() =>
    checkComponentHealthOperation(state.context, 'checked'),
  );
  expect(result).toMatchObject({
    healthy: false,
    code: 'not_found',
    error: null,
  });
  expect(state.events).toEqual([]);
  expect(reports.map((report) => report.cause)).toEqual([error]);
});

test('a signal handler read that stops its component reports it unavailable with paired events', async () => {
  const state = fixture();
  const component = state.add('signal-target');
  let calls = 0;
  const events: string[] = [];
  const result = await runSignalBroadcast(state.context, {
    signal: 'reload',
    pickHandler: (target) => {
      expect(target).toBe(component);
      stopIn(state, 'signal-target');
      return () => {
        calls++;
      };
    },
    startupLog: 'starting',
    timeoutLog: 'timeout',
    errorLog: 'failed',
    emitStarted: (name) => {
      events.push(`started:${name}`);
    },
    emitCompleted: (name) => {
      events.push(`completed:${name}`);
    },
    emitFailed: (name) => {
      events.push(`failed:${name}`);
    },
  });
  // Selected for this dispatch, then taken down by its own read: reported as a started
  // listener taking it down is, with `started` and `failed` back to back.
  expect(result.code).toBe('error');
  expect(result.results).toHaveLength(1);
  expect(result.results[0]).toMatchObject({
    name: 'signal-target',
    called: false,
    timedOut: false,
    code: 'unavailable',
  });
  expect(result.results[0]?.error?.message).toBe(
    'Component "signal-target" became unavailable before reload dispatch',
  );
  expect(events).toEqual(['started:signal-target', 'failed:signal-target']);
  expect(calls).toBe(0);
});

test.each<unknown>([
  Infinity,
  5e7,
  -1,
  1.5,
  Number.NaN,
  // Not numbers: refused without coercion - `Number()` throws for a symbol and runs an
  // object's `valueOf`, and neither may escape as a crash instead of the refusal.
  Symbol('length'),
  {
    valueOf() {
      throw new Error('valueOf ran');
    },
  },
  '1',
  null,
])(
  'broadcast refuses componentNames with an implausible length (%p) before reading entries',
  async (length) => {
    const { context, add, events } = fixture();
    let calls = 0;
    Object.defineProperty(add('first'), 'onMessage', {
      value: () => {
        calls++;
      },
    });
    const entryReads: PropertyKey[] = [];
    const names = new Proxy(['first'], {
      get(target, property, receiver) {
        if (property === 'length') {
          return length;
        }
        entryReads.push(property);
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    let refusal: unknown;
    try {
      await broadcastMessageInternal(context, 'hi', null, {
        componentNames: names,
      });
    } catch (error) {
      refusal = error;
    }
    // The same branded refusal a non-array filter gets: `[]` and a warning upstream.
    expect(refusal).toBeInstanceOf(TypeError);
    expect(isOperationOptionRefusal(refusal)).toBe(true);
    expect((refusal as Error).message).toContain('componentNames');
    expect(entryReads).toEqual([]);
    expect(calls).toBe(0);
    expect(events).toEqual([]);
  },
);

test('a component under late-start cleanup is refused by every access operation', async () => {
  const state = fixture();
  const component = state.add('late');
  let calls = 0;
  for (const hook of ['onMessage', 'getValue', 'healthCheck']) {
    Object.defineProperty(component, hook, {
      value: () => {
        calls++;
        return hook === 'getValue' ? { found: true, value: 1 } : true;
      },
    });
  }
  // Late-start cleanup marks the component running only so that it can be stopped.
  state.cleanupPending.add('late');

  for (const shouldIncludeStopped of [false, true]) {
    const options = { includeStopped: shouldIncludeStopped };
    expect(
      await sendMessageInternal(state.context, 'late', 'hi', null, options),
    ).toMatchObject({ sent: false, componentFound: true, code: 'stopped' });
    expect(
      getValueInternal(state.context, 'late', 'key', null, options),
    ).toMatchObject({ found: false, componentFound: true, code: 'stopped' });
    const [row] = await broadcastMessageInternal(state.context, 'hi', null, {
      ...options,
      componentNames: ['late'],
    });
    expect(row).toMatchObject({ name: 'late', sent: false, code: 'stopped' });
  }
  // Not an eligible recipient of an unfiltered broadcast.
  expect(await broadcastMessageInternal(state.context, 'hi', null)).toEqual([]);
  expect(
    await checkComponentHealthOperation(state.context, 'late'),
  ).toMatchObject({ healthy: false, code: 'stopped' });
  const signals = await runSignalBroadcast(state.context, {
    signal: 'reload',
    pickHandler: () => () => {
      calls++;
    },
    startupLog: 'starting',
    timeoutLog: 'timeout',
    errorLog: 'failed',
    emitStarted: () => {},
    emitCompleted: () => {},
    emitFailed: () => {},
  });
  expect(signals.results).toEqual([]);
  expect(calls).toBe(0);

  // Once cleanup ends the same registration is reachable again.
  state.cleanupPending.delete('late');
  expect(
    (await sendMessageInternal(state.context, 'late', 'hi', null)).code,
  ).toBe('sent');
  expect(calls).toBe(1);
});

test('message, value, health and signal dispatch share one entry rule for a running component whose start() is pending', async () => {
  const state = fixture();
  const component = state.add('pending');
  let calls = 0;
  for (const hook of ['onMessage', 'getValue', 'healthCheck']) {
    Object.defineProperty(component, hook, {
      value: () => {
        calls++;
        return hook === 'getValue' ? { found: true, value: 1 } : true;
      },
    });
  }
  // Running by membership and state, but a start of it is still running: health and
  // signals used to ask only whether it was up, while messaging refused it.
  state.pendingStarts.add('pending');

  expect(
    await sendMessageInternal(state.context, 'pending', 'hi', null),
  ).toMatchObject({ sent: false, code: 'stopped' });
  expect(getValueInternal(state.context, 'pending', 'key', null)).toMatchObject(
    { found: false, code: 'stopped' },
  );
  expect(
    await checkComponentHealthOperation(state.context, 'pending'),
  ).toMatchObject({ healthy: false, code: 'stopped' });
  const signals = await runSignalBroadcast(state.context, {
    signal: 'reload',
    pickHandler: () => () => {
      calls++;
    },
    startupLog: 'starting',
    timeoutLog: 'timeout',
    errorLog: 'failed',
    emitStarted: () => {},
    emitCompleted: () => {},
    emitFailed: () => {},
  });
  expect(signals.results).toEqual([]);
  expect(calls).toBe(0);

  state.pendingStarts.delete('pending');
  expect(
    await checkComponentHealthOperation(state.context, 'pending'),
  ).toMatchObject({ healthy: true, code: 'ok' });
  expect(calls).toBe(1);
});

test('a target becoming unavailable in the started listener is refused the same way by message, health and signal dispatch', async () => {
  const state = fixture();
  const component = state.add('target');
  let calls = 0;
  for (const hook of ['onMessage', 'healthCheck']) {
    Object.defineProperty(component, hook, {
      value: () => {
        calls++;
        return true;
      },
    });
  }
  const context: ComponentAccessContext = {
    ...state.context,
    lifecycleEvents: new LifecycleManagerEvents((name) => {
      state.events.push(name);
      if (name.endsWith('-started') || name === 'component:message-sent') {
        state.cleanupPending.add('target');
      }
    }),
  };
  const message = await sendMessageInternal(context, 'target', 'hi', null);
  expect(message).toMatchObject({ sent: false, code: 'stopped' });
  state.cleanupPending.delete('target');
  const health = await checkComponentHealthOperation(context, 'target');
  expect(health).toMatchObject({ healthy: false, code: 'stopped' });
  expect(calls).toBe(0);
  expect(state.events).toEqual([
    'component:message-sent',
    'component:message-failed',
    'component:health-check-started',
    'component:health-check-failed',
  ]);
});

test('checkAllHealth leaves out a component under late-start cleanup, as broadcast selection does', async () => {
  const state = fixture();
  let calls = 0;
  for (const name of ['healthy', 'late']) {
    Object.defineProperty(state.add(name), 'healthCheck', {
      value: () => {
        calls++;
        return true;
      },
    });
  }
  // Marked running only so that it can be stopped: not a running member the report is
  // about, so it must not answer `stopped` and flip the aggregate to degraded.
  state.cleanupPending.add('late');

  const report = await checkAllHealthOperation(state.context);

  expect(report.components.map(({ name }) => name)).toEqual(['healthy']);
  expect(report).toMatchObject({ healthy: true, code: 'ok' });
  expect(calls).toBe(1);
  expect(state.events).toEqual([
    'component:health-check-started',
    'component:health-check-completed',
  ]);
});

test('message availability evaluates the hook-entry block once per read', async () => {
  const { context, add } = fixture();
  add('target');
  let blockReads = 0;
  const counted: ComponentAccessContext = {
    ...context,
    isRawStartPending: () => {
      blockReads++;
      return false;
    },
  };

  // No handler: the initial availability read and the recheck after the handler read.
  const result = await sendMessageInternal(counted, 'target', 'hi', null);

  expect(result.code).toBe('no_handler');
  expect(blockReads).toBe(2);
});

test('health checks look the component up once before reading its hook, getValue again after its options', async () => {
  const { context, add } = fixture();
  add('target');
  let lookups = 0;
  const counted: ComponentAccessContext = {
    ...context,
    getComponent: (name) => {
      lookups++;
      return context.getComponent(name);
    },
  };

  // No handler: the lookup that finds the component, the first availability read - the
  // options getters and `value-requested` listeners have run since that lookup - and
  // the recheck after the handler read.
  expect(getValueInternal(counted, 'target', 'key', null).code).toBe(
    'no_handler',
  );
  expect(lookups).toBe(3);

  // The lookup, then the recheck after the handler read. The first availability read
  // follows that lookup with no caller code between, so it does not repeat it.
  lookups = 0;
  expect((await checkComponentHealthOperation(counted, 'target')).code).toBe(
    'no_handler',
  );
  expect(lookups).toBe(2);
});

test('getValue answers a missing component not_found without reading its options', () => {
  const { context, events } = fixture();
  const options = {
    get includeStopped(): boolean {
      throw new Error('options exploded');
    },
  };

  const result = getValueInternal(context, 'missing', 'key', null, options);

  expect(result).toMatchObject({
    found: false,
    componentFound: false,
    handlerImplemented: false,
    code: 'not_found',
  });
  expect(events).toEqual([
    'component:value-requested',
    'component:value-returned',
  ]);
});

test('getValue rechecks the captured component after its options getters run', () => {
  const { context, state, add, events } = fixture();
  add('target');
  const options = {
    get includeStopped(): boolean {
      state.components = [];
      return false;
    },
  };

  const result = getValueInternal(context, 'target', 'key', null, options);

  expect(result).toMatchObject({ componentFound: false, code: 'not_found' });
  expect(events).toEqual([
    'component:value-requested',
    'component:value-returned',
  ]);
});

test('a message handler getter that stops its component reports the handler it returned', async () => {
  const state = fixture();
  const component = state.add('recipient');
  Object.defineProperty(component, 'onMessage', {
    get() {
      stopIn(state, 'recipient');
      return () => 'unused';
    },
  });
  Object.defineProperty(component, 'getValue', {
    get() {
      stopIn(state, 'recipient');
      return () => ({ found: true, value: 'unused' });
    },
  });

  const message = await sendMessageInternal(
    state.context,
    'recipient',
    'hi',
    null,
  );
  state.componentStates.set('recipient', 'running');
  state.runningComponents.add('recipient');
  const value = getValueInternal(state.context, 'recipient', 'key', null);

  // Both record whether the captured target's handler was found.
  expect(message).toMatchObject({ code: 'stopped', handlerImplemented: true });
  expect(value).toMatchObject({ code: 'stopped', handlerImplemented: true });
});

test('checkAllHealth aggregates entry outcomes into its code', async () => {
  const entry = (overrides: Partial<HealthCheckResult>): HealthCheckResult => ({
    name: 'target',
    healthy: true,
    message: undefined,
    checkedAt: 0,
    durationMS: 0,
    error: null,
    timedOut: false,
    code: 'ok',
    ...overrides,
  });
  const cases: Array<{
    entries: HealthCheckResult[];
    code: HealthReport['code'];
  }> = [
    { entries: [entry({}), entry({ code: 'no_handler' })], code: 'ok' },
    { entries: [entry({}), entry({ healthy: false })], code: 'degraded' },
    {
      entries: [entry({}), entry({ healthy: false, code: 'stopped' })],
      code: 'degraded',
    },
    {
      entries: [entry({ healthy: false, code: 'stalled' })],
      code: 'degraded',
    },
    {
      entries: [
        entry({ healthy: false, code: 'stopped' }),
        entry({ healthy: false, timedOut: true, code: 'timeout' }),
      ],
      code: 'timeout',
    },
    {
      entries: [
        entry({ healthy: false, timedOut: true, code: 'timeout' }),
        entry({ healthy: false, error: new Error('boom'), code: 'error' }),
      ],
      code: 'error',
    },
  ];

  for (const { entries, code } of cases) {
    const { context, add } = fixture();
    for (const [index] of entries.entries()) {
      add(`c${String(index)}`);
    }
    let next = 0;
    const report = await checkAllHealthOperation({
      ...context,
      checkComponentHealth: () => Promise.resolve(entries[next++]),
    });
    expect(report.code).toBe(code);
    expect(report.healthy).toBe(code === 'ok');
  }
});

test('isComponentEnterable answers from an explicitly passed undefined state', () => {
  const { context, add, componentStates } = fixture();
  add('target');
  let stateReads = 0;
  const originalGet = componentStates.get.bind(componentStates);
  spyOn(componentStates, 'get').mockImplementation((name) => {
    stateReads++;
    return originalGet(name);
  });

  // The caller's own read found no state: that is the answer, not a cue to read again.
  expect(isComponentEnterable(context, 'target', undefined)).toBe(false);
  expect(stateReads).toBe(0);
  expect(isComponentEnterable(context, 'target', 'running')).toBe(true);
});

test.each([
  [
    'an invalid signalTimeoutMS',
    (component: BaseComponent) => {
      Object.defineProperty(component, 'signalTimeoutMS', { value: NaN });
      return () => {};
    },
    'invalid_options',
  ],
  [
    'a throwing handler getter',
    () => {
      throw new Error('getter exploded');
    },
    'operation_crashed',
  ],
] as const)(
  'a signal whose configuration read fails emits paired started/failed events (%s)',
  async (_label, pick, code) => {
    const { context, add } = fixture();
    add('target');
    const events: string[] = [];
    let failedWith: Error | undefined;
    const { reports, release } = claimReports();
    let result;
    try {
      result = await runSignalBroadcast(context, {
        signal: 'reload',
        pickHandler: pick,
        startupLog: 'starting',
        timeoutLog: 'timeout',
        errorLog: 'failed',
        emitStarted: (name) => {
          events.push(`started:${name}`);
        },
        emitCompleted: (name) => {
          events.push(`completed:${name}`);
        },
        emitFailed: (name, error) => {
          events.push(`failed:${name}`);
          failedWith = error;
        },
      });
    } finally {
      release();
    }

    expect(result.results).toEqual([
      {
        name: 'target',
        called: false,
        error: expect.any(Error),
        timedOut: false,
        code,
      },
    ]);
    // As a health check whose configuration read fails: `started` first, so a listener
    // counting signals in flight stays paired.
    expect(events).toEqual(['started:target', 'failed:target']);
    expect(failedWith).toBe(result.results[0]?.error ?? undefined);
    expect(reports).toHaveLength(code === 'operation_crashed' ? 1 : 0);
  },
);

test('a getValue getter that throws is logged, as a message handler getter is', () => {
  const { context, add } = fixture();
  const error = new Error('getter exploded');
  Object.defineProperty(add('provider'), 'getValue', {
    get() {
      throw error;
    },
  });
  spyOn(context.logger, 'entity').mockReturnValue(context.logger);
  const logged = spyOn(context.logger, 'error').mockImplementation(() => {});
  const { reports, release } = claimReports();
  let result;
  try {
    result = getValueInternal(context, 'provider', 'key', 'caller');
  } finally {
    release();
  }

  expect(result).toMatchObject({ code: 'operation_crashed', error });
  expect(reports).toHaveLength(1);
  expect(logged).toHaveBeenCalledWith(
    'getValue handler failed: {{error.message}}',
    { params: { error, key: 'key', from: 'caller' } },
  );
});

test('aggregate health does not check a replacement under a selected component name', async () => {
  const { context, state, add } = fixture();
  const first = add('first');
  add('second');
  const replacement = add('second');
  state.components.pop();
  let replacementCalls = 0;
  Object.defineProperty(replacement, 'healthCheck', {
    value: () => {
      replacementCalls++;
      return { healthy: true };
    },
  });
  Object.defineProperty(first, 'healthCheck', {
    get() {
      state.components[1] = replacement;
      return () => ({ healthy: true });
    },
  });
  const result = await checkAllHealthOperation(context);
  expect(result.components[1]).toMatchObject({
    name: 'second',
    code: 'not_found',
    healthy: false,
  });
  expect(replacementCalls).toBe(0);
});
