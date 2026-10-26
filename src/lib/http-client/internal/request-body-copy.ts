import { isPlainJSONBodyObject, isRequestBodyBytes } from '../utils';

/**
 * The text each JSON body copy was read back from - exactly the text it serializes to, its
 * own `toJSON` wrapper's included, or `undefined` for one that serializes to nothing - by
 * the copy. Only a copy no caller holds is here: one is forgotten as it is handed to an
 * interceptor (see `releaseRequestBody`), and nothing else hands a request's body to
 * caller code - an attempt's observers are handed their own, parsed back from the text
 * sent.
 */
const jsonTextByCopy = new WeakMap<object, string | undefined>();

/**
 * A request body as a value the client owns, which no caller holds: taken when a body is
 * handed over - to a builder's body setter, or as an interceptor's result - so a change
 * the caller makes afterwards reaches nothing the request sends or reports.
 *
 * - A JSON body (a plain object or an array) is the data it serializes to, read back:
 *   serialized once, by `JSON.stringify` - so every nested `toJSON` is applied and what
 *   JSON reads from prototypes is honored, where a structural copy would lose them - and
 *   parsed back. A `Date` is its ISO string, a class instance a plain object, an
 *   `undefined` member dropped. A top-level `toJSON` that answers something other than an
 *   object or an array - `null`, a string, a number, nothing - reads back as that value,
 *   which is no JSON body: a string is sent as text, `null` as no body at all, and a
 *   number is refused. Such a copy is wrapped as a plain object whose own `toJSON`
 *   answers it, so it is still a JSON body and serializes to exactly the text the
 *   caller's does.
 * - Bytes are copied, into this realm (see `cloneBodyValue`).
 * - Form data is a new form with the same entries; a `Blob` or `File` entry is kept as
 *   it is, being immutable.
 * - A string, `null` or `undefined` cannot be changed in place and is returned as it is.
 *
 * Each kind is told once, and the value read as that kind, so a `Proxy` whose prototype
 * answers differently on a second look cannot be passed on uncopied. Throws on a body of
 * any other type, and on a read that throws - a getter or a `toJSON`, a `BigInt` or a
 * circular reference in a JSON body, a `Proxy` over a form.
 */
export function copyRequestBody(body: unknown): unknown {
  if (body === undefined || body === null || typeof body === 'string') {
    return body;
  }

  if (isRequestBodyBytes(body)) {
    return copyBytes(body);
  }

  if (body instanceof FormData) {
    return copyFormData(body);
  }

  if (Array.isArray(body) || isPlainJSONBodyObject(body)) {
    // A copy of a copy is read back from the text it was read from.
    const text = jsonTextOf(body);

    // A top-level `toJSON` that answers `undefined` serializes to nothing.
    if (text === undefined) {
      const copy = { toJSON: () => undefined };
      jsonTextByCopy.set(copy, undefined);
      return copy;
    }

    const parsed: unknown = JSON.parse(text);
    const copy: object =
      Array.isArray(parsed) || isPlainJSONBodyObject(parsed)
        ? parsed
        : { toJSON: () => parsed };

    jsonTextByCopy.set(copy, text);
    return copy;
  }

  // Refused as `params()` refuses a query it cannot copy: by type, when it is handed over.
  throw new TypeError(
    'Unsupported request body type. Supported types: string, Uint8Array, FormData, plain object, array, null, and undefined.',
  );
}

/**
 * The JSON text a JSON body copy serializes to, when it is one `copyRequestBody` returned
 * that no interceptor has been handed (see `jsonTextByCopy`), so it is sent - or copied
 * again - without being serialized a second time; `undefined` for any other value.
 */
export function copiedJSONText(body: unknown): string | undefined {
  return typeof body === 'object' && body !== null
    ? jsonTextByCopy.get(body)
    : undefined;
}

/**
 * Whether `body` is a JSON body copy, not yet handed to an interceptor, that serializes to
 * nothing (a top-level `toJSON` that answers `undefined`). Read from the copy's own record
 * (see `jsonTextByCopy`) rather than by serializing, so a value an interceptor returned -
 * whose `toJSON` may answer differently the next time - is never asked.
 */
export function isCopySerializingToNothing(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    jsonTextByCopy.has(body) &&
    jsonTextByCopy.get(body) === undefined
  );
}

/**
 * The text a JSON body - a plain object or an array - serializes to, or `undefined` when
 * it serializes to nothing (a top-level `toJSON` that answers `undefined`): a copy's own
 * (see `jsonTextByCopy`), or serialized now for any other value. Throws as
 * `JSON.stringify` throws on it.
 */
function jsonTextOf(body: object): string | undefined {
  if (jsonTextByCopy.has(body)) {
    return jsonTextByCopy.get(body);
  }

  const text: unknown = JSON.stringify(body);
  return typeof text === 'string' ? text : undefined;
}

/**
 * Whether a JSON body - a plain object or an array - serializes to nothing, as
 * `JSON.stringify(body) === undefined` would answer, without serializing it: a copy's own
 * record (see `jsonTextByCopy`), or for any other value its top-level `toJSON`, own or
 * inherited, read once and called once with the key `''`, as `JSON.stringify` calls it.
 * Only an answer `JSON.stringify` writes nothing for - `undefined`, a symbol or a function
 * - serializes to nothing; a body with no `toJSON`, or one answering anything else, is
 * serialized to text or throws, and is not read further. Throws as reading or calling its
 * `toJSON` throws.
 */
export function serializesToNothing(body: object): boolean {
  if (jsonTextByCopy.has(body)) {
    return jsonTextByCopy.get(body) === undefined;
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
 * Called as a request's body is handed to caller code - an interceptor - which may keep
 * it and change it in place: a copy's text no longer says what it serializes to, so it is
 * forgotten, and the copy is serialized from then on as any other value is.
 */
export function releaseRequestBody(body: unknown): void {
  if (typeof body === 'object' && body !== null) {
    jsonTextByCopy.delete(body);
  }
}

/**
 * Bytes or form data as a copy of the client's own - bytes read through their internal
 * slots, so another realm's are copied into this one's - and any other value as it is.
 */
export function cloneBodyValue(body: unknown): unknown {
  if (body instanceof FormData) {
    return copyFormData(body);
  } else if (isRequestBodyBytes(body)) {
    return copyBytes(body);
  }

  return body;
}

function copyFormData(form: FormData): FormData {
  const cloned = new FormData();

  // Read through the intrinsic `entries`, as the client reads a form everywhere else: a
  // subclass's or a `Proxy`'s own `entries` would report entries the form does not hold,
  // and a `Proxy` over a form, which has no internal slots, throws here.
  for (const [key, value] of FormData.prototype.entries.call(form)) {
    cloned.append(key, value);
  }

  return cloned;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  // Read through its internal slots, so another realm's is copied into this one's.
  return new Uint8Array(bytes);
}
