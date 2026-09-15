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

// A cycle on paper - `redact-paths` imports this module - and harmless in practice: the
// constant is read inside `describeContainer`, never while either module is evaluating, so
// whichever of the two loads first sees it initialized by the time any walk runs. Imported
// rather than copied so the cap the walks bill against and the one this enforces cannot
// drift apart.
import { MAX_REDACTION_ENTRIES } from './redact-paths';

/**
 * What a container will admit to holding, or that asking threw.
 *
 * `'unreadable'` carries the thrown value because two callers report it -
 * `maskValueDeep` and `redactPathsInner` both hand it to a `ReportFormatFailure` so a
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
 * An object with more than {@link MAX_REDACTION_ENTRIES} keys is `'unreadable'` too, and
 * that is a refusal rather than a read that threw. Every walk bills each entry it visits
 * against that cap, and an array's `length` is only ever a number to compare against it -
 * but an object's keys arrive as a list, and a `Proxy` whose `ownKeys` trap invents
 * millions of them hands over the whole list before any per-entry budget has run.
 * `Object.keys` itself cannot be stopped short (a trap returns the list whole, and there
 * is no way to ask for the first `n`), so that allocation is the one cost this cannot
 * refuse; what it does refuse is everything after it. Reported as the shape the callers
 * already fail closed on rather than as an `'object'` with a truncated key list: a partial
 * copy stands in for the original and silently loses every entry past the bound, where the
 * marker every caller emits for `'unreadable'` says the container was not read - the same
 * answer `redact-normalization` gives an array whose `length` is past the cap, and the one
 * `applyRedaction` gives a root bag with that many keys.
 *
 * @returns The container's shape, or `'unreadable'` when asking threw or the answer was
 *          too large to walk. Never throws.
 */
export function describeContainer(value: object): ContainerShape {
  try {
    if (Array.isArray(value)) {
      return { kind: 'array', length: (value as unknown[]).length };
    }

    const keys = Object.keys(value);

    if (keys.length > MAX_REDACTION_ENTRIES) {
      // The list is dropped here rather than handed back, so nothing downstream can walk
      // or copy it. The count alone is safe to say: it is a number, not a value.
      return {
        kind: 'unreadable',
        error: new Error(
          `container has ${String(keys.length)} keys, more than the ${String(MAX_REDACTION_ENTRIES)} any walk may visit; it was not read`,
        ),
      };
    }

    return { kind: 'object', keys };
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
/**
 * The largest value that is an array *index* rather than an ordinary named property.
 *
 * An index is a key whose `ToString(ToUint32(key))` is the key itself, which stops one
 * short of `length`'s own maximum. `"-1"` and `"4294967296"` are therefore named
 * properties, not indexes - and a `parseInt` round-trip calls both of them indexes, which
 * is how a first cut of the named-property pass below silently dropped them.
 */
const MAX_ARRAY_INDEX = 2 ** 32 - 2;

/** Whether `key` addresses an array slot, as opposed to being a name that merely looks numeric. */
export function isArrayIndexKey(key: string): boolean {
  const asNumber = Number(key);

  return (
    Number.isInteger(asNumber) &&
    asNumber >= 0 &&
    asNumber <= MAX_ARRAY_INDEX &&
    String(asNumber) === key
  );
}

/**
 * An array's own enumerable keys that are *not* indexes.
 *
 * `describeContainer` reports an array as a length, which is what both walks iterate - so
 * a named property on an array is invisible to them while the renderer resolves it with an
 * ordinary property read. That divergence is the whole reason this exists.
 */
export function namedArrayKeys(source: object): string[] {
  const keys = Object.keys(source);
  const named: string[] = [];

  // Bounded on the named keys themselves, counted as the filter finds them, and not on
  // the total or on the total past `length`. A dense array of a million and one
  // elements has that many index keys and nothing named, so a bound on the total
  // refused it for its elements alone; a bound on the keys past `length` trusted a
  // `length` a `Proxy` can set to anything, so a trap claiming `Number.MAX_SAFE_INTEGER`
  // hid any list behind it. Counting what would actually be returned answers both: the
  // list a trap's `ownKeys` hands over cannot be cut short, but the walk over it stops
  // the moment it has found more named keys than any caller may visit. Thrown rather
  // than returned, because every caller already wraps this in the guard that treats a
  // refused enumeration as "could not be read" - reported and marked - and that is the
  // right answer for a list this long too.
  for (const key of keys) {
    if (isArrayIndexKey(key)) {
      continue;
    }

    if (named.length >= MAX_REDACTION_ENTRIES) {
      throw new Error(
        `array has more than ${String(MAX_REDACTION_ENTRIES)} named own keys, more than any walk may visit; its named properties were not read`,
      );
    }

    named.push(key);
  }

  return named;
}
