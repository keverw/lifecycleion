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
export class CallbackRegistry<Fn, Filter extends { phases?: unknown }> {
  private registrations: RegisteredCallback<Fn, Filter>[] = [];

  constructor(private readonly defaultPhases: Filter['phases']) {}

  public add(fn: Fn, filter?: Filter): RemoveFn {
    const entry: RegisteredCallback<Fn, Filter> = {
      fn,
      filter: {
        ...filter,
        phases: filter?.phases ?? this.defaultPhases,
      } as Filter,
    };
    this.registrations.push(entry);

    return () => {
      const idx = this.registrations.indexOf(entry);

      if (idx !== -1) {
        this.registrations.splice(idx, 1);
      }
    };
  }

  /** Whether nothing is registered, so a chain taken now would have nothing to run. */
  public get isEmpty(): boolean {
    return this.registrations.length === 0;
  }

  /**
   * The current registrations, copied so that later `add()` and removal calls do not
   * reach a chain built from them.
   */
  protected copyRegistrations(): RegisteredCallback<Fn, Filter>[] {
    return this.registrations.slice();
  }
}
