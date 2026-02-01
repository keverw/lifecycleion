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
  - [Monitoring with Events](#monitoring-with-events)
  - [Testing Components](#testing-components)
- [Best Practices](#best-practices)
  - [1. Design Components for Graceful Shutdown](#1-design-components-for-graceful-shutdown)
  - [2. Use Appropriate Timeouts](#2-use-appropriate-timeouts)
  - [3. Handle Optional Dependencies](#3-handle-optional-dependencies)
  - [4. Leverage Events for Monitoring](#4-leverage-events-for-monitoring)
  - [5. Validate Before Production](#5-validate-before-production)
  - [6. Use Single LifecycleManager Instance](#6-use-single-lifecyclemanager-instance)
- [Known Limitations](#known-limitations)
  - [1. Timeout Does Not Force-Cancel Operations](#1-timeout-does-not-force-cancel-operations)
  - [2. Stalled Component Memory](#2-stalled-component-memory)
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

### Multi-Phase Shutdown

The shutdown process has three phases:

1. **Global Warning Phase** (manager-level timeout)
   - Calls `onShutdownWarning()` on all running components
   - Components can save state, flush buffers, etc.
   - Non-blocking - components continue running

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
  autoStart?: boolean; // Auto-start if manager is running (default: false)
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
  autoStarted?: boolean; // true if auto-started
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
}
```

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

**Failure codes:**

- `'component_not_found'` - Component not found in registry
- `'component_running'` - Component is running (when stopIfRunning is false)
- `'stop_failed'` - Failed to stop component before unregistering
- `'bulk_operation_in_progress'` - Cannot unregister during bulk operations

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
  timeoutMS?: number; // Global timeout for entire startup process (default: constructor's startupTimeoutMS)
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
    | 'stalled_components_exist'
    | 'startup_timeout'
    | 'unknown_error';
  error?: Error; // Error object (when success is false due to dependency cycle or unknown error)
}
```

**Timeout Behavior:**

The timeout applies to the **entire startup process**, not per-component:

- Constructor option sets the default: `new LifecycleManager({ startupTimeoutMS: 60000 })`
- Method parameter overrides the default: `await lifecycle.startAllComponents({ timeoutMS: 30000 })`
- If startup exceeds the timeout, component initiation stops and returns partial results
- The timeout prevents hanging indefinitely when components fail to start

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

**Note:** `restartAllComponents` always uses `retryStalled: true` and `haltOnStall: true` during the shutdown phase; only the timeout is configurable.

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

**Failure codes:**

- `'component_not_found'` - Component not registered
- `'component_already_running'` - Component was already running
- `'component_already_starting'` - Component is currently starting
- `'component_already_stopping'` - Component is currently stopping
- `'component_not_running'` - Component not running (for stop operations)
- `'component_stalled'` - Component is stalled (for stop operations)
- `'missing_dependency'` - Required dependency not found
- `'dependency_not_running'` - Required dependency not running
- `'has_running_dependents'` - Other components depend on this one
- `'startup_in_progress'` - Bulk startup operation in progress
- `'shutdown_in_progress'` - Bulk shutdown operation in progress
- `'start_timeout'` - Component start timed out
- `'stop_timeout'` - Component stop timed out
- `'restart_stop_failed'` - Restart failed during stop phase
- `'restart_start_failed'` - Restart failed during start phase
- `'unknown_error'` - Unclassified failure
- `'restart_stop_failed'` - Restart failed during stop phase
- `'restart_start_failed'` - Restart failed during start phase
- `'unknown_error'` - Unexpected error

### Component Messaging

#### `sendMessageToComponent(name, payload, options?)`

Send a message to a specific component.

```typescript
sendMessageToComponent<T = unknown>(
  name: string,
  payload: T,
  options?: SendMessageOptions
): Promise<MessageResult>
```

**Example:**

```typescript
// Component with message handler
class CacheComponent extends BaseComponent {
  async onMessage<T>(payload: T, from: string | null) {
    if (payload.action === 'clear') {
      await this.cache.clear();
      return { success: true, cleared: true };
    }
  }
}

// Send message
const result = await lifecycle.sendMessageToComponent('cache', {
  action: 'clear',
});

console.log('Cache cleared:', result.data);
```

#### `broadcastMessage(payload, options?)`

Broadcast a message to multiple components.

```typescript
broadcastMessage<T = unknown>(
  payload: T,
  options?: BroadcastOptions
): Promise<BroadcastResult[]>
```

**Options:**

```typescript
interface BroadcastOptions {
  includeNonRunning?: boolean; // Include stopped components (default: false)
  componentNames?: string[]; // Filter by specific components
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
interface HealthReport {
  overallHealthy: boolean; // true only if ALL components healthy
  totalChecked: number;
  healthyCount: number;
  unhealthyCount: number;
  checkDurationMS: number;
  components: HealthCheckResult[];
}
```

### Value Sharing

Components can share values with each other:

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
triggerShutdown(method?: 'SIGINT' | 'SIGTERM' | 'SIGTRAP'): void
triggerReload(): Promise<SignalBroadcastResult>
triggerInfo(): Promise<SignalBroadcastResult>
triggerDebug(): Promise<SignalBroadcastResult>
```

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
getAllComponentStatuses(): ComponentStatus[]

// System state
getSystemState(): SystemState
getStalledComponents(): ComponentStallInfo[]
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

- `'idle'` - No components registered
- `'ready'` - Components registered, none running
- `'starting'` - `startAllComponents()` in progress
- `'running'` - Components are running (all or some)
- `'stalled'` - Some components failed to stop (stuck running)
- `'shutting-down'` - `stopAllComponents()` in progress
- `'stopped'` - All components stopped (can restart)
- `'error'` - Startup failed with rollback

**Note:** The `'running'` state is returned whenever any components are running, regardless of whether all components are running. Use `getRunningComponentCount()` and `getComponentCount()` to determine if all components are running.

`getRunningComponentCount()` excludes stalled components. Use `getStalledComponents()` if you need to include stalled ones.

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

// Optional: Called if stop() times out
onStopAborted?(): void;

// Optional: Called during global shutdown warning
onShutdownWarning?(): Promise<void> | void;

// Optional: Called for force shutdown if graceful shutdown times out
onShutdownForce?(): Promise<void> | void;

// Optional: Called if onShutdownForce() times out
onShutdownForceAborted?(): void;
```

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
onMessage?<T>(payload: T, from: string | null): Promise<unknown> | unknown;

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

## Advanced Usage

### Dynamic Component Management

Add and remove components at runtime:

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

  // Option 1: Unregister stalled components
  for (const stalled of shutdownResult.stalledComponents) {
    await lifecycle.unregisterComponent(stalled.name);
  }

  // Option 2: Force restart (risky - acknowledge the risk)
  await lifecycle.startAllComponents({ ignoreStalledComponents: true });
}
```
1. Design components with reasonable timeouts they can meet
2. Use the force shutdown phase to abandon work
3. Accept that some memory may leak until process exit

