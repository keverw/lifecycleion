/**
 * The most entries an array handed over to be copied may say it holds - a header value, a
 * trust store, an allowlist or a filter's list. Walked by index, a sparse array's length
 * is the cost, not its entries: `v.length = 2 ** 32 - 1` would hold the thread for
 * minutes, here and in every check of the copy after.
 */
export const MAX_COPIED_ARRAY_LENGTH = 2 ** 24;

/**
 * `array`'s length, refused with a `TypeError` naming `label` unless it is one an array
 * can have, and no more than `maxLength`. An array's own length always is one; a
 * `Proxy`'s is whatever its trap answers, and one that is not - `Infinity`, `1.5`, `'3'` -
 * would read on without end, past the list, or fail in the engine's own words.
 */
export function readArrayLength(
  array: readonly unknown[],
  label: string,
  maxLength = 2 ** 32 - 1,
): number {
  return assertArrayLength(array.length, label, maxLength);
}

/** `length` as {@link readArrayLength} holds an array's, for one already read. */
export function assertArrayLength(
  length: unknown,
  label: string,
  maxLength = 2 ** 32 - 1,
): number {
  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > 2 ** 32 - 1
  ) {
    throw new TypeError(`${label} has no array length`);
  }

  if (length > maxLength) {
    throw new TypeError(
      `${label} has a length over ${String(maxLength)} (got ${String(length)})`,
    );
  }

  return length;
}

/**
 * A test of whether `array` holds an own entry at an index: `in` where its prototype is
 * this realm's `Array.prototype`, which holds no index unless the realm's own built-ins
 * were changed - outside what this guards - and `Object.hasOwn` otherwise, so a hole a
 * prototype of the caller's fills stays a hole. Not `Object.hasOwn` throughout: on
 * JavaScriptCore it costs hundreds of times what `in` does per index.
 */
export function ownIndexTest(
  array: readonly unknown[],
): (index: number) => boolean {
  return Reflect.getPrototypeOf(array) === Array.prototype
    ? (index) => index in array
    : (index) => Object.hasOwn(array, index);
}

/**
 * A caller's array copied one level deep - its items, a nested object among them, kept as
 * they are - and any other value as it is. The rule for a caller's array a module keeps:
 * a header value, a trust store or a domain allowlist.
 *
 * By index, each item read once, so nothing of the caller's array is consulted: not its
 * own `constructor`, which `slice` builds the copy through, nor a `Symbol.iterator`, which
 * a spread runs. A hole stays a hole - one its prototype fills included, as only its own
 * entries are read - so a check that reads every index reads it as the `undefined` it is.
 * A length an array cannot have, or one over {@link MAX_COPIED_ARRAY_LENGTH}, is refused
 * (see {@link readArrayLength}).
 */
export function copyArrayValue<V>(value: V, label = 'A list'): V {
  if (!Array.isArray(value)) {
    return value;
  }

  const length = readArrayLength(value, label, MAX_COPIED_ARRAY_LENGTH);
  const copy: unknown[] = new Array(length);
  const hasIndex = ownIndexTest(value);
  for (let index = 0; index < length; index++) {
    if (hasIndex(index)) {
      copy[index] = value[index];
    }
  }

  return copy as V;
}
