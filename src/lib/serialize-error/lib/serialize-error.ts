import {
  defineEntry,
  describeContainer,
} from '../../internal/container-entries';
import {
  MAX_RENDER_DEPTH,
  MAX_RENDER_LENGTH,
  TRUNCATED,
  TRUNCATED_LENGTH,
  cutAt,
} from '../../internal/render-budget';
import { snapshotMembers } from '../../internal/read-member';
import {
  describeBinaryView,
  isArrayBufferLike,
} from '../../internal/binary-view';
import { isErrorValue } from '../../to-error';
import {
  createFormatReporter,
  type FormatErrorHandler,
  type ReportFormatFailure,
} from '../../internal/format-reporter';

export type {
  FormatErrorHandler,
  FormatFailureKind,
} from '../../internal/format-reporter';

/** Options for {@link serializeError}. */
export interface SerializeErrorOptions {
  /**
   * Notified when a value could not be serialized, so an `<unserializable>` marker leaves
   * a diagnosis and not only a marker.
   *
   * With no handler set, a standalone call uses the standard host path: a cancelable
   * global `'error'` event first; `globalThis.reportError()` when event dispatch is
   * unavailable; then guarded `console.error`. A custom sink that calls this function
   * should pass a handler that terminates locally.
   *
   * This runs at an IPC or RPC boundary, usually while already reporting a failure, so the
   * marker keeps the payload intact and the cause comes here instead. The cause is
   * deliberately absent from the marker: it comes from the caller's own getter and may
   * carry the value it was hiding, and this payload is about to be sent over a wire.
   *
   * Fires at most once per call. Do not serialize or log from inside it.
   */
  onFormatError?: FormatErrorHandler;
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
 * receiving side has no `onFormatError` of its own. The marker is the only thing that
 * survives the wire, so it is the only diagnosis that reader will ever get.
 *
 * **The cause is deliberately not here**, for the same reason it is nowhere else: it comes
 * from the caller's own getter and may carry the value it was hiding - and this object is
 * about to be sent somewhere. It goes to `onFormatError` instead.
 */
const UNSERIALIZABLE_KEYS = '<unserializable: keys>';

/** A single value refused to be read - a throwing accessor, a revoked `Proxy`. */
const UNSERIALIZABLE_VALUE = '<unserializable: value>';

/**
 * Stands in for a function, which JSON has no form for at all.
 *
 * `JSON.stringify` drops the key outright, so the receiver could not tell an absent
 * property from one holding a function - and an own `toJSON` is worse than dropped, since
 * `JSON.stringify` *calls* it and a hostile one threw from inside the caller's own
 * `stringify`, downstream of everything this module guards.
 */
const UNSERIALIZABLE_FUNCTION = '<function>';

/** A value was readable but could not be turned into text. */
const UNSERIALIZABLE_TEXT = '<unserializable: text>';

/**
 * Recognize Error instances or plain error payloads with textual identity and stack.
 *
 * Guarded: property reads are trappable operations, so hostile accessors cannot escape
 * what is only a shape test. This runs on the receiving end of IPC and on error paths, so
 * asking the question must not raise a failure of its own.
 */
export function isErrorLike(
  value: unknown,
): value is { name: string; message: string; stack?: string } {
  try {
    return (
      typeof value === 'object' &&
      value !== null &&
      (isErrorValue(value) ||
        (typeof (value as Record<string, unknown>).name === 'string' &&
          typeof (value as Record<string, unknown>).message === 'string' &&
          typeof (value as Record<string, unknown>).stack === 'string'))
    );
  } catch {
    return false;
  }
}

/**
 * A member as a string, or `undefined` when it is absent.
 *
 * A member that is *present but not a string* is described rather than answered as absent.
 * `SerializedError` says these three are text, and the value is whatever the caller put
 * there: `err.message = 42` answered `undefined` here, which the `?? ''` below turned into
 * an empty message - and the own-property copy loop then skipped `message` because the key
 * was already on the result, so the `42` reached the peer nowhere at all. Described, it
 * survives as `'42'`.
 *
 * A read that *threw* is neither: it answers {@link UNSERIALIZABLE_TEXT} and reports. The
 * plain guarded read this replaces answered `undefined`, which the `?? ''` and
 * `?? 'Error'` defaults below turned into an ordinary empty member - and this payload
 * crosses a process boundary, so the receiver was handed a well-formed error whose message
 * simply was not there, with nothing on either side saying a read had refused. The
 * identical accessor one level deeper has always produced a marker *and* a report.
 */
function readText(
  source: object,
  key: string,
  path: string,
  report: ReportFormatFailure,
  budget: NodeBudget,
): string | undefined {
  let value: unknown;

  try {
    value = (source as Record<string, unknown>)[key];
  } catch (error) {
    report(error, `${path}.${key}`);

    return boundedText(UNSERIALIZABLE_TEXT, budget);
  }

  if (typeof value === 'string') {
    // Bound at the read boundary rather than first storing the caller's complete string
    // in an intermediate record. `message` and `stack` are precisely the fields most
    // likely to be large on this failure-reporting path.
    return boundedText(value, budget);
  }

  // Absent stays absent, and `null` counts as absent: `stack` is optional on
  // `SerializedError`, and inventing the text `'undefined'` or `'null'` for an error that
  // carries no stack would be worse than carrying none. `deserializeError` refuses exactly
  // this on the far side of the wire, so describing them here would put the two ends of
  // one round trip in disagreement.
  return value === undefined || value === null
    ? undefined
    : boundedText(describeValue(value, report, `${path}.${key}`), budget);
}

/**
 * An own property, with a read that throws marked rather than dropped.
 *
 * A guarded read that answers `undefined` is indistinguishable from an absent property here, and
 * worse than indistinguishable once `JSON.stringify` runs: an `undefined` value is omitted
 * from the JSON entirely, so a custom field whose accessor threw reached the peer as a
 * field the error never carried.
 */
function readOwnMember(
  source: object,
  key: string,
  path: string,
  report: ReportFormatFailure,
): unknown {
  try {
    return (source as Record<string, unknown>)[key];
  } catch (error) {
    report(error, `${path}.${key}`);

    return UNSERIALIZABLE_VALUE;
  }
}

/** `String(value)` without letting a `toString` or `Symbol.toPrimitive` escape. */
function describeValue(
  value: unknown,
  report: ReportFormatFailure = () => {},
  path = '<root>',
): string {
  try {
    return String(value);
  } catch (error) {
    report(error, path);
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
 * raised here replaces the one being reported. The walk is bounded by depth, node count,
 * and aggregate string length. Things it survives that it did not include:
 *
 * - **A cycle.** `error.self = error`, or a request object attached to an error that
 *   points back at it, is ordinary rather than pathological, and it raised a `RangeError`
 *   through the recursion. Cut with {@link TRUNCATED} where it closes.
 * - **A payload deeper than {@link MAX_RENDER_DEPTH}**, which raised the same `RangeError`
 *   without a cycle being involved at all.
 * - **A read that throws.** `message`, `stack` and every own property are ordinary
 *   properties a subclass or a `Proxy` can turn into a throwing accessor.
 * - **A revoked `Proxy`**, which `instanceof` alone refuses to walk.
 * - **An enormous string or property name**, which could otherwise make one serialized
 *   error consume an arbitrary amount of memory despite the graph bounds.
 * - **A `Date` field**, which now keeps the ISO timestamp JSON would have produced instead
 *   of becoming an empty object.
 *
 * An error built in another realm - a `vm` context, an iframe, a jsdom window - is
 * recognized as an error rather than falling through to the error-like branch, which
 * serialized it without its non-enumerable `message` and `stack`.
 */
export function serializeError(
  error: unknown,
  callerOptions?: SerializeErrorOptions,
): SerializedError {
  const seen = new WeakSet<object>();

  // Read once, guarded, the way `errorToString` and `stringifyValue` read theirs. The
  // options bag is an ordinary object to a caller and a `Proxy` with a throwing
  // `onFormatError` getter to a hostile one, and this read happens before any `try` -
  // so the one function whose contract is "never throws, always terminates" threw while
  // describing somebody else's failure. A refused read means no handler, which is the
  // documented default. See `snapshotMembers`.
  const options = snapshotMembers(callerOptions, ['onFormatError']);

  // Uses the standard host reporting path when no handler is supplied - and it matters
  // more here than anywhere: this payload crosses a process boundary, and the receiving
  // side has no callback of its own to learn anything from.
  const report = createFormatReporter('render', options.onFormatError);

  // The root is tracked before the walk starts, not left for `deepSerialize` to add when
  // it reaches it. A nested error arrives here already in `seen`, because the walk added
  // it on the way in; the root has no such caller, so `error.self = error` serialized a
  // whole second copy of the error before the cycle was noticed one level lower.
  if (error !== null && typeof error === 'object') {
    seen.add(error);
  }

  return serializeErrorInner(error, seen, 0, '<error>', report, {
    remaining: MAX_SERIALIZED_NODES,
    remainingCharacters: MAX_RENDER_LENGTH,
  });
}

function serializeErrorInner(
  error: unknown,
  seen: WeakSet<object>,
  depth: number,
  path: string,
  report: ReportFormatFailure,
  budget: NodeBudget,
): SerializedError {
  // The shared brand check, so a cross-realm error keeps the error branch - and guarded,
  // which a bare `instanceof` is not.
  if (isErrorValue(error)) {
    // Keep enough of the shared text allowance aside for causal structure. A huge
    // message is useful, but not at the cost of erasing the key that explains why the
    // error happened. `errors` receives the same treatment for AggregateError.
    // Reserve at most half: a nested error may inherit only the causal reserve,
    // and still needs room for its own identity before reserving for its children.
    const priorityKeys = priorityErrorKeys(error);
    const reservedCharacters =
      priorityKeys.length === 0
        ? 0
        : Math.min(
            CAUSAL_CHARACTER_RESERVE,
            Math.floor(budget.remainingCharacters / 2),
          );

    budget.remainingCharacters -= reservedCharacters;

    const name =
      readText(error, 'name', path, report, budget) ??
      boundedText('Error', budget);
    const message =
      readText(error, 'message', path, report, budget) ??
      boundedText('', budget);
    const stack = readText(error, 'stack', path, report, budget);

    budget.remainingCharacters += reservedCharacters;

    const result: SerializedError = {
      // Bound these immediately after the guarded read. Keeping the caller's complete
      // string in this intermediate record until `deepSerializeRecord` reaches it made
      // the final output bounded but still let a huge message/stack flow through the
      // first copy on the failure path.
      name,
      message,
      stack,
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

      return deepSerializeRecord(
        result,
        seen,
        depth,
        path,
        report,
        budget,
        true,
      );
    }

    // Insert causal members before ordinary extras so `deepSerializeRecord` spends the
    // reserved allowance on them first. Preserve the literal keys even when their value
    // must be reduced to a truncation marker.
    for (const key of priorityKeys) {
      if (!keys.includes(key)) {
        continue;
      }

      if (budget.remaining <= 0) {
        defineEntry(result, key, TRUNCATED);

        continue;
      }

      budget.remaining--;
      defineEntry(result, key, readOwnMember(error, key, path, report));
    }

    for (const key of keys) {
      // `hasOwnProperty`, not `in`, which is the check the error-like branch below already
      // makes correctly. `in` walks `Object.prototype`, so an error carrying an own
      // property named `toString`, `valueOf`, `constructor` or `hasOwnProperty` answered
      // "already have that" about a key `result` had never been given, and the property
      // was dropped with no marker and no report - at a boundary whose whole purpose is
      // to carry an error across a process intact.
      if (Object.prototype.hasOwnProperty.call(result, key)) {
        continue;
      }

      // Stopped rather than spun through, exactly as the bounded walks below stop. This
      // enumeration is the error's own, and it is as attacker-shaped as any other bag:
      // an error whose `cause` carries three hundred thousand own keys copied every one
      // of them and then serialized every one of them, synchronously, on the failure path
      // {@link MAX_SERIALIZED_NODES} exists to bound. `name`, `message` and `stack` are
      // already in `result` by construction and so are never what this stops before.
      if (budget.remaining <= 0) {
        defineEntry(result, key, TRUNCATED);

        break;
      }

      budget.remaining--;

      // Read through the guard: a custom property is as free to throw as `message` is.
      // Defined rather than assigned, now that `__proto__` reaches here: `in` used to
      // answer true for it, so a plain assignment would reparent the object being built.
      defineEntry(result, key, readOwnMember(error, key, path, report));
    }

    return deepSerializeRecord(result, seen, depth, path, report, budget, true);
  }

  if (isErrorLike(error)) {
    const source = error as unknown as Record<string, unknown>;
    const copy: SerializedError = {} as SerializedError;

    const priorityKeys: string[] = priorityErrorKeys(source);
    const reservedCharacters =
      priorityKeys.length === 0
        ? 0
        : Math.min(
            CAUSAL_CHARACTER_RESERVE,
            Math.floor(budget.remainingCharacters / 2),
          );
    budget.remainingCharacters -= reservedCharacters;

    // Put identity before extras: the serialization pass may stop at any extra key.
    copy.name =
      readText(source, 'name', path, report, budget) ??
      boundedText('Error', budget);
    copy.message =
      readText(source, 'message', path, report, budget) ??
      boundedText('', budget);
    const stack = readText(source, 'stack', path, report, budget);
    if (stack !== undefined) {
      copy.stack = stack;
    }

    budget.remainingCharacters += reservedCharacters;

    // Spread replaced by a guarded per-key copy: a spread runs every own getter under no
    // guard at all, so one throwing accessor took the whole serialization down.
    const shape = describeContainer(source);

    if (shape.kind === 'object') {
      for (const key of [
        ...priorityKeys.filter((key) => shape.keys.includes(key)),
        ...shape.keys.filter((key) => !priorityKeys.includes(key)),
      ]) {
        // Charged and stopped, exactly as the `isErrorValue` branch above charges its own
        // enumeration. This one was free: an error-*like* bag - a plain object carrying
        // `name`, `message` and `stack`, which is what arrives over IPC - copied every one
        // of its keys uncharged and then handed them all to `deepSerializeRecord`, so the
        // cap that bounds the identical shape without those three members bounded nothing
        // here. Measured at 500,003 keys emitted against a budget of 100,000.
        //
        // The three members are never what this stops before: they are skipped here and
        // read by name below, exactly as the `isErrorValue` branch skips the keys it has
        // already placed. Charged like any other key, the budget could run out *on* `name`
        // or `message` - which then held the truncation marker, or were dropped outright -
        // and a `SerializedError` without them is one `deserializeError` rebuilds as a
        // nameless `Error('')`.
        if (key === 'name' || key === 'message' || key === 'stack') {
          continue;
        }

        if (budget.remaining <= 0) {
          defineEntry(copy, key, TRUNCATED);

          break;
        }

        budget.remaining--;

        defineEntry(copy, key, readOwnMember(source, key, path, report));
      }
    } else if (shape.kind === 'unreadable') {
      // Nothing could be enumerated, and that has to show. Acted on only for `'object'`,
      // an unreadable shape - a `Proxy` whose `ownKeys` trap throws - left `copy` empty
      // and returned `{}`: not a valid `SerializedError`, nothing reported, and a peer
      // `deserializeError` rebuilding a nameless `Error('')` from it. Every other branch
      // here reports the read that refused and marks what it could not carry.
      report(shape.error, path);

      defineEntry(copy, 'serializationFailure', UNSERIALIZABLE_KEYS);
    }

    return deepSerializeRecord(copy, seen, depth, path, report, budget, true);
  }

  const result: SerializedError = {
    name: boundedText('Error', budget),
    message: boundedText(describeValue(error, report, path), budget),
  };

  return deepSerializeRecord(result, seen, depth, path, report, budget, true);
}

/**
 * Turn a serialized error object back into a throwable Error.
 * Reconstructs error-shaped causes and aggregate members with a shared 100,000
 * property/entry budget and a depth cap. Surplus extras are omitted.
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
  const seen = new WeakMap<object, Error>();
  let extrasLeft = MAX_SERIALIZED_NODES;
  const read = (source: Record<string, unknown>, key: string): unknown => {
    try {
      return source[key];
    } catch {
      return UNSERIALIZABLE_VALUE;
    }
  };
  const isArray = (value: unknown): value is unknown[] => {
    try {
      return Array.isArray(value);
    } catch {
      return false;
    }
  };
  const restoreNested = (value: unknown, depth: number): unknown => {
    // SerializedError requires name and message, but its stack is optional.
    let isSerializedError = false;
    try {
      isSerializedError =
        value !== null &&
        typeof value === 'object' &&
        typeof (value as Record<string, unknown>).name === 'string' &&
        typeof (value as Record<string, unknown>).message === 'string';
    } catch {
      // An unreadable identity does not establish a serialized error shape.
    }
    if (!isErrorLike(value) && !isSerializedError) {
      return value; // Error causes may be arbitrary values, not just errors.
    }
    if (depth >= MAX_RENDER_DEPTH || extrasLeft <= 0) {
      return TRUNCATED;
    }
    return restore(value, depth);
  };
  const restore = (value: unknown, depth: number): Error => {
    const source: Record<string, unknown> =
      value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
    const cached = seen.get(source);
    if (cached) {
      return cached;
    }
    const rawMessage = read(source, 'message');
    const rawName = read(source, 'name');
    const rawStack = read(source, 'stack');
    const error = new Error(
      typeof rawMessage === 'string'
        ? rawMessage
        : rawMessage === undefined || rawMessage === null
          ? ''
          : describeValue(rawMessage),
    );
    seen.set(source, error);
    if (typeof rawName === 'string') {
      error.name = rawName;
    }
    if (typeof rawStack === 'string' && rawStack !== '') {
      error.stack = rawStack;
    }
    let keys: string[];
    try {
      keys = Object.keys(source);
    } catch {
      return error;
    }
    for (const key of keys) {
      if (key === 'name' || key === 'message' || key === 'stack') {
        continue;
      }
      if (extrasLeft-- <= 0) {
        break;
      }
      let extra = read(source, key);
      if (key === 'cause') {
        extra = restoreNested(extra, depth + 1);
      } else if (key === 'errors' && isArray(extra)) {
        const entries = extra;
        const restored: unknown[] = [];
        const length = read(
          entries as unknown as Record<string, unknown>,
          'length',
        );
        if (typeof length === 'number') {
          for (let index = 0; index < length; index++) {
            if (extrasLeft-- <= 0) {
              restored.push(TRUNCATED);
              break;
            }
            restored.push(
              restoreNested(
                read(
                  entries as unknown as Record<string, unknown>,
                  String(index),
                ),
                depth + 1,
              ),
            );
          }
        }
        extra = restored;
      }
      defineEntry(error as unknown as Record<string, unknown>, key, extra);
    }
    return error;
  };
  return restore(obj, 0);
}

// ── internal helpers ────────────────────────────────────────────────

/**
 * How many values one serialization will visit before it stops.
 *
 * The depth cap bounds how *deep* the walk goes and the cycle cut bounds loops; neither
 * bounds how much the walk *emits*, and those are three different limits. `seen` is
 * released as the walk leaves a node - deliberately, so a value referenced twice side by
 * side is serialized both times rather than the second being called circular - which means
 * a shared subtree is serialized once per reference, and that is exponential in depth
 * rather than linear in size. A diamond of `{ l: child, r: child }` twenty levels deep
 * produced 22 MB in 303 ms and ran out of memory at about thirty. Nothing about that
 * payload is pathological: reusing one object under two keys is ordinary.
 *
 * The array branch has the same gap from the other direction - it iterates the caller's
 * own `length`, which `Array.isArray` does not make honest and which a plain
 * `new Array(20_000_000)` makes expensive without any proxy at all.
 *
 * This is the failure-reporting path, and it promises to terminate and never to throw;
 * an `OOM` on the way to describing an error is the worst possible way to break that.
 * A hundred thousand nodes is far past any error payload worth sending across a process
 * boundary and leaves the cap invisible to every serialization that is not running away.
 */
const MAX_SERIALIZED_NODES = 100_000;

/** Text retained for `cause` and AggregateError `errors` after a huge diagnostic field. */
const CAUSAL_CHARACTER_RESERVE = 16_384;

/** Values left to visit in one serialization. See {@link MAX_SERIALIZED_NODES}. */
interface NodeBudget {
  remaining: number;
  remainingCharacters: number;
}

/** Own causal slots worth preserving ahead of arbitrary extra fields. */
function priorityErrorKeys(error: object): Array<'cause' | 'errors'> {
  const keys: Array<'cause' | 'errors'> = [];

  try {
    if (Object.prototype.hasOwnProperty.call(error, 'cause')) {
      keys.push('cause');
    }

    if (Object.prototype.hasOwnProperty.call(error, 'errors')) {
      keys.push('errors');
    }
  } catch {
    // The later guarded enumeration reports hostile proxy traps. Reservation is an
    // optimization for useful output, never a reason serialization itself may throw.
  }

  return keys;
}

/** Copy text into the shared serialization allowance, marking where it was cut. */
function boundedText(value: string, budget: NodeBudget): string {
  if (value.length <= budget.remainingCharacters) {
    budget.remainingCharacters -= value.length;

    return value;
  }

  const keptLength = Math.max(
    0,
    budget.remainingCharacters - TRUNCATED_LENGTH.length,
  );
  const kept = cutAt(value, keptLength);

  budget.remainingCharacters = 0;

  return `${kept}${TRUNCATED_LENGTH}`;
}

/** A Date's JSON representation, guarded and branded across realms. */
function serializeDate(value: object): string | null | undefined {
  try {
    // Date.prototype methods validate the receiver's internal [[DateValue]] slot. Unlike
    // `instanceof`, that brand check works for Dates created in a vm or iframe and cannot
    // be forged with Symbol.toStringTag or a borrowed prototype.
    const time = Date.prototype.getTime.call(value);

    return Number.isFinite(time)
      ? Date.prototype.toISOString.call(value)
      : null;
  } catch {
    return undefined;
  }
}

function deepSerializeRecord(
  record: SerializedError,
  seen: WeakSet<object>,
  depth: number,
  path: string,
  report: ReportFormatFailure,
  budget: NodeBudget,
  useBoundedTextValues = false,
): SerializedError {
  const result: SerializedError = {} as SerializedError;

  for (const key of Object.keys(record)) {
    const value = record[key];

    // These fixed, trusted keys have already had their values charged. Copying them
    // directly both avoids charging the same text twice and ensures a message that uses
    // the final allowance is still emitted instead of being replaced by a truncated key.
    if (
      useBoundedTextValues &&
      (key === 'name' ||
        key === 'message' ||
        key === 'stack' ||
        key === 'cause' ||
        key === 'errors')
    ) {
      if (key === 'cause' || key === 'errors') {
        defineEntry(
          result,
          key,
          budget.remainingCharacters <= 0
            ? TRUNCATED_LENGTH
            : deepSerialize(
                value,
                seen,
                depth,
                `${path}.${key}`,
                report,
                budget,
              ),
        );

        continue;
      }

      defineEntry(result, key, value);

      continue;
    }

    const outputKey = boundedText(key, budget);

    if (outputKey !== key) {
      defineEntry(result, outputKey, TRUNCATED_LENGTH);

      break;
    }

    defineEntry(
      result,
      outputKey,
      deepSerialize(value, seen, depth, `${path}.${key}`, report, budget),
    );
  }

  return result;
}

/**
 * Coerce a leaf `JSON.stringify` cannot carry, or hand it back untouched.
 *
 * This module's whole promise is a payload that survives `JSON.stringify`, and three
 * primitives broke it - one loudly, two quietly:
 *
 * - **A `BigInt` throws.** `JSON.stringify({ n: 1n })` raises a `TypeError`, so an error
 *   carrying one - an id, a byte count, a database key - took down the `stringify` at the
 *   IPC boundary this exists to cross, while already reporting a failure.
 * - **A function or a symbol value is dropped**, key and all, with nothing to say it was
 *   there. A function leaf is worse than absent: `JSON.stringify` *invokes* an own
 *   `toJSON`, so an object carrying a hostile one - copied verbatim, method and all -
 *   threw from inside the caller's `stringify` rather than from anything this module runs.
 *
 * Rendered as text in all three cases. The markers follow *this module's* vocabulary -
 * angle brackets, like the `<unserializable: …>` the docs already teach - rather than
 * `errorToString`'s `[Function]`, and the difference is the audience: that output is read
 * by a human, and this payload is parsed by a receiver who has no way to ask what a value
 * means. `<function>` reads as the library talking; `[Function]` reads as something a
 * caller might have stored. Neither is proof - a caller whose property really holds the
 * text `<function>` is indistinguishable, exactly as it already is for
 * `<unserializable: value>` - but one is recognizable and the other is a guess.
 *
 * A `bigint` is the exception, and gets its digits rather than a marker: they are the
 * *value*, and a receiver can parse them back. Its type is what does not survive - a
 * `bigint` and a string of the same digits arrive identical - which is the same trade
 * `stringifyTemplateValue` makes for the same leaf.
 *
 * `NaN` and the infinities are deliberately left alone: `JSON.stringify` writes `null` for
 * them rather than throwing, which is the conventional stand-in and costs nothing here.
 * `undefined` is left alone too - `JSON.stringify` drops the key, and an absent field is
 * how this module already represents an absent `message`.
 */
function coerceUnJSONableLeaf(value: unknown): unknown {
  switch (typeof value) {
    case 'bigint':
      return String(value);
    case 'function':
      return UNSERIALIZABLE_FUNCTION;
    case 'symbol':
      // `Symbol(description)`, wrapped so it reads as a marker: bare, it is exactly what
      // `String(symbol)` gives, which is indistinguishable from a caller's own text.
      return `<symbol: ${describeValue(value)}>`;
    default:
      return value;
  }
}

function deepSerialize(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
  path: string,
  report: ReportFormatFailure,
  budget: NodeBudget,
): unknown {
  if (typeof value === 'string') {
    return boundedText(value, budget);
  }

  if (value === null || typeof value !== 'object') {
    const leaf = coerceUnJSONableLeaf(value);
    return typeof leaf === 'string' ? boundedText(leaf, budget) : leaf;
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

  // Charged per value entered, which is the only count that bounds what the walk emits:
  // depth bounds the stack and `seen` bounds loops, and a shared subtree is neither deep
  // nor circular. See {@link MAX_SERIALIZED_NODES}.
  if (budget.remaining <= 0) {
    return TRUNCATED;
  }

  budget.remaining--;

  seen.add(value);

  try {
    const serializedDate = serializeDate(value);

    if (serializedDate !== undefined) {
      return serializedDate === null
        ? null
        : boundedText(serializedDate, budget);
    }

    if (isErrorLike(value)) {
      return serializeErrorInner(value, seen, depth + 1, path, report, budget);
    }

    // A view over binary data is one leaf, not one entry per byte - one leaf for the same
    // reason `errorToString` gives one, though spelled with the kind and size rather than
    // with its generic marker. `Array.isArray` is false for a
    // `Buffer`, so it fell through to the object branch and `Object.keys` enumerated its
    // indexes: an ordinary `Buffer` attached to an error became a JSON object with one key
    // per byte, exhausting the node budget on a 100 KB buffer and spending hundreds of
    // milliseconds in `Object.keys` on a 2 MB one - inside the walk that exists to
    // describe a failure cheaply on the IPC path.
    // The backing store as well as a view over one. `Object.keys(new ArrayBuffer(n))` is
    // empty, so a buffer crossed the wire as `{}` - indistinguishable from an empty object
    // and silent about its size.
    if (ArrayBuffer.isView(value) || isArrayBufferLike(value)) {
      return boundedText(describeBinaryView(value), budget);
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
        // `shape.length` is the caller's own `length` - writable, and answerable by a
        // `Proxy` trap over a value `Array.isArray` still calls an array. Stopped rather
        // than spun through, and marked so a truncated payload never looks complete.
        if (budget.remaining <= 0) {
          copy.push(TRUNCATED);

          break;
        }

        // Charged per *slot*, not only per container entered. A primitive costs nothing to
        // walk and so charges nothing on the way in, which left the one shape this branch
        // most needed to bound unbounded: `new Array(20_000_000)` is entirely holes, every
        // read answers `undefined`, and the budget was still untouched after twenty million
        // of them.
        budget.remaining--;

        const elementPath = `${path}[${String(index)}]`;

        try {
          copy.push(
            deepSerialize(
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
          copy.push(UNSERIALIZABLE_VALUE);
        }
      }

      return copy;
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of shape.keys) {
      // Stopped rather than spun through, exactly as the array branch above stops: the
      // budget is what bounds the work, and `continue` left it bounding nothing. A nested
      // bag of two million keys - `err.payload`, say - spent the budget after the first
      // hundred thousand and then performed one `defineProperty` per remaining key anyway,
      // handing `JSON.stringify` a two-million-entry object: the synchronous stall the cap
      // exists to prevent. One marker, so a truncated payload never looks complete.
      //
      // Bounds this walk, not the error's own top-level enumeration above, which is
      // deliberately uncharged: `name`, `message` and `stack` come from it, so stopping it
      // early could hand back a `SerializedError` with no name at all.
      if (budget.remaining <= 0) {
        defineEntry(result, key, TRUNCATED);

        break;
      }

      const outputKey = boundedText(key, budget);

      if (outputKey !== key) {
        defineEntry(result, outputKey, TRUNCATED_LENGTH);

        break;
      }

      // Per key, for the reason the array branch charges per slot: an object of a hundred
      // thousand primitive values costs nothing on the way in and is exactly the size this
      // is meant to bound.
      budget.remaining--;

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
          budget,
        );
      } catch (error) {
        report(error, `${path}.${key}`);
        entry = UNSERIALIZABLE_VALUE;
      }

      defineEntry(result, outputKey, entry);
    }

    return result;
  } finally {
    // Released on the way out, so a value referenced twice side by side is serialized
    // both times and only a genuine cycle is cut.
    seen.delete(value);
  }
}
