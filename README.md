# Lifecycleion v0.0.1

[![npm version](https://badge.fury.io/js/lifecycleion.svg)](https://badge.fury.io/js/lifecycleion)

A collection of foundational TypeScript utilities for managing application lifecycle, logging, retries, events, and common programming patterns.

<!-- toc -->

- [Why Lifecycleion?](#why-lifecycleion)
  - [Key Features](#key-features)
- [Installation](#installation)
- [Quick Example](#quick-example)
- [Available Libraries](#available-libraries)
- [Change Log](#change-log)
- [Contributing](#contributing)
- [License](#license)

<!-- tocstop -->

## Why Lifecycleion?

Lifecycleion provides battle-tested, production-ready utilities that handle the complex orchestration of modern applications. Whether you need graceful shutdowns, robust retry logic, flexible logging, or just reliable helper functions, Lifecycleion has you covered.

### Key Features

- 🚀 **Lifecycle Management** - Orchestrate startup, shutdown, and runtime control of application components with dependency resolution
- 🪵 **Flexible Logger** - Sink-based logger with log levels, redaction, and service scoping
- 🔄 **Retry Utilities** - Fixed and exponential backoff strategies with cancellation support
- 📡 **Event Systems** - Event emitters for multiple event types and single-event observers with type safety
- 🛡️ **Error Handling** - Serialize errors for IPC/RPC, format them as readable tables, and handle callbacks safely
- 🔧 **Common Utilities** - ID generation (UUID, ULID, ObjectID), string manipulation, deep cloning, and more
- 📦 **Tree-shakeable** - Import only what you need via subpath exports
- 💪 **TypeScript-first** - Full type safety with comprehensive TypeScript definitions

## Installation

```bash
npm install lifecycleion
# or
yarn add lifecycleion
# or
bun add lifecycleion
```

## Quick Example

```typescript
import {
  LifecycleManager,
  BaseComponent,
} from 'lifecycleion/lifecycle-manager';
import { createLogger } from 'lifecycleion/logger';
import { RetryRunner } from 'lifecycleion/retry-utils';

// Create a logger
const logger = createLogger({ service: 'my-app' });

// Set up retry logic
const runner = new RetryRunner({ maxAttempts: 3, baseDelayMs: 1000 });
await runner.run(async () => {
  // Your operation here
});

// Manage component lifecycle
class MyComponent extends BaseComponent {
  async start() {
    logger.info('Starting component');
  }

  async stop() {
    logger.info('Stopping component');
  }
}

const manager = new LifecycleManager();
manager.registerComponent(new MyComponent('my-component'));
await manager.startAllComponents();
```

## Available Libraries

Each library has comprehensive documentation in the [docs](./docs) folder. Click on any library name in the table below to view detailed usage examples, API references, and best practices.

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
| [sleep](./docs/sleep.md)                                           | `lifecycleion/sleep`                      | Pause async execution for a given number of milliseconds                                                                                 |
| [strings](./docs/strings.md)                                       | `lifecycleion/strings`                    | String type guard, case conversion (PascalCase, camelCase, CONSTANT_CASE), grapheme splitting, character filtering, and chopping helpers |
| [tmp-dir](./docs/tmp-dir.md)                                       | `lifecycleion/tmp-dir`                    | Create and automatically clean up uniquely-named temporary directories with configurable prefix, postfix, and unsafe cleanup support     |
| [unix-time-helpers](./docs/unix-time-helpers.md)                   | `lifecycleion/unix-time-helpers`          | Unix timestamp utilities for seconds, milliseconds, high-resolution timing, and unit conversion                                          |

## Change Log

See [changelog.md](./changelog.md) for version history and release notes.

## Contributing

Contributions are welcome! Please feel free to submit issues, feature requests, or pull requests on [GitHub](https://github.com/keverw/lifecycleion).

## License

MIT License - see [LICENSE](./LICENSE) file for details.
