# LifecycleManager - Product Requirements Document

## Overview

The LifecycleManager is a comprehensive lifecycle orchestration system that manages startup, shutdown, and runtime control of application components. It merges the best concepts from two previous projects of mine implementations (Orvenza's AgentComponentManager and DayMover's ServicesManager) with the existing ProcessSignalManager and Logger infrastructure. These don't need to be mentioned in the public doc, I think plan is to implmement a chunk, document/unit test and delete it out of the RPD since this is a little long doc.

## Core Philosophy

- **Component-oriented**: Use "component" terminology for managed entities
- **Ordered lifecycle**: Components start in registration order, stop in reverse order
- **Multi-phase shutdown**: Warning -> Graceful -> Force (configurable per component)
- **Signal integration**: Built-in process signal handling for graceful shutdown, reload, info, and debug
- **Hierarchical logging**: Components log as their own service (`logger.service('database')`), while the manager uses `.entity()` when logging about components it manages
- **Flexible ordering**: Dynamic insertion at start, end, before, or after specific components
- **Runtime introspection**: Check component status, list running components, query by name
- **Extensible**: Support for custom signal handlers and arbitrary component messaging

## Architecture Decisions

### 1. ProcessSignalManager Integration (Composition)

**Decision**: Use composition, not inheritance. The LifecycleManager will own a ProcessSignalManager instance.

**Rationale**:

- Clear separation of concerns: signal handling vs lifecycle management
- LifecycleManager can wrap ProcessSignalManager methods to provide component-specific context
- Easier to test and mock
- More flexible (can optionally not use ProcessSignalManager if desired)

**Signal Handler Behavior**:

- **Shutdown signals** (SIGINT, SIGTERM, SIGTRAP): Always trigger component shutdown
- **Reload signal** (SIGHUP, R key):
  - If custom callback provided: Call custom callback (callback receives a `broadcastReload()` function to optionally broadcast to components)
  - If no custom callback: Automatically broadcast to all running components with `onReload()` implemented
- **Info signal** (SIGUSR1, I key):
  - If custom callback provided: Call custom callback only
  - If no custom callback: Log warning that no info handler is configured
- **Debug signal** (SIGUSR2, D key):
  - If custom callback provided: Call custom callback only
  - If no custom callback: Log warning that no debug handler is configured

**Custom Signal Callbacks** (optional):

Applications can provide custom callbacks for reload/info/debug signals:

```typescript
const lifecycle = new LifecycleManager({
  logger,

  // Custom reload handler - can do custom logic AND broadcast to components
  onReloadRequested: async (broadcastReload) => {
    console.log('Reloading application configuration...');

    // Option 1: Do custom logic only (don't call broadcastReload)
    await reloadGlobalConfig();

    // Option 2: Do custom logic then broadcast to all components
    await reloadGlobalConfig();
    await broadcastReload(); // Calls onReload() on all running components

    // Option 3: Just broadcast (same as not providing callback)
    await broadcastReload();
  },

  // Custom info handler - called when SIGUSR1 or 'I' key pressed
  onInfoRequested: async () => {
    console.log('=== Application Info ===');
    console.log(`Uptime: ${process.uptime()}s`);
    console.log(`Memory: ${process.memoryUsage().heapUsed / 1024 / 1024}MB`);
    console.log(
      `Components: ${lifecycle.getRunningComponentNames().join(', ')}`,
    );
  },

  // Custom debug handler - called when SIGUSR2 or 'D' key pressed
  onDebugRequested: async () => {
    console.log('=== Debug Info ===');
    console.log('Running:', lifecycle.getRunningComponentNames());
    // Toggle debug mode, dump state, etc.
  },
});

// If you want to handle signals on a specific component instead,
// use the messaging system:
lifecycle.on('signal:info', async () => {
  await lifecycle.sendMessageToComponent('stats-component', {
    action: 'dumpStats',
  });
});
```

**Public API**:

```typescript
// Wrapper methods on LifecycleManager
lifecycleManager.attachSignals(); // -> processSignalManager.attach()
lifecycleManager.detachSignals(); // -> processSignalManager.detach()
lifecycleManager.getSignalStatus(); // -> processSignalManager.getStatus()
lifecycleManager.triggerShutdown(); // Manual shutdown trigger
await lifecycleManager.triggerReload(); // Manual reload trigger (returns results)
await lifecycleManager.triggerInfo(); // Manual info trigger (returns results)
await lifecycleManager.triggerDebug(); // Manual debug trigger (returns results)
```

### 2. Logger Hierarchy

**Two separate logging contexts**:

| Who's Logging                      | Logger Used                                              | Example Output                                     |
| ---------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| LifecycleManager about itself      | `logger.service('lifecycle-manager')`                    | `[lifecycle-manager] Starting all components...`   |
| LifecycleManager about a component | `logger.service('lifecycle-manager').entity('database')` | `[lifecycle-manager > database] Component started` |
| The component itself               | `logger.service('database')`                             | `[database] Connected to postgres://...`           |

**How it works**:

- Root logger passed to LifecycleManager constructor
- LifecycleManager creates: `logger.service('lifecycle-manager')` (or custom name) for its own logging
- When LifecycleManager logs about a component: `this.logger.entity(componentName)`
- Components receive the **root logger** and create their own service scope: `rootLogger.service(componentName)`
- This means components are first-class services, not children of LifecycleManager

### 4. Multi-Phase Shutdown Strategy

**Three-Phase Shutdown Flow** (similar to React lifecycle):

Each component can go through up to three phases during shutdown, with configurable timeouts:

1. **Warning Phase** (optional, configurable per component):
   - Call `component.onShutdownWarning()` if implemented
   - Wait up to `shutdownWarningTimeoutMS` (default: 0 = skip)
   - Purpose: Let component prepare for shutdown (stop accepting new work, drain queues, etc.)
   - If times out: Log warning, proceed to graceful phase

2. **Graceful Phase** (required):
   - Call `component.stop()`
   - Wait up to `shutdownGracefulTimeoutMS` (default: 5000ms)
   - Purpose: Normal shutdown procedure (close connections, save state, etc.)
   - If times out: Call `component.onStopAborted()` if implemented, then proceed to force phase
   - If throws: Proceed to force phase

3. **Force Phase** (if graceful times out OR throws error):
   - Call `component.onShutdownForce()` if implemented
   - Wait up to `shutdownForceTimeoutMS` (default: 2000ms)
   - Purpose: More aggressive cleanup (kill connections, abandon work, etc.)
   - If times out: Call `component.onShutdownForceAborted()` if implemented, mark as stalled, continue
   - Receives context about why force was triggered (timeout vs error)

**Overall Shutdown Flow**:

1. Signal received (SIGINT, SIGTERM, SIGTRAP) or manual trigger
2. Set `isShuttingDown` flag (prevents new registrations/operations)
3. Stop components in **reverse dependency order** (dependents first, then their dependencies)
4. For each component:
   - Phase 1: Warning (if configured and implemented)
   - Phase 2: Graceful shutdown (required)
   - Phase 3: Force shutdown (if graceful times out OR throws error, and implemented)
5. Track stalled components (timeout, error, both)
6. Emit events throughout the process
7. Global timeout applies to entire shutdown process
8. Final cleanup: detach signals (logger is NOT closed - caller owns it)

**Timeout Handling**:

- Global shutdown timeout (e.g., 30s for all components combined)
- Per-component timeouts (configurable in ComponentOptions)
- Track which components stalled and why (error, timeout, both)
- Continue stopping other components even if one stalls

**Dynamic Component Removal During Shutdown**:

- If a component is unregistered while shutdown is in progress:
  - If not yet processed: Remove from shutdown queue, skip it
  - If currently shutting down: Complete current phase, skip remaining phases
  - If already stopped: No-op (already handled)
- Emit event: `component:unregistered-during-shutdown`

### 5. Component Messaging

**Arbitrary Component Messaging**:
Applications can send custom messages to specific components by name. This allows for application-specific communication patterns without coupling to the lifecycle manager.

**Message Parameters**:

Messages are delivered with two parameters: `payload` (the message) and `from` (who sent it). The manager **automatically tracks** who sent the message:

**How "from" tracking works**:

- When called via `this.lifecycle.sendMessageToComponent()` inside a component → `from` = that component's name
- When called directly on the manager instance → `from` = null (external)
- The manager determines this by tracking which component owns the lifecycle reference being called

This allows components to know who sent the message and respond accordingly:

```typescript
// External code (from = null)
const result = await lifecycle.sendMessageToComponent('web-server', {
  action: 'getStats',
});
// Manager calls: webServer.onMessage({ action: 'getStats' }, null)

// Component to component (from = automatic)
class WebServerComponent extends BaseComponent {
  async onMessage(payload: unknown, from: string | null) {
    // Send message to cache
    const result = await this.lifecycle.sendMessageToComponent('cache', {
      action: 'invalidate',
      key: 'users',
    });
    // Manager calls: cache.onMessage({ action: 'invalidate', key: 'users' }, 'web-server')
  }
}

console.log(result);
// {
//   sent: true,
//   componentFound: true,
//   componentRunning: true,
//   handlerImplemented: true,
//   data: { connections: 42, uptime: 3600 },  // Returned from onMessage
//   error: null
// }

// Component implementation (async with return value)
class WebServerComponent extends BaseComponent {
  async onMessage(payload: unknown, from: string | null) {
    const msg = payload as { action: string; config?: unknown };

    // Can check who sent the message
    if (from !== null) {
      this.logger.debug(`Received message from component: ${from}`);
    }

    if (msg.action === 'updateConfig') {
      this.logger.info('Updating configuration...');
      await this.reloadConfig(msg.config);
      return { success: true }; // Returned in MessageResult.data
    }

    if (msg.action === 'getStats') {
      return {
        connections: this.server.connections.length,
        uptime: process.uptime(),
      };
    }
  }
}

// Component implementation (sync also supported)
class CacheComponent extends BaseComponent {
  onMessage(payload: unknown, from: string | null) {
    const msg = payload as { action: string };

    if (msg.action === 'clear') {
      this.cache.clear();
      this.logger.info(`Cache cleared (requested by: ${from ?? 'external'})`);
      return { itemsCleared: this.cache.size }; // Sync return value
    }

    if (msg.action === 'getSize') {
      return { size: this.cache.size };
    }
  }
}
```

**Return Value Details**:

```typescript
interface MessageResult {
  sent: boolean; // Was message delivered to handler
  componentFound: boolean; // Does component exist
  componentRunning: boolean; // Is component currently running
  handlerImplemented: boolean; // Does component have onMessage() method
  data: unknown; // Data returned from onMessage handler (undefined if handler returned nothing)
  error: Error | null; // Error if handler threw
}
```

**Broadcasting Messages**:

Send a message to multiple components:

```typescript
// External broadcast (from = null)
const results = await lifecycle.broadcastMessage({
  action: 'healthCheck',
});

console.log(results);
// [
//   { name: 'database', sent: true, running: true, data: { healthy: true }, error: null },
//   { name: 'web-server', sent: true, running: true, data: { healthy: true }, error: null },
//   { name: 'cache', sent: false, running: true, data: undefined, error: null }  // No onMessage handler
// ]

// Send to all registered components (running or not)
const results = await lifecycle.broadcastMessage(
  { action: 'ping' },
  { includeNonRunning: true },
);

// Filter to specific components
const results = await lifecycle.broadcastMessage(
  { action: 'reset' },
  { componentNames: ['database', 'cache'] },
);

// Component broadcasting to others (from = automatic)
class DatabaseComponent extends BaseComponent {
  async onMessage(payload: unknown, from: string | null) {
    const msg = payload as { action: string };

    if (msg.action === 'schema-changed') {
      // Notify other components that database schema changed
      // Manager automatically passes from: 'database'
      const results = await this.lifecycle.broadcastMessage({
        action: 'invalidate-cache',
      });
    }
  }
}

// Aggregate data from all components
const healthResults = await lifecycle.broadcastMessage({
  action: 'healthCheck',
});

const healthSummary = healthResults.reduce(
  (acc, result) => {
    if (result.sent && result.data) {
      acc[result.name] = result.data;
    }
    return acc;
  },
  {} as Record<string, unknown>,
);

console.log(healthSummary);
// {
//   database: { healthy: true, connections: 5 },
//   'web-server': { healthy: true, requestsPerSec: 120 },
//   cache: { healthy: true, hitRate: 0.95 }
// }
```

**Broadcast Return Value**:

```typescript
interface BroadcastResult {
  name: string; // Component name
  sent: boolean; // Was message delivered
  running: boolean; // Was component running
  data: unknown; // Data returned from onMessage handler (undefined if not sent or no return)
  error: Error | null; // Error if handler threw
}
```

**Sync/Async Handler Support**:

The `onMessage()` handler can be either synchronous or asynchronous:

```typescript
// Async handler
async onMessage(payload: unknown, from: string | null): Promise<unknown> {
  await someAsyncOperation();
  return { result: 'data' };
}

// Sync handler
onMessage(payload: unknown, from: string | null): unknown {
  someSyncOperation();
  return { result: 'data' };
}
```

The messaging system uses `isPromise()` to detect async handlers and waits for them appropriately.

**Messaging During Shutdown**:

Messages are rejected early if the manager is shutting down OR if the target component is not running:

```typescript
async sendMessageToComponent(name: string, message: unknown): Promise<MessageResult> {
  // Reject if manager is shutting down
  if (this.isShuttingDown) {
    return {
      sent: false,
      componentFound: this.hasComponent(name),
      componentRunning: false,
      handlerImplemented: false,
      data: undefined,
      error: new Error('Cannot send message: shutdown in progress'),
    };
  }

  // Reject if component is not running
  if (!this.isComponentRunning(name)) {
    return {
      sent: false,
      componentFound: this.hasComponent(name),
      componentRunning: false,
      handlerImplemented: false,
      data: undefined,
      error: null,
    };
  }

  // ... proceed with message delivery
}
```

**Public API**:

```typescript
// Send message to specific component
// 'from' is automatically determined by the manager
async sendMessageToComponent(
  name: string,
  message: unknown,
): Promise<MessageResult>

// Broadcast message to components
// 'from' is automatically determined by the manager
async broadcastMessage(
  message: unknown,
  options?: {
    includeNonRunning?: boolean;
    componentNames?: string[];
  }
): Promise<BroadcastResult[]>
```

### 6. Event System

Use EventEmitter for lifecycle events. Events are for **monitoring and observability**, not control flow.

**Event Handler Execution**:

Event handlers are **fire-and-forget** - they are NOT awaited:

```typescript
// Events are emitted synchronously, handlers run independently
this.emit('component:started', { name: component.getName() });
// Manager continues immediately, doesn't wait for handlers
```

This design ensures:

- Event handlers cannot block lifecycle operations
- Slow or failing handlers don't affect component startup/shutdown
- Handlers can be async, but errors are their own responsibility

**Event Handler Safety Guarantee**:

The LifecycleManager wraps all event emissions to prevent handler errors from breaking lifecycle operations:

```typescript
// Internal implementation
private safeEmit(event: string, data?: unknown): void {
  try {
    this.emit(event, data);
  } catch (error) {
    // Sync handler threw - log and continue
    this.logger.error('Event handler error', { event, error });
  }
  // Note: Async handlers that reject will create unhandled rejections
  // unless the handler catches its own errors
}
```

**Best practice for async event handlers**:

```typescript
// ❌ Bad - unhandled rejection if saveToDatabase fails
lifecycle.on('component:started', async (data) => {
  await saveToDatabase(data); // If this throws, unhandled rejection
});

// ✅ Good - catch your own errors
lifecycle.on('component:started', async (data) => {
  try {
    await saveToDatabase(data);
  } catch (error) {
    logger.error('Failed to save component start event', { error });
  }
});
```

If you need to react to events synchronously for control flow, use the result objects from lifecycle methods instead:

```typescript
// Instead of relying on events for control flow:
const result = await lifecycle.startComponent('database');
if (result.success) {
  // Component is now running
}
```

**Available Events**:

```typescript
// Lifecycle events
'lifecycle-manager:started'; // LifecycleManager initialized
'lifecycle-manager:shutdown-initiated'; // Shutdown requested
'lifecycle-manager:shutdown-completed'; // All components stopped
'lifecycle-manager:shutdown-timeout'; // Shutdown timed out
'lifecycle-manager:signals-attached'; // Signal handlers attached
'lifecycle-manager:signals-detached'; // Signal handlers detached

// Component registration events
'component:registered'; // Component added
'component:registration-rejected'; // Registration failed (duplicate name, during shutdown, etc.)
'component:unregistered'; // Component removed
'component:unregistered-during-shutdown'; // Component removed during shutdown

// Component startup events
'component:starting'; // Component.start() called
'component:started'; // Component.start() completed
'component:start-failed'; // Component.start() threw error (required component)
'component:start-failed-optional'; // Optional component failed (app continues)
'component:start-timeout'; // Component.start() timed out
'component:start-skipped'; // Skipped due to failed optional dependency
'component:startup-rollback'; // Rolling back due to startup failure

// Component shutdown events (multi-phase)
'component:shutdown-warning'; // onShutdownWarning() called
'component:shutdown-warning-completed'; // onShutdownWarning() finished
'component:shutdown-warning-timeout'; // onShutdownWarning() timed out
'component:stopping'; // stop() called (graceful phase)
'component:stopped'; // stop() completed
'component:stop-timeout'; // stop() timed out
'component:shutdown-force'; // onShutdownForce() called
'component:shutdown-force-completed'; // onShutdownForce() finished
'component:shutdown-force-timeout'; // onShutdownForce() timed out
'component:stalled'; // Component failed to stop completely

// Component messaging events
'component:message-sent'; // Message sent to component
'component:message-failed'; // Message handler threw error
'component:broadcast-started'; // Broadcast message started
'component:broadcast-completed'; // Broadcast message completed

// Signal events
'signal:shutdown'; // Shutdown signal received
'signal:reload'; // Reload signal received
'signal:info'; // Info signal received
'signal:debug'; // Debug signal received

// Health check events
'component:health-check-started'; // Health check initiated
'component:health-check-completed'; // Health check finished { name, healthy, durationMS }
'component:health-check-failed'; // Health check threw error { name, error }
```

## Core Features

### 1. Component Registration

**Registration Methods**:

```typescript
// Add at end (default)
registerComponent(
  component: BaseComponent,
  options?: RegisterOptions,
): RegisterComponentResult

// Insert at specific position
insertComponentAt(
  component: BaseComponent,
  position: 'start' | 'end' | 'before' | 'after',
  targetComponentName?: string,
  options?: RegisterOptions
): InsertComponentAtResult

// Remove component (async because it may need to stop the component first)
unregisterComponent(componentName: string, options?: UnregisterOptions): Promise<boolean>
```

**Unregister Options**:

```typescript
interface UnregisterOptions {
  stopIfRunning?: boolean; // Stop the component first if it's running (default: false)
}
```

**Unregister Behavior**:

```typescript
async unregisterComponent(name: string, options?: UnregisterOptions): Promise<boolean> {
  const component = this.getComponent(name);
  if (!component) {
    return false; // Component not found
  }

  const isRunning = this.isComponentRunning(name);

  // If running and stopIfRunning not set, reject
  if (isRunning && !options?.stopIfRunning) {
    this.logger.entity(name).warn(
      'Cannot unregister running component. Call stopComponent() first or pass { stopIfRunning: true }'
    );
    return false;
  }

  // If running and stopIfRunning is true, stop first
  if (isRunning && options?.stopIfRunning) {
    this.logger.entity(name).info('Stopping component before unregistering...');
    await this.stopComponent(name);
  }

  // Remove from registry
  this.components = this.components.filter(c => c.getName() !== name);
  this.emit('component:unregistered', { name });
  return true;
}
```

**Validation**:

- Enforce unique component names
- Enforce kebab-case naming convention
- **Prevent registration during shutdown** (while `isShuttingDown === true`)
  - `registerComponent()` returns `{ success: false, code: 'shutdown_in_progress', ... }` and may log warning
  - `insertComponentAt()` returns `{ success: false, code: 'shutdown_in_progress', ... }` and may log warning
  - Emit event: `component:registration-rejected` with reason
- Validate target component exists for 'before'/'after' positions
- Log warnings for failed registrations

**Registration During Startup/Runtime**:

Components can be registered while `startAllComponents()` is in progress or after it completes. By default, newly registered components are **not auto-started** - you must start them manually.

```typescript
interface RegisterOptions {
  autoStart?: boolean; // Auto-start if manager is running/starting (default: false)
}

// Default: register but don't auto-start
lifecycle.registerComponent(new CacheComponent(logger, { name: 'cache' }));
// Component is registered but NOT running
// Must call: await lifecycle.startComponent('cache');

// With autoStart: starts immediately if manager is running
lifecycle.registerComponent(new CacheComponent(logger, { name: 'cache' }), {
  autoStart: true,
});
```

**Auto-start behavior by manager state**:

| Manager State                 | `autoStart: false` (default) | `autoStart: true`                                          |
| ----------------------------- | ---------------------------- | ---------------------------------------------------------- |
| Not started yet               | Register only                | Register only (starts with `startAllComponents()`)         |
| Starting (`isStarting: true`) | Register only                | Register and start immediately (appended to startup queue) |
| Running (`isStarted: true`)   | Register only                | Register and start immediately                             |
| Shutting down                 | Rejected                     | Rejected                                                   |

**New state flag**: `isStarting: boolean` - true while `startAllComponents()` is in progress.

**Note**: Auto-started components are started at the end of the current component list. If component order matters (dependencies), register before calling `startAllComponents()` or manage order manually.

### 2. Component Lifecycle Management

**Individual Component Control**:

```typescript
// Start a specific component
startComponent(componentName: string): Promise<ComponentOperationResult>

// Stop a specific component
stopComponent(componentName: string): Promise<ComponentOperationResult>

// Restart a component (stop then start)
restartComponent(componentName: string): Promise<ComponentOperationResult>

interface ComponentOperationResult {
  success: boolean;
  componentName: string;
  reason?: string; // Human-readable explanation if !success
  error?: Error; // Underlying error if applicable
}
```

**Bulk Operations**:

```typescript
// Start all components in dependency order
startAllComponents(options?: StartupOptions): Promise<StartupResult>

// Stop all components in reverse dependency order
stopAllComponents(): Promise<ShutdownResult>

// Restart all components (like rebooting)
restartAllComponents(options?: StartupOptions): Promise<RestartResult>

interface StartupOptions {
  ignoreStalledComponents?: boolean; // Allow start even if stalled components exist
}

interface StartupResult {
  success: boolean;
  startedComponents: string[];
  failedOptionalComponents: Array<{ name: string; error: Error }>;
  skippedDueToDependency: string[];
  blockedByStalledComponents?: string[]; // Present if stalled components blocked startup
}

interface ShutdownResult {
  success: boolean; // True if all components stopped cleanly
  stoppedComponents: string[];
  stalledComponents: ComponentStallInfo[];
  durationMS: number;
}

interface RestartResult {
  shutdownResult: ShutdownResult;
  startupResult: StartupResult;
  success: boolean; // True only if both shutdown and startup succeeded
}
```

**`restartAllComponents()` Behavior**:

Restart is like rebooting a computer - a full stop followed by a full start:

```typescript
async restartAllComponents(options?: StartupOptions): Promise<RestartResult> {
  // Phase 1: Stop all components (reverse dependency order)
  const shutdownResult = await this.stopAllComponents();

  // Phase 2: Start all components (dependency order)
  const startupResult = await this.startAllComponents(options);

  return {
    shutdownResult,
    startupResult,
    success: shutdownResult.success && startupResult.success,
  };
}
```

**Important considerations**:

1. If `stopAllComponents()` has stalled components, the restart still attempts `startAllComponents()`. This is intentional - a reboot should try to bring the system back up even if shutdown was messy. However, `startAllComponents()` will fail if stalled components exist (unless `ignoreStalledComponents: true`).

2. If `startAllComponents()` fails after stop, normal startup rollback occurs. You're left with no running components (same as a failed boot).

3. There's no "atomic restart" - components are fully stopped before any are started. If you need rolling restarts (one at a time, keeping others running), use `restartComponent(name)` in a loop.

4. Events emitted: `lifecycle-manager:shutdown-initiated`, `lifecycle-manager:shutdown-completed`, then `lifecycle-manager:started` (or startup failure events).

```typescript
// Example: Handle restart failure
try {
  await lifecycle.restartAllComponents();
  console.log('Restart successful');
} catch (error) {
  if (error instanceof ComponentStartupError) {
    // Stop succeeded, but start failed
    console.error('System stopped but failed to restart:', error.message);
    process.exit(1); // Or attempt recovery
  }
}
```

**Partial Start Prevention**:

`startAllComponents()` requires a clean state - either no components running, or all components running:

```typescript
async startAllComponents(): Promise<void> {
  const runningCount = this.getRunningComponentCount();
  const totalCount = this.getComponentCount();

  // All running - nothing to do
  if (runningCount === totalCount) {
    this.logger.info('All components already running');
    return;
  }

  // Partial state - reject to avoid inconsistent startup
  if (runningCount > 0) {
    throw new Error(
      `Cannot start: ${runningCount}/${totalCount} components already running. ` +
      `Call stopAllComponents() first to ensure clean state.`
    );
  }

  // Clean state (0 running) - proceed with startup
  // ...
}
```

This prevents weird inconsistent states where some components started in a previous run and others didn't. If you need to start specific components individually, use `startComponent(name)` instead.

**Error Handling**:

- If a component fails to start: **rollback** - stop all previously started components in reverse order, then throw error
- If a component fails to stop: log error, mark as stalled, continue with others
- Distinguish between startup errors (critical, triggers rollback) and shutdown errors (best effort)

**Startup Rollback Behavior**:

When a component fails to start, the manager performs a rollback:

1. Emit `component:start-failed` event with error details
2. Stop all previously started components in **reverse order** (same as shutdown)
3. Emit `component:startup-rollback` event for each component being rolled back
4. After rollback completes, throw an error with the original failure reason
5. The manager is left in a clean state (no running components)

```typescript
// Example: If web-server fails to start after database started
// 1. database.start() ✓
// 2. cache.start() ✓
// 3. web-server.start() ✗ (throws error)
// 4. Rollback: cache.stop(), database.stop()
// 5. Throw: "Startup failed: web-server failed to start"
```

**Startup Timeout**:

Each component can configure a startup timeout via `startupTimeoutMS` (default: 30000ms).
If `start()` takes longer than this timeout:

1. Emit `component:start-timeout` event
2. Treat as startup failure, trigger rollback
3. The component's `start()` promise is NOT cancelled (no way to do this in JS), but the manager proceeds with rollback

There's also a global `startupTimeoutMS` on `LifecycleManagerOptions` (default: 60000ms) that acts as a hard ceiling for the entire `startAllComponents()` operation.

**Shutdown During Startup**:

If a shutdown signal is received while `startAllComponents()` is in progress:

1. Set `isShuttingDown = true`, abort further startup
2. Don't start any remaining components
3. Rollback already-started components (stop in reverse order)
4. Do NOT proceed with full shutdown sequence (we're already stopping everything)
5. Emit `lifecycle-manager:shutdown-initiated` with context indicating it was during startup
6. After rollback completes, emit `lifecycle-manager:shutdown-completed`

```typescript
// Example: Startup interrupted by SIGINT
// Components: [database, cache, web-server, api-server]
// 1. database.start() ✓
// 2. cache.start() ✓
// 3. SIGINT received!
// 4. Skip web-server, api-server
// 5. Rollback: cache.stop(), database.stop()
// 6. Done - no further shutdown needed
```

**Concurrent Operation Prevention**:

Individual component operations are rejected during bulk operations:

```typescript
// During startAllComponents():
startComponent(name); // Returns false, logs warning
stopComponent(name); // Returns false, logs warning
restartComponent(name); // Returns false, logs warning

// During stopAllComponents():
startComponent(name); // Returns false, logs warning
stopComponent(name); // Returns false, logs warning (already stopping)
restartComponent(name); // Returns false, logs warning
```

This prevents race conditions and ensures predictable behavior. If you need fine-grained control, wait for bulk operations to complete first.

### 3. Status Tracking

**Component Status**:

```typescript
// Check if component is registered
hasComponent(componentName: string): boolean

// Check if component is running
isComponentRunning(componentName: string): boolean

// Get all registered component names
getComponentNames(): string[]

// Get all running component names
getRunningComponentNames(): string[]

// Get component count
getComponentCount(): number
getRunningComponentCount(): number

// Get detailed component status
getComponentStatus(componentName: string): ComponentStatus | undefined

// Get all component statuses
getAllComponentStatuses(): ComponentStatus[]
```

**Component Status Details**:

```typescript
type ComponentState =
  | 'registered' // Registered but never started
  | 'starting' // start() in progress
  | 'running' // start() completed successfully
  | 'stopping' // stop() in progress (graceful phase)
  | 'force-stopping' // onShutdownForce() in progress
  | 'stopped' // stop() completed (can be restarted)
  | 'stalled'; // Failed to stop within timeout

interface ComponentStatus {
  name: string;
  state: ComponentState;
  startedAt: number | null; // Unix timestamp ms when start() completed
  stoppedAt: number | null; // Unix timestamp ms when stop() completed
  lastError: Error | null; // Last error from start/stop/message
  stallInfo: ComponentStallInfo | null; // If stalled, details about why
}
```

This detailed status allows you to:

- Know exactly what phase a component is in during transitions
- Track timing information for monitoring
- Access error details without relying on events
- Distinguish between "not started yet" and "stopped after running"

**Manager Status**:

```typescript
// Overall state
isStarting: boolean          // startAllComponents() in progress
isStarted: boolean           // All components started successfully
isShuttingDown: boolean      // Shutdown in progress
isShutdownComplete: boolean  // All components stopped

// Detailed system state
getSystemState(): SystemState

type SystemState =
  | 'idle'           // No components, nothing happening
  | 'ready'          // Components registered, not started
  | 'starting'       // startAllComponents() in progress
  | 'running'        // All components running
  | 'partial'        // Some components running (after individual start/stop)
  | 'shutting-down'  // stopAllComponents() in progress
  | 'stopped'        // All components stopped (can restart)
  | 'error';         // Startup failed with rollback

// Shutdown details
shutdownMethod: ShutdownMethod | null    // 'manual' | 'SIGINT' | 'SIGTERM' | 'SIGTRAP'
shutdownStartTime: number               // Unix timestamp ms
shutdownDuration: number                // ms
stalledComponents: ComponentStallInfo[] // Components that failed to stop
```

**Note on `isStarted`**:

The `isStarted` flag is `true` only after `startAllComponents()` completes successfully. If you start components individually via `startComponent()`, use `getSystemState()` which will return `'partial'` or check `getRunningComponentCount() > 0`.

### 4. Signal Integration

**Automatic Signal Handling**:

- When `attachSignals()` is called, ProcessSignalManager handles:
  - **Shutdown signals** (SIGINT, SIGTERM, SIGTRAP, Ctrl+C, Escape): trigger `stopAllComponents()`
  - **Reload signal** (SIGHUP, R key): call `onReload()` on all running components (if implemented)
  - **Info signal** (SIGUSR1, I key): call `onInfo()` on all running components (if implemented)
  - **Debug signal** (SIGUSR2, D key): call `onDebug()` on all running components (if implemented)

**Manual Triggers**:

```typescript
// Manually trigger signals (useful for testing or programmatic control)
triggerShutdown(method: 'SIGINT' | 'SIGTERM' | 'SIGTRAP' = 'SIGINT'): void
triggerReload(): Promise<SignalBroadcastResult>
triggerInfo(): Promise<SignalBroadcastResult>
triggerDebug(): Promise<SignalBroadcastResult>
```

**Signal Broadcast Results**:

Reload, info, and debug triggers return results showing what happened:

```typescript
interface SignalBroadcastResult {
  signal: 'reload' | 'info' | 'debug';
  results: ComponentSignalResult[];
}

interface ComponentSignalResult {
  name: string;
  called: boolean; // True if handler was called (component implements it)
  error: Error | null; // Error if handler threw
}
```

**Error Handling for Reload/Info/Debug**:

Errors in signal handlers are **graceful** - they don't stop the broadcast:

1. Call handler on each running component that implements it
2. If handler throws → log error, emit event, **continue to next component**
3. Collect all results (successes and failures)
4. Return aggregate result

```typescript
const result = await lifecycle.triggerReload();

// Example result:
// {
//   signal: 'reload',
//   results: [
//     { name: 'database', called: true, error: null },
//     { name: 'web-server', called: true, error: Error('Config file not found') },
//     { name: 'cache', called: false, error: null },  // No onReload() implemented
//   ]
// }

// Check for failures
const failures = result.results.filter((r) => r.error);
if (failures.length > 0) {
  logger.warn('Some components failed to reload', {
    failed: failures.map((f) => f.name),
  });
}
```

**Events**:

```typescript
// Per-component events
'component:reload-started'; // { name }
'component:reload-completed'; // { name }
'component:reload-failed'; // { name, error }

'component:info-started'; // { name }
'component:info-completed'; // { name }
'component:info-failed'; // { name, error }

'component:debug-started'; // { name }
'component:debug-completed'; // { name }
'component:debug-failed'; // { name, error }
```

### 5. Restart Behavior and State Management

**Shutdown-to-Restart Cycle**:

After a complete shutdown, the LifecycleManager can be restarted:

```typescript
// Initial startup
await lifecycle.startAllComponents();
lifecycle.attachSignals();

// ... application runs ...

// Shutdown (triggered by signal or manually)
await lifecycle.stopAllComponents();

// State is now reset - can restart
await lifecycle.startAllComponents(); // Works! Components restart
```

**State Reset on Shutdown Completion**:

When shutdown completes (successfully or via timeout):

1. Set `isShuttingDown = false`
2. Clear `shutdownMethod = null`
3. Clear `runningComponents` set
4. Clear `stalledComponents` map
5. Preserve component registration (components remain registered)
6. Emit `lifecycle-manager:shutdown-completed` event

**Partial Restart**:

You can start individual components after shutdown:

```typescript
// After shutdown, start just the database
await lifecycle.startComponent('database');

// Later, start the rest
await lifecycle.startComponent('web-server');
```

**Registration Persists Across Restarts**:

Components remain registered after shutdown. To fully reset:

```typescript
// Option 1: Unregister all components
for (const name of lifecycle.getComponentNames()) {
  await lifecycle.unregisterComponent(name);
}

// Option 2: Create a new LifecycleManager instance
const newLifecycle = new LifecycleManager({ logger });
```

**Error Recovery**:

If shutdown fails (stalls or times out), the manager still resets state to allow recovery:

- `isShuttingDown = false` (allows restart attempt)
- Stalled components remain registered but not running
- Application can choose to:
  - Retry: `await lifecycle.startAllComponents()`
  - Cleanup: Unregister stalled components, then restart
  - Exit: `process.exit(1)` on timeout event

**Best Practice**:

For most applications, the lifecycle manager is a singleton that runs for the process lifetime. Shutdown typically means process exit. However, supporting restart enables:

- Testing scenarios (start/stop/restart in tests)
- Hot reload workflows (stop components, reload code, restart)
- Graceful degradation (stop failing components, restart healthy ones)

**Multiple LifecycleManager Instances**:

Multiple LifecycleManager instances are allowed and can coexist. Each instance manages its own set of components independently. However, be aware of signal handling:

- Only ONE instance should call `attachSignals()` at a time
- If multiple instances attach signals, the ProcessSignalManager handles this (last one wins for shutdown trigger, but this is confusing)
- **Recommendation**: If using multiple instances, manage signals manually or use a single "root" instance for signal handling

Use cases for multiple instances:

- Separate component groups with independent lifecycles
- Testing (create fresh instance per test)
- Plugin systems where each plugin has its own lifecycle

```typescript
// Example: Two independent lifecycle managers
const coreLifecycle = new LifecycleManager({ logger, name: 'core' });
const pluginLifecycle = new LifecycleManager({ logger, name: 'plugins' });

// Only attach signals to one
coreLifecycle.attachSignals();

// Manually propagate shutdown to the other
coreLifecycle.on('lifecycle-manager:shutdown-initiated', async () => {
  await pluginLifecycle.stopAllComponents();
});
```

### 6. Timeout Configuration

```typescript
interface LifecycleManagerOptions {
  name?: string; // Name for logger scope (default: 'lifecycle-manager')
  logger: Logger; // Root logger instance
  startupTimeoutMS?: number; // Global timeout for startup (default: 60000, 0 = disabled)
  shutdownTimeoutMS?: number; // Global timeout for shutdown (default: 30000, 0 = disabled)
  attachSignalsOnStart?: boolean; // Auto-attach signals when first component starts (default: false)
  detachSignalsOnStop?: boolean; // Auto-detach signals when last component stops (default: false)
}
```

**Timeout Precedence**:

Per-component timeouts are configured in `ComponentOptions`, not `LifecycleManagerOptions`:

- `startupTimeoutMS` - per-component startup timeout (default: 30000ms, 0 = no timeout)
- `shutdownWarningTimeoutMS` - per-component warning phase timeout (default: 0 = skip warning phase)
- `shutdownGracefulTimeoutMS` - per-component graceful shutdown timeout (default: 5000ms, minimum: 1000ms)
- `shutdownForceTimeoutMS` - per-component force shutdown timeout (default: 2000ms, minimum: 500ms)

**Global vs Per-Component Timeout Interaction**:

The global timeouts (`startupTimeoutMS`, `shutdownTimeoutMS`) act as hard ceilings:

- If the global timeout is reached, the operation aborts immediately
- For startup: triggers rollback, throws `StartupTimeoutError`
- For shutdown: remaining components are marked as stalled
- Per-component timeouts are respected up until the global timeout
- If a component's per-component timeout exceeds remaining global time, the global timeout wins

```typescript
// Example: Global shutdown timeout = 10s, Component has graceful timeout = 15s
// Component will only get ~10s (or less if other components used some time)

// Example: Global startup timeout = 60s, 5 components with 30s each
// If first 2 components take 25s each, remaining components only get 10s total
```

**Recommendation**: Set global timeouts to be larger than the sum of expected per-component timeouts, with some buffer.

### 7. Component Dependencies

Components can declare explicit dependencies on other components. The LifecycleManager performs topological sort to determine startup order and reverses it for shutdown.

**Declaration**:

```typescript
export interface ComponentOptions {
  name: string;
  dependencies?: string[]; // Names of components this one depends on
  // ... other options
}

class ApiComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database', 'cache'], // API needs database and cache to start first
    });
  }
}
```

**Behavior**:

- **Startup**: Dependencies start before dependents. `database` and `cache` start before `api`.
- **Shutdown**: Reverse order. `api` stops before `database` and `cache`.
- **Cycle Detection**: Circular dependencies throw `DependencyCycleError` at registration time.
- **Missing Dependencies**: If a dependency isn't registered, throw `MissingDependencyError` at `startAllComponents()`.

**Interaction with Registration Order**:

- Dependencies take precedence over registration order
- Components without dependencies maintain their registration order relative to each other
- `insertComponentAt()` positions are respected within dependency constraints

```typescript
// Example: Registration order vs dependencies
lifecycle.registerComponent(new ApiComponent(logger)); // depends on ['database']
lifecycle.registerComponent(new DatabaseComponent(logger)); // no dependencies

// Despite API being registered first, database starts first due to dependency
await lifecycle.startAllComponents();
// Start order: database -> api
// Stop order: api -> database
```

**Public API**:

```typescript
// Get resolved startup order (after topological sort)
getStartupOrder(): string[]
```

**Automatic Validation**:

- **Cycle Detection**: Circular dependencies throw `DependencyCycleError` at registration time
- **Missing Dependencies**: If a dependency isn't registered, throw `MissingDependencyError` at `startAllComponents()` time

### 8. Health Checks

Components can implement optional health checks for runtime monitoring. Health checks can return a simple boolean or a rich result with metadata.

**Component Health Result**:

```typescript
interface ComponentHealthResult {
  healthy: boolean;
  message?: string; // Human-readable status
  details?: Record<string, unknown>; // Arbitrary metrics/metadata
}
```

**Declaration**:

```typescript
abstract class BaseComponent {
  // Return boolean OR rich result with metadata
  public healthCheck?():
    | Promise<boolean | ComponentHealthResult>
    | boolean
    | ComponentHealthResult;
}
```

**Simple Example** (just boolean):

```typescript
class CacheComponent extends BaseComponent {
  healthCheck() {
    return this.redis.isConnected();
  }
}
```

**Rich Example** (with metadata):

```typescript
class DatabaseComponent extends BaseComponent {
  async healthCheck() {
    const stats = await this.pool.stats();
    const isHealthy = stats.waitingRequests < 100;

    return {
      healthy: isHealthy,
      message: isHealthy ? 'Pool healthy' : 'Pool under pressure',
      details: {
        activeConnections: stats.active,
        idleConnections: stats.idle,
        waitingRequests: stats.waiting,
        maxConnections: stats.max,
        lastQueryLatencyMs: this.lastQueryLatency,
      },
    };
  }
}

class QueueComponent extends BaseComponent {
  async healthCheck() {
    const depth = await this.queue.depth();

    return {
      healthy: depth < 10000,
      message: depth > 5000 ? 'Queue backing up' : 'Processing normally',
      details: {
        queueDepth: depth,
        processedLastMinute: this.metrics.processedLastMinute,
        errorRate: this.metrics.errorRate,
        oldestMessageAge: this.metrics.oldestMessageAge,
      },
    };
  }
}
```

**Manager API**:

```typescript
// Check single component health
checkComponentHealth(name: string): Promise<HealthCheckResult>

// Check all running components
checkAllHealth(): Promise<HealthReport>

interface HealthCheckResult {
  name: string;
  healthy: boolean;
  message?: string;                    // From component's result
  details?: Record<string, unknown>;   // From component's result
  checkedAt: number;                   // Unix timestamp ms
  durationMS: number;
  error: Error | null;                 // If health check threw
}

interface HealthReport {
  healthy: boolean; // True only if ALL components are healthy
  components: HealthCheckResult[];
  checkedAt: number;
  durationMS: number;
}
```

**Example Output**:

```typescript
const health = await lifecycle.checkAllHealth();
// {
//   healthy: false,
//   checkedAt: 1706123456789,
//   durationMS: 45,
//   components: [
//     {
//       name: 'database',
//       healthy: true,
//       message: 'Pool healthy',
//       details: { activeConnections: 5, idleConnections: 10 },
//       checkedAt: 1706123456789,
//       durationMS: 12,
//       error: null,
//     },
//     {
//       name: 'queue',
//       healthy: false,
//       message: 'Queue backing up',
//       details: { queueDepth: 8500, processedLastMinute: 120 },
//       checkedAt: 1706123456801,
//       durationMS: 33,
//       error: null,
//     },
//   ],
// }
```

**Behavior**:

- Health checks have a default timeout of 5000ms (configurable via `healthCheckTimeoutMS` in options)
- **Timeout = unhealthy**: If health check doesn't respond in time, it's treated as `{ healthy: false, message: 'Health check timed out' }`
- **No abort callback**: Health checks are simple probes - if they're slow, that's the answer
- Components without `healthCheck()` are assumed healthy (not included in report, or included with `healthy: true`)
- Health check errors (throws) are treated as unhealthy with `error` populated
- Health checks only run on `'running'` components
- Boolean return is normalized to `{ healthy: <boolean> }`

**Implementation Note**:

```typescript
// Manager internally races against timeout
const result = await Promise.race([
  component.healthCheck(),
  sleep(timeout).then(() => ({
    healthy: false,
    message: 'Health check timed out',
  })),
]);
```

**Events**:

```typescript
'component:health-check-started';
'component:health-check-completed'; // { name, healthy, message, details, durationMS }
'component:health-check-failed'; // { name, error }
```

### 9. Shared Values (getValue Pattern)

Components can expose values that other components or external code can request. This follows the same pattern as messaging for consistency.

**Component Implementation**:

Components implement optional `getValue(key, from)` method to provide values on-demand:

```typescript
class DatabaseComponent extends BaseComponent {
  private pool!: Pool;
  private config!: DatabaseConfig;

  async start() {
    this.pool = await createPool(this.config);
  }

  // Optional getValue handler - like onMessage
  getValue(key: string, from: string | null): unknown {
    // 'from' is component name if another component requested, null if external

    if (from === null) {
      // External request - could require auth or log it
      this.logger.info(`External request for ${key}`);
    }

    if (key === 'pool') return this.pool;
    if (key === 'config') return this.config;

    return undefined; // Key not found
  }

  async stop() {
    await this.pool.end();
  }
}
```

**Requesting Values**:

Always returns a result object - simple and consistent:

```typescript
class ApiComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database'], // Ensures database is running first
    });
  }

  async start() {
    // Request value from another component
    // Manager calls database.getValue('pool', 'api')
    const result = this.lifecycle.getValue<Pool>('database', 'pool');

    if (!result.found) {
      throw new Error('Could not get database pool');
    }

    this.app.use((req, res, next) => {
      req.db = result.value;
      next();
    });
  }
}

// External code (from = null)
// Manager calls database.getValue('pool', null)
const result = lifecycle.getValue<Pool>('database', 'pool');
if (result.found) {
  usePool(result.value);
}
```

**API** (simple - just one method):

```typescript
// On BaseComponent (optional)
getValue?(key: string, from: string | null): unknown;

// On LifecycleManager (always returns result object)
getValue<T>(componentName: string, key: string): GetValueResult<T>;
```

**Result Object**:

```typescript
interface GetValueResult<T> {
  found: boolean; // True if getValue returned non-undefined
  value: T | undefined; // The returned value
  componentFound: boolean; // Component exists in registry
  componentRunning: boolean; // Component is in 'running' state
  handlerImplemented: boolean; // Component has getValue() method
  requestedBy: string | null; // Who requested (for logging)
}
```

**Behavior**:

- Values are provided **on-demand** (no storage in manager)
- Component must be in `'running'` state for getValue to be called
- If component doesn't implement `getValue()`, result has `handlerImplemented: false`
- Components can return different values based on `from` parameter (access control)
- **Automatic "from" tracking**: Works identically to messaging - `from` is automatically determined based on calling context
- Simple and consistent with messaging pattern

**Dependency Guarantee**:

If component A depends on component B, A's `start()` runs after B's, so getValue is safe:

```typescript
class ApiComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database'], // Guarantees database.start() completed
    });
  }

  async start() {
    // Safe - database is running
    const result = this.lifecycle.getValue<Pool>('database', 'pool');
    if (result.found) {
      usePool(result.value);
    }
  }
}
```

**Events**:

```typescript
'component:value-requested'; // { componentName, key, from }
'component:value-returned'; // { componentName, key, from, found }
```

**Consistency Note**:

The getValue pattern mirrors messaging for easy understanding:

| Feature       | Component Method           | Manager Method                      | Automatic Tracking |
| ------------- | -------------------------- | ----------------------------------- | ------------------ |
| **Messaging** | `onMessage(payload, from)` | `sendMessageToComponent(name, msg)` | ✅ Yes             |
| **Values**    | `getValue(key, from)`      | `getValue(name, key)`               | ✅ Yes             |

Both use the same pattern:

- Component handlers receive `(data, from)` parameters
- Manager tracks `from` automatically via `this.lifecycle`
- Both return result objects with detailed status
- Both are optional handlers

### 10. Optional Components

Components can be marked as optional so their startup failures don't trigger rollback.

**Declaration**:

```typescript
export interface ComponentOptions {
  name: string;
  optional?: boolean; // If true, startup failure logs warning but continues (default: false)
  // ... other options
}

new CacheComponent(logger, {
  name: 'cache',
  optional: true, // Redis down? App still starts
});
```

**Behavior**:

- **Startup failure**: Log warning, mark component as `'failed'`, continue with other components
- **No rollback**: Other components keep running
- **Dependency handling**: If an optional component fails, components that depend on it also fail (but don't rollback if they're also optional)
- **State tracking**: Failed optional components have state `'failed'` (new state)

**New Component State**:

```typescript
type ComponentState =
  | 'registered'
  | 'starting'
  | 'running'
  | 'failed' // NEW: Optional component failed to start
  | 'stopping'
  | 'force-stopping'
  | 'stopped'
  | 'stalled';
```

**Startup Result**:

```typescript
// startAllComponents() returns detailed result instead of void
async startAllComponents(): Promise<StartupResult>

interface StartupResult {
  success: boolean; // True if all required components started
  startedComponents: string[];
  failedOptionalComponents: Array<{
    name: string;
    error: Error;
  }>;
  skippedDueToDependency: string[]; // Components skipped because their optional dependency failed
}
```

**Example**:

```typescript
const result = await lifecycle.startAllComponents();
if (!result.success) {
  // Required component failed - app cannot run
  process.exit(1);
}
if (result.failedOptionalComponents.length > 0) {
  // Some optional components failed - app is degraded but functional
  logger.warn('Running in degraded mode', {
    failed: result.failedOptionalComponents.map((f) => f.name),
  });
}
```

### 11. Abort Callbacks

Components can implement optional abort callbacks that are called when the manager times out an operation. This provides cooperative cancellation without cluttering method signatures.

**Available Abort Callbacks**:

```typescript
abstract class BaseComponent {
  // Called when start() times out
  public onStartupAborted?(): void;

  // Called when stop() times out (before force phase begins)
  public onStopAborted?(): void;

  // Called when onShutdownWarning() times out
  public onShutdownWarningAborted?(): void;

  // Called when onShutdownForce() times out
  public onShutdownForceAborted?(): void;
}
```

**Usage**:

```typescript
class DatabaseComponent extends BaseComponent {
  private aborted = false;
  private abortController = new AbortController();

  async start() {
    // Option 1: Check flag periodically for long operations
    for (const migration of migrations) {
      if (this.aborted) {
        throw new Error('Startup aborted');
      }
      await this.runMigration(migration);
    }

    // Option 2: Use AbortController for APIs that support it
    await this.pool.connect({ signal: this.abortController.signal });
  }

  onStartupAborted() {
    // Called by manager when startup times out
    this.aborted = true;
    this.abortController.abort();
    this.logger.warn('Startup aborted due to timeout');
  }

  async stop() {
    await this.pool.drain();
  }

  onStopAborted() {
    // Called when graceful stop times out, force phase is about to begin
    this.pool.destroyAllNow(); // More aggressive cleanup
  }
}
```

**Behavior**:

- Abort callbacks are called **synchronously** by the manager just before proceeding
- The manager does NOT wait for the original operation to complete after calling abort
- Abort callbacks should be fast and non-blocking (set flags, trigger cleanup)
- If a component doesn't implement the callback, the manager proceeds without notification

**Timeline Example**:

```
0ms    - manager calls component.start()
25000ms - startup timeout reached
25000ms - manager calls component.onStartupAborted() (if implemented)
25000ms - manager proceeds with rollback (doesn't wait for start() to return)
???ms  - component's start() eventually returns (ignored by manager)
```

**Components that need AbortSignal for native APIs**:

```typescript
class FetchComponent extends BaseComponent {
  private abortController = new AbortController();

  async start() {
    // Pass signal to fetch, streams, timers, etc.
    const response = await fetch(url, {
      signal: this.abortController.signal,
    });
  }

  onStartupAborted() {
    // Abort the controller, which cancels the fetch
    this.abortController.abort();
  }
}
```

### 12. Snapshot List Guarantee

Bulk operations (`startAllComponents()`, `stopAllComponents()`, `restartAllComponents()`) operate on a **snapshot** of the component list taken at invocation.

**Guarantees**:

1. **Registration during bulk start**: Components registered with `autoStart: true` during `startAllComponents()` are appended to the snapshot and started after the original list completes.

2. **Unregistration during bulk operations**: Components unregistered during a bulk operation are skipped when their turn comes (not removed mid-iteration).

3. **No concurrent modification**: The internal component array is not mutated during iteration. Operations queue modifications for after the bulk operation completes.

**Example**:

```typescript
// Components: [database, cache, api]
lifecycle.startAllComponents(); // Takes snapshot: [database, cache, api]

// During database.start():
lifecycle.registerComponent(new MetricsComponent(logger), { autoStart: true });
// Metrics is appended to snapshot: [database, cache, api, metrics]

// During cache.start():
await lifecycle.unregisterComponent('api', { stopIfRunning: false });
// api is marked for skip, but still in snapshot

// Final start order: database -> cache -> (api skipped) -> metrics
```

### 13. Shutdown Result and Stalled Component Handling

**Shutdown Result Persistence**:

Shutdown results are preserved until the next startup attempt:

```typescript
interface ShutdownResult {
  completedAt: number; // Unix timestamp ms
  durationMS: number;
  method: ShutdownMethod;
  stoppedComponents: string[];
  stalledComponents: ComponentStallInfo[];
  errors: Array<{ component: string; phase: string; error: Error }>;
}

// Available after shutdown, cleared on next startAllComponents()
getLastShutdownResult(): ShutdownResult | null

// Convenience method
getStalledComponents(): ComponentStallInfo[]
```

**Stalled Components Block Restart**:

If any component is in `'stalled'` state, `startAllComponents()` returns a failure result:

```typescript
const result = await lifecycle.startAllComponents();
// result.success === false if stalled components exist
// result.blockedByStalledComponents === ['component-name', ...]
```

**Recovery Options**:

```typescript
// Option 1: Unregister stalled components individually
for (const name of lifecycle.getStalledComponents().map((s) => s.name)) {
  await lifecycle.unregisterComponent(name);
}
await lifecycle.startAllComponents();

// Option 2: Unregister all components and re-register
await lifecycle.unregisterAllComponents();
// Re-register fresh component instances...
await lifecycle.startAllComponents();

// Option 3: Force restart (acknowledge the risk of zombie processes)
await lifecycle.startAllComponents({ ignoreStalledComponents: true });
```

**New Helper Method**:

```typescript
// Unregister all components (useful for full reset)
async unregisterAllComponents(): Promise<void>
```

## Type Definitions

```typescript
// Shutdown method - how shutdown was triggered
type ShutdownMethod = 'manual' | 'SIGINT' | 'SIGTERM' | 'SIGTRAP';

// Shutdown signal - for manual trigger method parameter
type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGTRAP';

// Insert position for component ordering
type InsertPosition = 'start' | 'end' | 'before' | 'after';

// Options for component registration
interface RegisterOptions {
  autoStart?: boolean; // Auto-start if manager is running/starting (default: false)
}

// Options for component unregistration
interface UnregisterOptions {
  stopIfRunning?: boolean; // Stop the component first if it's running (default: false)
}

// Signal broadcast result (for reload/info/debug)
interface SignalBroadcastResult {
  signal: 'reload' | 'info' | 'debug';
  results: ComponentSignalResult[];
}

interface ComponentSignalResult {
  name: string;
  called: boolean; // True if handler was called
  error: Error | null; // Error if handler threw
}

// Component health check result (returned by component)
interface ComponentHealthResult {
  healthy: boolean;
  message?: string;
  details?: Record<string, unknown>;
}

// Shared value lookup result (matches messaging pattern)
interface GetValueResult<T> {
  found: boolean; // True if getValue returned non-undefined
  value: T | undefined; // The returned value
  componentFound: boolean; // Component exists in registry
  componentRunning: boolean; // Component is in 'running' state
  handlerImplemented: boolean; // Component has getValue() method
  requestedBy: string | null; // Who requested (for logging)
}

// Component state during lifecycle
type ComponentState =
  | 'registered' // Registered but never started
  | 'starting' // start() in progress
  | 'running' // start() completed successfully
  | 'failed' // Optional component failed to start (can retry)
  | 'stopping' // stop() in progress (graceful phase)
  | 'force-stopping' // onShutdownForce() in progress
  | 'stopped' // stop() completed (can be restarted)
  | 'stalled'; // Failed to stop within timeout

// Detailed component status
interface ComponentStatus {
  name: string;
  state: ComponentState;
  startedAt: number | null;
  stoppedAt: number | null;
  lastError: Error | null;
  stallInfo: ComponentStallInfo | null;
}

// Overall system state
type SystemState =
  | 'idle' // No components, nothing happening
  | 'ready' // Components registered, not started
  | 'starting' // startAllComponents() in progress
  | 'running' // All components running
  | 'partial' // Some components running (after individual start/stop)
  | 'shutting-down' // stopAllComponents() in progress
  | 'stopped' // All components stopped (can restart)
  | 'error'; // Startup failed with rollback

// Information about a component that failed to stop
interface ComponentStallInfo {
  name: string;
  phase: 'warning' | 'graceful' | 'force';
  reason: 'timeout' | 'error' | 'both';
  error?: Error;
  startedAt: number; // Unix timestamp ms when shutdown started for this component
  stalledAt: number; // Unix timestamp ms when component was marked as stalled
}
```

## API Design: Returns vs Throws

The LifecycleManager uses a consistent pattern for error handling:

**Return result objects** for runtime operations that can fail for expected reasons:

| Method                     | Returns                             | Failure Examples                                    |
| -------------------------- | ----------------------------------- | --------------------------------------------------- |
| `startComponent(name)`     | `Promise<ComponentOperationResult>` | Already running, not found, during shutdown         |
| `stopComponent(name)`      | `Promise<ComponentOperationResult>` | Not running, not found, stalled                     |
| `startAllComponents()`     | `Promise<StartupResult>`            | Optional component failed, stalled components exist |
| `stopAllComponents()`      | `Promise<ShutdownResult>`           | Components stalled                                  |
| `sendMessageToComponent()` | `Promise<MessageResult>`            | Component not found, not running, handler error     |
| `registerComponent()`      | `RegisterComponentResult`           | Duplicate name, during shutdown                     |
| `insertComponentAt()`      | `InsertComponentAtResult`           | Target not found, duplicate name, during shutdown   |
| `unregisterComponent()`    | `Promise<boolean>`                  | Not found, running without stopIfRunning            |

**Throw errors** only for programmer mistakes (bugs in calling code):

| Error                        | When Thrown                                  |
| ---------------------------- | -------------------------------------------- |
| `InvalidComponentNameError`  | Component name isn't valid kebab-case        |
| `DependencyCycleError`       | Circular dependency detected at registration |
| `ComponentRegistrationError` | Invalid registration inputs (bug in caller)  |

**Result Object Pattern**:

```typescript
interface ComponentOperationResult {
  success: boolean;
  componentName: string;
  reason?: string; // Human-readable explanation if !success
  error?: Error; // Underlying error if applicable
}

// Usage - no try/catch needed for expected failures
const result = await lifecycle.startComponent('database');
if (!result.success) {
  logger.warn(`Failed to start database: ${result.reason}`);
  // Handle gracefully - not an exception
}
```

**Rationale**:

- Runtime failures are expected (components can fail, timeouts happen)
- Result objects provide structured information without stack trace overhead
- Calling code doesn't need try/catch for every operation
- Easier to handle partial success (e.g., some components started, some failed)
- Throws reserved for "this should never happen if you're using the API correctly"

## Error Classes

Error classes are used for **programmer mistakes only** (thrown, not returned). Runtime failures are communicated via result objects.

```typescript
/**
 * Base class for all LifecycleManager errors
 */
export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LifecycleError';
  }
}

/**
 * Thrown when a component name doesn't follow kebab-case convention
 */
export class InvalidComponentNameError extends LifecycleError {
  constructor(public readonly componentName: string) {
    super(
      `Invalid component name '${componentName}'. ` +
        `Must be kebab-case (lowercase letters, numbers, hyphens). ` +
        `Examples: 'database', 'web-server', 'api-gateway-v2'`,
    );
    this.name = 'InvalidComponentNameError';
  }
}

/**
 * Thrown when component dependencies form a cycle
 */
export class DependencyCycleError extends LifecycleError {
  constructor(public readonly cycle: string[]) {
    super(`Circular dependency detected: ${cycle.join(' -> ')}`);
    this.name = 'DependencyCycleError';
  }
}

/**
 * Note on insertComponentAt() targeting:
 *
 * Target-not-found is treated as an expected runtime failure and is returned
 * as a result object (e.g. `{ success: false, code: 'target_not_found', ... }`)
 * rather than thrown.
 */
/**
 * Thrown when a required dependency is not registered
 * (only at startAllComponents() time, not registration)
 */
export class MissingDependencyError extends LifecycleError {
  constructor(
    public readonly componentName: string,
    public readonly missingDependencies: string[],
  ) {
    super(
      `Component '${componentName}' has missing dependencies: [${missingDependencies.join(', ')}]`,
    );
    this.name = 'MissingDependencyError';
  }
}
```

**Usage Example**:

```typescript
import {
  InvalidComponentNameError,
  DependencyCycleError,
} from './lifecycle-manager';

// These are programmer errors - fix your code, don't catch and retry
try {
  lifecycle.registerComponent(new MyComponent(logger, { name: 'BAD NAME' }));
} catch (error) {
  if (error instanceof InvalidComponentNameError) {
    // Bug in your code - component name must be kebab-case
    console.error('Fix the component name in your code:', error.message);
  }
}

// Runtime failures use result objects - no try/catch needed
const result = await lifecycle.startAllComponents();
if (!result.success) {
  if (result.blockedByStalledComponents) {
    // Handle stalled components
    for (const name of result.blockedByStalledComponents) {
      await lifecycle.unregisterComponent(name);
    }
    // Retry
    await lifecycle.startAllComponents();
  } else if (result.failedOptionalComponents.length > 0) {
    // Some optional components failed - app runs degraded
    logger.warn('Running in degraded mode');
  }
}
```

## Implementation Details

### Class Structure

```typescript
export class LifecycleManager extends EventEmitter {
  // Configuration
  private readonly name: string;
  private readonly logger: LoggerService;
  private readonly rootLogger: Logger;
  private readonly shutdownTimeoutMS: number;
  private readonly componentStopTimeoutMS: number;

  // Component management
  private components: BaseComponent[];
  private runningComponents: Set<string>;

  // Signal management
  private processSignalManager: ProcessSignalManager;
  private signalsAttached: boolean;

  // Startup state
  private isStarting: boolean;

  // Shutdown state
  private isShuttingDown: boolean;
  private shutdownMethod: ShutdownMethod | null;
  private shutdownStartTime: number;
  private shutdownTimeout: Timeout | null;
  private stalledComponents: Map<string, ComponentStallInfo>;

  constructor(options: LifecycleManagerOptions);

  // Component registration
  public registerComponent(
    component: BaseComponent,
    options?: RegisterOptions,
  ): boolean;
  public insertComponentAt(
    component: BaseComponent,
    position: InsertPosition,
    target?: string,
    options?: RegisterOptions,
  ): boolean;
  public unregisterComponent(
    name: string,
    options?: UnregisterOptions,
  ): Promise<boolean>;

  // Component lifecycle (all return result objects)
  public async startComponent(name: string): Promise<ComponentOperationResult>;
  public async stopComponent(name: string): Promise<ComponentOperationResult>;
  public async restartComponent(
    name: string,
  ): Promise<ComponentOperationResult>;
  public async startAllComponents(
    options?: StartupOptions,
  ): Promise<StartupResult>;
  public async stopAllComponents(): Promise<ShutdownResult>;
  public async restartAllComponents(
    options?: StartupOptions,
  ): Promise<RestartResult>;

  // Signal management
  public attachSignals(): void;
  public detachSignals(): void;
  public getSignalStatus(): ProcessSignalManagerStatus;

  // Manual triggers
  public triggerShutdown(method?: ShutdownSignal): void;
  public async triggerReload(): Promise<SignalBroadcastResult>;
  public async triggerInfo(): Promise<SignalBroadcastResult>;
  public async triggerDebug(): Promise<SignalBroadcastResult>;

  // Health checks
  public async checkComponentHealth(name: string): Promise<HealthCheckResult>;
  public async checkAllHealth(): Promise<HealthReport>;

  // Status queries
  public hasComponent(name: string): boolean;
  public isComponentRunning(name: string): boolean;
  public getComponentNames(): string[];
  public getRunningComponentNames(): string[];
  public getComponentCount(): number;
  public getRunningComponentCount(): number;
  public getComponentStatus(name: string): ComponentStatus | undefined;
  public getAllComponentStatuses(): ComponentStatus[];
  public getSystemState(): SystemState;
  public getStartupOrder(): string[]; // Resolved order after dependency sort
  public getStalledComponents(): ComponentStallInfo[];
  public getLastShutdownResult(): ShutdownResult | null;
  // Bulk management
  public async unregisterAllComponents(): Promise<void>;

  // Shared values (getValue pattern) - always returns result object
  public getValue<T>(componentName: string, key: string): GetValueResult<T>;

  // Private helpers
  private async startComponentInternal(component: BaseComponent): Promise<void>;
  private async stopComponentInternal(
    component: BaseComponent,
    timeout: number,
  ): Promise<void>;
  private handleShutdownRequest(method: ShutdownMethod): void;
  private handleReloadRequest(): void;
  private handleInfoRequest(): void;
  private handleDebugRequest(): void;
  private emitComponentEvent(event: string, name: string, data?: unknown): void;
}
```

### Key Implementation Notes

1. **Thread Safety**: Use proper async/await patterns, avoid concurrent modification of component arrays during iteration

2. **Error Recovery**:
   - Startup errors are fatal (stop everything, throw)
   - Shutdown errors are logged (mark as stalled, continue)
   - Component stop() errors shouldn't prevent other components from stopping

3. **Event Emission**:
   - Emit events before and after operations
   - Include component name and relevant context in all events
   - Use try-catch to prevent event handler errors from breaking lifecycle

4. **Logger Scoping**:
   - LifecycleManager uses `logger.service(name)` (default: 'lifecycle-manager') for its own logs
   - When logging about a component: `this.logger.entity(componentName)` → `[lifecycle-manager > database]`
   - Components receive `rootLogger` and create their own service: `rootLogger.service(name)` → `[database]`
   - Components are first-class services, not children of the manager
   - **Logger Ownership**: The LifecycleManager does NOT close the logger during shutdown. The logger is passed in externally and its lifecycle is managed by the caller.

5. **ProcessSignalManager Integration**:
   - Created in constructor with callbacks
   - attach()/detach() called explicitly or automatically based on options
   - Manual triggers available for testing/programmatic control

6. **Automatic "from" Tracking**:

   When components call `this.lifecycle.sendMessageToComponent()` or `this.lifecycle.getValue()`, the manager automatically determines the sender.

   **Implementation Approach**:

   ```typescript
   // Option 1: Component-specific proxy (cleaner)
   private createLifecycleProxy(component: BaseComponent): LifecycleManager {
     return new Proxy(this, {
       get: (target, prop) => {
         if (prop === 'sendMessageToComponent' || prop === 'getValue') {
           return (...args: any[]) => {
             const componentName = component.getName();

             // Guard: Verify component is still registered and running
             if (!target.isComponentRunning(componentName)) {
               // Return failed result - don't execute the operation
               if (prop === 'sendMessageToComponent') {
                 return Promise.resolve({
                   sent: false,
                   componentFound: target.hasComponent(componentName),
                   componentRunning: false,
                   handlerImplemented: false,
                   data: undefined,
                   error: new Error(`Calling component '${componentName}' is not running`),
                 });
               } else { // getValue
                 return {
                   found: false,
                   value: undefined,
                   componentFound: target.hasComponent(componentName),
                   componentRunning: false,
                   handlerImplemented: false,
                   requestedBy: componentName,
                 };
               }
             }

             // Inject component name as 'from'
             return target[prop](...args, componentName);
           };
         }
         return target[prop];
       },
     });
   }
   ```

   **Zombie Component Protection**: If a stopped/unregistered component tries to send messages or get values (because code kept a reference to it), the operation is rejected with a clear error message. This prevents confusing behavior where "from" claims to be a component that isn't running.

   **Result**: `from` parameter is always accurate without manual specification. External calls (on manager instance directly) have `from = null`.

7. **Double Signal Handling**:
   - If a shutdown signal is received while already shutting down, ignore it
   - Log a warning: "Shutdown already in progress, ignoring signal"
   - Do NOT queue or restart the shutdown process
   - This prevents race conditions and ensures predictable behavior

```typescript
private handleShutdownRequest(method: ShutdownMethod): void {
  if (this.isShuttingDown) {
    this.logger.warn('Shutdown already in progress, ignoring signal');
    return;
  }
  // ... proceed with shutdown
}
```

8. **Reentrancy Prevention**:

   **IMPORTANT**: Components MUST NOT call back into the LifecycleManager during their lifecycle hooks (`start()`, `stop()`, `onShutdownWarning()`, `onShutdownForce()`, `onReload()`, etc.).

   Prohibited patterns:

   ```typescript
   // ❌ DON'T DO THIS - causes deadlocks or inconsistent state
   class BadComponent extends BaseComponent {
     async start() {
       // Don't start other components from within start()
       await this.lifecycle.startComponent('other-component');
     }

     async stop() {
       // Don't send messages during stop()
       await this.lifecycle.sendMessageToComponent('other', {
         bye: true,
       });
     }
   }
   ```

   The LifecycleManager tracks operation state and will reject reentrant calls:

   ```typescript
   // Reentrant calls during lifecycle operations return result with success: false
   if (this.isInLifecycleOperation) {
     this.logger.warn('Reentrant lifecycle call rejected');
     return { success: false, reason: 'reentrant-call' };
   }
   ```

   If components need to coordinate, use the messaging system OUTSIDE of lifecycle hooks, or have the application orchestrate the coordination.

9. **Graceful Phase Abandonment**:

   When `stop()` times out and `onShutdownForce()` is called, the original `stop()` promise may still be pending. To prevent double-cleanup:

   ```typescript
   interface ComponentShutdownState {
     gracefulAbandoned: boolean; // Set to true when graceful times out
     forceStarted: boolean; // Set to true when force begins
   }
   ```

   Components can check this in their cleanup logic:

   ```typescript
   class MyComponent extends BaseComponent {
     private aborted = false;

     async stop() {
       // Normal cleanup...
       if (this.aborted) {
         // Graceful was abandoned, don't do full cleanup
         return;
       }
       await this.saveState(); // Only if graceful wasn't abandoned
     }

     onStopAborted() {
       // Called when graceful stop times out
       this.aborted = true;
     }

     async onShutdownForce() {
       // More aggressive cleanup - graceful timed out or threw error
       this.forceCloseConnections();
     }
   }
   ```

10. **Signals During Startup**:

    If reload/info/debug signals are received while `startAllComponents()` is in progress:
    - **Reload**: Only calls `onReload()` on components that have already started. Components still starting or not yet started are skipped.
    - **Info/Debug**: Same behavior - only affects already-running components.
    - **Shutdown**: Aborts startup and rolls back (documented elsewhere).

    ```typescript
    private handleReloadRequest(): void {
      if (this.isStarting) {
        this.logger.info('Reload during startup: only reloading already-started components');
      }
      // Iterate only over runningComponents set
      for (const name of this.runningComponents) {
        // ... call onReload()
      }
    }
    ```

## Usage Examples

### Basic Usage

```typescript
import { Logger } from './logger';
import { LifecycleManager, BaseComponent } from './lifecycle-manager';

// Create logger
const logger = new Logger({ sinks: [new ConsoleSink()] });

// Create lifecycle manager
const lifecycle = new LifecycleManager({
  name: 'my-app', // Must be kebab-case
  logger,
  shutdownTimeoutMS: 30000,
});

// Create components
class DatabaseComponent extends BaseComponent {
  private pool!: Pool;
  private abortController = new AbortController();

  async start() {
    this.logger.info('Connecting to database...');
    this.pool = await createPool(config);
    await this.pool.connect();
    this.logger.success('Database connected');
  }

  onStartupAborted() {
    this.abortController.abort();
  }

  async stop() {
    this.logger.info('Closing database connection...');
    await this.pool.drain();
    this.logger.success('Database closed');
  }

  // Provide values on-demand
  getValue(key: string, from: string | null): unknown {
    if (from === null) {
      this.logger.info(`External request for ${key}`);
    }

    if (key === 'pool') return this.pool;
    return undefined;
  }

  async healthCheck() {
    const stats = await this.pool.stats();
    return {
      healthy: stats.idle > 0,
      message: stats.idle > 0 ? 'Pool healthy' : 'No idle connections',
      details: {
        active: stats.active,
        idle: stats.idle,
        waiting: stats.waiting,
      },
    };
  }
}

class WebServerComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'web-server',
      dependencies: ['database'], // Depends on database
    });
  }

  async start() {
    this.logger.info('Starting web server...');

    // Get database pool from the database component
    const result = this.lifecycle.getValue<Pool>('database', 'pool');
    if (!result.found) {
      throw new Error('Could not get database pool');
    }

    this.app.use((req, res, next) => {
      req.db = result.value;
      next();
    });

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

// Register components
// Note: Dependencies determine actual order, not registration order
lifecycle.registerComponent(new WebServerComponent(logger)); // Has dependency on 'database'
lifecycle.registerComponent(
  new DatabaseComponent(logger, { name: 'database' }),
);

// Start all components (returns result object, not void)
const result = await lifecycle.startAllComponents();

if (!result.success) {
  logger.error('Failed to start application', {
    failed: result.failedOptionalComponents,
    stalled: result.blockedByStalledComponents,
  });
  process.exit(1);
}

// Output (from LifecycleManager) - database starts first due to dependency:
// [info] [my-app] Starting all components...
// [info] [my-app > database] Starting component...
// [info] [my-app > web-server] Starting component...

// Attach signal handlers
lifecycle.attachSignals();

// Later, graceful shutdown (can be triggered by Ctrl+C or manually)
// lifecycle.triggerShutdown();
// Stops in reverse dependency order: web-server -> database
```

### Advanced Ordering

Components can use explicit dependencies OR manual positioning with `insertComponentAt()`.

```typescript
// Using dependencies (recommended for most cases)
lifecycle.registerComponent(
  new DatabaseComponent(logger, { name: 'database' }),
);
lifecycle.registerComponent(
  new CacheComponent(logger, {
    name: 'cache',
    dependencies: ['database'], // Cache starts after database
  }),
);
lifecycle.registerComponent(
  new WebServerComponent(logger, {
    name: 'web-server',
    dependencies: ['database', 'cache'], // Web server starts last
  }),
);

// Using manual positioning (useful when dependencies aren't declared)
lifecycle.insertComponentAt(
  new ApiMiddlewareComponent(logger, { name: 'api-middleware' }),
  'before',
  'web-server',
);

// Note: Dependencies take precedence over manual positioning
// Final order determined by topological sort of dependencies
// Shutdown order: reverse of startup order
```

### Optional Components

```typescript
// Cache is optional - app works without it, just slower
lifecycle.registerComponent(
  new CacheComponent(logger, {
    name: 'cache',
    optional: true,
    dependencies: ['database'],
  }),
);

lifecycle.registerComponent(
  new WebServerComponent(logger, {
    name: 'web-server',
    dependencies: ['database'], // Note: NOT depending on cache
  }),
);

const result = await lifecycle.startAllComponents();

if (result.failedOptionalComponents.length > 0) {
  logger.warn('Running in degraded mode - cache unavailable');
  // App continues without cache
}
```

### Event Handling

```typescript
lifecycle.on('component:started', ({ name }) => {
  console.log(`Component ${name} is now running`);
});

lifecycle.on('component:stalled', ({ name, reason }) => {
  console.error(`Component ${name} failed to stop: ${reason}`);
});

lifecycle.on('lifecycle-manager:shutdown-completed', ({ duration, method }) => {
  console.log(`Shutdown completed in ${duration}ms via ${method}`);
  process.exit(0);
});

lifecycle.on('signal:reload', () => {
  console.log('Reload signal received, calling onReload() on all components');
});
```

### Component State Checking

```typescript
// Check if specific component is running
if (lifecycle.isComponentRunning('database')) {
  console.log('Database is running');
}

// List all running components
const running = lifecycle.getRunningComponentNames();
console.log('Running components:', running);

// Get detailed component status
const dbStatus = lifecycle.getComponentStatus('database');
if (dbStatus) {
  console.log(`Database state: ${dbStatus.state}`);
  console.log(`Started at: ${dbStatus.startedAt}`);
  if (dbStatus.lastError) {
    console.log(`Last error: ${dbStatus.lastError.message}`);
  }
}

// Get overall system state
const systemState = lifecycle.getSystemState();
console.log(`System state: ${systemState}`);
// 'idle' | 'ready' | 'starting' | 'running' | 'partial' | 'shutting-down' | 'stopped' | 'error'

// Get all component statuses for monitoring
const allStatuses = lifecycle.getAllComponentStatuses();
for (const status of allStatuses) {
  console.log(`${status.name}: ${status.state}`);
}
```

## Testing Strategy

### Unit Tests

1. **Component Registration**
   - Test unique name enforcement (kebab-case validation)
   - Test insertion positions (start, end, before, after)
   - Test unregistration
   - Test registration during shutdown (returns false)

2. **Lifecycle Operations**
   - Test start/stop individual components (result objects)
   - Test start/stop all components (result objects)
   - Test error handling (startup failures, shutdown failures)
   - Test stall detection and recovery

3. **Dependencies**
   - Test topological sort ordering
   - Test cycle detection (throws `DependencyCycleError`)
   - Test missing dependency detection
   - Test dependencies override registration order

4. **Optional Components**
   - Test optional component failure doesn't trigger rollback
   - Test dependent components are skipped when optional dependency fails
   - Test `'failed'` state tracking

5. **Abort Callbacks**
   - Test onStartupAborted() called on timeout
   - Test onStopAborted() called before force phase
   - Test abort callbacks are optional (no error if not implemented)

6. **Health Checks**
   - Test healthCheck() invocation
   - Test health check timeout
   - Test aggregate health report
   - Test boolean return normalized to result object
   - Test rich result with message and details

7. **Shared Values**
   - Test getValue() handler called with correct key and from
   - Test lifecycle.getValue() returns result object
   - Test result.found true when value returned
   - Test result.found false when key not found
   - Test result includes componentFound, componentRunning, handlerImplemented
   - Test from parameter tracks requester (component name or null)

8. **Signal Integration**
   - Test attach/detach
   - Test manual triggers
   - Test signal-to-lifecycle mapping

9. **Event Emission**
   - Test all event types are emitted
   - Test event data correctness
   - Test event handler errors don't break lifecycle

### Integration Tests

1. **Multiple Components**
   - Test ordering with dependencies
   - Test mixed optional/required components
   - Test complex dependency graphs

2. **Shutdown Scenarios**
   - Test graceful shutdown
   - Test force phase on timeout
   - Test force phase on error
   - Test stalled component tracking and restart blocking

3. **Signal Handling**
   - Test Ctrl+C triggers shutdown
   - Test reload signal calls onReload()
   - Test signals during startup

## Known Limitations

### 1. Timeout Does Not Force-Cancel Operations

JavaScript has no built-in way to _force_ cancel a running promise. When a component's `start()` or `stop()` times out:

- The manager calls `onStartupAborted()` or `onStopAborted()` (if implemented)
- The manager proceeds (rollback for startup, force phase then mark as stalled for shutdown)
- **Non-cooperative code** (code that doesn't check abort state) continues executing in the background
- If the promise eventually resolves, the component may try to use resources that were cleaned up

**Best practices for component authors**:

```typescript
class MyComponent extends BaseComponent {
  private aborted = false;
  private abortController = new AbortController();

  async start() {
    // Option 1: Check flag periodically during long operations
    for (const chunk of dataChunks) {
      if (this.aborted) {
        throw new Error('Startup aborted');
      }
      await processChunk(chunk);
    }

    // Option 2: Use AbortController for APIs that support signals
    await this.pool.connect({ signal: this.abortController.signal });
  }

  onStartupAborted() {
    // Called by manager when timeout occurs
    this.aborted = true;
    this.abortController.abort();
  }
}
```

**Important**: If your component doesn't implement abort callbacks, timeouts will proceed but your code keeps running. Implement abort callbacks for clean cancellation.

### 2. Stalled Component Memory

If a component stalls (times out during shutdown) and its promise never resolves:

- The promise and any closures it holds remain in memory
- Resources referenced by those closures cannot be garbage collected
- This is a potential memory leak

**This is unavoidable** without cooperative cancellation. The best practice is:

1. Design components with reasonable timeouts that they can actually meet
2. Use the force shutdown phase to abandon work rather than wait
3. If a component truly cannot stop, accept that some memory may leak until process exit

### 3. No Atomic Restart

`restartAllComponents()` is not atomic. There's a window where all components are stopped but none are started yet. If your application requires zero-downtime restarts, use rolling restarts with individual `restartComponent()` calls.

## Resolved Design Decisions

### 1. Warning/Force Shutdown

**Status**: ✅ **RESOLVED** - Implementing three-phase shutdown (warning -> graceful -> force) with per-component timeout configuration.

### 2. Component Dependencies

**Status**: ✅ **RESOLVED for V1** - Components can declare explicit dependencies. The manager performs topological sort for startup order and reverse for shutdown.

See [Component Dependencies](#component-dependencies) section for full specification.

### 3. Component Health Checks

**Status**: ✅ **RESOLVED for V1** - Components can implement optional `healthCheck()` method.

See [Health Checks](#health-checks) section for full specification.

### 4. Hot Reload / Dynamic Add/Remove

**Status**: ✅ **RESOLVED for V1** - Components can be registered/unregistered at runtime. Bulk operations use snapshot lists.

See [Snapshot List Guarantee](#snapshot-list-guarantee) section for full specification.

### 5. Optional/Non-Critical Components

**Status**: ✅ **RESOLVED for V1** - Components can be marked as `optional: true` so startup failures don't trigger rollback.

See [Optional Components](#optional-components) section for full specification.

### 6. Cooperative Cancellation

**Status**: ✅ **RESOLVED for V1** - Components can implement abort callbacks (`onStartupAborted()`, `onStopAborted()`, etc.) for cooperative cancellation on timeouts. This keeps method signatures clean while still enabling cancellation.

See [Abort Callbacks](#abort-callbacks) section for full specification.

### 7. Shared Values

**Status**: ✅ **RESOLVED for V1** - Components implement optional `getValue(key, from)` method to provide values on-demand. Follows the same pattern as messaging for consistency.

See [Shared Values](#shared-values-getvalue-pattern) section for full specification.

## Success Criteria

1. ✅ Single coherent API for component lifecycle management
2. ✅ Clean integration with ProcessSignalManager
3. ✅ Hierarchical logging with Logger
4. ✅ Flexible component ordering (dependencies + manual positioning)
5. ✅ Robust error handling via result objects (no unexpected throws)
6. ✅ Event-driven architecture for monitoring (fire-and-forget, safe)
7. ✅ Component dependencies with topological sort
8. ✅ Optional components for graceful degradation
9. ✅ Health checks with rich metadata support
10. ✅ Abort callbacks for cooperative cancellation
11. ✅ Shared values (provide/get) for component communication
12. ✅ Multi-phase shutdown (warning -> graceful -> force on timeout OR error)
13. ✅ Stalled component tracking and restart blocking
14. ✅ Well-documented with clear examples
15. ✅ Comprehensive test coverage (unit + integration)

## Next Steps

1. Review and approve this PRD
2. Create BaseComponent abstract class
3. Implement LifecycleManager core class
4. Write unit tests
5. Write integration tests
6. Create example usage (demo app)
7. Write comprehensive documentation
8. Migrate existing code (if applicable)
