/**
 * The one place a container's own enumeration is read.
 *
 * Six walks in this library traverse caller data - `renderContainer`, `maskValueDeep`,
 * `redactPathsInner`, `errorToString`'s `stringifyValueInner`, `ArraySink`'s
 * `snapshotValue`, and `redactPathsInner`'s candidate scan - and every one of them opens
 * the same way: ask whether it is an array, read `length` or `Object.keys` inside a guard,
 * and decide what to emit when the read refuses. They differ enormously *after* that -
 * different output types, cycle verdicts, depth caps, budgets, change-tracking - and those
 * differences are deliberate, which is why there is no shared walk here. What they have no
 * business disagreeing about is the enumeration itself.
 *
 * They disagreed anyway. `errorToString` swallowed a refused `ownKeys` into an empty key
 * list at two of its reads, so an error whose `additionalInfo` could not be enumerated
 * rendered as an error that simply carried none, while the other four all emitted a marker
 * saying the read had failed. That is the shape of bug this module exists to make
 * unwritable: {@link ContainerShape} carries `'unreadable'` as a case the compiler will not
 * let a caller forget, so "what do I emit when I cannot read this" has to be answered
 * rather than defaulted.
 *
 * Deliberately *not* a walk. This answers one question about one container and returns;
 * recursion, cycles, budgets and output shape stay with the caller that owns them.
 */

/**
 * What a container will admit to holding, or that asking threw.
 *
 * `'unreadable'` carries the thrown value because two callers report it -
 * `maskValueDeep` and `redactPathsInner` both hand it to a `ReportRedactionFailure` so a
 * broken payload leaves a diagnosis and not only a marker. Callers that have nothing to
 * report with simply ignore it.
 */
export type ContainerShape =
  | { kind: 'array'; length: number }
  | { kind: 'object'; keys: string[] }
  | { kind: 'unreadable'; error: unknown };

/**
 * Read what `value` holds, without trusting it to answer.
 *
 * `Array.isArray`, `length` and `Object.keys` are all inside the guard, and all three
 * genuinely refuse: `Array.isArray` throws on a revoked `Proxy`, `length` is an ordinary
 * property a subclass can turn into a throwing accessor, and `ownKeys` is a trap. A caller
 * that has already established `isPlainContainer(value)` still needs this, because that
 * question and this one fail independently.
 *
 * Own enumerable string keys only, matching what every walk already read and what the
 * renderers print. A symbol key, a non-enumerable one, and one carried on a prototype are
 * outside what these walks address - see `applyRedaction`'s `normalizeParamsBag` for the
 * one place that deliberately widens it, and why.
 *
 * @returns The container's shape, or `'unreadable'` when asking threw. Never throws.
 */
export function describeContainer(value: object): ContainerShape {
  try {
    if (Array.isArray(value)) {
      return { kind: 'array', length: (value as unknown[]).length };
    }

    return { kind: 'object', keys: Object.keys(value) };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}

/**
 * Write one entry into a container being rebuilt.
 *
 * Defined rather than assigned, and that is the whole reason this is a function: a plain
 * assignment to `__proto__` is a no-op for a string value and *reparents the object* for
 * an object one, so a payload carrying that key silently lost the entry or changed the
 * shape of the result. Five walks rebuild containers and all five need the same
 * incantation; written out five times, it is five chances to write `copy[key] = value`
 * instead.
 *
 * Writable and configurable so the rebuilt container behaves like the plain object or
 * array a caller expects to receive, rather than a frozen approximation of one.
 */
export function defineEntry(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}
