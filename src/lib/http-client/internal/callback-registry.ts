import { isNullish } from '../../internal/is-nullish';
import { normalizeFilterMethods } from '../utils';

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
  { entryType: 'string' | 'number'; allowed?: readonly string[] }
> = {
  phases: { entryType: 'string' },
  hosts: { entryType: 'string' },
  schemes: { entryType: 'string', allowed: ['http', 'https'] },
  bodyContainsKeys: { entryType: 'string' },
  statusCodes: { entryType: 'number' },
  contentTypes: { entryType: 'string', allowed: ['json', 'text', 'binary'] },
  contentTypeHeaders: { entryType: 'string' },
};

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
function copyFilterLists(
  filter: Record<string, unknown>,
  label: string,
  kind: FilterKind,
): Record<string, unknown[]> {
  // A field this kind of callback never sees is refused, as a misnamed one is: a
  // `statusCodes` on an error observer would be ignored, so it matched every error, and a
  // `contentTypes` on an interceptor would match nothing.
  for (const field of Object.keys(filter)) {
    if (field !== 'methods' && !kind.fields.includes(field)) {
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
    for (const entry of list) {
      if (typeof entry !== rule.entryType) {
        throw new TypeError(
          `${label} filter ${field} must contain only ${rule.entryType}s (got ${entry === null ? 'null' : typeof entry})`,
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
