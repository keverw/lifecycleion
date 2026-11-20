import { readUnknownMember } from '../../internal/read-member';
import { reportCallbackError } from '../../safe-handle-callback';
import type { AdapterRequest } from '../types';

/**
 * Puts `value` on `target` under `key`: how `HTTPClient` and its adapters hand each other
 * what is no field of the public types - a mark on an adapter, a listener or a mark on a
 * request. Under a `Symbol.for` key, so a copy of the code from another bundle finds it,
 * and not enumerable, so it is not listed among the target's own fields, and an adapter
 * that spreads a request into a new object does not carry it on. Read back through
 * `readUnknownMember`: an adapter or request may be the caller's, and a getter that throws
 * there means none rather than a failed send.
 */
export function setHiddenMember(
  target: object,
  key: symbol,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** The listener on `request` under `key`, if it carries one (see `setHiddenMember`). */
export function readHiddenRequestListener<
  Listener extends (...args: never[]) => void,
>(request: AdapterRequest, key: symbol): Listener | undefined {
  const listener = readUnknownMember(request, key);

  return typeof listener === 'function' ? (listener as Listener) : undefined;
}

/** The listeners whose throw has been reported; see `notifyHiddenRequestListener`. */
const reportedListeners = new WeakSet<object>();

/**
 * Tells `listener` `args`. One that throws - one a caller driving the adapter directly
 * put on its request - does not fail the adapter work that told it, as what it is told is
 * a hint to the client. Its first throw is reported (see `reportCallbackError`), so a
 * listener that failed partway is not silent; later ones are not, as one told of every
 * source wait would report each.
 */
export function notifyHiddenRequestListener<Args extends unknown[]>(
  listener: ((...args: Args) => void) | undefined,
  ...args: Args
): void {
  if (listener === undefined) {
    return;
  }

  try {
    Reflect.apply(listener, undefined, args);
  } catch (error) {
    if (!reportedListeners.has(listener)) {
      reportedListeners.add(listener);
      reportCallbackError('hidden request listener', error);
    }
  }
}
