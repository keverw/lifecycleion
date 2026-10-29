/**
 * Deep clone utility
 *
 * Creates a deep copy of a value, recursively cloning nested structures.
 * Handles most common data types including objects, arrays, dates, regexes,
 * Maps, Sets, and typed arrays.
 *
 * Note: Functions are returned by reference (not cloned). Circular references
 * are detected and handled to prevent infinite recursion.
 */

import { defineEntry } from './internal/define-entry';
import {
  arrayBufferKindOf,
  hasBufferTagInChain,
  typedArrayNameOf,
} from './internal/binary-view';

/**
 * Deep clone an object or value
 *
 * @param obj - The value to clone
 * @returns A deep clone of the input value
 */
export function deepClone<T>(obj: T): T {
  return cloneInternal(obj, new WeakMap());
}

function cloneInternal<T>(obj: T, seen: WeakMap<object, unknown>): T {
  // Primitives and null/undefined return as-is
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Check for circular references
  if (seen.has(obj)) {
    return seen.get(obj) as T;
  }

  // Handle Date
  if (obj instanceof Date) {
    return remember(seen, obj, new Date(obj));
  }

  // Handle RegExp
  if (obj instanceof RegExp) {
    const flags = obj.flags;
    const cloned = new RegExp(obj.source, flags);
    cloned.lastIndex = obj.lastIndex;
    return remember(seen, obj, cloned);
  }

  // Handle Map
  if (obj instanceof Map) {
    const cloned = remember<Map<unknown, unknown>>(seen, obj, new Map());

    for (const [key, value] of obj) {
      cloned.set(cloneInternal(key, seen), cloneInternal(value, seen));
    }

    return cloned as T;
  }

  // Handle Set
  if (obj instanceof Set) {
    const cloned = remember<Set<unknown>>(seen, obj, new Set());

    for (const value of obj) {
      cloned.add(cloneInternal(value, seen));
    }

    return cloned as T;
  }

  // A typed array or `DataView`: a copy of the bytes it covers, so a small view of a
  // large buffer - a `subarray` of a file read whole - does not copy the buffer behind it.
  // Two views of one buffer, or a view and its buffer, do not share memory in the clone.
  if (ArrayBuffer.isView(obj)) {
    return remember(seen, obj, cloneView(obj));
  }

  // An array of the same length, each index it holds cloned: a hole stays a
  // hole, as `structuredClone` keeps it, rather than becoming an `undefined` entry - one
  // emptied while the clone is made included. Read by index, not through an own
  // `Symbol.iterator`. Named entries (a `match` result's `index`) are not copied: listing
  // the keys to find them costs a dense array many times its clone.
  if (Array.isArray(obj)) {
    const source = obj as unknown[];
    const cloned = remember<unknown[]>(seen, obj, new Array(source.length));

    for (let index = 0; index < source.length; index++) {
      if (index in source) {
        cloned[index] = cloneInternal(source[index], seen);
      }
    }

    return cloned as T;
  }

  // An `ArrayBuffer` or `SharedArrayBuffer`: copied whole into a new one of its kind.
  const bufferKind = bufferKindOf(obj);
  if (bufferKind !== undefined) {
    return remember(seen, obj, copyBuffer(obj, bufferKind));
  }

  // Handle plain objects
  const cloned = remember<Record<string, unknown>>(seen, obj, {});

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      // Defined, not assigned: an own `__proto__` key (`JSON.parse` makes one) would
      // otherwise reparent the clone instead of being copied.
      defineEntry(
        cloned,
        key,
        cloneInternal((obj as Record<string, unknown>)[key], seen),
      );
    }
  }

  return cloned as T;
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
