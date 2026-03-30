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
  /** Time the cookie was stored (used with maxAge) */
  createdAt: number;
}

export interface CookieJarJSON {
  cookies: Cookie[];
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
 *
 * IPs and local hostnames like localhost are never treated as public suffixes.
 */
export class CookieJar {
  // Outer key: apex domain from tldts (e.g. 'example.co.uk'), or the hostname
  //            itself for IPs and localhost
  // Inner key: composite 'name@domain/path' for deduplication
  private buckets: Map<string, Map<string, Cookie>> = new Map();

  /**
   * Stores or updates a cookie. Returns false if the domain is missing or
   * not a valid hostname/IP (e.g. empty string, spaces, garbage input).
   *
   * Valid domains include: hostnames (example.com, localhost, myapp.test),
   * IPv4 (127.0.0.1), and IPv6 ([::1]).
   *
   * For server responses use parseSetCookieHeader — it also enforces PSL
   * validation and domain-suffix checks on top of the syntax check here.
   */
  public setCookie(cookie: Cookie): boolean {
    const domain = cookie.domain ?? '';

    if (!this.isSyntaxValidDomain(domain)) {
      return false;
    }

    const normalizedDomain = this.normalizeStoredDomain(domain);
    const path = cookie.path ?? '/';
    const bucket = this.getOrCreateBucket(this.apexFor(normalizedDomain));

    bucket.set(this.cookieKey(cookie.name, normalizedDomain, path), {
      ...cookie,
      domain: normalizedDomain,
      path,
    });

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
   * Applies the same rules as getCookiesFor — domain, path, and expiry are all checked.
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
        const domain = cookie.domain ?? '';
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
   */
  public getCookiesFor(url: string): Cookie[] {
    let hostname: string;
    let pathname: string;

    let requestScheme: string;

    try {
      const parsed = new URL(url);
      hostname = parsed.hostname;
      pathname = parsed.pathname;
      // RFC 6265 §5.4 — Secure cookies must not be sent on non-HTTPS requests.
      requestScheme = parsed.protocol;
    } catch {
      return [];
    }

    const now = Date.now();
    const result: Cookie[] = [];
    const apex = this.apexFor(hostname);

    const apexBucket = this.buckets.get(apex);

    if (apexBucket) {
      for (const cookie of apexBucket.values()) {
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

        if (cookie.secure && requestScheme !== 'https:') {
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
   * behavior on the wire).
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
        if (cookie.domain === normalizedHost) {
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
   */
  public fromJSON(data: CookieJarJSON): void {
    this.buckets.clear();

    for (const cookie of data.cookies) {
      if (cookie.expires && !(cookie.expires instanceof Date)) {
        cookie.expires = new Date(cookie.expires as unknown as string);
      }

      this.setCookie(cookie);
    }
  }

  // --- Private helpers ---

  private cookieKey(name: string, domain: string, path: string): string {
    return `${name}@${domain}${path}`;
  }

  /** Canonical form for stored cookie domains: lowercase DNS names; canonical IP literals. */
  private normalizeStoredDomain(domain: string): string {
    const ip = this.tryCanonicalIPLiteral(domain);

    if (ip !== null) {
      return ip;
    }

    return this.unbracketHost(domain).toLowerCase();
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
            // RFC 6265 §5.2 — empty Path attribute is ignored (default-path applies).
            if (attrValue !== '') {
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
            const maxAge = parseInt(attrValue, 10);
            if (!isNaN(maxAge)) {
              cookie.maxAge = maxAge;
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

    let domain: string;

    if (parsed.domain) {
      // RFC 6265 §5.2.3: strip leading dot
      const raw = parsed.domain.startsWith('.')
        ? parsed.domain.slice(1)
        : parsed.domain;

      // RFC 6265 5.1.3: domain matching is case-insensitive; URL.host is lowercased but Domain= is not.
      const normalizedDomain = this.normalizeStoredDomain(raw);

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

  private isExpired(cookie: Cookie, now: number): boolean {
    if (cookie.maxAge !== undefined) {
      return now > cookie.createdAt + cookie.maxAge * 1000;
    }

    if (cookie.expires) {
      return now > cookie.expires.getTime();
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
