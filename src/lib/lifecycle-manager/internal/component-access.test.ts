import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import { BaseComponent } from '../base-component';
import { LifecycleManagerEvents } from '../events';
import type { ComponentStallInfo, ComponentState } from '../types';
import type { ComponentAccessContext } from './component-access-context';
import {
  broadcastMessageInternal,
  getValueInternal,
  sendMessageInternal,
} from './component-messaging';
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
  const context: ComponentAccessContext = {
    get components() {
      return state.components;
    },
    componentStates,
    stalledComponents,
    runningComponents,
    isStarting: false,
    messageTimeoutMS: 0,
    logger: logger.service('access-test'),
    lifecycleEvents: new LifecycleManagerEvents((name) => {
      events.push(name);
    }),
    nameOf: (component) => component.getName(),
    isComponentRunning: (name) => runningComponents.has(name),
    isComponentUp: (name) => componentStates.get(name) === 'running',
    getComponent: (name) =>
      state.components.find((component) => component.getName() === name),
    isRawStartPending: (name) => pendingStarts.has(name),
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

test('broadcast dispatch resolves later recipients through the live registry', async () => {
  const { context, state, add } = fixture();
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
  Object.defineProperty(first, 'onMessage', {
    value: () => {
      state.components = [first, replacement];
      return Promise.resolve('first-result');
    },
  });
  Object.defineProperty(oldSecond, 'onMessage', {
    value: () => {
      throw new Error('The removed recipient must not be called');
    },
  });
  Object.defineProperty(replacement, 'onMessage', {
    value: () => Promise.resolve('replacement-result'),
  });
  const results = await broadcastMessageInternal(liveContext, 'hello', null);
  expect(results.map(({ name, data }) => ({ name, data }))).toEqual([
    { name: 'first', data: 'first-result' },
    { name: 'second', data: 'replacement-result' },
  ]);
});

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
