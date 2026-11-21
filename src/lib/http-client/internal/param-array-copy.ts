import { defineEntry } from '../../internal/define-entry';

/**
 * A `.params()` array value copied one level deep as `qs` reads it: every own enumerable
 * key, each read once - an index, or a name set on the array (`a[extra]=y`) - so the copy
 * serializes as the caller's array would have, in the order it lists them (see
 * {@link inKeyOrder}). A hole is not a key, so it stays a hole.
 */
export function copyParamArrayValue<V>(value: V): V {
  if (!Array.isArray(value)) {
    return value;
  }

  const source = value as unknown as Record<string, unknown>;
  const keys = Object.keys(source);
  const copy = [] as unknown as Record<string, unknown>;
  for (const key of keys) {
    defineEntry(copy, key, source[key]);
  }

  return inKeyOrder(copy, keys) as V;
}

/**
 * `copy`, an object or array just filled with `keys` in turn, listing them in that order:
 * itself when it already does, as it does unless `keys` puts an index after a name or
 * after a larger index - a `Proxy` may list its own that way, while an ordinary object
 * lists its index keys first, in ascending order - and otherwise a `Proxy` over it that
 * lists them so, as `qs` would have read the source.
 */
export function inKeyOrder<T extends object>(
  copy: T,
  keys: readonly string[],
): T {
  const listed = Object.keys(copy);
  if (listed.every((key, index) => key === keys[index])) {
    return copy;
  }

  // An array's `length`, which it holds as its own and cannot let go, must be listed too;
  // it is not enumerable, so `qs` still writes no entry for it.
  const ownKeys = Array.isArray(copy) ? [...keys, 'length'] : keys;
  return new Proxy(copy, { ownKeys: () => ownKeys });
}
