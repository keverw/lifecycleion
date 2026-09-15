import { parse } from 'tldts';

/**
 * Caller adjustments to the Public Suffix List the jar scopes cookies with.
 *
 * Both lists are plain suffixes, written without a leading dot and matched whole-label:
 * `corp.internal` covers `a.corp.internal` and does not cover `notcorp.internal`. No
 * wildcards - the bundled list already carries the ones the PSL defines, and a pattern
 * language here would be a second, subtly different matcher on a security boundary.
 *
 * Deliberately data rather than a predicate. A `(domain) => boolean` hook would run on
 * every store and every send, which means every one of them would have to survive a hook
 * that throws, returns a non-boolean, or answers differently on two calls - the jar would
 * have to fail closed on all three, and a jar that silently drops cookies because a hook
 * is inconsistent is worse than one that cannot be extended. Two frozen sets, validated
 * once in the constructor, cannot do any of that.
 */
export interface PublicSuffixOverrides {
  /**
   * Extra suffixes to treat as public, on top of the bundled list.
   *
   * Strictly narrowing: a host *under* one of these may never claim it with `Domain=`, and
   * hosts under them get one bucket each rather than a shared one. The suffix may still
   * name itself, host-only, per RFC 6265bis §5.5 - so with `corp.internal` added,
   * `evil.corp.internal` cannot claim `Domain=corp.internal`, while a server on
   * `https://corp.internal/` may still set it for itself alone. Use for internal or
   * multi-tenant domains the public list does not know about - `corp.internal`,
   * `apps.acme-cloud.net`.
   */
  add?: readonly string[];

  /**
   * Suffixes to stop treating as public, even when the bundled list has them.
   *
   * Strictly widening, and the only option here that can *open* a scope: hosts under a
   * removed suffix go back to sharing one bucket and may set cookies spanning it. The
   * escape hatch for a private-section entry that breaks a deployment you control -
   * removing `herokuapp.com` restores the pre-1.0 behaviour for that suffix alone.
   */
  remove?: readonly string[];
}

/** A hostname label list, lowercased, with a trailing root dot dropped. */
function toLabels(hostname: string): string[] {
  const trimmed = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

  return trimmed.toLowerCase().split('.');
}

/**
 * Normalizes one caller-supplied suffix, or throws.
 *
 * Constructor config is the one place in the jar that fails loudly rather than closed: a
 * typo'd suffix silently doing nothing is a scoping hole that only shows up as a cookie
 * going somewhere it should not, months later. Every other refusal in this file is a
 * response to a remote server and has to keep the process running.
 */
function normalizeSuffix(entry: unknown, listName: string): string {
  if (typeof entry !== 'string') {
    throw new TypeError(
      `publicSuffixes.${listName} must hold strings; received ${typeof entry}`,
    );
  }

  // A leading dot is how Set-Cookie writes a domain, and it is the likeliest thing a
  // caller copies in from one. Accepted and dropped, as `Domain=` itself is.
  const stripped = entry.startsWith('.') ? entry.slice(1) : entry;
  const normalized = stripped.endsWith('.')
    ? stripped.slice(0, -1).toLowerCase()
    : stripped.toLowerCase();

  if (normalized === '') {
    throw new TypeError(
      `publicSuffixes.${listName} must not hold empty suffixes`,
    );
  }

  if (normalized.includes('*')) {
    throw new TypeError(
      `publicSuffixes.${listName} does not support wildcards; list '${entry}' as a plain suffix`,
    );
  }

  for (const label of normalized.split('.')) {
    if (label === '') {
      throw new TypeError(
        `publicSuffixes.${listName} entry '${entry}' has an empty label`,
      );
    }
  }

  return normalized;
}

function normalizeList(
  entries: readonly string[] | undefined,
  listName: string,
): ReadonlySet<string> {
  const result = new Set<string>();

  if (entries === undefined) {
    return result;
  }

  if (!Array.isArray(entries)) {
    throw new TypeError(`publicSuffixes.${listName} must be an array`);
  }

  for (const entry of entries) {
    result.add(normalizeSuffix(entry, listName));
  }

  return result;
}

/**
 * Answers the two Public Suffix List questions the cookie jar asks, under one snapshot
 * and one set of caller overrides.
 *
 * Both questions have to come from the same place. When only the "may a cookie claim
 * this domain" check knew about an override, the jar would refuse to *store* a cookie
 * spanning two tenants while still filing both tenants in one bucket - a scope that is
 * open on the send path and closed on the store path, which is worse than either answer
 * consistently applied.
 *
 * The bundled list is consulted with the private section enabled, which is what browsers
 * do. Without it `github.io`, `herokuapp.com` and `s3.amazonaws.com` read as ordinary
 * registrable domains, and one tenant could set a cookie for every other tenant on the
 * same platform.
 */
export class PublicSuffixResolver {
  private readonly added: ReadonlySet<string>;
  private readonly removed: ReadonlySet<string>;
  private readonly hasOverrides: boolean;

  constructor(overrides?: PublicSuffixOverrides) {
    this.added = normalizeList(overrides?.add, 'add');
    this.removed = normalizeList(overrides?.remove, 'remove');

    for (const suffix of this.added) {
      if (this.removed.has(suffix)) {
        throw new TypeError(
          `publicSuffixes lists '${suffix}' in both add and remove; it can only be one`,
        );
      }
    }

    this.hasOverrides = this.added.size > 0 || this.removed.size > 0;
  }

  /**
   * Whether `hostname` is a public suffix, and so may only be the `Domain=` of a cookie
   * when it is the request host itself - RFC 6265bis §5.5, which the caller applies.
   *
   * IP literals are not: they are compared whole by the caller and have no suffix
   * structure.
   *
   * A bare single-label hostname is - `localhost`, `myapp`, an unqualified machine name.
   * The list carries none of them, so without this `Domain=localhost` from
   * `https://evil.localhost/` was a suffix of the request host, passed every check, and
   * was filed under `localhost` - where an ordinary `http://localhost/` request then sent
   * it, and where a `Max-Age=0` from the same sibling deleted it. That is the same tossing
   * the private section closes for `github.io`, one label shorter. A single label has no
   * registrable name beneath it by definition, which is exactly what makes it a suffix
   * rather than a domain. Local development is unaffected: a cookie with no `Domain=` is
   * host-only already, and one naming the host it came from is accepted host-only by the
   * rule above. `publicSuffixes.remove` opts a name back out.
   */
  public isPublicSuffix(hostname: string): boolean {
    const labels = toLabels(hostname);
    const normalized = labels.join('.');

    if (this.added.has(normalized)) {
      return true;
    }

    if (this.removed.has(normalized)) {
      return false;
    }

    const result = parse(normalized, { allowPrivateDomains: true });

    if (result.isIp) {
      return false;
    }

    if (labels.length === 1) {
      return true;
    }

    // `domain === null` says no registrable name sits under this hostname, which is true
    // both for a listed suffix and for a bare name the list has never heard of. The
    // section flags separate them: `com` and `co.uk` are ICANN, `github.io` and
    // `herokuapp.com` are private, and `localhost` is neither.
    return (
      result.domain === null &&
      (result.isIcann === true || result.isPrivate === true)
    );
  }

  /** Whether the caller explicitly removed this exact suffix from the bundled list. */
  public isRemovedSuffix(hostname: string): boolean {
    return this.removed.has(toLabels(hostname).join('.'));
  }

  /**
   * The registrable domain `hostname` belongs to - the bucket key cookies are filed under.
   *
   * Returns `hostname` itself when nothing sits under it: a public suffix with no
   * registrable part (`github.io`), or a bare name (`localhost`).
   */
  public apexFor(hostname: string): string {
    const labels = toLabels(hostname);
    const normalized = labels.join('.');

    if (this.hasOverrides) {
      // A removed ancestor is the widest domain a cookie may claim, so it must also be
      // the bucket for every host below it. Check from the shortest candidate upward:
      // with `com` removed, a `Domain=com` cookie must still be reachable from a host
      // below a more-specific bundled suffix such as `app.blogspot.com`. Stopping at
      // `blogspot.com` first would admit the cookie but file the request elsewhere.
      for (let i = labels.length - 1; i >= 0; i--) {
        const candidate = labels.slice(i).join('.');

        if (this.removed.has(candidate)) {
          return candidate;
        }
      }

      // Longest matching public suffix wins, so the walk starts at the whole hostname and
      // shortens from the left: for `a.b.corp.internal` with `corp.internal` added, the
      // first hit is `corp.internal` and the apex is the one label in front of it.
      for (let i = 0; i < labels.length; i++) {
        const candidate = labels.slice(i).join('.');

        if (this.isPublicSuffix(candidate)) {
          return i === 0 ? normalized : labels.slice(i - 1).join('.');
        }
      }
    }

    // No override matched, so the bundled list answers - and it answers for the unlisted
    // names too. A hostname under a TLD the list has never heard of (`host.notcorp.acme`,
    // a private search domain) has no public suffix for the walk above to find, but tldts
    // still reads the last two labels as its registrable domain. Falling through to it
    // rather than returning the whole hostname is what keeps an override on one suffix
    // from quietly re-bucketing every unrelated internal name in the jar: the walk would
    // have filed `host.notcorp.acme` under itself and `notcorp.acme` under a second
    // bucket, so a cookie stored from one was invisible to the other.
    return (
      parse(normalized, { allowPrivateDomains: true }).domain ?? normalized
    );
  }
}
