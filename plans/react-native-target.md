# Plan: make React Native a supported target for the HTTP client

Status: not started. Nothing here has been run on a device yet. Do it after PR #34 and PR #35 have merged, on a new branch from main (for example `feat-react-native`).

## Goal

`lifecycleion/http-client` with `XHRAdapter` works in a React Native app, on iOS and Android. That covers:

- requests and responses;
- upload and download progress;
- cancel and timeout;
- retries;
- the cookie jar.

The supported setups are documented: which React Native versions, and which polyfills, if any. A small test app proves it on both platforms.

## Why

React Native is meant to be a target, but nothing has ever run there. The code only mentions React Native in comments, as "an XHR outside a browser". All XHR tests run under Bun against `FakeXHR`, a test double, not a real React Native XHR.

A review of the React Native 0.88 source (October 2026) found that, as the code stands, **a bare React Native app cannot even construct `HTTPClient`**. The details are below.

## What React Native gives us (researched, not yet tested)

The research covers React Native 0.88 with Hermes V1 and the New Architecture. "Bare" means plain React Native with no Expo and no polyfills.

| Feature                                       | Bare RN 0.88                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crypto.getRandomValues`                      | **missing**                           | `HTTPClient`'s constructor and every request builder call `generateID('ulid')`. The `ulid` package throws "Failed to find a reliable PRNG" without it. Needs `react-native-get-random-values`, or `expo-standard-web-crypto`.                                                                                                                                                                                                                                                                           |
| `URL`                                         | **broken**                            | A regex-based shim, not a WHATWG parser. It never throws on bad input, does not lowercase hosts or strip default ports, resolves relative URLs naively, and has no setters except `search`. The client's redirect handling, cross-origin credential stripping and cookie matching all rely on a spec-compliant URL. That makes this a **security** issue, not just a bug. Needs `react-native-url-polyfill`. Expo SDK 52 and later replaces `URL` with a compliant version, except for non-ASCII hosts. |
| `DOMException`                                | **missing** (global expected in 0.89) | XHRAdapter calls `new DOMException(...)` on cancel and timeout, so it throws a `ReferenceError` there.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `TextDecoder`                                 | 0.88 and later                        | Used to decode text and JSON response bodies. Before 0.88 it needs a polyfill. Expo SDK 52–57 ships a utf-8-only one.                                                                                                                                                                                                                                                                                                                                                                                   |
| `TextEncoder`                                 | 0.74 and later                        | Only FetchAdapter and MockAdapter use it.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AbortSignal.reason`, `throwIfAborted`, `any` | 0.87 and later                        | The client calls `throw timeoutController.signal.reason` on timeout. Before 0.87 there is no `reason`, so it would throw `undefined`. `AbortSignal.any` already has a fallback.                                                                                                                                                                                                                                                                                                                         |
| `FormData`                                    | `append` and `getAll` only            | `cloneBodyValue` in `http-client.ts` calls `body.entries()`, which **throws** for a FormData body.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Blob` from bytes                             | throws                                | We don't build Blobs on the XHR path. Keep it that way.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `EventTarget`, `Event`                        | 0.86 and later                        | `reportToHost` already checks for these and falls back.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Intl.Segmenter`                              | missing                               | `graphemes.ts` already checks for it and falls back.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SharedArrayBuffer`                           | missing                               | `binary-view.ts` already checks `typeof`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Regex `\p{}` with the `u` flag                | yes                                   | tr46 only uses `u` with explicit ranges. Fine.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Regex `v` flag                                | no                                    | Not used anywhere. Keep it that way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### XMLHttpRequest specifics (iOS uses NSURLSession, Android uses OkHttp)

- **`responseType = 'arraybuffer'`:** works. Bodies cross the bridge as base64, so this costs extra memory and CPU.
- **Upload events:** only `upload.progress` fires. There is never an `upload.load` or `upload.loadend`. `lengthComputable` is always `true`, and `total` comes from the native side. The two fallbacks we added in review rounds 15 to 17 cover exactly this:
  - the final upload event sent on `xhr.load`;
  - "a computable length of 0 is unknown".
- **Download `progress`:** only fires if a progress or readystatechange listener is attached. We attach one.
- **Redirects:** always followed natively, with no way to turn that off. XHRAdapter reports a redirect that the transport followed as `redirect_disabled`, so **every redirect fails in React Native today**. We need to decide how to handle this; see Phase 2.
- **`withCredentials`:** defaults to **`true`** in React Native, unlike browsers. When it is `true`, native cookie storage takes part in every request:
  - iOS adds its stored cookies, and our `Cookie` header gets appended to them.
  - Android's OkHttp **replaces** our `Cookie` header whenever its own jar has cookies for that URL.
  - Both platforms store `Set-Cookie` responses natively. On Android that store is shared with WebView.
  - XHRAdapter never sets `withCredentials`.
- **`getAllResponseHeaders()`:** returns `null` before a response arrives. `parseXHRResponseHeaders` already handles a falsy value.
- **`timeout`:** we set `0` and use our own timer, so the platform difference (idle timeout on iOS, whole-call timeout on Android) does not matter.

### Other adapters in React Native

- **FetchAdapter:** not suitable.
  - Bare React Native's `fetch` is whatwg-fetch on top of XHR. It ignores `redirect: 'manual'` and has no streaming body.
  - Expo's `expo/fetch` does support `redirect` and streaming. But its `credentials: 'same-origin'` behaves like `'include'`, and an abort rejects with a `FetchError`, not an `AbortError`.
  - Document XHRAdapter as the React Native adapter. Revisit `expo/fetch` later if needed.
- **Large files and background transfers:** XHR keeps the whole body in JS memory, and stops when the app is suspended.
  - `expo-file-system` upload and download tasks stream from and to disk, report progress, and run in the background on iOS.
  - `react-native-blob-util` streams file transfers with progress.
  - Either could back an optional file-transfer adapter later (Phase 4).

## Design

### Phase 1: fail fast and fix what we can in code

1. **DOMException.** Build abort errors through one helper that uses `DOMException` when it exists. Otherwise it returns an `Error` with `name = 'AbortError'`. The client already identifies these by `name`, not `instanceof`.
2. **FormData clone.** In `cloneBodyValue`, don't depend on `entries()`. Use it when present. Otherwise pass the FormData through unchanged, or refuse it, but never let it throw. Decide which.
3. **Timeout reason.** When `signal.reason` is `undefined`, throw an explicit timeout `AbortError` instead.
4. **A preflight check, run once when XHRAdapter is constructed.**
   - It refuses to run on a runtime missing what the client needs for correctness. It throws a `TypeError` that names the polyfill to install.
   - It checks three things:
     - **`crypto.getRandomValues`.** Decided: no `Math.random` fallback, anywhere. Without it, `generateID` (and so `HTTPClient`) throws a clear error naming `react-native-get-random-values` or `expo-standard-web-crypto`, rather than `ulid`'s bare "Failed to find a reliable PRNG". The same applies to every `generateID` type, since IDs are used outside the HTTP client too.
     - **A spec-compliant `URL`.** Probe it: `new URL('HTTP://A.example:80/a/../b').href === 'http://a.example/b'`, and `new URL('not a url')` must throw.
     - **`TextDecoder`.**
   - This matches the project's fail-fast rule: silently wrong URL parsing would break the credential and cookie protections.
5. **`withCredentials`.** Add an XHRAdapter option, or always set it to `false`, so React Native's native cookie store stays out of requests when the client's `CookieJar` is in use. Browsers default it to `false` already, so setting it explicitly changes nothing there. Check the CORS consequences before making it unconditional.

### Phase 2: redirects in React Native

React Native always follows redirects, so XHRAdapter's current "a followed redirect is `redirect_disabled`" rule makes every redirect fail. Choose one of these:

- **(a) Accept the followed redirect** when the runtime is not a browser. Report the final URL and response, as Node's `fetch` with `redirect: 'follow'` would. We lose per-hop control: no hop interceptors, and credentials are not stripped on cross-origin hops.
- **(b) Keep refusing,** document it, and point users at server-side fixes.

Option (a) needs a careful look at credential handling, because the native layer resends our headers, `Authorization` included, to whatever host the redirect names. That is the same leak the client's own redirect handling exists to prevent. Probably safe only behind an explicit opt-in.

### Phase 3: a test app

- An Expo app (SDK 58 or later, React Native 0.88 or later) in `examples/react-native/`, or in a separate repo so the library's dependencies stay clean.
- Run it on the iOS simulator and the Android emulator.
- It drives the client against a small local test server on the host machine. iOS reaches it at `localhost`; Android at `10.0.2.2`.
- Run it twice:
  1. **Bare:** with only `react-native-get-random-values` and `react-native-url-polyfill`.
  2. **Expo defaults.**
- **Cases to cover:**
  - GET JSON and text.
  - POST of JSON, a string, a Uint8Array and FormData (with a `{uri}` file part).
  - Upload progress: check the final event has `loaded === total`.
  - Download progress, with and without `Content-Length`.
  - Cancel, timeout, and a retry after a 503.
  - `maxResponseBytes` refusing a large body.
  - Cookies:
    - the jar sends a cookie, and the server sees exactly that cookie;
    - a `Set-Cookie` response lands in the jar;
    - nothing leaks into the native store when `withCredentials` is `false`.
  - A redirect, which must match whatever Phase 2 decides.
  - A non-ASCII host through `domain-utils` (tr46).
- Automate later if it is worth it, for example with Maestro or Detox. Start with manual runs and a checklist.

### Phase 4 (optional): a file-transfer adapter

- A separate entry point, for example `lifecycleion/http-client-react-native-files`, wrapping `expo-file-system`.
- It handles uploads where the body is a file path, and downloads saved to a file, with progress and background support. Its job is similar to `streamResponse` on Node.
- Ordinary requests stay on XHRAdapter.
- Only build this if large files actually come up.

## Docs

- In `docs/http-client.md`, add a "React Native" section covering:
  - the minimum React Native version;
  - the polyfills a bare app needs (`react-native-get-random-values`, `react-native-url-polyfill`, and a `TextDecoder` before 0.88), and that Expo SDK 58 or later needs none of them;
  - XHRAdapter as the adapter to use;
  - how redirects and native cookies behave.
- In `docs/id-helpers.md`, note that the `crypto` requirement also applies there.

## Open questions

- **Minimum version:** React Native 0.87, for full `AbortSignal`? Or support older versions with fallbacks?
- **Redirects:** option (a) behind an opt-in, or option (b)?
- **`withCredentials = false`:** make it the default, or an option?

## Done when

- The Phase 1 fixes have tests that simulate the missing APIs. Run the existing XHRAdapter tests with `DOMException`, `crypto`, `FormData.entries` and `AbortSignal.reason` removed.
- The test app passes its checklist on the iOS simulator and the Android emulator, in both setups.
- `changelog.md` and `docs/http-client.md` are updated.
- This plan file is deleted in the same PR that implements it.
