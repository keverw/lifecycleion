import { describe, expect, test } from 'bun:test';
import { adoptPromise } from './adopt-promise';

// The rejection's message, or `'resolved'`.
async function settle(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as Error).message;
  }
}

describe('adoptPromise', () => {
  test('settles as a plain value or native promise does', async () => {
    expect(await adoptPromise(1)).toBe(1);
    expect(await adoptPromise(Promise.resolve(2))).toBe(2);
    expect(await settle(adoptPromise(Promise.reject(new Error('no'))))).toBe(
      'no',
    );
  });

  test("ignores a native promise's own no-op then", async () => {
    const promise: object = Promise.reject(new Error('real rejection'));
    Object.defineProperty(promise, 'then', { value: () => undefined });

    expect(await settle(adoptPromise(promise))).toBe('real rejection');
  });

  // Pins the documented limit: nothing can attach a reaction to such a promise, so the
  // result rejects with the getter's error. Resolved here, since a rejected one would be
  // left unhandled - which is the limit.
  test('rejects rather than throws for a throwing constructor getter', async () => {
    const promise: object = Promise.resolve(1);
    Object.defineProperty(promise, 'constructor', {
      get: (): never => {
        throw new Error('constructor exploded');
      },
    });

    expect(await settle(adoptPromise(promise))).toBe('constructor exploded');
  });

  test('rejects, not hangs, for a non-constructor constructor with a no-op then', async () => {
    // Resolved, so the limit - a rejection left unhandled - does not fire here.
    const promise: object = Promise.resolve(1);
    Object.defineProperty(promise, 'constructor', { value: 1 });
    Object.defineProperty(promise, 'then', { value: () => undefined });

    const outcome = await Promise.race([
      settle(adoptPromise(promise)),
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve('hung');
        }, 50);
      }),
    ]);

    expect(outcome).not.toBe('hung');
    expect(outcome).not.toBe('resolved');
  });

  test('rejects a promise-prototype fake rather than calling its own then', async () => {
    let isOwnThenCalled = false;
    const fake: object = Object.create(Promise.prototype) as object;
    Object.defineProperty(fake, 'then', {
      value: (): void => {
        isOwnThenCalled = true;
      },
    });

    expect(await settle(adoptPromise(fake))).not.toBe('resolved');
    expect(isOwnThenCalled).toBe(false);
  });

  test('rejects, not hangs, for a species that throws when constructed', async () => {
    const promise = Promise.resolve(1);
    let isOwnThenCalled = false;
    void Object.defineProperty(promise, 'then', {
      value: (): void => {
        isOwnThenCalled = true;
      },
    });
    class Bad {
      constructor() {
        throw new Error('species boom');
      }
    }
    void Object.defineProperty(promise, 'constructor', {
      value: { [Symbol.species]: Bad },
    });

    expect(await settle(adoptPromise(promise))).toBe('species boom');
    expect(isOwnThenCalled).toBe(false);
  });

  test('rejects for a promise from another realm with a throwing constructor getter', async () => {
    const { runInNewContext } = await import('node:vm');
    const promise = runInNewContext('Promise.resolve(1)') as object;
    let isOwnThenCalled = false;
    void Object.defineProperty(promise, 'then', {
      value: (): void => {
        isOwnThenCalled = true;
      },
    });
    Object.defineProperty(promise, 'constructor', {
      get: (): never => {
        throw new Error('constructor exploded');
      },
    });

    expect(await settle(adoptPromise(promise))).toBe('constructor exploded');
    expect(isOwnThenCalled).toBe(false);
  });

  test('adopts a non-promise thenable through its then', async () => {
    const thenable = {
      then: (resolve: (value: number) => void): void => {
        resolve(3);
      },
    };

    expect(await adoptPromise<unknown>(thenable)).toBe(3);
  });

  test('ignores an own constructor paired with an own no-op then', async () => {
    const promise: object = Promise.reject(new Error('real rejection'));
    Object.defineProperty(promise, 'constructor', { value: Object });
    Object.defineProperty(promise, 'then', { value: () => undefined });

    expect(await settle(adoptPromise(promise))).toBe('real rejection');
  });
});
