import { isNullish } from '../../internal/is-nullish';
import { normalizeFilterMethods } from '../utils';
import { validateConfigEntry } from '../../domain-utils/domain-utils';
import { isIPAddress, normalizeDomain } from '../../domain-utils/helpers';

/**
 * Every list a filter can carry besides `methods`: the type each entry must have and, for
 * a list of fixed names, the names allowed (`phases` is allowed per registry, since each
 * kind of callback is reached in its own phases). `matchesFilter` tests membership with
 * `includes`/`some`, so a string in place of a list would match by substring -
 * `phases: 'initial,retry'` matching both - and a name no request can have would match
 * nothing, silently.
 */
const FILTER_LISTS: Record<
  string,
  {
    entryType: 'string' | 'number';
    allowed?: readonly string[];
    /** Why an entry can never match, or `undefined` when it can. */
    check?: (entry: string) => string | undefined;
    /** As `check`, for a list of numbers. */
    checkNumber?: (entry: number) => string | undefined;
  }
> = {
  phases: { entryType: 'string' },
  // Trimmed first, as the matcher trims an entry before reading it.
  hosts: {
    entryType: 'string',
    check: (entry) => describeUnmatchableHostPattern(entry.trim()),
  },
  schemes: { entryType: 'string', allowed: ['http', 'https'] },
  bodyContainsKeys: { entryType: 'string' },
  statusCodes: {
    entryType: 'number',
    // An answer's status is an integer from 0 to 999; no other number is one.
    checkNumber: (entry) =>
      Number.isInteger(entry) && entry >= 0 && entry <= 999
        ? undefined
        : 'is not an integer status from 0 to 999',
  },
  contentTypes: { entryType: 'string', allowed: ['json', 'text', 'binary'] },
  contentTypeHeaders: {
    entryType: 'string',
    check: describeUnmatchableMediaTypePattern,
  },
};

/**
 * Why a host pattern can never match, by the matcher's own rules. It is compared with the
 * request URL's hostname alone, so a scheme, path or port is refused with that said.
 *
 * - An exact name is compared after the matcher's normalization, so it can match exactly
 *   when that normalization accepts it - single-label names (`backend`, `redis`) included.
 * - A wildcard pattern is read by the validator the matcher's wildcard rules come from:
 *   whole-label wildcards only, and never around a public suffix (`*.com`, `*.internal`).
 *   Nor around an IP address: a hostname ending in a numeric label is one, and only `*`
 *   alone wildcards an IP.
 */
function describeUnmatchableHostPattern(entry: string): string | undefined {
  if (entry.includes('/')) {
    return 'has a scheme or path; give the hostname alone';
  }
  if (/^[^:]*:\d*$/.test(entry) || /\]:/.test(entry)) {
    return 'has a port; give the hostname alone';
  }
  if (!entry.includes('*')) {
    return normalizeDomain(entry) === '' || urlHostnameOf(entry) === undefined
      ? 'is not a hostname a URL can have, so it can never match'
      : undefined;
  }
  // `*.` is `*` written as a fully qualified name, which the matcher reads the same way.
  if (entry.replace(/\.$/, '') === '*') {
    return undefined;
  }
  const result = validateConfigEntry(entry, 'domain', {
    allowGlobalWildcard: true,
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
    return new URL(`http://${authority}/`).hostname;
  } catch {
    return undefined;
  }
}

/** A media-type pattern is `type/subtype`, `type/*` or `*\/*`; anything else matches nothing. */
function describeUnmatchableMediaTypePattern(
  entry: string,
): string | undefined {
  const mediaType = entry.split(';', 1)[0].trim();
  const slash = mediaType.indexOf('/');
  const type = mediaType.slice(0, slash);
  const subtype = mediaType.slice(slash + 1);
  if (
    entry.includes(',') ||
    /\s/.test(mediaType) ||
    slash <= 0 ||
    subtype === '' ||
    subtype.includes('/') ||
    // `*` only as a whole subtype (`image/*`) or as `*/*`.
    (subtype.includes('*') && subtype !== '*') ||
    (type.includes('*') && mediaType !== '*/*')
  ) {
    return "is not one media type such as 'application/json', 'image/*' or '*/*'";
  }
  return undefined;
}

/**
 * What one kind of callback's filter may hold: its list fields besides `methods` (the
 * ones `matchesFilter` has a value to test for that kind), and the phases it is reached in.
 */
export interface FilterKind {
  readonly fields: readonly string[];
  readonly phases: readonly string[];
}

/**
 * The lists of `filter`, each read once, checked and copied - so a getter is not read
 * again, and a list the caller changes later does not change what matches. Nullish means
 * the list is absent. Throws a `TypeError` naming `label` for anything else that is not
 * an array of the right kind of entry, or that names a phase, scheme or content type that
 * does not exist.
 */
/**
 * Every field name a filter answers to: its own, and those it inherits from a class or
 * prototype of the caller's, since the lists are read with `filter[field]`, which finds
 * a class instance's getters and a prototype's fields too.
 *
 * The walk stops at a realm's root prototype - any inherited object with no prototype of
 * its own, so a plain object from a `vm` context or an iframe stops at that realm's
 * `Object.prototype` as one from this realm stops at ours - and skips methods, which are
 * behaviour rather than fields.
 */
function filterFieldNames(filter: object): Set<string> {
  const names = new Set<string>();
  for (
    let current: object | null = filter;
    current !== null &&
    (current === filter || Object.getPrototypeOf(current) !== null);
    current = Object.getPrototypeOf(current) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (name !== 'constructor' && typeof descriptor?.value !== 'function') {
        names.add(name);
      }
    }
  }
  return names;
}

function copyFilterLists(
  filter: Record<string, unknown>,
  label: string,
  kind: FilterKind,
): Record<string, unknown[]> {
  // A field this kind of callback never sees is refused, as a misnamed one is: a
  // `statusCodes` on an error observer would be ignored, so it would match every error,
  // and a `contentTypes` on an interceptor would match nothing. Nullish is absent here as
  // it is below, so a filter object shared between kinds may leave the field undefined.
  for (const field of filterFieldNames(filter)) {
    if (
      field !== 'methods' &&
      !kind.fields.includes(field) &&
      !isNullish(filter[field])
    ) {
      throw new TypeError(
        `${label} filter has no ${JSON.stringify(field)} field (it takes ${['methods', ...kind.fields].join(', ')})`,
      );
    }
  }
  const lists: Record<string, unknown[]> = {};
  for (const [field, rule] of Object.entries(FILTER_LISTS)) {
    if (!kind.fields.includes(field)) {
      continue;
    }
    const value = filter[field];
    if (isNullish(value)) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(
        `${label} filter ${field} must be an array (got ${typeof value})`,
      );
    }
    const allowed = field === 'phases' ? kind.phases : rule.allowed;
    const list = [...(value as unknown[])];
    // Refused rather than given a meaning: an empty list read as "match nothing" leaves a
    // callback that never runs, and read as "match everything" turns `hosts: []` from a
    // config with no hosts into a callback that runs for every host. `phases: []` keeps
    // its documented meaning, every phase.
    if (list.length === 0 && field !== 'phases') {
      throw new TypeError(
        `${label} filter ${field} is empty; omit it to match every request`,
      );
    }
    for (const entry of list) {
      if (typeof entry !== rule.entryType) {
        throw new TypeError(
          `${label} filter ${field} must contain only ${rule.entryType}s (got ${entry === null ? 'null' : typeof entry})`,
        );
      }
      const problem =
        typeof entry === 'string'
          ? rule.check?.(entry)
          : rule.checkNumber?.(entry as number);
      if (problem !== undefined) {
        throw new TypeError(
          `${label} filter ${field} entry ${JSON.stringify(entry)} ${problem}`,
        );
      }
      if (allowed && !allowed.includes(entry as string)) {
        throw new TypeError(
          `${label} filter ${field} has ${JSON.stringify(entry)}, which is not one of ${allowed.map((name) => `'${name}'`).join(', ')}`,
        );
      }
    }
    lists[field] = list;
  }
  return lists;
}

type RemoveFn = () => void;

/** One registered callback and the filter it was added with, `phases` defaulted. */
export interface RegisteredCallback<Fn, Filter> {
  fn: Fn;
  filter?: Filter;
}

/**
 * The registrations behind a request-interceptor or observer manager, kept in the order
 * they were added. Each manager adds the chain it runs them as through `snapshot()`.
 */
export class CallbackRegistry<
  Fn,
  Filter extends { phases?: unknown; methods?: unknown },
> {
  private registrations: ReadonlyArray<RegisteredCallback<Fn, Filter>> = [];

  constructor(
    private readonly defaultPhases: Filter['phases'],
    private readonly label: string,
    /** The filter fields this kind of callback takes, and the phases it is reached in. */
    private readonly kind: FilterKind,
  ) {}

  public add(fn: Fn, filter?: Filter): RemoveFn {
    // Refused now, as a malformed filter is, rather than failing - or, for an observer,
    // being reported and skipped - on every request it would have run for.
    const callback: unknown = fn;
    if (typeof callback !== 'function') {
      throw new TypeError(
        `${this.label} must be a function (got ${callback === null ? 'null' : typeof callback})`,
      );
    }
    const candidate: unknown = filter;
    if (!isNullish(candidate) && typeof candidate !== 'object') {
      throw new TypeError(
        `${this.label} filter must be an object (got ${typeof candidate})`,
      );
    }
    const source = (candidate ?? {}) as Record<string, unknown>;
    // Each field read once, into a filter of the client's own: only the fields
    // `matchesFilter` reads are kept.
    const methods = normalizeFilterMethods(source.methods, this.label);
    const lists = copyFilterLists(source, this.label, this.kind);
    const entry: RegisteredCallback<Fn, Filter> = {
      fn,
      filter: {
        ...lists,
        phases: lists.phases ?? this.defaultPhases,
        methods,
      } as Filter,
    };
    // Replaced rather than changed in place, so a chain already holding the array keeps
    // the registrations it began with, and taking one needs no copy.
    this.registrations = [...this.registrations, entry];

    return () => {
      this.registrations = this.registrations.filter(
        (registered) => registered !== entry,
      );
    };
  }

  /** Whether nothing is registered, so a chain taken now would have nothing to run. */
  public get isEmpty(): boolean {
    return this.registrations.length === 0;
  }

  /**
   * The current registrations. Later `add()` and removal calls replace the array rather
   * than change it, so they do not reach a chain built from this one.
   */
  protected currentRegistrations(): ReadonlyArray<
    RegisteredCallback<Fn, Filter>
  > {
    return this.registrations;
  }
}
