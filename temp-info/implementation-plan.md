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

## ~~Phase 7: Messaging, Health, Values~~ ✅ **COMPLETED**

**Implemented functionality**:

- ✅ Component-scoped lifecycle proxy (`ComponentLifecycle`) with callback injection
- ✅ Internal methods made private, accessed via `LifecycleInternalCallbacks`
- ✅ `sendMessageToComponent(name, payload)`:
  - Automatic `from` tracking (null for external, component name for component-to-component)
  - Calls `component.onMessage(payload, from)` with sync/async support
  - Returns `MessageResult` with sent status, data, and error
  - Blocks during shutdown
- ✅ `broadcastMessage(payload, options?)`:
  - Filter by running state and component names
  - Automatic `from` tracking
  - Continues on errors, aggregates all results
  - Returns `BroadcastResult[]` with per-component status
- ✅ `checkComponentHealth(name)`:
  - Calls `component.healthCheck()` if implemented
  - Races against `healthCheckTimeoutMS`
  - Normalizes boolean to `ComponentHealthResult`
  - Returns `HealthCheckResult` with timing and details
  - Components without handler return healthy (assume healthy)
- ✅ `checkAllHealth()`:
  - Checks all running components in parallel
  - Returns `HealthReport` with aggregate status
  - Overall healthy only if all components are healthy
- ✅ `getValue<T>(componentName, key)`:
  - Automatic `from` tracking
  - Calls `component.getValue(key, from)`
  - Returns `ValueResult<T>` with found/value/metadata
  - Only works on running components
- ✅ Events emitted:
  - `component:message-sent`, `component:message-failed`
  - `component:broadcast-started`, `component:broadcast-completed`
  - `component:health-check-started`, `component:health-check-completed`, `component:health-check-failed`
  - `component:value-requested`, `component:value-returned`

**Test results:** ✅ All 229 tests passing (881 assertions) - includes 31 new Phase 7 tests
**Build:** ✅ No TypeScript errors, clean build

**Phase 7 Tests Added (31 tests):**

- ✅ 7 tests for sendMessageToComponent()
  - Send to running component with handler
  - Component not found
  - Component not running
  - Component without handler
  - Handler throwing error
  - Reject during shutdown
  - Automatic 'from' tracking
- ✅ 7 tests for broadcastMessage()
  - Broadcast to all running
  - Skip non-running by default
  - Include non-running option
  - Filter by component names
  - Some handlers failing
  - Empty broadcast
  - Automatic 'from' tracking
- ✅ 9 tests for checkComponentHealth()
  - Boolean result normalization
  - Rich result with details
  - Component not found
  - Component not running
  - No handler (assumes healthy)
  - Handler throwing error
  - Timeout handling
  - Async health checks
  - Boolean false = unhealthy
- ✅ 4 tests for checkAllHealth()
  - All healthy components
  - Mixed health status
  - Only running components checked
  - Components without health check
- ✅ 3 tests for getValue()
  - Get value from component
  - Component not found
  - Component not running
  - No handler
  - Automatic 'from' tracking
  - Various return types
- ✅ 1 test for component-scoped lifecycle reference

**Architecture improvements**:

- Private internal methods with callback injection pattern
- ComponentLifecycle receives callbacks in constructor, not public interface access
- Cleaner separation: public API uses `null` for `from`, ComponentLifecycle uses component name

---

## ~~Phase 8: AutoStart & Final Polish~~ ✅ **COMPLETED**

**Implemented functionality:**

- ✅ AutoStart on registration with `options.autoStart`
  - Fire-and-forget when manager is running (`isStarted: true`)
  - Fire-and-forget with bypass during bulk startup (`isStarting: true`)
  - Deferred to `startAllComponents()` when manager is idle
  - Graceful error handling (logs but doesn't throw)
- ✅ Bypass parameter for `startComponent()` (`_bypassBulkOperationCheck`)
  - Allows AutoStart to work during bulk operations
  - Private parameter, not exposed in public API
- ✅ Event consolidation and metadata enrichment:
  - Removed separate `component:unregistered-during-shutdown` event
  - Added `duringShutdown?: boolean` to `component:unregistered` event
  - Added `duringStartup?: boolean` and `autoStarted?: boolean` to `component:registered` event
  - Added same metadata fields to all registration result objects
- ✅ Event emission when unregistration is attempted during shutdown (blocked but event includes flag)

**Test results:** ✅ All 246 tests passing (1039 assertions) - includes 11 new Phase 8 tests
**Build:** ✅ No TypeScript errors, clean build

**Phase 8 Tests Added (11 tests):**

- ✅ AutoStart disabled by default
- ✅ AutoStart behavior when manager is idle (deferred)
- ✅ AutoStart when manager is running (immediate fire-and-forget)
- ✅ AutoStart during bulk startup (immediate with bypass)
- ✅ Registration events include autoStarted metadata
- ✅ AutoStart failure handling (graceful, doesn't throw)
- ✅ AutoStart with missing dependencies (graceful failure)
- ✅ Unregistration during shutdown (blocked, event flag set)
- ✅ Registration during startup includes duringStartup flag
- ✅ Result objects include metadata fields

**API improvements:**

- Consolidated events with metadata flags instead of separate event types
- Better observability with duringStartup and autoStarted metadata

---

## ~~Phase 9: API & Event Consistency Review (0.5 day)~~ ✅ **COMPLETED**

### Goals

- Review API design for consistency and completeness
- The old `API_CONVENTIONS.md` file is a bit outdated, so use code as reference. The `API_CONVENTIONS.md` file could be deleted and add a section for future doc use in the `lifecycle-manager-prd.md`
- Validate event emitter patterns are consistent
- Using AI identify potential critical flaws or design issues
- Ensure no breaking changes needed before v1.0

### Completed Tasks

**API Review**:

- ✅ Reviewed all public method signatures for consistency
- ✅ Verified return types follow the result object pattern (all extend `BaseOperationResult`)
- ✅ Validated error handling is consistent (result objects for expected failures, exceptions only for constructor validation)
- ✅ Confirmed naming conventions are uniform (noun-first types, consistent query method patterns)

**Event Review**:

- ✅ Reviewed all event names and payloads for consistency
- ✅ Validated events are emitted at appropriate times via `LifecycleManagerEvents` class
- ✅ Confirmed event naming follows namespace patterns (`lifecycle-manager:*`, `component:*`, `signal:*`)
- ✅ No duplicate or redundant events found

**AI-Assisted Analysis**:

- ✅ No critical API flaws identified
- ✅ Async/await usage is consistent
- ✅ Error handling patterns are well-established
- ✅ No anti-patterns detected

**Documentation Updates**:

- ✅ Deleted `temp-info/API_CONVENTIONS.md`
- ✅ Added comprehensive "API Conventions" section to `lifecycle-manager-prd.md`
- ✅ Updated implementation status in PRD

### Key Findings (All Positive)

1. **Result Object Pattern**: All operations consistently return result objects extending `BaseOperationResult`
2. **Error Handling**: Only `BaseComponent` constructor throws exceptions (for name validation); all lifecycle operations return result objects
3. **Query Methods**: Consistent naming (`hasX`, `isX`, `getX`, `getXCount`, `getAllX`)
4. **Async/Sync Split**: Clear separation - lifecycle changes are async, queries are sync
5. **Event System**: Well-structured with typed payloads via `LifecycleManagerEvents` class
6. **Options Pattern**: All methods use trailing options parameters for extensibility

**Test results:** ✅ All 251 tests passing (1063 assertions)
**Build:** ✅ No TypeScript errors, clean build
**Lint:** ✅ No linting errors

---

## Phase 10: Integration Tests & Test Consolidation (1.5 days)

### Goals

- Add integration tests with mock components simulating real-world scenarios
- Consolidate unit tests that were split by phase into a clearer, feature-based structure
- Prune redundant or legacy references created during phased delivery

### Tasks

**Integration tests** (`lifecycle-manager.integration.test.ts`):

- Multi-component with complex dependencies (mock DB, cache, web server, API)
- Full signal handling
- Shutdown during startup with real components
- Optional/required mixes
- Health monitoring workflows

> **Tip**: Integration tests use mock components—classes extending `BaseComponent` that simulate services without real connections. No actual database or network calls needed.

**Test consolidation**:

- Merge or regroup phase-specific `describe()` blocks into feature-focused sections
- Deduplicate overlapping assertions
- Add a short "test map" comment at the top of `lifecycle-manager.test.ts` if needed

### Success Criteria

- Integration tests pass
- Unit tests read as a single, coherent suite without phase scaffolding
- No leftover phase markers in tests or test file organization

---

## Phase 11: Documentation & Export (1 day)

### Goals

- Create final, production-ready documentation
- Export LifecycleManager from the main package

### Tasks

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
- **Note**: Use the cleaned `lifecycle-manager-prd.md` as the reference specification when writing final documentation

**Export**:

- Update `src/index.ts` to export LifecycleManager, BaseComponent, types, errors

### Success Criteria

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

- Phase 1: 1 day ✅
- Phase 2: 2 days ✅
- Phase 3: 1.5 days ✅
- Phase 4: 1 day ✅
- Phase 5: 1.5 days ✅
- Phase 6: 1 day ✅
- Phase 7: 1.5 days ✅
- Phase 8: 0.5 day ✅
- Phase 9: 0.5 day ✅ (API review)
- Phase 10: 1.5 days (Integration tests + test consolidation)
- Phase 11: 1 day (Documentation + export)
- **Total: ~13 days**

---

## Verification

After each phase:

1. LifecycleManager unit tests pass (`bun test src/lib/lifecycle-manager/`)
2. Code coverage ≥ 95%
3. No TypeScript errors (`bun run build`)
4. Linting passes (`bun run lint`)
5. Comments above public methods when helpful for clarity
6. Corresponding PRD sections deleted

Final verification (Phase 11):

1. Integration tests pass
2. Example app runs successfully
3. All features demonstrated
4. Documentation complete
5. Exported from main package
6. PRD fully consumed
