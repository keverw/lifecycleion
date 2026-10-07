import { expect, test } from 'bun:test';
import { EventEmitter } from '../event-emitter';
import { SingleEventObserver } from '../single-event-observer';

for (const mutation of ['iterator', 'index'] as const) {
  test(`listener snapshots survive a replaced Array prototype ${mutation}`, () => {
    const emitter = new EventEmitter();
    const observer = new SingleEventObserver<number>();
    let emitted = 0;
    let notified = 0;
    emitter.on('sample', () => {
      emitted++;
    });
    emitter.on('sample', () => {
      emitted++;
    });
    observer.subscribe(() => {
      notified++;
    });
    observer.subscribe(() => {
      notified++;
    });
    const key = mutation === 'iterator' ? Symbol.iterator : '0';
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, key);
    try {
      Object.defineProperty(
        Array.prototype,
        key,
        mutation === 'iterator'
          ? {
              configurable: true,
              value() {
                return {
                  next() {
                    return { done: true, value: undefined };
                  },
                };
              },
            }
          : {
              configurable: true,
              set() {
                throw new Error('inherited array index setter');
              },
            },
      );
      emitter.emit('sample', 1);
      observer.notify(1);
    } finally {
      if (descriptor) {
        Object.defineProperty(Array.prototype, key, descriptor);
      } else {
        Reflect.deleteProperty(Array.prototype, key);
      }
    }
    expect(emitted).toBe(2);
    expect(notified).toBe(2);
  });
}
