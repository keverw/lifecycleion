import { expect, spyOn, test } from 'bun:test';
import { raceDeadline } from './race-deadline';
import { observePromise } from './intrinsics';
import { adoptPromise } from './adopt-promise';

test('zero expires next turn while undefined disables the timer', async () => {
  const pending = Promise.withResolvers<number>();
  let didTimeout = false;
  const unlimited = raceDeadline(pending.promise, undefined, () => {
    didTimeout = true;
    return -1;
  });
  expect((await raceDeadline(pending.promise, 0, () => -1)).value).toBe(-1);
  expect(didTimeout).toBe(false);
  pending.resolve(2);
  expect((await unlimited).value).toBe(2);
});

test('settlement clears the deadline on fulfillment and rejection', async () => {
  let timeouts = 0;
  const fail = new Error('input failed');
  expect(
    (
      await raceDeadline(Promise.resolve(3), 1, () => {
        timeouts++;
      })
    ).value,
  ).toBe(3);
  const rejected = raceDeadline(Promise.reject(fail), 1, () => {
    timeouts++;
  });
  expect(await observePromise(rejected, undefined, (error) => error)).toBe(
    fail,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(timeouts).toBe(0);
});

test('a throwing timeout callback rejects and late input rejection remains observed', async () => {
  const pending = Promise.withResolvers<void>();
  const fail = new Error('deadline callback');
  const timed = raceDeadline(pending.promise, 0, () => {
    throw fail;
  });
  expect(await observePromise(timed, undefined, (error) => error)).toBe(fail);
  pending.reject(new Error('late rejection'));
  await new Promise((resolve) => setTimeout(resolve, 0));
});

for (const shouldUnref of [false, true]) {
  test(`deadline timer reference policy: shouldUnref=${String(shouldUnref)}`, async () => {
    const original = globalThis.setTimeout;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hook = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      timer = original(callback, delay);
      return timer;
    }) as typeof setTimeout);
    try {
      const pending = raceDeadline(
        Promise.resolve(1),
        60000,
        () => 0,
        shouldUnref ? { shouldUnref: true } : undefined,
      );
      expect(timer?.hasRef()).toBe(!shouldUnref);
      expect((await pending).value).toBe(1);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      hook.mockRestore();
    }
  });
}

test('an unlimited wait settles when the adopted input species turns into a class that never settles', async () => {
  class NeverSettles {
    constructor(executor: (resolve: unknown, reject: unknown) => void) {
      executor(
        () => {},
        () => {},
      );
    }

    public then(): void {}
  }
  const source = Promise.resolve(5);
  let reads = 0;
  void Object.defineProperty(source, 'constructor', {
    get: () => (++reads === 1 ? Promise : { [Symbol.species]: NeverSettles }),
  });
  const adopted = adoptPromise(source);
  expect(adopted).toBe(source);
  const outcome = await Promise.race([
    raceDeadline(adopted, undefined, () => -1),
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
  ]);
  expect(outcome).toEqual({ value: 5 });
});

test('a timer that cannot be armed rejects the race and leaves the input observed', async () => {
  const hook = spyOn(globalThis, 'setTimeout').mockImplementation((() => {
    throw new Error('timer refused');
  }) as unknown as typeof setTimeout);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  const pending = Promise.withResolvers<void>();
  try {
    const raced = raceDeadline(pending.promise, 1000, () => undefined);
    expect(
      await observePromise(
        raced,
        undefined,
        (error) => (error as Error).message,
      ),
    ).toBe('timer refused');
  } finally {
    hook.mockRestore();
  }
  try {
    pending.reject(new Error('late rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  expect(unhandled).toEqual([]);
});
