import {
  defineEntry,
  describeContainer,
  namedArrayKeys,
} from '../../internal/container-entries';
import { isPlainContainer } from '../../internal/is-plain-container';
import { isPromise } from '../../is-promise';
import { MAX_REDACTION_ENTRIES } from '../../internal/redact-paths';
import { MAX_RENDER_DEPTH, TRUNCATED } from '../../internal/render-budget';
import {
  consoleFormatHandler,
  createFormatReporter,
  type FormatErrorHandler,
  type ReportFormatFailure,
} from '../../internal/format-reporter';
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
 * Stands where the snapshot stopped because it had copied all it is allowed to.
 *
 * Distinct from {@link TRUNCATED}, which says the walk hit the depth cap, and from
 * {@link UNCOPYABLE_MARKER}, which says a read threw: this one says the payload was
 * simply bigger than one entry may keep, and everything after it is missing.
 */
const TRUNCATED_ENTRIES = '[max entries exceeded]';

/** Entries left to copy in one snapshot, shared by every level of it. */
interface SnapshotBudget {
  entriesLeft: number;
}

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
  report: ReportFormatFailure,
): Record<string, unknown> {
  const snapshot = snapshotValue(
    params,
    new WeakMap(),
    0,
    '<params>',
    report,
    // One allowance for the whole snapshot rather than a per-container cap: a payload
    // splits the same total cost across any shape it likes, and a bound that reset at
    // each level would be no bound at all.
    { entriesLeft: MAX_REDACTION_ENTRIES },
  );

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
  path: string,
  report: ReportFormatFailure,
  budget: SnapshotBudget,
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

  // The shared enumeration, so "what does this container hold, and did asking throw" is
  // answered the same way here as in every other walk. `unreadable` is a case rather than
  // an empty result, which is what keeps a container that refused from being copied as one
  // that was genuinely empty.
  const shape = describeContainer(value);

  if (shape.kind === 'unreadable') {
    // Nothing can be enumerated, so nothing of the original may survive. Recorded after
    // this, never before, so a second reference to a container that cannot be read gets
    // the marker too rather than an empty copy this had started.
    report(shape.error, path);

    return UNCOPYABLE_MARKER;
  }

  if (shape.kind === 'array') {
    const source = value as unknown[];
    const copy: unknown[] = [];

    seen.set(value, copy);

    // A counted index loop rather than `for...of`, matching the redaction walk: iteration
    // resolves `Symbol.iterator` off the value, which on a subclass is caller code.
    for (let index = 0; index < shape.length; index++) {
      // Billed per element, before the element is read. `shape.length` is not a fact -
      // `Array.isArray` is true for a `Proxy` whose `length` trap may answer any number,
      // and a real `new Array(20_000_000)` costs the same - so a claim of billions had
      // this loop allocating a slot per claimed element synchronously inside `write()`,
      // which runs inside the caller's `logger.info()`. An unchanged large subtree
      // reaches this snapshot by reference whenever something *else* in the params was
      // redacted, so the claim does not even have to be on the redacted branch.
      if (budget.entriesLeft <= 0) {
        copy.push(TRUNCATED_ENTRIES);

        return copy;
      }

      budget.entriesLeft--;

      const elementPath = `${path}[${String(index)}]`;

      try {
        copy.push(
          snapshotValue(
            source[index],
            seen,
            depth + 1,
            elementPath,
            report,
            budget,
          ),
        );
      } catch (error) {
        report(error, elementPath);
        copy.push(UNCOPYABLE_MARKER);
      }
    }

    // An array's *named* properties, which the redaction walks carry and the renderers
    // print - `maskValueDeep` and `redactPathsInner` both call `namedArrayKeys` precisely
    // because they exist. Copied by index alone, a bag whose `items` is
    // `Object.assign([1, 2], { cursor: 'abc' })` reached this sink as `[1, 2]`, so
    // `ArraySink` held less than every other sink rendered from the same entry - including
    // a redaction marker sitting on one of those keys, which simply vanished.
    let namedKeys: string[] = [];

    try {
      namedKeys = namedArrayKeys(source);
    } catch (error) {
      // Reported and marked: an enumeration that refused is not an array without named
      // properties. The marker goes in as a trailing element, since a key that was never
      // enumerated cannot be named - the same answer `maskValueDeep` gives.
      report(error, path);
      copy.push(UNCOPYABLE_MARKER);
    }

    for (const namedKey of namedKeys) {
      if (budget.entriesLeft <= 0) {
        copy.push(TRUNCATED_ENTRIES);

        return copy;
      }

      budget.entriesLeft--;

      const namedPath = `${path}.${namedKey}`;

      try {
        defineEntry(
          copy as unknown as Record<string, unknown>,
          namedKey,
          snapshotValue(
            (source as unknown as Record<string, unknown>)[namedKey],
            seen,
            depth + 1,
            namedPath,
            report,
            budget,
          ),
        );
      } catch (error) {
        report(error, namedPath);
        defineEntry(
          copy as unknown as Record<string, unknown>,
          namedKey,
          UNCOPYABLE_MARKER,
        );
      }
    }

    return copy;
  }

  const copy: Record<string, unknown> = {};

  seen.set(value, copy);

  for (const key of shape.keys) {
    // Counted against the same allowance as the array branch: an `ownKeys` trap is as
    // free to invent a million keys as a `length` trap is to invent a million elements.
    // The marker goes in under a key of its own, so a reader sees the copy stopped
    // rather than reading a bag that looks complete.
    if (budget.entriesLeft <= 0) {
      defineEntry(copy, TRUNCATED_ENTRIES, TRUNCATED_ENTRIES);

      return copy;
    }

    budget.entriesLeft--;

    let entry: unknown;

    try {
      entry = snapshotValue(
        (value as Record<string, unknown>)[key],
        seen,
        depth + 1,
        `${path}.${key}`,
        report,
        budget,
      );
    } catch (error) {
      report(error, `${path}.${key}`);
      entry = UNCOPYABLE_MARKER;
    }

    // Defined rather than assigned: a plain assignment to `__proto__` reparents the copy
    // instead of storing the entry.
    defineEntry(copy, key, entry);
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

  private onFormatError?: FormatErrorHandler;

  /**
   * How many format failures are being reported right now, so an `onFormatError` that
   * logs through this same sink cannot feed the loop that reported it.
   *
   * The guard `FileSink` and `NamedPipeSink` hold over a `'format'` failure, which this
   * sink lacked. A handler that logs the failure it was handed is the natural one - a test
   * harness recording what went wrong into the very sink it is inspecting - and the
   * `write()` it makes runs the same transformer, or snapshots the same hostile params,
   * that just failed. Each write built a fresh reporter, so nothing remembered that a
   * report was already being delivered: write reported, the handler wrote, that write
   * reported, the handler wrote again, and the recursion ran until the stack gave out,
   * storing thousands of entries on the way.
   *
   * While this is above zero, a nested write's report is dropped and its entry stored as
   * it would be otherwise. Dropped rather than counted: this sink has no health surface
   * to count it on, and the entry itself is not lost - only the second diagnosis of the
   * same failure is, which the first one already gave.
   *
   * A count held until the handler *settles*, not a flag cleared on return, and for the
   * same reason the file sink gives: an `async` handler returns at its first `await`, and
   * a flag cleared there was down again by the time the handler resumed and logged - so
   * the chain ran on, one report per turn of the event loop.
   */
  private formatReportsInFlight = 0;

  constructor(options?: {
    transformer?: ArrayLogTransformer;
    /**
     * Notified when a param could not be copied into the stored snapshot (`kind` is
     * `'render'`), or when the `transformer` threw and the untransformed entry was stored
     * instead (`kind` is `'transform'`, `path` is `<transformer>`), so a
     * `<value could not be copied>` marker or a silently passed-through entry leaves a
     * diagnosis. Defaults to `console.error`. Fires at most once per kind per entry
     * written.
     */
    onFormatError?: FormatErrorHandler;
  }) {
    this.transformer = options?.transformer;
    this.onFormatError = options?.onFormatError;
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
        : {
            ...entry,
            redactedParams: snapshotParams(
              entry.redactedParams,
              // One reporter per entry: the bound that matters here is per snapshot, since
              // a sink writes many entries over its life and a budget shared across all of
              // them would report the first hostile param and stay silent thereafter.
              // The handler beneath it is the guarded one - see `guardedFormatHandler`
              // for why it is never the reporter's own default, and see
              // `formatReportsInFlight` for what the guard stops.
              createFormatReporter('render', this.guardedFormatHandler()),
            ),
          };

    if (this.transformer) {
      try {
        const transformed = this.transformer(stored);

        if (transformed !== false) {
          // Store the transformed entry
          this.logs.push(transformed);
          return;
        }
      } catch (error) {
        // Said, not swallowed. Falling through to the original entry is the right
        // recovery - a broken transformer must not cost you the log - but it was also
        // completely silent, so a transformer that threw on every entry looked exactly
        // like one that had chosen to pass every entry through untouched.
        createFormatReporter('transform', this.guardedFormatHandler())(
          error,
          '<transformer>',
        );
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

  /**
   * The handler every report from this sink goes through, wrapped in the re-entry guard.
   *
   * Built here rather than at each reporter, so the two places `write()` reports from -
   * the snapshot and the transformer - share one guard, and a handler's write that fails
   * the *other* way is stopped too. The reporters beneath stay per entry: the once-per-kind
   * bound is theirs and is not what this is for.
   *
   * A handler is always supplied, never left to the reporter's own default. A sink runs
   * *inside* a log call by definition, and that default broadcasts on the global `'error'`
   * channel - which a listening logger would log, reaching this sink again. The console is
   * the only rung that cannot re-enter what is already running.
   *
   * Returns the handler's result rather than discarding it, for the reason
   * `createFormatReporter` gives: `reportThroughHandler` follows a promise so an `async`
   * handler that rejects lands on the console rung instead of becoming an unhandled
   * rejection. The count comes down on that same settlement, whichever way it goes.
   */
  private guardedFormatHandler(): FormatErrorHandler {
    const handler = this.onFormatError ?? consoleFormatHandler();

    // Typed as returning `unknown` rather than what `FormatErrorHandler` declares, so the
    // promise an `async` handler hands back travels on to the reporter whatever that alias
    // says about its return - the reporter follows it, and the guard comes down with it.
    return (error, kind, path): unknown => {
      // See `formatReportsInFlight`. The nested report is the one dropped; its entry is
      // stored by `write()` exactly as if nothing had been reported.
      if (this.formatReportsInFlight > 0) {
        return undefined;
      }

      this.formatReportsInFlight++;

      let result: unknown;

      try {
        result = handler(error, kind, path);
      } catch (handlerError) {
        // The throw is the reporter's to answer - it lands on the console rung there -
        // but the guard must come down here, before it does, or a throwing handler would
        // leave this sink silent about every later failure.
        this.formatReportsInFlight--;

        throw handlerError;
      }

      if (isPromise(result)) {
        // Settled through `Promise.resolve` rather than `result.finally`, as the logger
        // does: `isPromise` accepts any thenable, and a `then`-only one has no `finally`
        // to call - nor the `catch` the reporter calls on what this returns, which is
        // why the wrapped promise is what goes back rather than the handler's own
        // object. A rejection still travels on to the reporter through it; the side
        // chain here only lowers the guard either way.
        const settled = Promise.resolve(result);

        void settled.then(
          () => {
            this.formatReportsInFlight--;
          },
          () => {
            this.formatReportsInFlight--;
          },
        );

        return settled;
      }

      this.formatReportsInFlight--;

      return result;
    };
  }
}
