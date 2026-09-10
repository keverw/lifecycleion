import {
  defineEntry,
  describeContainer,
} from '../../internal/container-entries';
import { readMember } from '../../internal/read-member';
import { MAX_RENDER_DEPTH, TRUNCATED } from '../../internal/render-budget';
import { isErrorValue } from '../../to-error';
import {
  createRenderReporter,
  type RenderErrorHandler,
  type ReportRenderFailure,
} from '../../internal/render-reporter';

/** Options for {@link serializeError}. */
export interface SerializeErrorOptions {
  /**
   * Notified when a value could not be serialized, so an `<unserializable>` marker leaves
   * a diagnosis and not only a marker.
   *
   * With no handler set, a standalone call reports on the standard global `'error'` channel - so a `logger.registerReportErrorListener()` records it - and falls back to `console.error` only when nothing claims the event. The `Logger` and its sinks always supply a handler for their own work, so this default is never reached from inside a log call.
   *
   * This runs at an IPC or RPC boundary, usually while already reporting a failure, so the
   * marker keeps the payload intact and the cause comes here instead. The cause is
   * deliberately absent from the marker: it comes from the caller's own getter and may
   * carry the value it was hiding, and this payload is about to be sent over a wire.
   *
   * Fires at most once per call. Do not serialize or log from inside it.
   */
  onRenderError?: RenderErrorHandler;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  [key: string]: unknown;
}

/**
 * Stands in for a value whose read threw, and says which half of it refused.
 *
 * Split the way `errorToString` and the template renderer split theirs, and it earns the
 * detail here more than anywhere: this payload crosses a process boundary, and the
 * receiving side has no `onRenderError` of its own. The marker is the only thing that
 * survives the wire, so it is the only diagnosis that reader will ever get.
 *
 * **The cause is deliberately not here**, for the same reason it is nowhere else: it comes
 * from the caller's own getter and may carry the value it was hiding - and this object is
 * about to be sent somewhere. It goes to `onRenderError` instead.
 */
const UNSERIALIZABLE_KEYS = '<unserializable: keys>';

/** A single value refused to be read - a throwing accessor, a revoked `Proxy`. */
const UNSERIALIZABLE_VALUE = '<unserializable: value>';

/** A value was readable but could not be turned into text. */
const UNSERIALIZABLE_TEXT = '<unserializable: text>';

/**
 * Check if a value looks like an Error (has name, message, and stack).
 *
 * Guarded: `in` is a trappable operation, so a `Proxy` with a hostile `has` threw out of
 * what is only a shape test. This runs on the receiving end of IPC and on error paths, so
 * asking the question must not raise a failure of its own.
 */
export function isErrorLike(
  value: unknown,
): value is { name: string; message: string; stack: string } {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      'name' in value &&
      'message' in value &&
      'stack' in value
    );
  } catch {
    return false;
  }
}

/** A member as a string, or `undefined` when it is absent or cannot be read. */
function readText(source: object, key: string): string | undefined {
  const value = readMember(source, key);

  return typeof value === 'string' ? value : undefined;
}

/** `String(value)` without letting a `toString` or `Symbol.toPrimitive` escape. */
function describeValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return UNSERIALIZABLE_TEXT;
  }
}

/**
 * Convert any Error (or error-like object, or arbitrary value) into a
 * plain, JSON-serializable object. All own properties — including the
 * non-enumerable ones that Error hides — are captured. Nested errors
 * are recursively serialized.
 *
 * **Never throws, and always terminates.** This is what is handed to `JSON.stringify` at
 * an IPC or RPC boundary, usually while already reporting a failure, so a second failure
 * raised here replaces the one being reported. Four things it survives that it did not:
 *
 * - **A cycle.** `error.self = error`, or a request object attached to an error that
 *   points back at it, is ordinary rather than pathological, and it raised a `RangeError`
 *   through the recursion. Cut with {@link TRUNCATED} where it closes.
 * - **A payload deeper than {@link MAX_RENDER_DEPTH}**, which raised the same `RangeError`
 *   without a cycle being involved at all.
 * - **A read that throws.** `message`, `stack` and every own property are ordinary
 *   properties a subclass or a `Proxy` can turn into a throwing accessor.
 * - **A revoked `Proxy`**, which `instanceof` alone refuses to walk.
 *
 * An error built in another realm - a `vm` context, an iframe, a jsdom window - is
 * recognized as an error rather than falling through to the error-like branch, which
 * serialized it without its non-enumerable `message` and `stack`.
 */
export function serializeError(
  error: unknown,
  options?: SerializeErrorOptions,
): SerializedError {
  const seen = new WeakSet<object>();

  // Defaults to the console, as every other failure channel in this library does - and it
  // matters more here than anywhere: this payload crosses a process boundary, and the
  // receiving side has no callback of its own to learn anything from.
  const report = createRenderReporter(options?.onRenderError);

  // The root is tracked before the walk starts, not left for `deepSerialize` to add when
  // it reaches it. A nested error arrives here already in `seen`, because the walk added
  // it on the way in; the root has no such caller, so `error.self = error` serialized a
  // whole second copy of the error before the cycle was noticed one level lower.
  if (error !== null && typeof error === 'object') {
    seen.add(error);
  }

  return serializeErrorInner(error, seen, 0, '<error>', report);
}

function serializeErrorInner(
  error: unknown,
  seen: WeakSet<object>,
  depth: number,
  path: string,
  report: ReportRenderFailure,
): SerializedError {
  // The shared brand check, so a cross-realm error keeps the error branch - and guarded,
  // which a bare `instanceof` is not.
  if (isErrorValue(error)) {
    const result: SerializedError = {
      name: readText(error, 'name') ?? 'Error',
      message: readText(error, 'message') ?? '',
      stack: readText(error, 'stack'),
    };

    // Own property *names*, including the non-enumerable ones an `Error` hides - which is
    // the whole point of this module and the reason `describeContainer` is not used here.
    // Guarded, because `ownKeys` is a trap.
    let keys: string[];

    try {
      keys = Object.getOwnPropertyNames(error);
    } catch (enumerationError) {
      // Nothing further can be enumerated; what was read above still stands.
      report(enumerationError, path);

      return deepSerializeRecord(result, seen, depth, path, report);
    }

    for (const key of keys) {
      if (!(key in result)) {
        // Read through the guard: a custom property is as free to throw as `message` is.
        result[key] = readMember(error, key);
      }
    }

    return deepSerializeRecord(result, seen, depth, path, report);
  }

  if (isErrorLike(error)) {
    const source = error as unknown as Record<string, unknown>;
    const copy: SerializedError = {} as SerializedError;

    // Spread replaced by a guarded per-key copy: a spread runs every own getter under no
    // guard at all, so one throwing accessor took the whole serialization down.
    const shape = describeContainer(source);

    if (shape.kind === 'object') {
      for (const key of shape.keys) {
        defineEntry(copy, key, readMember(source, key));
      }
    }

    return deepSerializeRecord(copy, seen, depth, path, report);
  }

  return { name: 'Error', message: describeValue(error) };
}

/**
 * Turn a serialized error object back into a throwable Error.
 * Useful on the receiving end of IPC / RPC when you need to re-throw.
 *
 * The extras are installed with {@link defineEntry} rather than `Object.assign`. Assign
 * uses `[[Set]]`, so a payload carrying `__proto__` **reparented the reconstructed error**
 * instead of storing that key - and this runs on data that arrived over IPC, which is
 * exactly where an attacker-controlled key would come from.
 *
 * `name` and `message` are read defensively for the same reason: the object came off the
 * wire and is not obliged to match {@link SerializedError}.
 */
export function deserializeError(obj: SerializedError): Error {
  // Checked despite the declared type: this runs on data that arrived over IPC, where the
  // annotation is a claim rather than a guarantee.
  const source: Record<string, unknown> =
    obj !== null && typeof obj === 'object' ? obj : {};

  const rawMessage = source['message'];
  const rawName = source['name'];
  const rawStack = source['stack'];

  const error = new Error(
    typeof rawMessage === 'string' ? rawMessage : describeValue(rawMessage),
  );

  if (typeof rawName === 'string') {
    error.name = rawName;
  }

  if (typeof rawStack === 'string') {
    error.stack = rawStack;
  }

  for (const key of Object.keys(source)) {
    if (key === 'name' || key === 'message' || key === 'stack') {
      continue;
    }

    defineEntry(error as unknown as Record<string, unknown>, key, source[key]);
  }

  return error;
}

// ── internal helpers ────────────────────────────────────────────────

function deepSerializeRecord(
  record: SerializedError,
  seen: WeakSet<object>,
  depth: number,
  path: string,
  report: ReportRenderFailure,
): SerializedError {
  const result: SerializedError = {} as SerializedError;

  for (const key of Object.keys(record)) {
    defineEntry(
      result,
      key,
      deepSerialize(record[key], seen, depth, `${path}.${key}`, report),
    );
  }

  return result;
}

function deepSerialize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  path: string,
  report: ReportRenderFailure,
): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  // Past the cap nothing further is walked. Without it a payload nested deeper than the
  // stack raised a `RangeError` out of a function whose whole job is to describe a
  // failure - and the cap has to be checked before the cycle test, since a deep payload
  // need not contain a cycle at all.
  if (depth >= MAX_RENDER_DEPTH) {
    return TRUNCATED;
  }

  if (seen.has(value)) {
    // A cycle is cut where it closes rather than recursing until the stack runs out.
    // `error.self = error` and a request object pointing back at the error it was
    // attached to are both ordinary, and both raised a `RangeError` here.
    return TRUNCATED;
  }

  seen.add(value);

  try {
    if (isErrorLike(value)) {
      return serializeErrorInner(value, seen, depth + 1, path, report);
    }

    const shape = describeContainer(value);

    if (shape.kind === 'unreadable') {
      report(shape.error, path);

      return UNSERIALIZABLE_KEYS;
    }

    if (shape.kind === 'array') {
      // A counted loop building a plain array, not `value.map`: `map` goes through
      // `ArraySpeciesCreate`, which calls a subclass's own constructor with a length, and
      // one that validates its arguments threw from inside the walk.
      const source = value as unknown[];
      const copy: unknown[] = [];

      for (let index = 0; index < shape.length; index++) {
        const elementPath = `${path}[${String(index)}]`;

        try {
          copy.push(
            deepSerialize(source[index], seen, depth + 1, elementPath, report),
          );
        } catch (error) {
          report(error, elementPath);
          copy.push(UNSERIALIZABLE_VALUE);
        }
      }

      return copy;
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of shape.keys) {
      let entry: unknown;

      // Per entry, so one throwing accessor marks its own key rather than discarding
      // every sibling beside it.
      try {
        entry = deepSerialize(
          source[key],
          seen,
          depth + 1,
          `${path}.${key}`,
          report,
        );
      } catch (error) {
        report(error, `${path}.${key}`);
        entry = UNSERIALIZABLE_VALUE;
      }

      defineEntry(result, key, entry);
    }

    return result;
  } finally {
    // Released on the way out, so a value referenced twice side by side is serialized
    // both times and only a genuine cycle is cut.
    seen.delete(value);
  }
}
