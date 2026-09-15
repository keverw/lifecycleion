import { describe, test, expect, mock } from 'bun:test';
import { EventEmitter, EventEmitterProtected } from './event-emitter';

function getFirstReportedError(
  errorHandler: ReturnType<typeof mock>,
): ErrorEvent {
  const [errorEvent] = errorHandler.mock.calls.at(0) ?? [];
  expect(errorEvent).toBeDefined();
  return errorEvent as ErrorEvent;
}

describe('EventEmitter', () => {
  test('basic event subscription and emission', () => {
    const emitter = new EventEmitter();
    const callback = mock(() => {});

    emitter.on('test', callback);
    emitter.emit('test', 'hello');

    expect(callback).toHaveBeenCalledWith('hello');
  });

  test('unsubscribe from event', () => {
    const emitter = new EventEmitter();
    const callback = mock(() => {});

    const unsubscribe = emitter.on('test', callback);
    unsubscribe();
    emitter.emit('test', 'hello');

    expect(callback).not.toHaveBeenCalled();
  });

  test('once subscription', () => {
    const emitter = new EventEmitter();
    const callback = mock(() => {});

    emitter.once('test', callback);
    emitter.emit('test', 'first');
    emitter.emit('test', 'second');

    expect(callback.mock.calls.length).toBe(1);
    expect(callback).toHaveBeenCalledWith('first');
  });

  test('multiple subscribers', () => {
    const emitter = new EventEmitter();
    const callback1 = mock(() => {});
    const callback2 = mock(() => {});

    emitter.on('test', callback1);
    emitter.on('test', callback2);
    emitter.emit('test', 'hello');

    expect(callback1).toHaveBeenCalledWith('hello');
    expect(callback2).toHaveBeenCalledWith('hello');
  });

  test('unsubscribing a sibling does not skip it during the current emission', () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];
    let unsubscribeSecond = (): void => {};

    emitter.on('test', () => {
      calls.push('first');
      unsubscribeSecond();
    });
    unsubscribeSecond = emitter.on('test', () => {
      calls.push('second');
    });

    emitter.emit('test');
    emitter.emit('test');

    expect(calls).toEqual(['first', 'second', 'first']);
  });

  test('clearing listeners does not stop the current emission', () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];

    emitter.on('test', () => {
      calls.push('first');
      emitter.clear('test');
    });
    emitter.on('test', () => {
      calls.push('second');
    });

    emitter.emit('test');
    emitter.emit('test');

    expect(calls).toEqual(['first', 'second']);
  });

  test('a nested emission snapshots the listeners present when it starts', () => {
    const emitter = new EventEmitter();
    const calls: string[] = [];

    emitter.on<string>('test', (value) => {
      calls.push(`first:${value}`);

      if (value === 'outer') {
        emitter.on<string>('test', (nestedValue) => {
          calls.push(`added:${nestedValue}`);
        });
        emitter.emit('test', 'inner');
      }
    });
    emitter.on<string>('test', (value) => {
      calls.push(`second:${value}`);
    });

    emitter.emit('test', 'outer');

    expect(calls).toEqual([
      'first:outer',
      'first:inner',
      'second:inner',
      'added:inner',
      'second:outer',
    ]);
  });

  test('hasListeners and listenerCount', () => {
    const emitter = new EventEmitter();
    const callback = mock(() => {});

    expect(emitter.hasListeners('test')).toBe(false);
    expect(emitter.listenerCount('test')).toBe(0);

    emitter.on('test', callback);

    expect(emitter.hasListeners('test')).toBe(true);
    expect(emitter.listenerCount('test')).toBe(1);
  });

  test('clear all listeners', () => {
    const emitter = new EventEmitter();
    const callback1 = mock(() => {});
    const callback2 = mock(() => {});

    emitter.on('test1', callback1);
    emitter.on('test2', callback2);
    emitter.clear();

    emitter.emit('test1', 'hello');
    emitter.emit('test2', 'hello');

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).not.toHaveBeenCalled();
  });

  test('clear specific event listeners', () => {
    const emitter = new EventEmitter();
    const callback1 = mock(() => {});
    const callback2 = mock(() => {});

    emitter.on('test1', callback1);
    emitter.on('test2', callback2);
    emitter.clear('test1');

    emitter.emit('test1', 'hello');
    emitter.emit('test2', 'hello');

    expect(callback1).not.toHaveBeenCalled();
    expect(callback2).toHaveBeenCalledWith('hello');
  });

  test('async event handlers', async () => {
    const emitter = new EventEmitter();
    const result: string[] = [];

    emitter.on('test', async (data: string) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result.push(data);
    });

    emitter.emit('test', 'hello');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result).toEqual(['hello']);
  });

  test('error handling in event handlers', () => {
    const emitter = new EventEmitter();
    const errorHandler = mock((event: Event) => event.preventDefault());

    globalThis.addEventListener('error', errorHandler);

    emitter.on('test', () => {
      throw new Error('Test error');
    });

    emitter.emit('test');

    expect(errorHandler).toHaveBeenCalled();
    const errorEvent = getFirstReportedError(errorHandler);
    expect(errorEvent.error.message).toContain('event handler for test');
    expect((errorEvent.error.cause as Error).message).toBe('Test error');

    globalThis.removeEventListener('error', errorHandler);
  });

  test('error handling in async event handlers', async () => {
    const emitter = new EventEmitter();
    const errorHandler = mock((event: Event) => event.preventDefault());

    globalThis.addEventListener('error', errorHandler);

    emitter.on('test', () => {
      return Promise.reject(new Error('Test error'));
    });

    emitter.emit('test');

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errorHandler).toHaveBeenCalled();
    const errorEvent = getFirstReportedError(errorHandler);
    expect(errorEvent.error.message).toContain('event handler for test');
    expect((errorEvent.error.cause as Error).message).toBe('Test error');

    globalThis.removeEventListener('error', errorHandler);
  });

  test('hasListener with regular subscription', () => {
    const emitter = new EventEmitter();
    const callback = () => {};

    expect(emitter.hasListener('test', callback)).toBe(false);
    emitter.on('test', callback);
    expect(emitter.hasListener('test', callback)).toBe(true);
  });

  test('hasListener with once subscription', () => {
    const emitter = new EventEmitter();
    const callback = () => {};

    emitter.once('test', callback);
    // The original callback won't be found because once() wraps it
    expect(emitter.hasListener('test', callback)).toBe(false);
  });

  test('hasListener after unsubscribe', () => {
    const emitter = new EventEmitter();
    const callback = () => {};

    const unsubscribe = emitter.on('test', callback);
    expect(emitter.hasListener('test', callback)).toBe(true);

    unsubscribe();
    expect(emitter.hasListener('test', callback)).toBe(false);
  });
});

describe('EventEmitterProtected', () => {
  test('protected emit can be called from derived class', () => {
    class MyEmitter extends EventEmitterProtected {
      public triggerEvent(data: string): void {
        this.emit('test', data);
      }
    }

    const emitter = new MyEmitter();
    const callback = mock(() => {});

    emitter.on('test', callback);
    emitter.triggerEvent('hello');

    expect(callback).toHaveBeenCalledWith('hello');
  });

  test('protected emit handles errors correctly', () => {
    class MyEmitter extends EventEmitterProtected {
      public triggerEvent(): void {
        this.emit('test');
      }
    }

    const emitter = new MyEmitter();
    const errorHandler = mock((event: Event) => event.preventDefault());

    globalThis.addEventListener('error', errorHandler);

    emitter.on('test', () => {
      throw new Error('Protected error');
    });

    emitter.triggerEvent();

    expect(errorHandler).toHaveBeenCalled();
    const errorEvent = getFirstReportedError(errorHandler);
    expect(errorEvent.error.message).toContain('event handler for test');
    expect((errorEvent.error.cause as Error).message).toBe('Protected error');

    globalThis.removeEventListener('error', errorHandler);
  });

  test('handleEventHandlerFailure override keeps failures off the global channel and siblings running', async () => {
    // The hook exists so an emitter whose own events are logged can keep its handler
    // failures out of the global `'error'` channel. An override must see every failure -
    // a sync throw and a rejection alike - the handlers after a failing one must still
    // run, and nothing may reach the global listener.
    const seen: Array<{ event: string; error: unknown; data: unknown }> = [];

    class QuietEmitter extends EventEmitterProtected {
      public triggerEvent(): void {
        this.emit('test', 'payload');
      }

      protected override handleEventHandlerFailure(
        event: string,
        error: unknown,
        data?: unknown,
      ): void {
        seen.push({ event, error, data });
      }
    }

    const emitter = new QuietEmitter();
    const globalHandler = mock((event: Event) => event.preventDefault());
    const sibling = mock(() => {});
    const syncFailure = new Error('sync');
    const asyncFailure = new Error('async');

    globalThis.addEventListener('error', globalHandler);

    try {
      emitter.on('test', () => {
        throw syncFailure;
      });
      emitter.on('test', sibling);
      emitter.on('test', () => Promise.reject(asyncFailure));
      emitter.on('test', 'not a function' as unknown as () => void);

      emitter.triggerEvent();

      // The rejection lands on a later tick.
      await new Promise((resolve) => setTimeout(resolve, 1));

      expect(sibling).toHaveBeenCalledWith('payload');
      expect(globalHandler).not.toHaveBeenCalled();
      expect(seen.map((entry) => entry.event)).toEqual([
        'test',
        'test',
        'test',
      ]);
      expect(seen.map((entry) => entry.data)).toEqual([
        'payload',
        'payload',
        'payload',
      ]);
      expect(seen[0]?.error).toBe(syncFailure);
      expect((seen[1]?.error as Error).message).toContain('is not a function');
      expect(seen[2]?.error).toBe(asyncFailure);
    } finally {
      globalThis.removeEventListener('error', globalHandler);
    }
  });

  test('all subscription methods work with protected emitter', () => {
    class MyEmitter extends EventEmitterProtected {
      public triggerEvent(data: string): void {
        this.emit('test', data);
      }
    }

    const emitter = new MyEmitter();
    const callback1 = mock(() => {});
    const callback2 = mock(() => {});

    emitter.on('test', callback1);
    emitter.once('test', callback2);

    expect(emitter.hasListeners('test')).toBe(true);
    expect(emitter.listenerCount('test')).toBe(2);

    emitter.triggerEvent('hello');
    emitter.triggerEvent('world');

    expect(callback1.mock.calls.length).toBe(2);
    expect(callback2.mock.calls.length).toBe(1);
  });
});
