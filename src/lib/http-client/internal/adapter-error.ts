import { describeNonTokenMethod, normalizeStandardMethod } from './http-method';
import {
  ADAPTER_ERROR_CARRIER_KEY,
  NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG,
  RESPONSE_STREAM_ABORT_FLAG,
  STREAM_ABORT_HEADERS_KEY,
  STREAM_ABORT_STATUS_KEY,
} from '../consts';
import { isErrorValue } from '../../to-error';
import { readUnknownMember as readObjectMember } from '../../internal/read-member';

/**
 * A non-retryable adapter error for a failure that may be the caller's own error - one a
 * route, a body's `toJSON` or a header value's `toString` threw. A fresh carrier, with
 * that error on `cause` (which the client reports), rather than the flag defined on the
 * caller's object: there it would stay for good, so the same object thrown later by an
 * adapter's `send()` would read as non-retryable, and it would show up in
 * `serializeError`.
 */
export function nonRetryableAdapterErrorFrom(error: unknown): Error {
  // Already one: a refusal raised inside a step that is itself read on a carrier goes
  // out as it is, not wrapped twice. Known by identity, not by its key: the key is a
  // registry symbol any caller can put on their own error to skip the wrapping.
  if (isAdapterErrorCarrier(error)) {
    return error;
  }

  const message = readObjectMember(error, 'message');
  const carrier = new Error(
    typeof message === 'string' && message.length > 0
      ? message
      : 'Adapter failure',
    { cause: error },
  );
  const name = readObjectMember(error, 'name');

  // Not an `AbortError`: the client reads that name as a cancel or a timeout before it
  // reads the flag, so a caller's own one - a `throwIfAborted()` on an unrelated signal,
  // from a header value's `toString` - would be reported as a cancel, or retried as a
  // timeout. The caller's error stays on `cause`.
  if (typeof name === 'string' && name !== 'AbortError') {
    carrier.name = name;
  }

  Object.defineProperty(carrier, ADAPTER_ERROR_CARRIER_KEY, { value: true });
  markNonRetryableAdapterError(carrier);
  carriers.add(carrier);

  return carrier;
}

/** Every carrier {@link nonRetryableAdapterErrorFrom} has made, by identity. */
const carriers = new WeakSet<Error>();

/** Whether `error` is a carrier {@link nonRetryableAdapterErrorFrom} made. */
export function isAdapterErrorCarrier(error: unknown): error is Error {
  return (
    typeof error === 'object' && error !== null && carriers.has(error as Error)
  );
}

/**
 * An adapter request's method as the transport takes it: converted to a string once, as
 * `fetch`, `open` and Node's request line convert it, so a non-string one does not throw
 * at the first `toUpperCase` after the request may already have gone out. Refused as a
 * non-retryable `adapter_error` when it is absent - `String` would make that the verb
 * `undefined`, which `fetch` accepts as a token and would send - when its `toString`
 * throws, or when what it converts to is not an RFC 9110 token: every attempt carries the
 * same method.
 *
 * The token check is here, for every adapter, rather than left to each runtime: Node's
 * refusal quotes the method (`Method must be a valid HTTP token ["GET secret-token"]`) and
 * a carrier passes that message on, while MockAdapter, with no runtime to ask, would answer
 * one with the 404 of a route not found. The refusal names no value.
 */
export function readAdapterMethod(method: unknown): string {
  if (typeof method === 'string') {
    return normalizeStandardMethod(assertMethodToken(method));
  }

  if (method === undefined || method === null) {
    const refusal = new TypeError(
      `Adapter request method is required (got ${String(method)})`,
    );
    markNonRetryableAdapterError(refusal);
    throw refusal;
  }

  let text: string;
  try {
    // eslint-disable-next-line @typescript-eslint/no-base-to-string -- a caller's value, converted as the transport converts it
    text = String(method);
  } catch (error) {
    throw nonRetryableAdapterErrorFrom(error);
  }

  return normalizeStandardMethod(assertMethodToken(text));
}

/** `method` as given, or a non-retryable `TypeError` naming no value when it is not a token. */
function assertMethodToken(method: string): string {
  const problem = describeNonTokenMethod(method);
  if (problem === undefined) {
    return method;
  }

  const refusal = new TypeError(`Adapter request method ${problem}`);
  markNonRetryableAdapterError(refusal);
  throw refusal;
}

/**
 * An `AbortError` for an adapter to reject with: a plain `Error` named `AbortError`, which
 * is how the client knows one - by name, not by class - so it needs no `DOMException`.
 */
export function makeAbortError(message = 'Request aborted'): Error {
  const error = new Error(message);
  error.name = 'AbortError';

  return error;
}

/**
 * Whether `error` is an `AbortError` as the client and the adapters know one: by name, on
 * an error value - one from another realm too (see `isErrorValue`), which `instanceof`
 * would miss - with the name read guarded.
 */
export function isAbortError(error: unknown): error is Error {
  return (
    isErrorValue(error) && readObjectMember(error, 'name') === 'AbortError'
  );
}

/** The refusal of a `CONNECT`, which asks for a tunnel no adapter here opens. Non-retryable. */
export function connectRefusal(adapterName: string): TypeError {
  const refusal = new TypeError(
    `${adapterName} does not open tunnels; a CONNECT request is not supported`,
  );
  markNonRetryableAdapterError(refusal);
  return refusal;
}

/**
 * Tag a terminal adapter configuration failure so `HTTPClient` reports it as a
 * non-retryable `adapter_error` rather than retrying it as a network error.
 */
export function markNonRetryableAdapterError(error: unknown): void {
  try {
    Object.defineProperty(error, NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG, {
      value: true,
    });
  } catch {
    // Not an object, or one that refuses the property; it is retried as any untagged
    // error is.
  }
}

/**
 * Define `tags` on `target` as own, non-enumerable data properties: read back by name
 * (`readObjectMember`), but left out of `JSON.stringify`, `Object.keys` and spreads.
 * Throws as `Object.defineProperty` does on a frozen or sealed target.
 */
export function defineHiddenTags(
  target: object,
  tags: Record<PropertyKey, unknown>,
): void {
  // `Reflect.ownKeys`, not `Object.entries`: the header-carrying tags are symbols.
  for (const key of Reflect.ownKeys(tags)) {
    Object.defineProperty(target, key, {
      value: tags[key],
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
}

/**
 * Tag an abort thrown while reading the body with the response already received,
 * matching what NodeAdapter attaches to its response-stream aborts. Shared by FetchAdapter
 * and XHRAdapter. The client decides what the abort meant; this only makes the evidence
 * survive the throw.
 *
 * No `effectiveRequestHeaders` is tagged: neither `fetch` nor `XMLHttpRequest` exposes
 * the headers that went out on the wire, and echoing the request's own back would claim a
 * proof neither has.
 */
export function markResponseStreamAbort(
  error: unknown,
  status: number,
  headers: Record<string, string | string[]>,
): Error {
  // Per the Fetch Standard the rejection is the abort reason verbatim, so
  // returning it untagged sends the client down its early cancellation path and
  // drops the response headers, Set-Cookie included.
  //
  // Always a fresh object, never the reason itself: a signal hands the same
  // reason to every consumer, so two requests sharing one controller would
  // overwrite each other's status and headers (and a frozen reason would throw).
  // `name` is copied because the client routes on it.
  const original = isErrorValue(error) ? error : undefined;
  const originalMessage =
    original === undefined ? undefined : readObjectMember(original, 'message');
  const originalName =
    original === undefined ? undefined : readObjectMember(original, 'name');
  const tagged = new Error(
    typeof originalMessage === 'string' ? originalMessage : 'Request aborted',
  );

  tagged.name = typeof originalName === 'string' ? originalName : 'AbortError';

  // Hidden, as NodeAdapter's tags are: the response headers carry its `Set-Cookie`, and a
  // serialized error must not.
  defineHiddenTags(tagged, {
    [RESPONSE_STREAM_ABORT_FLAG]: true,
    [STREAM_ABORT_STATUS_KEY]: status,
    [STREAM_ABORT_HEADERS_KEY]: headers,
    cause: error,
  });

  return tagged;
}
