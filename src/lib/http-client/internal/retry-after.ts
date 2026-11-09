/**
 * `Retry-After` as the client reads it before a retry (RFC 9110 section 10.2.3).
 */

import { trimHTTPWhitespace } from '../../internal/ascii-text';

/**
 * The retryable statuses whose `Retry-After` the client honors: `429 Too Many Requests`
 * and `503 Service Unavailable`, the two RFC 9110 and RFC 6585 name it for as a wait
 * before trying again. On a redirect it means something else, and no other retryable
 * status is defined to carry it.
 */
export const RETRY_AFTER_STATUS_CODES: ReadonlySet<number> = new Set([
  429, 503,
]);

const MONTHS = [
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

const MONTH = `(${MONTHS.join('|')})`;
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})';

/** `Sun, 06 Nov 1994 08:49:37 GMT` - the preferred form. */
const IMF_FIXDATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`,
);
/** `Sunday, 06-Nov-94 08:49:37 GMT` - obsolete RFC 850, a two-digit year. */
const RFC850_DATE = new RegExp(
  `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`,
);
/** `Sun Nov  6 08:49:37 1994` - obsolete asctime, in GMT though it says no zone. */
const ASCTIME_DATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} ( \\d|\\d{2}) ${TIME} (\\d{4})$`,
);

/**
 * How long a `Retry-After` value asks the client to wait, in milliseconds from `now` (an
 * epoch time), or `undefined` for a value that is neither form RFC 9110 defines: a whole
 * number of seconds (`120`), or an HTTP-date in any of its three forms, which a recipient
 * must accept - read as GMT, case-sensitively, as written. A date already past asks for
 * no wait (`0`). Trimmed of HTTP whitespace only. Repeated seconds that agree
 * (`120, 120`) are one value. Anything else - a fraction, a sign, a date in another
 * format, values that disagree - is unreadable, and the retry policy's own delay is used.
 */
export function parseRetryAfterMS(
  value: string | undefined,
  now: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const text = trimHTTPWhitespace(value);

  // A header seen twice reaches the client joined (`120, 120`) from `fetch` and XHR, and
  // as its first value from Node, which drops a repeated `Retry-After`: values that agree
  // are read as one, as each runtime would then wait the same.
  const seconds = /^(\d+)(?:[ \t]*,[ \t]*\1)*$/.exec(text);
  if (seconds) {
    return Number(seconds[1]) * 1000;
  }

  const at = parseHTTPDate(text, now);

  return at === undefined ? undefined : Math.max(0, at - now);
}

/** The epoch time an HTTP-date names, or `undefined` when `text` is not one. */
function parseHTTPDate(text: string, now: number): number | undefined {
  let match = IMF_FIXDATE.exec(text);
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    return utcTime(+year, month, +day, +hour, +minute, +second);
  }

  match = RFC850_DATE.exec(text);
  if (match) {
    const [, day, month, year, hour, minute, second] = match;
    return utcTime(
      fullYearOf(+year, now),
      month,
      +day,
      +hour,
      +minute,
      +second,
    );
  }

  match = ASCTIME_DATE.exec(text);
  if (match) {
    const [, month, day, hour, minute, second, year] = match;
    return utcTime(+year, month, +day, +hour, +minute, +second);
  }

  return undefined;
}

/**
 * The full year an RFC 850 two-digit year names: in the current century, unless that is
 * more than 50 years from `now`, which RFC 9110 reads as the most recent past year with
 * those digits.
 */
function fullYearOf(twoDigitYear: number, now: number): number {
  const currentYear = new Date(now).getUTCFullYear();
  const year = currentYear - (currentYear % 100) + twoDigitYear;

  return year > currentYear + 50 ? year - 100 : year;
}

/**
 * The epoch time of a GMT date and time, or `undefined` for one that names no real
 * moment (`31 Feb`, `24:00:00`, `12:00:60`). A leap second, `23:59:60`, is read as the
 * second after it.
 */
function utcTime(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = MONTHS.indexOf(monthName as (typeof MONTHS)[number]);

  const isLeapSecond = hour === 23 && minute === 59 && second === 60;

  if (hour > 23 || minute > 59 || (second > 59 && !isLeapSecond) || day < 1) {
    return undefined;
  }

  // `setUTCFullYear`, not `Date.UTC`, which reads a year below 100 as 19xx.
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, isLeapSecond ? 59 : second);

  // Rolled over into the next month: no such day.
  if (date.getUTCMonth() !== month) {
    return undefined;
  }

  return date.getTime() + (isLeapSecond ? 1000 : 0);
}
