/** Preserve invocation semantics if application code later replaces Reflect.apply. */
export const applyIntrinsic: typeof Reflect.apply = Reflect.apply;

// The reflection the promise classification reads, captured for the same reason: a
// replaced Reflect method could misreport a value's prototype or `constructor` and send
// a native promise's own no-op `then` down the trusting path.
/** `Reflect.get` as it was at module initialization. */
export const getIntrinsic: typeof Reflect.get = Reflect.get;
/** `Reflect.getPrototypeOf` as it was at module initialization. */
export const getPrototypeOfIntrinsic: typeof Reflect.getPrototypeOf =
  Reflect.getPrototypeOf;
/** `Reflect.construct` as it was at module initialization. */
export const constructIntrinsic: typeof Reflect.construct = Reflect.construct;
/** `Object.prototype`, read before application code can rebind the `Object` global. */
export const objectPrototypeIntrinsic: object = Object.prototype;
/** `Symbol.species`, read before application code can rebind the `Symbol` global. */
export const speciesSymbolIntrinsic: typeof Symbol.species = Symbol.species;

// Captured so an `abort()` or `signal` that application code replaces on the prototype
// later cannot keep an owned controller from aborting, or hand out a different signal
// than the one it aborts.
const abortControllerIntrinsic = AbortController;
// eslint-disable-next-line @typescript-eslint/unbound-method
const abortMethodIntrinsic = AbortController.prototype.abort;
// eslint-disable-next-line @typescript-eslint/unbound-method
const abortControllerSignalGetterIntrinsic = Object.getOwnPropertyDescriptor(
  AbortController.prototype,
  'signal',
)?.get;

/** An `AbortController` whose signal and abort were read through captured intrinsics. */
export interface OwnedAbortController {
  readonly signal: AbortSignal;
  /**
   * Abort the signal with `reason`. Never throws for a listener's error: the runtime
   * reports those itself (as an uncaught exception), not to the caller of `abort()`.
   */
  readonly abort: (reason: unknown) => void;
}

/** Create a controller from the `AbortController` captured at module initialization. */
export function createOwnedAbortController(): OwnedAbortController {
  const controller = new abortControllerIntrinsic();
  const signal = (
    abortControllerSignalGetterIntrinsic === undefined
      ? controller.signal
      : applyIntrinsic(abortControllerSignalGetterIntrinsic, controller, [])
  ) as AbortSignal;
  // This literal syntax sets the prototype without consulting a mutable helper.
  const owned = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __proto__: null,
    signal,
    abort: (reason: unknown): void => {
      applyIntrinsic(abortMethodIntrinsic, controller, [reason]);
    },
  };
  return owned;
}

// `instanceof` consults the right-hand side's live `Symbol.hasInstance`, which
// application code can define on `Promise` after this module loads. The ordinary check
// it overrides - a walk of the prototype chain - is captured from `Function.prototype`.
const ordinaryHasInstanceIntrinsic = Function.prototype[Symbol.hasInstance];

/**
 * `value instanceof constructor` as the ordinary prototype-chain walk answers it, never
 * a `Symbol.hasInstance` defined on `constructor` later. Throws as `instanceof` does,
 * for a proxy whose `getPrototypeOf` trap throws.
 */
export function ordinaryInstanceOf(
  value: unknown,
  constructor: object,
): boolean {
  return applyIntrinsic(ordinaryHasInstanceIntrinsic, constructor, [value]);
}

// Async functions use the realm's intrinsic Promise even when application setup has
// replaced the global binding before this module loads. Capture that same constructor
// and prototype so our observers accept the native promises returned by async functions.
// This does not recover methods already modified on the native prototype before import.
const nativePromisePrototype = Object.getPrototypeOf(
  (async () => {})(),
) as Promise<unknown>;

/** Read native promise state without consulting a later prototype override. */
// eslint-disable-next-line @typescript-eslint/unbound-method
export const promiseThenIntrinsic = nativePromisePrototype.then;

/** Construct promises compatible with native async functions and our observers. */
export const promiseConstructorIntrinsic =
  nativePromisePrototype.constructor as PromiseConstructor;
// eslint-disable-next-line @typescript-eslint/unbound-method
const promiseResolveMethodIntrinsic = promiseConstructorIntrinsic.resolve;

/** Keep both Promise.resolve and its constructor receiver from module initialization. */
export function promiseResolveIntrinsic<T>(
  value: T | PromiseLike<T>,
): Promise<Awaited<T>> {
  return applyIntrinsic(
    promiseResolveMethodIntrinsic,
    promiseConstructorIntrinsic,
    [value],
  ) as Promise<Awaited<T>>;
}

/**
 * Attach a reaction to an already adopted native promise without reading live methods.
 * This protects observation, not assimilation of a promise returned by a callback.
 * Internal asynchronous continuations should await their owned promises instead of
 * returning them from these callbacks; their native resolution would read then again.
 *
 * Never throws. Adoption can hand back the caller's own native promise, and the
 * intrinsic `then` reads its `constructor`/species again - a getter that throws on that
 * read is observed as a rejection with its error, so `onrejected` still hears of it.
 */
export function observePromise<T, TResult1 = T, TResult2 = never>(
  promise: Promise<T>,
  onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
  onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
): Promise<TResult1 | TResult2> {
  const reactions = [onfulfilled, onrejected];
  try {
    return applyIntrinsic(promiseThenIntrinsic, promise, reactions) as Promise<
      TResult1 | TResult2
    >;
  } catch (error) {
    return applyIntrinsic(
      promiseThenIntrinsic,
      promiseRejectIntrinsic(error),
      reactions,
    ) as Promise<TResult1 | TResult2>;
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
 * Run `task` on a microtask through captured intrinsics, not the replaceable
 * `queueMicrotask` global. A throw from `task` goes to `onError`, or is contained
 * when none is given, so the derived promise never rejects unobserved.
 */
export function queueMicrotaskIntrinsic(
  task: () => void,
  onError: (error: unknown) => unknown = () => undefined,
): void {
  observeRejection(
    observePromise(promiseResolveIntrinsic(undefined), task),
    onError,
  );
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const promiseRejectMethodIntrinsic = promiseConstructorIntrinsic.reject;

/** Create a native rejection even after application code replaces Promise.reject. */
export function promiseRejectIntrinsic<T = never>(reason: unknown): Promise<T> {
  return applyIntrinsic(
    promiseRejectMethodIntrinsic,
    promiseConstructorIntrinsic,
    [reason],
  );
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

/** Our result container must not inherit an application-added then method. */
export function boxPromiseValue<T>(value: T): PromiseResultBox<T> {
  // This literal syntax sets the prototype without consulting a mutable helper.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const box = { __proto__: null, value };
  return box;
}

/**
 * Await a captured observation, not a caller-owned native promise directly. Adoption
 * may preserve that promise's identity; a changing constructor getter can make await
 * consult its live then on the next read. Intrinsic observation avoids that detour,
 * and boxing prevents resolution from reading the fulfilled value's then again.
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
  return new promiseConstructorIntrinsic<PromiseResultBox<Awaited<T[number]>>>(
    (resolve, reject) => {
      // Do not consult application-supplied array iterator hooks.
      // eslint-disable-next-line unicorn/no-for-loop
      for (let index = 0; index < promises.length; index++) {
        const promise = promises[index];
        void observePromise(
          promise,
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
  return new promiseConstructorIntrinsic<PromiseResultBox<Results>>(
    (resolve, reject) => {
      const values: unknown[] = new Array(promises.length);
      let remaining = promises.length;
      if (remaining === 0) {
        resolve(boxPromiseValue(values as Results));
        return;
      }
      // eslint-disable-next-line unicorn/no-for-loop
      for (let index = 0; index < promises.length; index++) {
        const promise = promises[index];
        void observePromise(
          promise,
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
    },
  );
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
  return new promiseConstructorIntrinsic<PromiseResultBox<Results>>(
    (resolve) => {
      const results: PromiseSettledResult<unknown>[] = new Array<
        PromiseSettledResult<unknown>
      >(promises.length);
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
        void observePromise(
          promises[index],
          (value) =>
            record(index, {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              __proto__: null,
              status: 'fulfilled',
              value,
            } as PromiseFulfilledResult<unknown>),
          (reason) =>
            record(index, {
              // eslint-disable-next-line @typescript-eslint/naming-convention
              __proto__: null,
              status: 'rejected',
              reason,
            } as PromiseRejectedResult),
        );
      }
    },
  );
}
