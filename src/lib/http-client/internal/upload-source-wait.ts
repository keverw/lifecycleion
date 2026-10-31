import { UPLOAD_SOURCE_WAIT_LISTENER_KEY } from '../consts';
import { readUnknownMember } from '../../internal/read-member';
import type { AdapterRequest } from '../types';

/** Told `true` when a body writer parks on its source, and `false` when it comes back. */
export type UploadSourceWaitListener = (isWaiting: boolean) => void;

/**
 * Hands the adapter `request` is sent through a listener for the source waits of its
 * upload, under {@link UPLOAD_SOURCE_WAIT_LISTENER_KEY}.
 *
 * Not a field of `AdapterRequest`: it is how `HTTPClient` hears that `NodeAdapter`'s
 * multipart writer is parked on a `Blob.stream()` read rather than stalled, for the wait
 * on that upload before the next dispatch (see `settleUploadBeforeNextDispatch`), and no
 * other adapter has a use for it. Under a `Symbol.for` key, so a `NodeAdapter` from
 * another bundle finds it, and not enumerable, so an adapter that spreads the request
 * into a new object does not carry it on - its source waits count as silence.
 *
 * Any adapter can still read it and say it is waiting, and that only touches its own
 * author's requests. The client does not take the word unbounded either: a source wait
 * counts as activity for at most `UPLOAD_SOURCE_STALL_GRACE_MS`, the grace `NodeAdapter`
 * gives one itself, so an adapter that says it is waiting and never says it is done
 * still has its upload wait end. Saying it is done is activity, as an upload-progress
 * report is, and a report is something any adapter could already make as often as it
 * liked.
 */
export function listenForUploadSourceWait(
  request: AdapterRequest,
  listener: UploadSourceWaitListener,
): void {
  Object.defineProperty(request, UPLOAD_SOURCE_WAIT_LISTENER_KEY, {
    value: listener,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * The source-wait listener on `request`, if it carries one. Read through a guarded
 * accessor: a request an adapter is driven with directly is the caller's, and a getter
 * that throws there means no listener rather than a failed send.
 */
export function readUploadSourceWaitListener(
  request: AdapterRequest,
): UploadSourceWaitListener | undefined {
  const listener = readUnknownMember(request, UPLOAD_SOURCE_WAIT_LISTENER_KEY);

  return typeof listener === 'function'
    ? (listener as UploadSourceWaitListener)
    : undefined;
}

/**
 * Tells `listener` whether the writer is waiting on its source. A listener that throws -
 * one a caller driving the adapter directly put on its request - is ignored: what it is
 * told is a hint about the upload, and its failure changes nothing about how the upload
 * goes, so it must not fail the writer that told it.
 */
export function notifyUploadSourceWait(
  listener: UploadSourceWaitListener | undefined,
  isWaiting: boolean,
): void {
  if (listener === undefined) {
    return;
  }

  try {
    Reflect.apply(listener, undefined, [isWaiting]);
  } catch {
    // See above: nothing to fail, and nowhere the writer could report it to.
  }
}
