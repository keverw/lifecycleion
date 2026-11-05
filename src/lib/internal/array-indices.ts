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
 * Whether `holes` holes met so far, with `entries` entries among them, are enough that the
 * rest of the array is read by its own keys (see {@link SPARSE_RUN}): counted over the whole
 * walk, not per run, so an entry every 1,000 indices is as sparse as one far-off entry.
 */
export function isMostlyHoles(holes: number, entries: number): boolean {
  return holes > SPARSE_RUN && holes > entries * SPARSE_RUN_PER_ENTRY;
}

/**
 * Whether `array` holds `index` as its own, for a walk that reads each entry as it goes:
 * told by `in` while its prototype, read now, is this realm's `Array.prototype` -
 * `Object.hasOwn` costs hundreds of times as much per index on a large array on
 * JavaScriptCore - and by `Object.hasOwn` otherwise. Any other prototype, one an entry
 * read a moment ago swapped in included, can answer `in` for a hole: an Array subclass's
 * or another realm's as much as any, since one that lists no index can still be a `Proxy`
 * whose `has` answers for every hole, and nothing here tells one apart.
 */
export function holdsOwnIndex(array: unknown[], index: number): boolean {
  return Reflect.getPrototypeOf(array) === Array.prototype
    ? index in array
    : Object.hasOwn(array, index);
}

/**
 * Runs `visit` for each index below `length` that `source` holds as its own, in order,
 * each told by `Object.hasOwn`. Past enough holes (see {@link isMostlyHoles}) the rest
 * are found from its own keys and each checked again as it is reached - an entry visited
 * before can have removed it - so a sparse array's length is not walked.
 */
export function forEachOwnIndex(
  source: unknown[],
  length: number,
  visit: (index: number) => void,
): void {
  let holes = 0;
  let entries = 0;

  for (let index = 0; index < length; index++) {
    if (Object.hasOwn(source, index)) {
      entries++;
      visit(index);
      continue;
    }

    if (isMostlyHoles(++holes, entries)) {
      for (const at of indicesFrom(source, index + 1, length)) {
        if (Object.hasOwn(source, at)) {
          visit(at);
        }
      }
      return;
    }
  }
}

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
