# LifecycleManager internals

`LifecycleManager` owns the registry, operation claims, state transitions, startup and
shutdown orchestration, and late-work reconciliation. These modules implement rules,
component-facing operations, and narrowly scoped bookkeeping owners. They do not own
lifecycle claims or orchestrate bulk operations. They are internal implementation
details, not exports of the package's lifecycle-manager entry.

| Module                        | Responsibility                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `component-messaging.ts`      | Message delivery, message broadcasts, and synchronous value access.                                     |
| `component-inspection.ts`     | Individual and aggregate health checks, plus reload/info/debug broadcasts.                              |
| `component-access-context.ts` | The readonly live view and dispatch callbacks used by those operations.                                 |
| `component-dispatch.ts`       | The shared hook read-then-recheck and announce-recheck-invoke-under-deadline steps of those operations. |
| `bounded-array-copy.ts`       | The bounded by-index copy of caller arrays (dependency lists, broadcast `componentNames`).              |
| `dependency-policy.ts`        | Bounded dependency reads, stable dependency ordering, and cycle discovery.                              |
| `operation-policy.ts`         | Lifecycle-specific timeout error provenance, async failure containment, and common result construction. |
| `registration-policy.ts`      | Registration progress reports and placement predicates.                                                 |

`shutdown-warning.ts` owns warning-hook dispatch, its shared deadline, and warning
notifications. The manager chooses when this phase runs and retains shutdown ownership.

`component-metadata-reader.ts` owns guarded metadata reads and the report-once marks
described below. Its naming callback stays live; it does not own registration state.

The stateful helpers have deliberately smaller scopes:

| Module                           | Responsibility                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------- |
| `transition-event-dispatcher.ts` | Synchronous transition depth, notification FIFO, and control-event checkpoints. |
| `registration-read-tracker.ts`   | Registration generations, read stamps, and bounded live-registry reads.         |
| `stop-phase-observer.ts`         | Transfer of rejection-reporting ownership within one stop phase.                |

## Boundaries to preserve

- The access context is created once, but its state getters stay live. Registry
  publication replaces arrays, and hook/event/log callbacks can change availability
  during an operation. Do not replace the getters with construction-time snapshots.
- Context callbacks forward to manager methods at invocation time. The manager keeps
  its public safety nets and internal dispatch boundaries; extracting an operation
  must not bypass those checks or freeze an overridable method.
- Hook receivers, property-read order, notifications, and failure channels are part
  of the behavior. Keep these in their existing order when moving code. In particular,
  every hook dispatch rechecks availability after reading its hook and again after its
  started event; `component-dispatch.ts` holds both steps so they cannot drift apart.
- Availability includes a late start's cleanup, which marks its component running only
  to stop it. The manager exposes it through the `isLateStartCleanupPending`
  accessor.
- Dependency ordering snapshots names before acquiring dependency lists. The manager
  supplies candidate and generation-aware reads; the graph helper does not own a
  second dependency cache or registration registry.
- Timeout provenance has one WeakSet in `operation-policy.ts`. Constructor validation
  deliberately uses the unbranded shared timer helpers; a caller's validation error
  must not become an expected manager refusal just because it has the same type.
- Promise-returning manager delegates return the helper promise directly. Adding an
  extra async wrapper or scheduled task can change when callers regain control.
- These modules must remain usable in Node, Bun, and browsers. Do not import Node
  runtime modules or the manager implementation into them.

The focused tests here exercise module contracts directly. The original manager
suites remain the integration tests for ownership, re-entry, and operation timing.

Event dispatch owns its transition depth and FIFO, while the manager decides where
transitions begin and delivers events through its existing emitter boundary. Control
events remain synchronous; extracting the queue adds no scheduling.

Registry reads own registration generations and read stamps, not the registry itself.
Their source stays live, provisional registration advances the generation before hooks
run, and rollback restores the previous generation without rewinding the counter.

Stop-phase reporting owns only the choice of foreground or late rejection reporter.
Claims, stop tokens, and late-resolution state reconciliation stay in the manager.

Component metadata reads own the report-once marks for dependency and optional-status
failures. Registration snapshots those marks and rollback clears only newly made marks;
unregister clears them for the next registration. There is no second dependency cache.
