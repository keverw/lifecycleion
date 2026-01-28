# LifecycleManager - Product Requirements Document

## Overview

The LifecycleManager is a comprehensive lifecycle orchestration system that manages startup, shutdown, and runtime control of application components. It integrates with ProcessSignalManager and Logger infrastructure for signal handling and hierarchical logging.

**Current Status**: Phases 1-8 complete (core implementation done). This PRD serves as the specification for remaining work and final documentation.

## Core Philosophy

- **Component-oriented**: Use "component" terminology for managed entities
- **Ordered lifecycle**: Components start in registration order (respecting dependencies), stop in reverse order
- **Multi-phase shutdown**: Global warning -> per-component graceful -> force
- **Signal integration**: Built-in process signal handling for graceful shutdown, reload, info, and debug
- **Hierarchical logging**: Components log as their own service (`logger.service('database')`), while the manager uses `.entity()` when logging about components it manages
- **Flexible ordering**: Dynamic insertion at start, end, before, or after specific components
- **Runtime introspection**: Check component status, list running components, query by name
- **Extensible**: Support for custom signal handlers and arbitrary component messaging

## Architecture Decisions

### 1. ProcessSignalManager Integration (Composition)

**Decision**: Use composition, not inheritance. The LifecycleManager owns a ProcessSignalManager instance.

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
    await reloadGlobalConfig();
    await broadcastReload(); // Calls onReload() on all running components
  },

  // Custom info handler - called when SIGUSR1 or 'I' key pressed
  onInfoRequested: async () => {
    console.log('=== Application Info ===');
    console.log(`Uptime: ${process.uptime()}s`);
    console.log(`Components: ${lifecycle.getRunningComponentNames().join(', ')}`);
  },

  // Custom debug handler - called when SIGUSR2 or 'D' key pressed
  onDebugRequested: async () => {
    console.log('=== Debug Info ===');
    console.log('Running:', lifecycle.getRunningComponentNames());
  },
});
```

**Public API**:

```typescript
// Wrapper methods on LifecycleManager
lifecycleManager.attachSignals();     // -> processSignalManager.attach()
lifecycleManager.detachSignals();     // -> processSignalManager.detach()
lifecycleManager.getSignalStatus();   // -> processSignalManager.getStatus()

// Manual triggers
lifecycleManager.triggerShutdown();   // Manual shutdown trigger
await lifecycleManager.triggerReload();  // Manual reload trigger (returns results)
await lifecycleManager.triggerInfo();    // Manual info trigger (returns results)
await lifecycleManager.triggerDebug();   // Manual debug trigger (returns results)
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

### 3. Event System

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
}
```

**Best practice for async event handlers**:

```typescript
// ✅ Good - catch your own errors
lifecycle.on('component:started', async (data) => {
  try {
    await saveToDatabase(data);
  } catch (error) {
    logger.error('Failed to save component start event', { error });
  }
});
```

**Available Events**:

```typescript
// Lifecycle events
'lifecycle-manager:started'
'lifecycle-manager:shutdown-initiated'
'lifecycle-manager:shutdown-warning'
'lifecycle-manager:shutdown-warning-completed'
'lifecycle-manager:shutdown-warning-timeout'
'lifecycle-manager:shutdown-completed'

// Component registration
'component:registered'
'component:unregistered'

// Component lifecycle
'component:starting'
'component:started'
'component:start-failed'
'component:stopping'
'component:stopped'
'component:stop-failed'
'component:stalled'
'component:restart-initiated'
'component:restarted'

// Signal events
'signal:shutdown'
'signal:reload'
'signal:info'
'signal:debug'

// Per-component signal events
'component:reload-started'
'component:reload-completed'
'component:reload-failed'
'component:info-started'
'component:info-completed'
'component:info-failed'
'component:debug-started'
'component:debug-completed'
'component:debug-failed'

// Messaging events
'component:message-sent'
'component:message-failed'
'component:broadcast-started'
'component:broadcast-completed'

// Health check events
'component:health-check-started'
'component:health-check-completed'
'component:health-check-failed'

// Value request events
'component:value-requested'
'component:value-returned'
```

## Core Features

### 1. Component Registration (AutoStart Feature)

Components can be registered while `startAllComponents()` is in progress or after it completes. By default, newly registered components are **not auto-started**.

```typescript
interface RegisterOptions {
  autoStart?: boolean; // Auto-start if manager is running/starting (default: false)
}
```

**Auto-start behavior by manager state**:

| Manager State                 | `autoStart: false` (default)          | `autoStart: true`                                                             |
| ----------------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| Not started yet               | Register only (deferred start)        | Register only (deferred start with `startAllComponents()`)                    |
| Starting (`isStarting: true`) | Register only (component NOT started) | Register and await start (appended to startup queue, `startResult` available) |
| Running (`isStarted: true`)   | Register only (component NOT started) | Register and await start (`startResult` available)                            |
| Shutting down                 | Rejected                              | Rejected                                                                      |

### 2. Signal Integration

**Automatic Signal Handling**:
- When `attachSignals()` is called, ProcessSignalManager handles:
  - **Shutdown signals** (SIGINT, SIGTERM, SIGTRAP, Ctrl+C, Escape): trigger `stopAllComponents()`
  - **Reload signal** (SIGHUP, R key): call `onReload()` on all running components (if implemented)
  - **Info signal** (SIGUSR1, I key): call `onInfo()` on all running components (if implemented)
  - **Debug signal** (SIGUSR2, D key): call `onDebug()` on all running components (if implemented)

**Manual Triggers**:

```typescript
triggerShutdown(method: 'SIGINT' | 'SIGTERM' | 'SIGTRAP' = 'SIGINT'): void
triggerReload(): Promise<SignalBroadcastResult>
triggerInfo(): Promise<SignalBroadcastResult>
triggerDebug(): Promise<SignalBroadcastResult>
```

**Error Handling for Reload/Info/Debug**:

Errors in signal handlers are **graceful** - they don't stop the broadcast. The manager calls each handler, logs errors, and continues to the next component.

### 3. Restart Behavior and State Management

**Shutdown-to-Restart Cycle**:

After a complete shutdown, the LifecycleManager can be restarted. Components remain registered after shutdown.

**State Reset on Shutdown Completion**:
1. Set `isShuttingDown = false`
2. Clear `shutdownMethod = null`
3. Clear `runningComponents` set
4. Clear `stalledComponents` map
5. Preserve component registration
6. Emit `lifecycle-manager:shutdown-completed` event

**Multiple LifecycleManager Instances**:

Multiple instances are allowed and can coexist. Each manages its own components independently. However:
- Only ONE instance should call `attachSignals()` at a time
- **Recommendation**: If using multiple instances, manage signals manually or use a single "root" instance

### 4. Snapshot List Guarantee

Bulk operations (`startAllComponents()`, `stopAllComponents()`, `restartAllComponents()`) operate on a **snapshot** of the component list taken at invocation.

**Guarantees**:
1. **Registration during bulk start**: Components registered with `autoStart: true` are appended to the snapshot
2. **Unregistration during bulk operations**: Components unregistered during a bulk operation are skipped when their turn comes
3. **No concurrent modification**: The internal component array is not mutated during iteration

### 5. Shutdown Result and Stalled Component Handling

**Shutdown Result Persistence**:

```typescript
interface ShutdownResult {
  completedAt: number;
  durationMS: number;
  method: ShutdownMethod;
  stoppedComponents: string[];
  stalledComponents: ComponentStallInfo[];
  errors: Array<{ component: string; phase: string; error: Error }>;
}

getLastShutdownResult(): ShutdownResult | null
getStalledComponents(): ComponentStallInfo[]
```

**Stalled Components Block Restart**:

If any component is in `'stalled'` state, `startAllComponents()` returns a failure result.

**Recovery Options**:

```typescript
// Option 1: Unregister stalled components
for (const name of lifecycle.getStalledComponents().map((s) => s.name)) {
  await lifecycle.unregisterComponent(name);
}
await lifecycle.startAllComponents();

// Option 2: Unregister all components
await lifecycle.unregisterAllComponents();

// Option 3: Force restart (acknowledge the risk)
await lifecycle.startAllComponents({ ignoreStalledComponents: true });
```

## API Design: Returns vs Throws

**Return result objects** for runtime operations that can fail for expected reasons:

| Method                     | Returns                              | Failure Examples                                    |
| -------------------------- | ------------------------------------ | --------------------------------------------------- |
| `startComponent(name)`     | `Promise<ComponentOperationResult>`  | Already running, not found, during shutdown         |
| `stopComponent(name)`      | `Promise<ComponentOperationResult>`  | Not running, not found, stalled                     |
| `startAllComponents()`     | `Promise<StartupResult>`             | Optional component failed, stalled components exist |
| `stopAllComponents()`      | `Promise<ShutdownResult>`            | Components stalled                                  |
| `sendMessageToComponent()` | `Promise<MessageResult>`             | Component not found, not running, handler error     |
| `registerComponent()`      | `Promise<RegisterComponentResult>`   | Duplicate name, during shutdown                     |

**Throw errors** only for programmer mistakes (bugs in calling code):

| Error                        | When Thrown                                 |
| ---------------------------- | ------------------------------------------- |
| `InvalidComponentNameError`  | Component name isn't valid kebab-case       |
| `ComponentRegistrationError` | Invalid registration inputs (bug in caller) |

**Result Object Pattern**:

```typescript
interface ComponentOperationResult {
  success: boolean;
  componentName: string;
  reason?: string;
  error?: Error;
}

// Usage - no try/catch needed for expected failures
const result = await lifecycle.startComponent('database');
if (!result.success) {
  logger.warn(`Failed to start database: ${result.reason}`);
}
```

## Usage Examples

### Basic Usage

```typescript
import { Logger } from './logger';
import { LifecycleManager, BaseComponent } from './lifecycle-manager';

// Create lifecycle manager
const lifecycle = new LifecycleManager({
  name: 'my-app',
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
  constructor(logger: Logger) {
    super(logger, {
      name: 'web-server',
      dependencies: ['database'], // Depends on database
    });
  }

  async start() {
    this.logger.info('Starting web server...');
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
lifecycle.registerComponent(new WebServerComponent(logger));
lifecycle.registerComponent(new DatabaseComponent(logger, { name: 'database' }));

// Start all components
const result = await lifecycle.startAllComponents();
if (!result.success) {
  logger.error('Failed to start application');
  process.exit(1);
}

// Attach signal handlers
lifecycle.attachSignals();
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

const result = await lifecycle.startAllComponents();
if (result.failedOptionalComponents.length > 0) {
  logger.warn('Running in degraded mode - cache unavailable');
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
```

## Testing Strategy

The LifecycleManager has comprehensive test coverage with 246+ passing unit tests covering:
- Component registration and lifecycle operations
- Dependency management and topological ordering
- Optional components and failure handling
- Abort callbacks and timeout handling
- Health checks and shared values
- Signal integration and event emission
- Bulk operations and stall detection

See `src/lib/lifecycle-manager/lifecycle-manager.test.ts` for complete test implementation.

Integration tests (Phase 11) will cover multi-component scenarios with real-world usage patterns.

## Known Limitations

### 1. Timeout Does Not Force-Cancel Operations

JavaScript has no built-in way to _force_ cancel a running promise. When a component's `start()` or `stop()` times out:
- The manager calls `onStartupAborted()` or `onStopAborted()` (if implemented)
- The manager proceeds (rollback for startup, force phase for shutdown)
- **Non-cooperative code** continues executing in the background

**Best practices for component authors**:

```typescript
class MyComponent extends BaseComponent {
  private aborted = false;
  private abortController = new AbortController();

  async start() {
    // Check flag periodically during long operations
    for (const chunk of dataChunks) {
      if (this.aborted) throw new Error('Startup aborted');
      await processChunk(chunk);
    }

    // Use AbortController for APIs that support signals
    await this.pool.connect({ signal: this.abortController.signal });
  }

  onStartupAborted() {
    this.aborted = true;
    this.abortController.abort();
  }
}
```

### 2. Stalled Component Memory

If a component stalls and its promise never resolves:
- The promise and any closures it holds remain in memory
- This is a potential memory leak
- **This is unavoidable** without cooperative cancellation

Best practices:
1. Design components with reasonable timeouts they can meet
2. Use the force shutdown phase to abandon work
3. Accept that some memory may leak until process exit

### 3. No Atomic Restart

`restartAllComponents()` is not atomic. There's a window where all components are stopped but none are started yet. For zero-downtime restarts, use rolling restarts with individual `restartComponent()` calls.

## API Conventions

This section describes the API design conventions used in the LifecycleManager. These conventions ensure consistent, predictable behavior across all operations.

### Error Handling Strategy

The LifecycleManager uses **result objects for all operations** with a consistent structure based on `BaseOperationResult`.

#### Unified Base Result Interface

All operations return result objects extending `BaseOperationResult`. This provides a consistent structure for both successful operations and expected failures.

```typescript
interface BaseOperationResult {
  success: boolean;       // Whether the operation succeeded
  reason?: string;        // Human-readable explanation if !success
  code?: string;          // Machine-readable code for programmatic handling
  error?: Error;          // Underlying error if applicable
  status?: ComponentStatus; // Component state after operation (when applicable)
}

interface ComponentOperationResult extends BaseOperationResult {
  componentName: string;
  code?: ComponentOperationFailureCode;
}
```

**When result objects are used:**
- Component not found
- Component already in desired state
- Dependencies not met
- Shutdown in progress
- Dependency cycles
- Timeout errors

**Example usage:**

```typescript
const result = await lifecycle.startComponent('database');
if (!result.success) {
  console.error(`Failed to start: ${result.reason}`);
  console.error(`Error code: ${result.code}`);
  
  // Handle specific failures
  if (result.code === 'missing_dependency') {
    // Handle missing dependency
  }
}

// On success, status is included
if (result.success && result.status) {
  console.log(`Started at: ${result.status.startedAt}`);
}
```

#### Constructor Validation (Exceptions)

The only place that throws exceptions is `BaseComponent` constructor validation:

- `InvalidComponentNameError` - Component name doesn't match kebab-case pattern

**All other lifecycle-manager methods return result objects** - no exceptions are thrown to callers.

#### Nullable Returns (Queries)

Status and query methods return `undefined` when the requested entity doesn't exist:

- `getComponentStatus(name)` - Returns `undefined` if component not found
- `getComponentInstance(name)` - Returns `undefined` if component not found

### Result Type Reference

| Operation               | Result Type                 | Failure Codes                                                                       |
| ----------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| `startComponent()`      | `ComponentOperationResult`  | `component_not_found`, `component_already_running`, `missing_dependency`, etc.      |
| `stopComponent()`       | `ComponentOperationResult`  | `component_not_found`, `component_not_running`, `stop_timeout`, `has_running_dependents` |
| `restartComponent()`    | `ComponentOperationResult`  | `restart_stop_failed`, `restart_start_failed`                                       |
| `registerComponent()`   | `RegisterComponentResult`   | `duplicate_name`, `shutdown_in_progress`, `dependency_cycle`                        |
| `unregisterComponent()` | `UnregisterComponentResult` | `component_not_found`, `component_running`, `stop_failed`, `bulk_operation_in_progress` |
| `getStartupOrder()`     | `StartupOrderResult`        | `dependency_cycle`, `unknown_error`                                                 |

### Parameter Patterns

All methods that accept options use **trailing options parameters**:

```typescript
startComponent(name: string, options?: StartComponentOptions)
stopComponent(name: string, options?: StopComponentOptions)
restartComponent(name: string, options?: RestartComponentOptions)
registerComponent(component: BaseComponent, options?: RegisterOptions)
unregisterComponent(name: string, options?: UnregisterOptions)
```

**Benefits:**
- Easy to remember
- Future-proof (can add new options without breaking changes)
- IDE autocomplete works well

### Query Method Naming

Query methods follow consistent naming conventions:

| Pattern          | Usage                       | Examples                    |
| ---------------- | --------------------------- | --------------------------- |
| `hasX()`         | Boolean check for existence | `hasComponent()`            |
| `isX()`          | Boolean check for state     | `isComponentRunning()`      |
| `getX()`         | Retrieve single object      | `getComponentStatus()`      |
| `getAllX()`      | Retrieve all items          | `getAllComponentStatuses()` |
| `getXNames()`    | Retrieve name collection    | `getComponentNames()`       |
| `getXCount()`    | Count items                 | `getComponentCount()`       |

### Async/Sync Patterns

The API clearly separates synchronous and asynchronous operations:

**Synchronous (Immediate):**
- All query methods: `hasComponent()`, `getComponentStatus()`, `getValue()`, etc.

**Asynchronous (Must await):**
- Registration: `registerComponent()`, `insertComponentAt()` (async for autoStart support)
- All lifecycle operations: `startComponent()`, `stopComponent()`, `restartComponent()`
- Unregistration (may stop component): `unregisterComponent()`
- Bulk operations: `startAllComponents()`, `stopAllComponents()`
- Messaging: `sendMessageToComponent()`, `broadcastMessage()`
- Health checks: `checkComponentHealth()`, `checkAllHealth()`
- Signal triggers: `triggerReload()`, `triggerInfo()`, `triggerDebug()`

**Rule of thumb:** If it **changes component state** (starting/stopping), **awaits external operations**, or **may trigger async side effects**, it's async.

### Type Naming Conventions

Types follow noun-first naming:

```typescript
// ✓ Good (noun-first)
ComponentStatus
HealthCheckResult
MessageResult
StartupResult
ValueResult

// ✗ Avoid (verb-first)
GetValueResult  // Renamed to ValueResult
```

### Event System Conventions

Events are emitted via the `LifecycleManagerEvents` class with typed payloads. The event naming follows these patterns:

**Namespace patterns:**
- `lifecycle-manager:*` - Manager-level events (startup, shutdown)
- `component:*` - Component-level events (started, stopped, stalled)
- `signal:*` - Signal events (shutdown, reload, info, debug)

**Event payload consistency:**
- All component events include `name: string`
- Error events include `error: Error`
- Timeout events include `timeoutMS: number`
- Operation completion events include `durationMS: number` where applicable

**Event handler execution:**
Event handlers are **fire-and-forget** - they are NOT awaited. This ensures:
- Event handlers cannot block lifecycle operations
- Slow or failing handlers don't affect component startup/shutdown
- Handlers can be async, but errors are their own responsibility

### Future Extensibility

The API is designed for backward-compatible evolution:

1. **Options objects** allow adding new parameters without breaking changes
2. **Result objects** can gain new fields without breaking existing code
3. **Failure codes** are machine-readable strings (not enums) for easy extension
4. **Reserved options types** signal future expansion points

## Implementation Status

### ✅ Completed (Phases 1-9)
- Core LifecycleManager class with all lifecycle operations
- BaseComponent abstract class
- Component registration and dependency management
- Bulk operations (start/stop/restart all)
- Multi-phase shutdown with global warning
- Signal integration with ProcessSignalManager
- Component messaging and health checks
- AutoStart feature and event consolidation
- API & Event consistency review
- 251 unit tests, all passing

### 📋 Remaining
- **Phase 10**: Test consolidation and reorganization
- **Phase 11**: Integration tests, example app, and final documentation
