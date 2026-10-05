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
 */
export function copyBoundedArray(
  array: readonly unknown[],
  maxLength: number,
  refuse: (length: number) => Error,
): unknown[] {
  const length = Number(Reflect.get(array, 'length'));

  if (!Number.isInteger(length) || length < 0 || length > maxLength) {
    throw refuse(length);
  }

  const copy: unknown[] = [];
  for (let index = 0; index < length; index++) {
    copy[index] = Reflect.get(array, index);
  }
  return copy;
}
