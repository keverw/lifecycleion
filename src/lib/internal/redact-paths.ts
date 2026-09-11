import { getPathParts } from './path-utils';
import { defineEntry, describeContainer } from './container-entries';
import { isPlainContainer } from './is-plain-container';
import { maskValueDeep } from './mask-value-deep';
import { resolveRedaction } from './resolve-redaction';
import {
  REDACTION_FAILED_MARKER,
  type RedactValueFunction,
} from './default-redact-function';
import {
  NOOP_FORMAT_REPORTER,
  type ReportFormatFailure,
} from './format-reporter';

/** Decides the replacement for a redacted value. */
export type RedactLeafFunction = RedactValueFunction;

/**
 * Copies that stand in for another container, as `copy -> the container it forwards to`.
 *
 * `normalizeParamsBag` and `forwardingContainerCopy` hand the walk a *copy* whose keys
 * forward to the caller's container, and install that copy in place of the original. The
 * walk's cycle guard keys on object identity, so a back-edge elsewhere in the payload -
 * still pointing at the original - was no longer recognized as the node being walked. The
 * guard never fired, the original subtree was handed back by reference, and a key named in
 * `redactedKeys` reached every sink in clear text: `const c = { password: 's' }; c.self =
 * c;` rendered the secret through `self`.
 *
 * **Passed in, not marked on the object, and that is deliberate.** The obvious
 * implementation is a symbol property on the copy, and it is wrong three ways here:
 *
 * - `tsup` builds this package with `splitting: false` across 39 entry points in both CJS
 *   and ESM, so this module is *copied into every bundle that reaches it*. A
 *   `Symbol('...')` is evaluated once per copy, so `dist/lib/logger` and
 *   `dist/lib/stringify-value` would hold different symbols for the same concept - and a
 *   mark written by one copy and read by another reads as absent, silently restoring the
 *   leak above. `Symbol.for` would fix that and give up the next two points.
 * - A registry symbol is forgeable. A caller could stamp their own payload and steer the
 *   cycle guard; harmless in direction (it only ever over-redacts) but not something to
 *   hand out.
 * - A property on the copy is a strong reference to the *unmasked original*, riding along
 *   on the `redactedParams` a sink receives. Nothing enumerates it, but there is no reason
 *   to put it there at all.
 *
 * A map built by the caller that made the copies, and read only during the walk it was
 * built for, has none of those properties: no module identity, nothing to forge, and
 * nothing left on the result.
 */
export type ForwardingAliases = WeakMap<object, object>;

/** Whether the walk is already inside `value`, counting the container it forwards to. */
function isSeen(
  value: object,
  seen: WeakSet<object>,
  aliases: ForwardingAliases | undefined,
): boolean {
  if (seen.has(value)) {
    return true;
  }

  const origin = aliases?.get(value);

  return origin !== undefined && seen.has(origin);
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
function isArrayIndexKey(key: string): boolean {
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
function namedArrayKeys(source: object): string[] {
  return Object.keys(source).filter((key) => !isArrayIndexKey(key));
}

/**
 * How many container entries one redaction pass will visit before it fails closed.
 *
 * The walks iterate an array by `shape.length`, and `length` is not a fact: `Array.isArray`
 * is true for a `Proxy` over an array, and `length` is an ordinary writable property a
 * `get` trap may answer with any number. A proxy reporting `5_000_000` spun `applyRedaction`
 * for 1.3 seconds *synchronously inside `logger.info()`*, and `2 ** 32 - 1` is about twenty
 * minutes of it. A real `new Array(20_000_000)` costs the same, for the same reason.
 *
 * Every other walk over caller data in this library is bounded - `renderContainer` breaks
 * on `budget.remaining <= 0`, `maskValueDeep` charges per element - and this was the one
 * that was not. A million entries is far past any payload worth logging and leaves the cap
 * invisible to every pass that is not running away.
 */
export const MAX_REDACTION_ENTRIES = 1_000_000;

/**
 * Most entries a redaction list may hold before it is refused outright.
 *
 * A bound on `redactedKeys` and `sensitiveFieldNames`, which are configuration rather
 * than payload: a caller naming this many fields has not written a list, and reading one
 * costs the memory of every element before anything can decide it is unusable. Far past
 * any real configuration, and low enough that a value claiming a length in the millions
 * is answered without allocating for it. See {@link snapshotList}.
 */
const MAX_REDACT_LIST_ENTRIES = 100_000;

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
 * A caller-supplied list read once into a plain array, or `null` when it cannot be trusted.
 *
 * Every guard around `redactedKeys` and `sensitiveFieldNames` was built for a list that
 * *throws*, and a `Proxy` does not have to throw to be unusable - it can simply lie.
 * `new Proxy(['password'], { get: (t, k) => (k === 'length' ? 0 : t[k]) })` answers
 * `Array.isArray` yes, iterates as empty, and spreads to `[]`, so every reader concluded
 * "the caller asked to redact nothing" and handed the payload back in the clear. No marker,
 * no `onFormatError`, and `redactedKeys` on the entry reading `undefined` - the one
 * outcome redaction exists to prevent, reached without a single exception being raised.
 *
 * A consistent liar is undetectable in general, but *this* lie is not, because it breaks an
 * invariant only an exotic Array object enforces: **a real array never carries an own index
 * key at or beyond its own `length`.** Push an element and `length` grows with it; shorten
 * `length` and the elements past it are deleted. Only a `Proxy` can hold `'0'` while
 * claiming a length of zero, so an index key that sits outside the claimed range is proof
 * the two answers cannot both be true.
 *
 * The check does not fire on anything legitimate. A genuinely empty `[]` has no index keys
 * at all. A sparse `new Array(3)` with one element has key `'0'` against a length of 3 -
 * inside the range, so it passes, and its holes read `undefined` and are refused below as
 * non-strings, which is the existing behaviour.
 *
 * Read by index rather than iterated, and returned as a plain array so every later reader
 * sees one snapshot. Iteration resolves `Symbol.iterator` off the value, which on a
 * subclass is caller code free to yield something other than the elements; and a value read
 * twice need not answer the same way twice, which is how a list said "one key" to
 * `handleLog` and "no keys" to `applyRedaction` a moment later.
 *
 * @returns The entries as a plain array, or `null` when the value is not an array, cannot
 *          be read, or contradicts itself. Callers must treat `null` as a reason to mask
 *          everything rather than nothing.
 */
export function snapshotList(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }

    const claimed = (value as unknown[]).length;

    if (!Number.isSafeInteger(claimed) || claimed < 0) {
      return null;
    }

    // Refused before a single element is read, because the loop below materializes the
    // claimed length and nothing above bounds it. The self-contradiction check only
    // catches a list lying *downward* about `length` - an index key past the end - so a
    // `Proxy` answering `20_000_000` passes every test here and then costs eight seconds
    // and the array to go with it, synchronously inside `logger.info()`. A plain
    // `new Array(50_000_000)` does the same without a `Proxy` at all.
    //
    // The cap is on a list of *redaction entries*, not on payload data: these are the
    // names a caller configured, and a configuration with more than this many of them is
    // not one this could match against a payload in reasonable time either. Refused
    // rather than truncated, for the reason every other refusal here is - a half-read
    // list masks a subset and reads as success.
    if (claimed > MAX_REDACT_LIST_ENTRIES) {
      return null;
    }

    for (const key of Object.keys(value)) {
      // Own index keys only. A named property on an array - `list.note = 'x'` - is not an
      // element and says nothing about the length.
      if (!/^\d+$/.test(key)) {
        continue;
      }

      if (Number(key) >= claimed) {
        return null;
      }
    }

    const entries: unknown[] = [];

    for (let index = 0; index < claimed; index++) {
      entries.push((value as unknown[])[index]);
    }

    return entries;
  } catch {
    // A revoked `Proxy`, a throwing `length`, an `ownKeys` trap that refuses.
    return null;
  }
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
    const entries = snapshotList(value);

    if (entries === null) {
      return null;
    }

    const paths: RedactPath[] = [];

    for (const entry of entries) {
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
  state: RedactState,
): boolean {
  if (!isPlainContainer(value)) {
    return false;
  }

  if (isSeen(value, seen, state.aliases)) {
    return true;
  }

  // The scan reads the same unbounded `length` the walk does, so it needs a cap of its
  // own - and here "walk it properly" is the conservative answer, which is what the walk's
  // own budget then decides. Charged to {@link RedactState.scanLeft} rather than to the
  // walk's counter, for the reason that field documents.
  if (state.scanLeft <= 0) {
    return true;
  }

  if (visited.has(value)) {
    return false;
  }

  visited.add(value);

  // The shared enumeration, so this scan cannot conclude "nothing below" about a container
  // the walk itself would have entered - the one property that makes skipping it sound.
  const shape = describeContainer(value);

  if (shape.kind === 'unreadable') {
    // A read that failed says nothing about what is underneath it, so the scan refuses to
    // clear this subtree and the full walk decides, with its own per-entry guards.
    return true;
  }

  if (shape.kind === 'array') {
    const elements = value as unknown[];

    for (let index = 0; index < shape.length; index++) {
      if (state.scanLeft <= 0) {
        return true;
      }

      state.scanLeft--;

      let element: unknown;

      try {
        element = elements[index];
      } catch {
        return true;
      }

      if (needsFullWalk(element, seen, visited, state)) {
        return true;
      }
    }

    // An array's *named* properties, which this scan iterated past entirely. The scan is
    // the gate: answering "nothing below needs a walk" makes `redactPathsInner` return
    // `UNCHANGED`, and the caller then keeps the **original** subtree by reference - so
    // the walk's own named-property pass never runs and a back-edge parked on one is
    // invisible to the cycle guard. `root.items.back = root` rendered the secret in the
    // clear, which is precisely the leak class the alias map exists to close. The object
    // branch below never had the hole; the array branch did.
    if (state.scanLeft <= 0) {
      return true;
    }

    let names: string[];

    try {
      names = namedArrayKeys(value);
    } catch {
      return true;
    }

    for (const name of names) {
      if (state.scanLeft <= 0) {
        return true;
      }

      state.scanLeft--;

      let named: unknown;

      try {
        named = (value as Record<string, unknown>)[name];
      } catch {
        return true;
      }

      if (needsFullWalk(named, seen, visited, state)) {
        return true;
      }
    }

    return false;
  }

  for (const key of shape.keys) {
    if (state.scanLeft <= 0) {
      return true;
    }

    state.scanLeft--;

    let entry: unknown;

    try {
      entry = (value as Record<string, unknown>)[key];
    } catch {
      return true;
    }

    if (needsFullWalk(entry, seen, visited, state)) {
      return true;
    }
  }

  return false;
}

/** {@link needsFullWalk}, with a payload too deep to scan counting as "walk it". */
function mustWalkInFull(
  value: unknown,
  seen: WeakSet<object>,
  state: RedactState,
): boolean {
  try {
    // A fresh set per scan, not one shared across the walk: `seen` differs between
    // scans, so a node that answered `false` under one ancestor chain is not answering
    // the same question under another.
    return needsFullWalk(value, seen, new Set(), state);
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
  /**
   * Entries left to visit in this pass. See {@link MAX_REDACTION_ENTRIES}.
   *
   * On the state rather than a parameter because the bound is per *pass*, not per
   * container: a payload of ten thousand arrays of a hundred elements costs exactly what
   * one array of a million does, and a per-container cap would wave it through.
   */
  entriesLeft: number;
  /**
   * Entries left to *scan* in this pass. See {@link MAX_REDACTION_ENTRIES}.
   *
   * Separate from `entriesLeft`, and that separation is the point. The scan and the walk
   * read the same containers, so charging both to one counter made the scan's work
   * subtract from the walk's: a payload of `{ secret, a: [600k], b: [600k] }` masked
   * `secret`, passed `a` through intact, and then collapsed `b` to a single
   * {@link REDACTION_FAILED_MARKER} - because scanning `a` had already spent the budget
   * the walk of `b` needed. Nothing about `b` was too large; the *measuring* of `a` was
   * charged to it.
   *
   * Still a bound, and still per pass: the scan cannot exceed it either, and answers
   * "walk it properly" the moment it does, which is the conservative direction. The total
   * work a pass can do is two counters' worth rather than one, which is what a cap on each
   * of two distinct traversals means.
   */
  scanLeft: number;
  /**
   * Copies standing in for the containers they forward to. See {@link ForwardingAliases}.
   *
   * On the state because it is read at every level of the walk and set once per pass, like
   * everything else here - and never on the values themselves, for the reasons that type
   * documents.
   */
  aliases: ForwardingAliases | undefined;
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
  report: ReportFormatFailure,
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
    if (!mustWalkInFull(value, seen, state)) {
      return UNCHANGED;
    }

    shouldSkipScanBelow = true;
  }

  if (isSeen(value, seen, state.aliases)) {
    // A cycle counts as a change, so the parent is rebuilt around this marker.
    //
    // Passing the original through would be wrong here in a way it is not elsewhere: the
    // ancestor this points back at is still being walked, and if anything under it does
    // match, the copy being built would carry a reference to the *unmasked* original
    // instead of to the rebuilt version.
    //
    // Recorded as a failed read when a path points below this node, because that is what
    // it is: the walk was asked to reach something through this back-edge and refused, so
    // it never saw whether a redacted key sits there. Without the flag, a path whose only
    // resolution runs through the cycle produced a rebuild that `redactMatchedPaths` then
    // discarded - nothing had masked and nothing had failed - and handed the caller's own
    // container back with the named secret in the clear, while `entry.redactedKeys` still
    // claimed it was masked and no error was reported. `shouldSkipScanBelow` is exactly
    // the "no path points below" answer already computed above, so an incidental cycle in
    // a payload this list matches none of still takes the untouched-original shortcut.
    if (!shouldSkipScanBelow) {
      state.didFailToRead = true;
    }

    return REDACTION_FAILED_MARKER;
  }

  // Both the node and whatever it forwards to. A back-edge in the payload still points at
  // the *original* container, never at the copy standing in for it, so tracking only the
  // copy left the guard above unable to recognize the node it was already inside. See
  // {@link ForwardingAliases}.
  const origin = state.aliases?.get(value);

  seen.add(value);

  if (origin !== undefined) {
    seen.add(origin);
  }

  try {
    // The shared enumeration, so this walk and the renderer cannot disagree about what a
    // container holds - the divergence between the two that this design exists to remove.
    const shape = describeContainer(value);

    if (shape.kind === 'unreadable') {
      // The walk cannot tell whether something named for redaction sits below. Handing
      // back the original would risk returning it in the clear, so this one value fails
      // closed even though nothing under it matched.
      report(shape.error, path.join('.') || '<root>');
      state.didFailToRead = true;

      return REDACTION_FAILED_MARKER;
    }

    if (shape.kind === 'array') {
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
      for (let index = 0; index < shape.length; index++) {
        // Fails closed on the tail rather than dropping it. The walk cannot see what is
        // in the elements it never reached, so handing them back by reference would risk
        // returning a named key in the clear - the same reasoning as the unreadable
        // branch above. See {@link MAX_REDACTION_ENTRIES}.
        if (state.entriesLeft <= 0) {
          state.didFailToRead = true;
          didMask = true;
          copy.push(REDACTION_FAILED_MARKER);

          break;
        }

        state.entriesLeft--;

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

      // An array's *named* properties, which `describeContainer` reports as a length and
      // this branch therefore rebuilt without. It only mattered once something inside was
      // masked - a rebuilt array is what the caller receives, and anything not carried
      // over is simply gone - so redacting one index blanked an unrelated sibling:
      // `items.note` rendered `request-42` until `redactedKeys: ['items[0]']` was added,
      // and then rendered the fallback. Walked rather than copied across, so a path may
      // name one exactly as it names a key on an object.
      //
      // Behind the budget check, not beside it. `namedArrayKeys` calls `Object.keys`, which
      // materializes *every own index key as a string* - on a dense five-million-element
      // array that is 2.7 seconds and some 600 MB, synchronously inside `logger.info()`,
      // which is the exact stall {@link MAX_REDACTION_ENTRIES} exists to bound. Run
      // unconditionally after the index loop had already broken on an exhausted budget, it
      // defeated the cap it was written next to.
      let namedKeys: string[] = [];

      if (state.entriesLeft > 0) {
        try {
          namedKeys = namedArrayKeys(source);
        } catch (error) {
          report(error, path.join('.') || '<root>');
          state.didFailToRead = true;
          didMask = true;
        }
      } else {
        // Counted as a failed read, not as an absence. With the budget spent this branch
        // cannot ask whether there are named properties at all - `namedArrayKeys` *is*
        // the enumeration the cap exists to refuse - so anything here is dropped from the
        // rebuilt array with no per-key marker to show for it, unlike every other
        // exhaustion path in this walk. Saying so on the pass is what is affordable: it
        // keeps `redactMatchedPaths` from taking the "nothing changed, hand back the
        // original" shortcut and surfaces the truncation to the caller, where a marker on
        // a key this cannot name would have to be invented.
        //
        // Every exhausted shape, not just the empty array. The narrowing this replaces
        // argued that an array with elements has already had its index loop refuse one and
        // write a marker, which is true unless the budget ran out on the *last* element:
        // the loop then exits normally, having written no marker and set no flag, and the
        // named properties were dropped silently while the original came back by
        // reference with a named secret unmasked and unreported - the one exhaustion path
        // in this walk that failed open. Setting it again where a marker was written costs
        // nothing, since it is already true there.
        state.didFailToRead = true;
        didMask = true;
      }

      for (const namedKey of namedKeys) {
        if (state.entriesLeft <= 0) {
          state.didFailToRead = true;
          didMask = true;
          defineEntry(
            copy as unknown as Record<string, unknown>,
            namedKey,
            REDACTION_FAILED_MARKER,
          );

          continue;
        }

        state.entriesLeft--;

        let namedResult: unknown;
        let namedValue: unknown;

        try {
          namedValue = (source as unknown as Record<string, unknown>)[namedKey];
        } catch (error) {
          report(error, [...path, namedKey].join('.'));
          state.didFailToRead = true;
          didMask = true;
          defineEntry(
            copy as unknown as Record<string, unknown>,
            namedKey,
            REDACTION_FAILED_MARKER,
          );

          continue;
        }

        try {
          namedResult = redactPathsInner(
            namedValue,
            paths,
            [...path, namedKey],
            redactFunction,
            seen,
            state,
            report,
            shouldSkipScanBelow,
          );
        } catch (error) {
          report(error, [...path, namedKey].join('.'));
          state.didFailToRead = true;
          namedResult = REDACTION_FAILED_MARKER;
        }

        if (namedResult !== UNCHANGED) {
          didMask = true;
        }

        defineEntry(
          copy as unknown as Record<string, unknown>,
          namedKey,
          namedResult === UNCHANGED ? namedValue : namedResult,
        );
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
    const copy: Record<string, unknown> = {};
    let didMask = false;

    for (const key of shape.keys) {
      // `Object.keys` builds a fresh array, so this branch cannot be lied to about its
      // own length - but the budget is per pass, not per container, and a payload of many
      // small objects spends it exactly as one huge array does.
      if (state.entriesLeft <= 0) {
        state.didFailToRead = true;
        didMask = true;
        defineEntry(copy, key, REDACTION_FAILED_MARKER);

        continue;
      }

      state.entriesLeft--;

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

    if (origin !== undefined) {
      seen.delete(origin);
    }
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
  report: ReportFormatFailure = NOOP_FORMAT_REPORTER,
  aliases?: ForwardingAliases,
): unknown {
  const state: RedactState = {
    didMaskAnything: false,
    didFailToRead: false,
    noMatchUnchanged: new WeakSet(),
    entriesLeft: MAX_REDACTION_ENTRIES,
    scanLeft: MAX_REDACTION_ENTRIES,
    aliases,
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
