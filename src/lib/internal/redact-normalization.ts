/**
 * The pass that settles the walk and whatever reads its result on one snapshot of every
 * container a redaction path descends through.
 *
 * Here rather than in the logger because both public entry points that redact need it:
 * `applyRedaction` runs it over the params bag, and `stringify-value`'s `redactValueWith`
 * runs it over a synthetic one-key bag holding the value it was given. It lived in
 * `logger/utils/redaction.ts` while the logger was its only caller, which left
 * `stringify-value` - a separate entry point, bundled separately - importing a logger
 * feature module's private util. `internal/` is where code shared by the two belongs.
 *
 * `normalizeParamsBag` is deliberately *not* here: flattening the bag itself is the
 * logger's own step, and only the machinery below is shared.
 */

import { defineEntry } from './container-entries';
import { REDACTION_FAILED_MARKER } from './default-redact-function';
import type { ReportFormatFailure } from './format-reporter';
import { isPlainContainer } from './is-plain-container';
import { WILDCARD_PATH_SEGMENT } from './path-utils';
import {
  MAX_REDACTION_ENTRIES,
  redactPathPrefixes,
  type ForwardingAliases,
  type RedactPath,
  type RedactPrefixNode,
} from './redact-paths';

/**
 * A container holding exactly the keys `for...in` yields, each forwarding to the original.
 *
 * The same normalization {@link normalizeParamsBag} performs on the bag, one level down,
 * and it exists for the same reason: the walk enumerates, the template renderer looks a
 * property up, and every key one can reach that the other cannot is a value printed
 * without being masked.
 *
 * Getters are *forwarded* rather than read, unlike the bag's own copy. Nothing is read
 * here at all, so `Object.entries` in the walk runs the original accessor exactly when it
 * ran it before and fails the container closed exactly as it did - only the set of keys
 * changes. An array is rebuilt from its indexes alone, which is what the walk iterates.
 *
 * @param copies Every copy made during one normalization, keyed by the object it stands
 *        for *and by itself*. Keying it by the original is what makes a cycle terminate
 *        and what lets two paths through the same object share one copy. Keying it by
 *        itself is what stops a copy from being copied again: the first path through a
 *        prefix installs its copy in the container, so the second path reads that copy
 *        back out and asks to normalize *it* - a copy that is already normalized, and
 *        whose keys are already exactly the ones being asked for. Without this, `n`
 *        entries sharing a prefix stacked `n` layers of forwarding getters at every step
 *        of it, so each of the walk's reads ran `n` frames deep and the whole
 *        normalization went quadratic in the length of `redactedKeys`. Measured on one
 *        container behind one prefix, 200k reads cost 4.9ms for a single entry and 679ms
 *        for 256 of them.
 *
 * @returns The copy, or `null` when the original refuses to be enumerated - in which case
 *          the caller leaves it in place and the walk's own guards fail it closed.
 */
function forwardingContainerCopy(
  source: object,
  copies: Map<object, object>,
  aliases: ForwardingAliases,
): object | null {
  const existing = copies.get(source);

  if (existing !== undefined) {
    return existing;
  }

  // The copy under construction, held out here so a refusal on any path - the entry cap
  // in either branch, or a throw - can take it back out of both maps. A refused copy is
  // never installed, but one left registered kept a large half-built container alive in
  // `copies` and `aliases` for the rest of the pass.
  let copy: object | undefined;

  const discard = (): null => {
    copies.delete(source);

    if (copy !== undefined) {
      copies.delete(copy);
      aliases.delete(copy);
    }

    return null;
  };

  try {
    if (Array.isArray(source)) {
      const elements = source as unknown[];
      const length = elements.length;

      // Both checks below bound this copy exactly as the walk that follows is bounded, and
      // for the same reason: this runs one `defineProperty` per element, *before* the walk
      // `MAX_REDACTION_ENTRIES` bounds, so any entry descending into a large array paid the
      // cost the cap exists to refuse. A three-million-element array cost 4 seconds and about a gigabyte synchronously
      // inside `logger.info()`, and `Array.isArray` being true for a `Proxy` whose `length`
      // trap answers `2 ** 32 - 1` made it a permanent hang on the main thread - the same
      // lie the walk already defends against. Refusing the copy rather than truncating it:
      // a partial copy would be installed in place of the original and silently drop every
      // element past the bound, where `null` leaves the caller's container alone and the
      // walk's own guards fail it closed.
      //
      // `length` is the caller's, and a `Proxy` trap need not answer with an integer at
      // all. `NaN > MAX_REDACTION_ENTRIES` is `false`, so a `NaN` walked straight past the
      // bound below, then seeded `definedNamed` with `NaN` so the named-key cap
      // (`definedNamed >= MAX_REDACTION_ENTRIES`) was false forever too - one lie about
      // `length` disabling both caps at once - while the index loop ran zero times and
      // silently dropped every element from a line that still looked successful. The same
      // check `stepKeys` already makes, asked before the bound so the bound can be a plain
      // comparison.
      if (!Number.isSafeInteger(length) || length < 0) {
        return null;
      }

      if (length > MAX_REDACTION_ENTRIES) {
        return null;
      }

      const arrayCopy: unknown[] = [];

      copy = arrayCopy;
      copies.set(source, arrayCopy);
      copies.set(arrayCopy, arrayCopy);
      aliases.set(arrayCopy, source);

      for (let index = 0; index < length; index++) {
        Object.defineProperty(arrayCopy, index, {
          get: () => elements[index],
          enumerable: true,
          configurable: true,
        });
      }

      // An array's *named* properties too, and not only its indexes. The copy replaces the
      // original in the container above it, so anything this branch does not carry over is
      // simply gone - and `CurlyBrackets` resolves `items.note` by property read, so
      // redacting an unrelated sibling with `redactedKeys: ['items[0]']` turned a perfectly
      // ordinary `items.note` from `request-42` into the fallback. The object branch
      // already used `for...in` for exactly this reason; the array branch stopped at the
      // indexes the walk iterates and forgot that the renderer does not.
      // `Object.keys` rather than `for...in`: the indexes are already defined above, so
      // what is wanted here is exactly the own enumerable keys that are not indexes - and
      // the lint rule against `for...in` over an array is making the same point.
      const asRecord = elements as unknown as Record<string, unknown>;

      // Counted against the same bound the indexes were, and continuing from them: the
      // length check above bounds only what `length` admits to, and an `ownKeys` trap is as
      // free to invent a million *named* keys as a `length` trap is to invent a million
      // elements - a `Proxy` over `[]` answering `0` for `length` walked straight past that
      // check and then ran a million `defineProperty` calls synchronously inside
      // `logger.info()`. Refused rather than truncated, for the reason the length check is:
      // a partial copy is installed in place of the original and silently loses the rest.
      let definedNamed = length;

      for (const key of Object.keys(asRecord)) {
        if (Object.prototype.hasOwnProperty.call(arrayCopy, key)) {
          continue;
        }

        if (definedNamed >= MAX_REDACTION_ENTRIES) {
          return discard();
        }

        definedNamed++;

        const named = key;

        Object.defineProperty(arrayCopy, named, {
          get: () => asRecord[named],
          enumerable: true,
          configurable: true,
        });
      }

      return arrayCopy;
    }

    const record = source as Record<string, unknown>;
    const recordCopy: Record<string, unknown> = {};

    copy = recordCopy;
    copies.set(source, recordCopy);
    copies.set(recordCopy, recordCopy);
    aliases.set(recordCopy, source);

    // `for...in`, matching the bag's own copy: a key on the prototype is resolvable by the
    // renderer, so the walk has to see it too.
    //
    // Counted against the same bound as the array branch above, since an `ownKeys` trap is
    // as free to invent a million keys as a `length` trap is to invent a million elements.
    let defined = 0;

    for (const key in record) {
      if (defined >= MAX_REDACTION_ENTRIES) {
        return discard();
      }

      defined++;

      Object.defineProperty(recordCopy, key, {
        get: () => record[key],
        enumerable: true,
        configurable: true,
      });
    }

    return recordCopy;
  } catch {
    return discard();
  }
}

/**
 * Extend the bag's normalization down every path the caller named.
 *
 * {@link normalizeParamsBag} settles the walk and the renderer on one set of keys for the
 * bag itself, and that is where it stopped: values below the bag are passed to the walk by
 * reference, so a key one level down that `Object.entries` cannot see - a non-enumerable
 * own property, one a `Proxy` hides from `ownKeys`, a named property on an array - was
 * never masked, while `CurlyBrackets` resolved it with `in` plus a property read and
 * printed it. `redactedKeys: ['password']` on such a key renders the fallback;
 * `['user.password']` on the identical shape one level deeper printed the secret.
 *
 * Only the containers a parsed path actually descends through are normalized, so the cost
 * is bounded by what the caller named rather than by the size of the payload, and every
 * other value still reaches the walk - and `redactedParams` - by reference. A wildcard is
 * the one segment that widens that: `items[*].token` descends through every element of
 * `items`, exactly as `items[0].token` descends through one, which is what keeps a
 * wildcard from covering less than the path it generalizes.
 *
 * The copy is installed in place of the original, which is safe because the only things
 * written into are this module's own: the bag from {@link normalizeParamsBag} at the first
 * step, and a copy made here at every step after it.
 *
 * Shared with `redactValue` and `stringifyValue`, which need the same pass over the value
 * they are given. They have no params bag, so they build a synthetic one-key bag and root
 * their paths at it - see `redactValueWith` - which is what lets one normalization serve
 * both surfaces rather than the two drifting apart. The requirement is only that `bag` is
 * the caller's own object: this writes into it.
 */
export function normalizeAlongRedactPaths(
  bag: Record<string, unknown>,
  paths: RedactPath[],
  aliases: ForwardingAliases,
  report: ReportFormatFailure,
): void {
  const copies = new Map<object, object>();

  // The paths as a prefix *tree*, walked once, rather than as a list walked once per
  // entry. Both reach the same containers, and the difference is what each costs: five
  // entries under `arr[*]` descend one shared prefix five times as a list, so a bound on
  // the work charges the same array five times over and runs out four times sooner than
  // the work warrants. Charged once here, which is what makes the budget below a measure
  // of containers normalized rather than of entries written.
  const stack: NormalizationFrame[] = [
    { container: bag, node: redactPathPrefixes(paths) },
  ];

  // A wildcard turns a path from a chain into a fan-out - `a[*].b[*].c` reaches the
  // product of two array lengths - and this runs *before* the walk that
  // {@link MAX_REDACTION_ENTRIES} bounds, so without a cap of its own it would spend on
  // forwarding copies exactly the time that cap exists to refuse. Per pass rather than per
  // entry, exactly like the walk's own counter.
  //
  // Charged per container actually descended into, and nowhere else. A slot holding a
  // primitive is free, and that is the whole difference between this and a counter that
  // charges per key *inspected*: `items[*].x` over a million numbers normalizes nothing,
  // and charging it a million abandoned every frame still on the stack - including, in bag
  // order, a container the caller had separately named. That failure is worse than the
  // walk's own truncation, because it plants no marker and reports nothing. The renderer
  // is simply handed the original, with a key only a property read can reach still on it.
  //
  // The cap alone does not bound what those frames then *inspect*, which is the length of
  // the container each one descends into, so `descended` below deduplicates them. One
  // array reachable from many places was pushed once per alias and rescanned in full each
  // time - four thousand orders sharing one hundred-thousand-element array under
  // `orders[*].items[*].card` cost 76 seconds synchronously inside `logger.info()`, for
  // about four thousand charges, on a payload of a few hundred kilobytes. `copies`
  // deduplicates the copy; it does not deduplicate the descent, and the descent is where
  // the time goes.
  //
  // Inspecting a slot is still uncharged, and is not free: the copy's index is a
  // forwarding getter, so this re-enters the caller's own `get` trap when the source is a
  // `Proxy`. What the two bounds together buy is that it happens once per distinct
  // container *per prefix node* - the dedupe key is the pair - rather than once per route
  // to it, and that the frames doing it are capped, which is what stops a payload that
  // fans out through itself: a thousand-element array holding only itself would otherwise
  // reach a billion frames three wildcards deep.
  //
  // "Per prefix node" is the part a hostile *configuration* can still buy width with, and
  // it is left that way deliberately. A single 3 KB entry - `a` followed by a thousand
  // `[*]` - is a thousand prefix nodes over one array, and rescans it once for each: 20
  // seconds on an 800 KB payload. A thousand entries with distinct prefixes onto one
  // shared array cost the same. Nothing caps the length of an entry or the number of
  // distinct prefixes, and nothing sensibly could without refusing lists that are merely
  // long. It is the same class as the width bound on `findRedactPathNodes`: a cost a
  // developer's own `redactedKeys` can write, and one no payload can provoke on its own.
  // There is no payload-only shape left that stalls.
  //
  // Running out normalizes fewer containers than asked. It used to be left at that - a
  // real loss, said through `onFormatError` but otherwise fail-open: every container the
  // walk had not reached stayed the caller's original, and a key only a property read
  // can find - one a `Proxy` hides from `ownKeys`, a non-enumerable own property - was
  // still resolved by the renderer and printed, on the one shape the rest of this pass
  // exists to close. Now every container still waiting to be descended is withheld with
  // the marker instead, at the key its parent holds it under, which is what the walk
  // already does to a container it cannot copy. A path *did* descend into each of them,
  // so everything beneath was named for masking; over-masking is the safe direction, and
  // it costs one write per stacked pair rather than the scan that ran out. Still *said*,
  // since a marker only says that a value was withheld and this is the why.
  let budget = MAX_REDACTION_ENTRIES;

  // The `(container, node)` pairs already descended. Re-descending one is a strict no-op -
  // the copy comes back from `copies`, `defineEntry` rewrites the identical value, and the
  // same children are pushed again - so skipping it gives up nothing but the rescan. The
  // one thing it does give up is a second chance for a getter that throws once and then
  // answers, which is the policy `normalizeParamsBag` already settles: marking a getter
  // that threw is the answer redaction should give.
  const descended = new WeakMap<object, Set<RedactPrefixNode>>();

  while (stack.length > 0) {
    const current = stack.pop() as NormalizationFrame;
    const { container, node } = current;

    for (const [part, child] of node.children) {
      // A leaf names the value to mask, not a container to descend into.
      if (child.children.size === 0) {
        continue;
      }

      for (const key of stepKeys(container, part)) {
        if (budget <= 0) {
          report(
            new Error(
              `redactedKeys normalization stopped after ${String(MAX_REDACTION_ENTRIES)} containers; every container not yet reached was withheld`,
            ),
            '<redactedKeys>',
          );

          withholdUnreached(current, stack);

          return;
        }

        // Addressable, not merely readable. `container['__proto__']` resolves through the
        // accessor on `Object.prototype`, whose value `isPlainContainer` accepts by way of
        // its null-prototype branch - so a path spelled `__proto__.x` widened the bag with
        // a fabricated `__proto__` key that every sink then serialized into the log line.
        // Nothing was polluted, since every write here goes through `defineProperty`, but
        // the bag grew a key the caller never had. The walk sees own keys and inherited
        // *enumerable* ones; this has to see exactly the same set.
        if (!isAddressableKey(container, key)) {
          continue;
        }

        let value: unknown;

        try {
          value = container[key];
        } catch (error) {
          // Withheld, not skipped. A skip left the caller's own accessor in this parent -
          // the bag's forwarding getter, or the copy's - for the walk and the renderer to
          // call again, and an accessor that throws once and answers afterwards is the
          // second-read class this pass exists to close: nothing was snapshotted, so the
          // walk's read and the render's read were free to disagree. A path named this
          // key, so every value beneath it was named for masking; the marker is the safe
          // direction, exactly as it is for a copy that was refused below.
          report(
            new Error(
              'container could not be read for redaction and was withheld',
              { cause: error },
            ),
            key,
          );

          // Not guarded: the parent is the bag or a copy this module built, both plain
          // and writable, so this cannot fail - and if it does, the throw is the
          // fallback, since every caller answers a throw out of this pass by failing the
          // whole value closed. See the install below.
          defineEntry(container, key, REDACTION_FAILED_MARKER);

          continue;
        }

        // Only a plain container is walked as structure. Anything else is masked whole
        // when a path points into it, so its own keys are never resolved separately.
        if (!isPlainContainer(value)) {
          continue;
        }

        const copy = forwardingContainerCopy(value, copies, aliases);

        if (copy === null) {
          // Replaced with the marker, not left in place. A refused copy - an array past
          // `MAX_REDACTION_ENTRIES`, a prototype that enumerates past it, a read that
          // threw - used to leave the caller's own container here on the assumption that
          // the walk's guards fail it closed. They do not, if its `Object.keys` look
          // innocent: the walk matches nothing, hands the original back by reference, and
          // a key it enumerates nowhere - a non-enumerable own property, one a `Proxy`
          // hides from `ownKeys`, a named property on an array - is still resolved by the
          // renderer's property read and printed. That is the hidden-key class this whole
          // normalization exists to close, and the marker is the only answer that closes
          // it here. A path *did* descend into this container, so every key beneath it
          // was named for masking; over-masking the container is the safe direction.
          //
          // Reported as well as marked, on the redaction channel, the way the walk reports
          // a container it cannot read: the marker says *that* a value was withheld, and
          // `onFormatError` is the promise of *why*.
          report(
            new Error(
              'container could not be normalized for redaction and was withheld',
            ),
            key,
          );

          // Not guarded, for the reason the install below gives.
          defineEntry(container, key, REDACTION_FAILED_MARKER);

          continue;
        }

        // Installed into *this* parent regardless of whether the descent below is a
        // repeat, and the order matters. A parent skipped before this keeps a forwarding
        // getter onto the caller's own container, and where nothing beneath matches the
        // walk hands that value back by reference - so the original reaches
        // `redactedParams` with every key a property read can still resolve on it, while
        // the parent that was descended holds a copy carrying none of them.
        //
        // Not guarded. A failed install skipped with the parent's forwarding getter onto
        // the caller's own container still in place - the same shape as a skipped read,
        // on the write - and the parent is one this module built, so a failure here is a
        // broken invariant rather than hostile input. The throw is the fail-closed
        // answer: `applyRedaction` marks every named key, and `stringifyValue`,
        // `redactValue` and `errorToString` withhold the whole value.
        defineEntry(container, key, copy);

        let alreadyUnder = descended.get(copy);

        if (alreadyUnder === undefined) {
          alreadyUnder = new Set();
          descended.set(copy, alreadyUnder);
        }

        if (alreadyUnder.has(child)) {
          continue;
        }

        alreadyUnder.add(child);

        budget--;
        stack.push({
          container: copy as Record<string, unknown>,
          node: child,
          parent: container,
          key,
        });
      }
    }
  }
}

/**
 * One `(container, node)` pair waiting to be descended, and where its parent holds it, so
 * the whole container can be withheld if the walk runs out before reaching it.
 */
interface NormalizationFrame {
  container: Record<string, unknown>;
  node: RedactPrefixNode;
  /** Absent for the root bag, which has no parent to hold it. */
  parent?: Record<string, unknown>;
  key?: string;
}

/**
 * Withhold every container the normalization did not get to: the one it was inside when
 * the budget ran out, and every one still stacked behind it.
 *
 * Each is replaced at its parent's key with the marker, as a container that could not be
 * copied is. The root bag has no parent; what the walk had not reached beneath it is
 * covered by the frames stacked under it, since a root child is only ever reached by
 * being pushed. A parent is the bag or a copy this module built, so the write cannot
 * fail - and it is not guarded, for the reason the walk's own installs are not: a failure
 * here is a broken invariant, and the throw reaches the caller, which fails the whole
 * value closed. A swallowed failure would leave the parent's forwarding getter onto the
 * caller's own container in place, on exactly the frame this was called to withhold.
 */
function withholdUnreached(
  current: NormalizationFrame,
  stack: NormalizationFrame[],
): void {
  const frames = [current, ...stack];

  for (const frame of frames) {
    if (frame.parent === undefined || frame.key === undefined) {
      continue;
    }

    defineEntry(frame.parent, frame.key, REDACTION_FAILED_MARKER);
  }
}

/**
 * Whether `key` names something the walk can address on `container`.
 *
 * Own properties, and inherited ones only where they are enumerable - which is the set
 * `normalizeParamsBag` flattens and therefore the set the walk resolves. A non-enumerable
 * inherited accessor, `__proto__` being the one that matters, names nothing the walk will
 * ever reach.
 */
function isAddressableKey(container: object, key: string): boolean {
  try {
    if (Object.prototype.hasOwnProperty.call(container, key)) {
      return true;
    }

    for (
      let proto: object | null = Object.getPrototypeOf(container) as
        object | null;
      proto !== null;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, key);

      if (descriptor !== undefined) {
        return descriptor.enumerable === true;
      }
    }
  } catch {
    // A `Proxy` that refuses to answer. Nothing addressable can be established, and the
    // walk's own guards fail the container closed when it reaches it.
    return false;
  }

  return false;
}

/**
 * The keys `part` addresses on `container` - one, or every slot of an array under a `*`.
 *
 * Answers the same question `redact-paths` answers during the walk, and has to answer it
 * the same way: this pass and the walk disagreeing about what an entry addresses is how a
 * container gets widened for a path that never reaches it, or - the direction that leaks -
 * how a path reaches a container whose hidden keys were never widened for it. So a
 * wildcard expands over an array's indexes only. Against a plain object, including one
 * whose keys merely read as numbers, it is the key literally spelled `*`, which is the
 * literal step this yields for every other segment.
 *
 * An array's own `*` named property is yielded alongside its slots, for the same reason:
 * the walk reaches it as a literal key, so this has to offer it as one too. It comes first
 * so the literal reading is offered before a long run of slots.
 *
 * Yielded rather than collected, so a wildcard over a wide array costs one string at a
 * time instead of a million-entry key list built before the caller looks at any of it.
 */
function* stepKeys(container: object, part: string): Generator<string> {
  if (part !== WILDCARD_PATH_SEGMENT) {
    yield part;

    return;
  }

  let length: number;

  try {
    if (!Array.isArray(container)) {
      yield part;

      return;
    }

    length = (container as unknown[]).length;
  } catch {
    // A revoked `Proxy`, or a `length` that refuses. Nothing to descend into, and the
    // walk's own guards fail the container closed when it reaches it.
    return;
  }

  yield part;

  // No cap of its own, and none needed: `length` here is the length of a *copy*. Every
  // array this is called with came back from `forwardingContainerCopy`, which refuses one
  // longer than `MAX_REDACTION_ENTRIES` outright, and the bag it starts from is a record.
  // So the fan-out is already bounded by that cap one level up - measured at
  // `new Array(20_000_000)` under `items[*].x`, which is refused at the copy and never
  // reaches here - and a second cap would only disagree with the first. A `Proxy` cannot
  // widen it either: the copy is a plain array whose own indexes were defined under that
  // same bound, so no `length` trap is consulted here.
  if (!Number.isSafeInteger(length) || length <= 0) {
    return;
  }

  for (let index = 0; index < length; index++) {
    yield String(index);
  }
}

/**
 * Names the root of a value that has no key of its own, as the render walk spells it.
 *
 * Also the key `stringifyValue`, `redactValue` and `errorToString` root a value under when
 * they hand it to {@link normalizeAlongRedactPaths}: the pass needs a parent to install the
 * first copy into, and the value's own parent belongs to the caller, so each entry point
 * wraps it in a one-key bag of its own and unwraps the walk's answer with
 * {@link unwrapRedactionRoot}.
 */
export const ANONYMOUS_ROOT = '<value>';

/**
 * A failure subject spelled as if the walk had been given the value rather than the bag.
 *
 * The walk names a position by joining the path it is standing on, and a caller that roots
 * every path at {@link ANONYMOUS_ROOT} before handing it over would see a leaf it knows as
 * `user.token` reported as `<value>.user.token`. The wrapping is an implementation detail
 * of how the value is normalized; it must not reach the handler.
 *
 * Only the rooted form is rewritten. A subject the walk did not build from a path - an
 * entry as the caller wrote it, `<root>` for the bag itself - is already what it should
 * be and is passed through.
 */
export function unrootedSubject(path: string): string {
  if (path === ANONYMOUS_ROOT) {
    // The value as a whole, which is what `<root>` meant when the value *was* the root.
    return '<root>';
  }

  return path.startsWith(`${ANONYMOUS_ROOT}.`)
    ? path.slice(ANONYMOUS_ROOT.length + 1)
    : path;
}

/** A reporter that spells its subject with {@link unrootedSubject} first. */
export function unrootedReport(
  report: ReportFormatFailure,
): ReportFormatFailure {
  return (error: unknown, path: string): void => {
    report(error, unrootedSubject(path));
  };
}

/**
 * The masked value back out of the bag it was walked in.
 *
 * The walk returns either the bag itself, a rebuilt copy of it, or - when the root's own
 * keys could not be read at all - a single {@link REDACTION_FAILED_MARKER} standing in for
 * the whole thing. Only the first two carry the value, and a marker where a bag was
 * expected is the walk having failed closed, so it is handed on as one rather than being
 * unwrapped into `undefined`, which would read as "there was nothing here".
 */
export function unwrapRedactionRoot(walked: unknown): unknown {
  if (!isPlainContainer(walked) || Array.isArray(walked)) {
    return REDACTION_FAILED_MARKER;
  }

  return (walked as Record<string, unknown>)[ANONYMOUS_ROOT];
}
