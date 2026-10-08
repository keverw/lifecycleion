import {
  promiseConstructorIntrinsic,
  observePromise,
  awaitBoxedPromise,
  boxPromiseValue,
  pinPromiseConstructor,
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
export function raceDeadline<T, U>(
  pending: Promise<T>,
  delayMS: number | undefined,
  onTimeout: () => U,
  options?: { shouldUnref?: boolean },
): Promise<PromiseResultBox<T | U>> {
  // Not an async function: its result promise would read the live `constructor` when
  // the caller awaits it. A pinned promise of our own keeps that await from throwing
  // before it reacts, which would leave this race's rejection unhandled.
  if (delayMS === undefined) {
    return pinPromiseConstructor(awaitBoxedPromise(pending));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const clearDeadline = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  };
  const outcome = new promiseConstructorIntrinsic<PromiseResultBox<T | U>>(
    (resolve, reject) => {
      // Observed before the timer is armed: if arming throws, this executor rejects
      // the race, and `pending`'s own later rejection must already have a reaction.
      // Do not construct a second promise that resolves with a raw timeout value:
      // its inherited then could stall before the result ever reached the race.
      void observePromise(
        pending,
        (value) => resolve(boxPromiseValue(value)),
        reject,
      );
      // The live timer globals, deliberately, unlike the captured promise intrinsics:
      // a deadline is scheduling, not observation, and tests that substitute
      // `setTimeout`/`clearTimeout` to drive a deadline must reach this one too.
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
    },
  );
  // `await` on a pinned native promise reads neither the live `constructor` nor the
  // species, so it always reacts to `outcome`; the intrinsic `then` would still read
  // `Promise[Symbol.species]`, and a throwing one left `outcome` unobserved. The timer is
  // cleared on every settlement.
  const settle = async (): Promise<PromiseResultBox<T | U>> => {
    try {
      return await pinPromiseConstructor(outcome);
    } finally {
      clearDeadline();
    }
  };
  return pinPromiseConstructor(settle());
}
