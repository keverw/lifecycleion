# Plan: timestamps and sequence numbers on LifecycleManager events

Status: not started. Do this after PR #30 has merged, on a new branch from main (for example `feat-event-meta`).

## Goal

Give every `LifecycleManager` event a timestamp and a sequence number. Both are captured when the event is created, not when it is delivered.

## Why

Since PR #30, notifications raised during synchronous state transitions are queued and delivered in FIFO order. Control events (`lifecycle-manager:signals-attached`, `lifecycle-manager:shutdown-initiated`, `signal:shutdown`, `lifecycle-manager:shutdown-escalation-forced`) are delivered synchronously, so they can overtake notifications that are still queued. A listener that stamps events when it receives them therefore records delivery order, not the order in which things happened. Metadata captured at creation lets monitoring rebuild the true order.

## Design

- **Capture point:** capture the metadata in the `LifecycleManagerEvents` callback in `LifecycleManager` (`src/lib/lifecycle-manager/lifecycle-manager.ts`), immediately before `this.eventDispatcher.emit(event, data)`. This runs before the dispatcher selects synchronous delivery or queuing.
- **Delivery:** pass the metadata to listeners as a second argument, `(data, meta)`, with `meta = { timestamp: number; sequence: number }`.
  - Do not add fields to payloads. Some payloads spread in other types, such as `shutdown-completed` spreading `ShutdownResult`, and a new field could collide with them.
  - A second argument is not a breaking change, because existing listeners ignore it.
  - Check how `EventEmitterProtected` and the event-map types in `events.ts` pass arguments, and type the new argument properly.
- **`timestamp`:** `Date.now()`.
- **`sequence`:** a per-manager counter that only ever increases, assigned at creation. It gives an exact creation order, including between events created in the same millisecond.
- **Export and document:** export the meta type. Document in `events.ts` and `docs/lifecycle-manager.md` that `sequence` gives creation order, and that delivery order can differ for control events.

## Tests

- The metadata reaches listeners for both queued and synchronous events.
- `sequence` reflects creation order when a control event overtakes queued notifications. Use a re-entrant listener scenario like the ones in `control-events.test.ts`.
- `timestamp` is taken at creation. A queued event keeps its creation timestamp even when it is delivered later.

## Done when

- `changelog.md` has an entry under Unreleased, and `docs/lifecycle-manager.md` is updated.
- `bun test`, `npx eslint src/lib` and `npx tsc --noEmit` are all clean.
- A reviewer subagent has checked the diff for correctness, and its confirmed findings are fixed.
- This plan file is deleted in the same PR that implements it.
