/**
 * Type guard to check if a value is a boolean.
 *
 * @param value - Value to check
 * @returns `true` if the value is a boolean, `false` otherwise
 *
 * @example
 * ```typescript
 * isBoolean(true);       // true
 * isBoolean(false);      // true
 * isBoolean(1);          // false
 * isBoolean('true');     // false
 * isBoolean(null);       // false
 * isBoolean(undefined);  // false
 * ```
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Type guard to check if a value is a plain object (not null, not an array).
 *
 * @param value - Value to check
 * @returns `true` if the value is a plain object, `false` otherwise
 *
 * @example
 * ```typescript
 * isPlainObject({});           // true
 * isPlainObject({ a: 1 });     // true
 * isPlainObject([]);           // false
 * isPlainObject(null);         // false
 * isPlainObject(undefined);    // false
 * isPlainObject('string');     // false
 * isPlainObject(42);           // false
 * ```
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
