import { describe, expect, test } from 'bun:test';
import { adoptPromise, adoptResult, UnreadableReturn } from './adopt-promise';

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

    expect(await adoptPromise(lazy)).toBe('value');
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

    expect(await adoptPromise(proxy)).toBe(42);
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

    expect(await adoptPromise<unknown>(thenable)).toBe(3);
  });

  test('ignores an own constructor paired with an own no-op then', async () => {
    const promise: object = Promise.reject(new Error('real rejection'));
    Object.defineProperty(promise, 'constructor', { value: Object });
    Object.defineProperty(promise, 'then', { value: () => undefined });

    expect(await settle(adoptPromise(promise))).toBe('real rejection');
  });

  test('adopts a plain thenable without trying the intrinsic on it', async () => {
    const thenable = {
      then(resolve: (value: string) => void): void {
        resolve('plain');
      },
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored, and only applied
    const intrinsic = Promise.prototype.then;
    let intrinsicCallsOnThenable = 0;
    Promise.prototype.then = function (
      this: unknown,
      ...args: Parameters<typeof intrinsic>
    ): Promise<unknown> {
      if (this === thenable) {
        intrinsicCallsOnThenable++;
      }

      return Reflect.apply(intrinsic, this, args);
    } as typeof intrinsic;

    let adopted: Promise<string>;

    try {
      adopted = adoptPromise(thenable as unknown as PromiseLike<string>);
    } finally {
      Promise.prototype.then = intrinsic;
    }

    expect(await adopted).toBe('plain');
    expect(intrinsicCallsOnThenable).toBe(0);
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
  expect(await pending).toBe(42);
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

test('a foreign promise proxy with an own bound then follows the thenable fallback', async () => {
  const { runInNewContext } = await import('node:vm');
  const target = runInNewContext('Promise.resolve(42)') as Promise<number>;
  void Object.defineProperty(target, 'then', {
    value: Promise.prototype.then.bind(target),
  });
  const proxy = new Proxy(target, {});
  expect(proxy instanceof Promise).toBe(false);

  expect(await adoptPromise(proxy)).toBe(42);
  expect(await adoptResult(proxy)).toBe(42);
});

for (const entry of ['adoptPromise', 'adoptResult'] as const) {
  test(`${entry} keeps the native then after a later prototype patch`, async () => {
    const source = Promise.resolve(42);
    void Object.defineProperty(source, 'then', { value: () => undefined });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalThen = Promise.prototype.then;
    let pending!: Promise<unknown>;
    try {
      Promise.prototype.then = (() => {
        throw new Error('patched then must not run');
      }) as typeof Promise.prototype.then;
      pending =
        entry === 'adoptPromise'
          ? adoptPromise(source)
          : (adoptResult(source) as Promise<unknown>);
    } finally {
      Promise.prototype.then = originalThen;
    }
    expect(await pending).toBe(42);
  });

  test(`${entry} keeps the own-then check after a later hasOwnProperty patch`, async () => {
    // An own constructor makes Promise.resolve wrap the promise and call its own then.
    const source: object = Promise.reject(new Error('real rejection'));
    Object.defineProperty(source, 'constructor', { value: Object });
    Object.defineProperty(source, 'then', { value: () => undefined });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalHasOwn = Object.prototype.hasOwnProperty;
    let pending!: Promise<unknown>;
    try {
      // A patch that hides the own no-op then would leave adoption hanging.
      Object.prototype.hasOwnProperty = () => false;
      pending =
        entry === 'adoptPromise'
          ? adoptPromise(source)
          : (adoptResult(source) as Promise<unknown>);
    } finally {
      Object.prototype.hasOwnProperty = originalHasOwn;
    }
    const hung = new Promise<string>((resolve) => {
      setTimeout(() => resolve('hung'), 200);
    });
    expect(await Promise.race([settle(pending), hung])).toBe('real rejection');
  });

  test(`${entry} keeps Promise.resolve after a later static patch`, async () => {
    const source = Promise.resolve(42);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalResolve = Promise.resolve;
    let pending!: Promise<unknown>;
    try {
      Promise.resolve = () => {
        throw new Error('patched resolve must not run');
      };
      pending =
        entry === 'adoptPromise'
          ? adoptPromise(source)
          : (adoptResult(source) as Promise<unknown>);
    } finally {
      Promise.resolve = originalResolve;
    }
    expect(await pending).toBe(42);
  });
}

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
      expect(
        await (pending as Promise<unknown>).then(
          () => 'resolved',
          (error: unknown) => error,
        ),
      ).toBeInstanceOf(TypeError);
    }
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

    expect(await adoptPromise<unknown>(thenable)).toBe('adopted');
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

  test(`${entry} adopts a thenable after Promise gains a Symbol.hasInstance that claims it`, async () => {
    // A class prototype keeps the thenable off the plain-object shortcut, so it
    // reaches the classification a redefined `instanceof` would mislead.
    const thenable = new (class Deferred {
      public then = (resolve: (value: string) => void): void => {
        resolve('adopted');
      };
    })();
    let pending!: Promise<unknown>;
    try {
      Object.defineProperty(Promise, Symbol.hasInstance, {
        configurable: true,
        value: () => true,
      });
      pending =
        entry === 'adoptPromise'
          ? adoptPromise<unknown>(thenable)
          : (adoptResult(thenable) as Promise<unknown>);
    } finally {
      delete (Promise as unknown as Record<symbol, unknown>)[
        Symbol.hasInstance
      ];
    }
    expect(await settle(pending)).toBe('resolved');
    expect(await pending).toBe('adopted');
  });

  test(`${entry} keeps the prototype check after a later Reflect.getPrototypeOf patch`, async () => {
    // An own constructor makes Promise.resolve wrap the promise and call its own then.
    const source: object = Promise.reject(new Error('real rejection'));
    Object.defineProperty(source, 'constructor', { value: Object });
    Object.defineProperty(source, 'then', { value: () => undefined });
    const originalGetPrototypeOf = Reflect.getPrototypeOf;
    let pending!: Promise<unknown>;
    try {
      // A patch that dresses the promise as a plain object would skip the intrinsic.
      Reflect.getPrototypeOf = () => Object.prototype;
      pending =
        entry === 'adoptPromise'
          ? adoptPromise(source)
          : (adoptResult(source) as Promise<unknown>);
    } finally {
      Reflect.getPrototypeOf = originalGetPrototypeOf;
    }
    const hung = new Promise<string>((resolve) => {
      setTimeout(() => resolve('hung'), 200);
    });
    expect(await Promise.race([settle(pending), hung])).toBe('real rejection');
  });
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
    const hung = new Promise<string>((resolve) => {
      setTimeout(() => resolve('hung'), 100);
    });
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      hung,
    ]);
    expect(outcome).toBeInstanceOf(TypeError);
    expect(isOwnThenCalled).toBe(false);
  });

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
        : (adoptResult(thenable) as Promise<unknown>);
    expect(await pending).toBe('adopted');
  });
}

for (const entry of ['adoptPromise', 'adoptResult'] as const) {
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
    const hung = new Promise<string>((resolve) => {
      setTimeout(() => resolve('hung'), 100);
    });
    const outcome = await Promise.race([
      pending.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      hung,
    ]);
    expect(outcome).toBeInstanceOf(TypeError);
    expect(isOwnThenCalled).toBe(false);
  });
}
