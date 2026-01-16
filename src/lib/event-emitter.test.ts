import { describe, test, expect, mock } from 'bun:test';
import { EventEmitter, EventEmitterProtected } from './event-emitter';

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
    const errorHandler = mock(() => {});

    globalThis.addEventListener('reportError', errorHandler);

    emitter.on('test', () => {
      throw new Error('Test error');
    });

    emitter.emit('test');

    expect(errorHandler).toHaveBeenCalled();
    const errorEvent = errorHandler.mock.calls[0][0] as ErrorEvent;
    expect(errorEvent.error.message).toContain('event handler for test');
    expect(errorEvent.error.message).toContain('Test error');

    globalThis.removeEventListener('reportError', errorHandler);
  });

  test('error handling in async event handlers', async () => {
    const emitter = new EventEmitter();
    const errorHandler = mock(() => {});

    globalThis.addEventListener('reportError', errorHandler);

    emitter.on('test', () => {
      return Promise.reject(new Error('Test error'));
    });

    emitter.emit('test');

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(errorHandler).toHaveBeenCalled();
    const errorEvent = errorHandler.mock.calls[0][0] as ErrorEvent;
    expect(errorEvent.error.message).toContain('event handler for test');
    expect(errorEvent.error.message).toContain('Test error');

    globalThis.removeEventListener('reportError', errorHandler);
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
    const errorHandler = mock(() => {});

    globalThis.addEventListener('reportError', errorHandler);

    emitter.on('test', () => {
      throw new Error('Protected error');
    });

    emitter.triggerEvent();

    expect(errorHandler).toHaveBeenCalled();
    const errorEvent = errorHandler.mock.calls[0][0] as ErrorEvent;
    expect(errorEvent.error.message).toContain('event handler for test');
    expect(errorEvent.error.message).toContain('Protected error');

    globalThis.removeEventListener('reportError', errorHandler);
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
