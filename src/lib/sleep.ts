import { assertDurationMS, clampTimerDelayMS } from './internal/timer-limits';
/**
 * Sleeps the function for the specified number of milliseconds
 * Zero and negative delays resume on the next timer turn, never synchronously, so a
 * computed deadline that has already passed resumes normally. NaN and every non-number,
 * numeric strings included, reject with a TypeError. Infinity and delays above
 * 2,147,483,647 ms wait that maximum.
 *
 *  ```typescript
 * await sleep(1000);
 * ```
 */

export async function sleep(time: number): Promise<void> {
  assertDurationMS(time, 'Sleep duration');
  const delayMS = clampTimerDelayMS(time);
  return await new Promise<void>(function (resolve) {
    setTimeout(function () {
      resolve();
    }, delayMS);
  });
}
