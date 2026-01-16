import { describe, expect, it } from 'bun:test';
import {
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from './safe-handle-callback';
import { sleep } from './sleep';

describe('safeHandleCallback', () => {
  it('should call a synchronous callback successfully', () => {
    let resultSaved = 0;

    const callbackName = 'syncCallback';

    const callback = (value: number): void => {
      resultSaved = value;
    };

    safeHandleCallback(callbackName, callback, 5);

    expect(resultSaved).toBe(5);
  });

  it('should call an asynchronous callback successfully', async () => {
    let resultSaved = 0;

    const callbackName = 'asyncCallback';

    const callback = async (A: number, B: number): Promise<void> => {
      await sleep(1);
      resultSaved = A + B;
    };

    safeHandleCallback(callbackName, callback, 5, 10);

    while (resultSaved === 0) {
      // Wait for the callback to be executed
      await sleep(1);
    }

    expect(resultSaved).toBe(15);
  });

  it('should handle errors in a synchronous callback', (done) => {
    const callbackName = 'syncCallbackWithError';

    const callback = (): void => {
      throw new Error('Sync error');
    };

    const errorHandler = (event: Event): void => {
      expect((event['error'] as Error).message).toContain(
        'Error in a callback syncCallbackWithError',
      );

      expect((event['error'] as Error).message).toContain('Sync error');

      done();
    };

    globalThis.addEventListener('reportError', errorHandler);

    safeHandleCallback(callbackName, callback);

    globalThis.removeEventListener('reportError', errorHandler);
  });

  it('should handle errors in an asynchronous callback', (done) => {
    const callbackName = 'asyncCallbackWithError';

    // eslint-disable-next-line @typescript-eslint/require-await
    const callback = async (): Promise<void> => {
      throw new Error('Async error');
    };

    const errorHandler = (event: Event): void => {
      // Change the type of the event parameter to Event
      expect((event['error'] as Error).message).toContain(
        'Error in a callback asyncCallbackWithError',
      );

      expect((event['error'] as Error).message).toContain('Async error');

      globalThis.removeEventListener('reportError', errorHandler);
      done();
    };

    globalThis.addEventListener('reportError', errorHandler);
    safeHandleCallback(callbackName, callback);
  });

  it('should handle a non-function callback', (done) => {
    const callbackName = 'nonFunctionCallback';
    const callback = 123;

    const errorHandler = (event: Event): void => {
      // Change the type of the event parameter to Event
      expect((event['error'] as Error).message).toContain(
        'Error in a callback nonFunctionCallback',
      );

      expect((event['error'] as Error).message).toContain(
        'Callback provided for nonFunctionCallback is not a function',
      );

      done();
    };

    globalThis.addEventListener('reportError', errorHandler);

    safeHandleCallback(callbackName, callback);

    globalThis.removeEventListener('reportError', errorHandler);
  });
});

describe('safeHandleCallbackAndWait', () => {
  it('should call a synchronous callback successfully', async () => {
    const callbackName = 'syncCallback';

    const callback = (value: number): number => {
      return value * 2;
    };

    const result = await safeHandleCallbackAndWait(callbackName, callback, 5);

    expect(result.success).toBe(true);
    expect(result.value).toBe(10);
  });

  it('should call an asynchronous callback successfully', async () => {
    const callbackName = 'asyncCallback';

    const callback = async (A: number, B: number): Promise<number> => {
      await sleep(1);

      return A + B;
    };

    const result = await safeHandleCallbackAndWait(
      callbackName,
      callback,
      5,
      10,
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe(15);
  });

  it('should handle errors in a synchronous callback', async () => {
    const callbackName = 'syncCallbackWithError';

    const callback = (): void => {
      throw new Error('Sync error');
    };

    const errorHandler = (event: Event): void => {
      expect((event['error'] as Error).message).toContain(
        'Error in a callback syncCallbackWithError',
      );
      expect((event['error'] as Error).message).toContain('Sync error');
    };

    globalThis.addEventListener('reportError', errorHandler);

    const result = await safeHandleCallbackAndWait(callbackName, callback);

    globalThis.removeEventListener('reportError', errorHandler);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Sync error');
  });

  it('should handle errors in an asynchronous callback', async () => {
    const callbackName = 'asyncCallbackWithError';

    const callback = async (): Promise<void> => {
      await sleep(1);
      throw new Error('Async error');
    };

    const errorHandler = (event: Event): void => {
      expect((event['error'] as Error).message).toContain(
        'Error in a callback asyncCallbackWithError',
      );

      expect((event['error'] as Error).message).toContain('Async error');
    };

    globalThis.addEventListener('reportError', errorHandler);

    const result = await safeHandleCallbackAndWait(callbackName, callback);

    globalThis.removeEventListener('reportError', errorHandler);

    expect(result.success).toBe(false);
    expect(result.error?.message).toBe('Async error');
  });

  it('should handle a non-function callback', async () => {
    const callbackName = 'nonFunctionCallback';
    const callback = 123;

    const result = await safeHandleCallbackAndWait(callbackName, callback);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toBe(
      'Callback provided for nonFunctionCallback is not a function',
    );

    // Check if the error is reported using the reportError event
    const errorHandler = (event: Event): void => {
      const errorMessage = (event['error'] as Error).message;
      expect(errorMessage).toContain(
        'Callback provided for nonFunctionCallback is not a function',
      );
    };

    globalThis.addEventListener('reportError', errorHandler);

    // Trigger the reportError event
    globalThis.dispatchEvent(
      new ErrorEvent('reportError', { error: result.error }),
    );

    globalThis.removeEventListener('reportError', errorHandler);
  });
});
