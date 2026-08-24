# Change Log

<!-- toc -->

- [0.0.1 (Feb 23, 2026)](#001-feb-23-2026)
- [0.0.2 (Feb 28, 2026)](#002-feb-28-2026)
- [0.0.3 (Feb 28, 2026)](#003-feb-28-2026)
- [0.0.4 (Mar 2, 2026)](#004-mar-2-2026)
- [0.0.5 (Mar 3, 2026)](#005-mar-3-2026)
- [0.0.6 (Mar 3, 2026)](#006-mar-3-2026)
- [0.0.7 (Mar 4, 2026)](#007-mar-4-2026)
- [0.0.8 (Mar 18, 2026)](#008-mar-18-2026)
- [0.0.9 (Mar 19, 2026)](#009-mar-19-2026)
- [0.0.10 (Apr 7, 2026)](#0010-apr-7-2026)
- [0.0.11 (Apr 9, 2026)](#0011-apr-9-2026)
- [0.0.12 (Apr 18, 2026)](#0012-apr-18-2026)
- [0.0.13 (Apr 19, 2026)](#0013-apr-19-2026)
- [0.0.14 (Apr 28, 2026)](#0014-apr-28-2026)
- [0.0.15 (May 29, 2026)](#0015-may-29-2026)
- [0.0.16 (June 9, 2026)](#0016-june-9-2026)
- [0.0.17 (June 10, 2026)](#0017-june-10-2026)
- [0.0.18 (June 11, 2026)](#0018-june-11-2026)
- [0.0.19 (July 24, 2026)](#0019-july-24-2026)
- [0.0.20 (Aug 21, 2026)](#0020-aug-21-2026)
- [0.0.21 (unreleased)](#0021-unreleased)

<!-- tocstop -->

## 0.0.1 (Feb 23, 2026)

- Initial package publish

## 0.0.2 (Feb 28, 2026)

- LifecycleManager error and warning logs now pass full error objects in `params.error` for consistency with other component-operation log paths

## 0.0.3 (Feb 28, 2026)

- LifecycleManager, added `attachSignalsBeforeStartup` for attaching signal handlers before startup begins while preserving the original `attachSignalsOnStart` behavior
- LifecycleManager now automatically stops components that finish starting after LifecycleManager shutdown has already begun
- LifecycleManager, startup timeouts without `onStartupAborted()` now auto-stop the component if that delayed startup later completes

## 0.0.4 (Mar 2, 2026)

- LifecycleManager, fixed `enableLoggerExitHook()` so `logger.exit()` calls made during an already-running shutdown are deferred and completed after shutdown finishes instead of being left pending

## 0.0.5 (Mar 3, 2026)

- CurlyBrackets now supports array index paths such as `{{users[0].name}}`, `{{matrix[0][2]}}`, and mixed object-array traversal with existing fallback behavior preserved
- Logger redaction now supports the same mixed object-array paths in `redactedKeys`, including paths like `users[0].password`
- CurlyBrackets and logger docs/tests now explicitly cover nested path fallback behavior, primitive intermediate values, falsey terminal values, and `Error` interpolation behavior

## 0.0.6 (Mar 3, 2026)

- CurlyBrackets now supports quoted bracket keys such as `{{user["display-name"]}}` and mixed paths like `{{users[0]["display-name"]}}`
- Logger redaction now supports matching quoted bracket-key paths such as `users[0]["password-hash"]` in `redactedKeys`
- Shared internal path parsing now rejects unsupported syntax cleanly instead of partially tokenizing invalid paths

## 0.0.7 (Mar 4, 2026)

- Logger messages now render from redacted params when `redactedKeys` are configured, so templated sensitive fields are masked in `message` as well as `redactedParams`
- CurlyBrackets and logger redaction now share an internal value-stringification helper so arrays, objects, and `Error` values are normalized consistently before rendering or redaction, non-string values are now always stringified before passing to redaction functions

## 0.0.8 (Mar 18, 2026)

- Added `lifecycleion/dev-mode`, a runtime-settable dev/production mode flag with auto-detection from CLI args (`'dev'`/`'prod'`) or `NODE_ENV`, first-wins semantics for HTML injection compatibility, and `overrideDevMode()` for test/tooling use

## 0.0.9 (Mar 19, 2026)

- LifecycleManager error and warning log messages now include `error.message` inline (e.g., `"Component failed to start: Connection refused"`) so failure reasons are visible in plain log output without a custom structured sink

## 0.0.10 (Apr 7, 2026)

- Added the new adapter-based HTTP client foundation in `lifecycleion/http-client`, including the shared `HTTPAdapter` contract, fluent request builder, retries, redirect handling, cancellation, interceptors, response/error observers, request tracking, and the default `FetchAdapter`
- Added `MockAdapter` plus server-side cookie jar support and shared HTTP client request/response utilities
- Added `lifecycleion/http-client-node` with a Node adapter for server-side HTTP requests, streaming downloads, multipart uploads, Unix sockets, and TLS/mTLS options
- Added `lifecycleion/http-client-xhr` with an XHR adapter for environments that expose `XMLHttpRequest`, including real per-chunk upload/download progress, redirect detection, and Playwright-based browser integration tests
- Added `lifecycleion/domain-utils`, hardened helpers for normalizing and matching domains and origins, including IDNA/TR46 normalization, IPv6 literal support with zone-ID rejection, wildcard CORS matching with PSL/IP-tail guards, credentials-safe origin matching, and re-exports of `tldts` helpers (`getDomain`, `getSubdomain`) so consumers don't need a separate install
- Added `lifecycleion/lru-cache`, a TTL-aware LRU cache with configurable max entries, optional byte-size limit, per-entry TTL overrides, automatic expiration, and pluggable size calculators
- Fixed test-only TypeScript assertion issues reported in some unit test cases. No runtime or API behavior changed for them
- Added `lint` and `type-check` to `prepublishOnly` to strengthen the future release process

## 0.0.11 (Apr 9, 2026)

- Node.js support now targets `>=25` so browser-style global error event APIs such as `ErrorEvent` are available consistently for callback error reporting
- `lifecycleion/lru-cache` now supports `onChange` callbacks for cache writes and removals, with typed `set`, `skip`, `evict`, `expired`, `delete`, and `clear` events plus optional `onChangeReasons` filtering
- `lifecycleion/lru-cache` now skips writes that cannot fit within `maxSize` as a single value, emitting `reason: 'skip'` with `cause: 'maxSize'` while leaving existing cache state unchanged

## 0.0.12 (Apr 18, 2026)

- LifecycleManager `lifecycle-manager:shutdown-completed` events now include the shutdown result fields directly on the event payload, making ESC/SIGINT-triggered shutdown results observable without polling `getLastShutdownResult()`
- Clarified LifecycleManager shutdown event semantics in code/docs: `shutdown-completed` means the manager finished waiting. If a global shutdown timeout fires, the payload reflects the result at that point

## 0.0.13 (Apr 19, 2026)

- LifecycleManager now supports an opt-in `repeatedShutdownRequestPolicy` with a required `onForceShutdown()` hook so applications can decide how to escalate repeated shutdown requests received during an already-running shutdown
- Repeated shutdown escalation now tracks request count and timing window across real signals, keyboard-triggered shutdown requests, and programmatic `triggerShutdown()` calls that flow through the same signal callback path
- The default repeated shutdown escalation window is now 2 seconds with a default force threshold of 3 requests
- Repeated shutdown escalation now supports optional `armedAfterFailureMS` overrides so failed or stalled shutdown attempts can stay force-armed longer than the default derived post-failure window
- LifecycleManager shutdown logs now distinguish between the normal first shutdown request, repeated shutdown requests still being tracked, and repeated-request escalation when the force threshold is reached

## 0.0.14 (Apr 28, 2026)

- LifecycleManager now detects when a stalled component's original `stop()` or `onShutdownForce()` promise eventually resolves and automatically transitions it from `stalled` to `stopped`, clearing the stall record and emitting a `component:stalled-resolved` event. A per-component stop generation token prevents a late-resolving promise from affecting a component that has already been restarted since stalling.
- Docs now document the `stop()` promise-deduplication pattern as the recommended approach when `onShutdownForce()` should join an already-running `stop()`, and the `onGracefulStopTimeout()` pattern as an alternative for unblocking `stop()` without a concurrent second close.
- BaseComponent now exposes a protected `reportUnexpectedStop(error?)` method. Call it when the component detects an internal failure (crashed server, lost connection, exited worker) to let the manager mark it stopped, store the error as `lastError`, emit `component:unexpected-stop`, and then emit the canonical `component:stopped` event for the resulting stopped state. A subsequent `stopAllComponents()` call skips the already-stopped component and proceeds normally. The call is a no-op once the manager begins stopping or unregistering the component, and the handler is automatically re-armed after each successful restart.
- If `reportUnexpectedStop()` fires during `startAllComponents()`, required components now fail the bulk startup with `code: 'component_unexpected_stop'` and trigger rollback of later-started components, while optional components are recorded in `failedOptionalComponents`.
- Added `component:unexpected-stop` event (payload: `{ name, error? }`) emitted when a running component calls `reportUnexpectedStop()`, immediately before the follow-up `component:stopped` event.
- BaseComponent now exposes a protected `getSelfStatus()` method that returns the component's own `ComponentStatus` from the manager without requiring the caller to pass the component name.

## 0.0.15 (May 29, 2026)

- Added exported `LifecycleValueProvider` type for helpers that only need the shared-value `getValue()` surface, allowing the same helper to accept either a `LifecycleManager` or a component-scoped lifecycle reference.
- Prevent registering a single component instance with multiple `LifecycleManager` instances simultaneously. Registration fails with `code: 'duplicate_instance'` and a descriptive message.
- Unregistering a component now automatically clears its `lifecycle` reference and marks it as unregistered, allowing it to be registered again.

## 0.0.16 (June 9, 2026)

- `NodeAdapter` now accepts a top-level `ca` option (`string | Buffer | Array<string | Buffer>`) for trusting a private CA when connecting to internal HTTPS services, without requiring a client certificate. Previously the only way to supply a custom CA was through `mtls.ca`, which also required `cert` and `key`.

## 0.0.17 (June 10, 2026)

- Updated dependencies to their latest compatible versions, including security fixes for `qs` (GHSA-q8mj-m7cp-5q26) and `uuid` (GHSA-w5hq-g745-h8pq). No API changes.

## 0.0.18 (June 11, 2026)

- `NodeAdapter` now accepts a `servername` option to set the TLS SNI hostname independently of the connection target. This is required when dialing by IP address (e.g. from a service registry) but the server certificate's SAN lists a DNS name — without it, TLS verification fails because the IP does not match the DNS SAN.
- Updated dependencies (tr46 to 6.0.0) and (uuid to 14.0.0)

## 0.0.19 (July 24, 2026)

- Updated dependencies to their latest compatible versions, including a security fix for the direct dependency `find-my-way` (GHSA-c96f-x56v-gq3h, HTTP/2 DDoS) and transitive fixes for `qs` and `js-yaml`. Also bumped `tldts`, `string-width`, and `uuid`, plus dev tooling (`prettier`, `typescript-eslint`, `@playwright/test`, and others).
- Added `overrides` to pin the vulnerable transitive dev dependencies `brace-expansion` (to 5.0.8) and `esbuild` (to 0.28.1), clearing the remaining `bun audit` advisories without upgrading eslint or tsup to breaking major versions. These only affect the build/lint toolchain, not the published package.
- The pre-test Playwright check now launches a headless browser instead of only checking the full Chromium path, so a missing or stale `chrome-headless-shell` binary (e.g. after a Playwright version bump) fails fast with a clear message instead of surfacing as confusing test failures.
- No API changes.

## 0.0.20 (Aug 21, 2026)

- **Added `crl` to `NodeAdapterConfig`** — certificate revocation lists, so a server certificate whose serial has been revoked is rejected even though its chain and hostname still verify. Revocation failures resolve as status `495` like other TLS certificate errors. The value is read on every request, so refreshing a revocation set does not require rebuilding the adapter, and no connection-pool handling is needed: `crl` is part of Node's pool key, so changing it partitions the pool and a socket established under the old CRL is never reused under the new one.
- **Concatenated CRL bundles are split for you.** Node reads only the **first** CRL of a concatenated PEM string and silently ignores the rest — unlike `ca`, which reads every certificate in a bundle. The bundle is the standard interchange format (Apache documents `SSLCARevocationFile` as "the concatenation of the various PEM-encoded CRL files"; nginx and HAProxy agree; `openssl verify -CRLfile` reads a whole bundle), so this is Node diverging from the library it links rather than an OpenSSL limitation. The adapter splits bundles on the RFC 7468 boundary, including strings nested inside an array, so `[bundleOfTwo, oneMore]` contributes three CRLs. This includes **Buffers**: `fs.readFileSync('bundle.pem')` without an encoding returns one and its contents are PEM like any other bundle, so passing Buffers straight through would leave the most ordinary way of loading a file silently truncated — measured, a bundle whose second CRL revoked the server's certificate accepted the connection as a Buffer and rejected it once split. DER Buffers pass through untouched, since DER encodes exactly one CRL. Note also that OpenSSL uses the **first** CRL it has for a given issuer rather than the newest, so a bundle must not contain two CRLs for the same issuer. Without this the failure is `UNABLE_TO_GET_CRL`, which reads as "no CRL supplied" rather than "your bundle was truncated" — and a bundle whose first entry happens to cover the root in use appears to work until the roster or export order changes.
- **Revocation failures are now classified as TLS certificate errors**, so they resolve as status `495` rather than a generic transport failure. This covers `CERT_REVOKED` plus every CRL verification code OpenSSL exposes — matched by property rather than by name, since the message-text fallback catches almost none of them (`CRL has expired` and "format error in CRL's lastUpdate field" contain none of the words it looks for).
- **Only PEM blocks and whitespace are accepted in a `crl` string.** A truncated or corrupted CRL, a damaged delimiter, or decoded `openssl ... -text` output is refused with an error rather than silently dropped. Splitting keeps only complete blocks, so a cut-short entry would disappear while the intact ones stayed in force — leaving the caller enforcing a set they never supplied, with no error; passing the string through unsplit is no better, since Node reads its first CRL and ignores the rest. The rule is exact rather than heuristic because a parser cannot distinguish a half-written CRL from a line of commentary, so admitting the second necessarily admits the first. Strip annotations before passing a bundle.
- **Bun compatibility note:** Bun ignored `crl` entirely through 1.3.14 — it accepted a revoked certificate with no error, no warning, and no throw on a malformed CRL, meaning the option was never read. The same was true of `minVersion`, `maxVersion`, and `secureProtocol`. All are fixed in Bun 1.4.0, which matches Node 25.9.0 on every case tested. **Require Bun >= 1.4.0 if you depend on these options for security.** The enforcement tests probe the runtime and skip where `crl` is unsupported rather than passing for the wrong reason; the bundle-splitting tests run everywhere.
- Two caveats worth reading before enabling `crl`, both fail-closed and therefore safe, but both able to refuse healthy connections: every certificate in the chain needs a covering CRL (`X509_V_FLAG_CRL_CHECK_ALL`, so a partial CRL set refuses every root it does not cover, even unrevoked ones), and CRLs expire (`CRL_HAS_EXPIRED` blocks good certificates past `nextUpdate`). See `docs/http-client.md`.
- Adapter contract types (`HTTPAdapter`, `AdapterRequest`, `AdapterResponse`, `AdapterType`, `AdapterProgressEvent`, `HTTPMethod`) are re-exported from the adapter subpaths, so code driving an adapter directly no longer has to import types from `lifecycleion/http-client`. Type-only, so nothing is added to the runtime bundle. The node subpath also re-exports the response-streaming types.
- Pinned `@types/bun` to 1.3.14. `@types/bun` 1.4.0 declares `off`/`removeListener` overloads for its `memoryPressure` event directly on `NodeJS.Process`, which shadows the generic `EventEmitter` overloads that `@types/node` relies on being inherited, breaking `process.off('SIGINT', ...)` and every other signal detach at the type level. Types only, so no runtime or security impact.
- Applied `brace-expansion` and `js-yaml` overrides to clear two high-severity advisories reaching the tree through ESLint's dev-only dependencies.
- Dependency refresh within existing ranges: `find-my-way` 9.8.0, `tldts` 7.4.10, `uuid` 14.0.2, `@playwright/test` 1.62.1, and the `typescript-eslint` packages 8.67.0.

## 0.0.21 (unreleased)

- **Fixed callback error reporting on Node.js.** `safeHandleCallback()` and `safeHandleCallbackAndWait()` report failures by dispatching an `ErrorEvent` of type `'reportError'` through `globalThis.dispatchEvent()`. Node 25 added a global `ErrorEvent` constructor but did **not** make `globalThis` an `EventTarget`, so `dispatchEvent`, `addEventListener`, and `removeEventListener` are all `undefined` there — meaning callback errors were caught and then silently dropped on Node. The existing tests missed this because they run under Bun, which provides the browser-style global event methods. The same gap made `logger.registerReportErrorListener()` return `'not_available'` on Node.
- **Added [global-event-target](./docs/global-event-target.md)** (`lifecycleion/global-event-target`), a conservative polyfill that supplies the missing global event methods, backed by a single shared `EventTarget`. It installs only when all three methods are absent, so native and user-installed implementations are never overwritten; it is idempotent and shares one backing target across repeated initialization and multiple copies of the package via a `Symbol.for()` key; installed properties are non-enumerable and bound to the backing target. A partial or foreign surface (some methods present, others missing — or present but not callable, such as `globalThis.dispatchEvent = null`) is deliberately left alone rather than mixing methods from unrelated targets or clobbering a value the application put there; a member explicitly assigned `undefined` counts as absent, since that is how a global gets cleared — reporting is skipped there, and the helpers still return their normal results. Because installation runs during module initialization, it never throws: a non-extensible global object (`Object.freeze(globalThis)`) or a non-configurable property returns `'blocked'` rather than breaking the import of `safe-handle-callback` and everything downstream of it, and a definition rejected despite that preflight is rolled back so nothing is left half-installed. Importing `lifecycleion/safe-handle-callback` or `lifecycleion/logger` installs it, so for most users this is transparent. Browser and Bun behavior is unchanged, and `ErrorEvent` is never polyfilled: Node 25+ is the supported floor and provides it natively.
- **Added Node-runtime tests.** A Bun-only suite cannot catch this class of bug, since Bun has the globals natively. The new suite bundles fixtures with `Bun.build({ target: 'node' })` and runs them under the real `node` binary, asserting that a plain `globalThis.addEventListener('reportError', ...)` receives both synchronous throws and rejected async callbacks, that the reported `ErrorEvent` carries the wrapped callback name and original error details, that nothing becomes an uncaught exception or unhandled rejection, and that repeat installation and pre-existing global implementations are handled as documented. It also pins down that Node itself has `ErrorEvent` but no global event methods, so the assumption behind the fix fails loudly if it ever changes.
- `sideEffects` is now a list rather than `false`: the installation happens at module initialization, and a blanket `sideEffects: false` would let a bundler drop a bare `import 'lifecycleion/safe-handle-callback'` despite the documented guarantee that importing it installs. Only the `safe-handle-callback` and `logger` entry files are listed, so the rest of the package stays fully tree-shakeable, and the reporting path re-runs the install itself so a swallowed error can never be a packaging artifact.
- Ownership of the global methods is tracked by function identity rather than a boolean marker, which could outlive what it described. An application that replaces the methods after installation is now correctly reported as `'native'` / not polyfilled, and `getGlobalEventTarget()` returns `null` instead of a backing target that no longer receives anything.
- Documentation now describes `'reportError'` as Lifecycleion's reporting convention built from web-standard primitives (`ErrorEvent` plus the global `EventTarget` methods), rather than implying the event type itself is a web-standard API.
