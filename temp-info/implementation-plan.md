# LifecycleManager Implementation Plan

## Overview

Implementing a comprehensive lifecycle orchestration system with 30+ events, multi-phase shutdown, component dependencies, health checks, messaging, and ProcessSignalManager integration. Breaking the ~3000-line PRD into 8 manageable, testable phases following "implement → test → document → delete PRD section" workflow.

## Project Structure

```
src/lib/lifecycle-manager/
├── index.ts                    # Main LifecycleManager class
├── base-component.ts           # Abstract BaseComponent class
├── types.ts                    # All interfaces and types
├── errors.ts                   # Custom error classes
├── lifecycle-manager.test.ts   # Unit tests (incremental)
└── lifecycle-manager.integration.test.ts  # Integration tests (Phase 9)
```

## Phase 1: Foundation (1 day)

### Implement

**errors.ts** - Error classes with `errPrefix`, `errType`, `errCode` pattern:
- `InvalidComponentNameError` - kebab-case validation
- `ComponentRegistrationError` - duplicate names, registration during shutdown
- `DependencyCycleError` - circular dependencies
- `MissingDependencyError` - dependency not found
- `ComponentStartupError` - startup failure wrapper
- `StartupTimeoutError` - global startup timeout
- `ComponentNotFoundError` - component not in registry

**types.ts** - Core type definitions:
- `ComponentOptions` (name, dependencies, optional, all timeout configs)
- `ComponentState` (registered | starting | running | failed | stopping | force-stopping | stopped | stalled)
- `ComponentStatus`, `ComponentStallInfo`, `ShutdownMethod`
- Result types: `ComponentOperationResult`, `StartupResult`, `ShutdownResult`, `RestartResult`
- Message types: `MessageResult`, `BroadcastResult`
- Health types: `ComponentHealthResult`, `HealthCheckResult`, `HealthReport`
- Signal types: `SignalBroadcastResult`, `ComponentSignalResult`
- `GetValueResult`, `SystemState`, `RegisterOptions`, `UnregisterOptions`, `StartupOptions`
- `LifecycleManagerOptions`

**base-component.ts** - Abstract base class:
- Constructor with kebab-case name validation (regex: `/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/`)
- Create component logger: `rootLogger.service(name)`
- Store options with defaults (startupTimeoutMS: 30000, healthCheckTimeoutMS: 5000)
- Enforce minimums: gracefulTimeoutMS ≥ 1000ms, forceTimeoutMS ≥ 500ms
- Protected `lifecycle` reference (set by manager)
- Abstract: `start()`, `stop()`
- Optional: `onShutdownWarning()`, `onShutdownForce()`, `onReload()`, `onInfo()`, `onDebug()`
- Optional: `healthCheck()`, `onMessage(payload, from)`, `getValue(key, from)`
- Optional abort callbacks: `onStartupAborted()`, `onStopAborted()`, `onShutdownWarningAborted()`, `onShutdownForceAborted()`
- Getters: `getName()`, `getDependencies()`, `isOptional()`

### Tests
- Valid/invalid component names
- Default timeout values
- Timeout minimums enforced
- Logger scope creation
- Dependencies stored
- Optional flag works
- Error classes have correct properties

### Documentation
- JSDoc on BaseComponent explaining lifecycle
- Comment each optional method's purpose
- Document when abort callbacks are called

### PRD Sections to Delete
- Section 2 (Component Interface) - lines 107-235
- Error class portions of "Component Registration"
- Timeout minimum enforcement portions

---

## Phase 2: Core Registration & Individual Lifecycle (2 days)

### Implement

**index.ts** - LifecycleManager skeleton:
- Extend `EventEmitterProtected`
- Constructor: create `logger.service(name || 'lifecycle-manager')`
- Private: `components: BaseComponent[]`, `runningComponents: Set<string>`, `componentStates: Map<string, ComponentState>`, `stalledComponents: Map<string, ComponentStallInfo>`
- State flags: `isStarting`, `isStarted`, `isShuttingDown`
- Private `safeEmit()` wrapper for error-safe events

**Registration methods**:
- `registerComponent(component, options?)` - add at end, set `component.lifecycle = this`
- `insertComponentAt(component, position, targetName?, options?)` - flexible positioning
- `unregisterComponent(name, options?)` - async, with `stopIfRunning` option
- Validation: unique names, kebab-case, no registration during shutdown
- Emit: `component:registered`, `component:registration-rejected`, `component:unregistered`

**Status tracking**:
- `hasComponent(name): boolean`
- `isComponentRunning(name): boolean`
- `getComponentNames(): string[]`
- `getRunningComponentNames(): string[]`
- `getComponentCount(): number`
- `getRunningComponentCount(): number`
- `getComponentStatus(name): ComponentStatus | undefined`
- `getAllComponentStatuses(): ComponentStatus[]`
- `getSystemState(): SystemState`
- Private: `getComponent(name)` helper

**Individual lifecycle**:
- `startComponent(name)` - set state 'starting', call `start()` with timeout, update state/runningComponents
- `stopComponent(name)` - set state 'stopping', call `stop()` with timeout, handle stall
- `restartComponent(name)` - stop then start
- Call abort callbacks on timeout
- Emit events: `component:starting`, `component:started`, `component:start-failed`, `component:start-timeout`, `component:stopping`, `component:stopped`, `component:stop-timeout`, `component:stalled`

### Tests
- Register/unregister components
- Insert at start/end/before/after
- Duplicate names rejected
- Registration during shutdown rejected
- Status tracking correct
- Individual start/stop/restart
- Timeout handling
- Abort callbacks called
- State transitions correct
- Events emitted
- Event handler errors don't break lifecycle

### Documentation
- JSDoc on all public methods
- Explain result objects vs throwing
- Document state machine

### PRD Sections to Delete
- "Component Registration" (lines 690-748, excluding dependencies)
- "Component Lifecycle Management" - Individual control (lines 817-835)
- "Status Tracking" - Component status (lines 1028-1082)
- "Restart Behavior" - Individual restart portion

---

## Phase 3: Bulk Operations (1.5 days)

### Implement

**Bulk methods**:
- `startAllComponents(options?)`:
  - Reject if partial state (some already running)
  - Set `isStarting` flag
  - Snapshot component list
  - Loop in registration order (dependencies in Phase 4)
  - On failure: rollback (stop all started in reverse order)
  - Handle optional components (don't trigger rollback)
  - Global startup timeout
  - Handle shutdown during startup (abort, rollback, emit event)

- `stopAllComponents()`:
  - Set `isShuttingDown` flag
  - Snapshot running components in reverse order
  - For each: call `stopComponent()` (multi-phase in Phase 5)
  - Continue on errors, track stalled
  - Global shutdown timeout
  - Emit: `lifecycle-manager:shutdown-initiated`, `lifecycle-manager:shutdown-completed`

- `restartAllComponents(options?)`:
  - Call `stopAllComponents()` then `startAllComponents()`
  - Return combined result

**Concurrent operation prevention**:
- Track `isStarting`, `isStopping` flags
- Reject individual operations during bulk operations

### Tests
- Start all in registration order
- Partial state rejected
- Startup failure triggers rollback
- Rollback in reverse order
- Global timeout aborts remaining
- Stop all in reverse order
- Continue on errors
- Stalled components tracked
- Restart = stop + start
- Shutdown during startup handled
- Concurrent operations prevented
- State reset after completion

### Documentation
- Explain partial state prevention
- Document rollback behavior
- Explain snapshot lists

### PRD Sections to Delete
- "Bulk Operations" (lines 839-873)
- "Partial Start Prevention" (lines 920-948)
- "Error Handling" (lines 950-953)
- "Startup Rollback Behavior" (lines 955-973)
- "Startup Timeout" (lines 975-984)
- "Shutdown During Startup" (lines 986-1005)
- "Concurrent Operation Prevention" (lines 1007-1023)

---

## Phase 4: Dependency Management (1 day)

### Implement

**Dependency resolution**:
- Private `topologicalSort()` - Kahn's algorithm or DFS-based
- `getStartupOrder(): string[]` - public API for topological order
- Automatic validation: throw `DependencyCycleError` or `MissingDependencyError` when issues detected

**Update bulk operations**:
- Modify `startAllComponents()` to use topological order
- Modify `stopAllComponents()` to use reverse topological order
- Optional component dependency handling (skip dependents if optional dep fails)

**Cycle detection on registration**:
- Check for cycles when registering component with dependencies
- Throw early feedback

### Tests
- Linear dependencies: A → B → C starts as C, B, A
- Diamond dependencies work
- Multiple independent chains
- Registration order preserved when no dependencies
- Reverse order for shutdown
- Cycle detection (simple, complex, self)
- Missing dependencies detected
- Optional component dependencies

### Documentation
- Explain topological sort
- Document dependency rules
- Show dependency graph examples

### PRD Sections to Delete
- "Component Dependencies" (lines 1365-1427)
- "Dependencies" test section (lines 2818-2822)
- Dependency portions of "Optional Components"

---

## Phase 5: Multi-Phase Shutdown (1.5 days)

### Implement

**Three-phase shutdown** (private method):
- `private async shutdownComponent(component): Promise<ComponentShutdownResult>`
  - **Phase 1: Warning** (if `shutdownWarningTimeoutMS > 0` and implemented)
    - Call `onShutdownWarning()`
    - Race against timeout
    - On timeout: call `onShutdownWarningAborted()`, proceed to Phase 2
  - **Phase 2: Graceful** (always)
    - Set state 'stopping'
    - Call `stop()`
    - Race against `shutdownGracefulTimeoutMS`
    - On success: return
    - On timeout/error: call `onStopAborted()`, proceed to Phase 3
  - **Phase 3: Force** (if Phase 2 failed)
    - Set state 'force-stopping'
    - Call `onShutdownForce()` if implemented
    - Race against `shutdownForceTimeoutMS`
    - On timeout: call `onShutdownForceAborted()`, set state 'stalled'
    - Pass context (timeout vs error)

**Update methods**:
- Replace simple stop in `stopComponent()` with multi-phase
- Use multi-phase in `stopAllComponents()`

**Stalled tracking**:
- `getStalledComponents(): ComponentStallInfo[]`
- Clear on shutdown completion

**Events**:
- `component:shutdown-warning`, `component:shutdown-warning-completed`, `component:shutdown-warning-timeout`
- `component:shutdown-force`, `component:shutdown-force-completed`, `component:shutdown-force-timeout`

### Tests
- Three-phase flow (warning → graceful → stopped)
- Graceful timeout → force → stopped
- Graceful error → force → stopped
- Force timeout → stalled
- Skip warning if timeout = 0
- Abort callbacks at right times
- Per-component timeout configs
- Context passed to force handler

### Documentation
- Diagram three-phase flow
- Explain when each phase runs
- Document context parameter

### PRD Sections to Delete
- "Multi-Phase Shutdown Strategy" (lines 255-310)
- "Timeout Configuration" - per-component (lines 1317-1364)
- Three-phase shutdown test portions

---

## Phase 6: Signal Integration (1 day)

### Implement

**ProcessSignalManager composition**:
- Private `processSignalManager: ProcessSignalManager | null`
- `attachSignals()` - create and attach ProcessSignalManager
- `detachSignals()` - wrapper
- `getSignalStatus()` - wrapper

**Signal mapping**:
- Shutdown signals (SIGINT, SIGTERM, SIGTRAP) → `initiateShutdown(method)`
- Reload signal → custom callback OR `broadcastReload()`
- Info signal → custom callback OR log warning
- Debug signal → custom callback OR log warning

**Custom callbacks in options**:
- `onReloadRequested?: (broadcastReload: () => Promise<SignalBroadcastResult>) => void | Promise<void>`
- `onInfoRequested?: () => void | Promise<void>`
- `onDebugRequested?: () => void | Promise<void>`

**Broadcast methods** (private):
- `broadcastReload()`, `broadcastInfo()`, `broadcastDebug()`
- Call `onReload()`, `onInfo()`, `onDebug()` on running components
- Continue on errors, aggregate results

**Manual triggers**:
- `triggerShutdown(method?)`, `triggerReload()`, `triggerInfo()`, `triggerDebug()`

**Events**:
- `signal:shutdown`, `signal:reload`, `signal:info`, `signal:debug`
- `component:reload-started`, `component:reload-completed`, `component:reload-failed`
- Same for info/debug
- `lifecycle-manager:signals-attached`, `lifecycle-manager:signals-detached`

### Tests
- Attach/detach work
- Shutdown signals trigger shutdown
- Reload custom callback vs default broadcast
- Info/debug custom callbacks vs warnings
- Component signal handlers called
- Errors don't break broadcast
- Manual triggers work
- Events emitted

### Documentation
- Signal-to-lifecycle mapping
- Custom callback usage
- broadcastReload example

### PRD Sections to Delete
- "ProcessSignalManager Integration" (lines 20-106)
- "Signal Integration" (lines 1116-1198)
- "Signal Handling" test section

---

## Phase 7: Messaging, Health, Values (1.5 days)

### Implement

**Component messaging**:
- Private `getCallerComponentName(): string | null` - track caller via lifecycle reference
- `sendMessageToComponent(name, payload)`:
  - Determine `from` automatically
  - Call `component.onMessage(payload, from)`
  - Handle sync/async (use `isPromise()`)
  - Return `MessageResult` with data/error
- `broadcastMessage(payload, options?)`:
  - Filter by running/all, componentNames
  - Determine `from` automatically
  - Aggregate results
- Emit: `component:message-sent`, `component:message-failed`, `component:broadcast-started`, `component:broadcast-completed`

**Health checks**:
- `checkComponentHealth(name)`:
  - Call `component.healthCheck()` if implemented
  - Race against `healthCheckTimeoutMS`
  - Normalize boolean to `{ healthy: boolean }`
  - Return rich result with timing
- `checkAllHealth()`:
  - Aggregate all component health
  - Overall healthy = all healthy
- Emit: `component:health-check-started`, `component:health-check-completed`, `component:health-check-failed`

**Shared values**:
- `getValue<T>(componentName, key)`:
  - Determine `from` automatically
  - Call `component.getValue(key, from)`
  - Return `GetValueResult<T>` with found/value/metadata
- Emit: `component:value-requested`, `component:value-returned`

### Tests
- Send message, return data
- Async/sync handlers
- `from` tracking (external = null, component = name)
- Message to non-running rejected
- Message during shutdown rejected
- Error captured
- Broadcast with filters
- Health checks (boolean, rich, timeout, error)
- Aggregate health
- getValue returns value/undefined
- Result metadata correct

### Documentation
- Explain `from` tracking
- Messaging examples
- Health check patterns
- getValue vs onMessage

### PRD Sections to Delete
- "Component Messaging" (lines 312-509)
- "Health Checks" (lines 1428-1592)
- "Shared Values" (lines 1593-1745)
- Corresponding test sections

---

## Phase 8: Optional Components & Final Polish (1 day)

### Implement

**Optional components**:
- Update `startAllComponents()`:
  - On failure, check `component.isOptional()`
  - If optional: log warning, set state 'failed', add to `failedOptionalComponents`, continue
  - If required: rollback
  - Track `skippedDueToDependency`

**AutoStart on registration**:
- In `registerComponent()` and `insertComponentAt()`:
  - If `autoStart: true` and `isStarted || isStarting`, start component
  - Handle failures

**Stalled component restart blocking**:
- In `startAllComponents()`:
  - Check stalled components exist
  - If yes and not `ignoreStalledComponents`, throw error

**Dynamic removal during shutdown**:
- In `unregisterComponent()`:
  - Handle shutdown in progress
  - Emit `component:unregistered-during-shutdown`

**Final events**:
- `component:start-failed-optional`
- `component:start-skipped`
- `component:unregistered-during-shutdown`

**Status tracking**:
- `shutdownMethod`, `shutdownStartTime`, `shutdownDuration`

### Tests
- Optional fails, app continues
- Required fails, rollback
- Dependency chains with optional
- AutoStart before/during/after startup
- AutoStart during shutdown rejected
- Stalled blocks restart
- `ignoreStalledComponents` works
- Dynamic registration/unregistration
- Multiple LifecycleManager instances
- Empty component list
- All optional, all fail

### Documentation
- Optional component behavior
- AutoStart nuances
- Stalled recovery
- Comprehensive examples

### PRD Sections to Delete
- "Optional Components" (lines 1747-1819)
- "Abort Callbacks" (lines 1820-1932)
- AutoStart portions
- "Shutdown-to-Restart Cycle" (lines 1203-1302)
- "Stalled Component Memory"
- "Testing Strategy" (move tests to test files)

---

## Phase 9: Integration & Documentation (1.5 days)

### Implement

**Integration tests** (`lifecycle-manager.integration.test.ts`):
- Multi-component with complex dependencies
- Full signal handling
- Shutdown during startup with real components
- Optional/required mixes
- Health monitoring workflows

**Example app** (`examples/lifecycle-demo/`):
- Database, cache, web server, API components
- Dependency declaration
- Optional components
- Messaging and getValue
- Health check endpoint
- Signal handling demo

**Documentation**:
- README.md for LifecycleManager (quick start, architecture, API reference, best practices)
- Migration guide from old implementations
- Event reference

**Export**:
- Update `src/index.ts` to export LifecycleManager, BaseComponent, types, errors

### Success Criteria
- Integration tests pass
- Example app runs and demonstrates all features
- README is comprehensive
- Exported from main package

---

## Key Implementation Patterns

Based on exploration of existing codebase:

1. **Error Handling**: Custom error classes with `errPrefix`, `errType`, `errCode`; result objects for expected failures; throw only for programmer errors
2. **Async**: `async/await`, `Promise.race()` for timeouts, `isPromise()` for detection, `safeHandleCallback()` for events
3. **Logging**: Manager uses `logger.service('lifecycle-manager')`, manager about component uses `.entity(componentName)`, component uses `rootLogger.service(componentName)`
4. **State**: Private fields with public getters, immutable public state, logged/evented transitions
5. **Testing**: Bun test, `describe`/`test`/`expect`, `mock()` for callbacks, `beforeEach`/`afterEach` cleanup, test sync and async paths
6. **Code Style**: Private methods/fields, early returns/guards, descriptive names, JSDoc, TypeScript strict

---

## Critical Files

1. **src/lib/lifecycle-manager/index.ts** - Core LifecycleManager class (Phases 2-8)
2. **src/lib/lifecycle-manager/base-component.ts** - Abstract BaseComponent (Phase 1)
3. **src/lib/lifecycle-manager/types.ts** - All TypeScript types (Phase 1, used throughout)
4. **src/lib/lifecycle-manager/errors.ts** - Custom error classes (Phase 1)
5. **src/lib/lifecycle-manager/lifecycle-manager.test.ts** - Unit tests (incremental)

---

## Timeline Estimate

- Phase 1: 1 day
- Phase 2: 2 days
- Phase 3: 1.5 days
- Phase 4: 1 day
- Phase 5: 1.5 days
- Phase 6: 1 day
- Phase 7: 1.5 days
- Phase 8: 1 day
- Phase 9: 1.5 days
- **Total: ~12 days**

---

## Verification

After each phase:
1. All unit tests pass (`bun test`)
2. Code coverage ≥ 95%
3. No TypeScript errors (`bun run build`)
4. Linting passes (`bun run lint`)
5. JSDoc on all public APIs
6. Corresponding PRD sections deleted

Final verification (Phase 9):
1. Integration tests pass
2. Example app runs successfully
3. All features demonstrated
4. Documentation complete
5. Exported from main package
6. PRD fully consumed
