import { STREAM_FAILURE_SETTLED_LISTENER_KEY } from '../consts';
import { readUnknownMember } from '../../internal/read-member';
import type { AdapterRequest } from '../types';

/** Told that the adapter has settled a stream failure, before it fires the factory's signal. */
export type StreamFailureSettledListener = () => void;

/**
 * Hands the adapter `request` is sent through a listener for the moment it settles a
 * failure of a stream its `streamResponse` factory started - the sink failing, the
 * response failing during setup or mid-body, the factory throwing or returning
 * something it should not - under {@link STREAM_FAILURE_SETTLED_LISTENER_KEY}.
 *
 * Not a field of `AdapterRequest`: it is how `HTTPClient` hears that `NodeAdapter`
 * settled the failure first, so a cancel a cleanup listener on the factory's signal
 * makes once it fires does not stand in for that failure, and no other adapter has a
 * use for it. Not told for a factory's own decline, nor for a cancel or a timeout. Under
 * a `Symbol.for` key, so a `NodeAdapter` from another bundle finds it, and not
 * enumerable, so an adapter that spreads the request into a new object does not carry
 * it on. An adapter that calls it only touches its own requests.
 */
export function listenForStreamFailureSettled(
  request: AdapterRequest,
  listener: StreamFailureSettledListener,
): void {
  Object.defineProperty(request, STREAM_FAILURE_SETTLED_LISTENER_KEY, {
    value: listener,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * The stream-failure listener on `request`, if it carries one. Read through a guarded
 * accessor: a request an adapter is driven with directly is the caller's, and a getter
 * that throws there means no listener rather than a failed send.
 */
export function readStreamFailureSettledListener(
  request: AdapterRequest,
): StreamFailureSettledListener | undefined {
  const listener = readUnknownMember(
    request,
    STREAM_FAILURE_SETTLED_LISTENER_KEY,
  );

  return typeof listener === 'function'
    ? (listener as StreamFailureSettledListener)
    : undefined;
}

/**
 * Tells `listener` the stream failure is settled. One that throws - one a caller driving
 * the adapter directly put on its request - is ignored: the failure is settled whatever
 * it does, and the teardown that follows must still run.
 */
export function notifyStreamFailureSettled(
  listener: StreamFailureSettledListener | undefined,
): void {
  if (listener === undefined) {
    return;
  }

  try {
    Reflect.apply(listener, undefined, []);
  } catch {
    // See above.
  }
}
