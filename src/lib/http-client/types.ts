import type { CookieJar } from './cookie-jar';
import type { RetryPolicyOptions } from '../retry-utils';

// --- Adapter Interface ---

export type AdapterType = 'fetch' | 'xhr' | 'node' | 'mock';

export type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export type ContentType = 'json' | 'text' | 'binary';

/**
 * Public query value shape compatible with `qs.parse()` output, so consumers
 * do not need `@types/qs` installed just to use this package's declarations.
 */
export type QueryValue = string | QueryObject | QueryValue[] | undefined;

export interface QueryObject {
  [key: string]: QueryValue;
}

export interface HTTPAdapter {
  send(request: AdapterRequest): Promise<AdapterResponse>;
  getType(): AdapterType;
}

export interface AdapterRequest {
  requestURL: string;
  method: HTTPMethod;
  /** Lowercase-keyed outbound headers for this attempt. Some adapters materialize string[] values at send time. */
  headers: Record<string, string | string[]>;
  body?: string | Uint8Array | FormData | null;
  signal?: AbortSignal;
  onUploadProgress?: (event: AdapterProgressEvent) => void;
  onDownloadProgress?: (event: AdapterProgressEvent) => void;
  /**
   * NodeAdapter only. HTTPClient rejects non-node adapters before dispatch if
   * this is set. Called after response headers arrive on a 200 response.
   * Return a writable stream to pipe the body into it, or null to cancel.
   */
  streamResponse?: StreamResponseFactory;
  /** Passed by the client so NodeAdapter can populate StreamResponseInfo. */
  attemptNumber?: number;
  /** Passed by the client so NodeAdapter can populate StreamResponseInfo. */
  requestID?: string;
}

export interface AdapterResponse {
  status: number;
  /**
   * Set by adapters when a redirect response was encountered.
   *
   * - **NodeAdapter / MockAdapter**: set on real 3xx responses. Location is
   *   accessible, so HTTPClient's redirect loop can follow normally.
   *
   * - **FetchAdapter**: uses `redirect: 'manual'`.
   *   - In server runtimes (Bun, Node) this returns the real 3xx with a Location
   *     header, so HTTPClient's redirect loop works normally.
   *
   *   - In a browser, CORS constraints cause `redirect: 'manual'` to yield an
   *     opaque response (status 0, no Location). Browser adapters require
   *     `followRedirects: false`, so a detected redirect always results in
   *     `redirect_disabled`.
   *
   * - **XHRAdapter**: the browser always follows redirects with no opt-out.
   *   Detected after the fact by comparing `xhr.responseURL` to the original
   *   URL; resolves as status 0 with `wasRedirectDetected: true`. Same
   *   HTTPClient routing as FetchAdapter.
   */
  wasRedirectDetected?: boolean;
  /**
   * Redirect target when the adapter can determine it, even if the client
   * does not follow that redirect itself.
   */
  detectedRedirectURL?: string;
  /**
   * True when the adapter wants the client to treat this as a transport-level
   * failure. Adapters may still preserve a diagnostic status code such as 495,
   * or use `status: 0` for generic transport failures. The client routes these
   * through the failed/error path and sets `HTTPResponse.isFailed: true`.
   */
  isTransportError?: boolean;
  /**
   * Set to `false` when no attempt can succeed, whatever the method — a rejected
   * TLS certificate, say. Honoured for every method, and it overrides
   * `retryNonIdempotentMethods`.
   *
   * Do **not** set it for a failure that merely might have been delivered, such
   * as one that struck mid-upload: that vetoes retries for methods where replay
   * is safe by definition. Report
   * {@link AdapterResponse.wasDefinitelyNotSent} instead, or report nothing.
   *
   * Only `false` carries meaning. `true` is a hint, and never authorizes
   * replaying a non-idempotent request.
   */
  isRetryable?: boolean;
  /**
   * Set to `true` only when the adapter can prove no request bytes reached the
   * server — a refused connection, a name that did not resolve. Absence means
   * "not known", never "known to be safe".
   *
   * Deliberately separate from {@link AdapterResponse.isRetryable}, which is a
   * hint that says nothing about delivery. The client uses this to decide whether
   * a `POST` or `PATCH` may be retried after a transport failure, and ignores it
   * when a real response came back.
   */
  wasDefinitelyNotSent?: boolean;
  /**
   * Final request headers actually used by the adapter after adapter-local
   * mutations (for example multipart Content-Type/Content-Length added by the
   * Node adapter). When present, HTTPClient merges these into the observer-
   * facing AttemptRequest snapshot so response/error observers see the real
   * outgoing headers rather than only the pre-adapter request shape.
   */
  effectiveRequestHeaders?: Record<string, string | string[]>;
  /**
   * Most headers are `string`. `set-cookie` is always `string[]` (HTTP spec,
   * each cookie is a separate header line).
   *
   * Adapters may use any header casing, `HTTPClient` normalizes keys to
   * lowercase before redirect handling, cookies, and the public `HTTPResponse`.
   */
  headers: Record<string, string | string[]>;
  /** Raw response bytes. Higher layers decode/parse based on content-type. */
  body: Uint8Array | null;
  /**
   * Set by NodeAdapter when the body was piped to a StreamResponseFactory writable.
   * The client skips body parsing and sets isStreamed: true on HTTPResponse.
   */
  isStreamed?: boolean;
  /**
   * Set when response-body delivery fails after headers arrive — buffered
   * download truncation, writable errors, upstream response-stream errors.
   * NodeAdapter, FetchAdapter and MockAdapter all report it, and the client
   * synthesizes it for a per-attempt timeout that strikes mid-body. XHRAdapter
   * cannot: `XMLHttpRequest` zeroes the status on error.
   *
   * The client treats this as a terminal stream failure. The real HTTP status is
   * preserved (not zeroed) so observers can tell the server responded but body
   * delivery still failed.
   *
   * For replay decisions this groups with a real response, **not** with a
   * transport failure: headers arrived, so the server processed the request and
   * may have committed it, the same thing a 500 tells you.
   */
  isStreamError?: boolean;
  /**
   * Optional sub-classification for `isStreamError` so the client can surface a
   * more precise `HTTPClientError.code` while keeping `HTTPResponse`
   * transport-agnostic.
   */
  streamErrorCode?: 'stream_write_error' | 'stream_response_error';
  /**
   * Underlying error for an absorbed adapter failure. Populated for transport
   * failures the adapter resolves instead of throwing, and for streamed-body
   * failures carried via `isStreamError`.
   */
  errorCause?: Error;
  /**
   * Settles when the request **body** finishes going out, for a response that
   * arrived while it was still being written. Advisory: it never makes a response
   * a failure, and it never rejects.
   *
   * Absent for an ordinary REST endpoint, which reads and processes the whole
   * upload before answering - by then the body is already out. This is for the
   * uncommon shapes where the answer can come first: early-ack, unbuffered and
   * duplex endpoints.
   *
   * An endpoint with request buffering disabled answers while the upload is still
   * going, and what happens to the body afterwards was invisible to the caller.
   * It can fail - `serializeMultipartFormData` rejects when a `File` yields fewer
   * bytes than its `Blob.size`, putting a body on the wire short of its own
   * `Content-Length` with no transport failure anywhere - or be cut short by the
   * adapter's own stall watchdog, seconds after the caller already read a clean
   * `2xx`. Resolves with that failure, or with `undefined` when the body went out
   * in full.
   *
   * A promise rather than a plain error field because the answer usually does not
   * exist yet: the response is complete and is delivered immediately, and the
   * upload settles later. Waiting for it before resolving is what this must not
   * do - it turned a `413` that stopped reading into a network error with the
   * server's explanation dropped, and let an abort during the wait discard a
   * response that had already arrived in full.
   *
   * Present on every bodied request, from the moment the request has a body
   * rather than from the first byte written - so an abort before the writer
   * starts is reported here too, instead of leaving the field absent and
   * `await` answering `undefined`. Not only the requests whose writer was still
   * running when the response resolved, so presence does not mean the upload
   * outlived the answer. On the
   * ordinary shape, where the body went out long before the response came back,
   * it resolves with `undefined`. A writer that failed just before the response
   * arrived is still reported through it, which is why it is not gated on the
   * writer still being live.
   *
   * Nothing here affects `isFailed`, `isNetworkError`, retries, or the status,
   * and every such failure is still reported on the global `'error'` channel
   * whether or not anyone awaits this.
   *
   * An adapter that sets this must settle it in bounded time. `HTTPClient` waits on
   * it before the next redirect hop and before a retry, so that one body is not
   * written twice at once. The wait is bounded by the request's `timeout`: past
   * it, the request fails as a timeout rather than dispatching a second upload
   * beside one that may still be going out, and the broken contract is reported on
   * the global `'error'` channel. `NodeAdapter` settles its own well inside that,
   * through the upload stall watchdog; a custom adapter that never settles the
   * field turns every followed `307`/`308` and every retry into a timeout.
   */
  requestBodySettled?: Promise<Error | undefined>;
}

// --- Response streaming ---

/**
 * Minimal write-capable stream interface. Structurally matches Node.js Writable
 * without importing from 'node:stream', keeping this file isomorphic.
 */
/**
 * The subset of a Node `Writable` the adapter drives.
 *
 * **Reporting a failure.** A write that fails is expected to surface either through the
 * callback given to `write`/`end` or as an `'error'` event - which is what a Node stream
 * does. The event often arrives after the request has already settled and its own
 * listeners are gone, so the adapter keeps a listener attached across that gap to stop it
 * becoming an uncaught exception. The listener is released when the error or `'close'`
 * arrives, after roughly one second with neither, or after roughly five seconds total.
 * A later request can install a fresh listener; see the HTTP client documentation for
 * the exact lifetime rules.
 *
 * **Emit `'close'` when finished.** That is how the adapter learns nothing further is
 * coming and releases the listener. An implementation that emits neither an `'error'` nor
 * a `'close'` keeps the listener only until the bounded timers above expire.
 */
export interface WritableLike {
  write(chunk: Uint8Array | string, cb?: (err?: Error | null) => void): boolean;
  /**
   * The callback receives an error when the stream could not be finished - a write that
   * failed destroys it, so `end` reports here rather than succeeding. Ignoring the
   * argument settles a broken write as a success.
   */
  end(cb?: (err?: Error | null) => void): void;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'drain', listener: () => void): this;
  once(event: 'drain', listener: () => void): this;
  destroy(error?: Error): void;
  /**
   * Listener removal. Optional so an existing implementation still satisfies this type,
   * but define one: the adapter attaches listeners for the life of a request and takes
   * them off again afterwards, and with neither method it has no way to. It then attaches
   * one permanent listener per event to the writable and registers each request behind
   * that, rather than adding one per request to a writable reused across many of them.
   * Behaviour is the same either way; the listener is what defining one saves. Either
   * name works - both are `EventEmitter`'s, and a Node stream has both.
   */
  off?(
    event: 'drain' | 'error' | 'close',
    listener: (() => void) | ((err: Error) => void),
  ): unknown;
  removeListener?(
    event: 'drain' | 'error' | 'close',
    listener: (() => void) | ((err: Error) => void),
  ): unknown;
  /**
   * Set by Node-style streams once the stream has errored. Read as a second signal, for
   * a runtime that destroys the stream without passing the error to `end`'s callback.
   */
  errored?: Error | null;
}

/**
 * Info passed to a StreamResponseFactory. Status is always 200 — the factory
 * is never called for any other status code.
 */
export interface StreamResponseInfo {
  /** Always 200 — factory is not called for any other status. */
  status: 200;
  /** Response headers for this attempt. Most values are string; set-cookie is string[]. */
  headers: Record<string, string | string[]>;
  /** Fully resolved request URL for this attempt. */
  url: string;
  /** Which attempt this is (1-based). Increments on retry. */
  attempt: number;
  /** ULID assigned to this send() call. */
  requestID: string;
}

/**
 * Context passed alongside StreamResponseInfo. Provides an attempt-scoped
 * AbortSignal that fires on cancel, timeout, or stream write failure — so
 * cleanup logic (delete partial file, close import stream, etc.) can be
 * co-located with the stream setup code instead of scattered across observers.
 */
export interface StreamResponseContext {
  /** Fires on cancel, timeout, or stream write failure for this attempt. */
  signal: AbortSignal;
}

/**
 * Returned from a StreamResponseFactory to cancel the stream with an optional reason.
 * Equivalent to returning null, but allows attaching a reason to HTTPClientError.cancelReason.
 */
export interface StreamResponseCancel {
  cancel: true;
  reason?: string;
}

/**
 * Factory called by NodeAdapter after response headers arrive on a 200.
 * Return a WritableLike to pipe the body into it, null to cancel, or
 * `{ cancel: true, reason?: string }` to cancel with an optional reason string
 * surfaced on HTTPClientError.cancelReason.
 * May be async.
 */
export type StreamResponseFactory = (
  info: StreamResponseInfo,
  context: StreamResponseContext,
) =>
  | WritableLike
  | null
  | StreamResponseCancel
  | Promise<WritableLike | null | StreamResponseCancel>;

// --- Progress ---

/**
 * Raw progress event emitted by adapters. Does not include `attemptNumber` or
 * `hopNumber` — those are injected by `HTTPClient` when forwarding to consumers.
 */
export interface AdapterProgressEvent {
  loaded: number;
  total: number;
  /** 0–1, or -1 if total unknown */
  progress: number;
}

export interface HTTPProgressEvent extends AdapterProgressEvent {
  attemptNumber: number;
  /** Present only during redirect hops (1 = first redirect, 2 = second, etc.). */
  hopNumber?: number;
}

// --- Attempt lifecycle hooks ---

export interface AttemptStartEvent {
  attemptNumber: number;
  isRetry: boolean;
  requestID: string;
  /**
   * The original resolved URL for this `send()` before redirect follow-ups.
   *
   * During `initial` interceptors this is the pre-interceptor resolved URL.
   * In later phases it matches {@link HTTPResponse.initialURL}. This is not
   * the URL of the current adapter attempt — see
   * {@link InterceptedRequest.requestURL} and `redirect.to` for hop context.
   */
  initialURL: string;
  /**
   * Set for adapter attempts that are part of a redirect follow-up (1 = first hop).
   * Aligns with {@link HTTPProgressEvent.hopNumber}.
   */
  hopNumber?: number;
  /**
   * When `hopNumber` is set, the redirect hop this attempt belongs to — same fields as
   * `RequestPhase` `redirect` / `retry.redirect` for observers.
   */
  redirect?: RedirectHopInfo;
}

export interface AttemptEndEvent {
  attemptNumber: number;
  isRetry: boolean;
  willRetry: boolean;
  /**
   * Why no retry happened, when a retry was genuinely available to suppress — a
   * policy is configured, it has attempts left, and the status alone would have
   * allowed one. Absent otherwise, since nothing was suppressed.
   *
   * - `adapter_veto` — the adapter reported `isRetryable: false`. Not produced by
   *   a real transport, which pairs that flag with the non-retryable `495`;
   *   reachable from `MockAdapter` and custom adapters.
   * - `stream_error` — the body failed after headers arrived, so the server
   *   received the request and the outcome is unknown.
   * - `non_idempotent_method` — a `POST` or `PATCH` with no proof the request
   *   went undelivered. Set `retryNonIdempotentMethods` to allow it.
   *
   * Exists so a suppressed retry is self-explaining: `willRetry: false` alone is
   * indistinguishable from a policy declining.
   */
  retrySuppressedReason?:
    'adapter_veto' | 'stream_error' | 'non_idempotent_method';
  /** Present only when a retry has been scheduled after this attempt. */
  nextRetryDelayMS?: number;
  /** Epoch ms for the scheduled retry, when a retry has been scheduled. */
  nextRetryAt?: number;
  status: number;
  requestID: string;
  /** Same as {@link AttemptStartEvent.initialURL}. */
  initialURL: string;
  hopNumber?: number;
  redirect?: RedirectHopInfo;
}

// --- Config ---

export interface HTTPClientConfig {
  adapter?: HTTPAdapter;
  /**
   * Origin / prefix for relative request paths (`/api/...`, `v1/...`, etc.).
   *
   * Omit or leave unset only when every {@link BaseHTTPClient.request} path is
   * already absolute, or when you resolve URLs yourself.
   *
   * Relative paths are appended to this value. Full `http(s)://…` paths (and
   * `//host/…`) skip concatenation with `baseURL`; see JSDoc on
   * `BaseHTTPClient.request` and `buildURL` in `utils.ts`.
   */
  baseURL?: string;
  defaultHeaders?: Record<string, string | string[]>;
  timeout?: number;
  cookieJar?: CookieJar | null;
  retryPolicy?: RetryPolicyOptions;
  /**
   * Whether a retry policy may replay `POST` and `PATCH`, the methods RFC 9110
   * does not define as idempotent. Defaults to `false`.
   *
   * When `false`, such a request is never retried after a real HTTP response —
   * a 500 still means the handler ran and may have committed — and after a
   * transport failure only when the adapter reports
   * {@link AdapterResponse.wasDefinitelyNotSent}. A bare transport failure is not
   * enough, and neither is `isRetryable: true`.
   *
   * Set to `true` when writes are guarded by an idempotency key or are naturally
   * safe to repeat. Idempotent methods are unaffected either way.
   */
  retryNonIdempotentMethods?: boolean;
  includeRequestID?: boolean;
  includeAttemptHeader?: boolean;
  userAgent?: string;
  followRedirects?: boolean;
  maxRedirects?: number;
}

export interface SubClientConfig extends Partial<HTTPClientConfig> {
  /**
   * How sub-client `defaultHeaders` should interact with inherited defaults.
   * Default: `'replace'`.
   *
   * Use `'merge'` to preserve inherited defaults and layer new headers on top.
   *
   * If no new `defaultHeaders` are provided, `'merge'` keeps the inherited
   * defaults as-is.
   */
  defaultHeadersStrategy?: 'replace' | 'merge';
}

// --- Request ---

export interface HTTPRequestOptions {
  headers?: Record<string, string | string[]>;
  params?: Record<string, unknown>;
  body?: unknown;
  timeout?: number;
  signal?: AbortSignal;
  retryPolicy?: RetryPolicyOptions | null;
  /**
   * Per-request override for {@link HTTPClientConfig.retryNonIdempotentMethods}.
   * Falls back to the client config when omitted.
   */
  retryNonIdempotentMethods?: boolean;
  label?: string;
  onUploadProgress?: (event: HTTPProgressEvent) => void;
  onDownloadProgress?: (event: HTTPProgressEvent) => void;
  onAttemptStart?: (event: AttemptStartEvent) => void;
  onAttemptEnd?: (event: AttemptEndEvent) => void;
  /**
   * NodeAdapter only. Called after response headers arrive on a 200 response.
   * Return a WritableLike to pipe the body to it, or null to cancel.
   * HTTPClient rejects non-node adapters before dispatch if this is set.
   */
  streamResponse?: StreamResponseFactory;
}

// --- Response ---

export interface HTTPResponse<T = unknown> {
  status: number;
  /**
   * Lowercase keys (normalized by `HTTPClient` from adapter output).
   * Most values are `string`; `set-cookie` is `string[]`.
   */
  headers: Record<string, string | string[]>;
  body: T;
  contentType: ContentType;
  isJSON: boolean;
  isText: boolean;
  isCancelled: boolean;
  isTimeout: boolean;
  isNetworkError: boolean;
  /**
   * True when this response settled through the client's failed/error path.
   *
   * In practice this is true for responses flagged as `isCancelled`,
   * `isTimeout`, `isNetworkError`, `isStreamError`, or adapter
   * `isTransportError`, as well as other client-level failures that resolve to
   * `status: 0` (for example request setup, interceptor, and redirect
   * control-flow failures). For adapter-originated transport failures,
   * `isTransportError` is the explicit signal; bare `status: 0` is also
   * treated as a transport failure by the client.
   *
   * Ordinary HTTP responses, including HTTP error statuses like 4xx/5xx,
   * remain `false`. This tracks client-level failure handling, not HTTP
   * status class.
   */
  isFailed: boolean;
  isParseError: boolean;
  /**
   * Request URL for this `send()` after `initial` interceptors, before any
   * redirect follow-ups. Same string as {@link AttemptStartEvent.initialURL} on attempt hooks.
   * Real transport adapters use an absolute http(s) URL here. MockAdapter
   * path-only requests without a client `baseURL` are materialized as
   * `http://localhost/...` before interceptors run.
   */
  initialURL: string;
  /**
   * URL of the request that produced this response (last adapter attempt after redirects).
   * Equals {@link HTTPResponse.initialURL} when no redirect occurred.
   */
  requestURL: string;
  /** True when a redirect response was encountered at any point (followed or not). */
  wasRedirectDetected: boolean;
  /** True when HTTPClient's own redirect loop followed at least one hop. */
  wasRedirectFollowed: boolean;
  /** Redirect target when known but not followed by the client loop. */
  detectedRedirectURL?: string;
  /**
   * Redirect target URLs recorded during redirect handling, in order.
   * The current detected target may appear here before its follow-up request is
   * dispatched. If a redirect-phase interceptor rewrites that target and
   * redirect handling continues, later entries reflect the rewritten URL.
   */
  redirectHistory: string[];
  requestID: string;
  adapterType: AdapterType;
  /**
   * True when the response body was piped to a StreamResponseFactory writable.
   * body is null in this case — do not try to parse it.
   */
  isStreamed: boolean;
  /**
   * True when streamed body delivery fails after headers arrive (disk full,
   * writable destroyed, upstream response-stream error, etc.). The request
   * resolves as a failed response, with the real HTTP status preserved so
   * observers can distinguish a post-header streaming failure from a transport
   * failure (status: 0). Stream setup/factory failures do not set
   * `isStreamError`.
   */
  isStreamError: boolean;
  /**
   * Settles when the request body finishes going out. Present on every bodied
   * request, not only the ones whose upload was still running when the response
   * arrived - so presence says nothing about which of the two came first, and on
   * the ordinary shape it resolves with `undefined`. See
   * {@link AdapterResponse.requestBodySettled}.
   *
   * Advisory only, and it never rejects: this response succeeded as far as the
   * client is concerned - `isFailed`, `isNetworkError` and the status are
   * untouched - and a caller that ignores it sees exactly what it saw before. A
   * caller that needs to know its upload actually arrived awaits this and checks
   * for an `Error`. Only `NodeAdapter` reports it today.
   */
  requestBodySettled?: Promise<Error | undefined>;
}

// --- Error ---

export type ErrorCode =
  | 'network_error'
  | 'timeout'
  | 'cancelled'
  | 'redirect_disabled'
  | 'redirect_loop'
  | 'request_setup_error'
  | 'adapter_error'
  | 'interceptor_error'
  | 'stream_write_error'
  | 'stream_response_error'
  | 'stream_setup_error';

export interface HTTPClientError {
  code: ErrorCode;
  message: string;
  cause?: Error;
  /**
   * Original resolved URL for this `send()` before redirects.
   *
   * During `initial` interceptors this is the pre-interceptor resolved URL.
   * In later phases it matches {@link HTTPResponse.initialURL} and
   * {@link AttemptStartEvent.initialURL}.
   * Real transport adapters use an absolute http(s) URL here. MockAdapter
   * path-only requests without a client `baseURL` are materialized as
   * `http://localhost/...` before interceptors run.
   */
  initialURL: string;
  /** URL of the last request attempt when the error was produced. */
  requestURL: string;
  /** True when a redirect response was encountered at any point (followed or not). */
  wasRedirectDetected: boolean;
  /** True when HTTPClient's own redirect loop followed at least one hop before the error. */
  wasRedirectFollowed: boolean;
  /** Redirect target when known but not followed by the client loop. */
  detectedRedirectURL?: string;
  /**
   * Redirect target URLs recorded during redirect handling, in order.
   * The current detected target may appear here before its follow-up request is
   * dispatched. If a redirect-phase interceptor rewrites that target and
   * redirect handling continues, later entries reflect the rewritten URL.
   */
  redirectHistory: string[];
  requestID: string;
  isTimeout: boolean;
  /** True when a retry policy was active and all attempts were exhausted before a response was received. */
  isRetriesExhausted: boolean;
  /**
   * Optional reason string when the request was cancelled with an explicit string reason.
   * Set by: a request interceptor returning `{ cancel: true, reason: '...' }`, a
   * StreamResponseFactory returning `{ cancel: true, reason: '...' }`, or an AbortSignal
   * aborted via `controller.abort('reason')`. Undefined when no explicit string reason
   * was provided (e.g. `controller.abort()` with no argument, `builder.cancel()`).
   */
  cancelReason?: string;
}

// --- Request Phase ---

/**
 * **Phases vs hooks (one mental model)**
 *
 * - **`retry` and `redirect` are both phases** on the same `RequestPhaseName` list. They
 *   mean “something intermediate happened before this `send()` finishes,” not “only one
 *   kind of thing counts as a phase.” The names differ because the **payload** differs:
 *   retries are policy- and attempt-scoped (`attempt`, `maxAttempts`), while redirects are
 *   HTTP hop-scoped (`hop`, `from`, `to`, `statusCode`). Same idea as having both
 *   `click` and `keydown` in the DOM, different events but the same observer mechanism.
 *
 * - **Global (client-scoped) monitoring:** `addResponseObserver` / `addErrorObserver` on
 *   `HTTPClient`, with optional `phases` (plain arrays like `['retry', 'redirect', 'final']`).
 *   One callback with
 *   `phases: ['retry', 'redirect']` runs **once per matching event**, e.g. a `send()` that
 *   redirects once then retries once invokes the handler twice with different `phase.type`,
 *   never twice for the same adapter response (a status is either a redirect hop or a retry
 *   trigger, not both). The filter list is **OR** on `phase.type`.
 *
 * - **Policy retry (`type: ‘retry’`):** fires once per reattempt. Interceptors and observers
 *   always see the URL being retried, which is the redirect target when a redirect preceded
 *   the retry. The optional `phase.redirect` field is metadata that tells you which redirect
 *   hop led to this retry (`{ hop, from, to, statusCode }`), so you don’t have to track
 *   that yourself.
 *
 * - **Per-request (builder-scoped) monitoring:** `onAttemptStart`, `onAttemptEnd`, and
 *   progress callbacks fire only for that builder’s `send()`. They do not replace global
 *   observers. They are for when you want lifecycle tied to one call without registering
 *   on the client. Each **adapter** attempt on the initial URL and on every redirect
 *   follow-up (including policy retries on a hop) invokes start/end; `initialURL` on
 *   those events matches {@link HTTPResponse.initialURL}. Redirect attempts include
 *   `hopNumber` and `redirect` ({@link RedirectHopInfo}) matching observer phases.
 *
 * - **`initial`** is for **request** interceptors (mutate before send), not response/error
 *   observers. Settlement-only errors (interceptor throw mid-redirect/retry setup) still
 *   use **`final`** on error observers by design.
 *
 * **Per-handler phase subsets:**
 * - Interceptors see: `initial`, `retry`, `redirect` (never `final`)
 * - Response observers see: `retry`, `redirect`, `final` (never `initial`)
 * - Error observers see: `retry`, `final` (never `initial` or `redirect` — redirect errors
 *   surface as `final`, retry errors on redirect hops carry `redirect` inside the `retry` phase)
 */
export type RequestPhaseName = 'initial' | 'retry' | 'redirect' | 'final';
/** Phases that can reach a {@link RequestInterceptor}. */
export type InterceptorPhaseName = 'initial' | 'retry' | 'redirect';
/** Phases that can reach a {@link ResponseObserver}. */
export type ResponseObserverPhaseName = 'retry' | 'redirect' | 'final';
/** Phases that can reach an {@link ErrorObserver}. */
export type ErrorObserverPhaseName = 'retry' | 'final';

/**
 * One HTTP redirect hop. The **`redirect`** phase and **`retry.redirect`** (policy retry on a
 * post-redirect URL) both use this shape.
 *
 * **`from` / `to`:** Intended to be absolute URLs (the {@link InterceptedRequest.requestURL}
 * that received the redirect response, and the next {@link InterceptedRequest.requestURL}).
 * `Location` is resolved against `from`, then normalized with the client `baseURL` when
 * needed. Without a `baseURL`, path-only strings may remain as paths.
 */
export type RedirectHopInfo = {
  hop: number;
  from: string;
  to: string;
  statusCode: number;
};

/** Discriminated union describing the current phase of a request lifecycle. */
export type RequestPhase =
  | { type: 'initial' }
  | {
      type: 'retry';
      attempt: number;
      maxAttempts: number;
      /**
       * When set, this policy retry applies after this redirect hop (same fields as
       * `type: 'redirect'`). Omit when the reattempt still uses the original request URL.
       */
      redirect?: RedirectHopInfo;
    }
  | ({ type: 'redirect' } & RedirectHopInfo)
  | { type: 'final' };

/** Narrowed phase union for {@link RequestInterceptor} — excludes `final`. */
export type InterceptorPhase = Extract<
  RequestPhase,
  { type: InterceptorPhaseName }
>;
/** Narrowed phase union for {@link ResponseObserver} — excludes `initial`. */
export type ResponseObserverPhase = Extract<
  RequestPhase,
  { type: ResponseObserverPhaseName }
>;
/** Narrowed phase union for {@link ErrorObserver} — the phases actually delivered to the callback (excludes `initial` and `redirect`). */
export type ErrorObserverPhase = Extract<
  RequestPhase,
  { type: ErrorObserverPhaseName }
>;

// Interceptors vs Observers
//
// The core mental model:
//
//   Interceptors  = "what WILL happen", run before an attempt, can mutate or cancel the
//                   request. Fire on `initial` (before the very first send), `retry` (before
//                   each retry attempt), and `redirect` (before following a Location header).
//                   Because they run before, they can refresh auth tokens, rewrite URLs,
//                   add headers, or abort entirely.
//
//   Observers     = "what DID happen", run after an attempt produces a result, cannot
//                   modify anything. Because they run after, they are the right place for
//                   logging, metrics, cache writes, and analytics. A common pattern is
//                   reading auth tokens or account metadata out of response bodies (or even
//                   error bodies) and updating client state, without touching the response
//                   itself.
//
//   Response observers fire on `retry` (retryable HTTP response before the next attempt),
//   `redirect` (the 3xx response before following Location), and `final` (terminal response).
//
//   Error observers only ever fire on `retry` or `final`, there is no `redirect` phase.
//   When a failure happens while following a redirect hop, the phase is still `retry` or
//   `final` as normal, redirect context is available via `phase.redirect` (on `retry`) or
//   `error.redirectHistory` (on `final`).

// --- Interceptors ---

interface PhaseFilter {
  methods?: HTTPMethod[];
  hosts?: string[];
  /**
   * Match against the request scheme (`'http'` or `'https'`). In practice
   * `requestURL` is absolute whenever the request could be resolved before
   * dispatch. `MockAdapter` path-only requests without a client `baseURL`
   * are materialized as `http://localhost/...`, browser adapters resolve
   * against `window.location`, and non-mock adapters still require absolute
   * URLs at validation time. The scheme check is skipped only when
   * `requestURL` is absent.
   */
  schemes?: ('http' | 'https')[];
}

/**
 * Filter for request interceptors.
 * Default phases: `['initial']`. Only runs before the first request attempt.
 * Set `phases` to `['initial', 'retry', 'redirect']` to re-run before every attempt.
 *
 * On a redirect follow-up, the first adapter attempt uses phase `redirect`. Further
 * attempts on that same URL (policy retry) use `retry` with the same `redirect` object
 * shape nested under `retry.redirect`.
 */
export interface RequestInterceptorFilter extends PhaseFilter {
  /**
   * Which events run this interceptor: **OR** over phase type. Valid values: `initial`,
   * `retry`, `redirect`. (`final` never reaches interceptors.)
   *
   * Default: `['initial']`. Pass `['initial', 'retry', 'redirect']` to re-run on every attempt.
   * Pass `[]` to match all phases.
   */
  phases?: InterceptorPhaseName[];
  /** Match against the outgoing request body. */
  bodyContainsKeys?: string[];
}

/**
 * Filter for response observers. See {@link RequestPhaseName} for how `retry` and
 * `redirect` fit together as intermediate phases.
 *
 * Default phases: `[‘final’]`. Terminal **HTTP** response for this `send()` only.
 *
 * - **`’retry’`**: the adapter returned a **retryable HTTP status** (including `0`
 *   when it is in the client’s retryable set) and a further attempt will run. Phase is
 *   `{ type: ‘retry’, attempt, maxAttempts, redirect? }` (aligned with
 *   `onAttemptEnd.attemptNumber`, with `redirect` only for retries on a post-redirect URL).
 *   If the adapter **throws** but a retry will follow, that path uses **error**
 *   observers with the same phase shape, not response observers.
 * - **`’redirect’`**: each redirect **response** before following `Location`. Phase is
 *   `{ type: ‘redirect’, hop, from, to, statusCode }` (see {@link RedirectHopInfo}).
 *
 * When `send()` **settles** with `status === 0`, **error** observers run with phase
 * `final` only. **Before** that, each retryable `0` response in a retry cycle can
 * still invoke **response** observers with phase `retry` when your filter includes it.
 */
export interface ResponseObserverFilter extends PhaseFilter {
  /**
   * Which events run this observer: **OR** over phase type. Valid values: `retry`,
   * `redirect`, `final`. (`initial` never reaches response observers.)
   *
   * Default: `['final']`. Pass `[]` to match all phases.
   */
  phases?: ResponseObserverPhaseName[];
  statusCodes?: number[];
  /**
   * Match against the parsed response content type category (`json`, `text`, `binary`).
   */
  contentTypes?: ContentType[];
  /**
   * Match against the raw `content-type` header, with optional wildcard subtype patterns
   * such as `image/*`.
   */
  contentTypeHeaders?: string[];
  /**
   * Match against the decoded response body.
   */
  bodyContainsKeys?: string[];
}

/**
 * Filter for error observers. Response-only fields like `statusCodes` and
 * `bodyContainsKeys` are excluded.
 *
 * Default phases: `['final']`. Fires when the request settles with an error,
 * including failures before any adapter call (for example an interceptor
 * throw or interceptor cancel). Interceptor failures during `retry` or
 * `redirect` interceptor phases are also reported as `final`, not as those
 * phase names. That matches settlement semantics, not “which interceptor
 * phase threw.”
 *
 * Include `'retry'` in `phases` to also run when the **adapter** throws but a retry
 * will follow. Same `HTTPClientError` shape as terminal adapter errors,
 * with `isRetriesExhausted: false` and phase
 * `{ type: 'retry', attempt, maxAttempts, redirect? }`. **Interceptor** throws
 * (any phase, including `retry` / `redirect`) never emit this: they abort the chain
 * and only **`final`** error observers run, as in the paragraph above. Retryable **HTTP
 * status** responses (including `0` when retried) use **response** observers for this
 * phase name, not error observers.
 */
export interface ErrorObserverFilter extends PhaseFilter {
  /**
   * Which events run this observer: **OR** over phase type. Only `retry` and
   * `final` are valid here — `initial` and `redirect` never reach error
   * observers (redirect errors surface as `final`; retry errors on redirect
   * hops carry `redirect` context inside the `retry` phase).
   *
   * Default: `['final']`. Pass `[]` to match all phases.
   */
  phases?: ErrorObserverPhaseName[];
}

/**
 * Signal returned by an interceptor to cancel the request.
 * When returned, the request is aborted and a 'cancelled' error is produced.
 */
export interface InterceptorCancel {
  cancel: true;
  reason?: string;
}

/**
 * Additional context passed to request interceptors so they can see the full
 * request chain without having to track it themselves.
 */
export interface RequestInterceptorContext {
  /**
   * Original resolved URL for this `send()` before redirects.
   *
   * During `initial` interceptors this is the pre-interceptor resolved URL.
   * In later phases it matches {@link HTTPResponse.initialURL} and
   * {@link AttemptStartEvent.initialURL}.
   */
  initialURL: string;
  /**
   * Redirect targets already recorded for this send, in order.
   * During redirect-phase interceptors this includes the current detected
   * target before any rewrite returned from that interceptor.
   */
  redirectHistory: string[];
  /**
   * ULID assigned to this `send()` call.
   * Matches {@link HTTPResponse.requestID} and {@link HTTPClientError.requestID}.
   */
  requestID: string;
  /**
   * The adapter attempt number that will be dispatched after this interceptor
   * chain completes (1-based). Increments on each retry across all redirect hops.
   */
  attemptNumber: number;
}

export type RequestInterceptor = (
  request: InterceptedRequest,
  phase: InterceptorPhase,
  context: RequestInterceptorContext,
) =>
  | InterceptedRequest
  | InterceptorCancel
  | null
  | Promise<InterceptedRequest | InterceptorCancel | null>;

// --- Observers ---

export interface InterceptedRequest {
  /**
   * Pending request shape seen by request interceptors before body serialization.
   * `requestURL` changes on redirect follow-ups and is absolute before dispatch.
   */
  requestURL: string;
  method: HTTPMethod;
  headers: Record<string, string | string[]>;
  body?: unknown;
}

/**
 * Finalized observer-facing snapshot for one adapter attempt, after
 * headers/body have been prepared for dispatch.
 */
export type AttemptRequest = Omit<
  AdapterRequest,
  | 'headers'
  | 'signal'
  | 'onUploadProgress'
  | 'onDownloadProgress'
  | 'streamResponse'
> & {
  /**
   * Final request headers visible to response/error observers. These are
   * lowercase-keyed. Most values are `string`, but adapter-local snapshots may
   * preserve repeated request headers as `string[]` when the underlying runtime
   * supports them.
   */
  headers: Record<string, string | string[]>;
  /**
   * Post-interceptor body before attempt materialization. This is useful for
   * observers that need the semantic payload as well as the adapter-facing body.
   */
  rawBody?: unknown;
  /** Effective per-attempt timeout in ms. */
  timeout?: number;
  /**
   * 1-based attempt number for this adapter call. Increments on each retry.
   * Undefined on best-effort snapshots produced before any adapter attempt is
   * dispatched (e.g. interceptor errors, pre-send cancellations).
   */
  attemptNumber?: number;
  /**
   * ULID assigned to this {@link BaseHTTPClient.request} `send()` call.
   * Matches {@link HTTPResponse.requestID} and {@link HTTPClientError.requestID}.
   * Undefined on best-effort snapshots produced before the request ID is assigned
   * (should not occur in practice).
   */
  requestID?: string;
};

export type ResponseObserver = (
  response: HTTPResponse,
  request: AttemptRequest,
  phase: ResponseObserverPhase,
) => void | Promise<void>;

export type ErrorObserver = (
  error: HTTPClientError,
  request: AttemptRequest,
  phase: ErrorObserverPhase,
) => void | Promise<void>;

// --- Builder state ---

export type RequestState =
  | 'pending'
  | 'sending'
  | 'waiting_for_retry'
  | 'completed'
  | 'cancelled'
  | 'failed';
