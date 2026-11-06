import { readUnknownMember } from '../../internal/read-member';
import type { AdapterRequest } from '../types';

/**
 * Puts `listener` on `request` under `key`: how `HTTPClient` hands `NodeAdapter` a
 * listener that is no field of `AdapterRequest`. Under a `Symbol.for` key, so a
 * `NodeAdapter` from another bundle finds it, and not enumerable, so an adapter that
 * spreads the request into a new object does not carry it on.
 */
export function setHiddenRequestListener(
  request: AdapterRequest,
  key: symbol,
  listener: (...args: never[]) => void,
): void {
  Object.defineProperty(request, key, {
    value: listener,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * The listener on `request` under `key`, if it carries one. Read through a guarded
 * accessor: a request an adapter is driven with directly is the caller's, and a getter
 * that throws there means no listener rather than a failed send.
 */
export function readHiddenRequestListener<
  Listener extends (...args: never[]) => void,
>(request: AdapterRequest, key: symbol): Listener | undefined {
  const listener = readUnknownMember(request, key);

  return typeof listener === 'function' ? (listener as Listener) : undefined;
}

/**
 * Tells `listener` `args`. One that throws - one a caller driving the adapter directly
 * put on its request - is ignored: what it is told is a hint to the client, and its
 * failure must not fail the adapter work that told it.
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
  } catch {
    // See above.
  }
}
