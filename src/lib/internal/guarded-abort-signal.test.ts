import { afterEach, expect, test } from 'bun:test';
import { breakConsoleError, restoreConsoleError } from './console-test-utils';
import { guardAbortListeners } from './guarded-abort-signal';

// Every report the guard makes goes to the standard `'error'` channel. A listener error
// that escaped instead would be an uncaught exception, which fails the test that is
// running when it happens - so each test here also proves nothing escaped.

const LABEL = 'test abort listener';

let releaseReports: (() => void) | undefined;

afterEach(() => {
  releaseReports?.();
  releaseReports = undefined;
  restoreConsoleError();
});

function claimReports(): Error[] {
  const reports: Error[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error as Error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  releaseReports = () => {
    globalThis.removeEventListener('error', onError);
  };
  return reports;
}

function guarded(): { controller: AbortController; signal: AbortSignal } {
  const controller = new AbortController();
  guardAbortListeners(controller.signal, LABEL);
  return { controller, signal: controller.signal };
}

function causes(reports: Error[]): unknown[] {
  return reports.map((report) => report.cause);
}

test('a throwing function listener is reported, and the listeners after it still run', () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const order: string[] = [];
  const thrown = new Error('listener failed');
  const receivers: unknown[] = [];
  let eventType: string | undefined;

  signal.addEventListener('abort', () => order.push('before'));
  signal.addEventListener('abort', function (this: unknown, event: Event) {
    receivers.push(this);
    eventType = event.type;
    order.push('throws');
    throw thrown;
  });
  signal.addEventListener('abort', () => order.push('after'));

  expect(() => controller.abort('why')).not.toThrow();

  expect(order).toEqual(['before', 'throws', 'after']);
  expect(receivers).toEqual([signal]);
  expect(eventType).toBe('abort');
  expect(reports).toHaveLength(1);
  expect(reports[0].message).toBe(`Error in a callback ${LABEL}`);
  expect(reports[0].cause).toBe(thrown);
});

test('a handleEvent object is called on itself, read at dispatch, and its throw is reported', () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const order: string[] = [];
  const thrown = new Error('handleEvent failed');
  const receivers: unknown[] = [];
  const listener = {
    handleEvent(): void {
      order.push('original');
    },
  };

  signal.addEventListener('abort', listener);
  signal.addEventListener('abort', () => order.push('after'));
  // Read when the event is dispatched, not when the listener was added.
  listener.handleEvent = function (this: unknown): void {
    receivers.push(this);
    order.push('replacement');
    throw thrown;
  };

  controller.abort();

  expect(order).toEqual(['replacement', 'after']);
  expect(receivers).toEqual([listener]);
  expect(causes(reports)).toEqual([thrown]);
});

test('a handleEvent that cannot be read or is not callable is reported', () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const readFailure = new Error('handleEvent getter failed');
  let didRun = false;

  signal.addEventListener('abort', {
    get handleEvent(): () => void {
      throw readFailure;
    },
  });
  signal.addEventListener('abort', {
    handleEvent: 'not callable',
  } as unknown as EventListenerObject);
  signal.addEventListener('abort', () => {
    didRun = true;
  });

  controller.abort();

  expect(didRun).toBe(true);
  expect(reports).toHaveLength(2);
  expect(reports[0].cause).toBe(readFailure);
  expect((reports[1].cause as Error).message).toContain('is not a function');
});

test('a throwing onabort is reported, runs where it was first set, and is called on the signal', () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const order: string[] = [];
  const thrown = new Error('onabort failed');
  const receivers: unknown[] = [];

  signal.addEventListener('abort', () => order.push('a'));
  signal.onabort = () => order.push('first handler');
  signal.addEventListener('abort', () => order.push('b'));
  const handler = function (this: unknown): void {
    receivers.push(this);
    order.push('second handler');
    throw thrown;
  };
  signal.onabort = handler;

  expect(signal.onabort).toBe(handler);
  controller.abort();

  // Replacing the handler keeps its place, as a native event handler attribute does.
  expect(order).toEqual(['a', 'second handler', 'b']);
  expect(receivers).toEqual([signal]);
  expect(causes(reports)).toEqual([thrown]);
});

test('onabort set to null stops it, and set again it runs after the listeners added since', () => {
  claimReports();
  const first = guarded();
  let calls = 0;
  first.signal.onabort = () => {
    calls++;
  };
  first.signal.onabort = null;
  expect(first.signal.onabort).toBeNull();
  first.controller.abort();
  expect(calls).toBe(0);

  const second = guarded();
  const order: string[] = [];
  const handler = (): void => {
    order.push('handler');
  };
  second.signal.onabort = handler;
  second.signal.addEventListener('abort', () => order.push('listener'));
  second.signal.onabort = null;
  second.signal.onabort = handler;
  second.controller.abort();
  expect(order).toEqual(['listener', 'handler']);
});

test('onabort keeps an object, as the native attribute does, and stores other values as null', () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const notCallable = {};

  signal.onabort = notCallable as unknown as () => void;
  expect(signal.onabort as unknown).toBe(notCallable);
  // Invoking a non-callable handler does nothing, and is not an error.
  controller.abort();
  expect(reports).toHaveLength(0);

  for (const value of [5, 'handler', true, undefined]) {
    signal.onabort = value as unknown as () => void;
    expect(signal.onabort).toBeNull();
  }
});

test('an async listener that rejects is reported rather than left unhandled', async () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const thrown = new Error('async listener failed');

  // Async on purpose: the returned promise is what the guard must follow.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  signal.addEventListener('abort', async () => {
    await Promise.resolve();
    throw thrown;
  });
  signal.onabort = () => Promise.reject(thrown);
  controller.abort();

  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(causes(reports)).toEqual([thrown, thrown]);
});

test('removeEventListener removes a guarded listener with the same capture', () => {
  claimReports();
  const { controller, signal } = guarded();
  const order: string[] = [];
  const fn = (): void => {
    order.push('fn');
  };
  const object = {
    handleEvent: (): void => {
      order.push('object');
    },
  };
  const captured = (): void => {
    order.push('captured');
  };

  signal.addEventListener('abort', fn);
  signal.addEventListener('abort', object, { capture: true });
  signal.addEventListener('abort', captured, true);

  signal.removeEventListener('abort', fn);
  signal.removeEventListener('abort', object, true);
  // A different capture flag is a different registration, so this one stays.
  signal.removeEventListener('abort', captured, false);

  controller.abort();
  expect(order).toEqual(['captured']);
});

test('adding the same listener twice is de-duplicated per capture flag', () => {
  claimReports();
  const { controller, signal } = guarded();
  let calls = 0;
  const fn = (): void => {
    calls++;
  };
  const object = { handleEvent: fn };

  signal.addEventListener('abort', fn);
  signal.addEventListener('abort', fn, { once: true });
  signal.addEventListener('abort', object);
  signal.addEventListener('abort', object);
  // A capture listener is a second registration, as natively.
  signal.addEventListener('abort', fn, true);

  controller.abort();
  expect(calls).toBe(3);
});

test('once, signal and passive pass through, and each option is read once', () => {
  claimReports();
  const { signal } = guarded();
  const order: string[] = [];
  const remover = new AbortController();
  const reads: string[] = [];
  const counted = {
    get capture(): boolean {
      reads.push('capture');
      return false;
    },
    get once(): boolean {
      reads.push('once');
      return true;
    },
    get passive(): boolean {
      reads.push('passive');
      return true;
    },
    get signal(): AbortSignal {
      reads.push('signal');
      return remover.signal;
    },
  };

  signal.addEventListener('abort', () => order.push('once'), { once: true });
  signal.addEventListener('abort', () => order.push('removed by signal'), {
    signal: remover.signal,
  });
  signal.addEventListener(
    'abort',
    (event) => {
      order.push('passive');
      event.preventDefault();
    },
    { passive: true },
  );
  signal.addEventListener('abort', () => order.push('counted'), counted);
  expect(reads).toEqual(['capture', 'once', 'passive', 'signal']);

  const first = new Event('abort', { cancelable: true });
  // A passive listener cannot cancel the event.
  expect(signal.dispatchEvent(first)).toBe(true);
  expect(first.defaultPrevented).toBe(false);
  remover.abort();
  signal.dispatchEvent(new Event('abort'));

  expect(order).toEqual([
    'once',
    'removed by signal',
    'passive',
    'counted',
    'passive',
  ]);
});

test('null and undefined listeners are no-ops, and invalid calls fail as natively', () => {
  const { controller, signal } = guarded();
  const native = new AbortController().signal;

  // Returns without registering anything - and without the runtime warning Bun and Node
  // print for one, which the DOM's own no-op does not have.
  expect(() => {
    for (const type of ['abort', 'other']) {
      for (const listener of [null, undefined]) {
        signal.addEventListener(
          type,
          listener as unknown as EventListenerOrEventListenerObject,
        );
      }
    }
    signal.removeEventListener(
      'abort',
      null as unknown as EventListenerOrEventListenerObject,
    );
  }).not.toThrow();

  const nativeOutcome = (call: () => void): string => {
    try {
      call();
      return 'returned';
    } catch (error) {
      return (error as Error).name;
    }
  };
  const invalid: [string, (target: AbortSignal) => void][] = [
    ['no arguments', (target) => (target.addEventListener as () => void)()],
    [
      'primitive listener',
      (target) =>
        target.addEventListener(
          'abort',
          5 as unknown as EventListenerOrEventListenerObject,
        ),
    ],
    [
      'symbol type',
      (target) =>
        target.addEventListener(
          Symbol('type') as unknown as string,
          () => undefined,
        ),
    ],
  ];
  for (const [, call] of invalid) {
    expect(nativeOutcome(() => call(signal))).toBe(
      nativeOutcome(() => call(native)),
    );
  }

  controller.abort();
});

test('listeners for other event types pass through unwrapped', () => {
  const { signal } = guarded();
  let calls = 0;
  const receivers: unknown[] = [];
  const listener = function (this: unknown): void {
    calls++;
    receivers.push(this);
  };

  signal.addEventListener('other', listener);
  signal.dispatchEvent(new Event('other'));
  expect(calls).toBe(1);
  expect(receivers).toEqual([signal]);

  // Registered as itself, so the prototype's removal finds it.
  EventTarget.prototype.removeEventListener.call(signal, 'other', listener);
  signal.dispatchEvent(new Event('other'));
  expect(calls).toBe(1);
});

test('replacing the EventTarget methods after load does not bypass the guard', () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const thrown = new Error('listener failed');
  const order: string[] = [];
  const prototype = EventTarget.prototype;
  const add = Object.getOwnPropertyDescriptor(prototype, 'addEventListener');
  const remove = Object.getOwnPropertyDescriptor(
    prototype,
    'removeEventListener',
  );
  if (add === undefined || remove === undefined) {
    throw new Error('EventTarget methods are missing');
  }

  Object.defineProperty(prototype, 'addEventListener', {
    ...add,
    value: () => {
      throw new Error('replaced addEventListener');
    },
  });
  Object.defineProperty(prototype, 'removeEventListener', {
    ...remove,
    value: () => {
      throw new Error('replaced removeEventListener');
    },
  });
  try {
    signal.addEventListener('abort', () => {
      order.push('throws');
      throw thrown;
    });
    const removed = (): void => {
      order.push('removed');
    };
    signal.addEventListener('abort', removed);
    signal.removeEventListener('abort', removed);
    signal.onabort = () => order.push('handler');
  } finally {
    Object.defineProperty(prototype, 'addEventListener', add);
    Object.defineProperty(prototype, 'removeEventListener', remove);
  }

  controller.abort();
  expect(order).toEqual(['throws', 'handler']);
  expect(causes(reports)).toEqual([thrown]);
});

test('replacing the array iterator does not change which listener is added or removed', () => {
  const reports = claimReports();
  const { controller, signal } = guarded();
  const thrown = new Error('listener failed');
  const order: string[] = [];
  const iterator = Object.getOwnPropertyDescriptor(
    Array.prototype,
    Symbol.iterator,
  );
  if (iterator === undefined) {
    throw new Error('Array iterator is missing');
  }

  const kept = (): void => {
    order.push('kept');
    throw thrown;
  };
  const removed = (): void => {
    order.push('removed');
  };
  // Destructuring the arguments went through this, so `add`/`remove` threw - or, with
  // an iterator yielding other values, registered a listener the caller never passed.
  Object.defineProperty(Array.prototype, Symbol.iterator, {
    ...iterator,
    value: function* () {
      yield 'abort';
      yield removed;
    },
  });
  try {
    signal.addEventListener('abort', kept);
    signal.addEventListener('abort', removed);
    signal.removeEventListener('abort', removed);
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, iterator);
  }

  controller.abort();
  expect(order).toEqual(['kept']);
  expect(causes(reports)).toEqual([thrown]);
});

test('the guard is own, non-writable and non-configurable', () => {
  const { signal } = guarded();

  for (const key of ['addEventListener', 'removeEventListener']) {
    const descriptor = Object.getOwnPropertyDescriptor(signal, key);
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(() => {
      (signal as unknown as Record<string, unknown>)[key] = () => undefined;
    }).toThrow(TypeError);
  }
  const onabort = Object.getOwnPropertyDescriptor(signal, 'onabort');
  expect(typeof onabort?.get).toBe('function');
  expect(typeof onabort?.set).toBe('function');
  expect(onabort?.configurable).toBe(false);
  expect(Object.keys(signal)).toEqual([]);
});

test('reporting a listener error never throws, even when its console fallback does', () => {
  breakConsoleError();
  const { controller, signal } = guarded();
  let didRunAfter = false;
  // Observes without claiming, so the unclaimed report still falls through to the
  // broken console - unless a listener another suite left behind claims it first.
  let dispatched = 0;
  const observe = (): void => {
    dispatched++;
  };
  globalThis.addEventListener('error', observe);
  releaseReports = () => {
    globalThis.removeEventListener('error', observe);
  };

  signal.addEventListener('abort', () => {
    throw new Error('listener failed');
  });
  signal.addEventListener('abort', () => {
    didRunAfter = true;
  });

  expect(() => controller.abort()).not.toThrow();
  expect(didRunAfter).toBe(true);
  expect(dispatched).toBe(1);
});

test('native consumers of the signal still follow it', () => {
  const { controller, signal } = guarded();
  const derived = AbortSignal.any([signal]);
  const reason = new Error('stopped');

  controller.abort(reason);

  expect(derived.aborted).toBe(true);
  expect(derived.reason).toBe(reason);
  expect(signal.reason).toBe(reason);
});
