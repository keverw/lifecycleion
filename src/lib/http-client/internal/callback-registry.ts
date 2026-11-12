import { isNullish } from '../../internal/is-nullish';
import { describeValue } from '../../internal/describe-value';
import {
  MAX_COPIED_ARRAY_LENGTH,
  readArrayLength,
} from '../../internal/array-copy';
import { MAX_PROTOTYPE_DEPTH } from '../../internal/prototype-depth';
import { readCopiedIndex } from '../../internal/array-indices';
import { isRealmRootPrototype } from './plain-record';
import { trimHTTPWhitespace } from '../../internal/ascii-text';
import { normalizeFilterMethods } from '../utils';
import { readHostPattern } from '../../domain-utils/host-filter';
import { validateHostFilterEntry } from '../../domain-utils/domain-utils';

/**
 * Every list a filter can carry besides `methods`: the type each entry must have and, for
 * a list of fixed names, the names allowed (`phases` is allowed per registry, since each
 * kind of callback is reached in its own phases). `matchesFilter` and `matchesFilterPhase`
 * test membership with `includes`/`some`, so a string in place of a list would match by
 * substring - `phases: 'initial,retry'` matching both - and a name no request can have
 * would match nothing, silently.
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
  // By `matchesHostFilter`'s rules, which the client's `hosts` filters match by.
  hosts: {
    entryType: 'string',
    check: (entry) => validateHostFilterEntry(entry).info,
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

/** A media-type pattern is `type/subtype`, `type/*` or `*\/*`; anything else matches nothing. */
function describeUnmatchableMediaTypePattern(
  entry: string,
): string | undefined {
  // Trimmed as a header's media type is matched, so a no-break space is refused here
  // rather than accepted into a pattern that matches nothing.
  const mediaType = trimHTTPWhitespace(entry.split(';', 1)[0]);
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

/** A filter's own fields, as {@link filterFieldsOf} finds them. */
interface FilterFields {
  readonly names: ReadonlySet<string>;
  /** The realm root prototype the walk stopped at, or `null` for a chain without one. */
  readonly root: object | null;
}

/**
 * Every field name a filter answers to: its own, and those it inherits from a class or
 * prototype of the caller's, since the lists are read from those too (see
 * {@link callerFilterValue}): a class instance's getters and a prototype's fields.
 *
 * The walk stops at a realm's root prototype (see `isRealmRootPrototype`), so a plain
 * object from a `vm` context or an iframe stops at that realm's `Object.prototype` as one
 * from this realm stops at ours. An inherited method is behaviour rather than a field and
 * is skipped; an own field is a field whatever its value. A chain over
 * {@link MAX_PROTOTYPE_DEPTH} prototypes deep, past the filter's own, throws a `RangeError`.
 */
function filterFieldsOf(filter: object): FilterFields {
  const names = new Set<string>();
  let current: object | null = filter;
  for (
    let depth = 0;
    current !== null && !isRealmRootPrototype(current);
    depth++
  ) {
    if (depth > MAX_PROTOTYPE_DEPTH) {
      throw new RangeError(
        `The prototype chain is over ${MAX_PROTOTYPE_DEPTH} deep`,
      );
    }

    for (const name of Object.getOwnPropertyNames(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      const isInheritedMethod =
        current !== filter && typeof descriptor?.value === 'function';
      if (name !== 'constructor' && !isInheritedMethod) {
        names.add(name);
      }
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return { names, root: current };
}

/**
 * {@link filterFieldsOf}, with a walk the caller's code makes throw - a `Proxy` whose
 * `ownKeys` or `getPrototypeOf` trap throws, or a chain too deep to walk - refused as a
 * `TypeError` naming `label`, its error as the `cause`.
 */
function listFilterFields(filter: object, label: string): FilterFields {
  try {
    return filterFieldsOf(filter);
  } catch (error) {
    throw new TypeError(`${label} filter fields could not be read`, {
      cause: error,
    });
  }
}

/**
 * `value`, read from a filter's `field`, unless it is a value polluted onto
 * `Object.prototype`: a field that is not one of `fields` and that the realm root
 * prototype the walk stopped at holds - as the very value read, or through an accessor,
 * which is not called again, and which answers every read whatever it returns. A `hosts`
 * polluted onto it would otherwise restrict every callback added with a filter. A
 * `Proxy` whose `get` trap answers a field it holds nowhere is read as it answers, unless
 * the root holds an accessor of that name.
 */
function callerFilterValue(
  value: unknown,
  field: string,
  fields: FilterFields,
  label: string,
): unknown {
  const { names, root } = fields;

  if (names.has(field) || root === null) {
    return value;
  }

  // The root is the caller's when it only looks like one - a `Proxy` holding the
  // `Object.prototype` method names - so its trap is guarded as the field's read is.
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(root, field);
  } catch (error) {
    throw fieldReadError(label, field, error);
  }

  return descriptor === undefined ||
    ('value' in descriptor && !Object.is(descriptor.value, value))
    ? value
    : undefined;
}

/** Fixed names - phases, schemes - quoted for an error message: `'initial', 'retry'`. */
function quoteNames(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(', ');
}

/**
 * A filter's `field`, read as it is checked: a getter of the caller's that throws -
 * a class instance's, a field it does not take included - is refused as a `TypeError`
 * naming the field, its error as the `cause`, rather than escaping raw from adding the
 * callback.
 */
function readFilterField(
  filter: Record<string, unknown>,
  field: string,
  label: string,
): unknown {
  try {
    return filter[field];
  } catch (error) {
    throw fieldReadError(label, field, error);
  }
}

/** The refusal of a filter `field` whose read threw `error`. */
function fieldReadError(
  label: string,
  field: string,
  error: unknown,
): TypeError {
  return new TypeError(
    `${label} filter ${JSON.stringify(field)} field could not be read`,
    { cause: error },
  );
}

/**
 * The lists of `filter`, each read once, checked and copied - so a getter is not read
 * again, and a list the caller changes later does not change what matches. Nullish means
 * the list is absent. Throws a `TypeError` naming `label` for anything else that is not
 * an array of the right kind of entry, or that names a phase, scheme or content type that
 * does not exist.
 */
function copyFilterLists(
  filter: Record<string, unknown>,
  fields: FilterFields,
  label: string,
  kind: FilterKind,
  /** The phases an omitted `phases` gives, named when an empty one is refused. */
  defaultPhases: readonly string[],
): Record<string, unknown[]> {
  // A field this kind of callback never sees is refused, as a misnamed one is: a
  // `statusCodes` on an error observer would be ignored, so it would match every error,
  // and a `contentTypes` on an interceptor would match nothing. Nullish is absent here as
  // it is below, so a filter object shared between kinds may leave the field undefined.
  for (const field of fields.names) {
    if (
      field !== 'methods' &&
      !kind.fields.includes(field) &&
      !isNullish(readFilterField(filter, field, label))
    ) {
      throw new TypeError(
        `${label} filter has no ${JSON.stringify(field)} field (it takes ${['methods', ...kind.fields].join(', ')})`,
      );
    }
  }
  // No prototype, so a field the caller left out reads as absent here and in
  // `matchesFilter`, never as one polluted onto `Object.prototype`.
  const lists = Object.create(null) as Record<string, unknown[]>;
  for (const [field, rule] of Object.entries(FILTER_LISTS)) {
    if (!kind.fields.includes(field)) {
      continue;
    }
    const value = callerFilterValue(
      readFilterField(filter, field, label),
      field,
      fields,
      label,
    );
    if (isNullish(value)) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(
        `${label} filter ${field} must be an array (got ${typeof value})`,
      );
    }
    const allowed = field === 'phases' ? kind.phases : rule.allowed;
    // Read by index, each item once (as `copyArrayValue` reads one), not through the
    // caller's iterator, which could yield entries other than those checked; a hole is
    // read as the `undefined` it is, and refused. Each checked as it is read, so a list
    // refused at one entry is read no further.
    const source = value as unknown[];
    const length = readArrayLength(
      source,
      `${label} filter ${field}`,
      MAX_COPIED_ARRAY_LENGTH,
    );
    const list: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const entry = readCopiedIndex(source, index);
      // Named by its place in the list, never its text.
      const entryName = `${label} filter ${field}[${String(index)}]`;
      if (typeof entry !== rule.entryType) {
        throw new TypeError(
          `${entryName} must be a ${rule.entryType} (got ${describeValue(entry)})`,
        );
      }
      const problem =
        typeof entry === 'string'
          ? rule.check?.(entry)
          : rule.checkNumber?.(entry as number);
      if (problem !== undefined) {
        throw new TypeError(`${entryName} ${problem}`);
      }
      if (allowed && !allowed.includes(entry as string)) {
        throw new TypeError(
          `${entryName} is not one of ${quoteNames(allowed)}`,
        );
      }
      list.push(entry);
    }
    // Refused rather than given a meaning: an empty list read as "match nothing" leaves a
    // callback that never runs, and read as "match everything" turns `hosts: []` from a
    // config with no hosts into a callback that runs for every host. `phases: []` is no
    // exception: omitting `phases` gives the kind's default phases, so either reading of
    // an empty list does something omitting it does not - "every phase" turning an auth
    // interceptor built from a flag list that came out empty loose on redirect and retry
    // hops. The hint says what omitting it does instead, which for `phases` is not
    // "every request".
    if (list.length === 0) {
      throw new TypeError(
        `${label} filter ${field} is empty; ${
          field === 'phases'
            ? `omit it for the default phases (${quoteNames(defaultPhases)}), or list each of ${quoteNames(kind.phases)} to match every phase`
            : 'omit it to match every request'
        }`,
      );
    }
    lists[field] = list;
  }
  return lists;
}

type RemoveFn = () => void;

/** One registered callback and the filter it was added with, `phases` defaulted. */
export interface RegisteredCallback<Fn, Filter> {
  fn: Fn;
  filter: Filter;
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
        `${this.label} must be a function (got ${describeValue(callback)})`,
      );
    }
    const candidate: unknown = filter;
    if (!isNullish(candidate) && typeof candidate !== 'object') {
      throw new TypeError(
        `${this.label} filter must be an object (got ${describeValue(candidate)})`,
      );
    }
    const source = (candidate ?? {}) as Record<string, unknown>;
    // Each field read once, into a filter of the client's own: only the fields
    // `matchesFilter` reads are kept. `methods` is read before the fields are listed, so
    // one a `methods` getter adds is listed - and refused, if this kind does not take it.
    const methodsValue = readFilterField(source, 'methods', this.label);
    const fields = listFilterFields(source, this.label);
    const methods = normalizeFilterMethods(
      callerFilterValue(methodsValue, 'methods', fields, this.label),
      this.label,
    );
    const lists = copyFilterLists(
      source,
      fields,
      this.label,
      this.kind,
      this.defaultPhases as readonly string[],
    );
    // Read once here, as the copy `matchesFilter` reads them from never changes.
    if (lists.hosts) {
      lists.hostPatterns = (lists.hosts as string[]).map(readHostPattern);
    }
    const entry: RegisteredCallback<Fn, Filter> = {
      fn,
      // Kept without a prototype, as `lists` is: `matchesFilter` reads every field on
      // each request, and one the caller left out must not be found on `Object.prototype`.
      filter: Object.assign(lists, {
        phases: lists.phases ?? this.defaultPhases,
        methods,
      }) as unknown as Filter,
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

/**
 * A phase object for one callback: its own copy, and its own copy of the redirect hop a
 * retry phase nests. One shared object would let an interceptor or observer that writes
 * to it - `phase.redirect.to = ...` - change what every later one in the chain is told.
 */
export function copyCallbackPhase<Phase extends object>(phase: Phase): Phase {
  const copy = { ...phase };
  const redirect: unknown = (copy as { redirect?: unknown }).redirect;

  if (typeof redirect === 'object' && redirect !== null) {
    (copy as { redirect?: unknown }).redirect = { ...redirect };
  }

  return copy;
}
