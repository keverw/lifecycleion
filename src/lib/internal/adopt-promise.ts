import {
  queueMicrotaskSafely,
  attachIntrinsicReactions,
  noop,
} from './intrinsics';
import { isObjectLike } from './is-object-like';
import { describeError } from '../to-error';
import { reportToConsole } from './report-to-console';

/**
 * Whether `value` has `Promise.prototype` on its prototype chain - the shape of a native
 * promise from this realm, or a subclass's. The `instanceof` walk reads no property of
 * `value`; a proxy's `getPrototypeOf` trap that throws answers `false`.
 */
function inheritsFromPromise(value: unknown): boolean {
  try {
    return value instanceof Promise;
  } catch {
    return false;
  }
}

/**
 * Whether `value` carries `then` as an own property - the shape of a native promise
 * someone attached a replacement `then` to. A class's `then` lives on its prototype and
 * is not own; a plain thenable's usually is. A proxy's trap that throws answers `true`,
 * so the value is read through the native `then` rather than trusted.
 */
function hasOwnThen(value: object): boolean {
  try {
    return Object.hasOwn(value, 'then');
  } catch {
    return true;
  }
}

/**
 * Whether `error` is this realm's `TypeError` - what the native `then`'s internal-slot
 * check throws for a value that is not a native promise. Anything else comes from past
 * the check, so from a native promise of some realm. A `RangeError` from running out of
 * stack counts as the latter: the adoption rejects with it rather than guessing.
 */
function isThisRealmTypeError(error: unknown): boolean {
  try {
    return (
      isObjectLike(error) &&
      Reflect.getPrototypeOf(error) === TypeError.prototype
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
    [Symbol.species]: class {
      constructor(executor: (...args: unknown[]) => void) {
        build(executor);
      }
    },
  };
}

/**
 * The refusals the native `then` raises on its species path, in this engine's own
 * wording: a `constructor` that is not an object, a species that is not a constructor, and
 * a species that hands its executor no callable resolve or reject function, or calls it
 * twice. Recorded once, at load, from probe promises this module creates, so no engine's
 * wording is written down here.
 */
function recordSpeciesRefusals(): readonly string[] {
  const constructors: unknown[] = [
    0,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    { __proto__: null, [Symbol.species]: 0 },
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
  for (const constructor of constructors) {
    const probe = Promise.resolve();
    void Object.defineProperty(probe, 'constructor', {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __proto__: null,
      value: constructor,
    } as PropertyDescriptor);
    try {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      void Reflect.apply(Promise.prototype.then, probe, []);
    } catch (error) {
      if (isThisRealmTypeError(error)) {
        messages.push((error as TypeError).message);
      }
    }
  }
  return messages;
}

const speciesRefusalMessages = recordSpeciesRefusals();

/**
 * Whether the native `then` threw `error` from its species path - the brand check a
 * value that failed the slot check cannot fake. The internal-slot check refuses a
 * non-promise first, with a refusal of its own wording, before `constructor` is read; only
 * a native promise of some realm gets as far as these. Nothing the value inherits or
 * carries - a `Symbol.toStringTag`, a prototype - reaches the engine's message, so a
 * re-prototyped or foreign promise is caught and a thenable dressed as a promise is not.
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
    message = Reflect.get(error as object, 'message', error);
  } catch {
    return false;
  }
  return (
    typeof message === 'string' && speciesRefusalMessages.includes(message)
  );
}

/**
 * A caller's settled value, boxed. Native resolution reads a fulfilled object's `then`
 * again whenever it settles another promise with it - an `async` function returning it,
 * `Promise.race()`, a `then` reaction's result - and a getter that changed after the
 * value's own resolution could start an adoption there that never settles. The box is
 * the library's own object, so the promises adoption returns, and every `await` and
 * native combinator over them, carry it without reading the caller's value again.
 * Unwrap it synchronously, after the wait; the raw value must not settle another
 * promise.
 *
 * Boxing covers what happens after adoption. Adoption itself carries the fulfilled
 * value into the box without reading its `then` again only for this realm's native
 * promises, values with an own `then`, and plain thenables. A `Promise` subclass
 * instance or a proxy around a promise is followed through its `then`, as `await`
 * follows it, and the resolve function that `then` calls reads the fulfilled value's
 * `then` again.
 */
export interface PromiseResultBox<T> {
  value: T;
}

function boxPromiseValue<T>(value: T): PromiseResultBox<T> {
  return { value };
}

/**
 * Adopt a value from untrusted code - a component hook's return, a callback's result - as
 * a fresh native promise the library owns, fulfilled with the value boxed
 * ({@link PromiseResultBox}) or rejected as the value is. It is never the caller's own
 * promise, so `await`, `then` and the native combinators can be used on it directly: its
 * `constructor` and `then` are the built-ins, whatever the caller's promise does with
 * its own.
 *
 * It follows the value as `await` would, with one exception: a `then` attached to the
 * value itself, as an own property, is not trusted. `await` ignores one on a plain native
 * promise, but not on a native promise carrying its own `constructor` as well - it wraps
 * that and calls the own `then` - and `Promise.resolve()` hands a native promise back with
 * its own properties, so `.then()`, `.catch()` and `Promise.race()` on the result call it.
 * A no-op one never settled for the caller, and the real rejection went unhandled - fatal
 * under Node's default `--unhandled-rejections=throw`. A value with an own `then` is
 * therefore read through the native `Promise.prototype.then`, which only a native
 * promise's internal state answers.
 *
 * Everything else is followed the standard way, as `await` follows it. A `then` a
 * `Promise` subclass defines on its prototype is its behaviour - a lazy promise that
 * starts its work there, say - and skipping it skipped the work and reported success. A
 * proxy around a promise has no internal slot for the native `then` to read, but it can
 * have a `then` that works - one its `get` trap binds to the promise - and succeeds or
 * fails as `await` would when that `then` is inherited. Either way the value it fulfills
 * with is resolved, not boxed directly, so its `then` is read again - as `await` reads
 * it. A proxy on this realm's
 * `Promise.prototype` chain that exposes `then` as an own property is rejected after
 * the native `then` fails: it cannot be distinguished portably from the promise-prototype
 * fake or a native promise with broken constructor/species handling described below
 * without trusting the own `then` and risking a hang. A plain thenable
 * is adopted through its `then`; one that never calls back never settles, which no caller
 * can do anything about. A `then` - or a `constructor` getter - that throws rejects the
 * result rather than throwing.
 *
 * A native promise `Promise.resolve()` hands back as it is - its `constructor` read as
 * `Promise` - is observed through the native `then` too, so its fulfilled value reaches
 * the box without its `then` being read again. That reaction reads `constructor` a second
 * time, for its species; a getter that throws there, or a species that cannot build a
 * promise, rejects the result as an observation failure.
 *
 * Something on the `Promise.prototype` chain with an own `then` that the native `then`
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
 * Known limit: a broken native promise - one whose `constructor` misbehaves - cannot be
 * adopted without modifying it.
 * Every way the language offers to attach a reaction to one - `then`, `await`,
 * `Promise.resolve()`, the combinators - reads `constructor` first, so a rejection of
 * the promise itself is left unhandled. Shadowing the property for the call would get
 * past it in some shapes, but not a non-configurable own property or a frozen promise,
 * and this never writes to the value it is handed. Such a promise's failure is still
 * reported - as an unhandled rejection rather than through the caller. A native promise
 * from another realm - an iframe, a `vm` context - fares the same: the native `then` accepts
 * it, since its check is the internal slot, not the prototype, and what its broken
 * `constructor` or species throws there - or again in `Promise.resolve()` - rejects the
 * result.
 */
export function adoptPromise<T>(
  value: T | PromiseLike<T>,
  callbacks?: AdoptionCallbacks,
): Promise<PromiseResultBox<Awaited<T>>> {
  return (
    adoptOwnPromise(value, undefined, callbacks) ??
    adopt(value, undefined, callbacks)
  );
}

/** Hooks into one adoption, for a caller that must act at its exact moments. */
export interface AdoptionCallbacks {
  /**
   * The value could not be observed at all. Called synchronously, before the result
   * rejects with `error`; the value's own outcome is never seen.
   */
  onObservationFailure?: (error: unknown) => void;
  /**
   * The value settled - fulfilled when `didFulfill`. Called by the reaction that
   * settles the result, so before any reaction to the result runs.
   */
  onSettled?: (didFulfill: boolean) => void;
}

/**
 * Probe an own-then value before reading its override. Promise.prototype.then uses
 * the internal promise slot, so this also observes foreign-realm promises that fail
 * instanceof and have a throwing or non-callable own then. Plain thenables also reach
 * the probe: a native promise may have been reparented directly to Object.prototype. A
 * failed probe on a local promise is an adoption failure (for example a broken
 * constructor/species), as is any failure the slot check cannot throw - only a value
 * that passed it gets that far. On other objects, normal thenable handling remains the
 * fallback. Do not skip class or null prototypes: real native promises can acquire
 * either through setPrototypeOf, and foreign promises fail instanceof. The native slot
 * probe is necessary to keep their own then from hiding failures. This one boundary is
 * shared by both adoption entry points.
 *
 * The native `then` refuses a broken species - a `constructor` that is not an object, a
 * species that is not a constructor or misuses its executor - with this realm's
 * `TypeError`, the same error its slot check throws for a non-promise. For a native
 * promise off this realm's `Promise.prototype` chain (another realm's, or one
 * reparented) that refusal is told apart by its message ({@link isSpeciesRefusal}), so
 * the value is rejected rather than followed through its own `then`.
 *
 * `isPromise` is {@link inheritsFromPromise}'s answer, when the caller already read it:
 * a proxy's `getPrototypeOf` trap can answer differently each time, so one
 * classification asks it once. Read here, once, otherwise.
 */
function adoptOwnPromise<T>(
  value: T,
  isPromise?: boolean,
  callbacks?: AdoptionCallbacks,
): Promise<PromiseResultBox<Awaited<T>>> | undefined {
  if (!isObjectLike(value) || !hasOwnThen(value)) {
    return undefined;
  }
  const isOnPromiseChain = isPromise ?? inheritsFromPromise(value);
  let didAdopt = false;
  const pending = new Promise<PromiseResultBox<Awaited<T>>>(
    (resolve, reject) => {
      try {
        attachBoxingReactions<Awaited<T>>(value, resolve, reject, callbacks);
        didAdopt = true;
      } catch (error) {
        // A foreign-realm promise fails `inheritsFromPromise`. The slot check refuses a
        // non-promise before reading `constructor`, so any failure it cannot throw - from
        // a `constructor` getter, a species getter or a species constructor - comes from
        // a native promise of some realm, whose own `then` must not be trusted to settle
        // it. So does a species refusal, which the slot check's `TypeError` resembles.
        if (
          isOnPromiseChain ||
          !isThisRealmTypeError(error) ||
          isSpeciesRefusal(error)
        ) {
          didAdopt = true;
          notifyObservationFailure(callbacks, error);
          // Preserve the original rejection value, as adoption does.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        }
      }
    },
  );
  return didAdopt ? pending : undefined;
}

// A `then` read during classification belongs to that read. Reusing it keeps accessor side
// effects and return-contract classification stable. Both entry points have already
// tried native own-then handling before calling this shared assimilation function.
function adopt<T>(
  value: T | PromiseLike<T>,
  capturedThen?: (...args: unknown[]) => unknown,
  callbacks?: AdoptionCallbacks,
): Promise<PromiseResultBox<Awaited<T>>> {
  if (capturedThen !== undefined) {
    const followed = new Promise<Awaited<T>>((resolve, reject) => {
      // Thenable invocation is a microtask, just like Promise.resolve assimilation.
      // Ignore its return: only the supplied resolve/reject callbacks settle adoption.
      queueMicrotaskSafely(() => {
        try {
          Reflect.apply(capturedThen, value, [resolve, reject]);
        } catch (error) {
          // Preserve arbitrary rejection reasons exactly as Promise assimilation does.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        }
      });
    });
    return boxSettlement(followed, callbacks);
  }

  // A primitive has no `then` of its own to read, and is already settled.
  if (!isObjectLike(value) && callbacks?.onSettled === undefined) {
    return Promise.resolve(boxPromiseValue(value as Awaited<T>));
  }

  // Keep invocation errors asynchronous, as this function's contract requires.
  let resolved: Promise<Awaited<T>>;
  try {
    resolved = Promise.resolve(value);
  } catch (error) {
    notifyObservationFailure(callbacks, error);
    // Preserve the original failure, as adoption does.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(error);
  }
  if (resolved !== value) {
    // Already a promise of our own, which native resolution settles as `await` would.
    return boxSettlement(resolved, callbacks);
  }
  // The caller's own native promise, handed back as it is. Observed through the native
  // `then` rather than resolved into a new promise, which would read its fulfilled
  // value's `then` a second time.
  return new Promise<PromiseResultBox<Awaited<T>>>((resolve, reject) => {
    try {
      attachBoxingReactions<Awaited<T>>(resolved, resolve, reject, callbacks);
    } catch (error) {
      notifyObservationFailure(callbacks, error);
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(error);
    }
  });
}

/**
 * Settle an adoption from a native promise's own state, read through the native `then`,
 * its fulfilled value boxed rather than resolved. Throws when that `then` refuses
 * `source`.
 */
function attachBoxingReactions<T>(
  source: object,
  resolve: (box: PromiseResultBox<T>) => void,
  reject: (reason: unknown) => void,
  callbacks: AdoptionCallbacks | undefined,
): void {
  attachIntrinsicReactions<T>(
    source,
    (value) => {
      resolve(boxPromiseValue(value));
      notifySettled(callbacks, true);
    },
    (reason) => {
      reject(reason);
      notifySettled(callbacks, false);
    },
  );
}

/** Box the outcome of a promise of our own. */
function boxSettlement<T>(
  source: Promise<T>,
  callbacks: AdoptionCallbacks | undefined,
): Promise<PromiseResultBox<T>> {
  if (callbacks?.onSettled === undefined) {
    return source.then(boxPromiseValue);
  }
  return source.then(
    (value) => {
      notifySettled(callbacks, true);
      return boxPromiseValue(value);
    },
    (error: unknown) => {
      notifySettled(callbacks, false);
      throw error;
    },
  );
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
 * A promise is a fresh one of our own, as {@link adoptPromise} returns; undefined means
 * no async work.
 * Native promises are detected before reading then so hostile own properties cannot
 * hide a rejection. Other thenables are classified and adopted from a single read;
 * do not reintroduce a separate predicate followed by adoption.
 */
export function adoptResult(
  result: unknown,
): Promise<PromiseResultBox<unknown>> | UnreadableReturn | undefined {
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
    then = Reflect.get(result, 'then', result);
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
 * promise of any realm has its rejection observed and contained through the native
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
  // Prototype identity cannot rule out a native promise: callers can reparent it.
  try {
    attachIntrinsicReactions(result, noop, noop);
    return true;
  } catch (error) {
    if (
      inheritsFromPromise(result) ||
      !isThisRealmTypeError(error) ||
      isSpeciesRefusal(error)
    ) {
      return true;
    }
  }
  let then: unknown;
  try {
    then = Reflect.get(result, 'then', result);
  } catch (error) {
    return new UnreadableReturn(error);
  }
  return typeof then === 'function';
}

/**
 * Tell the caller that observation failed, without letting its callback change the
 * outcome: a throw here would escape `adoptPromise` synchronously, or replace the
 * rejection reason the adopted promise is about to carry. Its failure goes to the
 * console instead, since the adoption itself still reports the original.
 */
function notifyObservationFailure(
  callbacks: AdoptionCallbacks | undefined,
  error: unknown,
): void {
  const onObservationFailure = callbacks?.onObservationFailure;
  if (onObservationFailure === undefined) {
    return;
  }
  try {
    onObservationFailure(error);
  } catch (callbackError) {
    reportToConsole(
      `An adoption failure callback threw: ${describeError(callbackError)}`,
    );
  }
}

/** Tell the caller the value settled; a throw cannot keep the result from settling. */
function notifySettled(
  callbacks: AdoptionCallbacks | undefined,
  didFulfill: boolean,
): void {
  const onSettled = callbacks?.onSettled;
  if (onSettled === undefined) {
    return;
  }
  try {
    onSettled(didFulfill);
  } catch (callbackError) {
    reportToConsole(
      `An adoption settlement callback threw: ${describeError(callbackError)}`,
    );
  }
}
