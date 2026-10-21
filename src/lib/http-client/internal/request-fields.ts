import type { AdapterRequest } from '../types';
import { guardProgressCallback } from './progress';
import {
  nonRetryableAdapterErrorFrom,
  readAdapterMethod,
} from './adapter-error';
import { readMaxResponseBytes } from './response-limit';
import { presentHeaderValue } from './header-utils';
import { assertOptionalHeaderRecord } from './plain-record';
import { defineEntry } from '../../internal/define-entry';
import { isNullish } from '../../internal/is-nullish';

/**
 * The request fields every adapter reads, each read once, before anything is sent. Their
 * event listeners and route handling read them again otherwise, where a getter that
 * throws is an uncaught exception and a request that never settles.
 *
 * Read on a carrier: a getter that throws is the caller's, refused as a non-retryable
 * `adapter_error` rather than retried as a network failure. Then the method and the limit
 * are read by their own rules (`readAdapterMethod`, `readMaxResponseBytes`), which refuse
 * their own way.
 *
 * - The progress callbacks are guarded here, so every call site is covered: progress
 *   reporting is advisory and must not be able to change whether a request succeeded
 *   (see `guardProgressCallback`).
 * - The headers are copied by {@link copyRequestHeaders}: the copy is the adapter's own.
 */
export function readAdapterRequestFields(request: AdapterRequest) {
  // As given, read with the rest; only its conversion below is handed back.
  let givenMethod: unknown;
  let fields;
  try {
    givenMethod = request.method;
    fields = {
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
      headers: copyRequestHeaders(request.headers),
      body: request.body,
      signal: request.signal,
    };
  } catch (error) {
    throw nonRetryableAdapterErrorFrom(error);
  }

  return {
    ...fields,
    method: readAdapterMethod(givenMethod),
    // The most a buffered body may hold; `Infinity` for none.
    maxResponseBytes: readMaxResponseBytes(request),
  };
}

export type AdapterRequestFields = ReturnType<typeof readAdapterRequestFields>;

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
  assertOptionalHeaderRecord(headers, 'Adapter request headers');

  if (isNullish(headers)) {
    return copy;
  }

  for (const [name, value] of Object.entries(headers)) {
    const present = presentHeaderValue(value);
    if (present !== undefined) {
      defineEntry(copy, name, present);
    }
  }

  return copy;
}
