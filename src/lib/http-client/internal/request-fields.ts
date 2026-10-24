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
import { describeValue } from '../../internal/describe-value';

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
    const requestURL: unknown = request.requestURL;
    // A string, as the type has it: an adapter driven directly with anything else - a
    // number, a `URL` object - threw a raw `TypeError` from wherever it was first read
    // as one (XHRAdapter's `startsWith`), or was sent as whatever it coerced to.
    if (typeof requestURL !== 'string') {
      throw new TypeError(
        `Adapter request requestURL must be a string (got ${describeValue(requestURL)})`,
      );
    }
    fields = {
      guardedUploadProgress: guardProgressCallback(
        request.onUploadProgress,
        'onUploadProgress',
      ),
      guardedDownloadProgress: guardProgressCallback(
        request.onDownloadProgress,
        'onDownloadProgress',
      ),
      requestURL,
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

/**
 * Whether the caller's `signal` has aborted, read as every adapter reads it: a getter
 * that throws is the caller's, refused as a non-retryable `adapter_error` rather than
 * escaping raw - and retried as a network failure - from whichever check reads it.
 */
export function isSignalAborted(
  signal: AbortSignal | undefined | null,
): boolean {
  if (signal === undefined || signal === null) {
    return false;
  }

  try {
    // Exactly `true`, as the standard types it: a boolean. A broken polyfill's `1` or
    // `'false'` is not taken for an abort - a `'false'` read as truthy cancelled a
    // request that never was.
    return signal.aborted === true;
  } catch (error) {
    throw nonRetryableAdapterErrorFrom(error);
  }
}

/**
 * Whether the caller's `signal` has aborted, for a failure path that is already
 * reporting something: a getter that throws reads as "not aborted", as NodeAdapter reads
 * it, so the failure in hand - a transport error, a body that broke after the status
 * arrived - is reported rather than replaced. Read the signal with
 * {@link isSignalAborted} before anything is dispatched, so a signal that cannot be read
 * at all is refused there.
 */
export function isSignalAbortedQuietly(
  signal: AbortSignal | undefined | null,
): boolean {
  try {
    return isSignalAborted(signal);
  } catch {
    return false;
  }
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
