import { getRedactPathParts, WILDCARD_PATH_SEGMENT } from './path-utils';
import {
  defineEntry,
  describeContainer,
  isArrayIndexKey,
  namedArrayKeys,
} from './container-entries';
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
import {
  createRenderBudget,
  MAX_RENDER_DEPTH,
  type RenderBudget,
  TRUNCATED,
  TRUNCATED_LENGTH,
} from './render-budget';

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
      //
      // `isArrayIndexKey`, not a `/^\d+$/` of its own, for the reason that predicate
      // documents: `'007'` and `'4294967296'` match the pattern and are *named properties*,
      // which JavaScript stores beside the elements rather than in them. Called indexes
      // here, they read as an index past a shorter `length`, so this refused the list -
      // and a refusal is fail-closed all the way up: `parseRedactPaths` answers `null` and
      // the caller replaces the whole payload with `***REDACTION FAILED***`. A caller who
      // hangs a note on their own redaction list lost every log line's params to it.
      if (!isArrayIndexKey(key)) {
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
 * entry means, and on the logger's syntax: a bare name is a top-level key,
 * `user.password` or `items[0].token` addresses one location, and `users.*.password` or
 * `items[*].token` addresses every element of an array.
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
      // name like `password-hash` is fine here but would need quoting inside a path. A
      // bare `*` is one segment either way, so it follows the same rule as any other
      // wildcard: the key spelled `*` on an object bag - which is what the logger always
      // hands the walk - and every element when the redacted value is itself an array,
      // which `redactValue` and `stringifyValue` can be given.
      paths.push({ parts: [entry], entry });

      if (entry.includes('.') || entry.includes('[')) {
        // An entry with path syntax is ambiguous: it can name a nested location or one
        // literal key spelled that way. Both readings are covered, since leaving either
        // unmasked is the outcome redaction exists to prevent.
        const parts = getRedactPathParts(entry);

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

/** One node of the prefix tree {@link redactPathIndex} builds. */
interface RedactPathNode {
  /** The entry of the first path that ends exactly here, if any. */
  exact?: string;
  /** The entry of the first path that continues strictly below here, if any. */
  below?: string;
  children: Map<string, RedactPathNode>;
}

/**
 * Built once per list, then reused for every node the walk visits.
 *
 * Both lookups below used to be a linear scan of the whole list, run once per visited
 * node, so the cost of a pass was `paths x nodes`. Each factor is capped on its own -
 * {@link MAX_REDACT_LIST_ENTRIES} and {@link MAX_REDACTION_ENTRIES} - and nothing capped
 * the product: 5,000 entries over a 6,000-node payload measured 349 ms, and the permitted
 * maxima extrapolate to roughly twenty minutes synchronously inside `logger.info()`, which
 * is the exact stall `MAX_REDACTION_ENTRIES` exists to close. A prefix tree answers both
 * questions in the length of the path being asked about, which is bounded by the payload's
 * depth rather than by the size of the list.
 *
 * Keyed on the array so callers keep handing round a plain `RedactPath[]`. The lists are
 * built by `parseRedactPaths` and never mutated afterwards; a caller that did mutate one
 * would be answered from the tree built for it as it was.
 */
const redactPathIndexes = new WeakMap<RedactPath[], RedactPathNode>();

function redactPathIndex(paths: RedactPath[]): RedactPathNode {
  const existing = redactPathIndexes.get(paths);

  if (existing !== undefined) {
    return existing;
  }

  const root: RedactPathNode = { children: new Map() };

  // In list order, and never overwriting: both lookups answered with the *first* matching
  // entry when they were a `find`, and that entry is what a custom `redactFunction` is
  // handed as the key the caller wrote.
  for (const candidate of paths) {
    let node = root;

    for (const part of candidate.parts) {
      // Recorded on the way down, so every proper prefix of this path learns that
      // something addresses a location below it.
      node.below ??= candidate.entry;

      let child = node.children.get(part);

      if (child === undefined) {
        child = { children: new Map() };
        node.children.set(part, child);
      }

      node = child;
    }

    node.exact ??= candidate.entry;
  }

  redactPathIndexes.set(paths, root);

  return root;
}

/**
 * The parsed list as a prefix tree, for a caller that has to descend the paths itself.
 *
 * Only the shape of the paths, deliberately: which entry ends where is this module's
 * business, and a caller walking the prefixes has no use for it. A node with no children
 * is a leaf, which names a value rather than a container to descend into.
 */
export interface RedactPrefixNode {
  /** The segments any entry continues with here, as `segment -> the node below it`. */
  children: ReadonlyMap<string, RedactPrefixNode>;
}

/**
 * The prefix tree {@link redactPathIndex} builds, as {@link RedactPrefixNode}.
 *
 * Built once per list and cached on it, so a caller descending it pays nothing the walk
 * has not already paid. `applyRedaction` uses it to normalize the containers a path passes
 * through: descending the tree visits a shared prefix once, where descending the list
 * visits it once per entry - which with a wildcard means once per entry *per array
 * element*, and that difference is the difference between a bound that measures work and
 * one that charges the same work repeatedly until it runs out.
 */
export function redactPathPrefixes(paths: RedactPath[]): RedactPrefixNode {
  return redactPathIndex(paths);
}

/**
 * One step the walk has taken, as the index needs to see it.
 *
 * The key on its own is not enough, because a wildcard expands over an array's *indexes*
 * and over nothing else. `users.*.password` has to reach `users[0].password` when `users`
 * is an array, and has to mean the key literally named `*` when `users` is a plain object
 * - including one whose keys happen to read as numbers, `{ '0': { password } }`, which is
 * not an array and whose entries a wildcard therefore does not address. Only the walk
 * knows which container it was standing in, so it says so here rather than leaving the
 * index to guess it back from the shape of the key.
 *
 * `isArrayIndex` is `isArrayIndexKey` answered about the container the walk was in: an
 * element of an array is one, and an array's *named* properties - which `namedArrayKeys`
 * selects with that same predicate - are not. So `items[*]` masks the elements of `items`
 * and leaves `items.note` alone, exactly as `items[0]` does.
 */
export interface RedactPathStep {
  /** The key as the container holds it. */
  key: string;
  /** Whether the container was an array and `key` addresses one of its slots. */
  isArrayIndex: boolean;
}

/** A step onto a plain object's key, an array's named property, or any other literal key. */
export function literalStep(key: string): RedactPathStep {
  return { key, isArrayIndex: false };
}

/** A step onto one element of an array. */
export function indexStep(index: string): RedactPathStep {
  return { key: index, isArrayIndex: true };
}

/**
 * Longest subject one failure report may carry.
 *
 * The steps of a path are caller data - an object parsed from JSON carries whatever keys
 * arrived - and joining them unbounded made the one text this module emits the one it did
 * not cap: a payload nested thousands deep produced a single 40 KB `root.n.n.n....`
 * subject on the error path, where every other string here goes through `capKey` or
 * `chargeText`. Far longer than any path worth naming, and long enough that an ordinary
 * one is never touched.
 */
const MAX_PATH_TEXT_LENGTH = 1_000;

/**
 * The path as the failure reports spell it.
 *
 * Cut to {@link MAX_PATH_TEXT_LENGTH}, keeping the *front*: a report is read from the root
 * down, so the leading steps are the ones that locate it.
 */
function pathText(path: readonly RedactPathStep[]): string {
  const text = path.map((step) => step.key).join('.');

  if (text.length <= MAX_PATH_TEXT_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_PATH_TEXT_LENGTH)}${TRUNCATED_LENGTH}`;
}

/**
 * Every node `path` can be standing on, following wildcards where they apply.
 *
 * A wildcard makes this a walk of a small NFA rather than of a trie: at an array element
 * both the literal index child and the `*` child can continue, so the lookup carries a set
 * of nodes instead of one. It grows past a single node only where the caller wrote both a
 * concrete index and a wildcard through the same prefix - `['items[0].a', 'items[*].b']` -
 * so an ordinary list still costs one node per step, exactly as it did before wildcards
 * existed.
 *
 * The width is bounded by how many nodes the index holds at that depth, which is bounded
 * by the length of the list: a set of `n` nodes needs `n` entries enumerating that many
 * distinct literal/wildcard interleavings through one prefix. A *configuration* written to
 * do that - 8,192 entries covering every combination over 13 array levels - restores some
 * of the `paths x nodes` product the prefix tree removed, measured at 268 ms. No ordinary
 * list approaches it, and no payload can provoke it on its own, so it is left as a
 * property of the grammar rather than bounded by dropping nodes, which would silently
 * fail open.
 *
 * The literal child is pushed first at every step, so where both match it is the concrete
 * entry rather than the wildcard that a `redactFunction` is handed as the key the caller
 * wrote.
 */
function findRedactPathNodes(
  paths: RedactPath[],
  path: readonly RedactPathStep[],
): RedactPathNode[] {
  let nodes: RedactPathNode[] = [redactPathIndex(paths)];

  for (const step of path) {
    const next: RedactPathNode[] = [];

    for (const node of nodes) {
      const literal = node.children.get(step.key);

      if (literal !== undefined) {
        next.push(literal);
      }

      // Only over an array slot. A plain object's keys are never expanded over, and
      // neither are an array's named properties, so against either of those a `*` in the
      // list is the literal key matched just above and nothing more.
      //
      // The second test is belt and braces: an array index key is a run of digits, so it
      // cannot also be `*`, and this only makes it impossible to push one node twice.
      if (step.isArrayIndex && step.key !== WILDCARD_PATH_SEGMENT) {
        const wildcard = node.children.get(WILDCARD_PATH_SEGMENT);

        if (wildcard !== undefined) {
          next.push(wildcard);
        }
      }
    }

    if (next.length === 0) {
      return next;
    }

    nodes = next;
  }

  return nodes;
}

/** The first entry `pick` answers with, over a set of nodes the walk is standing on. */
function firstEntryOver(
  nodes: readonly RedactPathNode[],
  pick: (node: RedactPathNode) => string | undefined,
): string | undefined {
  for (const node of nodes) {
    const entry = pick(node);

    if (entry !== undefined) {
      return entry;
    }
  }

  return undefined;
}

/**
 * A stable name for the position `nodes` describes, for {@link RedactState.walkResults}.
 *
 * The nodes come out of {@link findRedactPathNodes} in the order the route reached them,
 * which two routes onto the same set need not agree on, so the ids are sorted: the memo
 * keys a *set*, and two spellings of one set that did not compare equal would each walk
 * the subtree again.
 *
 * `shouldSkipCandidateScan` is part of the position because it is part of the question -
 * it decides whether the node is scanned or walked in full, and the two can answer
 * differently for a container holding an unstable entry.
 *
 * So is the depth, and only because of the cap: how far a subtree gets to be walked before
 * {@link MAX_RENDER_DEPTH} cuts it is the one thing about the route that changes the answer
 * without changing the node set. Carrying it here is what lets a capped result be memoized
 * at all - counting the cap as route-dependent instead left every payload deeper than the
 * cap walking route by route, which is the blowup this memo exists to stop, arriving one
 * level lower down.
 */
function walkPositionKey(
  nodes: readonly RedactPathNode[],
  shouldSkipCandidateScan: boolean,
  depth: number,
): string {
  const ids: number[] = [];

  for (const node of nodes) {
    let id = redactPathNodeIDs.get(node);

    if (id === undefined) {
      id = nextRedactPathNodeID++;
      redactPathNodeIDs.set(node, id);
    }

    ids.push(id);
  }

  ids.sort((left, right) => left - right);

  return `${shouldSkipCandidateScan ? 's' : 'w'}:${depth}:${ids.join(',')}`;
}

/**
 * An id per index node, assigned on first use. See {@link walkPositionKey}.
 *
 * Weak, and never on the node itself: the index is cached on the caller's `paths` array
 * for as long as that array lives, and a number written onto its nodes would outlive the
 * pass that needed it.
 */
const redactPathNodeIDs = new WeakMap<RedactPathNode, number>();

let nextRedactPathNodeID = 0;

/** The first entry `pick` answers with, over the nodes `path` can be standing on. */
function firstEntryAt(
  paths: RedactPath[],
  path: readonly RedactPathStep[],
  pick: (node: RedactPathNode) => string | undefined,
): string | undefined {
  for (const node of findRedactPathNodes(paths, path)) {
    const entry = pick(node);

    if (entry !== undefined) {
      return entry;
    }
  }

  return undefined;
}

/**
 * The originating entry when `path` matches one of `paths`, else `undefined`.
 *
 * Returns the entry rather than a boolean so a custom `redactFunction` can be handed the
 * key the caller actually wrote.
 */
export function matchRedactPath(
  paths: RedactPath[],
  path: readonly RedactPathStep[],
): string | undefined {
  return firstEntryAt(paths, path, (node) => node.exact);
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
  path: readonly RedactPathStep[],
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

  return pathPointingBelow(paths, path);
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
  path: readonly RedactPathStep[],
): string | undefined {
  return firstEntryAt(paths, path, (node) => node.below);
}

/**
 * Whether reading `key` off `value` can answer differently the next time it is read.
 *
 * An own enumerable accessor is the one entry this walk cannot hand back by reference. The
 * walk reads each member exactly once and decides from that read alone, but the value it
 * returns is read *again* - by the renderer, by a structured sink, by whatever the caller
 * does with it - and a getter is free to answer differently then. A subtree that matched
 * nothing on the read the walk saw was passed through untouched, so the second read
 * rendered whatever the getter chose to give it: measured through the public API, a
 * `redactedKeys: ['password']` pass masking the root's own `password` and printing
 * `a.g.up.password` in the clear beside it, because `up` answered `{}` first and the
 * secret second.
 *
 * The answer is to stop passing such a container through, not to read it twice here. A
 * container holding one of these is rebuilt from the values the walk already read, so what
 * the caller gets back is the snapshot this pass actually vetted.
 *
 * Own accessors only. An inherited one is not something this walk reads or rebuilds, and a
 * `Proxy` that lies from its `getOwnPropertyDescriptor` trap can defeat this the way it can
 * defeat every other question asked of it - the leak this closes is the getter, which is
 * ordinary, not the hostile proxy, which is not.
 *
 * An absent descriptor is *not* one of these. An array hole has none - `[1, , 3]`,
 * `new Array(n)`, anything whose `length` runs past its defined indices - and the index
 * loop walks it by `length`, so treating "no descriptor" as unstable rebuilt every sparse
 * array that came through: the hole came back as a dense `undefined`, the caller's own
 * array stopped being handed back, and one hole anywhere forced a deep rebuild of the
 * whole payload. A hole answers `undefined` to every read, which is the one thing this
 * needs to know.
 *
 * @returns `true` when the member is an accessor, and when the descriptor cannot be read
 *          at all - a member this cannot vouch for is treated as one that needs
 *          snapshotting, which is the conservative direction here.
 */
function isUnstableEntry(value: object, key: string): boolean {
  let descriptor: PropertyDescriptor | undefined;

  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    return true;
  }

  return descriptor !== undefined && descriptor.get !== undefined;
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
  depth = 0,
): boolean {
  if (!isPlainContainer(value)) {
    return false;
  }

  // Bounded like every other walk over caller data, rather than relying on the `catch` in
  // {@link mustWalkInFull} to absorb a `RangeError` - which made the answer depend on how
  // much stack was left rather than on the payload, so one value cleared the scan at 5,000
  // deep and failed it at 20,000. "Walk it properly" is the conservative answer here and
  // the same one the overflow produced, now reached without running the stack out.
  if (depth >= MAX_RENDER_DEPTH) {
    return true;
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

      // A slot the walk would have to snapshot rather than pass through. Skipping the
      // subtree hands it back by reference, which is exactly what must not happen to an
      // accessor - see {@link isUnstableEntry}.
      if (isUnstableEntry(elements, String(index))) {
        return true;
      }

      let element: unknown;

      try {
        element = elements[index];
      } catch {
        return true;
      }

      if (needsFullWalk(element, seen, visited, state, depth + 1)) {
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

      if (isUnstableEntry(value, name)) {
        return true;
      }

      let named: unknown;

      try {
        named = (value as Record<string, unknown>)[name];
      } catch {
        return true;
      }

      if (needsFullWalk(named, seen, visited, state, depth + 1)) {
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

    if (isUnstableEntry(value, key)) {
      return true;
    }

    let entry: unknown;

    try {
      entry = (value as Record<string, unknown>)[key];
    } catch {
      return true;
    }

    if (needsFullWalk(entry, seen, visited, state, depth + 1)) {
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
  depth = 0,
): boolean {
  try {
    // A fresh set per scan, not one shared across the walk: `seen` differs between
    // scans, so a node that answered `false` under one ancestor chain is not answering
    // the same question under another.
    return needsFullWalk(value, seen, new Set(), state, depth);
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
   * Whether any container was rebuilt only to snapshot an unstable entry.
   *
   * Kept beside {@link RedactState.didMaskAnything} because it answers the same question
   * for the shortcut at the end of `redactMatchedPaths`: a pass that masked nothing hands
   * the caller their own value back, and that would undo every snapshot taken along the
   * way - handing back the very container whose getter is free to answer differently on
   * the read that reaches the output. See {@link isUnstableEntry}.
   */
  didSnapshotUnstable: boolean;
  /**
   * Whether the depth cap cut the walk short of something a path pointed at.
   *
   * Beside {@link RedactState.didSnapshotUnstable} and for the same reason: the copy the
   * walk built is the only value that carries what the cap did. The cap replaces the tail
   * it refused to walk with {@link TRUNCATED}, and a pass that masked nothing elsewhere
   * used to hand the caller their own value back instead - which is the *untruncated*
   * payload, with every key the walk never reached still on it. A list naming one key past
   * the cap therefore masked it at the last level before the cut and printed it in the
   * clear at the first level after, with nothing reported.
   *
   * So a cut a path pointed past is a change like any other: it forces the rebuilt copy
   * out, and what the caller gets is the value the walk actually vetted. A cut with no path
   * below it is not set here, so a payload deeper than the cap that the list matches none
   * of is still handed back by reference, untouched.
   */
  didTruncate: boolean;
  /**
   * What nodes this pass has already walked came back as, per walk position.
   *
   * `seen` is released as the walk leaves a node, deliberately, so a value referenced
   * twice side by side is walked both times rather than the second being called a cycle.
   * That makes the walk one of every *route* through the payload rather than of the
   * payload, and a subtree reachable by two references is therefore walked twice, its own
   * shared children four times, and so on: an object graph of 53 objects nested 26 deep,
   * with each level holding the same child under two keys, took 2.7 seconds, and 61
   * objects took roughly 44. This is what bounds that to one walk per node per position.
   *
   * Two conditions make the memo sound, and both are load-bearing:
   *
   * - **Keyed on the walk position, not only on the node.** The walk answers a question
   *   about a node *at a path*, and what the path contributes is exactly the set of index
   *   nodes the route is standing on - `matched`, `below` and everything the walk can
   *   still reach are read off that set and off nothing else about the route. So two
   *   routes standing on the same index nodes ask the same question, and one answer
   *   serves both. Keyed on the node alone this held only inside a region an ancestor's
   *   scan had already cleared, which left every payload a path *does* point into walking
   *   route by route: 20 shared objects under `order.items[*]...card` spent 2.5 seconds
   *   inside one `logger.info()` and then blanked an unrelated sibling with
   *   {@link REDACTION_FAILED_MARKER}, having exhausted the entry budget on rewalks.
   * - **Only a result that is not route-dependent.** A cycle yields the failure marker,
   *   and whether a back-edge closes depends on the route, not on the node - so a marker
   *   must never be replayed onto a route where the same node is not in a cycle. The same
   *   goes for the entry budget, which stops at whatever the walk order reached first.
   *   The depth cap is handled by the key rather than by this guard; see
   *   {@link walkPositionKey}. {@link RedactState.routeDependentResults} is what counts those,
   *   and a subtree that produced one is not recorded.
   *
   * Both {@link UNCHANGED} and a rebuilt copy are recorded. The copy matters as much as
   * the sentinel now that an unstable entry forces a snapshot: a shared subtree holding a
   * single getter answers with a copy rather than `UNCHANGED`, so recording only the
   * sentinel put the exponential walk straight back - 2^n rebuilds of the same node, which
   * is what this memo exists to stop. Replaying one copy across every reference also keeps
   * the sharing the input had, rather than turning one object into n identical ones.
   *
   * The pass-level flags are not replayed with it, and do not need to be: every one of
   * them is monotonic and was set by the walk being replayed.
   */
  walkResults: WeakMap<object, Map<string, unknown>>;
  /**
   * How many results this pass has produced that depend on the *route* to a node rather
   * than on the node.
   *
   * The memo above replays a result onto every reference that reaches a node, so a result
   * that would have been different by another route must never go into it. Three produce
   * one: a cycle, which closes on some routes and not others, and the entry budget, which
   * is spent in walk order and so stops at whichever reference got there first. The depth
   * cap is the third such result and is *not* counted here - it is keyed instead, by the
   * depth {@link walkPositionKey} carries, so a capped subtree is replayed only onto a
   * route standing exactly as far down. Counted rather than flagged, because what matters
   * is whether one landed
   * *inside the subtree just walked* - which is a comparison of this number before and
   * after, and not a property of the pass as a whole.
   */
  routeDependentResults: number;
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
  /**
   * The `'render'`-kind channel, for a leaf whose `toString` throws while it is being
   * masked.
   *
   * Carried on the state rather than passed alongside `report` because it is threaded
   * unchanged through every level of the walk and only `maskValueDeep` reads it. Kept
   * distinct from `report` for the reason `errorToString` keeps its own two apart: a
   * render failure reported on the redaction channel arrives with the wrong
   * `FormatFailureKind` and spends the one redaction report a genuinely broken
   * `redactFunction` still needs.
   */
  reportRender: ReportFormatFailure;
  /**
   * The allowance every mask in this pass spends from, shared by all of them.
   *
   * One budget per *pass*, not one per matched container, for the reason `entriesLeft` is
   * per pass: `maskValueDeep` charges its own walk, but called with a fresh budget at
   * every match it was charging a counter nobody else could see, so the cap bounded one
   * mask and nothing about their sum. `entriesLeft` did not close that either - it is
   * decremented once per matched *container*, before the mask descends - so forty keys
   * each holding a 400,000-element array, all forty named in `redactedKeys`, masked
   * 16,000,000 entries in 4.3 seconds synchronously inside `logger.info()`, sixteen times
   * the nominal per-pass cap.
   *
   * Past it a mask yields `REDACTED_PLACEHOLDER` rather than the original, which is the
   * same direction `maskValueDeep` already takes at its own limits: a pass that runs out
   * over-masks, and never under-masks.
   */
  maskBudget: RenderBudget;
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
  path: readonly RedactPathStep[],
  redactFunction: RedactLeafFunction | undefined,
  seen: WeakSet<object>,
  state: RedactState,
  report: ReportFormatFailure,
  shouldSkipCandidateScan = false,
): unknown {
  // The index nodes this route is standing on, resolved once. Every question the walk asks
  // of the path list - does this node match, does anything point below it, and which
  // position the memo keys on - is answered off this set and off nothing else about the
  // route, which is what lets {@link RedactState.walkResults} key on it. Resolving it once
  // also stops each level re-descending the index from the root, which was `O(depth)` per
  // node walked.
  const nodes = findRedactPathNodes(paths, path);
  const matched = firstEntryOver(nodes, (node) => node.exact);

  if (matched !== undefined) {
    // Marked before the attempt, not after: a mask that throws still yields the failure
    // marker, which must not be mistaken for "nothing happened here".
    state.didMaskAnything = true;

    try {
      return maskValueDeep(
        matched,
        value,
        (key, leaf, isDerived) =>
          resolveRedaction(
            key,
            leaf,
            isDerived,
            redactFunction,
            // No pre-cut: `maskValueDeep` cuts a replacement against the pass's budget
            // and records what it dropped, which a silent cut here would hide from it.
            Number.POSITIVE_INFINITY,
          ),
        new WeakSet(),
        report,
        undefined,
        // The pass's own budget, not a fresh one. See {@link RedactState.maskBudget}.
        state.maskBudget,
        state.reportRender,
      );
    } catch (error) {
      // Never fall back to the original: a failed redaction says so instead.
      report(error, matched);

      return REDACTION_FAILED_MARKER;
    }
  }

  // A function counts as a value here, not as "nothing to do". It is not a plain
  // container, so the mask-whole branch below is the one that applies to it - and reaching
  // that branch is the whole point: a path naming something *inside* a function exited
  // here untouched, so `applyRedaction({ cb }, ['cb.password'])` handed every sink the
  // function with its `password` property still on it, while the identical shape as a
  // class instance masked correctly.
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
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
    // {@link findPathInto} over the node set already resolved, root rule and all: nothing
    // addresses the root itself.
    const inside =
      path.length === 0
        ? undefined
        : firstEntryOver(nodes, (node) => node.below);

    if (inside === undefined) {
      return UNCHANGED;
    }

    state.didMaskAnything = true;

    try {
      return maskValueDeep(
        inside,
        value,
        (key, leaf, isDerived) =>
          resolveRedaction(
            key,
            leaf,
            isDerived,
            redactFunction,
            // No pre-cut: `maskValueDeep` cuts a replacement against the pass's budget
            // and records what it dropped, which a silent cut here would hide from it.
            Number.POSITIVE_INFINITY,
          ),
        new WeakSet(),
        report,
        undefined,
        // The pass's own budget, not a fresh one. See {@link RedactState.maskBudget}.
        state.maskBudget,
        state.reportRender,
      );
    } catch (error) {
      report(error, inside);

      return REDACTION_FAILED_MARKER;
    }
  }

  // Bounded like the renderers and like `maskValueDeep`, rather than recursing until the
  // stack runs out and letting a per-entry `catch` absorb the `RangeError`. Absorbing it
  // "worked" - the marker landed and the pass finished - but it made the output a property
  // of how much stack was left rather than of the payload: the same 20,000-deep value
  // passed through untouched when redaction was called directly and collapsed to a marker
  // one frame deeper in, and it charged the caller a redaction-failure report for a payload
  // nothing was wrong with.
  //
  // {@link TRUNCATED}, and deliberately not {@link REDACTION_FAILED_MARKER}: nothing failed
  // here, and the marker reads to an operator as a redaction outage. This is the same word
  // the renderers write where they stop, so a payload deep enough to reach the cap renders
  // as it did before redaction had a cap at all.
  //
  // What the cap must not do is hand the tail back *by reference*: a back-edge parked below
  // this point still refers to an ancestor that may be rebuilt around a mask, which is the
  // leak `mustWalkInFull` exists to catch and which nothing below the cap has checked. A
  // replacement string is not a reference, so that hazard is closed either way.
  //
  // `didFailToRead` is left alone - nothing failed to read here - and the pass-through is
  // left alone with it wherever the list was not pointing past the cut: a 20,000-deep
  // payload that a `redactedKeys` list matches none of still comes back by reference,
  // which is what redaction promises about a payload it was not asked to touch.
  //
  // A cut with a path pointing below it is the other case, and there the cap has to force
  // the rebuilt copy out - {@link RedactState.didTruncate} is what does that. Without it a
  // pass that masked nothing else handed the caller their own value back, tail and all, so
  // the key the list named went to every sink in the clear at one level past the cap while
  // masking correctly one level before it, with nothing reported. Over-masking is the only
  // direction a cap may fail in. Still not reported: a cap is not a failure, and the one
  // redaction report a broken `redactFunction` needs should not be spent on it.
  if (path.length >= MAX_RENDER_DEPTH) {
    if (firstEntryOver(nodes, (node) => node.below) !== undefined) {
      state.didTruncate = true;
    }

    return TRUNCATED;
  }

  // Already walked from this same position. See `RedactState.walkResults` for what makes
  // the position enough to key the answer on. `undefined` is never a recorded result - the
  // walk answers with `UNCHANGED` or with a container - so it is free to mean "not
  // recorded".
  const memoKey = walkPositionKey(nodes, shouldSkipCandidateScan, path.length);
  const recorded = state.walkResults.get(value)?.get(memoKey);

  if (recorded !== undefined) {
    return recorded;
  }

  // Where the counter stood before this node was walked, so what the walk comes back with
  // can be told apart from what the route to it produced. See
  // {@link RedactState.routeDependentResults}.
  const routeDependentBefore = state.routeDependentResults;

  // Nothing below can match, so the walk's answer for this whole subtree is the subtree
  // itself - reached, without this, by rebuilding all of it and discarding the rebuild.
  //
  // Scanned at most once per branch: an ancestor that already scanned and was told to
  // walk in full passes that answer down rather than having each level rediscover it.
  let shouldSkipScanBelow = shouldSkipCandidateScan;

  if (
    !shouldSkipCandidateScan &&
    firstEntryOver(nodes, (node) => node.below) === undefined
  ) {
    if (!mustWalkInFull(value, seen, state, path.length)) {
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

    // Whether this node closes a cycle is a property of the route to it, so nothing on the
    // way back up may be memoized. See {@link RedactState.routeDependentResults}.
    state.routeDependentResults++;

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
      report(shape.error, pathText(path) || '<root>');
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
          state.routeDependentResults++;
          didMask = true;
          copy.push(REDACTION_FAILED_MARKER);

          break;
        }

        state.entriesLeft--;

        // An array slot, so a `*` in the list expands onto it. Built once and reused for
        // both the reports and the recursion below, which is what the index and the
        // failure paths each need.
        const indexKey = String(index);
        const elementPath = [...path, indexStep(indexKey)];

        // Rebuilt rather than passed through, so what leaves this walk is the value it
        // read. See {@link isUnstableEntry}: the copy below already holds that value, so
        // marking the container is the whole of the fix.
        if (isUnstableEntry(source, indexKey)) {
          didMask = true;
          state.didSnapshotUnstable = true;
        }

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
          report(error, pathText(elementPath));
          state.didFailToRead = true;
          didMask = true;
          copy.push(REDACTION_FAILED_MARKER);

          continue;
        }

        try {
          result = redactPathsInner(
            element,
            paths,
            elementPath,
            redactFunction,
            seen,
            state,
            report,
            shouldSkipScanBelow,
          );
        } catch (error) {
          report(error, pathText(elementPath));
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
          report(error, pathText(path) || '<root>');
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
        state.routeDependentResults++;
        didMask = true;
      }

      for (const namedKey of namedKeys) {
        // Stopped on the first key past the budget, exactly as the object branch below
        // stops and for the reason its comment gives: a `continue` still walked the whole
        // key list and still built an entry for each of them, so the cap bounded neither
        // the time nor the size of the copy being rebuilt. An array with `length === 0`
        // sails past the `entriesLeft > 0` gate above - the index loop consumed nothing -
        // and then rebuilt every named key it had: 1.2 million of them against a cap of
        // one million, 624 ms synchronously inside the redaction pass. One marker stands
        // for the tail, which is what the rest would have been.
        if (state.entriesLeft <= 0) {
          state.didFailToRead = true;
          state.routeDependentResults++;
          didMask = true;
          defineEntry(
            copy as unknown as Record<string, unknown>,
            namedKey,
            REDACTION_FAILED_MARKER,
          );

          break;
        }

        state.entriesLeft--;

        // A *named* property of an array, which `namedArrayKeys` selected precisely
        // because `isArrayIndexKey` says it is not a slot - so a `*` in the list does not
        // expand onto it, and reaches it only as the key literally spelled `*`.
        const namedPath = [...path, literalStep(namedKey)];

        // Snapshotted rather than passed through, exactly as an element is above.
        if (isUnstableEntry(source, namedKey)) {
          didMask = true;
          state.didSnapshotUnstable = true;
        }

        let namedResult: unknown;
        let namedValue: unknown;

        try {
          namedValue = (source as unknown as Record<string, unknown>)[namedKey];
        } catch (error) {
          report(error, pathText(namedPath));
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
            namedPath,
            redactFunction,
            seen,
            state,
            report,
            shouldSkipScanBelow,
          );
        } catch (error) {
          report(error, pathText(namedPath));
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
        recordWalkResult(value, memoKey, state, copy, routeDependentBefore);

        return copy;
      }

      recordWalkResult(value, memoKey, state, UNCHANGED, routeDependentBefore);

      return UNCHANGED;
    }

    // Keys first, then each value read inside its own guard - not `Object.entries`, which
    // runs every getter under one `catch`, so a single unrelated throwing accessor failed
    // the whole container closed and lost every sibling, the one a path named included.
    // The array branch above and the renderer both degrade one entry at a time.
    const copy: Record<string, unknown> = {};
    let didMask = false;

    // The keys a path actually names at this position, read off the index nodes already
    // resolved rather than by asking per key. Small and author-controlled - a handful of
    // entries from `redactedKeys`, never a function of the payload.
    const namedKeys = new Set<string>();

    for (const node of nodes) {
      for (const childKey of node.children.keys()) {
        namedKeys.add(childKey);
      }
    }

    // What each key walked to, so the budget can be spent in one order while the copy is
    // still built in the container's own.
    const results = new Map<string, unknown>();

    /**
     * Walk one entry into {@link results}. Answers `false` once the pass's entry budget
     * is gone, which is the caller's signal to stop.
     *
     * `Object.keys` builds a fresh array, so this branch cannot be lied to about its own
     * length - but the budget is per pass, not per container, and a payload of many small
     * objects spends it exactly as one huge array does. Stopping on the first key past the
     * budget rather than marking every remaining one matches the array branch above and
     * both of `maskValueDeep`'s branches: a `continue` still walked the whole key list and
     * still built an entry for each of them, so on the payload the cap exists for - a
     * container with more keys than the cap, a `Proxy` whose `ownKeys` reports millions
     * among them - the cap bounded neither the time nor the size of the copy being rebuilt,
     * which is the entire point of it. One marker stands for the tail.
     */
    const walkEntry = (key: string): boolean => {
      if (state.entriesLeft <= 0) {
        return false;
      }

      state.entriesLeft--;

      // A plain object's key, never an array slot, so a `*` in the list reaches it only
      // as the key literally spelled `*` - including on an object whose keys read as
      // numbers, which is not an array and which a wildcard therefore does not address.
      const entryPath = [...path, literalStep(key)];

      // Snapshotted rather than passed through, exactly as an array's element is. This is
      // the branch the leak was measured on: an object whose `up` getter answered `{}` to
      // the walk and a bag holding `password` to the renderer.
      if (isUnstableEntry(value, key)) {
        didMask = true;
        state.didSnapshotUnstable = true;
      }

      let result: unknown;
      let entryValue: unknown;

      // Read once and kept, as the array branch keeps its element: a value read again
      // for the `UNCHANGED` path below need not answer the same way twice.
      try {
        entryValue = (value as Record<string, unknown>)[key];
      } catch (error) {
        // The walk never saw what was here, so it cannot conclude nothing matched.
        report(error, pathText(entryPath));
        state.didFailToRead = true;
        didMask = true;
        results.set(key, REDACTION_FAILED_MARKER);

        return true;
      }

      // Guarded per entry, exactly as the array branch above and the renderer both are.
      try {
        result = redactPathsInner(
          entryValue,
          paths,
          entryPath,
          redactFunction,
          seen,
          state,
          report,
          shouldSkipScanBelow,
        );
      } catch (error) {
        // The walk never saw what was below, so it cannot conclude nothing matched there.
        report(error, pathText(entryPath));
        state.didFailToRead = true;
        result = REDACTION_FAILED_MARKER;
      }

      if (result !== UNCHANGED) {
        didMask = true;
      }

      results.set(key, result === UNCHANGED ? entryValue : result);

      return true;
    };

    // The keys a path names, before any of the others.
    //
    // The budget is per pass, so whichever entries are walked first are the ones that get
    // it - and `Object.keys` order is the payload's, not this list's. A subtree nothing
    // points into can be enormous and still has to be walked in full whenever the
    // candidate scan cannot clear it, so on `{ b: <a million keys>, s: 'topsecret' }` with
    // `['s']` the whole allowance went to `b`, and `s` - the one key the caller actually
    // named - came back as the failure marker. Reversing the order on the *same* payload
    // masked it correctly, which is a redaction that depended on key order. The named keys
    // are few and the caller's own, so spending the budget on them first bounds nothing
    // that was not already bounded.
    for (const key of shape.keys) {
      if (!namedKeys.has(key)) {
        continue;
      }

      if (!walkEntry(key)) {
        break;
      }
    }

    // Then everything else, in the container's own order.
    for (const key of shape.keys) {
      if (results.has(key)) {
        continue;
      }

      if (!walkEntry(key)) {
        break;
      }
    }

    // Built in `Object.keys` order whatever order the two passes above ran in, so the
    // rebuilt copy enumerates exactly as the original did.
    //
    // One marker for the tail, at the first position the budget did not reach - the same
    // shape the array branch and both of `maskValueDeep`'s branches produce. Entries
    // already walked still go in behind it: they are the ones a path named, and dropping
    // them to keep the marker at the end would lose the mask this pass exists for.
    let didMarkTail = false;

    for (const key of shape.keys) {
      if (results.has(key)) {
        // Defined rather than assigned: a plain assignment to `__proto__` is a no-op for a
        // string and reparents the object for an object, so a payload carrying that key
        // would silently lose the entry or change the shape of the result.
        defineEntry(copy, key, results.get(key));

        continue;
      }

      if (didMarkTail) {
        continue;
      }

      didMarkTail = true;
      state.didFailToRead = true;
      state.routeDependentResults++;
      didMask = true;
      defineEntry(copy, key, REDACTION_FAILED_MARKER);
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
      recordWalkResult(value, memoKey, state, copy, routeDependentBefore);

      return copy;
    }

    recordWalkResult(value, memoKey, state, UNCHANGED, routeDependentBefore);

    return UNCHANGED;
  } finally {
    seen.delete(value);

    if (origin !== undefined) {
      seen.delete(origin);
    }
  }
}

/**
 * Note what `value` walked to, when that answer can be reused by every other route that
 * reaches it from the same position.
 *
 * Only for an answer that does not depend on the route taken to get here; see
 * `RedactState.walkResults` for why that is what makes the memo sound.
 *
 * @param routeDependentBefore `RedactState.routeDependentResults` as it stood when the
 *        walk of this node began. Unchanged means nothing under it hit a cycle or the
 *        entry budget, so what it came back with is a property of the position.
 */
function recordWalkResult(
  value: object,
  memoKey: string,
  state: RedactState,
  result: unknown,
  routeDependentBefore: number,
): void {
  if (state.routeDependentResults !== routeDependentBefore) {
    return;
  }

  let byPosition: Map<string, unknown>;

  try {
    const existing = state.walkResults.get(value);

    if (existing === undefined) {
      byPosition = new Map();
      state.walkResults.set(value, byPosition);
    } else {
      byPosition = existing;
    }
  } catch {
    // Not a usable `WeakMap` key, so this node is simply walked again if it recurs.
    return;
  }

  byPosition.set(memoKey, result);
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
 *
 * With one exception, and it is the cap rather than the rule: past
 * {@link MAX_REDACTION_ENTRIES} the walk can no longer tell whether a subtree it has not
 * finished holds something named, so it stops and stands a {@link REDACTION_FAILED_MARKER}
 * in for the rest. A container reached in that state comes back as a truncated rebuild
 * even though nothing in it matched. Fails closed by design - handing the tail back by
 * reference would be returning entries the walk never looked at - and the keys a path
 * actually names are walked first, so it is the unnamed bulk that degrades.
 */
export function redactMatchedPaths(
  value: unknown,
  paths: RedactPath[],
  redactFunction: RedactLeafFunction | undefined,
  report: ReportFormatFailure = NOOP_FORMAT_REPORTER,
  aliases?: ForwardingAliases,
  reportRender: ReportFormatFailure = NOOP_FORMAT_REPORTER,
  maskBudget: RenderBudget = createRenderBudget(),
): unknown {
  const state: RedactState = {
    didMaskAnything: false,
    didFailToRead: false,
    didSnapshotUnstable: false,
    didTruncate: false,
    walkResults: new WeakMap(),
    routeDependentResults: 0,
    entriesLeft: MAX_REDACTION_ENTRIES,
    scanLeft: MAX_REDACTION_ENTRIES,
    aliases,
    reportRender,
    maskBudget,
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
  // The depth cap is excluded for exactly that reason - it is the walk declining to look -
  // and a snapshot is excluded because handing the original back undoes it. See
  // {@link RedactState.didTruncate}.
  if (result === UNCHANGED) {
    return value;
  }

  return state.didMaskAnything ||
    state.didFailToRead ||
    state.didSnapshotUnstable ||
    state.didTruncate
    ? result
    : value;
}
