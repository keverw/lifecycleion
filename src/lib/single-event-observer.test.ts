import { SingleEventObserver } from './single-event-observer';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { sleep } from './sleep';

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

    const errorHandler = mock();
    globalThis.addEventListener('reportError', errorHandler);

    observer.subscribe(errorCallback);

    const data = 'Hello';
    observer.notify(data);

    // Wait for error handling to complete
    await sleep(10);

    expect(errorCallback).toHaveBeenCalledWith(data);
    expect(errorHandler).toHaveBeenCalled();

    globalThis.removeEventListener('reportError', errorHandler);
  });
});
