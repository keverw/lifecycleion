# LifecycleManager Implementation Plan

## Overview

Implementing a comprehensive lifecycle orchestration system with 30+ events, multi-phase shutdown, component dependencies, health checks, messaging, and ProcessSignalManager integration. Breaking the ~3000-line PRD (lifecycle-manager-prd.md within this same directory) into 8 manageable, testable phases following "implement → test → document → delete PRD section" workflow.

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

## ~~Phase 1: Foundation~~ ✅ **COMPLETED**

**Implemented files:**

- ✅ [errors.ts](../../src/lib/lifecycle-manager/errors.ts) - All error classes with errPrefix/errType/errCode pattern
- ✅ [types.ts](../../src/lib/lifecycle-manager/types.ts) - All TypeScript type definitions
- ✅ [base-component.ts](../../src/lib/lifecycle-manager/base-component.ts) - Abstract BaseComponent class with method-level comments
- ✅ [lifecycle-manager.test.ts](../../src/lib/lifecycle-manager/lifecycle-manager.test.ts) - Unit tests (27 tests passing, 113 assertions)
- ✅ [index.ts](../../src/lib/lifecycle-manager/index.ts) - Module exports

**Test results:** 27 tests passing, 113 expect() assertions, 0 failures (`bun test src/lib/lifecycle-manager/lifecycle-manager.test.ts`)
**Build:** ✅ No TypeScript errors, no linting errors
**PRD updated:** ✅ Deleted Component Interface section, error class portions, timeout minimums

---

## ~~Phase 2: Core Registration & Individual Lifecycle~~ ✅ **COMPLETED**

**Implemented files:**

- ✅ [lifecycle-manager.ts](../../src/lib/lifecycle-manager/lifecycle-manager.ts) - Core LifecycleManager class with all Phase 2 functionality
- ✅ [lifecycle-manager.test.ts](../../src/lib/lifecycle-manager/lifecycle-manager.test.ts) - Extended with Phase 2 tests (69 tests passing, 244 assertions)
- ✅ [index.ts](../../src/lib/lifecycle-manager/index.ts) - Exports updated to include LifecycleManager

**Implemented functionality:**

- ✅ LifecycleManager skeleton extending EventEmitterProtected
- ✅ Constructor with logger hierarchy setup
- ✅ All private fields: components, runningComponents, componentStates, stalledComponents, timestamps, errors
- ✅ State flags: isStarting, isStarted, isShuttingDown
- ✅ safeEmit() wrapper for error-safe events
- ✅ Registration: registerComponent(), insertComponentAt(), unregisterComponent()
- ✅ Status tracking: 13 methods (hasComponent, isComponentRunning, getComponentNames, etc.)
- ✅ Individual lifecycle: startComponent(), stopComponent(), restartComponent()
- ✅ Timeout handling with abort callbacks
- ✅ Stall detection and tracking
- ✅ 11 event types emitted with proper data
- ✅ State transitions: registered → starting → running → stopping → stopped/stalled

**Test results:** 69 tests passing, 244 expect() assertions, 0 failures (`bun test src/lib/lifecycle-manager/lifecycle-manager.test.ts`)
**Build:** ✅ No TypeScript errors, clean build
**PRD updated:** ✅ Deleted Component Registration, Individual Lifecycle, and Status Tracking sections

---

## ~~Phase 2.5: API Consistency & Sync Lifecycle (0.5 day)~~ ✅ **COMPLETED**

**Implemented updates:**

- ✅ Result-object error handling for registration/startup-order APIs
- ✅ Sync start/stop support test coverage
- ✅ Types updated with startup-order result codes

**Tests:** Not run (not requested)
**PRD updated:** ✅ Error-handling policy updated (sync start/stop already documented)

---

## ~~Phase 2.6: Manual Dependency Validation & Cycle Reporting~~ ✅ **COMPLETED**

**Implemented updates:**

- ✅ `startComponent()` validates dependencies are registered and running (optional bypass option for optional dependencies)
- ✅ Operation failure codes added for missing/not-running dependencies
- ✅ Cycle errors report detected cycle path when available

**Tests:** Not run (not requested)
**PRD updated:** ✅ Component Dependencies section updated (manual start + cycle reporting)

---

## ~~Phase 2.7: Unified Base Interface & API Enhancements~~ ✅ **COMPLETED**

**Implemented updates:**

- ✅ Created `BaseOperationResult` interface with common fields (success, reason, code, error, status)
- ✅ All result types now extend base interface:
  - `ComponentOperationResult`
  - `UnregisterComponentResult`
  - `RegistrationResultBase`
  - `StartupOrderResult`
- ✅ Enhanced `StopComponentOptions` with `forceImmediate` and `timeout` options
- ✅ Added `status?: ComponentStatus` field to operation results for immediate state access
- ✅ Renamed `GetValueResult` to `ValueResult` for naming consistency
- ✅ All public API methods return result objects (no exceptions thrown to callers)

**Tests:** Not run (not requested)
**Documentation updated:**

- ✅ API_CONVENTIONS.md updated to reflect unified base interface and current implementation
- ✅ api-review-summary.md deleted (review complete)

---

## ~~Phase 3: Bulk Operations~~ ✅ **COMPLETED**

**Implemented functionality**:

- ✅ `startAllComponents(options?)`:
  - ✅ Reject if partial state (some already running)
  - ✅ Set `isStarting` flag
  - ✅ Snapshot component list
  - ✅ Loop in registration order (dependencies will be in Phase 4)
  - ✅ On failure: rollback (stop all started in reverse order)
  - ✅ Handle optional components (don't trigger rollback)
  - ✅ Handle shutdown during startup (abort, rollback, emit event)
  - ✅ Block startup if stalled components exist (unless ignoreStalledComponents option)

- ✅ `stopAllComponents()`:
  - ✅ Set `isShuttingDown` flag
  - ✅ Snapshot running components in reverse order
  - ✅ For each: call `stopComponent()` (multi-phase in Phase 5)
  - ✅ Continue on errors, track stalled
  - ✅ Emit: `lifecycle-manager:shutdown-initiated`, `lifecycle-manager:shutdown-completed`

- ✅ `restartAllComponents(options?)`:
  - ✅ Call `stopAllComponents()` then `startAllComponents()`
  - ✅ Return combined result

**Concurrent operation prevention**:

- ✅ Track `isStarting`, `isShuttingDown` flags
- ✅ Reject individual operations during bulk operations
- ✅ `startComponent()`, `stopComponent()`, `restartComponent()` all check bulk operation flags

**Test results:** ✅ All 106 tests passing (431 assertions) - includes 23 new Phase 3 tests
**Build:** ✅ No TypeScript errors, clean build
**PRD updated:** ✅ Specified sections deleted

**Phase 3 Tests Added (23 tests):**

- ✅ 7 tests for startAllComponents() behavior
  - Start all in registration order
  - Partial state rejected
  - All running returns success
  - Startup failure triggers rollback
  - Rollback in reverse order
  - Optional components handled gracefully
  - Shutdown during startup handled
  - Stalled components block startup
  - ignoreStalledComponents option works
  - Events emitted correctly
- ✅ 4 tests for stopAllComponents() behavior
  - Stop all in reverse order
  - Continue on errors, track stalled
  - Events emitted correctly
  - State reset after completion
  - Duration calculated
- ✅ 3 tests for restartAllComponents() behavior
  - Stop then start sequence
  - Combined result structure
  - Stalled component handling
- ✅ 4 tests for concurrent operation prevention
  - Prevent start during bulk startup
  - Prevent stop during bulk startup
  - Prevent restart during bulk operations
  - Prevent start during shutdown

---

## ~~Phase 4: Dependency Management~~ ✅ **COMPLETED**

**Implemented functionality**:

- ✅ `getStartupOrderInternal()` - Kahn's algorithm for topological sort
- ✅ `getStartupOrder()` - Public API returning `StartupOrderResult`
- ✅ Single source of truth: sorter used by registration and getStartupOrder()
- ✅ `validateDependencies()` - Validation report with summary counts
  - Reports missing dependencies (with optional/required distinction)
  - Detects cycles
  - Returns detailed summary (totalMissingDependencies, requiredMissingDependencies, optionalMissingDependencies, totalCycles)
- ✅ Cycle detection on registration - returns failure result with `dependency_cycle` code
- ✅ `startAllComponents()` uses topological order
- ✅ `stopAllComponents()` uses reverse topological order
- ✅ Optional component dependency handling - skips dependents if optional dep fails
- ✅ `allowRequiredDependencies` option added to `StartComponentOptions`
- ✅ Manual start validates dependencies with override options
- ✅ Unregistration blocked during bulk operations to prevent race conditions

**Test results:** ✅ All 133 tests passing (523 assertions) - includes 23 new Phase 4 tests

**Phase 4 Tests Added (23 tests):**

- ✅ Linear dependencies (A → B → C starts as C, B, A)
- ✅ Diamond dependencies
- ✅ Multiple independent chains
- ✅ Registration order preserved when no dependencies
- ✅ Reverse order for shutdown
- ✅ Cycle detection (simple, complex, self)
- ✅ Missing dependency detection during manual start
- ✅ Dependency not running detection during manual start
- ✅ `allowOptionalDependencies` option for manual start
- ✅ `allowRequiredDependencies` option for manual start
- ✅ Skip components when optional dependency fails
- ✅ `validateDependencies()` returns valid when no issues
- ✅ `validateDependencies()` reports missing dependencies
- ✅ `validateDependencies()` reports cycles during registration
- ✅ `validateDependencies()` reports multiple issues with summary counts
- ✅ `getStartupOrder()` returns resolved order
- ✅ `getStartupOrder()` succeeds with valid dependencies

**Build:** ✅ No TypeScript errors, clean build
**PRD updated:** ✅ Deleted Component Dependencies section, renumbered remaining sections

---

## ~~Phase 5: Multi-Phase Shutdown~~ ✅ **COMPLETED**

- ✅ Implemented global warning phase (manager-level timeout) before per-component shutdown
- ✅ Updated per-component shutdown flow to graceful → force only
- ✅ Updated shutdown warning/force events and tests
- ✅ Removed corresponding PRD sections after implementation

---

## ~~Phase 6: Signal Integration~~ ✅ **COMPLETED**

**Implemented functionality**:

- ✅ ProcessSignalManager composition with private field
- ✅ `attachSignals()` / `detachSignals()` / `getSignalStatus()` public API
- ✅ Signal mapping:
  - Shutdown signals (SIGINT, SIGTERM, SIGTRAP) → `stopAllComponents()`
  - Reload signal → custom callback OR `broadcastReload()`
  - Info signal → custom callback OR log warning
  - Debug signal → custom callback OR log warning
- ✅ Custom callbacks in constructor options:
  - `onReloadRequested?: (broadcastReload: () => Promise<SignalBroadcastResult>) => void | Promise<void>`
  - `onInfoRequested?: () => void | Promise<void>`
  - `onDebugRequested?: () => void | Promise<void>`
- ✅ Private broadcast methods: `broadcastReload()`, `broadcastInfo()`, `broadcastDebug()`
- ✅ Manual triggers: `triggerShutdown()`, `triggerReload()`, `triggerInfo()`, `triggerDebug()`
- ✅ All signal-related events emitted
- ✅ Double shutdown protection (ignores signal if already shutting down)
- ✅ Only broadcasts to running components
- ✅ Handles signals during startup (only affects already-started components)

**Test results:** ✅ All 196 tests passing (722 assertions) - includes 14 new Phase 6 tests
**Build:** ✅ No TypeScript errors, clean build

**Phase 6 Tests Added (14 tests):**

- ✅ Attach/detach signal handlers
- ✅ Idempotent attach/detach
- ✅ Signal-related events emitted
- ✅ Shutdown trigger initiates stopAllComponents
- ✅ Double shutdown protection works
- ✅ Reload broadcasts to running components
- ✅ Reload only affects running components
- ✅ Reload skips components without onReload
- ✅ Reload continues on errors
- ✅ Reload events emitted correctly
- ✅ Custom reload callback works
- ✅ Custom info/debug callbacks work
- ✅ Info/debug warnings when no handler
- ✅ Signals during startup handled correctly
- ✅ getSignalStatus returns correct info

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

**Implementation requirements**:

- Check if `isStarting` or `isStarted` (manager state)
- Only start if dependencies are met (validate dependencies exist and are running)
- Handle edge cases gracefully:
  - During startup: component should be started immediately if deps are ready
  - After startup: normal dependency validation applies
  - During shutdown: reject registration attempt
  - Missing dependencies: return appropriate error

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

## Phase 9: Consolidation & Reorg (1 day)

### Goals

- Consolidate tests that were split by phase into a clearer, feature-based structure
- Prune redundant or legacy references created during phased delivery

### Tasks

**Tests**:

- Merge or regroup phase-specific `describe()` blocks into feature-focused sections
- Deduplicate overlapping assertions
- Add a short "test map" comment at the top of `lifecycle-manager.test.ts` if needed

### Success Criteria

- Tests read as a single, coherent suite without phase scaffolding
- No leftover phase markers in tests or test file organization

---

## Phase 10: Integration & Documentation (1.5 days)

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

**Documentation** (final, not phase-based):

- README.md for LifecycleManager (quick start, architecture, API reference, best practices)
- Migration guide from old implementations
- Event reference
- Remove phase language and any PRD remnants that leaked into docs

**Export**:

- Update `src/index.ts` to export LifecycleManager, BaseComponent, types, errors

### Success Criteria

- Integration tests pass
- Example app runs and demonstrates all features
- Docs read as final product docs, not a phased work plan
- Exported from main package

---

## Key Implementation Patterns

Based on exploration of existing codebase:

1. **Error Handling**: Custom error classes with `errPrefix`, `errType`, `errCode`; result objects for expected failures; throw only for programmer errors
2. **Async**: `async/await`, `Promise.race()` for timeouts, `isPromise()` for detection, `safeHandleCallback()` for events
3. **Logging**: Manager uses `logger.service('lifecycle-manager')`, manager about component uses `.entity(componentName)`, component uses `rootLogger.service(componentName)`
4. **State**: Private fields with public getters, immutable public state, logged/evented transitions
5. **Testing**: Bun test runner. While iterating on LifecycleManager, prefer scoped runs like `bun test src/lib/lifecycle-manager/` (or the single file) instead of the entire repo test suite, to avoid unrelated environment-dependent suites.
6. **Code Style**: Private methods/fields, early returns/guards, descriptive names, TypeScript strict

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

1. LifecycleManager unit tests pass (`bun test src/lib/lifecycle-manager/`)
2. Code coverage ≥ 95%
3. No TypeScript errors (`bun run build`)
4. Linting passes (`bun run lint`)
5. Comments above public methods when helpful for clarity
6. Corresponding PRD sections deleted

Final verification (Phase 9):

1. Integration tests pass
2. Example app runs successfully
3. All features demonstrated
4. Documentation complete
5. Exported from main package
6. PRD fully consumed
