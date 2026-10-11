import { isNullish } from '../../internal/is-nullish';
import fs, { promises as fsPromises } from 'fs';
import { describeError, toError } from '../../to-error';
import { renderOnce } from './internal/rendered-line';
import { isConsoleReportActive } from '../../internal/report-to-console';
import { renderJSONLine } from './internal/render-json-line';
import { renderTextEntry } from './internal/render-text-line';
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  MIN_CLOSE_FLUSH_MS,
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
import { describeEntryCount, describeWriteCount } from './internal/loss-ledger';
import { endStreamWithin } from './internal/end-stream';
import { FormatReportScheduler } from './internal/format-report-scheduler';
import { Backoff, openRetryBackoff } from './internal/reopen-backoff';
import {
  DeliveryEngine,
  type DeliverySlot,
  type FlushResult,
  type OpenContext,
  type OpenResult,
  type OpenRouting,
  type WriteOutcome,
} from './internal/delivery-engine';

import type { LogEntry, LogSink, LoggerDiagnostic } from '../types';
import { LogLevel, getLogLevel } from '../types';
import { diagnosticEntry } from '../internal/diagnostic-entry';
import { isDiagnosticEntry } from '../internal/sink-failure-routing';

export type {
  SinkErrorHandler,
  SinkFailure,
  SinkFailureKind,
} from './internal/sink-failure';
export type { FlushResult } from './internal/delivery-engine';

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

/** Today's date as the log file names it: `YYYY-MM-DD`, in UTC. */
function utcDateStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

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
 * that could stop it - the open never settles, so `flush()` hangs and `close()` can only
 * time out - and every pass reserves a fresh collision-free archive name, so it
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
 * `ERR_INVALID_ARG_VALUE` - asynchronously, from the first open, after the constructor
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
   * Cap on entries waiting to be written, the one in flight included. Defaults to 10,000;
   * pass `-1` to hold everything with no cap.
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
   * The same object `NamedPipeSink` hands back: `kind` says what failed, `target` which
   * file it was writing to at the time, `entry` / `attempt` which line and try, and
   * `disposition` what became of the line - `'lost'` is the one that means write it
   * somewhere else. See {@link SinkFailure}.
   */
  onError?: SinkErrorHandler;
}

export interface FileSinkHealth {
  isHealthy: boolean;
  /** Entries not yet written or given up on, the one in flight included. */
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
  /** Whether the log file is open. */
  isInitialized: boolean;
  /** Whether an automatic reopen of the log file is in flight. */
  isReconnecting: boolean;
  /**
   * Entries this sink did not deliver - unrenderable, evicted at `maxQueueSize`, out of
   * retries, logged after `close()` began, still queued when `close()` gave up on them,
   * or failed by a write `close()` ended. Always 0 when none of that has happened.
   */
  droppedEntries: number;
  /** `droppedEntries` by reason. See {@link DroppedEntryCounts}. */
  droppedByKind: DroppedEntryCounts;
}

/**
 * Error handler class for FileSink.
 *
 * `kind` is set where a write is raised as something other than a failed write, and read
 * by `dispatchEntry`: `'setup'` for a line that found no file to write to and was never
 * attempted.
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
 * The rejection for a line that found no stream to write to: raised as `'setup'`, so
 * `dispatchEntry` hands it back to the engine unattempted rather than as a failed write.
 */
function noStreamError(): FileSinkError {
  return new FileSinkError('No log file stream available', undefined, 'setup');
}

/**
 * One entry on its way to the file, with its line already rendered: what `writeEntry` is
 * handed for one attempt.
 *
 * Only a line that rendered reaches here: `write()` reports a render failure and never
 * queues it (see `RenderedLine`). The `LogEntry` comes along because the public `onError`
 * hands it back to the caller.
 */
interface QueuedEntry {
  formatted: string;
  entry: LogEntry;
  /** A console fallback may be forwarded here, but must not start another report. */
  shouldSuppressFailureReport?: boolean;
  /**
   * Tells the engine the line is about to be handed to the stream, so a `close()` that
   * gives up meanwhile knows it may have been written. See {@link DeliverySlot.committed}.
   */
  onCommitted?: () => void;
}

/**
 * FileSink writes logs to files with automatic rotation based on size and date
 *
 * The queue, retries, reopening, reporting, flush windows and close belong to a
 * {@link DeliveryEngine}; this class is the file: options, rendering, opening the log
 * file, the rotation each write goes through, and pairing a failed write's two reports.
 */
export class FileSink implements LogSink {
  private logDir: string;
  private basename: string;
  private maxSizeMB: number;
  private jsonFormat: boolean;
  private minLevel: LogLevel;
  private onError?: SinkErrorHandler;
  private logFileStream?: fs.WriteStream;
  private currentLogFile?: string;
  private currentLogSize = 0;
  /**
   * The queue and everything that happens to a line after it is rendered. See
   * {@link DeliveryEngine}.
   */
  private readonly engine: DeliveryEngine;
  private isInitialized = false;
  /** Spaces failed archive renames: {@link ROTATION_RETRY_INITIAL_MS} doubling to the max. */
  private readonly rotationBackoff = new Backoff({
    initialMS: ROTATION_RETRY_INITIAL_MS,
    maxMS: ROTATION_RETRY_MAX_MS,
  });
  private nextRotationAttemptAt = 0;

  /**
   * The entry the engine is waiting on `writeEntry` for, if any: what routes a rotation's
   * failed reopen, and what keeps a rotation's gap between streams from reading as a lost
   * connection.
   */
  private inFlightEntry?: QueuedEntry;
  /** The entry actually handed to stream.write(), excluding setup and rotation. */
  private activeStreamWriteEntry?: QueuedEntry;

  private closeTimeoutMS: number;

  /**
   * The `'format'` reports in flight, so an `onError` that logs through this same sink
   * cannot feed the loop that reported it.
   *
   * The shape `NamedPipeSink` guards against in `formatEntry`, reached here by a longer
   * road. A handler that re-logs the failure it was handed serializes the `entry` the
   * failure carries, and the `BigInt` or cycle that made *that* entry unrenderable makes
   * the handler's own line unrenderable too. Queued, that line reached the write path on
   * its next turn and was reported again - a drain loop that never ends, with every later
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
    const maxRetries = resolveMaxRetries(
      options.maxRetries,
      'FileSink maxRetries',
    );
    this.minLevel = options.minLevel ?? LogLevel.INFO;
    this.onError = options.onError;
    const maxQueueSize = resolveMaxQueueSize(
      options.maxQueueSize,
      'FileSink maxQueueSize',
    );

    this.engine = new DeliveryEngine({
      adapter: {
        label: 'FileSink',
        // One line at a time, each waiting for its callback before the next goes out.
        maxInFlight: 1,
        // A write the engine has stopped waiting for may still be rotating or writing, and
        // a second `writeEntry` beside it would rotate twice.
        holdsReleasedWrites: true,
        target: () => this.currentLogFile ?? this.logDir,
        open: (context) => this.openFile(context),
        isUsable: () => this.logFileStream !== undefined,
        // A write in flight holds the connection even between streams: a rotation ends one
        // stream and opens the next inside the write, and `close()` must wait for it rather
        // than read the gap as a destination gone.
        hasConnection: () =>
          this.logFileStream !== undefined || this.inFlightEntry !== undefined,
        write: (slot, _context, done, onCommitted) => {
          this.dispatchEntry(slot, done, onCommitted);
        },
        // Nothing to wait on: each write waits for its own callback.
        onDrain: () => false,
        release: () => {
          this.releaseStream();
        },
        // On what is left of the *whole* close's budget, held open by its timer: the
        // caller is awaiting this close, and the engine's report of what the end cost has
        // to reach it before the process exits.
        end: (timeoutMS) => this.endCurrentStream(timeoutMS, false),
        // Closed is not initialized, so not healthy either: the same answer
        // `NamedPipeSink.close()` gives.
        onClosed: () => {
          this.isInitialized = false;
        },
      },
      maxQueueSize,
      maxRetries,
      closeTimeoutMS: this.closeTimeoutMS,
      // The first attempt of an outage at once, then 1 s doubling to 5 s: see
      // `OPEN_RETRY_BACKOFF`.
      backoff: openRetryBackoff(),
      messages: {
        queueFull: (limit) =>
          `Log queue is full (maxQueueSize=${limit}); dropping the oldest entries`,
        // `close()` is bounded by `closeTimeoutMS`, so a slow or broken destination leaves
        // entries behind - and once it gives up nothing will ever process them. Counted in
        // `droppedEntries` and reported once as `'lost'`; see `LossLedger.abandon`. A file
        // that never opened is named as the reason rather than the budget, with the open
        // failure as the cause.
        abandoned: (count, reason) =>
          reason === 'timeout'
            ? `Closed with ${describeEntryCount(count)} still queued (closeTimeoutMS=${String(this.closeTimeoutMS)}); they were not written`
            : `Closed with ${describeEntryCount(count)} still queued: the log file ${reason === 'never_opened' ? 'could not be opened' : 'was lost and could not be reopened'}, so they were not written`,
        // Counted and said, not discarded quietly: `close()` waits up to
        // `closeTimeoutMS`, and a line logged in that window is one this sink did not
        // deliver.
        refusedAfterClose: () =>
          `Entry logged after close() began; it was not written, and further ones are counted in droppedEntries without being reported`,
        unconfirmed: (attempts) =>
          `Write to ${this.currentLogFile ?? this.logDir} was never confirmed by a stream since replaced, after ${String(attempts)} attempts; the entry was given up on and may not have been written`,
        outageCap: (maxReports) =>
          `Reported ${String(maxReports)} distinct failures setting up the log file in ${this.logDir}; further ones are not reported until it opens`,
        reopenFailed: () => 'Failed to set up the log file',
        // `close()` documents a bound, so a slow or hung destination is answered by giving
        // up rather than by hanging - but the entry that was mid-`stream.write` when the
        // deadline passed is in no queue and no counter, so `await close()` resolved and
        // `getHealth()` reported a clean shutdown with a write still outstanding. Whether
        // its bytes landed is genuinely unknown from here: the callback may fire after this
        // resolves, credit the entry as written, and add its length to a file nothing is
        // writing to any more. Unknown is the honest answer, and saying it is what "closed
        // means done" needs in the one case where it is not quite true.
        //
        // Not counted in `droppedEntries`, which means "lines this sink did not deliver" -
        // this line may well have been delivered. `'no_entry'` for the same reason: the
        // failure is about the close, and the entry itself is neither lost nor retrying.
        //
        // This is the entry's only report. Its write may still fail after `close()`
        // resolves - refused by `writeEntry`'s `closed` checks, or failed by the stream
        // `close()` destroyed - and that failure is neither reported nor counted.
        inFlightUnknown: (count) =>
          `Closed with ${count === 1 ? 'a write' : `${String(count)} writes`} still in flight (closeTimeoutMS=${String(this.closeTimeoutMS)}); whether ${count === 1 ? 'it' : 'they'} reached the file is unknown`,
        lostAtClose: (count, bytesLeft) =>
          `Closed with ${describeWriteCount(count)} failing as ${this.currentLogFile ?? this.logDir} was closed (${String(bytesLeft)} bytes still buffered); they were not written`,
      },
      createError: (message, cause) => new FileSinkError(message, cause),
      report: (failure, routing) =>
        reportSinkError(
          this,
          failure,
          this.onError,
          // A report that names an attempt is a line's failed write, and says which file
          // it was writing to; every other report is its own error's description.
          () =>
            failure.attempt === undefined
              ? describeError(failure.error)
              : this.describeWriteFailure(failure.error),
          {
            label: 'FileSink',
            isDiagnostic: routing.isDiagnostic,
            onSettled: routing.onSettled,
          },
        ),
      hasHandler: () => this.onError !== undefined,
    });

    // Opened asynchronously, by the engine: lines written meanwhile are queued, and sent
    // once the file is open.
    this.engine.start();
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

    if (this.closing) {
      // Counted and said, not discarded quietly: `close()` waits up to `closeTimeoutMS`,
      // and a line logged in that window is one this sink did not deliver.
      this.engine.refuseAfterClose(entry);

      return;
    }

    // Rendered here rather than on the write path, which runs after the file has opened and
    // `rotateIfNeeded` has been awaited: by then the caller has had the chance to mutate
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
    this.engine.enqueue({
      line: rendered.formatted ?? '',
      entry,
      shouldSuppressFailureReport,
    });
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
    const health = this.engine.getHealth();

    return {
      // The engine's answer - no failed writes, connected, not closing - and a stream in
      // hand, which a failed write takes away before the engine hears of it.
      isHealthy: health.isHealthy && this.isInitialized,
      queueSize: health.queueSize,
      lastError: health.lastError,
      consecutiveFailures: health.consecutiveFailures,
      // This sink's own: whether a stream is open, which a failed write clears at once.
      isInitialized: this.isInitialized,
      isReconnecting: health.isReconnecting,
      droppedEntries: health.droppedEntries,
      droppedByKind: health.droppedByKind,
    };
  }

  /**
   * Wait for every queued line to be written, and say what happened since the last flush.
   *
   * Resolves when the queue is empty; during an outage, once an attempt to open the file
   * made after this call has failed, or at once when the next attempt falls after the
   * deadline (`success: false`, `timedOut: false`, the lines still queued in
   * `entriesQueued`); or at the deadline (`timedOut: true`). See
   * {@link DeliveryEngine.flush}.
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

    // The clock starts here, before the wait rather than after it: `timeoutMS` is
    // documented as the maximum time this call takes, and an open that never settles is
    // exactly the case a caller sets one for.
    const startTime = Date.now();

    return await this.engine.flush(timeoutMS, startTime);
  }

  /**
   * Close the log file and wait for all pending writes
   */
  public close(): Promise<void> {
    // One close however many callers ask, published before any close-time callback can
    // re-enter close().
    return this.engine.close();
  }

  /** The most recent open attempt, settled. Never rejects. */
  private get initPromise(): Promise<void> {
    return this.engine.openSettled;
  }

  /** `close()` has begun, or finished: see {@link DeliveryEngine.isClosing}. */
  private get closing(): boolean {
    return this.engine.isClosing;
  }

  /** `close()` has stopped draining and finished with the queue. */
  private get closed(): boolean {
    return this.engine.isClosed;
  }

  /** The log file for today's UTC date, or for `date`. */
  private logFilePath(date = utcDateStamp()): string {
    return `${this.logDir}/${this.basename}-${date}.log`;
  }

  /** The rotation threshold in bytes. */
  private get maxSizeBytes(): number {
    return this.maxSizeMB * 1024 * 1024;
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
   * `writeEntry` forever with the line still in flight, so the queue never drained again.
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
   * Open the log file: the engine's `open`, made at construction and then on the engine's
   * own timer for as long as the file cannot be opened.
   *
   * A failure is reported once per distinct failure per outage (see
   * {@link DeliveryEngine.reportOpenFailure}), routed by what is queued: a directory that
   * cannot be created, a path that is a directory, `EACCES`, `EMFILE`. It spends no line's
   * attempts - the lines wait in the queue, bounded by `maxQueueSize`, and go out once an
   * attempt succeeds. Never rejects: what `setupLogFile` throws is the attempt's answer.
   */
  private async openFile(context: OpenContext): Promise<OpenResult> {
    // A stream still in hand is the connection: there is nothing to reopen.
    if (this.logFileStream !== undefined && !this.logFileStream.destroyed) {
      return { status: 'open' };
    }

    try {
      await this.setupLogFile();
    } catch (error) {
      this.reportSetupFailure(error, this.engine.openRouting(context));

      return { status: 'unavailable' };
    }

    // No stream and nothing thrown: `close()` finished while this was opening, or a
    // rotation the open ran could not reopen the file and has said so.
    return this.logFileStream === undefined
      ? { status: 'unavailable' }
      : { status: 'open' };
  }

  /**
   * Say that the log file could not be set up, as an outage rather than a line's failure:
   * `'setup'`, `'no_entry'`, once per distinct failure until the file opens again.
   *
   * The message names the underlying error, whose text names the path (`ENOTDIR: not a
   * directory, mkdir '/var/log/app'`), so two different failures during one outage - a
   * directory missing, then present but unwritable - are both said.
   */
  private reportSetupFailure(error: unknown, routing: OpenRouting): void {
    this.engine.reportOpenFailure(
      'setup',
      `Failed to setup log file: ${describeError(error)}`,
      error,
      routing.isDiagnostic,
      routing.shouldSuppressFailureReport,
    );
  }

  /**
   * Hand one line to {@link writeEntry}: the engine's `write`.
   *
   * The write is confirmed when `writeEntry` settles, after any rotation it had to do. A
   * line that found no file to write to was never attempted, and goes back to the engine
   * as `'unavailable'` with its attempts unspent; anything else that rejects is a failed
   * write for the engine to report, count and retry.
   */
  private dispatchEntry(
    slot: DeliverySlot,
    done: (outcome: WriteOutcome) => void,
    onCommitted: () => void,
  ): void {
    const queued: QueuedEntry = {
      formatted: slot.line,
      entry: slot.entry,
      shouldSuppressFailureReport: slot.shouldSuppressFailureReport,
      onCommitted,
    };

    this.inFlightEntry = queued;

    let written: Promise<void>;

    try {
      written = Promise.resolve(this.writeEntry(queued));
    } catch (error) {
      written = Promise.reject(toError(error));
    }

    // Cleared only if it is still this entry: the outcome can send the next line out,
    // which takes its place.
    const release = (): void => {
      if (this.inFlightEntry === queued) {
        this.inFlightEntry = undefined;
      }
    };

    void written.then(
      () => {
        done({ status: 'written' });
        release();
      },
      (error: unknown) => {
        if (this.activeStreamWriteEntry === queued) {
          this.activeStreamWriteEntry = undefined;
        }

        // `toError`, not `String(error)`: the coercion runs on the entry's only retry and
        // `onError` path, and `String()` invokes a `toString` this does not own. A value
        // whose `toString` throws made the coercion throw from inside the handler,
        // skipping `onError`, the re-queue and the failure counters, and escaping as an
        // unhandled rejection that left every queued entry behind it stalled.
        const failure = toError(error);
        const kind =
          failure instanceof FileSinkError ? failure.kind : undefined;

        done(
          kind === 'setup'
            ? { status: 'unavailable' }
            : { status: 'failed', error: failure, isRetryable: true },
        );
        release();
      },
    );
  }

  /**
   * Write one rendered line to the file, rotating first when a rotation is due. A stream
   * that is gone fails as `'setup'`, which hands the line back unattempted for the
   * engine's reopen to carry.
   */
  private async writeEntry(queued: QueuedEntry): Promise<void> {
    if (this.closed) {
      throw new FileSinkError('Cannot write to closed sink');
    }

    // The stream went away after the engine handed this line over. Never attempted, so it
    // goes back to the queue with its attempts unspent, for the reopen to carry.
    if (!this.logFileStream) {
      throw noStreamError();
    }

    // Check rotation before writing (handles date change and size limit)
    await this.rotateIfNeeded();

    // Asked again, after `rotateIfNeeded`. `close()` bounds its drain
    // loop and returns while a pass that started before the deadline is still suspended in
    // one of those, so the check at the top of this method is not the last word: that pass
    // resumed and wrote a line to disk *after* `await close()` had already resolved and
    // reported the sink shut down. Raised as an ordinary write failure so the entry is
    // counted and reported like any other line this sink did not deliver, rather than
    // landing in a file nobody is expecting to grow any more.
    if (this.closed) {
      throw new FileSinkError('Cannot write to closed sink');
    }

    // Always the line rendered in `write`, which reports a render that threw and never
    // queues it, so this is never a second attempt at one.
    const messageToWrite = queued.formatted;
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
    if (
      this.currentLogSize > 0 &&
      this.currentLogSize + messageBytes > this.maxSizeBytes
    ) {
      await this.rotateFile();
    }

    // `close()` may finish while the oversized-line rotation above is suspended. A
    // rotation that notices the close returns without changing the stream, so do not let
    // this older write continue into a sink that has already reported itself closed.
    if (this.closed) {
      throw new FileSinkError('Cannot write to closed sink');
    }

    // Write to file
    return await new Promise<void>((resolve, reject) => {
      // Rejected, not resolved. The stream can disappear *after* the check above: its
      // `'error'` handler calls `destroyStream` on a `nextTick`, which lands while this
      // method is suspended in `rotateIfNeeded` or `rotateFile` - both awaited after that
      // check - and a rotation whose reopen failed leaves none. Resolving here reported the
      // loss as a successful write, so the queue counted the line written and `onError`
      // never fired for a line that was never written. The line was not attempted, so it
      // goes back to the queue for the reopen to carry.
      if (!this.logFileStream) {
        return reject(noStreamError());
      }

      const writingTo = this.logFileStream;

      this.activeStreamWriteEntry = queued;
      queued.onCommitted?.();
      writingTo.write(messageToWrite, (err) => {
        if (this.activeStreamWriteEntry === queued) {
          this.activeStreamWriteEntry = undefined;
        }
        if (err) {
          // Torn down here, so the stream's own `'error'` event, which follows this
          // callback, finds a stream no longer in hand and reports nothing: this
          // rejection, which knows the line and whether it is coming back, is the report.
          //
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

          reject(new FileSinkError('Error writing to log file', err));
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
   * Open the log file for today: create the directory and the file if they are missing,
   * open a stream on it and wait for the descriptor, and rotate it if it is already over
   * the size limit.
   *
   * Throws what stopped it - `mkdir`'s `ENOTDIR` or `EACCES`, the open's `EISDIR` or
   * `EMFILE` - for the caller to report as an outage. The stream is installed only once it
   * has opened, so a stream this sink holds always has a descriptor, and a failure it
   * reports later is a failed write.
   */
  private async setupLogFile(shouldSkipRotation = false): Promise<void> {
    // Nothing to open for a sink that is already closed. `close()` bounds its own wait for
    // an open, so an attempt suspended in here - a slow `mkdir` on a network mount is
    // enough - can resume *after* `close()` resolved. It then opened a fresh descriptor
    // nothing would ever close and set `isInitialized` back to `true`, so `getHealth()`
    // reported a closed sink as initialized - the state `close()` clears the flag to
    // prevent. Checked again below for the same reason: every await here is a place
    // `close()` can run.
    //
    // `closed` only, not `closing`. `close()` raises `closing` *before* the drain it exists
    // to run, and opens the file for that drain when lines are queued and nothing is open
    // yet - `new FileSink(...)`, one `write()`, `await close()`. The descriptor a drain-phase
    // open creates is still the one `close()` ends afterwards, since `endCurrentStream`
    // reads whatever stream is current when it runs.
    if (this.closed) {
      return;
    }

    const currentLogFile = this.logFilePath();

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

    const stream = fs.createWriteStream(currentLogFile, { flags: 'a' });

    // Attached before anything awaits, so no error the stream emits is ever unhandled.
    stream.on('error', (streamError: unknown) => {
      this.handleStreamError(stream, streamError);
    });

    // `createWriteStream` returns a stream for a path it cannot open and fails afterwards,
    // as an event: waited for here, so that failure is this open's, not a write's.
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        stream.off('error', onError);
        resolve();
      };
      const onError = (error: unknown): void => {
        stream.off('open', onOpen);
        reject(toError(error));
      };

      stream.once('open', onOpen);
      stream.once('error', onError);
    });

    // Let go of, not overwritten: a stream installed while this one was opening - a
    // reopen after a stream error, racing a rotation's own - would otherwise keep its
    // descriptor for the life of the process, since nothing else holds it to end.
    if (this.logFileStream !== undefined) {
      this.releaseStream();
    }

    this.logFileStream = stream;
    this.currentLogFile = currentLogFile;

    // Get current file size
    try {
      const stats = await fsPromises.stat(currentLogFile);
      this.currentLogSize = stats.size;
    } catch {
      this.currentLogSize = 0;
    }

    // Rotate if already at size limit
    if (!shouldSkipRotation && this.currentLogSize >= this.maxSizeBytes) {
      await this.rotateFile();
    }

    // Closed while the size was being read, so this stream has already outlived the
    // teardown that would have ended it. Torn down here rather than left for nobody: the
    // descriptor is the leak, and `isInitialized` must not go back up behind a `close()`
    // that cleared it.
    //
    // `closed` only, for the reason the guard at the top of this method is: a stream
    // opened while `close()` is still draining is the stream those queued entries are
    // written through, and destroying it here left them with nowhere to go.
    if (this.closed) {
      this.destroyStream();

      return;
    }

    // Only for the stream this call opened. A failure reported while this was suspended in
    // `stat` or `rotateFile` has already torn it down, and a rotation replaces it and marks
    // its own; there is nothing for this to say about a stream it no longer holds.
    if (this.logFileStream === stream) {
      this.isInitialized = true;
    }
  }

  /**
   * A stream this sink opened reported an error.
   *
   * When it is the stream in hand, reported as the end of that connection, which the
   * engine recovers from on its own timer. A failed write's callback has already torn its
   * stream down and reported through its rejection, so its event never gets this far.
   */
  private handleStreamError(
    stream: fs.WriteStream,
    streamError: unknown,
  ): void {
    // The stream that failed, not whatever is current. A rotation replaces this stream, and
    // the one it replaced can still deliver its error afterwards - ungated, that late error
    // destroyed the *live* stream, failing whatever write was in flight on it and forcing a
    // needless reopen. A stream nobody is holding, or one whose open failed, is simply torn
    // down: an open's failure is the open's to report.
    if (this.logFileStream !== stream) {
      try {
        stream.destroy();
      } catch {
        // Nothing further to try for a stream nothing is using.
      }

      return;
    }

    this.destroyStream();

    // Reported, not only torn down: an async failure with no write in flight to pair it
    // with - the disk filling, the file removed underneath the descriptor - must not leave
    // `getHealth()` answering `isHealthy: true` with a stale `lastError` and `onError`
    // never fired. A failed write reports through its own rejection; this covers the
    // failure that has no line to attach to, and counts against health, since the stream
    // had a descriptor.
    //
    // No `entry`: the stream failed on its own, not while carrying a line this sink can
    // name. Anything queued is retried on the reopened stream and reported on its own terms
    // if that fails. Routed by the entry in flight all the same: unlike a rotation, a
    // stream failure is not latched, so one from a forwarded console line that reached the
    // console again would come back as another such line.
    const failure = new FileSinkError(
      `Log file stream failed: ${this.currentLogFile ?? this.logDir}`,
      toError(streamError),
    );
    const shouldSuppressFailureReport =
      this.activeStreamWriteEntry?.shouldSuppressFailureReport === true ||
      this.inFlightEntry?.shouldSuppressFailureReport === true;
    const isDiagnostic = isDiagnosticEntry(
      this.activeStreamWriteEntry?.entry ?? this.inFlightEntry?.entry,
    );

    this.engine.connectionLost(
      {
        isDiagnosticRetry: isDiagnostic,
        shouldSuppressRetryReport: shouldSuppressFailureReport,
      },
      () => {
        this.handleError('write', failure, {
          disposition: 'no_entry',
          countsAgainstHealth: true,
          shouldSuppressFailureReport,
          isDiagnostic,
        });
      },
    );
  }

  /**
   * Reopen the log file after a rotation ended the stream, reporting a failure as an
   * outage rather than throwing it into the write that rotated.
   *
   * The write then finds no stream and goes back to the queue unattempted, and the engine
   * reopens on its own timer. Routed as the engine routes its own reopen: by the line in
   * flight, unless ordinary work is queued behind it.
   */
  private async reopenAfterRotation(shouldSkipRotation = false): Promise<void> {
    try {
      await this.setupLogFile(shouldSkipRotation);
    } catch (error) {
      if (this.closed) {
        return;
      }

      this.reportSetupFailure(
        error,
        this.engine.openRouting({
          isDiagnosticRetry: isDiagnosticEntry(this.inFlightEntry?.entry),
          shouldSuppressRetryReport:
            isConsoleReportActive() ||
            this.inFlightEntry?.shouldSuppressFailureReport === true,
        }),
      );
    }
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
   * Let go of the current stream without waiting: the engine's `release`. Flushed if it
   * can be, within {@link MIN_CLOSE_FLUSH_MS}, and destroyed if it cannot, on an
   * unreferenced timer - letting go is never a reason for the process to stay alive.
   */
  private releaseStream(): void {
    const stream = this.logFileStream;

    if (stream === undefined) {
      return;
    }

    this.logFileStream = undefined;
    this.isInitialized = false;

    if (!stream.destroyed) {
      void endStreamWithin(stream, MIN_CLOSE_FLUSH_MS, { shouldUnref: true });
    }
  }

  /**
   * Rotate log file if needed based on size or date
   */
  private async rotateIfNeeded(): Promise<void> {
    if (!this.logFileStream || !this.currentLogFile) {
      return;
    }

    // Date changed - setup new file
    if (this.currentLogFile !== this.logFilePath()) {
      // Guarded exactly as `rotateFile()` is, and for both of its reasons. This branch
      // awaits `endCurrentStream(this.closeTimeoutMS)` - a *fresh* full-length wait, begun
      // from inside a close that is already keeping its own budget, so a UTC midnight
      // crossed during a shutdown on a stalled mount made a documented thirty-second bound
      // a sixty-second one. And it ends the stream `close()` is draining through to open the
      // next day's file, which past `closed` is a descriptor nothing will ever close. The
      // entry in hand goes to the day the sink was already writing, which is the right
      // trade at shutdown: a log line in the previous day's file, rather than a close that
      // overshoots its bound or a stream that outlives it.
      if (this.closing) {
        return;
      }

      // Ended first, exactly as `rotateFile()` ends it, so whatever sat in its buffer is
      // flushed to the day it was written for.
      await this.endStreamForRotation();
      await this.reopenAfterRotation();

      return;
    }

    // Size limit reached
    if (this.currentLogSize >= this.maxSizeBytes) {
      await this.rotateFile();
    }
  }

  /**
   * End the current stream for a rotation, bounded (see {@link endCurrentStream}), and
   * report what the bound gave up on rather than dropping it (see
   * {@link reportRotationFlushLoss}). Called before any rename moves the file, so the report
   * names the file the bytes were written for.
   */
  private async endStreamForRotation(): Promise<void> {
    const bytesLeft = await this.endCurrentStream(this.closeTimeoutMS, true);

    this.reportRotationFlushLoss(bytesLeft, this.currentLogFile ?? this.logDir);
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
    if (this.closing) {
      return;
    }

    // Keep the writable file open during an archive outage. All size-rotation
    // paths share this gate, including setup and the before-write size check.
    if (Date.now() < this.nextRotationAttemptAt) {
      return;
    }

    const currentDate = utcDateStamp();

    await this.endStreamForRotation();

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
      await this.reopenAfterRotation();
      return;
    }

    try {
      await fsPromises.rename(this.currentLogFile, rotatedFile);
    } catch (error) {
      const failure = new FileSinkError(
        `Error rotating log file from ${this.currentLogFile} to ${rotatedFile}`,
        toError(error),
      );
      const shouldReport = this.rotationBackoff.isAtRest;
      this.nextRotationAttemptAt = Date.now() + this.rotationBackoff.next();
      // Recorded on every failure, reported on the first of a backoff run.
      if (shouldReport) {
        this.handleError('setup', failure, { disposition: 'no_entry' });
      } else {
        this.engine.recordError(failure);
      }

      // The current file may still be writable when archiving is not. Reopen it
      // without immediately trying to rotate its unchanged size again; otherwise
      // reopening recurses indefinitely. A later write after the backoff will retry;
      // recovery needs no restart.
      await this.reopenAfterRotation(true);
      return;
    }

    this.rotationBackoff.reset();
    this.nextRotationAttemptAt = 0;

    // Setup new file (queue processing will resume after this)
    await this.reopenAfterRotation();
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

    this.engine.countLoss('format');

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

    this.engine.recordError(failure);
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

    this.engine.recordError(failure);
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
   * there is none. See {@link DeliveryEngine.report}.
   *
   * Every report this sink makes goes through here except a failed write's, which the
   * engine makes with the attempt, and a `'format'` failure's, held by `formatReports`.
   * `target` defaults to the file being written, or the directory before there is one.
   *
   * Routed by `entry` when there is one, and otherwise only by what the caller passes -
   * never by whichever entry happens to be in flight. A rotation, an archive collision or
   * a close-time loss belongs to no line, and each is reported once (a rotation only on
   * the first failure of its backoff run): suppressed because the line that triggered it
   * was a forwarded console report, or sent to the console because it was a diagnostic,
   * that one report was the only one `onError` would ever have had.
   *
   * Not counted against health unless `countsAgainstHealth` says so: only a failed write
   * on an open stream is.
   *
   * Answers whether the report went out rather than being suppressed.
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
      countsAgainstHealth?: boolean;
    },
  ): boolean {
    return this.engine.report(kind, failure, {
      ...options,
      countsAgainstHealth: options.countsAgainstHealth ?? false,
    });
  }

  /** The console line for a failed write, the one the engine's write reports fall back to. */
  private describeWriteFailure(error: Error): string {
    return `FileSink error writing to ${this.currentLogFile ?? this.logDir}: ${describeError(error)}`;
  }
}
