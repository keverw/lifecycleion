import {
  ADAPTER_ERROR_CARRIER_KEY,
  NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
} from '../consts';
import { readUnknownMember as readObjectMember } from '../../internal/read-member';

/**
 * A non-retryable adapter error for a failure that may be the caller's own error - one a
 * route, a body's `toJSON` or a header value's `toString` threw. A fresh carrier, with
 * that error on `cause` (which the client reports), rather than the flag defined on the
 * caller's object: there it stayed for good, so the same object thrown later by an
 * adapter's `send()` was read as non-retryable, and it showed up in `serializeError`.
 */
export function nonRetryableAdapterErrorFrom(error: unknown): Error {
  const message = readObjectMember(error, 'message');
  const carrier = new Error(
    typeof message === 'string' && message.length > 0
      ? message
      : 'Adapter failure',
    { cause: error },
  );
  const name = readObjectMember(error, 'name');

  if (typeof name === 'string') {
    carrier.name = name;
  }

  Object.defineProperty(carrier, ADAPTER_ERROR_CARRIER_KEY, { value: true });
  markNonRetryableAdapterError(carrier);

  return carrier;
}

/**
 * Tag a terminal adapter configuration failure so `HTTPClient` reports it as a
 * non-retryable `adapter_error` rather than retrying it as a network error.
 */
export function markNonRetryableAdapterError(error: unknown): void {
  try {
    Object.defineProperty(error, NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG, {
      value: true,
    });
  } catch {
    // Not an object, or one that refuses the property; it is retried as before.
  }
}

/**
 * Define `tags` on `target` as own, non-enumerable data properties: read back by name
 * (`readObjectMember`), but left out of `JSON.stringify`, `Object.keys` and spreads.
 * Throws as `Object.defineProperty` does on a frozen or sealed target.
 */
export function defineHiddenTags(
  target: object,
  tags: Record<PropertyKey, unknown>,
): void {
  // `Reflect.ownKeys`, not `Object.entries`: the header-carrying tags are symbols.
  for (const key of Reflect.ownKeys(tags)) {
    Object.defineProperty(target, key, {
      value: tags[key],
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
