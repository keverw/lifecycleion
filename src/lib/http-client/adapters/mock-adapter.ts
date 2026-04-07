import Router from 'find-my-way';
import qs from 'qs';
import { sleep } from '../../sleep';
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

export interface MockFormData {
  /** String fields from the multipart body */
  fields: Record<string, string>;
  /** File fields from the multipart body */
  files: Record<string, File>;
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
  delay?: number;
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
}

export type MockRouteHandler = (
  request: MockRequest,
) => MockResponse | Promise<MockResponse>;

export interface MockAdapterConfig {
  defaultDelay?: number;
  /**
   * Called when a route handler throws. Return a `MockResponse` to customize
   * the error response — similar to Fastify's `setErrorHandler`. Falls back to
   * the default `{ status: 500, body: { message: 'Internal Server Error' } }`
   * if this handler is not set or if it also throws.
   */
  onError?: (
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
  /** Remove all registered routes. */
  clear(): void;
}

// find-my-way requires a handler function; the actual MockRouteHandler lives in store.
const noop: Router.Handler<Router.HTTPVersion.V1> = () => {};

export class MockAdapter implements HTTPAdapter {
  public readonly routes: MockAdapterRoutes;
  private readonly router: Router.Instance<Router.HTTPVersion.V1>;
  private readonly config: MockAdapterConfig;

  constructor(config?: MockAdapterConfig) {
    this.config = config ?? {};

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
    const { requestURL, method, headers, body } = request;
    const materializedHeaders = materializeMockRequestHeaders(headers);

    // --- 1. Pre-flight abort check ---
    // Throw immediately if the signal was already cancelled before we even start.
    if (request.signal?.aborted) {
      throwAbortError();
    }

    // Signal 0% upload — upload is instant for mock, but we fire the event so
    // progress listeners see the same shape they would from FetchAdapter.
    request.onUploadProgress?.({ loaded: 0, total: 0, progress: 0 });

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
      const qIdx = requestURL.indexOf('?');

      if (qIdx >= 0) {
        path = requestURL.slice(0, qIdx);
        queryString = requestURL.slice(qIdx + 1);
      } else {
        path = requestURL;
        queryString = '';
      }
    }

    // --- 3. Route match & build MockRequest ---
    // qs handles nested bracket notation (e.g. ?where[active]=true).
    // cookies are pre-parsed from the `cookie` header for convenience —
    // the raw header is still available on req.headers.cookie.
    const query = qs.parse(queryString) as QueryObject;
    const cookies = parseCookieHeader(materializedHeaders['cookie']);
    const match = this.router.find(method as Router.HTTPMethod, path);
    const params = (match?.params ?? {}) as Record<string, string>;

    const mockRequest: MockRequest = {
      method,
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
    // While if a handler throws → onError (if set),
    // then falls back to default 500 if onError is unset or also throws.

    let mockResponse: MockResponse;

    if (match === null) {
      mockResponse = { status: 404, body: { message: 'Not Found' } };
    } else {
      const handler = match.store as MockRouteHandler;

      try {
        // Match real network semantics more closely: once the caller aborts,
        // stop waiting on an async mock handler and reject immediately.
        mockResponse = await awaitAbortable(
          handler(mockRequest),
          request.signal,
        );
      } catch (handlerError) {
        if (isInternalAbortError(handlerError)) {
          throwAbortError();
        }

        if (this.config.onError) {
          try {
            mockResponse = await awaitAbortable(
              this.config.onError(mockRequest, handlerError),
              request.signal,
            );
          } catch (error) {
            if (isInternalAbortError(error)) {
              throwAbortError();
            }

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

    // --- 5. Delay ---
    // Simulates network latency. Per-response delay takes priority over the
    // adapter default. When a signal is present, the sleep is abort-aware and
    // throws AbortError immediately instead of waiting out the full duration.
    const delay = mockResponse.delay ?? this.config.defaultDelay ?? 0;

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

    // HEAD / 204 / 304 never expose a body to consumers, even if the handler
    // returned one. This keeps the mock transport aligned with real HTTP.
    const responseBody = shouldOmitResponseBody(method, mockResponse.status)
      ? null
      : serializeResponseBody(mockResponse);

    // Signal upload complete, then report download size based on serialised body.
    request.onUploadProgress?.({ loaded: 1, total: 1, progress: 1 });

    request.onDownloadProgress?.({
      loaded: responseBody?.length ?? 0,
      total: responseBody?.length ?? 0,
      progress: 1,
    });

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
      const setCookieEntries = cookiesToSetCookieHeaders(mockResponse.cookies);

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
    if (!hasHeader(responseHeaders, 'content-type') && responseBody !== null) {
      const ct =
        mockResponse.contentType ?? inferContentType(mockResponse.body);

      if (ct === 'json') {
        responseHeaders['content-type'] = 'application/json';
      } else if (ct === 'text') {
        responseHeaders['content-type'] = 'text/plain';
      }
    }

    const normalizedResponseHeaders =
      normalizeAdapterResponseHeaders(responseHeaders);

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
    };
  }
}

// --- Helpers ---

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
    clear: () => router.reset(),
  };
}

function isDuplicateRouteRegistrationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    error.message.includes('already declared for route')
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
    const value = part.slice(eqIdx + 1).trim();

    if (name) {
      cookies[name] = value;
    }
  }

  return cookies;
}

function materializeMockRequestHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    result[key] = Array.isArray(value)
      ? key.toLowerCase() === 'cookie'
        ? value.join('; ')
        : value.join(', ')
      : value;
  }

  return result;
}

function cookiesToSetCookieHeaders(
  cookies: Record<string, string | MockCookieOptions | null>,
): string[] {
  return Object.entries(cookies).map(([name, value]) => {
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
    `Path=${cookie.path ?? '/'}`,
  ];

  appendCookieAttribute(parts, 'Max-Age', cookie.maxAge);
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

  for (const [key, value] of fd.entries()) {
    if (typeof value === 'string') {
      fields[key] = value;
    } else {
      files[key] = value;
    }
  }

  return { fields, files };
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
  return Object.keys(headers).some(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
}

class InternalMockAbortError extends Error {
  constructor() {
    super('The operation was aborted.');
    this.name = 'AbortError';
  }
}

function isInternalAbortError(error: unknown): error is InternalMockAbortError {
  return error instanceof InternalMockAbortError;
}

function throwAbortError(): never {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  throw err;
}

function shouldOmitResponseBody(method: string, status: number): boolean {
  return method === 'HEAD' || status === 204 || status === 304;
}

function awaitAbortable<T>(
  value: T | Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return Promise.resolve(value);
  }

  if (signal.aborted) {
    throw new InternalMockAbortError();
  }

  return new Promise<T>((resolve, reject) => {
    // Cancellation should reject immediately with AbortError, even if the
    // wrapped handler/onError promise is still pending.
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new InternalMockAbortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });

    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        // Preserve real handler failures, only normalize non-Error rejections
        // so promise rejection values stay lint-safe and predictable.
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
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
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
