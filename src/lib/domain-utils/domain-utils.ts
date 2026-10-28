import { getDomain, getSubdomain, getPublicSuffix } from 'tldts';
import {
  isAllWildcards,
  isHostTooLongToNormalize,
  hasPartialLabelWildcard,
  checkDNSLength,
  normalizeDomain,
  normalizeDomainName,
  readURLParserIPv4,
  isIPv6,
  toAsciiDots,
  canonicalizeBracketedIPv6Content,
  extractFixedTailAfterLastWildcard,
  isIPAddress,
  normalizeWildcardPattern,
  compileWildcardPattern,
  matchesCompiledWildcard,
  isUnmatchableWildcardTail,
  INTERNAL_PSEUDO_TLDS,
  INVALID_DOMAIN_CHARS,
  MAX_LABELS,
  readTrimmedEntry,
} from './helpers';
import {
  asciiLowercase,
  hasNonHTTPWhitespaceEdge,
  trimHTTPWhitespace,
  trimWhere,
} from '../internal/ascii-text';

export function safeParseURL(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function hasValidWildcardOriginHost(url: URL): boolean {
  return normalizeDomain(url.hostname) !== '';
}

function extractAuthority(input: string, schemeIdx: number): string {
  const afterScheme = input.slice(schemeIdx + 3);
  const cut = Math.min(
    ...[
      afterScheme.indexOf('/'),
      afterScheme.indexOf('?'),
      afterScheme.indexOf('#'),
    ].filter((i) => i !== -1),
  );

  return cut === Infinity ? afterScheme : afterScheme.slice(0, cut);
}

function hasDanglingPortInAuthority(input: string): boolean {
  const schemeIdx = input.indexOf('://');
  if (schemeIdx === -1) {
    return false;
  }

  const authority = extractAuthority(input, schemeIdx);
  const at = authority.lastIndexOf('@');
  const hostPort = at === -1 ? authority : authority.slice(at + 1);

  return hostPort.endsWith(':');
}

/** The URL parser's special schemes, each with its colon. */
const SPECIAL_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
  'ftp:',
  'file:',
]);

/** Whether the URL parser treats `protocol` (with its colon) as a special scheme. */
function isSpecialScheme(protocol: string): boolean {
  return SPECIAL_SCHEMES.has(protocol);
}

/**
 * An origin as the URL parser reads its text, or `undefined` when it is not written as
 * `scheme://authority`.
 *
 * The parser deletes every tab, CR and LF and strips leading and trailing C0 controls and
 * spaces before it reads anything, and it accepts a special scheme without its `//`
 * (`https:host`, `https:/host`, `https:\\host`). The textual guards here - a dangling
 * port, a percent-encoded host, the scheme that decides dot folding - read the text, so
 * they read it cleaned the same way, and only in the `scheme://` form every `Origin`
 * header takes: in any other, they would never see the host the parser then decodes.
 */
function toOriginText(text: string): string | undefined {
  const cleaned = trimWhere(
    text.replace(/[\t\n\r]/g, ''),
    (code) => code <= 0x20,
  );

  // `scheme://` followed directly by the authority: the parser skips any further `/` or
  // `\` after a special scheme and ends its authority at `\` too, so `https:///ex%61mple.com`
  // and `https://example.com:\` would have the guards read a host other than the
  // parser's. No `Origin` takes either form, so they are refused rather than imitated.
  const match = /^[a-z][a-z\d+.-]*:\/\/(.*)$/is.exec(cleaned);
  if (match === null) {
    return undefined;
  }

  const afterSlashes = match[1] ?? '';
  return afterSlashes.startsWith('/') || afterSlashes.includes('\\')
    ? undefined
    : cleaned;
}

/**
 * Whether an origin's host is percent-encoded. No browser sends one in an `Origin`, and
 * `validateConfigEntry` refuses one, so the matchers refuse it too rather than read it
 * decoded and match an entry the validator rejects. An IPv6 literal's `%25` zone is left
 * to the IPv6 handling.
 */
function hasPercentEncodedHost(origin: string): boolean {
  const schemeSep = origin.indexOf('://');

  if (schemeSep === -1) {
    return false;
  }

  const authority = extractAuthority(origin, schemeSep);
  const host = authority.slice(authority.lastIndexOf('@') + 1);

  return !host.startsWith('[') && host.includes('%');
}

/**
 * `text` with Unicode dot variants folded to `.` in its authority, as the URL parser's
 * IDNA mapping folds them in a special scheme's host - but not for a non-special scheme,
 * whose host the parser keeps opaque and percent-encodes them in, and never past the
 * authority: a path of `/。` folded to `/.` would be collapsed to `/` by the parser, and
 * `https://example.com/。` would read as the bare origin, where its path is `/%E3%80%82`.
 */
function foldOriginDots(text: string): string {
  // `text` is `toOriginText`'s, so it starts with `scheme://`, where the parser sees it.
  const schemeSep = text.indexOf('://');

  if (!isSpecialScheme(asciiLowercase(text.slice(0, schemeSep + 1)))) {
    return text;
  }

  const authorityStart = schemeSep + 3;
  const authority = extractAuthority(text, schemeSep);
  const authorityEnd = authorityStart + authority.length;

  return (
    text.slice(0, authorityStart) +
    toAsciiDots(authority) +
    text.slice(authorityEnd)
  );
}

/**
 * A URL's hostname normalized as the URL parser read it. A special scheme's host may be
 * an IPv4 address (`2130706433` is `127.0.0.1`). A non-special scheme's is opaque - kept
 * as written, never an IPv4 address: reading it as one would refuse `foo://a.2.3.4` and
 * merge `foo://2130706433` with `foo://127.0.0.1` - except an IPv6 literal, which the
 * parser reads for every scheme, so `foo://[::1]` keeps its brackets and matches itself.
 */
function normalizeOriginHostname(protocol: string, hostname: string): string {
  return isSpecialScheme(protocol) || hostname.startsWith('[')
    ? normalizeDomain(hostname)
    : normalizeDomainName(hostname);
}

/**
 * Normalize a bare origin for consistent comparison.
 * Returns the canonical origin form with a normalized hostname,
 * lowercase scheme, no trailing slash, and every special scheme's default port removed
 * (`:443` for `https` and `wss`, `:80` for `http` and `ws`, `:21` for `ftp`).
 */
export function normalizeOrigin(origin: string): string {
  // Preserve literal "null" origin exactly; treat all other invalids as empty sentinel
  if (origin === 'null') {
    return 'null';
  }

  // Read as the parser reads its text; see `toOriginText`.
  const originText = toOriginText(origin);
  if (originText === undefined) {
    return '';
  }

  // Normalize Unicode dots before URL parsing for browser compatibility
  // Chrome allows URLs like https://127。0。0。1 - but only for a special scheme's host:
  // a non-special scheme's is opaque, and the parser percent-encodes those dots.
  const normalizedOrigin = foldOriginDots(originText);
  if (hasDanglingPortInAuthority(normalizedOrigin)) {
    return '';
  }

  // A percent-encoded host (`https://ex%61mple.com`) is refused, as `validateConfigEntry`
  // refuses it. See `hasPercentEncodedHost`. So is an empty userinfo, query or fragment.
  if (
    hasPercentEncodedHost(normalizedOrigin) ||
    hasOriginExtras(normalizedOrigin)
  ) {
    return '';
  }

  const url = safeParseURL(normalizedOrigin);
  if (url) {
    // Only normalize bare origins. Allow a single trailing slash so callers
    // can pass values like "https://example.com/" without broadening real paths.
    if (
      url.username ||
      url.password ||
      (url.pathname && url.pathname !== '/') ||
      url.search ||
      url.hash
    ) {
      return '';
    }

    // Normalize hostname with punycode, as the URL parser read it. See
    // `normalizeOriginHostname`.
    const protocolLower = asciiLowercase(url.protocol);
    const normalizedHostname = normalizeOriginHostname(
      protocolLower,
      url.hostname,
    );

    // If hostname normalization fails (pathological IDN), return original origin
    // to avoid emitting values like "https://" with an empty host.
    if (normalizedHostname === '') {
      return '';
    }

    // Preserve brackets for IPv6 hosts; avoid double-bracketing if already present
    let host: string;
    // Extract the raw bracketed host (if present) from the authority portion only
    // to prevent matching brackets in path/query/fragment portions of full URLs.
    const schemeSep = normalizedOrigin.indexOf('://');
    const authority = extractAuthority(normalizedOrigin, schemeSep);
    const bracketMatch = authority.match(/\[([^\]]+)\]/);
    const rawBracketContent = bracketMatch ? bracketMatch[1] : null;

    // Decode only for IPv6 detection, not for output
    const hostnameForIpv6Check = asciiLowercase(
      (rawBracketContent ? rawBracketContent : normalizedHostname).replace(
        /%25/g,
        '%',
      ),
    );

    if (isIPv6(hostnameForIpv6Check)) {
      // Canonicalize bracket content using shared helper (do not decode %25)
      const raw = rawBracketContent
        ? rawBracketContent
        : normalizedHostname.replace(/^\[|\]$/g, '');

      const canon = canonicalizeBracketedIPv6Content(raw);

      host = `[${canon}]`;
    } else {
      host = normalizedHostname;
    }

    // An empty `url.port` is the scheme's default: the parser drops every special
    // scheme's (`wss://x.com:443` reads as `wss://x.com`), so it stays off.
    const port = url.port ? `:${url.port}` : '';

    // Explicitly use lowercase protocol for consistency
    return `${protocolLower}//${host}${port}`;
  }

  // If URL parsing fails, return empty sentinel (handles invalid URLs).
  // Literal "null" is handled above.
  return '';
}

/**
 * Smart wildcard matching for domains (apex must be explicit)
 *
 * Special case: a single "*" matches any host (domains and IPs).
 * For non-global patterns, apex domains must be listed explicitly.
 *
 * Pattern matching rules:
 * - "*.example.com" matches DIRECT subdomains only:
 *   - "api.example.com" ✅ (direct subdomain)
 *   - "app.api.example.com" ❌ (nested subdomain - use ** for this)
 * - "**.example.com" matches ALL subdomains (including nested):
 *   - "api.example.com" ✅ (direct subdomain)
 *   - "app.api.example.com" ✅ (nested subdomain)
 *   - "v2.app.api.example.com" ✅ (deep nesting)
 * - "*.*.example.com" matches exactly TWO subdomain levels:
 *   - "a.b.example.com" ✅ (two levels)
 *   - "api.example.com" ❌ (one level)
 *   - "x.y.z.example.com" ❌ (three levels)
 */
export function matchesWildcardDomain(
  domain: string,
  pattern: string,
): boolean {
  return matchesWildcardDomainIn(domain, pattern, true);
}

/**
 * {@link matchesWildcardDomain}, its pattern compiled through the shared cache when
 * `isCached` - false for a pattern from a list longer than the cache, which scanned in
 * order would evict, entry by entry, the one the next scan needs first (see
 * `cachedEntry`).
 */
function matchesWildcardDomainIn(
  domain: string,
  pattern: string,
  isCached: PatternCache,
): boolean {
  const normalizedDomain = normalizeDomain(domain);

  if (normalizedDomain === '') {
    return false; // invalid domain cannot match
  }

  // From the shared cache: uncached, a fixed allowlist checked on every request would
  // compile each pattern - IDNA per label, a Public Suffix List lookup - every time.
  const compiled = compiledWildcardPattern(pattern, isCached);

  return (
    compiled !== undefined &&
    matchesCompiledWildcard(normalizedDomain, compiled)
  );
}

/**
 * Smart origin wildcard matching for CORS with URL parsing
 * Supports protocol-specific wildcards and domain wildcards:
 * - * - matches any valid HTTP(S) origin (global wildcard)
 * - https://* or http://* - matches any domain with specific protocol
 * - *.example.com - matches direct subdomains with any protocol (ignores port)
 * - **.example.com - matches all subdomains including nested with any protocol
 * - https://*.example.com or http://*.example.com - matches direct subdomains with specific protocol
 * - https://**.example.com or http://**.example.com - matches all subdomains including nested with specific protocol
 *
 * Protocol support:
 * - For CORS, only http/https are supported; non-HTTP(S) origins never match
 * - Invalid or non-HTTP(S) schemes are rejected early for security
 *
 * Special cases:
 * - "null" origins: Cannot be matched by wildcard patterns, only by exact string inclusion in arrays
 *   (Security note: sandboxed/file/data contexts can emit literal "null". Treat as lower trust; do not
 *   allow via "*" or host wildcards. Include the literal "null" explicitly if you want to allow it.)
 * - Apex domains (example.com) must be listed explicitly, wildcards ignore port numbers
 * - Invalid URLs that fail parsing are treated as literal strings (no wildcard matching)
 */
export function matchesWildcardOrigin(
  origin: string,
  pattern: string,
): boolean {
  return wildcardOriginMatcher(origin, true)(pattern);
}

/**
 * {@link matchesWildcardOrigin} for a whole list of patterns, each cached as `isCached`
 * says (see above): the origin is read once - when a pattern first needs it - rather than
 * for every wildcard entry.
 */
function wildcardOriginMatcher(
  origin: string,
  isCached: PatternCache,
): (pattern: string) => boolean {
  let parsed: WildcardOrigin | undefined;
  let isRead = false;

  return (pattern) => {
    if (!isRead) {
      const originURL = readWildcardOrigin(origin);
      parsed = originURL === undefined ? undefined : { url: originURL };
      isRead = true;
    }

    return (
      parsed !== undefined &&
      matchesWildcardPatternIn(parsed, pattern, isCached)
    );
  };
}

/** An origin as a wildcard pattern reads it (see `readWildcardOrigin`). */
interface WildcardOrigin {
  url: URL;
  /** Its hostname normalized, when a pattern has first needed it. */
  normalizedHostname?: string;
}

/**
 * `origin` parsed as a wildcard pattern reads it: an HTTP(S) origin with nothing past its
 * host and port, or `undefined` for one no wildcard pattern matches.
 */
function readWildcardOrigin(origin: string): URL | undefined {
  // Read as the parser reads its text, as `normalizeOrigin` reads it; see `toOriginText`.
  const originText = toOriginText(origin);
  if (originText === undefined) {
    return undefined;
  }

  // Normalize Unicode dots before URL parsing for consistency
  const normalizedOrigin = foldOriginDots(originText);

  if (
    hasDanglingPortInAuthority(normalizedOrigin) ||
    hasPercentEncodedHost(normalizedOrigin) ||
    hasOriginExtras(normalizedOrigin)
  ) {
    return undefined;
  }

  // Every pattern - `*` and the protocol wildcards included - needs a parsed URL.
  const originURL = safeParseURL(normalizedOrigin);
  if (!originURL) {
    return undefined;
  }

  // For CORS, only http/https are relevant.
  const scheme = asciiLowercase(originURL.protocol);
  if (scheme !== 'http:' && scheme !== 'https:') {
    return undefined;
  }

  if (
    originURL.username ||
    originURL.password ||
    (originURL.pathname && originURL.pathname !== '/') ||
    originURL.search ||
    originURL.hash
  ) {
    return undefined;
  }

  return originURL;
}

/** Whether an origin read by `readWildcardOrigin` matches `pattern`. */
function matchesWildcardPatternIn(
  origin: WildcardOrigin,
  pattern: string,
  isCached: PatternCache,
): boolean {
  const originURL = origin.url;
  // Trimmed, as `validateConfigEntry` and `matchesOriginList` read it: untrimmed,
  // ` https://*` would match nothing here alone. Of HTTP whitespace only - see
  // `readTrimmedEntry`.
  const trimmedPattern = readTrimmedEntry(pattern);
  if (trimmedPattern === undefined) {
    return false;
  }
  const normalizedPattern = toAsciiDots(trimmedPattern);

  // Global wildcard: single "*" matches any valid HTTP(S) origin
  if (normalizedPattern === '*') {
    return hasValidWildcardOriginHost(originURL);
  }

  // Protocol-only wildcards
  const patternLower = asciiLowercase(normalizedPattern);

  if (patternLower === 'https://*' || patternLower === 'http://*') {
    const want = patternLower === 'https://*' ? 'https:' : 'http:';
    return (
      asciiLowercase(originURL.protocol) === want &&
      hasValidWildcardOriginHost(originURL)
    );
  }

  origin.normalizedHostname ??= normalizeDomain(originURL.hostname);
  const normalizedHostname = origin.normalizedHostname;

  if (normalizedHostname === '') {
    return false;
  }

  const originProtocol = asciiLowercase(originURL.protocol.slice(0, -1)); // Remove trailing ":" and lowercase

  // Handle protocol-specific domain wildcards: https://*.example.com
  if (normalizedPattern.includes('://')) {
    const [patternProtocol, ...rest] = normalizedPattern.split('://');
    const domainPattern = rest.join('://');

    // Reject non-domain characters in the domain pattern portion
    if (INVALID_DOMAIN_CHARS.test(domainPattern)) {
      return false;
    }

    // Protocol must match exactly
    if (originProtocol !== asciiLowercase(patternProtocol)) {
      return false;
    }

    // Fast reject: domain pattern must contain at least one wildcard and not be all-wildcards
    // - read without leading HTTP whitespace, as the domain matcher reads it: `https:// *`
    // would otherwise act as the protocol wildcard `https://*`, which
    // `validateConfigEntry` refuses. A trailing space is the validator's own trim, and
    // `https://* ` still matches.
    if (
      !domainPattern.includes('*') ||
      isAllWildcards(trimHTTPWhitespace(domainPattern))
    ) {
      return false;
    }

    // Check domain pattern using direct domain matching
    return matchesWildcardDomainIn(normalizedHostname, domainPattern, isCached);
  }

  // Handle domain wildcard patterns (including multi-label patterns)
  if (normalizedPattern.includes('*')) {
    // Fast reject for invalid all-wildcards patterns (e.g., "*.*", "**.*")
    // Note: single "*" is handled above as global wildcard
    if (normalizedPattern !== '*' && isAllWildcards(normalizedPattern)) {
      return false;
    }

    return matchesWildcardDomainIn(
      normalizedHostname,
      normalizedPattern,
      isCached,
    );
  }

  return false;
}

/**
 * Wildcard patterns compiled for {@link matchesDomainList}, which is called on every
 * request with the same list: compiling runs IDNA on each label and looks the tail up in
 * the Public Suffix List. Bounded, least recently used out first, so a list of ever-new
 * patterns does not grow it without bound.
 */
const compiledWildcardPatterns = new Map<
  string,
  ReturnType<typeof compileWildcardPattern>
>();
const MAX_COMPILED_WILDCARD_PATTERNS = 512;

/** A scheme and `://`: an origin, which a domain list refuses. */
const ORIGIN_LIKE = /^[a-z][a-z0-9+\-.]*:\/\//i;

/** Exact entries normalized for {@link matchesDomainList}, cached as patterns are. */
const normalizedExactEntries = new Map<string, string>();

/**
 * Where a wildcard pattern's compiled form is kept: the shared cache (`true`), nowhere
 * (`false`, for a list longer than it - see `cachedEntry`), or a list's own map (see
 * `originListPatterns`).
 */
type PatternCache =
  boolean | Map<string, ReturnType<typeof compileWildcardPattern>>;

function compiledWildcardPattern(
  pattern: string,
  cache: PatternCache,
): ReturnType<typeof compileWildcardPattern> {
  if (cache instanceof Map) {
    if (cache.has(pattern)) {
      return cache.get(pattern);
    }
    const compiled = compileWildcardPattern(pattern);
    cache.set(pattern, compiled);
    return compiled;
  }

  return cache
    ? cachedEntry(compiledWildcardPatterns, pattern, compileWildcardPattern)
    : compileWildcardPattern(pattern);
}

function normalizedExactEntry(entry: string, isCached: boolean): string {
  return isCached
    ? cachedEntry(normalizedExactEntries, entry, normalizeDomain)
    : normalizeDomain(entry);
}

/**
 * `compute(key)`, kept in `cache`. Least recently used out first: a hit moves to the end,
 * the oldest goes when full. A list longer than the cache is not cached at all: scanned
 * in order, each entry would evict the one the next scan needs first, missing every time
 * at more cost than computing them.
 */
function cachedEntry<T>(
  cache: Map<string, T>,
  key: string,
  compute: (key: string) => T,
): T {
  if (cache.has(key)) {
    const cached = cache.get(key) as T;
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }

  const value = compute(key);
  if (cache.size >= MAX_COMPILED_WILDCARD_PATTERNS) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, value);

  return value;
}

/** A domain-list entry as {@link matchesDomainList} reads it, compiled once. */
type CompiledDomainEntry =
  | {
      kind: 'wildcard';
      compiled: ReturnType<typeof compileWildcardPattern>;
    }
  | { kind: 'exact'; normalized: string };

/**
 * A list's entries, cleaned and validated, each compiled the first time a match reaches
 * it - so a scan that matches early compiles nothing past its match.
 */
interface CompiledDomainList {
  /** The entries the list held, to check it against next time. */
  source: readonly string[];
  /** Trimmed, with the empty ones dropped. */
  cleaned: readonly string[];
  /** Compiled as reached; `undefined` until then. */
  entries: (CompiledDomainEntry | undefined)[];
  isCached: boolean;
}

/**
 * Each list's compiled entries, kept against the list itself: a service checks the same
 * array on every request, and lists that each fit the shared caches above could still
 * evict each other there, two 300-entry lists used in turn recompiling every pattern on
 * every call. Kept with a copy of the entries the list held, and used only while it still
 * holds exactly those - an array is the caller's to change, and an entry they removed
 * must stop matching. A list built anew for each call misses here and falls back to the
 * shared caches.
 */
const compiledDomainLists = new WeakMap<
  readonly string[],
  CompiledDomainList
>();

function compiledDomainList(
  allowedDomains: readonly string[],
): CompiledDomainList {
  const kept = compiledDomainLists.get(allowedDomains);
  if (kept !== undefined && isSameList(kept.source, allowedDomains)) {
    return kept;
  }

  // Each entry read once, into the copy the list is checked against next time. `slice`,
  // not a spread: a sparse list's holes stay holes, which the `map` below skips, rather
  // than becoming `undefined` entries that throw.
  const source = allowedDomains.slice();

  // Trim and filter out empty entries first - and any edged with whitespace other than
  // spaces, tabs, CRs and LFs, which match nothing (see `readTrimmedEntry`).
  const cleaned = source
    .map((s) => readTrimmedEntry(s) ?? '')
    .filter((s) => s.length > 0);

  // Validate: throw if any origin-style patterns are present
  const originLike = cleaned.filter((s) => ORIGIN_LIKE.test(s));

  if (originLike.length > 0) {
    throw new Error(
      `matchesDomainList: origin-style patterns are not allowed in domain lists: ${originLike.join(', ')}`,
    );
  }

  const list: CompiledDomainList = {
    source,
    cleaned,
    entries: [],
    // A list that fits the shared caches is cached there too; see `cachedEntry`.
    isCached: cleaned.length <= MAX_COMPILED_WILDCARD_PATTERNS,
  };
  compiledDomainLists.set(allowedDomains, list);

  return list;
}

/** Entry `index` of `list`, compiled the first time it is reached. */
function compiledDomainEntry(
  list: CompiledDomainList,
  index: number,
): CompiledDomainEntry {
  const kept = list.entries[index];
  if (kept !== undefined) {
    return kept;
  }

  const allowed = list.cleaned[index];
  const entry: CompiledDomainEntry = allowed.includes('*')
    ? {
        kind: 'wildcard',
        compiled: compiledWildcardPattern(allowed, list.isCached),
      }
    : {
        kind: 'exact',
        normalized: normalizedExactEntry(allowed, list.isCached),
      };
  list.entries[index] = entry;

  return entry;
}

/**
 * Each origin list's compiled wildcard patterns, kept against the list itself, as
 * `compiledDomainLists` keeps a domain list's: checked against a copy of its entries on
 * every call, so a list the caller changes starts afresh.
 */
const originListPatternMaps = new WeakMap<
  readonly string[],
  {
    source: readonly string[];
    patterns: Map<string, ReturnType<typeof compileWildcardPattern>>;
  }
>();

function originListPatterns(
  allowedOrigins: readonly string[],
): Map<string, ReturnType<typeof compileWildcardPattern>> {
  const kept = originListPatternMaps.get(allowedOrigins);
  if (kept !== undefined && isSameList(kept.source, allowedOrigins)) {
    return kept.patterns;
  }

  const patterns = new Map<string, ReturnType<typeof compileWildcardPattern>>();
  originListPatternMaps.set(allowedOrigins, {
    source: allowedOrigins.slice(),
    patterns,
  });

  return patterns;
}

/** Whether `list` still holds exactly the entries of `source`, in order. */
function isSameList(
  source: readonly string[],
  list: readonly string[],
): boolean {
  if (source.length !== list.length) {
    return false;
  }

  // Every index, holes included: `every` skips a hole, so with it a hole the caller
  // filled in would read as unchanged, and the new entry would never be checked.
  // eslint-disable-next-line unicorn/no-for-loop -- an indexed loop is the point
  for (let index = 0; index < source.length; index++) {
    if (source[index] !== list[index]) {
      return false;
    }
  }

  return true;
}

/**
 * Check if a domain matches any pattern in a list
 * Supports exact matches, wildcards, and normalization
 *
 * Validation:
 * - Origin-style patterns (e.g., "https://*.example.com") are NOT allowed in domain lists.
 *   If any entry contains "://", an error will be thrown to surface misconfiguration early.
 * - Empty or whitespace-only entries are ignored.
 * Use `matchesOriginList` for origin-style patterns.
 */
export function matchesDomainList(
  domain: string,
  allowedDomains: string[],
): boolean {
  const normalizedDomain = normalizeDomain(domain);

  // Early exit: invalid input cannot match any allowed domain. Nor can `"null"`, the
  // origin-only literal: as documented, it is never matched here - the global `*`
  // would otherwise match it as it matches any single-label name.
  if (normalizedDomain === '' || normalizedDomain === 'null') {
    return false;
  }

  // Asked once, for every wildcard entry, and only if one is reached.
  let isIP: boolean | undefined;

  const list = compiledDomainList(allowedDomains);

  for (let index = 0; index < list.cleaned.length; index++) {
    const entry = compiledDomainEntry(list, index);
    // Against the domain normalized once above, as `matchesWildcardDomain` would read it,
    // rather than normalized again for every wildcard entry.
    if (entry.kind === 'wildcard') {
      isIP ??= isIPAddress(normalizedDomain);
      if (
        entry.compiled !== undefined &&
        matchesCompiledWildcard(normalizedDomain, entry.compiled, isIP)
      ) {
        return true;
      }
      continue;
    }

    // The cheap comparison first: at most one entry can be equal, and only that one
    // needs the IP and public-suffix checks.
    if (
      normalizedDomain === entry.normalized &&
      isAllowedExactHostname(entry.normalized)
    ) {
      return true;
    }
  }

  return false;
}

function isAllowedExactHostname(normalizedHostname: string): boolean {
  if (!normalizedHostname) {
    return false;
  }

  // The literal string "null" is origin-only and must never match in domain context.
  // Guard explicitly rather than relying on PSL classification of unknown single-label TLDs.
  if (normalizedHostname === 'null') {
    return false;
  }

  if (
    isIPAddress(normalizedHostname) ||
    INTERNAL_PSEUDO_TLDS.has(normalizedHostname)
  ) {
    return true;
  }

  const publicSuffix = getPublicSuffix(normalizedHostname);
  return !(publicSuffix && publicSuffix === normalizedHostname);
}

/**
 * Validate a configuration entry for either domain or origin contexts.
 * Non-throwing: returns { valid, info? } where info can carry non-fatal hints.
 *
 * - Domain context: accepts exact domains and domain wildcard patterns.
 * - Origin context: accepts
 *   - exact origins,
 *   - protocol-only wildcards like "https://*",
 *   - protocol + domain wildcard like "https://*.example.com",
 *   - bare domains (treated like domain context).
 *
 * Common rules:
 * - Only full-label wildcards are allowed ("*" or "**"); partial label wildcards are invalid.
 * - All-wildcards domain patterns (e.g., "*.*") are invalid. The global "*" may be allowed
 *   in origin context when explicitly enabled via options.
 * - Wildcards cannot target IP tails.
 * - PSL tail guard also rejects pseudo-TLD suffix wildcards like `*.localhost`.
 */
export type WildcardKind = 'none' | 'global' | 'protocol' | 'subdomain';

export type ValidationResult = {
  valid: boolean;
  info?: string;
  wildcardKind: WildcardKind;
};

/** Why an entry edged with whitespace other than spaces, tabs, CRs and LFs is refused. */
const WHITESPACE_EDGE_INFO =
  'whitespace other than spaces, tabs, CRs and LFs at an end (it can never match)';

function isValidPortString(port: string): boolean {
  if (!/^\d+$/.test(port)) {
    return false;
  }

  const portNumber = Number(port);
  return Number.isInteger(portNumber) && portNumber >= 0 && portNumber <= 65535;
}

export function validateConfigEntry(
  entry: string,
  context: 'domain' | 'origin',
  options?: { allowGlobalWildcard?: boolean; allowProtocolWildcard?: boolean },
): ValidationResult {
  const SCHEME_RE = /^[a-z][a-z0-9+\-.]*$/i;
  // Trimmed of HTTP whitespace, as the matchers trim it; see `readTrimmedEntry`.
  const raw = readTrimmedEntry(entry ?? '');
  if (raw === undefined) {
    return {
      valid: false,
      info: WHITESPACE_EDGE_INFO,
      wildcardKind: 'none',
    };
  }
  if (!raw) {
    return { valid: false, info: 'empty entry', wildcardKind: 'none' };
  }

  // Normalize options with secure defaults
  const opts = {
    allowGlobalWildcard: false,
    allowProtocolWildcard: true,
    ...(options ?? {}),
  } as Required<NonNullable<typeof options>> & {
    allowGlobalWildcard: boolean;
    allowProtocolWildcard: boolean;
  };

  // Helper: validate non-wildcard labels (punycode + DNS limits)
  function validateConcreteLabels(pattern: string): boolean {
    if (isHostTooLongToNormalize(pattern)) {
      return false;
    }

    const labels = pattern.split('.');
    const concrete: string[] = [];

    for (const lbl of labels) {
      if (lbl === '*' || lbl === '**') {
        continue;
      }

      const nd = normalizeDomainName(lbl);

      if (nd === '') {
        return false;
      }

      concrete.push(nd);
    }

    if (concrete.length > 0) {
      if (!checkDNSLength(concrete.join('.'))) {
        return false;
      }
    }

    return true;
  }

  // Helper: PSL tail guard and IP-tail rejection for wildcard patterns
  function wildcardTailIsInvalid(normalized: string): boolean {
    // The matcher's own tail rule, so the two cannot disagree.
    return isUnmatchableWildcardTail(
      extractFixedTailAfterLastWildcard(normalized.split('.')).fixedTail,
    );
  }

  // Helper: domain-wildcard structural checks (no URL chars, full labels, etc.)
  function validateDomainWildcard(pattern: string): ValidationResult {
    // A host after `scheme://` has not been trimmed yet: held to the same rule.
    if (hasNonHTTPWhitespaceEdge(pattern)) {
      return {
        valid: false,
        info: WHITESPACE_EDGE_INFO,
        wildcardKind: 'none',
      };
    }

    // Normalize Unicode dots and trim
    const trimmed = trimHTTPWhitespace(pattern).replace(/[．。｡]/g, '.'); // normalize Unicode dot variants to ASCII

    if (INVALID_DOMAIN_CHARS.test(trimmed)) {
      return {
        valid: false,
        info: 'invalid characters in domain pattern',
        wildcardKind: 'none',
      };
    }

    if (hasPartialLabelWildcard(trimmed)) {
      return {
        valid: false,
        info: 'partial-label wildcards are not allowed',
        wildcardKind: 'none',
      };
    }

    const normalized = normalizeWildcardPattern(trimmed);

    if (!normalized) {
      return {
        valid: false,
        info: 'invalid domain labels',
        wildcardKind: 'none',
      };
    }

    if (normalized.split('.').length > MAX_LABELS) {
      return {
        valid: false,
        info: 'wildcard pattern exceeds label limit',
        wildcardKind: 'none',
      };
    }

    if (isAllWildcards(normalized)) {
      return {
        valid: false,
        info: 'all-wildcards pattern is not allowed',
        wildcardKind: 'none',
      };
    }

    if (!validateConcreteLabels(normalized)) {
      return {
        valid: false,
        info: 'invalid domain labels',
        wildcardKind: 'none',
      };
    }

    if (wildcardTailIsInvalid(normalized)) {
      return {
        valid: false,
        info: 'wildcard tail targets public suffix or IP (disallowed)',
        wildcardKind: 'none',
      };
    }

    return { valid: true, wildcardKind: 'subdomain' };
  }

  // Helper: exact domain check (no protocols). Reject apex public suffixes.
  function validateExactDomain(s: string): ValidationResult {
    // The literal string "null" is origin-only; reject it explicitly
    // rather than relying on PSL classification of unknown single-label TLDs.
    if (asciiLowercase(s) === 'null') {
      return {
        valid: false,
        info: '"null" is not a valid domain entry',
        wildcardKind: 'none',
      };
    }

    // Check if it's an IP address first - if so, allow it (consistent with matchesDomainList)
    // Normalize Unicode dots for consistent IP detection
    const sDots = toAsciiDots(s);
    const ipv4 = readIPv4Entry(sDots);

    if (ipv4 !== undefined) {
      return ipv4.address === undefined
        ? { valid: false, info: ipv4.info, wildcardKind: 'none' }
        : { valid: true, info: ipv4.info, wildcardKind: 'none' };
    }

    // IPv6 is not flagged: its other spellings (`2001:DB8:0:0::1`) are the same address.
    if (isIPAddress(sDots)) {
      return { valid: true, wildcardKind: 'none' };
    }

    // For non-IP addresses, reject URL-like characters
    if (INVALID_DOMAIN_CHARS.test(s)) {
      return {
        valid: false,
        info: 'invalid characters in domain',
        wildcardKind: 'none',
      };
    }

    const nd = normalizeDomain(s);

    if (nd === '') {
      return { valid: false, info: 'invalid domain', wildcardKind: 'none' };
    }

    const ps = getPublicSuffix(nd);

    if (ps && ps === nd && !INTERNAL_PSEUDO_TLDS.has(nd)) {
      return {
        valid: false,
        info: 'entry equals a public suffix (not registrable)',
        wildcardKind: 'none',
      };
    }
    return { valid: true, wildcardKind: 'none' };
  }

  // Domain context path
  if (context === 'domain') {
    // Reject any origin-style entries (with protocols) upfront
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(raw)) {
      return {
        valid: false,
        info: 'protocols are not allowed in domain context',
        wildcardKind: 'none',
      };
    }

    // Special-case: global wildcard in domain context (config-time validation)
    if (raw === '*') {
      return opts.allowGlobalWildcard
        ? { valid: true, wildcardKind: 'global' }
        : {
            valid: false,
            info: "global wildcard '*' not allowed in this context",
            wildcardKind: 'none',
          };
    }

    if (raw.includes('*')) {
      return validateDomainWildcard(raw);
    }
    return validateExactDomain(raw);
  }

  // Origin context
  // Special-case: literal "null" origin is allowed by exact inclusion
  if (raw === 'null') {
    return { valid: true, wildcardKind: 'none' };
  }

  // Special-case: global wildcard in origin context (config-time validation)
  if (raw === '*') {
    return opts.allowGlobalWildcard
      ? { valid: true, wildcardKind: 'global' }
      : {
          valid: false,
          info: "global wildcard '*' not allowed in this context",
          wildcardKind: 'none',
        };
  }

  const schemeIdx = raw.indexOf('://');
  if (schemeIdx === -1) {
    // Bare domain/or domain pattern allowed in origin lists; reuse domain rules
    if (raw.includes('*')) {
      return validateDomainWildcard(raw);
    }
    return validateExactDomain(raw);
  }

  const scheme = asciiLowercase(raw.slice(0, schemeIdx));
  const rest = raw.slice(schemeIdx + 3);

  if (!SCHEME_RE.test(scheme)) {
    return {
      valid: false,
      info: 'invalid scheme in origin',
      wildcardKind: 'none',
    };
  }

  let normalizedRest = rest;

  // Disallow query/fragment in origin entries. Allow a single trailing slash
  // for exact origins so copied values like "https://example.com/" validate
  // the same way the runtime matchers normalize them.
  if (normalizedRest.includes('#') || normalizedRest.includes('?')) {
    return {
      valid: false,
      info: 'origin must not contain path, query, or fragment',
      wildcardKind: 'none',
    };
  }

  const slashIdx = normalizedRest.indexOf('/');
  if (slashIdx !== -1) {
    const authority = normalizedRest.slice(0, slashIdx);
    const suffix = normalizedRest.slice(slashIdx);

    if (suffix !== '/' || authority.includes('*')) {
      return {
        valid: false,
        info: 'origin must not contain path, query, or fragment',
        wildcardKind: 'none',
      };
    }

    normalizedRest = authority;
  }

  if (!normalizedRest) {
    return {
      valid: false,
      info: 'missing host in origin',
      wildcardKind: 'none',
    };
  }

  // Reject userinfo in origin entries for security and clarity
  if (normalizedRest.includes('@')) {
    return {
      valid: false,
      info: 'origin must not include userinfo',
      wildcardKind: 'none',
    };
  }

  // Protocol-only wildcard: scheme://*
  if (normalizedRest === '*') {
    if (scheme !== 'http' && scheme !== 'https') {
      return {
        valid: false,
        info: 'wildcard origins require http or https scheme',
        wildcardKind: 'none',
      };
    }

    if (!opts.allowProtocolWildcard) {
      return {
        valid: false,
        info: 'protocol wildcard not allowed',
        wildcardKind: 'none',
      };
    }

    const info =
      scheme === 'http' || scheme === 'https'
        ? undefined
        : 'non-http(s) scheme; CORS may not match';
    return { valid: true, info, wildcardKind: 'protocol' };
  }

  // Extract host (and optional port) while respecting IPv6 brackets
  let host = normalizedRest;
  let hasPort = false;

  if (normalizedRest.startsWith('[')) {
    const end = normalizedRest.indexOf(']');
    if (end === -1) {
      return {
        valid: false,
        info: 'unclosed IPv6 bracket',
        wildcardKind: 'none',
      };
    }
    host = normalizedRest.slice(0, end + 1);
    const after = normalizedRest.slice(end + 1);
    if (after.startsWith(':')) {
      const port = after.slice(1);

      if (!isValidPortString(port)) {
        return {
          valid: false,
          info: 'invalid port in origin',
          wildcardKind: 'none',
        };
      }

      // port present -> allowed for exact origins, but reject with wildcard hosts below
      // leave host as bracketed literal
      hasPort = true;
    } else if (after.length > 0) {
      return {
        valid: false,
        info: 'unexpected characters after IPv6 host',
        wildcardKind: 'none',
      };
    }
  } else {
    // strip port if present
    const colon = normalizedRest.indexOf(':');
    if (colon !== -1) {
      host = normalizedRest.slice(0, colon);
      const port = normalizedRest.slice(colon + 1);

      if (!isValidPortString(port)) {
        return {
          valid: false,
          info: 'invalid port in origin',
          wildcardKind: 'none',
        };
      }

      // optional port part is fine for exact origins
      hasPort = true;
    }
  }

  // If wildcard present in origin authority, treat as protocol+domain wildcard
  if (host.includes('*')) {
    if (scheme !== 'http' && scheme !== 'https') {
      return {
        valid: false,
        info: 'wildcard origins require http or https scheme',
        wildcardKind: 'none',
      };
    }

    // Forbid ports/brackets with wildcard hosts
    if (host.includes('[') || host.includes(']')) {
      return {
        valid: false,
        info: 'wildcard host cannot be an IP literal',
        wildcardKind: 'none',
      };
    }

    if (hasPort) {
      return {
        valid: false,
        info: 'ports are not allowed in wildcard origins',
        wildcardKind: 'none',
      };
    }

    // Validate as domain wildcard
    const verdict = validateDomainWildcard(host);
    if (!verdict.valid) {
      return verdict;
    }

    const info =
      scheme === 'http' || scheme === 'https'
        ? undefined
        : 'non-http(s) scheme; CORS may not match';
    return { valid: true, info, wildcardKind: 'subdomain' };
  }

  // Exact origin: allow any scheme; validate host as domain or IP. Every acceptance
  // below is held to what the matcher can match - see `exactOriginVerdict`. The entry is
  // normalized once, for that and for the opaque-host check below.
  let normalizedEntry: string | undefined;
  const readNormalizedEntry = (): string =>
    (normalizedEntry ??= normalizeOrigin(raw));
  const exactOriginVerdict = (result: ValidationResult): ValidationResult =>
    result.valid && readNormalizedEntry() === ''
      ? {
          valid: false,
          info: 'origin is not one the URL parser reads as written (it can never match)',
          wildcardKind: 'none',
        }
      : result;

  if (host.startsWith('[')) {
    const bracketContent = host.slice(1, -1);

    if (!isIPv6(bracketContent)) {
      return {
        valid: false,
        info: 'invalid IPv6 literal in origin',
        wildcardKind: 'none',
      };
    }

    const info =
      scheme === 'http' || scheme === 'https'
        ? undefined
        : 'non-http(s) scheme; CORS may not match';

    return exactOriginVerdict({ valid: true, info, wildcardKind: 'none' });
  }

  const hostDots = toAsciiDots(host);
  // A non-special scheme's host is opaque to the URL parser, never an address.
  const isOpaqueHost = !isSpecialScheme(`${asciiLowercase(scheme)}:`);

  // An opaque host is percent-encoded by the URL parser where it is not ASCII - Unicode
  // dots included, which are not folded for it - and a matched origin is read through
  // `normalizeOrigin`, which refuses that: say so here, ahead of every branch below,
  // rather than accept `foo://bücher.example` or `foo://1。2。3。4` and never match it.
  // Read without the entry's port or trailing slash - the entry itself when it has
  // neither, normalized once for this and `exactOriginVerdict`.
  const hostOrigin = `${scheme}://${host}`;
  if (
    isOpaqueHost &&
    (hostOrigin === raw
      ? readNormalizedEntry()
      : normalizeOrigin(hostOrigin)) === ''
  ) {
    return {
      valid: false,
      info: 'origin host is not one a non-special scheme can match (use ASCII)',
      wildcardKind: 'none',
    };
  }

  const hostIPv4 = isOpaqueHost ? undefined : readIPv4Entry(hostDots);
  if (hostIPv4 !== undefined || isIPAddress(hostDots)) {
    if (hostIPv4 !== undefined && hostIPv4.address === undefined) {
      return { valid: false, info: hostIPv4.info, wildcardKind: 'none' };
    }

    const schemeInfo =
      scheme === 'http' || scheme === 'https'
        ? undefined
        : 'non-http(s) scheme; CORS may not match';
    const notes = [hostIPv4?.info, schemeInfo].filter(
      (note): note is string => note !== undefined,
    );
    return exactOriginVerdict({
      valid: true,
      info: notes.length > 0 ? notes.join('; ') : undefined,
      wildcardKind: 'none',
    });
  }

  // Domain host
  const nd = isOpaqueHost ? normalizeDomainName(host) : normalizeDomain(host);

  if (nd === '') {
    return {
      valid: false,
      info: 'invalid domain in origin',
      wildcardKind: 'none',
    };
  }
  // Not for an opaque host, which is no DNS name: tldts reads every unknown single label
  // (`chrome-extension://<id>`, `app://myapp`) as a suffix of its own.
  const ps = isOpaqueHost ? null : getPublicSuffix(nd);
  if (ps && ps === nd && !INTERNAL_PSEUDO_TLDS.has(nd)) {
    return {
      valid: false,
      info: 'origin host equals a public suffix (not registrable)',
      wildcardKind: 'none',
    };
  }
  const info =
    scheme === 'http' || scheme === 'https'
      ? undefined
      : 'non-http(s) scheme; CORS may not match';
  return exactOriginVerdict({ valid: true, info, wildcardKind: 'none' });
}

/**
 * Parse an exact origin for list matching.
 * Rejects userinfo, non-empty paths, queries, and fragments so malformed inputs
 * are not silently normalized into broader origins.
 */
function parseExactOriginForMatching(entry: string): {
  normalizedOrigin: string;
  normalizedHostname: string;
  /** A non-special scheme's host, which the public suffix list says nothing about. */
  isOpaqueHost: boolean;
} | null {
  if (entry === 'null') {
    return {
      normalizedOrigin: 'null',
      normalizedHostname: '',
      isOpaqueHost: false,
    };
  }

  const entryText = toOriginText(entry);
  if (entryText === undefined) {
    return null;
  }

  const normalized = foldOriginDots(entryText);
  const schemeIdx = normalized.indexOf('://');

  if (schemeIdx !== -1) {
    const authority = extractAuthority(normalized, schemeIdx);
    const at = authority.lastIndexOf('@');
    const hostPort = at === -1 ? authority : authority.slice(at + 1);

    if (hostPort.endsWith(':')) {
      return null;
    }
  }

  const url = safeParseURL(normalized);
  if (!url) {
    return null;
  }

  if (url.username || url.password) {
    return null;
  }

  if (url.pathname && url.pathname !== '/') {
    return null;
  }

  if (url.search || url.hash) {
    return null;
  }

  const normalizedOrigin = normalizeOrigin(entry);
  if (normalizedOrigin === '') {
    return null;
  }

  return {
    normalizedOrigin,
    // Read as `normalizeOrigin` reads it.
    normalizedHostname: normalizeOriginHostname(
      asciiLowercase(url.protocol),
      url.hostname,
    ),
    isOpaqueHost:
      !isSpecialScheme(asciiLowercase(url.protocol)) &&
      !url.hostname.startsWith('['),
  };
}

/**
 * Whether an origin's text carries `@`, `?` or `#` after its scheme: userinfo, a query or
 * a fragment - even an empty one, which the URL parser reports as `''` and so would slip
 * past the field checks, where `validateConfigEntry` refuses the same text. No host
 * holds any of the three.
 */
function hasOriginExtras(text: string): boolean {
  const schemeEnd = text.indexOf('://');

  return /[@?#]/.test(schemeEnd === -1 ? text : text.slice(schemeEnd + 3));
}

function isCredentialsSafeWildcardOriginPattern(pattern: string): boolean {
  // Already trimmed by the list; held to its rule here too (see `readTrimmedEntry`).
  const trimmed = trimHTTPWhitespace(pattern).replace(/[．。｡]/g, '.');

  function isValidCredentialWildcardHost(written: string): boolean {
    // One trailing dot dropped, as the other matchers drop it: its empty last label
    // would refuse `https://*.example.com.`, which `validateConfigEntry` and
    // `matchesOriginList` both accept.
    // Leading and trailing whitespace dropped, as the other matchers drop it: `https://
    // *.example.com` is valid to `validateConfigEntry` and matches in `matchesOriginList`.
    // Of HTTP whitespace only; any other whitespace left is refused below.
    const host = trimHTTPWhitespace(written);

    if (isHostTooLongToNormalize(host)) {
      return false;
    }
    const hostPattern = host.endsWith('.') ? host.slice(0, -1) : host;

    if (isAllWildcards(hostPattern)) {
      return false;
    }

    if (INVALID_DOMAIN_CHARS.test(hostPattern)) {
      return false;
    }

    if (hasPartialLabelWildcard(hostPattern)) {
      return false;
    }

    const labels = hostPattern.split('.');
    const concrete: string[] = [];

    for (const lbl of labels) {
      if (lbl === '*' || lbl === '**') {
        continue;
      }

      const nd = normalizeDomainName(lbl);
      if (nd === '') {
        return false;
      }

      concrete.push(nd);
    }

    if (concrete.length > 0 && !checkDNSLength(concrete.join('.'))) {
      return false;
    }

    const normalized = normalizeWildcardPattern(hostPattern);
    if (!normalized) {
      return false;
    }

    // The matcher's own tail rule, so the two cannot disagree.
    return !isUnmatchableWildcardTail(
      extractFixedTailAfterLastWildcard(normalized.split('.')).fixedTail,
    );
  }

  if (!trimmed.includes('*')) {
    return false;
  }

  const schemeIdx = trimmed.indexOf('://');
  if (schemeIdx === -1) {
    return isValidCredentialWildcardHost(trimmed);
  }

  const scheme = asciiLowercase(trimmed.slice(0, schemeIdx));
  const host = trimmed.slice(schemeIdx + 3);

  if ((scheme !== 'http' && scheme !== 'https') || host === '*') {
    return false;
  }

  return isValidCredentialWildcardHost(host);
}

/**
 * Helper function to check origin list with wildcard support.
 * Supports exact matches, wildcard matches, and normalization.
 *
 * Exact origins may use non-HTTP(S) schemes and are compared exactly.
 * Wildcard matching remains HTTP(S)-only.
 * Blank allowlist entries are ignored after trimming.
 * Special case: single "*" matches any valid HTTP(S) origin.
 *
 * @param origin - The origin to check (undefined for requests without Origin header)
 * @param allowedOrigins - Array of allowed origin patterns
 * @param opts - Options for handling edge cases
 * @param opts.treatNoOriginAsAllowed - If true, allows requests without Origin header
 * when "*" is in the allowed list
 */
export function matchesOriginList(
  origin: string | undefined,
  allowedOrigins: string[],
  opts: { treatNoOriginAsAllowed?: boolean } = {},
): boolean {
  const cleaned = allowedOrigins
    .map((s) => readTrimmedEntry(s) ?? '')
    .filter(Boolean);

  if (!origin) {
    // Only allow requests without Origin header if explicitly opted in AND "*" is in the list
    return !!opts.treatNoOriginAsAllowed && cleaned.includes('*');
  }

  const parsedOrigin = parseExactOriginForMatching(origin);
  if (!parsedOrigin) {
    return false;
  }

  // The list's own compiled patterns: two lists that each fit the shared cache, used
  // in turn, would evict each other there on every call (see `originListPatterns`).
  const matchesWildcard = wildcardOriginMatcher(
    origin,
    originListPatterns(allowedOrigins),
  );

  return cleaned.some((allowed) => {
    // A wildcard - the global `*` included - is matched against the origin as the
    // wildcard matcher reads it, parsed once for the whole list.
    if (allowed.includes('*')) {
      return matchesWildcard(allowed);
    }

    if (allowed === 'null') {
      return parsedOrigin.normalizedOrigin === 'null';
    }

    if (!allowed.includes('://')) {
      const normalizedAllowedDomain = normalizeDomain(allowed);

      return (
        isAllowedExactHostname(normalizedAllowedDomain) &&
        parsedOrigin.normalizedHostname !== '' &&
        parsedOrigin.normalizedHostname === normalizedAllowedDomain
      );
    }

    const parsedAllowed = parseExactOriginForMatching(allowed);
    if (!parsedAllowed) {
      return false;
    }

    // Not for an opaque host: the public suffix list is about DNS names, and it reads
    // every unknown single label as a suffix, which would refuse every extension origin
    // (`chrome-extension://<id>`).
    if (
      !parsedAllowed.isOpaqueHost &&
      !isAllowedExactHostname(parsedAllowed.normalizedHostname)
    ) {
      return false;
    }

    return parsedOrigin.normalizedOrigin === parsedAllowed.normalizedOrigin;
  });
}

/**
 * Helper function to check if origin matches any pattern in a list (credentials-safe).
 *
 * Exact origins may use non-HTTP(S) schemes and are compared exactly.
 * When `allowWildcardSubdomains` is enabled, only host subdomain wildcard
 * patterns are honored. Global "*" and protocol-only wildcards such as
 * "https://*" are intentionally not honored in credentials mode.
 * Blank allowlist entries are ignored after trimming.
 */
export function matchesCORSCredentialsList(
  origin: string | undefined,
  allowedOrigins: string[],
  options: { allowWildcardSubdomains?: boolean } = {},
): boolean {
  if (!origin) {
    return false;
  }

  const parsedOrigin = parseExactOriginForMatching(origin);
  if (!parsedOrigin) {
    return false;
  }

  const cleaned = allowedOrigins
    .map((s) => readTrimmedEntry(s) ?? '')
    .filter(Boolean);

  const allowWildcard = !!options.allowWildcardSubdomains;
  // The list's own compiled patterns (see `originListPatterns`).
  const matchesWildcard = wildcardOriginMatcher(
    origin,
    originListPatterns(allowedOrigins),
  );

  for (const allowed of cleaned) {
    // Optional wildcard support for credentials lists (subdomain patterns only)
    if (allowWildcard && allowed.includes('*')) {
      if (
        isCredentialsSafeWildcardOriginPattern(allowed) &&
        matchesWildcard(allowed)
      ) {
        return true;
      }
      continue;
    }

    if (allowed === 'null') {
      if (parsedOrigin.normalizedOrigin === 'null') {
        return true;
      }

      continue;
    }

    if (!allowed.includes('://')) {
      const normalizedAllowedDomain = normalizeDomain(allowed);

      if (
        isAllowedExactHostname(normalizedAllowedDomain) &&
        parsedOrigin.normalizedHostname !== '' &&
        parsedOrigin.normalizedHostname === normalizedAllowedDomain
      ) {
        return true;
      }

      continue;
    }

    const parsedAllowed = parseExactOriginForMatching(allowed);
    if (!parsedAllowed) {
      continue;
    }

    // As in `matchesOriginList`: no public-suffix rule for an opaque host.
    if (
      !parsedAllowed.isOpaqueHost &&
      !isAllowedExactHostname(parsedAllowed.normalizedHostname)
    ) {
      continue;
    }

    if (parsedOrigin.normalizedOrigin === parsedAllowed.normalizedOrigin) {
      return true;
    }
  }

  return false;
}

/**
 * Result of parsing a Host header
 */
export interface ParsedHost {
  /** Domain/hostname with brackets stripped (e.g., "[::1]" → "::1") */
  domain: string;
  /** Port number as string, or empty string if no port specified */
  port: string;
}

/**
 * Parse Host header into domain and port components
 * Supports IPv6 brackets and handles port extraction with strict validation
 *
 * This function is commonly used to parse the HTTP Host header,
 * which may contain:
 * - Regular hostnames: "example.com" or "example.com:8080"
 * - IPv6 addresses: "[::1]" or "[::1]:8080"
 * - IPv4 addresses: "127.0.0.1" or "127.0.0.1:8080"
 *
 * The returned domain has brackets stripped for normalization
 * (e.g., "[::1]" → "::1"), while port is returned separately.
 *
 * **Strict validation:** For bracketed IPv6 addresses, after the closing bracket `]`,
 * only the following are valid:
 * - Nothing (end of string): `[::1]` → valid
 * - Port with colon: `[::1]:8080` → valid
 * - Any other characters: `[::1]garbage`, `[::1][::2]` → returns empty (malformed)
 *
 * @param host - Host header value (hostname[:port] or [ipv6][:port])
 * @returns Object with domain (without brackets) and port (empty string if no port).
 *          Returns `{ domain: '', port: '' }` for malformed input.
 *
 * @example
 * parseHostHeader('example.com:8080')
 * // => { domain: 'example.com', port: '8080' }
 *
 * parseHostHeader('[::1]:8080')
 * // => { domain: '::1', port: '8080' }
 *
 * parseHostHeader('[2001:db8::1]')
 * // => { domain: '2001:db8::1', port: '' }
 *
 * parseHostHeader('localhost')
 * // => { domain: 'localhost', port: '' }
 *
 * parseHostHeader('[::1][::2]') // malformed
 * // => { domain: '', port: '' }
 */
export function parseHostHeader(host: string): ParsedHost {
  // Of HTTP whitespace only: a value with other whitespace at an end (a no-break space)
  // is malformed, as the URL parser refuses such a host.
  const trimmedHost = readTrimmedEntry(host);

  if (!trimmedHost) {
    return { domain: '', port: '' };
  }

  function parsePortOrFail(port: string): ParsedHost | null {
    if (!isValidPortString(port)) {
      return { domain: '', port: '' };
    }

    return null;
  }

  // Handle IPv6 brackets
  if (trimmedHost.startsWith('[')) {
    const end = trimmedHost.indexOf(']');

    if (end !== -1) {
      const domain = trimmedHost.slice(1, end); // Remove brackets for normalization
      const rest = trimmedHost.slice(end + 1);

      if (!isIPv6(domain)) {
        return { domain: '', port: '' };
      }

      // Strict validation: after closing bracket, only allow empty or :port
      if (rest === '') {
        return { domain, port: '' };
      }

      if (rest.startsWith(':')) {
        const invalid = parsePortOrFail(rest.slice(1));
        if (invalid) {
          return invalid;
        }

        return { domain, port: rest.slice(1) };
      }

      // Malformed: has junk after closing bracket (e.g., "[::1]garbage" or "[::1][::2]")
      return { domain: '', port: '' };
    }

    // Malformed bracket - missing closing bracket
    return { domain: '', port: '' };
  }

  // Regular hostname:port parsing
  const idx = trimmedHost.indexOf(':');

  if (idx === -1) {
    return { domain: trimmedHost, port: '' };
  }

  if (idx === 0) {
    return { domain: '', port: '' };
  }

  const invalid = parsePortOrFail(trimmedHost.slice(idx + 1));
  if (invalid) {
    return invalid;
  }

  return {
    domain: trimmedHost.slice(0, idx),
    port: trimmedHost.slice(idx + 1),
  };
}

/**
 * Helper function to check if domain is apex (no subdomain)
 * Uses tldts to properly handle multi-part TLDs like .co.uk
 */
export function isApexDomain(domain: string): boolean {
  const normalizedDomain = normalizeDomain(domain);

  if (!normalizedDomain || isIPAddress(normalizedDomain)) {
    return false;
  }

  // Handle pseudo-TLD domains before tldts, which doesn't know about them.
  const labels = normalizedDomain.split('.');
  const lastLabel = labels[labels.length - 1];
  if (INTERNAL_PSEUDO_TLDS.has(lastLabel)) {
    if (normalizedDomain === lastLabel) {
      return true; // bare pseudo-TLD hostname (e.g. localhost, local) → apex
    }
    if (lastLabel === 'localhost') {
      return false; // localhost is a hostname, not a TLD; sub.localhost is not apex
    }
    return labels.length === 2; // foo.local → apex; bar.foo.local → not
  }

  // Use tldts to properly detect apex domains vs subdomains
  // This correctly handles multi-part TLDs like .co.uk, .com.au, etc.
  const parsedDomain = getDomain(normalizedDomain);
  const subdomain = getSubdomain(normalizedDomain);

  // Guard against null returns from tldts for invalid hosts
  if (!parsedDomain) {
    return false;
  }

  // Domain is apex if it matches the parsed domain and has no subdomain
  return parsedDomain === normalizedDomain && !subdomain;
}

/**
 * How the URL parser reads a host entry it takes for an IPv4 address, or `undefined` for
 * one it does not (a name, or IPv6).
 *
 * WHATWG reads any host whose last label is a number - decimal, or `0x` hex - as IPv4,
 * and a host matched against an entry is read that way too, so the entry means whatever
 * the parser makes of it: `192.168.001.010` is the octal `192.168.1.8`, `10.1` is
 * `10.0.0.1` and `0x7f.1` is `127.0.0.1`. Such an entry is accepted with an `info` naming
 * the address it is read as, so a typo is visible rather than silently matching another
 * address. One the parser refuses (`192.168.1.08` - an octal octet with an 8 in it) can
 * never be a URL's host and comes back with no `address`: it is invalid.
 */
function readIPv4Entry(
  rawHost: string,
): { address?: string; info?: string } | undefined {
  const ipv4 = readURLParserIPv4(rawHost);

  if (ipv4 === undefined) {
    return undefined;
  }

  if (ipv4.address === undefined) {
    return { info: 'IP address is not one the URL parser accepts' };
  }

  // Against what was written - but for a trailing dot, which the domain path does not
  // remark on either - so an entry that differs only by its spelling says so.
  const written = asciiLowercase(rawHost.replace(/\.$/, ''));

  return ipv4.address === written
    ? { address: ipv4.address }
    : { address: ipv4.address, info: `IP address is read as ${ipv4.address}` };
}

export {
  normalizeDomain,
  isIPAddress,
  isIPv4,
  isIPv6,
  checkDNSLength,
  canonicalizeBracketedIPv6Content,
} from './helpers';

export { getDomain, getSubdomain } from 'tldts';
