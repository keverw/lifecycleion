import { defineEntry } from '../../internal/define-entry';

/**
 * Copy a registration list with an indexed loop. Spread and `for...of` go through
 * `Array.prototype[Symbol.iterator]`, which application code can replace; an indexed
 * read of a manager-owned array cannot be redirected that way. Each entry is defined
 * rather than assigned: the copy starts holey, so an assignment would reach an index
 * setter added to `Array.prototype`.
 */
export function copyRegistrations<T>(source: readonly T[]): T[] {
  // A literal avoids consulting the replaceable global Array constructor.
  const copy: T[] = [];
  copy.length = source.length;
  const entries = copy as unknown as Record<string, T>;

  // eslint-disable-next-line unicorn/no-for-loop
  for (let index = 0; index < source.length; index++) {
    defineEntry(entries, index, source[index]);
  }

  return copy;
}
