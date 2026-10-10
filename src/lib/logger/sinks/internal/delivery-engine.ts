import type { LogEntry } from '../../types';
import { isDiagnosticEntry } from '../../internal/sink-failure-routing';
import {
  isConsoleReportActive,
  reportToConsole,
} from '../../../internal/report-to-console';
import { raceDeadline } from '../../../internal/race-deadline';
import { sleep } from '../../../sleep';
import { describeError, toError } from '../../../to-error';
import { deferClose } from './deferred-close';
import { FlushWindows, type FlushWindowResult } from './flush-window';
import { LossLedger } from './loss-ledger';
import { OutageReporter } from './outage-reporter';
import { Backoff, type BackoffOptions } from './reopen-backoff';
import type {
  DroppedEntryCounts,
  DroppedEntryKind,
  SinkFailure,
  SinkFailureDisposition,
  SinkFailureKind,
} from './sink-failure';

/**
 * How long `close()` keeps asking for its destination before giving up on its backlog.
 *
 * A FIFO's consumer is frequently restarted with the process writing to it, so at shutdown
 * the probe's `ENXIO` often means "the reader is coming back in a moment", not "nothing is
 * listening". A window this size covers that restart and nothing longer: a destination
 * that is genuinely gone must not hold a shutdown, which is why this is a fraction of
 * `closeTimeoutMS` rather than a share of it.
 */
export const CLOSE_REOPEN_GRACE_MS = 500;

/** How often {@link CLOSE_REOPEN_GRACE_MS} re-asks. Each attempt is one open. */
export const CLOSE_REOPEN_POLL_MS = 50;

/** How often `close()` drives the queue while it drains. */
const CLOSE_DRAIN_POLL_MS = 10;

/** How often `flush()` looks at the queue while it waits. */
const FLUSH_POLL_MS = 10;

/**
 * How long dispatch on a new connection waits for writes still in flight on an older one.
 *
 * A write that failed on a connection the engine has since replaced comes back to the
 * queue *ahead* of everything written after it, so newer lines are held until the old
 * writes have settled - otherwise a late failure is overtaken and the log reorders around
 * every reconnect. Bounded, because a destination that was torn down may never answer for
 * what it held: past this the barrier lifts and the line may be written twice. Delivery
 * across a reconnect is at-least-once; it is never lost to the barrier.
 */
export const ORPHAN_SETTLE_MS = 1000;

/**
 * One line the engine is delivering: the rendered line, the entry it came from, and how
 * many writes it has been through.
 *
 * Rendering happens before the line reaches the engine, so nothing on the delivery path
 * reads the entry again. It is kept for `onError`: a failure tied to a line hands the
 * caller the `LogEntry`, so a handler that falls back on `disposition: 'lost'` can re-emit
 * the line rather than only learn that one was lost.
 */
export interface DeliveryItem {
  /** Original write order, retained across retries. */
  sequence: number;
  line: string;
  entry: LogEntry;
  /**
   * Writes already attempted for this line. What makes a failed write recoverable rather
   * than terminal: the line keeps its place and is tried again, up to `maxRetries`.
   */
  attempts: number;
  /** Retained through retries so a forwarded terminal report cannot report itself. */
  shouldSuppressFailureReport: boolean;
}

/**
 * A line's place in the queue.
 *
 * Lines stay in the queue until their write is confirmed or they are finally given up on.
 * A dispatched line is marked `in_flight` where it stands rather than taken out, so a
 * failed write only clears the mark: order is kept with no re-insert, and nothing can be
 * counted twice.
 */
export interface DeliverySlot extends DeliveryItem {
  state: 'queued' | 'in_flight';
  /**
   * Whether the adapter has handed the line to its destination. Set by the adapter's
   * `onCommitted()` just before the bytes go to the stream, and what tells a line that may
   * have been written from one that cannot have been.
   */
  committed: boolean;
  /**
   * A fresh object per dispatch. An outcome whose token is not the slot's current one -
   * already settled, or the slot has moved on - is ignored, so a callback can never settle
   * a line twice.
   */
  token?: object;
  /** The connection this dispatch went to. See {@link ORPHAN_SETTLE_MS}. */
  generation?: number;
  /**
   * Whether an explicit `onError` has been told this line is `'retrying'`, so an eviction
   * owes it a final word of its own. See {@link DeliveryCompat.refusesRetryWithoutRoom}.
   */
  hasReportedRetrying?: boolean;
}

/** The line handed to {@link DeliveryEngine.enqueue}. */
export type DeliveryLine = Pick<
  DeliveryItem,
  'line' | 'entry' | 'shouldSuppressFailureReport'
>;

/**
 * What an open attempt found. A failure is reported by the adapter itself, through
 * {@link DeliveryEngine.reportOpenFailure}, so it is said once per outage; an
 * `'unavailable'` with nothing reported is a quiet one, such as a pipe with no reader.
 */
export type OpenResult = { status: 'open' } | { status: 'unavailable' };

/**
 * The origin of a request to open, as the engine remembers it.
 *
 * Only what an attempt cannot read from the queue itself: the failure of a diagnostic line
 * or of a line forwarded from a console report that took the connection away. See
 * {@link DeliveryEngine.openRouting} for how the queue's contents combine with it.
 */
export interface OpenRequest {
  isDiagnosticRetry?: boolean;
  shouldSuppressRetryReport?: boolean;
}

/** What an adapter's `open()` is told about the attempt. */
export interface OpenContext {
  /** The caller asked for this attempt by name (`reconnect()`), and is owed its answer. */
  isExplicit: boolean;
  isClosing: boolean;
  isDiagnosticRetry: boolean;
  shouldSuppressRetryReport: boolean;
}

/** How an open failure is routed: see {@link DeliveryEngine.openRouting}. */
export interface OpenRouting {
  isDiagnostic: boolean;
  shouldSuppressFailureReport: boolean;
}

/** What became of one write. */
export type WriteOutcome =
  | { status: 'written' }
  /** `isRetryable: false` for a write that may have delivered part of the line. */
  | {
      status: 'failed';
      error: unknown;
      isRetryable: boolean;
      /**
       * What the write failed as, when it was not the write itself: FileSink sets its
       * destination up inside a write, so a write can fail as `'setup'`, or as `'close'`
       * when the sink closed under it. Read only with {@link DeliveryCompat.inlineSetup};
       * omitted means `'write'`.
       */
      kind?: SinkFailureKind;
      /**
       * Called once the line is kept for another attempt, before anything sends it: where
       * FileSink starts the pause it takes before retrying a failed setup. Step B of
       * `plans/shared-sink-queue.md` only; removed with {@link DeliveryCompat.inlineSetup}.
       */
      onRetry?: () => void;
    }
  /** Not attempted: the destination went away before the line was handed to it. */
  | { status: 'unavailable' }
  /**
   * Failed because `close()` gave up on the destination, which has already reported what
   * it held: counted under `'close'` and not reported again. Kept from before the engine;
   * see {@link DeliveryCompat.honorsLateCallbacks}.
   */
  | { status: 'abandoned' };

/**
 * The destination-specific half of a queueing sink: how to open it, write to it and let
 * it go. The engine owns the queue, retries, reopening, reporting, flush and close.
 */
export interface DestinationAdapter {
  /** The sink's class name, for console lines. */
  readonly label: string;
  /** Writes in flight at once, before backpressure. `Infinity` for a stream. */
  readonly maxInFlight: number;
  /** What a failure names as its `target`. */
  target(): string;
  /**
   * One attempt to open. Reports its own failures through
   * {@link DeliveryEngine.reportOpenFailure} and must not reject; a rejection is a bug,
   * reported to the console rather than swallowed.
   */
  open(context: OpenContext): Promise<OpenResult>;
  /** Whether a write handed over now could be attempted. */
  isUsable(): boolean;
  /**
   * Whether the adapter still holds a destination that has not been torn down, usable or
   * not. What `close()` asks before deciding a backlog has nowhere to go.
   */
  hasConnection(): boolean;
  /**
   * Hand one line to the destination. `done` reports its outcome, now or later;
   * `onCommitted` is called just before the bytes leave the adapter. Answers `false` when
   * the destination wants no more until it drains. A throw is a failed attempt.
   */
  write(
    slot: DeliverySlot,
    context: { isClosing: boolean },
    done: (outcome: WriteOutcome) => void,
    onCommitted: () => void,
  ): boolean | void;
  /**
   * Call `resume` once the destination drains. Answers whether it will: `false` when
   * there is nothing to wait on.
   */
  onDrain(resume: () => void): boolean;
  /** Why an explicit reopen must be refused right now, if it must. */
  checkReopen?(): Error | undefined;
  /** Let go of the current destination, bounded and without waiting. */
  release(): void;
  /**
   * End the destination for `close()`, within `timeoutMS` (never less than the final-flush
   * minimum), reporting what it held if it could not flush. Resolves with the bytes left.
   */
  end(timeoutMS: number, context?: EndContext): Promise<number>;
  /**
   * Told the moment `close()` stops draining, before it gives up on anything or reports
   * it, so the adapter's own view of the sink is closed by the time a report reaches a
   * handler.
   */
  onClosed?(): void;
}

/** What {@link DestinationAdapter.end} is told about the close that is ending it. */
export interface EndContext {
  /**
   * Whether `close()` has already reported a write in flight whose delivery is unknown,
   * so the bytes the destination still holds are already named. See
   * {@link DeliveryCompat.drainsInFlight}.
   */
  hasReportedInFlight: boolean;
}

/** Options for {@link DeliveryEngine.report}: the shape the sinks' `handleError` takes. */
export interface DeliveryReportOptions {
  shouldSuppressFailureReport?: boolean;
  isDiagnostic?: boolean;
  /** `false` for a failure that belongs to a connection the sink has already replaced. */
  countsAgainstHealth?: boolean;
  /** What the failure names as its `target`, when not the adapter's current one. */
  target?: string;
  attempt?: number;
  disposition?: SinkFailureDisposition;
  /** The line this failure is about, when the sink still has it. */
  entry?: LogEntry;
  /** Called once the handler has settled, `async` or not. */
  onReported?: () => void;
}

/**
 * Delivers a report the engine owes. The sink owns routing: it calls `reportSinkError`
 * with itself, so owner registration and weak references stay with the sink. Answers
 * whether the report went out.
 */
export type DeliveryReporter = (
  failure: SinkFailure,
  routing: { isDiagnostic: boolean; onSettled?: () => void },
) => boolean;

/** The sink's own wording for the reports the engine makes. */
export interface DeliveryMessages {
  queueFull(limit: number): string;
  /** Lines still queued when `close()` gave up on them. */
  abandoned(count: number): string;
  refusedAfterClose(): string;
  /** A line whose write could not be attempted because the sink had closed. */
  failedAfterClose(): string;
  /** A line given up on after `attempts` writes because the queue could not hold it. */
  notRetained(attempts: number): string;
  /** The notice said once an outage has reported its distinct-failure cap. */
  outageCap(maxReports: number): string;
  /** `reconnect()`'s error when its open did not succeed. */
  reopenFailed(): string;
  /** Lines in flight when `close()` resolved, whose delivery is unknown. */
  inFlightUnknown(count: number): string;
  /** Lines whose writes failed as `close()` ended the destination, and its bytes left. */
  lostAtClose(count: number, bytesLeft: number): string;
}

/**
 * Behavior kept from before the engine, so a sink moves onto it without a change a caller
 * could see.
 *
 * Every switch here is `true` for a sink that has not yet taken the engine's own rules,
 * and each is turned off - its branch deleted - together, with the docs and changelog
 * that go with it (step D of `plans/shared-sink-queue.md`). Omitted means the engine's
 * own rule.
 */
export interface DeliveryCompat {
  /**
   * `queueSize`, the `maxQueueSize` cap and open routing count queued lines only, not ones
   * in flight; in-flight writes are bounded by backpressure alone. Off: every line in the
   * queue counts, and in-flight writes stop at `maxQueueSize`.
   */
  countsQueuedOnly?: boolean;
  /**
   * A failed write with attempts left is given up on (`'lost'`) when the queue has no
   * room for it. Off: a retrying line never gave up its place, so it is only ever lost to
   * eviction - and an evicted line an explicit `onError` was told is `'retrying'` gets a
   * `'queue_full'`/`'lost'` report of its own.
   */
  refusesRetryWithoutRoom?: boolean;
  /**
   * Writes, failed writes and a lost connection each ask to reopen at once, held only to
   * one attempt per backoff interval since the last automatic one; the engine waits for
   * the adapter to report a lost connection rather than letting a failed one go itself.
   * Off: the reopen timer alone drives recovery, and a connection that a failed write left
   * unusable is released at once.
   */
  reopensOnDemand?: boolean;
  /**
   * A line that found its destination gone before it could be handed over spends an
   * attempt. Off: its attempts are unchanged.
   */
  unavailableSpendsAttempt?: boolean;
  /**
   * `close()` leaves writes in flight to their own callbacks: a failure on a destination
   * `close()` gave up on is counted `'close'` and not reported, any other is reported
   * `'write'`/`'lost'` whenever it arrives, and a write orphaned on a replaced connection
   * keeps its callback. Off: close settles in-flight writes on evidence before it
   * resolves, and an orphaned write counts as a spent attempt whose late callback is
   * ignored.
   */
  honorsLateCallbacks?: boolean;
  /**
   * FileSink only, and temporary: removed in step C of `plans/shared-sink-queue.md`, when
   * FileSink's `open()` takes over its setup.
   *
   * The destination is set up inside each write, so a write can fail as something other
   * than a write: a failure is reported and counted under the outcome's `kind` (a line
   * lost after the sink closed under a write failure counts as `'close'`); a line whose
   * retry a handler's own lines or `close()` took away is reported `'lost'` with the same
   * failure, rather than a message of the engine's; the outcome's `onRetry` runs once the
   * line is kept; and a retry during `close()` goes out at once rather than on close's
   * next poll. Off: every write failure is a `'write'`.
   */
  inlineSetup?: boolean;
  /**
   * FileSink only, and temporary: removed in step D, which turns on the evidence-based
   * close for both sinks.
   *
   * A line in flight is still work: `close()` waits for it as it waits for the queue, and
   * an overflow episode ends only once nothing is queued or in flight. At the deadline a
   * line in flight that was never handed over is abandoned with the queue; one that was is
   * reported once as `'close'`/`'no_entry'` - its delivery unknown, so uncounted - and
   * `end()` is told so. Its late success still counts as written; its late failure is
   * ignored. Overrides {@link honorsLateCallbacks} at close.
   */
  drainsInFlight?: boolean;
}

/**
 * Every shared {@link DeliveryCompat} switch on: the behavior queueing sinks had before.
 * The FileSink-only ones are in {@link FILE_SINK_PRE_ENGINE_BEHAVIOR}.
 */
export const PRE_ENGINE_BEHAVIOR: DeliveryCompat = {
  countsQueuedOnly: true,
  refusesRetryWithoutRoom: true,
  reopensOnDemand: true,
  unavailableSpendsAttempt: true,
  honorsLateCallbacks: true,
};

/** {@link PRE_ENGINE_BEHAVIOR} plus FileSink's own: how FileSink behaved before. */
export const FILE_SINK_PRE_ENGINE_BEHAVIOR: Required<DeliveryCompat> = {
  countsQueuedOnly: true,
  refusesRetryWithoutRoom: true,
  reopensOnDemand: true,
  unavailableSpendsAttempt: true,
  honorsLateCallbacks: true,
  inlineSetup: true,
  drainsInFlight: true,
};

export interface DeliveryEngineOptions {
  adapter: DestinationAdapter;
  /** `undefined` for no cap. */
  maxQueueSize: number | undefined;
  maxRetries: number;
  closeTimeoutMS: number;
  /** Spacing of automatic reopen attempts. */
  backoff: BackoffOptions;
  messages: DeliveryMessages;
  /**
   * The error a report the engine composes carries, built from the sink's own message, so
   * a sink with its own error class reports in it. Defaults to `Error`.
   */
  createError?: (message: string) => Error;
  report: DeliveryReporter;
  /** Whether the sink has an explicit `onError`, read at report time. */
  hasHandler: () => boolean;
  compat?: DeliveryCompat;
}

/** What a queueing sink tells you about itself. */
export interface QueueingSinkHealth {
  /** No failed writes since the last successful one, connected, and not closing. */
  isHealthy: boolean;
  /** Lines waiting for the destination. */
  queueSize: number;
  /** Lines this sink did not deliver, whatever the reason. */
  droppedEntries: number;
  /** `droppedEntries` by reason. */
  droppedByKind: DroppedEntryCounts;
  /** Whether the destination is currently open. */
  isInitialized: boolean;
  /** Whether a reopen - manual or automatic - is in flight. */
  isReconnecting: boolean;
  /** The most recent failure of any kind. */
  lastError?: Error;
  /** Failed writes since the last successful one. */
  consecutiveFailures: number;
}

/** {@link DeliveryEngine.flush}'s answer. */
export interface DeliveryFlushResult extends FlushWindowResult {
  /** Lines still in the queue when the flush returned. */
  entriesQueued: number;
}

export type ReopenStatus =
  | { success: true }
  | { success: false; reason: 'already_reconnecting' }
  | { success: false; reason: 'closed' }
  | { success: false; reason: 'error'; error: Error };

/**
 * Where the connection stands.
 *
 * `opening` -> `connected` | `cooling_down` -> `opening` ...; anything -> `closed`. While
 * not connected and not closing, either an open is in flight or exactly one reopen timer
 * is armed. `idle` only until {@link DeliveryEngine.start}.
 */
type ConnectionState =
  'idle' | 'opening' | 'connected' | 'cooling_down' | 'closed';

/**
 * Who asked for an open: the constructor, the reopen policy, the caller by name, or
 * `close()` making a last attempt for its backlog.
 */
type OpenKind = 'initial' | 'automatic' | 'explicit' | 'closing';

/** What close collects while it waits on the writes it ended. */
interface CloseSettlement {
  failed: DeliverySlot[];
}

/**
 * One delivery engine for the queueing sinks: the queue and its in-flight marks, retries,
 * the reopen state machine and its timer, failure reporting, flush and close.
 *
 * **Re-entrancy.** Every report reaches caller code - an `onError`, or an owning logger -
 * that may call `write`, `close`, `flush` or `reconnect` on this same sink before it
 * returns. So state is updated before every report, and re-checked after it returns.
 */
export class DeliveryEngine {
  /**
   * Lines this sink did not deliver, by reason, and the once-per-episode reports for the
   * refused, evicted and abandoned ones. See {@link LossLedger}.
   */
  public readonly losses: LossLedger;
  /**
   * The open failures reported during this outage, so one outage is not reported every
   * second. See {@link OutageReporter} for the rule: once per distinct failure per outage,
   * capped with one notice, with separate ordinary and diagnostic budgets.
   *
   * Every failed open schedules another attempt, which is what makes recovery independent
   * of traffic, and which without this would make a mistyped destination call the caller's
   * `onError` once a second for the life of the process.
   *
   * Cleared when the destination opens, so the next outage speaks up again, and by an
   * explicit reopen, which is an attempt the caller asked for and is owed an answer to.
   */
  public readonly outages: OutageReporter;
  /**
   * The chained flush windows {@link flush} counts in. Public for a sink that runs its own
   * flush body in the same windows, so its counts partition with this one's.
   */
  public readonly flushes: FlushWindows;

  private readonly adapter: DestinationAdapter;
  private readonly options: DeliveryEngineOptions;
  private readonly compat: Required<DeliveryCompat>;
  /** Spaces automatic reopen attempts; see {@link ensureConnection}. */
  private readonly backoff: Backoff;

  /**
   * Every line not yet delivered or given up on, oldest first, each with the line already
   * rendered. Slots in flight keep their place.
   */
  private slots: DeliverySlot[] = [];
  /** Slots in {@link slots} marked `in_flight`. */
  private inFlightCount = 0;
  /**
   * In-flight slots dispatched on a connection older than the current one, which hold
   * dispatch on the current one until they settle. See {@link ORPHAN_SETTLE_MS}.
   */
  private staleInFlight = 0;
  private orphanTimer?: ReturnType<typeof setTimeout>;
  private nextSequence = 0;

  private state: ConnectionState = 'idle';
  /** Set by `close()` before anything else, and never cleared. */
  private closing = false;
  private closePromise?: Promise<void>;
  /** Present while `close()` waits on the writes it ended; see {@link closeOnEvidence}. */
  private closeSettlement?: CloseSettlement;
  /**
   * Whether a reopen - automatic or explicit - is in flight. Separate from `opening`,
   * which also covers the constructor's first attempt and `close()`'s last ones: this is
   * what `getHealth()` reports, and means what it says - a *re*-open.
   */
  private isReconnecting = false;
  /** The most recent open attempt, settled; never rejects. */
  private openPromise: Promise<void> = Promise.resolve(undefined);
  /** Identity of the attempt in flight, so a superseded one cannot settle state. */
  private openAttempt?: object;
  private openAttemptsStarted = 0;
  private lastFailedAttempt = 0;
  /** Bumped by every successful open. */
  private generation = 0;
  /** The connection in hand, or `undefined` when there is none. */
  private connectionGeneration?: number;

  /**
   * Whether a dispatch pass is running. Not re-entered: a write can fail synchronously,
   * and the retry that follows asks for a pass - which, without this, would recurse
   * through the same loop for as many retries as the queue holds. The pass already
   * running picks the line up.
   */
  private isPumping = false;
  /**
   * Whether the destination has told us to stop and wait for it to drain.
   *
   * Ignoring backpressure drains the managed queue into the stream's buffer, which has no
   * cap: with a reader attached but not consuming, 500 entries went there while
   * `maxQueueSize` held none of them and `getHealth()` reported an empty queue and no
   * drops.
   */
  private awaitingDrain = false;
  /**
   * Set when a dispatch found the destination gone before it could hand the line over, so
   * the pass running stops rather than offering the same line again.
   */
  private isPassStopped = false;

  /**
   * A reopen deferred by the backoff, if one is pending. One at a time, and `unref`'d, so
   * a sink waiting to recover never holds the process open and never stacks attempts.
   */
  private reopenTimer?: ReturnType<typeof setTimeout>;
  /** When {@link reopenTimer} is due, so a sooner request can displace a later one. */
  private reopenAtMS?: number;
  /**
   * When the last automatic reopen was attempted. An attempt costs real work - a `stat` and
   * an `open` for a pipe - and an outage is exactly when the log loop is busiest, so
   * attempting one per line would turn a dead destination into a syscall storm.
   */
  private lastReopenAttempt = 0;

  private lastError?: Error;
  private consecutiveFailures = 0;
  private totalWritten = 0;

  constructor(options: DeliveryEngineOptions) {
    this.options = options;
    this.adapter = options.adapter;
    this.compat = {
      countsQueuedOnly: false,
      refusesRetryWithoutRoom: false,
      reopensOnDemand: false,
      unavailableSpendsAttempt: false,
      honorsLateCallbacks: false,
      inlineSetup: false,
      drainsInFlight: false,
      ...options.compat,
    };
    this.backoff = new Backoff(options.backoff);
    this.losses = new LossLedger((kind, message, entry) =>
      this.report(kind, this.createError(message), {
        disposition: 'lost',
        entry,
      }),
    );
    this.outages = new OutageReporter({
      report: (kind, error, isDiagnostic) => {
        this.report(kind, error, { isDiagnostic });
      },
      describeCap: (maxReports) => options.messages.outageCap(maxReports),
    });
    this.flushes = new FlushWindows(() => ({
      written: this.totalWritten,
      dropped: this.losses.droppedEntries,
    }));
  }

  /** The most recent open attempt, settled. Never rejects. */
  public get openSettled(): Promise<void> {
    return this.openPromise;
  }

  /** Whether `close()` has begun. A closing engine refuses new lines. */
  public get isClosing(): boolean {
    return this.closing || this.closed;
  }

  /** Whether `close()` has finished with the queue. */
  public get isClosed(): boolean {
    return this.closed;
  }

  private get closed(): boolean {
    return this.state === 'closed';
  }

  /** Whether nothing is queued or in flight, and no dispatch pass is running. */
  public get isDrained(): boolean {
    return this.slots.length === 0 && !this.isPumping;
  }

  /**
   * Lines waiting for the destination. See {@link DeliveryCompat.countsQueuedOnly} for
   * whether lines in flight count.
   */
  public get queueSize(): number {
    return this.compat.countsQueuedOnly
      ? this.slots.length - this.inFlightCount
      : this.slots.length;
  }

  /**
   * Make the first open attempt. Called once, by the sink's constructor, after its
   * options are validated: the attempt is marked in flight synchronously, so a `write()`
   * in the same tick cannot start a second one beside it.
   */
  public start(): void {
    void this.startOpen('initial', {});
  }

  /**
   * Queue a rendered line and send what the destination can take.
   *
   * Queued whenever there is nowhere to put it *yet* - before the first open, and after a
   * failure took the destination away - and held rather than dropped: `maxQueueSize`
   * bounds how much an outage can hold.
   */
  public enqueue(line: DeliveryLine): void {
    this.slots.push({
      sequence: this.nextSequence++,
      line: line.line,
      entry: line.entry,
      attempts: 0,
      shouldSuppressFailureReport: line.shouldSuppressFailureReport,
      state: 'queued',
      committed: false,
    });
    this.enforceQueueLimit();
    this.pump();

    if (this.compat.reopensOnDemand) {
      this.ensureConnection();
    }
  }

  /**
   * Count and report a line refused because `close()` had begun. See
   * {@link LossLedger.refuseAfterClose}.
   */
  public refuseAfterClose(entry: LogEntry): void {
    this.losses.refuseAfterClose(entry, () =>
      this.options.messages.refusedAfterClose(),
    );
  }

  /** Count a line the sink lost before it reached the engine (a failed render). */
  public countLoss(kind: DroppedEntryKind): void {
    this.losses.count(kind);
  }

  /**
   * Send queued lines, oldest first, while the destination takes them.
   *
   * Stops at backpressure rather than emptying the managed queue into the stream's
   * unbounded one; the adapter's drain resumes it. Stops, too, while a write from an older
   * connection is still in flight (see {@link ORPHAN_SETTLE_MS}), and - unless
   * {@link DeliveryCompat.countsQueuedOnly} - once `maxQueueSize` lines are in flight.
   */
  public pump(): void {
    if (this.isPumping) {
      return;
    }

    this.isPumping = true;
    this.isPassStopped = false;

    try {
      while (
        !this.closed &&
        !this.isPassStopped &&
        !this.awaitingDrain &&
        this.adapter.isUsable() &&
        !this.isDispatchBlocked()
      ) {
        const slot = this.firstQueued();

        if (slot === undefined) {
          break;
        }

        this.dispatch(slot);
      }
    } finally {
      // A drained queue closes the reported overflow episode, so a sink that overflows
      // again hours later says so again. See {@link DeliveryCompat.drainsInFlight} for
      // whether a line in flight still holds it open.
      if (
        (this.compat.drainsInFlight ? this.slots.length : this.queueSize) === 0
      ) {
        this.losses.endOverflowEpisode();
      }

      this.isPumping = false;
    }
  }

  /**
   * How an open failure is routed, from the request's origin and the queue's contents.
   *
   * Any ordinary line queued makes the attempt ordinary, whatever asked for it: the
   * caller's own work is waiting on it. Otherwise an attempt asked for by a diagnostic
   * failure, or made during a console report, or - for an automatic attempt - with only
   * diagnostics queued, is diagnostic; one asked for by a forwarded console line, or made
   * during a console report, is suppressed. An explicit reopen is the caller's own request,
   * and its failure is owed to `onError` whatever happens to be queued.
   */
  public openRouting(
    request: OpenRequest & { isExplicit?: boolean },
  ): OpenRouting {
    const queued = this.queuedSlots();
    const hasOrdinaryWork = queued.some(
      (slot) =>
        !isDiagnosticEntry(slot.entry) && !slot.shouldSuppressFailureReport,
    );
    const isConsoleActive = isConsoleReportActive();

    return {
      shouldSuppressFailureReport:
        (request.shouldSuppressRetryReport === true || isConsoleActive) &&
        !hasOrdinaryWork,
      isDiagnostic:
        (request.isDiagnosticRetry === true ||
          isConsoleActive ||
          (request.isExplicit !== true &&
            queued.length > 0 &&
            queued.every((slot) => isDiagnosticEntry(slot.entry)))) &&
        !hasOrdinaryWork,
    };
  }

  /**
   * Report a failed open, once per distinct failure per outage rather than once per
   * attempt; see {@link outages}. Nothing while closing: `close()` is about to account
   * for the backlog itself. A suppressed one is recorded in `lastError` and no budget is
   * spent.
   */
  public reportOpenFailure(
    kind: SinkFailureKind,
    message: string,
    cause: unknown,
    isDiagnostic = false,
    shouldSuppressFailureReport = false,
  ): void {
    if (this.closing || this.closed) {
      return;
    }

    if (shouldSuppressFailureReport) {
      this.lastError = new Error(message, { cause });

      return;
    }

    this.outages.reportFailure(kind, message, cause, isDiagnostic);
  }

  /**
   * Reopen if the destination is not usable, at most one attempt at a time.
   *
   * Only one attempt may be in flight, because two concurrent opens could each obtain a
   * handle and one would be orphaned. With {@link DeliveryCompat.reopensOnDemand} this is
   * asked from every write, failed write and lost connection, and attempts are spaced by
   * the backoff since the last automatic one - deferred rather than dropped, since a
   * process that has just lost its destination may have nothing else to say. Without it,
   * a new episode opens at once and the timer takes it from there.
   */
  public ensureConnection(request: OpenRequest = {}): void {
    if (this.closing || this.closed) {
      return;
    }

    if (
      this.state === 'connected' ||
      this.state === 'opening' ||
      this.isReconnecting
    ) {
      return;
    }

    if (!this.compat.reopensOnDemand) {
      if (this.reopenTimer !== undefined) {
        return;
      }

      if (this.backoff.isAtRest) {
        void this.startOpen('automatic', request);
      } else {
        this.armReopen(this.backoff.next());
      }

      return;
    }

    const now = Date.now();
    const sinceLastAttempt = now - this.lastReopenAttempt;
    const cooldownMS = this.backoff.peek();

    if (sinceLastAttempt < cooldownMS) {
      this.armReopen(cooldownMS - sinceLastAttempt);

      return;
    }

    this.lastReopenAttempt = now;
    void this.startOpen('automatic', request);
  }

  /**
   * The adapter's connection in hand failed, so there is none: say so, then recover.
   *
   * `report` - the failure that ended it, when the adapter has not already said it - goes
   * out after the state has moved on and before recovery starts, so a handler that calls
   * `reconnect()` from inside it finds a sink that knows it is disconnected, and its
   * attempt is not raced by a second one.
   */
  public connectionLost(request: OpenRequest = {}, report?: () => void): void {
    if (this.state === 'connected') {
      this.state = 'cooling_down';
    }

    // Nothing is going to drain now, so a later connection is not made to wait on a drain
    // this one will never signal.
    this.awaitingDrain = false;
    this.connectionGeneration = undefined;

    report?.();

    this.ensureConnection(request);
  }

  /**
   * Reopen now, because the caller asked: `reconnect()`.
   *
   * Waits for an attempt already in flight rather than racing it; refused while closing
   * or when the adapter says so (a pipe with writes still buffered). The outage
   * deduplication is cleared first: a failed explicit reopen reports its failure again,
   * since the caller asked and has nowhere else to read the diagnosis.
   */
  public async reopenNow(): Promise<ReopenStatus> {
    // A closed sink is not one to reopen: a destination opened now would be held for the
    // life of the process by a sink nothing can write to again.
    if (this.closed || this.closing) {
      return { success: false, reason: 'closed' };
    }

    if (this.isReconnecting) {
      await this.openPromise;

      return { success: false, reason: 'already_reconnecting' };
    }

    this.isReconnecting = true;

    try {
      // An attempt already in flight has to finish before this one starts - the
      // constructor's, say, for an app that reconnects on a "reader is ready" signal. Two
      // concurrent opens could both succeed and one handle be orphaned. The flag above is
      // already set, so nothing new starts while this waits.
      if (this.state === 'opening') {
        await this.openPromise;

        if (this.closed || this.closing) {
          return { success: false, reason: 'closed' };
        }
      }

      const refusal = this.adapter.checkReopen?.();

      if (refusal !== undefined) {
        // Reopening was refused; the current connection has not failed.
        this.report('setup', refusal);

        return { success: false, reason: 'error', error: refusal };
      }

      this.dropConnection();
      this.outages.clear();
      this.backoff.reset();

      await this.startOpen('explicit', {});

      if (this.state === 'connected') {
        // The failures counted were about the connection this call just replaced, and
        // nothing else clears them but a successful write - so a reopen over an empty queue
        // would answer `{ success: true }` while `getHealth()` went on reporting unhealthy.
        // Deliberately not done on the automatic path: there the queue still holds the
        // lines that failed, and their next attempt is the honest answer.
        this.consecutiveFailures = 0;

        return { success: true };
      }

      return {
        success: false,
        reason: 'error',
        error: new Error(this.options.messages.reopenFailed()),
      };
    } finally {
      this.isReconnecting = false;
    }
  }

  /**
   * Record a failure and report it: the sinks' `handleError`. Answers whether the report
   * went out rather than being suppressed.
   */
  public report(
    kind: SinkFailureKind,
    error: unknown,
    options?: DeliveryReportOptions,
  ): boolean {
    // Normalized rather than trusted: `error` reaches here from stream and filesystem
    // callbacks as well as from `catch` blocks, so it is not guaranteed to be an `Error`.
    const failure = toError(error);

    this.lastError = failure;

    // Write failures only, and only from the connection in hand. A `'format'` failure
    // still produced a line and left the destination untouched, and a failure delivered
    // late by a connection already replaced says nothing about the one that replaced it.
    if (kind === 'write' && options?.countsAgainstHealth !== false) {
      this.consecutiveFailures++;
    }

    if (options?.shouldSuppressFailureReport === true) {
      return false;
    }

    return this.options.report(
      {
        kind,
        error: failure,
        target: options?.target ?? this.adapter.target(),
        ...(options?.entry === undefined ? {} : { entry: options.entry }),
        ...(options?.attempt === undefined ? {} : { attempt: options.attempt }),
        disposition: options?.disposition ?? 'no_entry',
      },
      {
        isDiagnostic:
          options?.isDiagnostic ?? isDiagnosticEntry(options?.entry),
        onSettled: options?.onReported,
      },
    );
  }

  /**
   * Record `error` as the most recent failure without reporting it: for a failure the sink
   * reports by its own route, or one it has already reported once.
   */
  public recordError(error: Error): void {
    this.lastError = error;
  }

  /** The base health every queueing sink reports. */
  public getHealth(): QueueingSinkHealth {
    const isConnected = this.state === 'connected';

    return {
      // Not while closing: `close()` leaves the connection in place for the whole of its
      // drain, while every new `write()` is being refused.
      isHealthy: this.consecutiveFailures === 0 && isConnected && !this.closing,
      queueSize: this.queueSize,
      droppedEntries: this.losses.droppedEntries,
      droppedByKind: this.losses.droppedByKind(),
      isInitialized: isConnected,
      isReconnecting: this.isReconnecting,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Wait for the queue to empty, within `timeoutMS`.
   *
   * Resolves when the queue is empty; when the destination is not open and either an
   * attempt started after this call has failed or the next one falls after the deadline
   * (`timedOut: false`, `success: false`, the lines still queued); or at the deadline
   * (`timedOut: true`). Never skips the backoff.
   */
  public async flush(timeoutMS: number): Promise<DeliveryFlushResult> {
    const startTime = Date.now();
    const result = await this.flushes.run(timeoutMS, async (window) => {
      const firstAttempt = this.openAttemptsStarted + 1;

      for (;;) {
        if (this.isDrained) {
          return window.settle(false);
        }

        if (this.closed) {
          return window.settle(false, false);
        }

        if (Date.now() - startTime > timeoutMS) {
          return window.settle(true);
        }

        if (
          this.state === 'cooling_down' &&
          (this.lastFailedAttempt >= firstAttempt ||
            (this.reopenAtMS !== undefined &&
              this.reopenAtMS > startTime + timeoutMS))
        ) {
          return window.settle(false, false);
        }

        await sleep(FLUSH_POLL_MS);
      }
    });

    return { ...result, entriesQueued: this.queueSize };
  }

  /**
   * Close: refuse new lines, drain what the destination can still take, give up on the
   * rest and say so, then end the destination. One close however many callers ask.
   */
  public close(): Promise<void> {
    this.closing = true;
    // Published before anything runs, so a close-time callback that calls `close()` again
    // joins this one rather than starting a second.
    this.closePromise ??= deferClose(() => this.closeInternal());

    return this.closePromise;
  }

  private createError(message: string): Error {
    return this.options.createError?.(message) ?? new Error(message);
  }

  private firstQueued(): DeliverySlot | undefined {
    if (this.slots.length === this.inFlightCount) {
      return undefined;
    }

    // The slots ahead of the first queued one are writes in flight, which the destination
    // bounds - a stream's buffer - so this walk stays short.
    for (const slot of this.slots) {
      if (slot.state !== 'in_flight') {
        return slot;
      }
    }

    return undefined;
  }

  private isDispatchBlocked(): boolean {
    if (this.staleInFlight > 0) {
      return true;
    }

    const maxInFlight = this.compat.countsQueuedOnly
      ? this.adapter.maxInFlight
      : Math.min(
          this.adapter.maxInFlight,
          this.options.maxQueueSize ?? Infinity,
        );

    return this.inFlightCount >= maxInFlight;
  }

  /** Hand one queued slot to the adapter, marked in flight where it stands. */
  private dispatch(slot: DeliverySlot): void {
    const token = {};

    slot.state = 'in_flight';
    slot.token = token;
    slot.committed = false;
    slot.generation = this.connectionGeneration;
    this.inFlightCount++;

    let canContinue: boolean | void;

    try {
      // The outcome is where a write is confirmed, and why this line is not considered
      // delivered yet. The adapter answering is not success: a stream reports `EPIPE` and
      // its kin asynchronously, so treating the synchronous return as delivery meant the
      // one line that actually failed was the one line never retried.
      canContinue = this.adapter.write(
        slot,
        { isClosing: this.closing },
        (outcome) => {
          this.settle(slot, token, outcome);
        },
        () => {
          if (slot.token === token) {
            slot.committed = true;
          }
        },
      );
    } catch (error) {
      // The line never reached the destination, so it keeps its place and goes out on a
      // later attempt. Counted against the connection in hand, which is what threw.
      this.settle(
        slot,
        token,
        { status: 'failed', error, isRetryable: true },
        true,
      );

      return;
    }

    if (canContinue === false) {
      this.pauseUntilDrain();
    }
  }

  /**
   * Hold the queue until the destination asks for more. One wait at a time, which is what
   * the flag is for: a `'drain'` listener per backpressured write is a leak that handles
   * nothing.
   */
  private pauseUntilDrain(): void {
    if (this.awaitingDrain) {
      return;
    }

    this.awaitingDrain = true;

    const isWaiting = this.adapter.onDrain(() => {
      this.awaitingDrain = false;
      this.pump();
    });

    if (!isWaiting) {
      this.awaitingDrain = false;
    }
  }

  /** Apply one write's outcome to its slot, once. */
  private settle(
    slot: DeliverySlot,
    token: object,
    outcome: WriteOutcome,
    isSynchronous = false,
  ): void {
    // Already settled, orphaned, or no longer in the queue: whatever this says, the slot
    // has had its answer.
    if (slot.token !== token) {
      return;
    }

    slot.token = undefined;

    const wasBlocked = this.isDispatchBlocked();

    if (this.closeSettlement !== undefined) {
      this.settleWhileClosing(slot, outcome, this.closeSettlement);
    } else {
      this.applyOutcome(slot, outcome, isSynchronous);
    }

    // A slot from an older connection settling can lift the barrier, and one leaving
    // flight can make room under the in-flight cap. Nothing else drives a pass then.
    if (wasBlocked && !this.isDispatchBlocked()) {
      this.pump();
    }
  }

  private applyOutcome(
    slot: DeliverySlot,
    outcome: WriteOutcome,
    isSynchronous: boolean,
  ): void {
    // Only the connection in hand may be marked unhealthy by this, or cleared by it. The
    // outcome can arrive later than the write that started it, and a reopen may have put a
    // working connection in place in between: the result belongs to the one that is gone.
    const isCurrent =
      isSynchronous || slot.generation === this.connectionGeneration;

    // `close()` already answered for a line still in flight when it gave up - abandoned
    // with the queue, or reported as unknown - so a failure arriving now has nothing left
    // to say. A late success is still a line written.
    if (
      this.compat.drainsInFlight &&
      this.closed &&
      outcome.status !== 'written'
    ) {
      this.removeSlot(slot);

      return;
    }

    switch (outcome.status) {
      case 'written': {
        this.removeSlot(slot);
        this.totalWritten++;

        if (isCurrent) {
          this.consecutiveFailures = 0;
        }

        this.backoff.reset();

        return;
      }
      case 'abandoned': {
        this.removeSlot(slot);
        this.losses.count('close');

        return;
      }
      case 'unavailable': {
        this.isPassStopped = true;

        if (this.compat.unavailableSpendsAttempt) {
          // Nothing was reported for this attempt, so whatever ends it is reported here.
          this.retryOrGiveUp(slot);

          return;
        }

        if (this.closed) {
          this.giveUpAfterClose(slot);

          return;
        }

        // The destination is gone, whatever the adapter still holds: let it go, and
        // the line waits in its place, its attempts unspent, for the next connection.
        this.leaveFlight(slot);
        this.enforceQueueLimit();

        if (!this.closing && this.state === 'connected') {
          this.dropConnection();
          this.armReopen(this.backoff.next());
        }

        return;
      }
      case 'failed': {
        this.applyFailure(slot, outcome, isCurrent, isSynchronous);

        return;
      }
    }
  }

  /**
   * A write that failed: reported with the line it belongs to, and either kept for another
   * attempt or given up on.
   *
   * `onError` hears every attempt by contract. Without one, only the attempt that loses
   * the line is reported: routed to the owning logger, each `'retrying'` attempt became a
   * diagnostic entry in its other sinks - `maxRetries + 1` of them for every line a dead
   * destination takes.
   */
  private applyFailure(
    slot: DeliverySlot,
    outcome: Extract<WriteOutcome, { status: 'failed' }>,
    isCurrent: boolean,
    isSynchronous: boolean,
  ): void {
    const kind = this.compat.inlineSetup ? (outcome.kind ?? 'write') : 'write';
    const willRetry =
      !this.closed &&
      outcome.isRetryable &&
      slot.attempts < this.options.maxRetries &&
      (!this.compat.refusesRetryWithoutRoom || this.hasRetryRoom());
    const report = {
      attempt: slot.attempts + 1,
      entry: slot.entry,
      // A synchronous throw came from the connection in hand by definition, and has
      // always counted against it.
      ...(isSynchronous ? {} : { countsAgainstHealth: isCurrent }),
    };

    if (!willRetry) {
      // Out of attempts, closed, or - for a write that may have delivered part of the line -
      // never to be replayed. Gone from the queue and counted before anyone is told.
      this.removeSlot(slot);
      this.losses.count(this.lossKindFor(kind));
      this.report(kind, outcome.error, {
        ...report,
        shouldSuppressFailureReport: this.shouldSuppressWriteReport(
          slot,
          false,
        ),
        disposition: 'lost',
      });

      return;
    }

    // Reported before the retry is committed, the slot still marked in flight with its
    // token cleared: nothing can settle it twice, and nothing a handler does can evict it.
    const shouldSuppress = this.shouldSuppressWriteReport(slot, true);
    const didReport = this.report(kind, outcome.error, {
      ...report,
      shouldSuppressFailureReport: shouldSuppress,
      disposition: 'retrying',
    });

    // Told to the caller's own handler - not to an owner or the console, which hear only
    // the attempt that loses the line.
    if (
      didReport &&
      !shouldSuppress &&
      this.options.hasHandler() &&
      !isDiagnosticEntry(slot.entry)
    ) {
      slot.hasReportedRetrying = true;
    }

    // Re-checked now the handler has returned: it may have filled the queue or closed the
    // sink, and the line is then reported again as `'lost'` - the final word.
    this.retryOrGiveUp(
      slot,
      this.compat.inlineSetup ? { kind, error: outcome.error } : undefined,
      outcome.onRetry,
    );
  }

  /**
   * Put a failed line back in its place for another attempt, or give up on it and say so.
   *
   * The line has either been reported `'retrying'` already, or - for a write that could not
   * be attempted at all - reported nothing, so a line given up on here is reported here,
   * with a message that says what is known: synthesized rather than re-reporting
   * `lastError`, which may be an unrelated earlier failure and would name the wrong cause.
   * With {@link DeliveryCompat.inlineSetup} the `'retrying'` report's own `failure` is
   * said again instead.
   *
   * `onRetry` runs once the line is kept, before anything can send it again.
   */
  private retryOrGiveUp(
    slot: DeliverySlot,
    failure?: { kind: SinkFailureKind; error: unknown },
    onRetry?: () => void,
  ): void {
    const isGivenUp =
      this.closed ||
      slot.attempts >= this.options.maxRetries ||
      (this.compat.refusesRetryWithoutRoom && !this.hasRetryRoom());

    if (isGivenUp && failure !== undefined) {
      this.giveUpAfterRetrying(slot, failure);

      return;
    }

    if (this.closed) {
      this.giveUpAfterClose(slot);

      return;
    }

    if (isGivenUp) {
      this.removeSlot(slot);
      this.losses.count('write');
      this.report(
        'write',
        this.createError(this.options.messages.notRetained(slot.attempts + 1)),
        {
          attempt: slot.attempts + 1,
          disposition: 'lost',
          entry: slot.entry,
          shouldSuppressFailureReport: slot.shouldSuppressFailureReport,
          // The connection this line could not be written to is already gone - that is
          // why it is here - so this says nothing about whatever replaced it.
          countsAgainstHealth: false,
        },
      );

      return;
    }

    slot.attempts++;
    this.leaveFlight(slot);
    this.enforceQueueLimit();
    onRetry?.();
    this.afterFailedWrite();
  }

  /**
   * A line reported `'retrying'` that cannot be kept after all: the handler filled the
   * queue or the sink closed. Reported again, with the same failure and attempt, as
   * `'lost'` - the final word. See {@link DeliveryCompat.inlineSetup}.
   */
  private giveUpAfterRetrying(
    slot: DeliverySlot,
    failure: { kind: SinkFailureKind; error: unknown },
  ): void {
    this.removeSlot(slot);
    this.losses.count(this.lossKindFor(failure.kind));
    this.report(failure.kind, failure.error, {
      attempt: slot.attempts + 1,
      entry: slot.entry,
      disposition: 'lost',
      shouldSuppressFailureReport: this.shouldSuppressWriteReport(slot, false),
      // Counted once already, by the `'retrying'` report of this same failure.
      countsAgainstHealth: false,
    });
  }

  /**
   * Which loss a failed line is counted under. Always `'write'`, unless
   * {@link DeliveryCompat.inlineSetup} says a write can fail as something else: then the
   * kind it failed as, and a write failure once the sink has closed is a closing loss.
   */
  private lossKindFor(kind: SinkFailureKind): DroppedEntryKind {
    if (!this.compat.inlineSetup) {
      return 'write';
    }

    if (kind === 'format' || kind === 'close' || kind === 'setup') {
      return kind;
    }

    return this.closed ? 'close' : 'write';
  }

  /**
   * A line whose write ended after `close()` finished with the queue. Nothing will carry it
   * any further; counted, and reported with its entry, since each failed write needs its
   * own final disposition for fallback consumers.
   */
  private giveUpAfterClose(slot: DeliverySlot): void {
    this.removeSlot(slot);
    this.losses.count('close');
    this.report(
      'close',
      this.createError(this.options.messages.failedAfterClose()),
      {
        disposition: 'lost',
        entry: slot.entry,
        shouldSuppressFailureReport: slot.shouldSuppressFailureReport,
      },
    );
  }

  /**
   * Drive recovery after a write failed and its line went back in the queue.
   *
   * Not while closing: `close()` drives its own drain every pass and has decided this sink
   * is not opening anything new. Otherwise the line goes out through the connection in
   * hand, or recovery is asked for when there is none - a failure can arrive after a
   * reopen has already put a working connection in place, and the line would otherwise sit
   * in a queue nothing was draining.
   */
  private afterFailedWrite(): void {
    // With `inlineSetup`, close's drain is the sink's own pass, which goes straight on to
    // the retry rather than waiting for close to poll.
    if (this.closed || (this.closing && !this.compat.inlineSetup)) {
      return;
    }

    if (
      this.state === 'connected' &&
      this.adapter.isUsable() &&
      !this.awaitingDrain
    ) {
      this.pump();

      return;
    }

    if (this.compat.reopensOnDemand) {
      this.ensureConnection();

      return;
    }

    if (this.state === 'connected' && !this.adapter.isUsable()) {
      this.dropConnection();
      this.armReopen(this.backoff.next());
    }
  }

  /**
   * Whether a failed line can keep its place without the cap evicting it at once. A retry
   * that would only push the queue over `maxQueueSize` is not a retry.
   */
  private hasRetryRoom(): boolean {
    return (
      this.options.maxQueueSize === undefined ||
      this.queueSize < this.options.maxQueueSize
    );
  }

  private shouldSuppressWriteReport(
    slot: DeliverySlot,
    willRetry: boolean,
  ): boolean {
    // A forwarded console line never starts another report.
    return (
      slot.shouldSuppressFailureReport === true ||
      (willRetry && !this.options.hasHandler())
    );
  }

  /** Clear a slot's in-flight mark, leaving it queued where it stands. */
  private leaveFlight(slot: DeliverySlot): void {
    if (slot.state !== 'in_flight') {
      return;
    }

    slot.state = 'queued';
    this.inFlightCount--;

    if (
      this.staleInFlight > 0 &&
      slot.generation !== this.connectionGeneration
    ) {
      this.staleInFlight--;
    }
  }

  /** Take a slot out of the queue for good. */
  private removeSlot(slot: DeliverySlot): void {
    this.leaveFlight(slot);
    slot.token = undefined;

    // Outcomes arrive in write order, so the slot is almost always at the head.
    const index = this.slots[0] === slot ? 0 : this.slots.indexOf(slot);

    if (index >= 0) {
      this.slots.splice(index, 1);
    }
  }

  /**
   * Discard the oldest queued lines once the queue is over `maxQueueSize`, and report the
   * first eviction of the episode. Never a line in flight: it may already be written.
   */
  private enforceQueueLimit(): void {
    const limit = this.options.maxQueueSize;
    const owed: DeliverySlot[] = [];

    const sampled = this.losses.evict(
      this.slots,
      limit,
      (cap) => this.options.messages.queueFull(cap),
      {
        isEvictable: (slot) => slot.state !== 'in_flight',
        occupancy: this.queueSize,
        onEvicted: (slot) => {
          if (
            !this.compat.refusesRetryWithoutRoom &&
            slot.hasReportedRetrying === true
          ) {
            owed.push(slot);
          }
        },
      },
    );

    // A line an explicit `onError` was told is `'retrying'` gets its own final word, unless
    // the episode's report - which covers owners and the console - already carried it.
    for (const slot of owed) {
      if (slot.entry === sampled) {
        continue;
      }

      this.report(
        'queue_full',
        this.createError(this.options.messages.queueFull(limit ?? 0)),
        { disposition: 'lost', entry: slot.entry },
      );
    }
  }

  private queuedSlots(): DeliverySlot[] {
    return this.compat.countsQueuedOnly
      ? this.slots.filter((slot) => slot.state !== 'in_flight')
      : this.slots;
  }

  /** Let go of the connection in hand, whatever state it is in. */
  private dropConnection(): void {
    this.adapter.release();
    this.awaitingDrain = false;
    this.connectionGeneration = undefined;

    if (this.state === 'connected') {
      this.state = 'cooling_down';
    }
  }

  /**
   * Start one open attempt. The attempt is marked in flight before anything awaits, so no
   * caller can start a second beside it. An attempt replaces any armed timer.
   */
  private startOpen(kind: OpenKind, request: OpenRequest): Promise<void> {
    this.clearReopenTimer();
    this.state = 'opening';

    const attempt = {};

    this.openAttempt = attempt;
    this.openAttemptsStarted++;

    const attemptNumber = this.openAttemptsStarted;

    if (kind === 'automatic') {
      this.isReconnecting = true;
    }

    const context: OpenContext = {
      isExplicit: kind === 'explicit',
      isClosing: this.closing,
      isDiagnosticRetry: request.isDiagnosticRetry === true,
      shouldSuppressRetryReport: request.shouldSuppressRetryReport === true,
    };

    const settled = (async (): Promise<void> => {
      let result: unknown;

      try {
        result = await this.adapter.open(context);
      } catch (error) {
        // The adapter reports its own failures and is built never to reject, so a
        // rejection here is a bug - reported, not swallowed. Contained, so `reconnect()`
        // and `close()` waiting on this attempt answer with their own status.
        reportToConsole(
          `${this.adapter.label} initialization failed unexpectedly: ${describeError(error)}`,
        );
      } finally {
        if (kind === 'automatic') {
          this.isReconnecting = false;
        }
      }

      this.settleOpen(attempt, attemptNumber, result);
    })();

    this.openPromise = settled;

    return settled;
  }

  private settleOpen(
    attempt: object,
    attemptNumber: number,
    result: unknown,
  ): void {
    if (this.openAttempt !== attempt) {
      return;
    }

    this.openAttempt = undefined;

    const isOpen =
      typeof result === 'object' &&
      result !== null &&
      (result as { status?: unknown }).status === 'open';

    if (this.closed) {
      // `close()` finished while this was in flight; a sink that can never write again
      // must not hold what it opened.
      if (isOpen) {
        this.adapter.release();
      }

      return;
    }

    if (isOpen) {
      this.state = 'connected';
      this.generation++;
      this.connectionGeneration = this.generation;
      this.awaitingDrain = false;
      // Everything still in flight went to an older connection, and holds dispatch here
      // until it settles.
      this.staleInFlight = this.inFlightCount;

      if (this.staleInFlight > 0) {
        this.armOrphanTimer();
      }

      // A later outage is a new fact and is reported as one.
      this.outages.clear();
      this.pump();

      return;
    }

    this.lastFailedAttempt = attemptNumber;

    if (this.state === 'opening') {
      this.state = 'cooling_down';
    }

    // Every failed open arms the next attempt, which is what makes recovery independent of
    // traffic: a destination recreated, a reader restarted or a permission fixed during a
    // quiet minute is picked up without waiting for the next log call.
    this.armReopen(this.backoff.next());
  }

  /**
   * Try again after `delayMS`. One timer at a time, `unref`'d, and the *soonest*: a later,
   * longer request never displaces a sooner recovery attempt.
   */
  private armReopen(delayMS: number): void {
    if (this.closing || this.closed) {
      return;
    }

    if (this.reopenTimer !== undefined) {
      if (
        this.reopenAtMS !== undefined &&
        Date.now() + delayMS >= this.reopenAtMS
      ) {
        return;
      }

      clearTimeout(this.reopenTimer);
      this.reopenTimer = undefined;
    }

    this.reopenAtMS = Date.now() + delayMS;

    const timer = setTimeout(() => {
      this.reopenTimer = undefined;
      this.reopenAtMS = undefined;
      this.onReopenTimer();
    }, delayMS);

    // So a pending attempt cannot hold the process open.
    timer.unref?.();

    this.reopenTimer = timer;
  }

  private clearReopenTimer(): void {
    if (this.reopenTimer !== undefined) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = undefined;
      this.reopenAtMS = undefined;
    }
  }

  /**
   * The reopen timer fired. Its routing comes from what is queued now rather than from
   * whatever asked for it: a queue holding only lines forwarded from a console report, and
   * diagnostics, is suppressed, as the failure that queued them would have been.
   */
  private onReopenTimer(): void {
    const queued = this.queuedSlots();
    const request: OpenRequest = {
      shouldSuppressRetryReport:
        queued.some((slot) => slot.shouldSuppressFailureReport) &&
        queued.every(
          (slot) =>
            slot.shouldSuppressFailureReport || isDiagnosticEntry(slot.entry),
        ),
    };

    if (this.compat.reopensOnDemand) {
      this.ensureConnection(request);

      return;
    }

    if (
      this.closing ||
      this.closed ||
      this.state === 'connected' ||
      this.state === 'opening' ||
      this.isReconnecting
    ) {
      return;
    }

    void this.startOpen('automatic', request);
  }

  /** Bound the generation barrier; see {@link ORPHAN_SETTLE_MS}. */
  private armOrphanTimer(): void {
    this.clearOrphanTimer();

    const generation = this.connectionGeneration;
    const timer = setTimeout(() => {
      this.orphanTimer = undefined;
      this.releaseOrphans(generation);
    }, ORPHAN_SETTLE_MS);

    timer.unref?.();
    this.orphanTimer = timer;
  }

  private clearOrphanTimer(): void {
    if (this.orphanTimer !== undefined) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = undefined;
    }
  }

  /**
   * Stop waiting for writes still in flight on a replaced connection.
   *
   * With {@link DeliveryCompat.honorsLateCallbacks} they keep their callbacks and only the
   * barrier lifts. Without it each counts as a spent attempt and goes back to the queue -
   * possibly to be written twice, never lost - and its late callback is ignored.
   */
  private releaseOrphans(generation: number | undefined): void {
    if (this.connectionGeneration !== generation || this.staleInFlight === 0) {
      return;
    }

    this.staleInFlight = 0;

    if (!this.compat.honorsLateCallbacks) {
      for (const slot of [...this.slots]) {
        if (
          slot.state === 'in_flight' &&
          slot.token !== undefined &&
          slot.generation !== generation
        ) {
          slot.token = undefined;
          this.retryOrGiveUp(slot);
        }
      }
    }

    this.pump();
  }

  private async closeInternal(): Promise<void> {
    const startTime = Date.now();
    const timeoutMS = this.options.closeTimeoutMS;

    // Wait for an attempt in flight, bounded. Losing it remains observed after the
    // deadline.
    try {
      await raceDeadline(this.openPromise, timeoutMS, () => undefined);
    } catch {
      // Adapters report their own open failures; a close does not get to raise one.
    }

    // A backlog and nothing to write it with: keep asking for the destination for a short
    // grace window rather than abandoning the backlog the moment `close()` is called. The
    // reopen policy's backoff is no help here - it exists to stop a dead destination
    // becoming a syscall storm, which is right for a running sink and wrong for the last
    // attempts a close gets to make. Whichever bound is nearer wins, so a close with little
    // budget left never overruns it for this.
    //
    // A destination torn down but not yet let go is no destination, which is what
    // `hasConnection` answers: a stream marks itself destroyed synchronously on a failed
    // write while the adapter learns of it only from the asynchronous error event, and a
    // `close()` entered in that window - an `onError` handler calling `sink.close()` -
    // would otherwise skip this loop and abandon the backlog without one attempt.
    const reopenGraceUntil =
      Date.now() + Math.min(CLOSE_REOPEN_GRACE_MS, timeoutMS);

    while (
      this.queueSize > 0 &&
      !this.adapter.hasConnection() &&
      this.state !== 'opening' &&
      Date.now() < reopenGraceUntil &&
      Date.now() - startTime < timeoutMS
    ) {
      await this.reopenForClose(startTime, reopenGraceUntil);

      if (this.adapter.hasConnection()) {
        break;
      }

      // Spaced out, so a destination that never comes back costs a handful of attempts
      // across the window rather than a spin.
      await sleep(CLOSE_REOPEN_POLL_MS);
    }

    // Drain what the destination can still take before giving up on it. An open in
    // progress counts as work to wait for, exactly as a live connection does; the
    // deadline still bounds the wait. See {@link DeliveryCompat.drainsInFlight} for
    // whether a line in flight is still work.
    const hasWork = (): boolean =>
      this.compat.drainsInFlight
        ? !this.isDrained
        : this.queueSize > 0 || this.isPumping;

    while (
      hasWork() &&
      (this.state === 'opening' || this.adapter.hasConnection()) &&
      Date.now() - startTime <= timeoutMS
    ) {
      // Asked for explicitly: nothing else drives a pass while this loop is awaiting, and
      // the queue may have been left parked by a failed write rather than by backpressure.
      this.pump();

      await sleep(CLOSE_DRAIN_POLL_MS);
    }

    // Closed is not healthy, and not connected either.
    this.state = 'closed';
    this.clearReopenTimer();
    this.clearOrphanTimer();
    this.adapter.onClosed?.();

    // What is left of the *whole* close's budget, so the open wait, the drain and the final
    // flush share one deadline.
    const remainingMS = (): number => timeoutMS - (Date.now() - startTime);

    if (this.compat.drainsInFlight) {
      await this.closeLeavingInFlight(remainingMS);

      return;
    }

    if (this.compat.honorsLateCallbacks) {
      this.abandonOnClose((slot) => slot.state !== 'in_flight');
      await this.adapter.end(remainingMS());
      this.connectionGeneration = undefined;

      return;
    }

    await this.closeOnEvidence(remainingMS);
  }

  /**
   * One attempt to reach the destination again for a close that still has a backlog,
   * raced against what is left of the grace window - not the close's whole budget, so a
   * final recovery attempt cannot consume the entire close timeout.
   */
  private async reopenForClose(
    startTime: number,
    graceUntil: number,
  ): Promise<void> {
    const remainingMS = Math.min(
      this.options.closeTimeoutMS - (Date.now() - startTime),
      graceUntil - Date.now(),
    );

    if (remainingMS <= 0) {
      return;
    }

    await raceDeadline(
      this.startOpen('closing', {}),
      remainingMS,
      () => undefined,
    );
  }

  /**
   * Give up on what close could not send, and say so once, with the oldest line as a
   * sample. `'close'` rather than `'write'`, so it is not counted against a connection
   * that is being torn down anyway.
   */
  private abandonOnClose(isAbandoned: (slot: DeliverySlot) => boolean): void {
    const abandoned = new Set(this.slots.filter(isAbandoned));

    // Their outcomes, should any still arrive, no longer have a slot to settle.
    for (const slot of abandoned) {
      this.leaveFlight(slot);
      slot.token = undefined;
    }

    this.losses.abandon(
      this.slots,
      (count) => this.options.messages.abandoned(count),
      (slot) => abandoned.has(slot),
    );
  }

  /**
   * The close rule with {@link DeliveryCompat.drainsInFlight}: give up on everything not
   * yet handed over, and say once that a write that was is unknown.
   *
   * The line handed over may well arrive - a filesystem write cannot be called back - so it
   * is not counted, and `'no_entry'`, since it is neither lost nor coming back. Its late
   * success counts as written; its late failure is ignored, this being its only report.
   */
  private async closeLeavingInFlight(remainingMS: () => number): Promise<void> {
    const handedOver = new Set(
      this.slots.filter(
        (slot) =>
          slot.state === 'in_flight' &&
          slot.committed &&
          slot.token !== undefined,
      ),
    );

    // Never handed over, so certainly not written: lost with the queue, and the oldest of
    // them is the report's sample.
    this.abandonOnClose((slot) => !handedOver.has(slot));

    if (handedOver.size > 0) {
      this.report(
        'close',
        this.createError(
          this.options.messages.inFlightUnknown(handedOver.size),
        ),
      );
    }

    await this.adapter.end(remainingMS(), {
      hasReportedInFlight: handedOver.size > 0,
    });
  }

  /**
   * The close rule without {@link DeliveryCompat.honorsLateCallbacks}: settle the writes
   * in flight on evidence before resolving.
   *
   * Queued lines, and in-flight ones never handed over, are abandoned. Committed writes
   * are left to the destination's own end; one macrotask after it, a write that succeeded
   * counts as written, a write that failed is counted `'close'` and reported once, and a
   * write still unsettled is reported once as unknown - uncounted, since it may well have
   * arrived - and its late callback ignored.
   */
  private async closeOnEvidence(remainingMS: () => number): Promise<void> {
    this.abandonOnClose(
      (slot) => slot.state !== 'in_flight' || !slot.committed,
    );

    const settlement: CloseSettlement = { failed: [] };

    this.closeSettlement = settlement;

    let bytesLeft = 0;

    try {
      bytesLeft = await this.adapter.end(remainingMS());
      // The callbacks a destination's teardown triggers arrive on a later turn.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      this.closeSettlement = undefined;
      this.connectionGeneration = undefined;
    }

    if (settlement.failed.length > 0) {
      const sample =
        settlement.failed.find((slot) => !isDiagnosticEntry(slot.entry)) ??
        settlement.failed[0];

      this.losses.count('close', settlement.failed.length);
      this.report(
        'close',
        this.createError(
          this.options.messages.lostAtClose(
            settlement.failed.length,
            bytesLeft,
          ),
        ),
        { disposition: 'lost', entry: sample.entry },
      );
    }

    const unsettled = this.slots.filter(
      (slot) => slot.state === 'in_flight' && slot.token !== undefined,
    );

    for (const slot of unsettled) {
      this.removeSlot(slot);
    }

    if (unsettled.length > 0) {
      this.report(
        'close',
        this.createError(
          this.options.messages.inFlightUnknown(unsettled.length),
        ),
      );
    }
  }

  private settleWhileClosing(
    slot: DeliverySlot,
    outcome: WriteOutcome,
    settlement: CloseSettlement,
  ): void {
    this.removeSlot(slot);

    if (outcome.status === 'written') {
      this.totalWritten++;

      return;
    }

    settlement.failed.push(slot);
  }
}
