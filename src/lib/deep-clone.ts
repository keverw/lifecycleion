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

  // Handle typed arrays
  if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
    const typedArray = obj as unknown as
      | Int8Array
      | Uint8Array
      | Uint8ClampedArray
      | Int16Array
      | Uint16Array
      | Int32Array
      | Uint32Array
      | Float32Array
      | Float64Array
      | BigInt64Array
      | BigUint64Array;
    // The shared `%TypedArray%.prototype.slice`, not the array's own: `Buffer`
    // overrides `slice` to return a view on the same memory, so a cloned `Buffer` was
    // the original under another name.
    const cloned = (
      Object.getPrototypeOf(Uint8Array.prototype) as {
        slice: (this: typeof typedArray) => typeof typedArray;
      }
    ).slice.call(typedArray);
    return remember(seen, obj, cloned);
  }

  // A `DataView` over a copy of its bytes, and an `ArrayBuffer` copied: both fell through
  // to the plain-object branch and came back as `{}`.
  if (obj instanceof DataView) {
    return remember(
      seen,
      obj,
      new DataView(
        obj.buffer.slice(obj.byteOffset, obj.byteOffset + obj.byteLength),
      ),
    );
  }

  if (obj instanceof ArrayBuffer) {
    return remember(seen, obj, obj.slice(0));
  }

  // Handle Array
  if (Array.isArray(obj)) {
    const cloned = remember<unknown[]>(seen, obj, []);

    for (const item of obj) {
      cloned.push(cloneInternal(item, seen));
    }

    return cloned as T;
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
