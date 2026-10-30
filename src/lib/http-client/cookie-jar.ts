import {
  assertKnownFields,
  assertOptionsObject,
  fieldNames,
} from '../internal/known-fields';
import { MAX_COOKIE_LIFETIME_SECONDS } from './consts';
import { parse } from 'tldts';
import { toASCII } from 'tr46';
import { checkDNSLength, toAsciiDots } from '../domain-utils/helpers';
import { describeValue } from '../internal/describe-value';
import { PublicSuffixResolver } from './public-suffix';
import type { PublicSuffixOverrides } from './public-suffix';
import { assertHeaderRecord } from './internal/plain-record';
import {
  asciiLowercase,
  hasWhitespaceEdge,
  isBlankText,
  trimSpacesAndTabs,
} from '../internal/ascii-text';
import { isNullish } from '../internal/is-nullish';
import { isHeaderSafeCookieText } from './internal/cookie-text';

// Matches bare hostnames like 'localhost', 'myapp', 'my-app' that tldts
// won't assign a registered domain to but are still valid cookie domains.
// `_` and a hyphen anywhere in a label are allowed as the URL parser allows them, and as
// `normalizeStoredDomain` keeps them: docker-compose service names (`my_service`) and
// hosts like `-edge.example.com` set cookies the jar would otherwise discard.
// One trailing dot is allowed, as `normalizeStoredDomain` keeps it (`localhost.`).
const HOSTNAME_PATTERN = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*\.?$/;

/** {@link MAX_COOKIE_LIFETIME_SECONDS} in milliseconds. */
const MAX_COOKIE_LIFETIME_MS = MAX_COOKIE_LIFETIME_SECONDS * 1000;

/** A cookie's expiry fields as the jar holds it to the lifetime cap. See {@link cookieLifetime}. */
interface CookieLifetime {
  createdAt: number;
  maxAge?: number;
  /** `expires` by its time. */
  expires?: number;
  /** When the cookie expires: `maxAge` first, then `expires`, else never (a session cookie). */
  expiresAt: number;
}

/**
 * A cookie's lifetime as the jar holds it: measured from `createdAt`, with `maxAge` and
 * `expires` held to {@link MAX_COOKIE_LIFETIME_SECONDS} from there. One within the cap,
 * or absent, is left as given.
 *
 * `setCookie` stores these fields and the `expiresAt` the jar judges expiry by, so a
 * cookie is sent exactly while it is not purged. Capped before any sum is taken: a
 * `maxAge` large enough to overflow `createdAt + maxAge * 1000` expires at the cap rather
 * than reading as unreadable. `null` when a field cannot take part - a `createdAt` or
 * `maxAge` that is not a finite number, an `expires` time that is `NaN` - so the jar
 * never holds a cookie whose expiry is `NaN` and therefore never past.
 *
 * The returned `createdAt` is never later than `now`: the cap (and `maxAge`) count from it, so a
 * persisted jar claiming a creation five years on would hold a cookie past the cap.
 */
function cookieLifetime(
  rawCreatedAt: unknown,
  maxAge: unknown,
  expires: number | undefined,
  now: number,
): CookieLifetime | null {
  if (typeof rawCreatedAt !== 'number' || !Number.isFinite(rawCreatedAt)) {
    return null;
  }

  const createdAt = Math.min(rawCreatedAt, now);

  if (
    maxAge !== undefined &&
    (typeof maxAge !== 'number' || !Number.isFinite(maxAge))
  ) {
    return null;
  }

  if (expires !== undefined && Number.isNaN(expires)) {
    return null;
  }

  const latest = createdAt + MAX_COOKIE_LIFETIME_MS;
  const lifetime: CookieLifetime = { createdAt, expiresAt: Infinity };

  if (expires !== undefined) {
    lifetime.expires = Math.min(expires, latest);
    lifetime.expiresAt = lifetime.expires;
  }

  if (maxAge !== undefined) {
    lifetime.maxAge = Math.min(maxAge, MAX_COOKIE_LIFETIME_SECONDS);
    lifetime.expiresAt = createdAt + lifetime.maxAge * 1000;
  }

  return lifetime;
}

/**
 * `cookie`'s expiry fields set to `lifetime`'s: those it carries, each the jar's own
 * value, so a stored cookie reads as the jar judges its expiry.
 */
function applyLifetime(cookie: Cookie, lifetime: CookieLifetime): void {
  cookie.createdAt = lifetime.createdAt;

  if (lifetime.maxAge !== undefined) {
    cookie.maxAge = lifetime.maxAge;
  }

  if (lifetime.expires !== undefined) {
    cookie.expires = new Date(lifetime.expires);
  }
}

/**
 * A request host, or a stored cookie domain, prepared for matching against many of the
 * other: its IP literal read once, and its normalized form once, when first asked for.
 */
interface PreparedHost {
  host: string;
  canonicalIP: string | null;
  normalized?: string;
}

interface ParsedCookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: Date;
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface Cookie {
  name: string;
  value: string;
  domain?: string;
  /**
   * True when the cookie must not match subdomains: a Set-Cookie with no `Domain=`, a last
   * `Domain=` that is empty or `.` (even after a valid one: the last wins, as Chrome and
   * Firefox read it), or a `Domain=` naming a public suffix that is the request host
   * itself (`Domain=localhost` from `http://localhost/`). Also true for a cookie given
   * to `setCookie` or restored by `fromJSON` whose domain is a public suffix under the
   * jar's list, which is stored as that last `Set-Cookie` stores it.
   */
  hostOnly?: boolean;
  path?: string;
  expires?: Date;
  /** Seconds from {@link createdAt}; no synthetic `expires` when only Max-Age was sent (RFC 6265). */
  maxAge?: number;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Epoch ms when the cookie was stored. Used with {@link maxAge} to compute expiry. */
  createdAt: number;
}

/**
 * Input shape for {@link CookieJar.setCookie}. Identical to {@link Cookie} except
 * `createdAt` is optional — the jar injects `Date.now()` when omitted.
 */
export type CookieInput = Omit<Cookie, 'createdAt'> & { createdAt?: number };

export interface CookieJarJSON {
  cookies: Cookie[];
}

/**
 * A cookie as the jar holds it. `cookie` is the jar's own object, as `setCookie` vetted
 * it, and is never handed out: every read returns a copy (see {@link copyCookie}), so
 * nothing a caller does to a returned cookie reaches the jar.
 */
interface StoredCookie {
  cookie: Cookie;
  /** `cookie`'s domain, which every stored cookie has. */
  domain: string;
  /** `domain` prepared for matching, so a send does not read it again per cookie. */
  preparedDomain: PreparedHost;
  /** When the cookie's identity was first stored; orders the `Cookie` header. */
  creationTime: number;
  /** When the cookie expires, from its capped lifetime; `Infinity` for a session cookie. */
  expiresAt: number;
}

/** A copy of a stored cookie, its `expires` a `Date` of its own. */
function copyCookie(cookie: Cookie): Cookie {
  const copy = { ...cookie };

  if (cookie.expires !== undefined) {
    copy.expires = new Date(cookie.expires);
  }

  return copy;
}

/** RFC 6265 §5.2.2 delta-seconds: an optional `-`, then digits only. */
const MAX_AGE_PATTERN = /^-?\d+$/;

/** RFC 6265bis §5.6: a cookie whose name and value together pass this is ignored. */
const MAX_COOKIE_NAME_VALUE_BYTES = 4096;

/**
 * The RFC 6265bis §4.1.3 name prefix `text` starts with, matched ASCII
 * case-insensitively as browsers match it, or `null` for none.
 */
function cookieNamePrefix(text: string): '__host-' | '__secure-' | null {
  const start = asciiLowercase(text.slice(0, '__secure-'.length));

  if (start.startsWith('__host-')) {
    return '__host-';
  }

  return start === '__secure-' ? '__secure-' : null;
}

const COOKIE_DATE_DELIMITER =
  /[\t\u0020-\u002f\u003b-\u0040\u005b-\u0060\u007b-\u007e]+/;
const COOKIE_DATE_TIME = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D.*)?$/;
const COOKIE_DATE_DAY = /^(\d{1,2})(?:\D.*)?$/;
const COOKIE_DATE_YEAR = /^(\d{2,4})(?:\D.*)?$/;
const COOKIE_DATE_MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/**
 * RFC 6265 §5.1.1's cookie-date algorithm: the time, day, month and year taken from the
 * first token of each shape, in UTC whatever zone is written. `new Date()` would read a
 * date with no zone - the asctime form - as local time, and `Expires=0` as the year 2000.
 * `undefined` when the value is not a cookie-date, so the attribute is ignored.
 */
function parseCookieDate(value: string): Date | undefined {
  let time: [number, number, number] | undefined;
  let day: number | undefined;
  let month: number | undefined;
  let year: number | undefined;

  for (const token of value.split(COOKIE_DATE_DELIMITER)) {
    if (token === '') {
      continue;
    }
    const timeMatch = time === undefined ? COOKIE_DATE_TIME.exec(token) : null;
    if (timeMatch) {
      time = [Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3])];
      continue;
    }
    const dayMatch = day === undefined ? COOKIE_DATE_DAY.exec(token) : null;
    if (dayMatch) {
      day = Number(dayMatch[1]);
      continue;
    }
    if (month === undefined) {
      const index = COOKIE_DATE_MONTHS.indexOf(
        asciiLowercase(token.slice(0, 3)),
      );
      if (index !== -1) {
        month = index;
        continue;
      }
    }
    const yearMatch = year === undefined ? COOKIE_DATE_YEAR.exec(token) : null;
    if (yearMatch) {
      year = Number(yearMatch[1]);
    }
  }

  if (
    time === undefined ||
    day === undefined ||
    month === undefined ||
    year === undefined
  ) {
    return undefined;
  }
  if (year >= 70 && year <= 99) {
    year += 1900;
  } else if (year >= 0 && year <= 69) {
    year += 2000;
  }
  const [hours, minutes, seconds] = time;
  if (
    day < 1 ||
    day > 31 ||
    year < 1601 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month, day, hours, minutes, seconds));
  // A day the month does not have (31 February) is not a date.
  return date.getUTCDate() === day ? date : undefined;
}

/** Construction options for {@link CookieJar}. */
export interface CookieJarOptions {
  /**
   * Adjustments to the Public Suffix List this jar scopes cookies with.
   *
   * The bundled list (from `tldts`, including its private section) is used as-is when
   * this is omitted, which is the right answer for public hosts. Supply `add` for
   * internal or multi-tenant domains the public list does not carry, and `remove` to
   * opt a suffix back out. Invalid entries throw from the constructor rather than being
   * ignored - see {@link PublicSuffixOverrides}.
   */
  publicSuffixes?: PublicSuffixOverrides;
}

/**
 * Shareable, standalone cookie jar.
 *
 * Cookies are bucketed by site - the registrable domain under the Public Suffix List
 * (via tldts) and the jar's overrides - for efficient URL lookup: only the buckets of the
 * request host's names are scanned instead of all stored cookies.
 *
 * Validation applied when storing from Set-Cookie headers:
 * - Rejects Domain= values that are recognized public suffixes. Both halves of the
 *   Public Suffix List count: ICANN (co.uk, com) and private (github.io, herokuapp.com,
 *   s3.amazonaws.com). Callers with internal or multi-tenant domains the public list
 *   does not carry can extend or trim the list per jar - see {@link CookieJarOptions}.
 * - Rejects Domain= values that are not a suffix of the request host, or that reach
 *   above the request host's site, as browsers reject them
 * - Strips leading dots from Domain= per RFC 6265
 * - Rejects a `Secure` cookie set by a non-secure request, and a non-`Secure` cookie
 *   set by one that would replace or evict a stored `Secure` cookie
 *   (RFC 6265bis "Leave Secure Cookies Alone")
 * - Enforces the `__Secure-` and `__Host-` name prefixes (RFC 6265bis)
 *
 * IPs are never treated as public suffixes. A bare single-label hostname - `localhost`,
 * `myapp` - is, so a cookie may not span one; per RFC 6265bis §5.5 a `Domain=` naming the
 * request host itself is still accepted, host-only, so a server on `http://localhost/`
 * setting `Domain=localhost` keeps working while `https://evil.localhost/` cannot claim
 * the shared name.
 */
export class CookieJar {
  // Outer key: the site - the registrable domain under the jar's suffix rules (e.g.
  //            'example.co.uk'), or the hostname itself for IPs and bare names like
  //            localhost (see `PublicSuffixResolver.registrableDomainFor`). One bucket
  //            is one site.
  // Inner key: `cookieKey`'s JSON of [name, domain, path, hostOnly], for deduplication.
  private buckets: Map<string, Map<string, StoredCookie>> = new Map();

  /**
   * The list this jar scopes with. Held per-jar rather than reached for as a module
   * singleton so two jars in one process can disagree about a suffix, and so the
   * override lists are validated once at construction instead of on every store.
   */
  private readonly publicSuffixes: PublicSuffixResolver;

  constructor(options?: CookieJarOptions) {
    assertOptionsObject(options, 'CookieJar options', true);
    assertKnownFields(
      options,
      fieldNames<CookieJarOptions>({ publicSuffixes: true }),
      'CookieJar options',
    );
    this.publicSuffixes = new PublicSuffixResolver(options?.publicSuffixes);
  }

  /**
   * Stores or updates a cookie. Returns false if the domain is missing or
   * not a valid hostname/IP (e.g. empty string, spaces, garbage input), or if the
   * cookie's expiry cannot be read: an `expires` that is not a `Date` (`null`
   * included) or is an `Invalid Date`, or a `maxAge` or `createdAt` that is not a
   * finite number. Such a cookie would compare
   * `now` against `NaN` in the expiry check, never be found expired, and be sent for
   * the life of the jar - see {@link fromJSON}.
   *
   * Also returns false for a name or value that cannot be written into a `Cookie`
   * header as one cookie-pair: a name that holds `=`, `;` or a control character other
   * than a tab, or starts or ends with a space or tab (one inside it is kept, as RFC
   * 6265bis keeps it), or a value holding `;` or a control character other than a tab,
   * or a name and value together longer than 4096 characters, the limit a `Set-Cookie`
   * is held to. A name may be
   * empty - a nameless cookie, sent as its value alone - when the value is not empty,
   * holds no `=` and does not start with `__Secure-` / `__Host-`. The header is
   * built as `name=value` pairs joined by `; `, so a value of `x; other=evil` would be
   * sent as two cookies, and a CR LF would be a header injection. The Set-Cookie parser
   * cannot produce these - it splits on `;` first - so this covers the programmatic path
   * and a persisted jar that was edited or tampered with.
   *
   * Valid domains include: hostnames (example.com, localhost, myapp.test),
   * IPv4 (127.0.0.1), and IPv6 ([::1]). One trailing dot is kept as part of the host:
   * `example.com.` is stored, sent and cleared apart from `example.com`, as a request host
   * keeps it (RFC 6265bis §5.1.2). An IPv4 address with one (`127.0.0.1.`) is refused,
   * since the URL parser reads it as the address and no request host is that string.
   *
   * Also returns false for a cookie that is already expired: it is not stored, and the
   * stored cookie of the same name, domain, path and host-only flag is deleted, as an
   * expired `Set-Cookie` deletes it. A domain cookie whose domain is a public suffix
   * under the jar's list is stored host-only, as a `Set-Cookie` naming the suffix from
   * that host itself is, and replaces the cookie such a `Set-Cookie` stored.
   *
   * The jar stores its own copy of the cookie. To change a stored cookie - its value,
   * say - call `setCookie` again with the same name, domain, path and `hostOnly`.
   *
   * For server responses use parseSetCookieHeader — it also enforces PSL
   * validation and domain-suffix checks on top of the syntax check here.
   */
  public setCookie(cookie: CookieInput): boolean {
    // Copied before any field is read, so every check below and the object that is stored
    // see the same values: the argument is the caller's object and may carry accessors.
    let input: CookieInput;

    try {
      input = { ...cookie };
    } catch {
      return false;
    }

    const rawDomain = input.domain ?? '';

    if (typeof rawDomain !== 'string') {
      return false;
    }

    const domain = this.normalizeStoredDomain(rawDomain);

    if (!this.isSyntaxValidDomain(domain)) {
      return false;
    }

    // The jar's own `Date`, read once by its time: the caller's stays theirs, so setting
    // it later cannot move the stored expiry past the lifetime cap, and one made in
    // another realm (a `vm` context, an iframe) is stored as a same-realm one.
    if (input.expires !== undefined) {
      try {
        input.expires = new Date(Date.prototype.getTime.call(input.expires));
      } catch {
        return false;
      }
    }

    // Capped as a `Set-Cookie` is (RFC 6265bis's 400 days), from the cookie's own
    // creation: a cookie restored through `fromJSON` with a 10-year lifetime would
    // otherwise keep it. Only an absent `createdAt` is now; a `null` is refused.
    const now = Date.now();
    const lifetime = cookieLifetime(
      input.createdAt === undefined ? now : input.createdAt,
      input.maxAge,
      input.expires?.getTime(),
      now,
    );

    if (lifetime === null) {
      return false;
    }

    const { createdAt } = lifetime;

    // Booleans or absent: the send path reads `secure` and `hostOnly` as `true` or not,
    // so a `secure: 'yes'` would be reported as set and still be sent over `http:`.
    for (const flag of ['secure', 'hostOnly', 'httpOnly'] as const) {
      const value: unknown = input[flag];
      if (value !== undefined && typeof value !== 'boolean') {
        return false;
      }
    }

    // One of the three a `Set-Cookie` can store, or absent.
    if (
      input.sameSite !== undefined &&
      input.sameSite !== 'Strict' &&
      input.sameSite !== 'Lax' &&
      input.sameSite !== 'None'
    ) {
      return false;
    }

    if (!this.hasWritableNameAndValue(input)) {
      return false;
    }

    // A string or absent: anything else is a corrupt field, refused as a corrupt flag is,
    // rather than read as the widest path.
    if (input.path !== undefined && typeof input.path !== 'string') {
      return false;
    }

    // Match the Set-Cookie path parser: an absent, empty, or non-absolute path uses the
    // default root path. Besides keeping persisted/programmatic cookies canonical, this
    // avoids retaining a path representation the send-side matcher never produces.
    const path =
      typeof input.path === 'string' && input.path.startsWith('/')
        ? input.path
        : '/';

    // The prefix rules need no request URL, so they hold here too: a `__Host-session`
    // with `hostOnly` cleared - a persisted jar tampered with - would otherwise be
    // restored through `fromJSON` and sent to every subdomain, carrying a name that
    // promises a server it was set host-only, over `https:`, at `/`.
    if (
      !this.hasValidNamePrefix({
        name: input.name,
        value: input.value,
        secure: input.secure,
        // `Domain` absent means host-only; on this path that is the `hostOnly` flag.
        domain: input.hostOnly === true ? undefined : domain,
        path,
      })
    ) {
      return false;
    }
    const site = this.siteFor(domain);

    // The cookie's own fields only, so what is stored, listed by `getAllCookies()` and
    // saved by `toJSON()` is a cookie and holds nothing else of the caller's.
    const stored: Cookie = {
      name: input.name,
      value: input.value,
      createdAt,
      domain,
      path,
    };

    for (const field of [
      'hostOnly',
      'expires',
      'maxAge',
      'secure',
      'httpOnly',
      'sameSite',
    ] as const) {
      this.copyIfPresent(input, stored, field);
    }

    // A domain cookie for a public suffix is kept for that host alone, as a `Set-Cookie`
    // naming the suffix from the host itself is (RFC 6265bis §5.5): stored host-only, and
    // so filed under the same key as that `Set-Cookie`'s cookie, which replaces and
    // deletes it. A jar saved under another suffix list can hold one.
    if (stored.hostOnly !== true && this.isPublicSuffix(domain)) {
      stored.hostOnly = true;
    }

    applyLifetime(stored, lifetime);

    const key = this.cookieKey(
      stored.name,
      domain,
      path,
      stored.hostOnly === true,
    );

    // Already expired: not stored, and the stored cookie it names is deleted, as an
    // expired `Set-Cookie` deletes it (RFC 6265 §5.3 step 11). `false`, so `fromJSON`
    // counts it out of what it restored.
    if (now >= lifetime.expiresAt) {
      this.buckets.get(site)?.delete(key);
      this.pruneEmptyBucket(site);
      return false;
    }
    // A replacement keeps the creation time of the cookie it replaces (RFC 6265 §5.3
    // step 11.3), which orders the `Cookie` header; `createdAt` stays the new cookie's
    // own, the base of its `Max-Age`.
    // Not an expired one still waiting to be purged: it was already gone (§5.3 step 11
    // reads the store, from which an expired cookie has been evicted), so the new cookie
    // takes its own place. Judged at `now`, the time the new cookie is stored at.
    const replaced = this.buckets.get(site)?.get(key);
    const creationTime =
      replaced === undefined || this.isExpired(replaced, now)
        ? createdAt
        : replaced.creationTime;

    this.getOrCreateBucket(site).set(key, {
      cookie: stored,
      domain,
      preparedDomain: this.prepareHost(domain),
      creationTime,
      expiresAt: lifetime.expiresAt,
    });

    return true;
  }

  /**
   * Returns copies of all stored cookies (including possibly expired ones — call
   * clearExpiredCookies first if needed). Writing to a returned cookie does not change
   * the jar; use `setCookie` to update one.
   */
  public getAllCookies(): Cookie[] {
    const result: Cookie[] = [];

    for (const bucket of this.buckets.values()) {
      for (const stored of bucket.values()) {
        result.push(copyCookie(stored.cookie));
      }
    }

    return result;
  }

  /**
   * Returns the named cookie applicable for the given URL (domain + path
   * matching, unexpired), or undefined.
   *
   * Applies the same rules as getCookiesFor — domain, path, and expiry are all checked —
   * and returns a copy of the stored cookie for the same reason.
   */
  public getCookieFor(name: string, url: string): Cookie | undefined {
    const [first] = this.collectCookies(url, name);
    return first === undefined ? undefined : copyCookie(first.cookie);
  }

  /**
   * Returns all domains that have cookies stored, with a count per domain.
   * Domains are stored in canonical form (lowercase hostnames; normalized IP literals),
   * a trailing dot kept: `example.com.` is listed apart from `example.com`.
   */
  public getStoredDomains(): Array<{ domain: string; count: number }> {
    const counts = new Map<string, number>();

    for (const bucket of this.buckets.values()) {
      for (const { domain } of bucket.values()) {
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries()).map(([domain, count]) => ({
      domain,
      count,
    }));
  }

  /**
   * Parses a Set-Cookie header string and stores the resulting cookie.
   * The request URL is used to infer and validate the domain (PSL + suffix checks).
   */
  public parseSetCookieHeader(header: string, url: string): void {
    const parsed = this.parseCookieString(header);

    if (!parsed) {
      return;
    }

    this.storeParsed(parsed, url);
  }

  /**
   * Processes all Set-Cookie headers from a response headers object: a plain object of
   * header names to values, its `set-cookie` lines read under any capitalization, in the
   * order they appear (as `HTTPClient` merges them). Only those lines are read; other
   * headers are not this method's to check.
   *
   * @throws {TypeError} When `headers` is not a plain object - a `Headers` or `Map`
   *         keeps its entries where this cannot read them, and every cookie in it would
   *         be silently dropped - or a `set-cookie` line is not a string.
   */
  public processResponseHeaders(
    headers: Record<string, string | string[]>,
    url: string,
  ): void {
    assertHeaderRecord(headers, 'CookieJar processResponseHeaders headers');

    // Every line checked before any is stored, so a refused call leaves the jar as it
    // found it rather than holding the cookies that came before the bad line.
    const lines: string[] = [];
    for (const [name, raw] of Object.entries(headers)) {
      if (asciiLowercase(name) !== 'set-cookie' || isNullish(raw)) {
        continue;
      }

      for (const line of Array.isArray(raw) ? (raw as unknown[]) : [raw]) {
        if (isNullish(line) || line === '') {
          continue;
        }

        if (typeof line !== 'string') {
          throw new TypeError(
            `CookieJar processResponseHeaders set-cookie line is not a string (got ${describeValue(line)})`,
          );
        }

        lines.push(line);
      }
    }

    for (const line of lines) {
      this.parseSetCookieHeader(line, url);
    }
  }

  /**
   * Returns cookies applicable for the given URL (domain + path matching, unexpired).
   * Cookies with the Secure attribute are omitted unless the request is secure - `https:`
   * or `wss:`, or a loopback host over `http:` or `ws:`, as browsers count one (RFC 6265
   * §5.4; see `isSecureRequest`).
   *
   * Scans the URL and ancestor-domain buckets, including parents above nested
   * private suffixes, instead of scanning all cookies.
   *
   * Returns copies, so writing to a returned cookie does not change the jar; use
   * `setCookie` to update a stored cookie.
   */
  public getCookiesFor(url: string): Cookie[] {
    return this.collectCookies(url).map((stored) => copyCookie(stored.cookie));
  }

  /**
   * Returns a `Cookie: name=value; name2=value2` string for the given URL: the cookies
   * `getCookiesFor` returns, in its order, so expired cookies are never included (same
   * as RFC behavior on the wire).
   */
  public getCookieHeaderString(url: string): string {
    // Read from the stored cookies, not copies: only their names and values are used.
    // A nameless cookie goes out as its value alone, as browsers send it.
    return this.collectCookies(url)
      .map(({ cookie }) =>
        cookie.name === '' ? cookie.value : `${cookie.name}=${cookie.value}`,
      )
      .join('; ');
  }

  /**
   * Removes expired cookies. Returns the number of cookies removed.
   */
  public clearExpiredCookies(): number {
    const now = Date.now();
    let count = 0;

    for (const [site, bucket] of this.buckets) {
      for (const [key, stored] of bucket) {
        if (this.isExpired(stored, now)) {
          bucket.delete(key);
          count++;
        }
      }

      this.pruneEmptyBucket(site);
    }

    return count;
  }

  /**
   * Removes cookies from the jar.
   *
   * - `clear()` — removes everything
   * - `clear(host, 'hostname')` — removes cookies stored for exactly that hostname,
   *   leaving other subdomains untouched. e.g. `clear('api.example.com', 'hostname')`
   *   does not touch cookies stored for `example.com`.
   * - `clear(host, 'domain')` — removes all cookies for the entire domain family
   *   (the host's registrable domain + all subdomains). e.g.
   *   `clear('api.example.com', 'domain')` clears every cookie stored for `example.com`
   *   or a host under it, and `clear('github.io', 'domain')` every `*.github.io` site's
   *   cookies. A site behind a nested private suffix is its own domain and is not cleared
   *   with its parent: `clear('amazonaws.com', 'domain')` leaves
   *   `bucket.s3.amazonaws.com`'s cookies. The registrable domain is read under the jar's
   *   `publicSuffixes`, removals included: with `herokuapp.com` removed,
   *   `clear('mine.herokuapp.com', 'domain')` clears every `*.herokuapp.com` cookie, as
   *   `herokuapp.com` is then the site, and with `com` removed,
   *   `clear('x.example.com', 'domain')` clears every `.com` cookie but those stored at
   *   or under a suffix still listed, such as `blogspot.com` and `app.blogspot.com`. With
   *   `uk` removed, `co.uk` is still a suffix, so `clear('x.co.uk', 'domain')` leaves
   *   `y.co.uk`'s cookies and a `Domain=uk` one. A removed suffix named itself is cleared
   *   whole, as a listed one is: `clear('uk', 'domain')` clears every `.uk` cookie, and
   *   `clear('com', 'domain')` with `com` removed every `.com` one, `app.blogspot.com`'s
   *   and `bucket.s3.amazonaws.com`'s included.
   *
   * A `host` that is not a non-empty string, or a `scope` that is not one of the two,
   * throws: only a call with no arguments at all clears everything.
   */
  public clear(): number;
  public clear(host: string, scope: 'hostname' | 'domain'): number;
  public clear(
    ...args: [] | [host: string, scope: 'hostname' | 'domain']
  ): number {
    if (args.length === 0) {
      let count = 0;
      for (const bucket of this.buckets.values()) {
        count += bucket.size;
      }
      this.buckets.clear();
      return count;
    }

    // Both refused rather than read loosely. Read loosely, a `host` that is `undefined` -
    // a config value left unset - would wipe the whole jar whatever scope came with it,
    // and a missing or misspelled `scope` (`'Domain'`) would clear by hostname and
    // quietly leave the domain's other cookies in place.
    const [host, scope] = args as unknown[];
    if (typeof host !== 'string' || isBlankText(host)) {
      const got =
        typeof host !== 'string'
          ? describeValue(host)
          : host === ''
            ? 'an empty string'
            : 'a blank string';
      throw new TypeError(
        `CookieJar.clear() host must be a non-empty string (got ${got})`,
      );
    }

    if (scope !== 'hostname' && scope !== 'domain') {
      throw new TypeError(
        `CookieJar.clear() scope must be 'hostname' or 'domain' (got ${typeof scope === 'string' ? 'an unknown scope' : describeValue(scope)})`,
      );
    }

    const normalizedHost = this.normalizeStoredDomain(host);

    if (!normalizedHost) {
      return 0;
    }

    const site = this.siteFor(normalizedHost);

    if (scope === 'domain') {
      // A removed suffix named itself is cleared as a listed one is, whole: the removal
      // decides which hosts share cookies, not what clearing that name reaches, so
      // `clear('uk', 'domain')` clears every `.uk` cookie with `uk` removed or not, and
      // `clear('com', 'domain')` with `com` removed reaches `app.blogspot.com` too.
      const isRemovedSuffixClear = this.isRemovedSuffix(normalizedHost);

      // Otherwise the host's site, which is the one bucket: with `com` removed,
      // `clear('x.example.com', 'domain')` clears every cookie of the `com` site and
      // leaves `app.blogspot.com`, a site of its own behind `blogspot.com`.
      if (!isRemovedSuffixClear && !this.isPublicSuffix(site)) {
        const count = this.buckets.get(site)?.size ?? 0;
        this.buckets.delete(site);
        return count;
      }

      const domain = isRemovedSuffixClear ? normalizedHost : site;
      let count = 0;

      // A suffix or bare name has no registrable part, so each site under it is a bucket
      // of its own - `clear('github.io', 'domain')` or `clear('localhost', 'domain')`
      // clears them all.
      for (const [key, bucket] of this.buckets) {
        if (key === domain || key.endsWith(`.${domain}`)) {
          count += bucket.size;
          this.buckets.delete(key);
        }
      }

      // A removed suffix whose removal joined it to a site above - `co.uk` with `uk`
      // removed as well, filed in `uk` - shares that bucket with the site's other names,
      // and only the cookies stored at or under it are taken.
      if (site !== domain) {
        count += this.clearStoredWithin(site, domain);
      }

      return count;
    } else {
      const bucket = this.buckets.get(site);

      if (!bucket) {
        return 0;
      }

      let count = 0;

      for (const [key, stored] of bucket) {
        if (stored.domain === normalizedHost) {
          bucket.delete(key);
          count++;
        }
      }

      this.pruneEmptyBucket(site);
      return count;
    }
  }

  /**
   * Serializes copies of the stored cookies.
   *
   * A replaced cookie's place in the `Cookie` header - its first creation time - is not
   * saved: after a restore, cookies of equal path length are ordered by `createdAt`.
   */
  public toJSON(): CookieJarJSON {
    return { cookies: this.getAllCookies() };
  }

  /**
   * Restores a jar from serialized JSON.
   *
   * `setCookie` refuses a cookie with a missing or invalid domain and says so by returning
   * `false`. A restore reports those refusals through its count, as every other mutator on
   * this class (`clear`, `clearExpiredCookies`, `setCookie`) reports what it did, so a
   * persisted jar that comes back short says so.
   *
   * The payload is read in full before the jar is touched, and each cookie is copied
   * rather than taken. A payload with no `cookies` or a `null` entry therefore throws
   * while the jar still holds what it had, rather than after emptying it. Frozen entries
   * are accepted because each entry is copied before modification, and a caller's own
   * array of cookies never has `Date` objects written into it.
   *
   * A restore *replaces*: once the payload has been read, the jar is emptied and refilled
   * with whatever `setCookie` accepts. A well-formed payload whose cookies are all refused
   * - every domain missing, say - therefore returns `0` and leaves an empty jar, not the
   * cookies that were there before. Only a payload that cannot be read at all leaves the
   * jar untouched. Snapshot with `toJSON()` first if a short restore should be rolled back.
   *
   * A cookie whose `expires` cannot be read as a date is refused the same way a cookie
   * with a bad domain is: left out of the jar and out of the count. Restored as
   * `new Date('garbage')` it would be an `Invalid Date`, which is truthy, so `isExpired`
   * would compare `now` against `NaN`, never find it greater, and send the cookie for the
   * life of the jar without ever purging it - one corrupt date in a persisted jar would
   * make an immortal cookie. Refused rather than restored as a session cookie,
   * because a cookie that was persisted with an expiry was not a session cookie, and
   * the header parser drops an unreadable `Expires` attribute for the same reason.
   * Here `null` - what `JSON.stringify` writes for an `Invalid Date` - and `undefined`
   * mean no expiry: `fromJSON` restores a `null` as absent. That is this method's own
   * reading of persisted data; `setCookie` refuses a `null` expiry field.
   *
   * The same refusal covers the other half of the expiry model: a `maxAge` or a
   * `createdAt` that is not a finite number - a string, `NaN`, an object - would make
   * `createdAt + maxAge * 1000` come out `NaN` and the cookie just as immortal, and
   * `maxAge` wins over `expires`, so a sound `expires` beside a corrupt `maxAge` would
   * not save it. `setCookie` refuses those the way it refuses a bad domain.
   * A `null` `maxAge` or `createdAt` reads as absent, as a `null` `expires` does.
   *
   * An entry with a field that cannot be read at all - a getter that throws - is refused
   * the same way. A `Date` is read by its time, whatever `getTime` it carries.
   *
   * A `domain` with a trailing dot is restored as written, as `setCookie` stores it: a
   * persisted `example.com.` cookie goes only to `example.com.` and hosts under it, not
   * to `example.com`. Folding it would send a cookie to a host that never set it.
   *
   * A cookie that has expired by the time it is restored is left out of the jar and out
   * of the count, as `setCookie` leaves it out.
   *
   * @returns How many cookies the jar holds once restored. Compare against
   *          `data.cookies.length` to learn whether any were refused; entries of the same
   *          name, domain, path and host-only flag are one cookie, the last one stored.
   * @throws {TypeError} When `data.cookies` is not an array, its length cannot be read, or
   *         it holds a non-object or an element that cannot be read. The jar is left as
   *         it was.
   */
  public fromJSON(data: CookieJarJSON): number {
    const cookies: unknown = data?.cookies;

    if (!Array.isArray(cookies)) {
      throw new TypeError('CookieJar.fromJSON: data.cookies must be an array');
    }

    // Read once, in a `try`: a `Proxy` over an array passes `Array.isArray`, and its
    // `length` getter can throw.
    let length: number;

    try {
      length = cookies.length;
    } catch {
      throw new TypeError('CookieJar.fromJSON: data.cookies cannot be read');
    }

    const prepared: Cookie[] = [];

    // By index, each element read in a `try`: the array is the caller's, and an element
    // getter that throws is an unreadable payload, refused as one. Not the array's own
    // `entries`, which the caller's array may replace.
    for (let index = 0; index < length; index++) {
      let entry: unknown;

      try {
        entry = cookies[index];
      } catch {
        entry = undefined;
      }

      if (entry === null || typeof entry !== 'object') {
        throw new TypeError(
          `CookieJar.fromJSON: data.cookies[${String(index)}] is not a cookie`,
        );
      }

      // Each field read once, into a copy: an entry whose fields cannot be read - a getter
      // that throws - is refused as `setCookie` refuses one, and counted out of the total.
      let cookie: Cookie;

      try {
        cookie = { ...(entry as Cookie) };
      } catch {
        continue;
      }

      const rawExpires: unknown = cookie.expires;

      // Absent, so `setCookie` injects `Date.now()`; a tampered value is refused there.
      if ((cookie.createdAt as unknown) === null) {
        delete (cookie as Partial<Cookie>).createdAt;
      }

      if ((cookie.maxAge as unknown) === null) {
        delete cookie.maxAge;
      }

      // A `null` `path`, flag or `sameSite` reads as absent, as a `null` expiry does; any
      // other value `setCookie` cannot store is refused there, and counted out of the total.
      for (const field of [
        'path',
        'secure',
        'hostOnly',
        'httpOnly',
        'sameSite',
      ] as const) {
        if ((cookie[field] as unknown) === null) {
          delete cookie[field];
        }
      }

      if (rawExpires === undefined || rawExpires === null) {
        delete cookie.expires;
      } else {
        // A `Date` is read by its time, not a `getTime` it carries itself, and from any
        // realm; anything else is parsed. One that cannot be read is refused: see above.
        let expires: Date;

        try {
          expires = new Date(rawExpires as string | number | Date);
        } catch {
          continue;
        }

        if (Number.isNaN(expires.getTime())) {
          continue;
        }

        cookie.expires = expires;
      }

      prepared.push(cookie);
    }

    this.buckets.clear();

    for (const cookie of prepared) {
      this.setCookie(cookie);
    }

    // What the jar holds once every entry is stored, not each entry `setCookie` took: a
    // later entry of the same identity replaces an earlier one, or deletes it when it has
    // expired, and neither leaves two cookies behind.
    let restored = 0;

    for (const bucket of this.buckets.values()) {
      restored += bucket.size;
    }

    return restored;
  }

  // --- Private helpers ---

  /**
   * The stored cookies {@link getCookiesFor} returns copies of, in header order, or only
   * those named `name`: the others are passed over before they are matched.
   */
  private collectCookies(url: string, name?: string): StoredCookie[] {
    let hostname: string;
    let pathname: string;

    let requestScheme: string;

    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      pathname = parsed.pathname;
      // RFC 6265 §5.4 — Secure cookies must not be sent on non-secure requests.
      requestScheme = parsed.protocol;
    } catch {
      return [];
    }

    const now = Date.now();
    const result: StoredCookie[] = [];
    // The request host read once, not once per cookie: normalizing it runs IDNA and a URL
    // parse.
    const requestHost = this.prepareHost(hostname);
    // The host's own site, and the site of each name above it: a parent domain can live
    // above a nested private suffix, in a site of its own. Every name between the host
    // and its site has that same site, so only the names above it are resolved. An IP
    // literal has no parent names. The ordinary domain/host-only checks below still apply.
    const site = this.siteFor(hostname);
    const candidateBuckets = new Set<string>([site]);

    if (requestHost.canonicalIP === null) {
      let parent = site;
      let dot = parent.indexOf('.');

      // A trailing dot ends the walk: `com.` has no name above it.
      while (dot !== -1 && dot !== parent.length - 1) {
        parent = parent.slice(dot + 1);
        candidateBuckets.add(this.siteFor(parent));
        dot = parent.indexOf('.');
      }
    }

    for (const candidate of candidateBuckets) {
      const siteBucket = this.buckets.get(candidate);
      if (!siteBucket) {
        continue;
      }
      for (const stored of siteBucket.values()) {
        const { cookie } = stored;

        if (name !== undefined && cookie.name !== name) {
          continue;
        }

        const isDomainMatch = cookie.hostOnly
          ? this.hostOnlyDomainMatches(requestHost, stored.preparedDomain)
          : this.domainMatches(requestHost, stored.preparedDomain);

        if (!isDomainMatch) {
          continue;
        }

        if (!this.pathMatches(pathname, cookie.path ?? '/')) {
          continue;
        }

        if (
          cookie.secure === true &&
          !this.isSecureRequest(requestScheme, hostname)
        ) {
          continue;
        }

        if (this.isExpired(stored, now)) {
          continue;
        }

        result.push(stored);
      }
    }

    result.sort((a, b) => {
      const pathLengthDelta =
        (b.cookie.path ?? '/').length - (a.cookie.path ?? '/').length;

      if (pathLengthDelta !== 0) {
        return pathLengthDelta;
      }

      return a.creationTime - b.creationTime;
    });

    return result;
  }

  /**
   * A cookie's identity (RFC 6265bis: name, domain, host-only flag and path) as one
   * unambiguous key. Encoded as a JSON array rather than joined: a name may contain `@`
   * and `/` and a path `@`, so `a@x.example.com/` with path `/` and `a` on
   * `x.example.com` with path `/@...` must not become the same key, or one site's cookie
   * could replace another's. The host-only flag is part of it, as browsers keep it: a
   * `Domain=example.com` cookie from `evil.example.com` and `example.com`'s own host-only
   * one of the same name are two cookies - one shared, not the other replacing or
   * deleting the parent's session.
   */
  private cookieKey(
    name: string,
    domain: string,
    path: string,
    isHostOnly: boolean,
  ): string {
    return JSON.stringify([name, domain, path, isHostOnly]);
  }

  /**
   * Canonical form for stored cookie domains: no leading dot, ASCII/IDNA DNS names;
   * canonical IP literals. RFC 6265 treats a leading dot as ignored, and persisted jars
   * from browser-oriented implementations commonly retain it.
   *
   * One trailing dot is kept, as the URL parser keeps it in a request host: RFC 6265bis
   * §5.1.2 canonicalizes a host without removing it and §5.1.3 domain-matches strings as
   * they are, so `example.com.` is a different host from `example.com`, as browsers treat
   * it. A second trailing dot names no host and is refused.
   */
  private normalizeStoredDomain(domain: string): string {
    // Only a leading dot actually written is dropped (RFC 6265 ignores it); one that a
    // full stop such as U+3002 maps to is left, so the check below refuses it.
    const raw = toAsciiDots(domain.startsWith('.') ? domain.slice(1) : domain);
    const ip = this.tryCanonicalIPLiteral(raw);

    if (ip !== null) {
      return ip;
    }

    // Keep malformed whitespace and repeated trailing dots invalid rather than
    // letting the general domain helper trim them into a different scope.
    if (hasWhitespaceEdge(raw) || raw.endsWith('..')) {
      return '';
    }

    // URL hosts allow underscores and hyphens that strict DNS validation rejects.
    // Keep IDNA safety checks and length limits without silently discarding their cookies.
    try {
      const ascii = toASCII(
        // Neither lowercased nor NFC-normalized first: TR46 maps case and then
        // normalizes, as the URL parser does - `toLowerCase` makes a word-final `Σ` the
        // final sigma `ς`, another domain (see `normalizeHostText` in domain-utils).
        this.unbracketHost(raw),
        {
          useSTD3ASCIIRules: false,
          checkHyphens: false,
          checkBidi: true,
          checkJoiners: true,
          transitionalProcessing: false,
          verifyDNSLength: false,
        },
      );

      // A dot mapping exposed at either end: a second trailing one (`example.com.` and a
      // soft hyphen, then `.`) names no host, and a leading one (a soft hyphen, then
      // `.example.com`) is refused on purpose, as domain-utils refuses it: an empty first
      // label is no host, and only a dot actually written is the leading dot RFC 6265
      // ignores. One trailing dot exposed this way is kept, as the URL parser keeps it.
      if (ascii?.startsWith('.') || ascii?.endsWith('..')) {
        return '';
      }

      // IDNA alone permits URL delimiters in non-strict mode. Reject anything
      // that URL parsing would interpret as credentials, a port, a path, or an escape.
      // That parse also refuses an IPv4 address with a trailing dot (`127.0.0.1.`): the
      // URL parser reads it as the address, so no request host is ever that string.
      return ascii &&
        checkDNSLength(ascii) &&
        new URL(`http://${ascii}/`).hostname === ascii
        ? ascii
        : '';
    } catch {
      return '';
    }
  }

  private parseCookieString(header: string): ParsedCookie | null {
    // A control character other than a tab anywhere ignores the whole line (RFC 6265bis).
    // eslint-disable-next-line no-control-regex -- control characters are what is refused
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(header)) {
      return null;
    }

    // Trimmed of spaces and tabs only, as RFC 6265bis trims. `trim()` would also take
    // U+00A0 - the last byte of a UTF-8 `à` or `Р` once Node and Bun read the header as
    // latin1 - and send the value back cut in the middle of a character.
    const parts = header.split(';').map(trimSpacesAndTabs);
    const nameValuePart = parts[0] ?? '';
    const eqIndex = nameValuePart.indexOf('=');

    // No `=` is a nameless cookie, its whole text the value (RFC 6265bis), as browsers
    // store it and send it back as `Cookie: foo`.
    const name =
      eqIndex === -1 ? '' : trimSpacesAndTabs(nameValuePart.slice(0, eqIndex));
    const value = trimSpacesAndTabs(
      eqIndex === -1 ? nameValuePart : nameValuePart.slice(eqIndex + 1),
    );

    if (name === '' && value === '') {
      return null;
    }

    const cookie: ParsedCookie = { name, value };

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const eqIdx = part.indexOf('=');
      // Matched in ASCII case only, as RFC 6265bis compares attribute names.
      const attrName = asciiLowercase(
        trimSpacesAndTabs(eqIdx === -1 ? part : part.slice(0, eqIdx)),
      );

      // Flag attributes are matched by name; RFC 6265bis ignores any value.
      if (attrName === 'secure') {
        cookie.secure = true;
      } else if (attrName === 'httponly') {
        cookie.httpOnly = true;
      } else {
        // A bare attribute (`; Path`) has an empty value, as RFC 6265bis §5.6 reads it -
        // the same as `; Path=`. Skipped, it would leave an earlier `Path=/` in force,
        // which would let `__Host-id=1; Secure; Path=/; Path` past the prefix rule.
        const attrValue =
          eqIdx === -1 ? '' : trimSpacesAndTabs(part.slice(eqIdx + 1));

        // An attribute value over 1024 octets is ignored, as RFC 6265bis ignores it.
        // Counted in characters: the header arrives read as latin1, one character per
        // octet on the wire, and encoding it as UTF-8 would count each byte above 0x7F
        // twice.
        if (attrValue.length > 1024) {
          continue;
        }

        switch (attrName) {
          case 'domain': {
            // The last one wins, an empty one included: `Domain=example.com; Domain=` is
            // host-only, as Chrome and Firefox store it. RFC 6265bis §5.6.3 would ignore
            // the empty one and keep the cookie on every subdomain; the narrower reading
            // is kept on purpose.
            // One leading dot dropped, as RFC 6265 §5.2.3 drops it; a second is kept, so
            // `Domain=..example.com` names no host and its cookie is ignored (see
            // `storeParsed`), as browsers ignore it, rather than becoming `example.com`.
            cookie.domain = attrValue.startsWith('.')
              ? attrValue.slice(1)
              : attrValue;
            break;
          }
          case 'path': {
            // The last Path attribute wins. An invalid value resets any earlier
            // path so resolvedCookiePath applies the request's default (RFC 6265 §5.2.4).
            if (attrValue.startsWith('/')) {
              cookie.path = attrValue;
            } else {
              delete cookie.path;
            }
            break;
          }
          case 'expires': {
            const date = parseCookieDate(attrValue);
            if (date) {
              // Capped where it is stored (see `cookieLifetime`), as every cookie is.
              cookie.expires = date;
            }
            break;
          }
          case 'max-age': {
            // RFC 6265 §5.2.2 — an optional `-` then digits, and nothing else; otherwise
            // the attribute is ignored: `Max-Age=60abc` and `Max-Age=1e9` are ignored, not
            // read by their leading digits. Bounded here only so it is a
            // finite number: a run of digits too long for one reads as `Infinity`, which
            // `setCookie` refuses. The lifetime cap itself is `cookieLifetime`'s.
            if (MAX_AGE_PATTERN.test(attrValue)) {
              cookie.maxAge = Math.min(
                parseInt(attrValue, 10),
                Number.MAX_SAFE_INTEGER,
              );
            }
            break;
          }
          case 'samesite': {
            const lower = asciiLowercase(attrValue);
            if (lower === 'strict') {
              cookie.sameSite = 'Strict';
            } else if (lower === 'lax') {
              cookie.sameSite = 'Lax';
            } else if (lower === 'none') {
              cookie.sameSite = 'None';
            } else {
              // The last `SameSite` wins, an unrecognized one included: it is the
              // default enforcement (RFC 6265bis §5.6.7), not the earlier value.
              delete cookie.sameSite;
            }
            break;
          }
        }
      }
    }

    return cookie;
  }

  /** Removes the cookies in `site`'s bucket stored for `domain` or a host under it. */
  private clearStoredWithin(site: string, domain: string): number {
    const bucket = this.buckets.get(site);

    if (!bucket) {
      return 0;
    }

    let count = 0;

    for (const [key, stored] of bucket) {
      if (stored.domain === domain || stored.domain.endsWith(`.${domain}`)) {
        bucket.delete(key);
        count++;
      }
    }

    this.pruneEmptyBucket(site);
    return count;
  }

  private pruneEmptyBucket(site: string): void {
    if (this.buckets.get(site)?.size === 0) {
      this.buckets.delete(site);
    }
  }

  private deleteCookieByIdentity(
    name: string,
    domain: string,
    path: string,
    isHostOnly: boolean,
  ): void {
    domain = this.normalizeStoredDomain(domain);
    const site = this.siteFor(domain);
    this.buckets
      .get(site)
      ?.delete(this.cookieKey(name, domain, path, isHostOnly));
    this.pruneEmptyBucket(site);
  }

  /**
   * RFC 6265 §5.1.4 — default-path from the path portion of the request-uri.
   * E.g. `/admin/settings` → `/admin`; `/admin` or `/` → `/`.
   */
  private defaultCookiePathFromPathname(pathname: string): string {
    if (pathname === '' || pathname.charCodeAt(0) !== 47 /* / */) {
      return '/';
    }

    let slashCount = 0;

    for (let i = 0; i < pathname.length; i++) {
      if (pathname.charCodeAt(i) === 47) {
        slashCount++;
      }
    }

    if (slashCount <= 1) {
      return '/';
    }

    return pathname.slice(0, pathname.lastIndexOf('/'));
  }

  /** Path from Set-Cookie when present and non-empty; otherwise §5.1.4 default-path. */
  private resolvedCookiePath(
    parsed: ParsedCookie,
    requestPathname: string,
  ): string {
    if (parsed.path !== undefined && parsed.path !== '') {
      return parsed.path;
    }

    return this.defaultCookiePathFromPathname(requestPathname);
  }

  /** The bucket key for `hostname`: its site, the registrable domain under this jar's
   *  suffix rules (see {@link PublicSuffixResolver.registrableDomainFor}).
   *  Falls back to hostname for IPs and local hostnames like localhost.
   *  A trailing dot is kept on the site (`www.example.com.` is under `example.com.`), so
   *  a trailing-dot host's cookies are a domain of their own, as they are on the send
   *  path, and `clear()` by `domain` reaches one form and not the other. */
  private siteFor(hostname: string): string {
    return this.inHostForm(hostname, (host) =>
      this.publicSuffixes.registrableDomainFor(host),
    );
  }

  /** Whether `hostname` is a suffix this jar's `publicSuffixes.remove` opts out (see
   *  {@link PublicSuffixResolver.isRemovedSuffix}). Never an IP literal. */
  private isRemovedSuffix(hostname: string): boolean {
    return (
      this.tryCanonicalIPLiteral(hostname) === null &&
      this.publicSuffixes.isRemovedSuffix(hostname)
    );
  }

  /** `resolve`'s answer for `hostname`, a canonical IP literal standing for itself and a
   *  trailing dot carried over onto the answer. */
  private inHostForm(
    hostname: string,
    resolve: (host: string) => string,
  ): string {
    const ip = this.tryCanonicalIPLiteral(hostname);

    if (ip !== null) {
      return ip;
    }

    const domain = resolve(hostname);

    return hostname.endsWith('.') && domain !== '' && !domain.endsWith('.')
      ? `${domain}.`
      : domain;
  }

  private getOrCreateBucket(site: string): Map<string, StoredCookie> {
    let bucket = this.buckets.get(site);

    if (!bucket) {
      bucket = new Map();
      this.buckets.set(site, bucket);
    }

    return bucket;
  }

  private storeParsed(parsed: ParsedCookie, url: string): void {
    if (
      parsed.name.length + parsed.value.length >
      MAX_COOKIE_NAME_VALUE_BYTES
    ) {
      return;
    }

    let address: URL;

    try {
      address = new URL(url);
    } catch {
      return;
    }

    const requestHostname = address.hostname;

    // A URL with no host (`file:///x`) has no one to set a cookie for.
    if (requestHostname === '') {
      return;
    }

    const isSecureRequest = this.isSecureRequest(
      address.protocol,
      requestHostname,
    );

    // RFC 6265bis §5.7: a Secure cookie is only accepted from a secure request. The send
    // path already withholds Secure cookies from any other, but a cookie *stored* from a
    // plain `http:` response could still replace the `https:` session under the same key -
    // cookie forcing - and the replacement would then go out over `https:` as the
    // real one. Refusing it here keeps a plain-text hop from writing into the secure
    // half of the jar at all.
    if (parsed.secure && !isSecureRequest) {
      return;
    }

    // RFC 6265bis §5.7: `SameSite=None` without `Secure` is ignored, as browsers ignore it.
    if (parsed.sameSite === 'None' && parsed.secure !== true) {
      return;
    }

    let domain: string;

    // Set when `Domain=` names a public suffix that is also the request host. RFC 6265bis
    // §5.5 keeps that cookie but strips its reach: it becomes host-only, as though no
    // `Domain=` had been sent. Tracked separately from `parsed.domain` because the
    // attribute *was* sent - the flag below cannot be derived from its absence.
    let isPublicSuffixHostOnly = false;

    if (parsed.domain) {
      // A dot the parser left: `Domain=..example.com`, which no host domain-matches. And
      // a non-ASCII one, which RFC 6265bis §5.6.3 ignores: header bytes arrive read as
      // latin1, so `Domain=m\xFCnchen.de` reads as `münchen.de` and IDNA would make it
      // the registrable `xn--mnchen-3ya.de`. A server sends the `xn--` form.
      if (
        parsed.domain.startsWith('.') ||
        /[\u0080-\uffff]/.test(parsed.domain)
      ) {
        return;
      }

      // RFC 6265 §5.2.3 / §5.1.3: ignore a leading dot and match domains
      // case-insensitively. URL.host is lowercased but Domain= is not.
      const normalizedDomain = this.normalizeStoredDomain(parsed.domain);

      if (!normalizedDomain) {
        return;
      }

      // A public suffix - `co.uk`, `github.io`, `localhost` - may not be spanned, but
      // naming your own host is not spanning anything. RFC 6265bis §5.5 refuses the
      // attribute only when it differs from the request host, and keeps the cookie
      // host-only when it matches: a server on `http://localhost/` setting a cookie for
      // itself with `Domain=localhost` is ordinary in local development. What is refused
      // is `Domain=localhost` from `https://evil.localhost/`, a *different* host claiming
      // the shared name, exactly as `Domain=github.io` from `evil.github.io` is.
      if (this.isPublicSuffix(normalizedDomain)) {
        if (normalizedDomain !== this.normalizeStoredDomain(requestHostname)) {
          return;
        }

        isPublicSuffixHostOnly = true;
      }

      // Reject cross-domain — server can only set cookies for its own domain
      if (!this.domainMatches(requestHostname, normalizedDomain)) {
        return;
      }

      // Within the request host's own site, as browsers require: a nested private
      // suffix must not grant a tenant scope over its parent, and a suffix still listed
      // beneath a removed one keeps its tenants off the removed name (`Domain=uk` from
      // `x.co.uk`, with `uk` removed and `co.uk` listed).
      if (this.siteFor(requestHostname) !== this.siteFor(normalizedDomain)) {
        return;
      }

      domain = normalizedDomain;
    } else {
      domain = requestHostname;
    }

    const path = this.resolvedCookiePath(parsed, address.pathname);

    // Prefix validation reads the `Path` attribute as sent: `__Host-` needs an explicit
    // `Path=/`, as RFC 6265bis §5.7 and browsers require - an omitted one that would
    // resolve to `/` from a root request does not count.
    if (!this.hasValidNamePrefix(parsed)) {
      return;
    }

    // A nameless cookie posing as a prefixed one - `__Host-x; Max-Age=0` - is ignored
    // whole (RFC 6265bis §5.7), before the deletions below: otherwise it would delete the
    // jar's nameless cookie, which `setCookie` would never let it replace.
    if (parsed.name === '' && cookieNamePrefix(parsed.value) !== null) {
      return;
    }

    // RFC 6265bis §5.7 "Leave Secure Cookies Alone": a non-Secure cookie from a
    // non-secure request cannot replace, shadow or evict a stored Secure cookie of the
    // same name whose scope covers it. Checked before the expiry-driven deletions
    // below on purpose - `Max-Age=0` over `http:` is otherwise a one-line eviction of
    // the `https:` session, and a fresh one planted beside it would then be the only
    // `session` cookie left to send.
    if (
      !isSecureRequest &&
      this.wouldShadowSecureCookie(parsed.name, domain, path)
    ) {
      return;
    }

    // Align with `if (parsed.domain)` above: empty `Domain=` / `Domain=.` parses to
    // `''` and must be host-only like a missing Domain attribute. A `Domain=` naming a
    // public suffix that is the request host is host-only too, per RFC 6265bis §5.5:
    // the cookie is kept, but only for the host that set it.
    const isHostOnly = !parsed.domain || isPublicSuffixHostOnly;

    // Deleted here rather than through `setCookie`: an expired cookie is never stored, so
    // its value need not be one `setCookie` would store - `sid=日本; Max-Age=0` deletes
    // `sid`, as a browser deletes it.
    // Max-Age=0 or negative → delete the cookie
    if (parsed.maxAge !== undefined && parsed.maxAge <= 0) {
      this.deleteCookieByIdentity(parsed.name, domain, path, isHostOnly);
      return;
    }

    // Expires in the past (or now) with no Max-Age: discard / remove — same effect as
    // Max-Age=0 for cookie identity. If Max-Age is present and positive, it overrides
    // Expires per RFC 6265 and the cookie may still be valid.
    if (
      parsed.expires !== undefined &&
      parsed.expires.getTime() <= Date.now() &&
      parsed.maxAge === undefined
    ) {
      this.deleteCookieByIdentity(parsed.name, domain, path, isHostOnly);
      return;
    }

    const cookie: Cookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      hostOnly: isHostOnly,
      path,
      createdAt: Date.now(),
    };

    if (parsed.expires) {
      cookie.expires = parsed.expires;
    }

    if (parsed.maxAge !== undefined) {
      cookie.maxAge = parsed.maxAge;
    }

    if (parsed.secure) {
      cookie.secure = true;
    }

    if (parsed.httpOnly) {
      cookie.httpOnly = true;
    }

    if (parsed.sameSite) {
      cookie.sameSite = parsed.sameSite;
    }

    this.setCookie(cookie);
  }

  /**
   * Whether a request counts as secure for cookie purposes, as browsers count one: over
   * `https:` or `wss:`, or over `http:` or `ws:` to a loopback host - `localhost`, a name
   * under `.localhost`, `127.0.0.0/8` or `[::1]` - which Chrome and Firefox treat as a
   * secure origin, so a local dev server's `Secure` cookie is kept and sent. The same
   * answer on the store and the send path, so the two never disagree about a cookie.
   * `hostname` is a parsed URL's: lowercased, an IPv4 address canonical and an IPv6 one
   * bracketed.
   */
  private isSecureRequest(protocol: string, hostname: string): boolean {
    if (protocol === 'https:' || protocol === 'wss:') {
      return true;
    }

    return (
      (protocol === 'http:' || protocol === 'ws:') && isLoopbackHost(hostname)
    );
  }

  /**
   * RFC 6265bis §4.1.3 cookie name prefixes, matched case-insensitively as browsers do.
   *
   * `__Secure-` requires the `Secure` attribute. `__Host-` requires `Secure`, no
   * non-empty `Domain` attribute (so the cookie is host-only; an empty `Domain=` reads
   * as absent) and `Path=/`. A cookie that claims
   * a prefix without meeting its conditions is refused outright rather than stored with
   * the guarantees the prefix promises to a server reading it back. The secure-scheme
   * half of both prefixes is enforced by the `Secure` check in `storeParsed`; the
   * attribute half is checked on `setCookie` as well, since it needs no URL.
   */
  private hasValidNamePrefix(parsed: ParsedCookie): boolean {
    const prefix = cookieNamePrefix(parsed.name);

    if (prefix === '__host-') {
      return parsed.secure === true && !parsed.domain && parsed.path === '/';
    }

    return prefix === null || parsed.secure === true;
  }

  /**
   * Whether the jar already holds a Secure cookie named `name` whose scope meets a new
   * cookie stored for `domain` / `path` - RFC 6265bis §5.7 step 21: the stored cookie's
   * domain domain-matches the new cookie's domain *or vice versa*, and either path
   * path-matches the other. The RFC asks only that the new path path-match the stored
   * one; the reverse is refused too, on purpose and stricter than browsers: a `/`
   * cookie planted beside a Secure `/admin` one is sent with it, and a server that reads
   * the last of two same-named cookies reads the plant. Both directions, and without
   * regard to `hostOnly`: a
   * host-only Secure cookie on `app.example.com` is shadowed by a `Domain=example.com`
   * cookie planted from `http://example.com`, which the send path would deliver beside
   * it, so the wider plant must be refused as much as the narrower one.
   */
  private wouldShadowSecureCookie(
    name: string,
    domain: string,
    path: string,
  ): boolean {
    const now = Date.now();
    // Read once, not once per stored cookie in each direction: normalizing it runs IDNA
    // and a URL parse.
    const preparedDomain = this.prepareHost(domain);
    const normalizedDomain = this.normalizedPreparedHost(preparedDomain);
    // Matching scopes can cross bucket boundaries at nested public suffixes,
    // in either direction (a wider insecure cookie can shadow a narrow secure one).
    // A bucket's key is a suffix of every domain stored in it, so a stored domain on
    // either side of `domain` sits in a bucket whose key is on one side of it too, and
    // the other buckets hold nothing to check.
    for (const [site, bucket] of this.buckets) {
      if (
        site !== normalizedDomain &&
        !site.endsWith(`.${normalizedDomain}`) &&
        !normalizedDomain.endsWith(`.${site}`)
      ) {
        continue;
      }

      for (const stored of bucket.values()) {
        const { cookie } = stored;

        if (
          cookie.secure !== true ||
          cookie.name !== name ||
          this.isExpired(stored, now)
        ) {
          continue;
        }

        const storedPath = cookie.path ?? '/';
        const isDomainMatch =
          this.domainMatches(preparedDomain, stored.preparedDomain) ||
          this.domainMatches(stored.preparedDomain, preparedDomain);

        if (
          isDomainMatch &&
          (this.pathMatches(path, storedPath) ||
            this.pathMatches(storedPath, path))
        ) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Returns a canonical lowercase IP literal for bucketing and matching, or null if
   * `host` is not syntactically a valid IPv4 or IPv6 host string (bracketed or not).
   *
   * Uses the URL parser for IPv6 literals so validation does not depend on tldts
   * `isIp`, which is unreliable for bracketed IPv6 and false for unbracketed `::1`
   * in some releases (see tldts#2288).
   */
  private tryCanonicalIPLiteral(host: string): string | null {
    if (!host) {
      return null;
    }

    if (host.startsWith('[') && host.endsWith(']')) {
      const inner = host.slice(1, -1);

      if (!inner) {
        return null;
      }

      try {
        return this.unbracketHost(new URL(`http://[${inner}]/`).hostname);
      } catch {
        return null;
      }
    }

    if (host.includes(':')) {
      try {
        return this.unbracketHost(new URL(`http://[${host}]/`).hostname);
      } catch {
        return null;
      }
    }

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      try {
        const { hostname } = new URL(`http://${host}/`);
        if (hostname !== host) {
          return null;
        }
        return host;
      } catch {
        return null;
      }
    }

    return null;
  }

  private unbracketHost(host: string): string {
    if (host.length >= 2 && host[0] === '[' && host[host.length - 1] === ']') {
      return host.slice(1, -1);
    }
    return host;
  }

  /** Validates domain syntax for setCookie. Accepts hostnames (example.com,
   *  localhost, myapp.test), IPv4, and bracketed IPv6 ([::1]). Rejects empty
   *  strings, spaces, and other garbage. Does NOT enforce PSL — use
   *  parseSetCookieHeader for server responses. */
  private isSyntaxValidDomain(domain: string): boolean {
    if (!domain) {
      return false;
    }

    if (this.tryCanonicalIPLiteral(domain) !== null) {
      return true;
    }

    const result = parse(domain);

    if (result.isIp) {
      return true;
    } else if (result.domain !== null) {
      return true;
    } else {
      // Bare hosts and public suffix hosts can both be syntactically valid.
      // Domain scope is enforced separately in storeParsed.
      return HOSTNAME_PATTERN.test(domain);
    }
  }

  /**
   * Returns true if the domain is a recognized public suffix, and so may only be the
   * `Domain=` of a cookie the request host itself sets - `storeParsed` refuses it from any
   * other host and keeps it host-only when it matches, per RFC 6265bis §5.5.
   *
   * Covers both sections of the Public Suffix List: the ICANN one (`com`, `co.uk`) and
   * the private one (`github.io`, `herokuapp.com`, `s3.amazonaws.com`). The private
   * section is the half that stops one tenant of a shared platform from setting a cookie
   * every other tenant on it would send - browsers honour it for exactly that reason.
   * A jar constructed with `publicSuffixes` overrides answers under those.
   *
   * IP literals are never public suffixes - they are compared whole and have no suffix
   * structure. Bare single-label hostnames (`localhost`, `myapp`) are, so a sibling cannot
   * claim the shared name; see {@link PublicSuffixResolver.isPublicSuffix}.
   */
  private isPublicSuffix(domain: string): boolean {
    if (this.tryCanonicalIPLiteral(domain) !== null) {
      return false;
    }

    return this.publicSuffixes.isPublicSuffix(domain);
  }

  /**
   * Whether the cookie's name and value can be written as one `name=value` pair of a
   * `Cookie` header. See {@link setCookie}.
   */
  private hasWritableNameAndValue(cookie: CookieInput): boolean {
    const { name, value } = cookie;

    if (typeof name !== 'string' || typeof value !== 'string') {
      return false;
    }

    // The limit a `Set-Cookie` is held to (see `storeParsed`): past it, every request to
    // the cookie's host would carry a `Cookie` header servers refuse.
    if (name.length + value.length > MAX_COOKIE_NAME_VALUE_BYTES) {
      return false;
    }

    // A name holds no `=` (its own delimiter). It may be empty - a nameless
    // cookie, sent as its value alone (RFC 6265bis) - when the value is not: and then the
    // value holds no `=`, or it would be read back as a name, and does not pose as a
    // `__Secure-` / `__Host-` cookie, which RFC 6265bis refuses.
    if (name === '') {
      return (
        value !== '' &&
        !value.includes('=') &&
        cookieNamePrefix(value) === null &&
        isHeaderSafeCookieText(value, '')
      );
    }

    // Spaces and tabs inside a name are kept, as RFC 6265bis keeps them (browsers keep a
    // space; Chrome refuses a tab, Firefox keeps it); at its edges they would be trimmed
    // off the name a server reads back.
    return (
      isHeaderSafeCookieText(name, '=') &&
      trimSpacesAndTabs(name) === name &&
      isHeaderSafeCookieText(value, '')
    );
  }

  /** Copies `key` from `from` to `to` only when it is present. */
  private copyIfPresent<K extends keyof Cookie>(
    from: Partial<Pick<Cookie, K>>,
    to: Partial<Pick<Cookie, K>>,
    key: K,
  ): void {
    const value = from[key];

    if (value !== undefined) {
      to[key] = value;
    }
  }

  private isExpired(stored: StoredCookie, now: number): boolean {
    return now >= stored.expiresAt;
  }

  /**
   * A host to match many cookie domains against, its IP literal and normalized form read
   * once (the normalized form only when first asked for).
   */
  private prepareHost(host: string): PreparedHost {
    return { host, canonicalIP: this.tryCanonicalIPLiteral(host) };
  }

  private normalizedPreparedHost(prepared: PreparedHost): string {
    prepared.normalized ??= this.normalizeStoredDomain(prepared.host);
    return prepared.normalized;
  }

  private domainMatches(
    requestHostInput: string | PreparedHost,
    cookieDomainInput: string | PreparedHost,
  ): boolean {
    const cookieDomain =
      typeof cookieDomainInput === 'string'
        ? this.prepareHost(cookieDomainInput)
        : cookieDomainInput;

    // An empty domain names no host, so it matches none.
    if (!cookieDomain.host) {
      return false;
    }

    const requestHost =
      typeof requestHostInput === 'string'
        ? this.prepareHost(requestHostInput)
        : requestHostInput;
    const canonicalRequestHost = requestHost.canonicalIP;
    const canonicalCookieDomain = cookieDomain.canonicalIP;

    if (canonicalRequestHost !== null && canonicalCookieDomain !== null) {
      return canonicalRequestHost === canonicalCookieDomain;
    }

    // DNS suffix rules apply only when neither side is an IP. In particular,
    // `evil.10.0.0.5` must not match a cookie domain of `10.0.0.5`.
    if (canonicalRequestHost !== null || canonicalCookieDomain !== null) {
      return false;
    }

    const req = this.normalizedPreparedHost(requestHost);
    const cook = this.normalizedPreparedHost(cookieDomain);

    if (req === cook) {
      return true;
    }

    // Subdomain suffix rules apply to DNS names only, not IP literals.
    if (req.includes(':') || cook.includes(':')) {
      return false;
    }

    return req.endsWith('.' + cook);
  }

  private hostOnlyDomainMatches(
    requestHost: PreparedHost,
    cookieDomain: PreparedHost,
  ): boolean {
    const canonicalRequestHost = requestHost.canonicalIP;
    const canonicalCookieDomain = cookieDomain.canonicalIP;

    if (canonicalRequestHost !== null && canonicalCookieDomain !== null) {
      return canonicalRequestHost === canonicalCookieDomain;
    }

    return (
      this.normalizedPreparedHost(requestHost) ===
      this.normalizedPreparedHost(cookieDomain)
    );
  }

  /**
   * RFC 6265 §5.1.4 — request-path path-matches cookie-path when:
   * (1) identical, (2) cookie-path is a prefix and ends with `/`, or
   * (3) cookie-path is a prefix and the next request-path character is `/`.
   *
   * A single `startsWith(cookiePath + '/')` only covers (1)+(3) and breaks (2):
   * e.g. cookie `/api/` must match `/api/users` without requiring `/api//`.
   */
  private pathMatches(requestPath: string, cookiePath: string): boolean {
    if (cookiePath === '/') {
      return true;
    } else if (requestPath === cookiePath) {
      return true;
    } else if (!requestPath.startsWith(cookiePath)) {
      return false;
    } else if (cookiePath.endsWith('/')) {
      return true;
    } else {
      return (
        requestPath.length > cookiePath.length &&
        requestPath.charAt(cookiePath.length) === '/'
      );
    }
  }
}

/** Whether a parsed URL's `hostname` names this machine: see `CookieJar.isSecureRequest`. */
function isLoopbackHost(hostname: string): boolean {
  const name = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

  return (
    name === 'localhost' ||
    name.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}
