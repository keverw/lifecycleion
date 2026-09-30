import { promiseConstructorIntrinsic } from './internal/intrinsics';
import { assertDurationMS, MAX_TIMER_MS } from './internal/timer-limits';
/**
 * Sleeps the function for the specified number of milliseconds
 * Zero and negative delays resume on the next timer turn, never synchronously.
 * This lets computed deadlines that have already passed resume normally; NaN and
 * non-number values still reject rather than being coerced into an immediate delay.
 *
 *  ```typescript
 * await sleep(1000);
 * ```
 */

export async function sleep(time: number): Promise<void> {
  assertDurationMS(time, 'Sleep duration');
  const delayMS = Math.max(0, Math.min(time, MAX_TIMER_MS));
  return await new promiseConstructorIntrinsic<void>(function (resolve) {
    setTimeout(function () {
      resolve();
    }, delayMS);
  });
}
