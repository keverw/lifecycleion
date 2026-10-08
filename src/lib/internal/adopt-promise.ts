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
 * Whether `error` is what the native `then`'s internal-slot check can throw for a value
 * that is not a native promise: this realm's `TypeError`, or - with the stack nearly
 * exhausted, where even that check cannot run - this realm's `RangeError`. Anything else
 * comes from past the check, so from a native promise of some realm.
 */
function isSlotCheckFailure(error: unknown): boolean {
  try {
    if (!isObjectLike(error)) {
      return false;
    }
    const prototype: unknown = Reflect.getPrototypeOf(error);
    return (
      prototype === TypeError.prototype || prototype === RangeError.prototype
    );
  } catch {
    return false;
  }
}

/**
 * Adopt a value from untrusted code - a component hook's return, a callback's result - as
 * a native promise that settles as it does, safe for observation through the native
 * `then`. A native input need not be wrapped again: that would re-adopt its fulfilled
 * value. Adoption does not promise a fresh identity. Consumers that await rather than
 * attach an observer use awaitBoxedPromise and unwrap afterward, so a changing input
 * constructor cannot redirect await through a live then. Constructor/species failures
 * during that observation remain subject to the native limits below.
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
 * fails as `await` would when that `then` is inherited. A proxy on this realm's
 * `Promise.prototype` chain that exposes `then` as an own property is rejected after
 * the native `then` fails: it cannot be distinguished portably from the promise-prototype
 * fake or a native promise with broken constructor/species handling described below
 * without trusting the own `then` and risking a hang. A plain thenable
 * is adopted through its `then`; one that never calls back never settles, which no caller
 * can do anything about. A `then` - or a `constructor` getter - that throws rejects the
 * result rather than throwing.
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
 * from another realm - an iframe, a `vm` context - fares the same: the native `then` accepts
 * it, since its check is the internal slot, not the prototype, and what its broken
 * `constructor` or species throws there - or again in `Promise.resolve()` - rejects the
 * result.
 */
export function adoptPromise<T>(
  value: T | PromiseLike<T>,
  onObservationFailure?: (error: unknown) => void,
): Promise<Awaited<T>> {
  return (
    adoptOwnPromise(value, undefined, onObservationFailure) ??
    adopt(value, undefined, onObservationFailure)
  );
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
 * Known limit: the native `then` refuses a broken species - a `constructor` that is not
 * an object, a species that is not a constructor or misuses its executor - with this
 * realm's `TypeError`, the same error its slot check throws for a non-promise. For a
 * native promise off this realm's `Promise.prototype` chain (another realm's, or one
 * reparented) that refusal cannot be told apart from a plain thenable, so the value is
 * taken for the thenable its own `then` claims it is and followed through that `then`.
 *
 * `isPromise` is {@link inheritsFromPromise}'s answer, when the caller already read it:
 * a proxy's `getPrototypeOf` trap can answer differently each time, so one
 * classification asks it once. Read here, once, otherwise.
 */
function adoptOwnPromise<T>(
  value: T,
  isPromise?: boolean,
  onObservationFailure?: (error: unknown) => void,
): Promise<Awaited<T>> | undefined {
  if (!isObjectLike(value) || !hasOwnThen(value)) {
    return undefined;
  }
  const isOnPromiseChain = isPromise ?? inheritsFromPromise(value);
  let didAdopt = false;
  const pending = new Promise<Awaited<T>>((resolve, reject) => {
    try {
      attachIntrinsicReactions<Awaited<T>>(value, resolve, reject);
      didAdopt = true;
    } catch (error) {
      // A foreign-realm promise fails `inheritsFromPromise`. The slot check refuses a
      // non-promise before reading `constructor`, so any failure it cannot throw - from
      // a `constructor` getter, a species getter or a species constructor - comes from
      // a native promise of some realm, whose own `then` must not be trusted to settle
      // it.
      if (isOnPromiseChain || !isSlotCheckFailure(error)) {
        didAdopt = true;
        notifyObservationFailure(onObservationFailure, error);
        // Preserve the original rejection value, as adoption does.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);
      }
    }
  });
  return didAdopt ? pending : undefined;
}

// A `then` read during classification belongs to that read. Reusing it keeps accessor side
// effects and return-contract classification stable. Both entry points have already
// tried native own-then handling before calling this shared assimilation function.
function adopt<T>(
  value: T | PromiseLike<T>,
  capturedThen?: (...args: unknown[]) => unknown,
  onObservationFailure?: (error: unknown) => void,
): Promise<Awaited<T>> {
  // Promise.resolve already returns a native promise observed through the native
  // `then`. Wrapping it again would resolve with its raw fulfilled value, reading
  // then a second time and turning an already successful result into another adoption.
  // Keep invocation errors asynchronous, as this function's contract requires.
  if (capturedThen === undefined) {
    try {
      return Promise.resolve(value);
    } catch (error) {
      notifyObservationFailure(onObservationFailure, error);
      // Preserve the original failure, as adoption does.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(error);
    }
  }

  return new Promise<Awaited<T>>((resolve, reject) => {
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
 * A promise is native and safe to observe; undefined means no async work.
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
    if (inheritsFromPromise(result) || !isSlotCheckFailure(error)) {
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
  onObservationFailure: ((error: unknown) => void) | undefined,
  error: unknown,
): void {
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
