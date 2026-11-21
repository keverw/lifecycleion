/**
 * The month names and calendar check the client's two date readers share: `Retry-After`'s
 * HTTP-date and a cookie's `Expires`.
 */

import { asciiLowercase } from '../../internal/ascii-text';

/** The short month names, from January. */
export const SHORT_MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** The long month names, from January. Each begins with its short name. */
export const LONG_MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MONTH_INDEXES: ReadonlyMap<string, number> = new Map(
  SHORT_MONTH_NAMES.map((month, index) => [asciiLowercase(month), index]),
);

/**
 * The month `name` begins with, by its first three letters in any ASCII case, from 0 for
 * January - `Nov` and `November` are 10 - or `-1` for none.
 */
export function monthIndexOf(name: string): number {
  return MONTH_INDEXES.get(asciiLowercase(name.slice(0, 3))) ?? -1;
}

/**
 * The epoch time of a date and time read as UTC, or `undefined` for one that names no
 * real moment: a month outside 0 to 11, a day the month does not have (`31 Feb`), an hour
 * past 23, or a minute or second past 59. A year below 100 is that year, not 19xx.
 */
export function utcMoment(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  if (
    month < 0 ||
    month > 11 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }

  // `setUTCFullYear`, not `Date.UTC`, which reads a year below 100 as 19xx.
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second);

  // Rolled over into the next month: no such day.
  return date.getUTCMonth() === month ? date.getTime() : undefined;
}
