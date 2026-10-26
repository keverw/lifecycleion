import { isNullish } from '../internal/is-nullish';
import { assertDurationMS, clampTimerDelayMS } from '../internal/timer-limits';
import type { AdapterType, HTTPMethod } from './types';

/**
 * HTTP responses that are plausibly transient and worth retrying when a retry
 * policy is explicitly enabled.
 *
 * `status === 0` is included on purpose because browser/XHR-style adapters can
 * surface "no real HTTP response" that way when the network is unavailable or
 * the request otherwise fails before a normal status code is received.
 */
export const RETRYABLE_STATUS_CODES: ReadonlySet<number> = new Set([
  // 0: Browser/XHR-style "no response" status.
  0,

  // 408 Request Timeout
  408,
  // 429 Too Many Requests
  429,

  // 500 Internal Server Error
  500,
  // 502 Bad Gateway
  502,
  // 503 Service Unavailable
  503,
  // 504 Gateway Timeout
  504,

  // 507 Insufficient Storage
  507,
  // 509 Bandwidth Limit Exceeded (non-standard)
  509,
  // 520 Unknown Error (Cloudflare)
  520,
  // 521 Web Server Is Down (Cloudflare)
  521,
  // 522 Connection Timed Out (Cloudflare)
  522,
  // 523 Origin Is Unreachable (Cloudflare)
  523,
  // 524 A Timeout Occurred (Cloudflare)
  524,
  // 598 Network Read Timeout Error (non-standard)
  598,
  // 599 Network Connect Timeout Error (non-standard)
  599,
]);

/**
 * The methods RFC 9110 defines as idempotent, so a replay lands the resource in the
 * same state as sending it once. An allow-list: every other method - `POST`, `PATCH`,
 * and any custom one (`LOCK`, `MKCOL`, an RPC verb) - may apply its change twice, and is
 * replayed only as a non-idempotent method is.
 *
 * `PUT` and `DELETE` are here on purpose: both are idempotent by definition, even though
 * they mutate.
 */
export const IDEMPOTENT_METHODS: ReadonlySet<HTTPMethod> = new Set<HTTPMethod>([
  'GET',
  'HEAD',
  'OPTIONS',
  'TRACE',
  'PUT',
  'DELETE',
]);

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The longest wait a `setTimeout` can keep: 2^31 - 1 ms, about 24.8 days. A duration past
 * it is coerced to 1 ms by the timer. See {@link resolveRequestTimeoutMS}.
 *
 * Re-exported from the shared definition so the client, the retry policy and the logger
 * sinks cannot disagree about where the timer stops being able to count.
 */
export { MAX_TIMER_MS } from '../internal/timer-limits';

/**
 * Reject a request timeout that {@link resolveRequestTimeoutMS} would refuse, without
 * resolving it. Builders validate when the value is set but keep nullish as-is, so it
 * still inherits the client value at dispatch. One check keeps both sites agreeing on
 * what is invalid and on the error's label.
 */
export function validateRequestTimeoutMS(
  requested: unknown,
  label = 'HTTP request timeout',
): asserts requested is number | null | undefined {
  if (!isNullish(requested)) {
    assertDurationMS(requested, label);
  }
}

/**
 * The per-attempt timeout a request will actually run under.
 *
 * Null and undefined select the configured default. `<= 0` disables the per-attempt
 * timer, as `HTTPClientConfig.timeout` and `HTTPRequestOptions.timeout` document, and so
 * does `Infinity`, which is what a caller writes to mean "no timeout". A finite value past
 * {@link MAX_TIMER_MS} is clamped there, the closest wait a timer can keep. `NaN` and any
 * non-nullish value that is not a number fail clearly: `NaN` - `Number(process.env.UNSET)`
 * - fits neither "armed" nor "disabled", and would leave the attempt without a timer while
 * the upload-settle wait could never expire.
 */
export function resolveRequestTimeoutMS(
  requested: unknown,
  defaultMS: number = DEFAULT_TIMEOUT_MS,
  label?: string,
): number {
  validateRequestTimeoutMS(requested, label);
  if (isNullish(requested)) {
    return defaultMS;
  }

  if (requested <= 0 || requested === Number.POSITIVE_INFINITY) {
    return 0;
  }

  return clampTimerDelayMS(requested);
}

/**
 * The most bytes of a buffered response body a client holds unless configured otherwise:
 * 64 MiB. A buffered body is held whole in memory before it is parsed, so without a bound
 * one oversized or endless response - a misrouted download, a hostile server - could take
 * the process with it. A body meant to be that large belongs in `streamResponse`.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * Reject a response size limit that {@link resolveMaxResponseBytes} would refuse, without
 * resolving it. Builders validate when the value is set but keep nullish as-is, so it
 * still inherits the client value at dispatch, as {@link validateRequestTimeoutMS} does
 * for the timeout.
 *
 * A positive integer, or `Infinity` for no limit. `0` is refused rather than read as
 * "disabled" the way a zero timeout is: a limit of nothing would fail every response with
 * a body, and a caller who wants no limit says so with `Infinity`. A fraction, `NaN` and a
 * non-number are refused for the reason `NaN` is refused for a timeout - each is a mistake
 * upstream, not a request for a default.
 */
export function validateMaxResponseBytes(
  requested: unknown,
  label = 'HTTP request maxResponseBytes',
): asserts requested is number | null | undefined {
  if (isNullish(requested) || requested === Number.POSITIVE_INFINITY) {
    return;
  }

  if (
    typeof requested !== 'number' ||
    !Number.isInteger(requested) ||
    requested <= 0
  ) {
    throw new TypeError(
      `${label} must be a positive integer, or Infinity for no limit (got ${typeof requested === 'number' ? String(requested) : typeof requested})`,
    );
  }
}

/**
 * The response size limit a request will actually run under: null and undefined select
 * `defaultBytes`, anything else is validated by {@link validateMaxResponseBytes} and kept
 * as given. `Infinity` is kept too, and adapters read it as no limit.
 */
export function resolveMaxResponseBytes(
  requested: unknown,
  defaultBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
  label?: string,
): number {
  validateMaxResponseBytes(requested, label);

  return isNullish(requested) ? defaultBytes : requested;
}

export const DEFAULT_REQUEST_ID_HEADER = 'x-local-client-request-id';

export const DEFAULT_REQUEST_ATTEMPT_HEADER = 'x-local-client-request-attempt';

export const DEFAULT_USER_AGENT = 'lifecycleion-http-client';

/**
 * The base a path-only request URL is read against for MockAdapter: by the client, when
 * no `baseURL` is configured, and by the adapter itself when driven directly with one.
 */
export const MOCK_ADAPTER_DEFAULT_BASE_URL = 'http://localhost';

export const NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG =
  '_lifecycleion_non_retryable_http_client_callback_error';

/** Terminal adapter configuration failures retain adapter_error classification. */
export const NON_RETRYABLE_HTTP_ADAPTER_ERROR_FLAG =
  '_lifecycleion_non_retryable_http_adapter_error';

export const STREAM_FACTORY_ERROR_FLAG = '_lifecycleion_stream_factory_error';

/**
 * Marks a response body's decoding failure - a corrupt compressed stream, bytes after it,
 * too many stacked codings - as opposed to a transport failure. The client follows a
 * redirect whose body only failed to decode, as browsers do: they never decode a body
 * they are about to leave. Nor does it stop a retry the status asks for.
 */
export const RESPONSE_DECODE_ERROR_KEY = Symbol.for(
  'lifecycleion.http-client.response-decode-error',
);

/**
 * Marks an adapter's carrier for a failure that may be the caller's own error: the client
 * reports the carrier's `cause`. A symbol, so it never reaches a serialized error.
 */
export const ADAPTER_ERROR_CARRIER_KEY = Symbol.for(
  'lifecycleion.http-client.adapter-error-carrier',
);

/**
 * Attached to the AbortError thrown when a StreamResponseFactory returns null
 * or `{ cancel: true, reason? }`. The value is the reason string if provided,
 * or `true` if the factory cancelled without a reason. Lets HTTPClient surface
 * the reason on HTTPClientError.cancelReason.
 */
export const STREAM_FACTORY_CANCEL_KEY =
  '_lifecycleion_stream_factory_cancel_reason';

export const RESPONSE_STREAM_ABORT_FLAG = '_lifecycleion_response_stream_abort';

/**
 * Attached to an error an adapter *throws* to carry the request body's own
 * settlement promise, the mirror of `AdapterResponse.requestBodySettled` on the
 * paths that resolve.
 *
 * `requestBodySettled` is documented as present on every bodied request, and an
 * adapter that throws - a cancel, a timeout, a transport failure - had nowhere to
 * put it: the promise lives in the adapter's closure and the response object it
 * would have ridden on is never built. `HTTPClient` then omitted the field, and
 * `await undefined` is `undefined`, which is the documented value for *an upload
 * that went out in full*. A cancelled bodied `POST` reported a clean upload.
 *
 * The value is the promise itself, never an error. `NodeAdapter`'s own promise
 * resolves with the upload's failure or with `undefined` and never rejects, so an
 * error carrying it can be discarded by a caller that does not care without
 * raising an unhandled rejection - but `HTTPAdapter` is a public extension point,
 * so `HTTPClient` normalizes whatever it finds here rather than trusting that of a
 * tag it did not write.
 *
 * A symbol rather than a string, unlike the boolean markers above it. This value
 * rides on an error that may be serialized at an IPC boundary, and `serializeError`
 * walks `getOwnPropertyNames` deliberately - so a string key put an internal
 * `Promise` into the payload as an empty object, and spent a node of that walk's
 * budget on it, enumerable or not. Symbol keys are skipped by both that walk and
 * `JSON.stringify`. `Symbol.for`, not `Symbol`, for the reason `reportToHost` uses
 * the global registry: the adapter and the client are separate entry points, so a
 * consumer importing both has two copies of this module and they must agree.
 */
export const REQUEST_BODY_SETTLED_KEY = Symbol.for(
  'lifecycleion.requestBodySettled.v1',
);

/**
 * The header-carrying tags an adapter puts on an error it throws: the request headers it
 * sent, and a cut-off response's status and headers. Symbols, for the reason
 * {@link REQUEST_BODY_SETTLED_KEY} is one: `serializeError` walks every own property
 * *name*, hidden or not, and these carry the request's credentials and the response's
 * `Set-Cookie`. Symbol keys are skipped by that walk and by `JSON.stringify`.
 */
export const EFFECTIVE_REQUEST_HEADERS_KEY = Symbol.for(
  'lifecycleion.effectiveRequestHeaders.v1',
);
export const STREAM_ABORT_STATUS_KEY = Symbol.for(
  'lifecycleion.streamAbortStatus.v1',
);
export const STREAM_ABORT_HEADERS_KEY = Symbol.for(
  'lifecycleion.streamAbortHeaders.v1',
);

/**
 * Marks a built-in network adapter - a `NodeAdapter`, `FetchAdapter` or `XHRAdapter` -
 * with its class's `send`; see `isBuiltInNetworkSend`. And marks the request `HTTPClient`
 * hands an adapter with the listener for the upload's source waits; see
 * `listenForUploadSourceWait`. `Symbol.for`, not `Symbol`, for the reason
 * {@link REQUEST_BODY_SETTLED_KEY} is: the client and each adapter are separate entry
 * points, bundled without shared chunks, so a consumer importing both has two copies of
 * the module that sets a mark and the one that reads it - a module-local registry in one
 * copy would never be found by the other.
 */
export const BUILT_IN_NETWORK_SEND_KEY = Symbol.for(
  'lifecycleion.builtInNetworkSend.v1',
);
export const UPLOAD_SOURCE_WAIT_LISTENER_KEY = Symbol.for(
  'lifecycleion.uploadSourceWaitListener.v1',
);

/**
 * How long the body writer may wait on its *source* after the response arrived before
 * that is called a stall. `NodeAdapter`'s stall watchdog gives a writer parked on a
 * `Blob.stream()` read this long, and `HTTPClient`'s wait on an attempt's upload counts
 * a reported source wait as activity for no longer than this.
 *
 * Separate from the adapter's socket grace because the two waits mean different things:
 * a socket that accepted nothing for five seconds has a receiver that stopped, while a
 * `Blob.stream()` read that has not answered in five seconds has a slow disk under it.
 * A minute is past any read a live disk answers, and it is a bound rather than a promise
 * for the same reason the socket grace is: a source that never answers would otherwise
 * park the writer, the socket and `requestBodySettled` for the life of the process.
 */
export const UPLOAD_SOURCE_STALL_GRACE_MS = 60_000;

/**
 * Set on the AbortError thrown by XHRAdapter's defensive `timeout` event
 * listener. Lets HTTPClient classify the error as a timeout (retryable) rather
 * than an unexpected abort (non-retryable cancel).
 */
export const XHR_BROWSER_TIMEOUT_FLAG = '_lifecycleion_xhr_browser_timeout';

/**
 * Every {@link AdapterType}. A client refuses an adapter whose `getType()` answers anything
 * else: each adapter and runtime check is keyed on the type, so an unknown one passed
 * every one of them.
 */
export const ADAPTER_TYPES: ReadonlySet<AdapterType> = new Set<AdapterType>([
  'fetch',
  'xhr',
  'node',
  'mock',
]);

/** The standard methods: sent uppercase whatever case they are given in. */
export const HTTP_METHODS: ReadonlyArray<HTTPMethod> = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
];

/**
 * Exact-match request headers that browsers either forbid outright or do not
 * let this client set reliably via plain Fetch/XHR headers.
 *
 * Prefix-based rules like `proxy-*` and `sec-*` are handled in `header-utils.ts`.
 */
export const BROWSER_RESTRICTED_HEADERS: ReadonlySet<string> = new Set([
  // Encoding / CORS negotiation headers controlled by the browser.
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'access-control-request-private-network',

  // Connection-level transport headers.
  'connection',
  'content-length',
  'date',
  'expect',
  'host',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',

  // Browser-managed request context / privacy headers.
  'cookie',
  'dnt',
  'origin',
  'referer',
  'set-cookie',
  'user-agent',
]);

export const BROWSER_RESTRICTED_HEADER_PREFIXES: ReadonlyArray<string> = [
  'proxy-',
  'sec-',
];

/**
 * Headers that can tunnel the real method through POST. Browsers block these
 * when they try to smuggle forbidden transport methods.
 */
export const BROWSER_METHOD_OVERRIDE_HEADER_NAMES: ReadonlySet<string> =
  new Set(['x-http-method', 'x-http-method-override', 'x-method-override']);

/**
 * Methods that browsers do not allow request headers to tunnel via the
 * override headers above.
 */
export const BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES: ReadonlySet<string> =
  new Set(['connect', 'trace', 'track']);

export const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Redirect responses that carry a follow-up `Location` hop. `300` and `304`
 * are excluded because they do not represent an automatic redirect here.
 */
export const REDIRECT_STATUS_CODES: ReadonlySet<number> = new Set([
  // 301 Moved Permanently
  301,
  // 302 Found
  302,

  // 303 See Other
  303,

  // 307 Temporary Redirect
  307,
  // 308 Permanent Redirect
  308,
]);

/**
 * The longest lifetime a cookie is given, in seconds: 400 days, RFC 6265bis §5.5's cap on
 * both `Max-Age` and `Expires`, as browsers apply it. Shared by `CookieJar`, which caps
 * what it stores, and `MockAdapter`, which caps the `Max-Age` it writes.
 */
export const MAX_COOKIE_LIFETIME_SECONDS = 400 * 24 * 60 * 60;
