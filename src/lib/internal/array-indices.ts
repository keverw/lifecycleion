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
 * Runs `visit` for each index below `length` that `source` holds as its own, in order,
 * each told by `Object.hasOwn`. Past a long run of holes (see {@link SPARSE_RUN}) the rest
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

    if (++holes > SPARSE_RUN && holes > entries * SPARSE_RUN_PER_ENTRY) {
      for (const at of indicesFrom(source, index + 1, length)) {
        if (Object.hasOwn(source, at)) {
          visit(at);
        }
      }
      return;
    }
  }
}

/** The most prototypes {@link inheritsNoIndices} reads before it answers no. */
const MAX_PROTOTYPE_DEPTH = 64;

/** Whether `key` is an array index: a canonical integer string below `2 ** 32 - 1`. */
function isIndexKey(key: string | symbol): boolean {
  if (typeof key !== 'string') {
    return false;
  }

  const index = Number(key);
  return (
    index >>> 0 === index && index !== 2 ** 32 - 1 && String(index) === key
  );
}

/**
 * Whether no prototype `array` inherits from holds an index of its own as it stands now -
 * an Array subclass's prototype or another realm's `Array.prototype` as much as this
 * realm's, which with `Object.prototype` is taken as holding none. When it is so, `in`
 * tells the indices `array` holds as its own, at a small part of `Object.hasOwn`'s cost on
 * a large array on JavaScriptCore - for an estimate only: a `Proxy` prototype answers
 * `has` as its trap does, whatever keys it lists, so a copy reads by `Object.hasOwn`. A
 * chain that cannot be read, or one over 64 deep, is answered no.
 */
export function inheritsNoIndices(array: object): boolean {
  try {
    let prototype = Reflect.getPrototypeOf(array);

    for (let depth = 0; depth < MAX_PROTOTYPE_DEPTH; depth++) {
      if (
        prototype === null ||
        prototype === Array.prototype ||
        prototype === Object.prototype
      ) {
        return true;
      }

      if (Reflect.ownKeys(prototype).some(isIndexKey)) {
        return false;
      }

      prototype = Reflect.getPrototypeOf(prototype);
    }
  } catch {
    // Read by `Object.hasOwn` instead.
  }

  return false;
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
