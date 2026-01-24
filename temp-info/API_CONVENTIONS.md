# LifecycleManager API Conventions

This document describes the API design conventions used in the LifecycleManager to help developers understand and predict API behavior.

## Error Handling Strategy

The LifecycleManager uses **three error patterns** depending on the situation:

### 1. Result Objects (Expected Failures)

Async operations that may fail normally return result objects with `success: false`. These are **not exceptions** - they represent normal operational failures like "component not found" or "component already running".

**When used:**
- Component not found
- Component already in desired state
- Dependencies not met
- Shutdown in progress

**Pattern:**
```typescript
interface OperationResult {
  success: boolean;
  componentName: string;
  reason?: string;      // Human-readable explanation
  code?: string;        // Machine-readable code for programmatic handling
  error?: Error;        // Underlying error if applicable
}
```

**Example:**
```typescript
const result = await lifecycle.startComponent('database');
if (!result.success) {
  console.error(`Failed to start: ${result.reason}`);
  console.error(`Error code: ${result.code}`);
  
  // Handle specific failures
  if (result.code === 'missing_dependency') {
    // Install missing dependency
  }
}
```

### 2. Exceptions (Currently Used - May Transition to Result Objects)

> **Note from maintainer:** Preference is to NOT throw even for programming errors. Current behavior documented below may change to return result objects for all failures.

Invalid input or system errors currently throw exceptions. These represent **programmer mistakes** or configuration errors that should be fixed in code.

**When thrown:**
- Invalid component name format
- Dependency cycles detected
- Invalid method arguments

**Available errors:**
- `InvalidComponentNameError` - Component name doesn't match kebab-case pattern
- `DependencyCycleError` - Circular dependency detected
- `ComponentStartTimeoutError` - Component start timed out
- `ComponentStopTimeoutError` - Component stop timed out

**Example:**
```typescript
try {
  // This throws if a cycle is detected
  lifecycle.registerComponent(component);
} catch (err) {
  if (err instanceof DependencyCycleError) {
    console.error(`Dependency cycle: ${err.additionalInfo.cycle}`);
  }
}
```

**Future direction:** May migrate to result objects for consistency:
```typescript
// Potential future API (all failures as results, no exceptions)
const result = lifecycle.registerComponent(component);
if (!result.success && result.code === 'dependency_cycle') {
  console.error(`Dependency cycle: ${result.cycle}`);
}
```

### 3. Nullable Returns (Queries)

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

All result objects now include consistent fields for programmatic error handling:

```typescript
// All operation results include these fields
{
  success: boolean;
  componentName: string;    // or 'targetName' in some contexts
  reason?: string;          // Human-readable explanation
  code?: string;            // Machine-readable failure code
  error?: Error;            // Underlying error if applicable
  // ... operation-specific fields
}
```

### Result Types

| Operation | Result Type | Failure Codes |
|-----------|-------------|---------------|
| `startComponent()` | `ComponentOperationResult` | `component_not_found`, `component_already_running`, `missing_dependency`, `shutdown_in_progress`, etc. |
| `stopComponent()` | `ComponentOperationResult` | `component_not_found`, `component_not_running`, `stop_timeout` |
| `restartComponent()` | `ComponentOperationResult` | `restart_stop_failed`, `restart_start_failed` |
| `registerComponent()` | `RegisterComponentResult` | `duplicate_name`, `shutdown_in_progress`, `dependency_cycle` |
| `unregisterComponent()` | `UnregisterComponentResult` | `component_not_found`, `component_running`, `stop_failed` |

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

// ✗ Avoid (verb-first)
GetValueResult  // Should be ValueResult
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
