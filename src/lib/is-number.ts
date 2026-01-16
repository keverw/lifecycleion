/**
 * Type guard to check if a value is a valid number.
 *
 * @param value - Value to check
 * @returns `true` if the value is a number and not NaN, `false` otherwise
 *
 * @example
 * ```typescript
 * isNumber(42);        // true
 * isNumber(3.14);      // true
 * isNumber(NaN);       // false
 * isNumber('123');     // false
 * isNumber(null);      // false
 * isNumber(undefined); // false
 * ```
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}
