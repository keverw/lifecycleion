import { isRequestBodyBytes, unsupportedRequestBodyMessage } from '../utils';
import { isPlainRecord } from './plain-record';
import { isBunRuntime } from '../../internal/is-bun-runtime';
import { filePartNameToSend, formEntries, isFormData } from './form-entries';
import { defineEntry } from '../../internal/define-entry';
import { plainBytesView } from '../../internal/binary-view';

/**
 * What the client knows of a JSON body copy it made (see `copyRequestBody`): the text it
 * serializes to, its own `toJSON` wrapper's included, or `undefined` for one that
 * serializes to nothing; and whether it has been filled from that text. A copy not yet
 * filled is an empty object or array of the shape its text has (see `releaseRequestBody`),
 * so a copy that is only ever sent - no interceptor reads it (see `handedRequest` in
 * interceptors.ts) and no `bodyContainsKeys` filter reads it - is never parsed back at
 * all.
 */
type CopyRecord =
  | { readonly text: string; readonly isFilled: false }
  | { readonly text: string | undefined; readonly isFilled: true };

/**
 * The record of each JSON body copy caller code has not been given. One is forgotten as
 * caller code is given it, which may keep it and change it in place - an interceptor that
 * reads its request's `body` (see `handedRequest` in interceptors.ts), or a builder's own
 * send function (see `releaseRequestBody`). Nothing else gives a request's body to caller
 * code: an attempt's observers are handed their own, parsed back from the text sent.
 */
const recordByCopy = new WeakMap<object, CopyRecord>();

/**
 * A request body as a value the client owns, which no caller holds: taken when a body is
 * handed over - to a builder's body setter, or as an interceptor's result - so a change
 * the caller makes afterwards reaches nothing the request sends or reports.
 *
 * - A JSON body (a plain object or an array) is the data it serializes to, read back:
 *   serialized once, by `JSON.stringify` - so every nested `toJSON` is applied and what
 *   JSON reads from prototypes is honored, where a structural copy would lose them - and
 *   parsed back when its contents are first read (see `releaseRequestBody`). Until then it
 *   is an empty object or array, the shape its text has, sent as that text. A `Date` is
 *   its ISO string, a class instance a plain object, an `undefined` member dropped. A
 *   top-level `toJSON` that answers something other than an object or an array - `null`,
 *   a string, a number, nothing - reads back as that value, which is no JSON body: a
 *   string is sent as text, `null` as no body at all, and a number is refused. Such a
 *   copy is wrapped as a plain object whose own `toJSON` answers it, so it is still a
 *   JSON body and serializes to exactly the text the caller's does.
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
    // A copy of a copy is read back from the text it was read from.
    const text = jsonTextOf(body);

    // A top-level `toJSON` that answers `undefined` serializes to nothing.
    if (text === undefined) {
      const copy = { toJSON: () => undefined };
      recordByCopy.set(copy, { text: undefined, isFilled: true });
      return copy;
    }

    // `JSON.stringify` writes no whitespace before a value, so the first character tells
    // an object or an array from every other value.
    const first = text[0];
    if (first === '{' || first === '[') {
      const copy = first === '[' ? [] : {};
      recordByCopy.set(copy, { text, isFilled: false });
      return copy;
    }

    const value: unknown = JSON.parse(text);
    const copy = { toJSON: () => value };
    recordByCopy.set(copy, { text, isFilled: true });
    return copy;
  }

  // Refused as `params()` refuses a query it cannot copy: by type, when it is handed over.
  throw new TypeError(unsupportedRequestBodyMessage(body));
}

/**
 * The JSON text a JSON body copy serializes to, when it is one `copyRequestBody` returned
 * that caller code has not been given (see `recordByCopy`), so it is sent - or copied
 * again - without being serialized a second time; `undefined` for any other value.
 */
export function copiedJSONText(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null
    ? recordByCopy.get(body)?.text
    : undefined;
}

/**
 * Whether `body` is a JSON body copy, not yet given to caller code, that serializes to
 * nothing (a top-level `toJSON` that answers `undefined`). Read from the copy's own record
 * (see `recordByCopy`) rather than by serializing, so a value an interceptor returned -
 * whose `toJSON` may answer differently the next time - is never asked.
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
 * The text a JSON body - a plain object or an array - serializes to, or `undefined` when
 * it serializes to nothing (a top-level `toJSON` that answers `undefined`): a copy's own
 * (see `recordByCopy`), or serialized now for any other value. Throws as
 * `JSON.stringify` throws on it.
 */
function jsonTextOf(body: object): string | undefined {
  const record = recordByCopy.get(body);
  if (record !== undefined) {
    return record.text;
  }

  const text: unknown = JSON.stringify(body);
  return typeof text === 'string' ? text : undefined;
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
 * The data a JSON body - a plain object - holds, as an interceptor's `bodyContainsKeys`
 * filter reads it: for a copy `copyRequestBody` returned empty, its text parsed, the data
 * kept in `parsedByCopy` - one phase's (see `InterceptorChainOptions.parsedContents`) - so
 * a body is parsed once however often the phase reads it, and the data is let go with the
 * phase; any other body as it is.
 */
export function readRequestBodyContents(
  body: Record<string, unknown>,
  parsedByCopy: Map<unknown, object>,
): Record<string, unknown> {
  const record = recordByCopy.get(body);
  if (record === undefined || record.isFilled) {
    return body;
  }

  const kept = parsedByCopy.get(body);
  if (kept !== undefined) {
    return kept as Record<string, unknown>;
  }

  const parsed = JSON.parse(record.text) as Record<string, unknown>;
  parsedByCopy.set(body, parsed);
  return parsed;
}

/**
 * Fill a JSON body copy `copyRequestBody` returned empty with the data its text parses
 * to - or `parsed`, the data a filter read it as (see `readRequestBodyContents`) - in
 * place, so it is the same object, the one the builder holds, as it is handed to caller
 * code (see `releaseRequestBody`). Parsed before the copy is touched, so a parse that
 * throws leaves it empty and its record as it was. Each member is defined as the parsed
 * data's own, so a `__proto__` key is a member, as `JSON.parse` makes it, not the copy's
 * prototype.
 */
function fillRequestBody(
  body: object,
  record: Extract<CopyRecord, { isFilled: false }>,
  parsed: object = JSON.parse(record.text) as object,
): void {
  if (Array.isArray(body)) {
    for (const member of parsed as unknown[]) {
      body.push(member);
    }
  } else {
    for (const key of Object.keys(parsed)) {
      defineEntry(
        body as Record<string, unknown>,
        key,
        (parsed as Record<string, unknown>)[key],
      );
    }
  }
}

/**
 * Whether `body` is a JSON body copy `copyRequestBody` returned empty that has not been
 * filled: one sent as its text, which nothing has read yet.
 */
export function isUnfilledRequestBody(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    recordByCopy.get(body)?.isFilled === false
  );
}

/**
 * Called as a request's body is handed to caller code - an interceptor that reads it, or a
 * builder's own send function - which may keep it and change it in place: a copy still
 * empty is filled (see `fillRequestBody`), and since its text no longer says what it
 * serializes to, its record is forgotten, and the copy is serialized from then on as any
 * other value is. `parsed`, the data a filter read the copy as, fills it in place of a
 * parse: handed over by one copy at most, so no two share nested objects. A fill that
 * throws leaves the record, and the copy still sent as its text. Any other value is left
 * as it is.
 */
export function releaseRequestBody(body: unknown, parsed?: object): void {
  if (typeof body !== 'object' || body === null) {
    return;
  }

  const record = recordByCopy.get(body);
  if (record === undefined) {
    return;
  }

  if (!record.isFilled) {
    fillRequestBody(body, record, parsed);
  }

  recordByCopy.delete(body);
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
