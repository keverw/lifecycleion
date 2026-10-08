import { isObjectLike } from './is-object-like';
import { reportToConsole } from './report-to-console';

// An own species for the throwaway derived promise `containDerivedRejection` attaches to,
// so its `then` builds a plain `Promise` rather than one the caller's class chose.
const safePromiseSpeciesConstructor = Object.freeze({
  get [Symbol.species](): PromiseConstructor {
    return Promise;
  },
});

/**
 * Attach a reaction to an already adopted native promise through the native
 * `Promise.prototype.then`, never the promise's own `then`.
 * This protects observation, not assimilation of a promise returned by a callback.
 * Internal asynchronous continuations should await their owned promises instead of
 * returning them from these callbacks; their native resolution would read then again.
 *
 * Settles a promise of our own, as `then` would settle its derived promise: with a
 * reaction's result, its throw, or - for a reaction left out - the input's own outcome.
 * Adoption can hand back the caller's own native promise, and the native `then` builds
 * its derived promise from that promise's live `constructor`/species: a getter that
 * changes between reads could have it built by a class whose `then` never settles, and
 * a caller awaiting it would wait forever. The reactions are attached to the input
 * itself whatever that class is, so they settle the promise returned here instead. The
 * derived value is observed only to contain an independent rejection: a caller's species
 * can return an already-rejected promise even when both reactions succeed.
 *
 * Never throws. A `constructor` getter that throws on this read, or a species that
 * cannot build a promise, keeps the native `then` from attaching to the input at all: the
 * reactions observe a rejection with that error instead, so the caller hears that
 * observation failed, but the input's own outcome is never seen - a rejection of it is
 * left to the host's unhandled-rejection reporting, the broken-`constructor` limit
 * `adoptPromise` documents.
 */
export function observePromise<T, TResult1 = T, TResult2 = never>(
  promise: Promise<T>,
  onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
  onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
): Promise<TResult1 | TResult2> {
  return new Promise<TResult1 | TResult2>((resolve, reject) => {
    // Neither reaction throws, so a derived promise the native `then` builds natively
    // fulfills with undefined rather than rejecting unobserved.
    attachReactions(
      promise,
      (value) => {
        if (typeof onfulfilled !== 'function') {
          resolve(value as unknown as TResult1);
          return;
        }
        try {
          resolve(onfulfilled(value));
        } catch (error) {
          // Preserve the reaction's original failure, as a derived promise would.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        }
      },
      (reason) => {
        if (typeof onrejected !== 'function') {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(reason);
          return;
        }
        try {
          resolve(onrejected(reason));
        } catch (error) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        }
      },
    );
  });
}

/**
 * The attachment beneath {@link observePromise}, for a caller whose reactions settle a
 * promise it owns and never throw. The native `then`'s derived promise is not used to
 * settle the caller, but its rejection is contained. A `then` that refuses the input - a
 * throwing `constructor` getter, an unusable species - hands the reactions a rejection
 * with its error instead, on a later microtask as a reaction would run.
 */
function attachReactions<T>(
  promise: Promise<T>,
  onfulfilled: (value: T) => void,
  onrejected: (reason: unknown) => void,
): void {
  try {
    attachIntrinsicReactions(promise, onfulfilled, onrejected);
  } catch (error) {
    queueMicrotask(() => {
      onrejected(error);
    });
  }
}

/**
 * Attach non-throwing terminal reactions through the native `Promise.prototype.then`,
 * read live and applied to `promise`, so an own `then` on the promise is bypassed. Its
 * unused species result is contained. Unlike {@link observePromise}, an attachment
 * failure throws synchronously so callers can distinguish it from the input's rejection.
 */
export function attachIntrinsicReactions<T>(
  promise: object,
  onfulfilled: (value: T) => void,
  onrejected: (reason: unknown) => void,
): void {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const derived: unknown = Reflect.apply(Promise.prototype.then, promise, [
    onfulfilled,
    onrejected,
  ]);
  if (derived !== promise) {
    containDerivedRejection(derived);
  }
}

/**
 * A species may return a rejected promise unrelated to either reaction's result. For a
 * native promise, temporarily shadow its constructor while attaching a terminal reaction:
 * otherwise its own species can create another rejected promise at every observation.
 * This value is the throwaway return of the native `then`, not the input promise. It is
 * restored synchronously before application code can receive another event. A species
 * that returns the input itself needs no second observer: its rejection is already wired
 * to `onrejected` above.
 *
 * A value that refuses the temporary definition, or is not a native promise, is followed
 * as a thenable. That path contains ordinary rejected species promises and throwing then
 * methods, but a frozen native promise with a recursively rejecting species cannot be
 * contained without modifying it or a lower-level promise reaction primitive.
 */
function containDerivedRejection(derived: unknown): void {
  if (!isObjectLike(derived)) {
    return;
  }

  let previous: PropertyDescriptor | undefined;
  let didShadow = false;
  try {
    previous = Object.getOwnPropertyDescriptor(derived, 'constructor');
    if (previous === undefined || previous.configurable || previous.writable) {
      didShadow = Reflect.defineProperty(derived, 'constructor', {
        value: safePromiseSpeciesConstructor,
        configurable: previous?.configurable ?? true,
        enumerable: previous?.enumerable ?? false,
        writable: previous?.writable ?? true,
      });
    }
  } catch {
    // The species result may be a frozen object or a Proxy that refuses definitions.
  }

  if (didShadow) {
    try {
      // Both reactions return undefined, so this newly derived, native Promise cannot
      // reject through either callback or re-adopt the original fulfilled value.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      void Reflect.apply(Promise.prototype.then, derived, [noop, noop]);
      return;
    } catch {
      // A non-native species value has no Promise internal slot. Try its then below.
    } finally {
      try {
        if (previous === undefined) {
          Reflect.deleteProperty(derived, 'constructor');
        } else {
          Reflect.defineProperty(derived, 'constructor', previous);
        }
      } catch {
        // A hostile Proxy can refuse restoration; reporting cannot repair it.
      }
    }
  }

  void containDerivedThenable(derived);
}

/** A reaction that ignores what it is given, for observers that only contain. */
export function noop(): void {}

async function containDerivedThenable(derived: unknown): Promise<void> {
  try {
    await derived;
  } catch {
    // Its rejection is separate from the operation's outcome.
  }
}

/**
 * Observe only rejection of an owned native promise. Fulfillment is deliberately
 * discarded: the implicit identity handler would resolve a derived promise with the
 * value and read its then property again. Neither that value nor the reporter's own
 * result is an output of this floating operation. A terminal observer contains a
 * reporter that throws or rejects without forwarding its fulfillment either.
 */
export function observeRejection(
  promise: Promise<unknown>,
  onRejected: (error: unknown) => unknown,
): void {
  const reported = observePromise(promise, () => undefined, onRejected);
  void observePromise(
    reported,
    () => undefined,
    () => undefined,
  );
}

/**
 * Run `task` on a microtask. A throw from `task` goes to `onError` on that same
 * microtask, or is reported to the console when none is given; a throw or rejection from
 * `onError` is contained too, so nothing here throws uncaught or rejects unobserved.
 */
export function queueMicrotaskSafely(
  task: () => void,
  onError: (error: unknown) => unknown = reportToConsole,
): void {
  queueMicrotask(() => {
    try {
      task();
    } catch (error) {
      reportQueuedTaskError(onError, error);
    }
  });
}

function reportQueuedTaskError(
  onError: (error: unknown) => unknown,
  error: unknown,
): void {
  let reported: unknown;
  try {
    reported = onError(error);
  } catch {
    return;
  }
  // Only a returned object can be a promise that later rejects. Adopted rather than
  // observed directly, since it is the reporter's value; a `then` that throws is
  // contained by the same terminal observer.
  if (isObjectLike(reported)) {
    observeRejection(
      observePromise(Promise.resolve(undefined), () => reported),
      () => undefined,
    );
  }
}

/**
 * A winning value stays boxed until its caller has awaited the race. Resolving the
 * outer promise with the raw value would read then again: a getter that changes after
 * the input fulfilled could start a never-settling adoption and consume the deadline.
 * Callers must unwrap synchronously, not return the raw value from another observer.
 */
export interface PromiseResultBox<T> {
  value: T;
}

/** Wrap a settled value so resolving a promise with it does not adopt the value. */
export function boxPromiseValue<T>(value: T): PromiseResultBox<T> {
  return { value };
}

/**
 * Await an observation, not a caller-owned native promise directly. Adoption may
 * preserve that promise's identity; a changing constructor getter can make await
 * consult its live then on the next read. Observation through the native `then` avoids
 * that detour and settles a promise of our own, and boxing prevents resolution from
 * reading the fulfilled value's then again.
 * Callers unwrap only after awaiting; ignored results can leave the box unopened.
 */
export function awaitBoxedPromise<T>(
  promise: Promise<T>,
): Promise<PromiseResultBox<T>> {
  return observePromise(promise, boxPromiseValue);
}

/**
 * Map settled values without asking native resolution to adopt the mapped value.
 * Mappers are synchronous: their output is data inside the box, even if that data
 * has a then property. A mapper that throws still rejects the returned promise,
 * which the caller must await or observe. Unwrap only after the boxed wait finishes.
 */
export function observeBoxed<T, U, V = never>(
  promise: Promise<T>,
  onFulfilled: (value: T) => U,
  onRejected?: (error: unknown) => V,
): Promise<PromiseResultBox<U | V>> {
  return observePromise(
    promise,
    (value) => boxPromiseValue(onFulfilled(value)),
    onRejected === undefined
      ? undefined
      : (error: unknown) => boxPromiseValue(onRejected(error)),
  );
}

/** Race owned/adopted native promises without re-adopting their fulfilled values. */
export function racePromises<T extends readonly Promise<unknown>[]>(
  promises: T,
): Promise<PromiseResultBox<Awaited<T[number]>>> {
  return new Promise<PromiseResultBox<Awaited<T[number]>>>(
    (resolve, reject) => {
      // Indexed, so an own iterator on the input array is never consulted.
      // eslint-disable-next-line unicorn/no-for-loop
      for (let index = 0; index < promises.length; index++) {
        attachReactions(
          promises[index],
          (value) => resolve(boxPromiseValue(value as Awaited<T[number]>)),
          reject,
        );
      }
    },
  );
}

/** Join owned/adopted native promises, preserving input order and observing losers. */
export function allPromises<T extends readonly Promise<unknown>[]>(
  promises: T,
): Promise<PromiseResultBox<{ -readonly [P in keyof T]: Awaited<T[P]> }>> {
  type Results = { -readonly [P in keyof T]: Awaited<T[P]> };
  return new Promise<PromiseResultBox<Results>>((resolve, reject) => {
    const values: unknown[] = [];
    values.length = promises.length;
    let remaining = promises.length;
    if (remaining === 0) {
      resolve(boxPromiseValue(values as Results));
      return;
    }
    // eslint-disable-next-line unicorn/no-for-loop
    for (let index = 0; index < promises.length; index++) {
      attachReactions(
        promises[index],
        (value) => {
          values[index] = value;
          remaining--;
          if (remaining === 0) {
            resolve(boxPromiseValue(values as Results));
          }
        },
        reject,
      );
    }
  });
}

/** Wait for every owned promise, retaining both fulfilled and rejected outcomes. */
export function allSettledPromises<T extends readonly Promise<unknown>[]>(
  promises: T,
): Promise<
  PromiseResultBox<{
    -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>>;
  }>
> {
  type Results = {
    -readonly [P in keyof T]: PromiseSettledResult<Awaited<T[P]>>;
  };
  return new Promise<PromiseResultBox<Results>>((resolve) => {
    const results: PromiseSettledResult<unknown>[] = [];
    results.length = promises.length;
    let remaining = promises.length;
    if (remaining === 0) {
      resolve(boxPromiseValue(results as Results));
      return;
    }
    const record = (
      index: number,
      outcome: PromiseSettledResult<unknown>,
    ): void => {
      results[index] = outcome;
      remaining--;
      if (remaining === 0) {
        resolve(boxPromiseValue(results as Results));
      }
    };
    // eslint-disable-next-line unicorn/no-for-loop
    for (let index = 0; index < promises.length; index++) {
      attachReactions(
        promises[index],
        (value) => record(index, { status: 'fulfilled', value }),
        (reason) => record(index, { status: 'rejected', reason }),
      );
    }
  });
}
