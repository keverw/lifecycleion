/**
 * Utilities to pad strings with another string up to a defined length.
 * Each function takes a string, length to pad and the string to be used for padding (but defaults to a blank space if not provided) and returns the modified string
 *
 * This only pads on the left side, so text is added to the front until the total string equals the given length.
 *
 * ```typescript
 * padLeft('Hey', 6, '*'); // returns ***Hey
 * ```
 * @category String Padding
 */

import { BLANK_SPACE } from './constants';

export function padLeft(
  str: string,
  length: number,
  padStr = BLANK_SPACE,
): string {
  return str.padStart(length, padStr);
}

/**
 * This only pads on the right side, so text is added to the end until the total string equals the given length.
 *
 * ```typescript
 * padRight('Hey', 6, '*'); // returns Hey***
 * ```
 *
 * @category String Padding
 */

export function padRight(
  str: string,
  length: number,
  padStr = BLANK_SPACE,
): string {
  return str.padEnd(length, padStr);
}

/**
 * Same as `padCenterPreferLeft` and `padCenterPreferRight` but you can pass in a string with `left` or `right` before the padStr to use more direct.
 *
 * Defaults to `left`
 *
 * @category String Padding
 */

export function padCenter(
  str: string,
  length: number,
  prefer: 'left' | 'right' = 'left',
  padStr = BLANK_SPACE,
): string {
  const midStrLength = length - str.length;

  if (midStrLength > 0) {
    const padLeftAmount =
      prefer === 'left'
        ? Math.ceil(midStrLength / 2)
        : Math.floor(midStrLength / 2);

    const padRightAmount =
      prefer === 'left'
        ? Math.floor(midStrLength / 2)
        : Math.ceil(midStrLength / 2);

    return (
      padLeft('', padLeftAmount, padStr) +
      str +
      padRight('', padRightAmount, padStr)
    );
  } else {
    return str;
  }
}

/**
 * It tries to pad equally on both sides in an attempt to center your text. However if it can't the extra character will be added to the left side
 *
 * @category String Padding
 */

export function padCenterPreferLeft(
  str: string,
  length: number,
  padStr = BLANK_SPACE,
): string {
  return padCenter(str, length, 'left', padStr);
}

/**
 * It tries to pad equally, but if it can't the extra character will be added to the right side
 *
 * @category String Padding
 */

export function padCenterPreferRight(
  str: string,
  length: number,
  padStr = BLANK_SPACE,
): string {
  return padCenter(str, length, 'right', padStr);
}
