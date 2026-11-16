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

const MONTH = `(${MONTHS.join('|')})`;
const TIME = '(\\d{2}):(\\d{2}):(\\d{2})';
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

/**
 * `Sun, 06 Nov 1994 08:49:37 GMT` - the preferred form. Like the other two, matched
 * ignoring ASCII case (without the `u` flag, `i` folds no other letter into ASCII), and
 * here with a one-digit day and another zone too, as got, ky and urllib3 read one.
 */
const IMF_FIXDATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\\d{1,2}) ${MONTH} (\\d{4}) ${TIME} ${ZONE}$`,
  'i',
);
/** `Sunday, 06-Nov-94 08:49:37 GMT` - obsolete RFC 850, a two-digit year. */
const RFC850_DATE = new RegExp(
  `^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\\d{1,2})-${MONTH}-(\\d{2}) ${TIME} ${ZONE}$`,
  'i',
);
/** `Sun Nov  6 08:49:37 1994` - obsolete asctime, in GMT though it says no zone. */
const ASCTIME_DATE = new RegExp(
  `^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ${MONTH} ( \\d|\\d{2}) ${TIME} (\\d{4})$`,
  'i',
);

/** The index of a month name matched ignoring case, from 0 for January. */
function monthIndex(name: string): number {
  const lower = asciiLowercase(name);
  return MONTHS.findIndex((month) => asciiLowercase(month) === lower);
}

/**
 * How long a `Retry-After` value asks the client to wait, in milliseconds from `now` (an
 * epoch time), or `undefined` for a value that is neither form RFC 9110 defines: a whole
 * number of seconds (`120`), or an HTTP-date in any of its three forms, which a recipient
 * must accept - read as GMT, its day name not checked against the date, as browsers'
 * and most HTTP libraries' parsers do not check it. The near-misses got, ky and urllib3
 * all read are read too: names in any case, a one-digit day, and a zone other than `GMT`
 * (see {@link ZONE}), so a server that asks for a wait in one is not retried sooner. A
 * date already past asks for no wait (`0`). Trimmed of HTTP whitespace only. Anything
 * else - a fraction, a sign, a zone they do not all read the same way (`CET`, `AST`,
 * `+01`), a date in another format (ISO 8601, which urllib3 does not read) or spaced
 * otherwise - is unreadable, and the retry policy's own delay is used.
 *
 * Only the first value is read. A header seen twice reaches the client joined
 * (`120, 60`) from `fetch` and XHR, and as its first value from Node, which drops a
 * repeated `Retry-After` - as the client keeps the first of one an adapter hands over as
 * an array (see `normalizeAdapterResponseHeaders`) - so each runtime waits the same: the
 * first value, whether or not the others agree with it. Told apart by the commas between
 * them: an IMF-fixdate or RFC 850 date holds one, after its day name, so it spans the
 * first two comma-separated pieces; a number of seconds or an asctime date the first.
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

  // Rejoined as it was written, so a date spaced otherwise than `Sun, 06 Nov ...` is not
  // made into one that is.
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
  let match = IMF_FIXDATE.exec(text);
  if (match) {
    const [, day, month, year, hour, minute, second, zone] = match;
    return inZone(utcTime(+year, month, +day, +hour, +minute, +second), zone);
  }

  match = RFC850_DATE.exec(text);
  if (match) {
    const [, day, month, year, hour, minute, second, zone] = match;
    // The latest year with those two digits that is not more than 50 years from `now`,
    // as RFC 9110 reads one: one that appears more than 50 years ahead is the most recent
    // past year with those digits.
    const currentYear = new Date(now).getUTCFullYear();
    const fiftyYearsOn = new Date(now);
    fiftyYearsOn.setUTCFullYear(currentYear + 50);
    const limit = fiftyYearsOn.getTime();

    // The year is chosen by the moment it would name, in its zone, then the date held
    // to that year: `29-Feb-00` read as 2100, which has no 29 February, is no date, not
    // 2000's.
    let fullYear = currentYear - (currentYear % 100) + +year + 100;
    while (
      Date.UTC(fullYear, monthIndex(month), +day, +hour, +minute, +second) -
        zoneOffsetMS(zone) >
      limit
    ) {
      fullYear -= 100;
    }

    return inZone(
      utcTime(fullYear, month, +day, +hour, +minute, +second),
      zone,
    );
  }

  match = ASCTIME_DATE.exec(text);
  if (match) {
    const [, month, day, hour, minute, second, year] = match;
    return utcTime(+year, month, +day, +hour, +minute, +second);
  }

  return undefined;
}

/** `time`, a date and time read as GMT, moved to the moment it names in `zone`. */
function inZone(time: number | undefined, zone: string): number | undefined {
  return time === undefined ? undefined : time - zoneOffsetMS(zone);
}

/**
 * The epoch time of a date and time read as GMT, or `undefined` for one that names no
 * real moment (`31 Feb`, `24:00:00`, `12:00:60`). A leap second, `23:59:60`, is read as
 * the second after it: judged on the time as written, before {@link inZone} moves one in
 * another zone, as urllib3 accepts it in any zone.
 */
function utcTime(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = monthIndex(monthName);

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
