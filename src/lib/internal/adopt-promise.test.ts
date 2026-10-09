import { describe, expect, test } from 'bun:test';
import { muteConsoleError, restoreConsoleError } from './console-test-utils';
import {
  adoptPromise,
  adoptResult,
  containDeferredResult,
  UnreadableReturn,
} from './adopt-promise';

// The rejection's message, or `'resolved'`.
async function settle(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (error) {
    return (error as Error).message;
  }
}

for (const entry of [
  'adoptPromise',
  'adoptResult',
  'containDeferredResult',
] as const) {
  for (const hasRecursiveSpecies of [false, true]) {
    for (const isSourceRejected of [false, true]) {
      test(`${entry} contains a ${hasRecursiveSpecies ? 'recursive' : 'plain'} rejected species result from a ${isSourceRejected ? 'rejected' : 'fulfilled'} source`, async () => {
        const orphan = new Error('unused species rejection');
        const failure = new Error('source rejection');
        const source = isSourceRejected
          ? Promise.reject(failure)
          : Promise.resolve(7);
        const species = hasRecursiveSpecies
          ? class RejectingSpecies extends Promise<unknown> {
              constructor(
                executor: (
                  resolve: (value: unknown) => void,
                  reject: (reason?: unknown) => void,
                ) => void,
              ) {
                super((resolve, reject) => {
                  executor(resolve, reject);
                  reject(orphan);
                });
              }
            }
          : function ReturningRejectedPromise(
              this: unknown,
              executor: (resolve: () => void, reject: () => void) => void,
            ): object {
              executor(
                () => {},
                () => {},
              );
              return Promise.reject(orphan);
            };
        const constructor = { [Symbol.species]: species };
        void Object.defineProperty(source, 'constructor', {
          value: constructor,
        });
        let ownThenCalls = 0;
        if (entry !== 'containDeferredResult') {
          void Object.defineProperty(source, 'then', {
            value: (): void => {
              ownThenCalls++;
            },
          });
        }
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandled);
        try {
          if (entry === 'containDeferredResult') {
            expect(containDeferredResult(source)).toBe(true);
          } else {
            const pending =
              entry === 'adoptPromise'
                ? adoptPromise(source)
                : adoptResult(source);
            expect(pending).toBeDefined();
            if (pending === undefined || pending instanceof UnreadableReturn) {
              throw new Error('Expected an adopted promise');
            }
            if (isSourceRejected) {
              expect(await pending.catch((error: unknown) => error)).toBe(
                failure,
              );
            } else {
              expect((await pending).value).toBe(7);
            }
          }
          expect(ownThenCalls).toBe(0);
          expect(
            Object.getOwnPropertyDescriptor(source, 'constructor')?.value,
          ).toBe(constructor);
          await new Promise((resolve) => setTimeout(resolve, 0));
        } finally {
          process.off('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toEqual([]);
      });
    }
  }
}

describe('adoptPromise', () => {
  test('settles as a plain value or native promise does', async () => {
    expect(await adoptPromise(1)).toEqual({ value: 1 });
    expect(await adoptPromise(Promise.resolve(2))).toEqual({ value: 2 });
    expect(await settle(adoptPromise(Promise.reject(new Error('no'))))).toBe(
      'no',
    );
  });

  test('returns a fresh promise of its own, never the input', () => {
    const native = Promise.resolve(1);
    const ownThen = Promise.resolve(2);
    void Object.defineProperty(ownThen, 'then', {
      value: Promise.prototype.then.bind(ownThen),
    });
    for (const input of [native, ownThen]) {
      const adopted = adoptPromise(input);
      expect(adopted).not.toBe(input);
      expect(Object.getPrototypeOf(adopted)).toBe(Promise.prototype);
      expect(Object.hasOwn(adopted, 'then')).toBe(false);
    }
  });

  for (const hasOwnThen of [false, true]) {
    test(`boxes a fulfilled value without reading its then again (own then: ${String(hasOwnThen)})`, async () => {
      let reads = 0;
      const value = {
        get then(): undefined {
          if (++reads > 1) {
            throw new Error('fulfilled value was adopted twice');
          }
          return undefined;
        },
      };
      const source = Promise.resolve(value);
      expect(reads).toBe(1);
      if (hasOwnThen) {
        void Object.defineProperty(source, 'then', { value: () => undefined });
      }
      const box = await Promise.race([adoptPromise(source)]);
      expect(box.value).toBe(value);
      expect(reads).toBe(1);
    });
  }

  for (const isRejected of [false, true]) {
    test(`onSettled runs before any reaction to the result (rejected: ${String(isRejected)})`, async () => {
      const order: string[] = [];
      const source = isRejected
        ? Promise.reject(new Error('failed'))
        : Promise.resolve(1);
      const adopted = adoptPromise(source, {
        onSettled: (didFulfill) => {
          order.push(`settled:${String(didFulfill)}`);
        },
      });
      await adopted.then(
        () => order.push('reaction'),
        () => order.push('reaction'),
      );
      expect(order).toEqual([`settled:${String(!isRejected)}`, 'reaction']);
    });
  }

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

  test("follows a Promise subclass's own then, as await does", async () => {
    // A lazy promise: its work starts only when `then` is called. Read through the
    // intrinsic, the work never ran and the result was `undefined`.
    class Lazy<T> extends Promise<T> {
      public static get [Symbol.species](): PromiseConstructor {
        return Promise;
      }

      #executor: (resolve: (value: T) => void) => void;
      #promise?: Promise<T>;

      constructor(executor: (resolve: (value: T) => void) => void) {
        super((resolve) => {
          resolve(undefined as T);
        });
        this.#executor = executor;
      }

      public override then<A = T, B = never>(
        onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
        onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
      ): Promise<A | B> {
        this.#promise ??= new Promise<T>(this.#executor);

        return this.#promise.then(onFulfilled, onRejected);
      }
    }

    const lazy = new Lazy<string>((resolve) => {
      setTimeout(() => {
        resolve('value');
      }, 5);
    });

    expect((await adoptPromise(lazy)).value).toBe('value');
  });

  test('follows a proxy around a promise through its then', async () => {
    const proxy = new Proxy(Promise.resolve(42), {
      get(target, key): unknown {
        const member: unknown = Reflect.get(target, key);

        return typeof member === 'function'
          ? (member as (...args: unknown[]) => unknown).bind(target)
          : member;
      },
    });

    expect((await adoptPromise(proxy)).value).toBe(42);
  });

  test('rejects a proxy with an own bound then rather than trusting its override', async () => {
    const target = Promise.resolve(42);
    void Object.defineProperty(target, 'then', {
      value: Promise.prototype.then.bind(target),
    });
    const proxy = new Proxy(target, {});

    const failure = await adoptPromise(proxy).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
  });

  test('adopts a non-promise thenable through its then', async () => {
    const thenable = {
      then: (resolve: (value: number) => void): void => {
        resolve(3);
      },
    };

    expect((await adoptPromise<unknown>(thenable)).value).toBe(3);
  });

  test('ignores an own constructor paired with an own no-op then', async () => {
    const promise: object = Promise.reject(new Error('real rejection'));
    Object.defineProperty(promise, 'constructor', { value: Object });
    Object.defineProperty(promise, 'then', { value: () => undefined });

    expect(await settle(adoptPromise(promise))).toBe('real rejection');
  });
});

test('adoptResult reads a thenable accessor once and invokes it asynchronously with its receiver', async () => {
  let reads = 0;
  let calls = 0;
  const value = {
    get then() {
      if (++reads > 1) {
        throw new Error('second read');
      }
      return function (this: unknown, resolve: (value: number) => void): void {
        expect(this).toBe(value);
        calls++;
        resolve(42);
      };
    },
  };
  const pending = adoptResult(value);
  expect(pending).not.toBeInstanceOf(UnreadableReturn);
  expect(reads).toBe(1);
  expect(calls).toBe(0);
  expect(((await pending) as { value: unknown }).value).toBe(42);
  expect(reads).toBe(1);
  expect(calls).toBe(1);
});

test('adoptResult preserves an unreadable first read as a return-contract error', () => {
  const cause = new Error('first read');
  const result = adoptResult({
    get then(): never {
      throw cause;
    },
  });
  expect(result).toBeInstanceOf(UnreadableReturn);
  expect((result as UnreadableReturn).cause).toBe(cause);
});

test('adoptResult rejects a proxy with an own bound then', async () => {
  const target = Promise.resolve(42);
  void Object.defineProperty(target, 'then', {
    value: Promise.prototype.then.bind(target),
  });
  const proxy = new Proxy(target, {});

  const result = adoptResult(proxy);
  expect(result).toBeInstanceOf(Promise);
  const failure = await (result as Promise<unknown>).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(TypeError);
});

for (const entry of ['adoptPromise', 'adoptResult'] as const) {
  test(`${entry} classifies an own-then proxy by one answer from its getPrototypeOf trap`, async () => {
    // Claims `Promise.prototype` once, then `null`: a classification that asked twice
    // could call it a promise in one place and a plain thenable in the next, and follow
    // the own `then` it refuses for anything on the promise chain.
    let thenCalls = 0;
    let prototypeReads = 0;
    const proxy = new Proxy(
      {
        then(resolve: (value: unknown) => void): void {
          thenCalls++;
          resolve('followed');
        },
      },
      {
        getPrototypeOf: () =>
          ++prototypeReads === 1 ? Promise.prototype : null,
      },
    );

    const adopted =
      entry === 'adoptPromise'
        ? adoptPromise(proxy)
        : (adoptResult(proxy) as Promise<unknown>);
    const failure = await adopted.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(TypeError);
    expect(thenCalls).toBe(0);
    expect(prototypeReads).toBe(1);
  });
}

test('a foreign promise proxy with an own bound then follows the thenable fallback', async () => {
  const { runInNewContext } = await import('node:vm');
  const target = runInNewContext('Promise.resolve(42)') as Promise<number>;
  void Object.defineProperty(target, 'then', {
    value: Promise.prototype.then.bind(target),
  });
  const proxy = new Proxy(target, {});
  expect(proxy instanceof Promise).toBe(false);

  expect((await adoptPromise(proxy)).value).toBe(42);
  expect(await adoptResult(proxy)).toEqual({ value: 42 });
});

for (const mode of ['throwing getter', 'non-function'] as const) {
  test(`adoptResult observes a foreign promise with an own ${mode}`, async () => {
    const { runInNewContext } = await import('node:vm');
    const promise = runInNewContext(
      'Promise.reject(new Error("foreign rejection"))',
    ) as object;
    // Keep the broken baseline safe for the test runner. The assertion below must
    // still observe the rejection through adoptResult, not through this safety catch.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    void Reflect.apply(Promise.prototype.then, promise, [undefined, () => {}]);
    expect(promise instanceof Promise).toBe(false);
    let reads = 0;
    Object.defineProperty(
      promise,
      'then',
      mode === 'throwing getter'
        ? {
            get(): never {
              reads++;
              throw new Error('own then must not run');
            },
          }
        : { value: 0 },
    );
    const pending = adoptResult(promise);
    expect(pending).toBeInstanceOf(Promise);
    expect(await settle(pending as Promise<unknown>)).toBe('foreign rejection');
    expect(reads).toBe(0);
  });
}

for (const prototype of [null, new (class Deferred {})()]) {
  test(`own-then native promise keeps rejection with ${prototype === null ? 'null' : 'class'} prototype`, async () => {
    const failure = new Error('native rejection');
    const promise = Promise.reject(failure);
    void Object.setPrototypeOf(promise, prototype);
    void Object.defineProperty(promise, 'then', {
      value: (): never => {
        throw new Error('own then must not run');
      },
    });
    expect(await settle(adoptPromise(promise))).toBe(failure.message);
  });
}

for (const ownThen of ['non-function', 'no-op'] as const) {
  test(`a foreign rejected promise with a species that never builds a promise and an own ${ownThen} then rejects`, async () => {
    const { runInNewContext } = await import('node:vm');
    const promise = runInNewContext(
      'Promise.reject(new Error("foreign rejection"))',
    ) as object;
    // Keep the broken baseline safe for the test runner.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    void Reflect.apply(Promise.prototype.then, promise, [undefined, () => {}]);
    let isOwnThenCalled = false;
    Object.defineProperty(promise, 'then', {
      value:
        ownThen === 'non-function'
          ? 1
          : (): void => {
              isOwnThenCalled = true;
            },
    });
    Object.defineProperty(promise, 'constructor', {
      value: {
        [Symbol.species]: class {
          constructor() {}
        },
      },
    });

    // The species refusal is what rejects: the rejection itself cannot be reached
    // without a working species, as for a local broken promise.
    for (const pending of [adoptResult(promise), adoptPromise(promise)]) {
      expect(pending).toBeInstanceOf(Promise);
      const hung = new Promise<string>((resolve) => {
        setTimeout(() => resolve('hung'), 100);
      });
      expect(
        await Promise.race([
          (pending as Promise<unknown>).then(
            () => 'resolved',
            (error: unknown) => error,
          ),
          hung,
        ]),
      ).toBeInstanceOf(TypeError);
    }
    expect(containDeferredResult(promise)).toBe(true);
    expect(isOwnThenCalled).toBe(false);
  });
}

for (const base of [Array, Map] as const) {
  test(`an own-then ${base.name} subclass is adopted through its then without building its species`, async () => {
    let constructed = 0;
    class Thenable extends (base as ArrayConstructor) {
      constructor() {
        super();
        constructed++;
      }

      public then = (resolve: (value: string) => void): void => {
        resolve('adopted');
      };
    }
    const thenable: object = new Thenable();
    constructed = 0;

    expect((await adoptPromise<unknown>(thenable)).value).toBe('adopted');
    expect(constructed).toBe(0);
  });
}

for (const entry of ['adoptPromise', 'adoptResult'] as const) {
  test(`${entry} rejects a foreign promise whose own no-op then hides a throwing species`, async () => {
    const { runInNewContext } = await import('node:vm');
    const promise = runInNewContext(
      'Promise.reject(new Error("foreign rejection"))',
    ) as object;
    // Keep the broken baseline safe for the test runner.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    void Reflect.apply(Promise.prototype.then, promise, [undefined, () => {}]);
    let isOwnThenCalled = false;
    Object.defineProperty(promise, 'then', {
      value: (): void => {
        isOwnThenCalled = true;
      },
    });
    // The `constructor` read succeeds; only the species read throws - and not this
    // realm's TypeError, which the slot check alone could have thrown.
    Object.defineProperty(promise, 'constructor', {
      value: {
        get [Symbol.species](): never {
          throw new Error('species failure');
        },
      },
    });

    const pending =
      entry === 'adoptPromise'
        ? adoptPromise(promise)
        : (adoptResult(promise) as Promise<unknown>);
    const hung = new Promise<string>((resolve) => {
      setTimeout(() => resolve('hung'), 200);
    });
    expect(await Promise.race([settle(pending), hung])).toBe('species failure');
    expect(isOwnThenCalled).toBe(false);
  });
}

for (const entry of ['adoptPromise', 'adoptResult'] as const) {
  test(`${entry} adopts a thenable tagged as a promise with a non-object constructor`, async () => {
    const thenable = new (class Deferred {
      public then = (resolve: (value: string) => void): void => {
        resolve('adopted');
      };
    })();
    Object.defineProperty(thenable, Symbol.toStringTag, { value: 'Promise' });
    Object.defineProperty(thenable, 'constructor', { value: 5 });
    expect(Object.prototype.toString.call(thenable)).toBe('[object Promise]');

    const pending =
      entry === 'adoptPromise'
        ? adoptPromise<unknown>(thenable)
        : (adoptResult(thenable) as Promise<{ value: unknown }>);
    expect((await pending).value).toBe('adopted');
  });
}

// Settle with a TypeError, or `'resolved'` / `'hung'`, within `ms`.
async function settleWithin(
  pending: Promise<unknown>,
  ms: number,
): Promise<unknown> {
  const hung = new Promise<string>((resolve) => {
    setTimeout(() => resolve('hung'), ms);
  });
  return await Promise.race([
    pending.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    hung,
  ]);
}

for (const entry of ['adoptPromise', 'adoptResult'] as const) {
  // Resolved, so the limit - a rejection left unhandled - does not fire here.
  test(`${entry} rejects a re-prototyped promise with a broken constructor and no tag rather than trusting its own then`, async () => {
    const promise: object = Promise.resolve(1);
    void Object.setPrototypeOf(promise, { constructor: 5 });
    let isOwnThenCalled = false;
    void Object.defineProperty(promise, 'then', {
      value: (): void => {
        isOwnThenCalled = true;
      },
    });
    expect(Object.prototype.toString.call(promise)).toBe('[object Object]');

    const pending =
      entry === 'adoptPromise'
        ? adoptPromise(promise)
        : (adoptResult(promise) as Promise<unknown>);
    expect(await settleWithin(pending, 100)).toBeInstanceOf(TypeError);
    expect(isOwnThenCalled).toBe(false);
  });

  test(`${entry} rejects, not fulfills, a re-prototyped rejected promise with a broken constructor and a non-function own then`, async () => {
    const source = Promise.reject(new Error('real failure'));
    // Observed before the constructor breaks, so the runner sees it handled; the
    // broken constructor would leave it unhandled otherwise, as documented.
    source.catch(() => {});
    const promise: object = source;
    void Object.setPrototypeOf(promise, { constructor: 5 });
    void Object.defineProperty(promise, 'then', { value: 1 });

    const pending =
      entry === 'adoptPromise'
        ? adoptPromise(promise)
        : (adoptResult(promise) as Promise<unknown>);
    expect(await settleWithin(pending, 100)).toBeInstanceOf(TypeError);
    expect(containDeferredResult(promise)).toBe(true);
  });

  // Each engine words a species executor called twice by whichever function it already
  // holds, so a resolve left `undefined` the first time is refused in words of its own.
  test(`${entry} rejects a re-prototyped promise whose species executor is called twice after an undefined resolve`, async () => {
    const noop = (): void => {};
    const promise: object = Promise.resolve(1);
    void Object.setPrototypeOf(promise, {
      constructor: {
        [Symbol.species]: class {
          constructor(executor: (...args: unknown[]) => void) {
            executor(undefined, noop);
            executor(noop, noop);
          }
        },
      },
    });
    let isOwnThenCalled = false;
    void Object.defineProperty(promise, 'then', {
      value: (): void => {
        isOwnThenCalled = true;
      },
    });

    const pending =
      entry === 'adoptPromise'
        ? adoptPromise(promise)
        : (adoptResult(promise) as Promise<unknown>);
    expect(await settleWithin(pending, 100)).toBeInstanceOf(TypeError);
    expect(isOwnThenCalled).toBe(false);
  });
}

// A species `RangeError` thrown with stack to spare is not the slot check running out of
// stack, so the value is a native promise and its own `then` is not trusted.
for (const entry of ['adoptPromise', 'adoptResult'] as const) {
  test(`${entry} rejects a re-prototyped promise whose species throws a RangeError rather than trusting its own then`, async () => {
    const promise: object = Promise.resolve(1);
    void Object.setPrototypeOf(promise, {
      constructor: {
        [Symbol.species]: class {
          constructor() {
            throw new RangeError('species refused');
          }
        },
      },
    });
    let isOwnThenCalled = false;
    void Object.defineProperty(promise, 'then', {
      value: (): void => {
        isOwnThenCalled = true;
      },
    });

    const pending =
      entry === 'adoptPromise'
        ? adoptPromise(promise)
        : (adoptResult(promise) as Promise<unknown>);
    const outcome = await settleWithin(pending, 100);
    expect(outcome).toBeInstanceOf(RangeError);
    expect((outcome as RangeError).message).toBe('species refused');
    expect(isOwnThenCalled).toBe(false);
  });
}

test('containDeferredResult counts a re-prototyped promise whose species throws a RangeError as a promise', () => {
  const promise: object = Promise.resolve(1);
  void Object.setPrototypeOf(promise, {
    constructor: {
      [Symbol.species]: class {
        constructor() {
          throw new RangeError('species refused');
        }
      },
    },
  });
  void Object.defineProperty(promise, 'then', { value: 1 });
  expect(containDeferredResult(promise)).toBe(true);
});

test('containDeferredResult observes a native rejection reparented to Object.prototype', async () => {
  const promise = Promise.reject(new Error('reparented native failure'));
  void Object.setPrototypeOf(promise, Object.prototype);
  expect(containDeferredResult(promise)).toBe(true);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
});

test('adoption ignores an own then on a native promise reparented to Object.prototype', async () => {
  const promise = Promise.reject(new Error('real native failure'));
  void Object.setPrototypeOf(promise, Object.prototype);
  let calls = 0;
  void Object.defineProperty(promise, 'then', {
    value: () => {
      calls++;
    },
  });
  expect(await settle(adoptPromise(promise))).toBe('real native failure');
  expect(calls).toBe(0);
});

for (const hasOwnThen of [false, true]) {
  test(`a throwing observation-failure callback keeps the original rejection (own then: ${String(hasOwnThen)})`, async () => {
    const captured = muteConsoleError();
    const source = Promise.resolve(1);
    void Object.defineProperty(source, 'constructor', {
      get(): never {
        throw new Error('constructor refused');
      },
    });
    if (hasOwnThen) {
      void Object.defineProperty(source, 'then', { value: () => {} });
    }
    try {
      let adopted: Promise<unknown> | undefined;
      expect(() => {
        adopted = adoptPromise(source, {
          onObservationFailure: () => {
            throw new Error('callback failed');
          },
        });
      }).not.toThrow();
      expect(await settle(adopted as Promise<unknown>)).toBe(
        'constructor refused',
      );
      expect(captured).toEqual([
        'An adoption failure callback threw: callback failed',
      ]);
    } finally {
      restoreConsoleError();
    }
  });
}
