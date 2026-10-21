import {
  markNonRetryableAdapterError,
  nonRetryableAdapterErrorFrom,
} from '../internal/adapter-error';
import { defineEntry } from '../../internal/define-entry';
import { readBinaryByteLength } from '../../internal/binary-view';
import { observeRejection } from '../../internal/promise-reactions';
import Router from 'find-my-way';
import type { HTTPMethod as RouterHTTPMethod } from 'find-my-way';
import {
  guardProgressCallback,
  knownBodyByteLength,
  uploadCompleteEvent,
} from '../internal/progress';
import {
  lowerCaseHeaderName,
  materializeRequestHeaders,
} from '../internal/header-utils';
import {
  hasResponseBody,
  isAnsweredBodyOverLimit,
  makeResponseTooLargeError,
  readMaxResponseBytes,
} from '../internal/response-limit';
import qs from 'qs';
import { sleep } from '../../sleep';
import {
  adoptPromise,
  type PromiseResultBox,
} from '../../internal/adopt-promise';
import { REDIRECT_STATUS_CODES } from '../consts';
import {
  isPlainJSONBodyObject,
  normalizeAdapterResponseHeaders,
  parseContentType,
  resolveDetectedRedirectURL,
} from '../utils';
import type {
  HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  ContentType,
  QueryObject,
} from '../types';
import { isErrorValue } from '../../to-error';
import { reportCallbackError } from '../../safe-handle-callback';
import { readUnknownMember as readObjectMember } from '../../internal/read-member';
import {
  isTimeoutValidationError,
  resolveTimeoutMS,
} from '../../internal/timer-limits';

export interface MockFormData {
  /** String fields from the multipart body - the last value of a repeated name */
  fields: Record<string, string>;
  /** File fields from the multipart body - the last file of a repeated name */
  files: Record<string, File>;
  /** Every value of each string field, in order, as a server receives a repeated one */
  allFields: Record<string, string[]>;
  /** Every file of each file field, in order (`<input type="file" multiple>`) */
  allFiles: Record<string, File[]>;
}

export interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: QueryObject;
  headers: Record<string, string>;
  /**
   * Parsed cookies from the `cookie` request header — same data as
   * `headers.cookie`, pre-parsed for convenience.
   */
  cookies: Record<string, string>;
  /**
   * Parsed request body for mock handlers.
   * JSON bodies are parsed, text bodies stay strings, binary bodies stay as
   * `Uint8Array`, and multipart/form-data bodies become `MockFormData`.
   */
  body?: unknown;
}

/** Cookie attributes for the `MockResponse.cookies` shorthand. */
export interface MockCookieOptions {
  value: string;
  /** Seconds until the cookie expires. Use `0` or a negative value to expire it immediately. */
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** Defaults to `'/'` when omitted. */
  path?: string;
  domain?: string;
}

export interface MockResponse {
  status: number;
  /**
   * Response entity body. Aligned with outgoing request rules in `serializeBody`
   * / `assertSupportedRequestBody`, except mock responses do not use `FormData`.
   *
   * Supported values (anything else throws when serialized):
   *
   * - `undefined` or omitted — no body
   * - `null` — no body
   * - `string` — UTF-8 bytes
   * - `Uint8Array` — raw bytes unchanged
   * - `ArrayBuffer` — copied to a `Uint8Array`
   * - plain object (`Object.prototype` or `null` prototype) — JSON
   * - array — JSON
   */
  body?: unknown;
  /**
   * Raw response headers. Use `set-cookie: string[]` for multiple cookies,
   * same as real HTTP. Merged with any entries from `cookies`.
   */
  headers?: Record<string, string | string[]>;
  contentType?: ContentType;
  /** Null or undefined uses the adapter default delay. */
  delay?: number | null;
  /**
   * Shorthand for setting / deleting cookies without writing raw Set-Cookie
   * strings. Merged with any `set-cookie` entries already in `headers`.
   *
   * - `string` → `name=value; Path=/` — session cookie (no expiry)
   * - `null` → `name=; Path=/; Max-Age=0` — deletes that same default
   *   root-scoped cookie
   * - `MockCookieOptions` → full control over path, domain, and attributes;
   *   when deleting one of these scoped cookies, the delete cookie must use
   *   the same identity (name + path + domain) and typically `maxAge: 0`
   */
  cookies?: Record<string, string | MockCookieOptions | null>;
  /**
   * Simulate a response-body failure that happens **after** headers arrive, so
   * consumers can test the `isStreamError` branch without a real socket.
   *
   * `status`, `headers` and cookies are reported as given, but `body` resolves as
   * `null` whatever the handler set and the response carries
   * `isStreamError: true`, which `HTTPClient` treats as terminal.
   *
   * Pass `true` for the default `'stream_response_error'`, or name the code.
   */
  streamError?: boolean | 'stream_write_error' | 'stream_response_error';
  /**
   * Simulate a failure that produced **no response at all** — a refused
   * connection, a name that did not resolve, a socket dropped before headers.
   *
   * Nothing from the handler's response is delivered: no body, headers, cookies,
   * or terminal progress. The response carries `isTransportError: true`.
   *
   * Pass `true` for a plain `status: 0` failure, or an object to exercise the
   * replay signals a real adapter would attach:
   *
   * ```ts
   * // Proven undelivered — a POST may be replayed
   * { status: 200, transportError: { wasDefinitelyNotSent: true } }
   *
   * // Delivery unknown — a POST is not replayed
   * { status: 200, transportError: true }
   *
   * // Nothing should retry this, whatever the method (a TLS failure)
   * { status: 200, transportError: { status: 495, isRetryable: false } }
   * ```
   */
  transportError?: boolean | MockTransportErrorOptions;
}

/** Shape of a simulated transport failure. See {@link MockResponse.transportError}. */
export interface MockTransportErrorOptions {
  /**
   * Diagnostic status to preserve, as adapters do for TLS failures (`495`).
   * Defaults to `0`, the ordinary "no response" status.
   */
  status?: number;
  /** Proof no request bytes reached the server. Authorizes replaying a write. */
  wasDefinitelyNotSent?: boolean;
  /** Set `false` for a failure no method should retry. */
  isRetryable?: boolean;
  /** Message for the generated `errorCause`. */
  message?: string;
}

export type MockRouteHandler = (
  request: MockRequest,
) => MockResponse | Promise<MockResponse>;

export interface MockAdapterConfig {
  /** Default latency in milliseconds; null or undefined uses zero. */
  defaultDelay?: number | null;
  /**
   * Called when a route handler throws or rejects. The original rejection reason
   * is preserved, including non-Error values, with or without an AbortSignal.
   * Return a `MockResponse` to customize
   * the error response — similar to Fastify's `setErrorHandler`. Falls back to
   * the default `{ status: 500, body: { message: 'Internal Server Error' } }`
   * if this handler is not set or if it also throws.
   *
   * Named `onHandlerError` rather than `onError` because it is not a reporting
   * callback, which is what `onError` means everywhere else in this library -
   * `FileSink.onError` and `NamedPipeSink.onError` are handed a failure and
   * return `void`. This one *produces the response*, so it decides the outcome
   * rather than observing it, and the shared name invited exactly the wrong
   * expectation. Its own failure is reported on the global `'error'` channel.
   */
  onHandlerError?: (
    req: MockRequest,
    error: unknown,
  ) => MockResponse | Promise<MockResponse>;
}

/**
 * Routes match on **path only** — the domain/host in the request URL is
 * stripped before matching. `http://api.test/users` and
 * `http://auth.test/users` both match a registered `/users` route.
 *
 * **Multiple domains** — use separate `MockAdapter` instances and assign
 * them to the root client and sub-clients respectively:
 *
 * ```ts
 * const apiMock = new MockAdapter();
 * const authMock = new MockAdapter();
 * const client = new HTTPClient({ adapter: apiMock, baseURL: 'https://api.test' });
 * const authClient = client.createSubClient({ adapter: authMock, baseURL: 'https://auth.test' });
 * ```
 *
 * **Cross-domain redirects** — redirects are followed by the same adapter
 * that initiated the request. Since domain is stripped, a redirect to
 * `https://auth.test/callback` will match a `/callback` route on the
 * originating adapter — no special setup needed for single-adapter setups.
 * For separate-adapter setups, register the redirect target path on the
 * originating adapter as well.
 */

export interface MockAdapterRoutes {
  get(path: string, handler: MockRouteHandler): void;
  post(path: string, handler: MockRouteHandler): void;
  put(path: string, handler: MockRouteHandler): void;
  patch(path: string, handler: MockRouteHandler): void;
  delete(path: string, handler: MockRouteHandler): void;
  head(path: string, handler: MockRouteHandler): void;
  options(path: string, handler: MockRouteHandler): void;
  /**
   * Register a route for any method Node's `http` knows - `TRACE`, WebDAV's `PROPFIND` or
   * `LOCK`, `PURGE` - in any case. A request's method is matched uppercased, as a real
   * server receives it from Node's `http`. Throws for a method name the router does not
   * know.
   */
  on(method: string, path: string, handler: MockRouteHandler): void;
  /** Remove all registered routes. */
  clear(): void;
}

/** The longest cookie lifetime a `Max-Age` is written with: 400 days (RFC 6265bis). */
const MAX_COOKIE_AGE_SECONDS = 400 * 24 * 60 * 60;

// find-my-way requires a handler function; the actual MockRouteHandler lives in store.
const noop: Router.Handler<Router.HTTPVersion.V1> = () => {};

export class MockAdapter implements HTTPAdapter {
  public readonly routes: MockAdapterRoutes;
  private readonly router: Router.Instance<Router.HTTPVersion.V1>;
  private readonly config: MockAdapterConfig;

  constructor(config?: MockAdapterConfig) {
    // Preserve inherited handlers, their receiver, and live config updates.
    // Validate now and again when a response selects the current default delay.
    this.config = config ?? {};
    resolveTimeoutMS(this.config.defaultDelay, 0, 'MockAdapter defaultDelay');

    this.router = Router({
      ignoreTrailingSlash: true,
      ignoreDuplicateSlashes: false,
      maxParamLength: 100,
    });

    this.routes = buildRoutes(this.router);
  }

  public getType(): AdapterType {
    return 'mock';
  }

  public async send(request: AdapterRequest): Promise<AdapterResponse> {
    // Guarded once, at the boundary, so every call site below is covered. Progress reporting is advisory and must not be able to
    // change whether a request succeeded; a throwing callback used to propagate out and be
    // classified as a transport failure. See `guardProgressCallback`.
    const guardedUploadProgress = guardProgressCallback(
      request.onUploadProgress,
      'onUploadProgress',
    );
    const guardedDownloadProgress = guardProgressCallback(
      request.onDownloadProgress,
      'onDownloadProgress',
    );

    const { requestURL, method, headers, body } = request;
    // Names lowercased, as a Node server receives them, so a request driven straight at
    // the adapter with `Content-Type` is read like one the client sent.
    const materializedHeaders = lowercaseHeaderNames(
      materializeRequestHeaders(headers),
    );
    // Headers every real server receives and the client does not set itself: `host`,
    // and a FormData body's multipart `content-type` (the boundary is the mock's own).
    if (!Object.hasOwn(materializedHeaders, 'host')) {
      try {
        defineEntry(materializedHeaders, 'host', new URL(requestURL).host);
      } catch {
        // A path-only URL driven straight at the adapter has no host to report.
      }
    }
    if (
      body instanceof FormData &&
      !Object.hasOwn(materializedHeaders, 'content-type')
    ) {
      defineEntry(
        materializedHeaders,
        'content-type',
        'multipart/form-data; boundary=----lifecycleion-mock-boundary',
      );
    }

    // --- 1. Pre-flight abort check ---
    // Throw immediately if the signal was already cancelled before we even start.
    if (request.signal?.aborted) {
      throwAbortError();
    }

    // Signal 0% upload — upload is instant for mock, but we fire the event so
    // progress listeners see the same shape they would from FetchAdapter.
    guardedUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

    // Again, as the real adapters do: a cancel from that callback ends the request before
    // the route handler runs, as it would before a real request was sent.
    if (request.signal?.aborted) {
      throwAbortError();
    }

    // --- 2. Parse URL ---
    // Strip host so routes match on path only — same behavior regardless of
    // whether the client passed an absolute URL (https://api.test/users) or a
    // path-only URL (/users). Falls back to manual splitting for path-only URLs
    // that `new URL()` would reject.
    let path: string;
    let queryString: string;

    try {
      const url = new URL(requestURL);
      path = url.pathname;
      queryString = url.search.slice(1);
    } catch {
      // Without its fragment, as `URL` drops it from `pathname` and `search`.
      const hashIdx = requestURL.indexOf('#');
      const withoutHash =
        hashIdx >= 0 ? requestURL.slice(0, hashIdx) : requestURL;
      const qIdx = withoutHash.indexOf('?');

      if (qIdx >= 0) {
        path = withoutHash.slice(0, qIdx);
        queryString = withoutHash.slice(qIdx + 1);
      } else {
        path = withoutHash;
        queryString = '';
      }
    }

    // --- 3. Route match & build MockRequest ---
    // qs handles nested bracket notation (e.g. ?where[active]=true).
    // cookies are pre-parsed from the `cookie` header for convenience —
    // the raw header is still available on req.headers.cookie.
    // As Express's extended query parser reads it - `qs.parse(query, { allowPrototypes:
    // true })`, the Express 4 default: a key named like
    // an `Object.prototype` member (`constructor`) is kept, `__proto__` is still dropped,
    // and qs's own limits apply as they do in production, so an array with more than 20
    // indices arrives as an object there and here alike.
    const query = qs.parse(queryString, {
      allowPrototypes: true,
    }) as QueryObject;
    const cookies = parseCookieHeader(materializedHeaders['cookie']);
    // Matched uppercased, as a real server sees it: Node's `http` sends any method it
    // knows uppercase, so `lock` arrives as `LOCK`. The router's own method type is a
    // fixed list; a method it does not know finds no route, as an unregistered path does.
    const routeMethod = method.toUpperCase();
    const match = this.router.find(routeMethod as RouterHTTPMethod, path);
    // Copied into a plain object: the router's own is a null-prototype `NullObject`,
    // which a route echoing `req.params` as its body had refused as an unsupported type.
    const params = { ...(match?.params ?? {}) } as Record<string, string>;

    const mockRequest: MockRequest = {
      method: routeMethod,
      path,
      params,
      query,
      headers: materializedHeaders,
      cookies,
      body:
        body instanceof FormData
          ? extractFormData(body)
          : parseRequestBody(body, materializedHeaders['content-type']),
    };

    // --- 4. Invoke handler ---
    // No registered route → default 404.
    // To customize the 404 body, register a wildcard route:
    //   adapter.routes.get('/*', (req) => ({ status: 404, body: { error: '...' } }))
    //
    // While if a handler throws -> onHandlerError (if set),
    // then falls back to default 500 if onHandlerError is unset or also throws.

    let mockResponse: MockResponse;
    // Which callback produced `mockResponse`, so a missing one names the right culprit.
    let responseSource: 'route' | 'onHandlerError' = 'route';

    if (match === null) {
      mockResponse = { status: 404, body: { message: 'Not Found' } };
    } else {
      const handler = match.store as MockRouteHandler;

      try {
        // Match real network semantics more closely: once the caller aborts,
        // stop waiting on an async mock handler and reject immediately.
        mockResponse = (
          await awaitAbortable(handler(mockRequest), request.signal)
        ).value;
      } catch (handlerError) {
        if (isInternalAbortError(handlerError)) {
          throwAbortError();
        }

        const onHandlerError = this.config.onHandlerError;
        if (onHandlerError) {
          responseSource = 'onHandlerError';
          try {
            mockResponse = (
              await awaitAbortable(
                Reflect.apply(onHandlerError, this.config, [
                  mockRequest,
                  handlerError,
                ]),
                request.signal,
              )
            ).value;
          } catch (error) {
            if (isInternalAbortError(error)) {
              throwAbortError();
            }

            // Said, not swallowed. The 500 is the right recovery - it mirrors what a real
            // server does when its own error handler fails - but it is also exactly what a
            // caller who configured no `onHandlerError` at all gets, so a broken `onHandlerError` was
            // indistinguishable from an absent one. In a test suite, which is the only
            // place this adapter runs, that is precisely the thing you want to be told.
            reportCallbackError('MockAdapter onHandlerError', error);

            mockResponse = {
              status: 500,
              body: { message: 'Internal Server Error' },
            };
          }
        } else {
          mockResponse = {
            status: 500,
            body: { message: 'Internal Server Error' },
          };
        }
      }
    }

    // The route has run: a handler that returned no response (a forgotten `return`) is a
    // mistake in the test's own setup, so it is not retried - a retry would only run the
    // route, and its side effects, again.
    if (typeof mockResponse !== 'object' || mockResponse === null) {
      const error = new TypeError(
        `MockAdapter ${responseSource} for ${method} ${path} returned no MockResponse (got ${mockResponse === null ? 'null' : typeof mockResponse})`,
      );
      markNonRetryableAdapterError(error);
      throw error;
    }

    // --- 5. Delay ---
    // Simulates network latency. Per-response delay takes priority over the
    // adapter default. When a signal is present, the sleep is abort-aware and
    // throws AbortError immediately instead of waiting out the full duration.
    const requestedDelay = mockResponse.delay;
    // Name the setting that was actually used, so a bad live `defaultDelay` update
    // is not blamed on a route that never set a delay.
    const isDefaultDelay =
      requestedDelay === undefined || requestedDelay === null;
    let delay: number;
    try {
      delay = resolveTimeoutMS(
        isDefaultDelay ? this.config.defaultDelay : requestedDelay,
        0,
        isDefaultDelay
          ? 'MockAdapter defaultDelay'
          : 'MockAdapter response delay',
      );
    } catch (error) {
      // The route has already run. Retrying a bad delay would repeat its side effects
      // without repairing the configuration. Only our validation error is terminal;
      // the caller-owned delay getter above keeps its usual adapter-error behavior.
      if (isTimeoutValidationError(error)) {
        markNonRetryableAdapterError(error);
      }
      throw error;
    }

    if (delay > 0) {
      // Use abort-aware sleep when a signal is present so cancellation throws
      // immediately rather than waiting for the full delay to elapse.
      if (request.signal) {
        await sleepAbortable(delay, request.signal);
      } else {
        await sleep(delay);
      }
    }

    // --- 6. Post-delay abort check ---
    // Catches cancellation when there was no delay (or delay was 0).
    if (request.signal?.aborted) {
      throwAbortError();
    }

    // A simulated transport failure never produced a response, so it returns
    // before any of the response-shaped work below — no body, no headers, no
    // cookies, and no terminal progress, exactly as a real one delivers none.
    if (mockResponse.transportError) {
      const options: MockTransportErrorOptions =
        mockResponse.transportError === true ? {} : mockResponse.transportError;

      return {
        status: options.status ?? 0,
        isTransportError: true,
        ...(options.isRetryable !== undefined
          ? { isRetryable: options.isRetryable }
          : {}),
        ...(options.wasDefinitelyNotSent !== undefined
          ? { wasDefinitelyNotSent: options.wasDefinitelyNotSent }
          : {}),
        headers: {},
        body: null,
        errorCause: new Error(
          options.message ??
            'Mock transport error (MockResponse.transportError)',
        ),
      };
    }

    // A status no server can send - Node's `writeHead` refuses one under 100 or past
    // 999 - is the route's mistake, not retried. `0` is not a status: use
    // `transportError` for a network failure.
    asRouteMistake(() => {
      const { status } = mockResponse;
      if (!Number.isInteger(status) || status < 100 || status > 999) {
        throw new TypeError(
          `MockAdapter route returned status ${String(status)}; a response status is an integer from 100 to 999 (use transportError for a network failure)`,
        );
      }
    });

    // A simulated post-header body failure loses the body the same way a real
    // one does, so the handler's body is never serialized.
    const simulatedStreamErrorCode = resolveMockStreamErrorCode(
      mockResponse.streamError,
    );

    // What the server would have put on the wire. HEAD / 204 / 205 / 304 never expose
    // a body to consumers, even if the handler returned one. This keeps the mock
    // transport aligned with real HTTP.
    // Not serialized at all under a simulated stream error, which loses it: a body the
    // mock could not serialize (a `Map`) failed the route as an `adapter_error` instead.
    let intendedBody: ReturnType<typeof serializeResponseBody> | null;
    try {
      intendedBody =
        shouldOmitResponseBody(method, mockResponse.status) ||
        simulatedStreamErrorCode !== undefined
          ? null
          : serializeResponseBody(mockResponse);
    } catch (error) {
      // A body the mock cannot serialize is the route's mistake, after it has run; not
      // retried, for the reason a bad delay is not.
      throw nonRetryableAdapterErrorFrom(error);
    }

    // A body past `maxResponseBytes` fails as the real adapters fail it: a stream error
    // that keeps the status and headers, the body dropped. A simulated stream error
    // already loses the body, so it stands as the route asked.
    // By the client's own rule (see `isAnsweredBodyOverLimit`), so the mock and the
    // client cannot disagree on which bodies the limit refuses.
    const maxResponseBytes = readMaxResponseBytes(request);
    const intendedByteLength =
      intendedBody === null ? 0 : (readBinaryByteLength(intendedBody) ?? 0);
    const isResponseTooLarge =
      simulatedStreamErrorCode === undefined &&
      intendedBody !== null &&
      isAnsweredBodyOverLimit(intendedBody, maxResponseBytes);
    const streamErrorCode: AdapterResponse['streamErrorCode'] =
      isResponseTooLarge ? 'response_too_large' : simulatedStreamErrorCode;

    // A simulated stream error loses the body, but it strikes after headers
    // arrived, so the headers still stand — Content-Type included, inferred below from
    // the route's body as it would have been sent.
    const responseBody = streamErrorCode !== undefined ? null : intendedBody;

    // --- 7. Build response headers ---
    const responseHeaders: AdapterResponse['headers'] = {
      ...(mockResponse.headers ?? {}),
    };

    // Merge cookies shorthand into set-cookie headers.
    // Entries from `cookies` are APPENDED after any existing `headers['set-cookie']`
    // entries — they are not overwritten. If both set the same cookie name, the
    // shorthand entry wins because it appears last (last Set-Cookie header for a
    // given name takes precedence in browsers and CookieJar).
    if (mockResponse.cookies) {
      const setCookieEntries = asRouteMistake(() =>
        cookiesToSetCookieHeaders(mockResponse.cookies ?? {}),
      );

      if (setCookieEntries.length > 0) {
        const existing = responseHeaders['set-cookie'];
        const existingArr =
          existing === undefined
            ? []
            : Array.isArray(existing)
              ? existing
              : [existing];
        responseHeaders['set-cookie'] = [...existingArr, ...setCookieEntries];
      }
    }

    // Auto-set content-type when handler didn't provide one.
    // Binary responses are intentionally skipped — content-type for binary is
    // format-specific (image/png, application/pdf, etc.) so the handler is
    // responsible for setting it via `headers` when it matters.
    // A HEAD response carries the content-type its GET would, body or no body.
    const hasRouteBody =
      intendedBody !== null ||
      ((routeMethod === 'HEAD' ||
        (simulatedStreamErrorCode !== undefined &&
          !shouldOmitResponseBody(method, mockResponse.status))) &&
        mockResponse.body !== undefined &&
        mockResponse.body !== null);
    if (!hasHeader(responseHeaders, 'content-type') && hasRouteBody) {
      const ct =
        mockResponse.contentType ?? inferContentType(mockResponse.body);

      if (ct === 'json') {
        responseHeaders['content-type'] = 'application/json';
      } else if (ct === 'text') {
        responseHeaders['content-type'] = 'text/plain';
      }
    }

    const normalizedResponseHeaders = asRouteMistake(() =>
      normalizeAdapterResponseHeaders(responseHeaders),
    );

    // After the headers are built and checked, as a real adapter has the headers before
    // any body progress: a route mistake found there does not follow a completed download.
    // Signal upload complete, then report download size based on serialised body.
    guardedUploadProgress?.(
      uploadCompleteEvent(knownBodyByteLength(request.body)),
    );

    // A simulated stream error reports no terminal download progress: real
    // adapters fail the body read before that point, so `progress: 1` here would
    // signal a completed download for a body that never arrived.
    if (streamErrorCode === undefined) {
      guardedDownloadProgress?.({
        loaded: responseBody === null ? 0 : intendedByteLength,
        total: responseBody === null ? 0 : intendedByteLength,
        progress: 1,
      });
    }

    const detectedRedirectURL = resolveDetectedRedirectURL(
      request.requestURL,
      mockResponse.status,
      normalizedResponseHeaders,
    );

    return {
      status: mockResponse.status,
      wasRedirectDetected: REDIRECT_STATUS_CODES.has(mockResponse.status),
      ...(detectedRedirectURL ? { detectedRedirectURL } : {}),
      headers: normalizedResponseHeaders,
      body: responseBody,
      ...(streamErrorCode !== undefined
        ? {
            isStreamError: true,
            streamErrorCode,
            errorCause: isResponseTooLarge
              ? makeResponseTooLargeError(maxResponseBytes, false)
              : new Error(
                  'Mock response stream error (MockResponse.streamError)',
                ),
          }
        : {}),
    };
  }
}

// --- Helpers ---

/**
 * Normalizes `MockResponse.streamError` to a `streamErrorCode`, or `undefined`
 * when no post-header body failure was requested.
 */
function resolveMockStreamErrorCode(
  streamError: MockResponse['streamError'],
): AdapterResponse['streamErrorCode'] {
  if (streamError === undefined || streamError === false) {
    return undefined;
  }

  return streamError === true ? 'stream_response_error' : streamError;
}

function buildRoutes(
  router: Router.Instance<Router.HTTPVersion.V1>,
): MockAdapterRoutes {
  function on(
    method: Router.HTTPMethod,
    path: string,
    handler: MockRouteHandler,
  ): void {
    try {
      router.on(method, path, noop, handler);
    } catch (error) {
      if (isDuplicateRouteRegistrationError(error)) {
        throw duplicateRouteRegistrationError(method, path, error);
      }

      throw error;
    }
  }

  return {
    get: (path, handler) => on('GET', path, handler),
    post: (path, handler) => on('POST', path, handler),
    put: (path, handler) => on('PUT', path, handler),
    patch: (path, handler) => on('PATCH', path, handler),
    delete: (path, handler) => on('DELETE', path, handler),
    head: (path, handler) => on('HEAD', path, handler),
    options: (path, handler) => on('OPTIONS', path, handler),
    on: (method, path, handler) =>
      on(method.toUpperCase() as Router.HTTPMethod, path, handler),
    clear: () => router.reset(),
  };
}

function isDuplicateRouteRegistrationError(error: unknown): error is Error {
  const message = readObjectMember(error, 'message');

  return (
    isErrorValue(error) &&
    typeof message === 'string' &&
    message.includes('already declared for route')
  );
}

function duplicateRouteRegistrationError(
  method: Router.HTTPMethod,
  path: string,
  cause: Error,
): Error {
  return new Error(
    `[MockAdapter] Duplicate route registration for ${method} ${path}. ` +
      'Routes must be unique per method and normalized path.',
    { cause },
  );
}

function parseCookieHeader(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }

  const cookies: Record<string, string> = {};

  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');

    if (eqIdx < 0) {
      continue;
    }

    const name = part.slice(0, eqIdx).trim();
    const value = decodeCookieValue(part.slice(eqIdx + 1).trim());

    // The first of a repeated name wins, as common server parsers (the `cookie` package
    // behind Express and Fastify) read it: the client sends the most specific path first.
    if (name && !Object.hasOwn(cookies, name)) {
      // Defined, not assigned: a `__proto__` cookie would otherwise vanish.
      defineEntry(cookies, name, value);
    }
  }

  return cookies;
}

function cookiesToSetCookieHeaders(
  cookies: Record<string, string | MockCookieOptions | null>,
): string[] {
  return Object.entries(cookies).map(([name, value]) => {
    // A `;` or `=` in a name, or a `;` in a value or attribute, would rewrite the line -
    // `abc; Domain=other.test` sets a Domain the route never asked for. A route mistake.
    assertCookieText(name, 'name', /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
    if (typeof value === 'string') {
      assertCookieText(value, 'value');
    } else if (value !== null) {
      assertCookieText(String(value.value), 'value');
      for (const attribute of ['path', 'domain'] as const) {
        const text = value[attribute];
        if (text !== undefined) {
          assertCookieText(text, attribute);
        }
      }
      // The two typed attributes, held to their types: a string in either was written
      // into the line as it was.
      const sameSite: unknown = value.sameSite;
      if (
        sameSite !== undefined &&
        sameSite !== 'Strict' &&
        sameSite !== 'Lax' &&
        sameSite !== 'None'
      ) {
        throw new TypeError(
          `MockAdapter cookie "${name}" sameSite must be 'Strict', 'Lax' or 'None'`,
        );
      }
      const maxAge: unknown = value.maxAge;
      if (maxAge !== undefined && typeof maxAge !== 'number') {
        throw new TypeError(
          `MockAdapter cookie "${name}" maxAge must be a number`,
        );
      }
    }
    // null pairs with the string shorthand above: both use Path=/.
    // Scoped deletes need explicit path/domain so the cookie identity matches.
    if (value === null) {
      return `${name}=; Path=/; Max-Age=0`;
    }

    // string → session cookie: no expiry, defaults to Path=/.
    if (typeof value === 'string') {
      return `${name}=${value}; Path=/`;
    }

    return serializeMockCookieOptions(name, value);
  });
}

function serializeMockCookieOptions(
  name: string,
  cookie: MockCookieOptions,
): string {
  const parts: string[] = [
    `${name}=${cookie.value}`,
    `Path=${cookie.path || '/'}`,
  ];

  // Whole seconds within the cookie lifetime cap (400 days, RFC 6265bis), as `Max-Age`
  // is read: a fraction, or a number too large to print as digits, would make the
  // cookie jar ignore the attribute, so `0.01` would never expire, `-0.5` would not
  // delete the cookie, and `Infinity` would leave a session cookie.
  const maxAge = cookie.maxAge;
  // A route mistake, not a cookie: `NaN` would print as `Max-Age=NaN`, which the jar
  // ignores, leaving a session cookie the route never asked for.
  if (typeof maxAge === 'number' && Number.isNaN(maxAge)) {
    throw new TypeError(`MockAdapter cookie "${name}" maxAge is NaN`);
  }
  appendCookieAttribute(
    parts,
    'Max-Age',
    typeof maxAge === 'number' && !Number.isNaN(maxAge)
      ? Math.max(
          -1,
          // Up for a positive fraction, so `0.5` is the short-lived cookie it asks for
          // rather than `Max-Age=0`, which deletes it; toward zero otherwise.
          Math.min(
            maxAge > 0 ? Math.ceil(maxAge) : Math.trunc(maxAge),
            MAX_COOKIE_AGE_SECONDS,
          ),
        )
      : maxAge,
  );
  appendCookieAttribute(parts, 'Domain', cookie.domain);

  if (cookie.httpOnly) {
    parts.push('HttpOnly');
  }

  if (cookie.secure) {
    parts.push('Secure');
  }

  appendCookieAttribute(parts, 'SameSite', cookie.sameSite);

  return parts.join('; ');
}

function appendCookieAttribute(
  parts: string[],
  name: string,
  value: number | string | undefined,
): void {
  if (value !== undefined && value !== '') {
    parts.push(`${name}=${value}`);
  }
}

function extractFormData(fd: FormData): MockFormData {
  const fields: Record<string, string> = {};
  const files: Record<string, File> = {};
  const allFields: Record<string, string[]> = {};
  const allFiles: Record<string, File[]> = {};

  for (const [key, value] of fd.entries()) {
    // Defined, not assigned: a `__proto__` field would otherwise vanish, and a
    // `__proto__` file would become the record's prototype.
    if (typeof value === 'string') {
      defineEntry(fields, key, value);
      defineEntry(allFields, key, [
        ...(Object.hasOwn(allFields, key) ? allFields[key] : []),
        value,
      ]);
    } else {
      defineEntry(files, key, value);
      defineEntry(allFiles, key, [
        ...(Object.hasOwn(allFiles, key) ? allFiles[key] : []),
        value,
      ]);
    }
  }

  return { fields, files, allFields, allFiles };
}

function parseRequestBody(
  body: string | Uint8Array | null | undefined,
  contentType: string | undefined,
): unknown {
  if (body === null || body === undefined) {
    return undefined;
  }

  const parsedContentType = parseContentType(contentType);

  if (body instanceof Uint8Array) {
    // Keep opaque bytes intact so mock handlers can inspect binary payloads
    // like uploads or octet-stream requests without lossy text decoding.
    if (parsedContentType === 'binary') {
      return body;
    } else if (parsedContentType === 'json') {
      // JSON requests arrive as bytes from the adapter layer, so decode first
      // and then match the client response path by attempting JSON.parse().
      const text = new TextDecoder().decode(body);

      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } else if (parsedContentType === 'text') {
      // Text-like bodies should be exposed to mock handlers as plain strings.
      return new TextDecoder().decode(body);
    }
  } else if (parsedContentType === 'json') {
    // String bodies can still declare JSON; parse when possible but preserve
    // the original string if the payload is invalid JSON.
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }

  // Plain strings with non-JSON content types are already in the desired form.
  return body;
}

function serializeResponseBody(response: MockResponse): Uint8Array | null {
  const { body } = response;

  if (body === undefined || body === null) {
    return null;
  } else if (body instanceof Uint8Array) {
    // Avoid JSON.stringify indexing the buffer into {"0":…,"1":…}.
    return body;
  } else if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  } else if (typeof body === 'string') {
    return new TextEncoder().encode(body);
  } else if (Array.isArray(body) || isPlainJSONBodyObject(body)) {
    return new TextEncoder().encode(JSON.stringify(body));
  }

  throw new Error(
    'Unsupported mock response body type. Supported types: string, Uint8Array, ArrayBuffer, plain object, array, null, and undefined.',
  );
}

function inferContentType(body: unknown): ContentType {
  if (typeof body === 'string') {
    return 'text';
  } else if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    return 'binary';
  } else {
    return 'json';
  }
}

function hasHeader(
  headers: Record<string, string | string[]>,
  name: string,
): boolean {
  const lowerName = lowerCaseHeaderName(name);
  return Object.keys(headers).some((k) => lowerCaseHeaderName(k) === lowerName);
}

class InternalMockAbortError extends Error {
  constructor() {
    super('The operation was aborted.');
    this.name = 'AbortError';
  }
}

function isInternalAbortError(error: unknown): error is InternalMockAbortError {
  try {
    return error instanceof InternalMockAbortError;
  } catch {
    // Rejection reasons can be proxies whose prototype inspection throws.
    return false;
  }
}

function throwAbortError(): never {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  throw err;
}

function lowercaseHeaderNames(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // ASCII only, as `materializeRequestHeaders` grouped them: `toLowerCase` folded a
    // Kelvin-sign name into a real one.
    const lower = lowerCaseHeaderName(key);
    // Own entries only: `constructor` and `__proto__` are headers here, not members.
    const existing = Object.hasOwn(result, lower) ? result[lower] : undefined;
    defineEntry(
      result,
      lower,
      existing === undefined
        ? value
        : `${existing}${lower === 'cookie' ? '; ' : ', '}${value}`,
    );
  }
  return result;
}

function shouldOmitResponseBody(method: string, status: number): boolean {
  return !hasResponseBody(method, status);
}

function awaitAbortable<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<PromiseResultBox<Awaited<T>>> {
  // `adoptPromise()`, not `Promise.resolve()`, for a handler's promise here and below:
  // `Promise.resolve()` hands a native promise back with its own `then`, and a no-op one
  // would hang the request.
  const adopted = adoptPromise(value);
  if (!signal) {
    return adopted;
  }

  return new Promise<PromiseResultBox<Awaited<T>>>((resolve, reject) => {
    // Guarded: a signal that is not a native `AbortSignal` may refuse the removal, and
    // a throw from the reactions below would reject their derived promise - unhandled
    // - and leave this wait settled by nothing.
    const detach = (): void => {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // The listener stays, and is inert: the wait it ends has already settled.
      }
    };

    // Cancellation should reject immediately with AbortError, even if the
    // wrapped handler/onHandlerError promise is still pending.
    const onAbort = () => {
      detach();
      reject(new InternalMockAbortError());
    };

    // Observed before anything else here can throw. A signal whose
    // `addEventListener` throws rejects this wait from the executor, and the
    // handler's promise, not yet observed, would then be an unhandled rejection.
    observeRejection(
      adopted.then(
        (result) => {
          detach();
          // Cancellation changes the wait, not adoption of the handler's data, which
          // stays boxed.
          resolve(result);
        },
        (error: unknown) => {
          detach();
          // onHandlerError receives the original reason with or without a signal.
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          reject(error);
        },
      ),
      () => undefined,
    );

    signal.addEventListener('abort', onAbort, { once: true });

    // A handler can abort synchronously before returning its promise. Observe
    // that promise before ending the wait so its rejection is still consumed.
    let isAborted: boolean;

    try {
      isAborted = signal.aborted;
    } catch (error) {
      // The executor rejects with this, and nothing will settle the wait again, so the
      // listener just attached is removed rather than left on the signal for good.
      detach();
      throw error;
    }

    if (isAborted) {
      onAbort();
    }
  });
}

/**
 * Like `sleep()` but throws AbortError immediately if the signal fires during
 * the delay rather than waiting for the full duration to elapse. Cleans up
 * both the timer and the abort listener to avoid leaks.
 */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw new InternalMockAbortError();
  }

  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(id);
      reject(new InternalMockAbortError());
    };

    const id = setTimeout(() => {
      // Resolved first and the removal guarded: this runs from a timer, where a throw
      // from a non-native signal's `removeEventListener` is an uncaught exception.
      resolve();
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
        // The listener stays, and is inert: the sleep has already ended.
      }
    }, ms);

    try {
      signal.addEventListener('abort', onAbort, { once: true });
    } catch (error) {
      // The executor rejects with this; the timer has nothing left to end.
      clearTimeout(id);
      throw error;
    }
  });
}

/**
 * Run a step that reads what the route returned, failing it as the route's mistake -
 * non-retryable, as a missing response is - so a retry does not run the route again.
 */
function asRouteMistake<R>(step: () => R): R {
  try {
    return step();
  } catch (error) {
    throw nonRetryableAdapterErrorFrom(error);
  }
}

/**
 * Throw when `text` would change a `Set-Cookie` line's framing, fails `pattern`, or holds a
 * character above U+00FF, which a real server's `setHeader` refuses and the jar drops.
 */
function assertCookieText(text: string, part: string, pattern?: RegExp): void {
  // eslint-disable-next-line no-control-regex -- control characters are what is refused
  const isUnsafe = /[;\u0000-\u001f\u007f\u0100-\uffff]/.test(text);
  if (isUnsafe || (pattern !== undefined && !pattern.test(text))) {
    throw new TypeError(
      `MockAdapter cookie ${part} ${JSON.stringify(text)} cannot be written into a Set-Cookie line`,
    );
  }
}

/** A cookie value as the `cookie` package reads it: unquoted, then percent-decoded. */
function decodeCookieValue(raw: string): string {
  const unquoted =
    raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
  if (!unquoted.includes('%')) {
    return unquoted;
  }
  try {
    return decodeURIComponent(unquoted);
  } catch {
    return unquoted;
  }
}
