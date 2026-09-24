/**
 * Adopt a value from untrusted code - a component hook's return, a callback's result - as
 * a fresh native promise that settles as it does, and that is safe to chain on.
 *
 * `Promise.resolve(value)` alone is not enough: it hands a native promise back unchanged,
 * own properties included, and `.then()`, `.catch()`, `Promise.race()` and returning it
 * from a `then` callback all look its `then` up. A promise carrying its own no-op `then`
 * then never settles for the caller, and its real rejection goes unhandled - fatal under
 * Node's default `--unhandled-rejections=throw`. The intrinsic `Promise.prototype.then`
 * is applied instead, so only the promise's own internal state decides.
 *
 * A non-promise thenable is adopted the standard way, through its `then`; one that never
 * calls back never settles, which no caller can do anything about. A `then` - or a native
 * promise's `constructor` getter - that throws rejects the result rather than throwing.
 *
 * Known limit: a native promise whose `constructor` misbehaves - a getter that throws,
 * a value that is not a constructor, a broken species - cannot be adopted without
 * modifying it. Every way the language offers to attach a reaction to one - `then`,
 * `await`, `Promise.resolve()`, the combinators - reads `constructor` first, so the
 * result rejects with that error, and a rejection of the promise itself is left
 * unhandled. Shadowing the property for the call would get past it in some shapes, but
 * not a non-configurable own property or a frozen promise, and this never writes to the
 * value it is handed. Such a promise's failure is still reported - as an unhandled
 * rejection rather than through the caller. (A native promise from another realm with a
 * broken `constructor` is not recognized as one, and is adopted through its own `then`.)
 */
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
 * Whether `SpeciesConstructor(value, Promise)` would succeed: `value.constructor` is
 * `undefined`, or an object whose `Symbol.species` is `undefined`, `null`, or a
 * constructor. Mirrors the spec's steps, reading the same properties; any read that
 * throws answers `false`.
 */
function hasSoundSpecies(value: unknown): boolean {
  try {
    const constructor: unknown = Reflect.get(value as object, 'constructor');

    if (constructor === undefined) {
      return true;
    }

    if (
      constructor === null ||
      (typeof constructor !== 'object' && typeof constructor !== 'function')
    ) {
      return false;
    }

    const species: unknown = Reflect.get(constructor, Symbol.species);

    if (species === undefined || species === null) {
      return true;
    }

    // `IsConstructor`, without calling it: `Reflect.construct` checks its `newTarget`
    // before anything runs, and constructs an empty `Object` when it passes.
    Reflect.construct(Object, [], species as new () => unknown);

    return true;
  } catch {
    return false;
  }
}

export function adoptPromise<T>(
  value: T | PromiseLike<T>,
): Promise<Awaited<T>> {
  return new Promise<Awaited<T>>((resolve, reject) => {
    // A native promise is read directly, before `Promise.resolve()` gets a say:
    // `Promise.resolve()` only hands one back unchanged when its `constructor` is
    // `Promise`, so one carrying its own `constructor` was wrapped instead - and the
    // wrapper then called its own `then`. Applying the intrinsic throws for anything
    // that is not a native promise, which falls through to the standard adoption.
    try {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      Reflect.apply(Promise.prototype.then, value, [resolve, reject]);

      return;
    } catch (error) {
      // A native promise whose `constructor` misbehaves - a throwing getter, a
      // non-object, a broken species - lands here too, and must not fall through:
      // `Promise.resolve()` would see a foreign `constructor`, wrap it, and call its own
      // `then` - the very thing this exists to avoid, and a no-op one hung the caller.
      // No check tells a native promise apart without reading it, so the failure is
      // told apart instead: an object on the promise chain whose species lookup is
      // sound failed the brand check - an `Object.create(Promise.prototype)` fake,
      // adopted below as a thenable - and one whose lookup is broken is what failed.
      if (inheritsFromPromise(value) && !hasSoundSpecies(value)) {
        // As thrown - the getter's own value, like any rejection this passes through.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error);

        return;
      }
      // Not a native promise; adopted below.
    }

    // The intrinsic, applied to the adopted promise - the point of the call.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.apply(Promise.prototype.then, Promise.resolve(value), [
      resolve,
      reject,
    ]);
  });
}
