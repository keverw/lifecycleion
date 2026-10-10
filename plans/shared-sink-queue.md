# Plan: one delivery engine for FileSink and NamedPipeSink

Status: in progress on `feat-lifecycle-hardening` (PR #30). Delete this file once the work lands. Where the "Refinements" section below disagrees with a later section, the refinements win.

## Goal

Both queueing sinks (`src/lib/logger/sinks/file.ts`, `src/lib/logger/sinks/named-pipe.ts`) run on one internal delivery engine, so their queueing, retry, outage, flush and close behavior is identical by construction, and no line is lost while its destination is merely unavailable.

## Policy

- **Lines stay in the queue until they are written.** A write marks a line in flight; it leaves the queue only when its write is confirmed, or when it is finally given up on (retries exhausted, evicted as `queue_full`, abandoned at the close deadline, or a partial pipe write that must never be replayed). A failed write just clears the in-flight mark, so order is kept with no `unshift` or sequence re-insert, and nothing can be counted twice.
- **Outages spend no retries.** While the destination cannot be opened (file/dir setup fails, pipe has no reader), lines are held and the engine reopens on its own timer with backoff. Per-line `maxRetries` is spent only on real write failures.
- **Bounded memory.** `maxQueueSize` counts every line in the queue, in flight or not. When full, the oldest line that is **not** in flight is evicted as `queue_full` (once per overflow episode, as today).
- **Outages are reported once** per distinct failure per episode (the pipe's existing `reportedOpenFailures` rule: cap 8 plus a notice, separate ordinary and diagnostic budgets), not once per line.

## Refinements (from the keep-in-queue design pass)

- **Queue slots.** Each slot is `{ sequence, line, entry, attempts, shouldSuppressFailureReport, state: 'queued' | 'in_flight', committed, token }`. `token` is a fresh object per dispatch; a callback whose token is stale, or whose slot has left the queue, is ignored. `committed` (set by the adapter's `onCommitted()` just before the bytes are handed to the stream) replaces `inFlightEntry`, `activeStreamWriteEntry` and `abandonedInFlightEntry`.
- **Dispatch.** The pump walks from the head and dispatches `queued` slots in order, stopping at `min(maxInFlight, maxQueueSize)`, on backpressure, or when the destination is not usable. Success removes the slot (fast path at the head). A retryable failure with attempts left puts the slot back to `queued` in place; otherwise it is removed and reported `'lost'`. `'unavailable'` puts it back to `queued` with attempts unchanged.
- **No retry-room refusal.** A retrying slot never gave up its place, so `hasRetryRoom`, the post-`onError` room re-check and `requeue()` go away. Overflow is handled only by eviction.
- **Eviction** takes the oldest `queued` slot, never an in-flight one (it may already be written). `evictQueuedEntries` gains a predicate. An evicted slot that was already reported `'retrying'` to an explicit `onError` also gets its own `'queue_full'`/`'lost'` report carrying its entry, so every `'retrying'` gets a final word; owners and console keep the once-per-episode report.
- **Generation barrier.** Each connection gets a generation number. Dispatch on a new connection waits until slots still in flight on an older connection have settled, so a late failure from an old stream cannot be overtaken by newer lines. Bounded by `ORPHAN_SETTLE_MS` = 1000; after that an orphaned slot counts as a spent attempt and its late callback is ignored. This can duplicate a line but never loses one: delivery across reconnects is at-least-once (document it).
- **Close, evidence-based.** At the deadline, `queued` slots and uncommitted in-flight slots are abandoned as `'close'`/`'lost'` (once, with a sample). Committed slots are left to `adapter.end(remaining, ref'd, ≥ MIN_CLOSE_FLUSH_MS)`, then the engine waits one macrotask (`setImmediate`) for the callbacks destroy triggers: successes count as written; failures are counted `'close'` with one `'close'`/`'lost'` report (including the pipe's leftover bytes); slots still unsettled get one `'close'`/`'no_entry'` ("N writes in flight; delivery unknown"), uncounted, released, late callbacks ignored. This replaces the `inFlightAtAbandon` adapter flag, `closeAbandonedStreams` and `didReportPostCloseLoss`.
- **Late callbacks after close resolved are ignored**; the report sent before close resolved is their only word.
- **Partial pipe write**: the slot is removed at once, counted `'write'`, reported `'write'`/`'lost'` with `bytesWritten`; never replayed.
- **`flush-window.ts`**: the `pendingFlush` chain and baselines move out of FileSink into a shared module (done in step A, since step 0 was already under way).
- **Backoff cap stays 5 s** (not 30 s): a shorter cap recovers faster after an outage, which means fewer held lines lost to `queue_full`, at the cost of one open attempt every 5 s during a long outage.
- **From step 0.** `Backoff` (`reopen-backoff.ts`) has `next()`, `peek()`, `reset()`, `isAtRest`; `next()` starts at `initialMS`, so the engine attempts immediately on a new episode and only then uses `next()` (no zero-start mode). `peek()` and `lastReopenAttempt` go away once the engine timer owns reopening. `OutageReporter` (`outage-reporter.ts`) receives only `isDiagnostic`; console suppression (`shouldSuppressFailureReport` → `lastError` only, no budget spent) is checked by the caller before reporting. There is one reopen timer: when it fires, routing (diagnostic/suppressed) comes from the queue's contents (the pipe's existing "ordinary work queued" rule), not from flags remembered per request. Keep `reportedOpenFailures`/`reportOpenFailure` on NamedPipeSink as thin delegates so `owned-failure-routing.test.ts` keeps working.
- **Test seams.** Expose a narrow `engine` member on each sink plus a test-only backoff override, so tests are not slowed by real backoff waits.
- **Steps A and B stay invisible**: the slot/dispatch structure lands with each port, but any refinement here that would change an existing test assertion (in-flight slots in `queueSize` and the cap, dropping retry-room refusal, per-entry eviction reports, the evidence-based close rule, ignoring late callbacks) is kept behind today's behavior and switched on in step D, with its docs and changelog.

## Current behavior (summary)

| Concern                 | FileSink                                                                                                                                                                                   | NamedPipeSink                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Destination unavailable | setup inline per line in `processQueue → writeEntry → setupLogFile()`; each failure spends an attempt (`'setup'`), 100 ms apart (`SETUP_RETRY_DELAY_MS`); no timer, recovery needs traffic | `openPipe()` failure → `reportOpenFailure()` (deduped per outage) → `scheduleReopen(REOPEN_COOLDOWN_MS 1000)`; lines held, no attempts spent; ENXIO quiet unless explicit `reconnect()` |
| Write failure           | callback destroys stream; every attempt to `onError`, owner/console only final `'lost'`; second `'lost'` if handler filled the queue or closed                                             | same reporting; partial writes (`consumePartialWriteFailure`) are `'lost'` with no retry; `requeue()` binary-inserts by `sequence`                                                      |
| In flight               | one write (`inFlightEntry`, `activeStreamWriteEntry`, `abandonedInFlightEntry`)                                                                                                            | many (backpressure-limited)                                                                                                                                                             |
| flush()                 | chained windows (`flushWindow`/`settleFlush`)                                                                                                                                              | none                                                                                                                                                                                    |
| close()                 | drain retrying setup inline; abandonment rules; `endCurrentStream`                                                                                                                         | grace reopen (`CLOSE_REOPEN_GRACE_MS` 500, poll 50 ms), drain, abandon, `endStreamWithin`                                                                                               |
| Rotation                | `rotateIfNeeded`/`rotateFile`, own backoff 1 s → 30 s                                                                                                                                      | n/a                                                                                                                                                                                     |

## Engine

New modules in `src/lib/logger/sinks/internal/`:

- `delivery-engine.ts`: `DeliveryEngine`, `DestinationAdapter`, `DeliveryItem`, `OpenResult`, `WriteOutcome`, `QueueingSinkHealth`.
- `reopen-backoff.ts`: `Backoff` (`initialMS`, `maxMS`, factor 2, `next()`, `reset()`). Rotation uses it too.
- `outage-reporter.ts`: the generalized `reportedOpenFailures` logic.
- `non-blocking-pipe-stream.ts`: the existing class, moved unchanged.
- `file-destination.ts`, `pipe-destination.ts`: the adapters (setup/rotation/size accounting; stat/probe/FIFO check/partial writes).

```ts
interface DeliveryItem {
  sequence: number;
  line: string;
  entry: LogEntry;
  attempts: number;
  shouldSuppressFailureReport: boolean;
}
type OpenFailure = { kind: SinkFailureKind; error: Error };
type OpenResult =
  | { status: 'open' }
  | {
      status: 'unavailable';
      failure?: OpenFailure; /* undefined = quiet, e.g. no reader */
    };
type WriteOutcome =
  | { status: 'written' }
  | { status: 'failed'; error: unknown; isRetryable: boolean } // partial pipe writes: isRetryable false
  | { status: 'unavailable'; failure?: OpenFailure }; // not attempted: destination gone before handoff
interface DestinationAdapter {
  readonly label: 'FileSink' | 'NamedPipeSink';
  readonly maxInFlight: number; // File 1, Pipe Infinity (backpressure-limited)
  readonly inFlightAtAbandon: 'unknown' | 'lost'; // File 'unknown' (fs write cannot be cancelled), Pipe 'lost'
  target(): string;
  open(ctx: { isExplicit: boolean; isClosing: boolean }): Promise<OpenResult>;
  isUsable(): boolean;
  write(
    item: DeliveryItem,
    ctx: { isClosing: boolean },
    done: (o: WriteOutcome) => void,
    onCommitted: () => void,
  ): { canContinue: boolean };
  onDrain(resume: () => void): void;
  bufferedBytes(): number;
  release(): void;
  end(timeoutMS: number, opts: EndStreamOptions): Promise<number>; // endStreamWithin
}
```

The engine owns the queue and in-flight marks, sequence numbers, `LossLedger`, `hasRetryRoom`, `maxRetries`, the state machine, `Backoff`, the reopen timer, `OutageReporter`, write-failure reporting rules (every attempt to `onError`; owner/console only final `'lost'`; forwarded-console suppression; recheck after each report), `consecutiveFailures`, `lastError`, flush, close, `reopenNow({ explicit })` and base `getHealth()`. Every report goes through a `report(failure, routing)` callback the sink passes in (it calls `reportSinkError(this, …)`), so owner routing and weak refs stay with the sink.

Each sink keeps option parsing, level filter, rendering/format guards and `FormatReportScheduler` (format failures never enter the engine; the sink calls `engine.countLoss('format')`), the public API, pipe `reconnect()` (delegates after its buffered-bytes guard), FileSink rotation inside its adapter's `write()` (no rotation while closing; a failed reopen after rotation returns `'unavailable'`), and the stream-error/write-callback pairing (`suppressedWriteErrors`); unpaired errors go to `engine.streamFailed(error, routing)`.

**Engine rule:** update state before every report and re-check state after it returns. Hostile `onError` handlers may call `write`/`close`/`flush`/`reconnect` from inside a report.

## State machine

`opening` → `connected` | `cooling_down` → `opening` …; `closing` → `closed`.

Invariant: while not connected and not closing, either an open is in flight or exactly one unref'd timer is armed. `write()` never starts an attempt itself.

- Construction → `opening` (flag set synchronously).
- Open succeeds → `connected`; `OutageReporter.clear()`; pump.
- Open `unavailable` → `cooling_down`; report via `OutageReporter` unless quiet; arm timer for `backoff.next()`.
- Timer fires → `opening`.
- Write `written` → remove from queue; `consecutiveFailures = 0` (current stream only); `backoff.reset()`.
- Write `failed` → `attempts++`; report `'write'` `'retrying'`/`'lost'`; keep in queue (clear in-flight mark) if `attempts ≤ maxRetries`, retryable, not closed; otherwise remove and count `'write'`. If `adapter.isUsable()`, keep pumping; otherwise `release()` and leave connected with `backoff.next()`.
- Write `unavailable` → clear in-flight mark, `attempts` unchanged; leave connected.
- Unpaired stream error → `'write'`/`'no_entry'`; `consecutiveFailures++` if current stream; leave connected.
- Backpressure → pause until `onDrain`.

## Values and rules

- Open backoff, both sinks: 0, then 1 s doubling to a 5 s cap (`OPEN_RETRY_INITIAL_MS` 1000, `OPEN_RETRY_MAX_MS` 5000). Reset on a successful write or explicit `reconnect()`, not on a successful open. Rotation keeps 1 s → 30 s on the same `Backoff`. `SETUP_RETRY_DELAY_MS` and `REOPEN_COOLDOWN_MS` go away. Timers unref'd.
- `reconnect()` (pipe only for now): refused while closing or with buffered bytes; waits for an in-progress open; `release()`, clear outage dedup, reset backoff, open with `isExplicit: true`; success resets `consecutiveFailures`.
- `close()`: cancel timer; refuse new writes; wait for an in-progress open (bounded); drain while connected; while not connected, grace reopen ignoring backoff (poll 50 ms, at most 500 ms of unavailability per close, inside `closeTimeoutMS`). At the deadline or once drained → `closed`: abandon the queue (`'close'`/`'lost'` once); in-flight lines follow `inFlightAtAbandon` (File: one `'close'`/`'no_entry'`, uncounted; Pipe: each counted `'close'` as its callback fails); then `end(remaining, { shouldUnref: false })`, never less than `MIN_CLOSE_FLUSH_MS`.
- `flush()` (both sinks): chained windows as today. Resolves when (a) the queue is empty, (b) not connected and an open attempt started after the flush began has failed, or the next attempt is after the deadline (`timedOut: false, success: false`), or (c) the deadline passes (`timedOut: true`). Never skips the backoff. New `FlushResult.entriesQueued`.
- Health (`QueueingSinkHealth`, both): `isHealthy = consecutiveFailures === 0 && connected && !closing`; `isInitialized` = connected; `isReconnecting`; `queueSize` = all lines in the queue (in flight included); `consecutiveFailures` = write failures only; `droppedEntries`; `droppedByKind = { queue_full, write, format, close }`; `lastError`.

Reporting:

| Event                                              | kind                                                                      | disposition       | entry  | Frequency                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------- | ----------------- | ------ | ------------------------------------------------------------- |
| Open failure                                       | adapter kind (`setup`, `not_found`, `not_a_pipe`, `unsupported_platform`) | `no_entry`        | none   | once per distinct (kind, message) per episode; cap 8 + notice |
| No reader (pipe)                                   | —                                                                         | —                 | —      | quiet unless explicit                                         |
| Explicit reconnect fails                           | adapter kind                                                              | `no_entry`        | none   | every time                                                    |
| Write attempt fails                                | `write`                                                                   | `retrying`/`lost` | yes    | `onError` every attempt; owner/console final `lost` only      |
| Partial pipe write                                 | `write`                                                                   | `lost`            | yes    | each                                                          |
| Unpaired stream error                              | `write`                                                                   | `no_entry`        | none   | each                                                          |
| Overflow                                           | `queue_full`                                                              | `lost`            | sample | once per overflow episode                                     |
| Write after close / abandon / in-flight known lost | `close`                                                                   | `lost`            | sample | once each                                                     |
| In-flight unknown / bytes unknown (File)           | `close`                                                                   | `no_entry`        | none   | once                                                          |
| Rotation failure (File)                            | `setup`                                                                   | `no_entry`        | none   | first of each backoff run                                     |
| Rotation flush loss (File)                         | `write`                                                                   | `no_entry`        | none   | each                                                          |

## Decisions (made)

1. Backoff 0 → 1 s → 5 s cap for opens, both sinks; rotation stays 1 s → 30 s.
2. Backoff resets on a successful write or explicit reconnect, not on a successful open.
3. `flush()` waits for the next attempt only if it falls before its deadline; adds `entriesQueued`.
4. NamedPipeSink gets `flush()`.
5. No FileSink `reconnect()` for now.
6. Remove `droppedByKind.setup` in 0.2.0 (never released).
7. Pipe "no reader" stays silent on automatic probes.
8. FileSink gets the same 500 ms close grace.
9. In-flight certainty at close stays an adapter flag. Verify Bun `fs.WriteStream` destroy behavior during a write.
10. Exiting without `close()` loses held lines (unref'd timers): accepted, documented.
11. An open hung on a stalled mount stays `opening`; flush/close stay bounded: accepted, documented.
12. FileSink `open()` awaits the `'open'` event (removes pending-open classification); test on Bun.
13. `maxQueueSize` and `queueSize` include in-flight lines; eviction skips in-flight lines.
14. Keep a few delegating private names during the port so test seams survive; move tests to engine/adapter seams afterwards.
15. Re-entrancy rule above is enforced and covered in `delivery-engine.test.ts`.

## Steps

Each step keeps the full suite green, updates docs (`docs/logger.md`, current behavior only) and the `changelog.md` Unreleased section where behavior changes, and is its own commit. Never-released changelog entries this replaces (the 100 ms setup wait, setup counting, `droppedByKind.setup`) are rewritten, not appended to.

- **0. Pure extraction.** `NonBlockingPipeStream` to its own file; `OutageReporter` from `reportOpenFailure`; `Backoff` (rotation uses it; pipe flat at 1 s). Unit tests for each. No behavior change.
- **A. Engine + NamedPipeSink port, no behavior change.** Engine configured flat 1 s with existing close grace. Keep-in-queue model from day one (it must reproduce today's order and reporting). `delivery-engine.test.ts` with a deterministic fake adapter: order, retries, eviction (skips in-flight), invariant, close/flush, hostile handlers. Pipe tests change seams only; no assertion values change.
- **B. FileSink port, today's semantics.** Temporary engine hook: adapter always usable, setup inline in `write()`, `'setup'` failures retried with the 100 ms delay. Keep a private `FileSink.writeEntry` as the adapter's write so spies keep working. Seam-only test changes.
- **C. FileSink holds lines during outages.** Real adapter `open()` awaiting `'open'`/`'error'`; delete `initialize`, `waitBeforeSetupRetry`/`setupRetryWait`, `pendingOpenFailure`/`takeOpenFailure`, `didNeverOpen`, `SETUP_RETRY_DELAY_MS` and the step-B hook. Intentional assertion changes in `file.test.ts` (setup-retry describe block, setup-loss tests, lazy-setup init timing), `review-contracts.test.ts`, `owned-failure-routing.test.ts`.
- **D. Shared knobs.** Backoff 0/1/2/4/5 s for both; pipe `flush()`; `FlushResult.entriesQueued`; `isReconnecting` on FileSink; remove `setup` from `DroppedEntryKind`. Update cooldown-dependent pipe tests, `sink-failure.test.ts`, `loss-ledger.test.ts`, health/flush shapes.

## User-visible changes (for docs/changelog)

FileSink: lines held during setup outages (no per-line setup losses; lost only to `queue_full` or the close deadline); setup retried on its own timer (recovers without traffic); outage reported once per distinct failure; reopen after a real write failure follows the backoff; `flush()` during an outage returns after the next attempt with lines still queued; `close()` during an outage tries for at most 500 ms; health gains `isReconnecting`; `FlushResult` gains `entriesQueued`.

NamedPipeSink: reopen backoff 0/1/2/4/5 s instead of flat 1 s; new `flush()`; writes no longer trigger a reopen attempt (the timer does).
