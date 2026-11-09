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
 * no wait (`0`). Trimmed of HTTP whitespace only. Repeated values that agree, joined
 * (`120, 120`), are one value (see `singleValue`). Anything else - a
 * fraction, a sign, a date in another format, values that disagree - is unreadable, and
 * the retry policy's own delay is used.
 */
export function parseRetryAfterMS(
  value: string | undefined,
  now: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const text = singleValue(value);

  if (text === undefined) {
    return undefined;
  }

  if (/^\d+$/.test(text)) {
    return Number(text) * 1000;
  }

  const at = parseHTTPDate(text, now);

  return at === undefined ? undefined : Math.max(0, at - now);
}

/**
 * The one value a `Retry-After` holds, trimmed of HTTP whitespace, or `undefined` for
 * repeated values that disagree. A header seen twice reaches the client joined
 * (`120, 120`) from `fetch` and XHR, and as its first value from Node, which drops a
 * repeated `Retry-After` - as the client reads one an adapter hands over as an array
 * (see `normalizeAdapterResponseHeaders`): values that agree are read as one, so each
 * runtime waits the same. Told apart by the commas
 * between them - one value of the forms with a comma (an IMF-fixdate or RFC 850 date)
 * spans two comma-separated pieces, any other form one.
 */
function singleValue(text: string): string | undefined {
  const pieces = text.split(',').map((piece) => trimHTTPWhitespace(piece));

  for (const size of [1, 2]) {
    if (pieces.length % size !== 0) {
      continue;
    }

    const values: string[] = [];
    for (let index = 0; index < pieces.length; index += size) {
      values.push(pieces.slice(index, index + size).join(', '));
    }

    if (values.every((candidate) => candidate === values[0])) {
      return values[0];
    }
  }

  return undefined;
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
    // The latest year with those two digits that is not more than 50 years from `now`,
    // as RFC 9110 reads one: one that appears more than 50 years ahead is the most recent
    // past year with those digits.
    const currentYear = new Date(now).getUTCFullYear();
    const fiftyYearsOn = new Date(now);
    fiftyYearsOn.setUTCFullYear(currentYear + 50);
    const limit = fiftyYearsOn.getTime();

    for (
      let fullYear = currentYear - (currentYear % 100) + +year + 100;
      fullYear >= currentYear - 100;
      fullYear -= 100
    ) {
      const at = utcTime(fullYear, month, +day, +hour, +minute, +second);

      if (at === undefined) {
        return undefined;
      }

      if (at <= limit) {
        return at;
      }
    }

    return undefined;
  }

  match = ASCTIME_DATE.exec(text);
  if (match) {
    const [, month, day, hour, minute, second, year] = match;
    return utcTime(+year, month, +day, +hour, +minute, +second);
  }

  return undefined;
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
