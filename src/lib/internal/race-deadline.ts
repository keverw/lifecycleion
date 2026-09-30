import {
  promiseConstructorIntrinsic,
  observePromise,
  awaitBoxedPromise,
  boxPromiseValue,
  type PromiseResultBox,
} from './intrinsics';

/**
 * Race an adopted handler against an already-normalized deadline. Undefined disables the
 * timer, but still boxes the outcome: forwarding a raw result through a new promise
 * would inspect its then property again. The caller unwraps only after awaiting.
 *
 * The timer belongs to this wait and is cleared on every exit. Losing work remains
 * observed by the native observer; deciding whether/how to report it remains the
 * caller's responsibility. Abort hooks and multi-phase shutdown ownership do not
 * belong here. A background wait can opt out of keeping the host alive; browser
 * numeric timer handles have no reference state, so that option is a no-op there.
 */
export async function raceDeadline<T, U>(
  pending: Promise<T>,
  delayMS: number | undefined,
  onTimeout: () => U,
  options?: { shouldUnref?: boolean },
): Promise<PromiseResultBox<T | U>> {
  if (delayMS === undefined) {
    return await awaitBoxedPromise(pending);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = new promiseConstructorIntrinsic<PromiseResultBox<T | U>>(
      (resolve, reject) => {
        timer = setTimeout(() => {
          try {
            resolve(boxPromiseValue(onTimeout()));
          } catch (error) {
            // Preserve the timeout callback's original failure.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            reject(error);
          }
        }, delayMS);
        if (options?.shouldUnref && typeof timer === 'object') {
          timer.unref?.();
        }
        // Do not construct a second promise that resolves with a raw timeout value:
        // its inherited then could stall before the result ever reached the race.
        void observePromise(
          pending,
          (value) => resolve(boxPromiseValue(value)),
          reject,
        );
      },
    );
    return await outcome;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
