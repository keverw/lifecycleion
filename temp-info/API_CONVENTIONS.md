# LifecycleManager API Conventions

This document describes the API design conventions used in the LifecycleManager to help developers understand and predict API behavior.

## Error Handling Strategy

The LifecycleManager uses **result objects for all operations** with a consistent structure based on `BaseOperationResult`.

### Unified Result Objects

All async operations return result objects extending `BaseOperationResult`. These represent both successful operations and normal operational failures like "component not found" or "component already running".

**Base Pattern:**
```typescript
interface BaseOperationResult {
  success: boolean;
  reason?: string;        // Human-readable explanation
  code?: string;          // Machine-readable code for programmatic handling
  error?: Error;          // Underlying error if applicable
  status?: ComponentStatus; // Component state after operation (when applicable)
}

interface ComponentOperationResult extends BaseOperationResult {
  componentName: string;
  code?: ComponentOperationFailureCode;
}
```

**When used:**
- Component not found
- Component already in desired state
- Dependencies not met
- Shutdown in progress
- Dependency cycles
- Timeout errors

**Example:**
```typescript
const result = await lifecycle.startComponent('database');
if (!result.success) {
  console.error(`Failed to start: ${result.reason}`);
  console.error(`Error code: ${result.code}`);
  
  // Check component state if available
  if (result.status) {
    console.log(`Current state: ${result.status.state}`);
  }
  
  // Handle specific failures
  if (result.code === 'missing_dependency') {
    // Install missing dependency
  }
}

// On success, status is included
if (result.success && result.status) {
  console.log(`Started at: ${result.status.startedAt}`);
}
```

### Constructor Validation (Exceptions)

The only place that throws exceptions is `BaseComponent` constructor validation:

**When thrown:**
- `InvalidComponentNameError` - Component name doesn't match kebab-case pattern

**All lifecycle-manager methods return result objects** - no exceptions are thrown to callers.

### Nullable Returns (Queries)

Status and query methods return `undefined` when the requested entity doesn't exist.

**When used:**
- `getComponentStatus(name)` - Returns `undefined` if component not found
- `getComponent(name)` - Internal method returns `undefined`

**Example:**
```typescript
const status = lifecycle.getComponentStatus('database');
if (status) {
  console.log(`State: ${status.state}`);
  console.log(`Started at: ${status.startedAt}`);
} else {
  console.log('Component not found');
}
```

## Result Object Consistency

All result types extend `BaseOperationResult` providing consistent structure:

```typescript
interface BaseOperationResult {
  success: boolean;
  reason?: string;          // Human-readable explanation
  code?: string;            // Machine-readable failure code
  error?: Error;            // Underlying error if applicable
  status?: ComponentStatus; // Component state after operation (when applicable)
}

// Example: Component operations extend the base
interface ComponentOperationResult extends BaseOperationResult {
  componentName: string;
  code?: ComponentOperationFailureCode;
}
```

### Result Types

| Operation | Result Type | Extends Base | Failure Codes |
|-----------|-------------|--------------|---------------|
| `startComponent()` | `ComponentOperationResult` | ✅ | `component_not_found`, `component_already_running`, `missing_dependency`, `shutdown_in_progress`, etc. |
| `stopComponent()` | `ComponentOperationResult` | ✅ | `component_not_found`, `component_not_running`, `stop_timeout` |
| `restartComponent()` | `ComponentOperationResult` | ✅ | `restart_stop_failed`, `restart_start_failed` |
| `registerComponent()` | `RegisterComponentResult` | ✅ | `duplicate_name`, `shutdown_in_progress`, `dependency_cycle` |
| `unregisterComponent()` | `UnregisterComponentResult` | ✅ | `component_not_found`, `component_running`, `stop_failed` |
| `getStartupOrder()` | `StartupOrderResult` | ✅ | `dependency_cycle`, `unknown_error` |

## Parameter Patterns

### Options Objects

All methods that accept options use **trailing options parameters**:

```typescript
// ✓ Consistent pattern
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

### StopComponentOptions

Currently implemented options for enhanced shutdown control:

```typescript
export interface StopComponentOptions {
  /**
   * If true, force immediate shutdown without graceful period
   * Calls onShutdownForce() directly, bypassing normal stop() flow
   */
  forceImmediate?: boolean;

  /**
   * Override the component's configured shutdown timeout in milliseconds
   * Only applies when forceImmediate is false
   */
  timeout?: number;
}
```

**Example:**
```typescript
// Force immediate shutdown
await lifecycle.stopComponent('db', { forceImmediate: true });

// Custom timeout
await lifecycle.stopComponent('db', { timeout: 10000 });
```

```typescript
// ✓ Consistent pattern
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

### Options Types

Even if an options object is currently empty, we define the type to reserve the field for future expansion:

```typescript
/**
 * Options for manually stopping a component
 * 
 * Currently empty but reserved for future options like:
 * - skipWarningPhase?: boolean
 * - forceImmediate?: boolean
 * - timeout?: number
 */
export interface StopComponentOptions {
  // Reserved for future use
}
```

## Query Method Naming

Query methods follow consistent naming conventions:

| Pattern | Usage | Examples |
|---------|-------|----------|
| `hasX()` | Boolean check for existence | `hasComponent()` |
| `isX()` | Boolean check for state | `isComponentRunning()` |
| `getX()` | Retrieve object/value | `getComponentStatus()` |
| `getXs()` | Retrieve collection | `getComponentNames()` |
| `getXCount()` | Count items | `getComponentCount()` |

**Examples:**
```typescript
// Boolean predicates
if (lifecycle.hasComponent('database')) { ... }
if (lifecycle.isComponentRunning('database')) { ... }

// Collections
const names = lifecycle.getComponentNames();
const statuses = lifecycle.getAllComponentStatuses();

// Counts
const total = lifecycle.getComponentCount();
const running = lifecycle.getRunningComponentCount();
```

## Async/Sync Patterns

The API clearly separates synchronous and asynchronous operations:

### Synchronous (Immediate)
- All query methods: `hasComponent()`, `getComponentStatus()`, etc.
- Registration (no side effects): `registerComponent()`, `insertComponentAt()`

### Asynchronous (Must await)
- All lifecycle operations: `startComponent()`, `stopComponent()`, `restartComponent()`
- Unregistration (may stop component): `unregisterComponent()`
- Bulk operations: `startAllComponents()`, `stopAllComponents()`

**Rule of thumb:** If it **changes component state** (starting/stopping), it's async.

## Type Naming Conventions

Types follow noun-first naming:

```typescript
// ✓ Good (noun-first)
ComponentStatus
HealthCheckResult
MessageResult
StartupResult
ValueResult

// ✗ Avoid (verb-first - deprecated)
GetValueResult  // Renamed to ValueResult
```

## Future Extensibility

The API is designed for backward-compatible evolution:

1. **Options objects** allow adding new parameters without breaking changes
2. **Result objects** can gain new fields without breaking existing code
3. **Failure codes** are machine-readable strings (not enums) for easy extension
4. **Reserved options types** signal future expansion points

## Best Practices

### Check result.success before proceeding
```typescript
const result = await lifecycle.startComponent('db');
if (!result.success) {
  // Handle failure
  return;
}
// Proceed with success case
```

### Use failure codes for programmatic handling
```typescript
if (!result.success) {
  switch (result.code) {
    case 'missing_dependency':
      await installDependency();
      break;
    case 'shutdown_in_progress':
      console.log('Shutdown in progress, skipping');
      break;
    default:
      console.error(result.reason);
  }
}
```

### Handle nullable query results
```typescript
const status = lifecycle.getComponentStatus('db');
if (!status) {
  console.log('Component not registered');
  return;
}
console.log(`State: ${status.state}`);
```

### Use try/catch for registration
```typescript
try {
  const result = lifecycle.registerComponent(component);
  if (!result.success) {
    console.error(`Registration failed: ${result.reason}`);
  }
} catch (err) {
  if (err instanceof DependencyCycleError) {
    console.error('Fix dependency cycle:', err.additionalInfo.cycle);
  }
}
```

## Future Direction: Unified Base Result Interface

The maintainer is interested in creating a unified base result interface for consistency across all operations. This would:

1. **Eliminate type proliferation** - Single base interface extended by all operations
2. **Enable generic handlers** - Write code that works with any result type
3. **Improve consistency** - All results have the same core fields

**Proposed design:**
```typescript
// Base interface for ALL operation results
interface BaseOperationResult {
  success: boolean;
  targetName: string;     // Generic name for the entity
  reason?: string;        // Human-readable explanation
  code?: string;          // Machine-readable code
  error?: Error;          // Underlying error if applicable
  metadata?: unknown;     // Operation-specific data
}

// Specific results extend base
interface ComponentOperationResult extends BaseOperationResult {
  componentName: string;  // Alias for targetName for backward compatibility
  // metadata could be: { state?: ComponentState, startedAt?: number }
}

interface RegisterComponentResult extends BaseOperationResult {
  componentName: string;
  metadata: {
    action: 'register';
    registrationIndex: number;
    startupOrder: string[];
  };
}

// Generic result handler
function handleResult<T extends BaseOperationResult>(result: T): void {
  if (!result.success) {
    console.error(`${result.targetName} failed: ${result.reason} (${result.code})`);
  }
}
```

**Benefits:**
- Consistent error handling patterns
- Less TypeScript type duplication
- Easier to understand and predict API behavior
- Generic utility functions possible

**Implementation effort:** MEDIUM (requires refactoring existing types, but maintains backward compatibility through field aliases)

## Migration Notes

If you're upgrading from an earlier version, note these changes:

### v0.0.1 → v0.1.0

**Added:**
- `code` field to `UnregisterComponentResult` for consistent error handling
- `StopComponentOptions` type (currently empty, reserved for future use)
- `RestartComponentOptions` type for restart configuration
- Options parameter to `stopComponent()` and `restartComponent()`

**No breaking changes** - all additions are optional/backward compatible.
