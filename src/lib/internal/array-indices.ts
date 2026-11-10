import { MAX_PROTOTYPE_DEPTH } from './prototype-depth';

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
 * whose `has` answers for every hole, and nothing here tells one apart. A `Proxy` array is
 * answered as its own traps answer, its `getPrototypeOf` and `has` included - a hole it
 * says it holds is read as an entry, as `Object.hasOwn` would read one its
 * `getOwnPropertyDescriptor` says it holds.
 */
export function holdsOwnIndex(array: unknown[], index: number): boolean {
  return Reflect.getPrototypeOf(array) === Array.prototype
    ? index in array
    : Object.hasOwn(array, index);
}

/**
 * Whether `source` holds `index` as its own, for a copy of a caller's list: an entry is
 * told by `in` while `source`'s prototype is this realm's `Array.prototype` -
 * `Object.hasOwn` costs hundreds of times as much per index on JavaScriptCore - and by
 * `Object.hasOwn` where `in` says no, or the prototype is any other. So a hole an Array
 * subclass's or other prototype fills is not read as an entry, and nor is an own entry a
 * `Proxy`'s `has` hides lost; this realm's `Array.prototype` and `Object.prototype` are
 * taken as filling none, as `indexFreePrototype` takes them. A `Proxy` whose `has`
 * answers for a hole is read as holding it, as `holdsOwnIndex` reads one. Unlike
 * `holdsOwnIndex`, a hole costs an `Object.hasOwn`.
 */
export function holdsCopiedIndex(
  source: readonly unknown[],
  index: number,
): boolean {
  return (
    (Reflect.getPrototypeOf(source) === Array.prototype && index in source) ||
    Object.hasOwn(source, index)
  );
}

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
 * `array`'s prototype, read once, when no prototype it inherits from lists an index of its
 * own as it stands now - an Array subclass's prototype or another realm's
 * `Array.prototype` as much as this realm's, which with `Object.prototype` is taken as
 * listing none - and `undefined` otherwise: for a chain that cannot be read, or one over
 * 64 deep, too. Not proof that `in` tells `array`'s own indices: a `Proxy` prototype
 * answers `has` as its trap does, whatever keys it lists, so a walk that reads by `in` on
 * this answer checks what it reads (see `LRUCache`'s size estimate).
 */
export function indexFreePrototype(array: object): object | null | undefined {
  try {
    const arrayPrototype = Reflect.getPrototypeOf(array);
    let prototype = arrayPrototype;

    for (let depth = 0; depth < MAX_PROTOTYPE_DEPTH; depth++) {
      if (
        prototype === null ||
        prototype === Array.prototype ||
        prototype === Object.prototype
      ) {
        return arrayPrototype;
      }

      if (Reflect.ownKeys(prototype).some(isIndexKey)) {
        return undefined;
      }

      prototype = Reflect.getPrototypeOf(prototype);
    }
  } catch {
    // Read by `Object.hasOwn` instead.
  }

  return undefined;
}

/**
 * Runs `visit` for each index below `length` that `source` holds as its own, in order,
 * each told as {@link holdsCopiedIndex} tells one. Past enough holes the rest are found
 * from its own keys, listed once, and each checked again by `Object.hasOwn` as it is
 * reached - an entry visited before can have removed it, and one it adds is not visited,
 * nor is a hole a `Proxy`'s `has` answers for - so a sparse array's length is not walked. As each hole walked costs an `Object.hasOwn`,
 * about what listing and checking an entry does, that is past {@link SPARSE_RUN} holes
 * once they outnumber the entries, not {@link isMostlyHoles}' many times as many.
 */
export function forEachOwnIndex(
  source: unknown[],
  length: number,
  visit: (index: number) => void,
): void {
  let holes = 0;
  let entries = 0;

  for (let index = 0; index < length; index++) {
    if (holdsCopiedIndex(source, index)) {
      entries++;
      visit(index);
      continue;
    }

    if (++holes > SPARSE_RUN && holes > entries) {
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
    if (!isIndexKey(key)) {
      continue;
    }

    const index = Number(key);

    if (index >= start && index < length) {
      indices.push(index);
    }
  }

  return indices.sort((left, right) => left - right);
}
