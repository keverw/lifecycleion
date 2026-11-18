import { isPlainRecord } from './plain-record';
import { isHighSurrogate } from './utf8-length';

/**
 * How deep a `.params()` value may nest: a top-level value is at depth 0, and an entry
 * of an object at depth `d` is at `d + 1`. `qs` is given it as its `depth` option, so it
 * refuses a deeper value rather than overflowing the stack, which it does from about
 * 3,000 levels on Node; {@link assertSerializableParams} refuses the same values when
 * they are handed over.
 */
export const MAX_PARAM_DEPTH = 1000;

/**
 * Whether an object at `depth` with `keyCount` entries nests past
 * {@link MAX_PARAM_DEPTH}: its entries are a level below it, and `qs` refuses one only
 * when there is an entry to put there. The rule both {@link assertSerializableParams} and
 * `buildURL`'s snapshot hold a value to, so one passes both or neither.
 */
export function exceedsParamDepth(keyCount: number, depth: number): boolean {
  return keyCount > 0 && reachesPastParamDepth(depth, 1);
}

/**
 * Whether an object at `depth` whose deepest entry is `height` levels below it nests
 * past {@link MAX_PARAM_DEPTH}.
 */
function reachesPastParamDepth(depth: number, height: number): boolean {
  return depth + height > MAX_PARAM_DEPTH;
}

/** `qs`'s refusal of a value deeper than {@link MAX_PARAM_DEPTH}, in its own words. */
export const PARAM_DEPTH_EXCEEDED_MESSAGE = `Input depth exceeded depth option of ${String(MAX_PARAM_DEPTH)}`;

/**
 * Refuses a `.params()` value `qs` would throw on when the query is built, so a data
 * condition - a `Date` parsed from bad input - is refused where it is handed over, as a
 * body that cannot be copied is, rather than rejecting `send()` with `qs`'s own
 * `RangeError`: a `Date` (by `instanceof`, as `qs` tells one) that `toISOString`, the
 * call `qs` serializes it by, throws on, an object nested inside itself, an entry
 * deeper than {@link MAX_PARAM_DEPTH}, and a `Map`, `Set`, `WeakMap`, `WeakSet`,
 * `URLSearchParams`, `Headers`, `FormData`, `Blob` (a `File` included) or `URL`, whose
 * entries or contents are not own properties, so `qs` would write nothing for one (see
 * {@link collectionTypeOf}). Walks the own enumerable keys `qs` walks - an
 * object's, a function's and a typed array's, all but a `Buffer`'s, which `qs` sends as
 * its text - through data properties only, so no getter runs before `qs` reads it; a
 * getter's value, and a nested object changed after this call, are still read only by
 * `qs`, at `send()`. An object reached by more than one path is walked once. A nested
 * `Proxy` is asked for its keys and descriptors here, so its `ownKeys` and
 * `getOwnPropertyDescriptor` traps run, and throw, here too.
 *
 * Kept separate from `buildURL`'s snapshot of the nested values (`snapshotParamValue`),
 * which reads through getters - it is the read `qs` serializes - where this check must
 * not. The two share {@link MAX_PARAM_DEPTH}.
 */
export function assertSerializableParams(
  params: Record<string, unknown>,
): void {
  const walk: ParamWalk = {
    path: [],
    ancestors: new Set([params]),
    heights: new Map(),
    collectionReads: undefined,
  };

  for (const key of Object.keys(params)) {
    walk.path.push(key);
    checkParamValue(params, key, 0, walk);
    walk.path.pop();
  }
}

interface ParamWalk {
  /** The keys from the top level down to the entry being checked. */
  readonly path: string[];
  /** The objects the entry being checked is nested inside. */
  readonly ancestors: Set<object>;
  /**
   * The objects whose entries were all checked and found serializable, each to how many
   * levels below it its deepest entry is.
   */
  readonly heights: Map<object, number>;
  /** {@link COLLECTION_TYPES}' slot reads, looked up when the first value needs them. */
  collectionReads: readonly CollectionRead[] | undefined;
}

/**
 * Checks the entry `key` of `holder`, at `depth`, and answers how many levels below it
 * its deepest entry is: 0 for a value `qs` does not walk into.
 */
function checkParamValue(
  holder: object,
  key: string,
  depth: number,
  walk: ParamWalk,
): number {
  const descriptor = Reflect.getOwnPropertyDescriptor(holder, key);
  if (descriptor === undefined || !('value' in descriptor)) {
    return 0;
  }

  const value: unknown = descriptor.value;
  if (
    (typeof value !== 'object' && typeof value !== 'function') ||
    value === null ||
    isNodeBuffer(value)
  ) {
    return 0;
  }

  if (value instanceof Date) {
    try {
      Date.prototype.toISOString.call(value);
    } catch {
      throw paramRefusal(walk, 'is not a valid Date');
    }
    return 0;
  }

  const checkedHeight = walk.heights.get(value);
  if (checkedHeight !== undefined) {
    if (reachesPastParamDepth(depth, checkedHeight)) {
      throw sharedDepthRefusal(value, depth, walk);
    }
    return checkedHeight;
  }

  // After the lookup: a collection is refused when first met, so it is never recorded.
  const collection = collectionTypeOf(value, walk);
  if (collection !== undefined) {
    throw paramRefusal(
      walk,
      `is a ${collection.name}, whose ${collection.held} qs does not read`,
    );
  }

  if (walk.ancestors.has(value)) {
    throw paramRefusal(walk, 'is an object it is nested inside');
  }

  const keys = Object.keys(value);
  if (exceedsParamDepth(keys.length, depth)) {
    throw depthRefusal(walk);
  }

  let height = 0;
  walk.ancestors.add(value);
  for (const nestedKey of keys) {
    walk.path.push(nestedKey);
    height = Math.max(
      height,
      1 + checkParamValue(value, nestedKey, depth + 1, walk),
    );
    walk.path.pop();
  }
  walk.ancestors.delete(value);
  walk.heights.set(value, height);
  return height;
}

/**
 * The values whose entries or contents are not own properties, each by a member of its
 * prototype that reads its internal slot and throws for any other value, and what it
 * holds there. `File` is a `Blob`.
 */
const COLLECTION_TYPES: ReadonlyArray<
  readonly [name: string, member: string, held: string]
> = [
  ['Map', 'size', 'entries'],
  ['Set', 'size', 'entries'],
  ['WeakMap', 'has', 'entries'],
  ['WeakSet', 'has', 'entries'],
  ['URLSearchParams', 'has', 'entries'],
  ['Headers', 'has', 'entries'],
  ['FormData', 'has', 'entries'],
  ['Blob', 'size', 'contents'],
  ['URL', 'href', 'contents'],
];

interface CollectionRead {
  readonly name: string;
  readonly held: string;
  readonly type: abstract new (...args: never[]) => unknown;
  readonly read: (...args: unknown[]) => unknown;
  /** Whether `read` is the runtime's own, whose slot read refuses any other value. */
  readonly isNative: boolean;
}

/** The slot reads of the {@link COLLECTION_TYPES} this runtime has. */
function lookUpCollectionReads(): CollectionRead[] {
  const reads: CollectionRead[] = [];

  for (const [name, member, held] of COLLECTION_TYPES) {
    const type: unknown = Reflect.get(globalThis, name);
    const prototype: unknown =
      typeof type === 'function' ? Reflect.get(type, 'prototype') : undefined;
    if (typeof prototype !== 'object' || prototype === null) {
      continue;
    }

    const descriptor = Reflect.getOwnPropertyDescriptor(prototype, member);
    const read: unknown = descriptor?.get ?? descriptor?.value;
    if (typeof read === 'function') {
      reads.push({
        name,
        held,
        type: type as abstract new (...args: never[]) => unknown,
        read: read as (...args: unknown[]) => unknown,
        isNative: Function.prototype.toString
          .call(read)
          .includes('[native code]'),
      });
    }
  }

  return reads;
}

/**
 * The type of `value` when it is one of {@link COLLECTION_TYPES} - a subclass's instance,
 * or one from another realm, included - told by its internal slot, so an object that
 * only inherits from one of their prototypes, or a `Proxy` around one, is not one. Where
 * the type's member is written in JavaScript, it is told by `instanceof` and then its
 * slot, so one from another realm is not told there. `qs`
 * walks any other object by its own enumerable keys: a function or a class instance with
 * none writes nothing, as an empty `{}` does. A plain record or an array is not asked.
 */
function collectionTypeOf(
  value: object,
  walk: ParamWalk,
): CollectionRead | undefined {
  if (Array.isArray(value) || isPlainRecord(value)) {
    return undefined;
  }

  walk.collectionReads ??= lookUpCollectionReads();
  for (const collection of walk.collectionReads) {
    // A member written in JavaScript - Node's, or a React Native or whatwg-fetch
    // polyfill's - may read a field any object can have rather than refuse what is not
    // one, so there the value must be an instance too: asked first, so the member never
    // runs against an object that is not one, nor a getter of the caller's with it.
    if (!collection.isNative && !(value instanceof collection.type)) {
      continue;
    }

    try {
      Reflect.apply(collection.read, value, [undefined]);
      return collection;
    } catch {
      // Not this type: its slot is missing.
    }
  }

  return undefined;
}

/**
 * The depth refusal for `value`, an object already checked elsewhere and met again at
 * `depth`, where its entries reach past {@link MAX_PARAM_DEPTH}: it follows, at each
 * level, the first entry whose own entries reach past it, down to the one that nests
 * too deep, so the refusal names the entry the walk would had it not met `value` before.
 */
function sharedDepthRefusal(
  value: object,
  depth: number,
  walk: ParamWalk,
): TypeError {
  let current = value;

  for (
    let currentDepth = depth;
    currentDepth < MAX_PARAM_DEPTH;
    currentDepth++
  ) {
    const deeper = firstTooDeepEntry(current, currentDepth, walk);
    if (deeper === undefined) {
      // A `Proxy` that now answers otherwise: refused where the chain ends.
      break;
    }

    walk.path.push(deeper.key);
    current = deeper.value;
  }

  return depthRefusal(walk);
}

/**
 * The first entry of `holder`, an object at `depth`, whose own entries reach past
 * {@link MAX_PARAM_DEPTH}, by the heights the walk recorded.
 */
function firstTooDeepEntry(
  holder: object,
  depth: number,
  walk: ParamWalk,
): { key: string; value: object } | undefined {
  for (const key of Object.keys(holder)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(holder, key);
    const value: unknown = descriptor?.value;
    if (
      (typeof value === 'object' || typeof value === 'function') &&
      value !== null &&
      reachesPastParamDepth(depth + 1, walk.heights.get(value) ?? 0)
    ) {
      return { key, value };
    }
  }

  return undefined;
}

function depthRefusal(walk: ParamWalk): TypeError {
  return paramRefusal(
    walk,
    `nests deeper than ${String(MAX_PARAM_DEPTH)} levels`,
  );
}

function paramRefusal(walk: ParamWalk, problem: string): TypeError {
  return new TypeError(
    `HTTPRequestBuilder params.${reportedParamPath(walk.path)} ${problem}, so it cannot be put in a query`,
  );
}

/** How many of a refused entry's leading keys its message names. */
const REPORTED_LEADING_KEYS = 5;

/** How many of a refused entry's trailing keys its message names, its own included. */
const REPORTED_TRAILING_KEYS = 20;

/** How many UTF-16 code units of each key a refusal names. */
const REPORTED_KEY_LENGTH = 64;

/**
 * A refused entry's keys as its message names them, joined with `.`: a path that would
 * leave out two or more keys by its first and last keys, with a count of those between,
 * and a long key by its start and `...`, not splitting a surrogate pair, so the message
 * stays short whatever the keys are.
 */
function reportedParamPath(path: readonly string[]): string {
  const shortened = (key: string): string => {
    if (key.length <= REPORTED_KEY_LENGTH) {
      return key;
    }

    const lastUnit = key.charCodeAt(REPORTED_KEY_LENGTH - 1);
    const end = isHighSurrogate(lastUnit)
      ? REPORTED_KEY_LENGTH - 1
      : REPORTED_KEY_LENGTH;
    return `${key.slice(0, end)}...`;
  };
  const omitted = path.length - REPORTED_LEADING_KEYS - REPORTED_TRAILING_KEYS;

  if (omitted < 2) {
    return path.map(shortened).join('.');
  }

  return [
    ...path.slice(0, REPORTED_LEADING_KEYS),
    `[${String(omitted)} more keys]`,
    ...path.slice(-REPORTED_TRAILING_KEYS),
  ]
    .map(shortened)
    .join('.');
}

/** Whether `value` is a `Buffer`, which `qs` sends as its text rather than walking it. */
function isNodeBuffer(value: object): boolean {
  return typeof Buffer === 'function' && Buffer.isBuffer(value);
}
