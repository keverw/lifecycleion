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
