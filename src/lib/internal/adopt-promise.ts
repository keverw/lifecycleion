import { isPromise } from '../is-promise';

/**
 * Whether `value` has `Promise.prototype` on its prototype chain - the shape of a native
 * promise from this realm, or a subclass's. `instanceof` walks the chain without reading
 * any property of `value`; a proxy's `getPrototypeOf` trap that throws answers `false`.
 */
function inheritsFromPromise(value: unknown): boolean {
  try {
    return value instanceof Promise;
  } catch {
    return false;
  }
}

/**
 * Whether a value from untrusted code should go through {@link adoptPromise}: anything on
 * the `Promise.prototype` chain, decided without reading it, or else a thenable, decided
 * by its `then`. `isPromise()` alone reads `then` first, so a native promise whose own
 * `then` is not a function - or a getter that throws - was never adopted, and its
 * rejection went unhandled. A throwing `then` getter on anything else still throws here,
 * for the caller to report.
 */
export function isAdoptable(value: unknown): boolean {
  return inheritsFromPromise(value) || isPromise(value);
}

/**
 * Whether `value` carries `then` as an own property - the shape of a native promise
 * someone attached a replacement `then` to. A class's `then` lives on its prototype and
 * is not own; a plain thenable's usually is. A proxy's trap that throws answers `true`,
 * so the value is read through the intrinsic rather than trusted.
 */
function hasOwnThen(value: object): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(value, 'then');
  } catch {
    return true;
  }
}

/**
 * Adopt a value from untrusted code - a component hook's return, a callback's result - as
 * a fresh native promise that settles as it does, and that is safe to chain on.
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
 * fails as `await` would. A plain thenable is adopted through its `then`; one that never calls back
 * never settles, which no caller can do anything about. A `then` - or a `constructor`
 * getter - that throws rejects the result rather than throwing.
 *
 * Something on the `Promise.prototype` chain with an own `then` that the intrinsic
 * refuses is rejected, never followed through that `then`: a native promise whose
 * `constructor` misbehaves - a getter that throws, a value that is not a constructor, a
 * species that throws or never builds a promise - and an `Object.create(Promise.prototype)`
 * fake. No check tells the two apart without reading the value's own properties, which is
 * what the broken promise breaks.
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
 * from another realm - an iframe, a `vm` context - fares the same: the intrinsic accepts
 * it, since its check is the internal slot, not the prototype, and a broken `constructor`
 * throws there and again in `Promise.resolve()`, which rejects the result.
 */
export function adoptPromise<T>(
  value: T | PromiseLike<T>,
): Promise<Awaited<T>> {
  return new Promise<Awaited<T>>((resolve, reject) => {
    // A primitive - what most hooks return, synchronously - cannot be a promise or a
    // thenable.
    if (
      value === null ||
      (typeof value !== 'object' && typeof value !== 'function')
    ) {
      resolve(value as Awaited<T>);

      return;
    }

    // Only an own `then` is bypassed, so only then is the intrinsic tried - which also
    // spares an object without one a thrown and caught `TypeError`, and its stack. A
    // plain thenable, whose `then` is usually its own, still pays it: the intrinsic has
    // to be tried first, for a native promise from another realm with an own `then`.
    if (hasOwnThen(value)) {
      try {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        Reflect.apply(Promise.prototype.then, value, [resolve, reject]);

        return;
      } catch (error) {
        // Never through the own `then` for anything on the promise chain: see above.
        // Decided by the value's shape, not by re-reading its `constructor`, which can
        // answer differently each time.
        if (inheritsFromPromise(value)) {
          // As thrown - the getter's own value, like any rejection this passes through.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);

          return;
        }
        // Not a native promise: a plain thenable, adopted below.
      }
    }

    // The standard adoption, as `await` performs it; the intrinsic is applied to the
    // adopted promise, which is this module's own.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.apply(Promise.prototype.then, Promise.resolve(value), [
      resolve,
      reject,
    ]);
  });
}
