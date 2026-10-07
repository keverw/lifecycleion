import { reportCallbackError } from './safe-handle-callback';
import {
  SingleEventObserver,
  SingleEventObserverProtected,
} from './single-event-observer';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from './internal/console-test-utils';
import { sleep } from './sleep';

// These suites deliberately drive the paths that fall through to `console.error` when
// nothing claims the report. Captured rather than printed so a real failure in the run
// output still stands out; flip `DEBUG` in the helper to see them.
beforeEach(() => {
  muteConsoleError();
});

afterEach(() => {
  restoreConsoleError();
});

describe('SingleEventObserver', () => {
  let observer: SingleEventObserver<string>;

  beforeEach(() => {
    observer = new SingleEventObserver<string>();
  });

  test('subscribing adds function to subscribers', () => {
    const callback = mock();

    observer.subscribe(callback);

    expect(observer.hasSubscriber(callback)).toBe(true);
  });

  test('unsubscribing removes function from subscribers', () => {
    const callback = mock();

    observer.subscribe(callback);
    observer.unsubscribe(callback);

    expect(observer.hasSubscriber(callback)).toBe(false);
  });

  test('notifying calls all functions in subscribers with data', async () => {
    const callback1 = mock();
    const callback2 = mock();

    observer.subscribe(callback1);
    observer.subscribe(callback2);

    const data = 'Hello';

    observer.notify(data);

    // Wait for async callbacks to complete
    await sleep(10);

    expect(callback1).toHaveBeenCalledWith(data);
    expect(callback2).toHaveBeenCalledWith(data);
  });

  test('notifying handles async callbacks', async () => {
    let result = '';
    const asyncCallback = mock(async (data: string): Promise<void> => {
      await sleep(5);
      result = data.toUpperCase();
    });

    observer.subscribe(asyncCallback);

    const data = 'Hello';
    observer.notify(data);

    // Wait for async callback to complete
    await sleep(10);

    expect(asyncCallback).toHaveBeenCalledWith(data);
    expect(result).toBe('HELLO');
  });

  test('notifying handles errors in callbacks', async () => {
    const errorCallback = mock(() => {
      throw new Error('Test error');
    });

    const errorHandler = mock((event: Event) => event.preventDefault());
    globalThis.addEventListener('error', errorHandler);

    observer.subscribe(errorCallback);

    const data = 'Hello';
    observer.notify(data);

    // Wait for error handling to complete
    await sleep(10);

    expect(errorCallback).toHaveBeenCalledWith(data);
    expect(errorHandler).toHaveBeenCalled();

    globalThis.removeEventListener('error', errorHandler);
  });
});

describe('SingleEventObserverProtected', () => {
  // The protected base is the half a consumer subclasses when only the owner should be
  // able to notify. Its `notify` is a different method from the public subclass's, so
  // exercising `SingleEventObserver` alone leaves it unrun.
  class Counter extends SingleEventObserverProtected<number> {
    public emit(value: number): void {
      this.notify(value);
    }
  }

  test('notifies subscribers from a derived class', () => {
    const counter = new Counter();
    const seen: number[] = [];

    counter.subscribe((value) => {
      seen.push(value);
    });
    counter.emit(1);
    counter.emit(2);

    expect(seen).toEqual([1, 2]);
  });

  test('unsubscribe and hasSubscriber work on the protected base', () => {
    const counter = new Counter();
    const seen: number[] = [];
    const listener = (value: number): void => {
      seen.push(value);
    };

    counter.subscribe(listener);
    expect(counter.hasSubscriber(listener)).toBe(true);

    counter.unsubscribe(listener);
    expect(counter.hasSubscriber(listener)).toBe(false);

    counter.emit(1);
    expect(seen).toEqual([]);
  });

  test('a subscriber that throws does not stop the others', () => {
    // Each subscriber goes through `safeHandleCallback`, so one failing is reported
    // rather than ending the loop.
    const counter = new Counter();
    const seen: number[] = [];

    counter.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    counter.subscribe((value) => {
      seen.push(value);
    });

    expect(() => counter.emit(7)).not.toThrow();
    expect(seen).toEqual([7]);
  });

  test('an anonymous subscriber is still named in the report', () => {
    // The callback name falls back to 'anonymous' when the function has no name.
    const counter = new Counter();
    const anonymous = (): void => {
      throw new Error('anon boom');
    };

    Object.defineProperty(anonymous, 'name', { value: '' });

    counter.subscribe(anonymous);

    expect(() => counter.emit(1)).not.toThrow();
  });
});

describe('subscriber changes during a notification', () => {
  test('a subscriber added during notify runs from the next notification', () => {
    const observer = new SingleEventObserver<number>();
    const seen: string[] = [];
    const late = (value: number): void => {
      seen.push(`late ${value}`);
    };

    observer.subscribe((value) => {
      seen.push(`first ${value}`);
      observer.subscribe(late);
    });

    observer.notify(1);
    expect(seen).toEqual(['first 1']);

    observer.notify(2);
    expect(seen).toEqual(['first 1', 'first 2', 'late 2']);
  });

  test('a subscriber that re-subscribes itself runs once per notification', () => {
    // Re-adding moves it to the end of the live set, so iterating that set reached it
    // again on every pass and never finished.
    const observer = new SingleEventObserver<number>();
    let calls = 0;
    const resubscriber = (): void => {
      calls++;
      if (calls > 10) {
        throw new Error('looped');
      }
      observer.unsubscribe(resubscriber);
      observer.subscribe(resubscriber);
    };

    observer.subscribe(resubscriber);
    observer.notify(1);
    expect(calls).toBe(1);

    observer.notify(2);
    expect(calls).toBe(2);
    expect(observer.hasSubscriber(resubscriber)).toBe(true);
  });

  test('a subscriber removed during notify still runs in that notification', () => {
    const observer = new SingleEventObserver<number>();
    const seen: string[] = [];
    const second = (value: number): void => {
      seen.push(`second ${value}`);
    };

    observer.subscribe((value) => {
      seen.push(`first ${value}`);
      observer.unsubscribe(second);
    });
    observer.subscribe(second);

    observer.notify(1);
    observer.notify(2);
    expect(seen).toEqual(['first 1', 'second 1', 'first 2']);
  });
});

describe('subscriber names and values', () => {
  let reports: Error[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error as Error);
    event.preventDefault();
  };

  beforeEach(() => {
    reports = [];
    globalThis.addEventListener('error', onError);
  });

  afterEach(() => {
    globalThis.removeEventListener('error', onError);
  });

  // The report's callback name is read from the subscriber's `name`, which is an
  // ordinary property: a getter can throw, and a value can be a symbol. Either threw out
  // of `notify` and skipped every subscriber after it.
  const NAMES: [string, PropertyDescriptor, string][] = [
    [
      'a name getter that throws',
      {
        get: () => {
          throw new Error('name getter failed');
        },
      },
      'SingleEventObserver_anonymous',
    ],
    [
      'a symbol name',
      { value: Symbol('named') },
      'SingleEventObserver_anonymous',
    ],
    ['an ordinary name', { value: 'named' }, 'SingleEventObserver_named'],
  ];

  for (const [kind, descriptor, callbackName] of NAMES) {
    test(`a subscriber with ${kind} is notified, and so are the rest`, () => {
      const observer = new SingleEventObserver<number>();
      const seen: string[] = [];
      const thrown = new Error('subscriber failed');
      const odd = (value: number): void => {
        seen.push(`odd ${value}`);
        throw thrown;
      };
      Object.defineProperty(odd, 'name', {
        configurable: true,
        ...descriptor,
      });

      observer.subscribe(odd);
      observer.subscribe((value) => {
        seen.push(`next ${value}`);
      });

      expect(() => observer.notify(1)).not.toThrow();
      expect(seen).toEqual(['odd 1', 'next 1']);
      expect(reports.map((report) => report.message)).toEqual([
        `Error in a callback ${callbackName}`,
      ]);
      expect(reports[0].cause).toBe(thrown);
    });
  }

  test("a subscriber's name is read only when it fails", () => {
    const observer = new SingleEventObserver<number>();
    let nameReads = 0;
    const subscriber = (): void => {};
    Object.defineProperty(subscriber, 'name', {
      configurable: true,
      get: () => {
        nameReads++;
        return 'counted';
      },
    });

    observer.subscribe(subscriber);
    observer.notify(1);
    observer.notify(2);
    expect(nameReads).toBe(0);
    expect(reports).toEqual([]);
  });

  test('a function proxy whose name read throws is still notified', () => {
    const observer = new SingleEventObserver<number>();
    const seen: number[] = [];
    const subscriber = new Proxy(
      (value: number): void => {
        seen.push(value);
      },
      {
        get: () => {
          throw new Error('proxy get failed');
        },
      },
    );

    observer.subscribe(subscriber);
    observer.subscribe((value) => {
      seen.push(value * 10);
    });

    expect(() => observer.notify(2)).not.toThrow();
    expect(seen).toEqual([2, 20]);
    expect(reports).toEqual([]);
  });

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'subscriber'],
    ['an object', { handleEvent: () => {} }],
  ])('subscribing %s is a TypeError', (_kind, value) => {
    const observer = new SingleEventObserver<number>();
    expect(() =>
      observer.subscribe(value as unknown as (data: number) => void),
    ).toThrow(TypeError);
    expect(
      observer.hasSubscriber(value as unknown as (data: number) => void),
    ).toBe(false);
  });
});

test('notification snapshots subscribers without the live Set iterator', () => {
  const observer = new SingleEventObserver<number>();
  let called = 0;
  observer.subscribe(() => {
    called++;
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    Set.prototype,
    Symbol.iterator,
  );
  if (descriptor === undefined) {
    throw new Error('Set iterator descriptor is missing');
  }
  Object.defineProperty(Set.prototype, Symbol.iterator, {
    configurable: true,
    value: () => {
      throw new Error('iterator replaced');
    },
  });
  try {
    observer.notify(1);
  } finally {
    Object.defineProperty(Set.prototype, Symbol.iterator, descriptor);
  }
  expect(called).toBe(1);
});

test('async subscribers entered by console forwarding do not restart diagnostics', async () => {
  const observer = new SingleEventObserver<string>();
  let calls = 0;
  let consoleCalls = 0;
  observer.subscribe(async () => {
    calls++;
    await Promise.resolve();
    throw new Error('observer forwarding failed');
  });
  const originalConsole = console.error;
  console.error = (): void => {
    if (++consoleCalls <= 10) {
      observer.notify('forward');
    }
  };
  try {
    reportCallbackError('original failure', new Error('initial'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(consoleCalls).toBe(1);
    expect(calls).toBe(1);
    console.error = (): void => {
      consoleCalls++;
    };
    observer.notify('independent failure');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(consoleCalls).toBe(2);
    expect(calls).toBe(2);
  } finally {
    console.error = originalConsole;
  }
});
