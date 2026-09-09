import type { NestedKeyValueEntry } from './ascii-tables/key-value-ascii-table';
import {
  KEY_VALUE_TABLE_MIN_WIDTH,
  KeyValueASCIITable,
} from './ascii-tables/key-value-ascii-table';
import {
  parseRedactPaths,
  redactMatchedPaths,
  type RedactPath,
} from './internal/redact-paths';
import {
  REDACTION_FAILED_MARKER,
  type RedactValueFunction,
} from './internal/default-redact-function';
import { isPlainContainer } from './internal/is-plain-container';
import { stringifyTemplateValue } from './internal/stringify-template-value';
import { isErrorValue } from './to-error';
import {
  charge,
  chargeUnits,
  createRenderBudget,
  MAX_RENDER_DEPTH,
  TRUNCATED,
  TRUNCATED_LENGTH,
  type RenderBudget,
} from './internal/render-budget';
import {
  createRedactionReporter,
  type RedactionErrorHandler,
  type ReportRedactionFailure,
} from './internal/redaction-reporter';

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

export type { RedactionErrorHandler } from './internal/redaction-reporter';

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
   * Notified when redaction fails for a value, so a broken `redactFunction` leaves a
   * diagnosis and not only a `***REDACTION FAILED***` marker. Defaults to `console.error`.
   *
   * Not routed to the global `'error'` channel: reporting there would loop, since a
   * listening logger logs it, logging renders, rendering redacts, and redaction throws
   * again. Fires at most once per call.
   *
   * Do not redact or log from inside it.
   */
  onRedactionError?: RedactionErrorHandler;
}

/**
 * Read a property off a value without trusting it.
 *
 * The value being rendered is whatever was thrown, and `message`/`stack`/`code` are
 * ordinary properties that a subclass or a `Proxy` can turn into accessors that throw.
 * This module runs on reporting paths that must not raise an error of their own, so an
 * unreadable member is treated as absent.
 *
 * See {@link readMemberOrThrew} where "absent" and "unreadable" have to be told apart.
 */
function readMember(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

/**
 * Returned by {@link readMemberOrThrew} when the read itself threw, which is not the same
 * as the member being absent. `sensitiveFieldNames` must tell them apart: absent means
 * nothing to mask, unreadable means the caller asked for masking and this cannot tell
 * what, which has to fail closed.
 */
const READ_THREW = Symbol('read-threw');

function readMemberOrThrew(
  value: Record<string, unknown>,
  key: string,
): unknown {
  try {
    return value[key];
  } catch {
    return READ_THREW;
  }
}

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
  report: ReportRedactionFailure,
): RedactPath[] | null {
  const raw = readMemberOrThrew(value, 'sensitiveFieldNames');

  if (raw === undefined || raw === null) {
    return [];
  }

  const parsed = parseRedactPaths(raw === READ_THREW ? undefined : raw);

  // Fails closed. A `sensitiveFieldNames` that is present but is not a usable list of
  // strings - a comma-joined string, a `Set`, a non-string entry, or an accessor that
  // threw - means the caller asked for masking and this cannot tell what for. Rendering
  // everything in the clear would be the one unacceptable answer.
  if (parsed === null) {
    report(
      new Error('sensitiveFieldNames is not a usable list of paths'),
      '<sensitiveFieldNames>',
    );
  }

  return parsed;
}

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
 */
function asAddressableBag(info: object): object {
  if (isPlainContainer(info)) {
    return info;
  }

  let keys: string[];

  try {
    keys = Object.keys(info);
  } catch {
    // A `Proxy` can throw from its `ownKeys` trap. Nothing can be addressed, and nothing
    // can be rendered either, so an empty bag is the whole answer.
    return {};
  }

  const bag: Record<string, unknown> = {};

  for (const key of keys) {
    try {
      Object.defineProperty(bag, key, {
        get: () => (info as Record<string, unknown>)[key],
        enumerable: true,
        configurable: true,
      });
    } catch {
      // One key that will not forward is dropped rather than failing the whole bag.
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
 * Fully guarded. The walk reads caller properties and calls the caller's `redactFunction`,
 * and this sits on a reporting path that must not raise an error of its own. A failure
 * fails closed on the whole value rather than falling through to the unmasked original.
 */
function redactAddressedValue(
  value: unknown,
  paths: RedactPath[],
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
): unknown {
  if (paths.length === 0) {
    return value;
  }

  try {
    return redactMatchedPaths(value, paths, redactFunction, report);
  } catch (error) {
    report(error, '<sensitiveFieldNames>');

    return REDACTION_FAILED_MARKER;
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
function entriesToText(entries: NestedKeyValueEntry[]): string {
  const parts: string[] = [];

  for (const entry of entries) {
    parts.push(`${quoteText(entry.key)}:${renderedValueToText(entry.value)}`);
  }

  return `{${parts.join(',')}}`;
}

function renderedValueToText(
  value: string | KeyValueASCIITable | NestedKeyValueEntry[],
): string {
  if (typeof value === 'string') {
    return quoteText(value);
  }

  if (value instanceof KeyValueASCIITable) {
    return quoteText(value.toString());
  }

  return entriesToText(value);
}

/** JSON string literal, so a value containing a comma cannot be read as two entries. */
function quoteText(value: string): string {
  try {
    return JSON.stringify(value) ?? '""';
  } catch {
    return '"<unrenderable>"';
  }
}

function safeStringify(value: unknown): string {
  try {
    return stringifyPrimitive(value);
  } catch {
    // `JSON.stringify` throws on a cyclic object and on a `BigInt` nested inside one,
    // `String()` invokes `toString`/`Symbol.toPrimitive`, and a symbol's own `toString`
    // can be overridden. None of that may escape a rendering call.
    return '<unrenderable>';
  }
}

function stringifyPrimitive(value: unknown): string {
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
      return JSON.stringify(value) ?? '<unrenderable>';
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
  options?: ErrorToStringOptions,
): string {
  const report = createRedactionReporter(options?.onRedactionError);

  try {
    const table = errorToASCIITable(
      error,
      maxRowLength,
      new WeakSet(),
      0,
      createRenderBudget(),
      options?.redactFunction,
      report,
    );

    return table.toString();
  } catch {
    return '<error could not be rendered>';
  }
}

/** The width `KeyValueASCIITable` falls back to, applied where a caller's is unusable. */
const DEFAULT_TABLE_WIDTH = 80;

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
 */
function resolveTableWidth(maxRowLength: number): number {
  if (!Number.isFinite(maxRowLength) || maxRowLength <= 0) {
    return DEFAULT_TABLE_WIDTH;
  }

  return Math.max(KEY_VALUE_TABLE_MIN_WIDTH, maxRowLength);
}

function errorToASCIITable(
  error: unknown,
  requestedRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
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
      const value = readMember(err, key);

      if (value) {
        table.addRow(label, charge(budget, safeStringify(value)));
      }
    }

    const additionalInfo = readMember(err, 'additionalInfo');
    const cause = readMember(err, 'cause');

    const hasInfo =
      Boolean(additionalInfo) && typeof additionalInfo === 'object';
    const hasCause = cause !== undefined && cause !== null;

    // Parsed once, ahead of both consumers. `cause` is caller data as much as
    // `additionalInfo` is, so it is covered by the same list and by the same fail-closed
    // rule; reading the list separately for each would let them disagree about whether it
    // was usable, and rendering the cause outside the rule is how a masked
    // `additionalInfo` came to sit beside a cause printed in the clear.
    let ownPaths: RedactPath[] | null = [];

    if (hasInfo || hasCause) {
      // Unusable means `additionalInfo` and `cause` are dropped wholesale below. An entry
      // that parses but resolves to nothing is not that case: it masks nothing, exactly
      // as the logger's `redactedKeys` does.
      ownPaths = readOwnSensitivePaths(err, report);
    }

    // Every table is its own root. An error nested in another's `additionalInfo` is
    // addressed by the parent's entries as a whole or not at all - the parent's walk has
    // already run by the time this is reached - and its own list covers its own contents.
    const sensitivePaths = ownPaths;

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
        const masked = redactAddressedValue(
          asAddressableBag(additionalInfo as object),
          sensitivePaths,
          redactFunction,
          report,
        );

        // The walk can fail the whole value closed, and what it hands back then is the
        // marker string rather than a bag of keys. Enumerating that walks the *string*,
        // so a failed redaction rendered as twenty-two rows of `AdditionalInfo.0`,
        // `AdditionalInfo.1` - one per character of `***REDACTION FAILED***`.
        if (masked === null || typeof masked !== 'object') {
          table.addRow('AdditionalInfo', charge(budget, safeStringify(masked)));

          addErrorTail(
            table,
            err,
            cause,
            sensitivePaths,
            maxRowLength,
            seen,
            depth,
            budget,
            redactFunction,
            report,
          );

          return table;
        }

        const info = masked as Record<string, unknown>;

        // Keys enumerated through a guard: `for...in` walks the prototype chain and a
        // `Proxy` can throw from its `ownKeys` trap.
        let keys: string[];

        try {
          keys = Object.keys(info);
        } catch {
          keys = [];
        }

        for (const key of keys) {
          // Checked, not only charged. Charging without a check bounds nothing: a payload
          // of fifty megabyte-long values billed the budget deeply negative and rendered
          // every one of them anyway.
          if (budget.remaining <= 0) {
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
          charge(budget, key);
          chargeUnits(
            budget,
            Math.max(MIN_ROW_COST, maxRowLength) * (depth + 1),
          );

          table.addRow(
            `AdditionalInfo.${key}`,
            stringifyValue(
              readMember(info, key),
              maxRowLength,
              seen,
              depth + 1,
              budget,
              redactFunction,
              report,
            ),
          );
        }
      }
    }

    addErrorTail(
      table,
      err,
      cause,
      sensitivePaths,
      maxRowLength,
      seen,
      depth,
      budget,
      redactFunction,
      report,
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
  err: Record<string, unknown>,
  cause: unknown,
  sensitive: RedactPath[] | null,
  maxRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
): void {
  if (cause !== undefined && cause !== null) {
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
      );

      // The same guard the `additionalInfo` branch carries. A walk that fails the whole
      // wrapper closed hands back the marker *string*, and reading `cause` off a string is
      // `undefined` - which would render the literal word "undefined" in place of the
      // marker that says redaction was attempted and failed.
      const maskedCause =
        maskedWrapper === null || typeof maskedWrapper !== 'object'
          ? maskedWrapper
          : readMember(maskedWrapper as Record<string, unknown>, 'cause');

      table.addRow(
        'Cause',
        stringifyValue(
          maskedCause,
          maxRowLength,
          seen,
          depth + 1,
          budget,
          redactFunction,
          report,
        ),
      );
    }
  }

  const stack = readMember(err, 'stack');

  if (stack) {
    table.addValueOnSeparateRow('Stack', charge(budget, safeStringify(stack)));
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

function stringifyValue(
  value: unknown,
  maxRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
): string | KeyValueASCIITable | NestedKeyValueEntry[] {
  if (typeof value === 'string') {
    // Checked before it is charged. A leaf is emitted whole rather than cut mid-string, so
    // the total can overshoot by one value; what it cannot do is emit an unbounded number
    // of them, which is what charging without checking allowed.
    if (budget.remaining <= 0) {
      return TRUNCATED_LENGTH;
    }

    return charge(budget, value);
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
      return charge(budget, TRUNCATED);
    }

    if (budget.remaining <= 0) {
      return charge(budget, TRUNCATED_LENGTH);
    }

    seen.add(value);
  }

  try {
    return stringifyValueInner(
      value,
      maxRowLength,
      seen,
      depth,
      budget,
      redactFunction,
      report,
    );
  } finally {
    if (isTracked) {
      seen.delete(value);
    }
  }
}

function stringifyValueInner(
  value: unknown,
  maxRowLength: number,
  seen: WeakSet<object>,
  depth: number,
  budget: RenderBudget,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
): string | KeyValueASCIITable | NestedKeyValueEntry[] {
  let arrayValue: unknown[] | null;

  try {
    arrayValue = Array.isArray(value) ? (value as unknown[]) : null;
  } catch {
    // `Array.isArray` throws on a revoked `Proxy`. Degrade this one leaf rather than
    // letting it escape to the top-level backstop, which would throw away the error's
    // message, name, and stack over a single bad value.
    return '<unrenderable>';
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

    let length: number;

    try {
      length = source.length;
    } catch {
      return '<unrenderable>';
    }

    for (let index = 0; index < length; index++) {
      // The separator is charged, not the parts: a part was charged by the call that
      // produced it, and charging it again here would bill a leaf once per level above
      // it and make the cap collapse with depth instead of holding.
      if (index > 0) {
        charge(budget, ', ');
      }

      if (budget.remaining <= 0) {
        parts.push(TRUNCATED_LENGTH);

        break;
      }

      // Each element is read and rendered inside its own guard, exactly as the object
      // branch does, so one unreadable element degrades alone.
      try {
        const item = source[index];

        const result = stringifyValue(
          item,
          maxRowLength,
          seen,
          depth + 1,
          budget,
          redactFunction,
          report,
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
          parts.push(entriesToText(result));
        }
      } catch {
        parts.push('<unrenderable>');
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
          Math.max(KEY_VALUE_TABLE_MIN_WIDTH, maxRowLength - 4),
          seen,
          depth + 1,
          budget,
          redactFunction,
          report,
        );
      }

      return charge(budget, stringifyTemplateValue(value));
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
      const asRecord = value as Record<string, unknown>;
      const ownInfo = readMember(asRecord, 'additionalInfo');
      const ownCause = readMember(asRecord, 'cause');
      const isErrorShaped =
        (Boolean(ownInfo) && typeof ownInfo === 'object') ||
        (ownCause !== undefined && ownCause !== null);

      // Read the "or threw" way: an accessor that refused is the caller asking for
      // masking without saying what for, so it routes here too and the table fails it
      // closed, rather than being read as absent and walked in the clear.
      const rawOwnList = readMemberOrThrew(asRecord, 'sensitiveFieldNames');

      if (isErrorShaped && rawOwnList !== undefined && rawOwnList !== null) {
        return errorToASCIITable(
          value,
          Math.max(KEY_VALUE_TABLE_MIN_WIDTH, maxRowLength - 4),
          seen,
          depth + 1,
          budget,
          redactFunction,
          report,
        );
      }

      // Handle objects differently
      //
      // Keys first, then each value read inside its own guard. Reading them together with
      // `Object.entries` runs every own getter under one `catch`, so a single throwing
      // accessor discarded the whole object and rendered it empty with nothing to say a
      // read had failed - while the array branch beside it, and every other walk, degrade
      // one entry at a time.
      let keys: string[];

      try {
        keys = Object.keys(value);
      } catch {
        keys = [];
      }

      // Clamped, not just decremented. `KeyValueASCIITable` throws below its minimum
      // width, so a chain of nested values that kept subtracting four eventually threw
      // from the constructor and the top-level backstop turned the whole render into
      // `<error could not be rendered>` - eighteen levels was enough.
      const nestedRowLength = Math.max(
        KEY_VALUE_TABLE_MIN_WIDTH,
        maxRowLength - 4,
      );

      const entries: NestedKeyValueEntry[] = [];

      for (const key of keys) {
        if (budget.remaining <= 0) {
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
        charge(budget, key);
        chargeUnits(budget, Math.max(MIN_ROW_COST, maxRowLength) * (depth + 1));

        let val: unknown;

        try {
          val = (value as Record<string, unknown>)[key];
        } catch {
          entries.push({ key, value: '<unrenderable>' });

          continue;
        }

        entries.push({
          key,
          value: stringifyValue(
            val,
            nestedRowLength,
            seen,
            depth + 1,
            budget,
            redactFunction,
            report,
          ),
        });
      }

      return entries;
    }
  } else {
    return charge(budget, safeStringify(value));
  }
}
