import { forEachOwnIndex, SPARSE_RUN } from './array-indices';

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

/** The refusals {@link assertArrayLength} raised, told from a throw out of caller code. */
const lengthRefusals = new WeakSet<Error>();

/**
 * Whether `error` is a length refusal of {@link readArrayLength} or
 * {@link assertArrayLength}, rather than a throw from the caller's own `length` getter or
 * `Proxy` trap read alongside it.
 */
export function isArrayLengthRefusal(error: unknown): error is TypeError {
  return error instanceof Error && lengthRefusals.has(error);
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
    throw refusal(new TypeError(`${label} has no array length`));
  }

  if (length > maxLength) {
    throw refusal(
      new TypeError(
        `${label} has a length over ${String(maxLength)} (got ${String(length)})`,
      ),
    );
  }

  return length;
}

function refusal(error: TypeError): TypeError {
  lengthRefusals.add(error);
  return error;
}

/**
 * A caller's array copied one level deep - its items, a nested object among them, kept as
 * they are - and any other value as it is. The rule for a caller's array a module keeps:
 * a header value, a trust store or a domain allowlist.
 *
 * By index, each item read once, so nothing of the caller's array is consulted: not its
 * own `constructor`, which `slice` builds the copy through, nor a `Symbol.iterator`, which
 * a spread runs. A hole stays a hole - one an Array subclass's or other prototype fills
 * included, as only its own entries are read; this realm's `Array.prototype` and
 * `Object.prototype` are taken as filling none (see {@link forEachOwnIndex}) - so a check
 * that reads every index reads it as the `undefined` it is.
 * Past enough holes the rest are read by its own keys (see {@link forEachOwnIndex}), and a
 * copy longer than {@link SPARSE_RUN} holds only the entries it was given: V8 allocates
 * `new Array(length)` whole, as JavaScriptCore does, so one entry in a list at the copy cap
 * would cost 128 MiB.
 * A length an array cannot have, or one over {@link MAX_COPIED_ARRAY_LENGTH}, is refused
 * (see {@link readArrayLength}).
 */
export function copyArrayValue<V>(value: V, label = 'A list'): V {
  if (!Array.isArray(value)) {
    return value;
  }

  const source: unknown[] = value;
  const length = readArrayLength(source, label, MAX_COPIED_ARRAY_LENGTH);
  const copy: unknown[] = length <= SPARSE_RUN ? new Array(length) : [];
  forEachOwnIndex(source, length, (index) => {
    copy[index] = source[index];
  });

  // Lengthened past its last entry by writing one index beyond, then cut back: a length
  // set on its own makes V8 allocate the holes up to it, where an index written far past
  // the last makes the array a sparse one first.
  if (copy.length < length) {
    copy[length] = undefined;
    copy.length = length;
  }

  return copy as V;
}
