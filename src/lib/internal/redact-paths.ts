import { getPathParts } from './path-utils';
import { isPlainContainer } from './is-plain-container';
import { maskValueDeep } from './mask-value-deep';
import { resolveRedaction } from './resolve-redaction';
import {
  REDACTION_FAILED_MARKER,
  type RedactValueFunction,
} from './default-redact-function';
import {
  NOOP_REDACTION_REPORTER,
  type ReportRedactionFailure,
} from './redaction-reporter';

/** Decides the replacement for a redacted value. */
export type RedactLeafFunction = RedactValueFunction;

/** One parsed redaction entry, kept with the text the caller wrote. */
export interface RedactPath {
  /** Parsed segments, used for matching. */
  parts: string[];
  /**
   * The entry exactly as the caller wrote it. Handed to a custom `redactFunction` as the
   * key, so it sees `user.password` rather than the leaf `password`.
   */
  entry: string;
}

/**
 * Parse redaction entries into matchable paths.
 *
 * Shared so `sensitiveFieldNames` and `stringifyValue`'s `redactedKeys` agree on what an
 * entry means, and on the logger's syntax: a bare name is a top-level key, and
 * `user.password` or `items[0].token` addresses one location.
 *
 * @returns `null` when the list itself is unusable - not an array, or holding a
 *          non-string. Callers must treat that as a reason to mask everything rather
 *          than to mask nothing, since the caller asked for masking and this cannot tell
 *          what for.
 */
export function parseRedactPaths(value: unknown): RedactPath[] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }

    const paths: RedactPath[] = [];

    for (const entry of value as unknown[]) {
      if (typeof entry !== 'string') {
        return null;
      }

      // A bare name is a top-level key and is taken literally, without going through the
      // path grammar. An unquoted segment must not contain a delimiter, so an ordinary
      // name like `password-hash` is fine here but would need quoting inside a path.
      paths.push({ parts: [entry], entry });

      if (entry.includes('.') || entry.includes('[')) {
        // An entry with path syntax is ambiguous: it can name a nested location or one
        // literal key spelled that way. Both readings are covered, since leaving either
        // unmasked is the outcome redaction exists to prevent.
        const parts = getPathParts(entry);

        if (parts !== null && parts.length > 0) {
          paths.push({ parts, entry });
        }
      }
    }

    return paths;
  } catch {
    return null;
  }
}

/**
 * The originating entry when `path` matches one of `paths`, else `undefined`.
 *
 * Returns the entry rather than a boolean so a custom `redactFunction` can be handed the
 * key the caller actually wrote.
 */
export function matchRedactPath(
  paths: RedactPath[],
  path: string[],
): string | undefined {
  return paths.find(
    (candidate) =>
      candidate.parts.length === path.length &&
      candidate.parts.every((part, index) => part === path[index]),
  )?.entry;
}

/**
 * The entry of a path that addresses something *inside* `value`.
 *
 * Only asks whether the caller pointed inside, not whether the location is reachable.
 * Reachability is answered afterwards by whether anything was actually masked, which is
 * the honest test: if a mask landed, the value was rebuilt and its own `toString` is never
 * called, so nothing it might have printed can reach the output. If none did, the value
 * passes through and prints as it is - and only then does an unreachable path matter.
 *
 * Asking up front instead is what went wrong twice. `Object.keys` blanked a value whenever
 * one entry in a long-lived list went stale, even though the other entries masked it
 * perfectly well. `in` stopped doing that but could not see a symbol key, a private
 * `#field`, or a `Map` subclass's entries, all of which a `toString` still renders.
 *
 * @returns The entry as the caller wrote it, so a `redactFunction` sees the key it named.
 */
function findPathInto(paths: RedactPath[], path: string[]): string | undefined {
  return paths.find((candidate) => {
    if (candidate.parts.length <= path.length) {
      return false;
    }

    for (const [index, element] of path.entries()) {
      if (candidate.parts[index] !== element) {
        return false;
      }
    }

    return true;
  })?.entry;
}

/**
 * Returned by {@link redactPathsInner} when nothing under a value was masked.
 *
 * The walk hands back the original value rather than a rebuilt copy in that case, which
 * is what keeps a `Date`, an `Error`, a `Map`, a `URL`, or a class instance intact when
 * it merely sits alongside something redacted. Rebuilding unconditionally flattened
 * every one of those to `{}`: the rebuild reads `Object.entries`, which is empty for a
 * `Date` and a `Map`, and skips the non-enumerable `message` and `stack` of an `Error`.
 *
 * A distinct sentinel rather than an identity comparison against the input, because
 * `undefined` and a genuinely unchanged leaf are indistinguishable otherwise, and a
 * masked value may legitimately equal the value it replaced.
 */
const UNCHANGED = Symbol('redact-paths-unchanged');

/**
 * Records whether any genuine mask landed during one walk.
 *
 * A cycle and an unreadable set of keys both yield {@link REDACTION_FAILED_MARKER}, which
 * counts as a change so the container around them is rebuilt - necessary, because handing
 * back an original that points at a half-rebuilt ancestor would put unmasked values inside
 * the copy. But when *nothing* matched anywhere, there is no ancestor being rebuilt and
 * nothing to protect: the walk should hand back what it was given, exactly as it does when
 * it finds no match at all.
 *
 * Tracking a real mask separately is what tells the two apart, so a payload that merely
 * contains a cycle is not rewritten by a `redactedKeys` list that matches none of it.
 */
interface RedactState {
  didMaskAnything: boolean;
  /**
   * Set when a read failed and left the walk unable to see what lies below.
   *
   * Distinct from a cycle, and the distinction is load-bearing. A back-edge is a place the
   * walk already knows: the ancestor is on the stack being walked, so "nothing matched
   * anywhere" really does mean nothing under it matched. A set of keys that cannot be read
   * is the opposite - the walk never saw what was there, so it cannot conclude anything,
   * and a key named for redaction may be sitting behind the read that failed.
   *
   * Treating them alike hands back the original with that key unmasked, which is exactly
   * the leak the failure marker exists to prevent.
   */
  didFailToRead: boolean;
}

/**
 * Mask every matched path under `value`.
 *
 * @returns The rebuilt value, or {@link UNCHANGED} when no path matched anywhere beneath
 *          it - in which case the caller keeps the original, by reference. A container
 *          is copied only where a mask actually landed inside it, so redaction never
 *          rewrites the parts of a payload it was not asked to touch.
 */
function redactPathsInner(
  value: unknown,
  paths: RedactPath[],
  path: string[],
  redactFunction: RedactLeafFunction | undefined,
  seen: WeakSet<object>,
  state: RedactState,
  report: ReportRedactionFailure,
): unknown {
  const matched = matchRedactPath(paths, path);

  if (matched !== undefined) {
    // Marked before the attempt, not after: a mask that throws still yields the failure
    // marker, which must not be mistaken for "nothing happened here".
    state.didMaskAnything = true;

    try {
      return maskValueDeep(
        matched,
        value,
        (key, leaf, isDerived) =>
          resolveRedaction(key, leaf, isDerived, redactFunction),
        new WeakSet(),
        report,
      );
    } catch (error) {
      // Never fall back to the original: a failed redaction says so instead.
      report(error, matched);

      return REDACTION_FAILED_MARKER;
    }
  }

  if (value === null || typeof value !== 'object') {
    return UNCHANGED;
  }

  // Redaction walks exactly what the renderer walks: a plain object or an array, and
  // nothing else. Anything else is a single value here because it is a single value
  // there - an `Error` prints `Error: boom`, a class instance prints `[Session]`, a `Map`
  // prints `[Map]`, and none of them print their properties.
  //
  // Descending into them anyway is what let redaction *disclose*. Masking one field
  // rebuilt the value as a plain object, so the renderer stopped printing its string form
  // and printed its fields instead - and asking to hide `password` on a `Session` printed
  // the `internalToken` beside it, which no unredacted log line had ever shown. Redacted
  // output must differ from unredacted output only where something was masked.
  //
  // So a path pointing inside one masks the whole value. That is the only masking whose
  // result still prints the way the original did: one string in place of another.
  if (!isPlainContainer(value)) {
    const inside = findPathInto(paths, path);

    if (inside === undefined) {
      return UNCHANGED;
    }

    state.didMaskAnything = true;

    try {
      return maskValueDeep(
        inside,
        value,
        (key, leaf, isDerived) =>
          resolveRedaction(key, leaf, isDerived, redactFunction),
        new WeakSet(),
        report,
      );
    } catch (error) {
      report(error, inside);

      return REDACTION_FAILED_MARKER;
    }
  }

  if (seen.has(value)) {
    // A cycle counts as a change, so the parent is rebuilt around this marker.
    //
    // Passing the original through would be wrong here in a way it is not elsewhere: the
    // ancestor this points back at is still being walked, and if anything under it does
    // match, the copy being built would carry a reference to the *unmasked* original
    // instead of to the rebuilt version.
    return REDACTION_FAILED_MARKER;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      const source = value as unknown[];
      let didMask = false;

      // A plain `[]` filled by index, not `source.map`. `map` on a subclass goes through
      // `ArraySpeciesCreate`, which calls that subclass's constructor with a length - and
      // a constructor that validates its arguments throws from inside the walk, where
      // there is no `catch`, so one such value anywhere turned the entire payload into the
      // failure marker. The renderer walks the same array without trouble, which is
      // exactly the divergence between the two walks this design exists to remove.
      //
      // Rebuilding as a plain array also matches what redaction does everywhere else: a
      // masked container comes back plain, because the caller's own value must not be
      // mutated and its type cannot be reconstructed from outside.
      const copy: unknown[] = [];

      let length: number;

      try {
        length = source.length;
      } catch (error) {
        report(error, path.join('.') || '<root>');
        state.didFailToRead = true;

        return REDACTION_FAILED_MARKER;
      }

      // A counted index loop, and deliberately not `for...of source.entries()`: `entries`
      // is resolved off the array, so an own property shadowing it is caller code. One
      // that throws took the whole payload down, and one that yields different pairs
      // rebuilt the array from the lie - a generator yielding a single entry silently
      // dropped every other element. `map` is out for the same shape of reason: it runs
      // `ArraySpeciesCreate`, which calls a subclass constructor, and a constructor that
      // validates its arguments threw from inside the walk.
      //
      // Each element is read and rendered inside its own guard, exactly as the object
      // branch and the renderer both do, so one unreadable element degrades alone instead
      // of turning the entire payload into the marker.
      for (let index = 0; index < length; index++) {
        let result: unknown;

        // Read once and kept, exactly as the object branch keeps the value
        // `Object.entries` gave it. Reading again for the `UNCHANGED` path below emitted
        // a value the walk had never looked at: an element backed by an accessor need not
        // answer the same way twice, so the walk concluded "nothing matched" from the
        // first read and then copied the second - which could be a value a path did
        // match. It also ran every element's getter twice, which is the cost
        // `renderContainer` counts as worth avoiding for the same reason.
        let element: unknown;

        try {
          element = source[index];
        } catch (error) {
          report(error, [...path, String(index)].join('.'));
          state.didFailToRead = true;
          didMask = true;
          copy.push(REDACTION_FAILED_MARKER);

          continue;
        }

        try {
          result = redactPathsInner(
            element,
            paths,
            [...path, String(index)],
            redactFunction,
            seen,
            state,
            report,
          );
        } catch (error) {
          report(error, [...path, String(index)].join('.'));
          state.didFailToRead = true;
          didMask = true;
          copy.push(REDACTION_FAILED_MARKER);

          continue;
        }

        if (result === UNCHANGED) {
          copy.push(element);
        } else {
          didMask = true;
          copy.push(result);
        }
      }

      return didMask ? copy : UNCHANGED;
    }

    let entries: [string, unknown][];

    try {
      entries = Object.entries(value);
    } catch (error) {
      // The keys cannot be read, so the walk cannot tell whether something named for
      // redaction sits below. Handing back the original would risk returning it in the
      // clear, so this one value fails closed even though nothing under it matched.
      report(error, path.join('.') || '<root>');
      state.didFailToRead = true;

      return REDACTION_FAILED_MARKER;
    }

    const copy: Record<string, unknown> = {};
    let didMask = false;

    for (const [key, entryValue] of entries) {
      let result: unknown;

      // Guarded per entry, exactly as the array branch above and the renderer both are.
      //
      // Defensive rather than a fix for a reproduced failure, and the only guard here
      // that is: `Object.entries` has already run every getter, so no hostile accessor
      // reaches this call, and the one thing left that could throw is stack exhaustion on
      // a payload nested past the recursion limit - which neither redaction walk caps and
      // which measurement could not actually provoke here (200k levels deep still
      // completes on Bun 1.4). It stays because the alternative is one branch of one walk
      // being the single place a throw escapes: `redactValue` and `applyRedaction` would
      // then fail the *whole* payload closed where the array branch degrades one entry,
      // and a divergence between these walks is the bug class this design exists to
      // remove. Costing nothing on the hot path, it is not worth leaving as the exception.
      try {
        result = redactPathsInner(
          entryValue,
          paths,
          [...path, key],
          redactFunction,
          seen,
          state,
          report,
        );
      } catch (error) {
        // The walk never saw what was below, so it cannot conclude nothing matched there.
        report(error, [...path, key].join('.'));
        state.didFailToRead = true;
        result = REDACTION_FAILED_MARKER;
      }

      if (result !== UNCHANGED) {
        didMask = true;
      }

      // Defined rather than assigned: a plain assignment to `__proto__` is a no-op for a
      // string and reparents the object for an object, so a payload carrying that key
      // would silently lose the entry or change the shape of the result.
      Object.defineProperty(copy, key, {
        value: result === UNCHANGED ? entryValue : result,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    // Only a container something was actually masked inside is rebuilt. Anything else is
    // handed back as it came in, so a `Date`, an `Error`, a `Map`, a `RegExp`, a `URL`,
    // or a class instance keeps its type and its contents - including the members a
    // rebuild would drop, since `Object.entries` sees neither a `Date`'s timestamp nor an
    // `Error`'s `message` and `stack`.
    //
    // A container that *was* masked inside is necessarily rebuilt as a plain object: the
    // caller's own value must not be mutated, and a class instance cannot be reconstructed
    // from the outside. Losing the type there is the deliberate price of masking within it.
    // Only a plain container reaches here, and its own entries are the whole of what the
    // renderer prints, so a path naming one it does not have reaches nothing - exactly as
    // a typo does, and masking over that would blank a payload for a misspelling.
    return didMask ? copy : UNCHANGED;
  } finally {
    seen.delete(value);
  }
}

/**
 * Return `value` with every path in `paths` masked, keeping the shape.
 *
 * The one walk both the logger's `redactedKeys` and `stringifyValue` use, so an entry
 * addresses the same thing and masks the same way in either.
 *
 * The input is never mutated. Copies are built only along the branches that lead to a
 * mask; every other part of the value is passed through by reference, so a payload that
 * names one key does not have the rest of itself rewritten.
 */
export function redactMatchedPaths(
  value: unknown,
  paths: RedactPath[],
  redactFunction: RedactLeafFunction | undefined,
  report: ReportRedactionFailure = NOOP_REDACTION_REPORTER,
): unknown {
  const state: RedactState = {
    didMaskAnything: false,
    didFailToRead: false,
  };

  const result = redactPathsInner(
    value,
    paths,
    [],
    redactFunction,
    new WeakSet(),
    state,
    report,
  );

  // Nothing matched anywhere, so there is nothing to copy: the caller's own value is the
  // correct answer, unchanged and un-flattened.
  //
  // `state` covers what the sentinel alone cannot. A cycle yields the failure marker and
  // so reads as a change - which it has to, to keep an unmasked original out of a copy
  // being rebuilt around it. With no real mask anywhere there is no such copy, so a
  // payload that merely contains a cycle is handed back as it came in rather than
  // rewritten by a list that matched none of it.
  //
  // A failed *read* is excluded from that shortcut. It is not evidence of absence: the
  // walk never saw what was behind it, so "nothing matched" says nothing about whether a
  // redacted key sits there, and handing back the original would return it in the clear.
  if (result === UNCHANGED) {
    return value;
  }

  return state.didMaskAnything || state.didFailToRead ? result : value;
}
