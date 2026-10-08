import {
  reportCallbackError,
  runCallbackSafely,
} from '../safe-handle-callback';
import { isNullish } from './is-nullish';
import { isObjectLike } from './is-object-like';

type Wrapper = (this: unknown, event: unknown) => void;

/**
 * Make `signal`'s own `'abort'` listeners and `onabort` handler unable to throw out of a
 * dispatch: what they throw or reject with is reported on the standard `'error'` channel
 * (see `reportCallbackError`) under `label`, and the listeners after them still run.
 *
 * An `EventTarget` runs its listeners itself, so an error one throws never reaches the
 * code that dispatched the event - `abort()`'s caller. Node and Bun report it as an
 * uncaught exception instead, fatal to a process with no handler. This defines own
 * `addEventListener`, `removeEventListener` and `onabort` on the instance, which forward
 * to the native `EventTarget` methods:
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
 * Must be called on a signal nothing else has seen yet. Throws a `TypeError` if the
 * signal refuses installation of the guard.
 */
export function guardAbortListeners(signal: AbortSignal, label: string): void {
  const addListener = (target: unknown, args: unknown[]): void => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.apply(EventTarget.prototype.addEventListener, target, args);
  };
  const removeListener = (target: unknown, args: unknown[]): void => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.apply(EventTarget.prototype.removeEventListener, target, args);
  };
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
      wrappers = new WeakMap<object, Wrapper>();
      if (isCapture) {
        captureWrappers = wrappers;
      } else {
        bubbleWrappers = wrappers;
      }
    }
    const existing = wrappers.get(listener);
    if (existing !== undefined) {
      return existing;
    }
    const wrapper = wrapListener(listener, label, reportListenerError);
    wrappers.set(listener, wrapper);
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
    const wrapper = wrappers.get(listener);
    wrappers.delete(listener);
    return wrapper;
  };

  function addEventListener(this: unknown, ...args: unknown[]): void {
    // Another receiver, or too few arguments: exactly the native method's behavior.
    if (this !== signal || args.length < 2) {
      addListener(this, args);
      return;
    }
    const [type, listener, options] = args;
    // `ToString`, once, as the native method would - a symbol throws here as it would there.
    const typeString = `${type as string}`;
    // The DOM's no-op. Not handed to the native method, which in Bun and Node also
    // prints a warning that the call has no effect.
    if (isNullish(listener)) {
      return;
    }
    if (typeString !== 'abort' || !isObjectLike(listener)) {
      addListener(signal, [typeString, listener, options]);
      return;
    }
    const { isCapture, nativeOptions } = readAddOptions(options);
    addListener(signal, [
      typeString,
      wrapperFor(listener, isCapture),
      nativeOptions,
    ]);
  }

  function removeEventListener(this: unknown, ...args: unknown[]): void {
    if (this !== signal || args.length < 2) {
      removeListener(this, args);
      return;
    }
    const [type, listener, options] = args;
    const typeString = `${type as string}`;
    const isCapture = readCapture(options);
    // A listener this guard never wrapped may still have been added through the
    // prototype's method; removing it as itself reaches that registration.
    const registered =
      (typeString === 'abort' && isObjectLike(listener)
        ? takeWrapper(listener, isCapture)
        : undefined) ?? listener;
    removeListener(signal, [
      typeString,
      registered,
      // An object, not the boolean: Node's native removal ignores a boolean `true`.
      { capture: isCapture },
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
      removeListener(signal, ['abort', handlerWrapper, false]);
    } else if (handler !== null && !isHandlerRegistered) {
      isHandlerRegistered = true;
      addListener(signal, ['abort', handlerWrapper, false]);
    }
  };

  // Refusal is surfaced rather than leaving a signal apparently guarded.
  if (
    !Reflect.defineProperty(signal, 'addEventListener', {
      value: addEventListener,
      writable: true,
      enumerable: false,
      configurable: true,
    }) ||
    !Reflect.defineProperty(signal, 'removeEventListener', {
      value: removeEventListener,
      writable: true,
      enumerable: false,
      configurable: true,
    }) ||
    !Reflect.defineProperty(signal, 'onabort', {
      get: getOnabort,
      set: setOnabort,
      enumerable: false,
      configurable: true,
    })
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
      handleEvent = Reflect.get(listener, 'handleEvent', listener);
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
    ? Boolean(Reflect.get(options, 'capture', options))
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
  const isCapture = Boolean(Reflect.get(options, 'capture', options));
  const once: unknown = Reflect.get(options, 'once', options);
  const passive: unknown = Reflect.get(options, 'passive', options);
  const signal: unknown = Reflect.get(options, 'signal', options);
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
