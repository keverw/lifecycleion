import { NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG } from '../consts';

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
  tags: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(tags)) {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}
