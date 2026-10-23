import { MAX_COOKIE_LIFETIME_SECONDS } from './consts';
import { parse } from 'tldts';
import { toASCII } from 'tr46';
import { checkDNSLength, toAsciiDots } from '../domain-utils/helpers';
import { describeValue } from '../internal/describe-value';
import { PublicSuffixResolver } from './public-suffix';
import type { PublicSuffixOverrides } from './public-suffix';
import { assertHeaderRecord } from './internal/plain-record';
import { lowerCaseHeaderName } from './internal/header-utils';
import { isNullish } from '../internal/is-nullish';

// Matches bare hostnames like 'localhost', 'myapp', 'my-app' that tldts
// won't assign a registered domain to but are still valid cookie domains.
// `_` and a hyphen anywhere in a label are allowed as the URL parser allows them, and as
// `normalizeStoredDomain` keeps them: docker-compose service names (`my_service`) and
// hosts like `-edge.example.com` set cookies the jar otherwise discarded.
const HOSTNAME_PATTERN = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

/**
 * `maxAge` and `expires` held to {@link MAX_COOKIE_LIFETIME_SECONDS} from `createdAt`:
 * only the fields over it, so one within it, or absent, is left as given.
 */
function capLifetime(
  cookie: Pick<Cookie, 'maxAge' | 'expires'>,
  createdAt: number,
): Partial<Pick<Cookie, 'maxAge' | 'expires'>> {
  const capped: Partial<Pick<Cookie, 'maxAge' | 'expires'>> = {};

  if (
    typeof cookie.maxAge === 'number' &&
    cookie.maxAge > MAX_COOKIE_LIFETIME_SECONDS
  ) {
    capped.maxAge = MAX_COOKIE_LIFETIME_SECONDS;
  }

  const latest = createdAt + MAX_COOKIE_LIFETIME_SECONDS * 1000;
  if (cookie.expires instanceof Date && cookie.expires.getTime() > latest) {
    capped.expires = new Date(latest);
  }

  return capped;
}

/** A request host prepared for matching against many cookie domains. */
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
   * itself (`Domain=localhost` from `http://localhost/`).
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
 * The scope a cookie was accepted with, kept beside the stored cookie rather than on it.
 *
 * `name`, `domain` and `path` are the components of the key the cookie is filed under,
 * and `hostOnly` / `secure` decide which host and which scheme it may go to. All five are
 * recorded exactly as `setCookie` vetted them so a later write through `getAllCookies()`
 * cannot widen them — see {@link CookieJar.snapshotForSend}. `hostOnly` and `secure` are
 * held as written, absent included, so a cookie handed back reads as it was stored.
 */
interface StoredCookieScope {
  name: string;
  domain: string;
  path: string;
  hostOnly?: boolean;
  secure?: boolean;
}

/**
 * Whether every character of `text` can be written into a `Cookie` header as part of
 * one cookie-pair: no control character other than a tab (a CR LF is a header injection,
 * a DEL is refused by the header parser on the other side; a tab is header-safe, and
 * RFC 6265bis keeps a cookie that carries one), no `;` (the pair delimiter), and none
 * of `extra`.
 *
 * Deliberately looser than RFC 6265's cookie-octet grammar, which also forbids space,
 * comma, double quote and backslash in a value. Servers send all four - a JSON blob, a
 * quoted value, a comma-separated list - and browsers store and return them, so
 * refusing them would drop real cookies from `parseSetCookieHeader`. What is refused
 * here is exactly what would change the *framing* of the header: another pair, or
 * another line.
 */
function isHeaderSafeCookieText(text: string, extra: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);

    // Above U+00FF is refused too: no header can carry it, so a stored cookie holding
    // one failed every request to its host, and took the host's other cookies with it.
    if (
      (code <= 0x1f && code !== 0x09) ||
      code === 0x7f ||
      code > 0xff ||
      char === ';' ||
      extra.includes(char)
    ) {
      return false;
    }
  }

  return true;
}

/** RFC 6265 §5.2.2 delta-seconds: an optional `-`, then digits only. */
const MAX_AGE_PATTERN = /^-?\d+$/;

/** RFC 6265bis §5.6: a cookie whose name and value together pass this is ignored. */
const MAX_COOKIE_NAME_VALUE_BYTES = 4096;

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
 * first token of each shape, in UTC whatever zone is written. `new Date()` read a date
 * with no zone - the asctime form - as local time, and `Expires=0` as the year 2000.
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
      const index = COOKIE_DATE_MONTHS.indexOf(token.slice(0, 3).toLowerCase());
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
 * Cookies are bucketed by apex domain (via tldts Public Suffix List) for efficient
 * URL lookup — only the relevant bucket is scanned instead of all stored cookies.
 *
 * Validation applied when storing from Set-Cookie headers:
 * - Rejects Domain= values that are recognized public suffixes. Both halves of the
 *   Public Suffix List count: ICANN (co.uk, com) and private (github.io, herokuapp.com,
 *   s3.amazonaws.com). Callers with internal or multi-tenant domains the public list
 *   does not carry can extend or trim the list per jar - see {@link CookieJarOptions}.
 * - Rejects Domain= values that are not a suffix of the request host
 * - Strips leading dots from Domain= per RFC 6265
 * - Rejects a `Secure` cookie set over a non-secure scheme, and a non-`Secure` cookie
 *   set over a non-secure scheme that would replace or evict a stored `Secure` cookie
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
  // Outer key: apex domain from the Public Suffix List (e.g. 'example.co.uk'), or the
  //            hostname itself for IPs and bare names like localhost
  // Inner key: composite 'name@domain/path' for deduplication
  private buckets: Map<string, Map<string, Cookie>> = new Map();

  /**
   * The list this jar scopes with. Held per-jar rather than reached for as a module
   * singleton so two jars in one process can disagree about a suffix, and so the
   * override lists are validated once at construction instead of on every store.
   */
  private readonly publicSuffixes: PublicSuffixResolver;

  // The scope each stored cookie was accepted with. Keyed by the stored object and held
  // off it, because the object itself is handed out by `getAllCookies()` and is writable
  // from there; dropped with the cookie when the bucket entry goes.
  private storedScopes: WeakMap<Cookie, StoredCookieScope> = new WeakMap();
  /** When each stored cookie's identity was first stored; orders the `Cookie` header. */
  private creationTimes: WeakMap<Cookie, number> = new WeakMap();

  constructor(options?: CookieJarOptions) {
    this.publicSuffixes = new PublicSuffixResolver(options?.publicSuffixes);
  }

  /**
   * Stores or updates a cookie. Returns false if the domain is missing or
   * not a valid hostname/IP (e.g. empty string, spaces, garbage input), or if the
   * cookie's expiry cannot be read: an `expires` that is an `Invalid Date`, or a
   * `maxAge` or `createdAt` that is not a finite number. Such a cookie would compare
   * `now` against `NaN` in the expiry check, never be found expired, and be sent for
   * the life of the jar - see {@link fromJSON}.
   *
   * Also returns false for a name or value that cannot be written into a `Cookie`
   * header as one cookie-pair (and `getCookiesFor` withholds a stored cookie that no
   * longer passes, so a mutation through `getAllCookies()` cannot reach the header): a name that holds `=`, `;`, whitespace or a
   * control character, or a value holding `;` or a control character other than a tab.
   * A name may be
   * empty - a nameless cookie, sent as its value alone - when the value is not empty,
   * holds no `=` and does not start with `__Secure-` / `__Host-`. The header is
   * built as `name=value` pairs joined by `; `, so a value of `x; other=evil` was sent
   * as two cookies, and a CR LF was a header injection. The Set-Cookie parser cannot
   * produce these - it splits on `;` first - so this closes the programmatic path and
   * a persisted jar that was edited or tampered with.
   *
   * Valid domains include: hostnames (example.com, localhost, myapp.test),
   * IPv4 (127.0.0.1), and IPv6 ([::1]).
   *
   * For server responses use parseSetCookieHeader — it also enforces PSL
   * validation and domain-suffix checks on top of the syntax check here.
   */
  public setCookie(cookie: CookieInput): boolean {
    // Copied before any field is read, so every check below and the object that is stored
    // see the same values. The argument is the caller's object and may carry accessors,
    // and checking one read while storing another is the write-time half of what
    // `snapshotForSend` closes on the way out.
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

    if (!this.hasReadableExpiry(input)) {
      return false;
    }

    // A same-realm copy of a `Date` made in another realm (a `vm` context, an iframe),
    // which `hasReadableExpiry` accepts by its time rather than by `instanceof`.
    if (input.expires !== undefined && !(input.expires instanceof Date)) {
      input.expires = new Date(Date.prototype.getTime.call(input.expires));
    }

    // Booleans or absent: the send path withholds a cookie whose `secure`, `hostOnly` or
    // `httpOnly` is anything else, so storing one reported a cookie that never goes out.
    for (const flag of ['secure', 'hostOnly', 'httpOnly'] as const) {
      const value: unknown = input[flag];
      if (value !== undefined && typeof value !== 'boolean') {
        return false;
      }
    }

    if (!this.hasWritableNameAndValue(input)) {
      return false;
    }

    const normalizedDomain = domain;
    // Match the Set-Cookie path parser: an absent, empty, or non-absolute path uses the
    // default root path. Besides keeping persisted/programmatic cookies canonical, this
    // avoids retaining a path representation the send-side matcher never produces.
    const path =
      typeof input.path === 'string' && input.path.startsWith('/')
        ? input.path
        : '/';

    // The prefix rules need no request URL, so they hold here too: a persisted jar
    // tampered into holding a `__Host-session` with `hostOnly` cleared used to be
    // restored through `fromJSON` and sent to every subdomain, carrying a name that
    // promises a server it was set host-only, over `https:`, at `/`.
    if (
      !this.hasValidNamePrefix({
        name: input.name,
        value: input.value,
        secure: input.secure,
        // `Domain` absent means host-only; on this path that is the `hostOnly` flag.
        domain: input.hostOnly === true ? undefined : normalizedDomain,
        path,
      })
    ) {
      return false;
    }
    // Never in the future: the lifetime cap (and `Max-Age`) count from it, so a persisted
    // jar claiming a creation five years on held a cookie past the cap.
    const now = Date.now();
    const createdAt = Math.min(input.createdAt ?? now, now);
    const bucket = this.getOrCreateBucket(this.apexFor(normalizedDomain));

    const stored: Cookie = {
      ...input,
      createdAt,
      domain: normalizedDomain,
      path,
      // Capped as a `Set-Cookie` is (RFC 6265bis's 400 days), from the cookie's own
      // creation: a jar restored through `fromJSON` from before the cap kept a 10-year
      // lifetime.
      ...capLifetime(input, createdAt),
    };

    const key = this.cookieKey(
      stored.name,
      normalizedDomain,
      path,
      input.hostOnly === true,
    );
    // A replacement keeps the creation time of the cookie it replaces (RFC 6265 §5.3
    // step 11.3), which orders the `Cookie` header; `createdAt` stays the new cookie's
    // own, the base of its `Max-Age`.
    // Not an expired one still waiting to be purged: it was already gone (§5.3 step 11
    // reads the store, from which an expired cookie has been evicted), so the new cookie
    // takes its own place.
    const replaced = bucket.get(key);
    const replacedSnapshot =
      replaced === undefined ? null : this.snapshotForSend(replaced);
    this.creationTimes.set(
      stored,
      replaced === undefined ||
        replacedSnapshot === null ||
        this.isExpired(replacedSnapshot, Date.now())
        ? createdAt
        : (this.creationTimes.get(replaced) ?? replaced.createdAt),
    );
    bucket.set(key, stored);

    const scope: StoredCookieScope = {
      name: stored.name,
      domain: normalizedDomain,
      path,
    };

    this.copyIfPresent(stored, scope, 'hostOnly');
    this.copyIfPresent(stored, scope, 'secure');

    this.storedScopes.set(stored, scope);

    return true;
  }

  /**
   * Returns all stored cookies (including possibly expired ones — call
   * clearExpiredCookies first if needed).
   */
  public getAllCookies(): Cookie[] {
    const result: Cookie[] = [];

    for (const bucket of this.buckets.values()) {
      result.push(...bucket.values());
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
    return this.getCookiesFor(url).find((c) => c.name === name);
  }

  /**
   * Returns all domains that have cookies stored, with a count per domain.
   * Domains are stored in canonical form (lowercase hostnames; normalized IP literals).
   */
  public getStoredDomains(): Array<{ domain: string; count: number }> {
    const counts = new Map<string, number>();

    for (const bucket of this.buckets.values()) {
      for (const cookie of bucket.values()) {
        // The scope the cookie was filed under, not the live object: `getAllCookies()`
        // hands out the stored cookies themselves, and a `domain` written through one
        // must not move the cookie in this listing while the send path, which reads the
        // same stored scope, still sends it where it was filed.
        const domain = this.storedScopes.get(cookie)?.domain ?? '';
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
   *         keeps its entries where this cannot read them, and every cookie in it was
   *         silently dropped - or a `set-cookie` line is not a string.
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
      if (lowerCaseHeaderName(name) !== 'set-cookie' || isNullish(raw)) {
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
   * Cookies with the Secure attribute are omitted unless the URL uses a secure scheme,
   * `https:` or `wss:` (RFC 6265 §5.4).
   *
   * Scans the URL and ancestor-domain buckets, including parents above nested
   * private suffixes, instead of scanning all cookies.
   *
   * Returns *copies*, not the stored objects. A cookie's `name`, `domain`, `path`,
   * `hostOnly` and `secure` come from the scope `setCookie` accepted it with, and every
   * other field is read exactly once; all the checks run against that copy and the header
   * is built from it. So a stored cookie mutated through `getAllCookies()` — a cleared
   * `secure`, a widened `domain` or `path`, a `value` getter that answers differently on
   * the second read — cannot reach the wire with a scope or a framing it was never stored
   * with. A cookie whose fields cannot be read at all (an accessor that throws) is
   * withheld, as one whose expiry cannot be read already is. Writing to a returned cookie
   * therefore does not change the jar; use `setCookie` to update a stored cookie, and
   * `getAllCookies()` to reach the live objects.
   */
  public getCookiesFor(url: string): Cookie[] {
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
    const result: Array<{ cookie: Cookie; creationTime: number }> = [];
    // The request host read once, not once per cookie: normalizing it runs IDNA and a URL
    // parse. Likewise each stored domain's public-suffix answer.
    const requestHost = this.prepareHost(hostname);
    const publicSuffixAnswers = new Map<string, boolean>();
    const isPublicSuffix = (domain: string): boolean => {
      let isSuffix = publicSuffixAnswers.get(domain);
      if (isSuffix === undefined) {
        isSuffix = this.isPublicSuffix(domain);
        publicSuffixAnswers.set(domain, isSuffix);
      }
      return isSuffix;
    };
    // A parent domain can live above a nested private suffix. Include its
    // bucket while retaining the ordinary domain/host-only checks below.
    const candidateBuckets = new Set<string>();
    const labels = hostname.split('.');
    for (let index = 0; index < labels.length; index++) {
      candidateBuckets.add(this.apexFor(labels.slice(index).join('.')));
    }

    for (const apex of candidateBuckets) {
      const apexBucket = this.buckets.get(apex);
      if (!apexBucket) {
        continue;
      }
      for (const stored of apexBucket.values()) {
        // Every check below runs against the snapshot, never the stored object: the
        // fields were read once each, so what is vetted is what goes out. A cookie whose
        // snapshot cannot be trusted is withheld.
        const cookie = this.snapshotForSend(stored);

        if (cookie === null) {
          continue;
        }

        if (this.isExpired(cookie, now)) {
          continue;
        }

        // Persisted cookies can predate the current suffix policy. Never let
        // a domain cookie for a public suffix span its tenants.
        if (
          !cookie.hostOnly &&
          cookie.domain &&
          isPublicSuffix(cookie.domain) &&
          !this.hostOnlyDomainMatches(requestHost, cookie.domain)
        ) {
          continue;
        }

        const isDomainMatch = cookie.hostOnly
          ? this.hostOnlyDomainMatches(requestHost, cookie.domain ?? '')
          : this.domainMatches(requestHost, cookie.domain ?? '');

        if (!isDomainMatch) {
          continue;
        }

        if (!this.pathMatches(pathname, cookie.path ?? '/')) {
          continue;
        }

        if (cookie.secure === true && !this.isSecureScheme(requestScheme)) {
          continue;
        }

        result.push({
          cookie,
          creationTime: this.creationTimes.get(stored) ?? cookie.createdAt,
        });
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

    return result.map((entry) => entry.cookie);
  }

  /**
   * Returns a `Cookie: name=value; name2=value2` string for the given URL.
   * Uses `getCookiesFor`, so expired cookies are never included (same as RFC
   * behavior on the wire), and the pairs are built from the copies it vetted rather than
   * re-read off the stored objects — one pair per cookie, whatever a caller has since
   * written onto them.
   */
  public getCookieHeaderString(url: string): string {
    // A nameless cookie goes out as its value alone, as browsers send it.
    return this.getCookiesFor(url)
      .map((c) => (c.name === '' ? c.value : `${c.name}=${c.value}`))
      .join('; ');
  }

  /**
   * Removes expired cookies, including those with unreadable expiry data.
   * Returns the number of cookies removed.
   */
  public clearExpiredCookies(): number {
    const now = Date.now();
    let count = 0;

    for (const [apex, bucket] of this.buckets.entries()) {
      for (const [key, cookie] of bucket.entries()) {
        if (this.isExpired(cookie, now)) {
          bucket.delete(key);
          count++;

          if (bucket.size === 0) {
            this.buckets.delete(apex);
          }
        }
      }
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
   *   (apex + all subdomains). e.g. `clear('api.example.com', 'domain')` clears
   *   everything in the `example.com` apex bucket, and `clear('github.io', 'domain')`
   *   every `*.github.io` site's cookies. A site behind a nested private suffix is its
   *   own domain and is not cleared with its parent: `clear('amazonaws.com', 'domain')`
   *   leaves `bucket.s3.amazonaws.com`'s cookies.
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
      const count = this.getAllCookies().length;
      this.buckets.clear();
      return count;
    }

    // Both refused rather than read loosely. A `host` that was `undefined` - a config
    // value left unset - wiped the whole jar whatever scope came with it; a missing or
    // misspelled `scope` (`'Domain'`) cleared by hostname and quietly left the domain's
    // other cookies in place.
    const [host, scope] = args as unknown[];
    if (typeof host !== 'string' || host.trim() === '') {
      throw new TypeError(
        `CookieJar.clear() host must be a non-empty string (got ${describeValue(host)})`,
      );
    }

    if (scope !== 'hostname' && scope !== 'domain') {
      throw new TypeError(
        `CookieJar.clear() scope must be 'hostname' or 'domain' (got ${describeValue(scope)})`,
      );
    }

    const normalizedHost = this.normalizeStoredDomain(host);

    if (!normalizedHost) {
      return 0;
    }

    const apex = this.apexFor(normalizedHost);

    if (scope === 'domain') {
      let count = 0;

      // The apex bucket - and, when the host is itself a public suffix or a bare name,
      // every bucket beneath it. Such a name has no registrable part, so each host under
      // it is its own bucket: `clear('github.io', 'domain')` or `clear('localhost',
      // 'domain')` cleared only the suffix's own and left `a.github.io` and
      // `sub.localhost` in place. Only then: under an ordinary domain a bucket beneath
      // the apex is a separate site behind a nested private suffix (`bucket.s3.amazonaws.com`
      // under `amazonaws.com`), not part of the domain being cleared.
      const isSuffixClear = this.isPublicSuffix(apex);
      for (const [key, bucket] of [...this.buckets.entries()]) {
        if (key === apex || (isSuffixClear && key.endsWith(`.${apex}`))) {
          count += bucket.size;
          this.buckets.delete(key);
        }
      }

      return count;
    } else {
      const bucket = this.buckets.get(apex);

      if (!bucket) {
        return 0;
      }

      let count = 0;

      for (const [key, cookie] of bucket.entries()) {
        // Matched on the stored scope, as the send path matches. Comparing the live
        // `domain` let a cookie mutated through `getAllCookies()` dodge the clear while
        // `getCookieHeaderString()` went on sending it from the scope it was filed under.
        if (this.storedScopes.get(cookie)?.domain === normalizedHost) {
          bucket.delete(key);
          count++;
        }
      }

      this.pruneEmptyBucket(apex);
      return count;
    }
  }

  /**
   * Serializes detached cookie snapshots using their stored scope. Caller edits to
   * live cookie objects cannot widen that scope after a save and restore. Cookies
   * whose mutable fields cannot be safely read are omitted, as on the send path.
   *
   * A replaced cookie's place in the `Cookie` header - its first creation time - is not
   * saved: after a restore, cookies of equal path length are ordered by `createdAt`.
   */
  public toJSON(): CookieJarJSON {
    const cookies: Cookie[] = [];

    for (const stored of this.getAllCookies()) {
      const cookie = this.snapshotForSend(stored);

      if (cookie !== null) {
        cookies.push(cookie);
      }
    }

    return { cookies };
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
   * `null` - what `JSON.stringify` writes for an `Invalid Date` - and `undefined` mean
   * no expiry, as they do on a live cookie.
   *
   * The same refusal covers the other half of the expiry model: a `maxAge` or a
   * `createdAt` that is not a finite number - a string, `NaN`, an object - would make
   * `createdAt + maxAge * 1000` come out `NaN` and the cookie just as immortal, and
   * `isExpired` prefers `maxAge` over `expires`, so a sound `expires` beside a corrupt
   * `maxAge` would not save it. `setCookie` refuses those the way it refuses a bad domain.
   * A `null` `maxAge` or `createdAt` reads as absent, as a `null` `expires` does.
   *
   * @returns How many cookies were restored. Compare against `data.cookies.length` to learn
   *          whether any were refused.
   * @throws {TypeError} When `data.cookies` is not an array or holds a non-object. The
   *         jar is left as it was.
   */
  public fromJSON(data: CookieJarJSON): number {
    const cookies: unknown = data?.cookies;

    if (!Array.isArray(cookies)) {
      throw new TypeError('CookieJar.fromJSON: data.cookies must be an array');
    }

    const prepared: Cookie[] = [];

    for (const [index, entry] of (cookies as unknown[]).entries()) {
      if (entry === null || typeof entry !== 'object') {
        throw new TypeError(
          `CookieJar.fromJSON: data.cookies[${String(index)}] is not a cookie`,
        );
      }

      const cookie: Cookie = { ...(entry as Cookie) };
      const rawExpires: unknown = cookie.expires;

      // Absent, so `setCookie` injects `Date.now()`; a tampered value is refused there.
      if ((cookie.createdAt as unknown) === null) {
        delete (cookie as Partial<Cookie>).createdAt;
      }

      if ((cookie.maxAge as unknown) === null) {
        delete cookie.maxAge;
      }

      // A `null` flag reads as absent, as a `null` expiry does; any other non-boolean is
      // refused by `setCookie`, and counted out of the total.
      for (const flag of ['secure', 'hostOnly', 'httpOnly'] as const) {
        if ((cookie[flag] as unknown) === null) {
          delete cookie[flag];
        }
      }

      if (rawExpires === undefined || rawExpires === null) {
        delete cookie.expires;
      } else {
        const expires =
          rawExpires instanceof Date
            ? rawExpires
            : new Date(rawExpires as string | number);

        if (Number.isNaN(expires.getTime())) {
          // Refused: see above.
          continue;
        }

        cookie.expires = expires;
      }

      prepared.push(cookie);
    }

    this.buckets.clear();

    let restored = 0;

    for (const cookie of prepared) {
      if (this.setCookie(cookie)) {
        restored++;
      }
    }

    return restored;
  }

  // --- Private helpers ---

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

  /** Canonical form for stored cookie domains: no leading dot, ASCII/IDNA DNS names;
   *  canonical IP literals. RFC 6265 treats a leading dot as ignored, and persisted jars
   *  from browser-oriented implementations commonly retain it. */
  private normalizeStoredDomain(domain: string): string {
    domain = toAsciiDots(domain);
    const withoutLeadingDot = domain.startsWith('.') ? domain.slice(1) : domain;
    const raw = withoutLeadingDot.endsWith('.')
      ? withoutLeadingDot.slice(0, -1)
      : withoutLeadingDot;
    const ip = this.tryCanonicalIPLiteral(raw);

    if (ip !== null) {
      return ip;
    }

    // Keep malformed whitespace and repeated trailing dots invalid rather than
    // letting the general domain helper trim them into a different scope.
    if (raw.trim() !== raw || raw.endsWith('.')) {
      return '';
    }

    // URL hosts allow underscores and hyphens that strict DNS validation rejects.
    // Keep IDNA safety checks and length limits without silently discarding their cookies.
    try {
      const ascii = toASCII(
        // Neither lowercased nor NFC-normalized first: TR46 maps case and then
        // normalizes, as the URL parser does - `toLowerCase` made a word-final `Σ` the
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
      // A trailing dot mapping exposed (`example.com.` and a soft hyphen): dropped as the
      // one trailing dot if none was written, so the cookie is stored for `example.com`
      // and not beside it under `example.com.`; refused as a second if one was. A leading
      // one exposed the same way (a soft hyphen, then `.example.com`) is refused on
      // purpose, below, as domain-utils refuses it: an empty first label is no host, and
      // only a dot actually written is the leading dot RFC 6265 ignores.
      // Not when mapping exposed a leading dot too: the call below would strip it as a
      // written one.
      if (ascii?.endsWith('.')) {
        return raw === withoutLeadingDot &&
          !ascii.endsWith('..') &&
          !ascii.startsWith('.')
          ? this.normalizeStoredDomain(ascii.slice(0, -1))
          : '';
      }

      // IDNA alone permits URL delimiters in non-strict mode. Reject anything
      // that URL parsing would interpret as credentials, a port, a path, or an escape.
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

    // Trimmed of spaces and tabs only, as RFC 6265bis trims. `trim()` also took U+00A0 -
    // the last byte of a UTF-8 `à` or `Р` once Node and Bun read the header as latin1 -
    // and sent the value back cut in the middle of a character.
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
      const attrName = trimSpacesAndTabs(
        eqIdx === -1 ? part : part.slice(0, eqIdx),
      ).toLowerCase();

      // Flag attributes are matched by name; RFC 6265bis ignores any value.
      if (attrName === 'secure') {
        cookie.secure = true;
      } else if (attrName === 'httponly') {
        cookie.httpOnly = true;
      } else {
        // A bare attribute (`; Path`) has an empty value, as RFC 6265bis §5.6 reads it -
        // the same as `; Path=`. Skipped, it left an earlier `Path=/` in force, which let
        // `__Host-id=1; Secure; Path=/; Path` past the prefix rule.
        const attrValue =
          eqIdx === -1 ? '' : trimSpacesAndTabs(part.slice(eqIdx + 1));

        // An attribute value over 1024 octets is ignored, as RFC 6265bis ignores it.
        // Counted in characters: the header arrives read as latin1, one character per
        // octet on the wire, and encoding it as UTF-8 counted each byte above 0x7F twice.
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
              // Capped as `Max-Age` is, at 400 days from now.
              const latest = Date.now() + MAX_COOKIE_LIFETIME_SECONDS * 1000;
              cookie.expires =
                date.getTime() > latest ? new Date(latest) : date;
            }
            break;
          }
          case 'max-age': {
            // RFC 6265 §5.2.2 — an optional `-` then digits, and nothing else; otherwise
            // the attribute is ignored. `parseInt` read a prefix, so `Max-Age=60abc` was
            // a minute and `Max-Age=1e9` was one second. Capped at RFC 6265bis's 400 days,
            // as browsers cap it.
            if (MAX_AGE_PATTERN.test(attrValue)) {
              cookie.maxAge = Math.min(
                parseInt(attrValue, 10),
                MAX_COOKIE_LIFETIME_SECONDS,
              );
            }
            break;
          }
          case 'samesite': {
            const lower = attrValue.toLowerCase();
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

  private pruneEmptyBucket(apex: string): void {
    if (this.buckets.get(apex)?.size === 0) {
      this.buckets.delete(apex);
    }
  }

  private deleteCookieByIdentity(
    name: string,
    domain: string,
    path: string,
    isHostOnly: boolean,
  ): void {
    domain = this.normalizeStoredDomain(domain);
    const apex = this.apexFor(domain);
    this.buckets
      .get(apex)
      ?.delete(this.cookieKey(name, domain, path, isHostOnly));
    this.pruneEmptyBucket(apex);
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

  /** Returns the apex (registered) domain for bucketing.
   *  Falls back to hostname for IPs and local hostnames like localhost. */
  private apexFor(hostname: string): string {
    const ip = this.tryCanonicalIPLiteral(hostname);

    if (ip !== null) {
      return ip;
    }

    return this.publicSuffixes.apexFor(hostname);
  }

  private getOrCreateBucket(apex: string): Map<string, Cookie> {
    let bucket = this.buckets.get(apex);

    if (!bucket) {
      bucket = new Map();
      this.buckets.set(apex, bucket);
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
    const isSecureScheme = this.isSecureScheme(address.protocol);

    // RFC 6265bis §5.7: a Secure cookie is only accepted from a secure scheme. The send
    // path already withholds Secure cookies on `http:`, but a cookie *stored* from an
    // `http:` response could still replace the `https:` session under the same key -
    // cookie forcing - and the replacement would then go out over `https:` as the
    // real one. Refusing it here keeps a plain-text hop from writing into the secure
    // half of the jar at all.
    if (parsed.secure && !isSecureScheme) {
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
      // latin1, so `Domain=m\xFCnchen.de` reads as `münchen.de` and IDNA made it the
      // registrable `xn--mnchen-3ya.de`. A server sends the `xn--` form.
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
      // host-only when it matches; refusing both alike dropped a cookie a server on
      // `http://localhost/` set for itself with `Domain=localhost`, which is ordinary in
      // local development. What stays refused is the case that made this a hole:
      // `Domain=localhost` from `https://evil.localhost/`, which is a *different* host
      // claiming the shared name, exactly as `Domain=github.io` from `evil.github.io` is.
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

      // A nested private suffix must not grant a tenant scope over its parent.
      if (this.apexFor(requestHostname) !== this.apexFor(normalizedDomain)) {
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
    // whole (RFC 6265bis §5.7), before the deletions below: it deleted the jar's
    // nameless cookie, which `setCookie` would never have let it replace.
    if (parsed.name === '' && /^__(secure|host)-/i.test(parsed.value)) {
      return;
    }

    // RFC 6265bis §5.7 "Leave Secure Cookies Alone": a non-Secure cookie from a
    // non-secure scheme cannot replace, shadow or evict a stored Secure cookie of the
    // same name whose scope covers it. Checked before the expiry-driven deletions
    // below on purpose - `Max-Age=0` over `http:` is otherwise a one-line eviction of
    // the `https:` session, and a fresh one planted beside it would then be the only
    // `session` cookie left to send.
    if (
      !isSecureScheme &&
      this.wouldShadowSecureCookie(parsed.name, domain, path)
    ) {
      return;
    }

    // Align with `if (parsed.domain)` above: empty `Domain=` / `Domain=.` parses to
    // `''` and must be host-only like a missing Domain attribute. A `Domain=` naming a
    // public suffix that is the request host is host-only too, per RFC 6265bis §5.5:
    // the cookie is kept, but only for the host that set it.
    const isHostOnly = !parsed.domain || isPublicSuffixHostOnly;

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
   * Whether a request scheme counts as secure for cookie purposes. The same answer the
   * send path gives: `getCookiesFor` withholds Secure cookies unless the scheme is
   * `https:` or `wss:`, so a scheme that could never receive a Secure cookie may not
   * set one either. `localhost` over `http:` is not secure on either side, so
   * store-time and send-time never disagree about a cookie.
   */
  private isSecureScheme(protocol: string): boolean {
    return protocol === 'https:' || protocol === 'wss:';
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
    const lowerName = parsed.name.toLowerCase();

    if (lowerName.startsWith('__host-')) {
      return parsed.secure === true && !parsed.domain && parsed.path === '/';
    }

    if (lowerName.startsWith('__secure-')) {
      return parsed.secure === true;
    }

    return true;
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
   *
   * The scope is read from the stored record, not the live object, as the send path
   * reads it, so a `secure` cleared through `getAllCookies()` does not open the door.
   */
  private wouldShadowSecureCookie(
    name: string,
    domain: string,
    path: string,
  ): boolean {
    const now = Date.now();
    // Matching scopes can cross bucket boundaries at nested public suffixes,
    // in either direction (a wider insecure cookie can shadow a narrow secure one).
    for (const bucket of this.buckets.values()) {
      for (const stored of bucket.values()) {
        const scope = this.storedScopes.get(stored);

        if (
          scope === undefined ||
          scope.secure !== true ||
          scope.name !== name
        ) {
          continue;
        }

        const isDomainMatch =
          this.domainMatches(domain, scope.domain) ||
          this.domainMatches(scope.domain, domain);

        if (
          isDomainMatch &&
          (this.pathMatches(path, scope.path) ||
            this.pathMatches(scope.path, path))
        ) {
          // Unreadable live cookie fields must not throw or authorize an insecure
          // replacement. Only a trusted expired snapshot releases the secure scope.
          const cookie = this.snapshotForSend(stored);
          if (cookie !== null && this.isExpired(cookie, now)) {
            continue;
          }
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
   * Whether every expiry field the cookie carries can take part in the expiry check.
   * `setCookie` refuses a cookie this rejects, and `isExpired` fails one closed should
   * it ever be reached another way, so the jar never holds a cookie whose expiry is
   * `NaN` and therefore never past.
   */
  private hasReadableExpiry(cookie: CookieInput): boolean {
    const { expires, maxAge, createdAt } = cookie;

    // A `Date` read by its time, not `instanceof`, so one from another realm counts.
    if (expires !== undefined) {
      let time: number;

      try {
        time = Date.prototype.getTime.call(expires);
      } catch {
        return false;
      }

      if (Number.isNaN(time)) {
        return false;
      }
    }

    if (maxAge !== undefined && !Number.isFinite(maxAge)) {
      return false;
    }

    if (createdAt !== undefined && !Number.isFinite(createdAt)) {
      return false;
    }

    return true;
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

    // A name holds no `=` (its own delimiter) and no space. It may be empty - a nameless
    // cookie, sent as its value alone (RFC 6265bis) - when the value is not: and then the
    // value holds no `=`, or it would be read back as a name, and does not pose as a
    // `__Secure-` / `__Host-` cookie, which RFC 6265bis refuses.
    if (name === '') {
      return (
        value !== '' &&
        !value.includes('=') &&
        !/^__(secure|host)-/i.test(value) &&
        isHeaderSafeCookieText(value, '')
      );
    }

    return (
      isHeaderSafeCookieText(name, '= \t') && isHeaderSafeCookieText(value, '')
    );
  }

  /**
   * A plain copy of a stored cookie with every field read exactly once, or `null` when
   * the cookie must be withheld from the request.
   *
   * `getAllCookies()` hands out the stored objects, so every field is caller-writable -
   * and can be replaced by an accessor. Two things follow, and both were reachable:
   *
   * - Reading a field for the check and again for the header let the two reads disagree.
   *   A `value` getter answering `'ok'` to {@link hasWritableNameAndValue} and
   *   `'x; other=evil'` to the header put a second pair on the wire, which is exactly
   *   the framing that check exists to refuse.
   * - A snapshot alone would not help the fields that decide *where* a cookie goes,
   *   because the write lands on the stored object itself: clearing `secure` on a session
   *   cookie stored for `https:` sent it in the clear, and clearing `hostOnly` while
   *   widening `domain` and `path` sent it to a sibling host and a path it was never
   *   stored for. So those come from {@link StoredCookieScope}, recorded by `setCookie`
   *   and held off the cookie, along with the `name` - the other half of the key the
   *   cookie is filed under, and what the header calls it. Bucketing by apex already
   *   bounded the widening to one registrable domain; this bounds it to what was stored.
   *
   * `value` is not anchored that way: it is the cookie's payload rather than its
   * identity, and writing a new one through `getAllCookies()` is a supported update. It
   * is read once and vetted, so what the header carries is what passed the check.
   *
   * A read that throws withholds the cookie, the way {@link isExpired} already fails
   * closed on an expiry it cannot read. So does a `secure` or `hostOnly` that was stored
   * as something other than a boolean, where coercion would land on the looser side, and
   * a cookie with no recorded scope, which is a cookie no `setCookie` filed.
   */
  private snapshotForSend(stored: Cookie): Cookie | null {
    const scope = this.storedScopes.get(stored);

    if (scope === undefined) {
      return null;
    }

    if (scope.secure !== undefined && typeof scope.secure !== 'boolean') {
      return null;
    }

    if (scope.hostOnly !== undefined && typeof scope.hostOnly !== 'boolean') {
      return null;
    }

    let cookie: Cookie;

    try {
      // Each mutable field read once, and an absent one left absent rather than written
      // as an own `undefined`: `toJSON` and callers test presence with `in`.
      cookie = {
        name: scope.name,
        value: stored.value,
        createdAt: stored.createdAt,
        domain: scope.domain,
        path: scope.path,
      };

      if (scope.hostOnly !== undefined) {
        cookie.hostOnly = scope.hostOnly;
      }

      if (scope.secure !== undefined) {
        cookie.secure = scope.secure;
      }

      this.copyIfPresent(stored, cookie, 'expires');
      this.copyIfPresent(stored, cookie, 'maxAge');
      this.copyIfPresent(stored, cookie, 'httpOnly');
      this.copyIfPresent(stored, cookie, 'sameSite');
    } catch {
      return null;
    }

    if (!this.hasWritableNameAndValue(cookie)) {
      return null;
    }

    // `createdAt` is the sort key as well as half the Max-Age arithmetic.
    if (!Number.isFinite(cookie.createdAt) || !this.hasReadableExpiry(cookie)) {
      return null;
    }

    // Own copy of the date too, so the returned cookie carries nothing the jar still
    // holds a reference to.
    if (cookie.expires !== undefined) {
      cookie.expires = new Date(cookie.expires);
    }

    return cookie;
  }

  /** Copies `key` from `from` to `to` only when it is present, reading it once. */
  private copyIfPresent<K extends keyof Cookie>(
    from: Cookie,
    to: Partial<Pick<Cookie, K>>,
    key: K,
  ): void {
    const value = from[key];

    if (value !== undefined) {
      to[key] = value;
    }
  }

  private isExpired(cookie: Cookie, now: number): boolean {
    // Unknown expiry fails closed, including accessors installed on a live cookie.
    // Read each field once so a changing getter cannot disagree with its own check.
    try {
      const maxAge = cookie.maxAge;
      if (maxAge !== undefined) {
        const expiresAt = cookie.createdAt + maxAge * 1000;
        return !Number.isFinite(expiresAt) || now >= expiresAt;
      }

      const expires = cookie.expires;
      if (expires) {
        const expiresAt = expires.getTime();
        return Number.isNaN(expiresAt) || now >= expiresAt;
      }

      return false;
    } catch {
      return true;
    }
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
    cookieDomain: string,
  ): boolean {
    if (!cookieDomain) {
      return true;
    }

    const requestHost =
      typeof requestHostInput === 'string'
        ? this.prepareHost(requestHostInput)
        : requestHostInput;
    const canonicalRequestHost = requestHost.canonicalIP;
    const canonicalCookieDomain = this.tryCanonicalIPLiteral(cookieDomain);

    if (canonicalRequestHost !== null && canonicalCookieDomain !== null) {
      return canonicalRequestHost === canonicalCookieDomain;
    }

    // DNS suffix rules apply only when neither side is an IP. In particular,
    // `evil.10.0.0.5` must not match a cookie domain of `10.0.0.5`.
    if (canonicalRequestHost !== null || canonicalCookieDomain !== null) {
      return false;
    }

    const req = this.normalizedPreparedHost(requestHost);
    const cook = this.normalizeStoredDomain(cookieDomain);

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
    requestHostInput: string | PreparedHost,
    cookieDomain: string,
  ): boolean {
    const requestHost =
      typeof requestHostInput === 'string'
        ? this.prepareHost(requestHostInput)
        : requestHostInput;
    const canonicalRequestHost = requestHost.canonicalIP;
    const canonicalCookieDomain = this.tryCanonicalIPLiteral(cookieDomain);

    if (canonicalRequestHost !== null && canonicalCookieDomain !== null) {
      return canonicalRequestHost === canonicalCookieDomain;
    }

    return (
      this.normalizedPreparedHost(requestHost) ===
      this.normalizeStoredDomain(cookieDomain)
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

/** `text` without leading and trailing spaces and tabs, the only whitespace RFC 6265bis trims. */
function trimSpacesAndTabs(text: string): string {
  let start = 0;
  let end = text.length;

  while (start < end && (text[start] === ' ' || text[start] === '\t')) {
    start++;
  }

  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
    end--;
  }

  return text.slice(start, end);
}
