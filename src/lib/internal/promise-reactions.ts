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
 * Attach non-throwing terminal reactions through the native `Promise.prototype.then`,
 * read live and applied to `promise`, so an own `then` on the promise is bypassed. This
 * is how adoption reads a caller's native promise; a promise adoption returned is the
 * library's own, and is observed with its `then` directly.
 *
 * The native `then` builds its derived promise from the input's live
 * `constructor`/species, which a caller's promise chooses: that unused result is
 * contained, since a species can return an already-rejected promise even when both
 * reactions succeed. An attachment failure - a `constructor` getter that throws, a
 * species that cannot build a promise - throws synchronously, so callers can tell it
 * from the input's rejection.
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

  // A plain native promise under unmodified built-ins builds a plain `Promise` from its
  // own `then`, so it needs no shadowing. A value that only looks plain - a Proxy, say -
  // throws from the native `then` and takes the general path below.
  try {
    if (
      Object.getPrototypeOf(derived) === Promise.prototype &&
      !Object.hasOwn(derived, 'constructor') &&
      Promise.prototype.constructor === Promise &&
      Promise[Symbol.species] === Promise
    ) {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      void Reflect.apply(Promise.prototype.then, derived, [noop, noop]);
      return;
    }
  } catch {
    // Not a native promise, or a trap threw; the general path decides.
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
 * Observe only rejection of an owned native promise - one adoption returned, or the
 * library's own. Fulfillment is deliberately discarded: forwarding the value would
 * settle a derived promise with it and read its `then` again. Neither that value nor
 * the reporter's own result is an output of this floating operation. A terminal
 * observer contains a reporter that throws or rejects without forwarding its
 * fulfillment either.
 */
export function observeRejection(
  promise: Promise<unknown>,
  onRejected: (error: unknown) => unknown,
): void {
  void promise.then(noop, onRejected).then(noop, noop);
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
      Promise.resolve(undefined).then(() => reported),
      noop,
    );
  }
}
