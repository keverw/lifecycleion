import type { NestedKeyValueEntry } from './ascii-tables/key-value-ascii-table';
import { KeyValueASCIITable } from './ascii-tables/key-value-ascii-table';
import { getPathParts } from './internal/path-utils';

/**
 * Read a property off a value without trusting it.
 *
 * The value being rendered is whatever was thrown, and `message`/`stack`/`code` are
 * ordinary properties that a subclass or a `Proxy` can turn into accessors that throw.
 * This module runs on reporting paths that must not raise an error of their own, so an
 * unreadable member is treated as absent.
 */
/**
 * Parse `sensitiveFieldNames` into path segments, using the same syntax as the logger's
 * `redactedKeys`: a bare name is a top-level key, and `user.password` / `items[0].token`
 * / quoted bracket keys address one exact location.
 *
 * @returns One segment list per entry, or `null` when the value is not a usable list of
 *          paths - which callers must treat as a reason to mask everything rather than
 *          to mask nothing.
 */
function parseSensitivePaths(value: unknown): string[][] | null {
  try {
    if (!Array.isArray(value)) {
      return null;
    }

    const paths: string[][] = [];

    for (const entry of value as unknown[]) {
      if (typeof entry !== 'string') {
        return null;
      }

      const parts = getPathParts(entry);

      if (parts === null || parts.length === 0) {
        // A malformed entry means the caller asked for masking somewhere this cannot
        // locate. Failing open here would render the value it names in the clear.
        return null;
      }

      paths.push(parts);
    }

    return paths;
  } catch {
    return null;
  }
}

/** Whether `path` is exactly one of the sensitive paths. */
function isSensitivePath(sensitive: string[][], path: string[]): boolean {
  return sensitive.some(
    (candidate) =>
      candidate.length === path.length &&
      candidate.every((part, index) => part === path[index]),
  );
}

function readMember(value: Record<string, unknown>, key: string): unknown {
  try {
    return value[key];
  } catch {
    return undefined;
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
export function errorToString(error: unknown, maxRowLength = 80): string {
  try {
    const table = errorToASCIITable(error, maxRowLength, new WeakSet(), []);

    return table.toString();
  } catch {
    return '<error could not be rendered>';
  }
}

function errorToASCIITable(
  error: unknown,
  maxRowLength: number,
  seen: WeakSet<object>,
  inheritedSensitive: string[][],
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
      const rawSensitive = readMember(err, 'sensitiveFieldNames');

      const ownPaths =
        rawSensitive === undefined || rawSensitive === null
          ? []
          : parseSensitivePaths(rawSensitive);

      // Fails closed, like the logger's redaction does. A `sensitiveFieldNames` that is
      // present but not a usable list of paths — a comma-joined string, a `Set`, a
      // malformed entry, or an accessor that threw and read back as `undefined` — means
      // the caller asked for masking somewhere this cannot locate. Rendering everything
      // in the clear would be the one unacceptable answer, so `additionalInfo` is
      // dropped wholesale instead.
      if (ownPaths === null) {
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
        if (isSensitivePath(sensitivePaths, [key])) {
          table.addRow(`AdditionalInfo.${key}`, '***');
        } else {
          const value = readMember(info, key);

          table.addRow(
            `AdditionalInfo.${key}`,
            stringifyValue(value, table, maxRowLength, seen, sensitivePaths, [
              key,
            ]),
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
  sensitive: string[][],
  path: string[],
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
  sensitive: string[][],
  path: string[],
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
    // Handle arrays differently
    return arrayValue
      .map((item, index) => {
        if (isSensitivePath(sensitive, [...path, String(index)])) {
          return '***';
        }

        const result = stringifyValue(
          item,
          table,
          maxRowLength,
          seen,
          sensitive,
          [...path, String(index)],
        );
        // Convert complex types to strings for joining
        if (typeof result === 'string') {
          return result;
        } else if (result instanceof KeyValueASCIITable) {
          return result.toString();
        } else {
          return safeStringify(result);
        }
      })
      .join(', ');
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
      return errorToASCIITable(value, maxRowLength - 4, seen, []);
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
      const entries: NestedKeyValueEntry[] = ownEntries.map(([key, val]) => ({
        key,
        value: isSensitivePath(sensitive, [...path, key])
          ? '***'
          : stringifyValue(val, table, maxRowLength - 4, seen, sensitive, [
              ...path,
              key,
            ]),
      }));

      return entries;
    }
  } else {
    return safeStringify(value);
  }
}
