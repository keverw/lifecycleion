import { getPathParts } from './path-utils';
import { maskValueDeep } from './mask-value-deep';
import { resolveRedaction } from './resolve-redaction';
import { REDACTION_FAILED_MARKER } from './default-redact-function';

/** Decides the replacement for a redacted value. */
export type RedactLeafFunction = (key: string, value: unknown) => unknown;

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

/** Build a copy of `value` with every matched path masked, keeping the shape. */
function redactPathsInner(
  value: unknown,
  paths: RedactPath[],
  path: string[],
  redactFunction: RedactLeafFunction | undefined,
  seen: WeakSet<object>,
): unknown {
  const matched = matchRedactPath(paths, path);

  if (matched !== undefined) {
    try {
      return maskValueDeep(matched, value, (key, leaf, isDerived) =>
        resolveRedaction(key, leaf, isDerived, redactFunction),
      );
    } catch {
      // Never fall back to the original: a failed redaction says so instead.
      return REDACTION_FAILED_MARKER;
    }
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    // A cycle cannot be rebuilt, and handing back the original would put an unmasked
    // object inside the copy - its own contents may sit at a path not yet reached.
    return REDACTION_FAILED_MARKER;
  }

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return (value as unknown[]).map((item, index) =>
        redactPathsInner(
          item,
          paths,
          [...path, String(index)],
          redactFunction,
          seen,
        ),
      );
    }

    let entries: [string, unknown][];

    try {
      entries = Object.entries(value);
    } catch {
      // The keys cannot be read, so nothing below can be masked. Returning the original
      // would hand back every sibling in the clear - including the ones named for
      // redaction, since the walk never reached them.
      return REDACTION_FAILED_MARKER;
    }

    const copy: Record<string, unknown> = {};

    for (const [key, entryValue] of entries) {
      Object.defineProperty(copy, key, {
        value: redactPathsInner(
          entryValue,
          paths,
          [...path, key],
          redactFunction,
          seen,
        ),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }

    return copy;
  } finally {
    seen.delete(value);
  }
}

/**
 * Build a copy of `value` with every path in `paths` masked, keeping the shape.
 *
 * The one walk both the logger's `redactedKeys` and `stringifyValue` use, so an entry
 * addresses the same thing and masks the same way in either.
 */
export function redactMatchedPaths(
  value: unknown,
  paths: RedactPath[],
  redactFunction: RedactLeafFunction | undefined,
): unknown {
  return redactPathsInner(value, paths, [], redactFunction, new WeakSet());
}
