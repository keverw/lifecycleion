import { toASCII, toUnicode } from 'tr46';

// Defense-in-depth: cap label processing to avoid pathological patterns
export const MAX_LABELS = 32;
// Extra safety: cap recursive matching steps to avoid exponential blow-ups
const STEP_LIMIT = 10_000;

// Invalid domain characters: ports, paths, fragments, brackets, userinfo, backslashes
export const INVALID_DOMAIN_CHARS = /[/?#:[\]@\\]/;

// Internal / special-use TLDs that we explicitly treat as non-PSL for wildcard-tail checks.
// Keep this list explicit—do not guess.
// Currently: 'localhost', 'local', 'test' (IANA special-use), and 'internal' (common in k8s/corporate).
// If you want to allow other names (e.g., 'lan'), add them here deliberately.
export const INTERNAL_PSEUDO_TLDS = Object.freeze(
  new Set<string>(['localhost', 'local', 'test', 'internal']),
);

// Helper functions for wildcard pattern validation
export function isAllWildcards(s: string): boolean {
  return s.split('.').every((l) => l === '*' || l === '**');
}

export function hasPartialLabelWildcard(s: string): boolean {
  return s.split('.').some((l) => l.includes('*') && l !== '*' && l !== '**');
}

/**
 * Check DNS length constraints for hostnames (non-throwing):
 * - each label <= 63 octets
 * - total name <= 253 characters, a trailing dot aside (255 octets on the wire)
 * - max 127 labels (theoretical DNS limit)
 * Assumes ASCII input (post-TR46 processing).
 */
export function checkDNSLength(host: string): boolean {
  const labels = host.split('.');

  // Label count cap for domains (127 is theoretical DNS limit)
  if (labels.length === 0 || labels.length > 127) {
    return false;
  }

  let total = 0;
  let i = 0;

  for (const lbl of labels) {
    const isLast = i++ === labels.length - 1;

    if (lbl.length === 0) {
      // Allow only a *trailing* empty label (for FQDN with a dot)
      if (!isLast) {
        return false;
      }
      continue;
    }

    if (lbl.length > 63) {
      return false;
    }

    total += lbl.length + 1; // account for dot
  }

  // 253 characters: the 255-octet wire limit counts a length octet per label and the root,
  // so 255 characters of text are 257 on the wire - tr46's `verifyDNSLength` refuses them.
  return total > 0 ? total - 1 <= 253 : false;
}

// IPv6 regex pattern hoisted to module scope for performance
const IPV6_BASE_REGEX =
  /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|::([fF]{4}(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

/**
 * Check if a string is an IPv4 address
 */
export function isIPv4(str: string): boolean {
  const ipv4Regex =
    /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
  return ipv4Regex.test(str);
}

/**
 * Check if a string is an IPv6 address
 */
export function isIPv6(str: string): boolean {
  // Zone identifiers are intentionally rejected to keep behavior portable across
  // Node, Bun, and browser-facing URL handling.
  // Both brackets or neither: `[::1` is no address, and the URL parser refuses it.
  const isBracketed = str.startsWith('[') && str.endsWith(']');
  if (!isBracketed && (str.startsWith('[') || str.endsWith(']'))) {
    return false;
  }

  const cleaned = isBracketed ? str.slice(1, -1) : str;
  if (cleaned.includes('%')) {
    return false;
  }

  return IPV6_BASE_REGEX.test(cleaned);
}

/**
 * Check if a string is an IP address (IPv4 or IPv6)
 */
export function isIPAddress(str: string): boolean {
  return isIPv4(str) || isIPv6(str);
}

/**
 * How the URL parser reads `host` as an IPv4 address, asked of the parser itself:
 * `undefined` when it does not take the host for one, `{ address }` when it does, and
 * `{}` when it takes it for one and refuses it - such a host is no URL's host at all.
 *
 * The parser reads a host as IPv4 when, after percent-decoding and IDNA mapping, its last
 * label is a number (decimal, or `0x` hex): `2130706433` and `0x7f.1` are `127.0.0.1`,
 * and so are `127.0.0.%31`, `127.0.0.①` and `１２７.0.0.1`; `192.168.1.08` (an octal
 * label with an 8) and `a.2.3.4` are refused. Imitating that mapping here missed one
 * spelling after another, so the mapping is the parser's: a host parsed with a label
 * appended (`<host>.a`) comes back mapped but never read as an address, which shows the
 * last label as the parser sees it, and the plain parse then gives the address or throws.
 *
 * Only a bare host is asked about. The parser reads a whole authority, so a port,
 * userinfo, path, query or fragment would be dropped from the answer rather than refused.
 */
export function readURLParserIPv4(
  host: string,
): { address?: string } | undefined {
  // Not stripped of a trailing dot here: the empty last label is dropped once, below,
  // after decoding - stripping one here as well read `1.2.3.4..` as `1.2.3.4`.
  const text = host;

  if (text === '' || /[@/\\?#:[\]\s]/.test(text)) {
    return undefined;
  }

  let mapped: string;
  try {
    mapped = new URL(`http://${text}.a/`).hostname;
  } catch {
    return undefined;
  }

  // WHATWG's "ends in a number" drops one empty last label first: a trailing dot that
  // appears only once decoded (`127.0.0.1%2e`) still leaves `1` as the last label.
  const labels = mapped.slice(0, -'.a'.length).split('.');
  if (labels.length > 1 && labels.at(-1) === '') {
    labels.pop();
  }
  const lastLabel = labels.at(-1) ?? '';

  if (!/^(?:\d+|0x[0-9a-f]*)$/i.test(lastLabel)) {
    return undefined;
  }

  try {
    const address = new URL(`http://${text}/`).hostname;
    return isIPv4(address) ? { address } : {};
  } catch {
    return {};
  }
}

/**
 * `host` as the canonical IP address the URL parser reads it as; `''` for a host the
 * parser takes for an IPv4 address and refuses, which is no host at all; `null` when it
 * is not an IP literal and is read as a name.
 *
 * Only for a whole host: the labels of a wildcard pattern go through
 * `normalizeDomainName`, which never asks, so the `127` of `*.127.0.0.1` stays a label
 * rather than becoming the address `0.0.0.127`.
 */
function canonicalizeIPAddressLiteral(host: string): string | null {
  const isBracketed = host.startsWith('[') && host.endsWith(']');

  if (isIPv6(host)) {
    return canonicalizeBracketedIPv6Content(host.replace(/^\[|\]$/g, ''));
  }

  // Only a bare address is an IP literal. The URL parser reads a whole authority, so
  // `127.0.0.1:8080`, `x@127.0.0.1`, `127.0.0.1/evil.com` and `[::1]:8080` came back as
  // their address with the port, userinfo or path dropped - an allowlist entry written as
  // `IP:port` then matched every port on that address, where `example.com:8080` is
  // refused. A port, a path, a query, a fragment or userinfo makes it no host at all.
  if (/[@/\\?#]/.test(host) || (host.includes(':') && !isBracketed)) {
    return null;
  }

  if (isBracketed) {
    try {
      const hostname = new URL(`http://${host}/`).hostname;

      if (isIPv6(hostname)) {
        return hostname.replace(/^\[|\]$/g, '').toLowerCase();
      }
    } catch {
      // Fall through to regular domain normalization, which refuses the brackets.
    }

    return null;
  }

  const ipv4 = readURLParserIPv4(host);

  if (ipv4 === undefined) {
    return null;
  }

  // Refused by the parser: `''`, not a name. Read as a name it was matched as one -
  // `1.2.3.08` against itself - though no request can ever carry it.
  return ipv4.address ?? '';
}

/**
 * Canonicalize IPv6 literal content for deterministic origin comparison.
 * Uses the platform URL parser so the result matches WHATWG URL origin semantics.
 */
export function canonicalizeBracketedIPv6Content(content: string): string {
  try {
    const url = new URL(`http://[${content}]/`);
    return url.hostname.replace(/^\[|\]$/g, '');
  } catch {
    // Callers normally validate before canonicalizing; keep this helper
    // non-throwing as a defensive fallback.
    return content.toLowerCase();
  }
}

/**
 * Extract the fixed tail (non-wildcard labels) after the last wildcard in a pattern.
 * Returns the labels that come after the rightmost wildcard in the pattern.
 *
 * @param patternLabels - Array of pattern labels (e.g., ["*", "api", "example", "com"])
 * @returns Object with fixedTailStart index and fixedTail labels array
 */
export function extractFixedTailAfterLastWildcard(patternLabels: string[]): {
  fixedTailStart: number;
  fixedTail: string[];
} {
  // Find the rightmost wildcard
  let lastWildcardIdx = -1;
  for (let i = patternLabels.length - 1; i >= 0; i--) {
    const lbl = patternLabels[i];
    if (lbl === '*' || lbl === '**') {
      lastWildcardIdx = i;
      break;
    }
  }

  const fixedTailStart = lastWildcardIdx + 1;
  const fixedTail = patternLabels.slice(fixedTailStart);

  return { fixedTailStart, fixedTail };
}

/**
 * Internal recursive helper for wildcard label matching
 */
function matchesWildcardLabelsInternal(
  domainLabels: string[],
  patternLabels: string[],
  domainIndex: number,
  patternIndex: number,
  counter: { count: number },
): boolean {
  if (++counter.count > STEP_LIMIT) {
    return false;
  }

  while (patternIndex < patternLabels.length) {
    const patternLabel = patternLabels[patternIndex];

    if (patternLabel === '**') {
      const isLeftmost = patternIndex === 0;

      // ** at index 0 means "1+ labels" while interior ** is "0+"
      // If leftmost, require at least one domain label
      if (isLeftmost) {
        for (let i = domainIndex + 1; i <= domainLabels.length; i++) {
          if (
            matchesWildcardLabelsInternal(
              domainLabels,
              patternLabels,
              i,
              patternIndex + 1,
              counter,
            )
          ) {
            return true;
          }
        }
        return false;
      }

      // Interior **: zero-or-more
      if (
        matchesWildcardLabelsInternal(
          domainLabels,
          patternLabels,
          domainIndex,
          patternIndex + 1,
          counter,
        )
      ) {
        return true;
      }

      // Try matching one or more labels
      for (let i = domainIndex + 1; i <= domainLabels.length; i++) {
        if (
          matchesWildcardLabelsInternal(
            domainLabels,
            patternLabels,
            i,
            patternIndex + 1,
            counter,
          )
        ) {
          return true;
        }
      }
      return false;
    } else if (patternLabel === '*') {
      // * matches exactly one label
      if (domainIndex >= domainLabels.length) {
        return false; // Not enough domain labels
      }
      domainIndex++;
      patternIndex++;
    } else {
      // Exact label match
      if (
        domainIndex >= domainLabels.length ||
        domainLabels[domainIndex] !== patternLabel
      ) {
        return false;
      }
      domainIndex++;
      patternIndex++;
    }
  }

  // All pattern labels matched, check if all domain labels are consumed
  return domainIndex === domainLabels.length;
}

/**
 * Match domain labels against wildcard pattern labels
 */
export function matchesWildcardLabels(
  domainLabels: string[],
  patternLabels: string[],
): boolean {
  const counter = { count: 0 };
  return matchesWildcardLabelsInternal(
    domainLabels,
    patternLabels,
    0,
    0,
    counter,
  );
}

/**
 * Helper function for label-wise wildcard matching
 * Supports patterns like *.example.com, **.example.com, *.*.example.com, etc.
 */
export function matchesMultiLabelPattern(
  domain: string,
  pattern: string,
): boolean {
  const domainLabels = domain.split('.');
  const patternLabels = pattern.split('.');

  // Guard against pathological label counts
  if (domainLabels.length > MAX_LABELS || patternLabels.length > MAX_LABELS) {
    return false;
  }

  // Pattern must have at least one non-wildcard label (the base domain)
  if (
    patternLabels.length === 0 ||
    patternLabels.every((label) => label === '*' || label === '**')
  ) {
    return false;
  }

  // Extract the fixed tail after the last wildcard
  const { fixedTailStart, fixedTail } =
    extractFixedTailAfterLastWildcard(patternLabels);

  // Domain must be at least as long as the fixed tail
  if (domainLabels.length < fixedTail.length) {
    return false;
  }

  // Match fixed tail exactly (right-aligned)
  for (let i = 0; i < fixedTail.length; i++) {
    const domainLabel =
      domainLabels[domainLabels.length - fixedTail.length + i];
    const patternLabel = fixedTail[i];
    if (patternLabel !== domainLabel) {
      return false;
    }
  }

  // Now match the left side (which may include wildcards and fixed labels)
  const remainingDomainLabels = domainLabels.slice(
    0,
    domainLabels.length - fixedTail.length,
  );
  const leftPatternLabels = patternLabels.slice(0, fixedTailStart);

  if (leftPatternLabels.length === 0) {
    // No left pattern, so only the fixed tail is required
    return remainingDomainLabels.length === 0;
  }

  return matchesWildcardLabels(remainingDomainLabels, leftPatternLabels);
}

/**
 * Normalize Unicode dot variants to ASCII dots for consistent IP and domain handling
 * @param s - String that may contain Unicode dot variants
 * @returns String with Unicode dots normalized to ASCII dots
 */
export function toAsciiDots(s: string): string {
  return s.replace(/[．。｡]/g, '.'); // fullwidth/japanese/halfwidth
}

/**
 * Normalize a domain name for consistent comparison
 * Handles trim, lowercase, a single trailing-dot FQDN form, NFC normalization,
 * and punycode conversion for IDN safety. Returns the canonical host form
 * without a trailing dot. Repeated trailing dots are rejected as invalid.
 * IP literals are canonicalized to a stable WHATWG URL-compatible form.
 */
export function normalizeDomain(domain: string): string {
  return normalizeHostText(domain, true);
}

/**
 * A name normalized as {@link normalizeDomain} normalizes one, but never read as an IP
 * address. For text the URL parser does not read as a host of a special scheme: a label
 * of a wildcard pattern (`127` alone is the address `0.0.0.127` to the parser, but it is
 * a label here), or the opaque host of a non-special scheme (`foo://a.2.3.4`), which the
 * parser keeps as written.
 */
export function normalizeDomainName(label: string): string {
  return normalizeHostText(label, false);
}

function normalizeHostText(domain: string, isWholeHost: boolean): string {
  let trimmed = domain.trim();

  // Normalize Unicode dots BEFORE checking IP for consistent behavior
  trimmed = toAsciiDots(trimmed);

  // Allow a single trailing dot for FQDNs, but reject repeated trailing dots
  if (/\.\.+$/.test(trimmed)) {
    return '';
  }

  // Asked with its trailing dot, if any: the parser drops one empty last label in all,
  // counting one that appears only once decoded, so `1.2.3.4%2e.` is the name `1.2.3.4..`
  // to it and not the address `1.2.3.4`.
  const hostAsWritten = trimmed;

  if (trimmed.endsWith('.')) {
    trimmed = trimmed.slice(0, -1);
  }

  // Canonicalize IP literals up front so exact host checks line up with WHATWG URL parsing.
  const canonicalIPAddress = isWholeHost
    ? canonicalizeIPAddressLiteral(hostAsWritten)
    : null;
  if (canonicalIPAddress !== null) {
    return canonicalIPAddress;
  }

  // Apply NFC normalization for Unicode domains
  const normalized = trimmed.normalize('NFC').toLowerCase();

  try {
    // Use TR46/IDNA processing for robust Unicode domain handling that mirrors browser behavior
    // `checkHyphens` off, as the WHATWG URL parser has it: it would also refuse a `--` in
    // a label's third and fourth characters - `r3---sn-abc.googlevideo.com`, a real CDN
    // host any URL carries - so no pattern could match such a host. A label that starts
    // or ends with a hyphen is still refused, below.
    //
    // `useSTD3ASCIIRules` off as well, as the parser has it, so a label may carry `_`:
    // the URL standard and DNS both allow it (`a_b.example.com`, `my_service`), browsers
    // send such origins, and the cookie jar and the client's host filter already accept
    // them. Off, it also lets through `!`, `*`, `$` and the rest, which no host name uses
    // and every pattern here would misread - so the ASCII result is held to letters,
    // digits, hyphens and `_` below.
    const ascii = toASCII(normalized, {
      useSTD3ASCIIRules: false,
      checkHyphens: false,
      checkBidi: true,
      checkJoiners: true,
      transitionalProcessing: false, // matches modern browser behavior (non-transitional)
      verifyDNSLength: false, // we already do our own length checks
    });
    if (!ascii) {
      throw new Error('TR46 processing failed');
    }
    if (!/^[a-z0-9_.-]+$/.test(ascii)) {
      return '';
    }
    // On the Unicode form of each label: an IDN label starting or ending with a hyphen
    // (`-ñ`) is `xn----rga` once encoded, which hides the hyphen from a check on `ascii`.
    const unicodeLabels = toUnicode(ascii, {
      useSTD3ASCIIRules: false,
    }).domain.split('.');
    if (
      unicodeLabels.some(
        (label) => label.startsWith('-') || label.endsWith('-'),
      )
    ) {
      return '';
    }
    // Enforce DNS length constraints post-TR46
    return checkDNSLength(ascii) ? ascii : ''; // return sentinel on invalid DNS lengths
  } catch {
    // On TR46 failure, return sentinel empty-string to signal invalid hostname
    return '';
  }
}

/**
 * Normalize a wildcard domain pattern by preserving wildcard labels
 * and punycode only non-wildcard labels. Also trims and removes
 * a trailing dot if present.
 */
export function normalizeWildcardPattern(pattern: string): string {
  let trimmed = pattern
    .trim()
    .normalize('NFC')
    .replace(/[．。｡]/g, '.'); // normalize Unicode dot variants to ASCII

  // Refuse non-domain characters (ports, paths, fragments, brackets, userinfo, backslashes)
  if (INVALID_DOMAIN_CHARS.test(trimmed)) {
    return ''; // sentinel for invalid pattern
  }

  // Whitespace inside the pattern too: each label was trimmed on its own, so `*.example
  // .com` matched `a.example.com`, where the exact entry `example .com` is refused.
  if (/\s/.test(trimmed)) {
    return '';
  }

  if (trimmed.endsWith('.')) {
    trimmed = trimmed.slice(0, -1);

    // `*.` is a subdomain pattern with no domain - a `*.${base}` whose base was empty -
    // not the global `*`, which it became, matching every host past the
    // `allowGlobalWildcard` gate that only reads the pattern as written.
    if (trimmed === '*') {
      return '';
    }
  }

  const labels = trimmed.split('.');

  // Reject empty labels post-split early (e.g., *..example.com)
  // This avoids double dots slipping to punycode
  for (const lbl of labels) {
    if (lbl.length === 0) {
      return ''; // sentinel for invalid pattern (no empty labels)
    }
  }

  const normalizedLabels = [];
  for (const lbl of labels) {
    if (lbl === '*' || lbl === '**') {
      normalizedLabels.push(lbl);
      continue;
    }

    // Pre-punycode check for obviously invalid labels
    if (lbl.length > 63) {
      return ''; // sentinel for invalid pattern
    }

    const nd = normalizeDomainName(lbl);

    if (nd === '') {
      // Invalid label after normalization
      return ''; // sentinel for invalid pattern
    }

    normalizedLabels.push(nd);
  }

  // Extract concrete (non-wildcard) labels and validate final ASCII length
  const concreteLabels = normalizedLabels.filter(
    (lbl) => lbl !== '*' && lbl !== '**',
  );
  if (concreteLabels.length > 0) {
    const concretePattern = concreteLabels.join('.');
    // Validate the ASCII length of the concrete parts to prevent pathological long IDNs
    if (!checkDNSLength(concretePattern)) {
      return ''; // sentinel for invalid pattern
    }
  }

  return normalizedLabels.join('.');
}
