import type { HTTPMethod } from './types';

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
 * Methods RFC 9110 does not define as idempotent, so replaying one may apply
 * the same change twice.
 *
 * `PUT` and `DELETE` are absent on purpose: both are idempotent by definition,
 * even though they mutate. Repeating them lands the resource in the same state
 * as doing it once, which is exactly what makes a replay safe.
 */
export const NON_IDEMPOTENT_METHODS: ReadonlySet<HTTPMethod> =
  new Set<HTTPMethod>(['POST', 'PATCH']);

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The longest wait a `setTimeout` can keep: 2^31 - 1 ms, about 24.8 days. A duration past
 * it is coerced to 1 ms by the timer. See {@link resolveRequestTimeoutMS}.
 */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * The per-attempt timeout a request will actually run under.
 *
 * `HTTPClientConfig.timeout` and `HTTPRequestOptions.timeout` both document `<= 0` as
 * "disable the per-attempt timer", and that reading is kept. What used to be taken
 * literally is everything else a `number` can be: `NaN` - `Number(process.env.UNSET)` -
 * passed both the `> 0` check that arms the timer and the `<= 0` check that disables the
 * upload-settle wait, so the attempt ran with no timer while the wait re-armed a `NaN`
 * timer every millisecond and could never expire; `Infinity` did the same to the wait and
 * fired the attempt timer after 1 ms. `NaN` and a non-number now take the default.
 * `Infinity` is what a caller writes to mean "no timeout", and that is what `0` already
 * means, so it disables the timer rather than being bounded at a number nobody chose. A
 * finite value past {@link MAX_TIMER_MS} is clamped there, the closest wait a timer can
 * keep.
 */
export function resolveRequestTimeoutMS(
  requested: unknown,
  defaultMS: number = DEFAULT_TIMEOUT_MS,
): number {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    return defaultMS;
  }

  if (requested <= 0 || requested === Number.POSITIVE_INFINITY) {
    return 0;
  }

  return Math.min(requested, MAX_TIMER_MS);
}

export const DEFAULT_REQUEST_ID_HEADER = 'x-local-client-request-id';

export const DEFAULT_REQUEST_ATTEMPT_HEADER = 'x-local-client-request-attempt';

export const DEFAULT_USER_AGENT = 'lifecycleion-http-client';

export const NON_RETRYABLE_HTTP_CLIENT_CALLBACK_ERROR_FLAG =
  '_lifecycleion_non_retryable_http_client_callback_error';

export const STREAM_FACTORY_ERROR_FLAG = '_lifecycleion_stream_factory_error';

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
 * Set on the AbortError thrown by XHRAdapter's defensive `timeout` event
 * listener. Lets HTTPClient classify the error as a timeout (retryable) rather
 * than an unexpected abort (non-retryable cancel).
 */
export const XHR_BROWSER_TIMEOUT_FLAG = '_lifecycleion_xhr_browser_timeout';

export const HTTP_METHODS: ReadonlyArray<HTTPMethod> = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
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
