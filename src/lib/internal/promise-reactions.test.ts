import { expect, test } from 'bun:test';
import { adoptPromise } from './adopt-promise';
import { safeHandleCallbackAndWait } from '../safe-handle-callback';
import { observeRejection, queueMicrotaskSafely } from './promise-reactions';

test('a native race over an adopted promise preserves a fulfilled value without reading its then again', async () => {
  let reads = 0;
  const value = {
    get then(): unknown {
      reads++;
      return reads === 1 ? undefined : (): void => {};
    },
  };
  const fulfilled = Promise.resolve(value);
  const raced = Promise.race([adoptPromise(fulfilled)]);
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

// A caller's own native promise whose `constructor` reads as `Promise` once - enough for
// `Promise.resolve()` to hand it back unchanged - and as `next` from then on. Returned
// adopted: a fresh promise of our own, never the input.
function withShiftingConstructor(
  promise: Promise<unknown>,
  next: () => unknown,
): Promise<{ value: unknown }> {
  let reads = 0;
  void Object.defineProperty(promise, 'constructor', {
    get: () => (++reads === 1 ? Promise : next()),
  });
  const adopted = adoptPromise(promise);
  expect(adopted).not.toBe(promise);
  expect(Object.getPrototypeOf(adopted)).toBe(Promise.prototype);
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

test("adoption settles its own promise when the input's species turns into a class that never settles", async () => {
  const adopted = withShiftingConstructor(
    Promise.resolve(7),
    neverSettlesConstructor,
  );
  const observed = adopted.then((box) => box.value);
  expect(await Promise.race([observed, watchdog()])).toBe(7);
});

test('adoption hears a rejection whose species turns into a class that never settles', async () => {
  const failure = new Error('real rejection');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const adopted = withShiftingConstructor(
      Promise.reject(failure),
      neverSettlesConstructor,
    );
    const observed = adopted.catch((error: unknown) => error);
    expect(await Promise.race([observed, watchdog()])).toBe(failure);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(unhandled).toEqual([]);
});

// Pins the documented limit: once the `constructor` read throws, nothing can attach to
// the input. Adoption rejects with the getter's error instead of hanging. Resolved here,
// since a rejected one would be left unhandled - which is the limit.
test('adoption reports a constructor getter that starts throwing as a rejection', async () => {
  const adopted = withShiftingConstructor(Promise.resolve(1), () => {
    throw new Error('constructor exploded');
  });
  const observed = adopted.then(
    () => 'fulfilled',
    (error: unknown) => (error as Error).message,
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
