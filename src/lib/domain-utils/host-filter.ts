/**
 * The host filter: which of a caller's own requests something applies to, by hostname -
 * the rules the HTTP client's `hosts` filters match by, and `matchesHostFilter` exposes.
 * Not an allowlist: a wildcard over a public suffix or pseudo-TLD (`*.internal`,
 * `*.com`) names that suffix's hosts as written, where the domain and origin matchers,
 * which decide whom to trust, refuse it. A host under an ICANN public suffix beneath a
 * wildcard's tail is still never matched (see `matchesCompiledWildcard`).
 */

import {
  asciiLowercase,
  hasNonHTTPWhitespaceEdge,
  trimHTTPWhitespace,
} from '../internal/ascii-text';
import {
  checkDNSLength,
  compileWildcardPattern,
  isIPAddress,
  lazyWildcardHostSuffix,
  matchesCompiledWildcard,
  normalizeDomain,
  type CompiledWildcardPattern,
} from './helpers';

/** One `hosts` pattern read once, by {@link readHostPattern}. */
export type HostPattern =
  /**
   * `*` alone: any host a request URL can carry, as documented - including one no other
   * pattern reads (`a!b.example.com`).
   */
  | { readonly kind: 'any' }
  /** An exact name, read by {@link readExactHostName}. */
  | { readonly kind: 'exact'; readonly name: string }
  | { readonly kind: 'wildcard'; readonly compiled: CompiledWildcardPattern }
  /**
   * A pattern that matches no host: `*.*`, a wildcard around an IP address or a numeric
   * tail (`10.*.0.1`), a name {@link readExactHostName} cannot read.
   */
  | { readonly kind: 'never' };

const ANY_HOST: HostPattern = { kind: 'any' };
const NO_HOST: HostPattern = { kind: 'never' };

/**
 * Whether a `hosts` pattern is `*` alone, trimmed of HTTP whitespace (space, tab, CR and
 * LF). Not `*.`: that is an empty label after the wildcard - what `*.${domain}` gives
 * with the domain unset - and read as `*`, it would send a host-scoped interceptor's
 * token to every host. It matches nothing, as in the domain matchers, and is refused when
 * the filter is added. Nor `*` with a no-break space beside it, which `trim()` would
 * take: see {@link hasNonHTTPWhitespaceEdge}.
 */
export function isGlobalHostPattern(pattern: string): boolean {
  return trimHTTPWhitespace(pattern) === '*';
}

/**
 * A `hosts` pattern read once - done when a filter is registered, rather than on every
 * request it is checked for: normalizing parses with the URL parser and runs IDNA, and a
 * wildcard is compiled once, its tail checked as `compileWildcardPattern` checks it.
 */
export function readHostPattern(pattern: string): HostPattern {
  if (hasNonHTTPWhitespaceEdge(pattern)) {
    return NO_HOST;
  }

  if (isGlobalHostPattern(pattern)) {
    return ANY_HOST;
  }

  if (pattern.includes('*')) {
    // A tail a CORS allowlist refuses - `*.internal`, `*.com` - names that suffix's hosts,
    // as a `NO_PROXY` suffix or a request mock's host pattern does: written out, it is the
    // caller's choice. A host under an ICANN public suffix beneath the tail is still not
    // matched (see `matchesCompiledWildcard`), so `**.hedmark.no` scoping a token does not
    // reach another registrant's `evil.os.hedmark.no`.
    const compiled = compileWildcardPattern(pattern, {
      allowSuffixTails: true,
    });
    if (compiled === undefined) {
      return NO_HOST;
    }

    return { kind: 'wildcard', compiled };
  }

  const name = readExactHostName(pattern);
  return name === '' ? NO_HOST : { kind: 'exact', name };
}

/**
 * A hostname as a host filter compares it - a request's, or an exact pattern's - or `''`
 * for one it cannot read: normalized by the domain matcher (case, IDNA, a trailing dot),
 * or, for a name the matcher refuses but the URL parser reads, as the parser writes it.
 * The matcher holds a name to DNS's rule that no label starts or ends with a hyphen; the
 * URL parser does not, and a request goes to `-edge.example.com`, so the exact pattern
 * `-edge.example.com` matches it, as `*.example.com` does.
 */
export function readExactHostName(name: string): string {
  return normalizeDomain(name) || readParsedHostname(trimHTTPWhitespace(name));
}

/**
 * A name the domain matcher refuses, read as the URL parser writes it, or `''`: held to
 * what the matcher reads - letters, digits, `_` and hyphens, within DNS lengths -
 * lowercased, and one trailing dot dropped, as the matcher drops it.
 */
function readParsedHostname(hostname: string): string {
  const lowercase = asciiLowercase(hostname);
  const name = lowercase.endsWith('.') ? lowercase.slice(0, -1) : lowercase;

  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/.test(name) && checkDNSLength(name)
    ? name
    : '';
}

/**
 * A request's hostname as one filter check reads it: normalized, and told whether it is
 * an IP address, and its public suffix read, each at most once and only if a pattern asks.
 */
export class CheckedHost {
  private normalizedName: string | undefined;
  private isIPName: boolean | undefined;
  private suffixReader: (() => string | null) | undefined;

  constructor(public readonly hostname: string) {}

  public get normalized(): string {
    this.normalizedName ??= readExactHostName(this.hostname);
    return this.normalizedName;
  }

  public get isIP(): boolean {
    this.isIPName ??= isIPAddress(this.normalized);
    return this.isIPName;
  }

  /** Its public suffix, as a wildcard match checks it (see `wildcardHostSuffix`). */
  public readonly readSuffix = (): string | null => {
    this.suffixReader ??= lazyWildcardHostSuffix(this.normalized);
    return this.suffixReader();
  };
}

/**
 * The last hostname checked, kept for the next check: every host-scoped interceptor and
 * observer of a request checks the same one, in turn, and normalizing it - the URL parser
 * and IDNA - is the same answer each time. The hostname alone, not the request URL, so
 * no query token or userinfo stays in module state after its request; one entry, so it
 * holds nothing past the next request.
 */
let lastCheckedHost: CheckedHost | undefined;

export function checkedHostFor(hostname: string): CheckedHost {
  if (lastCheckedHost?.hostname !== hostname) {
    lastCheckedHost = new CheckedHost(hostname);
  }

  return lastCheckedHost;
}

/** The one place a host is matched against a read pattern, exact or wildcard. */
export function matchesReadHostPattern(
  host: CheckedHost,
  pattern: HostPattern,
): boolean {
  switch (pattern.kind) {
    case 'any':
      return host.hostname !== '';
    case 'never':
      return false;
    case 'exact':
      return host.normalized === pattern.name;
    case 'wildcard':
      return (
        host.normalized !== '' &&
        matchesCompiledWildcard(
          host.normalized,
          pattern.compiled,
          host.isIP,
          host.readSuffix,
        )
      );
  }
}
