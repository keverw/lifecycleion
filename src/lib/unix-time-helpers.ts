/**
 * Returns the current unix time in seconds
 *
 * ```typescript
 * const time = unix();
 * ```
 */

export function unix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Returns the current unix time in milliseconds
 *
 *  ```typescript
 * const time = ms();
 * ```
 */

export function ms(): number {
  return Date.now();
}

/**
 * Returns a high resolution timestamp
 * Returns the time measured in milliseconds
 * This is aimed at performance monitoring
 *
 * ```typescript
 * const time = performance();
 * ```
 */

export function performance(): number {
  return globalThis.performance.now();
}

/**
 * Converts a Unix timestamp from milliseconds to seconds.
 * Useful for converting the millisecond-based timestamp from JavaScript's Date.now() into a Unix timestamp in seconds.
 *
 * @param {number} value - Unix timestamp in milliseconds.
 * @returns {number} - Unix timestamp converted to seconds.
 *
 * ```typescript
 * convertMSToUnix(1593189055006); // returns 1593189055
 * ```
 */

export function convertMSToUnix(value: number): number {
  return Math.floor(value / 1000);
}

/**
 * Converts a Unix timestamp from seconds to milliseconds.
 *
 * This function takes a Unix timestamp in seconds and converts it to milliseconds.
 * This is useful when dealing with JavaScript's Date object or other systems that
 * require time in milliseconds.
 *
 * @param {number} value - The Unix timestamp in seconds.
 * @returns {number} The Unix timestamp in milliseconds.
 *
 * Example:
 * ```typescript
 * convertUnix(1593189055); // returns 1593189055000
 * ```
 */

export function convertUnixToMS(value: number): number {
  return value * 1000;
}
