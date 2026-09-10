import type { AdapterProgressEvent } from '../types';
import { reportCallbackError } from '../../safe-handle-callback';

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
 * failing callback must not be able to change the result. It is reported on the standard
 * global `'error'` channel, where `safeHandleCallback` already sends every other
 * caller-callback failure, and the transfer carries on.
 *
 * @returns A guarded callback, or `undefined` when the caller supplied none, so the
 *          `?.()` call sites downstream stay exactly as they were.
 */
export function guardProgressCallback(
  callback: ((event: AdapterProgressEvent) => void) | undefined,
  label: string,
): ((event: AdapterProgressEvent) => void) | undefined {
  if (callback === undefined) {
    return undefined;
  }

  return (event: AdapterProgressEvent): void => {
    try {
      callback(event);
    } catch (error) {
      reportCallbackError(label, error);
    }
  };
}
