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
  - [Uploads That Outlive the Response](#uploads-that-outlive-the-response)
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
  - [Abort Listeners That Throw](#abort-listeners-that-throw)
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
  - [Writing Your Own `WritableLike`](#writing-your-own-writablelike)
    - [How Long That Listener Stays](#how-long-that-listener-stays)
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
  baseURL?: string; // Origin / prefix for relative paths: a string with no query or fragment. If set, MockAdapter, NodeAdapter, and server-side FetchAdapter require an absolute http(s):// URL.
  defaultHeaders?: RequestHeadersInput; // Values may be null/undefined: no header
  timeout?: number | null; // Default: 30,000 ms; <= 0 disables the per-attempt timeout.
  // NaN or a non-number throws; Infinity disables it like 0 does.
  // Same rules for the per-request override, whose default is this value.
  maxResponseBytes?: number | null; // Default: 64 MiB (DEFAULT_MAX_RESPONSE_BYTES); the most bytes of a buffered response body the client holds.
  // A positive integer, or Infinity for no limit. See Response Size Limit.
  cookieJar?: CookieJar | null; // Cookie management (null disables)
  retryPolicy?: RetryPolicyOptions; // Retry strategy (disabled by default)
  retryNonIdempotentMethods?: boolean; // Default: false - retry only the RFC 9110 idempotent methods (GET, HEAD, OPTIONS, TRACE, PUT, DELETE), not POST, PATCH or a custom one such as LOCK. See Non-Idempotent Methods
  includeRequestID?: boolean; // Default: false - sends x-local-client-request-id header
  includeAttemptHeader?: boolean; // Default: false - sends x-local-client-request-attempt header with the 1-based attempt number as a decimal string. The counter is global across redirect hops: attempt 2 on a redirect hop follows attempt 1 on the initial request, not reset per hop.
  userAgent?: string; // Auto-set to 'lifecycleion-http-client' for NodeAdapter and MockAdapter, and for FetchAdapter on server runtimes. Browsers block this header - constructor throws if set with FetchAdapter or XHRAdapter in a browser.
  followRedirects?: boolean; // Default: false (security-conscious default)
  maxRedirects?: number; // Default: 5 (only meaningful when followRedirects: true; throws at construction unless followRedirects: true; must be a whole number >= 1)
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
`followRedirects`, `retryNonIdempotentMethods`, `includeRequestID` and `includeAttemptHeader` must be booleans, `userAgent` a string, and `cookieJar` a `CookieJar`; `null` or omitted reads as unset - the default (`cookieJar: null` is no jar; see [Sub-Clients](#sub-client-creation) for which a sub-client inherits on `null`) - and anything else throws a `TypeError`, as does a sub-client `defaultHeadersStrategy` other than `'replace'`, `'merge'` or unset (`'replace'`). A request's `retryNonIdempotentMethods` option may be a boolean or unset, falling back to the client's; the builder's `.retryNonIdempotentMethods()` takes a boolean only. Client `defaultHeaders` is copied at construction - names lowercased, unset values dropped - so changing the object afterwards does not affect the client or its sub-clients; change a header for some requests with an interceptor or a sub-client. Client `retryPolicy` is validated and copied at construction. The internal snapshot is frozen and may be shared with sub-clients. Subclasses must not mutate `this._config.retryPolicy` in place; supply a new policy through client or sub-client configuration instead. A per-request
`.retryPolicy(options)` is validated and copied when called, before request interceptors
run. Invalid retry durations throw there, and later mutations to the supplied object do
not change the policy. Each request starts with a fresh retry budget; `null` on the
builder disables retries inherited from the client.

**Invalid timeouts, size limits, retry policies and bodies throw synchronously.** A
`timeout` that is `NaN` or not a number (a `TypeError`), a `maxResponseBytes` that is not
a positive integer or `Infinity` (a `TypeError`), or an invalid `retryPolicy`, throws from
the call that supplies it: `new HTTPClient()`, `createSubClient()`,
`client.get(path, { timeout, maxResponseBytes, retryPolicy })` and the other method helpers,
`.timeout()`, `.maxResponseBytes()`, and `.retryPolicy()`. So does a request body that
cannot be copied (see [Body Types](#body-types)) - one of an unsupported type (a
`TypeError`), a `BigInt` or a circular reference, a getter or `toJSON` that throws - from
`.body()`, `.json()`, `.text()`, `.formData()`, or `client.post(path, { body })` and the
other method helpers. It never reaches `send()`, so it does not resolve as a
`request_setup_error` and no `'error'` observer sees it. A malformed setting is a
programming mistake that no retry or response handling can repair, so it fails where it
was written.

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
- In a browser runtime, a URL still relative after `baseURL` - every relative path when `baseURL` is omitted (MockAdapter aside, see below), or one joined to a relative `baseURL` (`/api`, `api`) - is resolved against the document's base URL (a worker's location), as `fetch` and XHR resolve it: from a page at `https://app.test/dir/page`, `v1/users` is `https://app.test/dir/v1/users`, and `users` under `baseURL: 'api'` is `https://app.test/dir/api/users`. Unlike a configured `baseURL`, the page URL is not treated as a directory.
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
  .maxResponseBytes(1024 * 1024) // per-request response size limit override (null inherits)
  .retryPolicy({ strategy: 'fixed', maxRetryAttempts: 2, delayMS: 1000 }) // per-request retry override
  .retryNonIdempotentMethods(true) // POST is not retried by default; safe here because of the idempotency key
  .label('create-user') // non-empty grouping label for cancel/list filtering
  .params({ source: 'web' }) // appended to query string
  .onUploadProgress((e) => console.log(e))
  .onDownloadProgress((e) => console.log(e))
  .onAttemptStart((e) => console.log(e))
  .onAttemptEnd((e) => console.log(e))
  .signal(controller.signal) // external AbortSignal, composed with builder.cancel()
  .streamResponse((info, ctx) => writable); // NodeAdapter only - pipe response body to a writable stream

const response = await builder.send();
```

A header value of `null` or `undefined` - or such an item in an array - means no header: a request's `.headers({ authorization: undefined })` removes that client default for the request, a sub-client merging `defaultHeaders` removes the parent's the same way, and an interceptor removes one with `{ ...request.headers, authorization: undefined }`. Header names are case-insensitive and are sent lowercased. `.headers()`, and `headers` in the request options, copy the record's own entries when called, an array value included, so a header or array item added afterwards is not sent. The client's own `user-agent` is applied after a request's headers, so a request's `headers` neither change nor remove it: set `userAgent` on the client, or change or remove it in an interceptor. The request-ID and attempt headers are added to every attempt and follow `includeRequestID` and `includeAttemptHeader` only.

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

| Method / value       | Content-Type set                                      | Notes                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.json(data)`        | `application/json; charset=utf-8` for an object/array | The same as `.body(data)`: an object or array is serialized via `JSON.stringify`. A string is sent as `text/plain; charset=utf-8` and a number or boolean is refused - see the note below for a JSON primitive. `null` or `undefined` is no body.                                            |
| `.text(str)`         | `text/plain; charset=utf-8`                           | UTF-8 encoded                                                                                                                                                                                                                                                                                |
| `.formData(fd)`      | _(none, set by adapter)_                              | The library does not set this header. The adapter, or browser runtime, sets `multipart/form-data` with the boundary. Not visible in `request.headers` inside interceptors. Use `request.body instanceof FormData` to detect it.                                                              |
| `.body(data)`        | Inferred from value type (see below)                  | Generic form. Accepts JSON objects/arrays (`application/json; charset=utf-8`), strings (`text/plain; charset=utf-8`), Uint8Array (`application/octet-stream`; another realm's, such as a `vm` context's or a `Buffer` under jsdom, included), FormData (see `.formData`), null, or undefined |
| `undefined` / `null` | none                                                  | No body sent                                                                                                                                                                                                                                                                                 |

> **Note:** Passing `null` or `undefined` to any body method, including `.json()`, always results in no body and no `Content-Type`, as does an object whose own `toJSON` answers `undefined`, which `JSON.stringify` serializes to nothing. This applies across all methods since serialization is type-based, not method-based. To send a JSON primitive - `null`, a string, a number - serialize it yourself and say what it is: `.body(JSON.stringify(value)).headers({ 'content-type': 'application/json' })`.

**The body is copied when you hand it over.** `.body()`, `.json()`, `.text()`, `.formData()` and the `body` request option each take a copy the client owns, as `.headers()` and `.params()` do, so changing the object, `Uint8Array` or `FormData` you passed afterwards - before `send()`, or from `onAttemptEnd` between attempts - changes nothing that is sent or reported, on any attempt, retry or `307`/`308` replay. A JSON body (a plain object or an array) is copied as the data it serializes to: run through `JSON.stringify` once and parsed back, so every attempt sends exactly the text `JSON.stringify` gave for your value when you passed it - unless an interceptor changes the body - and request interceptors see plain data - a `Date` as its ISO string, a class instance as a plain object, a `Map` as `{}`, an `undefined` member dropped (`null` in an array). A top-level `toJSON` that answers a string, a number or `null` is kept as a plain object whose own `toJSON` answers that value, so the body still serializes to the same text. Bytes are copied: a `Buffer` as a `Buffer`, so an interceptor can still call `request.body.toString('base64')`, and any other `Uint8Array` - a subclass, or another realm's `Buffer` - as a plain `Uint8Array`. A `FormData` is copied entry by entry, its `Blob` and `File` entries kept as they are. On Bun, a form's entries report a `File` appended under a new filename (`fd.append('f', file, 'renamed.txt')`) by its original name, and one named `''` by none, so the copy - and with it every adapter - sends that name; wrap the file in a `File` with the name you want before appending it. A string is kept as it is. A body that cannot be copied throws from the setter, and nothing is sent: a getter or `toJSON` that throws (its own error), a `BigInt` or a circular reference, a `Proxy` over a form, or a body of an unsupported type such as a `URLSearchParams` or a `Proxy` over a `Uint8Array` (a `TypeError`).

Request interceptors are handed the copy unserialized, and it is serialized when each attempt is dispatched, as axios serializes after its interceptors. Since they are handed the copy, an interceptor cannot encode data JSON cannot hold - a `BigInt` through its own replacer, a `Map`, msgpack: `.json({ amount: 10n })` throws from the setter, and a `Map` member reaches the interceptor as `{}`, as `JSON.stringify` would send it. Encode such a body before handing it over, as a string or bytes with its own `Content-Type` (`.body(encoded).headers({ 'content-type': ... })`). A `bodyContainsKeys` filter reads the copy too: a key holding `undefined` is not there, the keys beside a top-level `toJSON` are gone - the copy is what it answers - and a nested class instance's fields are found as a plain object's are. When an interceptor's function runs, the body the phase's chain returns is copied the same way once the chain ends, so an interceptor that keeps the body it returned, or the one it was handed, and changes it later - from an observer, say - changes no later attempt or replay. A body an interceptor returns that cannot be copied fails the request as `request_setup_error`, before an attempt begins in the initial and redirect phases, while one of an unsupported type fails it as `interceptor_error`. On a `GET` or `HEAD` that FetchAdapter, or XHRAdapter in a browser, refuses a body on, a body that cannot be copied cannot serialize to nothing either, so the method is refused as `interceptor_error`, as it is with any other body. A `retry`-phase interceptor is handed a copy of the body each retry starts from, so an edit it makes in place (`request.body.retries = ...; return request`) goes out with that retry and is not made again on top of itself on the next. A `redirect`-phase interceptor is handed a copy of the hop's body too, so an edit it makes in place goes out with the next hop and never reaches the upload of the hop that answered, which may still be under way.

`NodeAdapter` writes a `FormData` body as `fetch` does (the WHATWG multipart encoding): field names and filenames as UTF-8, with `"`, CR and LF percent-encoded, and no `filename*=`, so a server reads the same names whichever adapter sent them - on Node. On Bun a `File` appended under a new filename is sent under its original name, and one named `''` as `blob` (see [Body Types](#body-types)). A file part whose `File` cannot be read (missing, a directory, no permission) fails the request as a non-retryable `adapter_error` whose `cause` is `Request body source could not be read`, with the read failure itself (`ENOENT`, `EISDIR`, ...) as that error's own `cause` - `error.cause.cause`. A part the adapter cannot size or write fails the same way, as a non-retryable `adapter_error`: a `name`, `type` or `size` getter that throws (the thrown value is `error.cause.cause`), a `type` that is not a string, a `size` that is not a whole number of bytes, or a form that cannot be read as one (a `Proxy` over a `FormData`), all under `Request body source could not be read`, and a `stream()` that yields a chunk other than a `Uint8Array` (one from another realm is accepted), under `Request body source produced a chunk that is not a Uint8Array`. The form is read through `FormData.prototype.entries`, never an `entries` a subclass or the form itself declares. Caught while the body is being sized, before anything is sent; a getter that throws only on the second read, and a chunk that is not a `Uint8Array`, are caught while the body is being written, so the request has gone out with part of its body. A caller-set `Transfer-Encoding` header is refused by `NodeAdapter`, which frames every body with a `Content-Length` itself, and so is an `Expect` header, since `NodeAdapter` does not wait for `100 Continue` (Node would send the headers before the length is set), and a caller's `Content-Length` on a request with no body is dropped. `NodeAdapter` does not switch protocols or open tunnels: an `Upgrade` header or a `CONNECT` request is refused, as is a body of any type other than a string, `Uint8Array` or `FormData` when the adapter is called directly, before any upload progress is reported or a connection is opened.

### Query Parameters

Parameters passed via `.params()` are merged into the URL query string using the `qs` library, which supports nested objects and arrays.

```typescript
client
  .get('/search')
  .params({ q: 'hello', filter: { active: true }, tags: ['a', 'b'] })
  .send();
// → /search?q=hello&filter%5Bactive%5D=true&tags%5B0%5D=a&tags%5B1%5D=b
```

An existing query string in the path is kept as written, and `.params()` is added after it. When the same top-level key appears in both, the `.params()` value wins and the path's pairs for that key are left out; a `.params()` value of `undefined` (or an object of nothing but `undefined`) is not given, and leaves the path's pairs alone, while an empty array or object is given and clears them. `.params()` takes a plain object; `null` or `undefined` clears the params set so far, and a `URLSearchParams`, `Map` or string throws a `TypeError`. Its own top-level entries are copied when `.params()` is called, each read once - the same for `params` in the request options - so adding, removing or replacing a key on the object afterwards does not change the request, and a top-level getter that throws throws from `.params()`. An array value is copied too, one level deep and with any holes kept, so an item added to it afterwards is not sent; an object value, and anything inside an array, is kept as given and serialized when the request is sent.

## HTTPResponse

```typescript
interface HTTPResponse<T = unknown> {
  status: number;
  headers: Record<string, string | string[]>; // Lowercase keys; set-cookie is always string[]
  body: T; // Parsed or raw - see below
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
  requestBodySettled?: Promise<Error | undefined>; // Optional adapter-reported upload outcome; see Uploads That Outlive the Response
}
```

`isFailed` is `true` only for client-level failures, not for HTTP error statuses. A 404 or 500 HTTP response has `isFailed: false` (the server responded and returned a status code). Most failures report `status: 0`, but four can carry a nonzero one: a stream error (see [Stream Errors and Replay](#stream-errors-and-replay)), a `stream_setup_error` (the factory was called for an answer whose headers had arrived), and an `adapter_error` for an answered response the client could not read (see [Error Codes](#error-codes)) keep the real status, and a transport failure an adapter reports with `isTransportError: true` keeps whatever status the adapter gave. Any of them can be `isFailed: true` with a `2xx` or `3xx` status, so check `isFailed` before trusting `status`. A timeout reports `status: 0`; only a body that timed out mid-stream, or one whose stream factory was still setting up, keeps its status. A cancel and a timeout are exclusive: a request cancelled after its timer fired is `isCancelled`, not `isTimeout`. An answer that arrives after its attempt's timer fired - from an adapter that does not stop on abort - is handled as any answer is: delivered if it can be read, an `adapter_error` keeping its status if not. That holds while the answer arrives within a second of the timer firing. After that, the attempt has already ended as a timeout (see [AbortSignal Integration](#abortsignal-integration)).

#### Uploads That Outlive the Response

For ordinary requests, the server receives the body and then responds. No separate upload tracking is needed. This section covers the less common case where a server responds early, while the client may still be sending the body. Receiving a response confirms that the server answered, but it does not necessarily confirm that the entire upload was sent.

`NodeAdapter` exposes `requestBodySettled` on bodied requests to track that separate upload outcome. The client uses it to wait before following a redirect or dispatching a retry. `FetchAdapter` exposes the response status and body, but no separate upload-completion signal, so it cannot provide that wait.

In browsers, `XHRAdapter` adds upload progress but currently does not expose `requestBodySettled` either. Progress reporting does not provide the same client-managed wait. XHR also follows redirects automatically before this adapter can detect them. Browser `FetchAdapter` blocks redirects instead. Neither browser adapter supports client-managed redirect following.

`requestBodySettled` resolves with an `Error` if the upload failed or with `undefined`
if the adapter finished writing it. It never rejects. For `NodeAdapter`, it is available
once a supported body has entered the adapter's upload tracking, including when the
response arrives after the upload has finished. It does not prove that the server
processed or committed the data. The same outcome is shared by the attempt's retry,
redirect, and response handling. An upload Error is always a wrapper, on every runtime:
the adapter's original Error is its `cause`, and it copies the original's readable
`message`, `name`, `stack`, and `code`, plus a Node system error's `errno`, `syscall`,
`address`, `port` and `path`, so `error.syscall === 'write'` still reads as it would on
the original. `instanceof` does not: check `error.cause` for the original's class. A rejection with a non-Error value is normalized
into an Error that likewise carries the value as `cause`. Inspect `cause` for the
original's identity, class, or other custom fields.

Check that the field exists before interpreting its resolution:

```ts
const response = await client.post('/upload').body(form).send();

if (response.requestBodySettled !== undefined) {
  const uploadFailure = await response.requestBodySettled;
  if (uploadFailure) {
    // Handle an incomplete upload separately from the HTTP response status.
  }
} else {
  // No upload outcome was reported; absence does not establish upload success.
}
```

The client carries reported outcomes onto cancellation, timeout, transport-error, and
redirect results. Absence means no adapter reported an outcome: for example, a bodiless
request, a request refused before upload tracking began, or an adapter without this
capability. The final response carries the outcome of the latest attempt that had a
body, or that reported one (a custom adapter may report one for a bodiless request),
across retries and redirects: a bodied `POST` that becomes a bodiless `GET` after a
redirect, or a retry whose interceptor dropped the body, still reports the bodied
attempt's outcome. If that latest bodied attempt was given up on after its adapter
ignored the abort, the outcome resolves with an `Error` saying the upload's fate is
unknown; if it reported none - a custom adapter's failure that carried none - the response
reports none either. Neither reports an earlier attempt's or hop's. A body that sends
nothing - an empty string, no bytes, a form with no entries - is no body here.
Redirect-phase observers see that hop's outcome.

Before following a redirect or retrying, the client waits for a reported upload outcome.
Cancellation ends the wait. The request's `timeout` bounds inactivity during this wait,
including silence since dispatch. Upload-progress reports restart that inactivity clock:
the client hands an adapter an `onUploadProgress` for every request with a body to watch
for them, except an `xhr` adapter, which is handed one only for a request that asked for
upload progress (see [XHRAdapter](#xhradapter)).
On expiry, the client returns a timeout, aborts the attempt, and reports the stalled
settlement through the global `'error'` channel. `timeout: 0`, negative values, and
`Infinity` disable this client wait bound. A custom adapter that supplies the promise
must settle it and honor cancellation.
A `null` or omitted request timeout inherits the client timeout. Explicit `NaN` or another non-number
throws before dispatch; finite negative values and either infinity retain the documented
disabled-timeout behavior. Do not pass an expired `deadline - Date.now()` directly: a zero or negative result disables the timer, rather than timing out immediately. Check whether the deadline has passed before sending the request.

`NodeAdapter` also watches uploads left running after an early response closes. It checks
socket progress at roughly five-second intervals and allows a pending multipart source
read roughly sixty seconds before declaring it stalled; once that read answers, the socket
again gets the full five seconds to accept what it produced. A connection that closes, or that
the adapter tears down, while a multipart source read is pending cancels that read and
settles the upload outcome with a failure. These adapter safeguards are
separate from the client's timeout. Continuing progress does not waive the normal
per-attempt response deadline.

The upload outcome is advisory: its resolved error does not itself change the received
status, `isFailed`, `isNetworkError`, or retry eligibility. This preserves an early `413`
and its explanation even if the server stops reading the body - as long as the answer
reaches the client. A server that closes the connection with the body unread can reset
it before the client has read its answer: nginx avoids this by reading and discarding the
rest of the body for a while (`lingering_close`, on by default), but a server that does
not linger can make the upload fail as a transport error (`status: 0`) on Node, where
writing into the reset connection fails before the buffered answer is read. Bun reads the
answer first. Such a failure is retried as any transport failure is, for an idempotent
method. Failures detected after an early response are also reported on the global
`'error'` channel, including a connection reset while a `streamResponse` factory is still
opening its sink. An upload cut short because the adapter itself ended the connection - a
cancel or timeout, a stream factory that declined or failed, a streaming sink that
failed, a response body over `maxResponseBytes` or one that fails to decode - settles
`requestBodySettled` with that failure but is not reported there. A timeout while the
client waits to dispatch another hop is a separate request failure.

### Content-Type Detection and Body Parsing

The response `Content-Type` header determines how the body is parsed. Only its media type is read - the first one, when fetch or XHR joined a repeated header, and without its parameters, case-insensitively:

| Media type                                    | `contentType` | Body type                 |
| --------------------------------------------- | ------------- | ------------------------- |
| `application/json`, or ends with `+json`      | `'json'`      | Parsed via `JSON.parse()` |
| Starts with `text/`                           | `'text'`      | UTF-8 decoded string      |
| `application/x-www-form-urlencoded`           | `'text'`      | UTF-8 decoded string      |
| Absent or anything else (`application/jsonl`) | `'binary'`    | Raw `Uint8Array`          |

`isText` mirrors `contentType === 'text'`. `isJSON` is `true` only when JSON parsing actually succeeded, and it stays `false` on a parse failure. `isParseError` is `true` when the server sent a JSON `Content-Type` but the body could not be parsed. In that case `contentType` is still `'json'`, `isJSON` is `false`, and `body` falls back to the raw string. An empty body is no body, whatever the `Content-Type` and the adapter: `body` is `null` and `isParseError` is `false`.

### Response Size Limit

A buffered response body is held whole in memory before it is parsed, so the client bounds it: `maxResponseBytes`, 64 MiB by default (`DEFAULT_MAX_RESPONSE_BYTES`). A body past the limit fails the request as `response_too_large` - except on a redirect the client is about to follow, whose body is never read, so a "Moved" page past the limit does not stop the redirect:

```typescript
const client = new HTTPClient({ maxResponseBytes: 10 * 1024 * 1024 }); // 10 MiB

// Per request: raise it, lower it, or turn it off with Infinity.
const builder = client.get('/export').maxResponseBytes(Infinity);
const response = await builder.send();

if (builder.error?.code === 'response_too_large') {
  console.log(response.status); // the server's real status
}
```

- **Where it is set.** `HTTPClientConfig.maxResponseBytes`, a sub-client's override (null or omitted inherits the parent's value), the `maxResponseBytes` request option, and `.maxResponseBytes()` on the builder (null or omitted inherits the client's value). It is a positive integer, or `Infinity` for no limit; anything else - `0`, a negative or fractional number, `NaN`, a non-number - throws a `TypeError` where it is given.
- **What is counted.** The body as it is handed over: decoded, where the adapter decodes a compressed response (`NodeAdapter`, and `fetch` itself), so a small gzip body that inflates past the limit is refused. The network adapters stop reading once the count passes the limit, rather than buffering the whole body first, and release the connection. `NodeAdapter` and `FetchAdapter` refuse a `Content-Length` already over the limit before the body is read, where it counts the bytes handed over - not for a response they decode, whose length counts the encoded bytes (with `decompress: false`, `NodeAdapter` decodes nothing, so a compressed response's length is refused up front too). `XHRAdapter` stops on download progress, which counts encoded or decoded bytes for a compressed body depending on the runtime (Chrome counts decoded, Firefox and React Native's Android networking encoded), and encoded bytes have no fixed bound on the decoded size. So only a body it can tell carries no coding is stopped there, as soon as those bytes pass the limit: one whose `Content-Encoding` it can read as `identity` (or empty), or one with none on a browser response whose request and final URL are both same-origin with the page. A browser hides `Content-Encoding` on a cross-origin response unless the server lists it in `Access-Control-Expose-Headers`, and outside a browser a runtime may decode the body itself and drop the header, so there its absence proves nothing. Every other body is checked exactly by its decoded size once it has loaded - so a compressed body that inflates past the limit, or one whose coding cannot be read, is refused only once the runtime holds it whole. Use `FetchAdapter` where a small compressed response could decode to more than you want held. `MockAdapter` applies it to the serialized route body.
- **Buffered responses only.** A body piped to `streamResponse` goes to your writable and is never held by the client, so it is not limited. A body too large to buffer is what `streamResponse` is for - but a factory is only called for a `200` with a body: a `streamResponse` request answered with another status (a `206` to a `Range` request) is buffered, and limited.
- **Every adapter.** The client checks a body handed over by any adapter, a custom one included, against the limit too. An adapter driven directly reads `maxResponseBytes` off its request by the same rule - a positive integer or `Infinity`, absent for none - and refuses anything else, a getter that throws included, with a non-retryable `TypeError`.
- **How it fails.** As a stream error: the response keeps its real status and headers, with `isStreamError: true`, `isFailed: true` and a `null` body. The error's `cause` states the limit. The adapter stopped reading, so none of the body reached you, and the status is the whole answer: a retryable status (a `503` with an oversized maintenance page) is retried as the retry policy allows, and any other is final (see [Stream Errors and Replay](#stream-errors-and-replay)). A `3xx` the client follows is not failed by it: its body is never read, so the redirect is followed as a bodiless one.
- **Stream chunks.** With a finite limit, `FetchAdapter` reads the response stream itself and fails a chunk that is not a `Uint8Array` as a `stream_response_error`, as the Fetch standard's `arrayBuffer()` does. Bun's `arrayBuffer()` accepts text and other binary chunks, so on Bun a `Response` built over such a stream (a test double, say) is read with `maxResponseBytes: Infinity` but refused under a limit.
- **Observers.** The attempt snapshot reports the limit the attempt ran under as `request.maxResponseBytes`.

## Error Handling

`send()` always resolves for request outcomes handled by the client runtime. HTTP errors (4xx/5xx), timeouts, cancels, transport failures, redirect control-flow failures, and other client-managed failure states all produce a settled `HTTPResponse` with no exception. Check `response.isFailed` for client-level failures and `response.status` for HTTP errors.

`send()` rejects (returns a rejected promise) only for programming errors around builder/client usage: calling it on a disabled client, calling it a second time on the same builder, calling it after `builder.cancel()` was already called pre-send, or a value the caller supplied that throws while the request is set up, before any interceptor runs - a getter nested in `params`, or a header value whose `toString` throws. For a disabled client or a value that throws during setup, the builder then ends `failed` - or `cancelled`, when a `cancel()` made during that setup was held (see Cancellation) - with no `error` and no error observers run; the other two leave its state as it was.

```typescript
const builder = client.get('/users/999');
const response = await builder.send();

if (response.isFailed) {
  // Client-level failure (timeout, cancelled, network error, redirect handling failure, etc.)
  const err = builder.error; // HTTPClientError, set whenever isFailed is
  console.log(err?.code, err?.message);
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
  cause?: Error; // Normalized underlying failure; a wrapped non-Error value is retained on cause.cause
  initialURL: string;
  requestURL: string; // URL of the last adapter attempt, or the redirect target if redirect handling failed before the follow-up was dispatched
  wasRedirectDetected: boolean;
  wasRedirectFollowed: boolean;
  detectedRedirectURL?: string;
  redirectHistory: string[]; // Redirect target URLs recorded during redirect handling, in order
  requestID: string;
  isTimeout: boolean;
  isRetriesExhausted: boolean; // true when the last failure was retryable but every retry attempt was spent
  cancelReason?: string; // set when cancelled with an explicit string reason - via builder.cancel('reason'), client.cancel(id, 'reason'), client.cancelAll/Own/WithLabel('reason'), controller.abort('reason'), or an interceptor/stream factory cancel
}
```

### Error Codes

| Code                    | Meaning                                                                                                                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network_error`         | Transport-level failure before a response was received                                                                                                                                                                                                                        |
| `timeout`               | Request exceeded the configured timeout                                                                                                                                                                                                                                       |
| `cancelled`             | Request was cancelled via `builder.cancel()`, `client.cancel()`, AbortSignal, or an interceptor/stream factory cancel                                                                                                                                                         |
| `redirect_disabled`     | A redirect response with a `Location` was received but `followRedirects` is `false`                                                                                                                                                                                           |
| `redirect_loop`         | The configured `maxRedirects` limit was reached                                                                                                                                                                                                                               |
| `request_setup_error`   | Request setup or local orchestration failure before a normal adapter response was produced (e.g. invalid configuration, a body an interceptor returned that cannot be copied, unresolved URL)                                                                                 |
| `adapter_error`         | The adapter threw an unexpected error, or resolved a response the client could not read (the latter is never retried)                                                                                                                                                         |
| `interceptor_error`     | A request interceptor threw, or returned a request that is unreadable or invalid                                                                                                                                                                                              |
| `stream_write_error`    | Writing chunks to the StreamResponseFactory writable failed                                                                                                                                                                                                                   |
| `stream_response_error` | The upstream response stream errored after headers arrived                                                                                                                                                                                                                    |
| `stream_setup_error`    | The StreamResponseFactory threw an error during setup, returned something other than a writable, `null`, or a cancel object, or the attempt timed out while it was still setting up (`isTimeout: true`, not retried: the factory may have opened its sink)                    |
| `response_too_large`    | A buffered response body passed `maxResponseBytes`. The real status and headers are kept, with `isStreamError: true`; retried only on a retryable status (a `503` with an oversized page), as the status alone is the answer. See [Response Size Limit](#response-size-limit) |

When `adapter_error` comes from a response the client could not read, the server did answer, so the response keeps the status that answer carried (the same status `onAttemptEnd` reports) and its headers once they were normalized, with `isFailed: true`, `isNetworkError: false` and a `null` body, as a stream error keeps its real status. Treat `isFailed` and the error code as authoritative, not the status. The status is `0` when the response object's own fields could not be read, and the headers are empty when they were what failed. `wasRedirectDetected` and `detectedRedirectURL` are the adapter's own when its response object was read, as on a healthy response. When there was none to read them from - a cookie jar that threw on a body stream aborted after headers, or a response whose own fields could not be read - they are derived from the status and `Location`. When it was the configured cookie jar that threw while storing the response's `Set-Cookie`, the error's `message` is `Cookie jar failed to process response headers` and its `cause` is what the jar threw. A cancel takes precedence over a jar failure, and so does a per-attempt timeout that cut the body stream: the request ends as that cancel or timeout instead. A jar failure on an answer that arrived whole is this `adapter_error` even if the attempt's timer had fired.

This covers a JSON or text body the adapter resolved as something other than bytes. It is decoded only where the body is used: the final response, a retry's response, and the response handed to `redirect`-phase observers, which is built whether or not any are registered. A `3xx` due to be followed with such a body therefore ends the request as `adapter_error` instead of being followed, while a refused redirect (`redirect_disabled`) or one past `maxRedirects` (`redirect_loop`) never reads its body and is unaffected. It also covers an `AbortError` thrown while the client reads an answered response: unless the request was cancelled, that is this `adapter_error`, not a cancel. If the attempt had timed out and that `AbortError` is the timeout's, it is a timeout (`status: 0`, retried as the policy allows) even though the answer arrived.

## Request Interceptors

Each run of an interceptor or response/error observer chain snapshots its
registrations when it begins. A request runs these chains once per phase: the initial
interceptors, then again for each retry, each redirect hop and the final outcome.
Adding or removing a callback while a chain is running affects the next chain run,
which can be a later phase of the same request; removing an earlier callback cannot
skip a later one in the current snapshot. A sub-client's chain run snapshots its
parent's registrations and its own together, so a parent callback that registers one
on the sub-client does not run it in that same chain run.

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
  { phases: ['initial', 'retry'], hosts: ['api.example.com'] }, // phases default: ['initial']
);

// Later: removeInterceptor()
```

The `hosts` filter keeps the token to the API's own host. Without it, the interceptor would run for every host, including a redirect target. On a redirect hop to another origin, the client drops a header that a `retry`-phase interceptor adds, unless it is on the cross-origin allow-list. See [Redirect Handling](#redirect-handling).

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
  headers: RequestHeadersInput; // Return a null/undefined value to remove a header
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

**Each interceptor's returned request is copied once.** The client copies its
`requestURL`, `method`, `headers` and `body` into a new plain object of its own, and that
copy is what the next interceptor that runs in the phase reads - its filter and the
interceptor itself - and, once the chain finishes, what the request is checked and sent
with. The next interceptor therefore receives the copy, not the object the earlier one
returned: other properties are dropped, header names are lowercase, header values are
strings or arrays of strings (as described below), a header removed with `null` or
`undefined` is absent, and changing an object an earlier interceptor kept a reference to
does not change the request. A result that is not a valid request fails as an
`interceptor_error` where it is copied, even when a later interceptor would have
replaced it, and is reported from that result whatever is registered after it. A standard method (`GET`, `HEAD`, `POST`, `PUT`, `DELETE`,
`OPTIONS`, `PATCH`, `TRACE`) is uppercased whatever its case, so a `post` is treated as `POST` by
the retry and redirect rules; any other method is case-sensitive and passed to the
adapter as given, as `request()` passes it too. What goes on the wire depends on the
transport: Node's `http`, which `NodeAdapter` uses on Node and Bun alike, uppercases it, Node's `fetch` sends it as given, and Bun's
`fetch` uppercases a method it knows (`purge` goes out as `PURGE`) and would send one it does not know as `GET` - `FetchAdapter` refuses a
request whose method the runtime's `fetch` would change, its case included, as a non-retryable `adapter_error` rather than sending it, so use `NodeAdapter` for a custom method on Bun. `CONNECT` is refused on every adapter (it opens a tunnel), and
`TRACE` and `TRACK` are refused before dispatch through `FetchAdapter`, and through
`XHRAdapter` in a browser, since those refuse them. A `GET` or `HEAD` with a body is
refused before dispatch through `FetchAdapter`, and through `XHRAdapter` in a browser,
since `fetch` refuses one and a browser's `XMLHttpRequest` silently sends it without the
body (an XHR outside a browser - React Native, a shim - may send it, and is let through); use
`NodeAdapter` to send it, or an interceptor to rewrite it (these method checks run on the
interceptors' result, with its body as the client's copy of it, the one that is sent; on a
retry held to a cross-origin hop's own request, on the stripped request that is sent, with the
hop's own body - see [Redirect Handling](#redirect-handling)). An empty string, bytes or form is a body there; a JSON body whose
`toJSON` answers `undefined` serializes to nothing, and goes out with none - an interceptor's is read
once, when its copy is taken. Header entries are copied at that
point: a single value is converted to a string, an array stays an array with each
element converted to a string, and a one-element array becomes that element's string.
Every later check and use (the next interceptor's filter, URL validation, the
browser-restricted header check, cookie-jar lookup, dispatch) reads that copy. A getter on
the returned object, on the header record or on one of its entries is therefore consulted
exactly once, by that copy, when it succeeds, and a URL that passed validation is the URL the
request is sent to. If copying fails, the best-effort snapshot for error observers may
read those values again. Any failure while taking that copy is an `interceptor_error`:
a `requestURL` or `method` that is not a string, `headers` that is not a plain object
(an array, a `Headers` or a `Map` is refused rather than read as empty; a plain object
from another realm, such as a `vm` context, is accepted), a getter that throws, or a
header value whose string conversion throws.

### Filter Options

```typescript
interface RequestInterceptorFilter {
  phases?: ('initial' | 'retry' | 'redirect')[]; // Default: ['initial']
  methods?: HTTPMethod[];
  hosts?: string[]; // Exact hostnames or wildcard patterns. '*.example.com' = one subdomain label only; '**.example.com' = any depth. Neither matches the apex - list it explicitly. '*' matches everything. PSL tail guard prevents '*.com'-style patterns.
  schemes?: ('http' | 'https')[]; // Match on request scheme. requestURL is absolute whenever it could be resolved before dispatch - MockAdapter synthesizes `http://...` URLs when no baseURL is configured, browser adapters resolve against window.location, Node adapter requires absolute URLs.
  bodyContainsKeys?: string[]; // Dot-path object matching like 'data.results'; array indexing is not supported; the body must be a plain object at the root level - JSON array responses never match
}
```

A standard method in `methods` is matched case-insensitively, and any other exactly. It must be an array of method names (or omitted). The callback must be a function and the filter an object (or omitted), or adding it throws a `TypeError`; so does a filter field that kind of callback does not take (`statusCodes` on an error observer, `contentTypes` on an interceptor) or a misspelled one. Every filter field is checked when the callback is added - each list must be an array of strings (`statusCodes`: numbers), and `phases`, `schemes` and `contentTypes` may only name ones that callback can see - and the filter is copied then, so changing it afterwards has no effect. The observer filters below follow the same rules. A request interceptor's filter that throws while it is matched - a `bodyContainsKeys` reading a body whose getter throws, say - fails the request as `interceptor_error`, as the interceptor throwing would. An observer's filter that throws is reported and that observer skipped, since an observer cannot change the request. All specified filter fields are ANDed together. Within each field, values are ORed. Any one match is sufficient. An empty `phases: []` matches all phases; any other empty list (`hosts: []`, `statusCodes: []`, ...) is refused when the callback is added, since it would either never match or match every request - omit the field to match every request. So is an entry that can never match: a `hosts` entry the matcher can never match - a scheme, path or port (`api.test:8080` - give the hostname alone), an empty label, a wildcard mixed into a label (`*api.example.com`), a wildcard whose fixed tail is an ICANN public suffix (`*.com`, `*.co.uk`) or an internal pseudo-TLD (`*.internal`) - a hosting platform's private-section suffix is allowed, so `*.github.io` matches every GitHub Pages site - a wildcard IP (`10.*.0.1`; only `*` alone matches an IP), or a name the matcher cannot read (`10.0.0.256`, or `a!b.example.com`: it reads host names - letters, digits, `_` and inner hyphens, in labels of at most 63 characters and a name of at most 253, one trailing dot aside - so a request host outside that is matched only by `*`; a request host the URL parser accepts with a hyphen at a label's edge, `-edge.example.com`, is matched by a wildcard such as `*.example.com` too, though an exact entry for it is refused) - a `statusCodes` entry that is not an integer from 0 to 999, or a `contentTypeHeaders` entry that is not one media type (`json`, `application/*+json`, a comma list; `*` works only as a whole subtype, `image/*`, or as `*/*`, which matches any type).

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
  requestID: string; // ULID for this send() - matches HTTPResponse.requestID and HTTPClientError.requestID
  attemptNumber: number; // 1-based attempt that will be dispatched after this interceptor chain completes; increments across retries and redirect hops
}
```

## Response Observers

Observers run **after** an adapter attempt and have no say in the outcome: what they return is ignored, and a throw is reported, not raised. They are handed the response, request and error themselves, not copies - a final observer's change to the response is what `send()` returns and the next observer sees - so treat them as read-only. They are the right place for logging, metrics, cache writes, and reading token state out of response bodies.

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
  rawBody?: unknown; // structured body when available; see below
  timeout?: number; // configured per-attempt timeout budget in ms
  maxResponseBytes?: number; // configured buffered response size limit; Infinity for none
  attemptNumber?: number; // 1-based; undefined on pre-dispatch best-effort snapshots
  requestID?: string; // matches HTTPResponse.requestID / HTTPClientError.requestID
}
```

`request.body` and `request.rawBody` are built once for each attempt, from the request's body, as the attempt is dispatched - before the adapter is handed the body - (for a request that ends before any attempt is dispatched, as it ends) and only when a response or error observer is registered on the client or its parent: an attempt dispatched with none registered carries neither, and no body is parsed back or copied for it. They are plain fields of the attempt's own, so changing or replacing them reaches neither the adapter, a `307`/`308` replay, nor a later attempt. `request.headers` is the attempt's own as well, its array values included, so redacting or adding to one in place reaches neither the adapter, a retry, the next redirect hop, nor the request another attempt was reported as. Every observer of one attempt - a parent client's and then the sub-client's - is handed the same request, so an observer that redacts its body in place changes what the observers after it see. `request.body` is the body as serialized for the adapter: a JSON body's string, or the string given. `request.rawBody` is the body before serialization. For a JSON body it is the value sent, parsed back from `request.body`: the request's body is the data your body serialized to when you handed it over (see [Body Types](#body-types)), so a `toJSON` is applied, a `Date` is its ISO string, a `Map` is `{}`, and an `undefined` member is dropped (`null` in an array). For a `Uint8Array` or `FormData` body, `request.body` and `request.rawBody` are one copy of the body as sent (a `Buffer` copied as a `Buffer`; see [Body Types](#body-types)), not the one the adapter is writing, so redacting it in place leaves the bytes on the wire alone, and an adapter changing or transferring what it was handed leaves it alone too. A string body is the string in both. When a body an interceptor returned could not be copied or built - a `BigInt` or a circular reference in a JSON body, an unsupported body type - an error observer's `request.body` is `null` and `request.rawBody` is the value the interceptor returned, not a copy.

Use `request.timeout` to inspect what timeout budget was configured for that attempt. Use `response.isTimeout` / `error.isTimeout` to inspect what actually happened.

### Filter Options

```typescript
interface ResponseObserverFilter {
  phases?: ('retry' | 'redirect' | 'final')[]; // Default: ['final']
  methods?: HTTPMethod[];
  hosts?: string[]; // Exact hostnames or wildcard patterns. '*.example.com' = one subdomain label only; '**.example.com' = any depth. Neither matches the apex - list it explicitly. '*' matches everything. PSL tail guard prevents '*.com'-style patterns.
  schemes?: ('http' | 'https')[]; // Match on request scheme. requestURL is absolute whenever it could be resolved before dispatch - MockAdapter synthesizes `http://...` URLs when no baseURL is configured, browser adapters resolve against window.location, Node adapter requires absolute URLs.
  statusCodes?: number[];
  contentTypes?: ('json' | 'text' | 'binary')[];
  contentTypeHeaders?: string[]; // Supports wildcards like 'image/*'
  bodyContainsKeys?: string[]; // Dot-path object matching like 'data.results'; array indexing is not supported; the body must be a plain object at the root level - JSON array responses never match
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

When a request fails before any adapter attempt is dispatched (for example request setup errors, pre-dispatch interceptor failures, or pre-send cancellation), the snapshot is best-effort: it carries the headers set before interceptors run - the request ID header (with `includeRequestID`) and the default `user-agent` - but not the per-attempt attempt header or cookie-jar cookies, which are applied at dispatch, because no real outbound attempt occurred.

### Filter Options

```typescript
interface ErrorObserverFilter {
  phases?: ('retry' | 'final')[]; // Default: ['final']
  methods?: HTTPMethod[];
  hosts?: string[]; // Exact hostnames or wildcard patterns. '*.example.com' = one subdomain label only; '**.example.com' = any depth. Neither matches the apex - list it explicitly. '*' matches everything. PSL tail guard prevents '*.com'-style patterns.
  schemes?: ('http' | 'https')[]; // Match on request scheme. requestURL is absolute whenever it could be resolved before dispatch - MockAdapter synthesizes `http://...` URLs when no baseURL is configured, browser adapters resolve against window.location, Node adapter requires absolute URLs.
}
```

Include `'retry'` in `phases` to also run when the adapter throws but a retry will follow:

```typescript
client.addErrorObserver(
  (error, request, phase) => {
    if (phase.type === 'retry') {
      console.log(
        `Attempt ${phase.attempt}/${phase.maxAttempts} failed, retrying...`,
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

**`retry` phase** carries `{ type: 'retry', attempt, maxAttempts, redirect? }`.
`attempt` and `maxAttempts` use the same global adapter-attempt numbering, including
redirect hops. For a retry-phase interceptor `attempt` is the attempt about to be sent;
for a retry-phase observer it is the attempt that just failed - so for one retry the
observer sees `attempt: 1` and the interceptor `attempt: 2`. `maxAttempts` is the highest attempt number available to the current retry
loop after retries spent on earlier hops. The optional `redirect` field is set when the
retry is occurring on a post-redirect URL. On such a retry to an origin other than the
request's caller-selected origin, while the interceptors keep the hop's host, the retry goes
out with the hop's own URL (but for an upgrade from `http:` to `https:` that leaves the port
as it was), the hop's own body and body headers (or, if they removed or emptied it, an empty body
without the hop's body headers or theirs), and, of the headers they add that the hop did not already carry, only those on
the cross-origin allow-list. A retry they send to another host selects that host, and the
rule does not apply. What they return is still checked as on any other retry: a body of an
unsupported type or a URL that is not an absolute `http(s)` URL, for example, fails the
request as `interceptor_error`, even on a hop that would have gone out with its own. See
[Redirect Handling](#redirect-handling).

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

A retryable status is necessary but not sufficient. A method RFC 9110 does not define as idempotent - `POST`, `PATCH`, or any custom method such as WebDAV's `LOCK` - is **not** retried by default (only `GET`, `HEAD`, `OPTIONS`, `TRACE`, `PUT` and `DELETE` are), because a status like `500` means the server responded, so the handler ran and may have committed. `PUT` and `DELETE` are unaffected: both mutate, but repeating either leaves the resource in the same state, which is what makes replay safe.

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

// A POST is already not retried by default - opt in only when the write is
// safe to repeat, for example when guarded by an idempotency key
await client
  .post('/payments')
  .headers({ 'idempotency-key': key })
  .retryNonIdempotentMethods(true)
  .send();
```

## Cookie Jar

A `CookieJar` provides cookie storage with Public Suffix List domain matching, path matching, secure-flag enforcement, and expiry handling.

A response cookie's lifetime is capped at 400 days, as browsers cap it (RFC 6265bis): a longer `Max-Age` or a later `Expires` is read as 400 days from now. `setCookie()` and `fromJSON()` hold `maxAge` and `expires` to 400 days from the cookie's `createdAt`, and a stored cookie edited past that through `getAllCookies()` - a longer `maxAge`, a later `expires` or a later `createdAt` - still expires there, 400 days from the `createdAt` the jar stored it with, and its `maxAge` counts from that `createdAt` too: it is sent for exactly as long as `clearExpiredCookies()` keeps it. `Expires` is read with RFC 6265's cookie-date algorithm, in UTC whatever zone is written, and a value that is not a cookie-date (`Expires=0`) is ignored, leaving a session cookie. A cookie whose name and value together pass 4096 bytes is ignored. A cookie a header cannot carry - a name or value with a character above U+00FF - is refused by `setCookie()` and `fromJSON()`. The jar does not limit how many cookies it holds; call `clearExpiredCookies()` on a long-lived jar. A replaced cookie keeps its place in the `Cookie` header, as browsers keep it; a jar restored with `fromJSON` orders cookies of equal path length by `createdAt` instead, so that place is not kept across a save.

Cookie domains are canonicalized through IDNA to lowercase ASCII: for example, `domain: 'münchen.de'` given to `setCookie()` or restored through `fromJSON()` matches the request host `xn--mnchen-3ya.de`, and so does a request to `https://münchen.de/`. The same normalization applies to hosts passed to `clear()`. A `Set-Cookie` header's `Domain` is ASCII or the cookie is ignored, as RFC 6265bis has it - whether the header came off the wire (where its bytes are read as latin1) or as a string passed to `processResponseHeaders()` / `parseSetCookieHeader()`; servers send the `xn--` form. The last `SameSite` attribute wins, an unrecognized value reading as the default. The last `Domain` attribute wins too, an empty one included: `Domain=example.com; Domain=` is host-only, as Chrome and Firefox store it (RFC 6265bis would ignore the empty one and widen the cookie to every subdomain). A `Domain` with two leading dots (`..example.com`) names no host, and its cookie is ignored. A `SameSite=None` cookie without `Secure` is ignored, as browsers ignore it. Invalid domain scopes are rejected. A trailing dot is part of the host, as RFC 6265bis compares hosts and browsers keep them apart: `example.com.` and `example.com` are different hosts to the jar, so a cookie set by one is never sent to the other. A `Domain` attribute must be a suffix of the request host as written - `Domain=example.com` from `www.example.com.` is ignored, and that host scopes a cookie with `Domain=example.com.` - and the public-suffix checks apply to either form (`Domain=com.` is refused). Two trailing dots name no host. An IPv4 address with a trailing dot is no cookie domain: the URL parser reads `127.0.0.1.` as `127.0.0.1`, so cookies set from it are that address's, and `domain: '127.0.0.1.'` or `Domain=127.0.0.1.` is refused (and `clear('127.0.0.1.', ...)` clears nothing). `setCookie()`, `fromJSON()`, `clear()` and `getStoredDomains()` keep the two forms apart as well: a restored `domain: 'example.com.'` is sent only to `example.com.` and its subdomains, and `clear('example.com', 'domain')` leaves it.

Fetch uses `Headers.getSetCookie()` to preserve individual response cookie lines.
On legacy implementations without it, the fallback accepts a single unambiguous
cookie, including Expires date commas. If a comma is followed by text containing
`=` before the next comma or semicolon, the entire Set-Cookie header is omitted:
it could be combined cookies or text inside a Path/extension attribute, and
splitting it could invent cookies or broaden their scope. Use a runtime with
`getSetCookie()` or NodeAdapter to reliably receive multiple cookies.

```typescript
import { CookieJar, HTTPClient } from 'lifecycleion/http-client';

const jar = new CookieJar();
const client = new HTTPClient({
  baseURL: 'https://api.example.com',
  cookieJar: jar,
});
```

When a `CookieJar` is attached to the client:

1. Before each adapter attempt (including retries) the `cookie` header is set from the jar's cookies for the request URL. The jar is authoritative: a `cookie` header the request or an interceptor set is replaced, or removed when the jar has nothing for that URL.
2. After every response the `set-cookie` headers are parsed and stored in the jar.
3. Cookies are maintained across redirect hops.

**Secure cookies and the request scheme.** `getCookiesFor()` sends Secure cookies only
over `https:` or `wss:`. Response parsing refuses Secure cookies from other schemes,
and refuses insecure cookies that would replace or shadow an existing, unexpired Secure
cookie of the same name with overlapping domain/path scope, including deletion attempts.
Overlapping in either direction: RFC 6265bis refuses only a path inside the Secure
cookie's, and this jar also refuses a wider one (`Path=/` beside a Secure `Path=/admin`),
which would be sent alongside it.
HTTPS responses may replace or downgrade their cookies. HTTP localhost is not treated
as secure. Use an HTTPS origin for Secure-cookie mocks.

Cookie-name prefixes are matched case-insensitively. `__Secure-` requires `Secure`, while
`__Host-` also requires no non-empty `Domain` attribute (an empty `Domain=` reads as absent, host-only) and an explicit `Path=/`, as RFC 6265bis
and browsers require: an omitted `Path` is refused even where it would default to `/`.
A nameless cookie whose value starts with either prefix is ignored, deletions included.
A cookie set with `setCookie()` is a domain cookie unless `hostOnly: true` is given. A
server's `Set-Cookie` without `Domain=` for the same name is a separate, host-only cookie,
as Chrome and Firefox keep the two apart, so both are sent. Seed a cookie the server will
refresh with `hostOnly: true` to have its `Set-Cookie` replace it.
Programmatic `setCookie()` and `fromJSON()` have no request scheme to check, but still
validate prefixes: `__Host-` requires `secure: true`, `hostOnly: true`, and path `/`.
They also validate domains, expiry, and header framing, so cookies are not stored unchecked.

**Cookie scoping uses the full Public Suffix List.** The jar refuses a `Domain=` that
spans a public suffix, and both halves of the list count: the ICANN half (`com`,
`co.uk`) and the private half (`github.io`, `herokuapp.com`,
`s3.amazonaws.com`). The private half is what
keeps one tenant of a shared platform from setting a cookie every other tenant on it would
send - browsers consult it for exactly that reason. Hosts under a public suffix are also
bucketed separately, so `evil.github.io` and `victim.github.io` never share cookie storage.
IP literals are not public suffixes. Bare single-label hostnames such as `localhost`,
`myapp`, and unqualified machine names are treated as public suffixes because the list
provides no registrable name beneath them. A response from `https://evil.localhost/`
cannot set a `Domain=localhost` cookie for requests to `http://localhost/`.

Under RFC 6265bis §5.5, a `Domain=` that names a public suffix is refused when it differs
from the request host and kept **host-only** when it matches. For example,
`Domain=localhost` from `http://localhost/` and `Domain=github.io` from
`https://github.io/` are accepted as host-only cookies.

These checks apply when cookies are stored, including deletion attempts. A
`Max-Age=0; Domain=localhost` response cookie from `https://evil.localhost/` cannot evict
a cookie belonging to `http://localhost/`. Hosts under a bare name are bucketed separately,
so a `Domain=localhost` cookie is not sent to `sub.localhost`, just as cookies for
`evil.github.io` and `victim.github.io` remain separate.

The list ships compiled into `tldts` and is looked up offline - nothing is downloaded at
runtime - which also means it is a snapshot frozen at the installed `tldts` version. Since
`tldts` is a peer dependency, you can refresh the list by upgrading it within its supported
range without waiting on a Lifecycleion release.

**Extending or trimming the list.** Pass `publicSuffixes` when the public list does not
describe your deployment. Both lists take plain suffixes - no leading dot required (one is
accepted and dropped), no wildcards - and are matched whole-label, so `corp.internal`
covers `a.corp.internal` and not `notcorp.internal`:

```typescript
const jar = new CookieJar({
  publicSuffixes: {
    // Stricter: no cookie may span these, and each host under them gets its own bucket.
    add: ['corp.internal', 'apps.acme-cloud.net'],
    // Wider, and the only option here that opens a scope: hosts under a removed suffix
    // share one bucket again and may set cookies spanning it.
    remove: ['herokuapp.com'],
  },
});
```

The overrides belong to that jar alone. Another `CookieJar` in the same process is
unaffected. They are validated once in the constructor and a bad entry throws a `TypeError`
rather than being ignored - an empty suffix, a wildcard, an empty label, a non-string, or a
suffix named in both lists or added beneath a removed suffix. A removed ancestor
allows shared cookies, which conflicts with an added child's tenant isolation. A typo that silently did nothing would be a scoping hole you
would only discover as a cookie going somewhere it should not. A `remove` entry the bundled list does not treat as a suffix (`a.example.com`, or one a later list has dropped) changes nothing.

**SameSite is stored, not enforced.** The `SameSite` attribute is parsed and kept on the stored cookie for callers to read, but `getCookiesFor()` does not consult it. This jar serves a client, not a browser: there is no navigation, no top-level "site" to compare against, and no notion of a cross-site request, so every cookie whose domain, path, expiry and `Secure` rules match is sent, whatever its `SameSite` value.

### CookieJar API

```typescript
// Options are optional; `publicSuffixes` is described above.
const jar = new CookieJar();

// Manually set a cookie (createdAt is optional - injected automatically if omitted)
// Returns false if domain is missing or syntactically invalid (empty string, spaces, etc.),
// if the expiry cannot be read (an `expires` that is an Invalid Date, or a `maxAge` /
// `createdAt` that is not a finite number - such a cookie would never be found expired),
// or if the name or value cannot be sent as one `name=value` pair: a name that holds
// `=`, `;`, a space, a tab or a control character (U+0000-U+001F, U+007F), or a value
// holding `;` or such a control character other than a tab. A name may be empty (a nameless cookie, sent as its value alone) when the
// value is not empty, holds no `=` and does not start with `__Secure-` / `__Host-`. Looser than RFC 6265's cookie-octet grammar on purpose: spaces,
// commas, quotes and backslashes in a value are accepted, as browsers accept them,
// because real servers send them. Only what would change the header's framing is refused.
const ok = jar.setCookie({
  name: 'session',
  value: 'abc123',
  domain: 'example.com',
  path: '/',
  secure: true,
  httpOnly: true,
});

// Read cookies for a URL. Both return copies, not the stored objects: `name`, `domain`,
// `path`, `hostOnly` and `secure` come from the scope `setCookie` accepted, and every
// other field is read once, so a stored cookie mutated through `getAllCookies()` cannot
// be sent with a wider scope or a different framing than it was stored with. Writing to
// a returned cookie does not change the jar - use `setCookie` to update a stored cookie.
const cookies = jar.getCookiesFor('https://api.example.com/users');
const session = jar.getCookieFor('session', 'https://api.example.com/');

// Parse a Set-Cookie header string and store the cookie in the jar
jar.parseSetCookieHeader('token=xyz; Path=/; HttpOnly', 'https://example.com/');

// Parse and store all set-cookie headers from a response headers object (same format as response.headers).
// A plain object only: a fetch `Headers` or a `Map` throws a TypeError.
jar.processResponseHeaders(response.headers, 'https://example.com/');

// Get the cookie header string for outgoing requests
const cookieHeader = jar.getCookieHeaderString('https://api.example.com/users');

// Maintenance
jar.clearExpiredCookies(); // Returns count removed
jar.clear(); // Remove all cookies - returns count removed
jar.clear('api.example.com', 'hostname'); // Remove cookies for exactly that hostname only - returns count removed
jar.clear('example.com', 'domain'); // Remove example.com and all its subdomains (the entire apex bucket) - returns count removed. A site behind a nested private suffix (bucket.s3.amazonaws.com under amazonaws.com) is its own domain and stays
jar.clear('github.io', 'domain'); // On a public suffix or bare name, every site beneath it
// A host that is not a non-empty string, or a missing or unknown scope, throws: only clear() with no arguments clears everything.

// Inspection
jar.getAllCookies(); // Live stored objects, including expired - prefer setCookie() for updates
jar.getStoredDomains(); // [{ domain, count }]

// Serialization
const data = jar.toJSON(); // Validated copies with the accepted scope; not live jar entries
const restored = jar.fromJSON(data); // Replaces existing cookies after preparing the snapshot
// `fromJSON` validates/copies the payload before clearing; malformed structure throws
// without replacing the jar. It returns how many cookies it accepted. A cookie with a missing or
// invalid domain, an `expires` that cannot be read as a date, a `maxAge` / `createdAt`
// that is not a finite number, or a name or value the `Cookie` header cannot carry as
// one pair, is refused, as is an entry with a field that throws when read, so compare
// against `data.cookies.length` to detect drops. A `null` `expires`, `maxAge` or
// `createdAt` reads as absent.
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
| 303      | GET, HEAD                     | Unchanged       |
| 303      | Other methods                 | GET             |
| 307, 308 | Any                           | Unchanged       |

Cross-origin redirects carry only an allow-list of headers: `accept`, `accept-encoding` (the caller's own; NodeAdapter's default one is not carried), `accept-language`, `content-encoding`, `content-language`, `content-type`, `user-agent`, `range` and the conditional headers (`if-range`, `if-match`, `if-none-match`, `if-modified-since`, `if-unmodified-since`). Everything else - `Authorization`, `Cookie`, and any custom header such as `X-API-Key` that might be a credential - is stripped. This is stricter than fetch, which drops only `Authorization`; a redirect-phase interceptor can add a header back for a target it trusts. Cookies are recomputed from the jar for the target.

A retry on that hop follows the same rule. The hop's request is the stripped one, plus whatever the redirect-phase interceptors added. When the `retry`-phase interceptors run on it, including a parent client's, a header they add is dropped unless it is on the allow-list above. A header the hop already carried keeps the value they give it, so a credential that a redirect-phase interceptor added for a trusted target can be refreshed on a retry. Their changes to the URL and the body are discarded: the retry goes out with the hop's own URL (its path, query, fragment, port and userinfo) and the hop's own body, so a token added as `?access_token=` or as a field of a `307`/`308` replay's body does not reach that host either. Its scheme is the hop's own too, with one exception: an upgrade of an `http:` hop to `https:` that leaves the port as it was (each scheme's default, or the same port number on both, so `http://host:443` to `https://host` and `http://host` to `https://host:80` count) is kept, and the retry goes out over `https:`, the rest of its URL still the hop's own. A downgrade to `http:`, or any other change of scheme or port, is discarded with the rest. The filters up to and including the first interceptor whose function runs - a parent client's included - read the hop's own request, as on any other hop; that function, and every filter and function after it, read a copy of the hop's body, or whatever an interceptor returned in its place. The functions are handed that copy, as on every retry (see [Body Types](#body-types)), so one that edits it in place (`request.body.token = ...`, `form.append(...)`) does not change what the hop sends. The hop's own body goes out with the hop's own `Content-Type`, `Content-Length`, `Content-Encoding`, `Content-Language` and `Content-Location`, whatever they set those to, whether they replaced the body, edited their copy, or left it alone; a body they remove, or set to an empty string, empty bytes or a form with no entries, is sent that way, as an empty value of the client's own, and without any of those five headers the hop or they set - as a hop rewritten to `GET` drops them with its body - so only the client's own default type for an empty string or bytes goes with it. A hop with no body to send goes out as it was, its own headers included. Bytes count as empty by the length they actually hold, not one a subclass reports. A body they return that could not be copied - a `BigInt` in a JSON body, say - is not copied, since it is not sent, and the hop's own goes out as above; one that cannot be read at all - a `Proxy` over a form - fails the request as `request_setup_error`, as it does on any other hop, and the response, the error and the error observers name the hop's own request - its URL, headers and body - not the interceptors'. All of this is silent, as the hop's own headers are dropped silently. What the interceptors return is still checked first, as on any other retry: a body of an unsupported type, a method or header the adapter refuses, or a URL that is not an absolute `http(s)` URL, for example, fails the request as `interceptor_error`, even though the hop would have gone out with its own. The `GET` and `HEAD` body rule reads the request that is sent instead - the hop's own body, or none, with their method - so a body of theirs over a hop with none goes out bodiless rather than being refused, and a hop with a body that they rewrite to `GET` is refused as `interceptor_error`. This applies while the hop is on an origin other than the request's [caller-selected origin](#nodeadapter), the scope URL credentials and TLS identity follow: the URL the caller addressed, or a host a retry interceptor chose by rewriting the URL. A retry the interceptor sends to exactly that origin is left alone too. A retry interceptor that rewrites the URL to another host selects that host, so its headers, URL and body - an edit to the copy included - are kept there. Rewriting only the path, query, scheme or port keeps the server's choice of host and selects nothing, so the rule still applies and the rewrite is discarded, but for the upgrade to `https:` above. The `Cookie` header comes from the jar when one is configured. Without a jar, a `Cookie` header a retry interceptor adds is dropped like any other.

A `307` or `308` replays the body, a `GET`'s included, with its `Content-Type` and `Content-Encoding`, across origins too. A hop rewritten to `GET`, and any `303` (a `GET` that carried a body included), drops the body and those headers, with `Content-Language` and `Content-Location`.

With `NodeAdapter`, URL-based Basic auth follows the resolved redirect URL: from `https://user:pass@example.com/start`, a relative `Location: /next` retains those credentials, while an absolute `Location: https://example.com/next` without userinfo does not. An explicitly supplied `Authorization` header still carries through same-origin redirects.

**Credentials in the `Location` URL are stripped too, on the same rule.** `user:pass@` in a URL is `Authorization: Basic` by another name. `NodeAdapter` copies it onto `options.auth`. A redirect target is the remote server's choice, so `Location: https://admin:secret@other.host/` does not authenticate this client to a host you never named. The userinfo is removed before the hop is recorded, so `redirectHistory`, the followed `requestURL`, and the observers and errors built from them do not carry it either. Same-origin userinfo is left alone. Fetch treats the same shape as fatal (a cross-origin `locationURL` that includes credentials is a network error). Stripping keeps the redirect followable and matches what this client already does to every other credential on a cross-origin hop.

`detectedRedirectURL` follows the same rule. It reports the target - on the response for a hop this client did **not** follow (`followRedirects: false`, or a redirect that ends the request), and on the response handed to `redirect`-phase observers for one it did, whose raw `Location` header still carries whatever the server wrote. Nothing is sent to it. Where the built-in adapters and the client resolve the `Location` themselves, they do it against the request URL without its userinfo, so the caller's credentials are not copied into it: from `https://user:pass@example.com/start`, `Location: /next` reports `https://example.com/next`. Userinfo the server wrote into the `Location` is kept on a target of the request's own origin and dropped on any other, as on a hop the client follows: from `https://example.com/start`, `Location: https://admin:secret@other.example/` reports `https://other.example/`. Userinfo identical to the request URL's own is not reported on any target, since nothing tells it apart from the request's credentials copied in by resolving against the request URL. A custom adapter's own `detectedRedirectURL` is held to the same rule against the URL it answered, so one that resolves `Location` with `new URL(location, requestURL)` does not report the caller's credentials. If you follow a same-origin target yourself, decide about its credentials yourself, and treat the field as untrusted remote input if you log it. The exception is a redirect a browser followed for XHRAdapter, which reports `xhr.responseURL`, the URL the browser itself followed to. A `Location` that does not resolve to a URL (`http://[bad`) reports no `detectedRedirectURL` at all; `wasRedirectDetected` still says there was a redirect.

**A `Location` that cannot be resolved to an absolute `http(s)` URL is refused** before
adapter dispatch and reported as `request_setup_error`. Relative locations are resolved
against the current request. Redirect interceptors run before this validation and may
repair or cancel the target. An invalid URL introduced by an interceptor is reported as
`interceptor_error`.

Redirects start from the latest dispatched attempt, including retry-interceptor changes
to its method, body, and headers. Structured JSON and form bodies remain available for
redirect interceptors, and generated body headers are recalculated after their edits.

**Scheme downgrades are followed.** A `307` or `308` from an `https:` URL to an `http:` `Location` is followed with the method and body intact, as curl and Node's own clients do: the target is the server's instruction, and the hop counts as cross-origin, so forwarded credentials are stripped and jar cookies are recomputed for the target. Secure cookies are withheld, but matching non-Secure cookies can be sent. The request body itself does go out in the clear on that hop. If that is not acceptable for a given client, leave `followRedirects` off and handle the `redirect_disabled` error, or reject the hop from a redirect-phase interceptor by checking `request.requestURL`'s scheme.

Note: `MockAdapter` strips the domain before route matching, so "cross-origin" redirects in tests are effectively same-origin to its router. Header stripping still applies, but test routes don't need to be registered per-domain.

Redirect metadata is recorded when a redirect target is detected and enters redirect handling. That means `redirectHistory` can include the current redirect target before the follow-up adapter attempt is dispatched. During redirect-phase interception, the metadata reflects the target detected from the redirect response. If a redirect interceptor rewrites `requestURL` and redirect handling continues, later `requestURL` / `redirectHistory` values reflect the rewritten target. If redirect handling is cancelled or errors before dispatch, the response/error metadata may still reflect the originally detected target rather than a completed adapter attempt. That target is the redirect detected and not followed: it is `detectedRedirectURL`, and it does not count toward `wasRedirectFollowed`, which says whether a hop was actually dispatched. A `Location` that does not resolve to a URL is still recorded in `redirectHistory` as the raw string the server sent (redirect-phase interceptors are handed it, and may rewrite it), but reports no `detectedRedirectURL`.

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

`cancel()` returns a `CancelResult` saying what it did: `'cancelled'` when this call cancelled the request (before `send()`, or in flight), `'already_cancelled'` when something else had - an earlier `cancel()`, `client.cancel()`, an interceptor, the stream factory or the request's own signal - and `'already_settled'` when it had already completed or failed. A `'cancelled'` holds: the request ends cancelled (`isCancelled: true`, with the reason given) even when the call lands after the last attempt has its answer - from that attempt's `onAttemptEnd`, say - or just before a failure, and that answer or failure is dropped. The signal is aborted at once and the tracked request reads `cancelled` at once; `send()` resolves, and the builder's own state turns `cancelled`, once the request has settled. A `cancel()` made while `send()` is still setting the request up - from a header value's `toString` or a `params` getter - is held and applied before anything is dispatched; it answers `'already_cancelled'` if the request's own signal has already aborted, and `'already_settled'` once setup has failed.

Calling `cancel()` before `send()` marks the builder so that `send()` throws a plain `Error` (not an `HTTPClientError`) immediately rather than dispatching the request. In this case `builder.error` is `null`. No `HTTPClientError` is produced and `cancelReason` is not accessible programmatically (the reason string, if any, appears only in the thrown `Error` message).

### ID-Scoped Cancel

```typescript
const builder = client.get('/users');
builder.send(); // fire-and-forget

// Cancel using the builder's ULID (available before or after send())
client.cancel(builder.requestID);
client.cancel(builder.requestID, 'shutdown');
```

All five cancel methods return **how many requests they cancelled**, so a `cancel()` that
matched nothing is visible rather than a silent no-op:

```typescript
if (client.cancel(someID) === 0) {
  // no request with that id was in flight - already finished or cancelled, or a stale id
}
```

### Tracker-Wide Cancel

```typescript
client.cancelAll(); // Cancel every request on the shared tracker: the whole client tree - parent, sub-clients and siblings - whichever client it is called on
client.cancelOwn(); // Cancel only requests from this exact client instance (not sub-clients)
client.cancelAllWithLabel('my-label'); // Cancel all requests with label across the whole client tree
client.cancelOwnWithLabel('my-label'); // Cancel own requests with label (not sub-clients)

// Each returns the number cancelled:
const stopped = client.cancelAllWithLabel('my-label');

// All accept an optional reason string surfaced on HTTPClientError.cancelReason:
client.cancelAll('app_shutdown');
client.cancelOwn('component_unmounted');
client.cancelAllWithLabel('upload', 'quota_exceeded');
client.cancelOwnWithLabel('poll', 'tab_hidden');
```

A label argument is held to the rule `builder.label()` holds a label to - a non-empty string - so `cancelAllWithLabel(undefined)` throws rather than matching every unlabeled request. The client and tracker cancel methods see a request once its `send()` has set it up; caller code that runs during that synchronous setup (a header value's `toString`, say) and calls `client.cancelAll()` does not reach it, while a `builder.cancel()` there is held and applied.

### AbortSignal Integration

```typescript
const controller = new AbortController();
const response = await client.get('/users').signal(controller.signal).send();

// Cancel from outside:
controller.abort();

// Cancel with a reason - surfaced on HTTPClientError.cancelReason:
controller.abort('user_navigated_away');
```

The external signal is composed with the client's cancel signal (`builder.cancel()`, `client.cancelAll()`, etc.). Either one will abort the request and set `isCancelled: true`. The per-attempt timeout is independent. It fires its own abort but sets `isTimeout: true` instead. Whatever an adapter's `send()` rejects with after that abort and before the response's status has arrived, or a transport-failure response it resolves then (`isTransportError: true`, or a bare `status: 0` that is not a stream error, nor a detected redirect with `followRedirects` off), is the attempt's timeout, so a custom adapter need not reject with an `AbortError`. Two stay their own failures: a rejection the adapter flagged non-retryable, and a transport failure resolved with `isRetryable: false`. Once the status has arrived, a timeout that cuts NodeAdapter's `streamResponse` factory mid-setup, or a body mid-read, ends the request as that `stream_setup_error` or `stream_response_error` with `isTimeout: true`, not retried (see [Error Codes](#error-codes)). An adapter that ignores the abort is waited for one second after it, whether the abort came from the timer or a cancel. If `send()` has not settled by then, the attempt ends as that timeout or cancel without it. An attempt with a body to send then reports a `requestBodySettled` that resolves with an `Error` saying the upload's outcome is unknown, since the adapter never said. The `onUploadProgress` and `onDownloadProgress` hooks and the `streamResponse` factory handed to that adapter are disarmed: a late call reaches none of yours, and a late factory call is answered `null`, so no sink is opened. A later answer is ignored - its `Set-Cookie` is not stored - and a later rejection is not left unhandled. An answer that arrives within that second is the attempt's own: a transport failure then is the timeout, as above, and its `Set-Cookie` is stored, as an answer in time is. If the adapter had already called the `streamResponse` factory, a timeout given up on this way is not retried; see [Streaming Responses](#streaming-responses). Nor is one whose attempt had a body to send: the adapter may still be sending it, and a retry would send it a second time beside it, so the request ends as that timeout, with `isRetriesExhausted: false` whatever the retry budget, its `onAttemptEnd` reporting `retrySuppressedReason: 'upload_unsettled'` when a retry was otherwise available. A bodiless one is retried as any timeout is, and so is one whose body sends nothing - an empty string, no bytes, or a form with no entries. If `controller.abort()` is called with an explicit string reason, it appears on `HTTPClientError.cancelReason`.

### Abort Listeners That Throw

The client hands two signals of its own to code it does not own: the per-attempt
`AdapterRequest.signal` an adapter receives (which matters for a custom `HTTPAdapter`),
and the `signal` a [`streamResponse` factory](#streaming-responses) receives. Their
`'abort'` listeners run inside `builder.cancel()`, `client.cancelAll()`, the per-attempt
timer, or the adapter's own teardown. On an ordinary `AbortSignal`, a listener that throws
is reported by the runtime as an uncaught exception (`process` `'uncaughtException'` in
Node and Bun), which terminates a process that has no handler.

Both signals guard against that. An error thrown by an `'abort'` listener added with
`signal.addEventListener()` (a function, or an object's `handleEvent`) or by
`signal.onabort` - or a rejection from an async one - is reported on the global `'error'`
channel like any other callback failure (see
[safe-handle-callback](./safe-handle-callback.md)), as
`Error in a callback HTTPClient attempt abort listener` or
`Error in a callback NodeAdapter streamResponse abort listener`, with the thrown value as
`cause`. The listeners after it still run, and the request settles as it otherwise would.

The guard is the signal's own `addEventListener`, `removeEventListener` and `onabort`,
defined on that instance and backed by the `EventTarget` methods. They otherwise behave
as natively: a duplicate listener with the same capture
flag is still ignored, `removeEventListener()` with the original listener removes it,
`once`, `passive` and `signal` options apply, a `null` listener is ignored, `onabort` runs
at the position where it was first set, and other event types are not wrapped. Native
consumers such as `fetch(url, { signal })` and `AbortSignal.any([signal])` follow it as
usual. Two gaps remain the runtime's:

- Listeners on a signal **derived** from it - `AbortSignal.any([signal, ...])`, for
  instance - belong to that signal and are not guarded.
- Calling `EventTarget.prototype.addEventListener.call(signal, ...)` (or the prototype's
  `onabort` setter) registers the raw listener, deliberately bypassing the guard.

Catch inside listeners in those two cases. A signal you pass in yourself, through
`.signal()` or the `signal` request option, is yours and is not modified: its listeners
run when you call `abort()`.

## Client Identity

```typescript
client.clientID; // ULID string - unique per HTTPClient or sub-client instance
client.adapterType; // AdapterType: 'fetch' | 'xhr' | 'node' | 'mock'
```

`clientID` matches the `clientID` field on tracked request entries. `adapterType` lets you inspect the active adapter without sending a request, which is useful in shared utilities that need to behave differently per runtime. It is the adapter's `getType()`, read once when the client is built: the config is checked against that value and every request uses it, so a custom adapter's `getType()` is not consulted again. A sub-client that shares its parent's adapter takes the parent's value rather than reading it again; one given its own adapter reads that adapter's `getType()` once when it is built. A `getType()` that returns anything other than `'fetch'`, `'xhr'`, `'node'` or `'mock'` makes the constructor throw a `TypeError`: the adapter and runtime checks are keyed on the type, so a custom adapter returns the one whose rules it follows.

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

`scope: 'all'` covers every request on the shared tracker - the whole client tree, so on a sub-client it lists the parent's and siblings' requests too. Any other `scope`, or a `label` that is not a non-empty string, throws.

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

Any `HTTPClientConfig` field can be overridden. An omitted or explicitly `undefined` field inherits the parent value. Of the options typed to accept `null`, a null `timeout` or `maxResponseBytes` inherits, while `cookieJar: null` disables cookies for that sub-client even if the parent has one. A `null` given to an option whose type excludes it also inherits for `adapter`, `defaultHeaders` and `followRedirects`; for every other option it reaches the new client as given and is handled as `new HTTPClient()` handles it, so `retryPolicy: null` disables the parent's retries, a null boolean option reads as `false`, a null `userAgent` as unset, and a null `maxRedirects` throws.

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

Every built-in adapter, driven directly, refuses a `method` that is absent, empty or not an HTTP token (`GET /x`) as a non-retryable `adapter_error` before anything is sent, with a message that does not quote the method. `HTTPClient` refuses one before that, when the request is built.

### FetchAdapter (Default)

Uses the global `fetch()` API. Works in browsers, Node.js 18+, Bun, and Deno.

```typescript
import { FetchAdapter, HTTPClient } from 'lifecycleion/http-client';

// Explicit (same as the default)
const client = new HTTPClient({ adapter: new FetchAdapter() });
```

No configuration options. Adapter-level behavior is controlled through `HTTPClientConfig`.

The adapter resolves a relative request URL as `fetch` does - against the document's base URL, or the worker's `location` - and sends only an absolute `http:` or `https:` URL. URL userinfo is withheld from that resolved URL when it is cross-origin to the initial URL. Only an initial URL that starts with `/` - root-relative (`/start`) or protocol-relative (`//host/start`) - is resolved against the same base first. Any other relative initial URL is treated as cross-origin, as one that cannot be resolved is: `''`, `#top`, `?q` and `start` name no origin of their own, and other spellings a browser reads as root- or protocol-relative (`\\host/start`, a leading space or tab) are not resolved either. The client always sends an absolute `http:` or `https:` URL. Driven directly with a URL of any other scheme (`file:`, `data:`, `blob:`, ...), or with a relative request URL where there is nothing to resolve it against (no document or `location`, as outside a browser), the adapter refuses it before calling `fetch` with a non-retryable `TypeError` (an `adapter_error` through the client), as NodeAdapter refuses a URL it cannot send.

**Upload visibility.** The adapter returns the HTTP status and reads the response body as usual. Fetch does not expose separate upload progress or completion, so `onUploadProgress` fires `0` at dispatch and `1` when response headers arrive. A request the adapter refuses before calling `fetch` fires neither. The adapter does not set `requestBodySettled`. This matters for servers that respond before an upload finishes: a retry or, on server runtimes, a followed redirect may overlap the earlier upload. See [Uploads That Outlive the Response](#uploads-that-outlive-the-response) for the Node and browser distinctions.

**Browser constraints (enforced at client construction):**

- `cookieJar` must not be set
- `userAgent` must not be set
- `followRedirects` must not be `true`

Browsers automatically strip forbidden headers (`cookie`, `user-agent`, `host`, all `proxy-*` and `sec-*` headers, etc.). Attempting to set them from calling code produces a `request_setup_error`. Attempting to set them from an interceptor produces an `interceptor_error`.

### NodeAdapter

Uses Node.js native `http` / `https` modules. Supports Unix domain sockets, mTLS, and per-chunk streaming.

Compressed responses are handled as `fetch` handles them: NodeAdapter sends `Accept-Encoding: gzip, deflate, br` (`br` over https only, as browsers offer it; `identity` on a `Range` request, as the Fetch standard has it) unless the request sets its own (`identity` asks for none), and decodes a `gzip`, `deflate` or `br` body - buffered or streamed, stacked codings (`gzip, br`) in reverse order, and `zstd` where the runtime has it (never asked for, only decoded when a server sends it; a body of several zstd frames, skippable metadata frames included, decodes whole however the network splits it) - before handing it over. Decoding is strict: a body that ends before its compressed stream does (a gzip body cut before its trailer), or carries bytes after it, is a stream error. gzip follows gunzip's own rule, as Node and browsers do: bytes after a gzip stream fail unless they start with a zero byte, which reads as padding, and what follows that zero byte is ignored. `fetch` decodes by its own runtime's rules, which are more lenient in places - Bun's ignores bytes after a compressed stream, Node's returns what decoded from a body cut short - so FetchAdapter and NodeAdapter can differ on such a body. A cancel or timeout stops the decoding at once. At most five stacked codings are decoded; more is a stream error. Response headers are reported as received, `Content-Encoding` included. `new NodeAdapter({ decompress: false })` turns this off: no `Accept-Encoding` of its own is sent, and every body is handed over exactly as it arrived (to save a server's `.gz` as sent, say), with `maxResponseBytes` and download progress counting the bytes as received, against `Content-Length`. Download progress for a decoded body counts decoded bytes, with an unknown total, since `Content-Length` counts the encoded ones. A body that cannot be decoded fails as a stream error with the response's status. Where what failed is the decoding rather than the transfer, the status still counts, as browsers treat it: a redirect is followed when `followRedirects` is on (a browser never decodes a body it is about to leave), and redirect-phase observers see it as a `3xx` with no body; a retryable status (`503`) is retried as the retry policy allows. A transfer that failed - the connection dropped - stops the request as any stream error does; a body past `maxResponseBytes` does not, since a redirect's body is never read.

```typescript
import { NodeAdapter } from 'lifecycleion/http-client-node';
import { HTTPClient } from 'lifecycleion/http-client';

// Unix domain socket
const client = new HTTPClient({
  adapter: new NodeAdapter({ socketPath: '/var/run/docker.sock' }),
  baseURL: 'http://localhost', // host is ignored for routing; path still matters
});

// Custom CA - internal services that use a private certificate authority.
// Accepts a PEM string, a Buffer, or an array of either (one CA per element).
const client = new HTTPClient({
  adapter: new NodeAdapter({ ca: fs.readFileSync('internal-ca.crt') }),
  baseURL: 'https://internal.example.com',
});

// Multiple CAs - no need to concatenate into a bundle
const client = new HTTPClient({
  adapter: new NodeAdapter({
    ca: [fs.readFileSync('internal-ca.crt'), fs.readFileSync('partner-ca.crt')],
  }),
  baseURL: 'https://internal.example.com',
});

// Dialing by IP with a DNS-named cert (service registry pattern).
//
// When a service registry gives you an instance IP, connect directly to it -
// Node.js skips DNS entirely when the target is an IP address. The server's
// cert SAN is a DNS name, not the IP, so TLS verification fails unless you
// tell Node which hostname to check the cert against via servername.
//
// Redirects are disabled by default, which is exactly what you want here -
// an unexpected redirect from an internal service is a misconfiguration
// worth surfacing, not silently following.
//
// The Host header defaults to the IP. If the backend routes by Host (e.g.
// a virtual-hosted proxy in front of the service), also set:
//   defaultHeaders: { host: 'billing.internal' }
const client = new HTTPClient({
  adapter: new NodeAdapter({
    ca: fs.readFileSync('internal-ca.crt'),
    servername: 'billing.internal', // cert SAN - TLS verifies against this name
  }),
  baseURL: 'https://10.0.0.5:443', // IP from the registry - where bytes go
});

// mTLS
//
// The client certificate is presented only to the origin you addressed. With
// followRedirects on, a hop to another origin (scheme, host or port) gets your
// trust settings (ca, mtls.ca, crl, rejectUnauthorized) but no client
// certificate and no servername - see the note below the config.
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
  socketPath?: string; // Unix domain socket path. Used only for the origin the request addressed, never on a cross-origin redirect hop.
  ca?: string | Buffer | Array<string | Buffer>; // Trusted CA cert(s) for servers using a private CA. Array allows multiple CAs without bundling. No client cert required - use mtls for that. An empty value ('', [], an empty buffer) throws: it would fall back to the runtime's public roots.
  servername?: string; // TLS SNI hostname. Required when dialing by IP but the cert SAN is a DNS name - without it, TLS verification fails because the IP does not match the DNS SAN. Sent only to the origin the request addressed, never on a cross-origin redirect hop.
  mtls?: {
    // Your TLS identity. Presented only to the origin the request addressed, never on a cross-origin redirect hop.
    cert: string | Buffer;
    key: string | Buffer;
    ca?: string | Buffer | Array<string | Buffer>; // Trust anchor for the server, added to `ca`. Applies on every hop, like `ca`.
  };
  crl?: string | ArrayBufferView | Array<string | ArrayBufferView>; // PEM certificate revocation list(s). A concatenated PEM bundle is split for you - see below.
  rejectUnauthorized?: boolean; // Default: true
  decompress?: boolean; // Default: true - decode gzip/deflate/br/zstd bodies and send Accept-Encoding. false hands bodies over as received. A non-boolean throws.
}
```

TLS certificate errors resolve as status `495` (transport error, not retryable) rather than throwing, so they flow through the normal error path - those the runtime reports as a certificate failure. That includes every revocation failure, such as `CERT_REVOKED`, `UNABLE_TO_GET_CRL`, `CRL_HAS_EXPIRED` and friends. A server rejecting the client certificate may only close or reset the connection on some runtimes (Bun does for TLS 1.3), which is status `0` and retried as any transport failure is.

**URL credentials and TLS identity are scoped to the caller-selected origin.**
`AdapterRequest.initialURL` identifies that origin, including one a retry interceptor
selects by changing the host. Changing only the scheme or port of a redirect target - an
"upgrade to https on retry" interceptor - keeps the server's choice of host, and selects
nothing. On a hop to another origin, all network adapters
withhold URL userinfo, and `NodeAdapter` also withholds `servername` and
`mtls.cert` / `mtls.key`. The client strips cross-origin Location userinfo before
recording the followed hop. Same-origin userinfo is preserved. Node uses it for Basic
auth. `fetch` sends none of it: Node's and browsers' `fetch` refuse a URL with
credentials, and Bun's drops them without a word, so a FetchAdapter request to
`https://user:pass@host/` goes out unauthenticated there. Set `Authorization` yourself
with FetchAdapter.

TLS trust settings (`ca`, `mtls.ca`, `crl`, and `rejectUnauthorized`) apply on every
connection. A target requiring the withheld client certificate can fail TLS or reject
the request. This does not guarantee one particular HTTP status. Address that origin
directly, or explicitly select it in an initial- or retry-phase interceptor (a redirect-phase rewrite does not), if it should receive the configured
identity. For direct adapter calls, omitting `initialURL` applies the configured identity, while
an unparseable `initialURL` is treated as cross-origin, and one that is not a string
is refused as a non-retryable `adapter_error`.

**The socket you configured stays with the origin you addressed, too.** `socketPath` is your chosen endpoint, and often a privileged one. `/var/run/docker.sock` is the usual example. A redirect to a different origin is sent over TCP to the host the `Location` actually names, not over your socket with only the request line and `Host` header changed. Otherwise a remote server's `Location` would become a request you never made against that socket. Same-origin redirects keep the socket, and the adapter driven directly (no `initialURL`) uses it as configured.

**Driven directly, `send()` reads the request once.** Each member of the `AdapterRequest` is read when `send()` is called, and `headers` is copied, so a getter is never consulted again from the socket, response or abort handlers that run later. A getter that throws on that first read rejects that `send()`.

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

The value is read on **every HTTPS request**, and normalized again whenever what it holds has changed, so refreshing a revocation set means passing a new value. **Construct a new `NodeAdapter`.** That is the intended way, and it is cheap precisely because the adapter owns no connection pool, so there is nothing to release and nothing to leak. There is no update method, and none is needed. Mutating the config object you handed the adapter also takes effect, but rebuilding keeps the CRL and the client that uses it visibly in step. How often to refresh is yours to decide. The library has no timer.

**Bundles are split for you.** A PEM string or Buffer holding several concatenated CRLs, the format Apache's `SSLCARevocationFile`, nginx's `ssl_crl`, and HAProxy's `crl-file` all expect and CA tooling exports, is split into the array Node requires. This includes Buffers: `fs.readFileSync('bundle.pem')` without an encoding returns one, and its contents are PEM like any other bundle, so it would otherwise be truncated exactly as a string would. Strings and Buffers nested inside an array are split too, so `[bundleOfTwo, oneMore]` contributes three CRLs rather than two. Any binary view is read: one CRL block is passed on as a `Buffer` over the same bytes (a copy when it carries a leading byte-order mark or sits at an offset into its memory, which Bun's `tls` misreads), and several are split into one string each. Only PEM is accepted: Node's `tls` does not read DER CRLs, so DER bytes are refused when the adapter is constructed (convert them with `openssl crl -inform DER -outform PEM`). The CRLs are also parsed then, and when a changed value is read for a request, so a CRL clipped mid-body or with corrupted base64 is refused as a non-retryable error rather than failing every HTTPS request. A value with no CRL in it at all (`''`, `[]`) is refused too, since it would turn revocation checking off; leave `crl` unset for that.

**Only PEM blocks and whitespace are accepted.** Initial CRL framing is validated when `NodeAdapter` is constructed, before any request or retry, including for clients using plain HTTP. The CRL is still read and normalized per HTTPS request so callers can refresh it; a refreshed value that is badly framed, or is not a string, binary data (a `Buffer`, `Uint8Array` or other `ArrayBuffer` view) or an array of them, fails that request without a retry. Anything else in the string, such as a truncated or corrupted CRL, a damaged delimiter, or decoded text from `openssl ... -text`, is refused with an error rather than split. The rule is exact rather than a best guess: a parser cannot tell a half-written CRL from a line of commentary, so admitting commentary would mean silently dropping the truncated entry and enforcing a revocation set you never supplied. Strip any annotation before passing a bundle here. A refreshed value that fails this check fails the request with `adapter_error` and the validation error as its cause, without retrying.

**Do not put two CRLs for the same issuer in one bundle.** OpenSSL uses the **first** CRL it has for an issuer, not the newest. In testing, a stale CRL followed by one revoking the server's certificate accepted the connection, while the same pair in the opposite order rejected it. Splitting does not change this. It is how CRL selection works. Supply exactly one current CRL per issuer.

Raw Node reads only the **first** CRL of a concatenated string and silently ignores the rest, unlike `ca`, which reads every certificate in a bundle:

| passed as           | `ca`          | `crl` (raw Node)         |
| ------------------- | ------------- | ------------------------ |
| concatenated bundle | reads **all** | reads **only the first** |
| array               | reads all     | reads all                |

It is Node diverging from the library it links, not an OpenSSL limitation: `openssl verify -crl_check_all -CRLfile bundle.pem` correctly finds a CRL that sits second in the file. Raw Node reports a truncated bundle as `UNABLE_TO_GET_CRL`, which reads as "no CRL supplied" rather than "your bundle was cut short," and a bundle whose first entry happens to cover the root in use appears to work until the roster or export order changes.

**Two things to plan for.** Both are fail-closed, so a stale or partial CRL never silently stops enforcing, but both can refuse healthy connections:

- **Every certificate in the chain needs a covering CRL.** Node enables `X509_V_FLAG_CRL_CHECK_ALL`, so supplying a CRL for one root while connecting through another fails with `UNABLE_TO_GET_CRL` even when nothing was revoked. Cover every root the client talks to, or give the scoped CRL its own client. This makes adding a root an outage unless its CRL lands first.
- **CRLs expire.** Past `nextUpdate` the handshake fails with `CRL_HAS_EXPIRED`, including for certificates that were never revoked. Either refresh well inside that window, or export with a `nextUpdate` far enough out that a stalled refresh cannot take you down.

**No connection-pool handling is needed.** `crl` is part of Node's connection pool key, so changing it partitions the pool: a socket established under the old CRL is never reused for a request carrying the new one. Requests using an updated CRL establish connections under that CRL rather than reusing sockets validated against the old one.

**Runtime support.** Bun ignored `crl` entirely through 1.3.14 and accepted a revoked certificate with no error. Bun implemented it in 1.4.0, where it matches Node on every case tested, including malformed-CRL rejection, expiry, coverage, and pool partitioning. **Require Bun >= 1.4.0 if you depend on revocation.** This library's own enforcement tests probe the runtime and skip where `crl` is unsupported, rather than passing for the wrong reason. The bundle-splitting tests run everywhere, since that part is the library's job rather than the runtime's.

### XHRAdapter

Uses `XMLHttpRequest` for real per-chunk progress tracking in browsers where `fetch` progress is unavailable.

The adapter listens for upload progress on `xhr.upload` only for a request that asked for it with `onUploadProgress`, and then only when its body has at least one byte, or a size it cannot know up front (a `FormData`). In a browser that listener makes a cross-origin upload a non-simple request, so asking for `onUploadProgress` on one means the server must answer a CORS preflight (`OPTIONS`) even for a `text/plain`, urlencoded or `FormData` body, which `FetchAdapter` sends without one. A request that does not ask is not listened on, and goes out as `fetch` would send it. Nor is a request with no body, or an empty one; its `onUploadProgress` still fires `0` at dispatch and `1` (`0` bytes) once an answer arrives.

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

A synchronous throw from `xhr.send()` fails the request once, as a non-retryable `adapter_error`. An asynchronous `send()` throws only an `InvalidStateError` or for a body it cannot convert, and both fail the same way on every attempt; network failures arrive as `error` events and follow the retry rules. An `XMLHttpRequest` shim that throws a network failure from `send()` instead is not retried. An `XMLHttpRequest` with no `upload` (as some shims have) sends without per-chunk upload progress: `onUploadProgress` fires `0` at dispatch and `1` only once an answer arrives (a response, including one refused as too large or a redirect the browser followed, even one an abort lands on), not on a network error, a timeout or an abort. One whose `upload` throws when read or listened on fails a request with a body to send and an `onUploadProgress` once, as a non-retryable `adapter_error`.

A caller's `Content-Length` is not sent: the XHR frames the body itself, as `fetch` does for `FetchAdapter`. The adapter rejects a cancel or timeout with a plain `Error` named `AbortError`, so it needs no `DOMException` where XHR runs outside a browser (React Native, a test shim).

The adapter resolves the request URL to an absolute URL once, as the browser does - a relative one against the document's base URL, or the worker's `location` - and opens the XHR with that URL. It resolves it with `new URL`, as FetchAdapter does, so the query is encoded as UTF-8: on a page in a legacy encoding, a raw non-ASCII query is sent as UTF-8 rather than in the page's encoding. URL userinfo is withheld from that resolved URL when it is cross-origin to the initial URL, so `//user:pass@api.test/x` on an `http:` page, for a request that started on `https://api.test/`, is opened without its credentials. Only an initial URL that starts with `/` - root-relative (`/start`) or protocol-relative (`//host/start`) - is resolved against the same base first. Any other relative initial URL is treated as cross-origin, as one that cannot be resolved is: `''`, `#top`, `?q` and `start` name no origin of their own, and other spellings a browser reads as root- or protocol-relative (`\\host/start`, a leading space or tab) are not resolved either. The client always sends an absolute `http:` or `https:` URL. Driven directly with a URL of any other scheme (`file:`, `data:`, `blob:`, ...), or with a relative request URL where there is nothing to resolve it against (no document or `location`, as outside a browser), the adapter refuses it before opening the XHR with a non-retryable `TypeError`, as NodeAdapter refuses a URL it cannot send.

Because browsers follow redirects silently, XHR cannot intercept them mid-flight. Instead, after the request completes, the adapter compares `xhr.responseURL` to the absolute URL it opened to detect whether a redirect occurred. If one is detected the response carries `wasRedirectDetected: true` and an `HTTPClientError` with code `redirect_disabled`. A `3xx` the XHR hands over without following - in a browser, one with no `Location`; outside one, an `XMLHttpRequest` that does not follow redirects - reports `wasRedirectDetected` from its status, and `detectedRedirectURL` where its `Location` resolves against that absolute URL, as FetchAdapter and NodeAdapter report a real `3xx`.

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

Routes are registered with `get`, `post`, `put`, `patch`, `delete`, `head` and `options`, or `routes.on(method, path, handler)` for any other method Node's `http` knows (`TRACE`, `PROPFIND`, `LOCK`, `PURGE`). A request's method is matched, and handed to the handler as `req.method`, uppercased, as a server receives it from Node's `http`; header names in `req.headers` are lowercase, and a `HEAD` request needs its own `head` route - it is not answered from a `get` route. A path parameter longer than 100 characters does not match its route, so that request gets a `404`. A handler that returns no response, or a body the mock cannot serialize, fails the request as a non-retryable `adapter_error`. When a request carries two cookies with the same name, `req.cookies` holds the first, as common server parsers do. Driven directly with a path-only request URL, the adapter resolves a redirect's `Location` against `http://localhost`, the base the client gives a mock request with no `baseURL`: `/start` answered with `Location: /next` reports `detectedRedirectURL: 'http://localhost/next'`.

**MockAdapterConfig:**

```typescript
interface MockAdapterConfig {
  defaultDelay?: number | null; // Non-negative milliseconds added to all responses; 0 disables
  onHandlerError?: (
    req: MockRequest,
    error: unknown,
  ) => MockResponse | Promise<MockResponse>;
}
```

Changes to the supplied config's `defaultDelay` or `onHandlerError` affect later
requests. Inherited error handlers are supported and receive the config as `this`.
The default delay is validated at construction and when a response uses it;
a response-specific `delay` takes precedence.

A `null` or omitted mock default delay uses zero. A `null` or omitted response delay
inherits the current default delay. Explicit `NaN`, other non-number, or negative delays throw;
`Infinity` and oversized durations use the timer ceiling. A route's response `delay`
overrides `defaultDelay` and is validated before its response is sent. An invalid
response delay fails that attempt with `adapter_error` and its original validation
error as the cause, without retrying the route handler even when retries are enabled.

`onHandlerError` receives the original thrown or rejected value, including non-Error
values, regardless of whether the request has an AbortSignal. If a route or error
handler aborts its own request, the request ends with AbortError while its returned
promise remains observed so a later rejection cannot become unhandled. The same holds
for a signal that refuses listeners: one whose `addEventListener` throws fails the wait
as a handler error would, one whose `removeEventListener` throws does not hold up the
response, and the handler's promise is observed either way.

`mock.routes.clear()` removes all registered mock routes.

**MockRequest** (received by route handlers):

```typescript
interface MockRequest {
  method: string;
  path: string;
  params: Record<string, string>; // Path params from :paramName segments
  query: QueryObject; // Parsed with qs, as Express's extended query parser reads it (the Express 4 default): nested `a[b]=1` keys, keys like `constructor` kept, qs's limits apply (an array past 20 items is an object). Express 5's and Fastify's default parsers read nested keys flat.
  headers: Record<string, string>; // Lowercase names, with `host` and a FormData body's multipart `content-type` added as a server receives them
  cookies: Record<string, string>; // Pre-parsed from cookie header: unquoted and percent-decoded, the first of a repeated name
  body?: unknown; // Parsed: JSON object, string, Uint8Array, or MockFormData ({ fields, files } with the last value of a name, { allFields, allFiles } with every value)
}
```

**MockResponse:**

```typescript
interface MockResponse {
  status: number;
  body?: unknown; // Supports objects (JSON), strings, Uint8Array, ArrayBuffer (bytes from another realm, such as jsdom or a `vm` context, included). An object whose own `toJSON` answers `undefined` is answered with no body and no inferred `content-type` (a HEAD route or a simulated `streamError` never serializes its body, so it still infers one from the object)
  headers?: Record<string, string | string[]>;
  contentType?: 'json' | 'text' | 'binary'; // Overrides auto-detection
  delay?: number | null; // Millisecond delay for this response
  cookies?: Record<string, string | MockCookieOptions | null>;
  streamError?: boolean | 'stream_write_error' | 'stream_response_error'; // Simulate a body failure after headers arrived
  transportError?: boolean | MockTransportErrorOptions; // Simulate a failure with no response at all
}
```

A route's `body` is serialized when the route answers, before its `delay`, so changing the object while the response is delayed does not change what is delivered. A `Uint8Array` or `ArrayBuffer` body is delivered as a plain `Uint8Array` copy of its bytes (a `Buffer` included, as the network adapters deliver one), so changing the bytes a request was answered with leaves the route's value as it was for the next request; a `Proxy` over a `Uint8Array` is delivered as it is.

`MockResponse.cookies` shorthand:

- `string` -> session cookie: `name=value; Path=/` (the string is the cookie value, not a raw Set-Cookie header)
- `null` -> delete cookie: `name=; Path=/; Max-Age=0`
- `MockCookieOptions` → full control over path, domain, maxAge, httpOnly, secure, sameSite

`cookies` entries are appended after any `headers['set-cookie']` entries. If the same cookie name appears in both, the `cookies` entry wins (last Set-Cookie header takes precedence).

Each entry is held to the rule the cookie jar stores by: a name is an HTTP token, and a value, `path` or `domain` is a string with no `;`, no control character other than a tab, and no character above U+00FF (a tab in a value or `path` is written, as it is from a raw `set-cookie`). Nothing is coerced. The request fails with a non-retryable error - so the route is not run again - for an entry that is not a string, `null` or an object (an array is refused as one); a `MockCookieOptions` whose `value` is not a string; a `path` or `domain` present and not a string; a `sameSite` other than `'Strict'`, `'Lax'` or `'None'`; a `maxAge` that is not a number, or is `NaN`; and an `httpOnly` or `secure` present and not a boolean. Each of these names the cookie by its position in `cookies` (and the type it got), never its text; a name that is not a token is named by its position too.

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

Streaming is supported **only by NodeAdapter**. Provide a `StreamResponseFactory` via `.streamResponse()` on the builder. It is called after the response headers arrive on a `200` response that carries a body; a `HEAD` answer has none, and is handed over buffered with a `null` body, the factory never called.

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
  status: 200; // Always 200 - not called for other statuses
  headers: Record<string, string | string[]>; // A copy: writing to it changes neither the response's headers nor the cookie jar
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

The `signal` is guarded against `'abort'` listeners that throw; see [Abort Listeners That Throw](#abort-listeners-that-throw).

`StreamResponseFactory` can also be supplied via `HTTPRequestOptions.streamResponse` when passing options directly to `client.get(...)`, `client.post(...)`, and the other request helpers.

```typescript
const response = await client
  .get('/large-file.bin', {
    streamResponse: (info, { signal }) => {
      const dest = createWriteStream('/tmp/large-file.bin');

      signal.addEventListener('abort', () => dest.destroy(), { once: true });
      return dest;
    },
  })
  .send();
```

#### Writing Your Own `WritableLike`

A Node stream, such as `fs.createWriteStream()`, a socket, or a `zlib` transform, satisfies
`WritableLike` as it is, and everything below is already true of it. The rest of this
section only matters if you hand-roll the sink.

Expectations for a custom writable:

- **Define `off` or `removeListener`.** Both are optional on the type so an existing
  object still compiles, but the adapter attaches listeners for the life of a request and
  takes them off again afterwards. With neither method it cannot, so it attaches one
  permanent listener per event to that writable instead and registers each request behind
  it - rather than adding a listener per request to a sink reused across many of them,
  until Node warns about a leak. Reporting is unchanged either way: an `'error'` that
  reaches that permanent listener within about a second of the last request leaving it is
  reported through the host error reporter, as the bounded listener described below
  reports it. The one difference is that the permanent listener never detaches, so a later
  `'error'` is still absorbed rather than becoming an uncaught exception, but it is not
  reported; handle those with your own `'error'` listener. What you save by defining one is
  that listener. Either name works. A Node stream has both.
- **Report a failed write.** Either call the callback passed to `write` / `end` with the
  error, or emit `'error'`, which is what a Node stream does. A write that fails destroys
  the stream and its `'error'` often arrives after the request has already settled, so the
  adapter keeps an `'error'` listener on your sink across that gap to stop the event from
  becoming an uncaught exception. The wait is bounded but not brief because a real
  `fs.WriteStream` closes its file descriptor asynchronously before it emits, so the error
  lands a poll phase later. The listener window is measured by elapsed time so a delayed
  poll phase does not expire that coverage before the error arrives.
  See [How long that listener stays](#how-long-that-listener-stays).
- **Emit `'close'` when you are finished.** That is how the adapter learns nothing further
  is coming and takes the listener off at once, instead of waiting out the timers below.
  A sink that closes with no error before the response has ended (destroyed by its owner,
  a proxied client that went away) fails the download as `stream_write_error`. After the
  response has ended, a `'close'` is a failure only when the sink reports
  `writableFinished: false`, as a Node stream destroyed with writes still queued does;
  otherwise `end`'s callback answers.
- **Set `errored` if you can, but you need not.** A Node stream records the error it failed
  with there, and the adapter reads it as a second signal when `end`'s callback reports
  success on a stream that was destroyed underneath it. It is optional, and a sink without
  it loses nothing as long as it honours the point above. The read is guarded, so an
  `errored` accessor that throws costs that one signal rather than the request. It happens
  inside `end`'s callback, a tick after the call, where an escaping throw would be an
  uncaught exception rather than a failed download. Implement listener registration and destruction reliably: throwing methods can prevent
  the adapter from observing failures or completing cleanup.

##### How Long That Listener Stays

Worth knowing, because the writable is yours and the adapter is holding a listener on it.

Nothing can promise "no more errors, ever." The operating system does not offer that
guarantee and a writable is free to emit an hour from now, so the adapter does not wait for
an answer it cannot get. **It waits for a bounded time and then lets go.**

One `'error'` listener is shared per writable rather than per request, so ten concurrent
downloads into one sink attach one listener between them, not ten. It comes off at the
first of these:

| Signal                             | What happens                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The `'error'` arrives              | Absorbed, and reported through the host error reporter unless the request already handed it to you as `errorCause`. Released one turn later, so a sibling request's late error is still covered                                                                                                  |
| `'close'`                          | The stream has finished tearing down and nothing further is coming, so it is released immediately                                                                                                                                                                                                |
| ~1 second with neither             | The per-request window. Every request that settles while the listener is already attached restarts it, so each gets a window of its own rather than the remainder of the first one's. With less than a whole window left before the ceiling below, the request attaches a fresh listener instead |
| ~5 seconds since it first attached | The absolute ceiling on one listener, which no amount of restarting extends                                                                                                                                                                                                                      |

That last row is the one to hold on to: **the absorber does not live forever, and it is not
per process.** Without the ceiling, a caller streaming continuously into `process.stdout` or
a pooled sink, exactly the kind of writable that never errors and never closes, would push the
window out on every settle and keep the _first_ request's closure pinned to that stream for
the life of the process.

When the ceiling is reached the listener detaches, and the next request to settle on that
writable attaches a fresh one with a fresh ceiling. Continuous traffic therefore does keep a
listener on the sink continuously. What it cannot do is keep any one request's scope alive
behind it.

The same listener covers a writable the factory returns after its request has already
ended. When the request is cancelled, times out, or loses its connection while an async
factory is still awaiting, the adapter destroys the writable the factory eventually
returns, with this listener attached first. An error that writable emits anyway, such as a
`createWriteStream()` into a missing directory failing to open, is reported through the
host error reporter, because the request it belonged to has already answered.

A Node stream the factory returns already failed (destroyed with an error, by a sync
factory or an `async` one) settles the request as a `stream_write_error` with that error
as its cause. A Node stream emits that error a tick after `destroy()`; the factory is
called from a microtask, so in Node and Bun the adapter's listener is on the stream
first, and a sync factory's stream also gets the late-error listener above the moment it
is returned. Not covered: a stream an `async` factory fails and then awaits I/O or a
timer before returning, which emits while the stream is not the adapter's yet, and a
hand-written `WritableLike` that emits `'error'` from inside `destroy()` itself. Give
either an `'error'` listener of your own.

That destroy is one of three: the adapter also destroys the writable when the request is
cancelled or times out mid-stream, and when the stream fails mid-body. A sink handed to
several concurrent requests is therefore destroyed as soon as any one of them ends that
way, under the others still writing to it. Return a fresh writable from each factory call
unless that is what you want.

The practical consequence for a sink you wrote: an error emitted more than a few seconds
after the last request touching it settled is yours to handle. On a Node stream with no
`'error'` listener of your own, that is an uncaught exception under the ordinary contract for a
stream you own, and the reason the two points above ask for an `'error'` or a `'close'`
rather than silence.

Return `null` or `{ cancel: true, reason? }` from the factory to cancel the request (produces `isCancelled: true`, error code `cancelled`). The `reason` string is surfaced on `HTTPClientError.cancelReason`. If the factory throws, or returns anything other than a writable, `null`, or a cancel object (such as `undefined` from a forgotten `return`), the error code is `stream_setup_error` instead. The factory is only called once the response's headers have arrived, so in every one of these cases - a cancel, a setup failure, or a timeout while an async factory is still setting up - the response's `Set-Cookie` is stored, and a `stream_setup_error` response carries the answer's real status.

When streaming is active on a retry attempt (before headers arrive), the factory is called again for the new attempt. The `signal` from the previous attempt will have fired, allowing cleanup code to run before the new stream is set up.

Once headers have arrived and the factory has been called, any mid-stream failure (`isStreamError: true`) is not retried because the response was already committed at the HTTP level. That includes a timeout of a custom adapter that called the factory and then ignored the abort, which the client gives up on a second later (see [Request Cancellation](#request-cancellation)), once the factory has started a stream - returned a writable, a promise that has not yet answered, or a thenable the client does not follow (anything but a plain native promise, such as a `Promise` subclass or a promise with its own `then`), which counts as started whatever it answers: it ends as a `stream_response_error` with `isTimeout: true` and the status the adapter announced to the factory, and the factory is not called again. A factory that threw, or answered `null` or a cancel (directly or through its promise), started none: with an adapter that then ignored the abort, that timeout is retried as any other. (With an adapter that reports the factory's failure or cancel, it is the `stream_setup_error` or cancel described below, not retried.) Whether a timeout or a cancel ended the attempt, the adapter that ignored the abort will not tear down the sink it was writing to, so the client calls `destroy()` on the writable your factory returned - directly, or through a promise from an `async` factory, when that promise answers, even after the attempt ended. A sink handed over through any other thenable is not known to the client and is not destroyed. The `signal` in the factory's context belongs to the adapter, and the client cannot fire it: cleanup that listens only to that signal runs only if the adapter aborts it, so listen for the writable's `'close'` as well. If the factory throws, that produces a `stream_setup_error` and is also not retried, since it indicates a local problem, such as failing to open a file, rather than a transient server issue.

### Stream Errors and Replay

`isStreamError` is not limited to streamed responses. It is also set when a buffered response body fails after headers arrive, such as from a peer reset mid-body, a premature close, or fewer bytes than a declared `Content-Length`. The real HTTP status is preserved in every case, so a truncated `200` still reports `200`, not `0`.

For deciding whether a request may be resent, a stream error groups with a **real response**, not with a transport failure, even though both leave you without a usable body:

| Outcome                                       | Did the server receive it?     | Safe to replay a non-idempotent write? |
| --------------------------------------------- | ------------------------------ | -------------------------------------- |
| Transport failure with `wasDefinitelyNotSent` | No, no connection was made     | Yes, nothing could have been applied   |
| Transport failure, delivery not proven        | Unknown                        | No, it may have arrived                |
| `isStreamError`, real status                  | Yes, and it may have committed | No, the outcome is unknown             |
| `5xx` with an intact body                     | Yes, and it may have committed | No, the outcome is unknown             |

A transport failure is not by itself a licence to replay. `status: 0` means no usable response came back, which is not the same as the request never arriving. A connection dropped after the request was written looks identical from here. Only an adapter that can name the cause (a refused connection, a name that did not resolve) can turn that into proof.

Treating a stream error as a transport failure is the mistake worth guarding against: the superficial resemblance is strong, but it inverts the replay decision. `HTTPClient` already applies this internally. A stream error is not retried, even though its status might otherwise be retryable - except where only the body failed and none of it reached you: a body that only failed to decode (a `503` labelled `gzip` and sent plain), where the answer itself arrived whole, or one past `maxResponseBytes`, which the adapter stopped reading. Their status is retried as it would be with a readable body.

`HTTPClient` treats a truncated `3xx` as terminal even with `followRedirects: true`. It does not dispatch the redirect hop. The response reports the real `3xx` status alongside `isStreamError`, with `wasRedirectDetected` and `detectedRedirectURL` still telling you where it pointed. A per-attempt timeout that strikes mid-body remains attached to this response instead of being replaced by the result of a later hop.

With `followRedirects: false` the same truncated `3xx` reports differently, and deliberately so. That path is not about following. The request ends at the redirect whether or not the body arrived, so it reports what it reports for _every_ disabled redirect: `redirect_disabled`, `status: 0`, `isStreamError: false`, and `wasRedirectDetected` / `detectedRedirectURL` pointing at the target. A per-attempt timeout that struck mid-body is not surfaced there either: `isTimeout` stays `false`, because the timeout is incidental to an outcome that was already decided by the config. Reading `isTimeout` to mean "a timeout occurred somewhere" rather than "a timeout is why this failed" will surprise you here.

Two things deliberately do **not** set the flag. A caller's own `AbortSignal` firing classifies as `isCancelled` (or `isTimeout`), since that is your decision rather than a network fault. A failure with no headers at all, such as a connection refusal, DNS failure, or TLS rejection, is a plain transport failure, because no status was ever received for the flag to qualify.

#### Adapter Support

| Adapter        | `isStreamError` | Notes                                                                                                                                                     |
| -------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeAdapter`  | Full            | Streamed and buffered bodies, distinguishing `stream_write_error` from `stream_response_error`                                                            |
| `FetchAdapter` | Buffered bodies | Server runtimes and browsers alike. Always reports `stream_response_error` because `fetch` buffers the body, so there is no per-chunk delivery to inspect |
| `MockAdapter`  | Simulated       | Opt in per response with `streamError: true`, or name the code explicitly                                                                                 |
| `XHRAdapter`   | Timeouts only   | A per-attempt timeout after the headers keeps the real status; a network error mid-body cannot, as `XMLHttpRequest` discards the status                   |

Every adapter, `XHRAdapter` included, also reports `response_too_large` as a stream error for a buffered body past `maxResponseBytes` (see [Response Size Limit](#response-size-limit)): there the adapter itself stops the read, while the headers are still in hand.

`FetchAdapter` is not limited to server runtimes here. Headers have already arrived when the body read starts, so the status is readable in a browser exactly as it is under Node or Bun, and a truncated body rejects the same way.

A per-attempt timeout that fires _during_ the body read counts as a post-header failure too, and is reported with the real status rather than as a plain timeout. The adapter cannot tell that abort apart from a caller cancellation because both arrive on the same signal, so it carries the response metadata out with the error and the client decides: a cancellation stays `isCancelled`, a timeout becomes a terminal stream failure (`stream_response_error`, even when a slow sink rather than the server is what held the body up).

`XHRAdapter` is the one real gap, for a network error mid-body - a per-attempt timeout there is the adapter's own abort, which reads the status first and carries it out as FetchAdapter does (after a redirect the browser followed, the refused redirect is reported instead). It is a spec-level limitation rather than a browser inconsistency: setting the error flag sets the response to a network error, which forces `status` to `0`. There is no surviving signal that headers ever arrived, so a mid-body truncation is indistinguishable from a connection refused. It arrives as an ordinary transport failure (`status: 0`, `isStreamError: false`), which for an **idempotent** method is eligible for retry, so a truncated `GET` is silently re-fetched where `NodeAdapter` and `FetchAdapter` would report the real status and stop.

A non-idempotent write is not replayed there, but only because `XHRAdapter` never supplies `wasDefinitelyNotSent`, so the default rule blocks it for want of proof, not because the truncation was recognized. Enable `retryNonIdempotentMethods` and that protection is gone, since nothing distinguishes this failure from a connection that was refused. Browser code performing non-idempotent writes should prefer `FetchAdapter` where replay safety matters.

#### Failures Before a Response

The same replay question applies to a failure with no response at all, where `isStreamError` cannot help because no headers ever arrived. Adapters answer it with two separate signals: `isRetryable: false` suppresses a retry the status alone would allow, and `wasDefinitelyNotSent: true` proves the request never reached the server.

`NodeAdapter` sets `wasDefinitelyNotSent` from the transport error code, treating only codes that prove no connection was established (`ECONNREFUSED`, `ENOTFOUND`, and similar) as replayable. Anything else, including `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, or a bare socket hang up, is possible delivery. The two unreachable codes are on that side despite reading like connect-time failures, because an ICMP unreachable arriving for an established connection is reported on that connection with the same code. Unproven is reported by leaving the field off rather than by setting it to `false`: the contract is that absence means "not known", so an explicit `false` would read as a proof of delivery no adapter is in a position to give.

It does not pair that with `isRetryable: false`. Whether a partly-sent request may be replayed is the method question, and withholding the proof already answers it. A blanket veto would additionally stop retrying an idempotent `PUT` after an ordinary socket error, which is the case a retry is most likely to fix.

`NodeAdapter` uses transport error codes rather than body-byte counts for this proof. A byte count cannot establish delivery in either direction: an empty-body request writes headers and nothing else, so the counter stays at `0` even after the server acted on it, and the counter tracks bytes handed to the stream rather than bytes on the wire, so it can be non-zero for a connection that was never established.

`XHRAdapter` sets neither. It never sets `wasDefinitelyNotSent`, because it has no way to prove non-delivery: upload progress events are suppressed for cross-origin requests that CORS does not grant access to, and such a request is still delivered. The browser blocks the response, not the request, so the absence of progress is not evidence that nothing was sent. It does not set `isRetryable: false` in its place either, since that flag blocks a retry for every method: inferring it from upload progress would stop retrying an idempotent `PUT` after an ordinary network error, and would override `retryNonIdempotentMethods` even when the caller has stated the replay is safe.

`FetchAdapter` never sets `wasDefinitelyNotSent`, because `fetch` exposes no upload progress or byte accounting, so a failure there is indistinguishable from one where nothing was sent. It sets `isRetryable: false` only for the TLS case below, exactly as `NodeAdapter` does.

`MockAdapter` can simulate any of it via `transportError`, so the replay rules are testable without a socket. It delivers no response data at all, meaning no body, headers, cookies, or terminal progress, and accepts the signals a real adapter would attach:

```typescript
// Proven undelivered - a POST may be replayed
adapter.routes.post('/orders', () => ({
  status: 200,
  transportError: { wasDefinitelyNotSent: true },
}));

// Delivery unknown - a POST is not replayed, an idempotent GET still is
adapter.routes.post('/orders', () => ({ status: 200, transportError: true }));

// Nothing should retry this, whatever the method. The default status 0 is
// retryable, so the veto is what stops it - pair it with a non-retryable
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

`isRetryable` is a hint about whether another attempt is worth making, and its contract only assigns meaning to `false`. An adapter may set it `true` for a failure it considers transient without knowing whether the request was delivered. Replaying a non-idempotent request needs a stronger statement, so adapters make it separately via `wasDefinitelyNotSent: true`, which claims only one thing: no request bytes reached the server. A custom adapter that sets `isRetryable: true` alone will not unlock a `POST` retry. The client reads these flags, and an adapter's other answer flags (`isTransportError`, `isStreamError`, `isStreamed`, `wasRedirectDetected`), only as booleans: a custom adapter's `'false'` or `1` is treated as unset.

`isRetryable: false` is reserved for failures that no method should retry because another attempt cannot succeed, not for ones that merely might have been delivered. A rejected TLS certificate is the example: both `NodeAdapter` and `FetchAdapter` resolve those as `495` with `isRetryable: false`, since the same request against the same server fails identically every time. On `FetchAdapter` this is a server-runtime classification. Bun puts the OpenSSL code on the error and Node hangs it off `cause`, while a browser reports an opaque `TypeError` with neither, so a browser TLS failure keeps the ordinary transport-error shape.

#### Why a Retry Did Not Happen

`willRetry: false` on an `onAttemptEnd` event does not say whether a retry was declined by the policy or suppressed by a safety rule. When the status alone would have allowed one, `retrySuppressedReason` names which rule stopped it:

| Value                   | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `adapter_veto`          | The adapter vetoed automatic retry for this response                                  |
| `stream_error`          | The body failed after headers arrived, so the server received the request             |
| `non_idempotent_method` | A non-idempotent method (`POST`, `PATCH`, a custom one) with no proof of non-delivery |
| `upload_unsettled`      | The adapter ignored a bodied attempt's timeout, and the body may still be going out   |

It is absent when a retry was scheduled, when no policy is configured, when the policy has no attempts left, or when the status was never retryable in the first place. In those cases nothing was suppressed, so naming a cause would misdescribe why the request stopped. It is also absent when the attempt ends as an `adapter_error`, such as a response whose body could not be decoded, even if a retry had been planned: the request failed, and the error code says why.

The built-in real transport adapters do not currently produce `adapter_veto`: their
TLS-certificate veto uses status `495`, which is already non-retryable. `MockAdapter`
can produce it with `transportError: { isRetryable: false }` at the default status `0`;
a custom adapter can also veto a status the client would otherwise retry.

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

`POST`, `PATCH` and any custom method (WebDAV's `LOCK`, say) are the methods RFC 9110 does not define as idempotent, so replaying one may apply the same change twice. By default `HTTPClient` will not retry them:

- **After a real HTTP response**, never by default. A retryable status like `500` does not prove that the write failed: the server may already have applied it.
- **After a transport failure**, only when the adapter reports `wasDefinitelyNotSent: true`, proving that no request bytes reached the server. An adapter that cannot tell reports nothing, which is treated as unsafe. The transport condition is part of the rule: on a real response delivery is already settled the other way, so nothing can unlock a replay there.
- **After a thrown adapter error** (including a per-attempt timeout), never by default. The client has no proof of non-delivery, so retrying could duplicate a write.

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
  body: { id: 1 }, // discarded - a real post-header failure loses the body
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

builder.requestID; // ULID assigned at construction time - available before and after send()
builder.state; // Current RequestState
builder.response; // HTTPResponse<T> | null
builder.error; // HTTPClientError | null
builder.attemptCount; // Attempts begun, including one a retry interceptor or request setup ended before dispatch (null before send and when the request ends in its initial interceptor phase - an interceptor's cancel or error, or a cancel made during setup or while the interceptors run; 0 for a signal already aborted at send or a `request_setup_error` before any attempt, such as an unresolvable URL or a body an initial-phase interceptor returned that cannot be copied; a value that throws during setup, so that `send()` rejects, leaves it null)
builder.nextRetryDelayMS; // Scheduled delay for next retry (ms), or null
builder.nextRetryAt; // Epoch ms for next retry, or null; retry-phase observers run within the delay, not after it
builder.startedAt; // Epoch ms when the first attempt began (null before send, and null when the request ended before its first attempt began - e.g. pre-send cancel(), pre-aborted AbortSignal, request setup error raised before the first attempt such as an unresolvable URL, or request interceptor cancel/error). A setup failure inside an attempt (a cookie jar that throws while building the Cookie header) happens after the attempt began, so startedAt is set and attemptCount counts it
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

**Internal representation:** All header keys are lowercased. `set-cookie` is always `string[]`. Other multi-value headers that arrive as comma-joined strings remain as `string`. A response header an adapter reports more than once - as an array, or under keys that differ only by case - is read as Node reads a repeated header: joined with `', '`, except one that holds a single value (`location`, `content-type`, `content-length`, ...), which keeps its first. `fetch` and XHR hand a repeated header over already joined with `, ` (`XHRAdapter` joins one an XHR outside a browser gives on lines of its own the same way), and `FetchAdapter` and `XHRAdapter` keep it joined, single-value headers included: a joined `Content-Type` is read by its first media type, and a joined `Content-Length` only when its values agree. For `Location`, both take the first by splitting at the first `, /` or `, scheme://`, so a single `Location` that itself contains one of those (an unencoded `, /` in its query) is read up to it. Servers percent-encode such characters; one that does not gets the same target only through `NodeAdapter`.

**Merging:** When multiple sources set the same header (default headers, request headers, interceptors), later values win wholesale. A `string[]` value replaces a `string` value entirely rather than being appended. A single-element `string[]` is normalized to a plain `string` when merging outgoing request headers. Observer-facing `AttemptRequest.headers` may still contain `string[]` values when an adapter reports repeated effective request headers, but array preservation is not guaranteed. Do not rely on `Array.isArray()` checks on header values in any context.

**Browser-restricted headers** (applying to FetchAdapter and XHRAdapter):

Exact names: `accept-charset`, `accept-encoding`, `access-control-request-headers`, `access-control-request-method`, `access-control-request-private-network`, `connection`, `content-length`, `date`, `expect`, `host`, `keep-alive`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `via`, `cookie`, `dnt`, `origin`, `referer`, `set-cookie`, `user-agent`

Prefix-based: all `proxy-*` and `sec-*` headers

Method-override headers `x-http-method`, `x-http-method-override`, `x-method-override` cannot tunnel `connect`, `trace`, or `track`.

## Exported Types

From `lifecycleion/http-client`:

```typescript
// Client
HTTPClient;
HTTPSubClient; // What createSubClient() returns
HTTPRequestBuilder; // Use as a type annotation: let builder: HTTPRequestBuilder<User>

// Adapter
(HTTPAdapter,
  AdapterRequest,
  AdapterResponse,
  AdapterType,
  AdapterProgressEvent);
FetchAdapter;

// Request
(HTTPMethod, ContentType, QueryValue, QueryObject, RequestHeadersInput);
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
(RequestState, RequestInfo, CancelResult);

// Streaming
(WritableLike,
  StreamResponseInfo,
  StreamResponseContext,
  StreamResponseCancel,
  StreamResponseFactory);

// Cookies
(Cookie, CookieInput, CookieJarJSON, CookieJarOptions, PublicSuffixOverrides);
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

| Constant                                   | Value / Type                       | Description                          |
| ------------------------------------------ | ---------------------------------- | ------------------------------------ |
| `DEFAULT_TIMEOUT_MS`                       | `30_000`                           | Default request timeout              |
| `DEFAULT_MAX_RESPONSE_BYTES`               | `67_108_864` (64 MiB)              | Default buffered response size limit |
| `DEFAULT_REQUEST_ID_HEADER`                | `'x-local-client-request-id'`      | Header name for request IDs          |
| `DEFAULT_REQUEST_ATTEMPT_HEADER`           | `'x-local-client-request-attempt'` | Header name for attempt number       |
| `DEFAULT_USER_AGENT`                       | `'lifecycleion-http-client'`       | Default User-Agent string            |
| `DEFAULT_MAX_REDIRECTS`                    | `5`                                | Default redirect limit               |
| `HTTP_METHODS`                             | `ReadonlyArray<HTTPMethod>`        | The standard methods, sent uppercase |
| `RETRYABLE_STATUS_CODES`                   | `ReadonlySet<number>`              | Status codes that trigger a retry    |
| `REDIRECT_STATUS_CODES`                    | `ReadonlySet<number>`              | 301, 302, 303, 307, 308              |
| `BROWSER_RESTRICTED_HEADERS`               | `ReadonlySet<string>`              | Exact headers blocked in browsers    |
| `BROWSER_RESTRICTED_HEADER_PREFIXES`       | `ReadonlyArray<string>`            | `['proxy-', 'sec-']`                 |
| `BROWSER_METHOD_OVERRIDE_HEADER_NAMES`     | `ReadonlySet<string>`              | Method override header names         |
| `BROWSER_FORBIDDEN_METHOD_OVERRIDE_VALUES` | `ReadonlySet<string>`              | `connect`, `trace`, `track`          |
