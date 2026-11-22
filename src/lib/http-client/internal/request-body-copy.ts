import { isRequestBodyBytes, unsupportedRequestBodyMessage } from '../utils';
import { isPlainRecord } from './plain-record';
import { isBunRuntime } from '../../internal/is-bun-runtime';
import { filePartNameToSend, formEntries, isFormData } from './form-entries';
import { plainBytesView } from '../../internal/binary-view';

/**
 * What the client knows of a JSON body copy it made (see `copyRequestBody`): the text it
 * serializes to, its own `toJSON` wrapper's included, or `undefined` for one that
 * serializes to nothing; and, once something has read it, the frozen data that text
 * parses to (see `readJSONBodyData`). A copy no interceptor or `bodyContainsKeys` filter
 * reads is never parsed at all.
 */
interface CopyRecord {
  readonly text: string | undefined;
  data?: object;
}

/**
 * The record of each JSON body copy, and of the frozen data read from one: both stand for
 * the same text, and neither can be changed, so a body handed back as either is sent as
 * that text, never serialized again.
 */
const recordByCopy = new WeakMap<object, CopyRecord>();

/**
 * A request body as a value the client owns, which no caller holds: taken when a body is
 * handed over - to a builder's body setter, or as an interceptor's result - so a change
 * the caller makes afterwards reaches nothing the request sends or reports.
 *
 * - A JSON body (a plain object or an array) is the text it serializes to: serialized
 *   once, by `JSON.stringify` - so every nested `toJSON` is applied and what JSON reads
 *   from prototypes is honored, where a structural copy would lose them. The copy is a
 *   frozen empty object or array, the shape its text has, sent as that text; read, it is
 *   the frozen data the text parses to (see `readJSONBodyData`). A `Date` is its ISO
 *   string, a class instance a plain object, an `undefined` member dropped. A top-level
 *   `toJSON` that answers something other than an object or an array - `null`, a string,
 *   a number, nothing - reads back as that value, which is no JSON body: a string is sent
 *   as text, `null` as no body at all, and a number is refused. Such a copy is a frozen
 *   plain object whose own `toJSON` answers it, so it is still a JSON body and serializes
 *   to exactly the text the caller's does. A copy, or data read from one, is its own copy.
 * - Bytes are copied, into this realm; a `Buffer` as a `Buffer` (see `copyBytes`).
 * - Form data - told by `FormData`'s own methods (see `isFormData`) - is a new form with
 *   the same entries; a `Blob` or `File` entry is kept as it is, being
 *   immutable.
 * - A string, `null` or `undefined` cannot be changed in place and is returned as it is.
 *
 * Each kind is told once, and the value read as that kind, so a `Proxy` whose prototype
 * answers differently on a second look cannot be passed on uncopied. Throws on a body of
 * any other type - a `Proxy` over a form among them - and on a read that throws: a getter
 * or a `toJSON`, a `BigInt` or a circular reference in a JSON body.
 */
export function copyRequestBody(body: unknown): unknown {
  if (body === undefined || body === null || typeof body === 'string') {
    return body;
  }

  if (isRequestBodyBytes(body)) {
    return copyBytes(body);
  }

  if (isFormData(body)) {
    return copyFormData(body);
  }

  if (Array.isArray(body) || isPlainRecord(body)) {
    if (recordByCopy.has(body)) {
      return body;
    }

    const serialized: unknown = JSON.stringify(body);

    // A top-level `toJSON` that answers `undefined` serializes to nothing.
    if (typeof serialized !== 'string') {
      return recordedCopy({ toJSON: () => undefined }, undefined);
    }

    // `JSON.stringify` writes no whitespace before a value, so the first character tells
    // an object or an array from every other value.
    const first = serialized[0];
    if (first === '{' || first === '[') {
      const copy = recordedCopy(first === '[' ? [] : {}, serialized);
      unreadCopies.add(copy);
      return copy;
    }

    const value: unknown = JSON.parse(serialized);
    return recordedCopy({ toJSON: () => value }, serialized);
  }

  // Refused as `params()` refuses a query it cannot copy: by type, when it is handed over.
  throw new TypeError(unsupportedRequestBodyMessage(body));
}

/** `copy`, frozen and recorded as the JSON body copy that serializes to `text`. */
function recordedCopy(copy: object, text: string | undefined): object {
  recordByCopy.set(Object.freeze(copy), { text });
  return copy;
}

/**
 * The JSON text a JSON body copy serializes to - a copy `copyRequestBody` returned, or the
 * data read from one (see `readJSONBodyData`) - so it is sent, or copied again, without
 * being serialized a second time; `undefined` for any other value.
 */
export function copiedJSONText(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null
    ? recordByCopy.get(body)?.text
    : undefined;
}

/**
 * Whether `body` is a JSON body copy that serializes to nothing (a top-level `toJSON` that
 * answers `undefined`). Read from the copy's own record (see `recordByCopy`) rather than by
 * serializing, so a value an interceptor returned - whose `toJSON` may answer differently
 * the next time - is never asked.
 */
export function isCopySerializingToNothing(body: unknown): boolean {
  return typeof body === 'object' && body !== null && isRecordedAsNothing(body);
}

/** Whether `recordByCopy` records `body` as a copy that serializes to nothing. */
function isRecordedAsNothing(body: object): boolean {
  const record = recordByCopy.get(body);
  return record !== undefined && record.text === undefined;
}

/**
 * Whether a JSON body - a plain object or an array - serializes to nothing, as
 * `JSON.stringify(body) === undefined` would answer, without serializing it: a copy's own
 * record (see `recordByCopy`), or for any other value its top-level `toJSON`, own or
 * inherited, read once and called once with the key `''`, as `JSON.stringify` calls it.
 * Only an answer `JSON.stringify` writes nothing for - `undefined`, a symbol or a function
 * - serializes to nothing; a body with no `toJSON`, or one answering anything else, is
 * serialized to text or throws, and is not read further. Throws as reading or calling its
 * `toJSON` throws.
 */
export function serializesToNothing(body: object): boolean {
  if (recordByCopy.has(body)) {
    return isRecordedAsNothing(body);
  }

  const toJSON: unknown = (body as { toJSON?: unknown }).toJSON;
  if (typeof toJSON !== 'function') {
    return false;
  }

  const value: unknown = Reflect.apply(toJSON, body, ['']);
  return (
    typeof value === 'undefined' ||
    typeof value === 'symbol' ||
    typeof value === 'function'
  );
}

/**
 * The JSON body copies `copyRequestBody` returned as an empty object or array, standing
 * for their text: their data is read only when asked for (see `readJSONBodyData`).
 */
const unreadCopies = new WeakSet<object>();

/** Whether `body` is a JSON body copy whose data is read only when asked for. */
export function isUnreadJSONBodyCopy(body: unknown): body is object {
  return typeof body === 'object' && body !== null && unreadCopies.has(body);
}

/**
 * The data a JSON body holds, as an interceptor or a `bodyContainsKeys` filter reads it:
 * for a copy `copyRequestBody` returned empty, the data its text parses to, deep-frozen -
 * parsed once, the first time it is asked for, and kept with the copy for every later
 * read - and recorded as standing for the same text, so a body handed back as it is sent
 * as that text (see `copiedJSONText`). A number `JSON.rawJSON` wrote past a double's
 * precision is read as that `JSON.rawJSON` value (see `exactJSONData`). Any other body as
 * it is.
 */
export function readJSONBodyData(body: unknown): unknown {
  if (!isUnreadJSONBodyCopy(body)) {
    return body;
  }

  const record = recordByCopy.get(body) as CopyRecord;
  if (record.data === undefined) {
    const data = deepFreeze(exactJSONData(record.text as string));
    recordByCopy.set(data, record);
    record.data = data;
  }

  return record.data;
}

/**
 * The data `text` - JSON a copy serialized to - parses to: its plain parse, unless that no
 * longer serializes to `text`, as a number `JSON.rawJSON` wrote past a double's precision
 * (`9007199254740993`) parses to the nearest double. Then each such number is kept as the
 * `JSON.rawJSON` value it was, so a body an interceptor builds from the data
 * (`{ ...request.body, token }`) still sends it as written. Only a number can read back as
 * other data: `JSON.stringify` writes every other value as its plain parse writes it.
 */
function exactJSONData(text: string): object {
  const parsed = JSON.parse(text) as object;
  const { rawJSON } = JSON as unknown as {
    rawJSON?: (source: string) => unknown;
  };
  if (rawJSON === undefined || JSON.stringify(parsed) === text) {
    return parsed;
  }

  return JSON.parse(
    text,
    (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' &&
      context?.source !== undefined &&
      context.source !== String(value)
        ? rawJSON(context.source)
        : value,
  ) as object;
}

/**
 * `value` - data `JSON.parse` made, so plain objects, arrays and primitives alone - with
 * every object in it frozen, walked with a stack of its own rather than by recursion, so
 * data nested as deep as `JSON.stringify` can write is frozen whole.
 */
function deepFreeze<T extends object>(value: T): T {
  const pending: object[] = [value];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    Object.freeze(next);
    for (const key of Object.keys(next)) {
      const member: unknown = (next as Record<string, unknown>)[key];
      if (typeof member === 'object' && member !== null) {
        pending.push(member);
      }
    }
  }

  return value;
}

/**
 * Bytes or form data as a copy of the client's own - bytes read through their internal
 * slots, so another realm's are copied into this one's - and any other value as it is.
 */
export function cloneBodyValue(body: unknown): unknown {
  if (isFormData(body)) {
    return copyFormData(body);
  } else if (isRequestBodyBytes(body)) {
    return copyBytes(body);
  }

  return body;
}

function copyFormData(form: FormData): FormData {
  const cloned = new FormData();

  for (const [key, value] of formEntries(form)) {
    // Under the name it is sent by, on Bun as on NodeAdapter: Bun's own encoding of a file
    // backed by a path, appended under none, would send the path.
    if (!isBunRuntime || typeof value === 'string') {
      cloned.append(key, value);
      continue;
    }

    const name: unknown = (value as File).name;
    const nameToSend = filePartNameToSend(name);
    // A part Bun reports with no name - a `Blob`, or a `File` named `''` - is named `blob`,
    // as `FormData` names a nameless `Blob` and NodeAdapter sends it; appended as it is,
    // Bun's `fetch` would send it as `filename=""`.
    const filename = typeof nameToSend === 'string' ? nameToSend : 'blob';

    if (filename === name) {
      cloned.append(key, value);
    } else {
      cloned.append(key, value as unknown as File, filename);
    }
  }

  return cloned;
}

/**
 * Whether `left` and `right` hold the same bytes, each read through the intrinsic
 * getters (see `plainBytesView`), so an own `byteLength` or `buffer` on either is not
 * believed. One over a detached buffer holds none that can be read, and is not the same.
 * Compares without copying either.
 */
export function holdsSameBytes(left: Uint8Array, right: Uint8Array): boolean {
  let leftBytes: Uint8Array;
  let rightBytes: Uint8Array;
  try {
    leftBytes = plainBytesView(left);
    rightBytes = plainBytesView(right);
  } catch {
    return false;
  }

  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }

  // Both sides as a `Buffer`, as a polyfill's `equals` - the `buffer` package a browser
  // bundle carries - takes nothing else; one that still refuses them is compared by index.
  if (typeof Buffer !== 'undefined') {
    try {
      return Buffer.from(
        leftBytes.buffer,
        leftBytes.byteOffset,
        leftBytes.byteLength,
      ).equals(
        Buffer.from(
          rightBytes.buffer,
          rightBytes.byteOffset,
          rightBytes.byteLength,
        ),
      );
    } catch {
      // Compared by index below.
    }
  }

  let index = 0;
  for (const byte of leftBytes) {
    if (byte !== rightBytes[index++]) {
      return false;
    }
  }

  return true;
}

/**
 * Bytes copied into this realm, read through their internal slots so another realm's are
 * copied too. This realm's `Buffer` stays a `Buffer` - a view over the copy, so nothing of
 * the caller's, not its `valueOf` or `length`, is consulted - so an interceptor's
 * `toString('base64')` reads the bytes; any other `Uint8Array`, another realm's `Buffer`
 * or a subclass among them, is a plain `Uint8Array`. A `Buffer` is told by its prototype
 * being `Buffer.prototype` itself, not by `Buffer.isBuffer`, whose `instanceof` walks a
 * prototype chain the caller may have put a `Proxy` in (and a polyfill's reads a
 * property). Where there is no `Buffer`, as in a browser, every copy is a plain one.
 */
function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);

  if (
    typeof Buffer !== 'undefined' &&
    Object.getPrototypeOf(bytes) === Buffer.prototype
  ) {
    return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
  }

  return copy;
}
