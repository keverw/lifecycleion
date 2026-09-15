import type { AdapterProgressEvent } from '../types';
import { safeHandleCallback } from '../../safe-handle-callback';

/**
 * Wrap a caller's progress callback so a throw from it cannot be mistaken for a transport
 * failure.
 *
 * `onUploadProgress` and `onDownloadProgress` are invoked from inside the adapters' stream
 * handlers, and were called bare. A throw there did not vanish - it propagated out and the
 * adapter classified it as an `adapter_error`, so the caller was told their request had a
 * network problem when in fact their own progress callback had a bug. That is a worse
 * outcome than silence in one specific way: silence leaves you looking, and a
 * misclassification points you somewhere there is nothing to find.
 *
 * Progress reporting is advisory - it never decides whether a request succeeded - so a
 * failing callback must not be able to change the result. The failure goes to the standard
 * global `'error'` channel, where `safeHandleCallback` already sends every other
 * caller-callback failure, and the transfer carries on.
 *
 * The same rule applies to every other purely observational hook, and `onAttemptStart` /
 * `onAttemptEnd` were worse than these: a throw from one of those took the request down to
 * `status: 0` and reported nothing at all.
 *
 * @returns A guarded callback, or `undefined` when the caller supplied none, so the
 *          `?.()` call sites downstream stay exactly as they were.
 */
export function guardProgressCallback(
  callback: ((event: AdapterProgressEvent) => void) | undefined | null,
  label: string,
): ((event: AdapterProgressEvent) => void) | undefined {
  // `== null`, so `null` is "none" as well as `undefined`. The bare `?.()` call sites this
  // replaced skipped a `null` hook exactly as they skipped an absent one, and narrowing the
  // check to `undefined` turned that silent no-op into a `safeHandleCallback` report of a
  // non-function on the global `'error'` channel - once per progress event, for a JavaScript
  // caller who simply passed `null`. `BaseHTTPClient` normalizes falsy hooks before they
  // reach here, so this is the direct-adapter path, but the doc above says "when the caller
  // supplied none" and `null` is that.
  if (callback === undefined || callback === null) {
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
