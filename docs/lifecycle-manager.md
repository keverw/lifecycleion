# LifecycleManager

A comprehensive lifecycle orchestration system that manages startup, shutdown, and runtime control of application components. The LifecycleManager coordinates complex applications with multiple components, handles graceful shutdowns, manages dependencies, and integrates with process signals for production-ready applications.

<!-- toc -->

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [1. Create Your Components](#1-create-your-components)
  - [2. Create and Configure LifecycleManager](#2-create-and-configure-lifecyclemanager)
  - [3. Graceful Shutdown](#3-graceful-shutdown)
- [Core Concepts](#core-concepts)
  - [Component Lifecycle States](#component-lifecycle-states)
  - [Dependency Management](#dependency-management)
  - [Optional Components](#optional-components)
  - [Multi-Phase Shutdown](#multi-phase-shutdown)
- [API Reference](#api-reference)
  - [LifecycleManager Constructor](#lifecyclemanager-constructor)
  - [Component Registration](#component-registration)
    - [`registerComponent(component, options?)`](#registercomponentcomponent-options)
    - [`insertComponentAt(component, position, reference?, options?)`](#insertcomponentatcomponent-position-reference-options)
    - [`unregisterComponent(name, options?)`](#unregistercomponentname-options)
  - [Lifecycle Operations](#lifecycle-operations)
    - [`startAllComponents(options?)`](#startallcomponentsoptions)
    - [`stopAllComponents(options?)`](#stopallcomponentsoptions)
    - [`restartAllComponents(options?)`](#restartallcomponentsoptions)
    - [Individual Component Operations](#individual-component-operations)
  - [Component Messaging](#component-messaging)
    - [`sendMessageToComponent(name, payload, options?)`](#sendmessagetocomponentname-payload-options)
    - [`broadcastMessage(payload, options?)`](#broadcastmessagepayload-options)
  - [Health Monitoring](#health-monitoring)
    - [`checkComponentHealth(name)`](#checkcomponenthealthname)
    - [`checkAllHealth()`](#checkallhealth)
  - [Value Sharing](#value-sharing)
  - [Signal Integration](#signal-integration)
    - [`attachSignals()`](#attachsignals)
    - [`detachSignals()`](#detachsignals)
    - [Manual Signal Triggers](#manual-signal-triggers)
    - [Custom Signal Handlers](#custom-signal-handlers)
  - [Logger Integration](#logger-integration)
    - [`enableLoggerExitHook()`](#enableloggerexithook)
  - [Status and Query Methods](#status-and-query-methods)
- [BaseComponent API](#basecomponent-api)
  - [Constructor](#constructor)
  - [Lifecycle Methods](#lifecycle-methods)
  - [Signal Handlers](#signal-handlers)
  - [Messaging](#messaging)
  - [Health Checks](#health-checks)
  - [Value Sharing](#value-sharing-1)
  - [Component Properties](#component-properties)
- [Events](#events)
  - [Subscribing to Events](#subscribing-to-events)
  - [Event Categories](#event-categories)
  - [Event Handler Best Practices](#event-handler-best-practices)
- [Error Handling](#error-handling)
  - [Result Objects vs Exceptions](#result-objects-vs-exceptions)
    - [Operations Return Result Objects](#operations-return-result-objects)
    - [Exceptions (Programmer Errors)](#exceptions-programmer-errors)
  - [Failure Codes](#failure-codes)
- [Advanced Usage](#advanced-usage)
  - [Dynamic Component Management](#dynamic-component-management)
  - [Dependency Validation](#dependency-validation)
  - [Stalled Component Recovery](#stalled-component-recovery)
- [Best Practices](#best-practices)
  - [1. Design Components for Graceful Shutdown](#1-design-components-for-graceful-shutdown)
  - [2. Use Appropriate Timeouts](#2-use-appropriate-timeouts)
  - [3. Handle Optional Dependencies](#3-handle-optional-dependencies)
  - [4. Leverage Events for Monitoring](#4-leverage-events-for-monitoring)
  - [5. Validate Before Production](#5-validate-before-production)
  - [6. Use Single LifecycleManager Instance](#6-use-single-lifecyclemanager-instance)
- [Known Limitations](#known-limitations)
  - [1. Timeouts Do Not Force-Cancel Work](#1-timeouts-do-not-force-cancel-work)
  - [2. Stalled Promises Can Retain Memory](#2-stalled-promises-can-retain-memory)
  - [3. No Atomic Restart](#3-no-atomic-restart)

<!-- tocstop -->

## Features

- 🚀 **Dependency-ordered startup** - Components start in dependency order (topological sort)
- 🛑 **Multi-phase shutdown** - Global warning → per-component graceful → force phases
- 📦 **Component lifecycle** - Unified interface for start, stop, restart operations
- 🔗 **Dependency management** - Automatic dependency resolution with cycle detection
- 📡 **Process signal integration** - Built-in handling for SIGINT, SIGTERM, SIGHUP, etc.
- 🪵 **Logger integration** - Graceful shutdown on `logger.exit()` with configurable timeout
- 💬 **Component messaging** - Send messages, broadcast to running components, and read values from other components
- 🏥 **Health monitoring** - Built-in health check system with timeouts
- 🔄 **Hot reload support** - Broadcast reload signals to components
- 📊 **Event-driven** - Rich event system for monitoring and observability
- 🎯 **Optional components** - Components that can fail without breaking startup

## Installation

```bash
npm install lifecycleion
# or
bun add lifecycleion
```

## Quick Start

### 1. Create Your Components

Components extend `BaseComponent` and implement lifecycle methods:

```typescript
import { BaseComponent } from 'lifecycleion';
import type { Logger } from 'lifecycleion';

class DatabaseComponent extends BaseComponent {
  private pool!: Pool;
  private abortController = new AbortController();

  constructor(logger: Logger) {
    super(logger, {
      name: 'database',
    });
  }

  async start() {
    this.logger.info('Connecting to database...');

    this.pool = await createPool(config, {
      signal: this.abortController.signal,
    });

    await this.pool.connect();
    this.logger.success('Database connected');
  }

  onStartupAborted() {
    // Called if startup times out
    this.abortController.abort();
  }

  async stop() {
    this.logger.info('Closing database connection...');
    await this.pool.drain();
    this.logger.success('Database closed');
  }

  async healthCheck() {
    const stats = await this.pool.stats();
    return {
      healthy: stats.idle > 0,
      message: stats.idle > 0 ? 'Pool healthy' : 'No idle connections',
      details: { active: stats.active, idle: stats.idle },
    };
  }
}

class WebServerComponent extends BaseComponent {
  private server!: Server;

  constructor(logger: Logger) {
    super(logger, {
      name: 'web-server',
      dependencies: ['database'], // Start after database
    });
  }

  async start() {
    this.logger.info('Starting web server...');
    this.server = createServer();
    await this.server.listen(3000);
    this.logger.success('Web server listening on port 3000');
  }

  async stop() {
    this.logger.info('Stopping web server...');
    await this.server.close();
    this.logger.success('Web server stopped');
  }

  async onReload() {
    this.logger.info('Reloading web server configuration...');
    await this.reloadConfig();
  }
}
```

### 2. Create and Configure LifecycleManager

```typescript
import { LifecycleManager } from 'lifecycleion';

const lifecycle = new LifecycleManager({
  name: 'my-app',
  logger,
  shutdownOptions: { timeoutMS: 30000 }, // 30 second shutdown timeout
});

// Register components
lifecycle.registerComponent(new DatabaseComponent(logger));
lifecycle.registerComponent(new WebServerComponent(logger));

// Start all components (respects dependencies)
const result = await lifecycle.startAllComponents();

if (!result.success) {
  logger.error('Failed to start application:', result.errors);
  process.exit(1);
}

// Manually Attach signal handlers for graceful shutdown
lifecycle.attachSignals();

logger.success('Application started successfully');
```

### 3. Graceful Shutdown

When SIGINT (Ctrl+C) or SIGTERM is received, the LifecycleManager automatically:

1. Emits `lifecycle-manager:shutdown-initiated` event
2. Runs global shutdown warning phase (calls `onShutdownWarning()` on all components)
3. Stops components in reverse dependency order
4. Handles timeouts and stalled components
5. Emits `lifecycle-manager:shutdown-completed` event

## Core Concepts

### Component Lifecycle States

Components transition through these states:

```
registered → starting → running → stopping → stopped
                   ↓
                stalled (if stop times out)
```

**Stalled State Definition:**
A component becomes "stalled" when:

1. The graceful `stop()` method exceeds `shutdownGracefulTimeoutMS` timeout, AND
2. Either `onShutdownForce()` is not implemented, OR `onShutdownForce()` also exceeds `shutdownForceTimeoutMS` timeout

Once stalled, a component remains registered but:

- `startAllComponents()` will fail unless you pass `ignoreStalledComponents: true` (which skips stalled components during bulk startup)
- `startComponent(name)` will fail unless you pass `forceStalled: true` (which calls `start()` regardless of stalled state)

To recover: unregister the component, retry stopping it via `stopAllComponents({ retryStalled: true })`, or force start with the appropriate option (`ignoreStalledComponents` for bulk, `forceStalled` for individual).

### Dependency Management

Components declare dependencies in their constructor options:

```typescript
class ApiComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database', 'cache'], // Required dependencies
      optional: false, // If true, startup continues even if it fails; dependents still attempt to start
    });
  }
}
```

**Dependency Resolution:**

- Components start in **topological order** (dependencies first)
- Components stop in **reverse topological order** (dependents first)
- Cycle detection prevents invalid dependency graphs
- Missing dependencies are reported before startup

### Optional Components

Optional components can fail during startup without breaking the entire application:

```typescript
class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // App works without cache, just slower
    });
  }
}

const result = await lifecycle.startAllComponents();

if (result.failedOptionalComponents.length > 0) {
  logger.warn('Running in degraded mode:', result.failedOptionalComponents);
}
```

Dependents still attempt to start if an optional component fails or isn't running, so they should handle missing optional dependencies gracefully. Optional dependencies are primarily for ordering and visibility, not hard requirements.

**Handling Optional Dependencies:**

Dependents of optional components should gracefully handle the missing dependency:

```typescript
class ApiComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database', 'cache'], // cache is optional, database is required
    });
  }

  async start() {
    // Database is required - assume it's available
    this.db = await getComponentValue('database', 'connection');

    // Cache is optional - check if available
    const cacheResult = lifecycle.getValue('cache', 'instance');
    this.cache = cacheResult.found ? cacheResult.value : null;

    if (!this.cache) {
      this.logger.warn('Cache unavailable, using fallback');
    }
  }
}

class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // Mark as optional so API can still start
    });
  }
}
```

When `cache` fails to start:

- It's recorded in `failedOptionalComponents`
- The `api` component still attempts to start
- The `api` component handles the missing cache gracefully

### Multi-Phase Shutdown

The shutdown process has three phases:

1. **Global Warning Phase** (manager-level timeout)
   - Calls `onShutdownWarning()` on all running components
   - Best for quick, non-blocking prep (stop accepting new work)
   - Avoid long-running persistence here, treat it as best-effort and minimal
   - Non-blocking - components continue running and there is no cancellation signal

2. **Graceful Phase** (per-component timeout)
   - Calls `stop()` on each component in reverse dependency order
   - Components shut down cleanly
   - Timeout triggers force phase for that component

3. **Force Phase** (per-component)
   - Called if graceful `stop()` times out
   - Component is marked as `stalled`
   - Manager stops after the first stall by default (set `haltOnStall: false` to continue)

```typescript
class WorkerComponent extends BaseComponent {
  private activeJobs = new Set<Job>();

  async onShutdownWarning() {
    // Global warning - stop accepting new work
    this.acceptingWork = false;
    this.logger.info('Shutdown warning received, stopping new work');
  }

  async stop() {
    // Graceful phase - wait for active jobs to complete
    this.logger.info('Waiting for active jobs to complete...');
    await this.waitForJobs(this.activeJobs);
    this.logger.success('All jobs completed');
  }
}
```

## API Reference

### LifecycleManager Constructor

```typescript
new LifecycleManager(options: LifecycleManagerOptions)
```

**Options:**

```typescript
interface LifecycleManagerOptions {
  name?: string; // Manager name for logging (default: 'lifecycle-manager')
  logger: Logger; // Logger instance (required)
  startupTimeoutMS?: number; // Global timeout for startup in ms (default: 60000, 0 = disabled)
  shutdownOptions?: StopAllOptions; // Default stopAll options for shutdown hooks (defaults: timeoutMS=30000, retryStalled=true, haltOnStall=true)
  shutdownWarningTimeoutMS?: number; // Global warning phase timeout in ms (default: 500, 0 = fire-and-forget, <0 = skip)
  messageTimeoutMS?: number; // Default message timeout in ms (default: 5000, 0 = disabled)
  attachSignalsOnStart?: boolean; // Auto-attach signals when first component starts (default: false)
  detachSignalsOnStop?: boolean; // Auto-detach signals when last component stops (default: false)
  enableLoggerExitHook?: boolean; // Auto-enable logger exit hook integration (default: false)

  // Custom signal handlers (optional)
  onReloadRequested?: (
    broadcastReload: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
  onInfoRequested?: (
    broadcastInfo: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
  onDebugRequested?: (
    broadcastDebug: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
}
```

### Component Registration

#### `registerComponent(component, options?)`

Register a component with the manager.

```typescript
registerComponent(
  component: BaseComponent,
  options?: RegisterOptions
): Promise<RegisterComponentResult>
```

**Options:**

```typescript
interface RegisterOptions {
  autoStart?: boolean; // Auto-start component if possible (default: false)
}
```

**Returns:**

```typescript
interface RegisterComponentResult {
  success: boolean;
  reason?: string;
  code?: RegistrationFailureCode;
  componentName?: string;
  duringStartup?: boolean; // true if registered during bulk startup
  autoStartAttempted?: boolean; // true if auto-start was attempted
  autoStartSucceeded?: boolean; // true if auto-start succeeded
}
```

**Example:**

```typescript
const result = await lifecycle.registerComponent(new DatabaseComponent(logger));

if (!result.success) {
  console.error('Registration failed:', result.reason);
}
```

#### `insertComponentAt(component, position, reference?, options?)`

Insert a component at a specific position.

```typescript
insertComponentAt(
  component: BaseComponent,
  position: 'start' | 'end' | 'before' | 'after',
  reference?: string,
  options?: RegisterOptions
): Promise<InsertComponentAtResult>
```

**Example:**

```typescript
// Insert cache before database
await lifecycle.insertComponentAt(
  new CacheComponent(logger),
  'before',
  'database',
);
```

**Returns:**

```typescript
interface InsertComponentAtResult {
  success: boolean;
  reason?: string;
  code?: RegistrationFailureCode;
  error?: Error;
  registered: boolean;
  action: 'insert';
  requestedPosition: {
    position: InsertPosition | (string & {});
    targetComponentName?: string;
  };
  actualPosition?: {
    position: InsertPosition;
    index: number;
  };
  manualPositionRespected?: boolean; // Whether explicit position was honored (vs dependency-based reordering)
  targetFound?: boolean; // Whether 'before'/'after' reference component was found
}
```

**Position Debugging Fields:**

- `manualPositionRespected` - `true` if the explicit position was honored, `false` if dependency ordering forced a different position
- `targetFound` - For 'before'/'after' positions, indicates if the reference component was found (always `undefined` for 'start'/'end')

#### `unregisterComponent(name, options?)`

Unregister a component (stops it if running).

```typescript
unregisterComponent(
  name: string,
  options?: UnregisterOptions
): Promise<UnregisterComponentResult>
```

**Options:**

```typescript
interface UnregisterOptions {
  stopIfRunning?: boolean; // Stop the component first if it's running (default: true)
  forceStop?: boolean; // Allow stopping even if other components depend on it (default: false)
}
```

**Notes:**

- `forceStop` only applies when `stopIfRunning` is true.
- If a component is stalled and `stopIfRunning` is true, unregister is blocked.

**Returns:**

```typescript
interface UnregisterComponentResult {
  success: boolean;
  componentName: string;
  reason?: string;
  code?: UnregisterFailureCode;
  error?: Error;
  stopFailureReason?: UnregisterStopFailureReason;
  wasStopped: boolean;
  wasRegistered: boolean;
}
```

**Failure codes:** See the centralized list in [Failure Codes](#failure-codes).

**Stop failure reasons:**

- `'stalled'` - Component stalled during stop
- `'timeout'` - Component stop timed out
- `'error'` - Component stop threw an error

### Lifecycle Operations

#### `startAllComponents(options?)`

Start all registered components in dependency order.

```typescript
startAllComponents(options?: StartupOptions): Promise<StartupResult>
```

**Options:**

```typescript
interface StartupOptions {
  ignoreStalledComponents?: boolean; // Allow startup despite stalled components
  timeoutMS?: number; // Total time budget for startup process (default: constructor's startupTimeoutMS)
}
```

**Returns:**

```typescript
interface StartupResult {
  success: boolean;
  startedComponents: string[];
  failedOptionalComponents: Array<{ name: string; error: Error }>;
  skippedDueToDependency: string[];
  durationMS?: number; // Total startup duration in milliseconds
  timedOut?: boolean; // True if startup timed out
  reason?: string; // Reason for failure (when success is false)
  code?:
    | 'already_in_progress'
    | 'shutdown_in_progress'
    | 'dependency_cycle'
    | 'no_components_registered'
    | 'stalled_components_exist'
    | 'startup_timeout'
    | 'unknown_error';
  error?: Error; // Error object (when success is false due to dependency cycle or unknown error)
}
```

**Timeout Behavior:**

The `startupTimeoutMS` option sets a **total time budget** for the entire startup process:

- All component starts combined must complete within this budget
- Constructor option sets the default: `new LifecycleManager({ startupTimeoutMS: 60000 })`
- Method parameter overrides the default: `await lifecycle.startAllComponents({ timeoutMS: 30000 })`
- If the timeout is exceeded, startup stops initiating new components
- Returns partial results with `timedOut: true`

**Examples:**

```typescript
// Use constructor's default timeout (60s)
await lifecycle.startAllComponents();

// Override with custom timeout (30s)
await lifecycle.startAllComponents({ timeoutMS: 30000 });

// Disable timeout (wait indefinitely)
await lifecycle.startAllComponents({ timeoutMS: 0 });
```

#### `stopAllComponents(options?)`

Stop all running components in reverse dependency order.

```typescript
stopAllComponents(options?: StopAllOptions): Promise<ShutdownResult>
```

**Parameters:**

- `options` (optional) - `StopAllOptions` object. If omitted, uses the constructor's `shutdownOptions.timeoutMS` value (default: 30000ms).

**StopAllOptions:**

```typescript
interface StopAllOptions {
  timeoutMS?: number; // Global shutdown timeout (default: 30000, 0 = disabled)
  retryStalled?: boolean; // Retry stalled components (default: true)
  haltOnStall?: boolean; // Stop processing after a stall (default: true)
}
```

**Timeout Behavior:**

The timeout applies to the **entire shutdown process**, not per-component:

- Constructor option sets the default: `new LifecycleManager({ shutdownOptions: { timeoutMS: 30000 } })`
- Method parameter overrides the default: `await lifecycle.stopAllComponents({ timeoutMS: 5000 })`
- If shutdown exceeds the timeout, components that haven't stopped yet will be left in their current state
- The timeout prevents hanging indefinitely when components fail to stop gracefully

**Examples:**

```typescript
// Use constructor's default timeout (30s)
await lifecycle.stopAllComponents();

// Override with custom timeout (5s)
await lifecycle.stopAllComponents({ timeoutMS: 5000 });

// Disable timeout (wait indefinitely)
await lifecycle.stopAllComponents({ timeoutMS: 0 });

// Retry stalled components in this shutdown pass
await lifecycle.stopAllComponents({ retryStalled: true });

// Stop processing after the first stall
await lifecycle.stopAllComponents({ haltOnStall: true });

// Continue shutdown even if a component stalls
await lifecycle.stopAllComponents({ haltOnStall: false });

// Skip retrying previously stalled components
await lifecycle.stopAllComponents({ retryStalled: false });
```

**Returns:**

```typescript
interface ShutdownResult {
  success: boolean;
  stoppedComponents: string[];
  stalledComponents: ComponentStallInfo[];
  durationMS: number;
  timedOut?: boolean;
  reason?: string;
  code?: 'already_in_progress';
}
```

#### `restartAllComponents(options?)`

Stop all components, then start them again.

```typescript
restartAllComponents(options?: RestartAllOptions): Promise<RestartResult>

interface RestartAllOptions {
  startupOptions?: StartupOptions;     // Options for the start phase
  shutdownTimeoutMS?: number;         // Timeout for the shutdown phase
}
```

**Note:** `restartAllComponents` hardcodes `retryStalled: true` and `haltOnStall: true` during shutdown — only the timeout is configurable via `shutdownTimeoutMS`.

#### Individual Component Operations

```typescript
// Start a single component
startComponent(name: string, options?: StartComponentOptions): Promise<ComponentOperationResult>

// Stop a single component
stopComponent(name: string, options?: StopComponentOptions): Promise<ComponentOperationResult>

// Restart a single component
restartComponent(name: string, options?: RestartComponentOptions): Promise<ComponentOperationResult>
```

**Options:**

```typescript
interface StartComponentOptions {
  allowRequiredDependencies?: boolean; // Force start despite missing required deps
  forceStalled?: boolean; // Force starting a stalled component
}

interface StopComponentOptions {
  forceImmediate?: boolean; // Skip graceful phase, go straight to force
  timeout?: number; // Override default timeout
}

interface RestartComponentOptions {
  stopOptions?: StopComponentOptions; // Options for stop phase
  startOptions?: StartComponentOptions; // Options for start phase
}
```

**Returns:**

```typescript
interface ComponentOperationResult {
  success: boolean;
  componentName: string;
  reason?: string;
  code?: ComponentOperationFailureCode;
  error?: Error;
  status?: ComponentStatus;
}
```

**Failure codes:** See the centralized list in [Failure Codes](#failure-codes).

### Component Messaging

#### `sendMessageToComponent(name, payload, options?)`

Send a message to a specific component.
By default, only running components receive messages; use `includeStopped`/`includeStalled` to override.

```typescript
sendMessageToComponent<T = unknown>(
  name: string,
  payload: T,
  options?: SendMessageOptions
): Promise<MessageResult>
```

**Options:**

```typescript
interface SendMessageOptions {
  timeout?: number; // Response timeout in milliseconds (default: manager messageTimeoutMS, 0 = disabled)
  includeStopped?: boolean; // Allow stopped components (default: false)
  includeStalled?: boolean; // Allow stalled components (default: false)
}
```

**Returns:**

```typescript
interface MessageResult {
  sent: boolean;
  componentFound: boolean;
  componentRunning: boolean;
  handlerImplemented: boolean;
  data: unknown;
  error: Error | null;
  timedOut: boolean;
  code:
    | 'sent'
    | 'not_found'
    | 'stopped'
    | 'stalled'
    | 'no_handler'
    | 'timeout'
    | 'error';
}
```

**Example:**

```typescript
import { isPlainObject } from 'lifecycleion';

// Component with message handler
class CacheComponent extends BaseComponent {
  async onMessage<TData = unknown>(
    payload: unknown,
    from: string | null,
  ): Promise<TData> {
    // Validate payload is a plain object (not null, not array)
    if (!isPlainObject(payload)) {
      return { success: false, error: 'Expected object' } as TData;
    }

    const data = payload as { action: string; key?: string };

    switch (data.action) {
      case 'clear':
        await this.cache.clear();
        return { success: true } as TData;
      case 'get':
        if (!data.key) {
          return { success: false, error: 'Missing key' } as TData;
        }

        return { success: true, value: this.cache.get(data.key) } as TData;
      default:
        return { success: false, error: 'Unknown action' } as TData;
    }
  }
}

// Send message
const result = await lifecycle.sendMessageToComponent('cache', {
  action: 'clear',
});

if (result.sent) {
  console.log('Cache cleared:', result.data);
}
```

**Note:** Payloads support any type (strings, numbers, objects). Validate as needed using type checks, type guards, or validation libraries

#### `broadcastMessage(payload, options?)`

Broadcast a message to multiple components.
By default, only running components receive messages; use `includeStopped`/`includeStalled` to override.
When `componentNames` is provided, only those targets are considered; stopped/stalled targets are reported but not sent unless explicitly included.

```typescript
broadcastMessage<T = unknown>(
  payload: T,
  options?: BroadcastOptions
): Promise<BroadcastResult[]>
```

**Options:**

```typescript
interface BroadcastOptions {
  timeout?: number; // Response timeout in milliseconds (default: manager messageTimeoutMS, 0 = disabled)
  includeStopped?: boolean; // Include stopped components (default: false)
  includeStalled?: boolean; // Include stalled components (default: false)
  componentNames?: string[]; // Filter by specific components
}
```

**Returns:**

```typescript
interface BroadcastResult {
  name: string;
  sent: boolean;
  running: boolean;
  data: unknown;
  error: Error | null;
  timedOut: boolean;
  code: 'sent' | 'stopped' | 'stalled' | 'no_handler' | 'timeout' | 'error';
}
```

### Health Monitoring

#### `checkComponentHealth(name)`

Check the health of a specific component.

```typescript
checkComponentHealth(name: string): Promise<HealthCheckResult>
```

**Example:**

```typescript
const health = await lifecycle.checkComponentHealth('database');

if (!health.healthy) {
  console.error('Database unhealthy:', health.message);
}
```

#### `checkAllHealth()`

Check health of all running components.

```typescript
checkAllHealth(): Promise<HealthReport>
```

**Returns:**

```typescript
interface HealthCheckResult {
  name: string;
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
  checkedAt: number;
  durationMS: number;
  error: Error | null;
  timedOut: boolean;
  code:
    | 'ok'
    | 'not_found'
    | 'stopped'
    | 'stalled'
    | 'no_handler'
    | 'timeout'
    | 'error';
}

interface HealthReport {
  healthy: boolean; // true only if ALL components healthy
  components: HealthCheckResult[];
  checkedAt: number;
  durationMS: number;
  timedOut: boolean;
  code: 'ok' | 'degraded' | 'timeout' | 'error';
}
```

### Value Sharing

Components can share values with each other. **By default, only running components can provide values.** Use the `includeStopped` or `includeStalled` options to retrieve values from components in other states.

```typescript
class ConfigComponent extends BaseComponent {
  getValue(key: string, from: string | null): ComponentValueResult {
    if (key === 'database-url') {
      return { found: true, value: this.config.databaseUrl };
    }

    return { found: false, value: undefined }; // Key not found
  }
}

// Request value from another component
const result = lifecycle.getValue('config', 'database-url');
if (result.found) {
  console.log('Database URL:', result.value);
}

// Request from a stopped or stalled component (explicitly)
const fallback = lifecycle.getValue('config', 'database-url', {
  includeStopped: true,
  includeStalled: true,
});
```

**Options:**

```typescript
interface GetValueOptions {
  includeStopped?: boolean; // Allow stopped components (default: false)
  includeStalled?: boolean; // Allow stalled components (default: false)
}
```

### Signal Integration

#### `attachSignals()`

Attach process signal handlers.

```typescript
attachSignals(): void
```

**Signals:**

- **SIGINT, SIGTERM, SIGTRAP** - Trigger `stopAllComponents()`
- **SIGHUP, R key** - Trigger reload (calls `onReload()` on components or custom callback)
- **SIGUSR1, I key** - Trigger info (custom callback or warning)
- **SIGUSR2, D key** - Trigger debug (custom callback or warning)

#### `detachSignals()`

Detach all signal handlers.

```typescript
detachSignals(): void
```

#### Manual Signal Triggers

```typescript
triggerReload(): Promise<SignalBroadcastResult>
triggerInfo(): Promise<SignalBroadcastResult>
triggerDebug(): Promise<SignalBroadcastResult>
```

**Note:** For programmatic shutdown, use [`stopAllComponents()`](#stopallcomponentsoptions) which returns a `ShutdownResult`.

#### Custom Signal Handlers

```typescript
const lifecycle = new LifecycleManager({
  logger,

  // Custom reload handler
  onReloadRequested: async (broadcastReload) => {
    console.log('Reloading global configuration...');
    await reloadGlobalConfig();
    await broadcastReload(); // Also reload components
  },

  // Custom info handler
  onInfoRequested: async () => {
    console.log('=== App Info ===');
    console.log('Uptime:', process.uptime());
    console.log('Components:', lifecycle.getRunningComponentNames());
  },

  // Custom debug handler
  onDebugRequested: async () => {
    console.log('Debug mode toggled');
  },
});
```

### Logger Integration

The LifecycleManager can integrate with the Logger's exit mechanism to trigger graceful component shutdown when `logger.exit()` is called.

#### `enableLoggerExitHook()`

Enable Logger exit hook integration to trigger graceful component shutdown before process exit.

```typescript
enableLoggerExitHook(): void
```

**What it does:**

- Sets up the logger's `beforeExit` callback to call `stopAllComponents(shutdownOptions)`
- When `logger.exit(code)` is called, components shut down gracefully first
- When `logger.error('message', { exitCode: 1 })` is called, components shut down before exit
- Uses the constructor's `shutdownOptions.timeoutMS` (default: 30000ms) to prevent hanging
- Overwrites any existing `beforeExit` callback on the logger

**Constructor Options:**

```typescript
const lifecycle = new LifecycleManager({
  logger,
  enableLoggerExitHook: true, // Auto-enable on construction
  shutdownOptions: { timeoutMS: 30000 }, // Max time for shutdown (default: 30s)
});
```

**Manual Usage:**

```typescript
const lifecycle = new LifecycleManager({ logger });

// Enable later
lifecycle.enableLoggerExitHook();

// Now logger.exit() triggers graceful shutdown
logger.exit(0);
// Components stop gracefully (up to shutdown timeout) before process exits
```

**Example with Error Exit:**

```typescript
const lifecycle = new LifecycleManager({
  logger,
  enableLoggerExitHook: true,
});

await lifecycle.registerComponent(database);
await lifecycle.registerComponent(apiServer);
await lifecycle.startAllComponents();

// Fatal error triggers graceful shutdown
logger.error('Database connection lost', { exitCode: 1 });
// Output:
// Logger exit triggered, stopping components...
// Stopping component: api-server...
// Stopping component: database...
// [Process exits with code 1]
```

**Timeout Behavior:**

If component shutdown exceeds `shutdownOptions.timeoutMS`, the process will exit anyway:

```typescript
const lifecycle = new LifecycleManager({
  logger,
  enableLoggerExitHook: true,
  shutdownOptions: { timeoutMS: 5000 }, // Only wait 5 seconds
});

// If shutdown takes longer than 5s, warning is logged and exit proceeds
logger.exit(0);
// Output if timeout exceeded:
// Shutdown timeout exceeded, proceeding with exit (timeoutMS: 5000)
```

**Important Notes:**

- This method is idempotent (can be called multiple times safely)
- Overwrites any existing `beforeExit` callback on the logger
- If you need custom exit logic, set it up manually with `logger.setBeforeExitCallback()`

### Status and Query Methods

```typescript
// Component existence and state
hasComponent(name: string): boolean
isComponentRunning(name: string): boolean
getComponentStatus(name: string): ComponentStatus | undefined
getComponentInstance(name: string): BaseComponent | undefined

// Lists and counts
getComponentNames(): string[]
getRunningComponentNames(): string[]
getComponentCount(): number
getRunningComponentCount(): number
getStalledComponentCount(): number
getStoppedComponentCount(): number
getAllComponentStatuses(): ComponentStatus[]

// System state
getSystemState(): SystemState
getStatus(): LifecycleManagerStatus
getStalledComponents(): ComponentStallInfo[]
getStalledComponentNames(): string[]
getStoppedComponentNames(): string[]
getLastShutdownResult(): ShutdownResult | null

// Dependencies
getStartupOrder(): StartupOrderResult
validateDependencies(): DependencyValidationResult
```

**DependencyValidationResult:**

```typescript
interface DependencyValidationResult {
  valid: boolean;
  missingDependencies: Array<{
    componentName: string;
    componentIsOptional: boolean;
    missingDependency: string;
  }>;
  circularCycles: string[][];
  summary: {
    totalMissingDependencies: number;
    requiredMissingDependencies: number;
    optionalMissingDependencies: number;
    totalCircularCycles: number;
  };
}
```

**SystemState Values:**

`getSystemState()` returns one of the following states:

- `'no-components'` - No components registered
- `'ready'` - Components registered, none running
- `'starting'` - `startAllComponents()` in progress
- `'running'` - Components are running (all or some)
- `'stalled'` - Some components failed to stop (stuck running)
- `'shutting-down'` - `stopAllComponents()` in progress
- `'stopped'` - All components stopped (can restart)
- `'error'` - Startup failed with rollback

**Note:** The `'running'` state is returned whenever any components are running, regardless of whether all components are running. Use `getRunningComponentCount()` and `getComponentCount()` to determine if all components are running.

`getRunningComponentCount()` excludes stalled components. Use `getStalledComponents()` if you need to include stalled ones.

**LifecycleManagerStatus:**

```typescript
interface LifecycleManagerStatus {
  systemState: SystemState;
  isStarted: boolean; // Any component is running (or stalled)
  isStarting: boolean;
  isShuttingDown: boolean;
  counts: {
    total: number;
    running: number;
    stopped: number;
    stalled: number;
  };
  components: {
    registered: string[];
    running: string[];
    stopped: string[];
    stalled: string[];
  };
}
```

**Note:** `components.running` excludes stalled components. `components.stopped` excludes both running and stalled (use `components.stalled` or `getStalledComponents()` for those).

**Definition:** `stopped` = registered − running − stalled.

## BaseComponent API

Components extend `BaseComponent` and can implement these methods:

### Constructor

```typescript
constructor(logger: Logger, options?: ComponentOptions)
```

**Options:**

```typescript
interface ComponentOptions {
  name: string; // Component name (kebab-case)
  dependencies?: string[]; // Component dependencies
  optional?: boolean; // If true, failure doesn't stop startup
  startupTimeoutMS?: number; // Start timeout in milliseconds (default: 30000, 0 = disabled)
  shutdownGracefulTimeoutMS?: number; // Graceful shutdown timeout in milliseconds (default: 5000, min: 1000)
  shutdownForceTimeoutMS?: number; // Force shutdown timeout in milliseconds (default: 2000, min: 500)
  healthCheckTimeoutMS?: number; // Health check timeout in milliseconds (default: 5000)
  signalTimeoutMS?: number; // Signal handler timeout in milliseconds (default: 5000, 0 = disabled)
}
```

### Lifecycle Methods

```typescript
// Required: Start the component
abstract start(): Promise<void> | void;

// Required: Stop the component
abstract stop(): Promise<void> | void;

// Optional: Called if start() times out
onStartupAborted?(): void;

// Optional: Called if graceful stop() times out
onGracefulStopTimeout?(): void;

// Optional: Called during global shutdown warning
onShutdownWarning?(): Promise<void> | void;

// Optional: Called for force shutdown if graceful shutdown times out
onShutdownForce?(): Promise<void> | void;

// Optional: Called if onShutdownForce() times out
onShutdownForceAborted?(): void;
```

**Note:** `onShutdownWarning()` is only fired during `stopAllComponents()`/`restartAllComponents()` shutdowns. There is no built-in "warning cleared" event; if shutdown is canceled or stalls, reset any warning state on the next successful `start()` or via an app-specific signal.

### Signal Handlers

```typescript
// Optional: Handle reload signal
onReload?(): Promise<void> | void;

// Optional: Handle info signal
onInfo?(): Promise<void> | void;

// Optional: Handle debug signal
onDebug?(): Promise<void> | void;
```

### Messaging

```typescript
// Optional: Handle messages from other components or external callers
onMessage?<TData = unknown>(payload: unknown, from: string | null): TData | Promise<TData>;

// Send message to another component
sendMessage<T>(to: string, payload: T): Promise<MessageResult>;

// Broadcast message to all components
broadcastMessage<T>(payload: T, options?: BroadcastOptions): Promise<BroadcastResult[]>;
```

### Health Checks

```typescript
// Optional: Report component health
healthCheck?(): Promise<ComponentHealthResult | boolean> | ComponentHealthResult | boolean;
```

**Return types:**

```typescript
// Rich result
return {
  healthy: true,
  message: 'All systems operational',
  details: { connections: 10, queueSize: 5 },
};

// Simple boolean
return true; // healthy
```

### Value Sharing

```typescript
// Optional: Provide values to other components
getValue?<T>(key: string, from: string | null): ComponentValueResult<T>;
```

### Component Properties

```typescript
// Access component metadata
getName(): string
getDependencies(): string[]
isOptional(): boolean

// Logger (pre-configured with component name)
protected logger: LoggerService
```

## Events

The LifecycleManager emits events for monitoring and observability. All events are typed via `LifecycleManagerEvents`.

### Subscribing to Events

```typescript
import type { LifecycleManagerEventMap } from 'lifecycleion';

// Type-safe event subscription
lifecycle.on('component:started', (data) => {
  console.log(`Component ${data.name} started`);
});

lifecycle.on('lifecycle-manager:shutdown-completed', (data) => {
  console.log(`Shutdown completed in ${data.durationMS}ms`);
  process.exit(0);
});
```

### Event Categories

**Lifecycle Events:**

- `lifecycle-manager:started` - All components started successfully
- `lifecycle-manager:shutdown-initiated` - Shutdown process started
- `lifecycle-manager:shutdown-warning` - Global warning phase started
- `lifecycle-manager:shutdown-warning-completed` - Warning phase completed
- `lifecycle-manager:shutdown-warning-timeout` - Warning phase timed out
- `lifecycle-manager:shutdown-completed` - Shutdown process completed

**Component Registration:**

- `component:registered` - Component registered
- `component:unregistered` - Component unregistered

**Component Lifecycle:**

- `component:starting` - Component start initiated
- `component:started` - Component started successfully
- `component:start-failed` - Component start failed
- `component:stopping` - Component stop initiated
- `component:stopped` - Component stopped successfully
- `component:stop-failed` - Component stop failed
- `component:stalled` - Component failed to stop (timeout)
- `component:restart-initiated` - Component restart started
- `component:restarted` - Component restarted successfully

**Signal Events:**

- `signal:shutdown` - Shutdown signal received
- `signal:reload` - Reload signal received
- `signal:info` - Info signal received
- `signal:debug` - Debug signal received

**Component Signal Events:**

- `component:reload-started` - Component reload started
- `component:reload-completed` - Component reload completed
- `component:reload-failed` - Component reload failed
- `component:info-started` - Component info started
- `component:info-completed` - Component info completed
- `component:info-failed` - Component info failed
- `component:debug-started` - Component debug started
- `component:debug-completed` - Component debug completed
- `component:debug-failed` - Component debug failed

**Messaging Events:**

- `component:message-sent` - Message sent to component
- `component:message-failed` - Message send failed
- `component:broadcast-started` - Broadcast started
- `component:broadcast-completed` - Broadcast completed

**Health Events:**

- `component:health-check-started` - Health check started
- `component:health-check-completed` - Health check completed
- `component:health-check-failed` - Health check failed

**Value Events:**

- `component:value-requested` - Value requested
- `component:value-returned` - Value returned

### Event Handler Best Practices

Event handlers are **fire-and-forget** - they do not block lifecycle operations:

```typescript
// ✅ Good - handle errors in async handlers
lifecycle.on('component:started', async (data) => {
  try {
    await logToDatabase(data);
  } catch (error) {
    logger.error('Failed to log component start:', error);
  }
});

// ❌ Bad - errors in handlers are caught and logged by manager
lifecycle.on('component:started', async (data) => {
  await logToDatabase(data); // Uncaught errors won't break lifecycle
});
```

## Error Handling

### Result Objects vs Exceptions

The LifecycleManager uses **result objects** for expected failures and reserves **exceptions** for programmer errors or invalid construction.

#### Operations Return Result Objects

All lifecycle operations return result objects, for example:

```typescript
const result = await lifecycle.startComponent('database');

if (!result.success) {
  console.error('Start failed:', result.reason);
  console.error('Error code:', result.code);

  // Handle specific failures
  if (result.code === 'missing_dependency') {
    console.error('Missing dependencies');
  }
}

// Access component state immediately
if (result.success && result.status) {
  console.log('Started at:', result.status.startedAt);
}
```

#### Exceptions (Programmer Errors)

Exceptions are limited to invalid construction or unexpected internal bugs. In normal use of the public API, failures are returned as result objects.

Explicit exceptions you may see:

- `BaseComponent` constructor validation:

```typescript
// ❌ Throws InvalidComponentNameError
new MyComponent(logger, { name: 'Invalid Name' }); // Must be kebab-case

// ✅ Valid name
new MyComponent(logger, { name: 'my-component' });
```

- `LifecycleManager` constructor requires a root logger:

```typescript
// ❌ Throws Error
new LifecycleManager({} as any);
```

Dependency cycle detection throws `DependencyCycleError` internally, but public methods catch it and return a result with `code: 'dependency_cycle'`.

### Failure Codes

Result objects include machine-readable failure codes:

```typescript
// Component operation failure codes
type ComponentOperationFailureCode =
  | 'component_not_found'
  | 'component_already_running'
  | 'component_already_starting'
  | 'component_already_stopping'
  | 'component_not_running'
  | 'component_stalled'
  | 'missing_dependency'
  | 'dependency_not_running'
  | 'has_running_dependents'
  | 'startup_in_progress'
  | 'shutdown_in_progress'
  | 'start_timeout'
  | 'stop_timeout'
  | 'restart_stop_failed'
  | 'restart_start_failed'
  | 'unknown_error';

// Registration failure codes
type RegistrationFailureCode =
  | 'duplicate_name'
  | 'duplicate_instance'
  | 'shutdown_in_progress'
  | 'startup_in_progress'
  | 'target_not_found'
  | 'invalid_position'
  | 'dependency_cycle'
  | 'unknown_error';

// Unregister failure codes
type UnregisterFailureCode =
  | 'component_not_found'
  | 'component_running'
  | 'stop_failed'
  | 'bulk_operation_in_progress';

// Startup order failure codes
type StartupOrderFailureCode = 'dependency_cycle' | 'unknown_error';
```

## Advanced Usage

### Dynamic Component Management

Add and remove components at runtime:

```typescript
// Add component during runtime with autoStart
const result = await lifecycle.registerComponent(
  new CacheComponent(logger),
  { autoStart: true }, // Automatically starts when possible
);

// Remove component (stops it first if running)
await lifecycle.unregisterComponent('cache');
```

### Dependency Validation

Validate dependencies before startup:

```typescript
const validation = lifecycle.validateDependencies();

if (!validation.valid) {
  console.error('Dependency issues found:');

  for (const issue of validation.missingDependencies) {
    console.error(
      `${issue.componentName} missing dependency: ${issue.missingDependency}`,
    );
  }

  for (const cycle of validation.circularCycles) {
    console.error(`Dependency cycle: ${cycle.join(' → ')}`);
  }

  console.error('Summary:', validation.summary);
}
```

### Stalled Component Recovery

Handle components that fail to stop:

```typescript
const shutdownResult = await lifecycle.stopAllComponents();

if (shutdownResult.stalledComponents.length > 0) {
  console.error('Stalled components:', shutdownResult.stalledComponents);

  // Option 0: Retry stalled components in another shutdown pass
  await lifecycle.stopAllComponents({ retryStalled: true });

  // Option 1: Unregister stalled components
  for (const stalled of shutdownResult.stalledComponents) {
    await lifecycle.unregisterComponent(stalled.name);
  }

  // Option 2: Force restart (risky - acknowledge the risk)
  await lifecycle.startAllComponents({ ignoreStalledComponents: true });
}
```

## Best Practices

### 1. Design Components for Graceful Shutdown

Implement cooperative cancellation:

```typescript
class WorkerComponent extends BaseComponent {
  private aborted = false;
  private abortController = new AbortController();

  async start() {
    // Check abort flag during long operations
    for (const task of tasks) {
      if (this.aborted) throw new Error('Startup aborted');
      await processTask(task);
    }

    // Use AbortController for APIs that support signals
    await fetch(url, { signal: this.abortController.signal });
  }

  onStartupAborted() {
    this.aborted = true;
    this.abortController.abort();
  }

  async stop() {
    // Graceful shutdown - wait for current work
    await this.waitForCurrentWork();
  }
}
```

### 2. Use Appropriate Timeouts

Configure timeouts based on your component's needs:

```typescript
const lifecycle = new LifecycleManager({
  logger,
  componentStartTimeoutMS: 60000, // Long-running migrations
  componentStopTimeoutMS: 10000, // Most components stop quickly
  shutdownWarningTimeoutMS: 5000, // Time to flush buffers
});
```

### 3. Handle Optional Dependencies

Mark non-critical components as optional:

```typescript
class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // App works without cache
    });
  }
}

// Check for degraded mode
const result = await lifecycle.startAllComponents();

if (result.failedOptionalComponents.some((item) => item.name === 'cache')) {
  logger.warn('Running without cache - performance may be degraded');
}
```

### 4. Leverage Events for Monitoring

Use events for observability, not control flow:

```typescript
// ✅ Good - monitoring and observability
lifecycle.on('component:started', ({ name }) => {
  metrics.increment('component.started', { component: name });
});

// ❌ Bad - don't use events for control flow
lifecycle.on('component:started', async ({ name }) => {
  // Don't start other components here - use dependencies instead
  await lifecycle.startComponent('other-component');
});
```

### 5. Validate Before Production

Always validate dependencies before production:

```typescript
// Validate dependency graph
const validation = lifecycle.validateDependencies();

if (!validation.valid) {
  throw new Error(
    'Invalid dependencies: ' +
      JSON.stringify({
        missingDependencies: validation.missingDependencies,
        circularCycles: validation.circularCycles,
      }),
  );
}
```

### 6. Use Single LifecycleManager Instance

Only create one instance per application:

```typescript
// ✅ Good - single instance
const lifecycle = new LifecycleManager({ logger });
lifecycle.attachSignals();

// ❌ Bad - multiple instances cause signal conflicts
const lifecycle1 = new LifecycleManager({ logger });
const lifecycle2 = new LifecycleManager({ logger });
lifecycle1.attachSignals(); // Conflicts with lifecycle2
```

## Known Limitations

### 1. Timeouts Do Not Force-Cancel Work

The LifecycleManager does not forcibly terminate work when timeouts are exceeded. JavaScript promises cannot be externally canceled without cooperation from the executing code.

When `start()` or `stop()` times out:

- The manager calls `onStartupAborted()` or `onGracefulStopTimeout()` (if implemented)
- The manager proceeds with next steps (rollback for startup, force phase for shutdown)
- **Non-cooperative code continues running in the background** until completion or process exit

How to avoid surprises:

1. Implement cooperative cancellation (AbortController, flags, or library timeouts).
2. Wire cancellation into long-running work and close resources in `onStartupAborted()`/`onGracefulStopTimeout()`.
3. Favor libraries that support AbortSignal or configurable timeouts.

### 2. Stalled Promises Can Retain Memory

If a component stalls and its promise never resolves, the promise and any captured state remain in memory until process exit. This is a risk whenever async work never settles.

How to reduce the risk:

1. Ensure `start()`/`stop()` always settle (resolve or reject) on all paths.
2. Use timeouts and cancellation so work can terminate deterministically.
3. Keep long-lived closures small; avoid capturing large buffers in stalled tasks.

### 3. No Atomic Restart

`restartAllComponents()` is not atomic. There is a window where all components are stopped but none are started yet. For zero-downtime restarts, use rolling restarts with individual `restartComponent()` calls.
