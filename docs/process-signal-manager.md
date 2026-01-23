# Process Signal Manager

A robust process signal and keyboard event manager. This utility provides a unified interface for handling process signals (SIGINT, SIGTERM, SIGTRAP, SIGHUP, SIGUSR1, SIGUSR2) and keyboard shortcuts (Ctrl+C, Escape, R, I, D - all case-insensitive), making it easy to implement graceful shutdowns, hot-reload functionality, runtime stats, and debug mode toggling.

<!-- toc -->

- [Features](#features)
- [Understanding Process Signals](#understanding-process-signals)
  - [Shutdown Signals](#shutdown-signals)
    - [SIGINT (Signal Interrupt)](#sigint-signal-interrupt)
    - [SIGTERM (Signal Terminate)](#sigterm-signal-terminate)
    - [SIGTRAP (Signal Trap)](#sigtrap-signal-trap)
  - [Reload Signal](#reload-signal)
    - [SIGHUP (Signal Hangup)](#sighup-signal-hangup)
  - [Info and Debug Signals](#info-and-debug-signals)
    - [SIGUSR1 (Info/Stats Signal)](#sigusr1-infostats-signal)
    - [SIGUSR2 (Debug Signal)](#sigusr2-debug-signal)
- [Usage](#usage)
  - [Basic Setup](#basic-setup)
  - [Async Handlers](#async-handlers)
  - [Custom Callback Names](#custom-callback-names)
  - [Reload-Only Manager](#reload-only-manager)
  - [Debouncing Keyboard Events](#debouncing-keyboard-events)
  - [Adding Info and Debug Handlers](#adding-info-and-debug-handlers)
- [API](#api)
  - [`constructor(options: ProcessSignalManagerOptions)`](#constructoroptions-processsignalmanageroptions)
  - [`isAttached: boolean`](#isattached-boolean)
  - [`getStatus(): ProcessSignalManagerStatus`](#getstatus-processsignalmanagerstatus)
  - [`attach(): void`](#attach-void)
  - [`detach(): void`](#detach-void)
  - [Trigger Methods](#trigger-methods)
- [Signal and Key Mappings](#signal-and-key-mappings)
- [Stdin Raw Mode Behavior](#stdin-raw-mode-behavior)
- [Multiple Instances](#multiple-instances)
- [Error Handling](#error-handling)
- [Demo](#demo)

<!-- tocstop -->

## Features

- 🎯 Unified handling of process signals and keyboard events
- 🛑 Graceful shutdown with SIGINT, SIGTERM, SIGTRAP
- 🔄 Optional reload callback (SIGHUP + R key) for hot-reload functionality
- ℹ️ Optional info callback (SIGUSR1 + I key) for stats and health checks
- 🐛 Optional debug callback (SIGUSR2 + D key) for toggling debug mode
- ⚡ Support for both synchronous and asynchronous callbacks
- 🛡️ Built-in error handling with safe callback execution
- 🎹 TTY detection and raw mode management
- 🔌 Clean attach/detach lifecycle for signal handlers

## Understanding Process Signals

This library handles common Unix process signals for both shutdown and reload operations.

### Shutdown Signals

Three signals trigger graceful shutdown:

#### SIGINT (Signal Interrupt)

- **Typical source:** Pressing `Ctrl+C` in the terminal
- **Purpose:** Polite request to stop - "please shut down gracefully"
- **Default behavior:** Terminate the process immediately
- **When handled:** Perform cleanup (close database connections, save state, etc.) before exiting

#### SIGTERM (Signal Terminate)

- **Typical source:** System shutdown, container platforms, process managers (PM2, systemd)
- **Purpose:** Graceful shutdown request - "I'm giving you time to clean up"
- **Default behavior:** Terminate the process
- **When handled:** Same as SIGINT - clean shutdown with proper resource cleanup
- **Example:** Container platforms typically send SIGTERM first, wait a grace period (e.g., 10 seconds), then send SIGKILL if the process is still running

#### SIGTRAP (Signal Trap)

- **Typical source:** Debuggers, manual triggering
- **Purpose:** Usually used for debugging/breakpoints, but can be used as a custom signal
- **Default behavior:** Core dump and terminate
- **When handled:** Treated as a shutdown signal alongside SIGINT/SIGTERM - less common but available if needed

**When should you care which signal you received?**

Most of the time, you don't need to distinguish between them - just handle all three the same way by cleaning up and exiting gracefully. However, you might want to know which signal triggered the shutdown for logging purposes or if you want different behavior (though this is rare).

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log(`Received ${method}`); // Know which signal triggered shutdown

    // Usually you'd handle them all the same way:
    cleanupResources();
    process.exit(0);
  },
});
```

### Reload Signal

#### SIGHUP (Signal Hangup)

- **Typical source:** System administrators running `kill -HUP <pid>`, process managers, service management tools
- **Purpose:** Standard daemon signal for reloading configuration without full restart
- **Default behavior:** Terminate the process (if not handled)
- **When handled:** Reload config files, restart workers, refresh data - without stopping the main process
- **Common pattern:** Long-running daemons (Apache, Nginx, MySQL, syslog) use SIGHUP to re-read configuration and reinitialize gracefully
- **Example:** After updating a config file, send `kill -HUP 12345` to tell your app to reload without downtime
- **Also triggered by:** Pressing the `R` key when your app is running in a terminal

**When to use reload vs shutdown:**

The reload callback is perfect for hot-reloading scenarios where you want to apply changes without stopping the process. Common use cases:

- Reloading configuration files
- Refreshing database connections
- Restarting worker threads
- Updating cached data

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log('Shutting down...');
    process.exit(0);
  },
  onReloadRequested: () => {
    console.log('Reloading configuration...');
    loadConfig();
    restartWorkers();
    console.log('Reload complete!');
  },
});
```

### Info and Debug Signals

User-defined signals for runtime introspection and debugging without disrupting your application.

**When you register handlers** (via `onInfoRequested` or `onDebugRequested`):

- ✅ Prevents the default behavior (prevents debugger activation in Node.js, prevents termination in Bun)
- ✅ Executes your custom callback instead
- ✅ Process stays alive after callback completes (all runtimes)

#### SIGUSR1 (Info/Stats Signal)

- **Typical source:** System administrators running `kill -USR1 <pid>`, monitoring tools
- **Purpose:** Display stats, health check, show metrics - "tell me how you're doing"
- **Also triggered by:** Pressing the `I` key in this library

**Default Behavior (when no handler is registered):**

| Runtime     | Behavior                                                   | Note                                                                           |
| ----------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Node.js** | Activates debugger on inspector port (process stays alive) | Works even without `--inspect` flag. Can be disabled with `--disable-sigusr1`. |
| **Bun**     | **Terminates** the process                                 | Bun uses `--inspect` flag for debugging, not SIGUSR1                           |
| **Other**   | Usually **terminates** (standard Unix behavior)            |                                                                                |

**When handled:** Print current stats, health check responses, show metrics

**Notes:**

- This library only registers a handler if you provide `onInfoRequested`. Without it, the runtime's default behavior remains (debugger in Node.js, termination in Bun).
- Registering a handler overrides Node.js's debugger activation ([docs](https://nodejs.org/en/learn/getting-started/debugging)). This is usually desired for production apps where stats/health checks are more useful than debugger activation.
- **Node.js debugging alternatives:** Use `node --inspect yourapp.js` (recommended), or `kill -USR1 <pid>` on processes without custom handlers. Can disable with `--disable-sigusr1` flag. Not available on Windows.
- **Bun's approach:** Uses `--inspect` for debugging ([docs](https://bun.com/docs/guides/runtime/web-debugger)). SIGUSR1 simply terminates if unhandled.

**Common use cases:**

- Print current statistics or metrics
- Health check / readiness probe
- Show active connections or jobs
- Display performance metrics
- Report current throughput

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: handleShutdown,
  onInfoRequested: () => {
    console.log('=== Health Check ===');
    console.log(`Uptime: ${process.uptime()}s`);
    console.log(
      `Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(`Active connections: ${getConnectionCount()}`);
    console.log(`Status: ${isHealthy() ? 'HEALTHY' : 'DEGRADED'}`);
    // Continue running after displaying stats
  },
});
```

#### SIGUSR2 (Debug Signal)

- **Typical source:** System administrators running `kill -USR2 <pid>`, debugging tools
- **Purpose:** Toggle debug mode, dump full state - "give me detailed info" or "turn on/off debug"
- **Also triggered by:** Pressing the `D` key in this library

**Default Behavior (when no handler is registered):**

| Runtime     | Behavior                                         |
| ----------- | ------------------------------------------------ |
| **Node.js** | **Terminates** the process (no special behavior) |
| **Bun**     | **Terminates** the process                       |
| **Other**   | Usually **terminates** (standard Unix behavior)  |

**When handled:** Toggle verbose logging, dump full state, enable profiling

**Note:** This library only registers a handler if you provide `onDebugRequested`. Without it, the signal is not handled and will terminate the process. User-defined signals (USR1/USR2) exist specifically for application-defined behavior.

**Common use cases:**

- Toggle verbose/debug logging on and off
- Dump complete internal state for debugging
- Enable/disable performance profiling
- Trigger memory heap dumps
- Show detailed configuration

```typescript
let debugMode = false;

const manager = new ProcessSignalManager({
  onShutdownRequested: handleShutdown,
  onDebugRequested: () => {
    debugMode = !debugMode;
    console.log(`Debug mode: ${debugMode ? 'ON' : 'OFF'}`);

    if (debugMode) {
      // Enable verbose logging
      logger.setLevel('debug');
      console.log('Detailed logging enabled');
    } else {
      logger.setLevel('info');
      console.log('Detailed logging disabled');
    }
  },
});
```

**Why separate info and debug?**

Splitting these into two callbacks makes the purpose of each clearer:

- **Info (I key / SIGUSR1)**: Quick stats, health checks
- **Debug (D key / SIGUSR2)**: Verbose mode toggle, state dumps - might be chatty

You can use both together for a complete debugging experience!

## Usage

### Basic Setup

```typescript
import { ProcessSignalManager } from './process-signal-manager';

const manager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log(`Shutdown requested via ${method}`);
    // Perform cleanup...
    process.exit(0);
  },
  onReloadRequested: () => {
    console.log('Reload requested!');
    // Reload configuration, restart services, etc.
    reloadApplication();
  },
});

manager.attach();

// The manager will now respond to:
// - SIGINT, SIGTERM, SIGTRAP signals → onShutdownRequested
// - SIGHUP signal or R key → onReloadRequested
// - Ctrl+C, Escape keys → onShutdownRequested
```

### Async Handlers

Both shutdown and reload handlers can be async:

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: async (method) => {
    console.log(`Shutting down via ${method}...`);
    await database.close();
    await server.close();
    console.log('Shutdown complete');
    process.exit(0);
  },
  onReloadRequested: async () => {
    console.log('Reloading...');
    await reloadConfig();
    await restartServices();
    console.log('Reload complete');
  },
});

manager.attach();
```

### Custom Callback Names

You can customize the callback names used in error reporting:

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: handleShutdown,
  onReloadRequested: handleReload,
  shutdownCallbackName: 'MyApp.handleShutdown',
  reloadCallbackName: 'MyApp.handleReload',
});

// Errors will now be reported with your custom names
```

### Reload-Only Manager

For specialized use cases, you can create a manager that only handles reload:

```typescript
const manager = new ProcessSignalManager({
  onReloadRequested: () => {
    console.log('Reloading configuration...');
    reloadConfig();
  },
});

manager.attach();

// This manager only responds to:
// - SIGHUP signal
// - R or r key press
// Shutdown signals (SIGINT, SIGTERM, SIGTRAP) will not be handled
```

### Throttling Keyboard Events

Keyboard events are throttled by default (200ms) to prevent accidental double-triggers:

```typescript
// Default: 200ms throttle is applied automatically
const manager = new ProcessSignalManager({
  onShutdownRequested: handleShutdown,
  onReloadRequested: handleReload,
});

// If user accidentally double-presses R quickly, only the first press triggers reload
```

You can customize the throttle interval:

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: handleShutdown,
  onReloadRequested: handleReload,
  keypressThrottleMS: 500, // Longer throttle for expensive operations
});
```

Or disable throttling entirely:

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: handleShutdown,
  onReloadRequested: handleReload,
  keypressThrottleMS: 0, // No throttling - every keypress triggers immediately
});
```

**How throttling works (leading-edge rate limiting):**

- The first keypress triggers the action immediately
- Subsequent presses within the 200ms window are ignored
- You can press again exactly 200ms after each _successful_ trigger
- This is the standard pattern for keyboard shortcuts and button clicks

**Example timeline:**

- t=0ms: Press 'R' → reload fires, timer starts
- t=50ms: Press 'R' → blocked (only 50ms since last successful trigger)
- t=150ms: Press 'R' → blocked (only 150ms since last successful trigger)
- t=200ms: Press 'R' → **fires** (200ms window expired from t=0ms)
- t=250ms: Press 'R' → blocked (only 50ms since trigger at t=200ms)
- t=400ms: Press 'R' → **fires** (200ms window expired from t=200ms)

**Notes:**

- Throttling only affects keyboard events, never process signals
- Process signals (sent via `kill -HUP <pid>`, etc.) are always processed immediately
- The default 200ms is similar to typical UI throttle values for keyboard shortcuts
- Allows predictable repeated actions at a maximum rate (e.g., reload at most 5 times per second)

### Adding Info and Debug Handlers

For runtime introspection and debugging:

```typescript
let debugMode = false;

const manager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log(`Shutting down via ${method}`);
    cleanupAndExit();
  },
  onReloadRequested: () => {
    console.log('Reloading config...');
    reloadConfig();
  },
  onInfoRequested: () => {
    // Quick stats - I key or SIGUSR1
    console.log('=== Health Check ===');
    console.log(`Uptime: ${process.uptime()}s`);
    console.log(
      `Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(`Active requests: ${getActiveRequests()}`);
  },
  onDebugRequested: () => {
    // Toggle debug mode - D key or SIGUSR2
    debugMode = !debugMode;
    logger.setLevel(debugMode ? 'debug' : 'info');
    console.log(`Debug mode: ${debugMode ? 'ON' : 'OFF'}`);
  },
});

manager.attach();

// Now you can:
// - Press 'I' or send `kill -USR1 <pid>` to see quick stats
// - Press 'D' or send `kill -USR2 <pid>` to toggle debug mode
// Process keeps running after info/debug events
```

## API

### `constructor(options: ProcessSignalManagerOptions)`

Creates a new ProcessSignalManager instance.

**Parameters:**

- `options`: Configuration object with the following properties:
  - `onShutdownRequested?`: `(method: ShutdownSignal) => void | Promise<void>` **(optional)**
    - Callback invoked when a shutdown signal is received
    - `method` will be one of: `'SIGINT'`, `'SIGTERM'`, or `'SIGTRAP'`
  - `onReloadRequested?`: `() => void | Promise<void>` **(optional)**
    - Callback invoked when reload is requested
    - Triggered by: SIGHUP signal or R key press (case-insensitive)
  - `onInfoRequested?`: `() => void | Promise<void>` **(optional)**
    - Callback invoked when info/stats are requested
    - Triggered by: SIGUSR1 signal or I key press (case-insensitive)
    - Common uses: Print stats, health checks, show metrics
  - `onDebugRequested?`: `() => void | Promise<void>` **(optional)**
    - Callback invoked when debug mode toggle is requested
    - Triggered by: SIGUSR2 signal or D key press (case-insensitive)
    - Common uses: Toggle debug mode, dump full state, enable verbose logging
  - `shutdownCallbackName?`: `string` **(optional)**
    - Custom name for the shutdown callback used in error reporting
    - Default: `'onShutdownRequested'`
  - `reloadCallbackName?`: `string` **(optional)**
    - Custom name for the reload callback used in error reporting
    - Default: `'onReloadRequested'`
  - `infoCallbackName?`: `string` **(optional)**
    - Custom name for the info callback used in error reporting
    - Default: `'onInfoRequested'`
  - `debugCallbackName?`: `string` **(optional)**
    - Custom name for the debug callback used in error reporting
    - Default: `'onDebugRequested'`
  - `keypressThrottleMS?`: `number` **(optional)**
    - Throttle interval in milliseconds for keyboard events (uses leading-edge rate limiting)
    - Allows an action to trigger at most once per interval
    - First press fires immediately, subsequent presses within the window are ignored
    - Prevents accidental double-triggers while allowing predictable repeated actions
    - Only affects keyboard events, not process signals (signals are never throttled)
    - Set to `0` to disable throttling entirely
    - Default: `200` (200ms, allowing 5 triggers per second maximum)

**Returns:** `ProcessSignalManager` instance

**Note:** All callbacks are optional. You can handle any combination of shutdown, reload, info, and/or debug signals.

### `isAttached: boolean`

A read-only getter property that returns whether the manager is currently attached to signals and keypresses.

**Returns:** `true` if attached, `false` otherwise

**Example:**

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log(`Shutdown: ${method}`);
  },
});

console.log(manager.isAttached); // false

manager.attach();
console.log(manager.isAttached); // true

manager.detach();
console.log(manager.isAttached); // false
```

### `getStatus(): ProcessSignalManagerStatus`

Get detailed status information about what the manager is attached to.

**Returns:** A status object containing:

- `isAttached`: `boolean` - Whether currently attached
- `handlers`: Object showing which callbacks are registered
  - `shutdown`: `boolean` - Whether shutdown handler is registered
  - `reload`: `boolean` - Whether reload handler is registered
  - `info`: `boolean` - Whether info handler is registered
  - `debug`: `boolean` - Whether debug handler is registered
- `listeningFor`: Object showing what events are actively being listened for (only meaningful when `isAttached` is `true`)
  - `shutdownSignals`: `boolean` - Listening for SIGINT, SIGTERM, SIGTRAP
  - `reloadSignal`: `boolean` - Listening for SIGHUP
  - `infoSignal`: `boolean` - Listening for SIGUSR1
  - `debugSignal`: `boolean` - Listening for SIGUSR2
  - `keypresses`: `boolean` - Listening for keyboard events (requires TTY)

**Example:**

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: handleShutdown,
  onReloadRequested: handleReload,
  onInfoRequested: handleInfo,
  onDebugRequested: handleDebug,
});

// Check status before listening
let status = manager.getStatus();
console.log(status);
// {
//   isAttached: false,
//   handlers: { shutdown: true, reload: true, info: true, debug: true },
//   listeningFor: {
//     shutdownSignals: false,
//     reloadSignal: false,
//     infoSignal: false,
//     debugSignal: false,
//     keypresses: false
//   }
// }

manager.attach();

// Check status while listening
status = manager.getStatus();
console.log(status);
// {
//   isAttached: true,
//   handlers: { shutdown: true, reload: true, info: true, debug: true },
//   listeningFor: {
//     shutdownSignals: true,
//     reloadSignal: true,
//     infoSignal: true,
//     debugSignal: true,
//     keypresses: true  // if TTY available
//   }
// }
```

This method is useful for debugging, logging, or conditionally checking what the manager is set up to handle.

### `attach(): void`

Attach signal handlers and start listening for process signals and keyboard events.

- Registers handlers for SIGINT, SIGTERM, SIGTRAP (shutdown, if callback provided)
- Registers handler for SIGHUP (reload, if callback provided)
- Registers handler for SIGUSR1 (info, if callback provided)
- Registers handler for SIGUSR2 (debug, if callback provided)
- Enables raw mode on stdin if TTY is available
- Starts listening for Ctrl+C, Escape, R, I, and D key presses
- Calling multiple times is safe (idempotent)

### `detach(): void`

Detach signal handlers and stop listening for process signals and keyboard events.

- Unregisters all signal handlers
- Restores stdin to normal mode
- Pauses stdin
- Calling multiple times is safe (idempotent)

### Trigger Methods

All trigger methods share the same behavior pattern and are useful for programmatic triggering or testing.

**Shared Parameters:**

- `shouldBypassAttachCheck?`: `boolean` - If `true`, triggers the callback even when not attached (default: `false`)

**Shared Behavior:**

- By default, only triggers if the manager is currently attached
- Only triggers if the corresponding callback was provided during construction
- Use `shouldBypassAttachCheck: true` to force triggering regardless of attach state

**Available Methods:**

| Method                                              | Additional Parameters                                               | Triggers Which Callback | Use Case                         |
| --------------------------------------------------- | ------------------------------------------------------------------- | ----------------------- | -------------------------------- |
| `triggerShutdown(method, shouldBypassAttachCheck?)` | `method: ShutdownSignal` (`'SIGINT'` \| `'SIGTERM'` \| `'SIGTRAP'`) | `onShutdownRequested`   | Initiate shutdown, testing       |
| `triggerReload(shouldBypassAttachCheck?)`           | -                                                                   | `onReloadRequested`     | Programmatic reload, testing     |
| `triggerInfo(shouldBypassAttachCheck?)`             | -                                                                   | `onInfoRequested`       | Request stats on demand, testing |
| `triggerDebug(shouldBypassAttachCheck?)`            | -                                                                   | `onDebugRequested`      | Toggle debug mode, testing       |

**Example:**

```typescript
const manager = new ProcessSignalManager({
  onShutdownRequested: (method) => console.log(`Shutdown: ${method}`),
  onReloadRequested: () => console.log('Reloading...'),
  onInfoRequested: () => console.log('Stats...'),
  onDebugRequested: () => console.log('Debug toggled'),
});

// Won't trigger - not attached
manager.triggerShutdown('SIGINT');
manager.triggerReload();

// Will trigger - bypasses attach check
manager.triggerShutdown('SIGINT', true);
manager.triggerInfo(true);

manager.attach();
// Will trigger - is attached
manager.triggerShutdown('SIGTERM');
manager.triggerReload();
manager.triggerInfo();
manager.triggerDebug();
```

## Signal and Key Mappings

The manager responds to the following events:

| Event Type     | Trigger    | Description                      | Callback                         |
| -------------- | ---------- | -------------------------------- | -------------------------------- |
| Process Signal | `SIGINT`   | Interrupt (Ctrl+C from terminal) | `onShutdownRequested('SIGINT')`  |
| Process Signal | `SIGTERM`  | Graceful shutdown request        | `onShutdownRequested('SIGTERM')` |
| Process Signal | `SIGTRAP`  | Trap (debuggers, custom use)     | `onShutdownRequested('SIGTRAP')` |
| Process Signal | `SIGHUP`   | Hangup (reload config)           | `onReloadRequested()`            |
| Process Signal | `SIGUSR1`  | User signal 1 (stats/health)     | `onInfoRequested()`              |
| Process Signal | `SIGUSR2`  | User signal 2 (debug toggle)     | `onDebugRequested()`             |
| Keyboard       | `Ctrl+C`   | Manual interrupt keypress        | `onShutdownRequested('SIGINT')`  |
| Keyboard       | `Escape`   | Quick exit keypress              | `onShutdownRequested('SIGINT')`  |
| Keyboard       | `R` or `r` | Reload trigger                   | `onReloadRequested()`            |
| Keyboard       | `I` or `i` | Info/stats trigger               | `onInfoRequested()`              |
| Keyboard       | `D` or `d` | Debug mode toggle                | `onDebugRequested()`             |

**Notes:**

- Keyboard events only work when stdin is a TTY (not in piped or redirected mode)
- Keyboard shortcuts are case-insensitive (`R` or `r`, `I` or `i`, `D` or `d` all work)
- **Keyboard events directly invoke callbacks** - they don't emit actual process signals
  - Example: Pressing `I` calls `onInfoRequested()` directly (no `process.emit('SIGUSR1')`)
  - Keyboard shortcuts work the same across all runtimes (Node.js, Bun, Deno)
  - The default behavior tables in the signal descriptions only apply to actual process signals (e.g., `kill -USR1 <pid>`), not keyboard shortcuts

## Stdin Raw Mode Behavior

This library is designed for applications that primarily **log output** and support **keyboard shortcuts**, not full-fledged REPLs or applications that need to read line-buffered input from stdin.

**What happens when you call `attach()`:**

When the manager attaches and stdin is a TTY, it enables **raw mode** to capture individual keypresses (Ctrl+C, Escape, R, I, D). Raw mode has these effects:

- **Line buffering is disabled** - Input is processed character-by-character instead of line-by-line
- **Echo is disabled** - Keypresses won't automatically appear on screen
- **Special character processing is disabled** - Ctrl+C won't send SIGINT automatically (we handle it manually)

**Restoration behavior:**

The manager tracks whether _it_ enabled raw mode:

- ✅ If raw mode was **off** when `attach()` was called, it will be **restored to off** when `detach()` is called
- ✅ If raw mode was **already on** when `attach()` was called, it will be **left on** when `detach()` is called
- ✅ This preserves the original state for applications that manage raw mode themselves

**When to use this library:**

✅ **Good fit:**

- Command-line tools that log output and want keyboard shortcuts
- Long-running daemons with monitoring/debugging keypresses
- Development servers with hot-reload (R) and stats (I) keys
- Background tasks that can be interrupted gracefully

❌ **Not a good fit:**

- REPLs or interactive shells that need line-buffered input
- Applications that need to read multi-line input from stdin
- Tools that rely on stdin being in cooked mode (normal) for other purposes

**Note:** If your application needs to read from stdin for other purposes while using this library, you'll need to manage the interaction between raw mode and your input handling carefully.

## Multiple Instances

While most applications use a single global `ProcessSignalManager` instance, the library supports multiple concurrent instances if needed:

```typescript
// Example: Different subsystems with their own managers
const dbManager = new ProcessSignalManager({
  onShutdownRequested: () => closeDatabase(),
});

const serverManager = new ProcessSignalManager({
  onShutdownRequested: () => closeHttpServer(),
});

dbManager.attach();
serverManager.attach();
```

**Behavior with multiple instances:**

- ✅ **Process signals**: All attached instances receive the same signal - each callback fires
- ✅ **Keyboard shortcuts**: All attached instances receive the same keypress - each callback fires
- ✅ **stdin management**: Properly coordinated using internal reference counting
- ✅ **Raw mode**: Stays enabled as long as any instance is attached
- ✅ **Clean lifecycle**: Each instance can attach/detach independently

### Important: Shared Keypress Behavior

**All attached instances receive every keypress.** When you press a key like `R`, `I`, or `D`:

1. Every attached instance with the corresponding handler will invoke its callback
2. There is no coordination between instances - callbacks run concurrently
3. If callbacks are async, multiple async operations may run in parallel without synchronization

This is by design to ensure all registered handlers respond to events, but it has implications:

```typescript
// Example: Both reload callbacks fire when R is pressed
const manager1 = new ProcessSignalManager({
  onReloadRequested: () => console.log('Manager 1 reloading'),
});
const manager2 = new ProcessSignalManager({
  onReloadRequested: () => console.log('Manager 2 reloading'),
});

manager1.attach();
manager2.attach();

// Pressing R will print BOTH:
// "Manager 1 reloading"
// "Manager 2 reloading"
```

**Recommendations for multi-instance usage:**

- Use a **single global instance** when possible - this is simpler and avoids duplicate callback execution
- If you need multiple instances, ensure their callbacks are idempotent or coordinate externally
- Consider using throttling (`keypressThrottleMS`) to prevent rapid accidental triggers
- For async callbacks, implement your own guards against concurrent execution if needed

**Demo:** See `scripts/demo-multiple-instances.ts` for a working example of multiple concurrent instances.

## Error Handling

All callbacks are wrapped with `safeHandleCallback()`, which:

- Catches synchronous errors
- Catches asynchronous promise rejections
- Reports errors via the global `reportError` event (standard API available in Node.js 15+, Bun, Deno, and browsers)
- Prevents uncaught exceptions from crashing the process

```typescript
// Errors in callbacks are caught and reported
const manager = new ProcessSignalManager({
  onShutdownRequested: () => {
    throw new Error('Something went wrong during shutdown');
  },
});

// Listen for errors globally using the standard reportError event
globalThis.addEventListener('reportError', (event) => {
  console.error('Callback error:', event.error);
});

manager.attach();
manager.triggerShutdown('SIGINT'); // Error will be caught and reported
```

## Demo

Two demo scripts are included:

### Interactive Demo

Test the manager interactively with keyboard shortcuts and signals:

```bash
bun run scripts/demo-process-signal-manager.ts
```

**Note:** Run in the foreground (without `&`) so keyboard shortcuts work. In background mode, only process signals will be available.

The demo will:

- Display the process ID for testing signals
- Show all available keyboard shortcuts and signals
- Log when shutdown, reload, info, or debug is triggered
- Display the current manager status
- Keep running until you trigger a shutdown

You can test the different callbacks:

- **Info/Stats**: Press `I` or send `kill -USR1 <pid>` from another terminal to see quick stats
- **Debug Toggle**: Press `D` or send `kill -USR2 <pid>` from another terminal to toggle debug mode
- **Reload**: Press `R` or send `kill -HUP <pid>` from another terminal to reload config
- **Shutdown**: Press `Ctrl+C` / `Escape` or send `kill -TERM <pid>` from another terminal to exit

### Multiple Instances Demo

Test multiple concurrent ProcessSignalManager instances:

```bash
bun run scripts/demo-multiple-instances.ts
```

This automated demo validates that multiple instances can coexist properly, showing independent attach/detach lifecycle and proper coordination of shared resources (stdin, raw mode).

The process will remain running after reload, info, and debug events, but will exit after shutdown events.
