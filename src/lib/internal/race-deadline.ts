/**
 * Race an owned promise - one adoption returned, or the library's own - against an
 * already-normalized deadline. Undefined disables the timer. The race settles a promise
 * with the winning value, which reads its `then`: a caller's value must arrive boxed, as
 * adoption delivers it, never raw.
 *
 * The timer belongs to this wait and is cleared on every exit. Losing work remains
 * observed by the race's reaction; deciding whether/how to report it remains the
 * caller's responsibility. Abort hooks and multi-phase shutdown ownership do not
 * belong here. A background wait can opt out of keeping the host alive; browser
 * numeric timer handles have no reference state, so that option is a no-op there.
 */
export async function raceDeadline<T, U>(
  pending: Promise<T>,
  delayMS: number | undefined,
  onTimeout: () => U,
  options?: { shouldUnref?: boolean },
): Promise<T | U> {
  if (delayMS === undefined) {
    return await pending;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T | U>((resolve, reject) => {
      // Observed before the timer is armed: if arming throws, this executor rejects
      // the race, and `pending`'s own later rejection must already have a reaction.
      pending.then(resolve, reject);
      timer = setTimeout(() => {
        try {
          resolve(onTimeout());
        } catch (error) {
          // Preserve the timeout callback's original failure.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        }
      }, delayMS);
      if (options?.shouldUnref && typeof timer === 'object') {
        timer.unref?.();
      }
    });
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
