/**
 * Deep clone utility
 *
 * Creates a deep copy of a value, cloning nested structures to any depth. Handles most
 * common data types including objects, arrays, dates, regexes, errors, Maps, Sets, boxed
 * primitives, buffers and typed arrays.
 *
 * Note: Functions are returned by reference (not cloned). Circular references are
 * detected, and each reaches the one clone of what it pointed at.
 */

import { defineEntry } from './internal/define-entry';
import { isDOMExceptionInstance } from './internal/dom-exception';
import {
  arrayBufferKindOf,
  hasBufferTagInChain,
  typedArrayNameOf,
} from './internal/binary-view';

/** Options for {@link deepClone}. */
export interface DeepCloneOptions {
  /**
   * Named keys copied from every array, at any depth, when the array holds them as its
   * own - `meta` on an array tagged with `arr.meta = {...}`, say. Each value is cloned.
   * Only these keys are looked up: an array's other named entries are not listed, which
   * would cost a large array many times its clone. A regex match result's `index`,
   * `input`, `groups` and `indices` are copied without being listed.
   */
  arrayKeys?: readonly string[];
}

/** What one `deepClone` call carries through its walk. */
interface CloneState {
  seen: WeakMap<object, unknown>;
  arrayKeys: readonly string[];
  /**
   * The containers being filled, innermost last. A container met is made, registered and
   * pushed, and the walk fills the innermost one an entry at a time, so a container's
   * entries are read as soon as it is met, before the entries after it in its parent -
   * the order a recursive clone, and `structuredClone`, read in - while the nesting depth
   * is bounded by memory, not the call stack.
   */
  frames: Frame[];
  /** This realm's `SharedArrayBuffer`, looked up once per call for the buffer check. */
  SharedBuffer: (new () => object) | undefined;
  /** How many plain objects are being filled by recursion (see {@link RECURSION_LIMIT}). */
  depth: number;
}

/**
 * A container being filled: `step` copies its entries until one opens a container of its
 * own - whose frame then goes first - and answers `false` once it has none left.
 */
interface Frame {
  step(state: CloneState): boolean;
}

/** The named entries `exec` and `match` give a match result. */
const MATCH_RESULT_KEYS: readonly string[] = [
  'index',
  'input',
  'groups',
  'indices',
];

/**
 * How many holes an array is walked through index by index, at the least, before the rest
 * of it is read by its own keys instead: a dense array never reaches it, and one item at
 * index 100,000,000 - or one every 65,536 indices - is not as many steps.
 */
const SPARSE_RUN = 65_536;

/**
 * How many holes, per entry already copied, it takes past {@link SPARSE_RUN}: listing an
 * array's keys costs a string for every entry it holds, many times a step, so an array
 * mostly full is walked on through its holes rather than listed.
 */
const SPARSE_RUN_PER_ENTRY = 64;

/**
 * How many plain objects deep a clone fills by recursion, the fastest way to fill one,
 * before it fills them as frames instead: deep enough for any ordinary value, and a small
 * share of the call stack even when an array, `Map`, `Set` or error sits between each
 * object and the next - each adds calls of its own between the two - so a clone called
 * from deep in a stack does not overflow it.
 */
const RECURSION_LIMIT = 250;

/**
 * Deep clone an object or value
 *
 * @param obj - The value to clone
 * @param options - See {@link DeepCloneOptions}
 * @returns A deep clone of the input value
 */
export function deepClone<T>(obj: T, options?: DeepCloneOptions): T {
  // An object, a function, `null` or absent, as `structuredClone` takes its options:
  // anything else - the index `map` passes as a second argument - is refused in this
  // module's words rather than read as no options.
  const given: unknown = options;
  if (
    given !== undefined &&
    given !== null &&
    typeof given !== 'object' &&
    typeof given !== 'function'
  ) {
    throw new TypeError('deepClone: options must be an object');
  }

  const state: CloneState = {
    seen: new WeakMap(),
    arrayKeys: readArrayKeys(
      (given as DeepCloneOptions | null | undefined)?.arrayKeys,
    ),
    frames: [],
    SharedBuffer: globalConstructor('SharedArrayBuffer'),
    depth: 0,
  };
  const result = cloneValue(obj, state);
  fillFrames(state, 0);

  return result;
}

/** Fill the frames above `base`, innermost first, until none is left above it. */
function fillFrames(state: CloneState, base: number): void {
  const { frames } = state;

  while (frames.length > base) {
    if (!(frames.at(-1) as Frame).step(state)) {
      frames.pop();
    }
  }
}

/**
 * `arrayKeys` read once, into a list of this module's own: a string array or absent,
 * anything else a `TypeError`. `length` is left out - every clone sets its own.
 */
function readArrayKeys(arrayKeys: unknown): readonly string[] {
  if (arrayKeys === undefined) {
    return [];
  }

  if (!Array.isArray(arrayKeys)) {
    throw new TypeError(
      'deepClone: options.arrayKeys must be an array of strings',
    );
  }

  const keys: string[] = [];
  // By index, not `for...of`, and to the length read once: a caller's array is read
  // without running its iterator, and a length that grows cannot keep the loop going.
  const length = arrayKeys.length;
  for (let index = 0; index < length; index++) {
    const key: unknown = arrayKeys[index];

    if (typeof key !== 'string') {
      throw new TypeError(
        'deepClone: options.arrayKeys must be an array of strings',
      );
    }

    if (key !== 'length' && !keys.includes(key)) {
      keys.push(key);
    }
  }

  return keys;
}

/**
 * `value`'s clone: a primitive as it is, a value already met as its one clone, and any
 * other object made - registered before its entries are filled, so a circular reference
 * finds it - with a frame pushed to fill its entries.
 *
 * A built-in type is told by its internal slot, through this realm's intrinsic methods,
 * so one from another realm (a `vm` context, an iframe) is cloned as this realm's, and a
 * fake - `Object.create(Map.prototype)`, a `Proxy` over a `Map` - holds no slot and is
 * cloned as a plain object. The slot is asked about only for a value that could hold it:
 * one whose chain holds the type's prototype, or one from another realm that is not a
 * plain object there. This realm's plain objects are told by `instanceof` alone, and
 * another realm's by their prototype being that realm's root.
 */
function cloneValue<T>(obj: T, state: CloneState): T {
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  if (state.seen.has(obj)) {
    return state.seen.get(obj) as T;
  }

  // A typed array or `DataView`: a copy of the bytes it covers, so a small view of a
  // large buffer - a `subarray` of a file read whole - does not copy the buffer behind it.
  // Two views of one buffer, or a view and its buffer, do not share memory in the clone.
  if (ArrayBuffer.isView(obj)) {
    return remember(state.seen, obj, cloneView(obj));
  }

  if (Array.isArray(obj)) {
    const source = obj as unknown[];
    // Sized by assignment, not `new Array(length)`, which a length that is not a number -
    // a `Proxy`'s - would make an array of one entry.
    const cloned = remember<unknown[]>(state.seen, obj, []);
    cloned.length = source.length;
    state.frames.push(new ArrayFrame(source, cloned));
    return cloned as T;
  }

  // An `ArrayBuffer` or `SharedArrayBuffer`: copied whole into a new one of its kind.
  const bufferKind = bufferKindOf(obj, state.SharedBuffer);
  if (bufferKind !== undefined) {
    return remember(state.seen, obj, copyBuffer(obj, bufferKind));
  }

  const foreignType = foreignBuiltInType(obj);
  const builtIn = cloneBuiltIn(obj, foreignType, state);
  if (builtIn !== undefined) {
    return builtIn as T;
  }

  if (isError(obj, foreignType)) {
    return cloneError(obj, state) as T;
  }

  return clonePlainObject(obj, state) as T;
}

/** The built-in types another realm's value is asked about by slot. */
const FOREIGN_BUILT_IN_TYPES: readonly string[] = [
  'Date',
  'RegExp',
  'Map',
  'Set',
  'Number',
  'String',
  'Boolean',
  'BigInt',
  'Symbol',
  'DOMException',
];

/**
 * For a value from another realm - its chain holds no `Object.prototype` of this one -
 * the built-in type whose prototype, in some realm, its chain holds: one of
 * {@link FOREIGN_BUILT_IN_TYPES}, told by each prototype's own `constructor` and name, read
 * by descriptor so no getter runs. `undefined` for this realm's values, and for another
 * realm's plain objects and class instances, which are then never asked about by slot.
 */
function foreignBuiltInType(obj: object): string | undefined {
  if (obj instanceof Object) {
    return undefined;
  }

  let prototype = Reflect.getPrototypeOf(obj);

  while (prototype !== null) {
    const next = Reflect.getPrototypeOf(prototype);

    // A realm's root: nothing past it is a built-in type's prototype.
    if (next === null) {
      return undefined;
    }

    const name = basePrototypeName(prototype);
    if (name !== undefined && FOREIGN_BUILT_IN_TYPES.includes(name)) {
      return name;
    }

    prototype = next;
  }

  return undefined;
}

/**
 * A plain object's clone - on a null prototype when the original has one, as a match
 * result's `groups` does, so such a clone inherits nothing either; any other prototype is
 * not kept - with its own enumerable properties, each read once when its turn comes, a
 * getter's value included; one deleted before its turn is passed over. Filled here, by
 * recursion, up to {@link RECURSION_LIMIT} deep - the frames a value of it opens filled
 * before its next key is read, so the read order is a recursive clone's - and past that
 * by an {@link ObjectFrame}.
 */
function clonePlainObject(obj: object, state: CloneState): object {
  const cloned = remember<Record<string, unknown>>(
    state.seen,
    obj,
    Reflect.getPrototypeOf(obj) === null ? Object.create(null) : {},
  );

  if (state.depth >= RECURSION_LIMIT) {
    state.frames.push(new ObjectFrame(obj, cloned));
    return cloned;
  }

  state.depth++;
  const base = state.frames.length;

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      assignEntry(
        cloned,
        key,
        cloneValue((obj as Record<string, unknown>)[key], state),
      );

      if (state.frames.length > base) {
        fillFrames(state, base);
      }
    }
  }

  state.depth--;
  return cloned;
}

/**
 * `value` set as `target`'s `key`: an own `__proto__` key (`JSON.parse` makes one) is
 * defined, not assigned, which would reparent the clone instead of copying it. Every other
 * key is assigned onto the fresh clone, which holds none yet: defining each costs several
 * times as much.
 */
function assignEntry(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (key === '__proto__') {
    defineEntry(target, key, value);
  } else {
    target[key] = value;
  }
}

/**
 * The clone of a `Date`, `RegExp`, `Map`, `Set` or boxed primitive, of this realm's type -
 * a subclass's instance as its base type's - or `undefined` for anything else. Only its
 * value or entries are copied, not other own properties it carries.
 */
function cloneBuiltIn(
  obj: object,
  foreignType: string | undefined,
  state: CloneState,
): object | undefined {
  if (obj instanceof Date || foreignType === 'Date') {
    const time = callIntrinsic(Date.prototype, 'getTime', obj);
    if (typeof time === 'number') {
      return remember(state.seen, obj, new Date(time));
    }
  }

  if (obj instanceof RegExp || foreignType === 'RegExp') {
    const cloned = cloneRegExp(obj);
    if (cloned !== undefined) {
      return remember(state.seen, obj, cloned);
    }
  }

  if (
    (obj instanceof Map || foreignType === 'Map') &&
    getIntrinsic(Map.prototype, 'size', obj) !== undefined
  ) {
    const cloned = remember<Map<unknown, unknown>>(state.seen, obj, new Map());
    state.frames.push(new MapFrame(obj, cloned));
    return cloned;
  }

  if (
    (obj instanceof Set || foreignType === 'Set') &&
    getIntrinsic(Set.prototype, 'size', obj) !== undefined
  ) {
    const cloned = remember<Set<unknown>>(state.seen, obj, new Set());
    state.frames.push(new SetFrame(obj, cloned));
    return cloned;
  }

  return cloneBoxedPrimitive(obj, foreignType, state);
}

/** The intrinsic flag getters of `RegExp.prototype`, each with the flag it reads. */
const REGEXP_FLAGS: ReadonlyArray<readonly [string, string]> = [
  ['hasIndices', 'd'],
  ['global', 'g'],
  ['ignoreCase', 'i'],
  ['multiline', 'm'],
  ['dotAll', 's'],
  ['unicode', 'u'],
  ['unicodeSets', 'v'],
  ['sticky', 'y'],
];

/**
 * A `RegExp`'s clone, from the source and flags its internal slots hold - read through
 * the intrinsic getters, so neither an own `source` or `flags` it shadows them with nor a
 * `Symbol.match` of its own is read - with its numeric `lastIndex`; `undefined` for a
 * value without the slot.
 */
function cloneRegExp(obj: object): RegExp | undefined {
  const source = getIntrinsic(RegExp.prototype, 'source', obj);
  if (typeof source !== 'string') {
    return undefined;
  }

  let flags = '';
  for (const [getter, flag] of REGEXP_FLAGS) {
    if (getIntrinsic(RegExp.prototype, getter, obj) === true) {
      flags += flag;
    }
  }

  const cloned = new RegExp(source, flags);
  const lastIndex: unknown = Reflect.get(obj, 'lastIndex');
  if (typeof lastIndex === 'number') {
    cloned.lastIndex = lastIndex;
  }

  return cloned;
}

/**
 * A `Number`, `String`, `Boolean`, `BigInt` or `Symbol` wrapper's clone: a wrapper of
 * this realm around the same primitive, as `structuredClone` makes one.
 */
function cloneBoxedPrimitive(
  obj: object,
  foreignType: string | undefined,
  state: CloneState,
): object | undefined {
  // Told by `instanceof` first, so this realm's plain objects pass five cheap checks and
  // build nothing.
  if (
    foreignType === undefined &&
    !(obj instanceof Number) &&
    !(obj instanceof String) &&
    !(obj instanceof Boolean) &&
    !(obj instanceof BigInt) &&
    !(obj instanceof Symbol)
  ) {
    return undefined;
  }

  const wrappers: ReadonlyArray<{
    readonly prototype: object;
    readonly name: string;
  }> = [Number, String, Boolean, BigInt, Symbol];

  for (const Wrapper of wrappers) {
    if (
      obj instanceof (Wrapper as unknown as typeof Object) ||
      foreignType === Wrapper.name
    ) {
      const primitive = callIntrinsic(Wrapper.prototype, 'valueOf', obj);
      if (primitive !== NO_SLOT) {
        return remember(state.seen, obj, new Object(primitive));
      }
    }
  }

  return undefined;
}

/**
 * A plain object being filled - on a null prototype when the original has one, as a
 * match result's `groups` does, so such a clone inherits nothing either; any other
 * prototype is not kept - with its own enumerable properties, each read once when its
 * turn comes, a getter's value included. One deleted before its turn is passed over.
 */
class ObjectFrame implements Frame {
  private readonly keys: string[];
  private position = 0;

  constructor(
    private readonly source: object,
    private readonly target: Record<string, unknown>,
  ) {
    this.keys = Object.keys(source);
  }

  public step(state: CloneState): boolean {
    const { keys, source, target } = this;
    const depth = state.frames.length;

    while (this.position < keys.length) {
      const key = keys[this.position++];
      if (!Object.prototype.hasOwnProperty.call(source, key)) {
        continue;
      }

      assignEntry(
        target,
        key,
        cloneValue((source as Record<string, unknown>)[key], state),
      );

      if (state.frames.length !== depth) {
        return true;
      }
    }

    return false;
  }
}

/**
 * An array being filled, to the length it had when met, by index - not through an own
 * `Symbol.iterator` - so one that grows while it is read is not followed. Each index it
 * holds as its own is copied (told by `in` on an array on `Array.prototype`, far cheaper,
 * and the same but for an index set on `Array.prototype` itself), so a hole stays a hole,
 * one emptied before its turn included. Past enough holes the rest is read by its own
 * keys (see {@link SPARSE_RUN}). Then the named entries: a match result's and `arrayKeys`' - the
 * others are not listed, which would cost a dense array many times its clone.
 */
class ArrayFrame implements Frame {
  private readonly length: number;
  private readonly isOwnOnly: boolean;
  private index = 0;
  private holes = 0;
  private entries = 0;
  /** The indices left past a run of holes, read by the array's own keys. */
  private tail: number[] | undefined;
  private tailPosition = 0;
  private named: readonly string[] | undefined;
  private namedPosition = 0;
  private isMatchResult = false;
  /** A match result's `indices`, whose `groups` is copied once its entries are. */
  private indicesGroups: { value: object; copy: unknown[] } | undefined;

  constructor(
    private readonly source: unknown[],
    private readonly target: unknown[],
  ) {
    this.length = target.length;
    this.isOwnOnly = Reflect.getPrototypeOf(source) !== Array.prototype;
  }

  public step(state: CloneState): boolean {
    const { source, target } = this;
    const depth = state.frames.length;

    if (this.tail === undefined) {
      // Walked in locals, written back when the walk stops: the loop is the whole cost of
      // cloning a dense array of primitives.
      const { length, isOwnOnly } = this;
      let { index, holes, entries } = this;

      while (index < length) {
        const at = index++;

        if (isOwnOnly ? Object.hasOwn(source, at) : at in source) {
          target[at] = cloneValue(source[at], state);
          entries++;

          if (state.frames.length !== depth) {
            break;
          }

          continue;
        }

        if (++holes > SPARSE_RUN && holes > entries * SPARSE_RUN_PER_ENTRY) {
          this.tail = indicesFrom(source, index, length);
          break;
        }
      }

      this.index = index;
      this.holes = holes;
      this.entries = entries;

      if (state.frames.length !== depth) {
        return true;
      }
    }

    if (this.tail !== undefined) {
      while (this.tailPosition < this.tail.length) {
        const index = this.tail[this.tailPosition++];

        if (Object.hasOwn(source, index)) {
          target[index] = cloneValue(source[index], state);

          if (state.frames.length !== depth) {
            return true;
          }
        }
      }
    }

    return this.stepNamed(state);
  }

  /**
   * The next named entry `target` carries over: a match result's (one whose first entry
   * is a string and that holds an own `index`, as lodash tells one), with the `groups`
   * its `indices` array holds under the `d` flag, and those named in `arrayKeys` - each
   * only when `source` holds it as its own, enumerable or not, read once and cloned.
   * Defined, not assigned, so a `__proto__` named there is copied as an entry.
   */
  private stepNamed(state: CloneState): boolean {
    if (this.named === undefined) {
      // Told by the clone's first entry, not read again from the source: a string clones
      // as itself.
      this.isMatchResult =
        typeof this.target[0] === 'string' &&
        Object.hasOwn(this.source, 'index');
      this.named = this.isMatchResult
        ? [
            ...MATCH_RESULT_KEYS,
            ...state.arrayKeys.filter(
              (key) => !MATCH_RESULT_KEYS.includes(key),
            ),
          ]
        : state.arrayKeys;
    }

    const record = this.source as unknown as Record<string, unknown>;
    const target = this.target as unknown as Record<string, unknown>;

    if (this.indicesGroups !== undefined) {
      const { value, copy } = this.indicesGroups;
      this.indicesGroups = undefined;
      defineEntry(
        copy as unknown as Record<string, unknown>,
        'groups',
        cloneValue((value as Record<string, unknown>).groups, state),
      );
      return true;
    }

    while (this.namedPosition < this.named.length) {
      const key = this.named[this.namedPosition++];
      if (!Object.hasOwn(record, key)) {
        continue;
      }

      const value = record[key];
      const copy = cloneValue(value, state);
      defineEntry(target, key, copy);

      if (
        this.isMatchResult &&
        key === 'indices' &&
        Array.isArray(value) &&
        Array.isArray(copy) &&
        Object.hasOwn(value, 'groups')
      ) {
        this.indicesGroups = { value, copy };
      }

      return true;
    }

    return false;
  }
}

/**
 * The array indices `source` holds as its own from `start` up to `length`, in order:
 * every own key, enumerable or not, that is an index - not a named key, nor one that
 * only reads like a number (`'1.5'`, `'01'`).
 */
function indicesFrom(
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

/**
 * A `Map` being filled from its entries as `Map.prototype.entries` gives them - not
 * through its own `Symbol.iterator` - each entry's key cloned, then its value.
 */
class MapFrame implements Frame {
  private readonly entries: Iterator<[unknown, unknown]>;
  private entry: [unknown, unknown] | undefined;
  private key: unknown;

  constructor(
    source: object,
    private readonly target: Map<unknown, unknown>,
  ) {
    this.entries = callIntrinsic(Map.prototype, 'entries', source) as Iterator<
      [unknown, unknown]
    >;
  }

  public step(state: CloneState): boolean {
    const depth = state.frames.length;

    for (;;) {
      // An entry whose key was cloned last step, its value still to come.
      if (this.entry === undefined) {
        const next = this.entries.next();
        if (next.done === true) {
          return false;
        }

        this.entry = next.value;
        this.key = cloneValue(this.entry[0], state);

        if (state.frames.length !== depth) {
          return true;
        }
      }

      this.target.set(this.key, cloneValue(this.entry[1], state));
      this.entry = undefined;

      if (state.frames.length !== depth) {
        return true;
      }
    }
  }
}

/** A `Set` being filled from its values as `Set.prototype.values` gives them. */
class SetFrame implements Frame {
  private readonly values: Iterator<unknown>;

  constructor(
    source: object,
    private readonly target: Set<unknown>,
  ) {
    this.values = callIntrinsic(
      Set.prototype,
      'values',
      source,
    ) as Iterator<unknown>;
  }

  public step(state: CloneState): boolean {
    const depth = state.frames.length;

    for (;;) {
      const next = this.values.next();
      if (next.done === true) {
        return false;
      }

      this.target.add(cloneValue(next.value, state));

      if (state.frames.length !== depth) {
        return true;
      }
    }
  }
}

/**
 * Whether `value` is an `Error` or a `DOMException`, told by its internal state - through
 * `Error.isError`, from any realm (a `vm` context, an iframe), and the `DOMException`
 * check, which Bun's `Error.isError` refuses. A runtime without `Error.isError` tells an
 * `Error` by `instanceof`, this realm's only.
 *
 * The `DOMException` check throws and catches for anything that is not one, which costs
 * every object it is asked about, so it is asked only about a value that could be one: an
 * `Error` by its chain (a `DOMException` inherits from `Error.prototype`), or a value from
 * another realm that is not a plain object there. Plain objects, and null-prototype
 * dictionaries, never reach it.
 */
function isError(
  value: object,
  foreignType: string | undefined,
): value is Error {
  const isErrorSlot = (Error as { isError?: (value: unknown) => boolean })
    .isError;

  if (
    typeof isErrorSlot === 'function'
      ? isErrorSlot(value)
      : value instanceof Error
  ) {
    return true;
  }

  return (
    (value instanceof Error || foreignType === 'DOMException') &&
    isDOMExceptionInstance(value)
  );
}

/**
 * An `Error` cloned on its own prototype, so `instanceof` and a subclass's `name` hold -
 * another realm's built-in error on this realm's (see {@link errorPrototype}):
 * every own string-keyed property - `message`, `stack`, `cause`, an `AggregateError`'s
 * `errors`, a subclass's `code` - read once and cloned, as enumerable as it was, and
 * writable and configurable as every clone's properties are: a frozen error's clone is not
 * frozen. A `stack` the engine serves through an accessor is copied as the text it reads
 * as. A property of the base the engine will not let go (non-configurable, as a hardened
 * realm can make one) is assigned over where it is writable, and otherwise kept as the
 * base has it.
 *
 * Built on a real error - a `new Error()` emptied of its own properties, or for a
 * `DOMException` a `new DOMException` of the message and name its internal state holds,
 * read through `DOMException.prototype`'s getters rather than any of its own - so the
 * clone is an error to `Error.isError` and `Object.prototype.toString`, and clones again
 * as one. A subclass's private fields, and anything else its constructor sets up beyond
 * own properties, are not there: its methods that read them throw on the clone.
 */
function cloneError(source: Error, state: CloneState): Error {
  let base: Error;

  if (isDOMExceptionInstance(source)) {
    const DOMExceptionType = globalConstructor('DOMException') as unknown as {
      new (message: string, name: string): Error;
      readonly prototype: object;
    };
    base = new DOMExceptionType(
      getIntrinsic(DOMExceptionType.prototype, 'message', source) as string,
      getIntrinsic(DOMExceptionType.prototype, 'name', source) as string,
    );
  } else {
    base = new Error();
  }

  for (const key of Reflect.ownKeys(base)) {
    Reflect.deleteProperty(base, key);
  }

  Reflect.setPrototypeOf(base, errorPrototype(source));
  const cloned = remember<Error>(state.seen, source, base);
  state.frames.push(new ErrorFrame(source, cloned));

  return cloned;
}

/** The built-in error types whose prototype another realm's error is moved off. */
const ERROR_TYPES: readonly string[] = [
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'AggregateError',
  'SuppressedError',
  'DOMException',
];

/**
 * The prototype an error's clone is put on: its own, except that another realm's
 * built-in error prototype (its `TypeError.prototype`) is swapped for this realm's, so
 * the clone is an `instanceof Error` here as a cloned `Date` is a `Date`. A subclass from
 * another realm keeps its own prototype, which no type here stands in for - one named
 * after a built-in too (`class TypeError extends TypeError`), as
 * {@link isBuiltInErrorPrototype} tells it by its place in the chain.
 */
function errorPrototype(source: Error): object | null {
  const prototype = Reflect.getPrototypeOf(source);

  if (prototype === null || prototype instanceof Object) {
    return prototype;
  }

  const name = basePrototypeName(prototype);

  if (
    name === undefined ||
    !ERROR_TYPES.includes(name) ||
    !isBuiltInErrorPrototype(prototype, name)
  ) {
    return prototype;
  }

  const local: unknown = globalConstructor(name)?.prototype;
  return typeof local === 'object' && local !== null ? local : prototype;
}

/**
 * Whether `prototype`, the own prototype of a constructor named `name` (see
 * {@link basePrototypeName}), sits where a realm puts its built-in error prototype of that
 * name - `Error`'s on the realm's root, every other directly on that realm's
 * `Error.prototype`. A subclass named after a built-in sits one link further down.
 */
function isBuiltInErrorPrototype(prototype: object, name: string): boolean {
  const parent = Reflect.getPrototypeOf(prototype);
  const errorPrototype = name === 'Error' ? prototype : parent;

  if (
    errorPrototype === null ||
    (name !== 'Error' && !isBasePrototype(errorPrototype, 'Error'))
  ) {
    return false;
  }

  const root = Reflect.getPrototypeOf(errorPrototype);
  return root !== null && Reflect.getPrototypeOf(root) === null;
}

/** An error being filled with its own string-keyed properties: see {@link cloneError}. */
class ErrorFrame implements Frame {
  private readonly keys: string[];
  private position = 0;

  constructor(
    private readonly source: Error,
    private readonly target: Error,
  ) {
    this.keys = Reflect.ownKeys(source).filter(
      (key): key is string => typeof key === 'string',
    );
  }

  public step(state: CloneState): boolean {
    const { source, target, keys } = this;
    const depth = state.frames.length;

    while (this.position < keys.length) {
      const key = keys[this.position++];
      const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
      const value = cloneValue(
        (source as unknown as Record<string, unknown>)[key],
        state,
      );
      const kept = Reflect.getOwnPropertyDescriptor(target, key);

      if (kept?.configurable === false) {
        if (kept.writable === true) {
          Reflect.set(target, key, value);
        }
      } else {
        Object.defineProperty(target, key, {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          __proto__: null,
          value,
          writable: true,
          enumerable: descriptor?.enumerable === true,
          configurable: true,
        } as PropertyDescriptor);
      }

      if (state.frames.length !== depth) {
        return true;
      }
    }

    return false;
  }
}

/** What {@link callIntrinsic} answers for a value without the slot the method reads. */
const NO_SLOT = Symbol('no slot');

/**
 * `prototype[name]` called on `value`: an intrinsic method, read off the prototype when
 * called, that reads an internal slot and throws for a value without it - answered as
 * {@link NO_SLOT}. Runs nothing of `value`'s own, not a `Proxy`'s traps.
 */
function callIntrinsic(
  prototype: object,
  name: string,
  value: object,
): unknown {
  const method: unknown = Reflect.getOwnPropertyDescriptor(
    prototype,
    name,
  )?.value;
  if (typeof method !== 'function') {
    return NO_SLOT;
  }

  try {
    return Reflect.apply(method, value, []) as unknown;
  } catch {
    return NO_SLOT;
  }
}

/**
 * `prototype`'s own getter `name` called on `value`, or `undefined` for a value without
 * the slot it reads - as {@link callIntrinsic}, for an accessor.
 */
function getIntrinsic(prototype: object, name: string, value: object): unknown {
  const getter = Reflect.getOwnPropertyDescriptor(prototype, name)?.get;
  if (typeof getter !== 'function') {
    return undefined;
  }

  try {
    return Reflect.apply(getter, value, []) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `cloned`, registered as `original`'s clone, so a value reached twice is cloned once and
 * both references keep pointing at one copy, as they pointed at one original.
 */
function remember<T>(
  seen: WeakMap<object, unknown>,
  original: object,
  cloned: unknown,
): T {
  seen.set(original, cloned);
  return cloned as T;
}

type BufferKind = 'ArrayBuffer' | 'SharedArrayBuffer';

interface BufferConstructorLike {
  new (byteLength: number, options?: { maxByteLength: number }): ArrayBuffer;
  readonly prototype: object;
}

interface ViewConstructorLike {
  new (buffer: ArrayBuffer): object;
  readonly prototype: object;
}

/** This realm's `%TypedArray%.prototype`, which every typed array type inherits from. */
function typedArrayPrototype(): object {
  return Object.getPrototypeOf(Uint8Array.prototype) as object;
}

/**
 * Whether `value` is a buffer, and which kind, told by its internal slot through the
 * intrinsic getters - which throw for anything else without running a `Proxy`'s traps or
 * a getter of the value's. Asked only of what may be one: an object whose prototype
 * chain holds this realm's `ArrayBuffer` or `SharedArrayBuffer` (an object that merely
 * inherits from one is not one, and is cloned as a plain object), or one from another
 * realm (a `vm` context, an iframe) whose chain holds that realm's. So this realm's plain
 * objects and class instances, another realm's plain objects, and null-prototype
 * dictionaries never pay for that check. A buffer whose prototype was taken away is not
 * told, as a `Date` or `Map` whose prototype was taken away is not.
 */
function bufferKindOf(
  value: object,
  SharedBuffer: (new () => object) | undefined,
): BufferKind | undefined {
  if (
    value instanceof ArrayBuffer ||
    (SharedBuffer !== undefined && value instanceof SharedBuffer)
  ) {
    return arrayBufferKindOf(value);
  }

  if (value instanceof Object || !hasBufferTagInChain(value)) {
    return undefined;
  }

  return arrayBufferKindOf(value);
}

/**
 * A buffer copied whole into a new one of its kind - resizable or growable as it is.
 * A `SharedArrayBuffer`'s copy is a new one, its memory not shared with the original. A
 * subclass is copied by `slice`, through its own constructor (see {@link isSubclass}),
 * which gives a fixed-length buffer whatever the original's.
 */
function copyBuffer(buffer: object, kind: BufferKind): object {
  const Kind = bufferConstructor(kind);
  if (isSubclass(buffer, Kind, kind)) {
    return Reflect.apply(
      Reflect.get(Kind.prototype, 'slice') as (begin: number) => object,
      buffer,
      [0],
    );
  }

  const read = (key: string): unknown =>
    Reflect.get(Kind.prototype, key, buffer);
  const byteLength = read('byteLength') as number;
  const maxByteLength = read('maxByteLength');
  const isResizable =
    read(kind === 'ArrayBuffer' ? 'resizable' : 'growable') === true &&
    typeof maxByteLength === 'number';

  return copyBytes(
    buffer,
    Kind,
    0,
    byteLength,
    isResizable ? maxByteLength : undefined,
  );
}

/**
 * `byteLength` bytes of `buffer` from `byteOffset`, copied into a new buffer built by
 * `Kind` - this realm's own buffer type, so a built-in buffer or view from another realm
 * is cloned as this realm's, resizable when asked. Read through a `Uint8Array`, which
 * throws for a detached buffer: a failure, rather than a clone that silently holds
 * nothing.
 */
function copyBytes(
  buffer: object,
  Kind: BufferConstructorLike,
  byteOffset: number,
  byteLength: number,
  maxByteLength?: number,
): ArrayBuffer {
  const copy =
    maxByteLength === undefined
      ? new Kind(byteLength)
      : new Kind(byteLength, { maxByteLength });

  new Uint8Array(copy).set(
    new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength),
  );

  return copy;
}

/**
 * A typed array or `DataView` over a copy of the bytes it covers, of its own type. The
 * copy is a fixed-length buffer of the view's buffer's kind, even under a view of a
 * resizable one. Read through the intrinsic getters, which answer for a view from any
 * realm. A typed array subclass - a `Buffer`, a caller's class - is copied by the shared
 * `slice`, through its own constructor (see {@link isSubclass}); a `DataView` subclass
 * comes back a `DataView`.
 */
function cloneView(view: ArrayBufferView): object {
  const name = typedArrayNameOf(view);
  const read = (key: string): unknown =>
    Reflect.get(
      name === undefined ? DataView.prototype : typedArrayPrototype(),
      key,
      view,
    );
  const buffer = read('buffer') as object;
  const View = (name === undefined
    ? DataView
    : globalConstructor(name)) as unknown as ViewConstructorLike | undefined;
  if (View === undefined) {
    throw new TypeError(
      `deepClone: cannot clone a ${name ?? 'view'}: this runtime has no such constructor`,
    );
  }

  if (name !== undefined && isSubclass(view, View, name)) {
    return Reflect.apply(
      Reflect.get(typedArrayPrototype(), 'slice') as () => object,
      view,
      [],
    );
  }

  // Its extent read once, so the copy and the view over it agree even where a worker
  // grows the buffer meanwhile: the new view spans the whole copy.
  const copy = copyBytes(
    buffer,
    bufferConstructor(arrayBufferKindOf(buffer) ?? 'ArrayBuffer'),
    read('byteOffset') as number,
    read('byteLength') as number,
  );

  return new View(copy);
}

/**
 * This realm's constructor for a buffer kind. A shared buffer is only told as one where
 * this realm has `SharedArrayBuffer` (its intrinsic getter is the check); a view over one
 * from another realm, where this one has none, is copied into an `ArrayBuffer`.
 */
function bufferConstructor(kind: BufferKind): BufferConstructorLike {
  return (kind === 'SharedArrayBuffer'
    ? (globalConstructor('SharedArrayBuffer') ?? ArrayBuffer)
    : ArrayBuffer) as unknown as BufferConstructorLike;
}

/**
 * Whether `original` is a subclass's instance rather than a built-in type's own - this
 * realm's, or another realm's `Uint8Array.prototype`. A subclass is copied through its
 * own constructor, by the shared `slice` and its species, so its instance fields - a
 * private field its methods read - are set up as they are for any instance of it. Told
 * by the prototype's own constructor and its name, not by `instanceof`, which a `Buffer`
 * fails where the globals are another realm's (a jsdom test environment).
 */
function isSubclass(
  original: object,
  Base: { readonly prototype: object },
  baseName: string,
): boolean {
  const prototype = Object.getPrototypeOf(original) as object | null;

  return (
    prototype !== null &&
    prototype !== Base.prototype &&
    !isBasePrototype(prototype, baseName)
  );
}

/** Whether `prototype` is some realm's own prototype of the built-in type `name`. */
function isBasePrototype(prototype: object, name: string): boolean {
  return basePrototypeName(prototype) === name;
}

/**
 * The name of the constructor whose own prototype `prototype` is - its own `constructor`,
 * whose own `prototype` is it, and that constructor's own `name` - read by descriptor, so
 * no getter runs; `undefined` for any other prototype. How some realm's built-in prototype
 * is told by name.
 */
function basePrototypeName(prototype: object): string | undefined {
  const constructor: unknown = Reflect.getOwnPropertyDescriptor(
    prototype,
    'constructor',
  )?.value;

  if (
    typeof constructor !== 'function' ||
    Reflect.getOwnPropertyDescriptor(constructor, 'prototype')?.value !==
      prototype
  ) {
    return undefined;
  }

  const name: unknown = Reflect.getOwnPropertyDescriptor(
    constructor,
    'name',
  )?.value;
  return typeof name === 'string' ? name : undefined;
}

/** A constructor this realm defines under `name`, if it does. */
function globalConstructor(name: string): (new () => object) | undefined {
  const value: unknown = Reflect.get(globalThis, name);

  return typeof value === 'function' ? (value as new () => object) : undefined;
}
