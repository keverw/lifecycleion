import { raceDeadline } from '../../internal/race-deadline';
import { isNullish } from '../../internal/is-nullish';
import fs, { promises as fsPromises } from 'fs';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import {
  isConsoleReportActive,
  reportToConsole,
} from '../../internal/report-to-console';
import { renderJSONLine } from './internal/render-json-line';
import { renderTextEntry } from './internal/render-text-line';
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  resolveMaxQueueSize,
  resolveMaxRetries,
} from './internal/queue-policy';
import {
  assertNumberOption,
  resolveTimeoutMS,
} from '../../internal/timer-limits';
import {
  reportSinkError,
  type DroppedEntryCounts,
  type SinkErrorHandler,
  type SinkFailureDisposition,
  type SinkFailureKind,
} from './internal/sink-failure';
import { describeEntryCount, LossLedger } from './internal/loss-ledger';
import { endStreamWithin } from './internal/end-stream';
import { deferClose } from './internal/deferred-close';
import { FormatReportScheduler } from './internal/format-report-scheduler';

import type { LogEntry, LogSink, LoggerDiagnostic } from '../types';
import { LogLevel, getLogLevel } from '../types';
import { diagnosticEntry } from '../internal/diagnostic-entry';
import { isDiagnosticEntry } from '../internal/sink-failure-routing';
import { sleep } from '../../sleep';

export type {
  SinkErrorHandler,
  SinkFailure,
  SinkFailureKind,
} from './internal/sink-failure';

/**
 * How many names one rotation will try before it accepts a collision.
 *
 * Only reached when two rotations share a millisecond, so a handful is already generous;
 * the bound is here because the queue is parked for the whole of a rotation and an
 * unbounded search for a free name would park it on a directory this cannot control.
 */
const MAX_ROTATION_NAME_ATTEMPTS = 100;

/** Megabytes a log file grows to before it is rotated, where the caller named nothing. */
const DEFAULT_MAX_SIZE_MB = 10;

/** Failed archive renames retry on later writes, with bounded exponential backoff. */
const ROTATION_RETRY_INITIAL_MS = 1000;
const ROTATION_RETRY_MAX_MS = 30_000;

/**
 * The rotation threshold this sink will honour, in megabytes.
 *
 * The sibling of `resolveMaxQueueSize` and `resolveMaxRetries`, and here for a sharper
 * reason than tidiness: a threshold of zero or less makes a *freshly opened, empty* file
 * satisfy `currentLogSize >= maxSizeBytes`, so `setupLogFile` rotates it, reopens, and
 * finds the new empty file over the limit as well. That loop never yields to anything
 * that could stop it - `initPromise` never settles, so `flush()` hangs and `close()` can
 * only time out - and every pass reserves a fresh collision-free archive name, so it
 * fills the log directory as fast as the disk will take files.
 *
 * `Infinity` is left alone: it is the honest spelling of "never rotate on size". Zero or
 * negative takes the default rather than being honoured literally. `NaN` or a non-number
 * from untyped config throws, the same answer the queue options and `closeTimeoutMS` give.
 */
function resolveMaxSizeMB(requested?: number | null): number {
  if (isNullish(requested)) {
    return DEFAULT_MAX_SIZE_MB;
  }

  assertNumberOption(requested, 'FileSink maxSizeMB');

  return requested > 0 ? requested : DEFAULT_MAX_SIZE_MB;
}

/**
 * `basename` as given, or a throw for one that would leave `logDir`.
 *
 * The file name is `logDir` joined with `basename`, and nothing between them resolved
 * the result: `basename: '../../outside'` wrote and rotated two directories up. That is
 * app configuration rather than request input, so this is a trust-boundary check, not a
 * defence - but a sink whose whole promise is "these files live in `logDir`" should not
 * break that promise on a config typo either. Refused at construction, where a bad
 * option is a bug to fix rather than a log file to hunt for.
 */
function resolveBasename(requested: string): string {
  if (
    typeof requested !== 'string' ||
    requested.length === 0 ||
    requested === '.' ||
    requested === '..' ||
    requested.includes('/') ||
    requested.includes('\\') ||
    hasControlCharacter(requested)
  ) {
    throw new FileSinkError(
      `FileSink basename must be a file name inside logDir, without path separators or control characters; got ${JSON.stringify(requested)}`,
    );
  }

  return requested;
}

/**
 * Whether a name carries a C0 control character or `DEL`.
 *
 * A `NUL` is the one that matters: on a path it reaches `fs`, Node refuses it with
 * `ERR_INVALID_ARG_VALUE` - asynchronously, from `initialize()`, after the constructor
 * that promised to refuse a bad name has already returned. The rest are refused with it
 * because a log file whose name holds a newline or an escape sequence is a name nothing
 * lists or greps cleanly, and a config typo is the only way one arrives.
 */
function hasControlCharacter(name: string): boolean {
  for (const character of name) {
    const code = character.codePointAt(0) ?? 0;

    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

export interface FileSinkOptions {
  logDir: string;
  /**
   * Base file name, a single path segment: no `/` or `\\`, no control characters, and
   * not `.` or `..`.
   *
   * One writing process per `logDir` + `basename`: rotation reserves an archive name by
   * checking for it and then renaming onto it, and rotations are serialized on this sink
   * only. Two processes sharing a log file can race that reservation and overwrite each
   * other's archive. Give each process its own `basename`.
   */
  basename: string;
  maxSizeMB?: number | null;
  jsonFormat?: boolean;
  maxRetries?: number | null;
  /**
   * Close budget in ms (default: 30000). Null or undefined uses the default.
   * NaN/other non-numbers throw TypeError; negatives throw RangeError.
   * Zero retains the final-flush minimum; Infinity is timer-capped.
   */
  closeTimeoutMS?: number | null;
  minLevel?: LogLevel;
  /**
   * Cap on entries waiting to be written. Defaults to 10,000; pass `-1` to hold
   * everything with no cap.
   *
   * The queue grows whenever writes fail or stall - a full disk, a directory that went
   * away, a slow volume - and every queued entry holds its rendered line *and* the
   * `LogEntry`, whose `params` is the caller's own object by reference. So a sink that
   * cannot write turns a logging loop into unbounded memory growth, on exactly the
   * unhealthy path where the process can least afford it. That is why the cap is on by
   * default rather than waiting to be asked for.
   *
   * The **oldest** entry is dropped to make room, on the reasoning that during an outage
   * the newest lines describe what is happening now. Drops are counted in
   * {@link FileSinkHealth.droppedEntries} and the first one is reported through
   * `onError`, so a silently truncated log is never the only evidence.
   *
   * Shared with `NamedPipeSink`, which reads the same option the same way.
   */
  maxQueueSize?: number | null;
  /**
   * Notified when this sink cannot do its job, in the shape every sink reports.
   * Explicit handlers take precedence. With no handler, failures go to owning
   * loggers, or to guarded console output when this sink has no owner. Failures
   * while writing diagnostic entries go directly to the console.
   *
   * One object rather than four positional arguments, and the same one `NamedPipeSink`
   * hands back: `kind` says what failed, `target` which file it was writing to at the
   * time, `entry` / `attempt` which line and try, and `disposition` what became of the
   * line - `'lost'` is the one that means write it somewhere else, and the `willRetry`
   * boolean it replaced could not say that. See {@link SinkFailure}.
   */
  onError?: SinkErrorHandler;
}

export interface FileSinkHealth {
  isHealthy: boolean;
  queueSize: number;
  lastError?: Error;
  /**
   * Failed writes since the last successful one.
   *
   * Write failures only, as in `NamedPipeSinkHealth.consecutiveFailures`: a `'format'`
   * failure never reached the file and says nothing about whether this sink can write,
   * so counting it would report a working sink as broken.
   */
  consecutiveFailures: number;
  isInitialized: boolean;
  /**
   * Entries this sink did not deliver - evicted at `maxQueueSize`, or still queued when
   * `close()` gave up on them. Always 0 when neither has happened.
   */
  droppedEntries: number;
  /** `droppedEntries` by reason. See {@link DroppedEntryCounts}. */
  droppedByKind: DroppedEntryCounts;
}

export interface FlushResult {
  success: boolean;
  /**
   * Entries written since the previous flush returned, or since this sink was made.
   *
   * Counted from the last flush rather than from this call's entry, as
   * {@link FlushResult.entriesFailed} is: a sink is written to between flushes, not only
   * while one is waiting, so a window that opened at the call would answer for none of it.
   */
  entriesWritten: number;
  /**
   * Entries lost since the previous flush returned - retries exhausted, evicted at
   * `maxQueueSize`, or abandoned by `close()`.
   *
   * `getHealth().droppedEntries` is the cumulative figure. Successive flushes partition
   * the losses between them, so each one is reported exactly once.
   */
  entriesFailed: number;
  timedOut: boolean;
}

/**
 * Error handler class for FileSink.
 *
 * `kind` is set where a failure is raised for `processQueue` to classify, and read by
 * `failureKindFor`; an error without one is a failed write.
 */
class FileSinkError extends Error {
  constructor(
    message: string,
    public cause?: Error,
    public readonly kind?: SinkFailureKind,
  ) {
    super(message);
    this.name = 'FileSinkError';
  }
}

/**
 * One entry waiting for the file, with its line already rendered.
 *
 * The render policy is {@link RenderedLine}'s, shared with `NamedPipeSink`. What is added
 * here is this sink's own: the `LogEntry`, because the public `onError` hands it back to the
 * caller, and the attempt count, because this sink retries a write - though never a render.
 */
interface QueuedEntry extends RenderedLine {
  entry: LogEntry;
  attempts: number;
  /** A console fallback may be forwarded here, but must not start another report. */
  shouldSuppressFailureReport?: boolean;
}

/**
 * FileSink writes logs to files with automatic rotation based on size and date
 */
export class FileSink implements LogSink {
  private logDir: string;
  private basename: string;
  private maxSizeMB: number;
  private jsonFormat: boolean;
  private maxRetries: number;
  private minLevel: LogLevel;
  private onError?: SinkErrorHandler;
  private logFileStream?: fs.WriteStream;
  private currentLogFile?: string;
  private currentLogSize = 0;
  private writeQueue: QueuedEntry[] = [];
  private maxQueueSize?: number;
  /**
   * Lines this sink did not deliver, by reason, and the once-per-episode reports for the
   * refused, evicted and abandoned ones. See {@link LossLedger}.
   */
  private readonly losses = new LossLedger((kind, message, entry) => {
    this.handleError(kind, new FileSinkError(message), {
      disposition: 'lost',
      entry,
    });
  });
  /**
   * Where the last {@link flush} stopped counting, so the next one starts there.
   *
   * A flush reports what happened to this sink *since the caller last asked*, not only
   * what happened while it was waiting - see the accounting in `flush()` for why the
   * narrower window let a whole batch of losses go unreported.
   */
  private flushBaselineWritten = 0;
  private flushBaselineDropped = 0;
  /** The flush in flight, if any; see {@link flush}. Never rejects. */
  private pendingFlush: Promise<void> = Promise.resolve(undefined);
  private isInitialized = false;
  private hasFinishedInitialization = false;
  private initPromise?: Promise<void>;
  private isProcessing = false;
  private lastError?: Error;
  private consecutiveFailures = 0;
  private rotationRetryDelayMS = 0;
  private nextRotationAttemptAt = 0;
  private totalEntriesWritten = 0;

  /** The entry {@link processQueue} is waiting on `writeEntry` for, if any. */
  private inFlightEntry?: QueuedEntry;
  /** The entry actually handed to stream.write(), excluding setup and rotation. */
  private activeStreamWriteEntry?: QueuedEntry;

  /**
   * The processing entry close() gave up on, already covered by its queued-loss or
   * in-flight-write report.
   */
  private abandonedInFlightEntry?: QueuedEntry;

  /**
   * Errors a write callback has already reported, so the stream's `'error'` event does not
   * report them again.
   *
   * The same pairing `NamedPipeSink` keeps, and for the same reason: a stream delivers one
   * failed write through both channels, and they know different halves of it. The callback
   * knows which line it was and whether it is coming back; the event knows only that the
   * stream is gone. Reported by both, a consumer got two entries for one failure, the
   * second contradicting the first about the line's fate.
   *
   * Keyed on the error itself rather than a single slot, so an unrelated failure arriving
   * in between cannot consume the entry that was waiting for its own event. Weak, so
   * remembering one cannot keep it alive.
   */
  private readonly suppressedWriteErrors = new WeakSet<object>();

  /**
   * An open that failed while {@link inFlightEntry} was waiting on it, left by the stream's
   * `'error'` handler for `writeEntry` to raise as that entry's `'setup'` failure.
   *
   * Reporting it from the handler too would print a console line for every attempt at
   * every entry, outside the rule `processQueue` keeps for the console: only the attempt
   * that loses the line. Kept with that entry, so a pass that ends before raising it -
   * `close()` winning, say - cannot hand it to a later entry.
   */
  private pendingOpenFailure?: { entry: QueuedEntry; failure: FileSinkError };

  private closing = false;
  private closePromise?: Promise<void>;
  private closed = false;
  private closeTimeoutMS: number;

  /**
   * The `'format'` reports in flight, so an `onError` that logs through this same sink
   * cannot feed the loop that reported it.
   *
   * The shape `NamedPipeSink` guards against in `formatEntry`, reached here by a longer
   * road. A handler that re-logs the failure it was handed serializes the `entry` the
   * failure carries, and the `BigInt` or cycle that made *that* entry unrenderable makes
   * the handler's own line unrenderable too. Queued, that line reaches `processQueue` on
   * its next turn and is reported again - a drain loop that never ends, with every later
   * line stuck behind it. See {@link FormatReportScheduler} for what is delivered to the
   * handler, what waits, and what goes to the console instead.
   */
  private readonly formatReports = new FormatReportScheduler();

  constructor(options: FileSinkOptions) {
    this.closeTimeoutMS = resolveTimeoutMS(
      options.closeTimeoutMS,
      DEFAULT_CLOSE_TIMEOUT_MS,
      'FileSink closeTimeoutMS',
    );

    this.logDir = options.logDir;
    this.basename = resolveBasename(options.basename);
    this.maxSizeMB = resolveMaxSizeMB(options.maxSizeMB);
    this.jsonFormat = options.jsonFormat ?? false;
    this.maxRetries = resolveMaxRetries(
      options.maxRetries,
      'FileSink maxRetries',
    );
    this.minLevel = options.minLevel ?? LogLevel.INFO;
    this.onError = options.onError;
    this.maxQueueSize = resolveMaxQueueSize(
      options.maxQueueSize,
      'FileSink maxQueueSize',
    );

    // Initialize asynchronously.
    //
    // `initialize` reports its own failures and is built never to reject, but `close()`
    // and `flush()` wait on it and queued writes resume afterwards. Contain it here rather
    // than trusted at each wait - the containment `NamedPipeSink.close()` gives its own
    // init wait. Left raw, a rejection from a future change would reject `close()`, a
    // shutdown step that must not raise, and go unhandled out of the constructor while
    // nothing waits on it. Reported, not swallowed, since it would be a bug.
    const initialized = this.initialize().catch((error: unknown) => {
      reportToConsole(
        `FileSink initialization failed unexpectedly: ${describeError(error)}`,
      );
    });
    this.initPromise = initialized.then(() => {
      this.hasFinishedInitialization = true;
      // One observer drains the startup backlog, including after setup failed.
      // Later writes retry setup through processQueue without observing init again.
      void this.processQueue();
    });
  }

  public write(entry: LogEntry): void {
    const shouldSuppressFailureReport = isConsoleReportActive();
    // Check if log level is below minimum threshold (skip for raw logs)
    if (entry.type !== 'raw') {
      const logLevel = getLogLevel(entry.type);
      if (logLevel > this.minLevel) {
        return;
      }
    }

    if (this.closing || this.closed) {
      // Counted and said, not discarded quietly: `close()` waits up to `closeTimeoutMS`,
      // and a line logged in that window is one this sink did not deliver.
      this.losses.refuseAfterClose(
        entry,
        () =>
          `Entry logged after close() began; it was not written, and further ones are counted in droppedEntries without being reported`,
      );

      return;
    }

    // Rendered here rather than on the write path, which runs after `setupLogFile` and
    // `rotateIfNeeded` have been awaited: by then the caller has had the chance to mutate
    // the bag `entry.redactedParams` points at, since redaction no longer copies it.
    const rendered = renderOnce(() => this.formatEntry(entry));

    // Reported here rather than queued, as `NamedPipeSink` reports it. A render is
    // attempted exactly once, so waiting in the queue cannot make this line appear - and
    // queued, it took a slot from real work, and could be evicted at `maxQueueSize` or
    // abandoned by `close()` before the `'format'` report it was owed ever fired.
    if (rendered.formatError !== undefined) {
      this.reportRenderFailure(
        entry,
        rendered.formatError,
        shouldSuppressFailureReport,
      );

      return;
    }

    // Add to queue with retry tracking
    this.writeQueue.push({
      entry,
      attempts: 0,
      ...rendered,
      shouldSuppressFailureReport,
    });
    this.enforceQueueLimit();

    if (this.hasFinishedInitialization) {
      void this.processQueue();
    }
  }

  /**
   * Set the minimum log level for this sink
   */
  public setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  public writeDiagnostic(diagnostic: LoggerDiagnostic): void {
    this.write(diagnosticEntry(diagnostic));
  }

  /**
   * Get the current minimum log level
   */
  public getMinLevel(): LogLevel {
    return this.minLevel;
  }

  /**
   * Get current health status of the sink
   */
  public getHealth(): FileSinkHealth {
    return {
      // Not while closing, either. `close()` clears `isInitialized` only once its drain has
      // finished, so for the whole of that drain - up to `closeTimeoutMS` - a sink that
      // was discarding every new `write()` at the `closing` guard still answered healthy
      // to anything polling it. The same answer `NamedPipeSink` gives.
      isHealthy:
        this.consecutiveFailures === 0 && this.isInitialized && !this.closing,
      queueSize: this.writeQueue.length,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      isInitialized: this.isInitialized,
      droppedEntries: this.losses.droppedEntries,
      droppedByKind: this.losses.droppedByKind(),
    };
  }

  /**
   * Flush all pending writes and wait for completion
   * Returns statistics about the flush operation
   * @param requestedTimeoutMS Maximum time to wait in milliseconds (default: 30000ms /
   *        30s). Null or undefined uses the default. Invalid values reject before a
   *        flush starts: `NaN` and other non-numbers produce TypeError; negative
   *        values produce RangeError. `Infinity` is capped
   *        at the largest timer delay; zero keeps its immediate deadline semantics.
   */
  public async flush(
    requestedTimeoutMS: number | null = DEFAULT_CLOSE_TIMEOUT_MS,
  ): Promise<FlushResult> {
    // Validate before joining the flush queue or advancing any counting window.
    const timeoutMS = resolveTimeoutMS(
      requestedTimeoutMS,
      DEFAULT_CLOSE_TIMEOUT_MS,
      'FileSink flush timeoutMS',
    );

    // The clock starts here, before the wait below rather than after it: `timeoutMS` is
    // documented as the maximum time this call takes, and an init that never settles is
    // exactly the case a caller sets one for.
    const startTime = Date.now();

    // One flush at a time. The counts below are windows between baselines that each
    // flush advances as it settles, which partitions the lines between *successive*
    // flushes exactly once - and two flushes in flight together both read the same
    // baselines before either advanced them, so both reported the same window: two
    // callers each told the same line was written, or the same line lost, and a caller
    // summing results double-counted. Chained rather than shared, since each caller
    // asked about the lines up to its own call. The clock above is this call's, so a
    // flush that waited behind another still answers within its own timeout.
    const previous = this.pendingFlush;
    const run = (async (): Promise<FlushResult> => {
      const isReady = await raceDeadline(
        previous.then(() => true),
        timeoutMS,
        () => false,
      );
      if (!isReady) {
        // This caller never owned a counting window. Its budget includes queueing.
        return {
          success: false,
          entriesWritten: 0,
          entriesFailed: 0,
          timedOut: true,
        };
      }
      return await this.flushWindow(timeoutMS, startTime);
    })();

    // run may time out while previous still owns its counting window. Keep
    // previous in the queue barrier so a third flush cannot overtake it.
    this.pendingFlush = (async (): Promise<void> => {
      try {
        await previous;
        await run;
      } catch {
        // An unsuccessful flush must not strand the next caller's turn.
      }
    })();

    return await run;
  }

  /**
   * Close the log file and wait for all pending writes
   */
  public close(): Promise<void> {
    this.closing = true;
    // Publish ownership before any close-time callback can re-enter close().
    this.closePromise ??= deferClose(() => this.closeInternal());
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    const startTime = Date.now();

    // Wait for initialization with timeout
    if (this.initPromise) {
      // Losing initialization remains observed after the deadline.
      await raceDeadline(
        this.initPromise,
        this.closeTimeoutMS,
        () => undefined,
      );
    }

    // Whether the drain gave up with a write still in flight, rather than with only a
    // backlog left. `abandonQueueOnClose()` reports the backlog; the entry already shifted
    // out of the queue and handed to `stream.write` belongs to neither counter, so a close
    // that timed out mid-write answered exactly like a clean one.
    let didAbandonInFlightWrite = false;

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > this.closeTimeoutMS) {
        didAbandonInFlightWrite = this.activeStreamWriteEntry !== undefined;
        this.abandonedInFlightEntry = this.inFlightEntry;
        // An entry parked in setup or rotation has never reached the stream. Include
        // it in the known queue loss, instead of describing an uncertain write.
        if (!didAbandonInFlightWrite && this.inFlightEntry !== undefined) {
          this.writeQueue.unshift(this.inFlightEntry);
        }

        break;
      }
      await sleep(10);
    }

    this.closed = true;

    // `isHealthy` is `consecutiveFailures === 0 && isInitialized`, computed identically in
    // both sinks, so a file sink that closed cleanly went on reporting itself healthy to
    // anything polling `getHealth()` - with no stream, and `write()` discarding every line
    // at the `closing || closed` guard without even counting it as dropped. Closed is not
    // healthy, the same answer `NamedPipeSink.close()` gives.
    this.isInitialized = false;

    this.abandonQueueOnClose();
    this.reportInFlightWriteOnClose(didAbandonInFlightWrite);

    // Close stream, on what is left of the *whole* close's budget, so the init wait, the
    // drain loop above and the final flush share one deadline. Bounded and floored as
    // `endStreamWithin` describes, and held open by its timer: the caller is awaiting this
    // close, and the report below has to reach it before the process exits.
    const bytesLeft = await this.endCurrentStream(
      this.closeTimeoutMS - (Date.now() - startTime),
      false,
    );

    // What the flush timeout gave up on, said before this resolves - the same report at
    // the same moment as `NamedPipeSink.close()`. This sink writes one line at a time and
    // waits for its callback, so the stream's buffer can hold nothing but the write that
    // was in flight when the drain gave up, and that one is reported just above. This is
    // the backstop for the case the model says cannot happen: bytes the stream still
    // held at the timeout that no report has named. Skipped when the in-flight report
    // fired, since it would describe the same bytes twice.
    //
    // `'no_entry'` and not counted, unlike `NamedPipeSink`'s `'lost'`: those bytes may
    // still reach the file, since destroying the stream does not cancel a write already
    // handed to the filesystem - the same unknown the in-flight report describes.
    if (bytesLeft > 0 && !didAbandonInFlightWrite) {
      this.handleError(
        'close',
        new FileSinkError(
          `Closed with ${String(bytesLeft)} bytes still buffered for ${this.currentLogFile ?? this.logDir} (closeTimeoutMS=${String(this.closeTimeoutMS)}); whether they reached the file is unknown`,
        ),
        { disposition: 'no_entry' },
      );
    }
  }

  /**
   * Report bytes a *rotation's* flush gave up on.
   *
   * `close()` has always named what its flush timeout abandoned; the two rotation paths
   * discarded the same number. A size- or midnight-triggered rotation on a stalled mount
   * ended the stream, waited out `closeTimeoutMS`, then opened the next file and returned
   * - and whatever the old stream still held went with the descriptor, with
   * `entriesFailed: 0`, `droppedEntries: 0` and `onError` never firing. That is the
   * silent-loss shape the close-path report was added to close, reached through the door
   * this sink goes through far more often.
   *
   * `kind: 'write'`, because written lines are what is at risk and nothing is closing;
   * `disposition: 'no_entry'`, because the bytes are a stream buffer rather than any one
   * entry this sink could hand back.
   */
  private reportRotationFlushLoss(bytesLeft: number, target: string): void {
    if (bytesLeft <= 0) {
      return;
    }

    this.handleError(
      'write',
      new FileSinkError(
        `Rotation abandoned ${String(bytesLeft)} bytes still buffered for ${target} (closeTimeoutMS=${String(this.closeTimeoutMS)}); whether they reached the file is unknown`,
      ),
      { disposition: 'no_entry', target },
    );
  }

  /**
   * End the current stream, bounded by `timeoutMS`, and let go of it.
   *
   * The one place this sink ends a stream, because every caller has to: `end()` is what
   * flushes what is buffered, and a stream replaced without it keeps its descriptor and
   * loses its buffer. The bound is needed wherever the sink waits on a flush, not only at
   * `close()`: an unbounded wait on a hung mount suspended a size-triggered rotation's
   * `writeEntry` forever with `isProcessing` still set, so the queue never drained again.
   * See {@link endStreamWithin}.
   *
   * `isBackground` for a rotation, whose deadline must not keep the process alive on a
   * stalled mount; `close()` passes `false`. Answers how many bytes the stream still held
   * when the wait gave up, so the caller can say so.
   */
  private async endCurrentStream(
    timeoutMS: number,
    isBackground: boolean,
  ): Promise<number> {
    const stream = this.logFileStream;
    const bytesLeft =
      stream === undefined
        ? 0
        : await endStreamWithin(stream, timeoutMS, {
            shouldUnref: isBackground,
          });

    // Cleared only if it is still the stream this found: a rotation that ran while `end()`
    // was flushing has already installed its replacement, and clearing unconditionally
    // would drop a live stream on the floor.
    if (this.logFileStream === stream) {
      this.logFileStream = undefined;
      this.isInitialized = false;
    }

    return bytesLeft;
  }

  /**
   * Say so when the close gave up with a write still in flight.
   *
   * `close()` documents a bound, so a slow or hung destination is answered by giving up
   * rather than by hanging - but the entry that was mid-`stream.write` when the deadline
   * passed is in no queue and no counter, so `await close()` resolved and `getHealth()`
   * reported a clean shutdown with a write still outstanding. Whether its bytes landed is
   * genuinely unknown from here: the callback may fire after this resolves, credit the
   * entry to `totalEntriesWritten`, and add its length to a file nothing is writing to any
   * more. Unknown is the honest answer, and saying it is what "closed means done" needs
   * in the one case where it is not quite true.
   *
   * Not counted in `droppedEntries`, which means "lines this sink did not deliver" - this
   * line may well have been delivered. `'no_entry'` for the same reason: the failure is
   * about the close, and the entry itself is neither lost nor retrying.
   *
   * This is the entry's only report. The pass that was writing it may resume after
   * `close()` resolves and fail - refused by `writeEntry`'s `closed` checks, or failed by
   * the stream `close()` destroyed - and {@link processQueue} neither reports nor counts
   * that failure.
   */
  private reportInFlightWriteOnClose(didAbandon: boolean): void {
    if (!didAbandon) {
      return;
    }

    this.handleError(
      'close',
      new FileSinkError(
        `Closed with a write still in flight (closeTimeoutMS=${String(this.closeTimeoutMS)}); whether it reached the file is unknown`,
      ),
      { disposition: 'no_entry' },
    );
  }

  /**
   * Give up on whatever is still queued when `close()` stops waiting, and say so.
   *
   * `close()` is bounded by `closeTimeoutMS`, so a slow or broken destination leaves
   * entries behind - and once `closed` is set nothing will ever process them. Counted in
   * `droppedEntries` and reported once as `'lost'`; see {@link LossLedger.abandon}.
   */
  private abandonQueueOnClose(): void {
    this.losses.abandon(
      this.writeQueue,
      (count) =>
        `Closed with ${describeEntryCount(count)} still queued (closeTimeoutMS=${String(this.closeTimeoutMS)}); they were not written`,
    );
  }

  /**
   * Initialize the file sink asynchronously
   */
  private async initialize(): Promise<void> {
    const shouldSuppressFailureReport = isConsoleReportActive();
    try {
      // Create log directory if it doesn't exist
      await fsPromises.mkdir(this.logDir, { recursive: true });

      // Initialize log file. `setupLogFile` owns `isInitialized`, and setting it again here
      // undid the one thing that flag's identity check exists to protect: `createWriteStream`
      // reports a path it cannot open - `EISDIR`, `EACCES`, `EMFILE` - as an event, typically
      // while `setupLogFile` is suspended in `stat`, so the `'error'` handler destroyed the
      // stream and cleared the flag and this line then put it straight back. `getHealth()`
      // answered `{ isInitialized: true, isHealthy: true }` for a sink holding no descriptor
      // at all, which is the state the handler had just finished reporting. A setup that
      // returns without marking the flag - a `close()` that landed mid-open, or a stream a
      // rotation has since replaced - means exactly that, and is left alone.
      await this.setupLogFile();
    } catch (error) {
      // `close()` may stop waiting for initialization before the filesystem operation
      // itself settles. Once closing has begun, do not claim that a failed setup is still
      // being retried after the sink has promised to shut down.
      if (this.closing || this.closed) {
        return;
      }

      // Said, not swallowed. Entries do stay queued and `writeEntry` retries `setupLogFile`
      // later, so nothing is lost here - but a constructor-time `EACCES` or `EISDIR` left
      // no trace at all until some later write happened to hit the missing stream, and a
      // sink that can never open its file looked identical to one that simply had nothing
      // to write yet. `NamedPipeSink` reports its setup failures up front; this now does
      // too.
      // `setupLogFile` already raises a `FileSinkError` that names the file, so wrapping
      // one produced `Failed to setup log file: Failed to setup log file: ...`. Only what
      // arrives as something else - `mkdir`'s raw `ENOTDIR`, `EACCES` - is wrapped.
      const failure =
        error instanceof FileSinkError
          ? error
          : new FileSinkError(
              `Failed to setup log file: ${describeError(error)}`,
              toError(error),
              'setup',
            );

      // Setup belongs to no particular line, and the queue still holds every entry: a
      // later write retries this, so nothing here is lost.
      this.handleError('setup', failure, {
        disposition: 'retrying',
        shouldSuppressFailureReport,
      });
    }
  }

  /**
   * Process the write queue
   * Processes entries one at a time with retry logic
   */
  private async processQueue(): Promise<void> {
    // If already processing, closed, or queue is empty, return
    if (this.isProcessing || this.closed || this.writeQueue.length === 0) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.writeQueue.length > 0) {
        const queuedEntry = this.writeQueue.shift();
        if (!queuedEntry) {
          break;
        }

        this.inFlightEntry = queuedEntry;

        try {
          await this.writeEntry(queuedEntry);
          this.consecutiveFailures = 0;
          this.totalEntriesWritten++;
        } catch (error) {
          if (this.activeStreamWriteEntry === queuedEntry) {
            this.activeStreamWriteEntry = undefined;
          }
          // Close already reported this entry: an actual stream write has unknown
          // delivery, while an entry parked in setup or rotation was counted as queued
          // loss. Its resumed pass must neither report nor count it again.
          if (queuedEntry === this.abandonedInFlightEntry) {
            continue;
          }

          // `toError`, not `String(error)`: the coercion runs inside the `catch` that
          // is the entry's only retry and `onError` handling, and `String()` invokes a
          // `toString` this does not own. A value whose `toString` throws made the
          // coercion throw from inside the handler, skipping `onError`, the re-queue
          // and the failure counters, and escaping `processQueue` as an unhandled
          // rejection that left every queued entry behind it stalled.
          const err = toError(error);
          const kind = this.failureKindFor(err);

          this.lastError = err;

          // Setup, rendering, and close failures say nothing about writes on an
          // open destination. Initialization has its own health flag.
          if (kind === 'write') {
            this.consecutiveFailures++;
          }

          // Determine if we should retry.
          //
          // A render that failed is never retried: the line is not re-rendered by design
          // (see `QueuedEntry.formatError`), so every attempt would raise the same
          // failure and call `onError` again for one entry that can never be written.
          //
          // And never once the sink is closed. `close()` gives up on its drain at
          // `closeTimeoutMS` with a pass possibly still in flight, and re-queueing from
          // there put the entry back in a queue `abandonQueueOnClose()` had already emptied
          // and nothing would ever drain: `getHealth().queueSize` stayed above zero after
          // `await close()` resolved, and the line was reported `'retrying'` - `maxRetries`
          // times, against a sink that could only answer `Cannot write to closed sink` -
          // before finally being counted. `NamedPipeSink.requeue` takes the same view: past
          // the close, the honest answer is that the entry is lost.
          const hasRetryRoom = () =>
            this.maxQueueSize === undefined ||
            this.writeQueue.length < this.maxQueueSize;
          let willRetry =
            queuedEntry.formatError === undefined &&
            !this.closed &&
            queuedEntry.attempts < this.maxRetries &&
            hasRetryRoom();

          // The shared rung, which also closes a gap this had and `NamedPipeSink` did
          // not: the console line lived *inside* the `catch` for a throwing callback, so
          // a sink with no `onError` at all reported a failed write nowhere. A file sink
          // that cannot write - a full disk, a directory that went away - said so only
          // through `getHealth()`, if anyone happened to poll it.
          // The callback hears every attempt, which is its contract. The console rung only
          // hears the last one: `maxRetries` defaults to 3, so a sink that cannot write
          // would otherwise print four lines for every entry, and a disk that filled up
          // under a logging loop turns that into the flood the fallback is supposed to
          // rescue you from. One line per entry actually lost says the same thing.
          const reportFailure = (willRetryEntry: boolean) => {
            // Still retry and count the write, but never let a forwarded terminal
            // report start another failure callback after the console guard clears.
            if (queuedEntry.shouldSuppressFailureReport) {
              return;
            }
            if (this.onError !== undefined || !willRetryEntry) {
              // Held across the report for a `'format'` failure only, and until the handler
              // settles rather than returns - see `FormatReportScheduler`. A write failure
              // is retried and the handler hears every attempt by contract; the chain this
              // breaks is the one where the handler's own line cannot render either.
              const report = (onReported?: () => void) =>
                reportSinkError(
                  this,
                  {
                    kind,
                    error: err,
                    target: this.currentLogFile ?? this.logDir,
                    entry: queuedEntry.entry,
                    attempt: queuedEntry.attempts + 1,
                    disposition: willRetryEntry ? 'retrying' : 'lost',
                  },
                  this.onError,
                  () => this.describeWriteFailure(err),
                  {
                    label: 'FileSink',
                    isDiagnostic: isDiagnosticEntry(queuedEntry.entry),
                    onSettled: onReported,
                  },
                );

              if (kind === 'format') {
                this.formatReports.schedule(report, () =>
                  this.describeWriteFailure(err),
                );
              } else {
                report();
              }
            }
          };
          reportFailure(willRetry);
          // A callback may enqueue another line or close the sink. Recheck before
          // committing a retry and report its final loss if the callback consumed room.
          if (willRetry && (this.closed || !hasRetryRoom())) {
            willRetry = false;
            reportFailure(false);
          }

          if (willRetry) {
            // Preserve ordering, but never enqueue a retry that the queue cap would
            // immediately evict. Its write failure must say 'lost' even when the
            // aggregate queue-full notification has already been emitted.
            queuedEntry.attempts++;
            this.writeQueue.unshift(queuedEntry);
          } else {
            // Max retries exceeded - entry is lost
            //
            // Counted as a drop, matching `NamedPipeSink`, and the only counter kept for
            // it: an entry lost to an exhausted retry or a failed render reported
            // `disposition: 'lost'` while `getHealth()` still answered
            // `{ isHealthy: true, droppedEntries: 0 }` - against that field's own
            // documented meaning, "lines this sink did not deliver". `flush()` reads the
            // same counter, so the two can no longer disagree about what was lost.
            this.losses.count(
              kind === 'format' || kind === 'close' || kind === 'setup'
                ? kind
                : this.closed
                  ? 'close'
                  : 'write',
            );
          }
        }
      }
    } finally {
      this.inFlightEntry = undefined;

      // A drained queue closes the reported overflow episode, so a sink that overflows
      // again hours later says so again.
      if (this.writeQueue.length === 0) {
        this.losses.endOverflowEpisode();
      }

      this.isProcessing = false;
    }
  }

  /** The body of {@link flush}, run one at a time; see there. */
  private async flushWindow(
    timeoutMS: number,
    startTime: number,
  ): Promise<FlushResult> {
    // `droppedEntries`, which every loss path bumps. A separate counter held only the
    // writes that exhausted their retries, so a flush that lost lines to a queue overflow
    // or to a `close()` abandoning its backlog - the conditions `maxQueueSize` exists for -
    // answered `{ success: true, entriesFailed: 0 }` about them. One counter, so `flush()`
    // and `getHealth()` cannot disagree about what was lost.
    //
    // Measured from where the *last* flush stopped counting rather than from this call's
    // own entry, which is the window a caller is actually asking about. `enforceQueueLimit`
    // runs synchronously inside `write()` and the queue only drains between turns of the
    // event loop, so every eviction a synchronous logging loop causes has already happened
    // by the time `flush()` is entered: 25,000 `write()` calls under the default 10,000
    // cap then answered `{ success: true, entriesWritten: 10000, entriesFailed: 0 }` while
    // `getHealth()` reported 15,000 dropped - a batch job's all-clear for losing most of
    // its log. Counted from the last flush, those losses are in the result that follows
    // them, and every line is accounted for exactly once across successive flushes.
    //
    // Both baselines are read before the wait below rather than after it, so a loss that
    // lands while the init is still settling is inside this call's answer rather than
    // deferred to the next one.
    const startWritten = this.flushBaselineWritten;
    const startFailed = this.flushBaselineDropped;

    // Wait for initialization, bounded by the caller's own budget. `close()` has always
    // raced this wait against its timeout; `flush()` awaited it outright, so a `mkdir` or
    // `stat` hung on an unresponsive mount made `flush(1000)` never return at all - the
    // shape a timeout exists to rule out.
    if (this.initPromise) {
      const initPromise = this.initPromise;
      const timeoutSentinel = { timedOut: true } as const;
      const result = await raceDeadline(
        initPromise,
        // This call's budget includes time spent waiting behind another flush.
        Math.max(0, timeoutMS - (Date.now() - startTime)),
        () => timeoutSentinel,
      );
      if (result === timeoutSentinel) {
        return this.settleFlush({
          success: false,
          entriesWritten: this.totalEntriesWritten - startWritten,
          entriesFailed: this.losses.droppedEntries - startFailed,
          timedOut: true,
        });
      }
    }

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > timeoutMS) {
        // Timeout reached
        const entriesWritten = this.totalEntriesWritten - startWritten;
        const entriesFailed = this.losses.droppedEntries - startFailed;

        return this.settleFlush({
          success: false,
          entriesWritten,
          entriesFailed,
          timedOut: true,
        });
      }

      await sleep(10);
    }

    const entriesWritten = this.totalEntriesWritten - startWritten;
    const entriesFailed = this.losses.droppedEntries - startFailed;

    return this.settleFlush({
      success: entriesFailed === 0,
      entriesWritten,
      entriesFailed,
      timedOut: false,
    });
  }

  /**
   * Move the flush baselines past what this result reported, and hand it back.
   *
   * On every exit including the timeouts: a flush that gave up still reported the writes
   * and losses it had seen, and counting them again in the next result would double-report
   * them.
   */
  private settleFlush(result: FlushResult): FlushResult {
    this.flushBaselineWritten = this.totalEntriesWritten;
    this.flushBaselineDropped = this.losses.droppedEntries;

    return result;
  }

  /**
   * Discard the oldest entries once the queue is over `maxQueueSize`, and report the first
   * eviction of the episode. See {@link LossLedger.evict}.
   */
  private enforceQueueLimit(): void {
    this.losses.evict(
      this.writeQueue,
      this.maxQueueSize,
      (limit) =>
        `Log queue is full (maxQueueSize=${limit}); dropping the oldest entries`,
    );
  }

  /**
   * Which kind of failure a thrown error describes: the `kind` its throw site set, or
   * `'write'` for anything raised without one.
   *
   * An entry `close()` finished under is raised as `'close'`, not `'write'`: the
   * destination was fine and the sink was shut down out from under a pass still in flight
   * (see the second `closed` check in `writeEntry`), and `NamedPipeSink` counts the
   * identical event as `'close'`.
   */
  private failureKindFor(error: Error): SinkFailureKind {
    return error instanceof FileSinkError && error.kind !== undefined
      ? error.kind
      : 'write';
  }

  /**
   * Write a single entry to the file
   * If stream is broken, it will be recreated on next attempt
   */
  private async writeEntry(queued: QueuedEntry): Promise<void> {
    // `write()` reports a render failure and never queues it, so this is a backstop: an
    // entry with no line must not reach the stream, and is never re-rendered. Raised as an
    // ordinary failure so `onError`, `lastError` and the counters still see it.
    if (queued.formatError !== undefined) {
      throw new FileSinkError(
        'Failed to format log entry',
        queued.formatError,
        'format',
      );
    }

    if (this.closed) {
      throw new FileSinkError(
        'Cannot write to closed sink',
        undefined,
        'close',
      );
    }

    if (!this.logFileStream) {
      await this.setupLogFile();
    }

    // Setup may return without a stream when close finishes while it is suspended.
    if (this.closed) {
      throw new FileSinkError(
        'Cannot write to closed sink',
        undefined,
        'close',
      );
    }

    // Setup that returns without a stream failed to open one: the `'error'` handler left
    // the reason for this entry when it had one.
    if (!this.logFileStream) {
      throw (
        this.takeOpenFailure(queued) ??
        new FileSinkError('No log file stream available', undefined, 'setup')
      );
    }

    // Check rotation before writing (handles date change and size limit)
    await this.rotateIfNeeded();

    // Asked again, after `setupLogFile` and `rotateIfNeeded`. `close()` bounds its drain
    // loop and returns while a pass that started before the deadline is still suspended in
    // one of those, so the check at the top of this method is not the last word: that pass
    // resumed and wrote a line to disk *after* `await close()` had already resolved and
    // reported the sink shut down. Raised as an ordinary write failure so the entry is
    // counted and reported like any other line this sink did not deliver, rather than
    // landing in a file nobody is expecting to grow any more.
    if (this.closed) {
      throw new FileSinkError(
        'Cannot write to closed sink',
        undefined,
        'close',
      );
    }

    // Always the line rendered in `write`. A render that threw has already been raised
    // above, so this is never a second attempt at one.
    const messageToWrite = queued.formatted ?? '';
    const messageBytes = Buffer.byteLength(messageToWrite, 'utf8');

    // Check if writing would exceed limit
    //
    // Only for a file that has something in it. An entry larger than `maxSizeMB` on its own
    // can never fit, so on an empty file this check fired for every such line and rotated a
    // file holding nothing: `rotateIfNeeded` above had already rotated the full one, and
    // this rotated its empty replacement straight back out. With `reserveRotatedFileName`
    // handing out unique names, those no longer collide, so each oversized entry left a
    // zero-byte archive behind - five 4 KB lines against a 1 KB limit produced ten files,
    // five of them empty. Written to the current file instead, overshooting the limit by
    // the one line that cannot be split, which is what an unsplittable entry costs either
    // way.
    const maxSizeBytes = this.maxSizeMB * 1024 * 1024;
    if (
      this.currentLogSize > 0 &&
      this.currentLogSize + messageBytes > maxSizeBytes
    ) {
      await this.rotateFile();
    }

    // `close()` may finish while the oversized-line rotation above is suspended. A
    // rotation that notices the close returns without changing the stream, so do not let
    // this older write continue into a sink that has already reported itself closed.
    if (this.closed) {
      throw new FileSinkError(
        'Cannot write to closed sink',
        undefined,
        'close',
      );
    }

    // Write to file
    return await new Promise<void>((resolve, reject) => {
      // Rejected, not resolved. The stream can disappear *after* the check above: its
      // `'error'` handler calls `destroyStream` on a `nextTick`, which lands while this
      // method is suspended in `rotateIfNeeded` or `rotateFile` - both awaited after that
      // check. Resolving here reported the loss as a successful write, so `processQueue`
      // cleared `consecutiveFailures` and incremented `totalEntriesWritten`, `flush`
      // answered `{ entriesWritten: 0, entriesFailed: 0, success: true }`, `getHealth` stayed
      // healthy with `droppedEntries: 0`, and `onError` never fired for a line that was
      // never written. Failing here instead routes it through the ordinary write-failure
      // path, which retries it and, if that runs out, reports it.
      if (!this.logFileStream) {
        return reject(
          this.takeOpenFailure(queued) ??
            new FileSinkError('No log file stream available'),
        );
      }

      const writingTo = this.logFileStream;
      const writingToFile = this.currentLogFile ?? this.logDir;

      this.activeStreamWriteEntry = queued;
      writingTo.write(messageToWrite, (err) => {
        if (this.activeStreamWriteEntry === queued) {
          this.activeStreamWriteEntry = undefined;
        }
        if (err) {
          // A stream that never opened failed its open, not this write: `EISDIR` or
          // `EACCES` from `createWriteStream` reaches a buffered write's callback before
          // the `'error'` event, and the teardown below sends that event down its
          // not-current branch, so this is the only place left to classify it. Raised as
          // `'setup'`, so the line is reported and counted as a destination that could not
          // be opened, and is not charged to `consecutiveFailures` as a failed write.
          // Read before the teardown, which can release the descriptor of a stream that
          // did open. `pending` alone cannot tell: a stream that opened and was then
          // destroyed has no descriptor either, and a write reaching it fails with
          // `ERR_STREAM_DESTROYED` - a write failure.
          const didNeverOpen =
            writingTo.pending &&
            (err as NodeJS.ErrnoException).code !== 'ERR_STREAM_DESTROYED';

          // The event is told to keep quiet about this particular error; it still tears
          // the stream down, which is the half it does know about. A non-object is not
          // trackable and is simply not suppressed: the event then reports it, which is
          // noisier than ideal but never silent.
          if (typeof err === 'object') {
            this.suppressedWriteErrors.add(err);
          }

          // The stream that failed, not whatever is current - the identity guard the
          // `'error'` handler carries, for the same hazard. A callback belonging to a
          // stream a rotation has since replaced tore down the healthy replacement and
          // lost its buffer.
          if (this.logFileStream === writingTo) {
            this.destroyStream();
          } else {
            try {
              writingTo.destroy();
            } catch {
              // Nothing further to try for a stream nothing is using.
            }
          }

          reject(
            didNeverOpen
              ? new FileSinkError(
                  `Failed to setup log file: ${writingToFile}`,
                  err,
                  'setup',
                )
              : new FileSinkError('Error writing to log file', err),
          );
        } else {
          // The same identity guard as the error branch. Charged unconditionally, a
          // callback belonging to a stream a rotation had since replaced added its bytes
          // to the *new* file's counter: they are in the archive, the fresh file is
          // that much smaller than the counter says, and it rotated early.
          if (this.logFileStream === writingTo) {
            this.currentLogSize += messageBytes;
          }

          resolve();
        }
      });
    });
  }

  /**
   * Format a log entry for file output
   */
  private formatEntry(entry: LogEntry): string {
    let formatted: string;

    if (this.jsonFormat) {
      // The logger's own renderer over the redacted bag, not a second `JSON.stringify`:
      // see `renderJSONLine`. A value it cannot render becomes a marker and is reported
      // as `'format'`/`'fallback'` - the line is still written.
      formatted = renderJSONLine(entry, (error) => {
        this.reportRenderFallback(entry, error);
      });
    } else {
      formatted = renderTextEntry(entry);
    }

    return formatted + '\n';
  }

  /**
   * Setup the log file
   */
  private async setupLogFile(shouldSkipRotation = false): Promise<void> {
    const isDiagnosticSetup = isDiagnosticEntry(this.inFlightEntry?.entry);
    const shouldSuppressSetupReport =
      isConsoleReportActive() ||
      this.inFlightEntry?.shouldSuppressFailureReport === true;
    // Nothing to open for a sink that is already closed. `close()` bounds its drain loop,
    // so a `writeEntry` suspended in here - a slow `mkdir` on a network mount is enough -
    // resumed *after* that loop gave up, after the stream `close()` found had been
    // destroyed and after `close()` itself resolved. It then opened a fresh descriptor
    // nothing would ever close and set `isInitialized` back to `true`, so `getHealth()`
    // reported a closed sink as initialized - the state `close()` clears the flag to
    // prevent. Checked again below for the same reason: every await here is a place
    // `close()` can run.
    //
    // `closed` only, not `closing`. `close()` raises `closing` *before* the drain loop that
    // is the whole point of waiting, and that loop's writes come through here whenever the
    // first entry arrives before the constructor's `initialize()` has opened anything -
    // `new FileSink(...)`, one `write()`, `await close()`. Refusing during the drain phase
    // meant that sink created no file at all and reported the entry lost after exhausting
    // its retries, where the same sequence wrote it before. The descriptor a drain-phase
    // open creates is still the one `close()` ends afterwards, since `endCurrentStream`
    // reads whatever stream is current when it runs.
    if (this.closed) {
      return;
    }

    const currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const currentLogFile = `${this.logDir}/${this.basename}-${currentDate}.log`;

    try {
      await fsPromises.mkdir(this.logDir, { recursive: true });

      // Explicitly create the file if it doesn't exist to avoid race conditions
      // This ensures the file exists on disk before we try to read it in tests
      try {
        await fsPromises.access(currentLogFile);
      } catch {
        // File doesn't exist, create it
        await fsPromises.writeFile(currentLogFile, '', { flag: 'a' });
      }

      if (this.closed) {
        return;
      }

      this.pendingOpenFailure = undefined;
      const stream = fs.createWriteStream(currentLogFile, { flags: 'a' });

      this.logFileStream = stream;
      this.currentLogFile = currentLogFile;

      stream.on('error', (streamError: unknown) => {
        // The stream that failed, not whatever is current. A rotation replaces this
        // stream, and the one it replaced can still deliver its error afterwards -
        // ungated, that late error destroyed the *live* stream, failing whatever write
        // was in flight on it and forcing a needless reopen. A stream nobody is holding
        // is simply torn down.
        if (this.logFileStream !== stream) {
          try {
            stream.destroy();
          } catch {
            // Nothing further to try for a stream nothing is using.
          }

          // An open that never completed still leaves the sink uninitialized, even when
          // nobody is holding the stream any more. A queued write reaching `stream.write()`
          // first runs `destroyStream()` from its own callback, so the `'error'` event that
          // follows arrives here rather than at the branch below that clears the flag: with
          // a log path that is a directory, twenty consecutive failed writes and not one
          // successful open still answered `{ isInitialized: true }`. Only when nothing has
          // taken this stream's place - a rotation replaces it with a live one, and that
          // sink is initialized.
          if (stream.pending && this.logFileStream === undefined) {
            this.isInitialized = false;
          }

          return;
        }

        this.destroyStream();

        // Already said, by the write callback that knew which line it was and whether it
        // was coming back. Consumed only when it matches, so an unrelated error cannot
        // unsuppress the report still waiting for its own event.
        if (
          typeof streamError === 'object' &&
          streamError !== null &&
          this.suppressedWriteErrors.has(streamError)
        ) {
          this.suppressedWriteErrors.delete(streamError);

          return;
        }

        // Reported, not only torn down. This handler recorded nothing at all, so an async
        // failure with no write in flight to pair it with - the disk filling, the file
        // removed underneath the descriptor, an open that failed - left `getHealth()`
        // answering `isHealthy: true` with a stale `lastError` and `onError` never fired,
        // where `NamedPipeSink` reports every such failure. A write that was in flight
        // still reports through its own rejection, which is the report suppressed above;
        // this covers the failure that has no line to attach to.
        //
        // `'setup'` while the stream is still opening, `'write'` once it has a descriptor -
        // the classification `NamedPipeSink` settled on. `createWriteStream` does not throw
        // for `EACCES`, `EISDIR` or `EMFILE`, it emits, and `'write'` is documented as the
        // one kind that means an entry is at risk: a destination that could never be opened
        // is about no entry at all.
        const kind: SinkFailureKind = stream.pending ? 'setup' : 'write';

        const failure = new FileSinkError(
          stream.pending
            ? `Failed to setup log file: ${currentLogFile}`
            : 'Log file stream failed',
          toError(streamError),
          kind,
        );

        // Only a failure of a stream that had a descriptor says anything about this
        // sink's ability to write; an open that never completed is `isInitialized`'s
        // business, exactly as `NamedPipeSink` treats it.
        if (kind === 'write') {
          this.consecutiveFailures++;
        } else {
          // An open that never completed leaves the sink uninitialized, whatever
          // `setupLogFile` marked on its way out: `createWriteStream` returns a stream for
          // a path it cannot open and fails afterwards, so the flag was set and
          // `getHealth()` answered `isHealthy: true` for a sink with no descriptor at all.
          // The next `writeEntry` calls `setupLogFile` again and sets it back when the
          // open really does succeed.
          this.isInitialized = false;

          // An entry is waiting on this open, and `writeEntry` raises the failure as that
          // entry's: see `pendingOpenFailure`.
          if (this.inFlightEntry !== undefined) {
            this.pendingOpenFailure = { entry: this.inFlightEntry, failure };

            return;
          }
        }

        // No `entry`: the stream failed on its own, not while carrying a line this sink
        // can name. Anything queued is retried on the reopened stream and reported on its
        // own terms if that fails. Routed by the entry in flight all the same: unlike a
        // rotation, a stream failure is not latched, so one from a forwarded console
        // line that reached the console again would come back as another such line.
        this.handleError(kind, failure, {
          disposition: 'no_entry',
          shouldSuppressFailureReport:
            (stream.pending
              ? shouldSuppressSetupReport
              : this.activeStreamWriteEntry?.shouldSuppressFailureReport ===
                true) ||
            this.inFlightEntry?.shouldSuppressFailureReport === true,
          isDiagnostic: stream.pending
            ? isDiagnosticSetup
            : isDiagnosticEntry(this.activeStreamWriteEntry?.entry),
        });
      });

      // Get current file size
      try {
        const stats = await fsPromises.stat(currentLogFile);
        this.currentLogSize = stats.size;
      } catch {
        this.currentLogSize = 0;
      }

      // Rotate if already at size limit
      const maxSizeBytes = this.maxSizeMB * 1024 * 1024;
      if (!shouldSkipRotation && this.currentLogSize >= maxSizeBytes) {
        await this.rotateFile();
      }

      // Closed while the size was being read, so this stream has already outlived the
      // teardown that would have ended it. Torn down here rather than left for nobody: the
      // descriptor is the leak, and `isInitialized` must not go back up behind a `close()`
      // that cleared it.
      //
      // `closed` only, for the reason the guards at the top of this method are: a stream
      // opened while `close()` is still draining is the stream those queued entries are
      // written through, and destroying it here left them with nowhere to go.
      if (this.closed) {
        this.destroyStream();

        return;
      }

      // Marked here rather than only in `initialize()`, which runs once from the
      // constructor and swallows what it catches. A sink whose directory was not there yet
      // recovers lazily - `writeEntry` calls this again and writes successfully from then
      // on - but nothing ever set the flag, so `getHealth()` answered
      // `{ isHealthy: false, isInitialized: false }` forever while every line was landing
      // on disk. An operator watching health saw a permanently broken sink that was fine.
      //
      // Only for the stream this call opened, the identity check `NamedPipeSink` makes for
      // the same reason. `createWriteStream` returns a stream for a path it cannot open and
      // reports afterwards, typically while this is suspended in `stat` or `rotateFile`, and
      // the `'error'` handler above clears the flag for exactly that case - setting it
      // unconditionally here put it straight back, so `getHealth()` answered
      // `{ isInitialized: true, isHealthy: true }` for a sink holding no descriptor at all.
      // A rotation replaces the stream and its own `setupLogFile` has already marked the
      // one that succeeded, so there is nothing for this to say about a stream it no longer
      // holds either.
      if (this.logFileStream === stream) {
        this.isInitialized = true;
      }
    } catch (error) {
      throw new FileSinkError(
        `Failed to setup log file: ${currentLogFile}`,
        toError(error),
        'setup',
      );
    }
  }

  /** The open failure left for `queued`, if any, consumed by reading it. */
  private takeOpenFailure(queued: QueuedEntry): FileSinkError | undefined {
    const pending = this.pendingOpenFailure;
    this.pendingOpenFailure = undefined;

    return pending?.entry === queued ? pending.failure : undefined;
  }

  /**
   * Destroy the current stream
   */
  private destroyStream(): void {
    if (this.logFileStream) {
      try {
        this.logFileStream.destroy();
      } catch {
        // Ignore
      } finally {
        this.logFileStream = undefined;
        this.isInitialized = false;
      }
    }
  }

  /**
   * Rotate log file if needed based on size or date
   */
  private async rotateIfNeeded(): Promise<void> {
    if (!this.logFileStream || !this.currentLogFile) {
      return;
    }

    const currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const expectedFile = `${this.logDir}/${this.basename}-${currentDate}.log`;

    // Date changed - setup new file
    if (this.currentLogFile !== expectedFile) {
      // Guarded exactly as `rotateFile()` is, and for both of its reasons. This branch
      // awaits `endCurrentStream(this.closeTimeoutMS)` - a *fresh* full-length wait, begun
      // from inside a close that is already keeping its own budget, so a UTC midnight
      // crossed during a shutdown on a stalled mount made a documented thirty-second bound
      // a sixty-second one. And it ends the stream `close()` is draining through to open the
      // next day's file, which past `closed` is a descriptor nothing will ever close. The
      // entry in hand goes to the day the sink was already writing, which is the right
      // trade at shutdown: a log line in the previous day's file, rather than a close that
      // overshoots its bound or a stream that outlives it.
      if (this.closing || this.closed) {
        return;
      }

      // Ended first, exactly as `rotateFile()` ends it. `setupLogFile()` overwrites
      // `logFileStream` with no teardown, so the stream this replaces was left open and
      // unreachable: one `WriteStream` and one file descriptor leaked per UTC midnight for
      // the life of the process, and whatever sat in its buffer was never flushed - not by
      // `close()`, which only ends the stream that is current by then.
      //
      // Bounded, like every other flush this sink waits on: see `endCurrentStream`. What
      // the bound gave up on is reported rather than dropped: see
      // `reportRotationFlushLoss`.
      const bytesLeft = await this.endCurrentStream(this.closeTimeoutMS, true);

      this.reportRotationFlushLoss(
        bytesLeft,
        this.currentLogFile ?? this.logDir,
      );

      await this.setupLogFile();

      return;
    }

    // Size limit reached
    const maxSizeBytes = this.maxSizeMB * 1024 * 1024;
    if (this.currentLogSize >= maxSizeBytes) {
      await this.rotateFile();
    }
  }

  /**
   * Rotate the current log file
   * Queue processing pauses during rotation, then resumes
   */
  private async rotateFile(): Promise<void> {
    if (!this.logFileStream || !this.currentLogFile) {
      return;
    }

    // Guarded like `setupLogFile`, and for the failure that has no other guard. A rotation
    // that starts as `close()` runs calls `endCurrentStream(this.closeTimeoutMS)` of its
    // own, which begins a fresh full-length wait *outside* the budget the close is keeping:
    // on a stalled mount the close times out and reports the sink shut down, and this then
    // resumes and renames the live log to an archive while the `setupLogFile` that would
    // reopen it early-returns because the sink is closed. Whatever was tailing the current
    // day's file watched it disappear after shutdown had already completed.
    if (this.closing || this.closed) {
      return;
    }

    // Keep the writable file open during an archive outage. All size-rotation
    // paths share this gate, including setup and the before-write size check.
    if (Date.now() < this.nextRotationAttemptAt) {
      return;
    }

    const currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    // Close current stream, bounded: see `endCurrentStream`. Read before the rename below
    // moves the file, so the report names the file the bytes were written for.
    const bytesLeft = await this.endCurrentStream(this.closeTimeoutMS, true);

    this.reportRotationFlushLoss(bytesLeft, this.currentLogFile);

    // Rename with timestamp, disambiguated when one second holds more than one rotation.
    //
    // A second-resolution suffix alone named the same archive twice under any burst that
    // filled `maxSizeMB` twice inside one second, and `rename` overwrites silently: the
    // earlier archive was gone, with `entriesFailed: 0`, `droppedEntries: 0` and `onError`
    // never firing - lines that this sink had reported as written, lost with nothing
    // anywhere saying so. Milliseconds make the ordinary collision impossible and the
    // counter settles the rest, since rotations are serialized on this sink.
    const rotatedFile = await this.reserveRotatedFileName(currentDate);

    // Asked again, for the failure the check at the top cannot cover on its own. Both
    // awaits above are long: `endCurrentStream` waits out `closeTimeoutMS` on a stalled
    // mount, and `reserveRotatedFileName` probes the disk. A `close()` racing this one
    // resumes in that window, times out, and reports the sink shut down - and this then
    // renamed the live log to an archive that `setupLogFile` would never replace, because
    // it early-returns on a closed sink. Re-checking after the awaits is the same pattern
    // `writeEntry` follows for the same reason. During the drain phase the ended
    // stream must be reopened for the accepted entry before rotation stands down.
    if (this.closed) {
      return;
    }
    if (this.closing) {
      // Rotation already ended the stream. Reopen it so close can drain the
      // accepted entry without rotating the file during shutdown.
      await this.setupLogFile();
      return;
    }

    try {
      await fsPromises.rename(this.currentLogFile, rotatedFile);
    } catch (error) {
      const failure = new FileSinkError(
        `Error rotating log file from ${this.currentLogFile} to ${rotatedFile}`,
        toError(error),
      );
      const shouldReport = this.rotationRetryDelayMS === 0;
      this.rotationRetryDelayMS = Math.min(
        this.rotationRetryDelayMS === 0
          ? ROTATION_RETRY_INITIAL_MS
          : this.rotationRetryDelayMS * 2,
        ROTATION_RETRY_MAX_MS,
      );
      this.nextRotationAttemptAt = Date.now() + this.rotationRetryDelayMS;
      // Recorded on every failure, reported on the first of a backoff run.
      if (shouldReport) {
        this.handleError('setup', failure, { disposition: 'no_entry' });
      } else {
        this.lastError = failure;
      }

      // The current file may still be writable when archiving is not. Reopen it
      // without immediately trying to rotate its unchanged size again; otherwise
      // every queued entry fails setup (or reopening recurses indefinitely).
      // A later write after the backoff will retry; recovery needs no restart.
      await this.setupLogFile(true);
      return;
    }

    this.rotationRetryDelayMS = 0;
    this.nextRotationAttemptAt = 0;

    // Setup new file (queue processing will resume after this)
    await this.setupLogFile();
  }

  /**
   * A rotated-file path that names nothing already on disk.
   *
   * The counter is only reached when two rotations land in the same millisecond, and it is
   * bounded: after {@link MAX_ROTATION_NAME_ATTEMPTS} the caller gets the last candidate
   * anyway rather than this looping while the queue is parked. A `rename` onto an existing
   * archive is still better than a rotation that never finishes - but it used to happen
   * without a word, and an archive overwritten in silence is a loss an operator cannot
   * trace. Reported as a `'setup'` failure before the rename, with the archive about to be
   * replaced as the target: `'no_entry'`, since no line is at stake, only history.
   */
  private async reserveRotatedFileName(currentDate: string): Promise<string> {
    const timestamp = Date.now();
    const base = `${this.logDir}/${this.basename}-${currentDate}-${String(timestamp)}`;

    let candidate = `${base}.log`;

    for (let attempt = 1; attempt <= MAX_ROTATION_NAME_ATTEMPTS; attempt++) {
      try {
        await fsPromises.access(candidate);
      } catch {
        // Nothing there to overwrite, which is the whole question being asked.
        return candidate;
      }

      candidate = `${base}-${String(attempt)}.log`;
    }

    // The name the loop gives up holding, asked about like every other. Advancing at the
    // end of each pass left the last candidate - `base-100.log` under the default cap -
    // formed but never probed, and the report below went out regardless: a rotation onto a
    // free name announced itself as overwriting an archive that was not there, so a sink
    // doing exactly the right thing raised a `'setup'` failure. The report is for a
    // rotation that really is about to replace history.
    try {
      await fsPromises.access(candidate);
    } catch {
      return candidate;
    }

    this.handleError(
      'setup',
      new FileSinkError(
        `No free archive name after ${String(MAX_ROTATION_NAME_ATTEMPTS + 1)} candidates; rotating over ${candidate}`,
      ),
      { disposition: 'no_entry', target: candidate },
    );

    return candidate;
  }

  /**
   * `entry` could not be rendered at all, so there is no line to write: counted as a
   * `'format'` loss and reported once, from `write()`.
   *
   * The recursion fuse. A line that cannot render, logged while the handler is being
   * called, the deferred report is being delivered, or the console is reporting, is a
   * report's own line coming back: handed to the handler, it would start a generation
   * that repeats forever. Counted, and said on the console rather than to the handler -
   * see `FormatReportScheduler`. A forwarded console line is counted and not reported.
   */
  private reportRenderFailure(
    entry: LogEntry,
    formatError: Error,
    shouldSuppressFailureReport: boolean,
  ): void {
    const failure = new FileSinkError(
      'Failed to format log entry',
      formatError,
    );
    const line = () => this.describeWriteFailure(failure);

    this.losses.count('format');

    if (
      this.formatReports.isFused ||
      this.formatReports.isConsoleReportActive ||
      shouldSuppressFailureReport
    ) {
      if (!shouldSuppressFailureReport) {
        this.formatReports.reportToConsole(line);
      }

      return;
    }

    this.lastError = failure;
    this.formatReports.schedule((onReported) => {
      reportSinkError(
        this,
        {
          kind: 'format',
          error: failure,
          target: this.currentLogFile ?? this.logDir,
          entry,
          attempt: 1,
          disposition: 'lost',
        },
        this.onError,
        line,
        {
          label: 'FileSink',
          isDiagnostic: isDiagnosticEntry(entry),
          onSettled: onReported,
        },
      );
    }, line);
  }

  /**
   * A value in `entry` would not render and a marker was written in its place.
   *
   * `'fallback'`, because the line goes out: this is advisory, and does not touch
   * `consecutiveFailures`. Guarded by `formatReports` for the same reason the
   * lost-line report is - an `onError` that logs the failure back with the same
   * unrenderable value in it would report from inside its own report, without bound.
   * Under the guard the handler's line still renders, marker and all, and is queued;
   * only the nested report leaves the handler, for the console.
   */
  private reportRenderFallback(entry: LogEntry, error: Error): void {
    const failure = new FileSinkError(
      'Failed to render a value in the log entry; a marker was written in its place',
      error,
    );

    const line = () =>
      `FileSink error rendering an entry for ${this.currentLogFile ?? this.logDir}: ${describeError(failure)}`;

    this.lastError = failure;
    this.formatReports.schedule((onReported) => {
      reportSinkError(
        this,
        {
          kind: 'format',
          error: failure,
          target: this.currentLogFile ?? this.logDir,
          entry,
          disposition: 'fallback',
        },
        this.onError,
        line,
        {
          label: 'FileSink',
          isDiagnostic: isDiagnosticEntry(entry),
          onSettled: onReported,
        },
      );
    }, line);
  }

  /**
   * Record a failure as `lastError` and report it through `onError`, or the console when
   * there is none.
   *
   * Every report this sink makes goes through here except a failed write's, which also
   * carries the attempt and is held by `formatReports` when it is a `'format'` failure.
   * `target` defaults to the file being written, or the directory before there is one.
   *
   * Routed by `entry` when there is one, and otherwise only by what the caller passes -
   * never by whichever entry happens to be in flight. A rotation, an archive collision or
   * a close-time loss belongs to no line, and each is reported once (a rotation only on
   * the first failure of its backoff run): suppressed because the line that triggered it
   * was a forwarded console report, or sent to the console because it was a diagnostic,
   * that one report was the only one `onError` would ever have had.
   */
  private handleError(
    kind: SinkFailureKind,
    failure: Error,
    options: {
      disposition: SinkFailureDisposition;
      /** The line this failure is about, when the sink still has it. */
      entry?: LogEntry;
      target?: string;
      isDiagnostic?: boolean;
      shouldSuppressFailureReport?: boolean;
    },
  ): void {
    this.lastError = failure;
    if (options.shouldSuppressFailureReport === true) {
      return;
    }

    reportSinkError(
      this,
      {
        kind,
        error: failure,
        target: options.target ?? this.currentLogFile ?? this.logDir,
        ...(options.entry === undefined ? {} : { entry: options.entry }),
        disposition: options.disposition,
      },
      this.onError,
      () => describeError(failure),
      {
        label: 'FileSink',
        isDiagnostic: options.isDiagnostic ?? isDiagnosticEntry(options.entry),
      },
    );
  }

  /** The console line for a failed write, the same one {@link processQueue} reports. */
  private describeWriteFailure(error: Error): string {
    return `FileSink error writing to ${this.currentLogFile ?? this.logDir}: ${describeError(error)}`;
  }
}
