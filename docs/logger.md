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
  - [Template Strings with Parameters](#template-strings-with-parameters)
    - [Nested Object Support](#nested-object-support)
  - [Redaction of Sensitive Data](#redaction-of-sensitive-data)
    - [Nested Object Redaction](#nested-object-redaction)
    - [Custom Redaction Function](#custom-redaction-function)
  - [Tags for Categorization and Filtering](#tags-for-categorization-and-filtering)
    - [Use Cases](#use-cases)
    - [Notes](#notes)
  - [Multiple Sinks](#multiple-sinks)
  - [Dynamic Sink Management](#dynamic-sink-management)
    - [Important Notes](#important-notes)
  - [Service Loggers](#service-loggers)
  - [Entity Loggers](#entity-loggers)
    - [Game Engine Example](#game-engine-example)
    - [Session Management with UUIDs](#session-management-with-uuids)
    - [Worker Pool Example](#worker-pool-example)
    - [Key Points](#key-points)
  - [Setting Exit Callback After Construction](#setting-exit-callback-after-construction)
- [Built-in Sinks](#built-in-sinks)
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
    - [Error Types](#error-types)
    - [Error Handling & Reconnection](#error-handling--reconnection)
    - [Custom Formatter](#custom-formatter)
    - [Setup](#setup)
- [API Reference](#api-reference)
  - [Logger Methods](#logger-methods)
  - [Options for Log Methods](#options-for-log-methods)
  - [Logger Configuration](#logger-configuration)
    - [Sink Error Handling](#sink-error-handling)
    - [Exit Behavior](#exit-behavior)
- [EventEmitter Integration](#eventemitter-integration)
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
- **TypeScript**: Fully typed with comprehensive interfaces

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
- The `exitCode` must be a valid number; non-numeric values are ignored and won't trigger exit

### Template Strings with Parameters

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

Templates support nested object properties using dot notation:

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

**Note:** Array indexing (e.g., `{{users[0].name}}`) is not supported. Only object property paths using dot notation are supported.

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

Redaction supports nested object properties using dot notation, just like templates:

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
// user.password → '********'
// credentials.apiKey → '***************'
// personalInfo.ssn → '***********'
```

**Note:** Array indexing (e.g., `users[0].password`) is not supported. Only object property paths using dot notation are supported.

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
  onError: (error, entry, attempt, willRetry) => {
    console.error(`File write failed (attempt ${attempt}):`, error.message);
    if (!willRetry) {
      console.error('Entry lost:', entry.message);
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
- You can still add new sinks after `logger.close()` if needed for a fresh start

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

#### Session Management with UUIDs

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

**Note:** This method overwrites any existing `beforeExitCallback` (including one set in the Logger constructor).

## Built-in Sinks

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
  closeTimeoutMS: 30000, // Timeout for close() in ms (default: 30000)
  minLevel: LogLevel.INFO, // Minimum log level to write (default: INFO)
  onError: (error, entry, attempt, willRetry) => {
    console.error(
      `Write failed (attempt ${attempt}/${maxRetries}):`,
      error.message,
    );

    if (!willRetry) {
      console.error('Entry will be lost:', entry.message);
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
- Rotated: `app-2024-01-15-1705334400.log`

#### Features

- Automatic rotation on size limit
- Automatic rotation on date change (UTC)
- Asynchronous writes with queue
- Automatic retry on write failures (configurable)
- Health monitoring and statistics
- Redacted params in file output

#### Error Handling & Retry

FileSink automatically retries failed writes up to `maxRetries` times (default: 3). The `onError` callback is invoked for each failure:

```typescript
import { FileSink, type LogEntry } from 'lifecycleion/logger';

const fileSink = new FileSink({
  logDir: './logs',
  basename: 'app',
  maxRetries: 3,
  onError: (error, entry, attempt, willRetry) => {
    // error: The error that occurred
    // entry: The log entry that failed to write
    // attempt: Current attempt number (1-based)
    // willRetry: Whether this entry will be retried

    console.error(`Write failed on attempt ${attempt}:`, error.message);

    if (!willRetry) {
      // Entry has exceeded max retries and will be lost
      console.error('Entry lost after max retries:', entry.message);
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
//   consecutiveFailures: 0,    // Number of consecutive failures
//   isInitialized: true        // Whether sink is ready
// }
```

#### Flush Pending Writes

Wait for all pending writes to complete and get statistics:

```typescript
// Default 30-second timeout
const result = await fileSink.flush();
console.log(result);
// {
//   success: true,        // false if any entries failed or timeout
//   entriesWritten: 42,   // Number of entries successfully written
//   entriesFailed: 0,     // Number of entries that failed after retries
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

```typescript
import { NamedPipeSink, PipeErrorType } from 'lifecycleion/logger';

const pipeSink = new NamedPipeSink({
  pipePath: '/tmp/app_logs',
  jsonFormat: true,
  closeTimeoutMS: 30000, // Timeout for close() in ms (default: 30000)
  onError: (errorType, err, pipePath) => {
    console.error(`Pipe error (${errorType}) for ${pipePath}:`, err.message);
    // Optionally attempt to reconnect
    // In production, consider adding delays, retry limits, and backoff strategies
    pipeSink.reconnect();
  },
});

logger.info('This goes to console and named pipe (if available)');
```

#### Error Types

The `onError` callback receives a `PipeErrorType` enum indicating what kind of error occurred:

```typescript
enum PipeErrorType {
  WRITE = 'write',
  CLOSE = 'close',
  NOT_FOUND = 'not_found',
  NOT_A_PIPE = 'not_a_pipe',
  PERMISSION = 'permission',
  UNSUPPORTED_PLATFORM = 'unsupported_platform',
}
```

#### Error Handling & Reconnection

When a pipe error occurs (e.g., reader disconnects), the `onError` callback is invoked with the error type, error object, and pipe path. You can use the `reconnect()` method to attempt to reestablish the connection:

```typescript
import {
  NamedPipeSink,
  PipeErrorType,
  ReconnectStatus,
} from 'lifecycleion/logger';

const pipeSink = new NamedPipeSink({
  pipePath: '/tmp/app_logs',
  onError: async (errorType, err, pipePath) => {
    console.error(`Pipe error (${errorType}) for ${pipePath}:`, err.message);

    // Only reconnect on certain error types
    if (errorType === PipeErrorType.WRITE) {
      // Wait a bit and try to reconnect
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const status = await pipeSink.reconnect();
      if (status.success) {
        console.log('Reconnected successfully');
      } else if (status.reason === 'already_reconnecting') {
        console.log('Reconnect already in progress');
      } else {
        console.error('Reconnect failed:', status.error.message);
      }
    }
  },
});

// Manual reconnection with status checking
const status = await pipeSink.reconnect();

// Check if currently reconnecting
if (pipeSink.isReconnecting) {
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

// Report error listener
logger.registerReportErrorListener(prefix?)
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
  redactFunction?: (keyName, value) => unknown; // Custom redaction (default: masks with asterisks using datamask)
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
   - Errors from the callback are reported via the global `reportError` event
   - Design your callback to handle errors internally if you need guaranteed cleanup
2. Set `logger.didExit = true` and `logger.exitCode = <code>`
3. Close all sinks
4. Call `process.exit(code)` **only if** `callProcessExit: true` (default)

**Exit Code Validation:** The `exitCode` must be a valid number. Non-numeric values are silently ignored and will not trigger process exit.

This means `callProcessExit: false` creates a "simulated exit" - the logger goes through the exit process (callbacks, state changes, closing sinks) but doesn't actually terminate the process. This is useful for:

- **Testing**: Verify exit behavior without killing your test runner
- **Browser environments**: No `process.exit()` available
- **Custom exit handling**: Use `beforeExitCallback` to implement your own exit logic

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
  redactedParams?: Record<string, unknown>; // Redacted: { userID: 456, password: '***' }
  redactedKeys?: string[]; // List of keys that were redacted: ['password', 'user.apiKey']
  error?: unknown; // Original error object from errorObject() calls
  exitCode?: number; // Exit code if this log triggers a process exit
  tags?: string[]; // Optional tags for categorizing/filtering logs: ['auth', 'security']
}
```

### Important Notes

- **`message`**: Contains the fully interpolated template with all parameter values (including sensitive data if included in the template)
- **`params`**: Raw unredacted parameters
- **`redactedParams`**: Parameters with sensitive values masked according to `redactedKeys`
- **`redactedKeys`**: List of parameter keys that were redacted (useful for auditing and metadata)

### Security Note

The `message` field is computed from the original unredacted `params`. If you include sensitive parameters in your template (e.g., `{{password}}`), they will appear in plain text in the message. Only include non-sensitive fields in your templates, and rely on `redactedParams` for structured data storage.

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

// Mute console in production, unmute in development
if (process.env.NODE_ENV === 'production') {
  consoleSink.mute();
}
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
