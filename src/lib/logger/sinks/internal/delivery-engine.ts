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
 * How long `close()` waits, after ending the destination, for the writes it still had in
 * flight to answer.
 *
 * Ending a destination fails the writes it held, and their callbacks usually arrive within
 * one turn of the event loop. Not always: a pipe stream whose write is still in the
 * thread pool defers its teardown until that syscall returns, and its callback lands on a
 * later I/O turn. A write that has not answered by then is reported as unknown, so a short
 * wait is the difference between saying what happened to it and saying nobody knows. Paid
 * only by a close that has writes still unanswered.
 */
export const CLOSE_SETTLE_MS = 50;

/** How often the {@link CLOSE_SETTLE_MS} wait looks again. */
const CLOSE_SETTLE_POLL_MS = 5;

/**
 * How long dispatch on a new connection waits for writes still in flight on an older one.
 *
 * A write that failed on a connection the engine has since replaced comes back to the
 * queue *ahead* of everything written after it, so newer lines are held until the old
 * writes have settled - otherwise a late failure is overtaken and the log reorders around
 * every reconnect. Bounded, because a destination that was torn down may never answer for
 * what it held: past this each such write counts as a spent attempt and goes out again,
 * and its late answer is ignored - so the line may be written twice. Delivery across a
 * reconnect is at-least-once; it is never lost to the barrier.
 *
 * The exception is an adapter that holds released writes
 * ({@link DestinationAdapter.holdsReleasedWrites}): there a released write keeps the
 * adapter's one place for up to this long again, and a late success in that time counts
 * its line as written instead of sending it again.
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
   * owes it a final word of its own: a line that keeps its place through a retry is only
   * ever lost to eviction or to `close()`, and every `'retrying'` gets a final word.
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
  | { status: 'failed'; error: unknown; isRetryable: boolean }
  /**
   * Not attempted: the destination went away before the line was handed to it. The line
   * keeps its place with its attempts unspent.
   */
  | { status: 'unavailable' };

/**
 * The destination-specific half of a queueing sink: how to open it, write to it and let
 * it go. The engine owns the queue, retries, reopening, reporting, flush and close.
 */
export interface DestinationAdapter {
  /** The sink's class name, for console lines. */
  readonly label: string;
  /** Writes in flight at once, before backpressure. `Infinity` for a stream. */
  readonly maxInFlight: number;
  /**
   * Whether a write the engine stopped waiting for may still be running, and must not
   * have another started beside it: the engine then holds its place, bounded (see
   * {@link ORPHAN_SETTLE_MS}). Only for `maxInFlight: 1`, where holding the one place
   * keeps every line - its own included - from going out beside it.
   */
  readonly holdsReleasedWrites?: boolean;
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
   * minimum). Resolves with the bytes it still held when it gave up, which the engine
   * names in its report of the writes that failed as it ended.
   */
  end(timeoutMS: number): Promise<number>;
  /**
   * Told the moment `close()` stops draining, before it gives up on anything or reports
   * it, so the adapter's own view of the sink is closed by the time a report reaches a
   * handler.
   */
  onClosed?(): void;
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

/**
 * Why `close()` gave up on lines it still held.
 *
 * - `'timeout'` - out of budget: the destination was still in hand, or an open was still
 *   pending, when `closeTimeoutMS` ran out.
 * - `'never_opened'` - no destination to write them to: none was in hand at any point of
 *   this close, and its latest attempt to open one failed, or was still pending when the
 *   reopen grace window ran out.
 * - `'connection_lost'` - the same, for a destination that was in hand during this close
 *   and went away.
 * - `'write_failed'` - the destination kept opening, but writes to it kept failing: the
 *   latest open succeeded, and a failed write took that connection away again.
 */
export type CloseAbandonReason =
  'timeout' | 'never_opened' | 'connection_lost' | 'write_failed';

/**
 * The clause a sink's abandon report gives for each reason but `'timeout'`, about the
 * `destination` it names ("the log file", "the pipe"), so both sinks say the same thing.
 */
export function describeCloseAbandonReason(
  reason: Exclude<CloseAbandonReason, 'timeout'>,
  destination: string,
): string {
  switch (reason) {
    case 'never_opened':
      return `${destination} could not be opened`;
    case 'connection_lost':
      return `${destination} was lost and could not be reopened`;
    case 'write_failed':
      return `writes to ${destination} kept failing`;
  }
}

/** The sink's own wording for the reports the engine makes. */
export interface DeliveryMessages {
  queueFull(limit: number): string;
  /**
   * Lines still queued when `close()` gave up on them, and why. The report carries as its
   * `cause` the failure behind that reason, when there is one: the latest write failure
   * for `'write_failed'` - or for `'timeout'`, while writes are failing - and otherwise
   * the failure the latest open attempt reported.
   */
  abandoned(count: number, reason: CloseAbandonReason): string;
  refusedAfterClose(): string;
  /**
   * A line given up on after `attempts` writes, the last of them never answered by a
   * connection the engine had replaced. See {@link ORPHAN_SETTLE_MS}.
   */
  unconfirmed(attempts: number): string;
  /** The notice said once an outage has reported its distinct-failure cap. */
  outageCap(maxReports: number): string;
  /** `reconnect()`'s error when its open did not succeed. */
  reopenFailed(): string;
  /** Lines in flight when `close()` resolved, whose delivery is unknown. */
  inFlightUnknown(count: number): string;
  /** Lines whose writes failed as `close()` ended the destination, and its bytes left. */
  lostAtClose(count: number, bytesLeft: number): string;
}

export interface DeliveryEngineOptions {
  adapter: DestinationAdapter;
  /** `undefined` for no cap. */
  maxQueueSize: number | undefined;
  maxRetries: number;
  closeTimeoutMS: number;
  /**
   * Spacing of automatic reopen attempts, after the first of an outage, which is made at
   * once. Reset by a successful write or an explicit reopen, not by a successful open: a
   * destination that opens and then fails every write is still in the same outage.
   */
  backoff: BackoffOptions;
  /**
   * How long the generation barrier waits, and how long a released write is then held
   * where the adapter holds them. See {@link ORPHAN_SETTLE_MS}, the default.
   */
  orphanSettleMS?: number;
  messages: DeliveryMessages;
  /**
   * The error a report the engine composes carries, built from the sink's own message, so
   * a sink with its own error class reports in it. `cause` is the failure behind it, when
   * the report has one. Defaults to `Error`.
   */
  createError?: (message: string, cause?: Error) => Error;
  report: DeliveryReporter;
  /** Whether the sink has an explicit `onError`, read at report time. */
  hasHandler: () => boolean;
}

/** What a queueing sink tells you about itself. */
export interface QueueingSinkHealth {
  /** No failed writes since the last successful one, connected, and not closing. */
  isHealthy: boolean;
  /** Lines not yet delivered or given up on, in flight included. */
  queueSize: number;
  /** Lines this sink did not deliver, whatever the reason. */
  droppedEntries: number;
  /** `droppedEntries` by reason. */
  droppedByKind: DroppedEntryCounts;
  /** Whether the destination is currently open. */
  isInitialized: boolean;
  /** Whether a reopen - manual or automatic - is in flight. */
  isReconnecting: boolean;
  /** The most recent failure of any kind, including a `formatter` that threw. */
  lastError?: Error;
  /**
   * Failed writes since the last successful one. Write failures only: a `'format'`
   * failure says nothing about whether the destination can be written to.
   */
  consecutiveFailures: number;
}

/** What `flush()` answers, on both queueing sinks. See {@link DeliveryEngine.flush}. */
export interface FlushResult extends FlushWindowResult {
  /**
   * Entries still waiting when the flush returned, in flight included: what a flush that
   * stopped early - an outage, or the deadline - left behind. The same count as
   * `getHealth().queueSize` at that moment.
   */
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

/** Whether a slot's write is out and has not answered. */
function isUnsettled(slot: DeliverySlot): boolean {
  return slot.state === 'in_flight' && slot.token !== undefined;
}

/**
 * Two requests for one reopen. A hint holds only when both carry it: a diagnostic or
 * forwarded failure asking alongside an ordinary one does not get to quiet the attempt.
 * With no earlier request, the new one stands.
 */
function mergeOpenRequests(
  armed: OpenRequest | undefined,
  request: OpenRequest,
): OpenRequest {
  if (armed === undefined) {
    return request;
  }

  return {
    isDiagnosticRetry:
      armed.isDiagnosticRetry === true && request.isDiagnosticRetry === true,
    shouldSuppressRetryReport:
      armed.shouldSuppressRetryReport === true &&
      request.shouldSuppressRetryReport === true,
  };
}

/** One macrotask: where the callbacks a destination's teardown triggers arrive. */
function nextMacrotask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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
   * `onError` every few seconds for the life of the process.
   *
   * Cleared when the destination opens, so the next outage speaks up again, and by an
   * explicit reopen, which is an attempt the caller asked for and is owed an answer to.
   */
  public readonly outages: OutageReporter;
  /**
   * The chained flush windows {@link flush} counts in: successive flushes partition the
   * lines written and lost between them. See {@link FlushWindows}.
   */
  public readonly flushes: FlushWindows;

  private readonly adapter: DestinationAdapter;
  private readonly options: DeliveryEngineOptions;
  /** Spaces automatic reopen attempts; see {@link ensureConnection}. */
  private readonly backoff: Backoff;
  /**
   * Whether this outage has had its immediate attempt. Cleared with the backoff, by a
   * successful write or an explicit reopen: a destination that opens and then fails every
   * write is still in the same outage, and must not be reopened at once after each one.
   */
  private hasReopenedAtOnce = false;

  /**
   * Every line not yet delivered or given up on, oldest first, each with the line already
   * rendered, from {@link head} on. Slots in flight keep their place.
   */
  private slots: DeliverySlot[] = [];
  /**
   * Where the queue starts in {@link slots}. A confirmed line at the front leaves by
   * advancing this rather than shifting the array, so draining a backlog stays linear; the
   * array is compacted once the dead prefix outgrows the live queue, or the queue empties.
   */
  private head = 0;
  /** No queued (not in flight) slot sits before this index: where {@link firstQueued} looks. */
  private queuedFrom = 0;
  /** Slots in {@link slots} marked `in_flight`. */
  private inFlightCount = 0;
  /**
   * In-flight slots dispatched on a connection older than the current one, which hold
   * dispatch on the current one until they settle. See {@link ORPHAN_SETTLE_MS}.
   */
  private staleInFlight = 0;
  /**
   * Writes {@link releaseOrphans} stopped waiting for that have not answered yet, for an
   * adapter that holds them ({@link DestinationAdapter.holdsReleasedWrites}, which writes
   * one line at a time). Their lines went back to the queue, but the adapter may still be
   * running them: each holds the one place, so nothing - its own line included - is
   * dispatched beside it while it holds.
   *
   * Taken only for a line that will be sent again, never while closing, and bounded like
   * the barrier itself: a write that has not answered one more {@link ORPHAN_SETTLE_MS}
   * later stops holding its place, and so does every one when `close()` begins, since a
   * destination torn down may never answer at all - or when its line leaves the queue,
   * evicted at the cap, which counts it lost even should the write still land. Past the
   * hold, a line may go out while its orphan is still running. Each maps to the timer
   * that lets it go, and the line it holds for.
   */
  private readonly releasedWrites = new Map<
    object,
    { timer: ReturnType<typeof setTimeout>; slot: DeliverySlot }
  >();
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
  /** Who asked for the attempt in flight: `close()` gives the first open its budget. */
  private openKind?: OpenKind;
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
  /** When {@link reopenTimer} is due, which `flush()` weighs against its deadline. */
  private reopenAtMS?: number;
  /**
   * What asked for this outage's reopens, beyond what the queue says: the failed line that
   * took the connection away may be gone from the queue by the time an attempt is made.
   * Set as the connection is lost, merged with each later request (see
   * {@link mergeOpenRequests}), kept across failed attempts - automatic or explicit - and
   * cleared by a successful open. See {@link onReopenTimer}.
   */
  private outageRouting?: OpenRequest;

  private lastError?: Error;
  /**
   * Why the destination last failed to open, cleared when it opens. The cause a close
   * that abandons its backlog for want of a destination reports, since the open failures
   * made while closing are not reported on their own.
   */
  private lastOpenFailure?: Error;
  /** The open attempt {@link lastOpenFailure} came from. */
  private lastOpenFailureAttempt = 0;
  /** Whether the latest open attempt to settle succeeded. */
  private didLastOpenSucceed = false;
  /**
   * The latest write failure on the connection in hand, cleared by a write that succeeds:
   * while it is set, writes are failing - a full disk, say - and a close that abandons
   * lines says so through it.
   */
  private latestWriteFailure?: Error;
  private consecutiveFailures = 0;
  private totalWritten = 0;

  constructor(options: DeliveryEngineOptions) {
    this.options = options;
    this.adapter = options.adapter;
    this.backoff = new Backoff(options.backoff);
    this.losses = new LossLedger((kind, message, entry, cause) =>
      this.report(kind, this.createError(message, cause), {
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
    return this.queueSize === 0 && !this.isPumping;
  }

  /**
   * Lines not yet delivered or given up on, in flight included: what `maxQueueSize` caps,
   * since a line in flight is held in memory exactly as a queued one is.
   */
  public get queueSize(): number {
    return this.slots.length - this.head;
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
   * bounds how much an outage can hold. Never starts an open: the reopen timer does that,
   * so a busy log loop during an outage is not a syscall storm.
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
   * connection is still in flight (see {@link ORPHAN_SETTLE_MS}), and once `maxQueueSize`
   * lines are in flight.
   */
  public pump(): void {
    if (this.isPumping) {
      return;
    }

    this.isPumping = true;
    this.isPassStopped = false;

    try {
      while (
        this.state === 'connected' &&
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
    const queued = this.compactSlots();
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
   * attempt; see {@link outages}. Not reported while closing: `close()` is about to
   * account for the backlog itself, and its abandon report carries this as its cause. A
   * suppressed one, or one made while closing, is recorded in `lastError` and no budget
   * is spent.
   */
  public reportOpenFailure(
    kind: SinkFailureKind,
    message: string,
    cause: unknown,
    isDiagnostic = false,
    shouldSuppressFailureReport = false,
  ): void {
    // A late answer from an open `close()` stopped waiting for describes nothing left.
    if (this.closed) {
      return;
    }

    const failure = new Error(message, { cause });

    this.lastOpenFailure = failure;
    this.lastOpenFailureAttempt = this.openAttemptsStarted;

    if (this.closing || shouldSuppressFailureReport) {
      this.lastError = failure;

      return;
    }

    this.outages.reportFailure(kind, message, cause, isDiagnostic);
  }

  /**
   * Start recovering a lost connection, unless recovery is already under way.
   *
   * Only one attempt may be in flight, because two concurrent opens could each obtain a
   * handle and one would be orphaned. A new outage opens at once (see
   * {@link claimImmediateReopen}); one already under way waits out the backoff on the
   * timer. Nothing else starts an
   * attempt: the timer alone drives recovery from there.
   */
  public ensureConnection(request: OpenRequest = {}): void {
    if (this.closing || this.closed || this.state === 'connected') {
      return;
    }

    // Recovery may be under way - an open in flight, or a timer armed by the failed write
    // that took the connection, which is told before the stream's own error event - or
    // not: either way this request's routing goes with the outage.
    this.outageRouting = mergeOpenRequests(this.outageRouting, request);

    if (this.state === 'opening' || this.isReconnecting) {
      return;
    }

    if (this.reopenTimer !== undefined) {
      return;
    }

    if (this.claimImmediateReopen()) {
      void this.startOpen('automatic', this.outageRouting);
    } else {
      this.armReopen(this.backoff.next());
    }
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
      // A new outage, routed by what ended it.
      this.outageRouting = request;
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

        // That attempt connected: this call's answer is already in hand, and dropping a
        // connection that has just opened would only risk it. (Widened: the await above
        // moved the state on from the `'opening'` this branch was entered with.)
        if ((this.state as ConnectionState) === 'connected') {
          return { success: true };
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
      this.resetBackoff();

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
   * Wait for the queue to empty, within `timeoutMS`, counting in the chained windows of
   * {@link flushes}.
   *
   * Resolves when the queue is empty and no open is in flight; when the destination is
   * not open and either an attempt started after this call has failed or the next one
   * falls after the deadline (`timedOut: false`, `success: false`, the lines still
   * queued); or at the deadline (`timedOut: true`). Never skips the backoff.
   *
   * `startTime` is the caller's clock, read before it validated anything, so a flush that
   * waited behind another still answers within its own timeout.
   */
  public async flush(
    timeoutMS: number,
    startTime = Date.now(),
  ): Promise<FlushResult> {
    const result = await this.flushes.run(timeoutMS, async (window) => {
      const firstAttempt = this.openAttemptsStarted + 1;

      for (;;) {
        // An open in flight is still work: a flush right after construction answers once
        // the destination has opened, not before it was ever tried.
        if (this.isDrained && this.state !== 'opening') {
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

  private createError(message: string, cause?: Error): Error {
    return (
      this.options.createError?.(message, cause) ??
      new Error(message, cause === undefined ? undefined : { cause })
    );
  }

  private firstQueued(): DeliverySlot | undefined {
    if (this.queueSize === this.inFlightCount) {
      return undefined;
    }

    // Resumed from where the last search stopped: the slots before it are in flight, so a
    // pass dispatching a run of lines walks past each of them once rather than every time.
    for (
      let index = Math.max(this.head, this.queuedFrom);
      index < this.slots.length;
      index++
    ) {
      const slot = this.slots[index];

      if (slot.state !== 'in_flight') {
        this.queuedFrom = index;

        return slot;
      }
    }

    return undefined;
  }

  private isDispatchBlocked(): boolean {
    if (this.staleInFlight > 0) {
      return true;
    }

    const maxInFlight = Math.min(
      this.adapter.maxInFlight,
      this.options.maxQueueSize ?? Infinity,
    );

    return (
      this.inFlightCount >= maxInFlight ||
      this.inFlightCount + this.releasedWrites.size >= this.adapter.maxInFlight
    );
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
          // A write released as an orphan answering at last: it frees its place under
          // `maxInFlight`, and a success whose line is still waiting in the queue - never
          // sent again, since that place was held - is that line delivered rather than one
          // to write twice. Past its bound it holds no place, and `settle` ignores it: the
          // slot's token has moved on.
          if (this.freeReleasedWrite(token)) {
            if (
              outcome.status === 'written' &&
              slot.state === 'queued' &&
              this.slots.includes(slot, this.head)
            ) {
              this.removeSlot(slot);
              this.totalWritten++;
            }

            this.pump();

            return;
          }

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

    switch (outcome.status) {
      case 'written': {
        this.removeSlot(slot);
        this.totalWritten++;

        // A late answer from a replaced connection says nothing about the outage the
        // current one may be in.
        if (isCurrent) {
          this.consecutiveFailures = 0;
          this.latestWriteFailure = undefined;
          this.resetBackoff();
        }

        return;
      }
      case 'unavailable': {
        this.isPassStopped = true;

        // The destination is gone, whatever the adapter still holds: let it go, and
        // the line waits in its place, its attempts unspent, for the next connection.
        this.leaveFlight(slot);
        this.enforceQueueLimit();

        if (!this.closing && this.state === 'connected') {
          this.dropConnection();
          this.scheduleReopen();
        }

        return;
      }
      case 'failed': {
        // A write failing on a connection already lost or replaced is not the failure
        // that ended it: the line was buffered behind that one, and a stream fails every
        // buffered write with the same error. Held as an outage holds it - its attempts
        // unspent, nothing reported - unless it may have delivered part of the line.
        if (!isCurrent && outcome.isRetryable) {
          this.leaveFlight(slot);
          this.enforceQueueLimit();
          // A connection that replaced the lost one takes it from here; nothing else
          // would drive a pass when this failure lifted no barrier.
          this.pump();

          return;
        }

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
    const willRetry =
      outcome.isRetryable && slot.attempts < this.options.maxRetries;

    if (isCurrent) {
      this.latestWriteFailure = toError(outcome.error);
    }
    // The reopen this failure may ask for is routed by the line that failed, which a line
    // given up on no longer leaves in the queue for the timer to read.
    const reopenRequest: OpenRequest = {
      isDiagnosticRetry: isDiagnosticEntry(slot.entry),
      shouldSuppressRetryReport: slot.shouldSuppressFailureReport,
    };
    const report = {
      attempt: slot.attempts + 1,
      entry: slot.entry,
      // A synchronous throw came from the connection in hand by definition, and has
      // always counted against it.
      ...(isSynchronous ? {} : { countsAgainstHealth: isCurrent }),
    };

    if (!willRetry) {
      // Out of attempts, or - for a write that may have delivered part of the line - never
      // to be replayed. Gone from the queue and counted before anyone is told.
      this.removeSlot(slot);
      this.losses.count('write');
      this.report('write', outcome.error, {
        ...report,
        shouldSuppressFailureReport: this.shouldSuppressWriteReport(
          slot,
          false,
        ),
        disposition: 'lost',
      });

      // The write failed whether or not the line comes back, so a connection it left
      // unusable is let go and reopened here too: nothing else would, when the
      // destination tore itself down without an error event.
      this.afterFailedWrite(reopenRequest);

      return;
    }

    // Reported before the retry is committed, the slot still marked in flight with its
    // token cleared: nothing can settle it twice, and nothing a handler does can evict it.
    const shouldSuppress = this.shouldSuppressWriteReport(slot, true);
    const didReport = this.report('write', outcome.error, {
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

    // The line keeps its place whatever the handler did: it is in flight until this
    // returns, so its own lines cannot evict it, and a `close()` it called takes the line
    // in its drain.
    this.keepForRetry(slot, reopenRequest);
  }

  /**
   * Put a failed line back in its place for another attempt, and carry on. Queued again,
   * it can be evicted like any other queued line, should the queue be over its cap.
   */
  private keepForRetry(slot: DeliverySlot, reopenRequest: OpenRequest): void {
    slot.attempts++;
    this.leaveFlight(slot);
    this.enforceQueueLimit();
    this.afterFailedWrite(reopenRequest);
  }

  /**
   * Drive recovery after a write failed, whether its line went back in the queue or was
   * given up on.
   *
   * While closing, a connection the failure left unusable is only let go: `close()` drives
   * its own drain every pass, and makes its own bounded attempts to reopen a connection
   * lost while it drains. Otherwise the queue goes out through the connection in hand, or -
   * when the failure left it unusable - the connection is let go and the timer reopens it:
   * at once for the first attempt of an outage, then after the backoff.
   */
  private afterFailedWrite(reopenRequest: OpenRequest): void {
    if (this.closed) {
      return;
    }

    if (this.closing) {
      // Let go now, as outside a close, so the writes the stream fails behind this one
      // arrive from a lost connection and are held rather than each spending an attempt.
      if (this.state === 'connected' && !this.adapter.isUsable()) {
        this.dropConnection();
      }

      return;
    }

    if (this.state !== 'connected') {
      // A later failure from the connection already let go still has a say in how the
      // reopens it is waiting on are routed - armed, or already in flight.
      this.outageRouting = mergeOpenRequests(this.outageRouting, reopenRequest);

      return;
    }

    if (this.adapter.isUsable()) {
      if (!this.awaitingDrain) {
        this.pump();
      }

      return;
    }

    this.dropConnection();
    this.scheduleReopen(reopenRequest);
  }

  /**
   * Arm the reopen timer after a lost connection: due at once for the first attempt of an
   * outage, as {@link ensureConnection} makes it, then after the backoff. On the timer even
   * when due at once, so the attempt starts outside the write outcome that asked for it.
   */
  private scheduleReopen(request: OpenRequest = {}): void {
    // A new outage, routed by what ended it.
    this.outageRouting = request;
    this.armReopen(this.claimImmediateReopen() ? 0 : this.backoff.next());
  }

  /**
   * Whether the next automatic attempt is the outage's first, made at once - claiming it,
   * so a destination that opens and then fails every write waits out the backoff from
   * then on.
   */
  private claimImmediateReopen(): boolean {
    if (!this.backoff.isAtRest || this.hasReopenedAtOnce) {
      return false;
    }

    this.hasReopenedAtOnce = true;

    return true;
  }

  /** The destination worked, or the caller asked by name: the next outage starts afresh. */
  private resetBackoff(): void {
    this.backoff.reset();
    this.hasReopenedAtOnce = false;
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
    if (this.clearFlight(slot)) {
      // Queued again somewhere behind where the search for a queued slot had got to.
      this.queuedFrom = this.head;
    }
  }

  /** The in-flight bookkeeping for a slot leaving flight. Answers whether it was in flight. */
  private clearFlight(slot: DeliverySlot): boolean {
    if (slot.state !== 'in_flight') {
      return false;
    }

    slot.state = 'queued';
    this.inFlightCount--;

    if (
      this.staleInFlight > 0 &&
      slot.generation !== this.connectionGeneration
    ) {
      this.staleInFlight--;
    }

    return true;
  }

  /** Take a slot out of the queue for good. */
  private removeSlot(slot: DeliverySlot): void {
    this.clearFlight(slot);
    slot.token = undefined;

    // Outcomes arrive in write order, so the slot is almost always at the head, and leaves
    // by the head advancing past it.
    if (this.slots[this.head] === slot) {
      this.head++;

      if (this.head === this.slots.length) {
        this.slots = [];
        this.head = 0;
        this.queuedFrom = 0;
        // The last line confirmed or given up on drains the queue - nothing queued or in
        // flight - which closes the reported overflow episode, so a sink that overflows
        // again hours later says so again. The one place that happens while the sink
        // runs: eviction always leaves `maxQueueSize` (at least 1) lines, and only
        // `close()` abandons the rest at once. Not after a pass: with no in-flight cap,
        // no pass follows the confirmation that empties the queue.
        this.losses.endOverflowEpisode();
      } else if (this.head * 2 >= this.slots.length) {
        this.compactSlots();
      }

      return;
    }

    const index = this.slots.indexOf(slot, this.head);

    if (index >= 0) {
      this.slots.splice(index, 1);
      // The slots after it moved up by one.
      this.queuedFrom = this.head;
    }
  }

  /**
   * The queue as an array of exactly its live slots, for the paths that hand it on or
   * search it whole. Linear, and only where the work it feeds is linear anyway.
   */
  private compactSlots(): DeliverySlot[] {
    if (this.head > 0) {
      this.slots = this.slots.slice(this.head);
      this.queuedFrom = Math.max(0, this.queuedFrom - this.head);
      this.head = 0;
    }

    return this.slots;
  }

  /**
   * Discard the oldest queued lines once the queue is over `maxQueueSize`, and report the
   * first eviction of the episode. Never a line in flight: it may already be written.
   *
   * A line an explicit `onError` was told is `'retrying'` gets a `'queue_full'`/`'lost'`
   * report of its own when it is evicted, so every `'retrying'` has a final word; owners
   * and the console keep the one report per episode.
   */
  private enforceQueueLimit(): void {
    const limit = this.options.maxQueueSize;

    // Every enqueue comes through here, so a queue within its cap allocates nothing.
    if (limit === undefined || this.queueSize <= limit) {
      return;
    }

    const owed: DeliverySlot[] = [];

    // Not compacted first: at the cap every enqueue evicts, and the oldest queued line sits
    // at the head, or just behind the lines in flight. Evicting it advances the head.
    const sampled = this.losses.evict(
      this.slots,
      limit,
      (cap) => this.options.messages.queueFull(cap),
      {
        isEvictable: (slot) => slot.state !== 'in_flight',
        occupancy: this.queueSize,
        start: this.head,
        // Before the episode's report, whose handler may write to this sink.
        onSettled: (start) => {
          this.head = start;

          // Evicting moved the slots that stayed.
          this.queuedFrom = this.head;

          // The dead prefix is let go once it outgrows the live queue, as `removeSlot`
          // does.
          if (this.head * 2 >= this.slots.length) {
            this.compactSlots();
          }
        },
        onEvicted: (slot) => {
          // Its line is gone, so a released write still running for it holds nothing.
          this.freeHoldFor(slot);

          if (slot.hasReportedRetrying === true) {
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
        this.createError(this.options.messages.queueFull(limit)),
        { disposition: 'lost', entry: slot.entry },
      );
    }
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
    this.openKind = kind;
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

      // A later outage is a new fact and is reported as one, and routed by its own cause.
      this.outages.clear();
      this.lastOpenFailure = undefined;
      this.didLastOpenSucceed = true;
      this.outageRouting = undefined;
      this.pump();

      return;
    }

    this.lastFailedAttempt = attemptNumber;
    this.didLastOpenSucceed = false;

    // An attempt that failed quietly - a pipe with no reader - leaves no failure of its
    // own, and an older one no longer says why the destination is unavailable now.
    if (this.lastOpenFailureAttempt !== attemptNumber) {
      this.lastOpenFailure = undefined;
    }

    if (this.state === 'opening') {
      this.state = 'cooling_down';
    }

    // Every failed open arms the next attempt, which is what makes recovery independent of
    // traffic: a destination recreated, a reader restarted or a permission fixed during a
    // quiet minute is picked up without waiting for the next log call.
    this.armReopen(this.backoff.next());
  }

  /**
   * Try again after `delayMS`, on one `unref`'d timer.
   *
   * Never called with a timer already armed: {@link ensureConnection} returns when one is,
   * {@link scheduleReopen} runs only as a connection is let go - and nothing arms a timer
   * while connected - and {@link settleOpen} follows an attempt whose start cleared it.
   */
  private armReopen(delayMS: number): void {
    if (this.closing || this.closed) {
      return;
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
   * The reopen timer fired. Its routing comes from what is queued now, and from what asked
   * for this outage's reopens ({@link outageRouting}): a queue holding only lines forwarded
   * from a console report, and diagnostics, is suppressed, as the failure that queued them
   * would have been, and so is one emptied by giving such a line up - for every attempt
   * until one opens, not only the first. Ordinary work queued outranks either; see
   * {@link openRouting}.
   */
  private onReopenTimer(): void {
    if (
      this.closing ||
      this.closed ||
      this.state === 'connected' ||
      this.state === 'opening' ||
      this.isReconnecting
    ) {
      return;
    }

    const queued = this.compactSlots();
    const armedFor = this.outageRouting ?? {};
    const request: OpenRequest = {
      isDiagnosticRetry: armedFor.isDiagnosticRetry === true,
      shouldSuppressRetryReport:
        armedFor.shouldSuppressRetryReport === true ||
        (queued.some((slot) => slot.shouldSuppressFailureReport) &&
          queued.every(
            (slot) =>
              slot.shouldSuppressFailureReport || isDiagnosticEntry(slot.entry),
          )),
    };

    void this.startOpen('automatic', request);
  }

  /** Bound the generation barrier; see {@link ORPHAN_SETTLE_MS}. */
  private armOrphanTimer(): void {
    this.clearOrphanTimer();

    const generation = this.connectionGeneration;
    const timer = setTimeout(() => {
      this.orphanTimer = undefined;
      this.releaseOrphans(generation);
    }, this.options.orphanSettleMS ?? ORPHAN_SETTLE_MS);

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
   * Keep a released write's place under `maxInFlight` until it answers, or for one more
   * {@link ORPHAN_SETTLE_MS} if it does not. See {@link releasedWrites}.
   */
  private holdReleasedWrite(token: object, slot: DeliverySlot): void {
    const timer = setTimeout(() => {
      if (this.releasedWrites.delete(token)) {
        this.pump();
      }
    }, this.options.orphanSettleMS ?? ORPHAN_SETTLE_MS);

    timer.unref?.();
    this.releasedWrites.set(token, { timer, slot });
  }

  /** Let a released write's place go. Answers whether it was still holding one. */
  private freeReleasedWrite(token: object): boolean {
    const hold = this.releasedWrites.get(token);

    if (hold === undefined) {
      return false;
    }

    clearTimeout(hold.timer);
    this.releasedWrites.delete(token);

    return true;
  }

  /** Let go of any hold kept for `slot`'s line, which has left the queue. */
  private freeHoldFor(slot: DeliverySlot): void {
    for (const [token, hold] of this.releasedWrites) {
      if (hold.slot === slot) {
        this.freeReleasedWrite(token);
      }
    }
  }

  /**
   * Stop waiting for writes still in flight on a replaced connection: each counts as a
   * spent attempt and goes back to the queue - possibly to be written twice, never lost -
   * and its late callback is ignored. One out of attempts is given up on and said once.
   * Where the adapter holds released writes, one whose line goes out again keeps its place
   * until it answers, for a bounded time, and a late success counts the line as written:
   * see {@link releasedWrites}.
   */
  private releaseOrphans(generation: number | undefined): void {
    if (this.connectionGeneration !== generation || this.staleInFlight === 0) {
      return;
    }

    this.staleInFlight = 0;

    for (const slot of [...this.compactSlots()]) {
      if (
        slot.state !== 'in_flight' ||
        slot.token === undefined ||
        slot.generation === generation
      ) {
        continue;
      }

      const token = slot.token;

      slot.token = undefined;

      if (slot.attempts < this.options.maxRetries) {
        // Held only for a line that goes out again, and not while closing: `close()` has
        // already let every hold go, and must not wait on a new one.
        if (this.adapter.holdsReleasedWrites === true && !this.closing) {
          this.holdReleasedWrite(token, slot);
        }

        slot.attempts++;
        this.leaveFlight(slot);

        continue;
      }

      // Gone from the queue and counted before anyone is told.
      this.removeSlot(slot);
      this.losses.count('write');
      this.report(
        'write',
        this.createError(this.options.messages.unconfirmed(slot.attempts + 1)),
        {
          attempt: slot.attempts + 1,
          disposition: 'lost',
          entry: slot.entry,
          shouldSuppressFailureReport: slot.shouldSuppressFailureReport,
          // The connection that never answered is already gone, so this says nothing
          // about whatever replaced it.
          countsAgainstHealth: false,
        },
      );

      // Re-checked: the handler may have closed the sink.
      if (this.closing || this.closed) {
        return;
      }
    }

    this.pump();
  }

  private async closeInternal(): Promise<void> {
    const startTime = Date.now();
    const timeoutMS = this.options.closeTimeoutMS;

    // A released write still unanswered must not hold the drain for the whole budget: it
    // may never answer, and its line is already back in the queue.
    for (const hold of this.releasedWrites.values()) {
      clearTimeout(hold.timer);
    }

    this.releasedWrites.clear();

    // A reopen already in flight shares the close's grace window below rather than having
    // the whole budget: past the window, an open that hangs is not waited for. The first
    // open, from the constructor, is waited for within the budget, and the window starts
    // after it.
    const isReopening = this.state === 'opening' && this.openKind !== 'initial';
    const reopenWindowMS = Math.min(CLOSE_REOPEN_GRACE_MS, timeoutMS);

    // Wait for an attempt in flight, bounded. Losing it remains observed after the
    // deadline.
    try {
      await raceDeadline(
        this.openPromise,
        isReopening ? reopenWindowMS : timeoutMS,
        () => undefined,
      );
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
    let reopenGraceUntil =
      (isReopening ? startTime : Date.now()) + reopenWindowMS;

    // Whether the destination has been in hand since the last grace window: what tells a
    // connection lost mid-drain - a reader restarting under a close with a backlog - from
    // one that never came back. Read on both sides of the wait, so a connection lost in
    // between still earns its window.
    let hasHadConnection = this.adapter.hasConnection();

    hasHadConnection =
      (await this.reopenWithinGrace(startTime, reopenGraceUntil)) ||
      hasHadConnection;

    // Whether a destination was in hand at any point of this close, unlike
    // `hasHadConnection`, which each grace window resets: what tells a backlog abandoned
    // for a connection lost from one abandoned for a destination that never opened.
    let didHoldConnection = hasHadConnection;

    // Drain what the destination can still take before giving up on it - a line in flight
    // included, since its write may still fail and need another attempt. The deadline
    // bounds the wait.
    while (!this.isDrained && Date.now() - startTime <= timeoutMS) {
      if (this.adapter.hasConnection()) {
        hasHadConnection = true;
        didHoldConnection = true;
      } else if (this.state === 'opening' && Date.now() < reopenGraceUntil) {
        // An open in progress counts as work to wait for, within the grace window it was
        // made in: past it, an open that hangs must not hold the close for its whole
        // budget.
      } else if (hasHadConnection) {
        // Lost mid-drain: the same bounded grace the close began with, from now, rather
        // than abandoning a backlog a destination back moments later would have taken.
        // Once per connection held, so a destination that does not come back ends it.
        if (this.state === 'connected') {
          this.dropConnection();
        }

        reopenGraceUntil =
          Date.now() +
          Math.min(CLOSE_REOPEN_GRACE_MS, timeoutMS - (Date.now() - startTime));
        hasHadConnection = await this.reopenWithinGrace(
          startTime,
          reopenGraceUntil,
        );

        continue;
      } else {
        break;
      }

      // Asked for explicitly: nothing else drives a pass while this loop is awaiting, and
      // the queue may have been left parked by a failed write rather than by backpressure.
      this.pump();

      await sleep(CLOSE_DRAIN_POLL_MS);
    }

    // Read before the adapter hears the close: why what is left is being abandoned, and the
    // failure behind it. Out of budget with the destination in hand or an open pending is
    // a timeout. Otherwise the grace window ran out first: with the latest open failed or
    // still pending, for want of a destination; with it succeeded, the connection it made
    // was lost again, and if writes are failing that is what the report says.
    const isOpenPending = this.state === 'opening';
    const isOutOfBudget = Date.now() - startTime >= timeoutMS;
    let abandon: { reason: CloseAbandonReason; cause?: Error };

    if (this.adapter.hasConnection() || (isOpenPending && isOutOfBudget)) {
      abandon = {
        reason: 'timeout',
        cause:
          this.latestWriteFailure ??
          (this.adapter.hasConnection() ? undefined : this.lastOpenFailure),
      };
    } else if (
      !isOpenPending &&
      this.didLastOpenSucceed &&
      this.latestWriteFailure !== undefined
    ) {
      abandon = { reason: 'write_failed', cause: this.latestWriteFailure };
    } else {
      abandon = {
        reason: didHoldConnection ? 'connection_lost' : 'never_opened',
        cause: this.lastOpenFailure,
      };
    }

    // Closed is not healthy, and not connected either.
    this.state = 'closed';
    this.clearReopenTimer();
    this.clearOrphanTimer();
    this.adapter.onClosed?.();

    // What is left of the *whole* close's budget, so the open wait, the drain and the final
    // flush share one deadline.
    const remainingMS = (): number => timeoutMS - (Date.now() - startTime);

    await this.closeOnEvidence(remainingMS, abandon);
  }

  /**
   * Keep asking for the destination, until `graceUntil`, while a close has a backlog and
   * nothing to write it with. Spaced by {@link CLOSE_REOPEN_POLL_MS}. Answers whether it
   * ends with a connection in hand.
   */
  private async reopenWithinGrace(
    startTime: number,
    graceUntil: number,
  ): Promise<boolean> {
    while (
      this.queueSize > 0 &&
      !this.adapter.hasConnection() &&
      this.state !== 'opening' &&
      Date.now() < graceUntil &&
      Date.now() - startTime < this.options.closeTimeoutMS
    ) {
      await this.reopenForClose(startTime, graceUntil);

      if (this.adapter.hasConnection()) {
        break;
      }

      // Spaced out, so a destination that never comes back costs a handful of attempts
      // across the window rather than a spin.
      await sleep(CLOSE_REOPEN_POLL_MS);
    }

    return this.adapter.hasConnection();
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
   * that is being torn down anyway. The report says why, with the failure behind it as
   * its cause; see {@link DeliveryMessages.abandoned}.
   */
  private abandonOnClose(
    isAbandoned: (slot: DeliverySlot) => boolean,
    abandon: { reason: CloseAbandonReason; cause?: Error },
  ): void {
    const abandoned = new Set(this.compactSlots().filter(isAbandoned));

    // Their outcomes, should any still arrive, no longer have a slot to settle.
    for (const slot of abandoned) {
      this.leaveFlight(slot);
      slot.token = undefined;
    }

    this.losses.abandon(
      this.compactSlots(),
      (count) => this.options.messages.abandoned(count, abandon.reason),
      (slot) => abandoned.has(slot),
      abandon.cause,
    );
    this.queuedFrom = 0;
  }

  /**
   * Settle the writes in flight on evidence before `close()` resolves.
   *
   * Queued lines, and in-flight ones never handed over, are abandoned. Committed writes
   * are left to the destination's own end; once they have answered - at least one
   * macrotask after it, and at most {@link CLOSE_SETTLE_MS} - a write that succeeded counts
   * as written, a write that failed is counted `'close'` and reported once - with the bytes
   * the destination still held - and a write still unsettled is reported once as unknown:
   * uncounted, since it may well have arrived. Any later callback is ignored, the report
   * sent before `close()` resolved being its only word.
   */
  private async closeOnEvidence(
    remainingMS: () => number,
    abandon: { reason: CloseAbandonReason; cause?: Error },
  ): Promise<void> {
    this.abandonOnClose(
      (slot) => slot.state !== 'in_flight' || !slot.committed,
      abandon,
    );

    const settlement: CloseSettlement = { failed: [] };

    this.closeSettlement = settlement;

    let bytesLeft = 0;

    try {
      bytesLeft = await this.adapter.end(remainingMS());
      // The callbacks a destination's teardown triggers arrive on a later turn.
      await nextMacrotask();

      const settleUntil = Date.now() + CLOSE_SETTLE_MS;

      while (this.hasUnsettledWrites() && Date.now() < settleUntil) {
        await sleep(CLOSE_SETTLE_POLL_MS);
      }
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

    const unsettled = this.compactSlots().filter(isUnsettled);

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

  private hasUnsettledWrites(): boolean {
    return this.compactSlots().some(isUnsettled);
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
