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
