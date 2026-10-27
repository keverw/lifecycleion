import { isPlainRecord } from './internal/plain-record';
import { copyArrayValue } from './internal/array-copy';
import { describeValue } from '../internal/describe-value';
import { parse } from 'tldts';
import { endsInANumber } from '../domain-utils/helpers';
import { asciiLowercase } from '../internal/ascii-text';

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
   * `apps.acme-cloud.net`. An addition equal to or beneath a removed suffix is
   * contradictory and throws a TypeError at construction.
   */
  add?: readonly string[];

  /**
   * Suffixes to stop treating as public, even when the bundled list has them.
   *
   * Strictly widening, and the only option here that can *open* a scope: a host whose
   * registrable domain a removal widens - as a browser with the same list reads it - may
   * set cookies spanning it. With `herokuapp.com` removed, `mine.herokuapp.com` may set
   * `Domain=herokuapp.com`; with `s3.amazonaws.com` removed, a bucket may set
   * `Domain=amazonaws.com`, which is sent to every host under `amazonaws.com`. A suffix
   * still listed beneath a removal keeps its tenants sites of their own: with `uk`
   * removed, `x.co.uk` may not set `Domain=uk` while `co.uk` stays listed. The escape
   * hatch for a private-section entry that breaks a deployment you control - removing
   * `herokuapp.com` restores the pre-1.0 behaviour for that suffix alone.
   */
  remove?: readonly string[];
}

/** A hostname label list, lowercased in ASCII, with a trailing root dot dropped. */
function toLabels(hostname: string): string[] {
  const trimmed = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;

  return asciiLowercase(trimmed).split('.');
}

/**
 * Normalizes one caller-supplied suffix, or throws.
 *
 * Constructor config is the one place in the jar that fails loudly rather than closed: a
 * typo'd suffix silently doing nothing is a scoping hole that only shows up as a cookie
 * going somewhere it should not, months later. Every other refusal in this file is a
 * response to a remote server and has to keep the process running.
 */
function normalizeSuffix(
  entry: unknown,
  listName: string,
  index: number,
): string {
  // Named by its place in the list, never its text, as every entry refused here is. The
  // only text a refusal here quotes is an unknown field's key, an option name and not a
  // hostname.
  const entryName = `publicSuffixes.${listName}[${String(index)}]`;

  if (typeof entry !== 'string') {
    throw new TypeError(
      `${entryName} must be a string (got ${describeValue(entry)})`,
    );
  }

  // A leading dot is how Set-Cookie writes a domain, and it is the likeliest thing a
  // caller copies in from one. Accepted and dropped, as `Domain=` itself is.
  const stripped = entry.startsWith('.') ? entry.slice(1) : entry;
  // Lowercased in ASCII only, so a typo is refused below: `toLowerCase` turned the Kelvin
  // sign in `\u212Aorp.internal` into the `k` of a valid `korp.internal`.
  const normalized = asciiLowercase(
    stripped.endsWith('.') ? stripped.slice(0, -1) : stripped,
  );

  if (normalized === '') {
    throw new TypeError(`${entryName} is empty`);
  }

  if (normalized.includes('*')) {
    throw new TypeError(
      `${entryName} is a wildcard, which publicSuffixes does not support; list it as a plain suffix`,
    );
  }

  if (normalized.length > 253) {
    throw new TypeError(`${entryName} is longer than a hostname`);
  }

  for (const label of normalized.split('.')) {
    if (label === '') {
      throw new TypeError(`${entryName} has an empty label`);
    }

    // Overrides are hostname suffixes, not URLs or arbitrary match strings. Keeping the
    // accepted form deliberately narrow also prevents a typo such as a scheme, slash or
    // whitespace from silently installing a rule that can never match a request host.
    // As narrow as the hosts the jar stores, and no narrower: letters, digits, `_` and
    // hyphens, an edge hyphen included, so a `my_net` the jar keeps cookies for can be
    // declared a suffix to isolate its tenants.
    if (label.length > 63 || !/^[a-z0-9_-]+$/.test(label)) {
      throw new TypeError(`${entryName} is not a valid hostname suffix`);
    }
  }

  // A last label the URL parser reads as a number, decimal or hex (`0x1f`, `0x`): an IP
  // address, which the jar answers before it consults any suffix rule, or a name the
  // parser reads as one (`corp.123`), which no request host can be. Either way the entry
  // could never take effect.
  if (endsInANumber(normalized.split('.').at(-1) ?? '')) {
    throw new TypeError(
      `${entryName} ends in a number, so no request host can match it (an IP address is never a public suffix)`,
    );
  }

  return normalized;
}

/** A list's suffixes normalized, index for index, so a refusal can name an entry's place. */
function normalizeList(
  entries: readonly string[] | undefined,
  listName: string,
): string[] {
  const result: string[] = [];

  if (entries === undefined) {
    return result;
  }

  if (!Array.isArray(entries)) {
    throw new TypeError(`publicSuffixes.${listName} must be an array`);
  }

  // Read by index, as every caller list is (see `copyArrayValue`): an `entries` or an
  // iterator of the array's own could report suffixes it does not hold. A hole reads as
  // `undefined` and is refused as any non-string entry is.
  for (const [index, entry] of copyArrayValue(entries).entries()) {
    result.push(normalizeSuffix(entry, listName, index));
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

  constructor(overrides?: PublicSuffixOverrides) {
    // Shape-checked, as every entry is: `publicSuffixes: ['corp.internal']` (the list
    // given where `{ add }` belongs) or a misspelled `{ ad: [...] }` built a jar with no
    // overrides at all, leaving the tenants the caller meant to isolate sharing cookies.
    if (overrides !== undefined) {
      // A plain object: a `Map` keeps its entries off its own properties, so it passed
      // the key check below with no keys and built a jar with no overrides.
      const candidate: unknown = overrides;
      if (!isPlainRecord(candidate)) {
        throw new TypeError(
          `publicSuffixes must be a plain object with 'add' and/or 'remove' lists (got ${Array.isArray(candidate) ? 'an array' : describeValue(candidate)})`,
        );
      }

      for (const key of Object.keys(overrides)) {
        if (key !== 'add' && key !== 'remove') {
          throw new TypeError(
            `publicSuffixes has an unknown field '${key}'; only 'add' and 'remove' are read`,
          );
        }
      }
    }

    const added = normalizeList(overrides?.add, 'add');
    const removed = normalizeList(overrides?.remove, 'remove');
    this.added = new Set(added);
    this.removed = new Set(removed);

    for (const [addIndex, suffix] of added.entries()) {
      for (const [removeIndex, removedSuffix] of removed.entries()) {
        if (suffix === removedSuffix || suffix.endsWith(`.${removedSuffix}`)) {
          throw new TypeError(
            `publicSuffixes.add[${String(addIndex)}] is, or is beneath, publicSuffixes.remove[${String(removeIndex)}]; shared cookies conflict with tenant isolation`,
          );
        }
      }
    }
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

    return isBundledPublicSuffix(normalized);
  }

  /**
   * Whether `hostname` is a suffix of the bundled list that `publicSuffixes.remove` opts
   * out - one whose removal took effect, as {@link registrableDomainFor} reads removals.
   * A removal of a name the bundled list does not treat as a suffix changes nothing, and
   * is not one.
   */
  public isRemovedSuffix(hostname: string): boolean {
    return this.isEffectiveRemoval(toLabels(hostname).join('.'));
  }

  /**
   * The registrable domain `hostname` belongs to under the jar's effective list - the
   * bundled list with the caller's additions and removals - and so the site it is part
   * of, which is also the bucket its cookies are filed under. A removed suffix at or
   * directly above the listed answer is no longer a suffix, so the domain widens past it,
   * up to the next name the effective list still treats as a suffix: with `herokuapp.com`
   * removed, `mine.herokuapp.com` belongs to `herokuapp.com`; with `com` removed,
   * `x.example.com` to `com`; and with `s3.amazonaws.com` removed,
   * `bucket.s3.amazonaws.com` to `amazonaws.com`, since `amazonaws.com` is no suffix
   * either. A suffix still listed stops the widening, as it does for a browser with the
   * same list: with `uk` removed, `a.x.co.uk` belongs to `x.co.uk`, since `co.uk` is still
   * a suffix, and with `com` removed, `app.blogspot.com` is still a site of its own.
   *
   * Returns `hostname` itself when nothing sits under it: a public suffix with no
   * registrable part (`github.io`, or `co.uk` with `uk` removed), or a bare name
   * (`localhost`).
   */
  public registrableDomainFor(hostname: string): string {
    const domain = this.listedRegistrableDomainFor(hostname);

    if (this.removed.size === 0) {
      return domain;
    }

    if (this.isEffectiveRemoval(domain)) {
      return this.widenPastRemoval(domain);
    }

    // Only past a removal: starting from the listed answer keeps bundled exception rules
    // (`!city.kawasaki.jp`) in force, though `kawasaki.jp` above it is no suffix. A name
    // the effective list still treats as a suffix is a domain of its own and is not
    // widened: with `uk` removed, `co.uk` is not `uk`.
    if (!domain.includes('.') || this.isPublicSuffix(domain)) {
      return domain;
    }

    const parent = domain.slice(domain.indexOf('.') + 1);

    return this.isEffectiveRemoval(parent)
      ? this.widenPastRemoval(parent)
      : domain;
  }

  /**
   * The registrable domain a removed suffix belongs to under the effective list: widened
   * one label at a time until the parent is a suffix still - `herokuapp.com` stays itself
   * below `com`, and `s3.amazonaws.com` becomes `amazonaws.com`.
   */
  private widenPastRemoval(removed: string): string {
    let domain = removed;

    while (domain.includes('.')) {
      const parent = domain.slice(domain.indexOf('.') + 1);

      if (this.isPublicSuffix(parent)) {
        break;
      }

      domain = parent;
    }

    return domain;
  }

  /** {@link isRemovedSuffix} for a name already normalized: one place for the rule. */
  private isEffectiveRemoval(normalized: string): boolean {
    return this.removed.has(normalized) && isBundledPublicSuffix(normalized);
  }

  /**
   * The registrable domain `hostname` belongs to under the bundled list and the caller's
   * additions, removals not applied. Returns `hostname` itself when nothing sits under it.
   */
  private listedRegistrableDomainFor(hostname: string): string {
    const labels = toLabels(hostname);
    const normalized = labels.join('.');

    if (this.added.size > 0) {
      // Parse the whole hostname so bundled wildcard exceptions remain in force.
      // Only caller additions may narrow that result; probing bundled suffixes
      // individually loses the exception context (e.g. city.kawasaki.jp). Read
      // without tldts's hostname check, as below: it finds no suffix at all for an
      // edge-hyphen host, and an added suffix above a longer bundled one then won.
      const bundled = parse(normalized, {
        allowPrivateDomains: true,
        validateHostname: false,
      });
      const bundledLength = bundled.publicSuffix?.split('.').length ?? 0;
      for (let i = 0; i < labels.length; i++) {
        const candidate = labels.slice(i).join('.');
        if (this.added.has(candidate) && labels.length - i >= bundledLength) {
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
    //
    // Read without tldts's hostname check, as above. The check only refuses a host - the
    // suffix lookup is the same either way - and it refuses one with a hyphen at a
    // label's edge (`-edge.example.com`), which the URL parser accepts and the jar keeps.
    // Such a host is under `example.com`, not its own apex: its `Domain=example.com`
    // cookies are kept and a domain clear of `example.com` reaches it.
    return (
      parse(normalized, { allowPrivateDomains: true, validateHostname: false })
        .domain ?? normalized
    );
  }
}

/** Whether the bundled list, without the caller's overrides, reads `normalized` as a public suffix. */
function isBundledPublicSuffix(normalized: string): boolean {
  const labels = normalized.split('.');

  // Without tldts's hostname check, as `listedRegistrableDomainFor` reads it: with the
  // check, a label starting or ending with a hyphen (`x-.ck` under `*.ck`) was read as no suffix at all,
  // so a `Domain=x-.ck` cookie was stored for every tenant under it.
  const result = parse(normalized, {
    allowPrivateDomains: true,
    validateHostname: false,
  });

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
