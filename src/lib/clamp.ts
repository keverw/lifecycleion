export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

/**
 * {@link clamp}, for a value that has to come out finite.
 *
 * `clamp` is `Math.max`/`Math.min`, and both launder `NaN`: `clamp(NaN, 1, Infinity)` is
 * `NaN`, not `1`. Every caller that turns the result into a duration then inherits it -
 * a `NaN` delay reads as "not greater than zero", which callers spell as *now*, so a
 * bound meant to slow something down removed the wait entirely. `Infinity` is refused for
 * the same reason from the other end: `setTimeout(Infinity)` fires on the next tick.
 *
 * @param value - The value to clamp.
 * @param min - Lower bound. Must itself be finite for the result to be.
 * @param max - Upper bound.
 * @param defaultValue - Returned when `value` is not finite.
 * @returns `value` clamped to `[min, max]`, or `defaultValue` when `value` is `NaN`,
 *          `Infinity` or `-Infinity`.
 */
export function finiteClamp(
  value: number,
  min: number,
  max: number,
  defaultValue: number,
): number {
  if (!Number.isFinite(value)) {
    return defaultValue;
  }

  return clamp(value, min, max);
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
