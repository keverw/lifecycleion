import {
  defaultRedactValue,
  REDACTION_FAILED_MARKER,
} from '../../internal/default-redact-function';
import { defineEntry } from '../../internal/container-entries';
import { isPlainContainer } from '../../internal/is-plain-container';
import { WILDCARD_PATH_SEGMENT } from '../../internal/path-utils';
import {
  MAX_REDACTION_ENTRIES,
  parseRedactPaths,
  redactMatchedPaths,
  redactPathPrefixes,
  snapshotList,
  type ForwardingAliases,
  type RedactPath,
  type RedactPrefixNode,
} from '../../internal/redact-paths';
import type { RedactFunction } from '../types';
import {
  createFormatReporter,
  type FormatErrorHandler,
} from '../../internal/format-reporter';

/**
 * Default redaction function using datamask
 * Masks sensitive values with asterisks
 */
export const defaultRedactFunction: RedactFunction = defaultRedactValue;

export { REDACTION_FAILED_MARKER } from '../../internal/default-redact-function';

/**
 * The params bag as a plain object holding exactly what the walk and the renderer can
 * both reach.
 *
 * Always copied, and copied with `for...in` rather than a spread. Both halves of that
 * fix the same class of bug: the walk enumerates a bag, while the template renderer
 * resolves `{{name}}` by property lookup, and every key one of them can see that the
 * other cannot is either a value printed without being masked or a value masked out of a
 * message that would have printed it.
 *
 * - A spread and `Object.entries` see only *own enumerable* properties, so a key on the
 *   prototype - a bag built with `Object.create`, or a class instance - was invisible to
 *   redaction while the renderer still resolved it. `for...in` walks the prototype chain,
 *   so both now see it and it is masked and printed as it was before this walk existed.
 * - Neither sees a *non-enumerable* own property, or one a `Proxy` hides from `ownKeys`,
 *   but property lookup does. Handing the caller's own bag straight to the walk left such
 *   a key unmasked *and* still resolvable, so `{{password}}` rendered a secret the
 *   caller had explicitly named. Copying means the renderer is given this object instead,
 *   which does not carry the key at all: it is neither masked nor printed, which is what
 *   the walk not seeing it has to mean.
 *
 * Values are copied by reference, so this stays shallow - `redactedParams` is still not
 * a snapshot of what lies beneath it.
 *
 * Defined rather than assigned, because a plain assignment to `__proto__` reparents the
 * object instead of storing the entry.
 *
 * Every value is read inside its own guard, so one throwing accessor marks its own key
 * rather than abandoning the bag. This used to be the second of two passes - an unguarded
 * copy first, this one only if that threw - which read every value twice whenever any of
 * them failed, and let a getter that throws once and then answers be retried until it
 * produced a value. Measured across sixteen hostile bags, the two passes agreed on all
 * but that one case, and marking a getter that threw is the answer redaction should give.
 *
 * @param unreadable Collects the keys whose read threw, *with the value they threw*, so
 *                   the caller can put the marker back after the walk and report the
 *                   cause. Carrying only the key left this the one redaction failure with
 *                   no channel at all: the marker landed in the output and
 *                   `onFormatError` never fired, which is exactly the silence that
 *                   handler exists to end. A key that is *also* named in `redactedKeys`
 *                   reaches the walk already holding the marker, and the walk masks
 *                   whatever it finds - turning `***REDACTION FAILED***` into an
 *                   ordinary-looking `**********`, exactly the disguise the distinct
 *                   marker exists to prevent.
 */
function normalizeParamsBag(
  params: Record<string, unknown>,
  unreadable: { key: string; error: unknown }[],
  aliases: ForwardingAliases,
): Record<string, unknown> {
  const copy: Record<string, unknown> = {};

  // The walk's cycle guard keys on object identity, and this hands it a *different* object
  // than the one the payload's own back-edges point at. Unmarked, `const c = { password:
  // 'secret' }; c.self = c;` walked `copy`, reached `c` through `self`, found it unseen,
  // and - since no path pointed below `self` - handed the original subtree back by
  // reference: the renderer printed the secret and `redactedParams.self.password` carried
  // it to every structured sink. Marked, the walk adds both to `seen` and the back-edge is
  // recognized as the node it is already inside.
  aliases.set(copy, params);

  for (const key in params) {
    let value: unknown;

    try {
      value = params[key];
    } catch (error) {
      value = REDACTION_FAILED_MARKER;
      unreadable.push({ key, error });
    }

    defineEntry(copy, key, value);
  }

  return copy;
}

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

  try {
    if (Array.isArray(source)) {
      const elements = source as unknown[];
      const length = elements.length;

      // Bounded exactly as the walk is, and for the same reason. This runs *before* the
      // walk that `MAX_REDACTION_ENTRIES` bounds, one `defineProperty` per element, so any
      // entry descending into a large array paid the cost the cap exists to refuse: a
      // three-million-element array cost 4 seconds and about a gigabyte synchronously
      // inside `logger.info()`, and `Array.isArray` being true for a `Proxy` whose `length`
      // trap answers `2 ** 32 - 1` made it a permanent hang on the main thread - the same
      // lie the walk already defends against. Refusing the copy rather than truncating it:
      // a partial copy would be installed in place of the original and silently drop every
      // element past the bound, where `null` leaves the caller's container alone and the
      // walk's own guards fail it closed.
      if (length > MAX_REDACTION_ENTRIES) {
        return null;
      }

      const copy: unknown[] = [];

      copies.set(source, copy);
      copies.set(copy, copy);
      aliases.set(copy, source);

      for (let index = 0; index < length; index++) {
        Object.defineProperty(copy, index, {
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

      for (const key of Object.keys(asRecord)) {
        if (Object.prototype.hasOwnProperty.call(copy, key)) {
          continue;
        }

        const named = key;

        Object.defineProperty(copy, named, {
          get: () => asRecord[named],
          enumerable: true,
          configurable: true,
        });
      }

      return copy;
    }

    const record = source as Record<string, unknown>;
    const copy: Record<string, unknown> = {};

    copies.set(source, copy);
    copies.set(copy, copy);
    aliases.set(copy, source);

    // `for...in`, matching the bag's own copy: a key on the prototype is resolvable by the
    // renderer, so the walk has to see it too.
    //
    // Counted against the same bound as the array branch above, since an `ownKeys` trap is
    // as free to invent a million keys as a `length` trap is to invent a million elements.
    let defined = 0;

    for (const key in record) {
      if (defined >= MAX_REDACTION_ENTRIES) {
        copies.delete(source);

        return null;
      }

      defined++;

      Object.defineProperty(copy, key, {
        get: () => record[key],
        enumerable: true,
        configurable: true,
      });
    }

    return copy;
  } catch {
    copies.delete(source);

    return null;
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
 */
function normalizeAlongRedactPaths(
  bag: Record<string, unknown>,
  paths: RedactPath[],
  aliases: ForwardingAliases,
): void {
  const copies = new Map<object, object>();

  // The paths as a prefix *tree*, walked once, rather than as a list walked once per
  // entry. Both reach the same containers, and the difference is what each costs: five
  // entries under `arr[*]` descend one shared prefix five times as a list, so a bound on
  // the work charges the same array five times over and runs out four times sooner than
  // the work warrants. Charged once here, which is what makes the budget below a measure
  // of containers normalized rather than of entries written.
  const stack: {
    container: Record<string, unknown>;
    node: RedactPrefixNode;
  }[] = [{ container: bag, node: redactPathPrefixes(paths) }];

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
  // Running out still normalizes fewer containers than asked, and that is a real loss
  // rather than a safe one - but there is no cheaper answer, since refusing the whole bag
  // would leave every key already widened half-applied.
  let budget = MAX_REDACTION_ENTRIES;

  // The `(container, node)` pairs already descended. Re-descending one is a strict no-op -
  // the copy comes back from `copies`, `defineEntry` rewrites the identical value, and the
  // same children are pushed again - so skipping it gives up nothing but the rescan. The
  // one thing it does give up is a second chance for a getter that throws once and then
  // answers, which is the policy `normalizeParamsBag` already settles: marking a getter
  // that threw is the answer redaction should give.
  const descended = new WeakMap<object, Set<RedactPrefixNode>>();

  while (stack.length > 0) {
    const { container, node } = stack.pop() as {
      container: Record<string, unknown>;
      node: RedactPrefixNode;
    };

    for (const [part, child] of node.children) {
      // A leaf names the value to mask, not a container to descend into.
      if (child.children.size === 0) {
        continue;
      }

      for (const key of stepKeys(container, part)) {
        if (budget <= 0) {
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
        } catch {
          continue;
        }

        // Only a plain container is walked as structure. Anything else is masked whole
        // when a path points into it, so its own keys are never resolved separately.
        if (!isPlainContainer(value)) {
          continue;
        }

        const copy = forwardingContainerCopy(value, copies, aliases);

        if (copy === null) {
          continue;
        }

        // Installed into *this* parent regardless of whether the descent below is a
        // repeat, and the order matters. A parent skipped before this keeps a forwarding
        // getter onto the caller's own container, and where nothing beneath matches the
        // walk hands that value back by reference - so the original reaches
        // `redactedParams` with every key a property read can still resolve on it, while
        // the parent that was descended holds a copy carrying none of them.
        try {
          defineEntry(container, key, copy);
        } catch {
          continue;
        }

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
        stack.push({ container: copy as Record<string, unknown>, node: child });
      }
    }
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

  if (!Number.isSafeInteger(length) || length <= 0) {
    return;
  }

  for (let index = 0; index < length; index++) {
    yield String(index);
  }
}

/**
 * Every redacted key marked as failed, used whenever nothing safer can be produced.
 *
 * Exported because two layers need the same answer: `applyRedaction` when the list is
 * present but unusable, and any caller that has to fail a whole redacted log call closed.
 * Written twice, the two drifted the moment either changed what "all marked" means, and a
 * sink would then have seen a different shape depending on which layer gave up.
 *
 * Guarded throughout: this runs precisely because the input could not be trusted, so it
 * must not assume `redactedKeys` is a usable array - a fail-closed branch that throws is
 * not fail-closed. With nothing nameable to mark, an empty object is the safe answer,
 * since it carries no original value.
 */
export function markAllRedactionFailed(
  redactedKeys: unknown,
): Record<string, unknown> {
  try {
    return Object.fromEntries(
      (redactedKeys as string[]).map((key) => [key, REDACTION_FAILED_MARKER]),
    );
  } catch {
    return {};
  }
}

/**
 * Apply redaction to params based on redacted keys
 * Supports top-level keys and mixed object/array paths
 * (e.g., 'user.password', 'users[0].password', or 'users[0]["password-hash"]')
 *
 * @param params Original params object
 * @param redactedKeys Keys to redact (supports nested object paths, array indexes, and quoted bracket keys)
 * @param redactFunction Custom redaction function (uses defaultRedactFunction if not provided)
 * @returns With no `redactedKeys` to act on, `params` itself - nothing was asked for, so
 *          nothing is copied. Otherwise a fresh plain bag carrying exactly the keys the
 *          walk saw, so the renderer cannot resolve one the walk could not: every matched
 *          path masked, and every other value carried over by reference, since copies are
 *          built only along the branches that lead to a mask.
 */
export function applyRedaction(
  params: Record<string, unknown>,
  redactedKeys?: string[],
  redactFunction?: RedactFunction,
  onFormatError?: FormatErrorHandler,
): Record<string, unknown> {
  const report = createFormatReporter('redaction', onFormatError);

  // A second channel, for the other way a mask can fail: the leaf renders through
  // `stringifyTemplateValue` on its way to the mask, and a `toString` that throws there is
  // a `'render'` failure, not a `'redaction'` one. Sharing `report` mislabelled its kind
  // and, since each reporter fires once per operation, let an unrenderable value consume
  // the report a genuinely broken `redactFunction` still needed.
  const reportRender = createFormatReporter('render', onFormatError);

  // Read once, through `snapshotList`, and never asked a second question afterwards.
  //
  // `redactedKeys` is typed `string[]`, but a JavaScript caller can hand over anything, and
  // `length` is an ordinary property an accessor or a `Proxy` can make throw - or simply
  // lie about. The lie is the one every guard here used to miss: a `Proxy` over a real
  // array whose `length` reads `0` passes `Array.isArray`, spreads to `[]`, and reports a
  // count of zero, so the "nothing was asked for" exit below handed the caller's params
  // straight back with the very values redaction was asked to hide. No throw, no marker, no
  // report. `snapshotList` refuses it by the invariant a real array cannot break - an own
  // index key at or beyond its own `length` - and returns a plain array otherwise, so
  // everything below reads a snapshot rather than the caller's object.
  let entries: unknown[] | null;

  try {
    // Absent, not merely falsy. `undefined` is the caller saying nothing about redaction;
    // `null`, `0`, `''` and `false` are a caller who supplied a list that cannot name a
    // key, which is the fail-closed case below. Letting every falsy value take this exit
    // handed those callers their params back untouched, and said nothing about it.
    if (redactedKeys === undefined) {
      return params;
    }

    entries = snapshotList(redactedKeys);
  } catch (error) {
    report(error, '<redactedKeys>');

    // Nothing nameable to mark, since the list is what could not be read.
    return {};
  }

  // Not an array, unreadable, or contradicting itself. There is no safe way to redact and
  // no key to mark, so nothing is returned rather than everything.
  if (entries === null) {
    report(new Error('redactedKeys is not a usable list'), '<redactedKeys>');

    return {};
  }

  const requestedCount = entries.length;

  // No redaction needed
  if (requestedCount === 0) {
    return params;
  }

  // Parsed with the shared parser rather than a local `includes('.')` test, so an entry
  // addresses the same thing here as it does in `sensitiveFieldNames` and
  // `stringifyValue`. A list that is present but unusable fails closed.
  //
  // Handed the snapshot, never `redactedKeys` itself. `parseRedactPaths` snapshots again
  // internally, and a plain array answers both reads identically - but the caller's own
  // object need not: a `Proxy` whose `get` trap answers `'password'` the first time and
  // something harmless afterwards passes `snapshotList` here, skips the "nothing was
  // asked for" exit above, and then has the *second* read decide the paths. The walk
  // matches nothing, and the params go back in the clear with no report at all. That is
  // the whole reason the snapshot exists, and this was the one read that went around it.
  //
  // The same goes for every `markAllRedactionFailed` below. Marking cannot leak a value -
  // it only ever writes the marker, and fails to `{}` if the list refuses - but handing it
  // the caller's object re-entered their traps a second, third and fourth time during an
  // already-failing pass, and let a lying list decide which keys the failure names.
  const paths = parseRedactPaths(entries);

  if (paths === null) {
    report(
      new Error('redactedKeys is not a usable list of paths'),
      '<redactedKeys>',
    );

    return markAllRedactionFailed(entries);
  }

  // No copy is made, and none is probed for either.
  //
  // A `deepClone` of the params used to run here purely as a throw-probe, its result
  // discarded: the theory was that a structure `deepClone` cannot copy - a throwing
  // getter, a revoked `Proxy` - meant redaction could not be trusted. It was wrong in
  // both directions. It cost a full deep clone of the params on every redacted log call
  // for a value nothing read, and it failed closed on payloads the walk itself handles
  // perfectly well: one unrelated throwing getter anywhere in the bag dropped *every*
  // param, including the sensitive one that would have masked correctly.
  //
  // The walk is the thing that fails closed, per value and where the failure actually is:
  // an unreadable set of keys or an unreadable element yields the failure marker in that
  // one place, and `redactMatchedPaths` refuses the "nothing matched, keep the original"
  // shortcut once any read has failed. A total refusal beneath it is caught below.
  //
  // The walk runs over `params` itself and builds its own copies - only along the
  // branches that lead to a redacted key; every other param is passed through by
  // reference. That is what keeps a `Date`, an `Error`, or a `URL` logged alongside a
  // secret from being flattened into `{}` - both in the rendered message and in the
  // `redactedParams` a structured sink reads. It does not mutate what it reads.

  // The params bag itself is normalized to a plain object, which the walk does not do
  // for it. The walk treats anything with a non-plain prototype as a single *value* -
  // right for a `URL` or a class instance sitting inside a payload, since that is how it
  // renders, but wrong for the bag being walked, whose entries are the params.
  //
  // This is now the only thing standing between a non-plain bag and an unmasked log line.
  // It first went in when a class instance passed as `params` matched "a path points
  // inside this" at the root and came back as the string `'***REDACTED***'`, against this
  // function's declared record type. Since a path no longer addresses the root at all,
  // the failure has changed sides and got quieter: an unnormalized class instance is now
  // left *entirely alone*, so a key named in `redactedKeys` is never masked and the
  // renderer prints it. Verified rather than assumed - the walk hands back
  // `{ password: 'hunter2secret' }` for a `Session` bag redacted on `['password']`.
  // Built here and read only by the walk it is handed to, so the copies below can stand in
  // for the caller's containers without anything being written onto the caller's values.
  // See `ForwardingAliases` for why this is a parameter rather than a mark on the object.
  const aliases: ForwardingAliases = new WeakMap();

  const walk = (
    root: Record<string, unknown>,
  ): Record<string, unknown> | null => {
    let result: unknown;

    try {
      result = redactMatchedPaths(
        root,
        paths,
        redactFunction,
        report,
        aliases,
        reportRender,
      );
    } catch (error) {
      // The walk guards every step it owns, so reaching here means something beneath it
      // refused entirely.
      report(error, '<params>');

      return null;
    }

    // The walk can hand back a single value rather than a bag - the failure marker it
    // returns when the root's own keys could not be read, say - and this function
    // declares a record. Returning a string would make every template placeholder render
    // as the fallback and give a structured sink reading `entry.redactedParams` a string
    // where it expects its params.
    return isPlainContainer(result) && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  };

  // Guarded because a property can be an accessor that throws: copying one key at a time
  // marks that one where it is, and every other param - the sensitive one included - is
  // still masked and still logged. Dropping them all is what a discarded `deepClone` probe
  // used to do, and it hid working redaction behind an unrelated getter. Values are copied
  // by reference, so this stays a shallow copy.
  let guarded: Record<string, unknown>;

  // The keys whose read failed, so the marker can be put back after the walk. Nothing but
  // the marker is ever written back, so this cannot restore a value.
  const unreadable: { key: string; error: unknown }[] = [];

  try {
    guarded = normalizeParamsBag(params, unreadable, aliases);
  } catch {
    // `Object.keys` itself refused - a revoked `Proxy`, an `ownKeys` trap that throws -
    // so there is no key to read safely and nothing to mark but the redacted ones.
    return markAllRedactionFailed(entries);
  }

  // The same normalization, continued down the paths the caller named, so the walk and
  // the renderer agree about a nested key exactly as they already do about a top-level
  // one. Guarded because it reads caller properties; a failure leaves the originals in
  // place, where the walk's own guards still apply.
  try {
    normalizeAlongRedactPaths(guarded, paths, aliases);
  } catch (error) {
    report(error, '<params>');
  }

  // Never fall through with the originals: a sensitive key still holding its own value is
  // the one outcome redaction exists to prevent.
  const walked = walk(guarded);

  if (walked === null) {
    return markAllRedactionFailed(entries);
  }

  for (const { key, error } of unreadable) {
    // Reported, not only marked. The reporter is once-per-pass, so a bag of forty
    // unreadable params still says one thing - but it says it, which is the whole promise
    // `onFormatError` makes on every other surface that redacts.
    report(error, key);

    try {
      defineEntry(walked, key, REDACTION_FAILED_MARKER);
    } catch {
      // The walk returns either `guarded` itself or a copy it built, both of them plain
      // and writable, so this cannot fail - and if it somehow did, the key already holds
      // a mask of the marker rather than anything the caller passed in.
    }
  }

  return walked;
}
