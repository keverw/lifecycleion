import { isNullish } from '../../internal/is-nullish';
import { normalizeFilterMethods } from '../utils';

/**
 * Every list a filter can carry besides `methods`, with the type each entry must have.
 * `matchesFilter` tests membership with `includes`/`some`, so a string in place of a list
 * would match by substring - `phases: 'initial,retry'` matching both - and anything else
 * would throw on every request.
 */
const FILTER_LISTS = {
  phases: 'string',
  hosts: 'string',
  schemes: 'string',
  bodyContainsKeys: 'string',
  statusCodes: 'number',
  contentTypes: 'string',
  contentTypeHeaders: 'string',
} as const;

/**
 * The lists of `filter`, each read once, checked and copied - so a getter is not read
 * again, and a list the caller changes later does not change what matches. Nullish means
 * the list is absent. Throws a `TypeError` naming `label` for anything else that is not
 * an array of the right kind of entry.
 */
function copyFilterLists(
  filter: Record<string, unknown>,
  label: string,
): Record<string, unknown[]> {
  const lists: Record<string, unknown[]> = {};
  for (const [field, entryType] of Object.entries(FILTER_LISTS)) {
    const value = filter[field];
    if (isNullish(value)) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new TypeError(
        `${label} filter ${field} must be an array (got ${typeof value})`,
      );
    }
    const list = [...(value as unknown[])];
    for (const entry of list) {
      if (typeof entry !== entryType) {
        throw new TypeError(
          `${label} filter ${field} must contain only ${entryType}s (got ${entry === null ? 'null' : typeof entry})`,
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
  ) {}

  public add(fn: Fn, filter?: Filter): RemoveFn {
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
    const lists = copyFilterLists(source, this.label);
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
