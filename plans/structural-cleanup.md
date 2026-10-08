# Structural cleanup plan

Baseline: `feat-lifecycle-hardening` at `f564fbb`. Each stage is its own commit (or series of
commits) with `bun test`, `bun run type-check`, `npx eslint .` and prettier green. 0.2.0 is
unreleased, so documented behavior may change when the changelog says so.

Order: **E → A1 → A2 → B → D (D0–D9) → C (optional, narrow)**.

Status: E, A1, A2, B and D (D0–D9, plus a registration phase split) are done; review findings
fixed in `08a7bf7`. C is deferred. Possible follow-ups: split unregistration out of
`registration-operations.ts`, and per-call records for `component-stop.ts`,
`component-start.ts` and `startup-orchestration.ts`.

## E. Logger `exit-completed`; starts refused while a simulated exit finishes

- `logger/types.ts`: add `'exit-completed': { eventType; code: number; endedProcess: boolean }`.
- `logger/index.ts` `finishExit`: emit once per exit after `_isFinishingExit = false` (also on
  close failure). For a real exit, emit right before `process.exit()` with `endedProcess: true`.
  Add a public `isFinishingExit` getter (true from `exit-process` to `exit-completed`).
- LifecycleManager: `isLoggerExitInProgress()` = `isProcessExitCommitted`, or a guarded read of
  `rootLogger.isFinishingExit`, plus a flag covering proceed → `exit-process`. Use it at the two
  start refusal sites (`refuseActiveBulkStartup`, `checkStartPreconditions`).
- Docs: logger "Exit Event Phases" third bullet; lifecycle-manager simulated-exit sentence.
- Tests: logger event tests; `logger-exit-commit.test.ts` slow-sink refusal; audit tests that
  start right after a simulated exit.
- Size: ~+60 source, ~+150 test. Risk: low.

## A. Narrow the threat model

Keep defenses against hostile **caller-supplied** values: component instances and getters,
option objects, hook promises/thenables (own `then`/`constructor`), Proxies, loggers, sinks,
adapters, interceptors, listeners, prototype-polluted caller data. Drop defenses against
**built-ins tampered with after import**. Document: "Tampering with built-ins after import is
unsupported."

### A1 (mechanical, ~−600–750 source, ~−2,000 test lines)

- `internal/intrinsics.ts`: `applyIntrinsic` → `Reflect.apply`, `getIntrinsic` → `Reflect.get`,
  `promiseConstructorIntrinsic` → native Promise (see decision 1), remove the captured
  prototype/descriptor helpers, `createOwnedAbortController`, `ordinaryInstanceOf`,
  `pinPromiseConstructor`, `snapshotSet`. Keep `safePromiseSpeciesConstructor` and the
  `containDerivedRejection` shadowing (decision 4). Keep `observePromise` (live `then`), `observeRejection`, boxes, combinators
  (plain assignment), and a small `queueMicrotaskSafely` for task error routing.
- `adopt-promise.ts`: keep own-`then` bypass, single `then` read, `UnreadableReturn`,
  `containDeferredResult`, `notifyObservationFailure`; drop captured reflection,
  `Symbol.hasInstance` immunity; `isSpeciesRefusal` per decision 3.
- `race-deadline.ts`: plain async function, try/finally clearTimeout.
- `report-to-console.ts`: keep `Symbol.for` cross-bundle state, `console.error` containment,
  re-entry guard; drop captured Set methods and null-proto descriptor.
- `define-entry.ts`: keep `__proto__`-key handling; drop captured `Object.defineProperty`.
- `timer-limits.ts`: live WeakSet methods.
- `guarded-abort-signal.ts`: keep listener wrapping/`handleEvent`/`onabort`/dedupe; drop
  captured EventTarget/WeakMap methods, non-writable definitions, no-EventTarget special case.
- `logger/internal/sink-failure-routing.ts`, `http-client/internal/copy-registrations.ts`
  (→ `slice()`), comments justifying index loops by patched globals.
- Tests deleted: `captured-runtime`, `rejection-observers`, `inherited-then`,
  `http-client/promise-observers`, plus tampering cases in intrinsics, adopt-promise,
  race-deadline, report-to-console, timer-limits, define-entry, guarded-abort-signal,
  hostile-error-handling, start-abort-signal, remaining-items, sink-return, report-to-host,
  file/named-pipe, xhr-adapter.
- Docs: README "Security and threat model"; drop "captured when the library loads" wording in
  lifecycle-manager.md and http-client.md; trim the Unreleased changelog bullets that claim
  global-tampering resistance.

### A2 (optional, ~−200–300 source; changes microtask timing)

Adoption always returns a fresh owned promise; box/observe helpers collapse into `await` and
native combinators.

## B. Read options once at entry (~−100–200, ~+120 lines)

New `lifecycle-manager/internal/operation-options.ts`: one typed snapshot per options type,
each field read once in today's order, throws propagate, frozen branded `XxxSnapshot` types
that internal signatures require. Snapshot after state-only refusals, then one re-entry check.

| Operation                | Change                                                                      |
| ------------------------ | --------------------------------------------------------------------------- |
| `stopAllComponents`      | snapshot before `acceptShutdownPass` instead of inside its transition       |
| `restartAllComponents`   | one snapshot + one refusal instead of four reads/refusals                   |
| `stopComponent`          | `allowStopWithRunningDependents`, `forceImmediate`, `timeout` read at entry |
| `restartComponent`       | one nested snapshot + one check                                             |
| `unregisterComponent`    | `stopIfRunning`/`forceStop` before the first replacement check              |
| `sendMessageToComponent` | `timeout` with the other fields at entry                                    |
| others                   | move into the helper, no behavior change                                    |

Behavior changes: restart runs all its option getters before refusing; `stopComponent`
getters run before the dependents refusal, and a throwing `timeout` getter fails before the
claim. One docs sentence and one changelog bullet.

## D. Split `lifecycle-manager.ts` (12.8k lines → ~2.5–3k facade)

- D0: move mutable fields to `internal/manager-state.ts`; codemod `this.x` → `this.state.x`.
- `internal/manager-core.ts`: `ManagerCore` interface; subsystems are classes over the core;
  public overridable methods are called through `core.manager` at call time.
- Steps (one commit each): D1 logger-exit hook, D2 component stop, D3 component start, D4
  late-start recovery, D5 shutdown pass + escalation, D6 startup orchestration (D6b: split
  `startAllComponentsOperation` into preflight/loop/reconcile/finalize), D7 restart, D8
  registration, D9 signal integration.
- Tests that patch private methods are updated to patch the subsystem.

## C. Defer log-sink delivery (optional; medium–high risk, ~−150–250 lines)

Route guarded-logger calls through the transition dispatcher's FIFO when inside a transition
(synchronous otherwise); flush at the end of the outermost transition in order with events;
control events flush queued logs first. Removable re-check sites: exit-hook
`already_in_progress` wait, `isProceedingForcedExit`, unregister pre-stop checks (after B),
"all already running" post-log snapshot and `didChangeDuringLog`, restart `afterInfoLog`,
`acceptShutdownPass` reset term, `handleShutdownRequest` depth wrapper, repeated-shutdown
state identity check. The auto-start "begun by log" branch stays. ~25–40 tests churn. Do it
after D, site by site, or skip.

## Decisions

Decided: owner accepted the recommended defaults below, except 1 (use the global `Promise`,
no load-time capture at all) and 4 (keep).

1. Native Promise: derive once from `(async () => {})()` (keeps polyfilled-`Promise` own-`then`
   classification correct) vs. the global `Promise`.
2. A2: do it?
3. `isSpeciesRefusal` / `recordSpeciesRefusals`: keep or drop?
4. Recursive-species containment: **keep** (owner decision). A caller's promise subclass can
   still choose its species, so the `containDerivedRejection` constructor shadowing stays,
   reading `Promise` through the load-time native constructor from decision 1.
5. Object.prototype pollution: drop null-proto descriptor tricks, keep own-property reads of
   caller data and `__proto__`-key handling?
6. `safeHandleCallbackAndWait()` null-prototype result records: keep or revert to plain objects?
7. Keep `reportToConsole`'s `console.error` containment and `Symbol.for` state?
8. B restart: batch option reads with one re-entry check (and batch component getters)?
9. B `stopComponent`: getters before dependents refusal; throwing `timeout` before the claim?
10. E: getter vs. subscription; close the proceed → `exit-process` gap; fire for real exits;
    `endedProcess` payload name.
11. C: do it at all; logs queued behind events in a transition; auto-start branch out of scope?
12. D: update tests that poke privates, or keep delegating privates on the facade?
