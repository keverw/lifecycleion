import { getDomain, getSubdomain, getPublicSuffix } from 'tldts';
import { getOrCompute } from '../internal/bounded-cache';
import {
  isAllWildcards,
  isHostTooLongToNormalize,
  hasPartialLabelWildcard,
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
  lazyWildcardHostSuffix,
  isUnmatchableWildcardTail,
  readWildcardTailRefusal,
  INTERNAL_PSEUDO_TLDS,
  INVALID_DOMAIN_CHARS,
  MAX_LABELS,
  readTrimmedEntry,
  parseURL,
} from './helpers';
import { describeValue } from '../internal/describe-value';
import { isNullish } from '../internal/is-nullish';
import { copyArrayValue } from '../internal/array-copy';
import {
  checkedHostFor,
  endsInNumericLabel,
  isGlobalHostPattern,
  matchesReadHostPattern,
  readExactHostName,
  readHostPattern,
  type HostPattern,
} from './host-filter';
import {
  assertKnownFields,
  assertOptionsObject,
} from '../internal/known-fields';
import {
  asciiLowercase,
  hasNonHTTPWhitespaceEdge,
  trimHTTPWhitespace,
  trimWhere,
  withoutTrailingDot,
} from '../internal/ascii-text';

/**
 * Refuses a pattern that is not a string, naming `fn`: a config mistake, which read on
 * would fail with the engine's own error on every call.
 */
function assertPattern(pattern: unknown, fn: string): void {
  if (typeof pattern !== 'string') {
    throw new TypeError(
      `${fn}: pattern must be a string (got ${describeValue(pattern)})`,
    );
  }
}

/**
 * Refuses an allowlist that is not an array, naming `fn` and its `argument`: a
 * comma-separated string read from an environment variable would otherwise fail with the
 * engine's own error on every call. See {@link copyEntryList} for its entries.
 */
function assertEntryListIsArray(
  list: unknown,
  fn: string,
  argument: string,
): asserts list is unknown[] {
  if (!Array.isArray(list)) {
    throw new TypeError(
      `${fn}: ${argument} must be an array of strings (got ${describeValue(list)})`,
    );
  }
}

/**
 * An allowlist's entries, each read once into a copy the matcher reads from then on, with
 * one that is not a string refused as {@link assertEntryListIsArray} refuses the list: a
 * number in it would fail with the engine's own error. Copied by {@link copyArrayValue},
 * so nothing of the caller's array is consulted; a sparse list's holes stay holes, which
 * `some` and the matchers' `map` skip, rather than becoming `undefined` entries.
 */
function copyEntryList(list: unknown, fn: string, argument: string): string[] {
  assertEntryListIsArray(list, fn, argument);
  const copy = copyArrayValue(list, `${fn}: ${argument}`);

  if (copy.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(
      `${fn}: ${argument} must be an array of strings (an entry is not one)`,
    );
  }

  return copy as string[];
}

/**
 * Refuses a matcher's options that are not an object, or that hold a field it does not
 * take: a misspelled `allowProtocolWildcard` would leave protocol wildcards allowed, its
 * default. `null` is no options, as `undefined` is.
 */
function assertMatcherOptions(
  options: unknown,
  fields: readonly string[],
  label: string,
): void {
  assertOptionsObject(options, label, true);
  assertKnownFields(options, fields, label);
}

/**
 * A boolean option's value, `isDefault` for `null` or `undefined`. Anything else is refused:
 * read by truthiness, `allowGlobalWildcard: 'false'` would turn the wildcard on.
 */
function readBooleanOption(
  value: unknown,
  isDefault: boolean,
  label: string,
): boolean {
  if (isNullish(value)) {
    return isDefault;
  }

  if (typeof value !== 'boolean') {
    throw new TypeError(
      `${label} must be a boolean (got ${describeValue(value)})`,
    );
  }

  return value;
}

export function safeParseURL(input: string): URL | null {
  try {
    return parseURL(input);
  } catch {
    return null;
  }
}

/**
 * Whether a parsed origin's host is one `normalizeOrigin` reads, for the global and
 * protocol wildcards: not one with a hyphen at a label's edge (`-edge.example.com`),
 * which the URL parser accepts and no origin entry here can name.
 */
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
  // A value that is not a string is no origin - an `Origin` header that was never sent.
  if (typeof text !== 'string') {
    return undefined;
  }

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
 * Returns the canonical origin form with a normalized hostname (one trailing dot kept, as
 * browsers keep it: `https://example.com.` is another origin than `https://example.com`),
 * lowercase scheme, no trailing slash, and every special scheme's default port removed
 * (`:443` for `https` and `wss`, `:80` for `http` and `ws`, `:21` for `ftp`).
 */
export function normalizeOrigin(origin: string): string {
  // Preserve literal "null" origin exactly; treat all other invalids as empty sentinel
  if (origin === 'null') {
    return 'null';
  }

  const bare = readBareOrigin(origin);

  return bare === undefined ? '' : (canonicalOrigin(bare)?.origin ?? '');
}

/** An origin's text as the URL parser reads it, and the parse (see `readBareOrigin`). */
interface BareOrigin {
  /** Cleaned as the parser cleans it (see `toOriginText`), its host's dots folded. */
  text: string;
  url: URL;
}

/**
 * `origin` read as a bare origin - a scheme and an authority with nothing past the host
 * and port but one trailing `/` - or `undefined`. The one reading `normalizeOrigin`, the
 * wildcard matcher and the exact-origin matcher share, so they refuse the same text.
 */
function readBareOrigin(origin: string): BareOrigin | undefined {
  // Read as the parser reads its text; see `toOriginText`.
  const originText = toOriginText(origin);
  if (originText === undefined) {
    return undefined;
  }

  // Normalize Unicode dots before URL parsing for browser compatibility
  // Chrome allows URLs like https://127。0。0。1 - but only for a special scheme's host:
  // a non-special scheme's is opaque, and the parser percent-encodes those dots.
  const text = foldOriginDots(originText);

  // A percent-encoded host (`https://ex%61mple.com`) is refused, as `validateConfigEntry`
  // refuses it. See `hasPercentEncodedHost`. So is an empty port, userinfo, query or
  // fragment.
  if (
    hasDanglingPortInAuthority(text) ||
    hasPercentEncodedHost(text) ||
    hasOriginExtras(text)
  ) {
    return undefined;
  }

  const url = safeParseURL(text);

  // Only bare origins. A single trailing slash is allowed so callers can pass values like
  // "https://example.com/" without broadening real paths.
  if (
    !url ||
    url.username ||
    url.password ||
    (url.pathname && url.pathname !== '/') ||
    url.search ||
    url.hash
  ) {
    return undefined;
  }

  return { text, url };
}

/**
 * A bare origin's canonical form, with its hostname normalized as `normalizeOrigin`
 * compares it, or `undefined` when the hostname does not normalize (a pathological IDN,
 * an edge-hyphen label): such an origin is invalid, rather than a value like "https://"
 * with an empty host.
 */
function canonicalOrigin({
  text,
  url,
}: BareOrigin): { origin: string; hostname: string } | undefined {
  // Normalize hostname with punycode, as the URL parser read it. See
  // `normalizeOriginHostname`.
  const protocolLower = asciiLowercase(url.protocol);
  const normalizedHostname = normalizeOriginHostname(
    protocolLower,
    url.hostname,
  );

  if (normalizedHostname === '') {
    return undefined;
  }

  // Preserve brackets for IPv6 hosts; avoid double-bracketing if already present
  let host: string;
  // Extract the raw bracketed host (if present) from the authority portion only
  // to prevent matching brackets in path/query/fragment portions of full URLs.
  const schemeSep = text.indexOf('://');
  const authority = extractAuthority(text, schemeSep);
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

  // A host's trailing dot is part of the origin, as browsers read it: `https://example.com.`
  // is another origin than `https://example.com`. `normalizeDomain` drops it, so it is put
  // back; `normalizeDomain` has already refused a repeated one, and the URL parser drops
  // an IPv4 address's.
  const trailingDot =
    host === normalizedHostname &&
    url.hostname.endsWith('.') &&
    !normalizedHostname.endsWith('.')
      ? '.'
      : '';

  // An empty `url.port` is the scheme's default: the parser drops every special
  // scheme's (`wss://x.com:443` reads as `wss://x.com`), so it stays off.
  const port = url.port ? `:${url.port}` : '';

  // Explicitly use lowercase protocol for consistency
  return {
    origin: `${protocolLower}//${host}${trailingDot}${port}`,
    hostname: `${normalizedHostname}${trailingDot}`,
  };
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
  assertPattern(pattern, 'matchesWildcardDomain');
  return matchesWildcardDomainIn(domain, pattern, true);
}

/**
 * {@link matchesWildcardDomain}, its pattern compiled through the shared cache when
 * `isCached` - false for a pattern from a list longer than the cache, which scanned in
 * order would evict, entry by entry, the one the next scan needs first (see
 * `MAX_SHARED_CACHE_ENTRIES`).
 */
function matchesWildcardDomainIn(
  domain: string,
  pattern: string,
  isCached: PatternCache,
): boolean {
  return matchesNormalizedWildcardIn(
    normalizeDomain(domain),
    pattern,
    isCached,
  );
}

/**
 * {@link matchesWildcardDomainIn} for a host already normalized by `normalizeDomain`,
 * with what the caller already knows of it (see `matchesCompiledWildcard`).
 */
function matchesNormalizedWildcardIn(
  normalizedDomain: string,
  pattern: string,
  isCached: PatternCache,
  isIP?: boolean,
  readSuffix?: () => string | null,
): boolean {
  if (normalizedDomain === '') {
    return false; // invalid domain cannot match
  }

  // From the shared cache: uncached, a fixed allowlist checked on every request would
  // compile each pattern - IDNA per label, a Public Suffix List lookup - every time.
  const compiled = compiledWildcardPattern(pattern, isCached);

  return (
    compiled !== undefined &&
    matchesCompiledWildcard(normalizedDomain, compiled, isIP, readSuffix)
  );
}

/**
 * Smart origin wildcard matching for CORS with URL parsing
 * Supports protocol-specific wildcards and domain wildcards:
 * - * - matches any valid HTTP(S) origin (global wildcard)
 * - https://* or http://* - matches any domain with specific protocol
 * - *.example.com - matches direct subdomains over http or https (ignores port)
 * - **.example.com - matches all subdomains including nested over http or https
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
  assertPattern(pattern, 'matchesWildcardOrigin');
  return wildcardOriginMatcher(origin, true)(pattern);
}

/**
 * {@link matchesWildcardOrigin} for a whole list of patterns, each cached as `isCached`
 * says (see above): the origin is read once - when a pattern first needs it - rather than
 * for every wildcard entry. `bareURL` is the origin's parse where the caller has read it
 * already (see `readBareOrigin`), `null` for one that is no bare origin.
 */
function wildcardOriginMatcher(
  origin: string,
  isCached: PatternCache,
  bareURL?: URL | null,
): (pattern: string) => boolean {
  let parsed: WildcardOrigin | undefined;
  let isRead = false;

  return (pattern) => {
    if (!isRead) {
      const originURL = readWildcardOrigin(origin, bareURL);
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
  /**
   * Its hostname normalized, when a pattern has first needed it, with whether it is an
   * IP address and its public suffix's reader.
   */
  host?: {
    normalized: string;
    isIP: boolean;
    readSuffix: () => string | null;
  };
}

/**
 * `origin` parsed as a wildcard pattern reads it: an HTTP(S) origin with nothing past its
 * host and port, or `undefined` for one no wildcard pattern matches.
 */
function readWildcardOrigin(
  origin: string,
  bareURL?: URL | null,
): URL | undefined {
  // Read as `normalizeOrigin` reads it, unless the caller has. Every pattern - `*` and
  // the protocol wildcards included - needs a parsed URL.
  const originURL =
    bareURL === undefined
      ? readBareOrigin(origin)?.url
      : (bareURL ?? undefined);

  // For CORS, only http/https are relevant.
  return originURL !== undefined && isHTTPScheme(originURL.protocol)
    ? originURL
    : undefined;
}

/** Whether `protocol` (with its colon, in any case) is `http:` or `https:`. */
function isHTTPScheme(protocol: string): boolean {
  const scheme = asciiLowercase(protocol);

  return scheme === 'http:' || scheme === 'https:';
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

  if (origin.host === undefined) {
    const normalized = normalizeDomain(originURL.hostname);
    origin.host = {
      normalized,
      isIP: normalized !== '' && isIPAddress(normalized),
      readSuffix: lazyWildcardHostSuffix(normalized),
    };
  }
  const host = origin.host;
  const normalizedHostname = host.normalized;

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
    return (
      hasSameTrailingDot(originURL, domainPattern) &&
      matchesNormalizedWildcardIn(
        normalizedHostname,
        domainPattern,
        isCached,
        host.isIP,
        host.readSuffix,
      )
    );
  }

  // Handle domain wildcard patterns (including multi-label patterns)
  if (normalizedPattern.includes('*')) {
    // Fast reject for invalid all-wildcards patterns (e.g., "*.*", "**.*")
    // Note: single "*" is handled above as global wildcard
    if (normalizedPattern !== '*' && isAllWildcards(normalizedPattern)) {
      return false;
    }

    return (
      hasSameTrailingDot(originURL, normalizedPattern) &&
      matchesNormalizedWildcardIn(
        normalizedHostname,
        normalizedPattern,
        isCached,
        host.isIP,
        host.readSuffix,
      )
    );
  }

  return false;
}

/**
 * Whether a bare domain entry's host, as the URL parser maps it, ends with a dot: after
 * the dots are folded and the characters IDNA removes (a soft hyphen, a zero-width
 * space) are gone, as `canonicalOrigin` reads an origin's host.
 */
function hasMappedTrailingDot(entry: string): boolean {
  const trimmed = readTrimmedEntry(entry);
  if (trimmed === undefined) {
    return false;
  }

  try {
    return parseURL(`https://${trimmed}`).hostname.endsWith('.');
  } catch {
    return false;
  }
}

/**
 * Whether an origin's host and a host wildcard pattern agree on a trailing dot: the dot is
 * part of the origin, as browsers read it (see `canonicalOrigin`), so `*.example.com`
 * matches `https://a.example.com` and `*.example.com.` matches `https://a.example.com.`,
 * and neither the other.
 */
function hasSameTrailingDot(originURL: URL, pattern: string): boolean {
  return (
    originURL.hostname.endsWith('.') ===
    trimHTTPWhitespace(pattern).endsWith('.')
  );
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

/**
 * How many entries each shared cache - {@link compiledWildcardPatterns} and
 * {@link normalizedExactEntries} - keeps, least recently used out first (see
 * `getOrCompute`), and so the longest list cached in them. A longer list is not cached
 * there at all: scanned in order, each entry would evict the one the next scan needs
 * first, missing every time at more cost than computing them.
 */
const MAX_SHARED_CACHE_ENTRIES = 512;

/** A scheme and `://`: an origin, which a domain list refuses. */
const ORIGIN_LIKE = /^[a-z][a-z0-9+\-.]*:\/\//i;

/** Exact entries normalized for {@link matchesDomainList}, cached as patterns are. */
const normalizedExactEntries = new Map<string, string>();

/**
 * Where a wildcard pattern's compiled form is kept: the shared cache (`true`), nowhere
 * (`false`, for a list longer than it - see `MAX_SHARED_CACHE_ENTRIES`), or a list's
 * own map (see `compiledOriginList`).
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
    ? getOrCompute(
        compiledWildcardPatterns,
        pattern,
        MAX_SHARED_CACHE_ENTRIES,
        compileWildcardPattern,
      )
    : compileWildcardPattern(pattern);
}

function normalizedExactEntry(entry: string, isCached: boolean): string {
  return isCached
    ? getOrCompute(
        normalizedExactEntries,
        entry,
        MAX_SHARED_CACHE_ENTRIES,
        normalizeDomain,
      )
    : normalizeDomain(entry);
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
  // Each entry read once, into the copy compared with the one the list was compiled from,
  // and kept as that one when it differs: the caller's list is read nowhere else.
  const source = copyEntryList(
    allowedDomains,
    'matchesDomainList',
    'allowedDomains',
  );
  const kept = compiledDomainLists.get(allowedDomains);
  if (kept !== undefined && isSameList(kept.source, source)) {
    return kept;
  }

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
    // A list that fits the shared caches is cached there too; see
    // `MAX_SHARED_CACHE_ENTRIES`.
    isCached: cleaned.length <= MAX_SHARED_CACHE_ENTRIES,
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
 * An origin list's entries, cleaned, with its wildcard patterns compiled and its exact
 * entries read as each is first reached.
 */
interface CompiledOriginList {
  /** The entries the list held, to check it against next time. */
  source: readonly string[];
  /** Trimmed, with the empty ones dropped. */
  cleaned: readonly string[];
  /** The wildcard patterns, compiled as reached (see `wildcardOriginMatcher`). */
  patterns: Map<string, ReturnType<typeof compileWildcardPattern>>;
  /** Each entry of `cleaned` holding no `*`, by index, read as reached; else `undefined`. */
  exact: (ExactOriginEntry | undefined)[];
}

/**
 * Each origin list's compiled entries, kept against the list itself, as
 * `compiledDomainLists` keeps a domain list's: checked against a copy of its entries on
 * every call, so a list the caller changes starts afresh, and holding no more than the
 * list does. A CORS check runs on every request with the same list, and reading an exact
 * entry parses it as a URL and maps its host to ASCII.
 */
const compiledOriginLists = new WeakMap<
  readonly string[],
  CompiledOriginList
>();

function compiledOriginList(
  allowedOrigins: readonly string[],
  /** The list's entries as the matcher read them (see `copyEntryList`), kept as its source. */
  entries: readonly string[],
): CompiledOriginList {
  const kept = compiledOriginLists.get(allowedOrigins);
  if (kept !== undefined && isSameList(kept.source, entries)) {
    return kept;
  }

  const list: CompiledOriginList = {
    source: entries,
    cleaned: entries.map((s) => readTrimmedEntry(s) ?? '').filter(Boolean),
    patterns: new Map(),
    exact: [],
  };
  compiledOriginLists.set(allowedOrigins, list);

  return list;
}

/** Entry `index` of `list`, which holds no `*`, read the first time it is reached. */
function exactOriginEntry(
  list: CompiledOriginList,
  index: number,
): ExactOriginEntry {
  let entry = list.exact[index];

  if (entry === undefined) {
    entry = readExactOriginEntry(list.cleaned[index]);
    list.exact[index] = entry;
  }

  return entry;
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
 *   An entry that starts with a scheme and `://` throws, whether or not there is a domain
 *   to match, to surface misconfiguration early.
 * - Empty or whitespace-only entries are ignored.
 * Use `matchesOriginList` for origin-style patterns.
 */
export function matchesDomainList(
  domain: string,
  allowedDomains: readonly string[],
): boolean {
  // Before the early exit below, so a list that is no list is refused on every call.
  assertEntryListIsArray(allowedDomains, 'matchesDomainList', 'allowedDomains');
  // Compiled before the early exit too, so an entry that is no string, or one that is an
  // origin, is refused whether or not there is a domain to match.
  const list = compiledDomainList(allowedDomains);
  const normalizedDomain = normalizeDomain(domain);

  // Early exit: invalid input cannot match any allowed domain. Nor can `"null"`, the
  // origin-only literal: as documented, it is never matched here - the global `*`
  // would otherwise match it as it matches any single-label name.
  if (normalizedDomain === '' || normalizedDomain === 'null') {
    return false;
  }

  // Asked once, for every wildcard entry, and only if one is reached - its public suffix
  // only once one matches.
  let isIP: boolean | undefined;
  const readSuffix = lazyWildcardHostSuffix(normalizedDomain);

  for (let index = 0; index < list.cleaned.length; index++) {
    const entry = compiledDomainEntry(list, index);
    // Against the domain normalized once above, as `matchesWildcardDomain` would read it,
    // rather than normalized again for every wildcard entry.
    if (entry.kind === 'wildcard') {
      isIP ??= isIPAddress(normalizedDomain);
      if (
        entry.compiled !== undefined &&
        matchesCompiledWildcard(
          normalizedDomain,
          entry.compiled,
          isIP,
          readSuffix,
        )
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

/**
 * Each host filter's patterns, read once against the list itself, as
 * `compiledDomainLists` keeps a domain list's: checked against a copy of its entries on
 * every call, so a list the caller changes is read afresh.
 */
const hostFilterLists = new WeakMap<
  readonly string[],
  { source: readonly string[]; patterns: readonly HostPattern[] }
>();

/**
 * Whether `hostname` matches any of `patterns` as a host filter - which of your own
 * requests or hosts something applies to, rather than whom to trust - by the rules the
 * HTTP client's `hosts` filters match by:
 *
 * - An exact name matches that host, after normalization (case, IDNA, a trailing dot) -
 *   one the URL parser reads with a hyphen at a label's edge (`-edge.example.com`)
 *   included.
 * - `*.example.com` matches one label under the tail and `**.example.com` any depth;
 *   neither matches the tail itself. A tail that is a public suffix or pseudo-TLD is
 *   matched as written - `*.internal` matches `api.internal`, `**.co.uk` every host under
 *   `co.uk` - where {@link matchesDomainList} refuses it. A host under an ICANN public
 *   suffix beneath the tail is still never matched: `**.hedmark.no` does not reach
 *   `evil.os.hedmark.no`, another registrant's.
 * - `*` alone matches any non-empty hostname, an IP address included; no other wildcard
 *   matches an IP address.
 * - An entry {@link validateHostFilterEntry} refuses - `*.*`, a wildcard around an IP or
 *   numeric tail, one over a Public Suffix List wildcard rule (`*.kawasaki.jp`), a scheme
 *   or port, whitespace other than spaces, tabs, CRs and LFs at an end - matches nothing.
 *   Check entries with it when they are configured, as the HTTP client checks a filter's.
 *
 * Pass a URL's `hostname`. Throws a `TypeError` for a list that is not an array of
 * strings; a `hostname` that is not a string matches nothing.
 */
export function matchesHostFilter(
  hostname: string,
  patterns: readonly string[],
): boolean {
  const source = copyEntryList(patterns, 'matchesHostFilter', 'patterns');
  let kept = hostFilterLists.get(patterns);

  if (kept === undefined || !isSameList(kept.source, source)) {
    kept = { source, patterns: source.map(readHostPattern) };
    hostFilterLists.set(patterns, kept);
  }

  if (typeof hostname !== 'string') {
    return false;
  }

  const host = checkedHostFor(hostname);
  return kept.patterns.some((pattern) => matchesReadHostPattern(host, pattern));
}

/**
 * Whether a host filter entry can match a host by {@link matchesHostFilter}'s rules, and
 * if not, why - the check the HTTP client runs on a `hosts` filter's entries when it is
 * added. `info` is phrased to follow the entry: `` `'${entry}' ${info}` ``. Refused:
 *
 * - a scheme, path or port: the filter is matched against a hostname alone;
 * - an exact name the matcher cannot read, or one the URL parser reads as another
 *   hostname, which is what a request's hostname will be;
 * - a wildcard `validateConfigEntry(entry, 'domain', { allowSuffixTails: true })`
 *   refuses, `*.` (a template whose domain is unset), or one whose hosts would be IP
 *   addresses;
 * - whitespace other than spaces, tabs, CRs and LFs at an end.
 */
export function validateHostFilterEntry(entry: string): {
  valid: boolean;
  info?: string;
} {
  if (typeof entry !== 'string') {
    return { valid: false, info: 'is not a string' };
  }

  // Trimmed first, of HTTP whitespace, as the matcher trims an entry before reading it.
  const info = hasNonHTTPWhitespaceEdge(entry)
    ? 'has a no-break space or other whitespace besides spaces, tabs, CRs and LFs at an end, so it can never match'
    : describeUnmatchableHostPattern(trimHTTPWhitespace(entry));

  return info === undefined ? { valid: true } : { valid: false, info };
}

/** Why a trimmed host filter entry can never match, or `undefined` when it can. */
function describeUnmatchableHostPattern(entry: string): string | undefined {
  if (entry.includes('/')) {
    return 'has a scheme or path; give the hostname alone';
  }

  if (/^[^:]*:\d*$/.test(entry) || /\]:/.test(entry)) {
    return 'has a port; give the hostname alone';
  }

  if (!entry.includes('*')) {
    const parsed = urlHostnameOf(entry);
    // A guard for any name the URL parser reads differently from the matcher, which would
    // be compared as written and so never equal a request's hostname. The matcher reads IP
    // literals as the parser does - `2130706433` is `127.0.0.1` to both - so those match.
    // A Unicode name the matcher cannot read in that spelling (`-ñ.example.com`) may be
    // one it reads as the parser writes it (`xn----rga.example.com`): said so, too.
    const name = readExactHostName(entry);
    const parsedName = parsed === undefined ? '' : readExactHostName(parsed);
    if (parsedName !== '' && parsedName !== name) {
      return "is read by the URL parser as another hostname, which is what a request's hostname will be; give the form the URL parser reads";
    }

    if (name === '' && endsInNumericLabel(entry)) {
      return 'ends in a numeric label, which the URL parser reads as an IPv4 address, so no request has it as a hostname; give the address itself or a name';
    }

    return name === '' || parsed === undefined
      ? "is not a hostname the matcher can read (it reads host names: letters, digits, '_' and hyphens), so it can never match"
      : undefined;
  }

  if (isGlobalHostPattern(entry)) {
    return undefined;
  }

  // Said plainly: the template that writes it (`*.${domain}`) lost its domain.
  if (toAsciiDots(entry) === '*.') {
    return "is a wildcard with an empty label after it, so it can never match; give '*' to match every host";
  }

  // A suffix tail is matched (see `readHostPattern`), so validated as one that is.
  const result = validateConfigEntry(entry, 'domain', {
    allowGlobalWildcard: true,
    allowSuffixTails: true,
  });
  if (!result.valid) {
    return `can never match (${result.info ?? 'invalid hostname pattern'}); give a hostname or a pattern such as '*.example.com'`;
  }

  // A hostname the pattern stands for, as the URL parser reads it: one ending in a
  // number - decimal, hex or octal - is an IP address, or no hostname at all.
  const sample = urlHostnameOf(
    entry
      .split('.')
      .map((part) => (part === '*' || part === '**' ? 'a' : part))
      .join('.'),
  );
  if (sample === undefined || isIPAddress(sample)) {
    return "can never match: a wildcard does not match an IP address ('*' alone does)";
  }

  return undefined;
}

/** `host` as the URL parser reads it, or `undefined` when no URL can have it. */
function urlHostnameOf(host: string): string | undefined {
  const authority =
    host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  try {
    return parseURL(`http://${authority}/`).hostname;
  } catch {
    return undefined;
  }
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

/** What kind of wildcard a valid entry is (see `validateConfigEntry`). */
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

/**
 * Validate a configuration entry for either domain or origin contexts.
 * Returns { valid, info? }, where info can carry non-fatal hints, for any entry; throws a
 * `TypeError` only for a context or option that is a configuration mistake.
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
 * - PSL tail guard also rejects pseudo-TLD suffix wildcards like `*.localhost`, unless
 *   `allowSuffixTails` is set: for a list that picks which of your own requests or
 *   hosts something applies to, rather than one that grants trust, a wildcard over a
 *   public suffix or pseudo-TLD (`*.internal`, `*.com`) is then valid. A tail under a
 *   Public Suffix List wildcard rule (`*.kawasaki.jp`) is refused either way.
 */
export function validateConfigEntry(
  entry: string,
  context: 'domain' | 'origin',
  options?: {
    allowGlobalWildcard?: boolean;
    allowProtocolWildcard?: boolean;
    allowSuffixTails?: boolean;
  },
): ValidationResult {
  const SCHEME_RE = /^[a-z][a-z0-9+\-.]*$/i;
  // The caller's code, not an entry from config, so refused rather than answered: any
  // other context - `'origins'`, `'Domain'` - would check the entry by the origin rules.
  const candidateContext: unknown = context;
  if (candidateContext !== 'domain' && candidateContext !== 'origin') {
    throw new TypeError(
      `validateConfigEntry: context must be 'domain' or 'origin' (got ${typeof candidateContext === 'string' ? 'an unknown context' : describeValue(candidateContext)})`,
    );
  }
  assertMatcherOptions(
    options,
    ['allowGlobalWildcard', 'allowProtocolWildcard', 'allowSuffixTails'],
    'validateConfigEntry options',
  );
  // Each option read once, its default for `null` or `undefined` as for one left out -
  // before the entry, so a bad option is refused whatever the entry is.
  const opts = {
    allowGlobalWildcard: readBooleanOption(
      options?.allowGlobalWildcard,
      false,
      'validateConfigEntry options.allowGlobalWildcard',
    ),
    allowProtocolWildcard: readBooleanOption(
      options?.allowProtocolWildcard,
      true,
      'validateConfigEntry options.allowProtocolWildcard',
    ),
    allowSuffixTails: readBooleanOption(
      options?.allowSuffixTails,
      false,
      'validateConfigEntry options.allowSuffixTails',
    ),
  };

  if (typeof entry !== 'string' && !isNullish(entry)) {
    return {
      valid: false,
      info: 'entry is not a string',
      wildcardKind: 'none',
    };
  }
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

  // Why a wildcard's tail is refused, or `undefined` when it is not: the matcher's own
  // tail rule, so the two cannot disagree, its refusal named for what the tail is.
  function wildcardTailRefusal(normalized: string): string | undefined {
    const { fixedTail } = extractFixedTailAfterLastWildcard(
      normalized.split('.'),
    );

    const refusal = readWildcardTailRefusal(fixedTail, {
      allowSuffixTails: opts.allowSuffixTails,
    });

    switch (refusal) {
      case undefined:
        return undefined;
      case 'no-tail':
        return 'wildcard has no fixed label after it (disallowed)';
      case 'suffix':
        return 'wildcard tail targets a public suffix or internal pseudo-TLD (disallowed)';
      case 'suffix-wildcard-rule':
        return 'wildcard tail is under a public suffix wildcard rule, so every label beneath it is a public suffix (disallowed)';
      case 'numeric':
        return 'wildcard tail ends in a numeric label, so a host under it is an IP address or no URL host at all (disallowed)';
      case 'ip':
        return 'wildcard tail targets an IP address (disallowed)';
      default: {
        // A refusal added to `WildcardTailRefusal` without a reason here fails to compile.
        const unnamed: never = refusal;
        return unnamed;
      }
    }
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
    const trimmed = toAsciiDots(trimHTTPWhitespace(pattern));

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

    // `normalizeWildcardPattern` has normalized each concrete label and held them to
    // DNS's lengths: an invalid one is its `''`, refused above.
    if (isAllWildcards(normalized)) {
      return {
        valid: false,
        info: 'all-wildcards pattern is not allowed',
        wildcardKind: 'none',
      };
    }

    const tailRefusal = wildcardTailRefusal(normalized);
    if (tailRefusal !== undefined) {
      return { valid: false, info: tailRefusal, wildcardKind: 'none' };
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

    return { valid: true, wildcardKind: 'protocol' };
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

    return { valid: true, wildcardKind: 'subdomain' };
  }

  // Exact origin: allow any scheme; validate host as domain or IP. Every acceptance
  // below is held to what the matcher can match - see `exactOriginVerdict`.
  // Asked of the matchers' own parser, so an entry is valid only if they can match it:
  // one with a tab, CR or LF left inside (`https://\texample.com`), which the host's own
  // check would trim at its edges, or one the URL parser does not read as written.
  const exactOriginVerdict = (result: ValidationResult): ValidationResult =>
    result.valid && parseExactOriginEntry(raw) === null
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
  // Read without the entry's port or trailing slash.
  const hostOrigin = `${scheme}://${host}`;
  if (isOpaqueHost && normalizeOrigin(hostOrigin) === '') {
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
 * {@link parseExactOriginForMatching} for an allowlist entry, which is refused - `null` -
 * when a tab, CR or LF is left inside it, as `validateConfigEntry` refuses it, rather
 * than read with them deleted as the URL parser reads an `Origin`: `https://exa\tmple.com`
 * is no entry for `https://example.com`.
 */
function parseExactOriginEntry(
  entry: string,
): ReturnType<typeof parseExactOriginForMatching> {
  return /[\t\n\r]/.test(entry) ? null : parseExactOriginForMatching(entry);
}

/**
 * Parse an exact origin for list matching.
 * Rejects userinfo, non-empty paths, queries, and fragments so malformed inputs
 * are not silently normalized into broader origins.
 */
function parseExactOriginForMatching(entry: string): {
  normalizedOrigin: string;
  normalizedHostname: string;
  /** Its parse (see `readBareOrigin`), `null` for the origin `null`. */
  url: URL | null;
  /** A non-special scheme's host, which the public suffix list says nothing about. */
  isOpaqueHost: boolean;
  /** Whether the scheme is `http:` or `https:`, the only ones a bare domain matches. */
  isHTTP: boolean;
} | null {
  if (entry === 'null') {
    return {
      normalizedOrigin: 'null',
      normalizedHostname: '',
      url: null,
      isOpaqueHost: false,
      isHTTP: false,
    };
  }

  // Read and canonicalized as `normalizeOrigin` reads it, from one parse.
  const bare = readBareOrigin(entry);
  const canonical = bare === undefined ? undefined : canonicalOrigin(bare);
  if (bare === undefined || canonical === undefined) {
    return null;
  }

  const { url } = bare;

  return {
    normalizedOrigin: canonical.origin,
    normalizedHostname: canonical.hostname,
    url,
    isOpaqueHost:
      !isSpecialScheme(asciiLowercase(url.protocol)) &&
      !url.hostname.startsWith('['),
    isHTTP: isHTTPScheme(url.protocol),
  };
}

/** An allowlist entry that is no wildcard, read once per list (see `compiledOriginList`). */
type ExactOriginEntry =
  | { kind: 'null' }
  /** A bare domain's normalized hostname; `''` for one that can never match. */
  | { kind: 'domain'; hostname: string }
  /** An exact origin's canonical form; `''` for one that can never match. */
  | { kind: 'origin'; origin: string };

/** `allowed`, an allowlist entry holding no `*`, read as the origin matchers compare it. */
function readExactOriginEntry(allowed: string): ExactOriginEntry {
  if (allowed === 'null') {
    return { kind: 'null' };
  }

  if (!allowed.includes('://')) {
    const hostname = normalizeDomain(allowed);
    // Kept, as an origin's host keeps it (see `canonicalOrigin`): `example.com.` matches
    // `https://example.com.` and not `https://example.com`. Read off the host the URL
    // parser maps the entry to, as an origin's is: `example.com。` is dotted, and
    // `example.com.\u00AD`, whose soft hyphen the mapping removes, is too - as its
    // `https://` form reads. Not for an IP address, whose dot the parser drops.
    const trailingDot =
      hostname !== '' && !isIPAddress(hostname) && hasMappedTrailingDot(allowed)
        ? '.'
        : '';

    return {
      kind: 'domain',
      hostname: isAllowedExactHostname(hostname)
        ? `${hostname}${trailingDot}`
        : '',
    };
  }

  const parsed = parseExactOriginEntry(allowed);

  // Not for an opaque host: the public suffix list is about DNS names, and it reads
  // every unknown single label as a suffix, which would refuse every extension origin
  // (`chrome-extension://<id>`).
  const isMatchable =
    parsed !== null &&
    (parsed.isOpaqueHost ||
      isAllowedExactHostname(withoutTrailingDot(parsed.normalizedHostname)));

  return { kind: 'origin', origin: isMatchable ? parsed.normalizedOrigin : '' };
}

/**
 * Whether an origin parsed by {@link parseExactOriginForMatching} matches an exact entry:
 * `"null"` only the literal `null` origin, an exact origin its own canonical form, and a
 * bare domain an HTTP(S) origin's hostname, any port - as a host wildcard matches only an
 * HTTP(S) origin.
 */
function matchesExactOriginEntry(
  origin: NonNullable<ReturnType<typeof parseExactOriginForMatching>>,
  entry: ExactOriginEntry,
): boolean {
  switch (entry.kind) {
    case 'null':
      return origin.normalizedOrigin === 'null';
    case 'domain':
      return (
        entry.hostname !== '' &&
        origin.isHTTP &&
        origin.normalizedHostname === entry.hostname
      );
    case 'origin':
      return entry.origin !== '' && origin.normalizedOrigin === entry.origin;
  }
}

/**
 * Whether an origin's text carries `@`, `?` or `#` after its scheme: userinfo, a query or
 * a fragment - even an empty one, which the URL parser reports as `''` and so would slip
 * past the field checks, where `validateConfigEntry` refuses the same text. No host
 * holds any of the three. Or anything after the host and port but one `/`: a path the
 * parser reduces to `/` (`/..`, `/.`, `/%2e`), which `validateConfigEntry` refuses too.
 */
function hasOriginExtras(text: string): boolean {
  const schemeEnd = text.indexOf('://');
  const afterScheme = schemeEnd === -1 ? text : text.slice(schemeEnd + 3);

  if (/[@?#]/.test(afterScheme)) {
    return true;
  }

  const pathStart = afterScheme.search(/[/\\]/);
  return pathStart !== -1 && afterScheme.slice(pathStart) !== '/';
}

function isCredentialsSafeWildcardOriginPattern(pattern: string): boolean {
  // Already trimmed by the list; held to its rule here too (see `readTrimmedEntry`).
  const trimmed = toAsciiDots(trimHTTPWhitespace(pattern));

  function isValidCredentialWildcardHost(written: string): boolean {
    // One trailing dot dropped for this check only (the matchers compare it): its empty last label
    // would refuse `https://*.example.com.`, which `validateConfigEntry` and
    // `matchesOriginList` both accept.
    // Leading and trailing whitespace dropped, as the other matchers drop it: `https://
    // *.example.com` is valid to `validateConfigEntry` and matches in `matchesOriginList`.
    // Of HTTP whitespace only; any other whitespace left is refused below.
    const host = trimHTTPWhitespace(written);

    if (isHostTooLongToNormalize(host)) {
      return false;
    }
    const hostPattern = withoutTrailingDot(host);

    if (isAllWildcards(hostPattern)) {
      return false;
    }

    if (INVALID_DOMAIN_CHARS.test(hostPattern)) {
      return false;
    }

    if (hasPartialLabelWildcard(hostPattern)) {
      return false;
    }

    // Each concrete label normalized and held to DNS's lengths, an empty one refused.
    // Handed `host` with its trailing dot, which it drops once itself: a second one is an
    // empty label, and refused.
    const normalized = normalizeWildcardPattern(host);
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
 * Wildcard and bare-domain entries match HTTP(S) origins only.
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
  allowedOrigins: readonly string[],
  opts: { treatNoOriginAsAllowed?: boolean } = {},
): boolean {
  const entries = copyEntryList(
    allowedOrigins,
    'matchesOriginList',
    'allowedOrigins',
  );
  assertMatcherOptions(
    opts,
    ['treatNoOriginAsAllowed'],
    'matchesOriginList options',
  );
  const isNoOriginAllowed = readBooleanOption(
    opts?.treatNoOriginAsAllowed,
    false,
    'matchesOriginList options.treatNoOriginAsAllowed',
  );
  const list = compiledOriginList(allowedOrigins, entries);
  const { cleaned } = list;

  if (!origin) {
    // Only allow requests without Origin header if explicitly opted in AND "*" is in the list
    return isNoOriginAllowed && cleaned.includes('*');
  }

  const parsedOrigin = parseExactOriginForMatching(origin);
  if (!parsedOrigin) {
    return false;
  }

  // The list's own compiled patterns: two lists that each fit the shared cache, used
  // in turn, would evict each other there on every call (see `compiledOriginList`).
  const matchesWildcard = wildcardOriginMatcher(
    origin,
    list.patterns,
    parsedOrigin.url,
  );

  return cleaned.some((allowed, index) =>
    // A wildcard - the global `*` included - is matched against the origin as the
    // wildcard matcher reads it, parsed once for the whole list.
    allowed.includes('*')
      ? matchesWildcard(allowed)
      : matchesExactOriginEntry(parsedOrigin, exactOriginEntry(list, index)),
  );
}

/**
 * Helper function to check if origin matches any pattern in a list (credentials-safe).
 *
 * Exact origins may use non-HTTP(S) schemes and are compared exactly; bare-domain
 * entries match HTTP(S) origins only.
 * When `allowWildcardSubdomains` is enabled, only host subdomain wildcard
 * patterns are honored. Global "*" and protocol-only wildcards such as
 * "https://*" are intentionally not honored in credentials mode.
 * Blank allowlist entries are ignored after trimming.
 */
export function matchesCORSCredentialsList(
  origin: string | undefined,
  allowedOrigins: readonly string[],
  options: { allowWildcardSubdomains?: boolean } = {},
): boolean {
  // Read before the origin is: a list that is no list is refused on every call.
  const entries = copyEntryList(
    allowedOrigins,
    'matchesCORSCredentialsList',
    'allowedOrigins',
  );
  assertMatcherOptions(
    options,
    ['allowWildcardSubdomains'],
    'matchesCORSCredentialsList options',
  );
  const allowWildcard = readBooleanOption(
    options?.allowWildcardSubdomains,
    false,
    'matchesCORSCredentialsList options.allowWildcardSubdomains',
  );
  if (!origin) {
    return false;
  }

  const parsedOrigin = parseExactOriginForMatching(origin);
  if (!parsedOrigin) {
    return false;
  }

  const list = compiledOriginList(allowedOrigins, entries);

  // The list's own compiled patterns (see `compiledOriginList`).
  const matchesWildcard = wildcardOriginMatcher(
    origin,
    list.patterns,
    parsedOrigin.url,
  );

  return list.cleaned.some((allowed, index) => {
    if (!allowed.includes('*')) {
      return matchesExactOriginEntry(
        parsedOrigin,
        exactOriginEntry(list, index),
      );
    }

    // Optional wildcard support for credentials lists (subdomain patterns only)
    return (
      allowWildcard &&
      isCredentialsSafeWildcardOriginPattern(allowed) &&
      matchesWildcard(allowed)
    );
  });
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
 * Whether `name` holds a forbidden domain code point of the URL standard (a C0 control,
 * space, `#`, `%`, `/`, `:`, `<`, `>`, `?`, `@`, `[`, a backslash, `]`, `^`, `|`, DEL)
 * or any other whitespace, which no hostname holds.
 */
function hasForbiddenDomainCodePoint(name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);

    if (
      code <= 0x20 ||
      code === 0x7f ||
      '#%/:<>?@[\\]^|'.includes(name[index])
    ) {
      return true;
    }
  }

  return /\s/.test(name);
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
 * (e.g., "[::1]" → "::1"), while port is returned separately, as the URL parser reads
 * it: an empty port (`example.com:`) is none, and leading zeros are dropped
 * (`example.com:00080` → port `'80'`).
 *
 * **Strict validation:** For bracketed IPv6 addresses, after the closing bracket `]`,
 * only the following are valid:
 * - Nothing (end of string): `[::1]` → valid
 * - Port with colon: `[::1]:8080` → valid
 * - Any other characters: `[::1]garbage`, `[::1][::2]` → returns empty (malformed)
 *
 * A hostname that holds a forbidden domain code point of the URL standard - a C0 control,
 * space, `#`, `%`, `/`, `:`, `<`, `>`, `?`, `@`, `[`, a backslash, `]`, `^`, `|`, DEL - or
 * any other whitespace is malformed too: `good.test@evil.test` → empty.
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
  // A value that is not a string - a `Host` header that was never sent - is malformed.
  if (typeof host !== 'string') {
    return { domain: '', port: '' };
  }

  // Of HTTP whitespace only: a value with other whitespace at an end (a no-break space)
  // is malformed, as the URL parser refuses such a host.
  const trimmedHost = readTrimmedEntry(host);

  if (!trimmedHost) {
    return { domain: '', port: '' };
  }

  // A port as the URL parser reads one: `''` (`example.com:`) is none, and leading zeros
  // are dropped (`00080` is `80`). `undefined` for one that is no port.
  function readPort(port: string): string | undefined {
    if (port === '') {
      return '';
    }

    return isValidPortString(port) ? String(Number(port)) : undefined;
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
        const port = readPort(rest.slice(1));

        return port === undefined ? { domain: '', port: '' } : { domain, port };
      }

      // Malformed: has junk after closing bracket (e.g., "[::1]garbage" or "[::1][::2]")
      return { domain: '', port: '' };
    }

    // Malformed bracket - missing closing bracket
    return { domain: '', port: '' };
  }

  // Regular hostname:port parsing
  const idx = trimmedHost.indexOf(':');
  const domain = idx === -1 ? trimmedHost : trimmedHost.slice(0, idx);

  // A hostname holds none of the URL standard's forbidden domain code points - a URL's
  // delimiters (`@`, `/`, `?`, `#`, a backslash, `<`, `>`, `^`, `|`), a C0 control, DEL,
  // `%` - and no other whitespace: `good.test@evil.test` names no one host.
  if (domain === '' || hasForbiddenDomainCodePoint(domain)) {
    return { domain: '', port: '' };
  }

  if (idx === -1) {
    return { domain, port: '' };
  }

  const port = readPort(trimmedHost.slice(idx + 1));

  return port === undefined ? { domain: '', port: '' } : { domain, port };
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
