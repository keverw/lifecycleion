/**
 * `array`'s length, refused with a `TypeError` naming `label` unless it is one an array
 * can have. An array's own length always is; a `Proxy`'s is whatever its trap answers, and
 * one that is not - `Infinity`, `1.5`, `'3'` - would read on without end, past the list,
 * or fail in the engine's own words.
 */
export function readArrayLength(
  array: readonly unknown[],
  label: string,
): number {
  const length: unknown = array.length;

  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > 2 ** 32 - 1
  ) {
    throw new TypeError(`${label} has no array length`);
  }

  return length;
}

/**
 * A caller's array copied one level deep - its items, a nested object among them, kept as
 * they are - and any other value as it is. The rule for a caller's array a module keeps:
 * a header value, a trust store or a domain allowlist.
 *
 * By index, each item read once, so nothing of the caller's array is consulted: not its
 * own `constructor`, which `slice` builds the copy through, nor a `Symbol.iterator`, which
 * a spread runs. A hole stays a hole, so a check that reads every index reads it as the
 * `undefined` it is. A length an array cannot have is refused (see `readArrayLength`).
 */
export function copyArrayValue<V>(value: V, label = 'A list'): V {
  if (!Array.isArray(value)) {
    return value;
  }

  const length = readArrayLength(value, label);
  const copy: unknown[] = new Array(length);
  for (let index = 0; index < length; index++) {
    if (index in value) {
      copy[index] = value[index];
    }
  }

  return copy as V;
}
