import { readHiddenMember, setHiddenMember } from './hidden-member';
import { reportCallbackError } from '../../safe-handle-callback';
import type { AdapterRequest } from '../types';

/** Puts `listener` on `request` under `key` (see `setHiddenMember`). */
export function setHiddenRequestListener(
  request: AdapterRequest,
  key: symbol,
  listener: (...args: never[]) => void,
): void {
  setHiddenMember(request, key, listener);
}

/** The listener on `request` under `key`, if it carries one (see `readHiddenMember`). */
export function readHiddenRequestListener<
  Listener extends (...args: never[]) => void,
>(request: AdapterRequest, key: symbol): Listener | undefined {
  const listener = readHiddenMember(request, key);

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
