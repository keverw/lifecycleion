import type { AdapterProgressEvent } from '../types';
import { safeHandleCallback } from '../../safe-handle-callback';
import { readBinaryByteLength } from '../../internal/binary-view';
import { utf8ByteLength } from './utf8-length';
import { isNullish } from '../../internal/is-nullish';

/**
 * Wrap a caller's progress callback so a throw from it cannot be mistaken for a transport
 * failure.
 *
 * `onUploadProgress` and `onDownloadProgress` are invoked from inside the adapters' stream
 * handlers. Called bare, a throw there would not vanish - it would propagate out and the
 * adapter would classify it as an `adapter_error`, telling the caller their request had a
 * network problem when in fact their own progress callback had a bug. That is a worse
 * outcome than silence in one specific way: silence leaves you looking, and a
 * misclassification points you somewhere there is nothing to find.
 *
 * Progress reporting is advisory - it never decides whether a request succeeded - so a
 * failing callback must not be able to change the result. The failure goes to the standard
 * global `'error'` channel, where `safeHandleCallback` already sends every other
 * caller-callback failure, and the transfer carries on.
 *
 * The same rule applies to every other purely observational hook, `onAttemptStart` /
 * `onAttemptEnd` included: unguarded, a throw from one of those would take the request down
 * to `status: 0` and report nothing at all.
 *
 * @returns A guarded callback, or `undefined` when the caller supplied none, so the
 *          call sites downstream stay plain `?.()` calls.
 */
export function guardProgressCallback(
  callback: ((event: AdapterProgressEvent) => void) | undefined | null,
  label: string,
): ((event: AdapterProgressEvent) => void) | undefined {
  // `null` is none too, not a non-function to report on every progress event.
  if (isNullish(callback)) {
    return undefined;
  }

  return (event: AdapterProgressEvent): void => {
    // `safeHandleCallback`, not a local `try`/`catch`. A hand-rolled guard catches a
    // synchronous throw and misses the other half: a callback declared `async`, or one
    // that returns a rejected promise, sails straight past it and becomes an unhandled
    // rejection. This is the one place in the library that knows how to invoke somebody
    // else's function, and it covers a non-function, a throw and a rejection alike.
    safeHandleCallback(label, callback, event);
  };
}

/**
 * The byte size of a request body as the browser adapters can know it without reading it:
 * `0` for no body, the encoded length of a string, a binary body's `byteLength`, a `Blob`'s
 * `size`, and `undefined` when it cannot be known up front (a `FormData`, a stream). Their
 * terminal upload event reports it, so `loaded` / `total` mean bytes, as on NodeAdapter,
 * rather than a stand-in `1`.
 */
export function knownBodyByteLength(body: unknown): number | undefined {
  if (isNullish(body)) {
    return 0;
  }

  if (typeof body === 'string') {
    return utf8ByteLength(body);
  }

  if (typeof body !== 'object') {
    return undefined;
  }

  // Bytes by their internal slot, as the response limit measures them: a buffer of any
  // kind, from any realm, at its real size rather than the one it reports.
  const byteLength = readBinaryByteLength(body);
  if (byteLength !== null) {
    return byteLength;
  }

  // Guarded: the body is the caller's, and a Proxy whose `getPrototypeOf` throws would
  // make this `instanceof` check throw from inside an XHR event listener - an uncaught
  // exception on the global channel rather than a size that cannot be known.
  try {
    if (typeof Blob !== 'undefined' && body instanceof Blob) {
      return body.size;
    }
  } catch {
    // Unknowable, as for a body of another kind.
  }

  return undefined;
}

/** The terminal progress event for a transfer of `byteLength` bytes, or of unknown size. */
export function completeProgressEvent(byteLength: number | undefined): {
  loaded: number;
  total: number;
  progress: 1;
} {
  const bytes = byteLength ?? 0;

  return { loaded: bytes, total: bytes, progress: 1 };
}
