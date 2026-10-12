import { performance } from './unix-time-helpers';
import { expect, it, spyOn } from 'bun:test';
import { sleep } from './sleep';
import { MAX_TIMER_MS } from './internal/timer-limits';

it('should sleep', async () => {
  const time = performance();

  await sleep(1000); // 1 second worth of time

  const timeRan = performance() - time;

  expect(timeRan).toBeGreaterThanOrEqual(1000);
  expect(timeRan).toBeLessThanOrEqual(2000);
});

it('rejects invalid durations and caps Infinity', async () => {
  for (const value of [
    Number.NaN,
    null as unknown as number,
    '50' as unknown as number,
  ]) {
    const caughtError = await sleep(value).catch((error: unknown) => error);
    expect(caughtError).toBeInstanceOf(Error);
  }
  const originalSetTimeout = globalThis.setTimeout;
  let armedDelay: number | undefined;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    armedDelay = delay;
    return originalSetTimeout(callback, 0);
  }) as typeof setTimeout;
  try {
    await sleep(Infinity);
    expect(armedDelay).toBe(MAX_TIMER_MS);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

it('rejects an omitted duration without arming a timer', async () => {
  const timer = spyOn(globalThis, 'setTimeout');
  try {
    const error: unknown = await sleep(undefined as unknown as number).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain('Sleep duration');
    expect(timer).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
  }
});

it.each([0, -0, -1, -Infinity])(
  'schedules %s on the next timer turn',
  async (duration) => {
    const timer = spyOn(globalThis, 'setTimeout');
    let isFinished = false;
    const pending = sleep(duration);
    // Observe rejection too, so a failing regression does not leave a floating
    // rejection when its assertions fail before awaiting the sleep.
    const observed = pending.then(
      () => {
        isFinished = true;
      },
      () => {},
    );
    try {
      expect(timer).toHaveBeenCalledTimes(1);
      expect(timer.mock.calls[0]?.[1]).toBe(0);
      expect(isFinished).toBe(false);
      await Promise.resolve();
      expect(isFinished).toBe(false);
      await pending;
      expect(isFinished).toBe(true);
    } finally {
      timer.mockRestore();
      await observed;
    }
  },
);
