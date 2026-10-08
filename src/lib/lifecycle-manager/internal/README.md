# LifecycleManager internals

`lifecycle-manager.ts` is the public facade. Its constructor builds the manager's state,
config, loggers, event plumbing and component access context once and hands them to a
`ManagerCore`; each public method then answers from that state - the status getters - or
delegates to the subsystem that owns the operation, under the public-method safety net
where it has one. The only private members it keeps are that wiring: its fields, the
access context (`createComponentAccessContext()`), and event delivery
(`deliverEvent()`).

Everything else lives in this directory. These modules are internal implementation
details, not exports of the package's lifecycle-manager entry.

## The core and its subsystems

`ManagerCore` (`manager-core.ts`) holds the parts every subsystem shares, built once by
the facade:

| Field                        | What it is                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `manager`                    | The facade, for its public, overridable methods - called through it at call time.                |
| `state`                      | `LifecycleManagerState`: every field the manager changes after construction.                     |
| `config`                     | `ManagerConfig`: the constructor options, validated and frozen.                                  |
| `logger`                     | The manager's guarded `LoggerService`; no log call can throw or reject at its call site.         |
| `rootLogger`                 | The caller's own `Logger`, never wrapped, for the logger exit hook.                              |
| `lifecycleEvents`            | The typed event emitters, queued through `dispatcher`.                                           |
| `dispatcher`                 | `TransitionEventDispatcher`: transition depth and the notification FIFO.                         |
| `registryReads`              | `RegistrationReadTracker`: registration generations and bounded reads of the live registry.      |
| `componentMetadata`          | `ComponentMetadataReader`: guarded dependency and optional-status reads, and their report marks. |
| `componentAccess`            | The live view and dispatch callbacks the component-facing modules use.                           |
| `createProcessSignalManager` | Creates the `ProcessSignalManager`, so these modules never import the Node-only signal manager.  |

and every subsystem, a class built over the core:

| Field                | Module                         | Responsibility                                                                                                                                                               |
| -------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registry`           | `component-registry.ts`        | `ComponentRegistry`: lookups by name, recorded names, statuses and timestamps, the `isStarted` flag, the reservations a registration checks, insertion indexes, publication. |
| `registration`       | `registration-operations.ts`   | `RegistrationOperations`: registering and inserting - reads, refusals, the provisional commit and its rollback, auto-start - and the `lifecycle` handle's callbacks.         |
| `unregistration`     | `unregistration-operations.ts` | `UnregistrationOperations`: unregistering - its refusals, stopping a running component first, the replacement checks after caller code, and the removal.                     |
| `startupOrdering`    | `startup-ordering.ts`          | `StartupOrdering`: the dependency order startup, shutdown and registration share, answering a failure to compute it, and `getStartupOrder()` / `validateDependencies()`.     |
| `claims`             | `component-claims.ts`          | `ComponentClaims`: taking, checking and releasing the per-component claims start and stop attempts hold.                                                                     |
| `componentStart`     | `component-start.ts`           | `ComponentStart`: the per-component start pipeline - the start net, its preconditions, the attempt, start settlements, and marking a component running.                      |
| `componentStop`      | `component-stop.ts`            | `ComponentStop`: the per-component stop pipeline - refusals, the stop net, graceful and force phases, stalled retries, and late stop resolution.                             |
| `lateStartRecovery`  | `late-start-recovery.ts`       | `LateStartRecovery`: stopping a start the manager stopped waiting for if it completes later, and whether such a start is still awaited.                                      |
| `unexpectedStops`    | `unexpected-stops.ts`          | `UnexpectedStops`: the unexpected-stop handler a running component reports through, clearing it, and draining the stops a bulk startup recorded.                             |
| `startup`            | `startup-orchestration.ts`     | `StartupOrchestration`: bulk startup - its refusals, the startup latch, the batch loop and follow-up auto-starts, rollback, and releasing what it held.                      |
| `shutdownPass`       | `shutdown-pass.ts`             | `ShutdownPassRunner`: the shutdown latch, accepting or refusing a pass, and the pass itself - warning phase, stop loop, joined starts, and its result.                       |
| `shutdownEscalation` | `shutdown-escalation.ts`       | `ShutdownEscalation`: shutdown signal requests, repeated-request counting, the post-failure armed window, and the escalation status.                                         |
| `restart`            | `restart-operations.ts`        | `RestartOperations`: bulk and single restarts - refusals, validating both phases before any stop, and the stale-snapshot check.                                              |
| `signals`            | `signal-integration.ts`        | `SignalIntegration`: attaching and detaching process signals, the automatic attach before a start and detach once idle, and the reload, info and debug requests.             |
| `loggerExit`         | `logger-exit-hook.ts`          | `LoggerExitHook`: the `beforeExit` callback, settling a pending exit when a pass ends, and the exit-in-progress gate.                                                        |
| `messaging`          | `messaging-operations.ts`      | `MessagingOperations`: messages, broadcasts and value reads under the public-method safety net, shared by the public methods and the `lifecycle` handle.                     |

### How subsystems reach each other

- Each subsystem receives the core in its constructor and only stores it there, since
  another subsystem may not exist yet.
- It reaches other subsystems through the core (`core.registry.getComponent()`), and
  calls the manager's public, overridable methods through `core.manager` at call time,
  so a subclass override or an instance patch of one is the one that runs.
- There is no bridge back to private manager members: every member a subsystem calls
  has an owning subsystem. A new operation goes onto the subsystem that owns its state,
  or into a new one - not onto the facade, and not behind a forwarding callback.
- Bookkeeping that only one subsystem touches is that subsystem's own private state
  rather than a state field: the logger exit's flags live on `LoggerExitHook`, the
  stall details beside each stall record on `ComponentStop`, and the armed window's
  expiry timer on `ShutdownEscalation`.
- State that lives only as long as one operation is an explicit record that operation
  hands to each of its phases: a bulk startup's progress, deadline and release reasons
  are the `StartupRun` every phase of `StartupOrchestration` takes, and a
  registration's reads and index are the `RegistrationAttempt` every phase of
  `registerComponentInternal()` takes. Phases stay synchronous; an asynchronous step
  hands its promise back to be awaited directly, so a split adds no await point.
- Tests reach subsystems through `coreOf(manager)` (`test-helpers.ts`). A few members
  are kept as methods only as test seams, and say so:
  `RegistrationOperations.isManualPositionRespected()` and
  `ShutdownPassRunner.runShutdownWarningPhase()`.

### Where does it live?

| Looking for                                                              | Where                                                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| A component by name, its recorded name or status, `isStarted`            | `ComponentRegistry`                                                                       |
| `registerComponent()`, `insertComponentAt()` / `unregisterComponent()`   | `RegistrationOperations` / `UnregistrationOperations`                                     |
| `getStartupOrder()`, `validateDependencies()`, the order startup follows | `StartupOrdering`; the graph itself in `dependency-policy.ts`                             |
| `startComponent()` / `stopComponent()`                                   | `ComponentStart` / `ComponentStop`, holding claims through `ComponentClaims`              |
| A timed-out start that completes later; a running component's crash      | `LateStartRecovery`; `UnexpectedStops`                                                    |
| `startAllComponents()` / `stopAllComponents()`                           | `StartupOrchestration` / `ShutdownPassRunner`; warnings in `shutdown-warning.ts`          |
| SIGINT/SIGTERM and repeated shutdown requests                            | `ShutdownEscalation`                                                                      |
| `restartAllComponents()` / `restartComponent()`                          | `RestartOperations`                                                                       |
| `attachSignals()`, `detachSignals()`, `trigger*()`, auto attach/detach   | `SignalIntegration`; per-component broadcasts in `component-inspection.ts`                |
| `logger.exit()` and `enableLoggerExitHook()`                             | `LoggerExitHook`                                                                          |
| Messages, broadcasts, `getValue()`                                       | `MessagingOperations` (safety nets); delivery in `component-messaging.ts`                 |
| Health checks                                                            | `component-inspection.ts`, called by the facade over the access context                   |
| Status getters, `getSystemState()`, `getStatus()`                        | The facade, reading `state` directly                                                      |
| Events                                                                   | `events.ts` emitters, queued by `transition-event-dispatcher.ts`, delivered by the facade |
| Reading options; safety nets and crash results                           | `operation-options.ts`; `operation-policy.ts`                                             |

## Rules and helpers

These modules implement rules, component-facing operations, and narrowly scoped
bookkeeping. They do not own lifecycle claims or orchestrate bulk operations.

| Module                        | Responsibility                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `component-messaging.ts`      | Message delivery, message broadcasts, and synchronous value access.                                                                                                |
| `component-inspection.ts`     | Individual and aggregate health checks, plus reload/info/debug broadcasts.                                                                                         |
| `component-access-context.ts` | The readonly live view and dispatch callbacks used by those operations.                                                                                            |
| `component-dispatch.ts`       | The shared hook entry rule, read-then-recheck, and announce-recheck-invoke-under-deadline steps.                                                                   |
| `bounded-array-copy.ts`       | The bounded by-index copy of caller arrays (dependency lists, broadcast `componentNames`).                                                                         |
| `dependency-policy.ts`        | Bounded dependency reads, stable dependency ordering, and cycle discovery.                                                                                         |
| `operation-policy.ts`         | Lifecycle-specific timeout error provenance, abort-linked failure detection, async failure containment and late-rejection logging, and common result construction. |
| `operation-options.ts`        | Caller options read once, each field in a fixed order, into frozen snapshots of branded types internal code requires.                                              |
| `registration-policy.ts`      | Registration progress reports, placement predicates, and the removed-timeout-hook refusal reason.                                                                  |
| `hook-abort.ts`               | The guarded abort controller each call of a component hook gets, and aborting it contained.                                                                        |

`shutdown-warning.ts` owns warning-hook dispatch, its shared deadline, and warning
notifications. The shutdown pass (`shutdown-pass.ts`) chooses when this phase runs and
retains shutdown ownership.

`component-metadata-reader.ts` owns guarded metadata reads and the report-once marks
described below. Its naming callback stays live; it does not own registration state.

The manager's own data is split by lifetime:

| Module              | Responsibility                                                                                                   |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `manager-state.ts`  | `LifecycleManagerState`: every field the manager changes after construction, and its record types.               |
| `manager-config.ts` | `resolveManagerConfig()`: the constructor options, validated once in a fixed order, as a frozen `ManagerConfig`. |

The state holds plain public fields that the facade and subsystems read and write in
place (`core.state.x`), so every read stays live; it has no methods and owns no rules.
Configuration that never changes after construction lives in the config instead.

The stateful helpers have deliberately smaller scopes:

| Module                           | Responsibility                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `transition-event-dispatcher.ts` | Synchronous transition depth, notification FIFO, and control-event checkpoints. |
| `registration-read-tracker.ts`   | Registration generations, read stamps, and bounded live-registry reads.         |
| `stop-phase-observer.ts`         | Transfer of rejection-reporting ownership within one stop phase.                |

## Boundaries to preserve

- The threat model is the one in the package
  [README](../../../../README.md#security-and-threat-model): defend against hostile
  caller-supplied values (components, options, returned promises, loggers, listeners),
  and read built-ins live. Do not add defenses against tampered built-ins.
- The access context is created once, but its state getters stay live. Registry
  publication replaces arrays, and hook/event/log callbacks can change availability
  during an operation. Do not replace the getters with construction-time snapshots.
- Context callbacks forward to manager and subsystem methods at invocation time. The manager keeps
  its public safety nets and internal dispatch boundaries; extracting an operation
  must not bypass those checks or freeze an overridable method.
- Hook receivers, property-read order, notifications, and failure channels are part
  of the behavior. Keep these in their existing order when moving code. In particular,
  every hook dispatch rechecks availability after reading its hook. The asynchronous
  ones - message, health check, signal - recheck again after their started event,
  following its listeners even when it is only queued; `component-dispatch.ts` holds
  both steps so they cannot drift apart. `getValueInternal()` is synchronous and cannot
  wait for listeners: it emits `value-requested` before reading its hook, so the
  post-read recheck is its last one, and a listener of a queued `value-requested` runs
  only after the call has returned.
- Availability includes a late start's cleanup, which marks its component running only
  to stop it. The manager exposes it through the `isLateStartCleanupPending`
  accessor.
- Whether a hook may be entered at all is one rule in `component-dispatch.ts`:
  `isHookEntryBlocked()` (a start, stop, pending raw start or late-start cleanup owns
  the component) and `isComponentEnterable()` (running and not blocked).
  `isComponentRunningMember()` is the running half alone, for a caller that already
  holds its `isHookEntryBlocked()` answer and must not evaluate it twice. Messaging,
  value access, health checks, signals and shutdown warnings all apply it; each keeps
  its own refusal codes, and a site that deliberately differs (broadcast selection,
  warnings to retried stalls) says why where it does. Messages, value reads and health
  checks label a refusal with the one `unavailableComponentCode()`.
- Dependency ordering snapshots names before acquiring dependency lists. The manager
  supplies candidate and generation-aware reads; the graph helper does not own a
  second dependency cache or registration registry.
- Timeout provenance has one WeakSet in `operation-policy.ts`. Constructor validation
  deliberately uses the unbranded shared timer helpers; a caller's validation error
  must not become an expected manager refusal just because it has the same type.
  `settleOperation()` drops the brand from the errors a public result hands back, so a
  caller that rethrows one is not taken for the manager's own refusal; a refusal
  answered inline and handed to a logger or listener before the operation settles is
  classified with `takeSettledFailureCode()`, which drops it there.
- Promise-returning manager delegates return the helper promise directly. Adding an
  extra async wrapper or scheduled task can change when callers regain control.
- These modules must remain usable in Node, Bun, and browsers. Do not import Node
  runtime modules or the manager implementation into them. The core names the
  manager's type (`import type`) for `core.manager`, and nothing more; the Node-only
  `ProcessSignalManager` is constructed through `core.createProcessSignalManager`,
  which the facade supplies.

The focused tests here exercise module contracts directly. The original manager
suites remain the integration tests for ownership, re-entry, and operation timing.

Event dispatch owns its transition depth and FIFO, while the manager decides where
transitions begin and delivers events through its existing emitter boundary. Control
events remain synchronous; extracting the queue adds no scheduling.

Registry reads own registration generations and read stamps, not the registry itself.
Their source stays live, provisional registration advances the generation before hooks
run, and rollback restores the previous generation without rewinding the counter.

Stop-phase reporting owns only the choice of foreground or late rejection reporter.
Claims stay in `ComponentClaims`, and stop tokens and late-resolution state
reconciliation in `ComponentStop`.

Component metadata reads own the report-once marks for dependency and optional-status
failures. Registration snapshots those marks and rollback clears only newly made marks;
unregister clears them for the next registration. There is no second dependency cache.
