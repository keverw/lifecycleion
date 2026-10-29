/**
 * Deep clone utility
 *
 * Creates a deep copy of a value, recursively cloning nested structures.
 * Handles most common data types including objects, arrays, dates, regexes,
 * errors, Maps, Sets, and typed arrays.
 *
 * Note: Functions are returned by reference (not cloned). Circular references
 * are detected and handled to prevent infinite recursion.
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

/** What one `deepClone` call carries through its recursion. */
interface CloneState {
  seen: WeakMap<object, unknown>;
  arrayKeys: readonly string[];
}

/** The named entries `exec` and `match` give a match result. */
const MATCH_RESULT_KEYS: readonly string[] = [
  'index',
  'input',
  'groups',
  'indices',
];

/**
 * Deep clone an object or value
 *
 * @param obj - The value to clone
 * @param options - See {@link DeepCloneOptions}
 * @returns A deep clone of the input value
 */
export function deepClone<T>(obj: T, options?: DeepCloneOptions): T {
  // An object or absent: anything else is refused here, in this module's words, rather
  // than read as no options or failing in the runtime's.
  const given: unknown = options;
  if (given !== undefined && (typeof given !== 'object' || given === null)) {
    throw new TypeError('deepClone: options must be an object');
  }

  return cloneInternal(obj, {
    seen: new WeakMap(),
    arrayKeys: readArrayKeys(options?.arrayKeys),
  });
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

function cloneInternal<T>(obj: T, state: CloneState): T {
  // Primitives and null/undefined return as-is
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Check for circular references
  if (state.seen.has(obj)) {
    return state.seen.get(obj) as T;
  }

  // Handle Date
  if (obj instanceof Date) {
    return remember(state.seen, obj, new Date(obj));
  }

  // Handle RegExp
  if (obj instanceof RegExp) {
    const flags = obj.flags;
    const cloned = new RegExp(obj.source, flags);
    cloned.lastIndex = obj.lastIndex;
    return remember(state.seen, obj, cloned);
  }

  // Handle Map
  if (obj instanceof Map) {
    const cloned = remember<Map<unknown, unknown>>(state.seen, obj, new Map());

    for (const [key, value] of obj) {
      cloned.set(cloneInternal(key, state), cloneInternal(value, state));
    }

    return cloned as T;
  }

  // Handle Set
  if (obj instanceof Set) {
    const cloned = remember<Set<unknown>>(state.seen, obj, new Set());

    for (const value of obj) {
      cloned.add(cloneInternal(value, state));
    }

    return cloned as T;
  }

  // A typed array or `DataView`: a copy of the bytes it covers, so a small view of a
  // large buffer - a `subarray` of a file read whole - does not copy the buffer behind it.
  // Two views of one buffer, or a view and its buffer, do not share memory in the clone.
  if (ArrayBuffer.isView(obj)) {
    return remember(state.seen, obj, cloneView(obj));
  }

  // An array of the same length, each index it holds cloned: a hole stays a
  // hole, as `structuredClone` keeps it, rather than becoming an `undefined` entry - one
  // emptied while the clone is made included. Read by index, not through an own
  // `Symbol.iterator`. Named entries are not listed - that would cost a dense array many
  // times its clone - so only a match result's and `arrayKeys`' are copied.
  if (Array.isArray(obj)) {
    const source = obj as unknown[];
    const cloned = remember<unknown[]>(
      state.seen,
      obj,
      new Array(source.length),
    );

    for (let index = 0; index < source.length; index++) {
      if (index in source) {
        cloned[index] = cloneInternal(source[index], state);
      }
    }

    copyNamedArrayEntries(source, cloned, state);

    return cloned as T;
  }

  // An `ArrayBuffer` or `SharedArrayBuffer`: copied whole into a new one of its kind.
  const bufferKind = bufferKindOf(obj);
  if (bufferKind !== undefined) {
    return remember(state.seen, obj, copyBuffer(obj, bufferKind));
  }

  if (isError(obj)) {
    return cloneError(obj, state) as T;
  }

  // Handle plain objects
  const cloned = remember<Record<string, unknown>>(state.seen, obj, {});

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      // Defined, not assigned: an own `__proto__` key (`JSON.parse` makes one) would
      // otherwise reparent the clone instead of being copied.
      defineEntry(
        cloned,
        key,
        cloneInternal((obj as Record<string, unknown>)[key], state),
      );
    }
  }

  return cloned as T;
}

/**
 * The named entries of `source` that `cloned` carries over: a match result's (one whose
 * first entry is a string and that holds an own `index`, as lodash tells one), with the
 * `groups` its `indices` array holds under the `d` flag, and those named in `arrayKeys` -
 * each only when `source` holds it as its own, read once and cloned. Defined, not
 * assigned, so a `__proto__` named there is copied as an entry.
 */
function copyNamedArrayEntries(
  source: unknown[],
  cloned: unknown[],
  state: CloneState,
): void {
  // Told by the clone's first entry, not read again from the source: a string clones as
  // itself.
  const isMatchResult =
    typeof cloned[0] === 'string' && Object.hasOwn(source, 'index');
  const keys = isMatchResult
    ? [
        ...MATCH_RESULT_KEYS,
        ...state.arrayKeys.filter((key) => !MATCH_RESULT_KEYS.includes(key)),
      ]
    : state.arrayKeys;
  const record = source as unknown as Record<string, unknown>;
  const target = cloned as unknown as Record<string, unknown>;

  for (const key of keys) {
    if (!Object.hasOwn(record, key)) {
      continue;
    }

    const value = record[key];
    const copy = cloneInternal(value, state);
    defineEntry(target, key, copy);

    if (
      isMatchResult &&
      key === 'indices' &&
      Array.isArray(value) &&
      Array.isArray(copy) &&
      Object.hasOwn(value, 'groups')
    ) {
      defineEntry(
        copy as unknown as Record<string, unknown>,
        'groups',
        cloneInternal(
          (value as unknown as Record<string, unknown>).groups,
          state,
        ),
      );
    }
  }
}

/**
 * Whether `value` is an `Error` or a `DOMException`, told by its internal state - through
 * `Error.isError`, from any realm (a `vm` context, an iframe), and the `DOMException`
 * check, which Bun's `Error.isError` refuses - without reading anything of it, so a
 * Proxy's traps are not run. A runtime without `Error.isError` tells an `Error` by
 * `instanceof`, this realm's only.
 */
function isError(value: object): value is Error {
  const isErrorSlot = (Error as { isError?: (value: unknown) => boolean })
    .isError;

  return (
    (typeof isErrorSlot === 'function'
      ? isErrorSlot(value)
      : value instanceof Error) || isDOMExceptionInstance(value)
  );
}

/**
 * An `Error` cloned on its own prototype, so `instanceof` and a subclass's `name` hold:
 * every own string-keyed property - `message`, `stack`, `cause`, an `AggregateError`'s
 * `errors`, a subclass's `code` - read once and cloned, as enumerable as it was. A
 * `stack` the engine serves through an accessor is copied as the text it reads as.
 *
 * Built on a real error - a `new Error()` emptied of its own properties, or for a
 * `DOMException` a `new DOMException` of its message and name, whose getters read that
 * state - so the clone is an error to `Error.isError` and `Object.prototype.toString`, and
 * clones again as one. A subclass's private fields, and anything else its constructor sets
 * up beyond own properties, are not there: its methods that read them throw on the clone.
 */
function cloneError(source: Error, state: CloneState): Error {
  const base = isDOMExceptionInstance(source)
    ? new DOMException(source.message, source.name)
    : new Error();

  for (const key of Reflect.ownKeys(base)) {
    Reflect.deleteProperty(base, key);
  }

  Reflect.setPrototypeOf(base, Reflect.getPrototypeOf(source));
  const cloned = remember<Error>(state.seen, source, base);
  const record = source as unknown as Record<string, unknown>;

  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== 'string') {
      continue;
    }

    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    Object.defineProperty(cloned, key, {
      // eslint-disable-next-line @typescript-eslint/naming-convention
      __proto__: null,
      value: cloneInternal(record[key], state),
      writable: true,
      enumerable: descriptor?.enumerable === true,
      configurable: true,
    } as PropertyDescriptor);
  }

  return cloned;
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
  new (buffer: ArrayBuffer, byteOffset: number, length: number): object;
  readonly prototype: object;
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(
  Uint8Array.prototype,
) as object;

/** This realm's `SharedArrayBuffer`, where the runtime has one. */
const SHARED_ARRAY_BUFFER = globalConstructor('SharedArrayBuffer');

/**
 * Whether `value` is a buffer, and which kind, told by its internal slot through the
 * intrinsic getters - which throw for anything else without running a `Proxy`'s traps or
 * a getter of the value's. Asked only of what may be one: an object whose prototype
 * chain holds this realm's `ArrayBuffer` or `SharedArrayBuffer` (an object that merely
 * inherits from one is not one, and is cloned as a plain object), or one from another
 * realm (a `vm` context, an iframe) whose chain holds that realm's. So this realm's plain
 * objects and class instances, another realm's plain objects, and null-prototype
 * dictionaries never pay for the check. A buffer whose prototype was taken away is not
 * told, as a `Date` or `Map` whose prototype was taken away is not.
 */
function bufferKindOf(value: object): BufferKind | undefined {
  if (
    value instanceof ArrayBuffer ||
    (SHARED_ARRAY_BUFFER !== undefined && value instanceof SHARED_ARRAY_BUFFER)
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
      name === undefined ? DataView.prototype : TYPED_ARRAY_PROTOTYPE,
      key,
      view,
    );
  const buffer = read('buffer') as object;
  const View = (name === undefined
    ? DataView
    : globalConstructor(name)) as unknown as ViewConstructorLike | undefined;
  if (View === undefined) {
    throw new TypeError(
      `deepClone cannot clone a ${name ?? 'view'}: this runtime has no such constructor`,
    );
  }

  if (name !== undefined && isSubclass(view, View, name)) {
    return Reflect.apply(
      Reflect.get(TYPED_ARRAY_PROTOTYPE, 'slice') as () => object,
      view,
      [],
    );
  }

  const copy = copyBytes(
    buffer,
    bufferConstructor(arrayBufferKindOf(buffer) ?? 'ArrayBuffer'),
    read('byteOffset') as number,
    read('byteLength') as number,
  );

  return new View(
    copy,
    0,
    read(name === undefined ? 'byteLength' : 'length') as number,
  );
}

/**
 * This realm's constructor for a buffer kind. A shared buffer is only told as one where
 * this realm has `SharedArrayBuffer` (its intrinsic getter is the check); a view over one
 * from another realm, where this one has none, is copied into an `ArrayBuffer`.
 */
function bufferConstructor(kind: BufferKind): BufferConstructorLike {
  return (kind === 'SharedArrayBuffer'
    ? (SHARED_ARRAY_BUFFER ?? ArrayBuffer)
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
  const constructor: unknown = Object.getOwnPropertyDescriptor(
    prototype,
    'constructor',
  )?.value;

  return (
    typeof constructor === 'function' &&
    Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value ===
      prototype &&
    Object.getOwnPropertyDescriptor(constructor, 'name')?.value === name
  );
}

/** A constructor this realm defines under `name`, if it does. */
function globalConstructor(name: string): (new () => object) | undefined {
  const value: unknown = Reflect.get(globalThis, name);

  return typeof value === 'function' ? (value as new () => object) : undefined;
}
