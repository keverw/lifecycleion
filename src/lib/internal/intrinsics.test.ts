import { expect, test } from 'bun:test';
import { adoptPromise } from './adopt-promise';
import { safeHandleCallbackAndWait } from '../safe-handle-callback';
import {
  allPromises,
  allSettledPromises,
  awaitBoxedPromise,
  observePromise,
  observeBoxed,
  observeRejection,
  queueMicrotaskSafely,
  racePromises,
} from './intrinsics';

test('racing observes a losing rejection and joining rejects on the first failure', async () => {
  const first = Promise.withResolvers<number>();
  const second = Promise.withResolvers<number>();
  const raced = racePromises([first.promise, second.promise]);
  const joined = allPromises([first.promise, second.promise]);
  const cause = new Error('second failed');
  const observed = observePromise(joined, undefined, (error) => error);
  first.resolve(1);
  expect(await raced).toEqual({ value: 1 });
  second.reject(cause);
  expect(await observed).toBe(cause);
  expect((await allPromises([])).value).toEqual([]);
});

for (const mode of ['race', 'all'] as const) {
  test(`${mode} does not consult caller array iteration hooks`, async () => {
    const inputs = [Promise.resolve(1), Promise.resolve(2)];
    void Object.defineProperty(inputs, Symbol.iterator, {
      value() {
        throw new Error('iterator used');
      },
    });
    void Object.defineProperty(inputs, 'entries', {
      value() {
        throw new Error('entries used');
      },
    });
    expect(
      await (mode === 'race' ? racePromises(inputs) : allPromises(inputs)),
    ).toEqual(mode === 'race' ? { value: 1 } : { value: [1, 2] });
  });
}

test('allSettledPromises waits for every outcome and ignores iterator hooks', async () => {
  const slow = Promise.withResolvers<number>();
  const failure = new Error('failed first');
  const inputs = [Promise.reject(failure), slow.promise];
  void Object.defineProperty(inputs, Symbol.iterator, {
    value() {
      throw new Error('iterator used');
    },
  });
  let didComplete = false;
  const joined = allSettledPromises(inputs);
  void observePromise(joined, () => {
    didComplete = true;
  });
  await Promise.resolve();
  expect(didComplete).toBe(false);
  slow.resolve(2);
  expect((await joined).value).toEqual([
    { status: 'rejected', reason: failure },
    { status: 'fulfilled', value: 2 },
  ]);
  expect((await allSettledPromises([])).value).toEqual([]);
});

test('a race preserves a fulfilled value without reading its then again', async () => {
  let reads = 0;
  const value = {
    get then(): unknown {
      reads++;
      return reads === 1 ? undefined : (): void => {};
    },
  };
  const fulfilled = Promise.resolve(value);
  const raced = racePromises([fulfilled]);
  const winner = await Promise.race([
    raced,
    new Promise<'watchdog'>((resolve) =>
      setTimeout(() => resolve('watchdog'), 30),
    ),
  ]);
  expect(winner).not.toBe('watchdog');
  expect((winner as { value: unknown }).value).toBe(value);
  expect(reads).toBe(1);
});

test('rejection-only observation discards fulfilled values without reading then', async () => {
  let reads = 0;
  const value = {
    get then(): undefined {
      if (++reads > 1) {
        throw new Error('value was forwarded');
      }
      return undefined;
    },
  };
  let reports = 0;
  observeRejection(Promise.resolve(value), () => {
    reports++;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(reads).toBe(1);
  expect(reports).toBe(0);
});

for (const isAsynchronous of [false, true]) {
  test(`rejection-only observation contains a ${isAsynchronous ? 'rejecting' : 'throwing'} reporter`, async () => {
    let reports = 0;
    observeRejection(Promise.reject(new Error('original')), () => {
      reports++;
      const failure = new Error('reporter failed');
      if (isAsynchronous) {
        return Promise.reject(failure);
      }
      throw failure;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reports).toBe(1);
  });
}

for (const shouldReject of [false, true]) {
  test(`boxed mapping does not adopt mapped data on rejection=${String(shouldReject)}`, async () => {
    const mapped = new Error('mapped metadata');
    let reads = 0;
    Object.defineProperty(mapped, 'then', {
      get() {
        reads++;
        throw new Error('mapped data must not be adopted');
      },
    });
    const source = shouldReject
      ? Promise.reject(new Error('source'))
      : Promise.resolve();
    const result = await observeBoxed(
      source,
      () => mapped,
      () => mapped,
    );
    expect(result.value).toBe(mapped);
    expect(reads).toBe(0);
  });
}

test('boxed mapping preserves a mapper throw as rejection', async () => {
  const failure = new Error('mapper failed');
  const result = observeBoxed(Promise.resolve(), () => {
    throw failure;
  });
  expect(await result.catch((error: unknown) => error)).toBe(failure);
});

// A caller's own native promise whose `constructor` reads as `Promise` once - enough for
// adoption to hand it back unchanged - and as `next` from then on. Returned adopted, as
// every caller of these observers receives it.
function withShiftingConstructor(
  promise: Promise<unknown>,
  next: () => unknown,
): Promise<unknown> {
  let reads = 0;
  void Object.defineProperty(promise, 'constructor', {
    get: () => (++reads === 1 ? Promise : next()),
  });
  const adopted = adoptPromise(promise);
  expect(adopted).toBe(promise);
  return adopted;
}

// A species that builds without complaint but whose instances never settle anyone.
class NeverSettles {
  constructor(executor: (resolve: unknown, reject: unknown) => void) {
    executor(
      () => {},
      () => {},
    );
  }

  public then(): void {}
}

const neverSettlesConstructor = (): unknown => ({
  [Symbol.species]: NeverSettles,
});

for (const speciesKind of [
  'base promise',
  'self-reproducing subclass',
] as const) {
  test(`a ${speciesKind} rejected by the input's species cannot crash an awaited callback`, async () => {
    const orphan = new Error('species rejected its derived promise');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    const species =
      speciesKind === 'base promise'
        ? function ReturningRejectedPromise(
            this: unknown,
            executor: (resolve: () => void, reject: () => void) => void,
          ): object {
            executor(
              () => {},
              () => {},
            );
            return Promise.reject(orphan);
          }
        : class RejectingSpecies extends Promise<unknown> {
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
          };
    const source = Promise.resolve(7);
    let constructorReads = 0;
    void Object.defineProperty(source, 'constructor', {
      get: () =>
        ++constructorReads === 1 ? Promise : { [Symbol.species]: species },
    });

    process.on('unhandledRejection', onUnhandled);
    try {
      expect(
        await safeHandleCallbackAndWait<number>('callback', () => source),
      ).toEqual({
        success: true,
        value: 7,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
}

function watchdog(ms = 100): Promise<'hung'> {
  return new Promise((resolve) => setTimeout(() => resolve('hung'), ms));
}

for (const entry of [
  'observePromise',
  'awaitBoxedPromise',
  'observeBoxed',
] as const) {
  test(`${entry} settles its own promise when the input's species turns into a class that never settles`, async () => {
    const source = withShiftingConstructor(
      Promise.resolve(7),
      neverSettlesConstructor,
    );
    const observed: Promise<unknown> =
      entry === 'observePromise'
        ? observePromise(source, (value) => value)
        : entry === 'awaitBoxedPromise'
          ? awaitBoxedPromise(source).then((box) => box.value)
          : observeBoxed(source, (value) => value).then((box) => box.value);
    expect(Object.getPrototypeOf(observed)).toBe(Promise.prototype);
    expect(await Promise.race([observed, watchdog()])).toBe(7);
  });

  test(`${entry} hears a rejection whose species turns into a class that never settles`, async () => {
    const failure = new Error('real rejection');
    const source = withShiftingConstructor(
      Promise.reject(failure),
      neverSettlesConstructor,
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const observed: Promise<unknown> =
        entry === 'observePromise'
          ? observePromise(source, undefined, (error) => error)
          : entry === 'awaitBoxedPromise'
            ? awaitBoxedPromise(source).catch((error: unknown) => error)
            : observeBoxed(
                source,
                () => 'fulfilled',
                (error) => error,
              ).then((box) => box.value);
      expect(await Promise.race([observed, watchdog()])).toBe(failure);
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
}

// Pins the documented limit: once the `constructor` read throws, nothing can attach to
// the input. The reactions hear the getter's error instead of hanging. Resolved here,
// since a rejected one would be left unhandled - which is the limit.
test('observePromise reports a constructor getter that starts throwing as a rejection', async () => {
  const source = withShiftingConstructor(Promise.resolve(1), () => {
    throw new Error('constructor exploded');
  });
  const observed = observePromise(
    source,
    () => 'fulfilled',
    (error) => (error as Error).message,
  );
  expect(await Promise.race([observed, watchdog()])).toBe(
    'constructor exploded',
  );
});

test('a queued task failure reaches the console when no reporter is supplied', async () => {
  const original = console.error;
  const failure = new Error('queued task failed');
  const seen: unknown[] = [];
  console.error = (error: unknown): void => {
    seen.push(error);
  };
  try {
    queueMicrotaskSafely(() => {
      throw failure;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  } finally {
    console.error = original;
  }
  expect(seen).toEqual([failure]);
});
