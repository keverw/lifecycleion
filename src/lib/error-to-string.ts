import type { NestedKeyValueEntry } from './ascii-tables/key-value-ascii-table';
import { KeyValueASCIITable } from './ascii-tables/key-value-ascii-table';
import {
  matchRedactPath,
  parseRedactPaths,
  type RedactPath,
} from './internal/redact-paths';
import {
  REDACTION_FAILED_MARKER,
  type RedactValueFunction,
} from './internal/default-redact-function';
import { resolveRedaction } from './internal/resolve-redaction';
import { maskValueDeep } from './internal/mask-value-deep';
import {
  createRedactionReporter,
  NOOP_REDACTION_REPORTER,
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
 * Mask a matched value for display, keeping the shape of a container.
 *
 * A leaf becomes the mask string. An object or array is walked and every leaf inside it
 * masked, then rendered normally - so naming a container redacts its contents instead of
 * replacing the whole thing with a mask of `'[object Object]'`, and an array's elements
 * are masked individually rather than joined and masked as one string.
 *
 * Fully guarded: reading the value runs an accessor this module does not own, and the
 * function itself is caller code. Either failing falls back to `***`, never to the
 * original value.
 */
function maskSensitiveValue(
  entry: string,
  readValue: () => unknown,
  table: KeyValueASCIITable,
  maxRowLength: number,
  seen: WeakSet<object>,
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
): string | KeyValueASCIITable | NestedKeyValueEntry[] {
  try {
    // `null` means "use the default for this one", so a caller can special-case a few
    // keys without reproducing the default masking for the rest. To render a literal
    // null, return the string. `undefined` defers the same way, so a function that
    // returns nothing for the keys it does not handle masks them rather than writing the
    // word `undefined` into the row.
    //
    // Each leaf is stringified before the function sees it, exactly as `applyRedaction`
    // does, so one function receives identical arguments from both - and so a mutating
    // function cannot reach into the caller's own error object.
    const masked = maskValueDeep(
      entry,
      readValue(),
      (key, leaf, isDerived) =>
        resolveRedaction(key, leaf, isDerived, redactFunction),
      new WeakSet(),
      report,
    );

    if (masked === null || typeof masked !== 'object') {
      return typeof masked === 'string' ? masked : safeStringify(masked);
    }

    // Already masked all the way down, so it is rendered with no sensitive paths left.
    return stringifyValue(
      masked,
      table,
      maxRowLength,
      seen,
      [],
      [],
      undefined,
      NOOP_REDACTION_REPORTER,
    );
  } catch (error) {
    // Same marker the logger uses for the same condition: redaction was attempted and
    // failed, which must read differently from a value that masked successfully.
    report(error, entry);

    return REDACTION_FAILED_MARKER;
  }
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
      [],
      options?.redactFunction,
      report,
    );

    return table.toString();
  } catch {
    return '<error could not be rendered>';
  }
}

function errorToASCIITable(
  error: unknown,
  maxRowLength: number,
  seen: WeakSet<object>,
  inheritedSensitive: RedactPath[],
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
): KeyValueASCIITable {
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
        table.addRow(label, safeStringify(value));
      }
    }

    const additionalInfo = readMember(err, 'additionalInfo');

    if (additionalInfo && typeof additionalInfo === 'object') {
      const rawSensitive = readMemberOrThrew(err, 'sensitiveFieldNames');

      const ownPaths =
        rawSensitive === undefined || rawSensitive === null
          ? []
          : parseRedactPaths(
              rawSensitive === READ_THREW ? undefined : rawSensitive,
            );

      // Fails closed. A `sensitiveFieldNames` that is present but is not a usable list
      // of strings — a comma-joined string, a `Set`, a non-string entry, or an accessor
      // that threw — means the caller asked for masking and this cannot tell what for.
      // Rendering everything in the clear would be the one unacceptable answer, so
      // `additionalInfo` is dropped wholesale instead. An entry that parses but resolves
      // to nothing is not this case: it masks nothing, exactly as the logger's
      // `redactedKeys` does.
      if (ownPaths === null) {
        report(
          new Error('sensitiveFieldNames is not a usable list of paths'),
          '<sensitiveFieldNames>',
        );
        table.addRow('AdditionalInfo', '*** (sensitiveFieldNames unreadable)');

        const stackOnly = readMember(err, 'stack');

        if (stackOnly) {
          table.addValueOnSeparateRow('Stack', safeStringify(stackOnly));
        }

        return table;
      }

      // An error nested in another's `additionalInfo` starts a fresh root for paths, so
      // the parent's entries address it as a whole rather than reaching inside it. Its
      // own list covers its own contents.
      const sensitivePaths = [...inheritedSensitive, ...ownPaths];

      const info = additionalInfo as Record<string, unknown>;

      // Keys enumerated through a guard: `for...in` walks the prototype chain and a
      // `Proxy` can throw from its `ownKeys` trap.
      let keys: string[];

      try {
        keys = Object.keys(info);
      } catch {
        keys = [];
      }

      for (const key of keys) {
        const matchedEntry = matchRedactPath(sensitivePaths, [key]);

        if (matchedEntry !== undefined) {
          table.addRow(
            `AdditionalInfo.${key}`,
            maskSensitiveValue(
              matchedEntry,
              // Read unguarded on purpose: `maskSensitiveValue` catches, so a throwing
              // accessor is reported as a failed mask. Going through `readMember` would
              // swallow the throw and hand over `undefined`, which stringifies to the
              // nine-character word "undefined" and masks to `un*****ed`.
              () => info[key],
              table,
              maxRowLength,
              seen,
              redactFunction,
              report,
            ),
          );
        } else {
          const value = readMember(info, key);

          table.addRow(
            `AdditionalInfo.${key}`,
            stringifyValue(
              value,
              table,
              maxRowLength,
              seen,
              sensitivePaths,
              [key],
              redactFunction,
              report,
            ),
          );
        }
      }
    }

    const stack = readMember(err, 'stack');

    if (stack) {
      table.addValueOnSeparateRow('Stack', safeStringify(stack));
    }
  }

  return table;
}

function stringifyValue(
  value: unknown,
  table: KeyValueASCIITable,
  maxRowLength: number,
  seen: WeakSet<object>,
  sensitive: RedactPath[],
  path: string[],
  redactFunction: RedactFieldFunction | undefined,
  report: ReportRedactionFailure,
): string | KeyValueASCIITable | NestedKeyValueEntry[] {
  if (typeof value === 'string') {
    return value;
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

    seen.add(value);
  }

  try {
    return stringifyValueInner(
      value,
      table,
      maxRowLength,
      seen,
      sensitive,
      path,
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
  table: KeyValueASCIITable,
  maxRowLength: number,
  seen: WeakSet<object>,
  sensitive: RedactPath[],
  path: string[],
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
      // Each element is read and rendered inside its own guard, exactly as the object
      // branch does, so one unreadable element degrades alone.
      try {
        const item = source[index];

        const matchedEntry = matchRedactPath(sensitive, [
          ...path,
          String(index),
        ]);

        if (matchedEntry !== undefined) {
          const maskedItem = maskSensitiveValue(
            matchedEntry,
            () => item,
            table,
            maxRowLength,
            seen,
            redactFunction,
            report,
          );

          parts.push(
            typeof maskedItem === 'string'
              ? maskedItem
              : safeStringify(maskedItem),
          );

          continue;
        }

        const result = stringifyValue(
          item,
          table,
          maxRowLength,
          seen,
          sensitive,
          [...path, String(index)],
          redactFunction,
          report,
        );
        // Convert complex types to strings for joining
        if (typeof result === 'string') {
          parts.push(result);
        } else if (result instanceof KeyValueASCIITable) {
          parts.push(result.toString());
        } else {
          parts.push(safeStringify(result));
        }
      } catch {
        parts.push('<unrenderable>');
      }
    }

    return parts.join(', ');
  } else if (typeof value === 'object' && value !== null) {
    let isError: boolean;

    try {
      isError = value instanceof Error;
    } catch {
      // `instanceof` walks a prototype chain, which a revoked `Proxy` refuses.
      isError = false;
    }

    if (isError) {
      // A nested error starts a fresh path root; the parent's entries address it as a
      // whole, which is handled by the caller before recursing here.
      return errorToASCIITable(
        value,
        maxRowLength - 4,
        seen,
        [],
        redactFunction,
        report,
      );
    } else {
      // Handle objects differently
      let ownEntries: [string, unknown][];

      try {
        ownEntries = Object.entries(value);
      } catch {
        ownEntries = [];
      }

      // Matched by path, exactly as the logger's `redactedKeys` does: a bare name in
      // `sensitiveFieldNames` addresses a top-level key of `additionalInfo`, and reaching
      // a nested value takes a path such as `user.password` or `items[0].token`.
      const entries: NestedKeyValueEntry[] = ownEntries.map(([key, val]) => {
        const matchedEntry = matchRedactPath(sensitive, [...path, key]);

        return {
          key,
          value:
            matchedEntry !== undefined
              ? maskSensitiveValue(
                  matchedEntry,
                  () => val,
                  table,
                  maxRowLength - 4,
                  seen,
                  redactFunction,
                  report,
                )
              : stringifyValue(
                  val,
                  table,
                  maxRowLength - 4,
                  seen,
                  sensitive,
                  [...path, key],
                  redactFunction,
                  report,
                ),
        };
      });

      return entries;
    }
  } else {
    return safeStringify(value);
  }
}
