/**
 * Copy a caller's array by index, reading its `length` once and bounding it before the
 * loop.
 *
 * The array is caller data: a subclass or proxy passes `Array.isArray` and runs its own
 * code for every read, and can report any `length` - `Infinity` or `5e7` would block the
 * event loop in the copy, with no timeout to rescue it. A length that is not a
 * non-negative integer no greater than `maxLength` is refused with `refuse(length)`,
 * which the caller builds so the refusal travels on its own channel (a returned read
 * error, a branded option refusal). Entries are copied as they are; validating them is
 * the caller's.
 *
 * Only a `number` length is accepted: it is never coerced. Coercion is more caller code -
 * `Number()` throws for a symbol, and runs an object's `valueOf` - and a throw there
 * would escape the refusal and reach the caller as a crash instead. `refuse` is handed a
 * description that is safe to build for any value.
 */
export function copyBoundedArray(
  array: readonly unknown[],
  maxLength: number,
  refuse: (length: string) => Error,
): unknown[] {
  const length: unknown = Reflect.get(array, 'length');

  if (
    typeof length !== 'number' ||
    !Number.isInteger(length) ||
    length < 0 ||
    length > maxLength
  ) {
    throw refuse(describeLength(length));
  }

  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    copy[index] = Reflect.get(array, index);
  }
  return copy;
}

/** Numbers by value; anything else by type - `String()` throws for some values. */
function describeLength(length: unknown): string {
  return typeof length === 'number'
    ? String(length)
    : `a non-number (${length === null ? 'null' : typeof length})`;
}
