import { getDomain, getSubdomain, getPublicSuffix } from 'tldts';
import {
  isAllWildcards,
  hasPartialLabelWildcard,
  checkDNSLength,
  normalizeDomain,
  isIPv6,
  toAsciiDots,
  canonicalizeBracketedIPv6Content,
  matchesMultiLabelPattern,
  extractFixedTailAfterLastWildcard,
  isIPAddress,
  normalizeWildcardPattern,
  INTERNAL_PSEUDO_TLDS,
  INVALID_DOMAIN_CHARS,
  MAX_LABELS,
} from './helpers';

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

/**
 * Normalize a bare origin for consistent comparison.
 * Returns the canonical origin form with a normalized hostname,
 * lowercase scheme, no trailing slash, and default ports removed
 * (80 for http, 443 for https).
 */
export function normalizeOrigin(origin: string): string {
  // Preserve literal "null" origin exactly; treat all other invalids as empty sentinel
  if (origin === 'null') {
    return 'null';
  }

  // Normalize Unicode dots before URL parsing for browser compatibility
  // Chrome allows URLs like https://127。0。0。1
  const normalizedOrigin = toAsciiDots(origin);
  if (hasDanglingPortInAuthority(normalizedOrigin)) {
    return '';
  }

  const url = safeParseURL(normalizedOrigin);
  if (url) {
    // Only normalize bare origins. Allow slash-only suffixes so callers can
    // pass values like "https://example.com/" without broadening real paths.
    if (
      url.username ||
      url.password ||
      (url.pathname && !/^\/+$/.test(url.pathname)) ||
      url.search ||
      url.hash
    ) {
      return '';
    }

    // Normalize hostname with punycode
    const normalizedHostname = normalizeDomain(url.hostname);

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
    const hostnameForIpv6Check = (
      rawBracketContent ? rawBracketContent : normalizedHostname
    )
      .replace(/%25/g, '%')
      .toLowerCase();

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

    // Normalize default ports for http/https
    let port = '';
    const protocolLower = url.protocol.toLowerCase();
    const defaultPort =
      protocolLower === 'https:'
        ? '443'
        : protocolLower === 'http:'
          ? '80'
          : '';

    if (url.port) {
      // Remove default ports for known protocols
      port = url.port === defaultPort ? '' : `:${url.port}`;
    } else {
      // Fallback: some URL implementations with exotic hosts might not populate url.port
      // even if an explicit port exists in the original string. Detect and normalize manually.
      // Handle potential userinfo (user:pass@) prefix for future compatibility

      // Try IPv6 bracketed format first
      let portMatch = authority.match(/^(?:[^@]*@)?\[[^\]]+\]:(\d+)$/);

      if (portMatch) {
        const explicit = portMatch[1];
        port = explicit === defaultPort ? '' : `:${explicit}`;
      } else {
        // Fallback for non-IPv6 authorities: detect :port after host
        portMatch = authority.match(/^(?:[^@]*@)?([^:]+):(\d+)$/);
        if (portMatch) {
          const explicit = portMatch[2];
          port = explicit === defaultPort ? '' : `:${explicit}`;
        }
      }
    }

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
  const normalizedDomain = normalizeDomain(domain);

  if (normalizedDomain === '') {
    return false; // invalid domain cannot match
  }

  // Normalize pattern preserving wildcard labels and trailing dot handling
  const normalizedPattern = normalizeWildcardPattern(pattern);
  if (!normalizedPattern) {
    return false; // invalid pattern
  }

  // Check if pattern contains wildcards
  if (!normalizedPattern.includes('*')) {
    return false;
  }

  // Allow single "*" as global wildcard - matches both domains and IP addresses
  if (normalizedPattern === '*') {
    return true;
  }

  // Do not wildcard-match IP addresses with non-global patterns; only exact IP matches are supported elsewhere
  if (isIPAddress(normalizedDomain)) {
    return false;
  }

  // Reject other all-wildcards patterns (e.g., "*.*", "**.*")
  if (isAllWildcards(normalizedPattern)) {
    return false;
  }

  // PSL/IP tail guard: ensure the fixed tail is neither a PSL nor an IP (except explicit localhost)
  // This prevents patterns like "*.com" or "**.co.uk" from matching

  const labels = normalizedPattern.split('.');
  const { fixedTail: fixedTailLabels } =
    extractFixedTailAfterLastWildcard(labels);
  if (fixedTailLabels.length === 0) {
    return false; // require a concrete tail
  }

  const tail = fixedTailLabels.join('.');

  if (!INTERNAL_PSEUDO_TLDS.has(tail)) {
    if (isIPAddress(tail)) {
      return false; // no wildcarding around IPs
    }

    const ps = getPublicSuffix(tail);

    if (ps && ps === tail) {
      return false; // no wildcarding around public suffixes
    }
  }

  // "**." requires at least one label before the remainder, so a domain that
  // exactly equals the remainder can never match (e.g., "**.example.com" ≠ "example.com").
  if (normalizedPattern.startsWith('**.')) {
    if (normalizedDomain === normalizeDomain(normalizedPattern.slice(3))) {
      return false;
    }
  }

  return matchesMultiLabelPattern(normalizedDomain, normalizedPattern);
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
  // Normalize Unicode dots before URL parsing for consistency
  const normalizedOrigin = toAsciiDots(origin);
  const normalizedPattern = toAsciiDots(pattern);

  if (hasDanglingPortInAuthority(normalizedOrigin)) {
    return false;
  }

  // Parse once and reuse
  const originURL = safeParseURL(normalizedOrigin);

  // For CORS, only http/https are relevant; reject other schemes early when parsed.
  if (originURL) {
    const scheme = originURL.protocol.toLowerCase();
    if (scheme !== 'http:' && scheme !== 'https:') {
      return false;
    }

    if (
      originURL.username ||
      originURL.password ||
      (originURL.pathname && originURL.pathname !== '/') ||
      originURL.search ||
      originURL.hash
    ) {
      return false;
    }
  }

  // Global wildcard: single "*" matches any valid HTTP(S) origin
  if (normalizedPattern === '*') {
    return originURL !== null && hasValidWildcardOriginHost(originURL);
  }

  // Protocol-only wildcards: require valid URL parsing for security
  const patternLower = normalizedPattern.toLowerCase();

  if (patternLower === 'https://*' || patternLower === 'http://*') {
    if (!originURL) {
      return false; // must be a valid URL
    }

    const want = patternLower === 'https://*' ? 'https:' : 'http:';
    return (
      originURL.protocol.toLowerCase() === want &&
      hasValidWildcardOriginHost(originURL)
    );
  }

  // Remaining logic requires a parsed URL
  if (!originURL) {
    return false;
  }

  const normalizedHostname = normalizeDomain(originURL.hostname);

  if (normalizedHostname === '') {
    return false;
  }

  const originProtocol = originURL.protocol.slice(0, -1).toLowerCase(); // Remove trailing ":" and lowercase

  // Handle protocol-specific domain wildcards: https://*.example.com
  if (normalizedPattern.includes('://')) {
    const [patternProtocol, ...rest] = normalizedPattern.split('://');
    const domainPattern = rest.join('://');

    // Reject non-domain characters in the domain pattern portion
    if (INVALID_DOMAIN_CHARS.test(domainPattern)) {
      return false;
    }

    // Protocol must match exactly
    if (originProtocol !== patternProtocol.toLowerCase()) {
      return false;
    }

    // Fast reject: domain pattern must contain at least one wildcard and not be all-wildcards
    if (!domainPattern.includes('*') || isAllWildcards(domainPattern)) {
      return false;
    }

    // Check domain pattern using direct domain matching
    return matchesWildcardDomain(normalizedHostname, domainPattern);
  }

  // Handle domain wildcard patterns (including multi-label patterns)
  if (normalizedPattern.includes('*')) {
    // Fast reject for invalid all-wildcards patterns (e.g., "*.*", "**.*")
    // Note: single "*" is handled above as global wildcard
    if (normalizedPattern !== '*' && isAllWildcards(normalizedPattern)) {
      return false;
    }

    return matchesWildcardDomain(normalizedHostname, normalizedPattern);
  }

  return false;
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

  // Early exit: invalid input cannot match any allowed domain
  if (normalizedDomain === '') {
    return false;
  }

  // Trim and filter out empty entries first
  const cleaned = allowedDomains
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Validate: throw if any origin-style patterns are present
  const ORIGIN_LIKE = /^[a-z][a-z0-9+\-.]*:\/\//i;
  const originLike = cleaned.filter((s) => ORIGIN_LIKE.test(s));

  if (originLike.length > 0) {
    throw new Error(
      `matchesDomainList: origin-style patterns are not allowed in domain lists: ${originLike.join(', ')}`,
    );
  }

  for (const allowed of cleaned) {
    if (allowed.includes('*')) {
      if (matchesWildcardDomain(domain, allowed)) {
        return true;
      }
      continue;
    }

    const normalizedAllowed = normalizeDomain(allowed);
    if (
      isAllowedExactHostname(normalizedAllowed) &&
      normalizedDomain === normalizedAllowed
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

  if (normalizedHostname === 'null') {
    return true;
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
 * - PSL tail guard (with allowlist for internal pseudo-TLDs like localhost).
 */
export type WildcardKind = 'none' | 'global' | 'protocol' | 'subdomain';

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
): { valid: boolean; info?: string; wildcardKind: WildcardKind } {
  const raw = (entry ?? '').trim();
  const SCHEME_RE = /^[a-z][a-z0-9+\-.]*$/i;
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
    const labels = pattern.split('.');
    const concrete: string[] = [];

    for (const lbl of labels) {
      if (lbl === '*' || lbl === '**') {
        continue;
      }

      if (lbl.length > 63) {
        return false;
      }

      const nd = normalizeDomain(lbl);

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
  function wildcardTailIsInvalid(pattern: string): boolean {
    const normalized = normalizeWildcardPattern(pattern);

    const labels = normalized.split('.');

    // Extract the fixed tail after the last wildcard
    const { fixedTail: fixedTailLabels } =
      extractFixedTailAfterLastWildcard(labels);
    if (fixedTailLabels.length === 0) {
      return true; // require a concrete tail
    }

    const tail = fixedTailLabels.join('.');
    if (INTERNAL_PSEUDO_TLDS.has(tail)) {
      return false; // allow *.localhost etc.
    }
    if (isIPAddress(tail)) {
      return true; // no wildcarding around IPs
    }
    const ps = getPublicSuffix(tail);
    if (ps && ps === tail) {
      return true;
    }
    return false;
  }

  // Helper: domain-wildcard structural checks (no URL chars, full labels, etc.)
  function validateDomainWildcard(pattern: string): {
    valid: boolean;
    info?: string;
    wildcardKind: WildcardKind;
  } {
    // Normalize Unicode dots and trim
    const trimmed = pattern
      .trim()
      .normalize('NFC')
      .replace(/[．。｡]/g, '.'); // normalize Unicode dot variants to ASCII

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
  function validateExactDomain(s: string): {
    valid: boolean;
    info?: string;
    wildcardKind: WildcardKind;
  } {
    // Check if it's an IP address first - if so, allow it (consistent with matchesDomainList)
    // Normalize Unicode dots for consistent IP detection
    const sDots = toAsciiDots(s);
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

  const scheme = raw.slice(0, schemeIdx).toLowerCase();
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

  // Exact origin: allow any scheme; validate host as domain or IP
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

    return { valid: true, info, wildcardKind: 'none' };
  }

  const hostDots = toAsciiDots(host);
  if (isIPAddress(hostDots)) {
    const info =
      scheme === 'http' || scheme === 'https'
        ? undefined
        : 'non-http(s) scheme; CORS may not match';
    return { valid: true, info, wildcardKind: 'none' };
  }

  // Domain host
  const nd = normalizeDomain(host);

  if (nd === '') {
    return {
      valid: false,
      info: 'invalid domain in origin',
      wildcardKind: 'none',
    };
  }
  const ps = getPublicSuffix(nd);
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
  return { valid: true, info, wildcardKind: 'none' };
}

/**
 * Parse an exact origin for list matching.
 * Rejects userinfo, non-empty paths, queries, and fragments so malformed inputs
 * are not silently normalized into broader origins.
 */
function parseExactOriginForMatching(entry: string): {
  normalizedOrigin: string;
  normalizedHostname: string;
} | null {
  if (entry === 'null') {
    return { normalizedOrigin: 'null', normalizedHostname: '' };
  }

  const normalized = toAsciiDots(entry);
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
    normalizedHostname: normalizeDomain(url.hostname),
  };
}

function isCredentialsSafeWildcardOriginPattern(pattern: string): boolean {
  const trimmed = pattern
    .trim()
    .normalize('NFC')
    .replace(/[．。｡]/g, '.');

  function isValidCredentialWildcardHost(hostPattern: string): boolean {
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

      if (lbl.length > 63) {
        return false;
      }

      const nd = normalizeDomain(lbl);
      if (nd === '') {
        return false;
      }

      concrete.push(nd);
    }

    if (concrete.length > 0 && !checkDNSLength(concrete.join('.'))) {
      return false;
    }

    const normalized = normalizeWildcardPattern(hostPattern);
    const { fixedTail } = extractFixedTailAfterLastWildcard(
      (normalized || hostPattern).split('.'),
    );
    if (!normalized || fixedTail.length === 0) {
      return false;
    }

    const tail = fixedTail.join('.');
    if (INTERNAL_PSEUDO_TLDS.has(tail)) {
      return true;
    }

    if (isIPAddress(tail)) {
      return false;
    }

    const ps = getPublicSuffix(tail);
    return !(ps && ps === tail);
  }

  if (!trimmed.includes('*')) {
    return false;
  }

  const schemeIdx = trimmed.indexOf('://');
  if (schemeIdx === -1) {
    return isValidCredentialWildcardHost(trimmed);
  }

  const scheme = trimmed.slice(0, schemeIdx).toLowerCase();
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
 * @param opts.treatNoOriginAsAllowed - If true, allows requests without Origin header when "*" is in the allowed list
 */
export function matchesOriginList(
  origin: string | undefined,
  allowedOrigins: string[],
  opts: { treatNoOriginAsAllowed?: boolean } = {},
): boolean {
  const cleaned = allowedOrigins.map((s) => s.trim()).filter(Boolean);

  if (!origin) {
    // Only allow requests without Origin header if explicitly opted in AND "*" is in the list
    return !!opts.treatNoOriginAsAllowed && cleaned.includes('*');
  }

  const parsedOrigin = parseExactOriginForMatching(origin);
  if (!parsedOrigin) {
    return false;
  }

  return cleaned.some((allowed) => {
    // Global wildcard: single "*" matches any origin - delegate to matchesWildcardOrigin for proper validation
    if (allowed === '*') {
      return matchesWildcardOrigin(origin, '*');
    }

    if (allowed.includes('*')) {
      // Avoid double-normalizing/parsing; wildcard matcher handles parsing + normalization itself
      // We pass the raw origin/pattern here (vs normalized in the non-wildcard path) because
      // the wildcard matcher needs to parse the origin as a URL for protocol/host extraction
      return matchesWildcardOrigin(origin, allowed);
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

    if (!isAllowedExactHostname(parsedAllowed.normalizedHostname)) {
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

  const cleaned = allowedOrigins.map((s) => s.trim()).filter(Boolean);

  const allowWildcard = !!options.allowWildcardSubdomains;

  for (const allowed of cleaned) {
    // Optional wildcard support for credentials lists (subdomain patterns only)
    if (allowWildcard && allowed.includes('*')) {
      if (
        isCredentialsSafeWildcardOriginPattern(allowed) &&
        matchesWildcardOrigin(origin, allowed)
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

    if (!isAllowedExactHostname(parsedAllowed.normalizedHostname)) {
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
  const trimmedHost = host.trim();

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

export {
  normalizeDomain,
  isIPAddress,
  isIPv4,
  isIPv6,
  checkDNSLength,
  canonicalizeBracketedIPv6Content,
} from './helpers';

export { getDomain, getSubdomain } from 'tldts';
