import { describeError } from '../to-error';
import { reportToConsole } from './report-to-console';

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
 * Whether `value` is a plain object of this realm - `Object.prototype` directly above it -
 * which no native promise is unless someone rebuilt one's prototype chain. Such a value is
 * spared trying the intrinsic `then` on it, which can only throw - and capture a stack - to
 * be caught. A native promise from another realm has that realm's `Promise.prototype`, not
 * this `Object.prototype`, so it still reaches the intrinsic. A `getPrototypeOf` trap
 * that throws answers `false`, so the intrinsic is tried.
 */
function isPlainObject(value: object): boolean {
  try {
    return Reflect.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
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
  return adopt(value);
}

// A captured then belongs to the classification read. Reusing it keeps accessor side
// effects and return-contract classification stable. Native own-then handling below
// still takes precedence: it reads the promise's internal state, not that override.
function adopt<T>(
  value: T | PromiseLike<T>,
  capturedThen?: (...args: unknown[]) => unknown,
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
    // spares an object without one a thrown and caught `TypeError`, and its stack. So
    // does a plain object literal's own `then` - the common thenable, on hot paths such
    // as sink writes - since no native promise has `Object.prototype` above it. Anything
    // else with an own `then` still tries the intrinsic first, for a native promise from
    // another realm.
    if (hasOwnThen(value) && !isPlainObject(value)) {
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

    if (capturedThen !== undefined) {
      // Thenable invocation is a microtask, just like Promise.resolve assimilation.
      // Ignore its return: only the supplied resolve/reject callbacks settle adoption.
      queueMicrotask(() => {
        try {
          Reflect.apply(capturedThen, value, [resolve, reject]);
        } catch (error) {
          // Preserve arbitrary rejection reasons exactly as Promise assimilation does.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        }
      });
      return;
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

/** A malformed return is distinct from a throw during the callback invocation. */
export class UnreadableReturn extends Error {
  constructor(cause: unknown) {
    super(`Returned value's then could not be read: ${describeError(cause)}`, {
      cause,
    });
  }

  /** Shared terminal wording, built only on failure rather than for every call. */
  public report(subject: string): void {
    reportToConsole(
      `${subject} returned a value whose then could not be read: ${describeError(this.cause)}`,
    );
  }
}

/**
 * Classify a completed callback's return separately from invoking it. Synchronous
 * success creates no reporting closure or wrapper. Only a malformed return allocates
 * a failure, which callers route through their configured channel or terminal console.
 * A promise is always freshly adopted and safe to chain; undefined means no async work.
 * Native promises are detected before reading then so hostile own properties cannot
 * hide a rejection. Other thenables are classified and adopted from a single read;
 * do not reintroduce a separate predicate followed by adoption.
 */
export function adoptResult(
  result: unknown,
): Promise<unknown> | UnreadableReturn | undefined {
  if (inheritsFromPromise(result)) {
    return adoptPromise(result);
  }
  if (
    result === null ||
    (typeof result !== 'object' && typeof result !== 'function')
  ) {
    return undefined;
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
