# Lifecycleion v0.0.1

A collection of foundational helpers to manage your application lifecycle

<!-- toc -->

- [Available Libraries](#available-libraries)

<!-- tocstop -->

## Available Libraries

| Library                                                            | Import Path                               | Description                                                                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [arrays](./docs/arrays.md)                                         | `lifecycleion/arrays`                     | Array utility functions for filtering, comparison, deduplication, and string manipulation                                                |
| [ascii-tables](./docs/ascii-tables.md)                             | `lifecycleion/ascii-tables`               | Key-value and multi-column ASCII tables with word wrapping, nesting, and emoji support                                                   |
| [clamp](./docs/clamp.md)                                           | `lifecycleion/clamp`                      | Number clamping utilities with safe handling for non-finite values and nullish inputs                                                    |
| [constants](./docs/constants.md)                                   | `lifecycleion/constants`                  | Common string constants including whitespace helpers and Python-style character sets                                                     |
| [curly-brackets](./docs/curly-brackets.md)                         | `lifecycleion/curly-brackets`             | String templating with `{{placeholders}}`, fallbacks, escaping, and compiled templates                                                   |
| [deep-clone](./docs/deep-clone.md)                                 | `lifecycleion/deep-clone`                 | Deep clone utility with circular reference detection for objects, arrays, Maps, Sets, and more                                           |
| [error-to-string](./docs/error-to-string.md)                       | `lifecycleion/error-to-string`            | Format errors into readable ASCII tables with support for nested info and sensitive field masking                                        |
| [event-emitter](./docs/event-emitter.md)                           | `lifecycleion/event-emitter`              | Lightweight event emitter with protected and public variants, type safety, and memory management                                         |
| [id-helpers](./docs/id-helpers.md)                                 | `lifecycleion/id-helpers`                 | Unified ID generation and validation for ObjectID, UUID v4, UUID v7, and ULID                                                            |
| [is-boolean](./docs/is-boolean.md)                                 | `lifecycleion/is-boolean`                 | Type guard to check if a value is a boolean                                                                                              |
| [is-function](./docs/is-function.md)                               | `lifecycleion/is-function`                | Check whether a value is a function                                                                                                      |
| [is-number](./docs/is-number.md)                                   | `lifecycleion/is-number`                  | Type guards to check whether a value is a valid number, with and without finite enforcement                                              |
| [is-plain-object](./docs/is-plain-object.md)                       | `lifecycleion/is-plain-object`            | Type guard to check if a value is a plain object (not null, not an array)                                                                |
| [is-promise](./docs/is-promise.md)                                 | `lifecycleion/is-promise`                 | Thenable/promise detection following the Promises/A+ specification                                                                       |
| [json-helpers](./docs/json-helpers.md)                             | `lifecycleion/json-helpers`               | JSON formatting utilities                                                                                                                |
| [lifecycle-manager](./docs/lifecycle-manager.md)                   | `lifecycleion/lifecycle-manager`          | Lifecycle orchestration for managing startup, shutdown, and runtime control of application components                                    |
| [logger](./docs/logger.md)                                         | `lifecycleion/logger`                     | Flexible sink-based logger with log levels, redaction, template strings, and service scoping                                             |
| [padding-utils](./docs/padding-utils.md)                           | `lifecycleion/padding-utils`              | String padding utilities for left, right, and center alignment with a configurable pad character                                         |
| [process-signal-manager](./docs/process-signal-manager.md)         | `lifecycleion/process-signal-manager`     | Unified handler for process signals (SIGINT, SIGTERM, SIGHUP, etc.) and keyboard shortcuts with graceful shutdown and hot-reload support |
| [promise-protected-resolver](./docs/promise-protected-resolver.md) | `lifecycleion/promise-protected-resolver` | Promise wrapper with `resolveOnce` and `rejectOnce` that guarantee a promise is only settled once                                        |
| [retry-utils](./docs/retry-utils.md)                               | `lifecycleion/retry-utils`                | Retry logic with fixed and exponential backoff via `RetryPolicy` (low-level) and `RetryRunner` (high-level with events and cancellation) |
| [safe-handle-callback](./docs/safe-handle-callback.md)             | `lifecycleion/safe-handle-callback`       | Safely execute sync or async callbacks with automatic error reporting via the standard `reportError` event API                           |
| [serialize-error](./docs/serialize-error.md)                       | `lifecycleion/serialize-error`            | Convert any `Error` into a plain JSON-serializable object and back again for IPC, RPCs, and database storage                             |
| [single-event-observer](./docs/single-event-observer.md)           | `lifecycleion/single-event-observer`      | Lightweight type-safe observer pattern for a single event type, with public and protected notify variants                                |
| [unix-time-helpers](./docs/unix-time-helpers.md)                   | `lifecycleion/unix-time-helpers`          | Unix timestamp utilities for seconds, milliseconds, high-resolution timing, and unit conversion                                          |
