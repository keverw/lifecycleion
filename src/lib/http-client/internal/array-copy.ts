import { defineEntry } from '../../internal/define-entry';

/**
 * A caller's array copied one level deep - its items, a nested object among them, kept as
 * they are - and any other value as it is. The rule for a caller's array the client
 * keeps: a header value or a trust store (a `.params()` array is copied as `qs` reads it -
 * see `copyParamArrayValue`).
 *
 * By index, each item read once, so nothing of the caller's array is consulted: not its
 * own `constructor`, which `slice` builds the copy through, nor a `Symbol.iterator`, which
 * a spread runs. A hole stays a hole, so a check that reads every index reads it as the
 * `undefined` it is.
 */
export function copyArrayValue<V>(value: V): V {
  if (!Array.isArray(value)) {
    return value;
  }

  const length = value.length;
  const copy: unknown[] = new Array(length);
  for (let index = 0; index < length; index++) {
    if (index in value) {
      copy[index] = value[index];
    }
  }

  return copy as V;
}

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
