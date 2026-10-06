import {
  promiseConstructorIntrinsic,
  applyIntrinsic,
  definePropertyIntrinsic,
  getIntrinsic,
  getPrototypeOfIntrinsic,
  hasOwnPropertyIntrinsic,
  objectPrototypeIntrinsic,
  rangeErrorPrototypeIntrinsic,
  typeErrorPrototypeIntrinsic,
  ordinaryInstanceOf,
  speciesSymbolIntrinsic,
  queueMicrotaskIntrinsic,
  promiseResolveIntrinsic,
  promiseRejectIntrinsic,
  promiseThenIntrinsic,
} from './intrinsics';
import { isObjectLike } from './is-object-like';
import { describeError } from '../to-error';
import { reportToConsole } from './report-to-console';

/**
 * Whether `value` has `Promise.prototype` on its prototype chain - the shape of a native
 * promise from this realm, or a subclass's. The ordinary `instanceof` walk reads no
 * property of `value`; a proxy's `getPrototypeOf` trap that throws answers `false`. It
 * is the captured walk, not `instanceof` itself, so a `Symbol.hasInstance` defined on
 * `Promise` later cannot claim a plain thenable is a promise and have it refused.
 */
function inheritsFromPromise(value: unknown): boolean {
  try {
    return ordinaryInstanceOf(value, promiseConstructorIntrinsic);
  } catch {
    return false;
  }
}

/**
 * Whether `value` carries `then` as an own property - the shape of a native promise
 * someone attached a replacement `then` to. A class's `then` lives on its prototype and
 * is not own; a plain thenable's usually is. A proxy's trap that throws answers `true`,
 * so the value is read through the intrinsic rather than trusted.
 */
function hasOwnThen(value: object): boolean {
  try {
    return applyIntrinsic(hasOwnPropertyIntrinsic, value, ['then']);
  } catch {
    return true;
  }
}

/**
 * Whether `value` is a plain object of this realm - `Object.prototype` directly above it -
 * which no native promise is unless someone rebuilt one's prototype chain. Such a value is
 * spared trying the intrinsic `then` on it, which can only throw - and capture a stack - to
 * be caught. A native promise from another realm has that realm's `Promise.prototype`, not
 * this `Object.prototype`, so it still reaches the intrinsic. A `getPrototypeOf` trap
 * that throws answers `false`, so the intrinsic is tried.
 */
function hasObjectPrototype(value: object): boolean {
  try {
    return getPrototypeOfIntrinsic(value) === objectPrototypeIntrinsic;
  } catch {
    return false;
  }
}

/** Whether `error` is this realm's `TypeError`, as a failed internal-slot check throws. */
function isThisRealmTypeError(error: unknown): boolean {
  try {
    return (
      isObjectLike(error) &&
      getPrototypeOfIntrinsic(error) === typeErrorPrototypeIntrinsic
    );
  } catch {
    return false;
  }
}

/**
 * Whether `error` is what the intrinsic `then`'s internal-slot check can throw for a value
 * that is not a native promise: this realm's `TypeError`, or - with the stack nearly
 * exhausted, where even that check cannot run - this realm's `RangeError`. Anything else
 * comes from past the check, so from a native promise of some realm.
 */
function isSlotCheckFailure(error: unknown): boolean {
  if (isThisRealmTypeError(error)) {
    return true;
  }
  try {
    return (
      isObjectLike(error) &&
      getPrototypeOfIntrinsic(error) === rangeErrorPrototypeIntrinsic
    );
  } catch {
    return false;
  }
}

// A `constructor` value whose species builds, then misuses the executor it is handed.
function speciesThat(build: (executor: (...args: unknown[]) => void) => void) {
  return {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    __proto__: null,
    [speciesSymbolIntrinsic]: class {
      constructor(executor: (...args: unknown[]) => void) {
        build(executor);
      }
    },
  };
}

/**
 * The refusals the intrinsic `then` raises on its species path, in this engine's own
 * wording: a `constructor` that is not an object, a species that is not a constructor, and
 * a species that hands its executor no callable resolve or reject function, or calls it
 * twice. Recorded once, from probe promises this module owns, so no engine's wording is
 * written down here.
 */
function recordSpeciesRefusals(): readonly string[] {
  const noop = (): void => {};
  const constructors: unknown[] = [
    0,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    { __proto__: null, [speciesSymbolIntrinsic]: 0 },
    speciesThat(noop),
    speciesThat((executor) => executor(noop, 0)),
    speciesThat((executor) => {
      executor(noop, noop);
      executor(noop, noop);
    }),
    // Some engines word a second call by the first function already set: here, reject.
    speciesThat((executor) => {
      executor(undefined, noop);
      executor(noop, noop);
    }),
  ];
  const messages: string[] = [];
  // eslint-disable-next-line unicorn/no-for-loop
  for (let index = 0; index < constructors.length; index++) {
    const probe = promiseResolveIntrinsic(undefined);
    definePropertyIntrinsic(probe, 'constructor', {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __proto__: null,
      value: constructors[index],
    } as PropertyDescriptor);
    try {
      void applyIntrinsic(promiseThenIntrinsic, probe, []);
    } catch (error) {
      if (isThisRealmTypeError(error)) {
        messages[messages.length] = (error as TypeError).message;
      }
    }
  }
  return messages;
}

const speciesRefusalMessages = recordSpeciesRefusals();

/**
 * Whether the intrinsic `then` threw `error` from its species path - the brand check a
 * value that failed the intrinsic cannot fake. The internal-slot check refuses a
 * non-promise first, with a refusal of its own wording, before `constructor` is read; only
 * a native promise of some realm gets as far as these. Nothing the value inherits or
 * carries - a `Symbol.toStringTag`, a prototype - reaches the engine's message, so a
 * re-prototyped promise is caught and a thenable dressed as a promise is not.
 *
 * Known limit: a species path that throws this realm's `TypeError` in words of its own - a
 * `constructor` or species getter, a species constructor - is not recognized, and such a
 * value is taken for the thenable its own `then` claims it is. So is a refusal an engine
 * words with the offending value in it, for a value other than the probe's, and every
 * refusal if the probes record nothing: the failure mode is the own-`then` fallback,
 * never a thenable refused.
 */
function isSpeciesRefusal(error: unknown): boolean {
  if (!isThisRealmTypeError(error)) {
    return false;
  }
  let message: unknown;
  try {
    message = getIntrinsic(error as object, 'message', error);
  } catch {
    return false;
  }
  // eslint-disable-next-line unicorn/no-for-loop
  for (let index = 0; index < speciesRefusalMessages.length; index++) {
    if (speciesRefusalMessages[index] === message) {
      return true;
    }
  }
  return false;
}

/**
 * Adopt a value from untrusted code - a component hook's return, a callback's result - as
 * a native promise that settles as it does, safe for captured observation. A native
 * input need not be wrapped again: that would re-adopt its fulfilled value. Adoption
 * does not promise a fresh identity. Consumers that await rather than attach an
 * intrinsic observer use awaitBoxedPromise and unwrap afterward, so a changing input
 * constructor cannot redirect await through a live then. Constructor/species failures
 * during the intrinsic observation remain subject to the native limits below.
 *
 * It follows the value as `await` would, with one exception: a `then` attached to the
 * value itself, as an own property, is not trusted. `await` ignores one on a plain native
 * promise, but not on a native promise carrying its own `constructor` as well - it wraps
 * that and calls the own `then` - and `Promise.resolve()` hands a native promise back with
 * its own properties, so `.then()`, `.catch()` and `Promise.race()` on the result call it.
 * A no-op one never settled for the caller, and the real rejection went unhandled - fatal
 * under Node's default `--unhandled-rejections=throw`. A value with an own `then` is
 * therefore read through the intrinsic `Promise.prototype.then`, which only a native
 * promise's internal state answers.
 *
 * Everything else is followed the standard way, as `await` follows it. A `then` a
 * `Promise` subclass defines on its prototype is its behaviour - a lazy promise that
 * starts its work there, say - and skipping it skipped the work and reported success. A
 * proxy around a promise has no internal slot for the intrinsic to read, but it can
 * have a `then` that works - one its `get` trap binds to the promise - and succeeds or
 * fails as `await` would when that `then` is inherited. A proxy on this realm's
 * `Promise.prototype` chain that exposes `then` as an own property is rejected after
 * the intrinsic fails: it cannot be distinguished portably from the promise-prototype
 * fake or a native promise with broken constructor/species handling described below
 * without trusting the own `then` and risking a hang. A plain thenable
 * is adopted through its `then`; one that never calls back never settles, which no caller
 * can do anything about. A `then` - or a `constructor` getter - that throws rejects the
 * result rather than throwing.
 *
 * Something on the `Promise.prototype` chain with an own `then` that the intrinsic
 * refuses is rejected, never followed through that `then`: a local own-then proxy around
 * a promise, a native promise whose `constructor` misbehaves - a getter that throws, a
 * value that is not a constructor, a species that throws or never builds a promise -
 * and an `Object.create(Promise.prototype)` fake. Standard reflection cannot reliably
 * tell an own-then proxy from the fake; a fallback would have to call the untrusted
 * `then` that may never settle.
 *
 * Known limit, the other way: a `then` attached to a single native promise as an own
 * property is never called, even one that does real work when first chained - starts
 * something lazily, or instruments the call - which `await` would call. The promise's
 * own state is what is read. An own `then` on one promise is the shape the hostile
 * no-op takes, and calling it as well would bring back the hang this exists to prevent.
 *
 * Known limit: a `then` that comes from the value's prototype chain is trusted, so a
 * native promise whose chain supplies a no-op one - a subclass that overrides `then`
 * with one, or a promise given such a prototype - never settles, and its rejection goes
 * unhandled, exactly as `await` would leave it. Telling that apart from a lazy promise
 * that starts its work in `then` would mean second-guessing the class, which is the
 * value's own behaviour to define.
 *
 * Known limit: a native promise whose prototype was replaced with `Object.prototype`, and
 * which carries its own `then`, is taken for the plain thenable it looks like and adopted
 * as `await` would adopt one: through that `then`.
 *
 * Known limit: protecting a native promise's own then requires forwarding its state
 * into a native promise we own (including for foreign realms). Native resolution of
 * that forwarding promise inspects a fulfilled object's then. A getter that changes
 * after the source fulfilled can therefore fail or stall this exceptional path. The
 * ordinary Promise.resolve path below does not add that extra forwarding step.
 *
 * Known limit: a broken native promise - one whose `constructor` misbehaves - cannot be
 * adopted without modifying it.
 * Every way the language offers to attach a reaction to one - `then`, `await`,
 * `Promise.resolve()`, the combinators - reads `constructor` first, so a rejection of
 * the promise itself is left unhandled. Shadowing the property for the call would get
 * past it in some shapes, but not a non-configurable own property or a frozen promise,
 * and this never writes to the value it is handed. Such a promise's failure is still
 * reported - as an unhandled rejection rather than through the caller. A native promise
 * from another realm - an iframe, a `vm` context - fares the same: the intrinsic accepts
 * it, since its check is the internal slot, not the prototype, and what its broken
 * `constructor` or species throws there - or again in `Promise.resolve()` - rejects the
 * result.
 */
export function adoptPromise<T>(
  value: T | PromiseLike<T>,
): Promise<Awaited<T>> {
  return adoptOwnPromise(value) ?? adopt(value);
}

/**
 * Probe an own-then value before reading its override. Promise.prototype.then uses
 * the internal promise slot, so this also observes foreign-realm promises that fail
 * instanceof and have a throwing or non-callable own then. Ordinary plain thenables
 * skip the probe. A failed probe on a local promise is an adoption failure (for
 * example a broken constructor/species), as is any failure the slot check cannot
 * throw - only a value that passed it gets that far - and a `TypeError` in the species
 * path's own wording, for the same reason. On other objects, normal thenable handling
 * remains the fallback. Do not skip class or null prototypes: real native promises
 * can acquire either through setPrototypeOf, and foreign promises fail instanceof.
 * The intrinsic slot probe is necessary to keep their own then from hiding failures.
 * This one boundary is shared by both adoption entry points.
 *
 * `isPromise` is {@link inheritsFromPromise}'s answer, when the caller already read it:
 * a proxy's `getPrototypeOf` trap can answer differently each time, so one
 * classification asks it once. Read here, once, otherwise.
 */
function adoptOwnPromise<T>(
  value: T,
  isPromise?: boolean,
): Promise<Awaited<T>> | undefined {
  if (!isObjectLike(value) || !hasOwnThen(value)) {
    return undefined;
  }
  const isOnPromiseChain = isPromise ?? inheritsFromPromise(value);
  // Nothing with `Promise.prototype` on its chain has `Object.prototype` directly above it.
  if (!isOnPromiseChain && hasObjectPrototype(value)) {
    return undefined;
  }
  let didAdopt = false;
  const pending = new promiseConstructorIntrinsic<Awaited<T>>(
    (resolve, reject) => {
      try {
        applyIntrinsic(promiseThenIntrinsic, value, [resolve, reject]);
        didAdopt = true;
      } catch (error) {
        // A foreign-realm promise fails `inheritsFromPromise`. The slot check refuses a
        // non-promise before reading `constructor`, so any failure it cannot throw - from
        // a `constructor` getter, a species getter or a species constructor - comes from
        // a native promise of some realm, whose own `then` must not be trusted to settle
        // it. A broken species can fail with that same `TypeError`, so it is told apart
        // by the engine's wording.
        if (
          isOnPromiseChain ||
          !isSlotCheckFailure(error) ||
          isSpeciesRefusal(error)
        ) {
          didAdopt = true;
          // Preserve the original rejection value, as adoption does.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        }
      }
    },
  );
  return didAdopt ? pending : undefined;
}

// A captured then belongs to the classification read. Reusing it keeps accessor side
// effects and return-contract classification stable. Both entry points have already
// tried native own-then handling before calling this shared assimilation function.
function adopt<T>(
  value: T | PromiseLike<T>,
  capturedThen?: (...args: unknown[]) => unknown,
): Promise<Awaited<T>> {
  // Promise.resolve already returns a native promise observed through our captured
  // methods. Wrapping it again would resolve with its raw fulfilled value, reading
  // then a second time and turning an already successful result into another adoption.
  // Keep invocation errors asynchronous, as this function's contract requires.
  if (capturedThen === undefined) {
    try {
      return promiseResolveIntrinsic(value);
    } catch (error) {
      return promiseRejectIntrinsic(error);
    }
  }

  return new promiseConstructorIntrinsic<Awaited<T>>((resolve, reject) => {
    // Thenable invocation is a microtask, just like Promise.resolve assimilation.
    // Ignore its return: only the supplied resolve/reject callbacks settle adoption.
    queueMicrotaskIntrinsic(() => {
      try {
        applyIntrinsic(capturedThen, value, [resolve, reject]);
      } catch (error) {
        // Preserve arbitrary rejection reasons exactly as Promise assimilation does.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      }
    });
  });
}

/** A malformed return is distinct from a throw during the callback invocation. */
export class UnreadableReturn extends Error {
  constructor(cause: unknown) {
    super(`Returned value's then could not be read: ${describeError(cause)}`, {
      cause,
    });
  }

  /** Describe the return-contract failure without claiming the invocation threw. */
  public describe(subject: string): string {
    return `${subject} returned a value whose then could not be read: ${describeError(this.cause)}`;
  }

  /** Shared terminal wording, built only on failure rather than for every call. */
  public report(subject: string, originalFailure?: string): void {
    const malformed = this.describe(subject);
    reportToConsole(
      originalFailure === undefined
        ? malformed
        : `${originalFailure}\n\n${malformed}`,
    );
  }
}

/**
 * Classify a completed callback's return separately from invoking it. Synchronous
 * success creates no reporting closure or wrapper. Only a malformed return allocates
 * a failure, which callers route through their configured channel or terminal console.
 * A promise is native and safe for captured observation; undefined means no async work.
 * Native promises are detected before reading then so hostile own properties cannot
 * hide a rejection. Other thenables are classified and adopted from a single read;
 * do not reintroduce a separate predicate followed by adoption.
 */
export function adoptResult(
  result: unknown,
): Promise<unknown> | UnreadableReturn | undefined {
  if (!isObjectLike(result)) {
    return undefined;
  }
  const isPromise = inheritsFromPromise(result);
  const ownPromise = adoptOwnPromise(result, isPromise);
  if (ownPromise !== undefined) {
    return ownPromise;
  }
  if (isPromise) {
    return adopt(result);
  }
  let then: unknown;
  try {
    then = getIntrinsic(result, 'then', result);
  } catch (error) {
    return new UnreadableReturn(error);
  }
  return typeof then === 'function'
    ? adopt(result, then as (...args: unknown[]) => unknown)
    : undefined;
}

/**
 * For a caller that refuses a promise or other thenable rather than waiting for it:
 * whether `result` is one, decided without calling anything `result` supplies. A native
 * promise of any realm has its rejection observed and contained through the intrinsic
 * `then`, which reads its `constructor` and species as any reaction would, but never its
 * own or inherited `then` method. Any other value has its `then` read, once, and never
 * called - a lazy thenable that starts its work there is not started. A `then` that
 * cannot be read answers an {@link UnreadableReturn}.
 *
 * Known limit: a native promise whose `constructor` misbehaves cannot be observed, as
 * {@link adoptPromise} documents, and neither can a proxy around a promise, which has
 * no internal slot; their rejections are left to the host's unhandled-rejection
 * reporting.
 */
export function containDeferredResult(
  result: object,
): boolean | UnreadableReturn {
  // A plain object of this realm is no native promise; spared the probe's throw.
  if (!hasObjectPrototype(result)) {
    try {
      void applyIntrinsic(promiseThenIntrinsic, result, [noop, noop]);
      return true;
    } catch (error) {
      if (
        inheritsFromPromise(result) ||
        !isSlotCheckFailure(error) ||
        isSpeciesRefusal(error)
      ) {
        return true;
      }
    }
  }
  let then: unknown;
  try {
    then = getIntrinsic(result, 'then', result);
  } catch (error) {
    return new UnreadableReturn(error);
  }
  return typeof then === 'function';
}

function noop(): void {}
