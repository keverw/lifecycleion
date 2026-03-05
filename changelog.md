# Change Log

<!-- toc -->

- [0.0.1 (Feb 23, 2026)](#001-feb-23-2026)
- [0.0.2 (Feb 28, 2026)](#002-feb-28-2026)
- [0.0.3 (Feb 28, 2026)](#003-feb-28-2026)
- [0.0.4 (Mar 2, 2026)](#004-mar-2-2026)
- [0.0.5 (Mar 3, 2026)](#005-mar-3-2026)
- [0.0.6 (Mar 3, 2026)](#006-mar-3-2026)
- [0.0.7 (Mar 4, 2026)](#007-mar-4-2026)

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
