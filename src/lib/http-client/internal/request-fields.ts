import type { AdapterRequest } from '../types';
import { guardProgressCallback } from './progress';
import { nonRetryableAdapterErrorFrom } from './adapter-error';
import { presentHeaderValue } from './header-utils';
import { isPlainRecord } from './plain-record';
import { defineEntry } from '../../internal/define-entry';
import { isNullish } from '../../internal/is-nullish';
import { describeValue } from '../../internal/describe-value';

/**
 * The request fields the Fetch, XHR and Mock adapters read, each read once, before
 * anything is sent. Their event listeners and route handling read them again otherwise,
 * where a getter that throws is an uncaught exception and a request that never settles.
 *
 * Read on a carrier: a getter that throws is the caller's, refused as a non-retryable
 * `adapter_error` rather than retried as a network failure. The method is left as given,
 * for `readAdapterMethod`, and the limit for `readMaxResponseBytes`, which refuse their
 * own way.
 *
 * - The progress callbacks are guarded here, so every call site is covered: progress
 *   reporting is advisory and must not be able to change whether a request succeeded
 *   (see `guardProgressCallback`).
 * - The headers are copied by {@link copyRequestHeaders}.
 */
export function readAdapterRequestFields(request: AdapterRequest) {
  try {
    return {
      guardedUploadProgress: guardProgressCallback(
        request.onUploadProgress,
        'onUploadProgress',
      ),
      guardedDownloadProgress: guardProgressCallback(
        request.onDownloadProgress,
        'onDownloadProgress',
      ),
      requestURL: request.requestURL,
      initialURL: request.initialURL,
      givenMethod: request.method as unknown,
      headers: copyRequestHeaders(request.headers),
      body: request.body,
      signal: request.signal,
    };
  } catch (error) {
    throw nonRetryableAdapterErrorFrom(error);
  }
}

/**
 * A request's headers as every adapter sends them: each value read once and converted
 * (see `presentHeaderValue`), an unset one dropped, names kept as given. Read here, so a
 * value's `toString` that throws throws now, and the copy reaches no getter of the
 * caller's later.
 *
 * No headers (`undefined` or `null`) is none. A record that is not a plain object is
 * refused with a `TypeError`: a `Headers` or `Map` keeps its entries off its own
 * properties, and read as one it sent none of them.
 */
export function copyRequestHeaders(
  headers: unknown,
): Record<string, string | string[]> {
  const copy: Record<string, string | string[]> = {};

  if (isNullish(headers)) {
    return copy;
  }

  if (!isPlainRecord(headers)) {
    throw new TypeError(
      `Adapter request headers must be a plain object of header names to values (got ${describeValue(headers)})`,
    );
  }

  for (const [name, value] of Object.entries(headers)) {
    const present = presentHeaderValue(value);
    if (present !== undefined) {
      defineEntry(copy, name, present);
    }
  }

  return copy;
}
