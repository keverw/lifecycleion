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

/**
 * Deep clone an object or value
 *
 * @param obj - The value to clone
 * @param seen - Internal WeakMap for tracking circular references (do not pass manually)
 * @returns A deep clone of the input value
 */
export function deepClone<T>(obj: T, seen = new WeakMap()): T {
  // Primitives and null/undefined return as-is
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Check for circular references
  if (seen.has(obj as object)) {
    return seen.get(obj as object) as T;
  }

  // Handle Date
  if (obj instanceof Date) {
    return new Date(obj) as T;
  }

  // Handle RegExp
  if (obj instanceof RegExp) {
    const flags = obj.flags;
    const cloned = new RegExp(obj.source, flags);
    cloned.lastIndex = obj.lastIndex;
    return cloned as T;
  }

  // Handle Map
  if (obj instanceof Map) {
    const cloned = new Map();
    seen.set(obj as object, cloned);

    for (const [key, value] of obj) {
      cloned.set(deepClone(key, seen), deepClone(value, seen));
    }

    return cloned as T;
  }

  // Handle Set
  if (obj instanceof Set) {
    const cloned = new Set();
    seen.set(obj as object, cloned);

    for (const value of obj) {
      cloned.add(deepClone(value, seen));
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
    const cloned = typedArray.slice();
    return cloned as T;
  }

  // Handle Array
  if (Array.isArray(obj)) {
    const cloned: unknown[] = [];
    seen.set(obj as object, cloned);

    for (const item of obj) {
      cloned.push(deepClone(item, seen));
    }

    return cloned as T;
  }

  // Handle plain objects
  const cloned: Record<string, unknown> = {};
  seen.set(obj as object, cloned);

  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      cloned[key] = deepClone((obj as Record<string, unknown>)[key], seen);
    }
  }

  return cloned as T;
}
