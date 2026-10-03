import { expect, test } from 'bun:test';
import {
  allPromises,
  allSettledPromises,
  observePromise,
  observeBoxed,
  observeRejection,
  racePromises,
} from './intrinsics';

for (const mode of ['race', 'all'] as const) {
  test(`${mode} observes native inputs despite replaced then and combinators`, async () => {
    const first = Promise.withResolvers<number>();
    const second = Promise.withResolvers<number>();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalThen = Promise.prototype.then;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalRace = Promise.race;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const originalAll = Promise.all;
    let joined: Promise<unknown>;
    try {
      Promise.prototype.then = (() => {
        throw new Error('live then used');
      }) as typeof originalThen;
      Promise.race = (() => {
        throw new Error('live race used');
      }) as typeof originalRace;
      Promise.all = (() => {
        throw new Error('live all used');
      }) as typeof originalAll;
      joined =
        mode === 'race'
          ? racePromises([first.promise, second.promise])
          : allPromises([first.promise, second.promise]);
    } finally {
      Promise.prototype.then = originalThen;
      Promise.race = originalRace;
      Promise.all = originalAll;
    }
    second.resolve(2);
    first.resolve(1);
    expect(await joined).toEqual(
      mode === 'race' ? { value: 2 } : { value: [1, 2] },
    );
  });
}

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
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
}

test('boxed mapping preserves a mapper throw as rejection', async () => {
  const failure = new Error('mapper failed');
  const result = observeBoxed(Promise.resolve(), () => {
    throw failure;
  });
  expect(await result.catch((error: unknown) => error)).toBe(failure);
});
