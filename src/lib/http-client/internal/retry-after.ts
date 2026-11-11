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
 * must accept - read as GMT, case-sensitively, as written, its day name not checked
 * against the date, as browsers' and most HTTP libraries' parsers do not check it. A
 * date already past asks for no wait (`0`). Trimmed of HTTP whitespace only. Anything else - a fraction, a sign, a
 * date in another format or spaced otherwise - is unreadable, and the retry policy's own
 * delay is used.
 *
 * Only the first value is read. A header seen twice reaches the client joined
 * (`120, 60`) from `fetch` and XHR, and as its first value from Node, which drops a
 * repeated `Retry-After` - as the client keeps the first of one an adapter hands over as
 * an array (see `normalizeAdapterResponseHeaders`) - so each runtime waits the same: the
 * first value, whether or not the others agree with it. Told apart by the commas between
 * them: an IMF-fixdate or RFC 850 date holds one, after its day name, so it spans the
 * first two comma-separated pieces; a number of seconds or an asctime date the first.
 *
 * An HTTP-date is measured two ways when the response's `Date` header, read by its first
 * value the same way, is an HTTP-date too: from `now`, the client's clock, and from that
 * `Date`, the server's own clock, and the shorter wait is used. A client clock behind the
 * server's makes the first too long, and a cache's stored answer, whose `Date` is the
 * origin's from when it was made, the second, so the shorter is the closer in both. A
 * client clock ahead of the server's makes the first too short, as it does when `now`
 * alone is read, and a `Date` from another clock than the `Retry-After`'s - a proxy's
 * written over the origin's - can make the second too short. Without a readable `Date`,
 * it is measured from `now`.
 */
export function parseRetryAfterMS(
  value: string | undefined,
  now: number,
  responseDate?: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const pieces = value.split(',');
  const first = trimHTTPWhitespace(pieces[0]);

  if (/^\d+$/.test(first)) {
    return Number(first) * 1000;
  }

  const at = parseFirstHTTPDate(pieces, now);
  if (at === undefined) {
    return undefined;
  }

  const serverNow =
    responseDate === undefined
      ? undefined
      : parseFirstHTTPDate(responseDate.split(','), now);
  const wait =
    serverNow === undefined ? at - now : Math.min(at - now, at - serverNow);

  return Math.max(0, wait);
}

/**
 * The epoch time the first value of a header names, when it is an HTTP-date, from the
 * header split at its commas (`pieces`): the first two pieces, as an IMF-fixdate or RFC
 * 850 date holds a comma, else the first (see `parseRetryAfterMS`). Rejoined as it was
 * written, so a date spaced otherwise than `Sun, 06 Nov ...` is not made into one that is.
 */
function parseFirstHTTPDate(
  pieces: readonly string[],
  now: number,
): number | undefined {
  return (
    (pieces.length > 1
      ? parseHTTPDate(trimHTTPWhitespace(`${pieces[0]},${pieces[1]}`), now)
      : undefined) ?? parseHTTPDate(trimHTTPWhitespace(pieces[0]), now)
  );
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

    // The year is chosen by the moment it would name, then the date held to that year:
    // `29-Feb-00` read as 2100, which has no 29 February, is no date, not 2000's.
    let fullYear = currentYear - (currentYear % 100) + +year + 100;
    while (
      Date.UTC(
        fullYear,
        MONTHS.indexOf(month as (typeof MONTHS)[number]),
        +day,
        +hour,
        +minute,
        +second,
      ) > limit
    ) {
      fullYear -= 100;
    }

    return utcTime(fullYear, month, +day, +hour, +minute, +second);
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
