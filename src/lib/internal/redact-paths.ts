import { getPathParts } from './path-utils';
import { defineEntry } from './container-entries';
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
export function findPathInto(
  paths: RedactPath[],
  path: string[],
): string | undefined {
  // Nothing addresses the root itself. Paths are rooted *at* the value, so the shortest
  // one names an entry of it, and the prefix test below is vacuously true for every entry
  // when `path` is empty - which made any non-empty `redactedKeys` blank a non-plain value
  // handed straight to `redactValue` or `stringifyValue`. `['password']` turned
  // `new Error('boom')` into `***REDACTED***`, though a bare name addresses a top-level
  // key and an `Error` has none to address: a path naming an entry a value lacks must
  // reach nothing rather than blanking the payload.
  if (path.length === 0) {
    return undefined;
  }

  return pathPointingBelow(paths, path)?.entry;
}

/**
 * The first entry that addresses something strictly below `path`, if any.
 *
 * The prefix test on its own, without {@link findPathInto}'s rule about the root. The two
 * questions are different and only one of them excludes the root: "should this value be
 * masked whole" is meaningless for the value the paths are rooted at, while "can anything
 * below here match" is exactly what has to be asked of it before walking into it.
 */
function pathPointingBelow(
  paths: RedactPath[],
  path: string[],
): RedactPath | undefined {
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
  });
}

/**
 * Whether a subtree that no path addresses still has to be walked in full.
 *
 * A container with no candidate beneath it masks nothing, so the walk's whole output for
 * it is the value that went in - which it reaches by rebuilding every object and array
 * below it and then throwing all of that away when nothing turns out to have matched. On
 * a payload of any size that is the dominant cost of redacting, and it is spent to learn
 * something the parsed paths already knew.
 *
 * It cannot simply be skipped, though, and this is what the skip has to rule out first:
 *
 * - **A back-edge into an ancestor.** Handing back the original is safe for a value
 *   nothing points out of, but a subtree holding a reference *up* to an ancestor that is
 *   being rebuilt would carry the unmasked original into the result, where a structured
 *   sink reads it. That is the one case {@link REDACTION_FAILED_MARKER} exists for here.
 * - **A read that throws.** The walk marks a container whose keys or elements cannot be
 *   read, and degrades per entry rather than per payload. Rather than reproduce any of
 *   that, a failed read here just says "walk it properly".
 *
 * Both answers are conservative in the same direction: anything unusual falls back to the
 * full walk, which is unchanged and still decides the output. The scan only ever removes
 * work that would have produced the input.
 *
 * Traversal mirrors the walk's exactly - plain containers only, own enumerable keys, one
 * read per element - so it cannot conclude "nothing below" about a place the walk would
 * have entered. On the fallback path a value is read twice, once here and once by the
 * walk; only the walk's read reaches the output, and nothing in a subtree with no
 * candidate is masked either way, so the second read cannot change what is emitted.
 *
 * @param visited Nodes this scan has already entered. Without it the scan is not a walk
 *        of the graph but of every *route* through it, and both shapes that produces are
 *        real. A subtree that reuses one object across `n` references is scanned `2^n`
 *        times. A cycle closing below the scan root - rather than back into an ancestor,
 *        which `seen` catches - is not a cycle to this function at all, so it recursed
 *        until the stack ran out: the `RangeError` reached {@link mustWalkInFull}, which
 *        answered "walk it properly" correctly, but only after running every getter in
 *        the loop thousands of times over. A three-node cycle holding fifty accessors
 *        cost 625,550 reads against the hundred this promises.
 *
 *        A revisit answers `false`, and that is the same answer in both shapes. A node
 *        that had already *finished* returned `false`, since one returning `true` bails
 *        the whole scan out at once and there is no second route to take. A node still on
 *        the scan stack is a cycle contained entirely within this subtree, which nothing
 *        needs to mask: the subtree is handed back by reference, so the loop stays inside
 *        a value that was never rebuilt, and the back-edge hazard the failure marker
 *        exists for - a reference *up* into an ancestor mid-rebuild - is what `seen`
 *        answers, separately and unchanged.
 */
function needsFullWalk(
  value: unknown,
  seen: WeakSet<object>,
  visited: Set<object>,
): boolean {
  if (!isPlainContainer(value)) {
    return false;
  }

  if (seen.has(value)) {
    return true;
  }

  if (visited.has(value)) {
    return false;
  }

  visited.add(value);

  if (Array.isArray(value)) {
    let length: number;

    try {
      length = value.length;
    } catch {
      return true;
    }

    for (let index = 0; index < length; index++) {
      let element: unknown;

      try {
        element = value[index];
      } catch {
        return true;
      }

      if (needsFullWalk(element, seen, visited)) {
        return true;
      }
    }

    return false;
  }

  let keys: string[];

  try {
    keys = Object.keys(value);
  } catch {
    return true;
  }

  for (const key of keys) {
    let entry: unknown;

    try {
      entry = (value as Record<string, unknown>)[key];
    } catch {
      return true;
    }

    if (needsFullWalk(entry, seen, visited)) {
      return true;
    }
  }

  return false;
}

/** {@link needsFullWalk}, with a payload too deep to scan counting as "walk it". */
function mustWalkInFull(value: unknown, seen: WeakSet<object>): boolean {
  try {
    // A fresh set per scan, not one shared across the walk: `seen` differs between
    // scans, so a node that answered `false` under one ancestor chain is not answering
    // the same question under another.
    return needsFullWalk(value, seen, new Set());
  } catch {
    // A `RangeError` from a payload nested past the stack, and nothing else: every read
    // the scan makes is already guarded.
    return true;
  }
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
  /**
   * Nodes already walked, inside a region no path can reach, that came back
   * {@link UNCHANGED}.
   *
   * `seen` is released as the walk leaves a node, deliberately, so a value referenced
   * twice side by side is walked both times rather than the second being called a cycle.
   * That makes the walk one of every *route* through the payload rather than of the
   * payload, and a subtree reachable by two references is therefore walked twice, its own
   * shared children four times, and so on: an object graph of 53 objects nested 26 deep,
   * with each level holding the same child under two keys, took 2.7 seconds, and 61
   * objects took roughly 44. This is what bounds that to one walk per node.
   *
   * Two conditions make the memo sound, and both are load-bearing:
   *
   * - **Only inside a skipped region.** A result is keyed on the node alone, but the walk
   *   answers a question about the node *at a path*. Where an ancestor's scan already
   *   established that no path points below it, nothing at or beneath it can match, so
   *   the path stops mattering and the node alone determines the answer.
   * - **Only {@link UNCHANGED}.** A cycle yields the failure marker, and whether a
   *   back-edge closes depends on the route, not on the node - so a marker must never be
   *   replayed onto a route where the same node is not in a cycle. `UNCHANGED` cannot be
   *   wrong in that direction: it is returned only when nothing beneath produced a marker
   *   on this route, and a node whose subtree reaches back into itself produces one on
   *   every route that walks it, this one included.
   */
  noMatchUnchanged: WeakSet<object>;
}

/**
 * Mask every matched path under `value`.
 *
 * @returns The rebuilt value, or {@link UNCHANGED} when no path matched anywhere beneath
 *          it - in which case the caller keeps the original, by reference. A container
 *          is copied only where a mask actually landed inside it, so redaction never
 *          rewrites the parts of a payload it was not asked to touch.
 *
 * @param shouldSkipCandidateScan Set once an ancestor's {@link mustWalkInFull} has
 *        already answered "walk it properly", so the scan is not repeated below it.
 *        Without this the same subtree was scanned again at every level beneath the node
 *        that failed the scan, which is `O(depth x subtree)`: a 4000-deep chain ending in
 *        a back-edge cost 235ms against 0.1ms for the same chain without the cycle, and
 *        every getter in it ran once per ancestor level. Nothing is lost by inheriting
 *        the answer. A node is scanned only when no path points below it, which means
 *        nothing under it matches, which means the same is true of every one of its
 *        descendants - so the scan they skip is one whose only possible outcome is the
 *        full walk they are already doing.
 */
function redactPathsInner(
  value: unknown,
  paths: RedactPath[],
  path: string[],
  redactFunction: RedactLeafFunction | undefined,
  seen: WeakSet<object>,
  state: RedactState,
  report: ReportRedactionFailure,
  shouldSkipCandidateScan = false,
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

  // Already walked, under an ancestor that established nothing here can match, and found
  // to change nothing. See `RedactState.noMatchUnchanged` for why the node alone is
  // enough to key that on here and nowhere else.
  if (shouldSkipCandidateScan && state.noMatchUnchanged.has(value)) {
    return UNCHANGED;
  }

  // Nothing below can match, so the walk's answer for this whole subtree is the subtree
  // itself - reached, without this, by rebuilding all of it and discarding the rebuild.
  //
  // Scanned at most once per branch: an ancestor that already scanned and was told to
  // walk in full passes that answer down rather than having each level rediscover it.
  let shouldSkipScanBelow = shouldSkipCandidateScan;

  if (
    !shouldSkipCandidateScan &&
    pathPointingBelow(paths, path) === undefined
  ) {
    if (!mustWalkInFull(value, seen)) {
      return UNCHANGED;
    }

    shouldSkipScanBelow = true;
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

        // Read once and kept, exactly as the object branch keeps the entry it read.
        // Reading again for the `UNCHANGED` path below emitted
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
            shouldSkipScanBelow,
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

      if (didMask) {
        return copy;
      }

      recordUnchanged(value, shouldSkipCandidateScan, state);

      return UNCHANGED;
    }

    // Keys first, then each value read inside its own guard - not `Object.entries`, which
    // runs every getter under one `catch`, so a single unrelated throwing accessor failed
    // the whole container closed and lost every sibling, the one a path named included.
    // The array branch above and the renderer both degrade one entry at a time.
    let keys: string[];

    try {
      keys = Object.keys(value);
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

    for (const key of keys) {
      let result: unknown;
      let entryValue: unknown;

      // Read once and kept, as the array branch keeps its element: a value read again
      // for the `UNCHANGED` path below need not answer the same way twice.
      try {
        entryValue = (value as Record<string, unknown>)[key];
      } catch (error) {
        // The walk never saw what was here, so it cannot conclude nothing matched.
        report(error, [...path, key].join('.'));
        state.didFailToRead = true;
        didMask = true;
        defineEntry(copy, key, REDACTION_FAILED_MARKER);

        continue;
      }

      // Guarded per entry, exactly as the array branch above and the renderer both are.
      try {
        result = redactPathsInner(
          entryValue,
          paths,
          [...path, key],
          redactFunction,
          seen,
          state,
          report,
          shouldSkipScanBelow,
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
      defineEntry(copy, key, result === UNCHANGED ? entryValue : result);
    }

    // Only a container something was actually masked inside is rebuilt. Anything else is
    // handed back as it came in, so a `Date`, an `Error`, a `Map`, a `RegExp`, a `URL`,
    // or a class instance keeps its type and its contents - including the members a
    // rebuild would drop, since `Object.keys` sees neither a `Date`'s timestamp nor an
    // `Error`'s `message` and `stack`.
    //
    // A container that *was* masked inside is necessarily rebuilt as a plain object: the
    // caller's own value must not be mutated, and a class instance cannot be reconstructed
    // from the outside. Losing the type there is the deliberate price of masking within it.
    // Only a plain container reaches here, and its own entries are the whole of what the
    // renderer prints, so a path naming one it does not have reaches nothing - exactly as
    // a typo does, and masking over that would blank a payload for a misspelling.
    if (didMask) {
      return copy;
    }

    recordUnchanged(value, shouldSkipCandidateScan, state);

    return UNCHANGED;
  } finally {
    seen.delete(value);
  }
}

/**
 * Note that `value` walked to {@link UNCHANGED}, when that answer can be reused.
 *
 * Only inside a region an ancestor's scan already cleared, and only for `UNCHANGED`; see
 * `RedactState.noMatchUnchanged` for why both conditions are what make the memo sound.
 */
function recordUnchanged(
  value: object,
  isInSkippedRegion: boolean,
  state: RedactState,
): void {
  if (!isInSkippedRegion) {
    return;
  }

  try {
    state.noMatchUnchanged.add(value);
  } catch {
    // Not a usable `WeakSet` key, so this node is simply walked again if it recurs.
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
    noMatchUnchanged: new WeakSet(),
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
