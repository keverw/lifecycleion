import { defineEntry } from '../../internal/define-entry';

// The rule for a caller's array the client keeps - a header value or a trust store - is
// shared with the domain matchers' allowlists. A `.params()` array is copied as `qs`
// reads it instead (see `copyParamArrayValue`).
export { copyArrayValue } from '../../internal/array-copy';

/**
 * A `.params()` array value copied one level deep as `qs` reads it: every own enumerable
 * key, each read once - an index, or a name set on the array (`a[extra]=y`) - so the copy
 * serializes as the caller's array would have. A hole is not a key, so it stays a hole.
 */
export function copyParamArrayValue<V>(value: V): V {
  if (!Array.isArray(value)) {
    return value;
  }

  const source = value as unknown as Record<string, unknown>;
  const copy = [] as unknown as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    defineEntry(copy, key, source[key]);
  }

  return copy as V;
}
