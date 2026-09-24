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
 */
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
    } catch {
      // Not a native promise - or one whose `constructor` misbehaves; adopted below.
    }

    // The intrinsic, applied to the adopted promise - the point of the call.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.apply(Promise.prototype.then, Promise.resolve(value), [
      resolve,
      reject,
    ]);
  });
}
