/**
 * `Retry-After` as the client reads it before a retry (RFC 9110 section 10.2.3).
 */

import { asciiLowercase, trimHTTPWhitespace } from '../../internal/ascii-text';

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

const LONG_MONTHS = [
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

/** A month name, short or long: `Nov` or `November`. */
const MONTH = `(${[...LONG_MONTHS, ...MONTHS].join('|')})`;
/**
 * `GMT`, or another zone as a non-conforming server writes one: a name RFC 822 defines
 * (`UT`, `Z`, the US zones), `UTC`, or a `+hhmm` / `-hhmm` offset - the zones
 * `Date.parse` on Bun and Node, which got and ky read the header with, and urllib3 all
 * read.
 */
const ZONE = '(GMT|UTC|UT|Z|[ECMP][SD]T|[+-]\\d{4})';

/** Each RFC 822 US zone's offset from GMT, in hours. */
const US_ZONE_OFFSETS: Readonly<Record<string, number>> = {
  est: -5,
  edt: -4,
  cst: -6,
  cdt: -5,
  mst: -7,
  mdt: -6,
  pst: -8,
  pdt: -7,
};

/** How far `zone`, as {@link ZONE} matched it, is ahead of GMT, in milliseconds. */
function zoneOffsetMS(zone: string): number {
  if (zone[0] === '+' || zone[0] === '-') {
    const sign = zone[0] === '-' ? -1 : 1;
    // Read as `Date.parse` and urllib3 read one: `+0160` is two hours.
    const hours = Number(zone.slice(1, 3));
    const minutes = Number(zone.slice(3, 5));
    return sign * (hours * 60 + minutes) * 60_000;
  }

  return (US_ZONE_OFFSETS[asciiLowercase(zone)] ?? 0) * 3_600_000;
}

const SHORT_DAYS = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun';

/**
 * A day name and what follows it: a long one with its comma, a short one with its comma
 * or a space, as urllib3 reads one - it takes a first word without a comma as the date
 * only when it is a short day name.
 */
const DAY_NAME =
  '(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),[ \\t]*|' +
  `(?:${SHORT_DAYS})(?:,[ \\t]*|[ \\t]+))`;

/** Spaces and tabs, the whitespace RFC 5322 folds a date with. */
const WS = '[ \\t]+';

/**
 * `Sun, 06 Nov 1994 08:49:37 GMT`, the preferred form, RFC 850's (`Sunday, 06-Nov-94`),
 * and the near-misses got, ky and urllib3 all read the same way: no day name, a short
 * one without its comma, runs of whitespace, a one-digit day or hour, a long month name,
 * a two-digit year, no seconds, another zone (see {@link ZONE}), and RFC 850's long day
 * name and dashes in either layout. Matched ignoring ASCII case (without the `u` flag,
 * `i` folds no other letter into ASCII). urllib3 reads no space before the comma, and no
 * mix of a space and a dash around the month, so neither is read here.
 *
 * A two-digit year is read by RFC 9110's 50-year rule in either layout, as an HTTP-date
 * requires, where `Date.parse` and urllib3 each read a fixed century: they differ only
 * for a year more than about 40 years from now (`70` is 2070, which they read as 1970).
 */
const DATE_TIME = new RegExp(
  `^${DAY_NAME}?` +
    `(\\d{1,2})(?:${WS}${MONTH}${WS}|-${MONTH}-)(\\d{4}|\\d{2})` +
    `${WS}(\\d{1,2}):(\\d{2})(?::(\\d{2}))?${WS}${ZONE}$`,
  'i',
);
/** `Sun Nov  6 08:49:37 1994` - obsolete asctime, in GMT though it says no zone. */
const ASCTIME_DATE = new RegExp(
  `^(?:${SHORT_DAYS}) ${MONTH} ( \\d|\\d{2}) ` +
    '(\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$',
  'i',
);

/** The index of a month name {@link MONTH} matched, from 0 for January. */
function monthIndex(name: string): number {
  const short = asciiLowercase(name).slice(0, 3);
  return MONTHS.findIndex((month) => asciiLowercase(month) === short);
}

/**
 * How long a `Retry-After` value asks the client to wait, in milliseconds from `now` (an
 * epoch time), or `undefined` for a value that is neither form RFC 9110 defines: a whole
 * number of seconds (`120`), or an HTTP-date in any of its three forms, which a recipient
 * must accept - read as GMT, its day name not checked against the date, as browsers'
 * and most HTTP libraries' parsers do not check it. The near-misses got, ky and urllib3
 * all read the same way are read too (see {@link DATE_TIME}), so a server that asks for
 * a wait in one is not retried sooner. A date already past asks for no wait (`0`).
 * Trimmed of HTTP whitespace only. Anything else - a fraction, a sign, a zone they do
 * not all read the same way (`CET`, `AST`, `+01`) or none, a day name that is no day's,
 * a date that does not exist, a space before the comma, a space on one side of the month
 * and a dash on the other, a date in another format (ISO 8601, which urllib3 does not
 * read) - is unreadable, and the retry policy's own delay is used.
 *
 * Only the first value is read. A header seen twice reaches the client joined
 * (`120, 60`) from `fetch` and XHR, and as its first value from Node, which drops a
 * repeated `Retry-After` - as the client keeps the first of one an adapter hands over as
 * an array (see `normalizeAdapterResponseHeaders`) - so each runtime waits the same: the
 * first value, whether or not the others agree with it. Told apart by the commas between
 * them: a date with a comma after its day name spans the first two comma-separated
 * pieces; a number of seconds, a date without one or an asctime date the first.
 *
 * An HTTP-date is measured from `now`, the client's clock, as got, ky and Python's urllib3
 * measure it - not from the response's `Date`, so a client clock behind or ahead of the
 * server's lengthens or shortens the wait by the difference.
 */
export function parseRetryAfterMS(
  value: string | undefined,
  now: number,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const pieces = value.split(',');
  const first = trimHTTPWhitespace(pieces[0]);

  if (/^\d+$/.test(first)) {
    return Number(first) * 1000;
  }

  // Rejoined as it was written, so the date read is the text the server sent.
  const at =
    (pieces.length > 1
      ? parseHTTPDate(trimHTTPWhitespace(`${pieces[0]},${pieces[1]}`), now)
      : undefined) ?? parseHTTPDate(first, now);
  if (at === undefined) {
    return undefined;
  }

  return Math.max(0, at - now);
}

/** The epoch time an HTTP-date names, or `undefined` when `text` is not one. */
function parseHTTPDate(text: string, now: number): number | undefined {
  let match = DATE_TIME.exec(text);
  if (match) {
    const [, day, spacedMonth, dashedMonth, year, hour, minute, second, zone] =
      match;
    const month = monthIndex(spacedMonth ?? dashedMonth);
    const offsetMS = zoneOffsetMS(zone);
    const fullYear =
      year.length === 2
        ? centuryOf(
            +year,
            now,
            (candidate) =>
              Date.UTC(candidate, month, +day, +hour, +minute, +(second ?? 0)) -
              offsetMS,
          )
        : +year;
    const time = utcTime(fullYear, month, +day, +hour, +minute, +(second ?? 0));
    return time === undefined ? undefined : time - offsetMS;
  }

  match = ASCTIME_DATE.exec(text);
  if (match) {
    const [, month, day, hour, minute, second, year] = match;
    return utcTime(+year, monthIndex(month), +day, +hour, +minute, +second);
  }

  return undefined;
}

/**
 * The year a two-digit `year` names, as RFC 9110 reads one: the latest with those digits
 * whose moment, by `momentIn`, is not more than 50 years from `now`, so one that appears
 * more than 50 years ahead is the most recent past year with those digits. The year is
 * chosen by the moment, in its zone, and the date then held to it: `29-Feb-00` read as
 * 2100, which has no 29 February, is no date, not 2000's.
 */
function centuryOf(
  year: number,
  now: number,
  momentIn: (fullYear: number) => number,
): number {
  const currentYear = new Date(now).getUTCFullYear();
  const fiftyYearsOn = new Date(now);
  fiftyYearsOn.setUTCFullYear(currentYear + 50);
  const limit = fiftyYearsOn.getTime();

  let fullYear = currentYear - (currentYear % 100) + year + 100;
  while (momentIn(fullYear) > limit) {
    fullYear -= 100;
  }

  return fullYear;
}

/**
 * The epoch time of a date and time read as GMT, or `undefined` for one that names no
 * real moment (`31 Feb`, `24:00:00`, `12:00:60`). A leap second, `23:59:60`, is read as
 * the second after it: judged on the time as written, before its zone moves it, as
 * urllib3 accepts it in any zone. `month` is from 0 for January.
 */
function utcTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
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
