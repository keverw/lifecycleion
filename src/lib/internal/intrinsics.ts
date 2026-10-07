import { defineEntry } from './define-entry';
import { isObjectLike } from './is-object-like';
import { reportToConsole } from './report-to-console';

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
/** `Object.prototype`, read before application code can rebind the `Object` global. */
export const objectPrototypeIntrinsic: object = Object.prototype;
/** `Symbol.species`, read before application code can rebind the `Symbol` global. */
export const speciesSymbolIntrinsic: typeof Symbol.species = Symbol.species;
/**
 * `Reflect.defineProperty` as it was at module initialization: a definition that must
 * land on the object it names, however application code later replaces the global.
 */
export const definePropertyIntrinsic: typeof Reflect.defineProperty =
  Reflect.defineProperty;
const deletePropertyIntrinsic: typeof Reflect.deleteProperty =
  Reflect.deleteProperty;
const getOwnPropertyDescriptorIntrinsic: typeof Object.getOwnPropertyDescriptor =
  Object.getOwnPropertyDescriptor;
/**
 * `Object.prototype.hasOwnProperty` as it was at module initialization, so a later patch
 * cannot misreport which properties a value carries itself.
 */
// eslint-disable-next-line @typescript-eslint/unbound-method
export const hasOwnPropertyIntrinsic = Object.prototype.hasOwnProperty;
/** `TypeError.prototype`, read before application code can rebind the `TypeError` global. */
export const typeErrorPrototypeIntrinsic: object = TypeError.prototype;
/** `RangeError.prototype`, read before application code can rebind the `RangeError` global. */
export const rangeErrorPrototypeIntrinsic: object = RangeError.prototype;

// Captured so an `abort()` or `signal` that application code replaces on the prototype
// later cannot keep an owned controller from aborting, or hand out a different signal
// than the one it aborts. A runtime without `AbortController` captures nothing, so
// importing this module still works there; only creating an owned controller fails.
const abortControllerIntrinsic: typeof AbortController | undefined =
  typeof AbortController === 'function' ? AbortController : undefined;
// eslint-disable-next-line @typescript-eslint/unbound-method
const abortMethodIntrinsic = abortControllerIntrinsic?.prototype.abort;
const abortControllerSignalGetterIntrinsic =
  abortControllerIntrinsic === undefined
    ? undefined
    : // eslint-disable-next-line @typescript-eslint/unbound-method
      Object.getOwnPropertyDescriptor(
        abortControllerIntrinsic.prototype,
        'signal',
      )?.get;

/** An `AbortController` whose signal and abort were read through captured intrinsics. */
export interface OwnedAbortController {
  readonly signal: AbortSignal;
  /**
   * Abort the signal with `reason`. Never throws for a listener's error: the runtime
   * reports those itself (as an uncaught exception), not to the caller of `abort()`.
   * `guardAbortListeners()` turns them into reports for a signal it was given.
   */
  readonly abort: (reason: unknown) => void;
}

/**
 * Create a controller from the `AbortController` captured at module initialization.
 * Throws a `TypeError` in a runtime that had no `AbortController` then.
 */
export function createOwnedAbortController(): OwnedAbortController {
  if (
    abortControllerIntrinsic === undefined ||
    abortMethodIntrinsic === undefined
  ) {
    throw new TypeError(
      'AbortController is not available in this runtime; lifecycleion needs it to create an abort signal',
    );
  }
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
// An own constructor for a throwaway species promise. Naming Promise itself would still
// consult its live Symbol.species getter, which application code can replace after load.
const safePromiseSpeciesConstructor = Object.freeze({
  // eslint-disable-next-line @typescript-eslint/naming-convention
  __proto__: null,
  [speciesSymbolIntrinsic]: promiseConstructorIntrinsic,
});
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
 * Settles a promise of our own, as `then` would settle its derived promise: with a
 * reaction's result, its throw, or - for a reaction left out - the input's own outcome.
 * Adoption can hand back the caller's own native promise, and the intrinsic `then` builds
 * its derived promise from that promise's live `constructor`/species: a getter that
 * changes between reads could have it built by a class whose `then` never settles, and
 * a caller awaiting it would wait forever. The reactions are attached to the input
 * itself whatever that class is, so they settle the promise returned here instead. The
 * derived value is observed only to contain an independent rejection: a caller's species
 * can return an already-rejected promise even when both reactions succeed.
 *
 * Never throws. A `constructor` getter that throws on this read, or a species that
 * cannot build a promise, keeps the intrinsic from attaching to the input at all: the
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
  return new promiseConstructorIntrinsic<TResult1 | TResult2>(
    (resolve, reject) => {
      // Neither reaction throws, so a derived promise the intrinsic builds natively
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
    },
  );
}

/**
 * The attachment beneath {@link observePromise}, for a caller whose reactions settle a
 * promise it owns and never throw. The intrinsic's derived promise is not used to settle
 * the caller, but its rejection is contained. A `then` that refuses
 * the input - a throwing `constructor` getter, an unusable species - hands the reactions
 * a rejection with its error instead, on a later microtask as a reaction would run.
 */
function attachReactions<T>(
  promise: Promise<T>,
  onfulfilled: (value: T) => void,
  onrejected: (reason: unknown) => void,
): void {
  try {
    attachIntrinsicReactions(promise, onfulfilled, onrejected);
  } catch (error) {
    void runOnMicrotask(() => {
      onrejected(error);
    });
  }
}

/**
 * Attach non-throwing terminal reactions through the captured native `then`, containing
 * its unused species result. Unlike {@link observePromise}, an attachment failure
 * throws synchronously so callers can distinguish it from the input's rejection.
 */
export function attachIntrinsicReactions<T>(
  promise: object,
  onfulfilled: (value: T) => void,
  onrejected: (reason: unknown) => void,
): void {
  const derived: unknown = applyIntrinsic(promiseThenIntrinsic, promise, [
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
 * This value is the throwaway return of our intrinsic `then`, not the input promise. It is
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
    previous = getOwnPropertyDescriptorIntrinsic(derived, 'constructor');
    if (previous === undefined || previous.configurable || previous.writable) {
      didShadow = definePropertyIntrinsic(derived, 'constructor', {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        __proto__: null,
        value: safePromiseSpeciesConstructor,
        configurable: previous?.configurable ?? true,
        enumerable: previous?.enumerable ?? false,
        writable: previous?.writable ?? true,
      } as PropertyDescriptor);
    }
  } catch {
    // The species result may be a frozen object or a Proxy that refuses definitions.
  }

  if (didShadow) {
    try {
      // Both reactions return undefined, so this newly derived, intrinsic Promise cannot
      // reject through either callback or re-adopt the original fulfilled value.
      void applyIntrinsic(promiseThenIntrinsic, derived, [noop, noop]);
      return;
    } catch {
      // A non-native species value has no Promise internal slot. Try its then below.
    } finally {
      try {
        if (previous === undefined) {
          deletePropertyIntrinsic(derived, 'constructor');
        } else {
          definePropertyIntrinsic(derived, 'constructor', previous);
        }
      } catch {
        // A hostile Proxy can refuse restoration; reporting cannot repair it.
      }
    }
  }

  void containDerivedThenable(derived);
}

function noop(): void {}

async function containDerivedThenable(derived: unknown): Promise<void> {
  try {
    await derived;
  } catch {
    // Its rejection is separate from the operation's outcome.
  }
}

/**
 * Run `task` on the next microtask through `await` itself. Awaiting a non-promise builds
 * an intrinsic promise and attaches to it without reading `constructor`, `then` or a
 * species, so this works even when application code has broken every one of those for
 * the realm - a throwing `Promise[Symbol.species]` getter or
 * `Promise.prototype.constructor` - which also breaks the intrinsic `then`. The returned
 * promise rejects with whatever `task` throws.
 */
async function runOnMicrotask(task: () => void): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/await-thenable
  await undefined;
  task();
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
 * Run `task` on a microtask through `await`, not the replaceable `queueMicrotask`
 * global, so it runs even if application code breaks promise species realm-wide. A
 * throw from `task` goes to `onError` on that same microtask, or is reported to the console when none
 * is given; a throw or rejection from `onError` is contained too, so nothing here
 * rejects unobserved.
 */
export function queueMicrotaskIntrinsic(
  task: () => void,
  onError: (error: unknown) => unknown = reportToConsole,
): void {
  void runOnMicrotask(() => {
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
      observePromise(promiseResolveIntrinsic(undefined), () => reported),
      () => undefined,
    );
  }
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
 * consult its live then on the next read. Intrinsic observation avoids that detour and
 * settles a promise of our own, and boxing prevents resolution from reading the
 * fulfilled value's then again.
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
  return new promiseConstructorIntrinsic<PromiseResultBox<Results>>(
    (resolve, reject) => {
      // A literal, not `new Array()`: the `Array` global is application code's to replace.
      const values: unknown[] = [];
      values.length = promises.length;
      const valueEntries = values as unknown as Record<string, unknown>;
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
            // Defined, not assigned: `values` starts holey, so an assignment would
            // reach an index setter an application added to `Array.prototype`.
            defineEntry(valueEntries, index, value);
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
      const results: PromiseSettledResult<unknown>[] = [];
      results.length = promises.length;
      const resultEntries = results as unknown as Record<
        string,
        PromiseSettledResult<unknown>
      >;
      let remaining = promises.length;
      if (remaining === 0) {
        resolve(boxPromiseValue(results as Results));
        return;
      }
      const record = (
        index: number,
        outcome: PromiseSettledResult<unknown>,
      ): void => {
        // Defined, not assigned, for the same reason as in `allPromises`.
        defineEntry(resultEntries, index, outcome);
        remaining--;
        if (remaining === 0) {
          resolve(boxPromiseValue(results as Results));
        }
      };
      // eslint-disable-next-line unicorn/no-for-loop
      for (let index = 0; index < promises.length; index++) {
        attachReactions(
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

// eslint-disable-next-line @typescript-eslint/unbound-method
const setForEachIntrinsic = Set.prototype.forEach;

/** Snapshot a set without consulting an application-replaced iterator. */
export function snapshotSet<T>(values: Set<T>): T[] {
  const snapshot: T[] = [];
  applyIntrinsic(setForEachIntrinsic, values, [
    (value: T): void => {
      defineEntry(
        snapshot as unknown as Record<string, T>,
        snapshot.length,
        value,
      );
    },
  ]);
  return snapshot;
}
