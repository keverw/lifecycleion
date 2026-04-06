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
- [0.0.10 (Unreleased)](#0010-unreleased)

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

- Added `lifecycleion/dev-mode` — runtime-settable dev/production mode flag with auto-detection from CLI args (`'dev'`/`'prod'`) or `NODE_ENV`, first-wins semantics for HTML injection compatibility, and `overrideDevMode()` for test/tooling use

## 0.0.9 (Mar 19, 2026)

- LifecycleManager error and warning log messages now include `error.message` inline (e.g., `"Component failed to start: Connection refused"`) so failure reasons are visible in plain log output without a custom structured sink

## 0.0.10 (Unreleased)

- Added the new adapter-based HTTP client foundation in `lifecycleion/http-client`, including the shared `HTTPAdapter` contract, fluent request builder, retries, redirect handling, cancellation, interceptors, response/error observers, request tracking, and the default `FetchAdapter`
- Added `MockAdapter` plus server-side cookie jar support and shared HTTP client request/response utilities
- Added `lifecycleion/http-client-node` with a Node adapter for server-side HTTP requests, streaming downloads, multipart uploads, Unix sockets, and TLS/mTLS options
- Added `lifecycleion/http-client-xhr` with an XHR adapter for environments that expose `XMLHttpRequest`, including real per-chunk upload/download progress, redirect detection, and Playwright-based browser integration tests
- Added `lifecycleion/domain-utils` — hardened helpers for normalizing and matching domains and origins, including IDNA/TR46 normalization, IPv6 literal support with zone-ID rejection, wildcard CORS matching with PSL/IP-tail guards, credentials-safe origin matching, and re-exports of `tldts` helpers (`getDomain`, `getSubdomain`) so consumers don't need a separate install
