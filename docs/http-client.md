# http-client

A TypeScript HTTP client with a fluent request builder, request/response interceptors and observers, automatic retries, cookie management, and redirect control. Ships with Fetch, Node.js native, XHR, and Mock adapters.

<!-- toc -->

- [Import Paths](#import-paths)
- [Quick Start](#quick-start)
- [HTTPClient Configuration](#httpclient-configuration)
- [Making Requests](#making-requests)
  - [HTTP Methods](#http-methods)
  - [Request Builder API](#request-builder-api)
  - [Body Types](#body-types)
  - [Query Parameters](#query-parameters)
- [HTTPResponse](#httpresponse)
  - [Content-Type Detection and Body Parsing](#content-type-detection-and-body-parsing)
- [Error Handling](#error-handling)
  - [HTTPClientError](#httpclienterror)
  - [Error Codes](#error-codes)
- [Request Interceptors](#request-interceptors)
  - [Filter Options](#filter-options)
  - [Cancelling from an Interceptor](#cancelling-from-an-interceptor)
  - [Interceptor Context](#interceptor-context)
- [Response Observers](#response-observers)
  - [Filter Options](#filter-options-1)
- [Error Observers](#error-observers)
  - [Filter Options](#filter-options-2)
- [Phase Model](#phase-model)
- [Retry Policy](#retry-policy)
  - [Retryable Status Codes](#retryable-status-codes)
  - [Per-Request Override](#per-request-override)
- [Cookie Jar](#cookie-jar)
  - [CookieJar API](#cookiejar-api)
- [Redirect Handling](#redirect-handling)
  - [Method Rewriting Rules](#method-rewriting-rules)
  - [Redirect Phase Info](#redirect-phase-info)
- [Request Cancellation](#request-cancellation)
  - [Builder-Scoped Cancel](#builder-scoped-cancel)
  - [ID-Scoped Cancel](#id-scoped-cancel)
  - [Tracker-Wide Cancel](#tracker-wide-cancel)
  - [AbortSignal Integration](#abortsignal-integration)
- [Client Identity](#client-identity)
- [Request Tracking](#request-tracking)
- [Sub-Client Creation](#sub-client-creation)
- [Enable and Disable](#enable-and-disable)
- [Progress Events](#progress-events)
- [Adapters](#adapters)
  - [FetchAdapter (default)](#fetchadapter-default)
  - [NodeAdapter](#nodeadapter)
  - [XHRAdapter](#xhradapter)
  - [MockAdapter (testing)](#mockadapter-testing)
- [Streaming Responses](#streaming-responses)
- [Builder Post-Send Accessors](#builder-post-send-accessors)
- [Request State Values](#request-state-values)
- [Headers](#headers)
- [Exported Types](#exported-types)
- [Exported Constants](#exported-constants)

<!-- tocstop -->

## Import Paths

The HTTP client is split across four subpath exports to keep browser bundles lean.

```typescript
// Core: HTTPClient, CookieJar, FetchAdapter, all types, all constants
import { HTTPClient, CookieJar, FetchAdapter } from 'lifecycleion/http-client';

// Node.js native adapter (Node.js only)
import { NodeAdapter } from 'lifecycleion/http-client-node';
import type { NodeAdapterConfig } from 'lifecycleion/http-client-node';

// XHR adapter (browser only)
import { XHRAdapter } from 'lifecycleion/http-client-xhr';

// Mock adapter (testing)
import { MockAdapter } from 'lifecycleion/http-client-mock';
import type {
  MockAdapterConfig,
  MockRequest,
  MockResponse,
} from 'lifecycleion/http-client-mock';
```

## Quick Start

```typescript
import { HTTPClient } from 'lifecycleion/http-client';

const client = new HTTPClient({
  baseURL: 'https://api.example.com',
  timeout: 10_000, // ms
});

// GET with typed response
const response = await client
  .get<{ id: number; name: string }>('/users/1')
  .send();

console.log(response.status); // 200
console.log(response.body); // { id: 1, name: '...' }

// POST with JSON body
const created = await client
  .post('/users')
  .json({ name: 'Alice', email: 'alice@example.com' })
  .send();

console.log(created.status); // 201
```

## HTTPClient Configuration

```typescript
interface HTTPClientConfig {
  adapter?: HTTPAdapter; // Default: FetchAdapter
  baseURL?: string; // Origin / prefix for relative paths. If set, MockAdapter, NodeAdapter, and server-side FetchAdapter require an absolute http(s):// URL.
  defaultHeaders?: Record<string, string | string[]>;
  timeout?: number; // Default: 30,000 ms; <= 0 disables the per-attempt timeout
  cookieJar?: CookieJar | null; // Cookie management (null disables)
  retryPolicy?: RetryPolicyOptions; // Retry strategy (disabled by default)
  includeRequestID?: boolean; // Default: false — sends x-local-client-request-id header
  includeAttemptHeader?: boolean; // Default: false — sends x-local-client-request-attempt header with the 1-based attempt number as a decimal string. The counter is global across redirect hops: attempt 2 on a redirect hop follows attempt 1 on the initial request, not reset per hop.
  userAgent?: string; // Auto-set to 'lifecycleion-http-client' for NodeAdapter and MockAdapter, and for FetchAdapter on server runtimes. Browsers block this header — constructor throws if set with FetchAdapter or XHRAdapter in a browser.
  followRedirects?: boolean; // Default: false (security-conscious default)
  maxRedirects?: number; // Default: 5 (only meaningful when followRedirects: true; throws at construction unless followRedirects: true; must be >= 1)
}
```

```typescript
const client = new HTTPClient({
  baseURL: 'https://api.example.com',
  defaultHeaders: { 'x-api-version': '2024-01' },
  timeout: 15_000,
  followRedirects: true,
  retryPolicy: {
    strategy: 'exponential',
    maxRetryAttempts: 3,
    minTimeoutMS: 500,
  },
});
```

**Platform constraints:**

| Feature           | Browser + FetchAdapter | Browser + XHRAdapter | Server + FetchAdapter | Server + NodeAdapter | MockAdapter |
| ----------------- | ---------------------- | -------------------- | --------------------- | -------------------- | ----------- |
| `cookieJar`       | Not supported          | Not supported        | Supported             | Supported            | Supported   |
| `userAgent`       | Not supported          | Not supported        | Supported             | Supported            | Supported   |
| `followRedirects` | Not supported          | Not supported        | Supported             | Supported            | Supported   |

The constructor throws immediately on unsupported combinations so failures are caught at startup, not at request time.

## Making Requests

### HTTP Methods

All methods return an `HTTPRequestBuilder<T>`. Call `.send()` to execute.

```typescript
client.get<T>(path, options?)
client.post<T>(path, options?)
client.put<T>(path, options?)
client.patch<T>(path, options?)
client.delete<T>(path, options?)
client.head<T>(path, options?)

// Generic method
client.request<T>(method, path, options?)
```

**Path resolution:**

- Relative paths (`/v1/users`, `v1/users`) are appended to `baseURL`.
- Absolute `http(s)://` URLs bypass `baseURL` entirely and work with or without a `baseURL`.
- Protocol-relative `//host/path` URLs also bypass `baseURL` as a path prefix. If `baseURL` is configured, they are resolved using its scheme. If `baseURL` is omitted, browser runtimes resolve them against the current page/worker scheme, `MockAdapter` materializes them as `http://host/...`, and other server-side adapters cannot resolve them so the request fails at send time as a configuration error.

All paths are resolved as far as possible before interceptors, the cookie jar, or any adapter sees them. For the real transport adapters (`fetch`, `xhr`, `node`) that means an absolute `http(s)://` URL. For `MockAdapter`, requests without a client `baseURL` are resolved before interceptors run using deterministic mock defaults: true path-only inputs become `http://localhost/...`, and protocol-relative inputs (`//host/...`) become `http://host/...`. Other unresolved non-HTTP inputs still fail during request setup.

For `MockAdapter`, those resolved URLs are used for features that inspect the resolved URL, such as host/scheme filters and shared `CookieJar` state. If you want mock clients to use different default origins, use distinct cookie jars, protocol-relative request URLs, or give each client an explicit absolute `baseURL`.

### Request Builder API

All builder methods are fluent (chainable) and must be called **before** `.send()`. The builder is single-use: calling `.send()` a second time throws.

```typescript
const builder = client
  .post<User>('/users')
  .headers({ 'x-idempotency-key': 'abc123' }) // merged onto defaultHeaders
  .json({ name: 'Alice' }) // sets a JSON body; content-type is inferred during request materialization
  .timeout(5_000) // per-request timeout override
  .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1000 }) // per-request retry override
  .label('create-user') // non-empty grouping label for cancel/list filtering
  .params({ source: 'web' }) // appended to query string
  .onUploadProgress((e) => console.log(e))
  .onDownloadProgress((e) => console.log(e))
  .onAttemptStart((e) => console.log(e))
  .onAttemptEnd((e) => console.log(e))
  .signal(controller.signal) // external AbortSignal, composed with builder.cancel()
  .streamResponse((info, ctx) => writable); // NodeAdapter only — pipe response body to a writable stream

const response = await builder.send();
```

Options can also be passed directly to the method call:

```typescript
const response = await client
  .post<User>('/users', {
    headers: { 'x-idempotency-key': 'abc123' },
    body: { name: 'Alice' },
    timeout: 5_000,
  })
  .send();
```

### Body Types

| Method / value       | Content-Type set                     | Notes                                                                                                                                                                                                                           |
| -------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.json(data)`        | `application/json`                   | Serialized via `JSON.stringify`. Passing `null` or `undefined` results in no body (see note below).                                                                                                                             |
| `.text(str)`         | `text/plain`                         | UTF-8 encoded                                                                                                                                                                                                                   |
| `.formData(fd)`      | _(none, set by adapter)_             | The library does not set this header. The adapter, or browser runtime, sets `multipart/form-data` with the boundary. Not visible in `request.headers` inside interceptors. Use `request.body instanceof FormData` to detect it. |
| `.body(data)`        | Inferred from value type (see below) | Generic form. Accepts JSON objects/arrays (`application/json`), strings (`text/plain`), Uint8Array (`application/octet-stream`), FormData (see `.formData`), null, or undefined                                                 |
| `undefined` / `null` | none                                 | No body sent                                                                                                                                                                                                                    |

> **Note:** Passing `null` or `undefined` to any body method, including `.json()`, always results in no body and no `Content-Type`. This applies across all methods since serialization is type-based, not method-based. If you need to send a JSON null payload, use `.body('null').headers({ 'content-type': 'application/json' })` explicitly.

### Query Parameters

Parameters passed via `.params()` are merged into the URL query string using the `qs` library, which supports nested objects and arrays.

```typescript
client
  .get('/search')
  .params({ q: 'hello', filter: { active: true }, tags: ['a', 'b'] })
  .send();
// → /search?q=hello&filter%5Bactive%5D=true&tags%5B0%5D=a&tags%5B1%5D=b
```

Existing query strings in the path are preserved and merged. When the same key appears in both the path string and `.params()`, the `.params()` value wins.

## HTTPResponse

```typescript
interface HTTPResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[]>; // Lowercase keys; set-cookie is always string[]
  body: T; // Parsed or raw — see below
  contentType: 'json' | 'text' | 'binary';
  isJSON: boolean;
  isText: boolean;
  isCancelled: boolean;
  isTimeout: boolean;
  isNetworkError: boolean;
  isFailed: boolean; // true for client-level failures (timeouts, network errors, etc.)
  // false for ordinary HTTP errors like 4xx/5xx
  isParseError: boolean;
  initialURL: string; // URL after initial interceptors, before any redirect hops
  requestURL: string; // URL of the last adapter attempt, or the redirect target if redirect handling failed before the follow-up was dispatched
  wasRedirectDetected: boolean;
  wasRedirectFollowed: boolean;
  detectedRedirectURL?: string;
  redirectHistory: string[]; // Redirect target URLs recorded during redirect handling, in order; entries may appear before the follow-up attempt is dispatched, and a continued redirect rewrite updates later entries to the rewritten target
  requestID: string;
  adapterType: AdapterType;
  isStreamed: boolean; // Body was piped to a StreamResponseFactory; body is null
  isStreamError: boolean; // Body delivery failed after headers arrived
}
```

`isFailed` is `true` only for client-level transport failures. A 404 or 500 HTTP response has `isFailed: false` (the server responded and returned a status code).

### Content-Type Detection and Body Parsing

The response `Content-Type` header determines how the body is parsed:

| Content-Type value                     | `contentType` | Body type                 |
| -------------------------------------- | ------------- | ------------------------- |
| Contains `application/json` or `+json` | `'json'`      | Parsed via `JSON.parse()` |
| Starts with `text/`                    | `'text'`      | UTF-8 decoded string      |
| `application/x-www-form-urlencoded`    | `'text'`      | UTF-8 decoded string      |
| Absent or anything else                | `'binary'`    | Raw `Uint8Array`          |

`isText` mirrors `contentType === 'text'`. `isJSON` is `true` only when JSON parsing actually succeeded, and it stays `false` on a parse failure. `isParseError` is `true` when the server sent a JSON `Content-Type` but the body could not be parsed. In that case `contentType` is still `'json'`, `isJSON` is `false`, and `body` falls back to the raw string.

## Error Handling

`send()` always resolves for request outcomes handled by the client runtime. HTTP errors (4xx/5xx), timeouts, cancels, transport failures, redirect control-flow failures, and other client-managed failure states all produce a settled `HTTPResponse` with no exception. Check `response.isFailed` for client-level failures and `response.status` for HTTP errors.

`send()` rejects (returns a rejected promise) only for programming errors around builder/client usage: calling it on a disabled client, calling it a second time on the same builder, or calling it after `builder.cancel()` was already called pre-send.

```typescript
const builder = client.get('/users/999');
const response = await builder.send();

if (response.isFailed) {
  // Client-level failure (timeout, cancelled, network error, redirect handling failure, etc.)
  const err = builder.error; // HTTPClientError
  console.log(err.code, err.message);
} else if (response.status === 404) {
  console.log('Not found');
} else if (response.status >= 200 && response.status < 300) {
  console.log(response.body);
}
```

### HTTPClientError

When a request settles through the client's failure path the builder's `.error` property is set. This includes transport failures as well as client-managed failures such as request setup errors, interceptor errors, redirect control-flow failures, and stream setup failures:

```typescript
interface HTTPClientError {
  code: ErrorCode; // See error codes below
  message: string;
  cause?: Error; // Underlying error when available
  initialURL: string;
  requestURL: string; // URL of the last adapter attempt, or the redirect target if redirect handling failed before the follow-up was dispatched
  wasRedirectDetected: boolean;
  wasRedirectFollowed: boolean;
  detectedRedirectURL?: string;
  redirectHistory: string[]; // Redirect target URLs recorded during redirect handling, in order
  requestID: string;
  isTimeout: boolean;
  isRetriesExhausted: boolean; // true when all retry attempts were spent
  cancelReason?: string; // set when cancelled with an explicit string reason — via builder.cancel('reason'), client.cancel(id, 'reason'), client.cancelAll/Own/WithLabel('reason'), controller.abort('reason'), or an interceptor/stream factory cancel
}
```

### Error Codes

| Code                    | Meaning                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network_error`         | Transport-level failure before a response was received                                                                                                         |
| `timeout`               | Request exceeded the configured timeout                                                                                                                        |
| `cancelled`             | Request was cancelled via `builder.cancel()`, `client.cancel()`, AbortSignal, or an interceptor/stream factory cancel                                          |
| `redirect_disabled`     | A redirect response was received but `followRedirects` is `false`                                                                                              |
| `redirect_loop`         | The configured `maxRedirects` limit was reached                                                                                                                |
| `request_setup_error`   | Request setup or local orchestration failure before a normal adapter response was produced (e.g. invalid configuration, unsupported body type, unresolved URL) |
| `adapter_error`         | The adapter threw an unexpected error                                                                                                                          |
| `interceptor_error`     | A request interceptor threw                                                                                                                                    |
| `stream_write_error`    | Writing chunks to the StreamResponseFactory writable failed                                                                                                    |
| `stream_response_error` | The upstream response stream errored after headers arrived                                                                                                     |
| `stream_setup_error`    | The StreamResponseFactory threw an error during setup                                                                                                          |

## Request Interceptors

Interceptors run **before** an adapter attempt and can mutate the outgoing request (headers, URL, body) or cancel it entirely. They are the right place for auth token injection, URL rewriting, or pre-flight validation.

```typescript
// Remove a previously added interceptor by calling the returned function
const removeInterceptor = client.addRequestInterceptor(
  (request, phase, context) => {
    return {
      ...request,
      headers: {
        ...request.headers,
        authorization: `Bearer ${getToken()}`,
      },
    };
  },
  { phases: ['initial', 'retry'] }, // default: ['initial']
);

// Later: removeInterceptor()
```

The interceptor receives the request and must return the (mutated) request, an `InterceptorCancel` to abort it, or `null` as shorthand for cancelling without a reason:

```typescript
type RequestInterceptor = (
  request: InterceptedRequest,
  phase: InterceptorPhase,
  context: RequestInterceptorContext,
) =>
  | InterceptedRequest
  | InterceptorCancel
  | null
  | Promise<InterceptedRequest | InterceptorCancel | null>;

// Cancel without a reason (null shorthand)
client.addRequestInterceptor(() => null);

// Cancel with a reason surfaced on HTTPClientError.cancelReason
client.addRequestInterceptor((req) => {
  if (!req.headers['authorization']) {
    return { cancel: true, reason: 'auth_missing' };
  }
  return req;
});

interface InterceptedRequest {
  requestURL: string; // Absolute before dispatch
  method: HTTPMethod;
  headers: Record<string, string | string[]>;
  body?: unknown; // Pre-serialization
}
```

When rewriting `requestURL`, always produce an absolute `http:` or `https:` URL. This applies to `MockAdapter` too. The client may materialize an absolute URL for you before interceptors run (for example via `baseURL`, browser resolution, or MockAdapter's synthetic `http://...` fallback), but interceptor outputs themselves must stay absolute.

To change just the path while keeping the same origin:

```typescript
client.addRequestInterceptor((request) => {
  const u = new URL(request.requestURL);
  u.pathname = '/v2/users';
  return { ...request, requestURL: u.href };
});
```

### Filter Options

```typescript
interface RequestInterceptorFilter {
  phases?: ('initial' | 'retry' | 'redirect')[]; // Default: ['initial']
  methods?: HTTPMethod[];
  hosts?: string[]; // Exact hostnames or wildcard patterns. '*.example.com' = one subdomain label only; '**.example.com' = any depth. Neither matches the apex — list it explicitly. '*' matches everything. PSL tail guard prevents '*.com'-style patterns.
  schemes?: ('http' | 'https')[]; // Match on request scheme. requestURL is absolute whenever it could be resolved before dispatch — MockAdapter synthesizes `http://...` URLs when no baseURL is configured, browser adapters resolve against window.location, Node adapter requires absolute URLs.
  bodyContainsKeys?: string[]; // Dot-path object matching like 'data.results'; array indexing is not supported; the body must be a plain object at the root level — JSON array responses never match
}
```

All specified filter fields are ANDed together. Within each field, values are ORed. Any one match is sufficient. An empty `phases: []` matches all phases.

### Cancelling from an Interceptor

Return an `InterceptorCancel` object to abort the request with a `cancelled` error:

```typescript
client.addRequestInterceptor((request, phase, context) => {
  if (!isTokenValid()) {
    return { cancel: true, reason: 'Token expired' };
  }

  return request;
});
```

### Interceptor Context

```typescript
interface RequestInterceptorContext {
  initialURL: string; // Original resolved URL for this send(). During `initial` interceptors this is the pre-interceptor resolved URL; later phases match HTTPResponse.initialURL
  redirectHistory: string[]; // Redirect targets already recorded for this send; during redirect-phase interceptors this includes the current detected target before any rewrite returned from that interceptor
  requestID: string; // ULID for this send() — matches HTTPResponse.requestID and HTTPClientError.requestID
  attemptNumber: number; // 1-based attempt that will be dispatched after this interceptor chain completes; increments across retries and redirect hops
}
```

## Response Observers

Observers run **after** an adapter attempt and cannot modify the response. They are the right place for logging, metrics, cache writes, and reading token state out of response bodies.

```typescript
const removeObserver = client.addResponseObserver(
  (response, request, phase) => {
    console.log(`${request.method} ${request.requestURL} → ${response.status}`);
  },
  { phases: ['final'] }, // default: ['final']
);
```

Signature:

```typescript
type ResponseObserver = (
  response: HTTPResponse,
  request: AttemptRequest,
  phase: ResponseObserverPhase,
) => void | Promise<void>;
```

`request` is the finalized observer-facing attempt snapshot:

```typescript
interface AttemptRequest {
  requestURL: string;
  method: HTTPMethod;
  headers: Record<string, string | string[]>;
  body?: string | Uint8Array | FormData | null; // serialized adapter-facing body
  rawBody?: unknown; // structured pre-serialization body when available
  timeout?: number; // configured per-attempt timeout budget in ms
  attemptNumber?: number; // 1-based; undefined on pre-dispatch best-effort snapshots
  requestID?: string; // matches HTTPResponse.requestID / HTTPClientError.requestID
}
```

Use `request.timeout` to inspect what timeout budget was configured for that attempt. Use `response.isTimeout` / `error.isTimeout` to inspect what actually happened.

### Filter Options

```typescript
interface ResponseObserverFilter {
  phases?: ('retry' | 'redirect' | 'final')[]; // Default: ['final']
  methods?: HTTPMethod[];
  hosts?: string[]; // Exact hostnames or wildcard patterns. '*.example.com' = one subdomain label only; '**.example.com' = any depth. Neither matches the apex — list it explicitly. '*' matches everything. PSL tail guard prevents '*.com'-style patterns.
  schemes?: ('http' | 'https')[]; // Match on request scheme. requestURL is absolute whenever it could be resolved before dispatch — MockAdapter synthesizes `http://...` URLs when no baseURL is configured, browser adapters resolve against window.location, Node adapter requires absolute URLs.
  statusCodes?: number[];
  contentTypes?: ('json' | 'text' | 'binary')[];
  contentTypeHeaders?: string[]; // Supports wildcards like 'image/*'
  bodyContainsKeys?: string[]; // Dot-path object matching like 'data.results'; array indexing is not supported; the body must be a plain object at the root level — JSON array responses never match
}
```

Example: observe all 401 responses to trigger a token refresh. Adding a `hosts` filter is a good idea in practice so the observer only fires for your own API and not third-party requests made through the same client:

```typescript
client.addResponseObserver(
  async (response, request, phase) => {
    await refreshTokens();
  },
  { statusCodes: [401], phases: ['final'], hosts: ['api.example.com'] },
);
```

## Error Observers

Error observers run when a request settles through the client's failure path.

```typescript
const removeObserver = client.addErrorObserver(
  (error, request, phase) => {
    console.error(`Request failed: ${error.code}`, error.message);
  },
  { phases: ['final'] }, // default: ['final']
);
```

Signature:

```typescript
type ErrorObserver = (
  error: HTTPClientError,
  request: AttemptRequest,
  phase: ErrorObserverPhase,
) => void | Promise<void>;
```

The `request` argument is the same `AttemptRequest` snapshot described above, including the configured `timeout` for that attempt.

When a request fails before any adapter attempt is dispatched (for example request setup errors, pre-dispatch interceptor failures, or pre-send cancellation), the snapshot is best-effort: it omits internally added request headers and cookie-jar-applied cookies because no real outbound attempt occurred.

### Filter Options

```typescript
interface ErrorObserverFilter {
  phases?: ('retry' | 'final')[]; // Default: ['final']
  methods?: HTTPMethod[];
  hosts?: string[]; // Exact hostnames or wildcard patterns. '*.example.com' = one subdomain label only; '**.example.com' = any depth. Neither matches the apex — list it explicitly. '*' matches everything. PSL tail guard prevents '*.com'-style patterns.
  schemes?: ('http' | 'https')[]; // Match on request scheme. requestURL is absolute whenever it could be resolved before dispatch — MockAdapter synthesizes `http://...` URLs when no baseURL is configured, browser adapters resolve against window.location, Node adapter requires absolute URLs.
}
```

Include `'retry'` in `phases` to also run when the adapter throws but a retry will follow:

```typescript
client.addErrorObserver(
  (error, request, phase) => {
    if (phase.type === 'retry') {
      console.log(
        `Attempt ${phase.attempt}/${phase.maxAttempts} failed, retrying…`,
      );
    }
  },
  { phases: ['retry', 'final'] },
);
```

## Phase Model

Phases describe where in the request lifecycle a callback fires. Interceptors, response observers, and error observers each see a different subset:

| Phase      | Interceptors  | Response observers | Error observers |
| ---------- | ------------- | ------------------ | --------------- |
| `initial`  | Yes (default) | No                 | No              |
| `retry`    | Yes           | Yes                | Yes             |
| `redirect` | Yes           | Yes                | No              |
| `final`    | No            | Yes (default)      | Yes (default)   |

**`retry` phase** carries `{ type: 'retry', attempt, maxAttempts, redirect? }`. The optional `redirect` field is set when the retry is occurring on a post-redirect URL.

**`redirect` phase** carries `{ type: 'redirect', hop, from, to, statusCode }`.

Error observers never receive a `redirect` phase. Redirect-time errors surface as `final` (or `retry` when another attempt follows).

## Retry Policy

The retry policy is configured at the client level and shared across all redirect hops for a given `send()` call. It can also be overridden per-request.

```typescript
import type { RetryPolicyOptions } from 'lifecycleion/retry-utils';

// Exponential backoff (recommended)
const client = new HTTPClient({
  retryPolicy: {
    strategy: 'exponential',
    maxRetryAttempts: 3, // Retries after the first attempt. Default: 10; minimum: 1
    minTimeoutMS: 500, // Initial delay (ms). Default: 1000
    maxTimeoutMS: 10_000, // Maximum delay cap (ms). Default: 30_000
    factor: 1.5, // Backoff multiplier. Default: 1.5
    dispersion: 0.2, // 0–1 jitter fraction. Default: 0.1
  },
});

// Fixed delay
const client2 = new HTTPClient({
  retryPolicy: {
    strategy: 'fixed',
    maxRetryAttempts: 2, // Default: 10; minimum: 1
    delayMS: 1_000, // Delay between each attempt (ms). Default: 1000; minimum: 1
  },
});
```

### Retryable Status Codes

Retries apply when the response status is in the `RETRYABLE_STATUS_CODES` set:

`0, 408, 429, 500, 502, 503, 504, 507, 509, 520, 521, 522, 523, 524, 598, 599`

Status `0` covers adapter-level "no real HTTP response" conditions (network unreachable, XHR transport failure, etc.).

4xx responses other than 408 and 429 are **not** retried.

### Per-Request Override

```typescript
// Override for one request
await client
  .get('/unstable')
  .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1000 })
  .send();

// Disable retries for one request (even if the client has a default policy)
await client.post('/payments').retryPolicy(null).send();
```

## Cookie Jar

A `CookieJar` provides RFC 6265-compliant cookie storage with Public Suffix List domain matching, path matching, secure-flag enforcement, and expiry handling.

```typescript
import { CookieJar, HTTPClient } from 'lifecycleion/http-client';

const jar = new CookieJar();
const client = new HTTPClient({
  baseURL: 'https://api.example.com',
  cookieJar: jar,
});
```

When a `CookieJar` is attached to the client:

1. Before each adapter attempt (including retries) the jar's cookies for the request URL are added to the `cookie` header.
2. After every response the `set-cookie` headers are parsed and stored in the jar.
3. Cookies are maintained across redirect hops.

### CookieJar API

```typescript
const jar = new CookieJar();

// Manually set a cookie (createdAt is optional — injected automatically if omitted)
// Returns false if domain is missing or syntactically invalid (empty string, spaces, etc.)
const ok = jar.setCookie({
  name: 'session',
  value: 'abc123',
  domain: 'example.com',
  path: '/',
  secure: true,
  httpOnly: true,
});

// Read cookies for a URL
const cookies = jar.getCookiesFor('https://api.example.com/users');
const session = jar.getCookieFor('session', 'https://api.example.com/');

// Parse a Set-Cookie header string and store the cookie in the jar
jar.parseSetCookieHeader('token=xyz; Path=/; HttpOnly', 'https://example.com/');

// Parse and store all set-cookie headers from a response headers object (same format as response.headers)
jar.processResponseHeaders(response.headers, 'https://example.com/');

// Get the cookie header string for outgoing requests
const cookieHeader = jar.getCookieHeaderString('https://api.example.com/users');

// Maintenance
jar.clearExpiredCookies(); // Returns count removed
jar.clear(); // Remove all cookies — returns count removed
jar.clear('api.example.com', 'hostname'); // Remove cookies for exactly that hostname only — returns count removed
jar.clear('example.com', 'domain'); // Remove example.com and all its subdomains (the entire apex bucket) — returns count removed

// Inspection
jar.getAllCookies(); // All stored cookies, including expired — call clearExpiredCookies() first if needed
jar.getStoredDomains(); // [{ domain, count }]

// Serialization
const data = jar.toJSON();
jar.fromJSON(data); // Clears existing cookies first, then loads from the serialized snapshot
```

## Redirect Handling

Redirects are disabled by default (`followRedirects: false`). Many APIs never issue redirects, and blindly following them can leak auth headers to unintended origins or mask unexpected infrastructure changes. Enable explicitly at the client level if your use case requires it, or catch the `redirect_disabled` error and handle the redirect yourself.

```typescript
const client = new HTTPClient({
  followRedirects: true,
  maxRedirects: 5, // Default
});
```

**Platform support:** Redirect following requires an adapter that can intercept 3xx responses before the browser handles them. `NodeAdapter` and `FetchAdapter` in server runtimes (Node.js, Bun) fully support it. `MockAdapter` supports it on any platform since responses are fully controlled. Browsers follow redirects transparently at the network layer, so `FetchAdapter` in a browser and `XHRAdapter` cannot intercept or limit them. The constructor throws if you combine `followRedirects: true` with these adapters.

### Method Rewriting Rules

| Status   | Original method               | Redirect method |
| -------- | ----------------------------- | --------------- |
| 301, 302 | POST                          | GET             |
| 301, 302 | GET, HEAD, PUT, PATCH, DELETE | Unchanged       |
| 303      | Any                           | GET             |
| 307, 308 | Any                           | Unchanged       |

Cross-origin redirects strip unsafe headers (Authorization, Cookie, etc.) from the forwarded request.

Note: `MockAdapter` strips the domain before route matching, so "cross-origin" redirects in tests are effectively same-origin to its router. Header stripping still applies, but test routes don't need to be registered per-domain.

Redirect metadata is recorded when a redirect target is detected and enters redirect handling. That means `redirectHistory` can include the current redirect target before the follow-up adapter attempt is dispatched. During redirect-phase interception, the metadata reflects the target detected from the redirect response. If a redirect interceptor rewrites `requestURL` and redirect handling continues, later `requestURL` / `redirectHistory` values reflect the rewritten target. If redirect handling is cancelled or errors before dispatch, the response/error metadata may still reflect the originally detected target rather than a completed adapter attempt.

### Redirect Phase Info

```typescript
type RedirectHopInfo = {
  hop: number; // 1 = first redirect
  from: string; // URL that returned the 3xx
  to: string; // Resolved redirect target
  statusCode: number; // 301 | 302 | 303 | 307 | 308
};
```

This shape appears in `{ type: 'redirect' }` phases on response observers, in `{ type: 'retry', redirect }` when a policy retry follows a redirect, and in `AttemptStartEvent.redirect` / `AttemptEndEvent.redirect` on attempt hooks.

## Request Cancellation

### Builder-Scoped Cancel

```typescript
const builder = client.get('/slow-endpoint');
setTimeout(() => builder.cancel(), 2_000);
const response = await builder.send();
// response.isCancelled === true

// With a reason surfaced on HTTPClientError.cancelReason:
builder.cancel('timeout_budget_exceeded');
```

`cancel()` returns `true` if the cancel was applied, `false` if it was a no-op (the request had already completed, been cancelled, or failed).

Calling `cancel()` before `send()` marks the builder so that `send()` throws a plain `Error` (not an `HTTPClientError`) immediately rather than dispatching the request. In this case `builder.error` is `null`. No `HTTPClientError` is produced and `cancelReason` is not accessible programmatically (the reason string, if any, appears only in the thrown `Error` message).

### ID-Scoped Cancel

```typescript
const builder = client.get('/users');
builder.send(); // fire-and-forget

// Cancel using the builder's ULID (available before or after send())
client.cancel(builder.requestID);
client.cancel(builder.requestID, 'shutdown');
```

### Tracker-Wide Cancel

```typescript
client.cancelAll(); // Cancel every tracked request (this client + all sub-clients)
client.cancelOwn(); // Cancel only requests from this exact client instance (not sub-clients)
client.cancelAllWithLabel('my-label'); // Cancel all requests with label (this client + sub-clients)
client.cancelOwnWithLabel('my-label'); // Cancel own requests with label (not sub-clients)

// All accept an optional reason string surfaced on HTTPClientError.cancelReason:
client.cancelAll('app_shutdown');
client.cancelOwn('component_unmounted');
client.cancelAllWithLabel('upload', 'quota_exceeded');
client.cancelOwnWithLabel('poll', 'tab_hidden');
```

### AbortSignal Integration

```typescript
const controller = new AbortController();
const response = await client.get('/users').signal(controller.signal).send();

// Cancel from outside:
controller.abort();

// Cancel with a reason — surfaced on HTTPClientError.cancelReason:
controller.abort('user_navigated_away');
```

The external signal is composed with the client's cancel signal (`builder.cancel()`, `client.cancelAll()`, etc.). Either one will abort the request and set `isCancelled: true`. The per-attempt timeout is independent. It fires its own abort but sets `isTimeout: true` instead. If `controller.abort()` is called with an explicit string reason, it appears on `HTTPClientError.cancelReason`.

## Client Identity

```typescript
client.clientID; // ULID string — unique per HTTPClient or sub-client instance
client.adapterType; // AdapterType: 'fetch' | 'xhr' | 'node' | 'mock'
```

`clientID` matches the `clientID` field on tracked request entries. `adapterType` lets you inspect the active adapter without sending a request, which is useful in shared utilities that need to behave differently per runtime.

## Request Tracking

```typescript
const { count, requests } = client.listRequests({
  scope: 'own',
  label: 'my-label',
});
// scope: 'own' (default) | 'all'

// Each entry:
// { requestID: string; clientID: string; label?: string; state: RequestState }
```

`scope: 'all'` includes requests from sub-clients that share the same tracker.

## Sub-Client Creation

Sub-clients share the parent's request tracker and enable/disable state. `createSubClient` is only available on `HTTPClient`, and it returns an `HTTPSubClient` that omits `createSubClient`, so nesting sub-clients is not supported.

```typescript
const authClient = client.createSubClient({
  baseURL: 'https://auth.example.com',
  defaultHeaders: { 'x-api-version': 'v2' },
  defaultHeadersStrategy: 'merge', // 'merge' | 'replace' (default: 'replace')
});
```

`defaultHeadersStrategy`:

- `'replace'` (default): the sub-client's `defaultHeaders` replace the parent's entirely.
- `'merge'`: the sub-client's `defaultHeaders` are layered on top of the parent's.

Any `HTTPClientConfig` field can be overridden. When `cookieJar` is set to `null` it disables cookies for that sub-client even if the parent has one.

Sub-clients inherit the parent's interceptors and observers. The parent chain runs first, then the sub-client's own. This means shared concerns like auth headers or global logging happen before sub-client-specific logic. Adding interceptors or observers to a sub-client does not affect the parent.

## Enable and Disable

```typescript
client.disable(); // All subsequent send() calls throw immediately
client.enable(); // Re-enables the client

client.isDisabled; // true if the client or any parent client is disabled
```

Disabling a parent client also disables all of its sub-clients.

## Progress Events

```typescript
interface HTTPProgressEvent {
  loaded: number;
  total: number;
  progress: number; // 0–1, or -1 if total is unknown
  attemptNumber: number;
  hopNumber?: number; // Present during redirect hops (1 = first redirect)
}
```

Progress granularity depends on the adapter:

| Adapter      | Upload progress          | Download progress                |
| ------------ | ------------------------ | -------------------------------- |
| FetchAdapter | 0% at start, 100% at end | Terminal 100% only (no 0% event) |
| NodeAdapter  | Real per-chunk           | Real per-chunk                   |
| XHRAdapter   | Real per-chunk           | Real per-chunk                   |
| MockAdapter  | 0% at start, 100% at end | Terminal 100% only (no 0% event) |

## Adapters

### FetchAdapter (default)

Uses the global `fetch()` API. Works in browsers, Node.js 18+, Bun, and Deno.

```typescript
import { FetchAdapter, HTTPClient } from 'lifecycleion/http-client';

// Explicit (same as the default)
const client = new HTTPClient({ adapter: new FetchAdapter() });
```

No configuration options. Adapter-level behavior is controlled through `HTTPClientConfig`.

**Browser constraints (enforced at client construction):**

- `cookieJar` must not be set
- `userAgent` must not be set
- `followRedirects` must not be `true`

Browsers automatically strip forbidden headers (`cookie`, `user-agent`, `host`, all `proxy-*` and `sec-*` headers, etc.). Attempting to set them from calling code produces a `request_setup_error`. Attempting to set them from an interceptor produces an `interceptor_error`.

### NodeAdapter

Uses Node.js native `http` / `https` modules. Supports Unix domain sockets, mTLS, and per-chunk streaming.

```typescript
import { NodeAdapter } from 'lifecycleion/http-client-node';
import { HTTPClient } from 'lifecycleion/http-client';

// Unix domain socket
const client = new HTTPClient({
  adapter: new NodeAdapter({ socketPath: '/var/run/docker.sock' }),
  baseURL: 'http://localhost', // host is ignored for routing; path still matters
});

// mTLS
const client = new HTTPClient({
  adapter: new NodeAdapter({
    mtls: {
      cert: fs.readFileSync('client.crt'),
      key: fs.readFileSync('client.key'),
      ca: fs.readFileSync('ca.crt'),
    },
  }),
  baseURL: 'https://internal.example.com',
});

// Self-signed certificates (dev/test only)
const client = new HTTPClient({
  adapter: new NodeAdapter({ rejectUnauthorized: false }),
  baseURL: 'https://localhost:8443',
});
```

**NodeAdapterConfig:**

```typescript
interface NodeAdapterConfig {
  socketPath?: string; // Unix domain socket path
  mtls?: {
    cert: string | Buffer;
    key: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
  };
  rejectUnauthorized?: boolean; // Default: true
}
```

TLS certificate errors resolve as status `495` (transport error, not retryable) rather than throwing, so they flow through the normal error path.

### XHRAdapter

Uses `XMLHttpRequest` for real per-chunk progress tracking in browsers where `fetch` progress is unavailable.

```typescript
import { XHRAdapter } from 'lifecycleion/http-client-xhr';
import { HTTPClient } from 'lifecycleion/http-client';

const client = new HTTPClient({
  adapter: new XHRAdapter(),
  baseURL: 'https://api.example.com',
});
```

No configuration options. Adapter-level behavior is controlled through `HTTPClientConfig`.

**XHRAdapter constraints** (same as FetchAdapter browser constraints, plus one more):

- `cookieJar` must not be set
- `userAgent` must not be set
- `followRedirects` must not be `true`
- `HTTPClient` throws if `XMLHttpRequest` is not available (e.g. Node.js without a shim)

Because browsers follow redirects silently, XHR cannot intercept them mid-flight. Instead, after the request completes, the adapter compares `xhr.responseURL` to the original URL to detect whether a redirect occurred. If one is detected the response carries `wasRedirectDetected: true` and an `HTTPClientError` with code `redirect_disabled`.

### MockAdapter (testing)

Route-based mock server for unit and integration tests. Routes match on **path only**. The domain in the URL is stripped before matching.

```typescript
import { MockAdapter } from 'lifecycleion/http-client-mock';
import { HTTPClient } from 'lifecycleion/http-client';

const mock = new MockAdapter({ defaultDelay: 0 });
const client = new HTTPClient({
  adapter: mock,
  baseURL: 'https://api.test',
});

mock.routes.get('/users/:id', async (req) => {
  const { id } = req.params;
  return { status: 200, body: { id, name: 'Alice' } };
});

mock.routes.post('/users', async (req) => {
  return {
    status: 201,
    body: { id: 2, ...(req.body as object) },
    cookies: { session: 'new-session-value' },
  };
});

// Test
const response = await client.get('/users/1').send();
expect(response.status).toBe(200);
expect(response.body).toEqual({ id: '1', name: 'Alice' });
```

**MockAdapterConfig:**

```typescript
interface MockAdapterConfig {
  defaultDelay?: number; // Milliseconds delay added to all responses
  onError?: (
    req: MockRequest,
    error: unknown,
  ) => MockResponse | Promise<MockResponse>;
}
```

`mock.routes.clear()` removes all registered mock routes.

**MockRequest** (received by route handlers):

```typescript
interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>; // Path params from :paramName segments
  query: QueryObject; // Parsed query string
  headers: Record<string, string>;
  cookies: Record<string, string>; // Pre-parsed from cookie header
  body?: unknown; // Parsed: JSON object, string, Uint8Array, or MockFormData
}
```

**MockResponse:**

```typescript
interface MockResponse {
  status: number;
  body?: unknown; // Supports objects (JSON), strings, Uint8Array, ArrayBuffer
  headers?: Record<string, string | string[]>;
  contentType?: 'json' | 'text' | 'binary'; // Overrides auto-detection
  delay?: number; // Millisecond delay for this response
  cookies?: Record<string, string | MockCookieOptions | null>;
}
```

`MockResponse.cookies` shorthand:

- `string` -> session cookie: `name=value; Path=/` (the string is the cookie value, not a raw Set-Cookie header)
- `null` -> delete cookie: `name=; Path=/; Max-Age=0`
- `MockCookieOptions` → full control over path, domain, maxAge, httpOnly, secure, sameSite

`cookies` entries are appended after any `headers['set-cookie']` entries. If the same cookie name appears in both, the `cookies` entry wins (last Set-Cookie header takes precedence).

**Simulate multiple domains in tests:**

```typescript
const apiMock = new MockAdapter();
const authMock = new MockAdapter();

const client = new HTTPClient({
  adapter: apiMock,
  baseURL: 'https://api.test',
});

const authClient = client.createSubClient({
  adapter: authMock,
  baseURL: 'https://auth.test',
});

apiMock.routes.get('/data', (req) => ({ status: 200, body: { data: true } }));

authMock.routes.post('/token', (req) => ({
  status: 200,
  body: { token: 'xyz' },
}));
```

## Streaming Responses

Streaming is supported **only by NodeAdapter**. Provide a `StreamResponseFactory` via `.streamResponse()` on the builder. It is called after the response headers arrive on a `200` response.

```typescript
import { createWriteStream, unlinkSync } from 'node:fs';
import { NodeAdapter } from 'lifecycleion/http-client-node';
import { HTTPClient } from 'lifecycleion/http-client';
import type { StreamResponseFactory } from 'lifecycleion/http-client';

const client = new HTTPClient({
  adapter: new NodeAdapter(),
  baseURL: 'https://files.example.com',
});

const response = await client
  .get('/large-file.bin')
  .streamResponse((info, { signal }) => {
    const dest = createWriteStream('/tmp/large-file.bin');

    // Clean up the partial file if the request is cancelled or fails
    signal.addEventListener('abort', () => {
      dest.destroy();

      try {
        unlinkSync('/tmp/large-file.bin');
      } catch {}
    });

    return dest;
  })
  .send();

// When streamed: response.isStreamed === true, response.body === null
// On failure:   response.isStreamError === true
```

The factory receives:

```typescript
interface StreamResponseInfo {
  status: 200; // Always 200 — not called for other statuses
  headers: Record<string, string | string[]>;
  url: string; // Resolved URL for this attempt
  attempt: number; // 1-based; increments on retry
  requestID: string;
}

interface StreamResponseContext {
  signal: AbortSignal; // Fires on cancel, timeout, or stream write failure
}

interface StreamResponseCancel {
  cancel: true;
  reason?: string; // Surfaced on HTTPClientError.cancelReason
}

type StreamResponseFactory = (
  info: StreamResponseInfo,
  context: StreamResponseContext,
) =>
  | WritableLike
  | null
  | StreamResponseCancel
  | Promise<WritableLike | null | StreamResponseCancel>;
```

`StreamResponseFactory` can also be supplied via `HTTPRequestOptions.streamResponse` when passing options directly to `client.get(...)`, `client.post(...)`, and the other request helpers.

```typescript
const response = await client.get('/large-file.bin', {
  streamResponse: (info, { signal }) => {
    const dest = createWriteStream('/tmp/large-file.bin');

    signal.addEventListener('abort', () => dest.destroy(), { once: true });
    return dest;
  },
});
```

Return `null` or `{ cancel: true, reason? }` from the factory to cancel the request (produces `isCancelled: true`, error code `cancelled`). The `reason` string is surfaced on `HTTPClientError.cancelReason`. If the factory throws, the error code is `stream_setup_error` instead.

When streaming is active on a retry attempt (before headers arrive), the factory is called again for the new attempt. The `signal` from the previous attempt will have fired, allowing cleanup code to run before the new stream is set up.

Once headers have arrived and the factory has been called, any mid-stream failure (`isStreamError: true`) is not retried because the response was already committed at the HTTP level. If the factory throws, that produces a `stream_setup_error` and is also not retried, since it indicates a local problem, such as failing to open a file, rather than a transient server issue.

## Builder Post-Send Accessors

After calling `.send()`, the builder exposes live state:

```typescript
const builder = client.get('/users');
const response = await builder.send();

builder.requestID; // ULID assigned at construction time — available before and after send()
builder.state; // Current RequestState
builder.response; // HTTPResponse<T> | null
builder.error; // HTTPClientError | null
builder.attemptCount; // Total adapter calls made (null before send)
builder.nextRetryDelayMS; // Scheduled delay for next retry (ms), or null
builder.nextRetryAt; // Epoch ms for next retry, or null
builder.startedAt; // Epoch ms when first attempt dispatched (null before send, and null when no adapter attempt was dispatched — e.g. pre-send cancel(), pre-aborted AbortSignal, request setup error, or interceptor cancel/error)
builder.elapsedMS; // Wall-clock ms including retry waits; freezes on completion (null when startedAt is null)
```

Labels default to `undefined`. When set, they must be non-empty strings, empty or whitespace-only labels throw.

## Request State Values

```typescript
type RequestState =
  | 'pending' // Before send()
  | 'sending' // Adapter call in flight
  | 'waiting_for_retry' // Delay between retry attempts
  | 'completed' // Terminal success (any HTTP status, even 4xx/5xx)
  | 'cancelled' // Cancelled before or during send
  | 'failed'; // Terminal transport failure
```

## Headers

**Internal representation:** All header keys are lowercased. `set-cookie` is always `string[]`. Other multi-value headers that arrive as comma-joined strings remain as `string`.

**Merging:** When multiple sources set the same header (default headers, request headers, interceptors), later values win wholesale. A `string[]` value replaces a `string` value entirely rather than being appended. A single-element `string[]` is normalized to a plain `string` when merging outgoing request headers and when normalizing response headers. Observer-facing `AttemptRequest.headers` may still contain `string[]` values when an adapter reports repeated effective request headers, but array preservation is not guaranteed. Do not rely on `Array.isArray()` checks on header values in any context.

**Browser-restricted headers** (applying to FetchAdapter and XHRAdapter):

Exact names: `accept-charset`, `accept-encoding`, `access-control-request-headers`, `access-control-request-method`, `access-control-request-private-network`, `connection`, `content-length`, `date`, `expect`, `host`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `via`, `cookie`, `dnt`, `origin`, `referer`, `set-cookie`, `user-agent`

Prefix-based: all `proxy-*` and `sec-*` headers

Method-override headers `x-http-method`, `x-http-method-override`, `x-method-override` cannot tunnel `connect`, `trace`, or `track`.

## Exported Types

From `lifecycleion/http-client`:

```typescript
// Client
HTTPClient;
HTTPRequestBuilder; // Use as a type annotation: let builder: HTTPRequestBuilder<User>

// Adapter
(HTTPAdapter, AdapterRequest, AdapterResponse, AdapterType);
FetchAdapter;

// Request
(HTTPMethod, ContentType, QueryValue, QueryObject);
(HTTPClientConfig, SubClientConfig, HTTPRequestOptions);
(InterceptedRequest, AttemptRequest);

// Response
(HTTPResponse, ErrorCode, HTTPClientError, HTTPProgressEvent);
(AttemptStartEvent, AttemptEndEvent);

// Interceptors & Observers
(RequestInterceptor, RequestInterceptorFilter, RequestInterceptorContext);
(InterceptorCancel, InterceptorPhase);
(ResponseObserver, ResponseObserverFilter, ResponseObserverPhase);
(ErrorObserver, ErrorObserverFilter, ErrorObserverPhase);

// Phases
(RequestPhase, RequestPhaseName);
(InterceptorPhaseName, ResponseObserverPhaseName, ErrorObserverPhaseName);
RedirectHopInfo;

// Tracking
(RequestState, RequestInfo);

// Streaming
(WritableLike,
  StreamResponseInfo,
  StreamResponseContext,
  StreamResponseCancel,
  StreamResponseFactory);

// Cookies
(Cookie, CookieInput, CookieJarJSON);
```

From `lifecycleion/http-client-node`:

```typescript
NodeAdapter;
NodeAdapterConfig;
```

From `lifecycleion/http-client-xhr`:

```typescript
XHRAdapter;
```

From `lifecycleion/http-client-mock`:

```typescript
MockAdapter;
(MockAdapterConfig, MockAdapterRoutes, MockRequest, MockResponse);
(MockRouteHandler, MockFormData, MockCookieOptions);
```

## Exported Constants

From `lifecycleion/http-client`:

| Constant                                   | Value / Type                       | Description                       |
| ------------------------------------------ | ---------------------------------- | --------------------------------- |
| `DEFAULT_TIMEOUT_MS`                       | `30_000`                           | Default request timeout           |
| `DEFAULT_REQUEST_ID_HEADER`                | `'x-local-client-request-id'`      | Header name for request IDs       |
| `DEFAULT_REQUEST_ATTEMPT_HEADER`           | `'x-local-client-request-attempt'` | Header name for attempt number    |
| `DEFAULT_USER_AGENT`                       | `'lifecycleion-http-client'`       | Default User-Agent string         |
| `DEFAULT_MAX_REDIRECTS`                    | `5`                                | Default redirect limit            |
| `HTTP_METHODS`                             | `ReadonlyArray<HTTPMethod>`        | All supported HTTP method strings |
| `RETRYABLE_STATUS_CODES`                   | `ReadonlySet<number>`              | Status codes that trigger a retry |
| `REDIRECT_STATUS_CODES`                    | `ReadonlySet<number>`              | 301, 302, 303, 307, 308           |
| `BROWSER_RESTRICTED_HEADERS`               | `ReadonlySet<string>`              | Exact headers blocked in browsers |
| `BROWSER_RESTRICTED_HEADER_PREFIXES`       | `ReadonlyArray<string>`            | `['proxy-', 'sec-']`              |
| `BROWSER_METHOD_OVERRIDE_HEADER_NAMES`     | `ReadonlySet<string>`              | Method override header names      |
| `BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES` | `ReadonlySet<string>`              | `connect`, `trace`, `track`       |
