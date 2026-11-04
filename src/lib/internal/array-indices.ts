/**
 * How many holes an array is walked through index by index, at the least, before the rest
 * of it is read by its own keys instead: a dense array never reaches it, and one item at
 * index 100,000,000 - or one every 65,536 indices - is not as many steps.
 */
export const SPARSE_RUN = 65_536;

/**
 * How many holes, per entry already read, it takes past {@link SPARSE_RUN}: listing an
 * array's keys costs a string for every entry it holds, many times a step, so an array
 * mostly full is walked on through its holes rather than listed.
 */
export const SPARSE_RUN_PER_ENTRY = 64;

/**
 * The array indices `source` holds as its own from `start` up to `length`, in order:
 * every own key, enumerable or not, that is an index - not a named key, nor one that
 * only reads like a number (`'1.5'`, `'01'`).
 */
export function indicesFrom(
  source: unknown[],
  start: number,
  length: number,
): number[] {
  const indices: number[] = [];

  for (const key of Object.getOwnPropertyNames(source)) {
    const index = Number(key);

    if (
      index >>> 0 === index &&
      String(index) === key &&
      index >= start &&
      index < length
    ) {
      indices.push(index);
    }
  }

  return indices.sort((left, right) => left - right);
}
