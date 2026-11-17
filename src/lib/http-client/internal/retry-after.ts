/**
 * `Retry-After` as the client reads it before a retry (RFC 9110 section 10.2.3).
 */

import { asciiLowercase, trimHTTPWhitespace } from '../../internal/ascii-text';
import {
  LONG_MONTH_NAMES,
  SHORT_MONTH_NAMES,
  monthIndexOf,
  utcMoment,
} from './calendar-date';

/**
 * The retryable statuses whose `Retry-After` the client honors: `429 Too Many Requests`
 * and `503 Service Unavailable`, the two RFC 9110 and RFC 6585 name it for as a wait
 * before trying again. On a redirect it means something else, and no other retryable
 * status is defined to carry it.
 */
export const RETRY_AFTER_STATUS_CODES: ReadonlySet<number> = new Set([
  429, 503,
]);

/**
 * The month names, short or long, as one alternation: the long ones first, so `November`
 * is matched whole rather than as `Nov` and a remainder.
 */
const MONTH_NAMES = [...LONG_MONTH_NAMES, ...SHORT_MONTH_NAMES].join('|');

/** A month name, short or long: `Nov` or `November`. */
const MONTH = `(?<month>${MONTH_NAMES})`;
/**
 * `GMT`, or another zone as a non-conforming server writes one: a name RFC 822 defines
 * (`UT`, `Z`, the US zones), `UTC`, or a `+hhmm` / `-hhmm` offset - the zones
 * `Date.parse` on Bun and Node, which got and ky read the header with, and urllib3 all
 * read.
 */
const ZONE = '(?<zone>GMT|UTC|UT|Z|[ECMP][SD]T|[+-]\\d{4})';

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

const LONG_DAYS = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';

/**
 * A day name and what follows it: a long one with its comma, a short one with its comma
 * or a space, as urllib3 reads one - it takes a first word without a comma as the date
 * only when it is a short day name.
 */
const DAY_NAME = `(?:(?:${LONG_DAYS}),[ \\t]*|(?:${SHORT_DAYS})(?:,[ \\t]*|[ \\t]+))`;

/**
 * A {@link DAY_NAME} with a space after it, as urllib3 needs one before it reads a comma
 * after a day that comes first or after a dashed year: it splits a date at its spaces,
 * and takes the first piece, if it ends in a comma, for the day name.
 */
const SPACED_DAY_NAME = `(?:(?:${LONG_DAYS}),|(?:${SHORT_DAYS}),?)[ \\t]+`;

/** Spaces and tabs, the whitespace RFC 5322 folds a date with. */
const WS = '[ \\t]+';

const DAY = '(?<day>\\d{1,2})';
const YEAR = '(?<year>\\d{4}|\\d{2})';
const TIME = '(?<hour>\\d{1,2}):(?<minute>\\d{2})(?::(?<second>\\d{2}))?';

/** A layout of {@link DATE_LAYOUTS}, and whether it is RFC 850's: day, month and year. */
interface DateLayout {
  readonly pattern: RegExp;
  readonly isRFC850: boolean;
}

/**
 * `layout` after an optional day name, or after a {@link SPACED_DAY_NAME} it needs when
 * `isBehindDayName`.
 */
function dateLayout(
  layout: string,
  { isRFC850 = false, isBehindDayName = false } = {},
): DateLayout {
  const dayName = isBehindDayName ? SPACED_DAY_NAME : `${DAY_NAME}?`;
  // Matched ignoring ASCII case: without the `u` flag, `i` folds no other letter into
  // ASCII.
  return { pattern: new RegExp(`^${dayName}${layout}$`, 'i'), isRFC850 };
}

/**
 * What follows a spaced date: the year and time in either order, and the zone. After a
 * year that follows the time, a comma may be followed by an offset with no space
 * (`08:49:37 2026,+0500`), and by no other zone without one.
 */
const SPACED_RESTS = [
  `${YEAR},?${WS}${TIME}${WS}${ZONE}`,
  `${TIME}${WS}${YEAR}(?:,?${WS}|,(?=[+-]))${ZONE}`,
  `${TIME}${WS}${ZONE}${WS}${YEAR}`,
];

/** What follows a dashed date: the time and zone. */
const DASHED_REST = `${WS}${TIME}${WS}${ZONE}`;

/**
 * `Sun, 06 Nov 1994 08:49:37 GMT`, the preferred form, RFC 850's (`Sunday, 06-Nov-94`),
 * and the near-misses got, ky and urllib3 all read the same way: no day name, a short
 * one without its comma, runs of whitespace, a one-digit day or hour, a long month name,
 * a two-digit year (see {@link momentOf}), no seconds, another zone (see {@link ZONE}),
 * RFC 850's long day name and dashes in either layout, the month before the day
 * (`Nov 06, 1994`, `Nov-06-1994`), a comma after a spaced year, the time before the
 * year, with the zone after the year or before it (`Nov 06 08:49:37 1994 GMT`,
 * `Nov 06 08:49:37 GMT 1994`) or an offset straight after the year's comma
 * (`Nov 06 08:49:37 1994,+0500`), and, behind a {@link SPACED_DAY_NAME}, a comma after a
 * day that comes first or after a dashed year (`Sun, 06, Nov 1994`). urllib3 reads no
 * space before a comma and no mix of a space and a dash around the month, so neither is
 * read here.
 */
const DATE_LAYOUTS: readonly DateLayout[] = [
  ...[`${DAY}${WS}${MONTH}`, `${MONTH}${WS}${DAY},?`].flatMap((date) =>
    SPACED_RESTS.map((rest) => dateLayout(`${date}${WS}${rest}`)),
  ),
  ...SPACED_RESTS.map((rest) =>
    dateLayout(`${DAY},${WS}${MONTH}${WS}${rest}`, { isBehindDayName: true }),
  ),
  dateLayout(`${DAY}-${MONTH}-${YEAR}${DASHED_REST}`, { isRFC850: true }),
  dateLayout(`${DAY}-${MONTH}-${YEAR},${DASHED_REST}`, {
    isRFC850: true,
    isBehindDayName: true,
  }),
  dateLayout(`${MONTH}-${DAY}-${YEAR}${DASHED_REST}`),
  dateLayout(`${MONTH}-${DAY}-${YEAR},${DASHED_REST}`, {
    isBehindDayName: true,
  }),
];

/**
 * The most pieces, split at its commas, a date of {@link DATE_LAYOUTS} spans: one after
 * its day name, one after a day that follows the month, and one after the year.
 */
const MAX_DATE_PIECES = 4;

/** `Sun Nov  6 08:49:37 1994` - obsolete asctime, in GMT though it says no zone. */
const ASCTIME_DATE = new RegExp(
  `^(?:${SHORT_DAYS}) ${MONTH} (?<day> \\d|\\d{2}) ` +
    '(?<hour>\\d{2}):(?<minute>\\d{2}):(?<second>\\d{2}) (?<year>\\d{4})$',
  'i',
);

/**
 * What may follow an asctime date's comma and leave it read as GMT: nothing, or a value of
 * its own - a number of seconds, or a date begun by its day or a whole day or month name
 * (`, Mon, 16 Nov ...` splits there as `Mon`). Anything else may be a zone the date was
 * written in (`, CET`, `, NOVT`, `, GMT+0100 (CET)`), so the date is not read.
 */
const NEXT_VALUE = new RegExp(
  `^[ \\t]*(?:$|\\d|(?:${SHORT_DAYS}|${LONG_DAYS}|${MONTH_NAMES})(?![a-z]))`,
  'i',
);

/** A month name as a whole word and a four-digit year, at the start of a comma piece. */
const MONTH_AND_YEAR = new RegExp(
  `^[ \\t]*(?:${MONTH_NAMES})[ \\t]+\\d{4}(?!\\d)`,
  'i',
);

/**
 * How long a `Retry-After` value asks the client to wait, in milliseconds from `now` (an
 * epoch time), or `undefined` for a value that is neither form RFC 9110 defines: a whole
 * number of seconds (`120`), or an HTTP-date in any of its three forms, which a recipient
 * must accept - read as GMT, its day name not checked against the date, as browsers'
 * and most HTTP libraries' parsers do not check it. The near-misses got, ky and urllib3
 * all read the same way are read too (see {@link DATE_LAYOUTS}), so a server that asks
 * for a wait in one is not retried sooner. A date already past asks for no wait (`0`).
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
 * them: a number of seconds is the first comma-separated piece, and a date the most of
 * the first pieces that read as one, as a date's own commas - after its day name, after
 * a day that follows the month, after the year - split it across up to four.
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
    // A day before a comma, a month and a year (`16, Nov 2026 ...`) is one date, unread,
    // not that many seconds. A second value that is a date of its own begins with its
    // month and day (`120, Nov 15, 2026 ...`), and the seconds are read.
    const isDayOfOneDate =
      first.length <= 2 &&
      Number(first) >= 1 &&
      Number(first) <= 31 &&
      pieces.length > 1 &&
      MONTH_AND_YEAR.test(pieces[1]);
    return isDayOfOneDate ? undefined : Number(first) * 1000;
  }

  // Rejoined as it was written, so the date read is the text the server sent. The most
  // pieces first: an asctime date and a zone after a comma are one date, as got, ky and
  // urllib3 read them.
  for (
    let count = Math.min(pieces.length, MAX_DATE_PIECES);
    count > 0;
    count--
  ) {
    const text = trimHTTPWhitespace(pieces.slice(0, count).join(','));
    const at = parseHTTPDate(text, now);
    if (at === undefined) {
      continue;
    }

    // Anything after an asctime date's comma but nothing or a value of its own may be a
    // zone ZONE does not read (`, CET`, `,EST`), and leaves no date: the asctime alone,
    // read as GMT, would name another moment.
    if (
      count < pieces.length &&
      ASCTIME_DATE.test(text) &&
      !NEXT_VALUE.test(pieces[count])
    ) {
      return undefined;
    }

    return Math.max(0, at - now);
  }

  return undefined;
}

/** The epoch time an HTTP-date names, or `undefined` when `text` is not one. */
function parseHTTPDate(text: string, now: number): number | undefined {
  for (const { pattern, isRFC850 } of DATE_LAYOUTS) {
    const groups = pattern.exec(text)?.groups;
    if (groups) {
      return momentOf(groups, isRFC850, now);
    }
  }

  const groups = ASCTIME_DATE.exec(text)?.groups;
  if (groups) {
    const { year, month, day, hour, minute, second } = groups;
    return utcTime(+year, monthIndexOf(month), +day, +hour, +minute, +second);
  }

  return undefined;
}

/**
 * The epoch time a match of {@link DATE_LAYOUTS} names, or `undefined` for one that names
 * no real moment. A two-digit year is read by RFC 9110's 50-year rule in RFC 850's
 * layout, as an HTTP-date requires, and by RFC 5322's in any other - `00` to `49` are
 * 20xx, `50` to `99` 19xx - as `Date.parse` reads one, on Bun and Node alike. The readers
 * read a fixed century in RFC 850's layout too: `Date.parse` by RFC 5322's rule, urllib3
 * `00` to `68` as 20xx, in any layout. So from 2026, `Date.parse` reads `50` to `76`
 * there as 19xx where the 50-year rule reads 20xx, and urllib3 reads `50` to `68` as 20xx
 * where RFC 5322's rule reads 19xx. A four-digit year is read as written, as RFC 9110's
 * `4DIGIT` reads it - `0026` is the year 26 - where both readers read one below 100 by
 * their two-digit rule.
 */
function momentOf(
  groups: Readonly<Record<string, string | undefined>>,
  isRFC850: boolean,
  now: number,
): number | undefined {
  const month = monthIndexOf(groups.month as string);
  const offsetMS = zoneOffsetMS(groups.zone as string);
  const day = Number(groups.day);
  const hour = Number(groups.hour);
  const minute = Number(groups.minute);
  const second = Number(groups.second ?? 0);
  const digits = groups.year as string;

  let year = Number(digits);
  if (digits.length === 2) {
    year = isRFC850
      ? centuryOf(
          year,
          now,
          (candidate) =>
            Date.UTC(candidate, month, day, hour, minute, second) - offsetMS,
        )
      : year + (year < 50 ? 2000 : 1900);
  }

  const time = utcTime(year, month, day, hour, minute, second);
  return time === undefined ? undefined : time - offsetMS;
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
 * real moment (see `utcMoment`). A leap second, `23:59:60`, is read as the second after
 * it: judged on the time as written, before its zone moves it, as urllib3 accepts it in
 * any zone. `month` is from 0 for January.
 */
function utcTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  if (hour === 23 && minute === 59 && second === 60) {
    const time = utcMoment(year, month, day, hour, minute, 59);
    return time === undefined ? undefined : time + 1000;
  }

  return utcMoment(year, month, day, hour, minute, second);
}
