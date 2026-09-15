import { parse } from 'tldts';
import { normalizeAdapterResponseHeaders } from './utils';

// Matches bare hostnames like 'localhost', 'myapp', 'my-app' that tldts
// won't assign a registered domain to but are still valid cookie domains.
const HOSTNAME_PATTERN =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;

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
  /** True when the cookie came from a Set-Cookie without Domain= and must not match subdomains. */
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
 * Shareable, standalone cookie jar.
 *
 * Cookies are bucketed by apex domain (via tldts Public Suffix List) for efficient
 * URL lookup — only the relevant bucket is scanned instead of all stored cookies.
 *
 * Validation applied when storing from Set-Cookie headers:
 * - Rejects Domain= values that are recognized public suffixes (e.g. co.uk, com)
 * - Rejects Domain= values that are not a suffix of the request host
 * - Strips leading dots from Domain= per RFC 6265
 * - Rejects a `Secure` cookie set over a non-secure scheme, and a non-`Secure` cookie
 *   set over a non-secure scheme that would replace or evict a stored `Secure` cookie
 *   (RFC 6265bis "Leave Secure Cookies Alone")
 * - Enforces the `__Secure-` and `__Host-` name prefixes (RFC 6265bis)
 *
 * IPs and local hostnames like localhost are never treated as public suffixes.
 */
/**
 * Whether every character of `text` can be written into a `Cookie` header as part of
 * one cookie-pair: no control character (a CR LF is a header injection, a DEL or tab is
 * refused by the header parser on the other side), no `;` (the pair delimiter), and
 * none of `extra`.
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

    if (code <= 0x1f || code === 0x7f || char === ';' || extra.includes(char)) {
      return false;
    }
  }

  return true;
}

/** RFC 6265 §5.2.2 delta-seconds: an optional `-`, then digits only. */
const MAX_AGE_PATTERN = /^-?\d+$/;

/**
 * The longest `Max-Age` stored, in seconds: the largest value whose expiry in
 * milliseconds is still a safe integer.
 */
const MAX_COOKIE_MAX_AGE_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

export class CookieJar {
  // Outer key: apex domain from tldts (e.g. 'example.co.uk'), or the hostname
  //            itself for IPs and localhost
  // Inner key: composite 'name@domain/path' for deduplication
  private buckets: Map<string, Map<string, Cookie>> = new Map();

  // The scope each stored cookie was accepted with. Keyed by the stored object and held
  // off it, because the object itself is handed out by `getAllCookies()` and is writable
  // from there; dropped with the cookie when the bucket entry goes.
  private storedScopes: WeakMap<Cookie, StoredCookieScope> = new WeakMap();

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
   * longer passes, so a mutation through `getAllCookies()` cannot reach the header): a name that is empty or holds `=`, `;`, whitespace or a
   * control character, or a value holding `;` or a control character. The header is
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

    const domain = input.domain ?? '';

    if (!this.isSyntaxValidDomain(domain)) {
      return false;
    }

    if (!this.hasReadableExpiry(input)) {
      return false;
    }

    if (!this.hasWritableNameAndValue(input)) {
      return false;
    }

    const normalizedDomain = this.normalizeStoredDomain(domain);
    const path = input.path ?? '/';

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
    const createdAt = input.createdAt ?? Date.now();
    const bucket = this.getOrCreateBucket(this.apexFor(normalizedDomain));

    const stored: Cookie = {
      ...input,
      createdAt,
      domain: normalizedDomain,
      path,
    };

    bucket.set(this.cookieKey(stored.name, normalizedDomain, path), stored);

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
   * Processes all Set-Cookie headers from a response headers object.
   *
   * Uses the same normalization as `HTTPClient` ({@link normalizeAdapterResponseHeaders}):
   * lowercase keys and merged `set-cookie` lines, so mixed-case adapter output
   * matches `FetchAdapter` / normalized responses.
   */
  public processResponseHeaders(
    headers: Record<string, string | string[]>,
    url: string,
  ): void {
    const normalized = normalizeAdapterResponseHeaders(headers);
    const raw = normalized['set-cookie'];

    if (raw === undefined || raw === '') {
      return;
    }

    const lines: string[] = Array.isArray(raw) ? raw : [raw];

    if (lines.length === 0) {
      return;
    }

    for (const line of lines) {
      this.parseSetCookieHeader(line, url);
    }
  }

  /**
   * Returns cookies applicable for the given URL (domain + path matching, unexpired).
   * Cookies with the Secure attribute are omitted unless the URL uses the `https:` scheme
   * (RFC 6265 §5.4).
   *
   * Only scans the apex-domain bucket for the URL — O(cookies in that domain)
   * instead of O(all cookies).
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
    const result: Cookie[] = [];
    const apex = this.apexFor(hostname);

    const apexBucket = this.buckets.get(apex);

    if (apexBucket) {
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

        const isDomainMatch = cookie.hostOnly
          ? this.hostOnlyDomainMatches(hostname, cookie.domain ?? '')
          : this.domainMatches(hostname, cookie.domain ?? '');

        if (!isDomainMatch) {
          continue;
        }

        if (!this.pathMatches(pathname, cookie.path ?? '/')) {
          continue;
        }

        if (cookie.secure === true && !this.isSecureScheme(requestScheme)) {
          continue;
        }

        result.push(cookie);
      }
    }

    result.sort((a, b) => {
      const pathLengthDelta = (b.path ?? '/').length - (a.path ?? '/').length;

      if (pathLengthDelta !== 0) {
        return pathLengthDelta;
      }

      return a.createdAt - b.createdAt;
    });

    return result;
  }

  /**
   * Returns a `Cookie: name=value; name2=value2` string for the given URL.
   * Uses `getCookiesFor`, so expired cookies are never included (same as RFC
   * behavior on the wire), and the pairs are built from the copies it vetted rather than
   * re-read off the stored objects — one pair per cookie, whatever a caller has since
   * written onto them.
   */
  public getCookieHeaderString(url: string): string {
    return this.getCookiesFor(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /**
   * Removes expired cookies from the jar. Returns the number of cookies removed.
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
   *   everything in the `example.com` apex bucket.
   */
  public clear(): number;
  public clear(host: string, scope: 'hostname' | 'domain'): number;
  public clear(host?: string, scope?: 'hostname' | 'domain'): number {
    if (host === undefined) {
      const count = this.getAllCookies().length;
      this.buckets.clear();
      return count;
    } else if (scope === 'domain') {
      const count = this.buckets.get(this.apexFor(host))?.size ?? 0;
      this.buckets.delete(this.apexFor(host));
      return count;
    } else {
      const apex = this.apexFor(host);
      const bucket = this.buckets.get(apex);

      if (!bucket) {
        return 0;
      }

      const normalizedHost = this.normalizeStoredDomain(host);
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
   * Serializes the jar to JSON.
   */
  public toJSON(): CookieJarJSON {
    return { cookies: this.getAllCookies() };
  }

  /**
   * Restores a jar from serialized JSON.
   *
   * `setCookie` refuses a cookie with a missing or invalid domain and says so by returning
   * `false`. This threw that answer away and returned `void`, so a persisted jar could come
   * back short with nothing to say it had - and every other mutator on this class
   * (`clear`, `clearExpiredCookies`, `setCookie`) reports what it did.
   *
   * The payload is read in full before the jar is touched, and each cookie is copied
   * rather than taken. This used to `clear()` first and mutate `expires` in place, so a
   * payload with no `cookies`, a `null` entry, or a frozen cookie threw *after* the jar
   * was already empty - the one order in which a failed restore also loses what was
   * there - and a caller's own array of cookies came back with `Date` objects written
   * into it.
   *
   * A restore *replaces*: once the payload has been read, the jar is emptied and refilled
   * with whatever `setCookie` accepts. A well-formed payload whose cookies are all refused
   * - every domain missing, say - therefore returns `0` and leaves an empty jar, not the
   * cookies that were there before. Only a payload that cannot be read at all leaves the
   * jar untouched. Snapshot with `toJSON()` first if a short restore should be rolled back.
   *
   * A cookie whose `expires` cannot be read as a date is refused the same way a cookie
   * with a bad domain is: left out of the jar and out of the count. It used to be
   * restored with `new Date('garbage')` - an `Invalid Date`, which is truthy, so
   * `isExpired` compared `now` against `NaN`, found it never greater, and the cookie
   * was sent for the life of the jar and never purged. One corrupt date in a persisted
   * jar made an immortal cookie. Refused rather than restored as a session cookie,
   * because a cookie that was persisted with an expiry was not a session cookie, and
   * the header parser drops an unreadable `Expires` attribute for the same reason.
   * `null` - what `JSON.stringify` writes for an `Invalid Date` - and `undefined` mean
   * no expiry, as they do on a live cookie.
   *
   * The same refusal covers the other half of the expiry model: a `maxAge` or a
   * `createdAt` that is not a finite number - a string, `NaN`, an object - made
   * `createdAt + maxAge * 1000` come out `NaN` and the cookie just as immortal, and
   * `isExpired` prefers `maxAge` over `expires`, so a sound `expires` beside a corrupt
   * `maxAge` did not save it. `setCookie` refuses those the way it refuses a bad domain.
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

  private cookieKey(name: string, domain: string, path: string): string {
    return `${name}@${domain}${path}`;
  }

  /** Canonical form for stored cookie domains: no leading dot, lowercase DNS names;
   *  canonical IP literals. RFC 6265 treats a leading dot as ignored, and persisted jars
   *  from browser-oriented implementations commonly retain it. */
  private normalizeStoredDomain(domain: string): string {
    const raw = domain.startsWith('.') ? domain.slice(1) : domain;
    const ip = this.tryCanonicalIPLiteral(raw);

    if (ip !== null) {
      return ip;
    }

    return this.unbracketHost(raw).toLowerCase();
  }

  private parseCookieString(header: string): ParsedCookie | null {
    const parts = header.split(';').map((p) => p.trim());
    const nameValuePart = parts[0];
    const eqIndex = nameValuePart.indexOf('=');

    if (eqIndex === -1) {
      return null;
    }

    const name = nameValuePart.slice(0, eqIndex).trim();
    const value = nameValuePart.slice(eqIndex + 1).trim();

    if (!name) {
      return null;
    }

    const cookie: ParsedCookie = { name, value };

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      const lowerPart = part.toLowerCase();

      if (lowerPart === 'secure') {
        cookie.secure = true;
      } else if (lowerPart === 'httponly') {
        cookie.httpOnly = true;
      } else {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) {
          continue;
        }

        const attrName = part.slice(0, eqIdx).trim().toLowerCase();
        const attrValue = part.slice(eqIdx + 1).trim();

        switch (attrName) {
          case 'domain': {
            cookie.domain = attrValue.startsWith('.')
              ? attrValue.slice(1)
              : attrValue;
            break;
          }
          case 'path': {
            // RFC 6265 §5.2.4 — a Path that is empty or does not start with `/` is
            // ignored (default-path applies). `Path=foo` used to be stored as written;
            // no request path matches it, so the cookie was never sent, but it was held
            // and counted for the life of the jar.
            if (attrValue.startsWith('/')) {
              cookie.path = attrValue;
            }
            break;
          }
          case 'expires': {
            const date = new Date(attrValue);
            if (!isNaN(date.getTime())) {
              cookie.expires = date;
            }
            break;
          }
          case 'max-age': {
            // RFC 6265 §5.2.2 — an optional `-` then digits, and nothing else; otherwise
            // the attribute is ignored. `parseInt` read a prefix, so `Max-Age=60abc` was
            // a minute and `Max-Age=1e9` was one second. Capped so `createdAt + maxAge *
            // 1000` stays a finite number of milliseconds; a longer lifetime is
            // indistinguishable from it.
            if (MAX_AGE_PATTERN.test(attrValue)) {
              cookie.maxAge = Math.min(
                parseInt(attrValue, 10),
                MAX_COOKIE_MAX_AGE_SECONDS,
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
  ): void {
    const apex = this.apexFor(domain);
    this.buckets.get(apex)?.delete(this.cookieKey(name, domain, path));
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

    const result = parse(hostname);
    return result.domain ?? hostname;
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

    if (!this.hasValidNamePrefix(parsed)) {
      return;
    }

    let domain: string;

    if (parsed.domain) {
      // RFC 6265 §5.2.3 / §5.1.3: ignore a leading dot and match domains
      // case-insensitively. URL.host is lowercased but Domain= is not.
      const normalizedDomain = this.normalizeStoredDomain(parsed.domain);

      // Reject public suffixes — prevents Domain=co.uk style attacks
      if (this.isPublicSuffix(normalizedDomain)) {
        return;
      }

      // Reject cross-domain — server can only set cookies for its own domain
      if (!this.domainMatches(requestHostname, normalizedDomain)) {
        return;
      }

      domain = normalizedDomain;
    } else {
      domain = requestHostname;
    }

    const path = this.resolvedCookiePath(parsed, address.pathname);

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

    // Max-Age=0 or negative → delete the cookie
    if (parsed.maxAge !== undefined && parsed.maxAge <= 0) {
      this.deleteCookieByIdentity(parsed.name, domain, path);
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
      this.deleteCookieByIdentity(parsed.name, domain, path);
      return;
    }

    const cookie: Cookie = {
      name: parsed.name,
      value: parsed.value,
      domain,
      // Align with `if (parsed.domain)` above: empty `Domain=` / `Domain=.` parses to
      // `''` and must be host-only like a missing Domain attribute.
      hostOnly: !parsed.domain,
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
   * `Domain` attribute (so the cookie is host-only) and `Path=/`. A cookie that claims
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
   * domain domain-matches the new cookie's domain *or vice versa*, and its path
   * path-matches the new path. Both directions, and without regard to `hostOnly`: a
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
    const bucket = this.buckets.get(this.apexFor(domain));

    if (!bucket) {
      return false;
    }

    for (const stored of bucket.values()) {
      const scope = this.storedScopes.get(stored);

      if (scope === undefined || scope.secure !== true || scope.name !== name) {
        continue;
      }

      const isDomainMatch =
        this.domainMatches(domain, scope.domain) ||
        this.domainMatches(scope.domain, domain);

      if (isDomainMatch && this.pathMatches(path, scope.path)) {
        return true;
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
        new URL(`http://[${inner}]/`);
        return inner.toLowerCase();
      } catch {
        return null;
      }
    }

    if (host.includes(':')) {
      try {
        new URL(`http://[${host}]/`);
        return host.toLowerCase();
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
      // Bare hostnames like 'localhost' — tldts domain is null but valid
      return result.isIcann !== true && HOSTNAME_PATTERN.test(domain);
    }
  }

  /** Returns true if the domain is a recognized public suffix (e.g. co.uk, com).
   *  IPs and local hostnames like localhost are not rejected. */
  private isPublicSuffix(domain: string): boolean {
    if (this.tryCanonicalIPLiteral(domain) !== null) {
      return false;
    }

    const result = parse(domain);
    return !result.isIp && result.domain === null && result.isIcann === true;
  }

  /**
   * Whether every expiry field the cookie carries can take part in the expiry check.
   * `setCookie` refuses a cookie this rejects, and `isExpired` fails one closed should
   * it ever be reached another way, so the jar never holds a cookie whose expiry is
   * `NaN` and therefore never past.
   */
  private hasReadableExpiry(cookie: CookieInput): boolean {
    const { expires, maxAge, createdAt } = cookie;

    if (
      expires !== undefined &&
      (!(expires instanceof Date) || Number.isNaN(expires.getTime()))
    ) {
      return false;
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

    // A name is also non-empty and holds no `=` (its own delimiter) and no space.
    return (
      name !== '' &&
      isHeaderSafeCookieText(name, '= ') &&
      isHeaderSafeCookieText(value, '')
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
    // Fails closed: `setCookie` refuses an expiry that cannot be read, but a comparison
    // against `NaN` is never true, and "never expired" is the wrong side to land on for
    // a cookie whose expiry is unknown.
    if (cookie.maxAge !== undefined) {
      const expiresAt = cookie.createdAt + cookie.maxAge * 1000;

      return !Number.isFinite(expiresAt) || now > expiresAt;
    }

    if (cookie.expires) {
      const expiresAt = cookie.expires.getTime();

      return Number.isNaN(expiresAt) || now > expiresAt;
    }

    return false;
  }

  private domainMatches(requestHost: string, cookieDomain: string): boolean {
    if (!cookieDomain) {
      return true;
    }

    const canonicalRequestHost = this.tryCanonicalIPLiteral(requestHost);
    const canonicalCookieDomain = this.tryCanonicalIPLiteral(cookieDomain);

    if (canonicalRequestHost !== null && canonicalCookieDomain !== null) {
      return canonicalRequestHost === canonicalCookieDomain;
    }

    const req = this.unbracketHost(requestHost).toLowerCase();
    const cook = this.unbracketHost(cookieDomain).toLowerCase();

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
    requestHost: string,
    cookieDomain: string,
  ): boolean {
    const canonicalRequestHost = this.tryCanonicalIPLiteral(requestHost);
    const canonicalCookieDomain = this.tryCanonicalIPLiteral(cookieDomain);

    if (canonicalRequestHost !== null && canonicalCookieDomain !== null) {
      return canonicalRequestHost === canonicalCookieDomain;
    }

    return (
      this.unbracketHost(requestHost).toLowerCase() ===
      this.unbracketHost(cookieDomain).toLowerCase()
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
