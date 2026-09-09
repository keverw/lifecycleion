import { isPlainContainer } from '../../internal/is-plain-container';
import { MAX_RENDER_DEPTH, TRUNCATED } from '../../internal/render-budget';
import type { ArrayLogTransformer, LogEntry, LogSink } from '../types';

/**
 * Stands in for a value whose read threw, so the snapshot could not copy it.
 *
 * Nothing of the original is kept, which is the safe direction: handing back the caller's
 * own value is exactly what the snapshot exists to avoid. Not {@link TRUNCATED}, which
 * says the walk stopped short of something readable, and not the redaction markers, which
 * would claim a masking happened here.
 */
const UNCOPYABLE_MARKER = '<value could not be copied>';

/**
 * Copy the structure of `redactedParams` so what is stored stops tracking the caller.
 *
 * `redactedParams` is not a snapshot: copies below the bag are built only along the
 * branches that led to a mask, so every subtree that held nothing redacted is the
 * caller's own object by reference. `FileSink` and `NamedPipeSink` settle this by
 * rendering their line inside `write()`, but this sink's whole purpose is to keep the
 * entry itself, so it takes the copy instead. Without it, a caller reusing one params
 * object across log calls could set `params.user.token = '<secret>'` *after* the log
 * call and read that token back in clear text from `logs[i].redactedParams`, under a
 * `redactedKeys: ['user.token']` that masked nothing because the key did not exist yet.
 *
 * Only plain objects and arrays are rebuilt. An `Error`, a `Date`, a `URL`, a class
 * instance is a value rather than structure - the same rule the redaction and rendering
 * walks turn on - and copying one either flattens it (an `Error`'s `message` and `stack`
 * are not enumerable) or reconstructs it wrongly, so it is kept by reference. A caller
 * that mutates one of those after the fact is outside what this can promise.
 *
 * Guarded and bounded the way the renderer is, and for the same reasons: keys and values
 * are caller code that can throw, and a structure deeper than {@link MAX_RENDER_DEPTH}
 * is past where the rendered `message` stopped printing it, so the copy stops at the same
 * place and says so with the same marker.
 */
function snapshotParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const snapshot = snapshotValue(params, new WeakMap(), 0);

  // The top level is a bag this sink owns, so a marker there would replace the whole
  // thing. Unreadable keys leave an empty bag instead - it carries no caller values.
  return isPlainContainer(snapshot)
    ? (snapshot as Record<string, unknown>)
    : {};
}

function snapshotValue(
  value: unknown,
  seen: WeakMap<object, unknown>,
  depth: number,
): unknown {
  if (!isPlainContainer(value)) {
    return value;
  }

  // A cycle resolves to the copy already made for it, so the shape survives instead of
  // recursing forever. A subtree referenced twice shares one copy for the same reason:
  // the snapshot only has to stop tracking the caller, not reproduce identity.
  const existing = seen.get(value);

  if (existing !== undefined) {
    return existing;
  }

  if (depth >= MAX_RENDER_DEPTH) {
    return TRUNCATED;
  }

  if (Array.isArray(value)) {
    const source = value as unknown[];
    const copy: unknown[] = [];

    let length: number;

    try {
      length = source.length;
    } catch {
      return UNCOPYABLE_MARKER;
    }

    // Recorded only once the container can be enumerated, so a second reference to one
    // that cannot gets the marker too rather than the empty copy this had started.
    seen.set(value, copy);

    // A counted index loop rather than `for...of`, matching the redaction walk: iteration
    // resolves `Symbol.iterator` off the value, which on a subclass is caller code.
    for (let index = 0; index < length; index++) {
      try {
        copy.push(snapshotValue(source[index], seen, depth + 1));
      } catch {
        copy.push(UNCOPYABLE_MARKER);
      }
    }

    return copy;
  }

  const copy: Record<string, unknown> = {};

  let keys: string[];

  try {
    keys = Object.keys(value);
  } catch {
    return UNCOPYABLE_MARKER;
  }

  seen.set(value, copy);

  for (const key of keys) {
    let entry: unknown;

    try {
      entry = snapshotValue(
        (value as Record<string, unknown>)[key],
        seen,
        depth + 1,
      );
    } catch {
      entry = UNCOPYABLE_MARKER;
    }

    // Defined rather than assigned: a plain assignment to `__proto__` reparents the copy
    // instead of storing the entry.
    Object.defineProperty(copy, key, {
      value: entry,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return copy;
}

/**
 * ArraySink stores logs in memory for testing and debugging
 */
export class ArraySink implements LogSink {
  public logs: LogEntry[] = [];
  private transformer?: ArrayLogTransformer;
  private closed = false;

  constructor(options?: { transformer?: ArrayLogTransformer }) {
    this.transformer = options?.transformer;
  }

  public write(entry: LogEntry): void {
    if (this.closed) {
      return;
    }

    // Taken before the transformer runs, so a transformer that reads `redactedParams`
    // sees the same values a later reader of `logs` will. `params` is deliberately left
    // alone: it is documented as the caller's own object by reference, an escape hatch
    // for a sink that needs the real values.
    const stored =
      entry.redactedParams === undefined
        ? entry
        : { ...entry, redactedParams: snapshotParams(entry.redactedParams) };

    if (this.transformer) {
      try {
        const transformed = this.transformer(stored);

        if (transformed !== false) {
          // Store the transformed entry
          this.logs.push(transformed);
          return;
        }
      } catch {
        // If transformer fails, fall through to store original entry
      }
    }
    // Store the original entry
    this.logs.push(stored);
  }

  /**
   * Clear all stored logs
   */
  public clear(): void {
    this.logs = [];
  }

  /**
   * Get logs in a snapshot-friendly format for testing
   */
  public getSnapshotFriendlyLogs(): string[] {
    return this.logs.map((log) => `${log.type}: ${log.message}`);
  }

  /**
   * Close the sink and stop accepting new logs
   */
  public close(): void {
    this.closed = true;
  }
}
