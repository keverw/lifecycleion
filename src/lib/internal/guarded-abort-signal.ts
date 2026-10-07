import {
  reportCallbackError,
  runCallbackSafely,
} from '../safe-handle-callback';
import {
  applyIntrinsic,
  definePropertyIntrinsic,
  getIntrinsic,
} from './intrinsics';
import { isNullish } from './is-nullish';
import { isObjectLike } from './is-object-like';

// Captured at module initialization, like the rest of the intrinsics: the guard installed
// below must keep registering with the real `EventTarget` after application code replaces
// these methods, or a replacement could hand the raw listener to the runtime after all.
// A runtime without `EventTarget` captures nothing, so importing this module still works
// there; only guarding a signal fails.
const eventTargetPrototype: EventTarget | undefined =
  typeof EventTarget === 'function' ? EventTarget.prototype : undefined;
// eslint-disable-next-line @typescript-eslint/unbound-method
const addEventListenerIntrinsic = eventTargetPrototype?.addEventListener;
// eslint-disable-next-line @typescript-eslint/unbound-method
const removeEventListenerIntrinsic = eventTargetPrototype?.removeEventListener;
const weakMapIntrinsic = WeakMap;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapGetIntrinsic = WeakMap.prototype.get;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapSetIntrinsic = WeakMap.prototype.set;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapDeleteIntrinsic = WeakMap.prototype.delete;

type Wrapper = (this: unknown, event: unknown) => void;

/**
 * Make `signal`'s own `'abort'` listeners and `onabort` handler unable to throw out of a
 * dispatch: what they throw or reject with is reported on the standard `'error'` channel
 * (see `reportCallbackError`) under `label`, and the listeners after them still run.
 *
 * An `EventTarget` runs its listeners itself, so an error one throws never reaches the
 * code that dispatched the event - `abort()`'s caller. Node and Bun report it as an
 * uncaught exception instead, fatal to a process with no handler. This defines own,
 * non-writable, non-configurable `addEventListener`, `removeEventListener` and `onabort`
 * on the instance, so later changes to the prototypes cannot route around it:
 *
 * - An `'abort'` listener - a function, or an object whose `handleEvent` is read at
 *   dispatch - is registered as a wrapper that calls it with the receiver it would have
 *   had (the signal, or the object). The same listener and capture flag reuse one
 *   wrapper, so a duplicate add is still ignored and `removeEventListener` with the
 *   original listener still removes it. `once`, `passive` and `signal` pass through.
 * - `onabort` stores its handler as the native attribute does (an object as-is, anything
 *   else as `null`) and runs it at the position where it was first set.
 * - A `null` or `undefined` listener is ignored, as the DOM specifies. Other event
 *   types and invalid calls go to the native method unwrapped, so they behave and fail
 *   as they would on any signal.
 *
 * Not covered, by design: listeners on a signal derived from this one (`AbortSignal.any`,
 * for instance) are that signal's, and calling `EventTarget.prototype.addEventListener`
 * on this signal directly registers the raw listener. Consumers that listen internally
 * (`fetch`, `AbortSignal.any`) are unaffected.
 *
 * Must be called on a signal nothing else has seen yet. Throws a `TypeError`, before
 * touching `signal`, in a runtime that had no `EventTarget` when this module loaded;
 * also throws if a signal refuses installation of a guard.
 */
export function guardAbortListeners(signal: AbortSignal, label: string): void {
  if (
    addEventListenerIntrinsic === undefined ||
    removeEventListenerIntrinsic === undefined
  ) {
    throw new TypeError(
      'EventTarget is not available in this runtime; lifecycleion needs it to guard abort listeners',
    );
  }
  const addListener: EventTarget['addEventListener'] =
    addEventListenerIntrinsic;
  const removeListener: EventTarget['removeEventListener'] =
    removeEventListenerIntrinsic;
  const reportListenerError = (error: unknown): void => {
    reportCallbackError(label, error);
  };
  // One wrapper per listener and capture flag. Weak, so a listener nothing else holds
  // does not stay alive because it was added once.
  let bubbleWrappers: WeakMap<object, Wrapper> | undefined;
  let captureWrappers: WeakMap<object, Wrapper> | undefined;

  const wrapperFor = (listener: object, isCapture: boolean): Wrapper => {
    let wrappers = isCapture ? captureWrappers : bubbleWrappers;
    if (wrappers === undefined) {
      wrappers = new weakMapIntrinsic<object, Wrapper>();
      if (isCapture) {
        captureWrappers = wrappers;
      } else {
        bubbleWrappers = wrappers;
      }
    }
    const existing = applyIntrinsic(weakMapGetIntrinsic, wrappers, [
      listener,
    ]) as Wrapper | undefined;
    if (existing !== undefined) {
      return existing;
    }
    const wrapper = wrapListener(listener, label, reportListenerError);
    applyIntrinsic(weakMapSetIntrinsic, wrappers, [listener, wrapper]);
    return wrapper;
  };

  const takeWrapper = (
    listener: object,
    isCapture: boolean,
  ): Wrapper | undefined => {
    const wrappers = isCapture ? captureWrappers : bubbleWrappers;
    if (wrappers === undefined) {
      return undefined;
    }
    const wrapper = applyIntrinsic(weakMapGetIntrinsic, wrappers, [
      listener,
    ]) as Wrapper | undefined;
    applyIntrinsic(weakMapDeleteIntrinsic, wrappers, [listener]);
    return wrapper;
  };

  function addEventListener(this: unknown, ...args: unknown[]): void {
    // Another receiver, or too few arguments: exactly the native method's behavior.
    if (this !== signal || args.length < 2) {
      applyIntrinsic(addListener, this, args);
      return;
    }
    // Indexed, not destructured: array destructuring reads the live
    // `Array.prototype[Symbol.iterator]`, which caller code can replace.
    const type = args[0];
    const listener = args[1];
    const options = args[2];
    // `ToString`, once, as the native method would - a symbol throws here as it would there.
    const typeString = `${type as string}`;
    // The DOM's no-op. Not handed to the native method, which in Bun and Node also
    // prints a warning that the call has no effect.
    if (isNullish(listener)) {
      return;
    }
    if (typeString !== 'abort' || !isObjectLike(listener)) {
      applyIntrinsic(addListener, signal, [typeString, listener, options]);
      return;
    }
    const { isCapture, nativeOptions } = readAddOptions(options);
    applyIntrinsic(addListener, signal, [
      typeString,
      wrapperFor(listener, isCapture),
      nativeOptions,
    ]);
  }

  function removeEventListener(this: unknown, ...args: unknown[]): void {
    if (this !== signal || args.length < 2) {
      applyIntrinsic(removeListener, this, args);
      return;
    }
    const type = args[0];
    const listener = args[1];
    const options = args[2];
    const typeString = `${type as string}`;
    const isCapture = readCapture(options);
    // A listener this guard never wrapped may still have been added through the
    // prototype's method; removing it as itself reaches that registration.
    const registered =
      (typeString === 'abort' && isObjectLike(listener)
        ? takeWrapper(listener, isCapture)
        : undefined) ?? listener;
    applyIntrinsic(removeListener, signal, [
      typeString,
      registered,
      // An object, not the boolean: Node's native removal ignores a boolean `true`.
      // eslint-disable-next-line @typescript-eslint/naming-convention
      { __proto__: null, capture: isCapture },
    ]);
  }

  // `onabort` as an event handler attribute: one native registration, made when it is
  // first set and kept while the handler is replaced, so it runs where it was first set.
  let handler: object | null = null;
  let isHandlerRegistered = false;
  const handlerWrapper = function (this: unknown, event: unknown): void {
    const current = handler;
    // A non-callable object is kept, and invoking it does nothing.
    if (typeof current === 'function') {
      runCallbackSafely(label, current, [event], reportListenerError, this);
    }
  };
  const getOnabort = (): object | null => handler;
  const setOnabort = (value: unknown): void => {
    handler = isObjectLike(value) ? value : null;
    if (handler === null && isHandlerRegistered) {
      isHandlerRegistered = false;
      applyIntrinsic(removeListener, signal, ['abort', handlerWrapper, false]);
    } else if (handler !== null && !isHandlerRegistered) {
      isHandlerRegistered = true;
      applyIntrinsic(addListener, signal, ['abort', handlerWrapper, false]);
    }
  };

  // Descriptors without a prototype, so nothing added to `Object.prototype` (a `get`,
  // say) is read as part of them. Refusal is surfaced rather than leaving a signal apparently guarded.
  if (
    !definePropertyIntrinsic(signal, 'addEventListener', {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __proto__: null,
      value: addEventListener,
      writable: false,
      enumerable: false,
      configurable: false,
    } as PropertyDescriptor)
  ) {
    throw new TypeError('Abort signal refused installation of listener guards');
  }
  if (
    !definePropertyIntrinsic(signal, 'removeEventListener', {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __proto__: null,
      value: removeEventListener,
      writable: false,
      enumerable: false,
      configurable: false,
    } as PropertyDescriptor)
  ) {
    throw new TypeError('Abort signal refused installation of listener guards');
  }
  if (
    !definePropertyIntrinsic(signal, 'onabort', {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __proto__: null,
      get: getOnabort,
      set: setOnabort,
      enumerable: false,
      configurable: false,
    } as PropertyDescriptor)
  ) {
    throw new TypeError('Abort signal refused installation of listener guards');
  }
}

/**
 * Call `listener` as an `EventTarget` would - a function on the receiver the dispatch
 * gives it, an object's `handleEvent` (read now, per dispatch) on the object - with
 * anything it throws or rejects with sent to `report`.
 */
function wrapListener(
  listener: object,
  label: string,
  report: (error: unknown) => void,
): Wrapper {
  if (typeof listener === 'function') {
    return function (this: unknown, event: unknown): void {
      runCallbackSafely(label, listener, [event], report, this);
    };
  }
  return function (event: unknown): void {
    let handleEvent: unknown;
    try {
      handleEvent = getIntrinsic(listener, 'handleEvent', listener);
    } catch (error) {
      report(error);
      return;
    }
    // A `handleEvent` that is not callable is reported as not a function.
    runCallbackSafely(label, handleEvent, [event], report, listener);
  };
}

/** `capture` as the native methods flatten their options: from an object, or the value. */
function readCapture(options: unknown): boolean {
  return isObjectLike(options)
    ? Boolean(getIntrinsic(options, 'capture', options))
    : Boolean(options);
}

/**
 * Read an `addEventListener` options object once, in the native order, and hand the
 * native method an object whose own properties hold those values. Inheriting from the
 * original keeps any other member reachable - Node's internal symbol-keyed options, for
 * instance - without reading the standard ones a second time, where a getter could give
 * a different `capture` than the one the wrapper was chosen by.
 */
function readAddOptions(options: unknown): {
  isCapture: boolean;
  nativeOptions: unknown;
} {
  if (!isObjectLike(options)) {
    return { isCapture: Boolean(options), nativeOptions: options };
  }
  const isCapture = Boolean(getIntrinsic(options, 'capture', options));
  const once: unknown = getIntrinsic(options, 'once', options);
  const passive: unknown = getIntrinsic(options, 'passive', options);
  const signal: unknown = getIntrinsic(options, 'signal', options);
  return {
    isCapture,
    nativeOptions: {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __proto__: options,
      capture: isCapture,
      once,
      passive,
      signal,
    },
  };
}
