# Logger

A modern, flexible logging library with sink-based architecture, template string support, and built-in redaction.

<!-- toc -->

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [Simple Logging](#simple-logging)
  - [Log Level Filtering](#log-level-filtering)
    - [Log Levels](#log-levels)
    - [Log Level Use Cases](#log-level-use-cases)
    - [Per-Sink Filtering](#per-sink-filtering)
  - [Exit Codes](#exit-codes)
  - [Template Strings With Parameters](#template-strings-with-parameters)
    - [Nested Object Support](#nested-object-support)
  - [Redaction of Sensitive Data](#redaction-of-sensitive-data)
    - [Nested Object Redaction](#nested-object-redaction)
    - [Wildcards Over Arrays](#wildcards-over-arrays)
    - [A Path Names a Location, Not a Value](#a-path-names-a-location-not-a-value)
    - [Path Grammar](#path-grammar)
    - [Custom Redaction Function](#custom-redaction-function)
    - [Redaction Fails Closed](#redaction-fails-closed)
    - [Finding Out _Why_ Redaction Failed](#finding-out-_why_-redaction-failed)
  - [When a Value Cannot Be Rendered](#when-a-value-cannot-be-rendered)
    - [Controlling How a Value Is Masked](#controlling-how-a-value-is-masked)
    - [What the Default Reveals](#what-the-default-reveals)
  - [Tags for Categorization and Filtering](#tags-for-categorization-and-filtering)
    - [Use Cases](#use-cases)
    - [Notes](#notes)
  - [Multiple Sinks](#multiple-sinks)
  - [Dynamic Sink Management](#dynamic-sink-management)
    - [Important Notes](#important-notes)
  - [Service Loggers](#service-loggers)
  - [Entity Loggers](#entity-loggers)
    - [Game Engine Example](#game-engine-example)
    - [Session Management With UUIDs](#session-management-with-uuids)
    - [Worker Pool Example](#worker-pool-example)
    - [Key Points](#key-points)
  - [Setting Exit Callback After Construction](#setting-exit-callback-after-construction)
- [Built-In Sinks](#built-in-sinks)
  - [ConsoleSink](#consolesink)
    - [Log Level Control](#log-level-control)
    - [Mute/Unmute Control](#muteunmute-control)
  - [ArraySink](#arraysink)
    - [With Transformer](#with-transformer)
  - [FileSink](#filesink)
    - [Log Level Control for Files](#log-level-control-for-files)
    - [File Naming](#file-naming)
    - [Features](#features-1)
    - [Error Handling & Retry](#error-handling--retry)
    - [Health Monitoring](#health-monitoring)
    - [Flush Pending Writes](#flush-pending-writes)
  - [NamedPipeSink](#namedpipesink)
    - [Failure Shape](#failure-shape)
    - [Error Handling & Reconnection](#error-handling--reconnection)
    - [Custom Formatter](#custom-formatter)
    - [Setup](#setup)
- [API Reference](#api-reference)
  - [Logger Methods](#logger-methods)
  - [Options for Log Methods](#options-for-log-methods)
  - [Logger Configuration](#logger-configuration)
    - [Sink Error Handling](#sink-error-handling)
      - [Where Errors Go When the Logger Cannot Log Them](#where-errors-go-when-the-logger-cannot-log-them)
    - [Exit Behavior](#exit-behavior)
- [Capturing Reported Errors](#capturing-reported-errors)
- [Where Failures Go](#where-failures-go)
  - [Why the Fall-Back Is the Console](#why-the-fall-back-is-the-console)
  - [Never Seeing a Console Line](#never-seeing-a-console-line)
  - [Standalone Renderers Are Different](#standalone-renderers-are-different)
- [EventEmitter Integration](#eventemitter-integration)
  - [Exit Event Phases](#exit-event-phases)
- [Custom Sinks](#custom-sinks)
- [LogEntry Structure](#logentry-structure)
  - [Important Notes](#important-notes-1)
  - [Security Note](#security-note)
- [Testing](#testing)
  - [With Transformer for Consistent Test Snapshots](#with-transformer-for-consistent-test-snapshots)
  - [With Console Sink for Debugging Tests](#with-console-sink-for-debugging-tests)
- [Frontend/Browser Usage](#frontendbrowser-usage)
  - [Features](#features-2)
  - [With Additional Sinks and Redaction](#with-additional-sinks-and-redaction)
- [Architecture Overview](#architecture-overview)
  - [Sink-Based Design](#sink-based-design)

<!-- tocstop -->

## Features

- **Sink-Based Architecture**: Write logs to multiple destinations simultaneously (console, files, named pipes, custom sinks)
- **Dynamic Sink Management**: Add, remove, and query sinks at runtime
- **Log Level Filtering**: Filter logs by severity on a per-sink basis with dynamic control
- **Debug Mode**: Separate debug log type with gray color, filtered by default
- **Template Strings**: Use `{{variable}}` syntax for dynamic log messages
- **Redaction**: Built-in support for masking sensitive data (passwords, API keys, etc.)
- **Tags**: Categorize and filter logs with optional string tags
- **Service Loggers**: Create scoped loggers with service names
- **Entity Loggers**: Create loggers for specific instances within services (components, game objects, workers, sessions)
- **EventEmitter Integration**: React to logging events for monitoring and alerting
- **Error Handling**: Custom error handlers for sink failures with access to the failing sink
- **Closed State Tracking**: All sinks track closed state and prevent writes after closing
- **File Rotation**: Automatic log file rotation based on size and date
- **Named Pipe Support**: Write to named pipes for log aggregation (Linux/macOS)
- **Browser & Node.js**: Works in both environments with appropriate color support
- **TypeScript**: Definitions for the published logger APIs

## Installation

```typescript
import {
  Logger,
  ConsoleSink,
  ArraySink,
  FileSink,
  NamedPipeSink,
} from 'lifecycleion/logger';
```

## Quick Start

### Simple Logging

```typescript
import { Logger, ConsoleSink } from 'lifecycleion/logger';

const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true, timestamps: true })],
});

logger.error('Error message');
logger.warn('Warning message');
logger.notice('Important notice');
logger.success('Operation successful');
logger.info('Application started');
logger.debug('Debug information'); // Filtered by default
```

### Log Level Filtering

Control which log levels are output on a per-sink basis using the `LogLevel` enum:

```typescript
import { Logger, ConsoleSink, LogLevel } from 'lifecycleion/logger';

// Default behavior: INFO level (shows ERROR, WARN, NOTICE, SUCCESS, INFO)
const consoleSink = new ConsoleSink();
const logger = new Logger({ sinks: [consoleSink] });

logger.error('Error message'); // ✓ Shown
logger.warn('Warning message'); // ✓ Shown
logger.notice('Notice message'); // ✓ Shown
logger.success('Success message'); // ✓ Shown
logger.info('Info message'); // ✓ Shown
logger.debug('Debug message'); // ✗ Hidden (filtered out)

// Enable debug mode to see all logs
consoleSink.setMinLevel(LogLevel.DEBUG);
logger.debug('Now this debug message shows!'); // ✓ Shown

// Set to only show errors and warnings
consoleSink.setMinLevel(LogLevel.WARN);
logger.error('Error shown'); // ✓ Shown
logger.warn('Warning shown'); // ✓ Shown
logger.info('Info hidden'); // ✗ Hidden

// Check current level
console.log(consoleSink.getMinLevel()); // LogLevel.WARN
```

#### Log Levels

The `LogLevel` enum uses numeric values where lower numbers = higher priority:

```typescript
enum LogLevel {
  ERROR = 0, // Critical failures and errors
  WARN = 1, // Potential problems or degraded functionality
  NOTICE = 2, // Normal but significant condition
  SUCCESS = 3, // Positive confirmations of operations
  INFO = 3, // Same level as SUCCESS (routine operational info)
  DEBUG = 4, // Verbose development and debugging details
  RAW = 99, // Special: always shown regardless of minLevel
}
```

When you set `minLevel` to a specific level, all logs at that level **and higher priority** (lower numbers) are shown:

- `LogLevel.ERROR` → Only errors
- `LogLevel.WARN` → Errors and warnings
- `LogLevel.NOTICE` → Errors, warnings, and important notices
- `LogLevel.INFO` → Errors, warnings, notices, success, and info messages (default)
- `LogLevel.DEBUG` → Everything including debug messages

**Note:** `RAW` logs are always output regardless of the `minLevel` setting, as they're intended for unformatted output that bypasses filtering.

#### Log Level Use Cases

Understanding when to use each log level helps maintain consistent, meaningful logs:

```typescript
// ERROR - Something is broken
logger.error('Database connection failed');
logger.error('Failed to process payment');

// WARN - Potential problem or degraded functionality
logger.warn('Slow query detected: 2.5s');
logger.warn('API rate limit at 90%');
logger.warn('Disk space running low: 5% remaining');

// NOTICE - Important but not problematic (blue, stands out)
logger.notice('Configuration loaded from defaults');
logger.notice('Running in fallback mode');
logger.notice('First-time user onboarding triggered');
logger.notice('Scheduled maintenance in 10 minutes');

// SUCCESS - Positive confirmation of operations
logger.success('User registration complete');
logger.success('Payment processed successfully');
logger.success('Database migration completed');

// INFO - Routine operational information
logger.info('Request received: GET /api/users');
logger.info('Cache hit for key: user:123');
logger.info('Background job started');

// DEBUG - Verbose development details
logger.debug('Parsing JWT token');
logger.debug('Cache miss, fetching from DB');
logger.debug('Request headers: {...}');
```

**Key distinction between NOTICE and INFO:** Use `notice` for information that warrants attention but isn't a problem (sits between WARN and INFO in priority). Use `info` for routine operational logs that track normal activity.

#### Per-Sink Filtering

Different sinks can have different log levels:

```typescript
import { FileSink, ConsoleSink, LogLevel } from 'lifecycleion/logger';

const consoleSink = new ConsoleSink({
  minLevel: LogLevel.INFO, // Console shows INFO and above
});

const fileSink = new FileSink({
  logDir: './logs',
  basename: 'debug',
  minLevel: LogLevel.DEBUG, // File captures everything including debug
});

const logger = new Logger({
  sinks: [consoleSink, fileSink],
});

logger.debug('Debug info');
// Console: ✗ Not shown
// File: ✓ Written

logger.info('Important info');
// Console: ✓ Shown
// File: ✓ Written
```

### Exit Codes

You can specify an exit code to terminate the process after logging:

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true })],
});

// Exit with code 0 (success)
logger.info('Process completed successfully', { exitCode: 0 });

// Exit with code 1 (error)
logger.error('Fatal error occurred', { exitCode: 1 });

// Exit with custom code
logger.error('Configuration error', { exitCode: 2 });

// No exit code = no exit (default behavior)
logger.error('Non-fatal error'); // Process continues
```

**Notes:**

- The exit code is included in the `LogEntry` that sinks receive, so custom sinks can see when a log will trigger an exit
- The `exitCode` must be a valid number. Non-numeric values are ignored and won't trigger exit

### Template Strings With Parameters

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true })],
});

logger.info('User {{userID}} logged in from {{ip}}', {
  params: {
    userID: 456,
    ip: '10.0.0.30',
  },
});
// Output: "User 456 logged in from 10.0.0.30"

logger.success('Payment of ${{amount}} processed for order {{orderId}}', {
  params: {
    amount: 99.99,
    orderId: 'ORD-12345',
  },
});
// Output: "Payment of $99.99 processed for order ORD-12345"
```

#### Nested Object Support

Templates support nested object properties using dot notation, array indexes, and quoted bracket keys:

```typescript
logger.info('User {{user.name}} (ID: {{user.id}}) from {{session.ip}}', {
  params: {
    user: {
      id: 123,
      name: 'Alice',
      role: 'admin',
    },
    session: {
      ip: '192.168.1.1',
      duration: 3600,
    },
  },
});
// Output: "User Alice (ID: 123) from 192.168.1.1"
```

```typescript
logger.info('Primary user {{users[0].name}} from {{sessions[0].ips[1]}}', {
  params: {
    users: [{ name: 'Alice' }],
    sessions: [{ ips: ['10.0.0.1', '10.0.0.2'] }],
  },
});
// Output: "Primary user Alice from 10.0.0.2"
```

```typescript
logger.info(
  'User {{user["display-name"]}} with public ID {{metadata["public-id"]}}',
  {
    params: {
      user: { 'display-name': 'Alice' },
      metadata: { 'public-id': 'USR-12345' },
    },
  },
);
// Output: "User Alice with public ID USR-12345"
```

**Error objects** work naturally with dot-path access:

```typescript
try {
  await db.connect();
} catch (error) {
  const err = toError(error);
  logger.error('Database connection failed: {{error.message}}', {
    params: { error: err },
  });
  // Output: "Database connection failed: Connection refused"
}
```

Normalizing the caught value with [`toError`](./to-error.md) ensures `{{error.message}}` always resolves to a string - without it, a thrown string or plain object would produce `(null)` in the output. Libraries and native APIs occasionally throw non-`Error` values.

Use `toError` rather than hand-rolling `error instanceof Error ? error : new Error(String(error))`: both halves of that idiom can throw. `instanceof` walks a prototype chain, which a revoked `Proxy` refuses, and `String()` invokes `toString`/`Symbol.toPrimitive` - on a value created with `Object.create(null)` it raises a `TypeError` of its own, from the line that was only trying to normalize an error. `toError` guards both and keeps the original on `cause`.

The normalized `err` is also captured in `params` for structured sinks that need the full error object or stack trace. Because the pattern only wraps non-`Error` values, original `Error` stack traces are preserved when the thrown value was already an `Error`.

### Redaction of Sensitive Data

Redaction is specified per-log to match the specific structure being logged:

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true })],
});

logger.info('Login attempt for user {{username}}', {
  params: {
    username: 'john_doe',
    password: 'super_secret_123', // This will be redacted
    ip: '10.0.1.50',
  },
  redactedKeys: ['password'],
});
// Output: "Login attempt for user john_doe"
// But password is masked in params

logger.warn('API call with key {{apiKey}}', {
  params: {
    apiKey: 'sk_live_1234567890', // This will be redacted
    endpoint: '/api/users',
  },
  redactedKeys: ['apiKey'],
});
```

#### Nested Object Redaction

Redaction supports nested object properties, array indexes, and quoted bracket keys, just like templates:

```typescript
logger.info('User login attempt', {
  params: {
    user: {
      username: 'alice',
      password: 'secret123', // Will be masked
      email: 'alice@example.com',
    },
    credentials: {
      apiKey: 'sk_live_1234567890', // Will be masked
      sessionId: 'abc123',
    },
    personalInfo: {
      ssn: '123-45-6789', // Will be masked
      address: '123 Main St',
    },
  },
  redactedKeys: ['user.password', 'credentials.apiKey', 'personalInfo.ssn'],
});

// The params object will have nested values redacted:
// user.password → '********3'
// credentials.apiKey → 's****************0'
// personalInfo.ssn → '1*********9'
```

```typescript
logger.info('User login attempt', {
  params: {
    users: [
      {
        username: 'alice',
        password: 'secret123', // Will be masked
      },
    ],
  },
  redactedKeys: ['users[0].password'],
});
```

For simple identifier-style keys, dot notation and quoted bracket notation are equivalent. For example, `user.password` and `user["password"]` resolve to the same field.

```typescript
logger.info('User login attempt', {
  params: {
    users: [
      {
        'display-name': 'alice',
        'password-hash': 'secret123', // Will be masked
      },
    ],
  },
  redactedKeys: ['users[0]["password-hash"]'],
});
```

**Note:** Dot notation, array indexes, quoted bracket keys like `users[0]["password-hash"]`, and the array wildcard `users[*].password` are all supported. Quoting is only required for a key that contains `.`, `[` or `]`. The path `users[0].password-hash` resolves the same as `users[0]["password-hash"]`.

A bare name therefore addresses a top-level key only: `redactedKeys: ['password']` masks `params.password` and leaves `params.user.password` rendered. Name the path to reach it.

#### Wildcards Over Arrays

A wildcard segment addresses **every element of an array**. `*` and `[*]` are the same rule written two ways, so `users.*.password` and `users[*].password` are interchangeable:

```typescript
logger.info('User login attempt', {
  params: {
    users: [
      { username: 'alice', password: 'secret123' }, // Will be masked
      { username: 'bob', password: 'secret456' }, // Will be masked
    ],
  },
  redactedKeys: ['users[*].password'],
});
```

It stands in for an array **index**, and only for one. That has two consequences worth knowing:

- **A plain object is not expanded over.** Where the parent is an object, a wildcard is the key literally spelled `*` - the same key `users["*"]` addresses - and nothing else. Naming one field never quietly masks the whole bag it sits in. An object whose keys happen to read as numbers, `{ users: { '0': { password } } }`, is still an object and is still not expanded over.
- **An array's named properties are not expanded over either.** `items[*]` masks the elements of `items` and leaves a property such as `items.note` alone, exactly as `items[0]` does.

`*`, `[*]` and the quoted `["*"]` are all the same segment, so quoting is **not** an escape hatch: `items["*"]` expands over every element when `items` is an array, exactly as `items[*]` does.

That is the grammar's existing rule rather than a wildcard exception. Quoting disambiguates a key that contains a delimiter, but it never changes what a segment means. The same is already true of numbers. The paths `users[0]`, `users["0"]`, `users['0']` and `users.0` are one entry, and that one entry addresses both an array's slot `0` and a plain object's key `"0"`, because the parser does not distinguish an index from a name and the container decides. The consequence for wildcards is simply that there is no spelling which addresses only a named property called `*` on an array.

Concrete paths are unchanged: `users[0].password` still masks that one element, and where both a concrete entry and a wildcard match the same location, the concrete one is the key handed to a [`redactFunction`](#custom-redaction-function).

A wildcard that resolves to nothing - the parent is missing, or is not a container - masks nothing and does not warn, exactly as an unreachable concrete path does. It adds no failure mode of its own: a container that genuinely refuses to be read still fails closed and still reports, wildcard or not.

#### A Path Names a Location, Not a Value

This section is the one description of path behaviour for all three surfaces that redact - the logger's `redactedKeys`, [`errorToString`](./error-to-string.md#additional-info--sensitive-fields)'s `sensitiveFieldNames`, and [`stringifyValue`](./stringify-value.md#redacting-while-rendering)'s `redactedKeys`. They share the parser and the walk, so what follows holds for each of them.

If one object is reachable by two paths, masking one leaves the other in the clear, because only one of them was named:

```typescript
const account = { apiKey: 'sk-live-abcdefghijkl' };

logger.info('sync', {
  params: { account, snapshot: { account } },
  redactedKeys: ['account.apiKey'],
});
// redactedParams.account.apiKey           → 's******************l'
// redactedParams.snapshot.account.apiKey  → 'sk-live-abcdefghijkl'
```

Both entries are the same object, so the second one is the first one unmasked. Name every path you want masked - here, `['account.apiKey', 'snapshot.account.apiKey']`.

Where that shows up depends on the surface. The rendered log message is unaffected unless it interpolates the second path, but a structured sink walks the whole of `redactedParams` and reaches it. The `redactValue` function hands the alias back as it came in, and `errorToString` prints it, since it renders every entry of `additionalInfo` into the table.

This falls out of what a path means and is not an oversight to work around. Masking by value instead would mean that naming one key silently rewrote a value somewhere else in the payload that you never mentioned, which is the opposite of the guarantee that redacted output differs from unredacted output only where a value was masked. It also cannot be done reliably in one pass, since whether the alias is masked would depend on which of the two paths the walk happened to reach first.

#### Path Grammar

An unquoted path segment is a run of name characters - letters, digits, combining marks, `_`, `$`, `@` and `-` - so ordinary key names need no quoting: `user.password-hash` and `users[0].api-key` both work. A key that contains anything else, including a delimiter, whitespace, or any other punctuation, needs the quoted bracket form, which is the only way to disambiguate it: `user["a.b"]`, `user["my key"]`, `user["a+b"]`. An entry the grammar rejects, such as a trailing dot or an unterminated bracket, redacts **nothing** and does not warn.

`*` and `[*]` are segments of their own, and only as a whole segment: `users[*].password` and `users.*.password` parse, while a partial wildcard such as `us*rs` or `a.*b` does not and therefore redacts nothing. The quoted `["*"]` is the same segment rather than an escape hatch - see [Wildcards Over Arrays](#wildcards-over-arrays).

This is the redaction grammar. A `{{placeholder}}` in a message template uses the same syntax minus the wildcard, since a placeholder renders one value and there is nothing for `{{users[*].name}}` to print - it is left in the message verbatim, as any unparseable placeholder is.

[`errorToString`](./error-to-string.md#additional-info--sensitive-fields) uses this same syntax for the `sensitiveFieldNames` list it reads off an error, so one mental model covers both. The two agree on bare names, dotted paths, array indexes, and quoted bracket keys. They differ only in what happens when the list itself is unusable, where `errorToString` drops `additionalInfo` wholesale.

#### Custom Redaction Function

You can customize how values are masked at the logger level:

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true })],
  redactFunction: (key, _value) => `[REDACTED-${key}]`,
});

logger.info('API call', {
  params: { apiKey: 'sk_12345' },
  redactedKeys: ['apiKey'],
});
// apiKey will be masked as: [REDACTED-apiKey]
```

Naming a plain object or an array in `redactedKeys` masks **each value inside it** and keeps the shape, so a structured sink still receives an object or an array rather than one masked string.

Any **other** value whose string form is produced rather than being the value itself - an `Error`, a `Date`, a `URL`, a `Map`, a class instance, a function, a symbol, and `null` or `undefined` - has no shape worth rebuilding and is replaced outright with `***REDACTED***`. It is deliberately not stringified and partially masked: the default keeps a value's first and last characters, and for a `URL` or a custom `toString` that is exactly where a secret tends to sit. A string shorter than 8 characters is replaced the same way, since a proportional mask of something that short hides almost nothing.

Return `null` to defer to the default masking for that value, so you can special-case a few keys without reproducing the default for the rest:

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true })],
  redactFunction: (key, _value) => (key === 'apiKey' ? '[hidden]' : null),
});
// apiKey → [hidden]; every other redacted key gets the default masking
```

To render a literal null, return the string `'null'`. Returning **nothing** defers as well: `undefined` is read exactly as `null`, so a function that handles a few keys and falls off the end for the rest masks them by default.

The same function and the same deferral rule work with [`errorToString`](./error-to-string.md#choosing-how-values-are-masked), which shares this default and passes the same key and stringified value.

#### Redaction Fails Closed

Your `redactFunction` is your code, and the values it is handed are your callers' - either
can fail. Redaction runs inside `handleLog`, which must not throw out of a `logger.info()`,
so a failure is contained. What it must never do is leave the original value in place: the
rendered message is built from the redacted params, so falling through would print the very
value redaction was asked to hide, to every sink.

A value whose redaction fails is replaced with `REDACTION_FAILED_MARKER`:

```typescript
import { REDACTION_FAILED_MARKER } from 'lifecycleion/logger';

REDACTION_FAILED_MARKER; // '***REDACTION FAILED***'
```

Four failure modes, all fail closed:

| What failed                                                                         | Result                                                                                                           |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Your `redactFunction` throws for a key                                              | That key becomes the marker, while every other param redacts normally                                            |
| A value cannot be stringified (a `toString` that throws)                            | Same - that key becomes the marker                                                                               |
| A param cannot be read (a getter that throws)                                       | That key becomes the marker where it sits, while every other param, including the redacted one, redacts normally |
| The `params` object cannot be read at all (a revoked `Proxy`, a throwing `ownKeys`) | **Only** the redacted keys are returned, each set to the marker. Other params are dropped from `redactedParams`  |

The marker is deliberately distinct from an ordinary `***` mask. An operator seeing `***`
concludes redaction worked, so a broken `redactFunction` would otherwise hide itself behind
output that looks successful.

Note that a cyclic `params` object is **not** a failure - it is walked and redacted
normally.

`entry.params` is unaffected by any of this and still carries the raw values, exactly as it
does on the success path. Only `entry.redactedParams` and the rendered `message` are
substituted. A sink that wants to detect the condition should compare against the exported
constant rather than hard-coding the literal.

#### Finding Out _Why_ Redaction Failed

The marker says that redaction failed, never why - the thrown error was discarded. Pass
`onFormatError` to get the cause:

```typescript
const logger = new Logger({
  redactFunction: myRedactor,
  onFormatError: (error, kind, path) => {
    if (kind !== 'redaction') return;

    metrics.increment('redaction.failed', { path });
    // `error.message` is the throw from `myRedactor`; the original is on `error.cause`.
  },
});
```

`kind` is `'redaction'` here and `'render'` when a value refused to be read - see below.

### When a Value Cannot Be Rendered

Rendering degrades rather than failing: a param that refuses to be read becomes a marker
(`[unrenderable]`, `<unrenderable: value>`) and the line still goes out, so one bad param
never costs you the log entry. That is the right trade, and it used to be completely
silent. A `{{user.token}}` that rendered `(null)` because its accessor threw looked
exactly like a typo.

`onFormatError` is where the cause goes:

```ts
const logger = new Logger({
  onFormatError: (error, kind, path) => {
    // kind:  'render' here, 'redaction' when a redactFunction is what threw
    // path:  'user.token' — structural, built from keys the renderer already holds
    // error: the getter's own throw
  },
});
```

Both stages report through the one callback because both come from the same walk over the
same value and address it with the same structural path. The `kind` is the only thing that ever
differed between them.

It fires at most once per kind per operation, and only when a read actually threw, never for the
ordinary degradations like `[circular]` or `[max depth exceeded]`, which never reach a
reporter at all.

With no handler set, **the logger and its sinks write these to `console.error`**, and that
is deliberate rather than lazy: everything they render runs inside a log call, so reporting
anywhere a logger might hear it would be logged, and logging renders. The console is the
only rung that cannot re-enter what is already running.

A **standalone** call to `stringifyValue()` or `errorToString()`, invoked directly by you
with nothing logging, has no such risk, so with no handler it reports on the standard
global `'error'` channel instead and a `registerReportErrorListener()` records it like any
other reported failure.

> **If your own sink, formatter or transformer calls `stringifyValue()`, pass it an
> `onFormatError`.** It runs inside a log call while looking exactly like a standalone one,
> so left to the default it broadcasts, your listener logs it, that logging reaches your
> sink again, and it cycles.

**The cause never reaches the log line.** It comes from your own getter or `toString`,
which were handed the value and are free to put it in the message. A cause written into
the output would travel to every sink past `redactedKeys`. The marker is
library-authored text, the cause goes to one handler that asked for it. `path` is always
structural and never a value.

`errorObject()` formats twice, first the error and then the params, so it can report twice per
kind, for genuinely different failures. Each kind carries its own budget: a value that
fails to redact and a value that fails to render are different failures, and collapsing
them would hide one.

It is handed the failure normalized to an `Error`, the kind, and the path - the
`redactedKeys` entry as you wrote it for a redaction failure (`user.password`, not the leaf
`password`), the renderer's structural path for a render failure. With no handler set it
**writes to `console.error`**, so a broken redactor is loud rather than silent.

Two things about it are deliberate:

- **The logger never reports its own failures on the global `'error'` channel.** Everything
  it renders and redacts runs inside a log call, so reporting there would loop:
  `registerReportErrorListener()` logs what it hears, logging renders a message, rendering
  redacts, and redaction throws again. Each pass is a fresh turn, so no re-entrancy guard
  closes it. The logger therefore always supplies a handler for its own work - yours if you
  set one, a console-writing one if you did not - and `onSinkError` and
  `onEventHandlerError` are console-only for exactly the same reason. A _standalone_
  `stringifyValue()` or `errorToString()`, with nothing logging, has no such risk and does
  use that channel. See the note above.
- **It fires at most once per redaction pass.** A failure is raised per leaf, so a redactor
  that throws unconditionally would otherwise report once for every value inside a named
  container. The first failure names the cause. The markers left in the output show the
  full extent. A pass, not a log call: `errorObject()` redacts twice - once rendering the
  error, once over the params - so it can report twice, for two different failures.

> The error you are handed **may contain the value**. It is your `redactFunction`'s own
> error, and that function was given the value - `throw new Error('cannot mask ' + value)`
> carries it verbatim, and so does a bare `throw value`. The library never puts a value in
> one of these and the `key` is always the entry as you configured it, so this is only ever
> as safe as your own message. Mind that before forwarding it somewhere the log line itself
> would not go.

Don't log from inside it, for the reason above. The same option is available on
`stringifyValue`, `redactValue`, and `errorToString`.

The guarantee is about redaction _failing_: a key that this attempts to redact never keeps its original value. It is not a guarantee that every sensitive value is found. A `redactedKeys` entry that does not resolve to anything in `params` redacts nothing and is skipped, exactly as it always was, so a typo such as `'password.'` silently protects nothing. A dotted entry is treated as ambiguous and both readings are covered: `'user.password'` redacts the nested `params.user.password` _and_ a literal key spelled `'user.password'`, when either exists.

#### Controlling How a Value Is Masked

Your function is handed the key and the value **already stringified** - it is always a
`string`, whatever the original was - and a string is the ordinary thing to hand back. The
other returns are control signals rather than replacement values, ways of saying "you do
the masking":

| return            | meaning                                             |
| ----------------- | --------------------------------------------------- |
| a `string`        | the replacement text, used as-is                    |
| `null`            | use the default masking                             |
| a `number`        | use the default masking at that percent, e.g. `70`  |
| a masking request | the library's masking with your settings, see below |
| `undefined`       | use the default masking, exactly as `null` does     |

```typescript
type RedactFunction = (keyName: string, value: string) => RedactFunctionResult;

type RedactFunctionResult =
  string | number | RedactMaskConfig | null | undefined;
```

A masking request asks for the library's own masking with different settings:

```typescript
interface RedactMaskConfig {
  strategy?: 'string' | 'email' | 'domain'; // default 'string'
  percent?: number; // 0-100 (out-of-range values are clamped), default 90
  maskChar?: string; // single character, default '*' (longer is cut to its first character)
  userPercent?: number; // 'email' only, falls back to percent
  domainPercent?: number; // 'email' only, falls back to percent
}
```

`'email'` keeps the `@` and the dots so an address stays recognizable as one, and `'domain'` does the same for a hostname. The default `'string'` masks a proportion of the whole value, which mangles both.

```typescript
redactFunction: (key) => {
  if (key === 'email') return { strategy: 'email' };
  if (key === 'apiKey') return { percent: 100 };
  return null; // everything else gets the default
};
```

**An object is always read as a masking request, never as a replacement value.** There is
no case where returning an object puts that object in your log line - hand back a string if
that is what you want. So there are only two outcomes for one, and the unusable one is not
an error:

| you return                                  | you get                    |
| ------------------------------------------- | -------------------------- |
| every key names a setting, and there is one | masking with exactly those |
| anything else                               | the default masking        |

The second row covers `{}`, `{ note: 'withheld' }`, a mixed `{ percent: 10, note: 'x' }`,
an array, and a class instance. All of them land exactly where `null` does - masked as
though no `redactFunction` had been given at all. `{}` because every field is optional, so
a config you assemble conditionally can legitimately come out empty. The rest fall back because
honouring the half of an object we recognize is a guess, and the guess is what leaked
before: an unrecognized shape read as a config discarded the caller's value and emitted a
proportional mask of the _original_ in its place.

Landing where `null` does means landing there in full, the rule below on non-string values
included - so an unusable request cannot quietly hand a `URL` back with its query intact.

TypeScript catches most of this for you. Returning an array, a boolean, or an object with
nothing recognizable in it (`{ note: 'x' }`) is a type error, because the return type is
`RedactFunctionResult`. **The one case it does not catch is an object that mixes settings
with unknown keys** - `{ percent: 10, note: 'x' }` compiles, then masks with the defaults
rather than at 10%. Excess-property checking needs a fresh object literal in a directly
annotated position, and the return of a contextually-typed arrow is not one, so the extra
key slips past. Annotate the return if you want the compiler's help:

```typescript
redactFunction: (key): RedactFunctionResult =>
  key === 'apiKey' ? { percent: 10, note: 'x' } : null,
//                                  ^^^^ now an error
```

This is why the runtime falls back to the default rather than honouring the half it
recognizes: a green build is not evidence your config parsed.

The `redactedKeys` list decides _what_ is redacted. This decides _how_, and only for the keys you single out.

Masking never returns the original. A request that would hide nothing - a percent of `0`, a value too short to mask proportionally, an address `email` cannot parse - falls through to `***REDACTED***` instead.

#### What the Default Reveals

The default masks 90% of strings that are at least 8 characters long, so a little survives at each end and the same secret can be correlated across log lines without being readable. A shorter string is replaced with `***REDACTED***` outright, since a proportional mask of something that short hides almost nothing.

Partial masking applies **only to values that were genuinely strings**. A number, an object, a function, a symbol, and `null` or `undefined` all reach the masker as a _produced_ string, and proportional masking keeps its ends - which for a card number is the BIN prefix and last four, and for a `URL` is the query string. Those are replaced with `***REDACTED***`. This is why deferring on an `undefined` value gives `***REDACTED***` rather than a partial mask of the `[undefined]` text your function was shown: the default is handed the original value, not its rendering. Return a masking request that **names a setting** - `{ percent: 60 }` - to opt a specific value back into partial masking, or a number, which is the same request spelled shorter. That is the deliberate choice the opt-in asks for, which is why an object that does not name a setting - `{}` included - does not count as one: it requests the default, and the default is the replacement.

### Tags for Categorization and Filtering

Tags allow you to categorize and filter log entries for better organization and querying:

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true })],
});

// Tag logs for filtering and categorization
logger.info('User logged in', {
  tags: ['auth', 'security'],
  params: { userId: 123 },
});

logger.warn('Slow database query', {
  tags: ['database', 'performance'],
  params: { duration: 1500 },
});

logger.error('Payment processing failed', {
  tags: ['payment', 'critical'],
  params: { orderId: 'ORD-456' },
});

// With service loggers
const apiService = logger.service('API');
apiService.info('Request completed', {
  tags: ['http', 'success'],
  params: { endpoint: '/users', status: 200 },
});
```

#### Use Cases

- **Filtering**: Create custom sinks that route logs based on tags (e.g., send all `['critical']` logs to alerting)
- **Analysis**: Query logs by tag in your log aggregation system
- **Monitoring**: Track specific categories of events
- **Debugging**: Add `['debug']` tags to verbose logs and filter them out in production

#### Notes

- Tags are optional and only included in `LogEntry` when provided
- Empty tag arrays are treated as undefined to keep log entries clean
- Tags work with all log levels and features (params, exitCode, error objects, services)

### Multiple Sinks

```typescript
const arraySink = new ArraySink();
const fileSink = new FileSink({
  logDir: './logs',
  basename: 'app',
  maxSizeMB: 10,
  jsonFormat: true,
  onError: ({ kind, error, target, entry, attempt, disposition }) => {
    console.error(
      `File ${kind} failed on ${target} (attempt ${attempt}):`,
      error.message,
    );
    if (disposition === 'lost') {
      console.error('Entry lost:', entry?.message);
    }
  },
});

const logger = new Logger({
  sinks: [
    new ConsoleSink({ colors: true, timestamps: false }),
    arraySink,
    fileSink,
  ],
});

logger.info('This message goes to console, array, and file');
logger.error('Error logged to all sinks');

// Access array logs
console.log(`ArraySink has ${arraySink.logs.length} logs stored`);
console.log('ArraySink logs:', arraySink.getSnapshotFriendlyLogs());

// Check file sink health
const health = fileSink.getHealth();
if (!health.isHealthy) {
  console.warn(`File sink unhealthy: ${health.consecutiveFailures} failures`);
}

// Flush and get statistics before shutdown
const result = await fileSink.flush();
console.log(
  `Flushed ${result.entriesWritten} entries, ${result.entriesFailed} failed`,
);
```

### Dynamic Sink Management

You can add, remove, and query sinks at runtime:

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink()],
});

// Add a sink dynamically
const fileSink = new FileSink({ logDir: './logs', basename: 'app' });
logger.addSink(fileSink);

// Get all current sinks
const sinks = logger.getSinks(); // Returns readonly array

// Remove a sink (does NOT close it - you must close it yourself)
const removed = logger.removeSink(fileSink);

if (removed) {
  await fileSink.close(); // Close it manually
}

// When logger.close() is called, all sinks are closed and removed
await logger.close();
console.log(logger.closed); // true
console.log(logger.getSinks().length); // 0
```

#### Important Notes

- `removeSink()` does NOT close the sink - you are responsible for closing it if needed
- `logger.close()` closes all sinks AND removes them from the logger
- After `logger.close()`, the logger is marked as closed and will not accept new log messages
- Adding a sink after `logger.close()` does not reopen the logger. Create a new `Logger`
  instance for a fresh start

### Service Loggers

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true, typeLabels: true })],
});

const authService = logger.service('Auth');
const dbService = logger.service('Database');

authService.info('User authentication started');
authService.success('User authenticated successfully');
// Output: [INFO] [Auth] User authenticated successfully

dbService.info('Connecting to database');
dbService.warn('Slow query detected: {{duration}}ms', {
  params: { duration: 1234 },
});
// Output: [WARN] [Database] Slow query detected: 1234ms
```

### Entity Loggers

Entity loggers allow you to create scoped loggers for specific instances within a service. This is particularly useful for:

- **Component lifecycle management**: Track individual component instances
- **Game engines**: Log events for specific game actor objects (doors, NPCs, players)
- **Worker pools**: Monitor individual workers
- **Session management**: Track individual user sessions
- **Connection pools**: Monitor specific connections

```typescript
const logger = new Logger({
  sinks: [new ConsoleSink({ colors: true })],
});

// Component lifecycle example
const lifecycleService = logger.service('component-lifecycle');
lifecycleService.info('Lifecycle manager started');

const audioComponent = lifecycleService.entity('audio-component-123');
audioComponent.info('Component initialized');
audioComponent.success('Audio system ready');
// Output: [component-lifecycle] [audio-component-123] Audio system ready

const renderComponent = lifecycleService.entity('render-component-456');
renderComponent.warn('Low GPU memory');
// Output: [component-lifecycle] [render-component-456] Low GPU memory
```

#### Game Engine Example

```typescript
const scriptingService = logger.service('scripting');

const door = scriptingService.entity('objects/door-main-entrance');
door.info('Door created');
door.info('Player interaction', { params: { action: 'open' } });
// Output: [scripting] [objects/door-main-entrance] Player interaction

const enemy = scriptingService.entity('objects/enemy-goblin-15');
enemy.info('Enemy spawned at {{x}}, {{y}}', {
  params: { x: 100, y: 200 },
});
// Output: [scripting] [objects/enemy-goblin-15] Enemy spawned at 100, 200
```

#### Session Management With UUIDs

Entity names can be anything - including UUIDs for unique session tracking:

```typescript
const sessionManager = logger.service('session-manager');
const session = sessionManager.entity('550e8400-e29b-41d4-a716-446655440000');

session.info('Session created');
session.info('User authenticated', {
  params: { userId: 123 },
  tags: ['auth', 'security'],
});
// Output: [session-manager] [550e8400-e29b-41d4-a716-446655440000] User authenticated
```

#### Worker Pool Example

```typescript
const workerPool = logger.service('worker-pool');
workerPool.info('Pool initialized with 4 workers');

const worker1 = workerPool.entity('worker-1');
worker1.info('Processing task {{taskId}}', { params: { taskId: 'task-abc' } });
worker1.success('Task completed');

const worker2 = workerPool.entity('worker-2');
worker2.error('Task failed', { tags: ['error', 'retry'] });
// Output: [worker-pool] [worker-2] Task failed
```

#### Key Points

- Entity loggers are created from service loggers using `.entity(entityName)`
- The `entityName` can be any string: IDs, UUIDs, hierarchical paths (e.g., `objects/door-main`)
- Entity loggers support all the same methods as service loggers (error, info, warn, etc.)
- The entity name appears in log output: `[service-name] [entity-name] message`
- Entity names are included in the `LogEntry` structure for filtering and analysis

### Setting Exit Callback After Construction

When you have circular dependencies between Logger and other components, use `setBeforeExitCallback()` to set the callback after construction.

**LifecycleManager Integration:** If you're using LifecycleManager, it provides a built-in `enableLoggerExitHook()` method that automatically sets up graceful shutdown on logger exit:

```typescript
import { LifecycleManager } from 'lifecycleion/lifecycle-manager';

const logger = new Logger({ sinks: [new ConsoleSink()] });
const lifecycle = new LifecycleManager({ logger });

// Option 1: Use the built-in helper (recommended)
lifecycle.enableLoggerExitHook();

// Now logger.exit() automatically triggers graceful component shutdown
logger.error('Fatal error', { exitCode: 1 });
// Automatically calls lifecycle.stopAllComponents() before exit
```

If `logger.exit()` is called while LifecycleManager shutdown is already in
progress, that exit call returns `{ action: 'wait' }` instead of exiting immediately. The
first such exit request stays pending and proceeds after shutdown finishes.
Later duplicate exit calls during that same shutdown also return `{ action: 'wait' }`, but
are otherwise ignored.

**Manual Integration:** For custom exit logic or when not using LifecycleManager, use `setBeforeExitCallback()` directly:

```typescript
const logger = new Logger();
const lifecycle = new LifecycleManager({ logger });

// Set custom callback after both are constructed
logger.setBeforeExitCallback(async (exitCode, isFirstExit) => {
  if (isFirstExit) {
    // Custom logic before shutdown
    await saveState();

    // Graceful shutdown
    await lifecycle.stopAllComponents();
  }

  return { action: 'proceed' };
});

// Later, remove the callback if needed
logger.setBeforeExitCallback(undefined);
```

This approach avoids constructor ordering issues and allows components to reference each other without creating circular dependency problems.

**Notes:**

- `isFirstExit` means the first exit request observed by the logger, not necessarily the first exit that has fully completed.
- This method overwrites any existing `beforeExitCallback` (including one set in the Logger constructor).

## Built-In Sinks

### ConsoleSink

Writes logs to the console with optional colors, timestamps, type labels, and log level filtering.

```typescript
import { ConsoleSink, LogLevel } from 'lifecycleion/logger';

new ConsoleSink({
  colors: true, // Enable colors (default: true)
  timestamps: true, // Show timestamps (default: false)
  typeLabels: true, // Show [ERROR], [INFO], etc. (default: false)
  muted: false, // Start muted (default: false)
  minLevel: LogLevel.INFO, // Minimum log level to show (default: INFO)
});
```

#### Log Level Control

Dynamically change what log levels are shown:

```typescript
const consoleSink = new ConsoleSink();

// Default is INFO level - debug logs are filtered
logger.debug('Hidden');

// Enable debug logs
consoleSink.setMinLevel(LogLevel.DEBUG);
logger.debug('Now visible!');

// Set to only show errors
consoleSink.setMinLevel(LogLevel.ERROR);
logger.warn('Hidden');
logger.error('Visible');

// Check current level
const currentLevel = consoleSink.getMinLevel(); // LogLevel.ERROR
```

#### Mute/Unmute Control

You can dynamically mute and unmute console output:

```typescript
const consoleSink = new ConsoleSink();
const logger = new Logger({ sinks: [consoleSink] });

logger.info('This will be logged');

// Mute console output
consoleSink.mute();
logger.info('This will NOT be logged');

// Unmute console output
consoleSink.unmute();
logger.info('This will be logged again');

// Check mute status
console.log(consoleSink.isMuted()); // false
```

This is particularly useful for:

- Temporarily silencing verbose logs during certain operations
- Controlling output in testing environments
- Implementing debug modes that can be toggled at runtime

### ArraySink

Stores logs in memory for testing and debugging.

```typescript
const arraySink = new ArraySink();

logger.info('Test message');

// Access logs
console.log(arraySink.logs);
console.log(arraySink.getSnapshotFriendlyLogs());

// Clear logs
arraySink.clear();
```

#### With Transformer

You can optionally transform log entries when they're written to the ArraySink. This is useful for:

- Keeping test snapshots consistent by removing timestamps
- Normalizing log formats for assertions
- Filtering or redacting sensitive data in tests
- Creating custom output formats

```typescript
const arraySink = new ArraySink({
  transformer: (entry) => {
    // Return false to keep the original entry
    if (entry.serviceName === 'SkipThis') {
      return false;
    }
    // Return a transformed entry
    return {
      ...entry,
      message: `[${entry.serviceName || 'ROOT'}] ${entry.type.toUpperCase()}: ${entry.message}`,
    };
  },
});

const logger = new Logger({ sinks: [arraySink] });
logger.info('Test message');
// Stored message: "[ROOT] INFO: Test message"

const service = logger.service('Auth');
service.error('Login failed');
// Stored message: "[Auth] ERROR: Login failed"
```

### FileSink

Writes logs to files with automatic rotation based on size and date, and log level filtering.

```typescript
import { FileSink, LogLevel } from 'lifecycleion/logger';

new FileSink({
  logDir: './logs', // Directory for log files
  basename: 'app', // Base filename (creates app-2024-01-15.log)
  maxSizeMB: 10, // Rotate at 10MB (default: 10)
  jsonFormat: true, // Use JSON format (default: false)
  maxRetries: 3, // Retry failed writes (default: 3)
  maxQueueSize: 10_000, // Entries held while writes fail (default: 10,000; -1 = unlimited)
  closeTimeoutMS: 30000, // Timeout for close() in ms (default: 30000)
  minLevel: LogLevel.INFO, // Minimum log level to write (default: INFO)
  onError: ({ kind, error, target, entry, attempt, disposition }) => {
    console.error(
      `${kind} failed on ${target} (attempt ${attempt}):`,
      error.message,
    );

    if (disposition === 'lost') {
      console.error('Entry will be lost:', entry?.message);
    }
  },
});
```

#### Log Level Control for Files

Control what gets written to log files:

```typescript
// Create a debug log file that captures everything
const debugSink = new FileSink({
  logDir: './logs',
  basename: 'debug',
  minLevel: LogLevel.DEBUG, // Capture all logs including debug
});

// Create an error-only log file
const errorSink = new FileSink({
  logDir: './logs',
  basename: 'errors',
  minLevel: LogLevel.ERROR, // Only capture errors
});

const logger = new Logger({
  sinks: [debugSink, errorSink],
});

// Dynamically change file sink level
debugSink.setMinLevel(LogLevel.WARN); // Now only warnings and errors
console.log(debugSink.getMinLevel()); // LogLevel.WARN
```

#### File Naming

- Current: `app-2024-01-15.log`
- Rotated: `app-2024-01-15-1705334400123.log`, then
  `app-2024-01-15-1705334400123-1.log` if that millisecond already exists

#### Features

- Automatic rotation on size limit
- Automatic rotation on date change (UTC)
- Asynchronous writes with queue
- Automatic retry on write failures (configurable)
- Health monitoring and statistics
- Redacted params in file output

#### Error Handling & Retry

FileSink automatically retries failed writes up to `maxRetries` times (default: 3). The `onError` callback is invoked for each failure:

> **One failure is never retried.** An entry whose line could not be serialized is
> reported once and dropped. The line is rendered when `write()` is called, so that the
> params cannot change underneath it, and re-rendering later is exactly what that
> prevents - so a second attempt could not come out differently. `onError` receives a
> `FileSinkError` with the message `Failed to format log entry` and the underlying
> serialization error on its `cause`.

```typescript
import { FileSink, type LogEntry } from 'lifecycleion/logger';

const fileSink = new FileSink({
  logDir: './logs',
  basename: 'app',
  maxRetries: 3,
  onError: (failure) => {
    // failure.kind: what failed - 'write', 'format', 'setup', 'close', 'queue_full', ...
    // failure.error: the error itself, always an Error
    // failure.target: the file being written to at the time (rotation changes it)
    // failure.entry: the log entry, when the sink still has it
    // failure.attempt: current attempt number (1-based)
    // failure.disposition: what became of the line - 'retrying', 'lost', 'fallback'
    //   (the sink substituted its own format and carried on) or 'no_entry' (the failure
    //   is not about a particular line)

    console.error(
      `${failure.kind} failed on attempt ${failure.attempt}:`,
      failure.error.message,
    );

    // 'lost' is the only disposition that means write it somewhere else. Reacting to
    // 'retrying' duplicates a line the sink is about to resend, and 'fallback' means the
    // sink substituted its own format and carried on with the line.
    if (failure.disposition === 'lost') {
      console.error('Entry lost:', failure.entry?.message);
      // You could send to a backup sink, alert monitoring, etc.
    }
  },
});
```

#### Health Monitoring

Check the health status of the sink to monitor failures and queue size:

```typescript
const health = fileSink.getHealth();
console.log(health);
// {
//   isHealthy: true,           // false if any consecutive failures
//   queueSize: 0,              // Number of pending writes
//   lastError: undefined,      // Last error that occurred
//   consecutiveFailures: 0,    // Consecutive failed *writes* since the last success
//   isInitialized: true,       // Whether sink is ready
//   droppedEntries: 0          // Lines this sink did not deliver
// }
```

`consecutiveFailures`, and therefore `isHealthy`, counts write failures only in both
queueing sinks. A `'format'` failure never reached the destination and says nothing about
whether the sink can write, so it is reported through `onError` (with `disposition`) and
recorded in `lastError`, but it does not mark the sink unhealthy.

#### Flush Pending Writes

Wait for all pending writes to complete and get statistics:

```typescript
// Default 30-second timeout
const result = await fileSink.flush();
console.log(result);
// {
//   success: true,        // false if any entries failed or timeout
//   entriesWritten: 42,   // Entries written since the last flush
//   entriesFailed: 0,     // Entries this sink lost since the last flush - retries
//                         // exhausted, evicted at maxQueueSize, or abandoned by close()
//   timedOut: false       // true if flush timed out
// }

// Custom timeout (10 seconds)
const result = await fileSink.flush(10000);
if (result.timedOut) {
  console.warn(
    `Flush timed out with ${fileSink.getHealth().queueSize} entries still pending`,
  );
}
```

### NamedPipeSink

Writes logs to a named pipe (FIFO) for log aggregation. Linux/macOS only.

Both queueing sinks, `FileSink` and `NamedPipeSink`, answer a failed write the same way:

- the entry goes back on the queue and is retried up to `maxRetries` (default 3)
- the queue holds up to `maxQueueSize` entries (default 10,000). Pass `-1` to hold
  everything, which is what both did before the default existed)
- over the cap, the **oldest** entry is dropped, counted
  (both sinks report `getHealth().droppedEntries`) and the first
  drop is reported through `onError`
- `getHealth().droppedEntries` means "lines this sink did not deliver": evicted at the
  cap, still queued when `close()` gave up on them, and for `NamedPipeSink` also out of
  retries and failed by a write still in flight when `close()` finished (`FileSink` counts
  its retry drops in its own `flush()` result instead). A close that abandons a queue
  reports it once as a `'close'` failure with `disposition: 'lost'` rather than once per
  entry
- a broken stream is reopened automatically on a later write, so neither sink needs an API
  call to recover
- `minLevel` / `setMinLevel()` / `getMinLevel()` filter by level, defaulting to
  `LogLevel.INFO` as `ConsoleSink` does. A `raw` entry is always written
- entries stay in the sink's own queue until the destination is genuinely writable, so the
  cap and `getHealth().queueSize` mean what they say

For `NamedPipeSink`, "writable" means the FIFO has actually opened, which does not happen
until something opens the read end. Until then `getHealth().isInitialized` is `false` and
lines accumulate under `maxQueueSize` rather than in Node's own unbounded stream buffer.
A `reconnect()` with nothing reading the pipe therefore reports failure rather than claiming
success, and it reports it immediately: the sink asks whether a reader is there with a
non-blocking open before it performs the real one, and gets `ENXIO` straight back when
there is none. That is also what keeps a reader-less FIFO from parking a file-I/O thread
and holding the whole process open. A blocking open of a pipe nobody is reading never
returns and cannot be cancelled. The sink keeps asking on an `unref`'d one-second timer, so
it opens and flushes the queue on its own if a reader turns up later.

`close()` gets one last chance at the pipe. If entries are still queued and the sink has no
open stream, it re-probes for a reader across a short grace window (500ms, polled every
50ms) before giving up, because the process reading a FIFO is often restarted alongside the
one writing to it and a probe at that instant answers "no reader" for a consumer that is
back a moment later. The probe is non-blocking, so a pipe nobody is reading costs a handful
of immediate syscalls and the close returns at the end of the window - never the full
`closeTimeoutMS`. A sink with an empty queue skips the window entirely and closes at once.

`NamedPipeSink.reconnect()` remains available for reconnecting on demand. Because the sink
now reopens on its own, a `reconnect()` that races one of those automatic attempts answers
`already_reconnecting`, meaning the reconnection it would have performed is already under way.

```typescript
import { NamedPipeSink, LogLevel } from 'lifecycleion/logger';

const pipeSink = new NamedPipeSink({
  pipePath: '/tmp/app_logs',
  jsonFormat: true,
  minLevel: LogLevel.INFO, // Minimum log level to write (default: INFO)
  maxRetries: 3, // Retry failed writes (default: 3)
  maxQueueSize: 10_000, // Entries held while the pipe is unusable (default: 10,000; -1 = unlimited)
  closeTimeoutMS: 30000, // Budget shared by all of close(): the init wait, the queue drain, and the final flush (default: 30000)
  onError: ({ kind, error, target }) => {
    console.error(`Pipe ${kind} failed for ${target}:`, error.message);

    // Only reconnect on a failure that means the pipe itself is broken. Not every kind
    // does: 'format' says your `formatter` threw and the default format was used
    // instead, so the line was written and the pipe is healthy — reconnecting on that
    // would tear the sink down and rebuild it once per log call.
    //
    // The sink also reopens on its own, so this is rarely needed; see above.
    if (kind === 'write') {
      void pipeSink.reconnect();
    }
  },
});

logger.info('This goes to console and named pipe (if available)');
```

#### Failure Shape

Every sink reports a failure in the same shape, so one handler serves both:

```typescript
interface SinkFailure {
  // What failed. 'write' means a line is at risk; 'format' means a line could not be
  // formatted — `disposition` says what that cost, since NamedPipeSink substitutes its
  // own default format and carries on, while a line that could not be rendered at all is
  // gone. Either way the pipe itself is healthy: reconnecting here acts on a working sink.
  kind:
    | 'write'
    | 'format'
    | 'close'
    | 'setup'
    | 'queue_full'
    | 'not_found'
    | 'not_a_pipe'
    | 'unsupported_platform';
  error: Error; // always an Error; the original thrown value is on `cause`
  target: string; // the pipe path, or the log file being written at the time
  entry?: LogEntry; // when the sink still has it — never for NamedPipeSink, which
  // deliberately drops it so a stalled queue cannot pin your params
  attempt?: number; // 1-based, for a failure tied to an entry

  // What became of the line. This, not `kind`, is what says whether to write it
  // somewhere else:
  //   'retrying'  — the sink will try again; a fallback write here duplicates it
  //   'lost'      — it will not arrive: out of retries, unrenderable, or dropped at the cap
  //   'fallback'  — the sink substituted its own format and carried on with the line
  //                  (a custom formatter threw); a later failure is reported separately
  //   'no_entry'  — the failure is not about a particular line (open, rotate, close)
  disposition: 'retrying' | 'lost' | 'fallback' | 'no_entry';
}
```

#### Error Handling & Reconnection

When a pipe error occurs (e.g., reader disconnects), the `onError` callback is invoked with a `SinkFailure`. The sink reopens on its own, but `reconnect()` is available to reestablish the connection on demand:

```typescript
import { NamedPipeSink, type ReconnectStatus } from 'lifecycleion/logger';

const pipeSink = new NamedPipeSink({
  pipePath: '/tmp/app_logs',
  onError: async ({ kind, error, target }) => {
    console.error(`Pipe ${kind} failed for ${target}:`, error.message);

    // Only reconnect on a failure that means the pipe itself is broken
    if (kind === 'write') {
      // Wait a bit and try to reconnect
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const status = await pipeSink.reconnect();
      if (status.success) {
        console.log('Reconnected successfully');
      } else if (status.reason === 'already_reconnecting') {
        console.log('Reconnect already in progress');
      } else if (status.reason === 'closed') {
        console.log('Sink is closed; not reconnecting');
      } else {
        console.error('Reconnect failed:', status.error.message);
      }
    }
  },
});

// Manual reconnection with status checking
const status = await pipeSink.reconnect();

// Check if currently reconnecting
if (pipeSink.getHealth().isReconnecting) {
  console.log('Reconnection in progress...');
}
```

**Important:** If `reconnect()` fails, the `onError` handler will be called again with the failure details. When implementing retry logic, consider adding delays and retry limits to avoid rapid repeated failures.

Writes that occur while disconnected are queued and flushed upon successful reconnection.

#### Custom Formatter

You can provide a custom formatter to control exactly what gets written to the pipe:

```typescript
const pipeSink = new NamedPipeSink({
  pipePath: '/tmp/app_logs',
  formatter: (entry) => {
    // Custom JSON structure
    return JSON.stringify({
      ts: entry.timestamp,
      level: entry.type,
      svc: entry.serviceName || 'app',
      msg: entry.message,
      // Include error stack if available
      stack: entry.error instanceof Error ? entry.error.stack : undefined,
    });
  },
});
```

The formatter receives the full `LogEntry` and should return a string (newline is added automatically).

#### Setup

```bash
# Create named pipe
mkfifo /tmp/app_logs

# Read from pipe
cat /tmp/app_logs

# Or use with log aggregation tools
```

## API Reference

### Logger Methods

```typescript
// Log levels
logger.error(message, options?)
logger.warn(message, options?)
logger.notice(message, options?)
logger.success(message, options?)
logger.info(message, options?)
logger.debug(message, options?)  // Debug level (filtered by default)
logger.raw(message, options?)    // No formatting, always shown

// Error objects
logger.errorObject(prefix, error, options?)

// Service loggers
logger.service(name: string): LoggerService

// LoggerService methods (same as Logger but with service name)
service.error(message, options?)
service.warn(message, options?)
service.notice(message, options?)
service.success(message, options?)
service.info(message, options?)
service.debug(message, options?)
service.raw(message, options?)
service.errorObject(prefix, error, options?)
service.entity(entityName: string): LoggerService  // Create entity logger

// Sink management
logger.addSink(sink: LogSink): void
logger.removeSink(sink: LogSink): boolean
logger.getSinks(): readonly LogSink[]

// Lifecycle
logger.exit(code: number)
logger.close(): Promise<void>

// State getters
logger.closed: boolean
logger.didExit: boolean
logger.exitCode: number
logger.isPendingExit: boolean
logger.hasExitedOrPending: boolean

// Global 'error' event listener
logger.registerReportErrorListener(prefix?, options?)
logger.unregisterReportErrorListener()
logger.isReportErrorListenerRegistered(): boolean
logger.isReportErrorAvailable(): boolean

// Set/update exit callback (useful for circular dependencies)
logger.setBeforeExitCallback(callback?)
```

### Options for Log Methods

```typescript
interface LogOptions {
  exitCode?: number; // Exit process with specified code after logging
  params?: Record<string, unknown>; // Template parameters
  tags?: string[]; // Tags for categorizing/filtering logs
  redactedKeys?: string[]; // Keys to redact in params (per-log basis)
}
```

### Logger Configuration

```typescript
interface LoggerOptions {
  sinks?: LogSink[]; // Output destinations
  redactFunction?: (keyName, value: string) => RedactFunctionResult; // Custom redaction (default: masks with asterisks using datamask)
  onFormatError?: (error, kind: 'redaction' | 'render', path) => void; // Redaction or rendering failed (default: console.error)
  callProcessExit?: boolean; // Actually call process.exit() (default: true, disable for tests/browser)
  beforeExitCallback?: (
    code,
    isFirst,
  ) => BeforeExitResult | Promise<BeforeExitResult>; // Hook called before exit, returns { action: 'proceed' | 'wait' }
  onSinkError?: (
    error: Error,
    context: 'write' | 'close',
    sink: LogSink,
  ) => void; // Handle sink errors (default: console.error)
  onEventHandlerError?: (error: Error, event: string) => void; // Handle failures of this logger's own event handlers (default: console.error)
}

interface BeforeExitResult {
  action: 'proceed' | 'wait'; // 'proceed' to continue exit, 'wait' to prevent exit (e.g., shutdown in progress)
}
```

#### Sink Error Handling

By default, when a sink fails to write or close, the error is logged to `console.error`. You can provide a custom error handler to intercept these errors:

```typescript
const logger = new Logger({
  sinks: [new FileSink({ logDir: './logs', basename: 'app' })],
  onSinkError: (error, context, sink) => {
    // error: The error that occurred
    // context: Either 'write' or 'close'
    // sink: The sink that failed

    if (context === 'write') {
      console.error('Failed to write to sink:', error.message);
      // Optionally remove the failing sink
      logger.removeSink(sink);
    } else {
      console.error('Failed to close sink:', error.message);
    }
  },
});
```

##### Where Errors Go When the Logger Cannot Log Them

Some failures cannot be written to the sinks because the sinks are either the thing that failed or the thing that would fail again. Those go to a callback you provide, or to `console.error` when you provide none. They never go back into the logger:

| Failure                                                                                         | Goes to                                                              |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| A sink throws on `write` or `close`                                                             | `onSinkError`, or `console.error` if you did not provide one         |
| Your `onSinkError` itself throws                                                                | `console.error`                                                      |
| A `'logger'` event handler of this logger throws or rejects                                     | `onEventHandlerError`, or `console.error` if you did not provide one |
| Your `onEventHandlerError` itself throws                                                        | `console.error`                                                      |
| Your `redactFunction` throws, or a value cannot be read to redact it                            | `onFormatError` with `kind: 'redaction'`, or `console.error`         |
| A value refuses to be read or turned into text                                                  | `onFormatError` with `kind: 'render'`, or `console.error`            |
| Your `onFormatError` itself throws                                                              | `console.error`                                                      |
| A new error is reported while `registerReportErrorListener()` is still logging the previous one | `console.error`                                                      |

The third and fifth rows are the ones that would otherwise loop. Logging emits a `'logger'` event, so reporting that handler's failure through the logger would emit again. Logging also renders a message, which redacts, so reporting a redaction failure through the logger would redact again and throw again. Neither loop is a stack overflow that a re-entrancy guard could catch - each pass is a fresh turn - which is why both get a callback that cannot re-enter the logger. It gets its own callback rather than `onSinkError` because no sink was involved, and there would be nothing honest to pass as that callback's `sink` argument:

```typescript
const logger = new Logger({
  sinks: [new FileSink({ logDir: './logs', basename: 'app' })],
  onEventHandlerError: (error, event) => {
    // error: the wrapped failure, with the handler's original error on `error.cause`
    // event: the event whose handler failed, e.g. 'logger'
    metrics.increment('logger.handler_failure');
  },
});
```

Everything else, including errors reported by other Lifecycleion modules and by your own code using [the reporting pattern](./safe-handle-callback.md#the-reporting-pattern), reaches your sinks normally through `registerReportErrorListener()`.

> Do not call this logger's own log methods from inside `onSinkError`, `onEventHandlerError`, or `onFormatError`. If the sink is what failed, logging from the handler asks the same sink to write again. Logging from `onEventHandlerError` re-emits the very event whose handler just failed. Logging from `onFormatError` runs the same redaction or rendering that just threw.

> **Do not read `.message` directly inside these callbacks.** Both are handed a real `Error`, but the value a sink or handler threw is not yours, and `message` is an ordinary property that a subclass or a `Proxy` can turn into an accessor that throws. Reading it raises a second failure from inside the callback that was handling the first.

Use [`describeError`](./to-error.md#describeerror) instead, which normalizes and reads in one guarded step and never throws:

```typescript
import { describeError } from 'lifecycleion/to-error';

onSinkError: (error, context, sink) => {
  metrics.increment('logger.sink_failure', { reason: describeError(error) });
};
```

The callbacks are handed differently shaped errors, which matters if you log or group on them:

| Callback              | Receives                                                                                                                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onSinkError`         | The sink's own error, unwrapped. `cause` is set only when the sink threw a non-`Error` value                                                                                                                                                                                                   |
| `onEventHandlerError` | A **wrapped** error, `Error in a logger event handler for <event>: <message>`, with the handler's original failure on `cause`                                                                                                                                                                  |
| `onFormatError`       | The `redactFunction`'s, getter's or `toString`'s own error, normalized. `cause` is set only when it threw a non-`Error` value. The second argument is the kind, the third the path - the `redactedKeys` entry as you wrote it for `'redaction'`, the renderer's structural path for `'render'` |

This allows you to:

- Log errors to a monitoring service
- Remove failing sinks from the logger
- Implement custom retry logic
- Switch to backup sinks
- Track failure statistics

#### Exit Behavior

When a log includes an `exitCode`, the logger will:

1. Call `beforeExitCallback` (if provided) with the exit code
   - Callback must return `{ action: 'proceed' }` to continue with exit
   - Or return `{ action: 'wait' }` to prevent exit (e.g., shutdown already in progress)
   - **IMPORTANT:** If the callback throws an error or rejects, the exit process proceeds automatically to prevent the application from hanging
   - Errors from the callback are reported on the global `'error'` event channel when the required browser-style event primitives are available
   - Design your callback to handle errors internally if you need guaranteed cleanup
2. Set `logger.didExit = true` and `logger.exitCode = <code>`
3. Close all sinks
4. Call `process.exit(code)` **only if** `callProcessExit: true` (default)

**Exit Code Validation:** The `exitCode` must be a valid number. Non-numeric values are silently ignored and will not trigger process exit.

This means `callProcessExit: false` creates a "simulated exit" - the logger goes through the exit process (callbacks, state changes, closing sinks) but doesn't actually terminate the process. During a simulated exit, the logger still executes its entire exit sequence:

- **Callback Hook Execution**: Calls the registered `beforeExitCallback` (e.g. to shut down component lifecycles).
- **State Property Updates**: Sets `logger.didExit = true` and updates `logger.exitCode` (enabling clean unit/integration test assertions).
- **Sink Cleanup**: Closes all registered sinks cleanly.
- **Event Signaling**: Emits `'logger'` events (`exit-called` and `exit-process`), allowing external code to react to the exit intent.

This is useful for:

- **Testing**: Verify exit behavior without killing your test runner
- **Browser environments**: No `process.exit()` available
- **Custom exit handling**: Use `beforeExitCallback` to implement your own exit logic. See [docs/lifecycle-manager.md](lifecycle-manager.md#process-exit-design--rationale) for details on how `LifecycleManager` hooks into this mechanism to cleanly orchestrate component shutdowns.

## Capturing Reported Errors

Lifecycleion catches errors thrown by callbacks you hand it, including event handlers, `onChange`, and lifecycle hooks, so one bad callback cannot break an operation. Those errors are reported on the standard global `'error'` event channel rather than rethrown, which means that without a listener they are only written to the console.

`registerReportErrorListener()` attaches that listener and routes what it hears into this logger's sinks:

```typescript
const result = logger.registerReportErrorListener();
// 'success' | 'already_registered' | 'closed' | 'not_available'
```

One call covers the whole process: the listener sits on `globalThis`, so it captures reports from every Lifecycleion module in the application, no per-instance wiring. Each error is logged through `errorObject(prefix, error)` and also emitted as a `'logger'` event with `{ eventType: 'uncaughtException', error }`.

**Parameters:**

- `prefix` - Prefix for the logged message. Default `'Uncaught exception'`.
- `options.preventDefault` - Whether to cancel the event. Default `true`.

**About `preventDefault`:** the listener claims each error by default, which stops `safe-handle-callback` from also writing it to the console and, in browsers, suppresses the browser's own console line. Since the error is already going to your sinks, that avoids logging it twice. Pass `preventDefault: false` to log to the sinks _and_ leave the error for the console:

```typescript
logger.registerReportErrorListener('Uncaught exception', {
  preventDefault: false,
});
```

**Scope:** this listens on the platform `'error'` channel, so in a browser it also receives genuine uncaught script errors, not just Lifecycleion's own callback reports. Those can arrive with no `error` object. The event's `message` is logged instead. With the default `preventDefault: true`, the console line for that traffic is suppressed as well.

Resource-load failures (a broken `<img>` or `<script>` tag) are **not** included by default. Those `error` events fire on the element and do not bubble, so a global listener registered without capture never sees them. They behave exactly as they would with no logger involved: the element's own handlers run and the browser reports the failed request in the console.

Set `captureResourceErrors: true` to take them as well:

```typescript
logger.registerReportErrorListener('Uncaught exception', {
  captureResourceErrors: true,
});
```

The listener then registers with capture, so it sees element `error` events on the way down. A resource failure is a plain `Event` with no `error` and usually no `message`, so it is described from the failing element instead, for example, `Failed to load IMG: /logo.png`, and tagged `'resource'`.

Capture is a wide net: a listener registered this way sees **every** `error` event dispatched anywhere in the document, not just failed loads. Classification is therefore deliberately narrow, and an event is only treated as a resource failure when it is **trusted** (dispatched by the browser itself, never by application code), is a plain `Event` (not an `ErrorEvent` or a `CustomEvent`), and has a target element naming a resource in `src`, `href`, `currentSrc`, or `data` (the last for `<object>`, which names its resource nowhere else). Anything else is left alone. A component that dispatches its own `error` event and branches on the result keeps its answer, rather than finding the event cancelled by a logger. Because `dispatchEvent()` always produces an untrusted event, a wrapper element re-announcing a failure with `this.dispatchEvent(new Event('error'))` stays the application's own signal.

Expect volume: every broken asset becomes a log entry, and on a page with flaky third-party resources that adds up. **Filter them in your sinks**. The tag is there so a custom sink can route them somewhere quieter or drop them entirely:

```typescript
class AppSink implements LogSink {
  write(entry: LogEntry): void {
    if (entry.tags?.includes('resource')) {
      return; // or send to a separate, lower-priority destination
    }

    // ...
  }
}
```

Lifecycleion's own reports and uncaught script errors are untagged, so filtering on `'resource'` never drops them. On Node and Bun this option does nothing: there is no document, so nothing dispatches element events there.

**Shadow DOM is not covered.** A resource `error` event is dispatched with `composed: false`, so its propagation path stops at the shadow boundary and never reaches `globalThis`. Capture does not help because the global object is not on the path at all. Failed loads inside a shadow root are therefore invisible to this option and to any other global listener. Nothing can widen the path from outside. Seeing them means a listener inside that shadow root, which a closed root does not allow at all.

This does not affect an ordinary React, Vue, Angular, or Svelte application: those render into the light DOM, where every failed load is on the normal path. It applies only where a shadow root is genuinely in play, such as with third-party web components or when mounting your own app into one, and then only to resources inside that root. The rest of the page still reports normally.

**Closing:** `close()` unregisters the listener. A closed logger's log methods are no-ops, so a listener left registered would claim reports it cannot record and, by cancelling them, stop them from reaching the console either. A logger cannot be reopened, so registering after `close()` returns `'closed'` and attaches nothing rather than leaving an inert listener on `globalThis`.

**Feedback loops:** logging emits a `'logger'` event, and a failing event handler is normally reported on this same channel, so a `'logger'` handler that fails would feed itself forever. `Logger` therefore reports failures of its own `'logger'` handlers to the `onEventHandlerError` option, or to `console.error` when there is none, rather than to the `'error'` channel. Handlers on other Lifecycleion emitters are unaffected and still reach your sinks. As a backstop, the listener also ignores any report that arrives while it is still logging the previous one, such as a sink that dispatches an error of its own mid-write, so that error goes to the console instead of back through the sinks.

Teardown and inspection:

```typescript
logger.unregisterReportErrorListener(); // 'success' | 'not_registered' | 'not_available'
logger.isReportErrorListenerRegistered(); // boolean
logger.isReportErrorAvailable(); // boolean — are the global event primitives present?
```

`'not_available'` from `registerReportErrorListener` means the global object exposes neither native nor polyfilled event methods. From `unregisterReportErrorListener` it means the removal itself was refused - the methods are there, but `removeEventListener` threw - so **the listener is still attached and still receiving**, and the registration is deliberately kept so that a later `register` does not add a second one. `isReportErrorListenerRegistered()` agrees with it and still answers `true`. See [global-event-target](./global-event-target.md). On Node.js, Lifecycleion installs them for you.

## Where Failures Go

The logger has three callbacks for things that go wrong while logging. All three behave
identically: **your handler if you set one, `console.error` if you did not, and
`console.error` again if yours throws.** Nothing ever escapes into your `logger.info()`
call, and nothing is ever silently dropped.

| Callback              | Fires when                                                        |
| --------------------- | ----------------------------------------------------------------- |
| `onSinkError`         | a sink's `write()` or `close()` throws or rejects                 |
| `onEventHandlerError` | one of your `logger.on('logger', …)` handlers throws or rejects   |
| `onFormatError`       | a value could not be formatted - see `kind` for which stage threw |

`onFormatError`'s `kind` is `'redaction'` when your `redactFunction` threw or
`redactedKeys` was unusable, and `'render'` when a value refused to be read or turned into
text. They are one callback rather than two because both come from the same walk over the
same value and address it with the same structural path.

`FileSink` and `NamedPipeSink` have their own `onError` with the same three rungs, and
`ArraySink` has `onFormatError` (which also reports a throwing `transformer`, under
`kind: 'transform'`), while `ConsoleSink` has none, since it does not queue or
transform anything. See [Built-In Sinks](#built-in-sinks).

### Why the Fall-Back Is the Console

Because it is the only rung that cannot re-enter what just failed. Everything the logger
renders, redacts and writes happens _inside_ a log call, so reporting a failure anywhere a
logger might hear it would be logged, and logging renders, redacts and writes to sinks,
which is what failed a moment ago. Each pass is a fresh turn, so no re-entrancy guard
closes that loop.

### Never Seeing a Console Line

Set all three. Once every channel has a handler, the library's console rung is unreachable
from the logger:

```ts
const report = (what: string) => (error: Error, subject: string) =>
  metrics.increment('lifecycleion_failure', {
    what,
    subject,
    message: error.message,
  });

const logger = new Logger({
  sinks: [/* … */],
  onSinkError: (error, context, sink) => report('sink')(error, context),
  onEventHandlerError: report('event-handler'),
  onFormatError: (error, kind, path) => report(kind)(error, path),
});
```

Two caveats worth knowing:

- **A handler that throws still reaches the console**, reporting both the original failure
  and your handler's own throw. That is deliberate: a handler that just failed is not a
  reason to reach for a louder channel, and both facts matter. One says the channel you
  chose is broken, the other is what you needed to know.
- **`ConsoleSink` is unaffected.** It writes to the console because that is its job. These
  callbacks are about failures, not output.

### Standalone Renderers Are Different

`stringifyValue()`, `errorToString()`, `serializeError()` and `CurlyBrackets()` can be
called with no logger involved at all. With no handler, those report on the standard global `'error'` channel
instead, so `registerReportErrorListener()` picks them up and logs them properly, falling
back to the console only when nothing claims the event. There is no loop to worry about
when nothing is logging.

> **If your own sink, formatter or transformer calls one of them, pass it a handler.** It
> runs inside a log call while looking exactly like a standalone one, so left to the default
> it broadcasts, your listener logs it, and that logging reaches your sink again.

## EventEmitter Integration

```typescript
const logger = new Logger({ sinks: [...] });

// Listen to log events
logger.on('logger', (event) => {
  switch (event.eventType) {
    case 'log':
      console.log(`[${event.logType}] ${event.message}`);
      break;
    case 'exit-called':
      console.log(`Exit requested: ${event.code}`);
      break;
    case 'exit-process':
      console.log(`Process exiting: ${event.code}`);
      break;
    case 'uncaughtException':
      console.error('Uncaught exception:', event.error);
      break;
    case 'close':
      console.log('Logger closed');
      break;
  }
});

logger.info('This will trigger an event');
logger.error('Error event will be emitted');
```

### Exit Event Phases

When the logger handles an exit, it emits two distinct events representing different lifecycle phases:

- **`exit-called`**: Emitted **immediately** when `logger.exit()` is called, _before_ any registered `beforeExitCallback` hooks (like component shutdowns) run. It indicates the exit sequence has been initiated, and includes an `isFirstExit: boolean` flag to track redundant exit calls.
- **`exit-process`**: Emitted **after** all registered exit callbacks have settled and finished their work, just before the logger starts closing its sinks and optionally terminates the process (`callProcessExit: true`). It indicates the logger has finished pre-exit callback work and is proceeding into final sink cleanup.

## Custom Sinks

Create your own sink by implementing the `LogSink` interface:

```typescript
import { LogSink, LogEntry } from 'lifecycleion/logger';

class DatabaseSink implements LogSink {
  async write(entry: LogEntry): Promise<void> {
    await db.insert('logs', {
      timestamp: entry.timestamp,
      type: entry.type,
      message: entry.message,
      params: entry.redactedParams || entry.params, // Use redacted params for storage
      redactedKeys: entry.redactedKeys, // Track which fields were redacted
    });
  }

  async close(): Promise<void> {
    await db.disconnect();
  }
}

// Custom metrics sink example
class CustomMetricsSink implements LogSink {
  private errorCount = 0;
  private infoCount = 0;

  write(entry: LogEntry): void {
    if (entry.type === 'error') {
      this.errorCount++;
    } else if (entry.type === 'info') {
      this.infoCount++;
    }
  }

  getMetrics() {
    return {
      errors: this.errorCount,
      infos: this.infoCount,
    };
  }
}

// Use it
const logger = new Logger({
  sinks: [new DatabaseSink()],
});
```

## LogEntry Structure

Each sink receives a complete `LogEntry`:

```typescript
interface LogEntry {
  timestamp: number; // Unix timestamp in ms
  type: LogType; // 'error' | 'warn' | 'notice' | 'success' | 'info' | 'debug' | 'raw'
  serviceName?: string; // Service name (only present when using service logger)
  entityName?: string; // Entity identifier (only present when using entity logger)
  template: string; // Original template: "User {{userID}} logged in"
  message: string; // Computed message: "User 456 logged in"
  params?: Record<string, unknown>; // Raw params: { userID: 456, password: 'secret' }
  redactedParams?: Record<string, unknown>; // Present when redaction is configured: { userID: 456, password: '***' }
  redactedKeys?: string[]; // List of keys that were redacted: ['password', 'user.apiKey']
  error?: unknown; // Original error object from errorObject() calls
  exitCode?: number; // Exit code if this log triggers a process exit
  tags?: string[]; // Optional tags for categorizing/filtering logs: ['auth', 'security']
}
```

### Important Notes

- **`message`**: Contains the interpolated template. When `redactedKeys` are configured, the message is rendered from `redactedParams`. Otherwise it is rendered from the original `params`.
- **`params`**: Raw unredacted parameters - the caller's own object, by reference. **This is an escape hatch, and it holds the secrets.** See below.
- **`redactedParams`**: Parameters with sensitive values masked according to `redactedKeys`. Present only when redaction is configured. **Not an independent copy** - see below.
- **`redactedKeys`**: List of parameter keys that were redacted (useful for auditing and metadata)

### Security Note

If you configure `redactedKeys`, the `message` field is rendered from the redacted values. This means templated sensitive fields such as `{{password}}` are masked in the message as well as in `redactedParams`. Without `redactedKeys`, the message is rendered from the original `params`.

**`entry.params` is never redacted.** Every entry carries both views. The `params` value is handed to sinks exactly as the caller passed it, secrets and all, so a sink that genuinely needs the real values, such as an in-process metric or a local debugger, can have them. Redaction masks `redactedParams` and the `message`, not `params`.

That makes it the one field a sink must be deliberate about. **A sink that writes anywhere the values could outlive the process, such as a file, a socket, a pipe, or a third-party service, should not read `params` directly:**

```ts
const safe = entry.redactedParams ?? entry.params;
```

`redactedParams` is `undefined` when no `redactedKeys` were configured, which is why the fallback is needed. When redaction _was_ configured, this always prefers the masked view. Reaching for `entry.params` on its own is how a redacted log line still ends up shipping the secret.

`redactedParams` differs from `params` only where a value was masked. Everything else is the value the caller passed by reference. A `Date` is still that `Date`, and an `Error` still carries its `message` and `stack`, so a structured sink can read it without losing fidelity to redaction.

**That reference sharing is literal, and it is not a copy or a snapshot.** The bag itself is always a fresh object, which keeps what a sink can read equal to what redaction walked. However, copies below it are built only along the branches that lead to a mask, so every value the walk did not touch is the caller's own. Two rules follow for a sink or an `arrayLogTransformer`:

- **Do not write into `redactedParams`.** Adding or replacing a top-level field is safe, since that bag belongs to the entry, but normalizing a value _in place_ writes into the caller's own object. Build your own instead, using `{ ...entry.redactedParams }` for a shallow change or a deep copy for anything below the top level.
- **Read it before you `await`.** An unmasked subtree reflects whatever the caller's object holds at the moment you read it, not at the moment the entry was created, and reusing one params object across log calls is ordinary. Serialize synchronously, or take your own copy first. `FileSink` and `NamedPipeSink` both do the former. They render the line in `write()` and queue the string, not the entry.

The masked values themselves are fresh strings and are affected by neither.

## Testing

```typescript
const { logger, arraySink } = Logger.createTestOptimizedLogger();

logger.info('Test message', {
  params: { password: 'secret' },
  redactedKeys: ['password'],
});

expect(arraySink.logs.length).toBe(1);
expect(arraySink.logs[0].message).toBe('Test message');
expect(arraySink.logs[0].redactedParams?.password).not.toBe('secret');
```

### With Transformer for Consistent Test Snapshots

Transformers are useful for normalizing log output in tests by stripping timestamps or other dynamic values:

```typescript
const { logger, arraySink } = Logger.createTestOptimizedLogger({
  arrayLogTransformer: (entry) => {
    // Normalize timestamps for consistent snapshots
    // Makes test snapshots consistent regardless of when they run
    return { ...entry, timestamp: 0 };
  },
});

logger.info('User logged in');

expect(arraySink.getSnapshotFriendlyLogs()).toMatchSnapshot();
// Snapshot: ["info: User logged in"]
```

### With Console Sink for Debugging Tests

Sometimes you want to see console output while debugging tests:

```typescript
const { logger, arraySink, consoleSink } = Logger.createTestOptimizedLogger({
  includeConsoleSink: true,
  muteConsole: false, // Unmuted for debugging (default is muted)
});

logger.info('This appears in console AND arraySink');

// Later, mute console to reduce noise
consoleSink!.mute();
logger.info('This only appears in arraySink');

expect(arraySink.logs.length).toBe(2);
```

## Frontend/Browser Usage

For frontend applications, use the `createFrontendOptimizedLogger` factory method which is pre-configured for browser environments:

```typescript
const { logger, consoleSink } = Logger.createFrontendOptimizedLogger();

logger.info('Application started');
logger.error('Failed to fetch data');

// Mute console during bulk operations
consoleSink.mute();
for (let i = 0; i < 1000; i++) {
  logger.info(`Processing item ${i}`);
}
consoleSink.unmute();
```

### Features

- Pre-configured with `ConsoleSink` for browser devtools output
- Process exit disabled (browsers don't have `process.exit`)
- Can add additional sinks if needed
- Mute/unmute console dynamically

### With Additional Sinks and Redaction

```typescript
const { logger, consoleSink } = Logger.createFrontendOptimizedLogger({
  sinks: [
    new ArraySink(), // For capturing logs in-app
    // Could add custom sinks for remote logging services
  ],
  muteConsole: false, // Start with console enabled (default)
});

logger.info('User {{username}} logged in', {
  params: {
    username: 'alice',
    sessionToken: 'secret123', // Will be redacted
  },
  redactedKeys: ['sessionToken'],
});

// Mute console in production, unmute in development.
// lifecycleion/dev-mode provides a runtime-settable flag that works across
// bundlers and SSR — recommended over process.env.NODE_ENV directly:
import { getDevMode } from 'lifecycleion/dev-mode';

if (!getDevMode()) {
  consoleSink.mute();
}

// Or manually via NODE_ENV if you prefer:
// if (process.env.NODE_ENV === 'production') consoleSink.mute();
```

## Architecture Overview

### Sink-Based Design

The logger uses a flexible sink-based architecture where logs flow to multiple destinations:

```typescript
const logger = new Logger({
  sinks: [
    new ConsoleSink({ colors: true, timestamps: true }), // Console output
    new ArraySink(), // In-memory storage
    new FileSink({ logDir: './logs', basename: 'app' }), // File storage
    new NamedPipeSink({ pipePath: '/tmp/logs' }), // Named pipe
  ],
});
```

Each sink receives the complete `LogEntry` and can process it independently. This allows you to:

- Write to multiple destinations simultaneously
- Create custom sinks for specific needs
- Configure each sink independently
- Add/remove sinks without changing your code
