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
    - [`insertComponentAt(component, position, targetComponentName?, options?)`](#insertcomponentatcomponent-position-targetcomponentname-options)
    - [`unregisterComponent(name, options?)`](#unregistercomponentname-options)
  - [Lifecycle Operations](#lifecycle-operations)
    - [`startAllComponents(options?)`](#startallcomponentsoptions)
    - [`stopAllComponents(options?)`](#stopallcomponentsoptions)
    - [`restartAllComponents(options?)`](#restartallcomponentsoptions)
    - [Individual Component Operations](#individual-component-operations)
  - [Component Messaging](#component-messaging)
    - [`sendMessageToComponent(componentName, payload, options?)`](#sendmessagetocomponentcomponentname-payload-options)
    - [`broadcastMessage(payload, options?)`](#broadcastmessagepayload-options)
  - [Health Monitoring](#health-monitoring)
    - [`checkComponentHealth(name)`](#checkcomponenthealthname)
    - [`checkAllHealth()`](#checkallhealth)
  - [Value Sharing](#value-sharing)
  - [Signal Integration](#signal-integration)
    - [`attachSignals()`](#attachsignals)
    - [`detachSignals()`](#detachsignals)
    - [`getSignalStatus()`](#getsignalstatus)
    - [`getShutdownEscalationStatus()`](#getshutdownescalationstatus)
    - [Manual Signal Triggers](#manual-signal-triggers)
    - [Custom Signal Handlers](#custom-signal-handlers)
    - [Repeated Shutdown Request Policy](#repeated-shutdown-request-policy)
  - [Logger Integration](#logger-integration)
    - [`enableLoggerExitHook()`](#enableloggerexithook)
    - [Process Exit Design & Rationale](#process-exit-design--rationale)
    - [Logger Requirements](#logger-requirements)
  - [Status and Query Methods](#status-and-query-methods)
    - [Component Existence and State](#component-existence-and-state)
    - [Lists and Counts](#lists-and-counts)
    - [System State](#system-state)
    - [Dependencies](#dependencies)
- [BaseComponent API](#basecomponent-api)
  - [Constructor](#constructor)
  - [Lifecycle Methods](#lifecycle-methods)
  - [Signal Handlers](#signal-handlers)
  - [Messaging](#messaging)
  - [Health Checks](#health-checks)
  - [Value Sharing](#value-sharing-1)
  - [Reporting Unexpected Stops](#reporting-unexpected-stops)
  - [Component Properties](#component-properties)
- [Events](#events)
  - [Subscribing to Events](#subscribing-to-events)
  - [Event Categories](#event-categories)
  - [Event Handler Best Practices](#event-handler-best-practices)
- [Error Handling](#error-handling)
  - [Result Objects vs Exceptions](#result-objects-vs-exceptions)
    - [Operations Return Result Objects](#operations-return-result-objects)
    - [Promises Never Reject](#promises-never-reject)
    - [Running Operations in the Background](#running-operations-in-the-background)
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
  - [7. Make Component Startup Idempotent and Coordinate With Shutdown](#7-make-component-startup-idempotent-and-coordinate-with-shutdown)
  - [8. Safe Resource Sharing via Dynamic Wrappers](#8-safe-resource-sharing-via-dynamic-wrappers)
    - [Step 1: The Resource Component](#step-1-the-resource-component)
    - [Step 2: The Consumer Wrapper Helper](#step-2-the-consumer-wrapper-helper)
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

**Note on Logger:** The LifecycleManager requires a `Logger` from `lifecycleion/logger`. The logger provides sinks, service scoping, and lifecycle integration.

## Quick Start

### 1. Create Your Components

Components extend `BaseComponent` and implement lifecycle methods.

**Production Note:** For simple or stateless components, implementing standard `start()` and `stop()` methods is sufficient. For production servers and long-running services, you should implement the **idempotency pattern** (using a `startPromise`, a `stopPromise`, and explicit start/stop coordination) to prevent race conditions. See [Best Practice #7](#7-make-component-startup-idempotent-and-coordinate-with-shutdown) for details.

```typescript
import { BaseComponent } from 'lifecycleion/lifecycle-manager';
import type { Logger } from 'lifecycleion/logger';

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
import { LifecycleManager } from 'lifecycleion/lifecycle-manager';

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
  logger.error('Failed to start application', {
    params: { errors: result.errors },
  });

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
                  ↓                   ↓
                  ↓ (timeout)         stalled (if shutdown fails)
                  ↓
            starting-timed-out (required component timeout)
                  ↓
            failed (optional component timeout/error)
```

**Note:** Required components that timeout enter `starting-timed-out` and trigger rollback. Optional components that fail enter `failed` state and startup continues.

Once a required startup failure begins rollback, the bulk startup timer is cleared.
Rollback uses the component shutdown timeouts, and startup returns the original failure
after cleanup finishes. A concurrent shutdown also cancels the remaining bulk starts,
even if shutdown finishes before startup resumes. Shutdown owns cleanup in this case, so
startup does not launch a second rollback that could bypass `haltOnStall`. The aborted
startup result lists components from that startup pass that are still running when it
returns. Consult the shutdown result for stalls and incomplete stops.

**Starting-Timed-Out State Definition:**
A component enters "starting-timed-out" when:

1. `start()` exceeds `startupTimeoutMS`
2. The manager marks the component `starting-timed-out` and treats it as not running

After an individual component timeout, this state behaves like `registered`: the component can be started again, unregistered normally, and will not be stopped during shutdown because it is not running. The state is cleared automatically on a successful start. Bulk startup deadlines follow the same recovery rules described below.

After a bulk startup deadline, restart and unregistration are allowed even if the
abandoned `start()` never settles. A late successful start is stopped automatically
only if its attempt still owns the registered component. A retry or replacement makes
the old completion stale, so it cannot stop the new run. Once automatic late cleanup
actually starts, restart and unregistration are blocked until that cleanup finishes.
These cleanup protections also apply to individual component timeouts.

Use `getStartTimedOutComponentNames()` to inspect components currently in this state.
For accounting purposes, `getStoppedComponentNames()` and `getStoppedComponentCount()` include
components in this state so that `running + stopped + stalled = total`.

When a component `start()` exceeds its `startupTimeoutMS`, the manager:

1. Marks the component state as `starting-timed-out` (for observability)
2. Treats the component as not running
3. Calls `onStartupAborted()` if the component implements it

If `onStartupAborted()` is not implemented, the timeout still applies and the
state enters `starting-timed-out`. If that delayed `start()` later completes
successfully, the manager automatically calls `stop()` to clean it up and then
returns the state to `starting-timed-out` for observability.

Any in-flight startup work may continue in the background, so components should
either keep startup side effects idempotent or implement their own cancellation
mechanism (e.g., track an abort flag, or stop/short-circuit once `stop()` is
called).

**Failed State Definition:**

A component enters "failed" when:

1. It's marked as `optional: true`, AND
2. Its `start()` method throws an error or exceeds `startupTimeoutMS`

When an optional component fails:

- The component state becomes `failed`
- It's recorded in `StartupResult.failedOptionalComponents`
- Startup **continues** with remaining components (dependents still attempt to start)
- The component can be restarted later with `startComponent(name)`

```typescript
class CacheComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'cache',
      optional: true, // Failure enters 'failed' state, doesn't stop startup
    });
  }
}

const result = await lifecycle.startAllComponents();
if (result.failedOptionalComponents.length > 0) {
  logger.warn(
    'Some optional components failed:',
    result.failedOptionalComponents.map((c) => c.name),
  );
  // Application continues running in degraded mode
}
```

**Stalled State Definition:**
A component becomes "stalled" when:

1. The graceful `stop()` method exceeds `shutdownGracefulTimeoutMS` or throws an error, AND
2. Either `onShutdownForce()` is not implemented, OR `onShutdownForce()` also fails by timing out or throwing an error

Once stalled, a component remains registered but:

- `startAllComponents()` will fail unless you pass `ignoreStalledComponents: true` (which skips stalled components during bulk startup)
- `startComponent(name)` will fail unless you pass `forceStalled: true` (which calls `start()` regardless of stalled state)

To recover: unregister the component, retry via `stopAllComponents({ retryStalled: true })` (this escalates to the force phase and does not re-run `stop()`), start non-stalled components via `startAllComponents({ ignoreStalledComponents: true })`, or force start an individual stalled component via `startComponent(name, { forceStalled: true })`. Force starting is only appropriate for components whose `start()` implementation rejects or otherwise protects against any still-running shutdown work from the previous run.

**Automatic late resolution:** If `stop()` eventually completes after the graceful timeout (e.g., a server waiting on keep-alive connections), the manager automatically clears the stall and emits `component:stalled-resolved`. No manual retry is needed. The same applies to `onShutdownForce()`: if it eventually resolves after its own timeout, the stall is cleared automatically. If neither ever completes, the stall persists until you intervene.

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

**Important:** When you mark a component as `optional: true`, it's the **component itself** that's optional (can fail without triggering rollback), NOT the dependency relationship. Other components that list it as a dependency will still attempt to start even if it fails, so those dependents must handle the missing component gracefully.

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
   - Timeout or error triggers force phase for that component

3. **Force Phase** (per-component)
   - Called if graceful `stop()` times out or throws
   - Also called (skipping graceful) when retrying a previously stalled component via `retryStalled: true`
   - Component is marked as `stalled` if force phase is not implemented, times out, or throws
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
  attachSignalsBeforeStartup?: boolean; // Auto-attach signals before startAllComponents()/startComponent() begins work, even if startup later fails (default: false)
  attachSignalsOnStart?: boolean; // Auto-attach signals when a component successfully starts and none are attached (default: false)
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
  action: 'register';
  success: boolean;
  registered: boolean;
  componentName: string;
  reason?: string;
  code?: RegistrationFailureCode;
  error?: Error;
  registrationIndexBefore: number | null;
  registrationIndexAfter: number | null;
  startupOrder: string[];
  duringStartup?: boolean; // true if registered during bulk startup
  autoStartAttempted?: boolean; // true if auto-start was attempted
  autoStartDeferred?: boolean; // true if left to a bulk startup that had not begun its loop
  autoStartSucceeded?: boolean; // true if auto-start succeeded
  startResult?: ComponentOperationResult; // result of auto-start (if attempted)
}
```

**Registration Constraints:**

- **Single Manager Binding**: A component instance can only be registered with one `LifecycleManager` at a time. Attempting to register a component instance that is already registered (either with the same manager under a different name, or with a different manager instance) will fail with `code: 'duplicate_instance'`.
- **Unique Name Constraint**: The component name must be unique within a manager instance. Registering a component with a name that is already taken will fail with `code: 'duplicate_name'`. That holds even when a component's own code registers the name while the registration is in progress, for example from `getDependencies()`: registration checks again right before it commits.
- **Bulk Operation Guard**: Registration/insertion is blocked while the manager is shutting down (`isShuttingDown = true`), failing with `code: 'shutdown_in_progress'`. During startup (`isStarting = true`), registration/insertion is only blocked when the new component is a required dependency of an already-registered component, failing with `code: 'startup_in_progress'`.

**Example:**

```typescript
const result = await lifecycle.registerComponent(new DatabaseComponent(logger));

if (!result.success) {
  console.error('Registration failed:', result.reason);
}
```

#### `insertComponentAt(component, position, targetComponentName?, options?)`

Insert a component at a specific position.

```typescript
insertComponentAt(
  component: BaseComponent,
  position: 'start' | 'end' | 'before' | 'after',
  targetComponentName?: string,
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
    index: number; // The actual registry index where the component was inserted
    description?: string; // Human-readable position description (e.g., "after database, before api")
  };
  manualPositionRespected: boolean; // Whether explicit position was honored (vs dependency-based reordering)
  targetFound?: boolean; // Whether 'before'/'after' reference component was found (always `undefined` for 'start'/'end')
}
```

**Position Debugging Fields:**

- `requestedPosition` - What you asked for (position type and optional target component)
- `actualPosition` - Where it actually ended up after dependency resolution, read when the call returns. Present when the component is still registered then - not when a listener removed it again during its auto-start
  - `index` - The registry array index (0-based)
  - `description` - Human-readable position like `"at start"`, `"at end"`, `"after database, before api"`, or `"only component"`
- `manualPositionRespected` - `true` if the explicit position was honored, `false` if dependency ordering forced a different position
- `targetFound` - For 'before'/'after' positions, indicates if the reference component was found (always `undefined` for 'start'/'end')

**Example:**

```typescript
const result = await lifecycle.insertComponentAt(
  new CacheComponent(logger),
  'before',
  'database',
);

console.log(result.actualPosition);
// { index: 2, description: "after config, before database" }
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
  forceStop?: boolean; // Allow stopping even if running dependents exist (default: false)
}
```

**Notes:**

- `forceStop` only applies when `stopIfRunning` is true (passes through to `stopComponent` as `allowStopWithRunningDependents`).
- If a component is stalled and `stopIfRunning` is true, unregister is blocked.
- While a start or stop is in flight, unregister is refused with `component_starting` / `component_stopping`: the operation writes its outcome when it settles, so the component has to be left registered until then. This is checked again after unregister's own stop, since a `component:stopped` listener may have started the component again; one that is already back up is refused with `component_running`.
- Successfully unregistering a component automatically clears its `lifecycle` reference (setting it to `undefined`) and marks it as unregistered, which allows the same component instance to be registered again (either with the same manager or with a different one).

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
  ignoreStalledComponents?: boolean; // Allow bulk startup to proceed by skipping stalled components
  timeoutMS?: number; // Startup time budget, excluding failure rollback (default: constructor's startupTimeoutMS)
}
```

**Returns:**

```typescript
interface StartupResult {
  success: boolean;
  startedComponents: string[];
  failedOptionalComponents: Array<{ name: string; error: Error }>;
  skippedDueToDependency: string[];
  blockedByStalledComponents?: string[]; // Present when stalled components blocked startup
  durationMS?: number; // Total startup duration in milliseconds
  timedOut?: boolean; // True if startup timed out
  reason?: string; // Reason for failure (when success is false)
  code?:
    | 'already_in_progress'
    | 'shutdown_in_progress'
    | 'dependency_cycle'
    | 'no_components_registered'
    | 'stalled_components_exist'
    | 'partial_state' // Some components already running
    | 'required_component_failed' // Required component failed to start
    | 'shutdown_requested_during_restart' // restartAllComponents() skipped its startup phase
    | 'signal_attach_failed' // attachSignalsBeforeStartup / attachSignalsOnStart could not attach process signals
    | 'startup_timeout'
    | 'unknown_error';
  error?: Error; // Error object (when success is false due to dependency cycle or unknown error)
}
```

**Timeout Behavior:**

Timeouts operate at **two independent levels** - they don't compete, they're layered:

Lifecycle timer delays are capped at 2,147,483,647 ms. Constructor `startupTimeoutMS`,
`messageTimeoutMS`, and `shutdownWarningTimeoutMS` use their defaults for `NaN` and
cap positive `Infinity` at that ceiling. At component/per-call timer boundaries,
non-finite or negative delays also use the ceiling rather than firing immediately.
Use the documented `0` setting to disable a timeout where supported. The warning
phase separately supports `-1` for fire-and-forget notifications.

**1. Global Timeout (Bulk Operation)**

- `startAllComponents({ timeoutMS })` sets a time budget for starting components. Failure rollback uses its own shutdown timeouts
- If exceeded: manager stops initiating new components and promptly returns a snapshot of partial results with `timedOut: true` and `code: 'startup_timeout'`.
- The remaining bulk budget also bounds the current component start, even when its own timeout is disabled. Previously started components remain running unless rollback had already begun for a separate failure.
- A start still in flight receives `onStartupAborted()` when implemented. Restart and unregistration are allowed while the abandoned start remains pending. If it later resolves and still owns the component, automatic cleanup stops it. Recovery is blocked only while that cleanup runs. A stale completion cannot stop a retry or replacement.
- Once a required failure starts rollback, the startup timer is cleared. Startup waits for rollback and returns the original failure. Another bulk startup is blocked until rollback finishes.
- Timeouts cannot preempt synchronous JavaScript that blocks the event loop.
- Constructor option sets the default: `new LifecycleManager({ startupTimeoutMS: 60000 })`
- Method parameter overrides: `await lifecycle.startAllComponents({ timeoutMS: 30000 })`

**2. Per-Component Timeout (Individual Component)**

- Each component's `startupTimeoutMS` (default 30s) controls only that component's `start()` method
- If exceeded on **required component** (default): enters `starting-timed-out` state and triggers **rollback**
- If exceeded on **optional component**: enters `failed` state and startup **continues**

**Example:**

```typescript
// Global: 60s for entire startup operation
await lifecycle.startAllComponents({ timeoutMS: 60000 });

// Required component with 5s timeout (default behavior)
class ComponentA extends BaseComponent {
  constructor() {
    super(logger, { name: 'A', startupTimeoutMS: 5000 });
  }
}

// Optional component with 5s timeout
class ComponentB extends BaseComponent {
  constructor() {
    super(logger, { name: 'B', startupTimeoutMS: 5000, optional: true });
  }
}

// If required Component A's start() takes 6 seconds:
// - Component A enters 'starting-timed-out' state (exceeded its 5s timeout)
// - Startup STOPS and rolls back all started components
// - Returns { success: false, code: 'required_component_failed', reason: '...', error: ... }
//
// If optional Component B's start() takes 6 seconds:
// - Component B enters 'failed' state (exceeded its 5s timeout)
// - Startup CONTINUES with Component C (global 60s timer still has 54s left)
// - Returns { success: true, failedOptionalComponents: [{ name: 'B', ... }] }
//
// If global 60s expires while Component C is starting:
// - Manager stops initiating new starts after timeout; current start may still run
//   until its per-component timeout (if any) elapses
// - Returns { success: false, timedOut: true, code: 'startup_timeout', startedComponents: [...], ... }
```

**More Examples:**

```typescript
// Use constructor's default timeout (60s)
await lifecycle.startAllComponents();

// Override with custom timeout (30s)
await lifecycle.startAllComponents({ timeoutMS: 30000 });

// Disable global timeout (wait indefinitely)
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
  retryStalled?: boolean; // Retry components that were previously stalled (default: true)
  haltOnStall?: boolean; // Stop processing after a component becomes stalled (default: true)
}
```

**Option Details:**

- `retryStalled`: If `true`, attempts to stop components that are currently in the `stalled` state from previous shutdown attempts. If `false`, skips components already marked as stalled. **Note:** retry goes directly to the force phase (`onShutdownForce`), not the graceful phase. `stop()` is not called again. The assumption is that graceful already had its chance, and the retry is an escalation.
- `haltOnStall`: If `true`, stops processing remaining components as soon as any component becomes stalled during _this_ shutdown. If `false`, continues attempting to stop remaining components even after a stall occurs.

**Timeout Behavior:**

Timeouts operate at **two independent levels** - they don't compete, they're layered:

**1. Global Timeout (Bulk Operation)**

- `stopAllComponents({ timeoutMS })` sets a total time budget for the entire shutdown operation
- If exceeded: the public call promptly returns partial results and releases the bulk shutdown latch. A stop already in flight continues under its component timeouts. The timed-out shutdown pass initiates no further stops. Deferred logger exits can proceed, so components are not guaranteed to finish before process exit.
- Components not yet processed are left in their current state. A later shutdown attempt will not overlap an unfinished stop or stop its dependencies while that stop remains in flight.
- Constructor option sets the default: `new LifecycleManager({ shutdownOptions: { timeoutMS: 30000 } })`. Constructor `timeoutMS: NaN` uses that 30,000ms default. A per-call `timeoutMS: NaN` retains the safety-timer maximum delay (2,147,483,647ms). Use a finite duration to bound a shutdown explicitly.
- Method parameter overrides: `await lifecycle.stopAllComponents({ timeoutMS: 5000 })`

**2. Per-Component Timeouts (Individual Component)**

- Each component's `shutdownGracefulTimeoutMS` (default 5s) and `shutdownForceTimeoutMS` (default 2s) control its individual shutdown phases
- If the graceful phase exceeds its timeout or throws, and the force phase is unavailable or also fails, that component becomes stalled. Shutdown continues with the next component unless `haltOnStall: true`

**Example:**

```typescript
// Global: 30s for entire shutdown operation
await lifecycle.stopAllComponents({ timeoutMS: 30000 });

// Component A has 3s graceful timeout
class ComponentA extends BaseComponent {
  constructor() {
    super(logger, { name: 'A', shutdownGracefulTimeoutMS: 3000 });
  }
}

// If Component A's stop() takes 4 seconds:
// - Component A becomes stalled (exceeded its 3s graceful timeout)
// - Bulk operation continues with Component B (global 30s timer still has 26s left)
//
// If global 30s expires while Component C is stopping:
// - Manager stops initiating new stops after timeout; current stop may still run
//   until its per-component timeout (if any) elapses
// - Returns { success: false, timedOut: true, stoppedComponents: ['B'], stalledComponents: [...] }
```

**More Examples:**

```typescript
// Use constructor's default timeout (30s)
await lifecycle.stopAllComponents();

// Override with custom timeout (5s)
await lifecycle.stopAllComponents({ timeoutMS: 5000 });

// Disable global timeout (wait indefinitely)
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
  code?: 'already_in_progress' | 'shutdown_timeout' | 'unknown_error';
  error?: Error; // The thrown value, when the pass itself failed (unknown_error)
}
```

**Note:** If `timedOut` is `true`, `success` will be `false` even if no components stalled.

A pass that throws outright - a bug in the manager, or a component getter that throws - resolves with `code: 'unknown_error'` and the thrown value on `error`, rather than rejecting. It still emits `lifecycle-manager:shutdown-completed` with the same result and updates `getLastShutdownResult()`, lists the components it had already stopped, and arms the escalation window like any other failed pass.

**From inside shutdown listeners:** `lifecycle-manager:shutdown-completed` and `shutdown-escalation-armed` run while the pass still holds its latch, so a call made from one returns `already_in_progress`. Defer it (`setImmediate`, `queueMicrotask`) or `await` this method's promise instead.

**Background use:** the promise never rejects, so a caller that cannot block - an HTTP handler, an event listener - can start a shutdown without awaiting it and read the outcome later. See [Running Operations in the Background](#running-operations-in-the-background). A call made while a shutdown is already running resolves at once with `already_in_progress`.

**Escalation:** calls made while a shutdown is running **never** count toward [`repeatedShutdownRequestPolicy`](#repeated-shutdown-request-policy), whatever `countManualRetriesTowardEscalation` says. Escalation represents an operator pressing Ctrl+C again; overlapping programmatic callers are not expressing that, so a burst of them can never force-kill the process. The flag only covers a deliberate retry after a failed pass: with it enabled, a call made while escalation is still armed counts once and can reach `forceAfterCount`, and the retry pass still starts. A manual call does not emit `signal:shutdown`, which describes a real OS signal; observe `lifecycle-manager:shutdown-initiated` instead.

#### `restartAllComponents(options?)`

Stop all components, then start them again.

```typescript
restartAllComponents(options?: RestartAllOptions): Promise<RestartResult>

interface RestartAllOptions {
  startupOptions?: StartupOptions;     // Options for the start phase
  shutdownTimeoutMS?: number;         // Timeout for the shutdown phase
  // Note: retryStalled and haltOnStall are hardcoded to true during restart shutdown
}
```

**Returns:**

```typescript
interface RestartResult {
  shutdownResult: ShutdownResult;
  startupResult: StartupResult;
  startupSkippedByShutdownRequest?: boolean; // Present and true when a shutdown request canceled the startup phase
  success: boolean; // True only if both phases succeeded
}
```

**Important:** `restartAllComponents` hardcodes `retryStalled: true` and `haltOnStall: true` for the shutdown phase to ensure clean restart. Only `shutdownTimeoutMS` can be customized.

**A shutdown request during the shutdown phase wins.** A `SIGINT`/`SIGTERM`, a `logger.exit()` under [`enableLoggerExitHook()`](#enableloggerexithook), or a direct `stopAllComponents()` call made while the restart is stopping asks the process to stay down, so the restart skips its startup phase instead of bringing every component back up. The result then carries `startupSkippedByShutdownRequest: true`, `startupResult.code` is `shutdown_requested_during_restart`, and `success` is `false` - the restart did not complete. This is checked before the shutdown phase's own outcome, so a stalled or failed stop phase paired with a request still reports the request. `getLastShutdownResult()` is left in place (a completed restart clears it), so the shutdown phase's outcome is still readable afterwards. Skipping startup does not stop anything the shutdown phase could not: if `shutdownResult.success` is `false` - a stall or a timeout - some components may still be running, exactly as after any failed shutdown.

**A shutdown phase that throws outright** resolves the restart rather than rejecting it: `shutdownResult` carries the pass's `unknown_error` result, and the startup phase is skipped - with `startupResult.code` also `unknown_error` - since nothing can be said about the state the components were left in.

Only the restart that actually runs the shutdown phase can be cancelled this way. A `restartAllComponents()` call made while a shutdown is already running - including one started by another restart - has its own shutdown phase refused with `already_in_progress` and then gets whatever `startAllComponents()` answers, usually `shutdown_in_progress`; it never reports `startupSkippedByShutdownRequest`, and it does not disturb the restart whose shutdown phase is running. The reverse holds too: every restart that does run a shutdown phase is cancellable on its own terms, including one that starts in the moment between a previous pass finishing and the restart that owned it resuming.

```typescript
const result = await lifecycle.restartAllComponents();

if (result.startupSkippedByShutdownRequest) {
  // Something asked us to shut down mid-restart, so nothing was started again.
  if (!result.shutdownResult.success) {
    // The shutdown phase stalled or timed out: some components may still be running.
    console.warn('Restart cancelled with components still running');
  }

  return;
}
```

A request that arrives during the restart's _startup_ phase aborts that startup instead: the request starts a real shutdown pass, and `startupResult.code` is `shutdown_in_progress`.

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
  allowNonRunningDependencies?: boolean; // Allow start with non-running registered deps (missing deps still fail)
  forceStalled?: boolean; // Force starting a stalled component
  allowDuringBulkStartup?: boolean; // Allow starting during startAllComponents() (default: false)
  // Normally blocked to prevent race conditions with dependency ordering.
  // Only needed for dynamic mid-startup registration. Most users never need this option.
}
// A dependency counts as running only while it is up: one that is stopping or
// force-stopping is not, and a start on it fails with 'dependency_not_running' unless
// the dependency is optional or allowNonRunningDependencies is set. A dependency that
// goes down while the start reads the component's own getters is held to required.

interface StopComponentOptions {
  forceImmediate?: boolean; // Skip graceful phase, go straight to force
  timeout?: number; // Override default timeout
  allowStopWithRunningDependents?: boolean; // Allow stopping despite running dependents (default: false)
}

// Note: Individual component stops skip the global warning phase. Only bulk shutdown operations
// include the onShutdownWarning() callback.

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

**Overlapping operations:** `startComponent()` refuses to run alongside the same component's other lifecycle work. A start already underway returns `component_already_starting`; a stop still in flight returns `component_already_stopping`. This holds even after a global shutdown timeout has already returned: `stopAllComponents()` settles at its deadline while a component's `stop()` or `onShutdownForce()` may still be running, and per-component state keeps the overlap blocked until that work finishes.

Both codes are an immediate refusal: the call returns `success: false` without waiting for the in-flight operation to settle, and it does not start the component once that work finishes. To wait for a component to become startable again, poll `getComponentStatus(name).state` until it leaves `stopping` / `force-stopping`, then start it. `component:stopped` and `component:stalled` (recoverable with `forceStalled: true`) are useful prompts to re-check, but confirm with the state rather than relying on either event arriving. To make concurrent callers of your own `start()` / `stop()` implementations share a single in-flight promise, see [Best Practice #7](#7-make-component-startup-idempotent-and-coordinate-with-shutdown). The manager only guards its own invocations, so that pattern is still required for the force phase, where `onShutdownForce()` runs concurrently with an unfinished `stop()` by design.

### Component Messaging

Message, health, and value result code `stopped` means unavailable and not stalled. It does not identify the exact lifecycle state. Use `getComponentStatus(name).state` to distinguish registered, starting, failed, and stopped components. `includeStopped` permits handlers on inactive components, but never during active startup, a timed-out startup, or teardown.

#### `sendMessageToComponent(componentName, payload, options?)`

Send a message to a specific component.
By default, only running components receive messages, so use `includeStopped`/`includeStalled` to override. During bulk shutdown, components still running can receive messages until their own teardown begins. Messages remain blocked during `starting`, `starting-timed-out`, `stopping`, and `force-stopping`, even with these overrides or after the bulk shutdown timeout. Messages refused during teardown return `code: 'stopped'` and `error: null`. Missing targets return `not_found`.

```typescript
sendMessageToComponent<T = unknown>(
  componentName: string,
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
import { isPlainObject } from 'lifecycleion/is-plain-object';

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
By default, only running components receive messages, so use `includeStopped`/`includeStalled` to override. During bulk shutdown, components still running can receive messages until their own teardown begins. Messages remain blocked during `starting`, `starting-timed-out`, `stopping`, and `force-stopping`, even with these overrides or after the bulk shutdown timeout. Messages refused during teardown return `code: 'stopped'` and `error: null`.
When `componentNames` is provided, only those targets are considered, and stopped/stalled targets are reported but not sent unless explicitly included.

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

Health hooks are skipped during `stopping` and `force-stopping`, and the result is unhealthy, including after a bulk shutdown timeout.

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
  error?: Error; // Set when the check itself failed unexpectedly
}
```

### Value Sharing

Components can share values with each other. **By default, only running components can provide values.** Use the `includeStopped` or `includeStalled` options to retrieve values from components in other states. Value requests remain blocked during `starting`, `starting-timed-out`, `stopping`, and `force-stopping`, even with these overrides or after the bulk shutdown timeout.

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

`getValue()` is synchronous and never throws. A component's own `getValue()` handler that throws resolves as `code: 'error'`, and so does an unexpected failure in the lookup itself, which also carries the thrown value on `error` and is reported on the global `'error'` channel.

### Signal Integration

#### `attachSignals()`

Attach process signal handlers manually.

```typescript
attachSignals(): void
```

**Signals:**

- **SIGINT, SIGTERM, SIGTRAP** - Trigger `stopAllComponents()`
- **SIGHUP, R key** - Trigger reload (calls `onReload()` on components or custom callback)
- **SIGUSR1, I key** - Trigger info (custom callback or warning)
- **SIGUSR2, D key** - Trigger debug (custom callback or warning)

If `attachSignalsBeforeStartup` is enabled, handlers are auto-attached before
`startAllComponents()` or `startComponent()` begins work, so the startup window
is covered even if startup fails. If attaching fails, the start is refused with
`code: 'signal_attach_failed'` before any work begins.

If `attachSignalsOnStart` is enabled, handlers are auto-attached when a
component successfully starts and none are attached. If attaching fails, that component is stopped
again and its start fails with `code: 'signal_attach_failed'` - a process
configured to handle signals does not stay up without them. In
`startAllComponents()` that fails the whole startup with the same code and
rolls it back, whether or not the component is optional.

If `detachSignalsOnStop` is enabled, currently attached handlers are detached
when the last running component stops, whether they were attached manually or
automatically. If startup fails before anything is running, handlers attached
via `attachSignalsBeforeStartup` are detached during startup cleanup. Handlers
stay attached while any component is stalled - a stalled component is not
counted as running, but Ctrl+C is how the operator retries or forces it - and
come off once the last stall clears: by a later stop, by the original `stop()`
or `onShutdownForce()` finishing late, or by unregistering it. They also stay
while anything is still in flight - a startup or shutdown, a component starting
or stopping - and come off once it ends, if nothing is left. A clean
`stopAllComponents()` detaches them before it emits
`lifecycle-manager:shutdown-completed`; a failed one keeps them, so the next
Ctrl+C still reaches escalation.

#### `detachSignals()`

Detach all signal handlers.

```typescript
detachSignals(): void
```

#### `getSignalStatus()`

Get detailed status information about signal handling configuration.

```typescript
getSignalStatus(): LifecycleSignalStatus
```

**Returns:**

```typescript
interface LifecycleSignalStatus {
  isAttached: boolean;
  handlers: {
    shutdown: boolean;
    reload: boolean;
    info: boolean;
    debug: boolean;
  };
  listeningFor: {
    shutdownSignals: boolean;
    reloadSignal: boolean;
    infoSignal: boolean;
    debugSignal: boolean;
    keypresses: boolean;
  };
  shutdownMethod: ShutdownMethod | null;
}
```

**Example:**

```typescript
const status = lifecycle.getSignalStatus();

if (status.isAttached) {
  console.log('Signal handlers attached');
  console.log(
    'Listening for shutdown signals:',
    status.listeningFor.shutdownSignals,
  );
  console.log('Listening for reload signal:', status.listeningFor.reloadSignal);
}
```

#### `getShutdownEscalationStatus()`

```typescript
getShutdownEscalationStatus(): ShutdownEscalationStatus
```

Returns a read-only snapshot of repeated shutdown escalation configuration and runtime state.

```typescript
type ShutdownEscalationStatus =
  | {
      configured: false;
      isShuttingDown: boolean;
      isArmed: false;
      forceAfterCount: null;
      withinMS: null;
      armedAfterFailureMS: null;
      armedAfterFailureMSSource: null;
      requestCount: 0;
      firstMethod: null;
      latestMethod: null;
      firstRequestAt: null;
      latestRequestAt: null;
      repeatedWindowStartedAt: null;
      armedUntil: null;
      hasTriggeredForceShutdown: false;
    }
  | {
      configured: true;
      isShuttingDown: boolean;
      isArmed: boolean;
      forceAfterCount: number;
      withinMS: number;
      armedAfterFailureMS: number;
      armedAfterFailureMSSource: 'explicit' | 'derived';
      countManualRetriesTowardEscalation: boolean;
      requestCount: number;
      firstMethod: ShutdownMethod | null;
      latestMethod: ShutdownMethod | null;
      firstRequestAt: number | null;
      latestRequestAt: number | null;
      repeatedWindowStartedAt: number | null;
      armedUntil: number | null;
      hasTriggeredForceShutdown: boolean;
    };
```

When consuming this in TypeScript, check `configured` first so the union narrows cleanly before reading enabled-only fields such as `forceAfterCount` or `countManualRetriesTowardEscalation`.

**Example:**

```typescript
const escalation = lifecycle.getShutdownEscalationStatus();

if (escalation.configured && escalation.isArmed) {
  console.log('Shutdown escalation is armed until:', escalation.armedUntil);
  console.log('Current escalation count:', escalation.requestCount);
}
```

#### Manual Signal Triggers

Reload/info/debug broadcasts check that each component is still running immediately before invoking its handler. Components that begin teardown during an earlier callback are skipped. A synchronous signal-started event that makes its target unavailable produces a per-component `unavailable` result. An already-running signal handler is not cancelled by teardown.

```typescript
triggerReload(): Promise<SignalBroadcastResult>
triggerInfo(): Promise<SignalBroadcastResult>
triggerDebug(): Promise<SignalBroadcastResult>
```

**Note:** For programmatic shutdown, use [`stopAllComponents()`](#stopallcomponentsoptions). It returns a `ShutdownResult`, and it is safe to start without awaiting - see [Running Operations in the Background](#running-operations-in-the-background).

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

#### Repeated Shutdown Request Policy

Use `repeatedShutdownRequestPolicy` when you want repeated shutdown requests
during an already-running shutdown to escalate into application-defined behavior.

Terminology used below:

- **Escalation state** is the logical repeated-shutdown context for one shutdown cycle
- **Armed window** is the short post-failure period after an unsuccessful shutdown returns, before the next retry starts
- During an active retry, the escalation state is still preserved, but the armed window is not active because shutdown is running again
- A `restartAllComponents()` stop phase does not start an escalation cycle of its own. The first shutdown signal during it is the operator's initial request: it cancels the restart and starts the cycle (`firstMethod` is that signal) without being counted. Signals after it count as presses, as they would against any running shutdown. A restart whose stop phase fails with no signal leaves nothing armed

This applies to shutdown requests from:

- OS signals
- Keyboard shortcuts such as `Escape` and `Ctrl+C`
- Programmatic signal-style shutdown requests such as `ProcessSignalManager.triggerShutdown()`

```typescript
const lifecycle = new LifecycleManager({
  logger,
  repeatedShutdownRequestPolicy: {
    forceAfterCount: 3, // default
    withinMS: 2000, // default
    armedAfterFailureMS: 6000, // optional override; default is withinMS * forceAfterCount
    countManualRetriesTowardEscalation: false, // default
    onForceShutdown: ({
      requestCount,
      firstMethod,
      latestMethod,
      isShuttingDown,
      wasArmedAfterFailure,
    }) => {
      logger.warn('Force shutdown requested', {
        params: {
          requestCount,
          firstMethod,
          latestMethod,
          isShuttingDown,
          wasArmedAfterFailure,
        },
      });

      process.exit(1);
    },
  },
});
```

**How counting works:**

- The first shutdown request starts graceful shutdown but does not count toward the force threshold
- That first request still arms the escalation state with an effective escalation count of `0`
- Additional shutdown requests received while shutdown is still in progress are treated as escalation requests
- By default, only signal-style shutdown requests count toward escalation
- Manual `stopAllComponents()` retries start a fresh escalation cycle unless `countManualRetriesTowardEscalation` is enabled
- A shutdown request made from inside `onForceShutdown()` or a `lifecycle-manager:shutdown-escalation-forced` listener is treated as a continuation of the request that fired it, not as a new one, so it is never counted again
- Escalation requests are counted inside a `withinMS` window
- If a new escalation request arrives more than `withinMS` after the first escalation request in the current window, a new escalation window starts
- `onForceShutdown()` fires once per escalation state when the count reaches `forceAfterCount`

**Important reset behavior:**

- The repeated-request counter belongs to one active escalation state
- If shutdown completes successfully, the repeated-request state resets immediately
- If shutdown completes unsuccessfully, times out, or leaves stalled components behind, escalation stays armed briefly so follow-up shutdown requests can continue the same force count
- That post-failure armed period defaults to `withinMS * forceAfterCount`, or uses `armedAfterFailureMS` when explicitly configured. The effective duration is capped at 2,147,483,647 ms to match the timer limit
- A shutdown request received during that armed period continues the same escalation state and starts a fresh shutdown attempt
- While that retry is running, the armed timer is no longer active because shutdown is in progress again
- If the retry also finishes unsuccessfully, the manager re-arms the post-failure window so follow-up requests can continue the same escalation state
- It also resets on a fresh `startAllComponents()`
- A later `stopAllComponents()` attempt only continues the same escalation state when `countManualRetriesTowardEscalation` is `true`
- Once the armed period expires, or shutdown/startup later succeeds, the next escalation state starts fresh

**Stalled shutdown behavior:**

- The policy can still escalate while shutdown is stalled or still waiting on component timeouts
- This is intentional: repeated shutdown requests are meant to express stronger operator intent during a hanging shutdown
- If `stopAllComponents()` returns unsuccessfully, the escalation state remains armed briefly so quick follow-up signal presses still count
- Manual retry attempts only keep counting during that armed period when `countManualRetriesTowardEscalation` is enabled
- A follow-up signal during that armed period retries shutdown immediately instead of being treated as telemetry-only
- Once that armed period expires, or a later shutdown/startup succeeds, the old escalation state is cleared

**Example timeline (`forceAfterCount: 3`, `withinMS: 2000`):**

- `t=0ms`: first shutdown request arrives, graceful shutdown starts
- `t=5000ms`: second shutdown request arrives, escalation count = `1`
- `t=6500ms`: third shutdown request arrives within 2000ms of the previous escalation window start, escalation count = `2`
- `t=7000ms`: fourth shutdown request arrives within that same window, escalation count = `3`, `onForceShutdown()` fires

If instead the fourth request arrived at `t=8000ms`, the escalation window would reset there and the escalation count would start over from `1`.

**Post-failure retry example (`forceAfterCount: 3`, `withinMS: 2000`):**

- `t=0ms`: first shutdown request arrives, graceful shutdown starts
- `t=3000ms`: shutdown returns unsuccessfully, so the post-failure armed window opens briefly
- `t=3500ms`: another shutdown signal arrives during that armed window
- That signal increments the same escalation state and immediately starts a new shutdown attempt
- While that retry is running, the armed window itself is no longer active
- If the retry also returns unsuccessfully, the manager opens a new armed window so later requests can continue the same escalation state

**Design note:**

- `onForceShutdown()` is application-defined on purpose
- The LifecycleManager detects repeated requests, but your app decides what "force" means
- Common choices include final logging, telemetry flush, `logger.exit()`, or `process.exit()`
- `isShuttingDown` in the callback context is `true` when force escalation fires during an active shutdown (the normal path: operator pressed the shutdown signal multiple times while `stopAllComponents()` was running). It is `false` when escalation fires from the post-failure armed window (a previous shutdown returned unsuccessfully and the manager kept escalation armed briefly, and no shutdown is actively running when the callback fires)
- `wasArmedAfterFailure` is `true` in the post-failure case above and `false` during an active shutdown. Use this flag to distinguish the two paths if your handler needs to know whether it must start a new shutdown or assume one is already underway

**Escalation events:**

- `lifecycle-manager:shutdown-escalation-armed` means a failed/timed-out shutdown left a short-lived escalation window open
- `lifecycle-manager:shutdown-escalation-expired` means that armed window elapsed and the old escalation state was cleared
- `lifecycle-manager:shutdown-escalation-forced` means the repeated-request threshold was crossed and the manager invoked `onForceShutdown()`
- The `forced` event does **not** guarantee that the process exited. It only means the force callback was dispatched

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
- An exit that lands while a shutdown is already running waits for it rather than starting a second pass - and if that shutdown is a [`restartAllComponents()`](#restartallcomponentsoptions) stop phase, it cancels the restart's startup phase, so nothing is started again behind the exit
- **Exit behavior depends on logger configuration:** `logger.exit()` only calls `process.exit()` when the logger is created with `callProcessExit: true` (default). Test-optimized and frontend-optimized loggers disable process exit.

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
// The shutdown-completed payload has timedOut: true, then exit proceeds.
```

**Important Notes:**

- This method is idempotent (can be called multiple times safely)
- Overwrites any existing `beforeExit` callback on the logger
- If you need custom exit logic, set it up manually with `logger.setBeforeExitCallback()`
- If `logger.exit()` is called while shutdown is already in progress, that exit call returns `{ action: 'wait' }` instead of exiting immediately.
- The first such `logger.exit()` call is kept pending and allowed to proceed when the in-flight shutdown completes or reaches its global timeout.
- Later duplicate `logger.exit()` calls during the same shutdown also return `{ action: 'wait' }`, but are otherwise ignored so they cannot override the pending exit code or exit early.

#### Process Exit Design & Rationale

By default, `LifecycleManager` does **not** call `process.exit()` during signal-triggered shutdowns (such as `SIGINT` or `SIGTERM`). Instead, it relies on the Node.js event loop naturally emptying once all components have stopped.

This design choice has two primary benefits:

- **Resource Leak Detection**: If a component's `stop()` method fails to clean up properly (e.g., leaves a database connection pool open, fails to close an HTTP server, or leaves an active interval running), the process will hang. This surfaces resource leaks during development and testing that would otherwise be masked by a forced exit.
- **Multi-App Integration Testing**: In testing environments where multiple simulated application instances run in a single process, calling `process.exit()` in one manager would terminate the entire test runner. Leaving process termination to the host allows clean multi-lifecycle execution.

If you want the process to exit automatically:

- **Via signals**: Handle the exit explicitly in the application entrypoint by listening to the `lifecycle-manager:shutdown-completed` event (e.g., calling `logger.exit(0)` or `process.exit(0)`).
- **Via logger hooks**: Enable logger exit hook integration (`enableLoggerExitHook: true`). When enabled, calling `logger.exit()` or logging a fatal error with `exitCode` will trigger `LifecycleManager` to stop all components first, and then delegate back to the logger to proceed with its configured exit behavior (respecting any overrides like `callProcessExit: false`). See [Exit Behavior in docs/logger.md](logger.md#exit-behavior) for details on configuring simulated exits.
- **Via repeated signals (Ctrl+C escalation)**: Configure `repeatedShutdownRequestPolicy.onForceShutdown` to call `logger.exit(1)` or `process.exit(1)` when the threshold (like multiple Ctrl+C presses) is crossed. With `enableLoggerExitHook`, a `logger.exit()` made synchronously from `onForceShutdown` - before any `await` - proceeds at once instead of waiting for the running shutdown; one made later is deferred like any exit during a shutdown.

#### Logger Requirements

The LifecycleManager requires a Logger instance that implements the Lifecycleion logger interface. This Logger provides:

- **Structured logging** with message templates and parameters
- **Service scoping** via `logger.service(name)` for component-specific logs
- **Entity scoping** for logging with entity context
- **Process exit integration** via `logger.exit()` and `beforeExit` callbacks
- **Multiple log levels**: error, warn, info, success, notice, debug, raw

**Creating a Logger:**

The Logger class is part of the Lifecycleion package. Basic usage:

```typescript
import { Logger } from 'lifecycleion/logger';

const logger = new Logger({
  // Logger configuration options
});

// Create LifecycleManager with the logger
const lifecycle = new LifecycleManager({
  logger,
  name: 'my-app',
});
```

**Logger Interface Used by Components:**

Components receive a scoped logger service via `logger.service(componentName)` which provides:

- `logger.info(message, options?)` - Informational messages
- `logger.error(message, options?)` - Error messages
- `logger.warn(message, options?)` - Warning messages
- `logger.success(message, options?)` - Success messages
- `logger.debug(message, options?)` - Debug messages
- `logger.entity(name)` - Create entity-scoped logger

**Message Templates:**

Log messages support `{{key}}` template syntax for embedding param values inline. This is useful in component `start()`/`stop()` implementations so errors are visible in any log output without needing a structured sink:

```typescript
async start() {
  try {
    await this.db.connect();
  } catch (error) {
    const err = toError(error);

    this.logger.error('Failed to connect: {{error.message}}', {
      params: { error: err },
    });
    // → "Failed to connect: Connection refused"
  }
}
```

Normalizing the caught value with [`toError`](./to-error.md) ensures `{{error.message}}` always resolves to a string - without it, a thrown string or plain object would produce `(null)` in the output. Libraries and native APIs occasionally throw non-`Error` values.

Use `toError` rather than hand-rolling `error instanceof Error ? error : new Error(String(error))`: both halves of that idiom can throw. `instanceof` walks a prototype chain, which a revoked `Proxy` refuses, and `String()` invokes `toString`/`Symbol.toPrimitive` - on a value created with `Object.create(null)` it raises a `TypeError` of its own, from the line that was only trying to normalize an error. `toError` guards both and keeps the original on `cause`.

The normalized `err` is also captured in `params` for structured sinks that need the full error object or stack trace. Because the pattern only wraps non-`Error` values, original `Error` stack traces are preserved when the thrown value was already an `Error`.

**Note:** The LifecycleManager itself logs `error.message` inline when component lifecycle methods fail (e.g., `start()` throwing, shutdown errors). Avoid including sensitive details like connection strings or credentials in error messages thrown from lifecycle methods, as they will appear in plain log output.

**A logger that fails cannot fail a lifecycle operation.**

The logger is yours, so every line the manager writes runs code it does not own - inside OS signal handlers, timer callbacks, floating promise chains, and the middle of a startup or shutdown pass. The manager wraps its own service logger once, at construction, so this holds for every operation, not just for a particular path:

- **A log method that throws, or that returns a rejecting promise, cannot fail or derail the operation that was logging.** Startup, shutdown, restart, and every per-component operation carry on and return their normal result. Before this, a throw inside the shutdown stop loop rejected the pass, leaving the components it had not reached running and every `lifecycle-manager:shutdown-completed` listener waiting on a pass that was already over. The guard keeps a logger failure off the pass's failure path in the first place, so it is not reported as a failed shutdown either.
- **`logger.entity(name)` is covered too.** If `entity()` itself throws, the chain still gets something callable back - the line lands under the service name, without the entity scope.
- **Failures are reported on the global `'error'` channel**, never back through the logger that just failed. See [safe-handle-callback](./safe-handle-callback.md). The report names the logger method (for example `lifecycle-manager logger.warn`) and carries the original failure on `cause`. Listen with `globalThis.addEventListener('error', handler)` and call `event.preventDefault()` to claim it.
- **Your logger object is never wrapped or modified.** `rootLogger` stays the exact instance you passed in: `enableLoggerExitHook()`, `logger.exit()`, and the scoped logger every component builds all go through your object unchanged. Only the manager's own internal logging is guarded.

This is a containment guarantee, not a repair: a logger that throws still loses those lines. It is worth fixing the logger.

### Status and Query Methods

#### Component Existence and State

**`hasComponent(name: string): boolean`**

Check if a component is registered.

```typescript
if (lifecycle.hasComponent('database')) {
  console.log('Database component is registered');
}
```

**`isComponentRunning(name: string): boolean`**

Check if a component is currently running.

```typescript
if (lifecycle.isComponentRunning('cache')) {
  // Use cache
} else {
  // Fallback behavior
}
```

**`getComponentStatus(name: string): ComponentStatus | undefined`**

Get detailed status for a specific component. Returns `undefined` if component not found.

```typescript
const status = lifecycle.getComponentStatus('web-server');
if (status) {
  console.log('State:', status.state); // 'running', 'stopped', etc.
  console.log('Started at:', status.startedAt);
  console.log('Stopped at:', status.stoppedAt);
  console.log('Last error:', status.lastError);
  console.log('Stall info:', status.stallInfo);
}
```

**`getComponentInstance(name: string): BaseComponent | undefined`**

Get the raw component instance. Returns `undefined` if component not found.

```typescript
const dbComponent = lifecycle.getComponentInstance('database');

if (dbComponent) {
  // Access component metadata
  console.log('Component name:', dbComponent.getName());
  console.log('Dependencies:', dbComponent.getDependencies());
  console.log('Is optional:', dbComponent.isOptional());
}
```

**Warning:** Direct access to component instances should be used carefully. Prefer using the manager's API methods for lifecycle operations (start, stop, messaging, etc.) to maintain proper state management. This method is primarily useful for reading component metadata (name, dependencies, optional flag).

#### Lists and Counts

**`getComponentNames(): string[]`**

Get names of all registered components.

**`getRunningComponentNames(): string[]`**

Get names of all currently running components (excludes stalled).

**`getComponentCount(): number`**

Get total number of registered components.

**`getRunningComponentCount(): number`**

Get number of currently running components (excludes stalled).

**`getStalledComponentCount(): number`**

Get number of stalled components (failed to stop during shutdown).

**`getStoppedComponentCount(): number`**

Get number of stopped components. Includes components in `starting-timed-out` state for accounting purposes (since they're not running).

**`getStartTimedOutComponentCount(): number`**

Get number of components in `starting-timed-out` state (exceeded startup timeout).

**`getAllComponentStatuses(): ComponentStatus[]`**

Get detailed status for all registered components.

```typescript
const statuses = lifecycle.getAllComponentStatuses();
for (const status of statuses) {
  console.log(`${status.name}: ${status.state}`);

  if (status.error) {
    console.error(`  Error: ${status.error.message}`);
  }
}
```

#### System State

**`getSystemState(): SystemState`**

Get the current system state (see SystemState Values below).

**`getStatus(): LifecycleManagerStatus`**

Get comprehensive manager status including counts and component lists (see LifecycleManagerStatus below).

```typescript
const status = lifecycle.getStatus();
console.log('System state:', status.systemState);
console.log('Running:', status.counts.running);
console.log('Stalled:', status.counts.stalled);
```

**SystemState Values:**

`getSystemState()` returns one of the following states:

- `'no-components'` - No components registered
- `'ready'` - Components registered, none running
- `'starting'` - `startAllComponents()` in progress
- `'running'` - Components are running (all or some)
- `'stalled'` - Some components failed to stop (stuck running)
- `'shutting-down'` - `stopAllComponents()` in progress

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
    startTimedOut: number;
  };
  components: {
    registered: string[];
    running: string[];
    stopped: string[];
    stalled: string[];
    startTimedOut: string[];
  };
}
```

**Note:** `counts.stopped` and `components.stopped` include `startTimedOut` components.

**Note:** `components.running` excludes stalled components. `components.stopped` excludes both running and stalled (use `components.stalled` or `getStalledComponents()` for those).

**Definition:** `stopped` = registered − running − stalled.

**`getStalledComponents(): ComponentStallInfo[]`**

Get detailed information about stalled components.

```typescript
const stalled = lifecycle.getStalledComponents();
for (const info of stalled) {
  console.error(`Stalled: ${info.name}`);
  console.error(`  Reason: ${info.reason}`);
  console.error(`  At: ${new Date(info.stalledAt)}`);
}
```

**`getStalledComponentNames(): string[]`**

Get names of stalled components.

**`getStoppedComponentNames(): string[]`**

Get names of stopped components (includes `starting-timed-out` state).

**`getStartTimedOutComponentNames(): string[]`**

Get names of components in `starting-timed-out` state.

**`getLastShutdownResult(): ShutdownResult | null`**

Get the result of the last `stopAllComponents()` call. Returns `null` if no shutdown has occurred yet or after a successful `restartAllComponents()`.

```typescript
const lastShutdown = lifecycle.getLastShutdownResult();
if (lastShutdown && lastShutdown.stalledComponents.length > 0) {
  console.error('Previous shutdown had stalled components:');
  for (const stalled of lastShutdown.stalledComponents) {
    console.error(`  - ${stalled.name}: ${stalled.reason}`);
  }
}
```

**Use cases:**

- Debugging shutdown issues
- Tracking stalled components across restarts
- Collecting shutdown metrics
- Recovery decision-making

#### Dependencies

**`getStartupOrder(): StartupOrderResult`**

Get the computed startup order based on dependencies.

```typescript
interface StartupOrderResult {
  success: boolean;
  startupOrder: string[]; // Resolved dependency order (empty array if !success)
  reason?: string; // Human-readable explanation when !success
  code?: StartupOrderFailureCode; // 'dependency_cycle' | 'unknown_error'
  error?: Error; // Error object (present for dependency_cycle and unknown_error)
}
```

**Example:**

```typescript
const order = lifecycle.getStartupOrder();

if (order.success) {
  console.log('Startup order:', order.startupOrder);
} else {
  console.error('Cannot compute order:', order.reason);

  if (order.code === 'dependency_cycle') {
    console.error('Cycle detected:', order.error);
  }
}
```

**`validateDependencies(): DependencyValidationResult`**

Validate the dependency graph for missing dependencies and circular cycles

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
  unreadableDependencies: Array<{ componentName: string; error: Error }>; // getDependencies() threw or returned a non-array or non-string entry (a throwing isOptional() is read as required, not listed)
  summary: {
    totalMissingDependencies: number; // Total number of missing dependencies across all components
    requiredMissingDependencies: number; // Missing dependencies on required components (blocks startup)
    optionalMissingDependencies: number; // Missing dependencies on optional components (degrades functionality)
    totalCircularCycles: number; // Number of circular dependency cycles detected
    totalUnreadableDependencies: number; // Number of unreadableDependencies entries
  };
}
```

**Summary Fields Explained:**

- `totalMissingDependencies`: Count of all missing dependency declarations (sum of required + optional)
- `requiredMissingDependencies`: Missing dependencies that will prevent startup (required components depending on non-existent components)
- `optionalMissingDependencies`: Missing dependencies that won't block startup but indicate configuration issues
- `totalCircularCycles`: Number of dependency cycles detected (each cycle prevents startup)

**Example:**

```typescript
const validation = lifecycle.validateDependencies();

console.log(`Valid: ${validation.valid}`);
console.log(`Missing: ${validation.summary.totalMissingDependencies} total`);
console.log(
  `  - ${validation.summary.requiredMissingDependencies} blocking startup`,
);
console.log(
  `  - ${validation.summary.optionalMissingDependencies} non-blocking`,
);
console.log(`Circular cycles: ${validation.summary.totalCircularCycles}`);

if (!validation.valid) {
  // Detailed breakdown available in missingDependencies and circularCycles arrays
}
```

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
  shutdownGracefulTimeoutMS?: number; // Graceful shutdown timeout in ms (default: 5000, minimum: 1000)
  // Values below 1000ms are silently raised to 1000ms to ensure reasonable cleanup time
  shutdownForceTimeoutMS?: number; // Force shutdown timeout in ms (default: 2000, minimum: 500)
  // Values below 500ms are silently raised to 500ms to prevent abrupt termination
  healthCheckTimeoutMS?: number; // Health check timeout in milliseconds (default: 5000, 0 = disabled)
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

// Optional: Called for force shutdown if graceful shutdown times out or throws
onShutdownForce?(): Promise<void> | void;

// Optional: Called if onShutdownForce() times out
onShutdownForceAborted?(): void;
```

**Shutdown contract:** `stop()` should always eventually settle (resolve or reject) on every path. If you implement `onShutdownForce()`, it should also eventually settle. In many components, `onShutdownForce()` should not start a completely separate shutdown flow. Instead, it should help the in-flight `stop()` finish or await the same underlying stop work.

**Important:** `onShutdownWarning()` is only fired during bulk shutdowns via `stopAllComponents()` or `restartAllComponents()`. Individual `stopComponent()` calls do NOT trigger the warning phase. There is no built-in "warning cleared" event, so if shutdown is canceled or stalls, reset any warning state on the next successful `start()` or via an app-specific signal.

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
// from: component name when sent from another component, null when sent from manager/external

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

// Simple boolean (automatically wrapped by manager)
return true; // Automatically wrapped to { healthy: true, message: undefined, details: undefined }
return false; // Wrapped to { healthy: false, message: undefined, details: undefined }
```

**Note:** Boolean returns are automatically normalized to `ComponentHealthResult` format by the manager. Return result rich objects directly for more detailed health information.

### Value Sharing

```typescript
// Optional: Provide values to other components
getValue?<T>(key: string, from: string | null): ComponentValueResult<T>;
```

### Reporting Unexpected Stops

If a component stops on its own, such as a crashed server, a lost database connection, or a worker thread that exited, call `reportUnexpectedStop()` so the manager can update its state, emit `component:unexpected-stop`, and then emit the canonical `component:stopped` event for the resulting stopped state:

```typescript
class ServerComponent extends BaseComponent {
  private server?: http.Server;
  private stopping = false;
  private serverError?: Error;

  async start() {
    const reportUnexpectedStop = this.getUnexpectedStopReporter();
    this.stopping = false;
    this.serverError = undefined;
    this.server = http.createServer(this.handler);
    this.server.listen(8080);

    this.server.on('error', (err) => {
      // 'error' isn't always fatal (e.g. a transient socket error may leave the
      // server still listening). Store it so 'close' can report it with context.
      this.serverError = err;
    });

    this.server.on('close', () => {
      // 'close' is the definitive "server stopped" signal. Guard with the
      // stopping flag so it only fires when the manager didn't ask us to stop.
      if (!this.stopping) {
        reportUnexpectedStop(
          this.serverError ?? new Error('Server closed unexpectedly'),
        );
      }
    });
  }

  async stop() {
    this.stopping = true;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
```

The `component:unexpected-stop` event gives callers a single place to decide what to do, such as restart, escalate, or shut everything down. `component:stopped` follows immediately afterward so generic "component is now stopped" listeners still work for this path. If you call `stopAllComponents()` in response, the already-stopped component is skipped naturally (it's no longer running), and the rest of the shutdown proceeds in normal dependency order. The error passed to `reportUnexpectedStop()` is stored as `lastError` on the component's status and remains visible after shutdown. For async listeners registered in `start()`, prefer `getUnexpectedStopReporter()` as shown above so callbacks from an older run become a no-op after restart. `reportUnexpectedStop()` remains useful for immediate or synchronous detection paths. Both return `true` if the manager accepted the signal for the current run, otherwise `false`.

If a component reports an unexpected stop while `startAllComponents()` is still in progress, the startup attempt is reconciled before completion: a required component causes bulk startup to fail with `code: 'component_unexpected_stop'` and triggers rollback of any later-started components, while a stopped optional component is recorded in `failedOptionalComponents` and startup continues.

### Component Properties

```typescript
// Access component metadata
getName(): string
getDependencies(): string[]
isOptional(): boolean

// Get this component's own status from the manager (no need to pass name)
// Returns undefined if the component is not registered
// Check status?.state === 'running' to test if currently running
protected getSelfStatus(): ComponentStatus | undefined

// Capture a run-scoped callback for async listeners created during start()
// The returned function becomes a no-op after stop, unregister, or restart
// Returns true if the signal was accepted for the current run
protected getUnexpectedStopReporter(): (error?: Error) => boolean

// Report an unexpected stop directly for immediate or synchronous detection paths
// Returns true if the signal was accepted for the current run
protected reportUnexpectedStop(error?: Error): boolean

// Logger (pre-configured with component name)
protected logger: LoggerService

// Lifecycle manager reference (for advanced usage)
protected lifecycle: ComponentLifecycleRef
```

**Component Lifecycle Reference:**

Components have access to a `lifecycle` property that provides a restricted view of the LifecycleManager. This allows components to interact with other components at runtime:

```typescript
class ApiComponent extends BaseComponent {
  async start() {
    // Check if optional dependency is running
    if (this.lifecycle.isComponentRunning('cache')) {
      // Get value from cache component
      const result = this.lifecycle.getValue('cache', 'instance');

      if (result.found) {
        this.cache = result.value;
      }
    }

    // Send message to another component
    await this.lifecycle.sendMessageToComponent('metrics', {
      event: 'api-started',
      timestamp: Date.now(),
    });
  }
}
```

**Available methods through `lifecycle`:**

- **Event listeners**: `on()`, `once()`, `hasListener()`, `hasListeners()`, `listenerCount()`
- **Component queries**: `hasComponent()`, `isComponentRunning()`, `getComponentStatus()`, `getComponentNames()`, `getRunningComponentNames()`, `getComponentCount()`, `getRunningComponentCount()`, `getStalledComponentCount()`, `getStoppedComponentCount()`, and `getAllComponentStatuses()`. Use `getSelfStatus()` (on `BaseComponent` directly) to query your own state without passing the name
- **System state**: `getSystemState()`, `getStatus()`
- **Stalled/stopped components**: `getStalledComponents()`, `getStalledComponentNames()`, `getStoppedComponentNames()`
- **Dependency validation**: `validateDependencies()`, `getStartupOrder()`
- **Lifecycle control**: `startAllComponents()`, `stopAllComponents()`, `restartAllComponents()`, `startComponent()`, `stopComponent()`, `restartComponent()`
- **Messaging**: `sendMessageToComponent()`, `broadcastMessage()`
- **Value sharing**: `getValue()`
- **Health checks**: `checkComponentHealth()`, `checkAllHealth()`
- **Signal management**: `attachSignals()`, `detachSignals()`, `getSignalStatus()`, `triggerReload()`, `triggerInfo()`, `triggerDebug()`

**Note:** While lifecycle control methods are available through the lifecycle reference, use them with caution. For startup/shutdown ordering, prefer declaring dependencies in your component's configuration rather than manually controlling other components' lifecycles.

## Events

The LifecycleManager emits events for monitoring and observability. All events are typed via `LifecycleManagerEvents`.

### Subscribing to Events

```typescript
import type { LifecycleManagerEventMap } from 'lifecycleion/lifecycle-manager';

// Type-safe event subscription
lifecycle.on('component:started', (data) => {
  console.log(`Component ${data.name} started`);
});

lifecycle.on('lifecycle-manager:shutdown-completed', (data) => {
  console.log(`Shutdown completed in ${data.durationMS}ms`);

  if (!data.success) {
    console.error('Shutdown issues:', data);
  }

  process.exit(data.success ? 0 : 1);
});
```

### Event Categories

**Lifecycle Events:**

- `lifecycle-manager:started` - All components started successfully
- `lifecycle-manager:shutdown-initiated` - Shutdown process started
- `lifecycle-manager:shutdown-warning` - Global warning phase started
- `lifecycle-manager:shutdown-warning-completed` - Warning phase completed
- `lifecycle-manager:shutdown-warning-timeout` - Warning phase timed out
- `lifecycle-manager:shutdown-completed` - Shutdown attempt completed, includes the `ShutdownResult` fields at the top level plus `method` / `duringStartup`. This is the best single event for centralized logging or follow-up policy when shutdown times out or leaves stalled components. If the global shutdown timeout was hit, the payload reflects the result at the moment the public call stopped waiting. A component stop already in flight is not cancelled: its per-component state continues to reject an overlapping start or stop, while the process-wide shutdown latch is released so exit handling and later shutdown/escalation attempts can proceed. It always pairs with `lifecycle-manager:shutdown-initiated`: a pass that throws outright still emits it with `success: false`, `code: 'unknown_error'` and a `reason` naming the cause - the same result `stopAllComponents()` resolves with - so a caller waiting on it is never left hanging. Listeners run while the pass still holds its shutdown latch: `getSystemState()` says `shutting-down` there, and any operation started from inside one - `stopAllComponents()`, `startAllComponents()`, a per-component start or stop - is refused (`already_in_progress` / `shutdown_in_progress`). To act on the result, defer out of the listener (`setImmediate`, `queueMicrotask`), or `await` the promise `stopAllComponents()` returned instead of listening.

**Component Registration:**

- `component:registered` - Component registered
- `component:unregistered` - Component unregistered

**Component Lifecycle:**

- `component:starting` - Component start initiated
- `component:started` - Component started successfully
- `component:start-failed` - Component start failed
- `component:stopping` - Component stop initiated
- `component:stopped` - Component is now stopped. Emitted after normal manager-driven stop flows, after late stall resolution, and after `reportUnexpectedStop()` transitions a running component into the stopped state
- `component:stop-failed` - Component stop failed
- `component:stalled` - Component failed to stop after graceful/force handling timed out or errored
- `component:stalled-resolved` - Previously stalled component's `stop()` or `onShutdownForce()` promise eventually resolved on its own, and the stall was cleared automatically
- `component:unexpected-stop` - Component reported stopping on its own via `reportUnexpectedStop()`. Payload includes `name` and an optional `error`. This event fires before the follow-up `component:stopped` event so listeners can react to the abnormal cause separately from the generic stopped-state transition

**Signal Events:**

- `signal:shutdown` - Shutdown request received, includes `method` and whether shutdown was already in progress via `isAlreadyShuttingDown`
- `signal:reload` - Reload signal received
- `signal:info` - Info signal received
- `signal:debug` - Debug signal received
- `lifecycle-manager:shutdown-escalation-armed` - Failed/timed-out shutdown left escalation armed briefly for follow-up force presses. Like `shutdown-completed`, it fires while the failed pass still holds its shutdown latch, so defer any follow-up operation out of the listener.
- `lifecycle-manager:shutdown-escalation-expired` - Armed escalation window expired and was cleared
- `lifecycle-manager:shutdown-escalation-forced` - Repeated shutdown requests crossed the force threshold and `onForceShutdown()` was invoked. The payload includes `wasArmedAfterFailure` to indicate whether the threshold was crossed during an active shutdown or from the post-failure armed window

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

Event handlers are **fire-and-forget** - they do not block lifecycle operations.

**Event Handler Error Handling:** The LifecycleManager automatically catches errors thrown by event handlers via `safeHandleCallback`, preventing them from breaking lifecycle operations. Errors are dispatched as `ErrorEvent` objects on the standard global `'error'` event channel:

```typescript
// Listen for event handler errors
globalThis.addEventListener('error', (event) => {
  if (event instanceof ErrorEvent) {
    // Claim the report, so it is not written to the console as well
    event.preventDefault();

    console.error('Event handler error:', event.error.message);
    // error.message names the callback: "Error in a callback event handler for component:started"
    // The error the handler actually threw is on `event.error.cause`, so you can render it
    // with your own settings - or use `errorToString(event.error)`, which renders both.
  }
});
```

Available in Node.js 25+, Bun, Deno, and modern browsers. **Note:** Errors are NOT logged to the LifecycleManager's logger - use an `'error'` listener, or `logger.registerReportErrorListener()`, for custom logging/monitoring.

However, it's still best practice to handle errors explicitly in your handlers for better control over error logging and recovery.

```typescript
// ✅ Best - handle errors explicitly for better control
lifecycle.on('component:started', async (data) => {
  try {
    await logToDatabase(data);
  } catch (error) {
    logger.errorObject('Failed to log component start', error);
    // Can add custom recovery logic here
  }
});

// ✅ Safe but less control - manager catches and logs errors
lifecycle.on('component:started', async (data) => {
  await logToDatabase(data); // Errors are caught by manager
});

// ❌ Bad - blocking or long-running work
lifecycle.on('component:started', async (data) => {
  // Don't perform expensive operations here - events are for notifications only
  await performExpensiveMigration(); // This blocks the event loop
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

#### Promises Never Reject

Every async method answers with a result object, including when something goes wrong that the manager did not plan for - a bug in the manager, or a component that breaks its contract with a getter (`getName()`, `getDependencies()`, `isOptional()`) that throws. The promise resolves with a failed result and the original error is reported on the global `'error'` channel (see [safe-handle-callback](./safe-handle-callback.md)):

| Method                                                                   | Unexpected failure resolves with                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `registerComponent()`, `insertComponentAt()`                             | `code: 'unknown_error'`, `registered`: whether this call added it |
| `unregisterComponent()`                                                  | `code: 'unknown_error'`                                           |
| `startAllComponents()`, `stopAllComponents()`, `restartAllComponents()`  | `code: 'unknown_error'` with `error`                              |
| `startComponent()`, `stopComponent()`, `restartComponent()`              | `code: 'unknown_error'` with `error`                              |
| `sendMessageToComponent()`, `checkComponentHealth()`, `checkAllHealth()` | `code: 'error'`                                                   |
| `getValue()` (synchronous)                                               | `code: 'error'` with `error`                                      |
| `triggerReload()`, `triggerInfo()`, `triggerDebug()`                     | `code: 'error'`, including when your callback throws              |
| `broadcastMessage()`                                                     | an empty array                                                    |

Branch on `code` as usual; `unknown_error` is never an expected outcome, so treat it as a bug to report rather than a condition to retry around.

Automatic signal handling follows the configuration. A start that is configured to attach process signals (`attachSignalsBeforeStartup`, `attachSignalsOnStart`) fails with `code: 'signal_attach_failed'` when attaching throws, rather than bringing the process up without them - see [`attachSignals()`](#attachsignals). A detach that throws once the last component stops (`detachSignalsOnStop`) does not fail the stop or unregister it follows: the operation carries on and the failure is logged and reported. An explicit `attachSignals()` / `detachSignals()` call still throws to its caller.

#### Running Operations in the Background

There is no `wait: false` option; there doesn't need to be. Because no promise rejects, you can start any operation without awaiting it and still read its result later from the same promise:

```typescript
// Inside an HTTP handler that must respond now
const pending = lifecycle.stopAllComponents();

res.status(202).send('shutting down');

pending.then((result) => {
  if (!result.success) {
    console.error('Shutdown did not complete cleanly:', result.reason);
  }
});
```

If you don't need the result, `void lifecycle.stopAllComponents()` is safe too - there is no rejection to go unhandled. Events and state getters still report the outcome: `lifecycle-manager:shutdown-completed`, `getLastShutdownResult()`, and `getSystemState()`.

A call that is refused - `already_in_progress`, `shutdown_in_progress`, and so on - resolves almost immediately, so you still find out quickly whether what you asked for was accepted.

#### Exceptions (Programmer Errors)

Exceptions are limited to invalid construction and explicit synchronous calls such as `attachSignals()`. The async public API never rejects - see [Promises Never Reject](#promises-never-reject).

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

Result objects include machine-readable failure codes.

**Timeout Code Naming Convention:**

- Bulk operations (e.g., `startAllComponents()`, `stopAllComponents()`) use `startup_timeout` / `shutdown_timeout`
- Individual component operations (e.g., `startComponent()`, `stopComponent()`) use `component_startup_timeout` / `component_shutdown_timeout`

This distinction makes it clear whether the timeout occurred at the bulk operation level or the individual component level.

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
  | 'component_startup_timeout'
  | 'component_shutdown_timeout'
  | 'restart_stop_failed'
  | 'restart_start_failed'
  | 'startup_rolled_back' // an auto-start whose bulk startup rolled back; stopped again
  | 'signal_attach_failed'
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
  | 'component_starting' // A start is in flight; wait for it to settle
  | 'component_stopping' // A stop is in flight; wait for it to settle
  | 'stop_failed'
  | 'bulk_operation_in_progress'
  | 'unknown_error';

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

`lifecycle-manager:shutdown-completed` is the usual global hook for deciding what to do next with `timedOut` or `stalledComponents`. Use repeated shutdown escalation separately when you want follow-up shutdown requests to trigger another shutdown pass or invoke force behavior.

```typescript
const shutdownResult = await lifecycle.stopAllComponents();

if (shutdownResult.stalledComponents.length > 0) {
  console.error('Stalled components:', shutdownResult.stalledComponents);

  // Option 0: Retry via force phase (escalation - does NOT re-run stop())
  // If the component implements onShutdownForce(), that is called.
  // If not, the component stalls again immediately.
  await lifecycle.stopAllComponents({ retryStalled: true });

  // Option 1: Unregister stalled components
  for (const stalled of shutdownResult.stalledComponents) {
    await lifecycle.unregisterComponent(stalled.name);
  }

  // Option 2: Start non-stalled components while skipping stalled ones
  await lifecycle.startAllComponents({ ignoreStalledComponents: true });

  // Option 3: Force restart an individual stalled component (risky - the
  // component's start() must protect against any still-running shutdown work
  // from the previous run)
  await lifecycle.startComponent('server', { forceStalled: true });
}
```

`ignoreStalledComponents` does not force-start stalled components during bulk startup. It lets startup continue for non-stalled components and skips stalled entries. Forced starts use `startComponent(name, { forceStalled: true })` and are only safe when the component's `start()` implementation does not report success while its own previous `stop()` work is still active. For server-like components, reject `start()` while a `stopPromise` exists so the manager does not mark the component running while the old shutdown can still close its resources.

**If `onShutdownForce()` should join the already-running `stop()`**, deduplicate the promise in `stop()` so that calling it again, or calling it from `onShutdownForce()`, simply awaits the same in-flight operation. Note: This example uses a simplified, idealized `this.server.close()` abstraction. For a complete, production-ready component that also coordinates startup and rejects start attempts while stopping, see [Best Practice #7](#7-make-component-startup-idempotent-and-coordinate-with-shutdown):

```typescript
class ServerComponent extends BaseComponent {
  // Stored so concurrent callers (e.g. onShutdownForce) join the same
  // in-flight promise rather than starting a second concurrent close.
  private stopPromise: Promise<void> | null = null;

  async stop() {
    // Return the same promise if stop is already running, so concurrent callers
    // (including onShutdownForce) join the in-flight operation
    // instead of starting a second concurrent close.
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = (async () => {
      try {
        await this.server.close(); // waits for keep-alive connections to drain
      } finally {
        // Runs on both success and error. Without this, a thrown error would leave
        // stopPromise pointing at a rejected promise forever. Since there's no catch,
        // errors still propagate normally to any caller awaiting this promise.
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  async onShutdownForce() {
    // Force-close open connections so server.close() in the in-flight stop()
    // can finish draining and resolve. Both ?. guards are needed: the outer one
    // handles server not yet assigned (e.g. start() failed), the inner one
    // handles runtimes that don't expose closeAllConnections. (Note: If coordinating
    // with an active start(), you would also check/await that promise here.)
    this.server?.closeAllConnections?.();
    // Wait for the stop() promise to resolve
    await this.stop();
  }
}
```

Alternatively, use `onGracefulStopTimeout()` to unblock `stop()` directly. When the graceful timeout is reached, the manager calls this hook and then proceeds with timeout handling, which may enter the force phase or mark the component stalled. If the hook unblocks the original `stop()` promise, the manager's late-resolution handling clears the stall automatically:

```typescript
class ServerComponent extends BaseComponent {
  async stop() {
    await this.server.close(); // waits for keep-alive connections to drain
  }

  onGracefulStopTimeout() {
    // Called while stop() is still running but has exceeded shutdownGracefulTimeoutMS.
    // Force-closing connections unblocks server.close(), which lets stop() resolve.
    // Once stop() resolves, the manager auto-clears the stall via late resolution.
    // Both ?. guards are needed: the outer one handles server not yet assigned,
    // the inner one handles runtimes that don't expose closeAllConnections. (Note: If
    // coordinating with an active start(), you would ensure startup settled first.)
    this.server?.closeAllConnections?.();
  }
}
```

If `stop()` (or `onShutdownForce()`) just needs more time and will eventually complete on its own, the automatic late-resolution behavior handles it: the manager clears the stall and emits `component:stalled-resolved` when the promise resolves, with no manual retry needed.

The key requirement is still that the promise eventually settles: late resolution is supported, but never-settling shutdown work will remain stalled until you intervene or the process exits.

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
  startupTimeoutMS: 60000, // Long-running migrations (global timeout for all components)
  shutdownOptions: { timeoutMS: 10000 }, // Most components stop quickly (global timeout)
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

### 7. Make Component Startup Idempotent and Coordinate With Shutdown

For servers and long-running services, make `start()` idempotent by tracking an in-flight `startPromise`, and make `stop()` idempotent by tracking an in-flight `stopPromise`. Additionally, reject `start()` while `stop()` is in progress, and coordinate `stop()` so that it awaits any active `startPromise` before shutting down.

This prevents race conditions such as a shutdown request arriving mid-boot, multiple callers starting the same server concurrently, or a force restart trying to reuse a server that is still shutting down. Starting while stopping should be treated as an error: the existing runtime is being torn down, so a new start attempt must wait until shutdown settles and can create a fresh runtime.

If the component is already ready, `start()` can return successfully without creating another resource. If initialization is still pending, return its existing promise or reject the duplicate call explicitly. Do not return successfully before the component is ready, because the manager treats a fulfilled startup promise as readiness. The example below keeps the successful startup promise until shutdown, so subsequent calls reuse it.

A startup timeout does not automatically retry `start()`. If your application requests another start after a timeout, the original work may still be running. The manager uses attempt tokens to prevent an old late-completion handler from changing the newer run's state or stopping it. Those tokens do not prevent your original `start()` from assigning to component fields or creating resources. Reuse the pending promise, or cancel and settle the old work before creating a replacement. If overlapping attempts are intentional, the component needs its own attempt checks before publishing resources and must dispose of resources created by superseded attempts.

```typescript
class ServerComponent extends BaseComponent {
  private server: Server | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  async start(): Promise<void> {
    // Starting while shutdown is active is not a safe no-op: the manager could
    // mark the component running while the old stop() is still draining.
    if (this.stopPromise) {
      throw new Error('Cannot start server while shutdown is in progress');
    }

    // Return the same promise if start is already running, so concurrent callers
    // join the in-flight operation instead of starting a second concurrent startup.
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      try {
        this.server = createServer();
        await this.server.listen(3000);

        this.logger.success('Server started');
      } catch (error) {
        // Reset startup state on failure so startup can be retried.
        this.server = null;
        this.startPromise = null;
        throw error;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      try {
        // Await active startup to settle before stopping, preventing orphaned
        // listening sockets if shutdown is initiated mid-boot.
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Ignore startup errors since we are stopping anyway
          }
        }

        // Keep a local reference so this stop attempt closes the same runtime
        // even if component state changes while shutdown is in progress.
        const server = this.server;
        if (server) {
          await server.close();
        }

        // Only clear the server reference after a successful stop. If stop()
        // rejects, force shutdown still needs this.server to close connections.
        this.server = null;
        this.startPromise = null;
      } finally {
        // Runs on both success and error. Without this, a thrown error would leave
        // stopPromise pointing at a rejected promise forever. Since there's no catch,
        // errors still propagate normally to any caller awaiting this promise.
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  onGracefulStopTimeout(): void {
    // Force-closing active connections can unblock the in-flight stop() above.
    this.server?.closeAllConnections?.();
  }

  async onShutdownForce(): Promise<void> {
    // If graceful close failed or timed out, keep using the same server handle and
    // join the in-flight stop() promise instead of starting a second close.
    this.server?.closeAllConnections?.();
    await this.stop();
  }
}
```

**Cooperative Cancellation during Startup:** If your component's startup logic consists of multiple sequential async steps or supports native cancellation (like `AbortSignal`), you can manage cooperative cancellation yourself. To do this, create an `AbortController` for each startup attempt, store it as an instance property on your component, pass its `signal` to your startup operations (like database connections or fetch requests), and call `this.abortController.abort()` at the very beginning of your `stop()` method (or in `onStartupAborted()`). Because an aborted signal stays aborted permanently, create a fresh controller before each retry or restart. Because `stop()` is protected by the `stopPromise` guard, this abort will only ever be triggered once for each stop attempt. If the underlying operations honor cancellation, awaiting the in-flight `startPromise` immediately after allows shutdown to proceed once they settle. Aborting the signal alone does not guarantee prompt completion. However, for standard single-step operations (like binding an HTTP server via `listen()`), awaiting the in-flight promise to settle and then immediately shutting it down remains the simplest and safest path.

**Force-Closing Connections on Shutdown:** For servers using raw Node.js `http.Server`, active keep-alive connections will prevent the server from fully closing, causing `stop()` to stall. To handle this gracefully, you can implement either hook to run `this.server?.closeAllConnections?.()`:

1. `onGracefulStopTimeout()`: Called when the graceful timeout is hit, letting you nudge the existing `stop()` promise to settle so the manager can clear the stall via late-resolution handling.
2. `onShutdownForce()`: Called during the force shutdown phase. Awaiting `this.stop()` here (after force-closing) allows you to clean up and settle during the force escalation phase.

See the [Stalled Component Recovery](#stalled-component-recovery) section for examples of how to implement these patterns.

### 8. Safe Resource Sharing via Dynamic Wrappers

When sharing resources (such as a database connection pool, a Redis client, or an API client) via `getValue()`, consumers, whether they are other registered components (like background workers), web servers, or middleware, should avoid holding onto direct, long-lived references to the underlying resource. Doing so can cause issues if the provider component restarts, stops, or goes offline.

Instead, the resource-providing component should manage the connection lifecycle and expose it via `getValue()`, while consumers use a **Wrapper** class that dynamically resolves the active resource on every call.

#### Step 1: The Resource Component

The component manages the database pool's lifecycle (creation, testing, and teardown). It can also implement logic to swap a live connection pool with zero downtime, or buffer replacement credentials for the next manager-driven startup when the pool is stopped or stopping.

```typescript
import {
  BaseComponent,
  type ComponentValueResult,
} from 'lifecycleion/lifecycle-manager';
import type { Logger } from 'lifecycleion/logger';
import { Pool } from 'pg';
import { ulid } from 'ulid';

export interface DatabaseConfig {
  // Required connection parameters
  user: string;
  host: string;
  database: string;
  password: string;
  port: number;

  // Optional pool configuration
  max?: number;
  min?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

// Default pool configuration values (uses Millis to match pg native options)
// See https://node-postgres.com/guides/pool-sizing for details on pool sizing
const DEFAULT_POOL_CONFIG = {
  max: 20, // Max number of clients in the pool
  min: 2, // Min number of idle clients to keep in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to remain idle before being closed
  connectionTimeoutMillis: 2000, // How long to wait for a connection from the pool
};

const OLD_POOL_DRAIN_MS = 1000;

export interface DatabasePoolRef {
  pool: Pool;
  poolID: string;
}

export interface DatabaseStatusRef {
  connected: boolean;
  poolID: string | null;
  state: string;
  hasPendingConfig: boolean;
  totalConnections: number;
  idleConnections: number;
  waitingRequests: number;
}

class DatabaseConnectionManager extends BaseComponent {
  private pool: Pool | null = null;
  private poolID: string | null = null;
  private config: DatabaseConfig;
  private pendingConfig: DatabaseConfig | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private configUpdateQueue: Promise<void> = Promise.resolve();
  private retiredPools = new Set<Pool>();
  private retiredPoolClosePromises = new Map<Pool, Promise<void>>();
  private retiredPoolTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(logger: Logger, config: DatabaseConfig) {
    super(logger, {
      name: 'database',
    });

    this.config = config;
  }

  async start(): Promise<void> {
    // Starting while shutdown is active is not a safe no-op
    if (this.stopPromise) {
      throw new Error(
        'Cannot start database connection manager while shutdown is in progress',
      );
    }

    // Return the same promise if start is already running, so concurrent callers
    // join the in-flight operation instead of starting a second concurrent startup.
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = (async () => {
      // A buffered config is only consumed by a manager-driven startup attempt.
      const startupConfig = this.pendingConfig ?? this.config;

      this.logger.info('Connecting to database and creating pool...', {
        params: {
          host: startupConfig.host,
          database: startupConfig.database,
        },
      });

      // Create initial pool with defaults merged with provided config
      const poolConfig = {
        ...DEFAULT_POOL_CONFIG,
        ...startupConfig,
      };

      const pool = new Pool(poolConfig);

      // Handle unexpected errors on idle clients (e.g. if the database server drops
      // the socket, or if credentials rotate and connection attempts fail). This
      // prevents idle errors from raising unhandled exceptions and crashing the process.
      pool.on('error', (err) => {
        this.logger.errorObject(
          'Unexpected error on idle client in database pool',
          err,
        );
      });

      try {
        // Verify connection by checking out a client and running a test query
        const client = await pool.connect();

        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }

        this.pool = pool;
        this.poolID = ulid();

        // Promote the startup config only after the replacement pool is verified.
        this.config = startupConfig;
        this.pendingConfig = null;
        this.logger.success('Database pool successfully created and verified');
      } catch (error) {
        // Reset startup state on failure so startup can be retried
        this.pool = null;
        this.poolID = null;
        this.startPromise = null;
        await pool.end().catch(() => {});
        throw error;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopPromise = (async () => {
      try {
        // Await active startup to settle before stopping, preventing orphaned pools
        // if shutdown is initiated mid-boot.
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Ignore startup errors since we are stopping anyway
          }
        }

        try {
          // Wait for any in-flight config swap before closing the active pool.
          await this.configUpdateQueue;
        } catch {
          // Ignore config update errors since we are stopping anyway
        }

        // Keep a local reference to close the pool gracefully.
        // pool.end() is graceful: it waits for all checked-out clients to be released
        // before resolving, but will hang if a client is leaked and never returned.
        const pool = this.pool;
        const retiredPools = [...this.retiredPools];

        for (const timer of this.retiredPoolTimers) {
          clearTimeout(timer);
        }

        this.retiredPoolTimers.clear();
        this.retiredPools.clear();

        if (pool) {
          this.logger.info('Closing database pool connections...');
          await pool.end();
        }

        for (const retiredPool of retiredPools) {
          await this.closeRetiredPool(retiredPool);
        }

        // Only clear references after a successful close.
        this.pool = null;
        this.poolID = null;
        this.startPromise = null;
        this.logger.success('Database pool closed');
      } finally {
        // Runs on both success and error to prevent stopPromise pointing at a rejected
        // promise forever. Errors still propagate normally to any awaiting caller.
        this.stopPromise = null;
      }
    })();

    return this.stopPromise;
  }

  /**
   * Safely updates the database pool configuration.
   */
  async updateConfig(newConfig: DatabaseConfig) {
    const runUpdate = async () => {
      // Await active startup to settle before swapping configuration. If startup
      // fails because credentials are stale, continue so the buffer path below
      // can buffer replacement credentials for the next startup attempt.
      if (this.startPromise) {
        await this.startPromise.catch(() => {});
      }

      // If there is no stable live pool to swap, buffer the new config for the
      // next manager-driven startup instead of mutating the active config.
      if (this.stopPromise || !this.pool) {
        this.pendingConfig = newConfig;

        this.logger.info(
          'Database pool configuration buffered for next start',
          {
            params: {
              host: newConfig.host,
              database: newConfig.database,
            },
          },
        );

        return;
      }

      const oldPool = this.pool;

      // Create new pool with updated config and default pool settings
      const updatedPoolConfig = {
        ...DEFAULT_POOL_CONFIG,
        ...newConfig,
      };

      const newPool = new Pool(updatedPoolConfig);

      // Handle unexpected errors on idle clients (e.g. if connection drops or login details expire)
      newPool.on('error', (err) => {
        this.logger.errorObject(
          'Unexpected error on idle client in database pool',
          err,
        );
      });

      try {
        // Verify connection by checking out a client and running a test query
        const client = await newPool.connect();

        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }

        // Swap the references upon successful connection test
        this.pool = newPool;
        this.poolID = ulid();
        this.config = newConfig;
        this.pendingConfig = null;

        this.logger.info('Database pool configuration updated', {
          params: {
            host: newConfig.host,
            database: newConfig.database,
          },
        });

        // Give requests that already captured the old pool a short drain window,
        // then gracefully close the old pool in the background.
        this.retiredPools.add(oldPool);

        const timer = setTimeout(() => {
          this.retiredPoolTimers.delete(timer);
          void this.closeRetiredPool(oldPool);
        }, OLD_POOL_DRAIN_MS);

        this.retiredPoolTimers.add(timer);
      } catch (error) {
        // Clean up the new pool and keep using the old one
        await newPool.end();
        throw error;
      }
    };

    // The promise chain is the queue: each update waits for the previous one
    // before it starts, so overlapping calls cannot swap or close the same pool.
    // Catching the prior update keeps one failure from blocking future updates.
    const update = this.configUpdateQueue.catch(() => {}).then(runUpdate);
    this.configUpdateQueue = update;

    return update;
  }

  private closeRetiredPool(pool: Pool): Promise<void> {
    const existingClose = this.retiredPoolClosePromises.get(pool);

    if (existingClose) {
      return existingClose;
    }

    const closePromise = pool
      .end()
      .catch((err) => {
        this.logger.errorObject('Failed to close old database pool', err);
      })
      .finally(() => {
        this.retiredPools.delete(pool);
        this.retiredPoolClosePromises.delete(pool);
      });

    this.retiredPoolClosePromises.set(pool, closePromise);

    return closePromise;
  }

  getValue<T = unknown>(
    key: string,
    from: string | null,
  ): ComponentValueResult<T> {
    const status = this.getSelfStatus();

    if (key === 'pool') {
      if (status?.state !== 'running' || !this.pool || !this.poolID) {
        return { found: false, value: undefined };
      }

      const value: DatabasePoolRef = {
        pool: this.pool,
        poolID: this.poolID,
      };

      return {
        found: true,
        value: value as T,
      };
    } else if (key === 'status') {
      const value: DatabaseStatusRef = {
        connected: this.pool !== null,
        poolID: this.poolID,
        state: status?.state ?? 'unknown',
        hasPendingConfig: this.pendingConfig !== null,
        totalConnections: this.pool?.totalCount ?? 0,
        idleConnections: this.pool?.idleCount ?? 0,
        waitingRequests: this.pool?.waitingCount ?? 0,
      };

      return {
        found: true,
        value: value as T,
      };
    } else {
      return { found: false, value: undefined };
    }
  }
}
```

#### Step 2: The Consumer Wrapper Helper

Consumers use a helper wrapper class to interact with the database. Instead of caching the connection pool, it queries the `DatabaseConnectionManager`'s shared value dynamically. The provider also exposes a `poolID` that changes every time a new pool is promoted, allowing the wrapper to retry client acquisition once when a request races with a pool swap without looping forever. In web applications, this helper is typically instantiated once and attached to the incoming request object (such as `req.db`) via middleware, making database operations safe and uniform across all handlers.

In a larger app or monorepo, place shared value types like `DatabasePoolRef` and `DatabaseStatusRef` in a shared types file imported by both the component and its consumers. Unit test the wrapper behavior too, especially unavailable pools, pool-swap retry, non-replayed writes, and transaction rollback paths.

```typescript
import { safeHandleCallback } from 'lifecycleion/safe-handle-callback';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { LifecycleValueProvider } from 'lifecycleion/lifecycle-manager';

export interface DatabasePoolRef {
  pool: Pool;
  poolID: string;
}

export interface DatabaseHelperOptions {
  onPoolSwapRetry?: (details: {
    mode: 'client' | 'query';
    previousPoolID: string;
    activePoolID: string;
  }) => void | Promise<void>;
}

export interface TransactionResult<T> {
  status: 'committed' | 'rolled_back';
  value?: T;
  error?: Error;
}

export class TransactionContext {
  private committed = false;
  private rolledBack = false;

  constructor(private client: PoolClient) {}

  /**
   * Run a query within this transaction.
   */
  async query(text: string, params?: unknown[]) {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction has already completed');
    }

    return this.client.query(text, params);
  }

  /**
   * Manually commit the transaction.
   */
  async commit() {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction has already completed');
    }

    await this.client.query('COMMIT');
    this.committed = true;
  }

  /**
   * Manually rollback the transaction.
   */
  async rollback() {
    if (this.committed || this.rolledBack) {
      throw new Error('Transaction has already completed');
    }

    await this.client.query('ROLLBACK');
    this.rolledBack = true;
  }

  /**
   * Check if the transaction has been manually finalized (committed or rolled back).
   */
  isCompleted() {
    return this.committed || this.rolledBack;
  }

  /**
   * Get the current status of the transaction.
   */
  getStatus(): 'pending' | 'committed' | 'rolled_back' {
    if (this.committed) {
      return 'committed';
    } else if (this.rolledBack) {
      return 'rolled_back';
    } else {
      return 'pending';
    }
  }
}

export class DatabaseHelper {
  constructor(
    private lifecycle: LifecycleValueProvider,
    private options: DatabaseHelperOptions = {},
  ) {
    if (
      options.onPoolSwapRetry !== undefined &&
      typeof options.onPoolSwapRetry !== 'function'
    ) {
      throw new TypeError('onPoolSwapRetry must be a function');
    }
  }

  /**
   * Retrieves the active connection pool reference or throws a descriptive error.
   */
  private getPoolRefOrThrow(): DatabasePoolRef {
    const result = this.lifecycle.getValue<DatabasePoolRef>('database', 'pool');

    if (!result.found || !result.value) {
      // Fetch the component status to provide a more specific error message
      const statusResult = this.lifecycle.getValue<{ state: string }>(
        'database',
        'status',
        { includeStopped: true, includeStalled: true },
      );

      const state = statusResult.value?.state ?? 'unknown';
      throw new Error(
        `Database connection is unavailable (manager state: ${state})`,
      );
    }

    return result.value;
  }

  private shouldRetryAfterPoolSwap(error: unknown): boolean {
    const retryableCodes = new Set([
      // Node.js network/socket errors
      'ECONNRESET',
      'ECONNREFUSED',
      'EPIPE',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      // PostgreSQL SQLSTATE connection exception class
      '08000',
      '08001',
      '08003',
      '08004',
      '08006',
      '08007',
      '08P01',
      // Server shutdown/restart conditions
      '57P01',
      '57P02',
      '57P03',
    ]);
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
    const message = describeError(error);

    return (
      (code !== null && retryableCodes.has(code)) ||
      message.includes('Cannot use a pool after calling end') ||
      message.includes('Connection terminated unexpectedly') ||
      message.includes('Client has encountered a connection error')
    );
  }

  private async runOperationWithPoolSwapRetry(
    mode: 'client',
  ): Promise<PoolClient>;
  private async runOperationWithPoolSwapRetry<
    T extends QueryResultRow = QueryResultRow,
  >(mode: 'query', text: string, params?: unknown[]): Promise<QueryResult<T>>;
  private async runOperationWithPoolSwapRetry<
    T extends QueryResultRow = QueryResultRow,
  >(
    mode: 'client' | 'query',
    text?: string,
    params?: unknown[],
  ): Promise<PoolClient | QueryResult<T>> {
    const poolRef = this.getPoolRefOrThrow();

    const run = (ref: DatabasePoolRef) => {
      switch (mode) {
        case 'client':
          return ref.pool.connect();

        case 'query':
          if (text === undefined) {
            throw new Error('Query text is required');
          }

          return ref.pool.query<T>(text, params);

        default:
          throw new Error(`Unsupported database operation mode: ${mode}`);
      }
    };

    try {
      return await run(poolRef);
    } catch (error) {
      // Retry once only when a pool/connection lifecycle error races with a newer pool.
      if (!this.shouldRetryAfterPoolSwap(error)) {
        throw error;
      }

      const activePoolRef = this.lifecycle.getValue<DatabasePoolRef>(
        'database',
        'pool',
      );
      const activePoolID = activePoolRef.value?.poolID ?? null;

      if (activePoolID === null || activePoolID === poolRef.poolID) {
        throw error;
      }

      // Keep telemetry hook failures from interrupting the database operation.
      if (this.options.onPoolSwapRetry) {
        safeHandleCallback(
          'DatabaseHelper onPoolSwapRetry',
          this.options.onPoolSwapRetry,
          {
            mode,
            previousPoolID: poolRef.poolID,
            activePoolID,
          },
        );
      }

      const nextPoolRef = this.getPoolRefOrThrow();
      return run(nextPoolRef);
    }
  }

  /**
   * Run a direct query against the pool.
   * Use this for writes, mixed statements, or reads that should not be replayed.
   * This method dynamically resolves the active pool but does not retry the SQL
   * after it has been sent, because the client cannot always know whether
   * PostgreSQL already ran it. Use runInTransaction() for multi-step atomic work.
   */
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const poolRef = this.getPoolRefOrThrow();
    return poolRef.pool.query<T>(text, params);
  }

  /**
   * Run a read-only query that is safe to replay once during pool rotation.
   * This method only accepts leading SELECT statements with no semicolons. It
   * cannot prove that custom functions are side-effect-free, so only use it for
   * reads your application considers safe to replay. For writes or reads that
   * are not safe to replay, use query() so the SQL is never replayed
   * automatically.
   */
  async readQuery<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const normalizedQuery = text.trimStart().toLowerCase();

    if (
      !normalizedQuery.startsWith('select') ||
      normalizedQuery.includes(';')
    ) {
      throw new Error('readQuery() only accepts replayable SELECT statements');
    }

    return this.runOperationWithPoolSwapRetry<T>('query', text, params);
  }

  /**
   * Run a series of queries inside a transaction.
   * Automatically starts a transaction and passes a TransactionContext to the callback.
   * The callback MUST explicitly call tx.commit() or tx.rollback() before resolving.
   * If it resolves without manual completion, the transaction is rolled back and an error is returned.
   * If the callback throws an error, the transaction is rolled back and the error is returned.
   * Returns a TransactionResult object detailing the status, return value, or caught error.
   * Releases the client safely under all circumstances.
   */
  async runInTransaction<T>(
    callback: (tx: TransactionContext) => Promise<T>,
  ): Promise<TransactionResult<T>> {
    const client = await this.runOperationWithPoolSwapRetry('client');
    const tx = new TransactionContext(client);

    try {
      await client.query('BEGIN');
      const result = await callback(tx);

      // Force manual completion: if resolved without explicit commit/rollback, we rollback and throw
      if (!tx.isCompleted()) {
        await tx.rollback().catch(() => {});
        throw new Error(
          'Transaction was resolved without being explicitly committed or rolled back',
        );
      }

      return {
        status: tx.getStatus() as 'committed' | 'rolled_back',
        value: result,
      };
    } catch (error) {
      const err = toError(error);

      // If not finalized yet, auto-rollback
      if (!tx.isCompleted()) {
        await tx.rollback().catch(() => {});
        return { status: 'rolled_back', error: err };
      }

      // If already finalized (e.g. committed, but a subsequent step in the callback failed),
      // return the correct transaction status along with the caught error.
      return {
        status: tx.getStatus() as 'committed' | 'rolled_back',
        error: err,
      };
    } finally {
      client.release();
    }
  }
}
```

## Known Limitations

### 1. Timeouts Do Not Force-Cancel Work

The LifecycleManager does not forcibly terminate work when timeouts are exceeded. JavaScript promises cannot be externally canceled without cooperation from the executing code.

When `start()` or `stop()` times out:

- The manager calls `onStartupAborted()` or `onGracefulStopTimeout()` (if implemented)
- The manager proceeds with next steps (rollback for startup, force phase for shutdown)
- **Non-cooperative code continues running in the background** until completion or process exit
- If `start()` times out and there is no `onStartupAborted()`, the manager will stop the component automatically if that delayed startup eventually completes. Bulk startup deadlines perform this late cleanup even when an abort hook is implemented.
- If shutdown begins while `start()` is still in flight, the manager waits for that startup attempt to settle and then stops the component automatically if it finishes starting

How to avoid surprises:

1. Implement cooperative cancellation (AbortController, flags, or library timeouts).
2. Wire cancellation into long-running work and close resources in `onStartupAborted()`/`onGracefulStopTimeout()`.
3. Favor libraries that support AbortSignal or configurable timeouts.

### 2. Stalled Promises Can Retain Memory

If a component stalls and its promise never resolves, the promise and any captured state remain in memory until process exit. This is a risk whenever async work never settles.

How to reduce the risk:

1. Ensure `start()`/`stop()` always settle (resolve or reject) on all paths.
2. Use timeouts and cancellation so work can terminate deterministically.
3. Keep long-lived closures small, and avoid capturing large buffers in stalled tasks.

### 3. No Atomic Restart

`restartAllComponents()` is not atomic. There is a window where all components are stopped but none are started yet. For zero-downtime restarts, use rolling restarts with individual `restartComponent()` calls.
