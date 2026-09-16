import type { NestedKeyValueEntry } from './ascii-tables/key-value-ascii-table';
import {
  KEY_VALUE_TABLE_MIN_WIDTH,
  KeyValueASCIITable,
} from './ascii-tables/key-value-ascii-table';
import {
  parseRedactPaths,
  redactMatchedPaths,
  type ForwardingAliases,
  type RedactPath,
} from './internal/redact-paths';
import {
  ANONYMOUS_ROOT,
  isEnumerableBeforeTerminalPrototype,
  normalizeAlongRedactPaths,
  unrootedReport,
  unwrapRedactionRoot,
} from './internal/redact-normalization';
import {
  REDACTION_FAILED_MARKER,
  type RedactValueFunction,
} from './internal/default-redact-function';
import { describeContainer } from './internal/container-entries';
import { isPlainContainer } from './internal/is-plain-container';
import { readMember, snapshotMembers } from './internal/read-member';
import {
  noteLeafCut,
  renderLeafWithinBudget,
} from './internal/stringify-template-value';
import { isErrorValue } from './to-error';
import {
  capNestedKey,
  charge,
  chargeNestedText,
  chargeText,
  chargeUnits,
  createSiblingBudget,
  createRenderBudget,
  cutAt,
  foldTruncations,
  MAX_RENDER_DEPTH,
  MAX_RENDER_LENGTH,
  noteTruncation,
  resolveMaxRenderLength,
  TRUNCATED,
  TRUNCATED_LENGTH,
  type RenderBudget,
  type TruncationHandler,
} from './internal/render-budget';
import { createTruncationReporter } from './internal/truncation-reporter';
import {
  describeBinaryView,
  isArrayBufferLike,
  readBinaryByteLength,
} from './internal/binary-view';
import {
  createFormatReporter,
  type FormatErrorHandler,
  type ReportFormatFailure,
} from './internal/format-reporter';

export type {
  TruncationHandler,
  TruncationInfo,
  TruncationReason,
} from './internal/render-budget';

/**
 * Produces the replacement shown for a value named by `sensitiveFieldNames`.
 *
 * The logger's `redactFunction` under this entry point's own name - one definition, so
 * the same function can be used for both and a change to the contract cannot reach one
 * and miss the other. It is handed the key the caller wrote and the stringified value,
 * and defers the same way: return `null` to fall back to the default masking for that
 * value rather than reproducing it.
 */
export type RedactFieldFunction = RedactValueFunction;

export type {
  FormatErrorHandler,
  FormatFailureKind,
} from './internal/format-reporter';

// The return type of a `redactFunction` and the config it may hand back, so this entry
// point can be used without importing the logger for its types.
export type {
  RedactFunctionResult,
  RedactMaskConfig,
} from './internal/default-redact-function';

/** Options for {@link errorToString}. */
export interface ErrorToStringOptions {
  /**
   * See {@link RedactFieldFunction}. Defaults to the same masking the logger applies, so
   * a value renders identically whether it went through a log line or a rendered error.
   */
  redactFunction?: RedactFieldFunction;
  /**
   * Notified when a value could not be formatted, so a `***REDACTION FAILED***` or
   * `<unrenderable: ...>` marker leaves a diagnosis and not only a marker.
   *
   * `kind` says which stage threw: `'redaction'` for a broken `redactFunction`,
   * `'render'` for a value that refused to be read or stringified. Both come from the same
   * walk over the same value and address it with the same path, which is why they are one
   * callback with a discriminator rather than two.
   *
   * The markers name which half refused - `keys`, `value`, `text` - and deliberately never
   * carry the cause: the thrown error comes from your own getter, `toString` or
   * `redactFunction` and may carry the value it was hiding, so putting it in the table
   * would send it to every sink past `sensitiveFieldNames`. It comes here instead.
   *
   * With no handler set, a standalone call uses the standard host path: a cancelable
   * global `'error'` event first; `globalThis.reportError()` when event dispatch is
   * unavailable; then guarded `console.error`. The logger uses its separate diagnostic
   * channel for logger-owned formatting. A custom sink that calls this function should
   * pass a handler that terminates locally.
   *
   * Fires at most once per kind per call. Do not redact, render or log from inside it.
   */
  onFormatError?: FormatErrorHandler;
  /**
   * Characters this render may emit, defaulting to {@link MAX_RENDER_LENGTH}.
   *
   * One allowance for the whole table, shared by every row and every level below them, so
   * an error carrying a large `cause` chain costs one cap rather than one per link.
   * `Infinity` renders without a bound; anything else unusable takes the default rather
   * than being honoured, since this is the bound that makes an error built from untrusted
   * data safe to render.
   *
   * @see onTruncate, which is how a caller learns it was reached.
   */
  maxRenderLength?: number;
  /**
   * Notified when the render was cut short - by {@link maxRenderLength}, the depth cap, or
   * a cycle.
   *
   * Deliberately not {@link onFormatError}: these are degradations rather than failures.
   * The walk succeeded and simply could not represent everything, so there is no error to
   * hand over, and the marker in the output says where it stopped. That is enough for a
   * human reading a stack trace and not enough for a program consuming the string, which
   * is what this is for.
   *
   * Fires at most once per call. Do not render, redact or log from inside it.
   */
  onTruncate?: TruncationHandler;
}

/**
 * Returned by {@link readMemberOrThrew} when the read itself threw, which is not the same
 * as the member being absent. `sensitiveFieldNames` must tell them apart: absent means
 * nothing to mask, unreadable means the caller asked for masking and this cannot tell
 * what, which has to fail closed.
 */
const READ_THREW = Symbol('read-threw');

/**
 * A read that threw, carrying what it threw.
 *
 * The sentinel alone said only *that* the read failed, so the one caller that reports -
 * the `additionalInfo` row - had nothing to hand over and synthesized a bare
 * `Error('Value could not be read')`. `serializeError` reports the caller's real error for
 * the identical input, and two sibling renderers giving different diagnostic quality for
 * the same payload is the sort of inconsistency the marker vocabulary was unified to end.
 */
interface ReadFailure {
  readonly kind: typeof READ_THREW;
  readonly error: unknown;
}

function isReadFailure(value: unknown): value is ReadFailure {
  // Guarded, because the thing being tested is often a *value* the caller supplied rather
  // than one of these wrappers - and reading any property off a revoked `Proxy` throws.
  // The bare `=== READ_THREW` identity test this replaces never touched the value, so the
  // guard is what keeps the richer sentinel from being a downgrade.
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as ReadFailure).kind === READ_THREW
    );
  } catch {
    return false;
  }
}

function readMemberOrThrew(
  value: Record<string, unknown>,
  key: string,
): unknown {
  try {
    return value[key];
  } catch (error) {
    return { kind: READ_THREW, error } satisfies ReadFailure;
  }
}

/**
 * The parsed list, plus each `additionalInfo.`-prefixed entry read from the bag.
 *
 * The path root is the `additionalInfo` bag itself, so `['password']` names
 * `additionalInfo.password` - which is also how an `onFormatError` report spells that
 * location. The table uses the display label `AdditionalInfo.password`; paths remain
 * case-sensitive and that capitalized prefix is not an alias. Copying the property path into
 * `sensitiveFieldNames` is the obvious thing to do, and it looked for
 * `additionalInfo.additionalInfo.password`, matched nothing, and printed the secret: a
 * fail-open answer to the one entry the docs' own output invites. Each such entry now
 * also names the location it reads as. The original stays too, so a bag that genuinely
 * holds a key named `additionalInfo` is masked at both readings - over-masking a value
 * the caller named is the safe direction, and a path names a location either way.
 *
 * Applied to the *parsed* list rather than to the raw one, deliberately: expanding the
 * caller's array first would hand `parseRedactPaths` a clean copy of it, and a hostile
 * list - one that under-reports its length, or whose entries cannot be read - must reach
 * the parser as it is so that it is refused as it was. Only the dotted spelling is
 * aliased; a bracket path with nothing before it is not a path this grammar reads.
 */
function withAdditionalInfoAliases(paths: RedactPath[]): RedactPath[] {
  const aliases: RedactPath[] = [];

  for (const path of paths) {
    const { entry } = path;

    if (
      entry.startsWith(`${ADDITIONAL_INFO_PREFIX}.`) &&
      entry.length > ADDITIONAL_INFO_PREFIX.length + 1 &&
      // Each entry appears once per reading in `paths`; alias it once.
      path.parts.length === 1
    ) {
      const stripped = parseRedactPaths([
        entry.slice(ADDITIONAL_INFO_PREFIX.length + 1),
      ]);

      if (stripped !== null) {
        aliases.push(...stripped);
      }
    }
  }

  return aliases.length === 0 ? paths : [...paths, ...aliases];
}

/** The actual member name that `sensitiveFieldNames` is rooted at. */
const ADDITIONAL_INFO_PREFIX = 'additionalInfo';

/**
 * A value's own `sensitiveFieldNames`, parsed into a fresh path root.
 *
 * Shared by the two places a value can start a root of its own - the error table and the
 * nested-object walk - so the "absent, usable, or unreadable" reading cannot drift
 * between them.
 *
 * @returns The parsed paths; `[]` when the value names none; `null` when it named
 *   something that is not a usable list of paths, which the caller must fail closed on.
 */
function readOwnSensitivePaths(
  value: Record<string, unknown>,
  report: ReportFormatFailure,
): RedactPath[] | null {
  const raw = readMemberOrThrew(value, 'sensitiveFieldNames');

  // `undefined` only. `null` and `undefined` mean different things in JavaScript: a
  // property that was never set reads `undefined`, while `null` is a value somebody
  // assigned - so `sensitiveFieldNames: null` is a caller who asked for masking and did
  // not say what for, which is precisely the fail-closed case. Folding the two together
  // made this the one redaction surface that answered differently from the other two for
  // the same spelling: `redactedKeys: null` blanks the params in the logger and yields
  // the marker from `stringifyValue`, while `sensitiveFieldNames: null` printed the value
  // in the clear. `null` now falls through to `parseRedactPaths`, which refuses a
  // non-array and reports it like any other unusable list.
  if (raw === undefined) {
    return [];
  }

  // An entry with path syntax the grammar refuses is reported under the entry as
  // written, the same as the logger and `stringifyValue` do; a valid path that misses
  // stays silent.
  const parsed = parseRedactPaths(
    isReadFailure(raw) ? undefined : raw,
    (entry) =>
      report(
        new Error(
          'redaction path could not be parsed; only its literal reading is used',
        ),
        entry,
      ),
  );

  // Fails closed. A `sensitiveFieldNames` that is present but is not a usable list of
  // strings - a comma-joined string, a `Set`, a non-string entry, or an accessor that
  // threw - means the caller asked for masking and this cannot tell what for. Rendering
  // everything in the clear would be the one unacceptable answer.
  if (parsed === null) {
    report(
      new Error('sensitiveFieldNames is not a usable list of paths'),
      '<sensitiveFieldNames>',
    );

    return null;
  }

  return withAdditionalInfoAliases(parsed);
}

/**
 * What replaces a value this could not render, and which half of it refused.
 *
 * One marker used to cover five unrelated failures - a container that would not be
 * enumerated, a getter that threw, a revoked `Proxy`, a `toString` that threw, a
 * `JSON.stringify` that returned nothing - so an operator reading `<unrenderable>` learned
 * only that something went wrong, never enough to know whether to look at the payload's
 * shape or at the code that produces its values. These say which.
 *
 * **The cause itself is deliberately not here, and that is a rule rather than an
 * omission.** The thrown value belongs to the caller: a getter is free to throw
 * `new Error('cannot read ' + this.password)`, and a marker carrying that message would
 * put the value into the table, past `sensitiveFieldNames`, and into every sink. Redaction
 * already settled this - `createFormatReporter` hands the cause to `onFormatError`
 * and warns that it may contain the value, while the output gets only the neutral marker.
 * These three are library-authored text with no caller input in them, which is what lets
 * them be rendered at all.
 *
 * Named rather than written out, unlike the other markers in this file. Those are each
 * emitted from one place, where a literal is clearer than an indirection; these are three
 * similar spellings across ten sites, which is ten chances to write `key` for `keys` and
 * produce a marker nothing greps for and no test names.
 */
const UNRENDERABLE_KEYS = '<unrenderable: keys>';

/**
 * A value with nothing to address inside it, so it renders as one row rather than as rows.
 *
 * Not a string, because every string this file produces is a value a payload could hold:
 * the caller renders the original through the ordinary leaf renderer on seeing this, so a
 * sentinel that could be confused with content would send a payload down the wrong branch.
 */
const NOT_ADDRESSABLE = Symbol('error-to-string-not-addressable');

/** A single value refused to be read - a throwing accessor, a revoked `Proxy`. */
const UNRENDERABLE_VALUE = '<unrenderable: value>';

/** A value was readable but could not be turned into text. */
const UNRENDERABLE_TEXT = '<unrenderable: text>';

/**
 * `additionalInfo` as something the paths can actually address.
 *
 * The walk treats a non-plain value - a class instance, an `Error`, a `Map` - as a single
 * leaf, and no path can address the root, so nothing inside one is ever masked. The table
 * enumerates its keys regardless of what it is, so the two disagreed exactly where it
 * matters: `sensitiveFieldNames: ['password']` on a class-instance `additionalInfo` masked
 * nothing and the table printed the password. Forwarding the same keys through a plain
 * object puts them where the paths are rooted, so the walk sees what the renderer will.
 *
 * Getters are forwarded rather than read here. Reading now would turn an accessor that
 * throws into `undefined`, which masks to the nine-character word "undefined"; left as an
 * accessor, it throws inside the walk, which fails it closed.
 *
 * `for...in`, matching the logger's `normalizeParamsBag`, which normalizes the params bag
 * for exactly this reason. `Object.keys` sees only own enumerable properties, so a key
 * carried on the prototype - `Object.create({ requestId: 'r-1' })`, or a class instance
 * whose prototype holds enumerable fields - was dropped from the bag and stopped being
 * rendered at all, though the flat `for...in` this replaced printed it. Forwarding the
 * inherited keys as own ones puts them back where both the walk and the table can see
 * them, which is the whole point of the bag.
 *
 * @returns The bag, {@link UNRENDERABLE_KEYS} when the value refuses to be enumerated
 *   at all, which the caller renders as the marker rather than as an absent
 *   `additionalInfo`, or {@link NOT_ADDRESSABLE} when it enumerates to nothing or is an
 *   error, which the caller renders as a single row.
 */
function asAddressableBag(
  info: object,
  path: string,
  reportRender: ReportFormatFailure,
  budget: RenderBudget,
): object | string | typeof NOT_ADDRESSABLE {
  if (isPlainContainer(info)) {
    return info;
  }

  // An error is a leaf here whatever it carries, and goes through the single-row exit,
  // where `stringifyValue` renders it as its own nested table under its own
  // `sensitiveFieldNames` - the rule this file states for an error nested one level
  // deeper, applied to one sitting directly in `additionalInfo`.
  //
  // Without this the bag was built from whatever own enumerable keys the error happened to
  // have, and those keys became the whole of the rendering: a `Error('connect ECONNREFUSED')`
  // carrying `code`, `errno`, `syscall` and `path` - the shape every Node syscall error has -
  // rendered as four flat `AdditionalInfo.<key>` rows with no `message`, no `name` and no
  // `stack`, while the same error with no own key rendered the full table. The most common
  // error in the wild was the one whose diagnosis was dropped.
  if (isErrorValue(info)) {
    return NOT_ADDRESSABLE;
  }

  // So is a view over binary data, and for the plainer reason that its keys are its bytes.
  // A `Buffer` attached to an error is ordinary, and forwarding it key by key rendered
  // tens of thousands of `AdditionalInfo.<n> | 0` rows - the budget's whole allowance spent
  // saying nothing - after materializing every index the enumeration touched, which is
  // seconds of synchronous work at a few megabytes. `sensitiveFieldNames` was never going
  // to name a byte offset either. Rendered as the one value it is, like every other
  // non-plain container whose contents are not addressable structure.
  if (ArrayBuffer.isView(info)) {
    return NOT_ADDRESSABLE;
  }

  // Through a `Record` view: `isPlainContainer` is a `value is object` guard, so the early
  // return above narrows `info` to `never` and `for...in` will not take it directly.
  const source = info as Record<string, unknown>;

  const keys: string[] = [];

  /** Whether the key cap below stopped the collection short of the value's own keys. */
  let didCapKeys = false;

  try {
    for (const key in source) {
      if (!isEnumerableBeforeTerminalPrototype(source, key)) {
        continue;
      }

      // Bounded like every other walk in this file. The rows this bag becomes are bounded
      // - the loop that writes them stops the moment the budget runs out - but *building*
      // it was not, and a bag is a forwarding accessor defined per key: `additionalInfo`
      // holding a `Uint8Array` (a `Buffer` on an error is ordinary) spent 1.5 seconds at a
      // million elements and 9.9 at five million, all to produce the same one megabyte of
      // output the cap allows. Synchronous, on the failure-reporting path, whose whole
      // contract is that it terminates.
      //
      // See {@link MAX_ADDRESSABLE_BAG_KEYS} for why cutting here cannot cut a row the
      // render would otherwise have emitted.
      // Tested before the key is collected, not after: asked afterwards, the check fired
      // on the iteration that took the *last* key a value happened to have, so an object
      // holding exactly `MAX_ADDRESSABLE_BAG_KEYS` of them was reported truncated and given
      // a marker row with nothing missing from it. Reaching this with the bag already full
      // means there was one more key to take, which is the only shape that is a cut.
      if (keys.length >= MAX_ADDRESSABLE_BAG_KEYS) {
        didCapKeys = true;

        break;
      }

      keys.push(key);
    }
  } catch (error) {
    // A `Proxy` can throw from its `ownKeys` trap. Said, not swallowed: an empty bag here
    // rendered the error as one that simply carried no `additionalInfo`, which is a
    // different and much more reassuring claim than "its keys could not be read" - the
    // same silent collapse the plain-container branch below refuses, and that
    // `renderContainer`, `maskValueDeep`, `redactPathsInner` and `snapshotValue` all mark.
    reportRender(error, path);

    return UNRENDERABLE_KEYS;
  }

  // Nothing enumerable to forward. A `Map`, a `Set`, a `Date`, an `Error`, a `URL` - every
  // non-plain container whose contents live behind methods or internal slots - yields no
  // keys here, so the bag was empty, the row loop below had nothing to write, and the
  // error rendered as one carrying no `additionalInfo` at all. That is the same silent
  // collapse the refused-enumeration branch above exists to refuse, and it disagreed with
  // this file's own rule that a non-object `additionalInfo` renders as a single row: the
  // identical value one level deeper (`additionalInfo: { inner: map }`) rendered fine.
  // Answering with the marker string sends it through the single-row exit instead, where
  // it prints as the leaf it is.
  if (keys.length === 0) {
    return NOT_ADDRESSABLE;
  }

  const bag: Record<string, unknown> = {};

  for (const key of keys) {
    try {
      Object.defineProperty(bag, key, {
        get: () => source[key],
        enumerable: true,
        configurable: true,
      });
    } catch (error) {
      // One key that will not forward is dropped rather than failing the whole bag - and
      // said, matching the refused-enumeration branch above it, which was the one
      // inconsistent swallow left in this file. Effectively unreachable (a fresh object,
      // a key `for...in` already yielded) but a dropped key is a missing row, and a
      // missing row is exactly what the markers here exist to make impossible.
      reportRender(error, joinPath(path, key));
    }
  }

  // Said, when the cap above cut the collection. {@link MAX_ADDRESSABLE_BAG_KEYS} is sized
  // so the budget's own marker row lands first - but only for a budget of at most
  // {@link MAX_RENDER_LENGTH}, and `maxRenderLength` is the caller's to raise. Above it the
  // rows the cap dropped were the render's only loss, and it had no marker and no
  // `onTruncate`: 100,000 keys rendered exactly 62,500 rows and reported an intact render.
  // Counted and named here instead, so a cut is a cut whatever the allowance is.
  //
  // Defined after the forwarded keys rather than before them, so the marker renders as the
  // last row: written first it read as the row where the render stopped, with 62,500 rows
  // still to come after it. Every other truncation marker in this file lands last too.
  if (didCapKeys) {
    noteTruncation(budget, 'length');

    try {
      Object.defineProperty(bag, TRUNCATED_LENGTH, {
        value: '',
        enumerable: true,
        configurable: true,
        writable: true,
      });
    } catch {
      // The count above is what makes the cut answerable; the marker row is the nicety.
    }
  }

  return bag;
}

/**
 * Mask everything the paths name, before any of it is rendered.
 *
 * The shared walk from `redact-paths`, which is also what the logger's `redactedKeys`
 * runs, so a value masked in a log line and the same value masked in a rendered error
 * cannot disagree. The input is never mutated: copies are built only along the branches
 * that lead to a mask.
 *
 * Preceded by the same pre-walk normalization the logger's params and `stringifyValue`
 * get, and for the same reason. The walk reads each member once and hands a subtree that
 * matched nothing back by reference; the table that follows reads that member again, and
 * `stringifyValue` renders it with no paths of its own. A `Proxy` under `additionalInfo`
 * that answers `{}` to the walk's read and `{ password: 'secret' }` to the render's was
 * therefore masked on the read nobody sees and printed on the read everybody does.
 * Normalizing first reads every container along a named path once into a copy that
 * stands in for the original, so the walk and the rows after it look at one snapshot.
 *
 * Rooted under {@link ANONYMOUS_ROOT} in a bag of this function's own, because the
 * normalization needs a parent to install the first copy into and the value's own parent
 * is the caller's - the `additionalInfo` bag is the caller's object when it is a plain
 * container. A non-plain value is walked bare: there is no container beneath it for the
 * walk to hand back by reference, so there is no second read to disagree with the first.
 *
 * Fully guarded. The walk reads caller properties and calls the caller's `redactFunction`,
 * and this sits on a reporting path that must not raise an error of its own. A failure
 * fails closed on the whole value rather than falling through to the unmasked original.
 */
function redactAddressedValue(
  value: unknown,
  paths: RedactPath[],
  redactFunction: RedactFieldFunction | undefined,
  report: ReportFormatFailure,
  reportRender: ReportFormatFailure,
  budget: RenderBudget,
): unknown {
  if (paths.length === 0) {
    return value;
  }

  const maskBudget = createSiblingBudget(budget);

  try {
    // `reportRender` as well as `report`, the same split this file already keeps
    // everywhere else: a leaf renders on its way to the mask, and a `toString` that throws
    // there is a `'render'` failure. Passing only `report` labelled it `'redaction'` and
    // spent the one redaction report a broken `redactFunction` still needs.
    if (!isPlainContainer(value)) {
      return redactMatchedPaths(
        value,
        paths,
        redactFunction,
        report,
        undefined,
        reportRender,
        // This render's own allowance, so masking and the table that follows spend one
        // budget between them. See `StringifyValueOptions.maxRenderLength`.
        maskBudget,
      );
    }

    const bag: Record<string, unknown> = { [ANONYMOUS_ROOT]: value };
    const rootedPaths = paths.map((path): RedactPath => ({
      parts: [ANONYMOUS_ROOT, ...path.parts],
      // The entry as the caller wrote it, untouched: it is what a custom
      // `redactFunction` is handed as the key.
      entry: path.entry,
    }));

    // Copies standing in for the caller's containers, so the walk recognizes a back-edge
    // pointing at an original it is holding a copy of.
    const aliases: ForwardingAliases = new WeakMap();

    // Inside the guard, so a throw out of normalization fails closed to the marker below
    // rather than walking a half-normalized bag - an alias written under one key and not
    // yet under its sibling is a shape neither the walk nor the table was promised.
    normalizeAlongRedactPaths(
      bag,
      rootedPaths,
      aliases,
      unrootedReport(report),
    );

    return unwrapRedactionRoot(
      redactMatchedPaths(
        bag,
        rootedPaths,
        redactFunction,
        unrootedReport(report),
        aliases,
        unrootedReport(reportRender),
        maskBudget,
      ),
    );
  } catch (error) {
    report(error, '<sensitiveFieldNames>');

    return REDACTION_FAILED_MARKER;
  } finally {
    // Masking is a sibling pass over the same value the table/string renderer emits.
    // Only its truncation signals are folded back; charging its reads against the main
    // allowance would count every masked character twice.
    foldTruncations(budget, maskBudget);
  }
}

/**
 * A rendered value as one line of text, for a context that can only hold a string.
 *
 * An array joins its elements into a single cell, so an element that rendered as
 * structure has to be flattened back into text. The entry list is the *renderer's* shape,
 * not the caller's: `stringifyValue` returns `NestedKeyValueEntry[]` for a plain object so
 * the table can lay it out as indented rows, which an array element never gets. Handing
 * that list to `safeStringify` serialized the wrapper itself, so an ordinary
 * `additionalInfo: { items: [{ token: 'x' }] }` rendered as
 * `[{"key":"token","value":"x"}]` - the caller's data wearing this module's plumbing.
 * Masking was applied first, so nothing was disclosed by it; it was simply unreadable.
 */
function entriesToText(
  entries: NestedKeyValueEntry[],
  path: string,
  reportRender: ReportFormatFailure,
): string {
  const parts: string[] = [];

  for (const entry of entries) {
    parts.push(
      `${quoteText(entry.key, path, reportRender)}:${renderedValueToText(
        entry.value,
        path,
        reportRender,
      )}`,
    );
  }

  return `{${parts.join(',')}}`;
}

function renderedValueToText(
  value: string | KeyValueASCIITable | NestedKeyValueEntry[],
  path: string,
  reportRender: ReportFormatFailure,
): string {
  if (typeof value === 'string') {
    return quoteText(value, path, reportRender);
  }

  if (value instanceof KeyValueASCIITable) {
    return quoteText(value.toString(), path, reportRender);
  }

  return entriesToText(value, path, reportRender);
}

/**
 * Where a value sits, for the render reporter alone.
 *
 * Structural only: every segment is a key the walk already knows or a bracketed index, so
 * nothing a caller supplied as a *value* can reach it. That is what makes a path safe to
 * hand to a reporter, and it is the same rule `onFormatError`'s `key` follows.
 *
 * A nested error starts a fresh table but not a fresh path, so a failure deep inside a
 * `cause` still says where it was: `cause.additionalInfo.token`.
 */
function joinPath(...segments: string[]): string {
  const parts = segments.filter((segment) => segment.length > 0);

  return parts.length > 0 ? parts.join('.') : '<error>';
}

/**
 * Report a value failure and hand back the marker, for a site with only an expression
 * slot to put it in.
 */
function reportUnrenderableValue(
  error: unknown,
  path: string,
  reportRender: ReportFormatFailure,
): string {
  reportRender(error, path);

  return UNRENDERABLE_VALUE;
}

/**
 * Report a text failure and hand back the marker, so a site that has only an expression
 * slot can still say what happened.
 */
function reportUnrenderableText(
  reason: string,
  path: string,
  reportRender: ReportFormatFailure,
): string {
  reportRender(new Error(reason), path);

  return UNRENDERABLE_TEXT;
}

/** JSON string literal, so a value containing a comma cannot be read as two entries. */
function quoteText(
  value: string,
  path: string,
  reportRender: ReportFormatFailure,
): string {
  try {
    return JSON.stringify(value) ?? '""';
  } catch {
    reportRender(new Error('Value could not be quoted'), path);

    return `"${UNRENDERABLE_TEXT}"`;
  }
}

function safeStringify(
  value: unknown,
  path: string,
  reportRender: ReportFormatFailure,
  budget?: RenderBudget,
): string {
  // A view over binary data whose rendering could not survive the budget anyway.
  //
  // This path reaches `JSON.stringify`, and a `Buffer` has a JSON form: it expands to
  // `{"type":"Buffer","data":[65,65,...]}`, four or five characters per byte, built whole
  // before anything can cut it. A 40 MB buffer attached to an error cost about a second
  // and well over a hundred megabytes to produce a couple of hundred characters of table
  // cell. The `ArrayBuffer.isView` check in `describeAddressableInfo` already stops such a
  // value being *enumerated* as one row per byte; it does not stop this, one step later.
  //
  // Conditional on the allowance, matching `stringifyTemplateValue` rather than
  // `serializeError`: a small buffer renders as it always has. `byteLength` is the
  // comparison even though the JSON form is several times larger, because the point is to
  // bound the work against the budget rather than to predict the encoding - under it, the
  // work is a small multiple of an allowance the caller chose; over it, nothing is
  // rendered that could have been kept. The size is measured through the intrinsic getter
  // rather than read off the value - see `readBinaryByteLength` - so a subclass cannot
  // under-report its way onto the slow path; a view that genuinely cannot be measured,
  // such as a detached one, fails closed to the marker.
  // The backing store itself, which `ArrayBuffer.isView` deliberately excludes. Not counted
  // as a truncation and not weighed against the allowance: `JSON.stringify` renders one as
  // `{}` whatever its size, so nothing is being dropped here - the marker only says what
  // the empty object never did, that this is binary and how much of it there is.
  if (value !== null && typeof value === 'object' && isArrayBufferLike(value)) {
    return describeBinaryView(value);
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    ArrayBuffer.isView(value)
  ) {
    const allowance = budget?.remaining ?? MAX_RENDER_LENGTH;
    const byteLength = readBinaryByteLength(value);

    if (byteLength === null || byteLength > allowance) {
      // Counted, for the reason the same branch in `stringifyTemplateValue` is: the marker
      // stands in for content the length bound refused, and a bound that drops content
      // without moving `truncations` reports an intact render to the `onTruncate` handler
      // a caller set to watch for exactly this. No `dropped` count - the JSON form was
      // never built, so nothing measured what it would have been.
      if (budget !== undefined) {
        noteTruncation(budget, 'length');
      }

      return describeBinaryView(value);
    }
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    budget !== undefined &&
    !ArrayBuffer.isView(value)
  ) {
    const leaf = renderLeafWithinBudget(budget, value, path, reportRender);
    noteLeafCut(budget, leaf, budget.truncations);
    return leaf.text;
  }

  try {
    return stringifyPrimitive(value, path, reportRender);
  } catch (error) {
    reportRender(error, path);

    // `JSON.stringify` throws on a cyclic object and on a `BigInt` nested inside one,
    // `String()` invokes `toString`/`Symbol.toPrimitive`, and a symbol's own `toString`
    // can be overridden. None of that may escape a rendering call.
    return UNRENDERABLE_TEXT;
  }
}

function stringifyPrimitive(
  value: unknown,
  path: string,
  reportRender: ReportFormatFailure,
): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'object':
      return (
        JSON.stringify(value) ??
        reportUnrenderableText(
          'Value has no JSON representation',
          path,
          reportRender,
        )
      );
    case 'function':
      return '[Function]';
    case 'symbol':
      return value.toString();
    default: {
      // This should never happen, but satisfy the linter
      const fallback = value as string | number | boolean;
      return String(fallback);
    }
  }
}

/**
 * Render an error as a key/value ASCII table.
 *
 * Never throws. The value being rendered is whatever was thrown, so every property read
 * is guarded, the recursive walk of `additionalInfo` refuses to revisit an object it has
 * already seen, and the whole render is wrapped as a backstop — a deeply nested payload
 * can still exhaust the stack, and a `RangeError` from that must not escape a caller
 * whose only job was reporting a failure.
 */
export function errorToString(
  error: unknown,
  maxRowLength = 80,
  callerOptions?: ErrorToStringOptions,
): string {
  // Read once, guarded, before anything else: the reads below sit outside the `try` that
  // keeps the never-throws promise, and an options object with a throwing accessor
  // escaped it. A refused read is the option being absent, which is its documented
  // default. See `snapshotMembers`.
  const options = snapshotMembers(callerOptions, [
    'onFormatError',
    'maxRenderLength',
    'onTruncate',
    'redactFunction',
  ]);

  const report = createFormatReporter('redaction', options.onFormatError);

  // Uses the same host reporting path as the redaction reporter when no handler is
  // supplied. The two failures are equally exceptional: this fires only when a read
  // actually *threw*, never for the
  // ordinary degradations - `[Function]`, `[circular]`, `[max depth exceeded]` - which
  // never reach a reporter at all. Silence by default would leave the swallow this channel
  // exists to end as the behaviour almost everyone gets.
  const reportRender = createFormatReporter('render', options.onFormatError);

  // The root goes in `seen` before the walk, the same way `serializeError` registers
  // it. Without that, `err.cause = err` was not a cycle until the *second* time round:
  // the error rendered in full, then again as its own cause, and only the third visit was
  // caught - so a self-referential error printed its message four times, while the sibling
  // renderer printed it once.
  const seen = new WeakSet<object>();

  if (error !== null && typeof error === 'object') {
    seen.add(error);
  }

  // One allowance for this call. Held here rather than built inline so the truncation
  // reporter below can watch the same counters the walk moves.
  const budget = createRenderBudget(
    resolveMaxRenderLength(options.maxRenderLength),
  );

  const reportTruncation = createTruncationReporter(budget, options.onTruncate);

  try {
    const table = errorToASCIITable(
      error,
      '',
      maxRowLength,
      seen,
      0,
      budget,
      options.redactFunction,
      report,
      reportRender,
    );

    const rendered = table.toString();
    if (rendered.length > budget.limit) {
      noteTruncation(budget, 'length');
      const marker = cutAt(TRUNCATED_LENGTH, budget.limit);
      return cutAt(rendered, budget.limit - marker.length) + marker;
    }
    return rendered;
  } catch (error_) {
    // Said, not swallowed - the one degradation site in this file that was silent. What
    // reaches here is everything the per-value guards could not hold: a `RangeError` from
    // a graph deep enough to exhaust the stack, or a throw out of
    // `KeyValueASCIITable.toString()` itself. The caller is handed a placeholder with the
    // error's message, name, `stack` and `cause` all gone, so without this a
    // caller-supplied `onFormatError` - the whole point of which is to learn that a render
    // degraded - heard nothing at all about the one degradation that loses everything.
    //
    // Guarded, because the reporter is reached from a `catch` that must return a string
    // however badly this goes: `onFormatError` is caller code, and a throw from it here
    // would replace `<error could not be rendered>` with a failure raised while reporting
    // that the render failed.
    try {
      reportRender(error_, '<error>');
    } catch {
      // Nothing left to report with. The placeholder below is still the honest answer.
    }

    return '<error could not be rendered>';
  } finally {
    // After the render whatever it did, the `catch` included: a cut made before a later
    // failure is still a cut. The reporter reads the budget's own counters rather than the
    // rendered string, so it sees one made anywhere in the walk - a row, a nested entry, a
    // cycle, or the depth cap.
    reportTruncation('<error>');
  }
}

/** The width `KeyValueASCIITable` falls back to, applied where a caller's is unusable. */
const DEFAULT_TABLE_WIDTH = 80;

/**
 * Ceiling for a caller's `maxRowLength`.
 *
 * The lower clamp exists so a narrow width cannot discard the error; this is the same
 * failure from the other end. Every row is padded out to the table width, and that framing
 * is charged against {@link MAX_RENDER_LENGTH} only for the `AdditionalInfo` rows - never
 * for the fixed Message/Name/Code/Stack/Cause rows or the borders around them. So the
 * width, not the payload, decided the size of the result: `errorToString(new Error('x'),
 * 10_000_000)` returned 120,000,011 characters against a one-megabyte cap, and at `1e9` the
 * table renderer itself threw and the top-level backstop answered `<error could not be
 * rendered>` - the whole error lost to a number the caller passed.
 *
 * Ten thousand is far past any terminal or log column worth rendering into and still leaves
 * the clamp invisible to every caller not asking for something pathological.
 */
const MAX_TABLE_WIDTH = 10_000;

/**
 * A width the table can actually be built at.
 *
 * `maxRowLength` is a public parameter of {@link errorToString}, and the constructor
 * throws below {@link KEY_VALUE_TABLE_MIN_WIDTH} - a throw the top-level backstop turns
 * into `<error could not be rendered>`, discarding the error's message, name and stack
 * because the caller asked for a narrow column. The nested tables have clamped against
 * that minimum since the constant was introduced; the entry point, where a caller's own
 * number arrives, was the one place that did not, so `errorToString(err, 5)` rendered
 * nothing at all.
 *
 * A width that names nothing usable - zero, negative, `NaN` - resolves to the table's own
 * default rather than to the minimum. Zero already meant "use the default" through the
 * constructor's `|| 80`, and a narrow table is a worse answer than the ordinary one for a
 * caller who supplied no real width.
 *
 * Bounded above by {@link MAX_TABLE_WIDTH} as well, which is the same failure reached from
 * the other end - see that constant.
 */
function resolveTableWidth(maxRowLength: number): number {
  if (!Number.isFinite(maxRowLength) || maxRowLength <= 0) {
    return DEFAULT_TABLE_WIDTH;
  }

  return Math.min(
    MAX_TABLE_WIDTH,
    Math.max(KEY_VALUE_TABLE_MIN_WIDTH, maxRowLength),
  );
}

function errorToASCIITable(
  error: unknown,
  path: string,
  requestedRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportFormatFailure,
  reportRender: ReportFormatFailure,
): KeyValueASCIITable {
  // Resolved once, and used for everything below: the table this builds, the width handed
  // to nested values, and the per-row cost charged against the budget. A nested caller has
  // already clamped, so this is idempotent there.
  const maxRowLength = resolveTableWidth(requestedRowLength);

  const table = new KeyValueASCIITable({
    tableWidth: maxRowLength,
    autoAdjustWidthWhenPossible: true,
  });

  if (error && typeof error === 'object') {
    const err = error as Record<string, unknown>;
    table.addRow('Key', 'Value');
    let ownPaths: RedactPath[] | null | undefined;

    // Label as rendered, member name as read off the value.
    const members: [string, string][] = [
      ['Message', 'message'],
      ['Name', 'name'],
      ['Code', 'code'],
      ['Errno', 'errno'],
      // other conventional that might be used to enhance the error object
      ['Prefix', 'errPrefix'],
      ['errType', 'errType'],
      ['errCode', 'errCode'],
    ];

    for (const [label, key] of members) {
      // `readMemberOrThrew`, not `readMember`, for the reason the `additionalInfo` entries
      // below use it: the plain helper answers `undefined` for a read that refused, and the
      // absence test below then dropped the row - so an error whose `message` accessor
      // threw rendered as one that simply had no message, and nothing was reported. That
      // is the silent collapse every other level of this renderer is marked for, and the
      // error's own members were the last place still taking it.
      const read = readMemberOrThrew(err, key);

      if (isReadFailure(read)) {
        reportRender(read.error, joinPath(path, key));
        table.addRow(label, UNRENDERABLE_VALUE);

        continue;
      }

      let value = read;
      if (value !== null && typeof value === 'object') {
        if (ownPaths === undefined) {
          ownPaths = readOwnSensitivePaths(err, report);
        }
        if (ownPaths === null) {
          value = '*** (sensitiveFieldNames unreadable)';
        } else {
          const masked = redactAddressedValue(
            { [key]: value },
            ownPaths,
            redactFunction,
            report,
            reportRender,
            budget,
          );
          value =
            masked !== null && typeof masked === 'object'
              ? readMember(masked, key)
              : masked;
        }
      }

      // Absent, not merely falsy. A truthiness test dropped every conventional member
      // that legitimately holds a falsy value: `code: 0` and `errno: 0` are ordinary on a
      // syscall failure and lost their rows entirely, and an empty `message` or `name`
      // went the same way. A read that threw has already been marked above, so the only
      // thing this drops is a member that is genuinely absent.
      if (value !== undefined && value !== null) {
        // The row's framing, exactly as the `additionalInfo` and nested walks charge it:
        // every row is padded out to the table width and re-indented once per enclosing
        // level, and none of that is any string this walk produces.
        chargeUnits(budget, rowFrameCost(maxRowLength, depth));

        table.addRow(
          label,
          // `chargeNestedText`, because a cause's table is re-emitted by every ancestor:
          // billed once, a 200 KB `message` twenty-five causes deep rendered 26 MB against
          // the 1 MB cap.
          chargeNestedText(
            budget,
            safeStringify(value, joinPath(path, key), reportRender, budget),
            rowTextLevels(maxRowLength, depth, label.length),
          ),
        );
      }
    }

    // Read the way the conventional members above are, and for the same reason: with
    // `readMember` a `cause` or `additionalInfo` accessor that threw came back `undefined`
    // and was dropped by the absence tests below, so the error rendered as one carrying
    // neither - reported to nobody. The failure is carried rather than flattened, so the
    // marker rows below can say which of the two refused.
    const additionalInfoRead = readMemberOrThrew(err, 'additionalInfo');
    const cause = readMemberOrThrew(err, 'cause');
    const stack = readMemberOrThrew(err, 'stack');
    const isInfoUnreadable = isReadFailure(additionalInfoRead);
    const additionalInfo = isInfoUnreadable ? undefined : additionalInfoRead;

    if (isReadFailure(additionalInfoRead)) {
      reportRender(additionalInfoRead.error, joinPath(path, 'additionalInfo'));
    }

    if (isReadFailure(cause)) {
      // Reported here, where the error that was thrown is in hand; `addErrorTail` renders
      // the marker row for it, so the `Cause` row keeps its place after `AdditionalInfo`.
      reportRender(cause.error, joinPath(path, 'cause'));
    }

    // Present, not "present and an object". A non-object `additionalInfo` - a string, a
    // number, a `bigint` - is outside what the documented shape describes, and it was
    // dropped for it: the row was never added, so an error carrying
    // `additionalInfo: 'failed at stage 3'` rendered as one carrying no additional info at
    // all. That is the same silent collapse the unreadable cases were fixed for, arrived
    // at from the other direction, and it loses something the caller plainly meant to
    // report. It renders as a single row now, its own value, the way the fail-closed and
    // failed-redaction paths already render theirs.
    //
    // `null` still counts as absent, matching `cause` below: an explicitly null
    // `additionalInfo` carries nothing to show.
    const hasInfo = additionalInfo !== undefined && additionalInfo !== null;
    const hasCause =
      !isReadFailure(cause) && cause !== undefined && cause !== null;

    // Parsed once, ahead of both consumers. `cause` is caller data as much as
    // `additionalInfo` is, so it is covered by the same list and by the same fail-closed
    // rule; reading the list separately for each would let them disagree about whether it
    // was usable, and rendering the cause outside the rule is how a masked
    // `additionalInfo` came to sit beside a cause printed in the clear.
    if (
      ownPaths === undefined &&
      (hasInfo ||
        hasCause ||
        (stack !== null && typeof stack === 'object' && !isReadFailure(stack)))
    ) {
      // Unusable means `additionalInfo` and `cause` are dropped wholesale below. An entry
      // that parses but resolves to nothing is not that case: it masks nothing, exactly
      // as the logger's `redactedKeys` does.
      ownPaths = readOwnSensitivePaths(err, report);
    }

    // Every table is its own root. An error nested in another's `additionalInfo` is
    // addressed by the parent's entries as a whole or not at all - the parent's walk has
    // already run by the time this is reached - and its own list covers its own contents.
    const sensitivePaths = ownPaths === undefined ? [] : ownPaths;

    // Marked, not dropped. `hasInfo` is false for a read that refused, so this is the row
    // that keeps an unreadable `additionalInfo` from rendering as an absent one. The
    // report has already gone out at the read.
    if (isInfoUnreadable) {
      table.addRow('AdditionalInfo', UNRENDERABLE_VALUE);
    }

    if (hasInfo) {
      if (sensitivePaths === null) {
        table.addRow('AdditionalInfo', '*** (sensitiveFieldNames unreadable)');
      } else {
        // Redacted once, here, then rendered as ordinary data.
        //
        // The renderer used to carry the path list down every branch and re-decide at
        // each one whether the value in hand was named - a second implementation of the
        // walk `redact-paths` already owns, and one that disagreed with it three separate
        // times on this branch alone: an object inside an array, a path reaching into a
        // nested error, and a derived value each rendered in the clear here while the
        // logger masked them. Masking first leaves one walk to be right, and the renderer
        // with nothing to decide.
        // Only an object has keys to address, forward, or walk. Anything else is a single
        // value that renders as one row through the shared exit below - the same exit a
        // failed redaction and an unreadable bag already take.
        const bag =
          typeof additionalInfo === 'object'
            ? asAddressableBag(
                additionalInfo,
                joinPath(path, 'additionalInfo'),
                reportRender,
                budget,
              )
            : additionalInfo;

        // A container with nothing addressable inside it - a `Map`, a `Set`, a `Date`, a
        // `URL` - renders as the one leaf it is, through the same renderer that already
        // prints it that way one level deeper. Walking it as a bag produced no rows at
        // all, so the error came out claiming to carry no `additionalInfo`; nothing is
        // skipped by not walking it, since a path cannot address a key it does not have.
        if (bag === NOT_ADDRESSABLE) {
          // A non-plain value is one leaf to the redaction walk, but paths may still point
          // into it. In that case the walk masks the whole leaf rather than pretending it
          // can safely print the unnamed siblings. Skipping the walk here meant an Error
          // used directly as `additionalInfo` ignored both `message` and the documented
          // `additionalInfo.message` alias and rendered the secret in its nested table.
          const directInfoBag = { [ADDITIONAL_INFO_PREFIX]: additionalInfo };
          const directInfoPaths = sensitivePaths.map((sensitivePath) => ({
            parts: [ADDITIONAL_INFO_PREFIX, ...sensitivePath.parts],
            entry: sensitivePath.entry,
          }));
          const maskedBag = redactAddressedValue(
            directInfoBag,
            directInfoPaths,
            redactFunction,
            report,
            reportRender,
            budget,
          );
          const maskedInfo =
            maskedBag !== null && typeof maskedBag === 'object'
              ? (maskedBag as Record<string, unknown>)[ADDITIONAL_INFO_PREFIX]
              : maskedBag;

          table.addRow(
            'AdditionalInfo',
            stringifyValue(
              maskedInfo,
              joinPath(path, 'additionalInfo'),
              maxRowLength,
              seen,
              depth + 1,
              budget,
              redactFunction,
              report,
              reportRender,
            ),
          );

          addErrorTail(
            table,
            stack,
            cause,
            sensitivePaths,
            path,
            maxRowLength,
            seen,
            depth,
            budget,
            redactFunction,
            report,
            reportRender,
          );

          return table;
        }

        // A bag that could not be enumerated at all carries the marker instead, and falls
        // through to the non-object branch below, which renders it as the `AdditionalInfo`
        // value. Nothing is skipped by not walking it: there is nothing readable under it
        // to mask, which is exactly what the marker says.
        // A non-object never reaches the walk: no path can address the root, so there is
        // nothing inside one to mask, exactly as for any other non-plain leaf.
        const masked =
          bag === null || typeof bag !== 'object'
            ? bag
            : redactAddressedValue(
                bag,
                sensitivePaths,
                redactFunction,
                report,
                reportRender,
                budget,
              );

        // The walk can fail the whole value closed, and what it hands back then is the
        // marker string rather than a bag of keys. Enumerating that walks the *string*,
        // so a failed redaction rendered as twenty-two rows of `AdditionalInfo.0`,
        // `AdditionalInfo.1` - one per character of `***REDACTION FAILED***`.
        if (masked === null || typeof masked !== 'object') {
          table.addRow(
            'AdditionalInfo',
            chargeNestedText(
              budget,
              safeStringify(
                masked,
                joinPath(path, 'additionalInfo'),
                reportRender,
                budget,
              ),
              rowTextLevels(maxRowLength, depth, 'AdditionalInfo'.length),
            ),
          );

          addErrorTail(
            table,
            stack,
            cause,
            sensitivePaths,
            path,
            maxRowLength,
            seen,
            depth,
            budget,
            redactFunction,
            report,
            reportRender,
          );

          return table;
        }

        const info = masked as Record<string, unknown>;

        // `Object.keys` here, not `for...in`, and that is not a disagreement with
        // `asAddressableBag` above: the bag it returns has already flattened every
        // inherited enumerable key into an own forwarding one, so own keys are the whole
        // set by this point. Still enumerated through a guard, because a `Proxy` can
        // throw from its `ownKeys` trap.
        let keys: string[];

        try {
          keys = Object.keys(info);
        } catch (error) {
          // Said, not swallowed. An empty list here rendered the error as one that simply
          // carried no `additionalInfo`, which is a different and much more reassuring
          // claim than "its keys could not be read" - and every other walk marks this
          // case: `renderContainer` emits `[unrenderable]`, `maskValueDeep` and
          // `redactPathsInner` the redaction marker, `snapshotValue` its own. This was
          // the one that degraded silently.
          reportRender(error, joinPath(path, 'additionalInfo'));
          table.addRow('AdditionalInfo', UNRENDERABLE_KEYS);

          addErrorTail(
            table,
            stack,
            cause,
            sensitivePaths,
            path,
            maxRowLength,
            seen,
            depth,
            budget,
            redactFunction,
            report,
            reportRender,
          );

          return table;
        }

        for (const key of keys) {
          // Checked, not only charged. Charging without a check bounds nothing: a payload
          // of fifty megabyte-long values billed the budget deeply negative and rendered
          // every one of them anyway.
          if (budget.remaining <= 0) {
            noteTruncation(budget, 'length');
            table.addRow('AdditionalInfo', TRUNCATED_LENGTH);

            break;
          }

          // The row's framing as well as the key, exactly as the nested walk charges it
          // and for the same reason: every entry here becomes a table row padded out to
          // the table width, which is none of the strings this walk produces. Charging
          // only the key billed roughly eight characters for a row that costs upwards of
          // a hundred and eighty, so `additionalInfo` holding 500,000 one-character
          // values rendered 22.5 MB against a 1 MB cap - and 111 MB at
          // `errorToString(err, 400)`, since the uncharged part scales with the width.
          // The identical payload one level deeper, where this charge already existed,
          // came out at 1.5 MB.
          // `capKey` first. `charge` bills a string and hands it back *whole*, which
          // bounds how many keys a render emits and says nothing about how long one of
          // them is - and a key is as attacker-shaped as a value, since a payload parsed
          // from JSON carries whatever key names arrived. A single five-megabyte key blew
          // straight through the one-megabyte cap, amplified here by the row framing: the
          // same payload as `additionalInfo` rendered 11,251,061 characters. Values were
          // bounded when the cap went in; keys were the leaf nobody cut.
          const renderedKey = chargeKeyRow(
            budget,
            key,
            keyTextLevels(maxRowLength, depth),
          );

          chargeUnits(budget, rowFrameCost(maxRowLength, depth));

          // `readMemberOrThrew`, not `readMember`. The plain helper answers `undefined`
          // for a read that refused, and `undefined` renders as the literal word - so an
          // entry whose accessor threw came out looking like one that was genuinely
          // absent, which is the same silent collapse the refused enumeration above is
          // marked for. The nested walk already marks this one level deeper; the top
          // level was the one place that did not.
          const entryValue = readMemberOrThrew(info, key);

          table.addRow(
            `AdditionalInfo.${renderedKey}`,
            isReadFailure(entryValue)
              ? reportUnrenderableValue(
                  entryValue.error,
                  joinPath(path, 'additionalInfo', key),
                  reportRender,
                )
              : stringifyValue(
                  entryValue,
                  joinPath(path, 'additionalInfo', key),
                  maxRowLength,
                  seen,
                  depth + 1,
                  budget,
                  redactFunction,
                  report,
                  reportRender,
                ),
          );
        }
      }
    }

    addErrorTail(
      table,
      stack,
      cause,
      sensitivePaths,
      path,
      maxRowLength,
      seen,
      depth,
      budget,
      redactFunction,
      report,
      reportRender,
    );
  }

  return table;
}

/**
 * Add the rows that close every error table: its `cause`, then its stack.
 *
 * `cause` is rendered because it is where the original now lives. A reporting path that
 * wraps a failure - `reportCallbackError` does - hands listeners a wrapper carrying the
 * thrown value on `cause` rather than a pre-rendered string, so that a consumer with its
 * own `redactFunction` renders it under its own settings. Rendered here, the wrapper still
 * says everything the pre-rendered form did.
 *
 * Shared so the fail-closed `sensitiveFieldNames` branch, which returns early, cannot
 * drift from the ordinary one.
 */
function addErrorTail(
  table: KeyValueASCIITable,
  stack: unknown,
  cause: unknown,
  sensitive: RedactPath[] | null,
  path: string,
  maxRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportFormatFailure,
  reportRender: ReportFormatFailure,
): void {
  if (isReadFailure(cause)) {
    // Already reported by the caller that did the read. Rendered rather than skipped,
    // because a `cause` accessor that threw is not an error without a cause.
    table.addRow('Cause', UNRENDERABLE_VALUE);
  } else if (cause !== undefined && cause !== null) {
    if (sensitive === null) {
      // The same fail-closed answer `additionalInfo` gets. Rendering the cause here while
      // refusing to render `additionalInfo` two rows above would disclose exactly what
      // the refusal was protecting.
      table.addRow('Cause', '*** (sensitiveFieldNames unreadable)');
    } else {
      // Rooted at `cause`, so the caller can address it: `sensitiveFieldNames: ['cause']`
      // masks the whole thing and `['cause.password']` reaches one field inside it. A
      // cause that is itself an error takes the nested-error branch and renders under its
      // own list instead, exactly as one nested in `additionalInfo` does.
      //
      // Wrapped in an object rather than redacted bare, because that is what puts it at
      // the `cause` path the caller writes; the walk refuses an empty path, and a bare
      // value would put `['cause.password']` one level off.
      const maskedWrapper = redactAddressedValue(
        { cause },
        sensitive,
        redactFunction,
        report,
        reportRender,
        budget,
      );

      // The same guard the `additionalInfo` branch carries. A walk that fails the whole
      // wrapper closed hands back the marker *string*, and reading `cause` off a string is
      // `undefined` - which would render the literal word "undefined" in place of the
      // marker that says redaction was attempted and failed.
      const maskedCause =
        maskedWrapper === null || typeof maskedWrapper !== 'object'
          ? maskedWrapper
          : readMember(maskedWrapper, 'cause');

      table.addRow(
        'Cause',
        stringifyValue(
          maskedCause,
          joinPath(path, 'cause'),
          maxRowLength,
          seen,
          depth + 1,
          budget,
          redactFunction,
          report,
          reportRender,
        ),
      );
    }
  }

  // `readMemberOrThrew` for the reason every other read in this table uses it: a `stack`
  // accessor that threw answered `undefined` under `readMember` and the truthiness test
  // below dropped the row, so the one member an operator reaches for first went missing
  // with nothing said about it.
  if (isReadFailure(stack)) {
    reportRender(stack.error, joinPath(path, 'stack'));
    table.addValueOnSeparateRow('Stack', UNRENDERABLE_VALUE);
  } else if (stack) {
    chargeUnits(budget, rowFrameCost(maxRowLength, depth));

    let renderedStack: unknown = stack;
    if (typeof stack === 'object') {
      if (sensitive === null) {
        renderedStack = '*** (sensitiveFieldNames unreadable)';
      } else {
        const masked = redactAddressedValue(
          { stack },
          sensitive,
          redactFunction,
          report,
          reportRender,
          budget,
        );
        renderedStack =
          masked !== null && typeof masked === 'object'
            ? readMember(masked, 'stack')
            : masked;
      }
    }
    const stackText = safeStringify(
      renderedStack,
      joinPath(path, 'stack'),
      reportRender,
      budget,
    );

    table.addValueOnSeparateRow(
      'Stack',
      chargeNestedText(
        budget,
        stackText,
        // `ownRowTextLevels`, not `rowTextLevels`: a stack is written on its own row, one
        // padded line per line of it, and a stack of many short lines was charged for its
        // characters and emitted as full-width rows.
        ownRowTextLevels(stackText, maxRowLength, depth),
      ),
    );
  }
}

/**
 * Floor for what one nested row costs the budget.
 *
 * The table width shrinks by four per level of nesting and goes negative past twenty, and
 * a negative cost is a *refund*: charging the width unclamped, a payload deep enough to
 * exhaust the width paid nothing and then handed budget back, so the deepest payloads -
 * the only ones the cap exists for - were the ones it stopped bounding.
 */
const MIN_ROW_COST = 8;

/**
 * How many rendered lines one row of a key-value table actually costs.
 *
 * `KeyValueASCIITable` emits a content line *and* a `+---+` rule per row, each padded out
 * to the full table width, so billing a row one width under-counted the render by half:
 * 400,000 one-character `additionalInfo` values rendered 1.88 MB against the 1 MB cap.
 *
 * This is the *framing* of one row, which is constant. A row whose value is written on its
 * own lines pays per line of that value too, and {@link ownRowTextLevels} is where that is
 * charged.
 */
const LINES_PER_ROW = 2;

/**
 * What a container's own delimiters cost, before the row amplification is applied.
 *
 * The two characters an empty container still renders as. Charged because a container
 * whose contents cost the budget nothing has to cost it something, or a payload built from
 * empty containers never reaches the cap at all - the same reason `renderContainer`
 * charges its brackets.
 */
const CONTAINER_FRAME_COST = 2;

/**
 * How many keys one bag forwards before it stops collecting them.
 *
 * Not a second cap on the output: a row costs the budget at least
 * `MIN_ROW_COST * LINES_PER_ROW`, so {@link MAX_RENDER_LENGTH} pays for this many rows and
 * no more, and the render stops at the budget - with its own marker row - at or before the
 * key this stops at. What it bounds is the *collection*, which is work the budget never
 * saw and which scales with the value rather than with the output.
 */
const MAX_ADDRESSABLE_BAG_KEYS = Math.ceil(
  MAX_RENDER_LENGTH / (MIN_ROW_COST * LINES_PER_ROW),
);

/**
 * What one row's framing costs the budget, excluding its text.
 *
 * Every row is padded out to the table width, emitted over {@link LINES_PER_ROW} lines,
 * and re-indented once per enclosing level - and none of that is any string the walks
 * produce, so nothing else charges it.
 */
function rowFrameCost(maxRowLength: number, depth: number): number {
  return Math.max(MIN_ROW_COST, maxRowLength) * (depth + 1) * LINES_PER_ROW;
}

/**
 * What one character of a row's text actually costs the whole render.
 *
 * Two multipliers, both of which the flat per-row charge misses. A cause's table is
 * re-wrapped and re-indented by every level above it, so a character is emitted once per
 * enclosing level; and each *wrapped line* carries borders and padding, which at the
 * narrow widths deep nesting reaches - the width drops by four per level and floors at
 * {@link KEY_VALUE_TABLE_MIN_WIDTH} - costs more than the content it frames. Charging the
 * text flat, a 200 KB message twenty-five causes deep rendered 26 MB against the 1 MB cap.
 */
function rowTextLevels(
  maxRowLength: number,
  depth: number,
  keyWidth = 0,
): number {
  // Clamped the way `KeyValueASCIITable.calculateColumnWidths` clamps the key column
  // itself: a key longer than that is wrapped rather than given the width it asked for, so
  // billing the raw length would over-charge - by up to ~37x at width 80 - and truncate a
  // render that fits.
  // The key column is not available to the value, so a row's text wraps inside what is
  // left of the width - and charging as though the whole table were content under-bills
  // by exactly that ratio. A forty-character key under an eighty-column table rendered
  // 2,189,105 characters against the one-megabyte cap. `keyWidth` defaults to zero for a
  // value written on its own row, which really does get the full width.
  const keyColumn = Math.min(
    keyWidth,
    Math.max(0, Math.floor((maxRowLength - 7) / 2)),
  );

  const content = Math.max(1, maxRowLength - ROW_FRAME_WIDTH - keyColumn);

  return ((depth + 1) * maxRowLength) / content;
}

/**
 * Cut a key to the allowance that will hold it, and bill what it will actually cost.
 *
 * The two halves have to agree. {@link capNestedKey} cuts against the per-level allowance
 * - a key wrapped in the narrow key column and padded out to the full width costs several
 * characters per character - while `charge` bills the raw count, so the budget was told a
 * key cost a fraction of what it emitted: three 450,000-character `additionalInfo` keys
 * rendered 3,038,876 characters against a 1,000,000 cap, each one billed 450,000 and the
 * loop's `remaining <= 0` guard never tripping until the third had already gone out.
 */
function chargeKeyRow(
  budget: RenderBudget,
  key: string,
  levels: number,
): string {
  const rendered = capNestedKey(budget, key, levels);

  chargeUnits(budget, rendered.length * Math.max(1, levels));

  return rendered;
}

/** Borders, padding and the key column's separator around one wrapped line of text. */
const ROW_FRAME_WIDTH = 6;

/**
 * What one character of a *key* costs, the {@link rowTextLevels} of the other column.
 *
 * A key is billed by {@link capKey} at its raw character count, and a raw count is not what
 * it renders to: the key column is roughly half the table width, so a key longer than that
 * wraps, and `KeyValueASCIITable` pads every one of those wrapped lines out to the *full*
 * width. A five-megabyte key cut to the one-megabyte cap rendered 2,251,070 characters at
 * the default width - the cap restored in name only, and by exactly the amplification the
 * value side already bills for.
 */
function keyTextLevels(maxRowLength: number, depth: number): number {
  const width = Math.max(MIN_ROW_COST, maxRowLength);

  // The key column as `KeyValueASCIITable.calculateColumnWidths` clamps it, which is what
  // a long key actually gets to wrap inside.
  const keyColumn = Math.max(1, Math.floor((width - 7) / 2));

  return ((depth + 1) * width) / keyColumn;
}

/**
 * How many lines `text` is written over before any wrapping.
 *
 * Counted rather than split: the value is caller data - a `stack` is as long as the engine
 * made it - and `split('\n')` on it allocates an array of every line to learn one number.
 */
function countLines(text: string): number {
  let lines = 1;
  let index = text.indexOf('\n');

  while (index !== -1) {
    lines++;
    index = text.indexOf('\n', index + 1);
  }

  return lines;
}

/**
 * {@link rowTextLevels} for a value written on its own row, which pays per *line*.
 *
 * An own row - the `Stack` row, and the nested tables - is emitted line by line, and
 * `KeyValueASCIITable` pads every one of those lines out to the full table width. For a
 * value whose lines are long, wrapping dominates and {@link rowTextLevels} already charges
 * it; for a value with many *short* lines nothing did, and a stack is precisely that shape:
 * `'a\n'.repeat(400_000)` rendered 32,400,890 characters against the one-megabyte cap,
 * because 400,000 one-character lines were billed as 800,000 characters and emitted as
 * 400,000 padded rows of eighty.
 *
 * So a character costs the wrapping it provokes *plus* its share of the padding every line
 * it ends carries. Measured on the text as handed over: a cut made against this factor
 * keeps a prefix, whose line count is never higher, so the estimate can only overshoot -
 * the safe direction for a cap.
 */
function ownRowTextLevels(
  text: string,
  maxRowLength: number,
  depth: number,
): number {
  const width = Math.max(MIN_ROW_COST, maxRowLength);
  const perLinePadding = (width * countLines(text)) / Math.max(1, text.length);

  return rowTextLevels(maxRowLength, depth) + (depth + 1) * perLinePadding;
}

function stringifyValue(
  value: unknown,
  path: string,
  maxRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportFormatFailure,
  reportRender: ReportFormatFailure,
): string | KeyValueASCIITable | NestedKeyValueEntry[] {
  if (typeof value === 'string') {
    // Cut at whatever budget is left, rather than emitted whole and merely charged for.
    // Charging without cutting bounded how *many* leaves this walk emits and nothing about
    // the size of one: a single ten-megabyte `additionalInfo` string rendered in full
    // against a one-megabyte cap, and said so nowhere, since the marker only ever landed
    // on the entry *after* it. `chargeText` handles the exhausted-budget case this used to
    // check for separately - with nothing left it keeps none of the value and emits the
    // marker alone.
    //
    // Charged at what a character of a row actually costs, the way the conventional-member
    // rows above already charge theirs. Billed flat, this leaf paid for the text once and
    // not for the wrapping and re-indenting that emits it: a single five-megabyte
    // `additionalInfo` value rendered 1,421,387 characters against the one-megabyte cap.
    //
    // Without a `keyWidth`, unlike those rows: this leaf is reached through the walk and
    // does not know the row it will sit in, so it is billed as though the whole width were
    // available to it. That under-bills a long key - which leaves less of the row for the
    // value and so wraps it harder - and the cap holds approximately rather than exactly.
    return chargeNestedText(budget, value, rowTextLevels(maxRowLength, depth));
  }

  // A payload that points back at itself would otherwise recurse until the stack runs
  // out. `additionalInfo` is arbitrary caller data, so a cycle is an ordinary mistake,
  // not a hostile one.
  //
  // Tracks the current path, not every object ever seen: the entry is removed once this
  // branch finishes, so an object referenced twice side by side still renders in full
  // both times and only a genuine cycle — an object contained within itself — is cut.
  // Marking on first sight instead would report `<circular>` for a payload that simply
  // reuses one object, which is not circular and would read as a bug in the caller's data.
  const isTracked = typeof value === 'object' && value !== null;

  if (isTracked) {
    if (seen.has(value)) {
      noteTruncation(budget, 'circular');

      return '<circular>';
    }

    // Releasing `seen` on the way out is what makes a shared subtree render once per
    // reference, so the cycle check bounds nothing about the size of the output: a
    // payload of `{ l: child, r: child }` nested twenty deep is not circular, not deep,
    // and rendered to over a hundred megabytes before the string length limit turned it
    // into `<error could not be rendered>` - losing the message, name and stack this
    // exists to report. The same depth cap and shared length budget the template
    // renderer already carries, since the two walk the same caller payloads and a cap
    // that held in only one of them would just be reached through the other entry point.
    if (depth >= MAX_RENDER_DEPTH) {
      noteTruncation(budget, 'depth');

      return charge(budget, TRUNCATED);
    }

    if (budget.remaining <= 0) {
      noteTruncation(budget, 'length');

      return charge(budget, TRUNCATED_LENGTH);
    }

    seen.add(value);
  }

  try {
    return stringifyValueInner(
      value,
      path,
      maxRowLength,
      seen,
      depth,
      budget,
      redactFunction,
      report,
      reportRender,
    );
  } finally {
    if (isTracked) {
      seen.delete(value);
    }
  }
}

function stringifyValueInner(
  value: unknown,
  path: string,
  maxRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportFormatFailure,
  reportRender: ReportFormatFailure,
): string | KeyValueASCIITable | NestedKeyValueEntry[] {
  let arrayValue: unknown[] | null;

  try {
    arrayValue = Array.isArray(value) ? (value as unknown[]) : null;
  } catch (error) {
    // `Array.isArray` throws on a revoked `Proxy`. Degrade this one leaf rather than
    // letting it escape to the top-level backstop, which would throw away the error's
    // message, name, and stack over a single bad value.
    reportRender(error, path);

    return UNRENDERABLE_VALUE;
  }

  if (arrayValue !== null) {
    // Handle arrays differently.
    //
    // A counted index loop building a plain `string[]`, not `source.map(...).join(', ')`,
    // for the same reason `redactPathsInner` and `maskValueDeep` count: `map` goes through
    // `ArraySpeciesCreate`, which calls the value's own subclass constructor with a
    // length, and a constructor that validates its arguments throws from inside the walk.
    // `join` would then be resolved off that subclass too. Either throw escapes every
    // per-value guard here and reaches only the top-level backstop, which discards the
    // error's message, name, and stack over a single bad value.
    const source = arrayValue;
    const parts: string[] = [];

    // The shared enumeration. Called inside the branch rather than once at the top: the
    // top-level `Array.isArray` above selects between two paths that enumerate different
    // things, and a value that is *not* a plain container must never be enumerated at all
    // - a hostile class instance renders by its constructor name, and asking it for keys
    // here would turn that into `<unrenderable>`. The two branches are exclusive, so this
    // still runs once per container.
    const shape = describeContainer(source);

    if (shape.kind !== 'array') {
      reportRender(
        shape.kind === 'unreadable'
          ? shape.error
          : new Error('Array would not report its length'),
        path,
      );

      return UNRENDERABLE_KEYS;
    }

    // This container's own framing, charged as `renderContainer` charges its brackets and
    // for the same reason: a container whose contents cost nothing cost nothing at all, so
    // a payload built from empty containers ran past the cap without ever reaching it -
    // `additionalInfo: { a: Array(600_000).fill({}) }` rendered 2,892,509 characters
    // against the one-megabyte cap.
    //
    // Billed at what a character of a row costs, like every other text this walk charges:
    // the framing is emitted into a row that is wrapped, padded and re-indented once per
    // enclosing level.
    chargeUnits(
      budget,
      CONTAINER_FRAME_COST * rowTextLevels(maxRowLength, depth),
    );

    for (let index = 0; index < shape.length; index++) {
      // The separator is charged, not the parts: a part was charged by the call that
      // produced it, and charging it again here would bill a leaf once per level above
      // it and make the cap collapse with depth instead of holding.
      if (index > 0) {
        charge(budget, ', ');
      }

      if (budget.remaining <= 0) {
        noteTruncation(budget, 'length');
        parts.push(TRUNCATED_LENGTH);

        break;
      }

      // Each element is read and rendered inside its own guard, exactly as the object
      // branch does, so one unreadable element degrades alone.
      try {
        const item = source[index];
        const remainingBefore = budget.remaining;

        const result = stringifyValue(
          item,
          joinPath(path, String(index)),
          maxRowLength,
          seen,
          depth + 1,
          budget,
          redactFunction,
          report,
          reportRender,
        );
        // Convert complex types to strings for joining. A string element is pushed as
        // it stands rather than quoted, so `['a', 'b']` still renders `a, b`; only a
        // value nested *inside* an element is quoted, where the quoting is what keeps a
        // value containing a comma from reading as two entries.
        if (typeof result === 'string') {
          parts.push(result);
        } else if (result instanceof KeyValueASCIITable) {
          parts.push(result.toString());
        } else {
          let text = entriesToText(result, path, reportRender);
          const levels = rowTextLevels(maxRowLength, depth);
          // Flattening quotes keys and values, expanding control characters up to
          // sixfold. Replace the original charge only when the escaped form costs more.
          if (text.length * levels > remainingBefore - budget.remaining) {
            budget.remaining = remainingBefore;
            text = chargeNestedText(budget, text, levels);
          }
          parts.push(text);
        }
      } catch (error) {
        reportRender(error, joinPath(path, String(index)));
        parts.push(UNRENDERABLE_VALUE);
      }
    }

    return parts.join(', ');
  } else if (typeof value === 'object' && value !== null) {
    // The shared brand check rather than a local `instanceof`, for the reason `toError`
    // documents: an error from a `vm` context, an iframe, or a jsdom window fails this
    // realm's `instanceof` while being an error in every respect. One inside
    // `additionalInfo` was therefore walked as an ordinary object and rendered as a plain
    // nested table, losing the `message`, `code` and `stack` rows the error branch gives
    // it. Guarded internally, so the local `try` this replaces is no longer needed.
    const isError = isErrorValue(value);

    if (!isPlainContainer(value)) {
      // Only a plain object or an array is *structure* to be walked; anything else - a
      // `Date`, a `Map`, a `URL`, a class instance, an `Error` - is a single value. The
      // shared rule, so redaction and rendering cannot disagree about what a value is.
      //
      // Walking these was both wrong and disclosing. A `Date` has no own enumerable
      // properties, so it rendered as an empty nested table instead of its timestamp; and
      // naming `session.password` on a class instance masked that one field while
      // printing every sibling beside it - an `internalToken` the caller never asked to
      // have shown, which is exactly what the logger's walk was rebuilt to prevent.
      //
      // Both of those cases are settled before this function sees the value: the walk
      // treats a non-plain value as one leaf, so a value named as a whole and a value
      // named *into* have each already been replaced by their mask. What arrives here is
      // whatever the walk left alone.
      if (isError) {
        // Nothing above addresses it, so it starts a fresh path root: the parent's list
        // addresses it as a whole or not at all, and its own `sensitiveFieldNames` covers
        // its own contents.
        return errorToASCIITable(
          value,
          path,
          Math.max(KEY_VALUE_TABLE_MIN_WIDTH, maxRowLength - 4),
          seen,
          depth,
          budget,
          redactFunction,
          report,
          reportRender,
        );
      }

      // `reportRender`, not the default no-op. It is in scope and threaded into every
      // other degradation site in this file, and omitting it here made this the one place
      // a value that *refused* to render - a `toString` that throws, a getter that blows
      // up - emitted its marker and told nobody: `onFormatError` documents `'render'` as
      // exactly this case and was never called for it.
      //
      // The marker itself stays `stringifyTemplateValue`'s `[unrenderable: ...]` rather
      // than this file's `<unrenderable: ...>`, deliberately: this branch hands the whole
      // value to that renderer, so every marker *inside* the result is already spelled its
      // way, and respelling only the outermost one would make a single rendered value
      // disagree with itself.
      //
      // Charged at what a character of a row costs, like the string leaf above and unlike
      // the flat `chargeText` this used to make: this value is written into a row that is
      // wrapped, padded and re-indented once per enclosing level, none of which a flat
      // character count sees.
      //
      // Rendered through `renderLeafWithinBudget` rather than bare, so the cut is made
      // against *this* render's allowance instead of the fixed `MAX_RENDER_LENGTH` the
      // budget-less call falls back to - which shortened a nested leaf at one megabyte
      // however high `maxRenderLength` was set, and told `onTruncate` nothing.
      const levels = rowTextLevels(maxRowLength, depth);
      const leaf = renderLeafWithinBudget(
        budget,
        value,
        path,
        reportRender,
        levels,
      );
      const truncationsBeforeCharge = budget.truncations;
      const charged = chargeNestedText(budget, leaf.text, levels);

      // Counted here only if the charge above did not cut the same leaf again. See
      // `noteLeafCut`.
      noteLeafCut(budget, leaf, truncationsBeforeCharge);

      return charged;
    } else {
      // An error-shaped plain object renders as an error, under its own
      // `sensitiveFieldNames`.
      //
      // `sensitiveFieldNames` names paths into `additionalInfo`, so honouring it means
      // rendering through the table that anchors it there; walking the object as ordinary
      // structure gives those names nothing to match. That was only ever reached when
      // such an object was handed straight to `errorToString`, and the reporting paths
      // stopped doing that: `reportCallbackError` and the `Logger` error listener both
      // wrap a thrown non-`Error` as `new Error(..., { cause })`. So an object that named
      // its own sensitive fields arrived one level down, was walked under the parent's
      // empty list, and printed those fields in the clear to every sink.
      //
      // Gated on `additionalInfo`/`cause` because that is the shape the list addresses -
      // and gated on exactly what the table itself requires of them, not on merely having
      // the key. The table renders `additionalInfo` only when it is a non-null object and
      // `cause` only when it is non-null, so an object holding `additionalInfo: 'text'` or
      // `cause: null` passed a looser gate here and then rendered as a completely empty
      // table, dropping every key it had. An object this cannot address stays on the walk
      // below, where its keys still render.
      //
      // The cost of staying on the walk is that such an object's *sibling* keys are printed
      // rather than dropped, and `sensitiveFieldNames` cannot mask them: the list names
      // paths into `additionalInfo`, so it never addressed them on the table path either -
      // they were merely invisible there, because the table prints four rows and not the
      // object's own keys. Keeping them is the deliberate trade this release made, and it
      // is why this gate does *not* simply track the widened `hasInfo` at the top of the
      // table.
      const asRecord = value as Record<string, unknown>;
      const ownInfo = readMemberOrThrew(asRecord, 'additionalInfo');
      const ownCause = readMemberOrThrew(asRecord, 'cause');

      // Read the "or threw" way, like `sensitiveFieldNames` below and for the same reason.
      // Under a plain guarded read an accessor that refused came back `undefined`, so the
      // gate answered "not error-shaped" and the object went to the walk below and printed
      // its keys in the clear - the one route on which a present-but-unusable
      // `sensitiveFieldNames` could no longer fail it closed, because the gate it depends on
      // had already been decided by the read that threw. A member that refuses counts as
      // present: the table is the branch that can fail it closed.
      if (isReadFailure(ownInfo)) {
        reportRender(ownInfo.error, joinPath(path, 'additionalInfo'));
      }

      if (isReadFailure(ownCause)) {
        reportRender(ownCause.error, joinPath(path, 'cause'));
      }

      const isErrorShaped =
        isReadFailure(ownInfo) ||
        isReadFailure(ownCause) ||
        (Boolean(ownInfo) && typeof ownInfo === 'object') ||
        (ownCause !== undefined && ownCause !== null);

      // Read the "or threw" way: an accessor that refused is the caller asking for
      // masking without saying what for, so it routes here too and the table fails it
      // closed, rather than being read as absent and walked in the clear.
      //
      // `undefined` alone counts as absent, matching `readOwnSensitivePaths`. A `null`
      // that did not route here was walked as ordinary structure and printed its fields
      // in the clear - the same leak that function's `null` handling exists to stop, one
      // level lower down, so the two have to draw the line in the same place.
      const rawOwnList = readMemberOrThrew(asRecord, 'sensitiveFieldNames');

      if (isErrorShaped && rawOwnList !== undefined) {
        return errorToASCIITable(
          value,
          path,
          Math.max(KEY_VALUE_TABLE_MIN_WIDTH, maxRowLength - 4),
          seen,
          depth,
          budget,
          redactFunction,
          report,
          reportRender,
        );
      }

      // Handle objects differently
      //
      // Keys first, then each value read inside its own guard. Reading them together with
      // `Object.entries` runs every own getter under one `catch`, so a single throwing
      // accessor discarded the whole object and rendered it empty with nothing to say a
      // read had failed - while the array branch beside it, and every other walk, degrade
      // one entry at a time.
      // The shared enumeration, reached only for a plain container. `unreadable` is a case
      // rather than an empty key list: read as `[]`, a container that refused printed as
      // one that genuinely held nothing, which is the silent collapse the comment above
      // rules out for a throwing accessor and then allowed one line lower for a refused
      // enumeration.
      const shape = describeContainer(value);

      if (shape.kind === 'unreadable') {
        reportRender(shape.error, path);

        return UNRENDERABLE_KEYS;
      }

      const keys = shape.kind === 'object' ? shape.keys : [];

      // Clamped, not just decremented. `KeyValueASCIITable` throws below its minimum
      // width, so a chain of nested values that kept subtracting four eventually threw
      // from the constructor and the top-level backstop turned the whole render into
      // `<error could not be rendered>` - eighteen levels was enough.
      const nestedRowLength = Math.max(
        KEY_VALUE_TABLE_MIN_WIDTH,
        maxRowLength - 4,
      );

      const entries: NestedKeyValueEntry[] = [];

      // The container's own framing, for the reason the array branch above charges its
      // brackets: an object with no keys charged nothing, so a payload of them was free.
      chargeUnits(
        budget,
        CONTAINER_FRAME_COST * rowTextLevels(maxRowLength, depth),
      );

      for (const key of keys) {
        if (budget.remaining <= 0) {
          noteTruncation(budget, 'length');
          entries.push({ key: TRUNCATED_LENGTH, value: '' });

          break;
        }

        // The row's framing as well as the key, and the framing scaled by how deep the
        // row sits. Two things the plain character count cannot see: every entry becomes
        // a row padded out to the table width, which is none of the strings the walk
        // produces; and the table re-indents each nested line once per level above it, so
        // one row's text is copied `depth` times into the finished output. Charging only
        // content let a payload of one-character keys build a million rows against a
        // budget it had barely touched, and charging a flat row let twenty levels of it
        // amplify to eighteen megabytes.
        // `capKey` first, for the reason the `additionalInfo` walk above does it: a key is
        // a variable-length leaf like any value, and billing one without cutting it leaves
        // the cap unenforced against a payload whose *keys* are large.
        const renderedKey = chargeKeyRow(
          budget,
          key,
          keyTextLevels(maxRowLength, depth),
        );

        chargeUnits(budget, rowFrameCost(maxRowLength, depth));

        let val: unknown;

        try {
          val = (value as Record<string, unknown>)[key];
        } catch (error) {
          reportRender(error, joinPath(path, key));
          entries.push({ key: renderedKey, value: UNRENDERABLE_VALUE });

          continue;
        }

        entries.push({
          key: renderedKey,
          value: stringifyValue(
            val,
            joinPath(path, key),
            nestedRowLength,
            seen,
            depth + 1,
            budget,
            redactFunction,
            report,
            reportRender,
          ),
        });
      }

      return entries;
    }
  } else {
    return chargeText(budget, safeStringify(value, path, reportRender, budget));
  }
}
