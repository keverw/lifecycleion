export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * Clamps a value to a minimum, returning a default if the value is not finite or is undefined/null.
 *
 * Useful for config/settings validation where you want to:
 * - Enforce a minimum value
 * - Handle invalid inputs (Infinity, NaN, undefined, null) gracefully
 *
 * @param value - The value to clamp (can be undefined or null)
 * @param min - The minimum allowed value
 * @param defaultValue - The default to return if value is not finite or is undefined/null
 * @returns The clamped value, or defaultValue if value is not finite/undefined/null
 *
 * @example
 * ```typescript
 * finiteClampMin(5000, 1000, 3000) // 5000 (value > min)
 * finiteClampMin(500, 1000, 3000)  // 1000 (enforces min)
 * finiteClampMin(Infinity, 1000, 3000) // 3000 (not finite, use default)
 * finiteClampMin(NaN, 1000, 3000)      // 3000 (not finite, use default)
 * finiteClampMin(undefined, 1000, 3000) // 3000 (undefined, use default)
 * finiteClampMin(null, 1000, 3000)      // 3000 (null, use default)
 * ```
 */
export function finiteClampMin(
  value: number | undefined | null,
  min: number,
  defaultValue: number,
): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return defaultValue;
  }

  return Math.max(value, min);
}
