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
  - [Cancelling From an Interceptor](#cancelling-from-an-interceptor)
  - [Interceptor Context](#interceptor-context)
- [Response Observers](#response-observers)
  - [Filter Options](#filter-options-1)
- [Error Observers](#error-observers)
  - [Filter Options](#filter-options-2)
- [Phase Model](#phase-model)
- [Retry Policy](#retry-policy)
  - [Retryable Status Codes](#retryable-status-codes)
  - [Method Safety](#method-safety)
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
  - [FetchAdapter (Default)](#fetchadapter-default)
  - [NodeAdapter](#nodeadapter)
    - [Certificate Revocation (`crl`)](#certificate-revocation-crl)
  - [XHRAdapter](#xhradapter)
  - [MockAdapter (Testing)](#mockadapter-testing)
- [Streaming Responses](#streaming-responses)
  - [Stream Errors and Replay](#stream-errors-and-replay)
    - [Adapter Support](#adapter-support)
    - [Failures Before a Response](#failures-before-a-response)
    - [Why a Retry Did Not Happen](#why-a-retry-did-not-happen)
    - [Non-Idempotent Methods](#non-idempotent-methods)
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
  retryNonIdempotentMethods?: boolean; // Default: false — do not retry POST/PATCH. See Non-Idempotent Methods
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
  .retryNonIdempotentMethods(true) // POST is not retried by default; safe here because of the idempotency key
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
  isStreamError: boolean; // Body delivery failed after headers arrived; see Stream Errors and Replay
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

### Cancelling From an Interceptor

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

### Method Safety

A retryable status is necessary but not sufficient. `POST` and `PATCH`, the methods RFC 9110 does not define as idempotent, are **not** retried by default, because a status like `500` means the server responded, so the handler ran and may have committed. `PUT` and `DELETE` are unaffected: both mutate, but repeating either leaves the resource in the same state, which is what makes replay safe.

Set `retryNonIdempotentMethods: true` on the client, or `.retryNonIdempotentMethods(true)` per request, when writes are guarded by an idempotency key. See [Non-Idempotent Methods](#non-idempotent-methods) for the full rules, including how transport failures are treated.

### Per-Request Override

```typescript
// Override for one request
await client
  .get('/unstable')
  .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1000 })
  .send();

// Disable retries for one request (even if the client has a default policy)
await client.get('/expensive-report').retryPolicy(null).send();

// A POST is already not retried by default — opt in only when the write is
// safe to repeat, for example when guarded by an idempotency key
await client
  .post('/payments')
  .headers({ 'idempotency-key': key })
  .retryNonIdempotentMethods(true)
  .send();
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

### FetchAdapter (Default)

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

// Custom CA — internal services that use a private certificate authority.
// Accepts a PEM string, a Buffer, or an array of either (one CA per element).
const client = new HTTPClient({
  adapter: new NodeAdapter({ ca: fs.readFileSync('internal-ca.crt') }),
  baseURL: 'https://internal.example.com',
});

// Multiple CAs — no need to concatenate into a bundle
const client = new HTTPClient({
  adapter: new NodeAdapter({
    ca: [fs.readFileSync('internal-ca.crt'), fs.readFileSync('partner-ca.crt')],
  }),
  baseURL: 'https://internal.example.com',
});

// Dialing by IP with a DNS-named cert (service registry pattern).
//
// When a service registry gives you an instance IP, connect directly to it —
// Node.js skips DNS entirely when the target is an IP address. The server's
// cert SAN is a DNS name, not the IP, so TLS verification fails unless you
// tell Node which hostname to check the cert against via servername.
//
// Redirects are disabled by default, which is exactly what you want here —
// an unexpected redirect from an internal service is a misconfiguration
// worth surfacing, not silently following.
//
// The Host header defaults to the IP. If the backend routes by Host (e.g.
// a virtual-hosted proxy in front of the service), also set:
//   defaultHeaders: { host: 'billing.internal' }
const client = new HTTPClient({
  adapter: new NodeAdapter({
    ca: fs.readFileSync('internal-ca.crt'),
    servername: 'billing.internal', // cert SAN — TLS verifies against this name
  }),
  baseURL: 'https://10.0.0.5:443', // IP from the registry — where bytes go
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
  ca?: string | Buffer | Array<string | Buffer>; // Trusted CA cert(s) for servers using a private CA. Array allows multiple CAs without bundling. No client cert required — use mtls for that.
  servername?: string; // TLS SNI hostname. Required when dialing by IP but the cert SAN is a DNS name — without it, TLS verification fails because the IP does not match the DNS SAN.
  mtls?: {
    cert: string | Buffer;
    key: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>;
  };
  crl?: string | Buffer | Array<string | Buffer>; // Certificate revocation list(s). A concatenated PEM bundle is split for you — see below.
  rejectUnauthorized?: boolean; // Default: true
}
```

TLS certificate errors resolve as status `495` (transport error, not retryable) rather than throwing, so they flow through the normal error path. That includes every revocation failure, such as `CERT_REVOKED`, `UNABLE_TO_GET_CRL`, `CRL_HAS_EXPIRED` and friends.

#### Certificate Revocation (`crl`)

`crl` rejects a server certificate whose serial has been revoked, even though its chain and hostname still verify. A revoked certificate fails the handshake with `CERT_REVOKED`, surfacing as status `495`.

```typescript
const client = new HTTPClient({
  adapter: new NodeAdapter({
    ca: fs.readFileSync('ca.crt'),
    crl: fs.readFileSync('crl.pem', 'utf8'), // one CRL, or a bundle of many
  }),
  baseURL: 'https://internal.example.com',
});
```

The value is read and normalized on **every request**, so refreshing a revocation set means passing a new value. **Construct a new `NodeAdapter`.** That is the intended way, and it is cheap precisely because the adapter owns no connection pool, so there is nothing to release and nothing to leak. There is no update method, and none is needed. Mutating the config object you handed the adapter also takes effect, but rebuilding keeps the CRL and the client that uses it visibly in step. How often to refresh is yours to decide. The library has no timer.

**Bundles are split for you.** A PEM string or Buffer holding several concatenated CRLs, the format Apache's `SSLCARevocationFile`, nginx's `ssl_crl`, and HAProxy's `crl-file` all expect and CA tooling exports, is split into the array Node requires. This includes Buffers: `fs.readFileSync('bundle.pem')` without an encoding returns one, and its contents are PEM like any other bundle, so it would otherwise be truncated exactly as a string would. Strings and Buffers nested inside an array are split too, so `[bundleOfTwo, oneMore]` contributes three CRLs rather than two. DER Buffers are passed through untouched because DER encodes exactly one CRL, so there is nothing to split.

**Only PEM blocks and whitespace are accepted.** Anything else in the string, such as a truncated or corrupted CRL, a damaged delimiter, or decoded text from `openssl ... -text`, is refused with an error rather than split. The rule is exact rather than a best guess: a parser cannot tell a half-written CRL from a line of commentary, so admitting commentary would mean silently dropping the truncated entry and enforcing a revocation set you never supplied. Strip any annotation before passing a bundle here.

**Do not put two CRLs for the same issuer in one bundle.** OpenSSL uses the **first** CRL it has for an issuer, not the newest. In testing, a stale CRL followed by one revoking the server's certificate accepted the connection, while the same pair in the opposite order rejected it. Splitting does not change this. It is how CRL selection works. Supply exactly one current CRL per issuer.

This exists because Node reads only the **first** CRL of a concatenated string and silently ignores the rest, unlike `ca`, which reads every certificate in a bundle:

| passed as           | `ca`          | `crl` (raw Node)         |
| ------------------- | ------------- | ------------------------ |
| concatenated bundle | reads **all** | reads **only the first** |
| array               | reads all     | reads all                |

It is Node diverging from the library it links, not an OpenSSL limitation: `openssl verify -crl_check_all -CRLfile bundle.pem` correctly finds a CRL that sits second in the file. The failure mode is the reason this is worth handling for you. A truncated bundle reports `UNABLE_TO_GET_CRL`, which reads as "no CRL supplied" rather than "your bundle was cut short," and a bundle whose first entry happens to cover the root in use appears to work until the roster or export order changes.

**Two things to plan for.** Both are fail-closed, so a stale or partial CRL never silently stops enforcing, but both can refuse healthy connections:

- **Every certificate in the chain needs a covering CRL.** Node enables `X509_V_FLAG_CRL_CHECK_ALL`, so supplying a CRL for one root while connecting through another fails with `UNABLE_TO_GET_CRL` even when nothing was revoked. Cover every root the client talks to, or give the scoped CRL its own client. This makes adding a root an outage unless its CRL lands first.
- **CRLs expire.** Past `nextUpdate` the handshake fails with `CRL_HAS_EXPIRED`, including for certificates that were never revoked. Either refresh well inside that window, or export with a `nextUpdate` far enough out that a stalled refresh cannot take you down.

**No connection-pool handling is needed.** `crl` is part of Node's connection pool key, so changing it partitions the pool: a socket established under the old CRL is never reused for a request carrying the new one. Testing against a shared keepAlive agent confirmed that after a CRL update, the previously good connection is rejected rather than reused.

**Runtime support.** Bun ignored `crl` entirely through 1.3.14 and accepted a revoked certificate with no error. Bun implemented it in 1.4.0, where it matches Node on every case tested, including malformed-CRL rejection, expiry, coverage, and pool partitioning. **Require Bun >= 1.4.0 if you depend on revocation.** This library's own enforcement tests probe the runtime and skip where `crl` is unsupported, rather than passing for the wrong reason. The bundle-splitting tests run everywhere, since that part is the library's job rather than the runtime's.

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

### MockAdapter (Testing)

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
  streamError?: boolean | 'stream_write_error' | 'stream_response_error'; // Simulate a body failure after headers arrived
  transportError?: boolean | MockTransportErrorOptions; // Simulate a failure with no response at all
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

### Stream Errors and Replay

`isStreamError` is not limited to streamed responses. It is also set when a buffered response body fails after headers arrive, such as from a peer reset mid-body, a premature close, or fewer bytes than a declared `Content-Length`. The real HTTP status is preserved in every case, so a truncated `200` still reports `200`, not `0`.

For deciding whether a request may be resent, a stream error groups with a **real response**, not with a transport failure, even though both leave you without a usable body:

| Outcome                                       | Did the server receive it?     | Safe to replay a non-idempotent write? |
| --------------------------------------------- | ------------------------------ | -------------------------------------- |
| Transport failure with `wasDefinitelyNotSent` | No — no connection was made    | Yes — nothing could have been applied  |
| Transport failure, delivery not proven        | Unknown                        | No — it may have arrived               |
| `isStreamError`, real status                  | Yes, and it may have committed | No — the outcome is unknown            |
| `5xx` with an intact body                     | Yes, and it may have committed | No — the outcome is unknown            |

A transport failure is not by itself a licence to replay. `status: 0` means no usable response came back, which is not the same as the request never arriving. A connection dropped after the request was written looks identical from here. Only an adapter that can name the cause (a refused connection, a name that did not resolve) can turn that into proof.

Treating a stream error as a transport failure is the mistake worth guarding against: the superficial resemblance is strong, but it inverts the replay decision. `HTTPClient` already applies this internally. A stream error is never retried, even though its status might otherwise be retryable.

Terminal means terminal for a `3xx` too: a redirect whose body failed is **not** followed, even with `followRedirects: true`. The `Location` header survived, so following would work, and that is the problem, because the hop would continue, a healthy destination would answer `200`, and the failure would be gone from the result. A per-attempt timeout that struck mid-body is the case that stings, since a later hop reports its own `isTimeout`. Nothing is lost by stopping: the response reports the real `3xx` status alongside `isStreamError`, with `wasRedirectDetected` and `detectedRedirectURL` still telling you where it pointed.

With `followRedirects: false` the same truncated `3xx` reports differently, and deliberately so. That path is not about following. The request ends at the redirect whether or not the body arrived, so it reports what it reports for _every_ disabled redirect: `redirect_disabled`, `status: 0`, `isStreamError: false`, and `wasRedirectDetected` / `detectedRedirectURL` pointing at the target. A per-attempt timeout that struck mid-body is not surfaced there either: `isTimeout` stays `false`, because the timeout is incidental to an outcome that was already decided by the config. Reading `isTimeout` to mean "a timeout occurred somewhere" rather than "a timeout is why this failed" will surprise you here.

Two things deliberately do **not** set the flag. A caller's own `AbortSignal` firing classifies as `isCancelled` (or `isTimeout`), since that is your decision rather than a network fault. A failure with no headers at all, such as a connection refusal, DNS failure, or TLS rejection, is a plain transport failure, because no status was ever received for the flag to qualify.

#### Adapter Support

| Adapter        | `isStreamError` | Notes                                                                                                                                               |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeAdapter`  | Full            | Streamed and buffered bodies; distinguishes `stream_write_error` from `stream_response_error`                                                       |
| `FetchAdapter` | Buffered bodies | Server runtimes and browsers alike; always reports `stream_response_error` — `fetch` buffers the body, so there is no per-chunk delivery to inspect |
| `MockAdapter`  | Simulated       | Opt in per response with `streamError: true`, or name the code explicitly                                                                           |
| `XHRAdapter`   | Not reported    | `XMLHttpRequest` discards the status on a network error, leaving nothing to qualify                                                                 |

`FetchAdapter` is not limited to server runtimes here. Headers have already arrived when the body read starts, so the status is readable in a browser exactly as it is under Node or Bun, and a truncated body rejects the same way.

A per-attempt timeout that fires _during_ the body read counts as a post-header failure too, and is reported with the real status rather than as a plain timeout. The adapter cannot tell that abort apart from a caller cancellation because both arrive on the same signal, so it carries the response metadata out with the error and the client decides: a cancellation stays `isCancelled`, a timeout becomes a terminal stream failure.

`XHRAdapter` is the one real gap, and it is a spec-level limitation rather than a browser inconsistency: setting the error flag sets the response to a network error, which forces `status` to `0`. There is no surviving signal that headers ever arrived, so a mid-body truncation is indistinguishable from a connection refused. It arrives as an ordinary transport failure (`status: 0`, `isStreamError: false`), which for an **idempotent** method is eligible for retry, so a truncated `GET` is silently re-fetched where `NodeAdapter` and `FetchAdapter` would report the real status and stop.

A non-idempotent write is not replayed there, but only because `XHRAdapter` never supplies `wasDefinitelyNotSent`, so the default rule blocks it for want of proof, not because the truncation was recognized. Enable `retryNonIdempotentMethods` and that protection is gone, since nothing distinguishes this failure from a connection that was refused. Browser code performing non-idempotent writes should prefer `FetchAdapter` where replay safety matters.

#### Failures Before a Response

The same replay question applies to a failure with no response at all, where `isStreamError` cannot help because no headers ever arrived. Adapters answer it with two separate signals: `isRetryable: false` suppresses a retry the status alone would allow, and `wasDefinitelyNotSent: true` proves the request never reached the server.

`NodeAdapter` sets `wasDefinitelyNotSent` from the transport error code, treating only codes that prove no connection was established (`ECONNREFUSED`, `ENOTFOUND`, and similar) as replayable. Anything else, including `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, or a bare socket hang up, is possible delivery. The two unreachable codes are on that side despite reading like connect-time failures, because an ICMP unreachable arriving for an established connection is reported on that connection with the same code. Unproven is reported by leaving the field off rather than by setting it to `false`: the contract is that absence means "not known", so an explicit `false` would read as a proof of delivery no adapter is in a position to give.

It does not pair that with `isRetryable: false`. Whether a partly-sent request may be replayed is the method question, and withholding the proof already answers it. A blanket veto would additionally stop retrying an idempotent `PUT` after an ordinary socket error, which is the case a retry is most likely to fix.

A body-byte count cannot supply the proof in either direction: an empty-body request writes headers and nothing else, so the counter stays at `0` even after the server acted on it, and the counter tracks bytes handed to the stream rather than bytes on the wire, so it can be non-zero for a connection that was never established.

`XHRAdapter` sets neither. It never sets `wasDefinitelyNotSent`, because it has no way to prove non-delivery: upload progress events are suppressed for cross-origin requests that CORS does not grant access to, and such a request is still delivered. The browser blocks the response, not the request, so the absence of progress is not evidence that nothing was sent. It does not set `isRetryable: false` in its place either, since that flag blocks a retry for every method: inferring it from upload progress would stop retrying an idempotent `PUT` after an ordinary network error, and would override `retryNonIdempotentMethods` even when the caller has stated the replay is safe.

`FetchAdapter` never sets `wasDefinitelyNotSent`, because `fetch` exposes no upload progress or byte accounting, so a failure there is indistinguishable from one where nothing was sent. It sets `isRetryable: false` only for the TLS case below, exactly as `NodeAdapter` does.

`MockAdapter` can simulate any of it via `transportError`, so the replay rules are testable without a socket. It delivers no response data at all, meaning no body, headers, cookies, or terminal progress, and accepts the signals a real adapter would attach:

```typescript
// Proven undelivered — a POST may be replayed
adapter.routes.post('/orders', () => ({
  status: 200,
  transportError: { wasDefinitelyNotSent: true },
}));

// Delivery unknown — a POST is not replayed, an idempotent GET still is
adapter.routes.post('/orders', () => ({ status: 200, transportError: true }));

// Nothing should retry this, whatever the method. The default status 0 is
// retryable, so the veto is what stops it — pair it with a non-retryable
// status like 495 and the status alone ends the request, proving nothing.
adapter.routes.get('/secure', () => ({
  status: 200,
  transportError: { isRetryable: false },
}));

// A diagnostic status, as adapters preserve for TLS failures
adapter.routes.get('/bad-cert', () => ({
  status: 200,
  transportError: { status: 495 },
}));
```

So the `POST`/`PATCH` transport-failure exception is, today, a `NodeAdapter` capability. In a browser those writes are simply not retried after a transport failure, which is the safe outcome, just a stricter one than a runtime with real evidence can offer.

Since the client treats anything other than `false` as retryable, an unset value means "not known to be unsafe", not "known to be safe". Callers that must not double-apply a write should not infer permission to replay from its absence.

`isRetryable` is a hint about whether another attempt is worth making, and its contract only assigns meaning to `false`. An adapter may set it `true` for a failure it considers transient without knowing whether the request was delivered. Replaying a non-idempotent request needs a stronger statement, so adapters make it separately via `wasDefinitelyNotSent: true`, which claims only one thing: no request bytes reached the server. A custom adapter that sets `isRetryable: true` alone will not unlock a `POST` retry.

`isRetryable: false` is now reserved for failures that no method should retry because another attempt cannot succeed, not for ones that merely might have been delivered. A rejected TLS certificate is the example: both `NodeAdapter` and `FetchAdapter` resolve those as `495` with `isRetryable: false`, since the same request against the same server fails identically every time. On `FetchAdapter` this is a server-runtime classification. Bun puts the OpenSSL code on the error and Node hangs it off `cause`, while a browser reports an opaque `TypeError` with neither, so a browser TLS failure keeps the ordinary transport-error shape.

#### Why a Retry Did Not Happen

`willRetry: false` on an `onAttemptEnd` event does not say whether a retry was declined by the policy or suppressed by a safety rule. When the status alone would have allowed one, `retrySuppressedReason` names which rule stopped it:

| Value                   | Meaning                                                                   |
| ----------------------- | ------------------------------------------------------------------------- |
| `adapter_veto`          | The adapter reported `isRetryable: false` — no attempt can succeed        |
| `stream_error`          | The body failed after headers arrived, so the server received the request |
| `non_idempotent_method` | A `POST` or `PATCH` with no proof of non-delivery                         |

It is absent when a retry was scheduled, when no policy is configured, when the policy has no attempts left, or when the status was never retryable in the first place. In those cases nothing was suppressed, so naming a cause would misdescribe why the request stopped.

`adapter_veto` does not occur with a real transport. `NodeAdapter` and `FetchAdapter` set `isRetryable: false` only for a rejected TLS certificate, and pair it with `495`, which is not a retryable status, so the status ends the request before the veto is consulted, and nothing was suppressed to report. It is reachable from `MockAdapter` via `transportError: { isRetryable: false }`, whose default `status: 0` _is_ retryable (that is what the [`/secure` example above](#failures-before-a-response) exercises), and from a custom adapter that vetoes a status the client would otherwise retry.

```typescript
await client
  .post('/orders')
  .onAttemptEnd((event) => {
    if (event.retrySuppressedReason === 'non_idempotent_method') {
      // Set retryNonIdempotentMethods once the write carries an idempotency key
    }
  })
  .send();
```

#### Non-Idempotent Methods

Adapter evidence answers "did this reach the server?". The request method answers a different question, "does it matter if it arrives twice?" The client uses both.

`POST` and `PATCH` are the methods RFC 9110 does not define as idempotent, so replaying one may apply the same change twice. By default `HTTPClient` will not retry them:

- **After a real HTTP response**, never. A retryable status like `500` is not evidence of a failed delivery. It is the opposite, since the server responded, so the handler ran and may have committed.
- **After a transport failure**, only when the adapter reports `wasDefinitelyNotSent: true`, proving that no request bytes reached the server. An adapter that cannot tell reports nothing, which is treated as unsafe. The transport condition is part of the rule: on a real response delivery is already settled the other way, so nothing can unlock a replay there.
- **After a thrown adapter error** (including a per-attempt timeout), never. There is no response to draw evidence from, and a timeout in particular means the request was sent and the answer never came back.

`PUT` and `DELETE` are _not_ affected, even though they mutate. Both are idempotent by definition: repeating one leaves the resource in the same state as doing it once, which is exactly what makes replay safe.

Opt in when writes are guarded by an idempotency key, or are naturally safe to repeat:

```typescript
// For every request from this client
const client = new HTTPClient({
  adapter,
  retryPolicy: { strategy: 'exponential', maxRetryAttempts: 3 },
  retryNonIdempotentMethods: true,
});

// Or per request, overriding the client config either way
await client.post('/orders').json(order).retryNonIdempotentMethods(true).send();
```

This only ever _removes_ retries relative to the retry policy. It never introduces one, and it does nothing unless a retry policy is active.

`MockAdapter` reports the status, headers, and cookies you set while forcing `body` to `null`, so the branch can be tested without a real socket:

```typescript
adapter.routes.post('/orders', () => ({
  status: 200,
  body: { id: 1 }, // discarded — a real post-header failure loses the body
  streamError: true,
}));

const response = await client.post('/orders').send();
// response.status         === 200
// response.isStreamError  === true
// response.body           === null
// response.isFailed       === true, and the request was not retried
```

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
MockTransportErrorOptions;
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
