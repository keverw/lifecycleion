import fs, { promises as fsPromises } from 'fs';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import { reportThroughHandler } from '../../internal/failure-reporter';
import { renderJSONLine } from './internal/render-json-line';
import { renderTextLine } from './internal/render-text-line';
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  resolveMaxQueueSize,
  resolveMaxRetries,
  resolveTimeoutMS,
} from './internal/queue-policy';
import {
  createDroppedEntryCounts,
  type DroppedEntryCounts,
  type DroppedEntryKind,
  type SinkErrorHandler,
  type SinkFailureKind,
} from './internal/sink-failure';

import type { LogEntry, LogSink, LoggerDiagnostic } from '../types';
import { LogLevel, getLogLevel } from '../types';
import { diagnosticEntry } from '../internal/diagnostic-entry';

export type {
  SinkErrorHandler,
  SinkFailure,
  SinkFailureKind,
} from './internal/sink-failure';

/**
 * The shortest flush `close()` will ask for, however little of its budget is left.
 *
 * The same floor, and for the same reason, as `NamedPipeSink`'s: the drain loop spends the
 * close budget before the flush is reached, and a zero-millisecond timer registered in the
 * same tick as `end()` always wins against a `'finish'` that cannot fire synchronously.
 * Without it the final flush would not merely be short but impossible. A tenth of a second
 * is what a close can overshoot by, against a default of thirty.
 */
const MIN_CLOSE_FLUSH_MS = 100;

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
 * `Infinity` is left alone: it is the honest spelling of "never rotate on size". Anything
 * unusable - zero, negative, `NaN`, a non-number from untyped config - takes the default
 * rather than being honoured literally, the same answer the queue options give.
 */
function resolveMaxSizeMB(requested?: number): number {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    return DEFAULT_MAX_SIZE_MB;
  }

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
  maxSizeMB?: number;
  jsonFormat?: boolean;
  maxRetries?: number;
  closeTimeoutMS?: number;
  minLevel?: LogLevel;
  /**
   * Cap on entries waiting to be written. Defaults to 10,000; pass `-1` to hold
   * everything, which is what this did before the option had a default.
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
  maxQueueSize?: number;
  /**
   * Notified when this sink cannot do its job, in the shape every sink reports.
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
 * Error handler class for FileSink
 */
class FileSinkError extends Error {
  constructor(
    message: string,
    public cause?: Error,
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
  private droppedEntries = 0;
  private readonly droppedByKind = createDroppedEntryCounts();
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
  private pendingFlush: Promise<void> = Promise.resolve();
  private didReportDrop = false;
  private isInitialized = false;
  private initPromise?: Promise<void>;
  private isProcessing = false;
  private lastError?: Error;
  private consecutiveFailures = 0;
  private rotationRetryDelayMS = 0;
  private nextRotationAttemptAt = 0;
  private totalEntriesWritten = 0;
  /**
   * Whether the first entry refused because the sink is closing has been reported.
   *
   * See {@link write}. Every such entry is counted; only the first is reported.
   */
  private reportedCloseRefusal = false;

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

  private closing = false;
  private closed = false;
  private closeTimeoutMS: number;

  /**
   * How many `'format'` failures are being reported right now, so an `onError` that logs
   * through this same sink cannot feed the loop that reported it.
   *
   * The shape `NamedPipeSink` guards against in `formatEntry`, reached here by a longer
   * road. A handler that re-logs the failure it was handed - `logger.error('sink failed',
   * { failure })` is the natural one - serializes the `entry` the failure carries, and the
   * `BigInt` or cycle that made *that* entry unrenderable makes the handler's own line
   * unrenderable too. That line was queued, `processQueue` reached it on its next turn,
   * reported it, and the handler logged again: a drain loop that never ended, with every
   * later line stuck behind it. While this is above zero, a line that fails to render is
   * counted in `droppedEntries` and not reported, which is where the chain stops.
   *
   * A count held until the handler *settles*, not a flag cleared on return. An `async`
   * handler returns at its first `await`, and a flag cleared there was down again by the
   * time the handler resumed and logged - so the chain ran on, one report per turn of the
   * event loop. And a count rather than a flag because the drain loop keeps going while
   * that handler is still pending: a second failure reported meanwhile must not clear the
   * guard the first one still holds.
   */
  private formatReportActive = false;
  private invokingFormatReport = false;
  private deliveringDeferredFormatReport = false;
  private deferredFormatReport?: (onReported: () => void) => void;

  constructor(options: FileSinkOptions) {
    this.logDir = options.logDir;
    this.basename = resolveBasename(options.basename);
    this.maxSizeMB = resolveMaxSizeMB(options.maxSizeMB);
    this.jsonFormat = options.jsonFormat ?? false;
    this.maxRetries = resolveMaxRetries(options.maxRetries);
    this.closeTimeoutMS = resolveTimeoutMS(
      options.closeTimeoutMS,
      DEFAULT_CLOSE_TIMEOUT_MS,
    );
    this.minLevel = options.minLevel ?? LogLevel.INFO;
    this.onError = options.onError;
    this.maxQueueSize = resolveMaxQueueSize(options.maxQueueSize);

    // Initialize asynchronously
    this.initPromise = this.initialize();
  }

  public write(entry: LogEntry): void {
    // Check if log level is below minimum threshold (skip for raw logs)
    if (entry.type !== 'raw') {
      const logLevel = getLogLevel(entry.type);
      if (logLevel > this.minLevel) {
        return;
      }
    }

    if (this.closing || this.closed) {
      // After the level filter, never before it: an entry below `minLevel` was never
      // going to be written, so it is not a line this sink failed to deliver and must not
      // land in `droppedEntries` - or fire a `'close'` report for a `debug` line.
      // Counted and said, not discarded quietly - the same answer `NamedPipeSink` gives.
      // `close()` waits up to `closeTimeoutMS`, and every line logged in that window left
      // through this early return with `droppedEntries` unmoved, `onError` silent and
      // `getHealth()` reporting a clean shutdown. `abandonQueueOnClose` counts what was
      // already queued; these are the ones refused at the door.
      this.countDropped('close');

      // Once, for the reason the abandoned queue reports once: an application still
      // logging through a thirty-second close would otherwise get a callback per line.
      if (!this.reportedCloseRefusal) {
        this.reportedCloseRefusal = true;

        const failure = new FileSinkError(
          `Entry logged after close() began; it was not written, and further ones are counted in droppedEntries without being reported`,
        );

        this.lastError = failure;

        reportThroughHandler(
          this.onError === undefined
            ? undefined
            : () =>
                this.onError?.({
                  kind: 'close',
                  error: failure,
                  target: this.currentLogFile ?? this.logDir,
                  entry,
                  disposition: 'lost',
                }),
          () => describeError(failure),
          undefined,
          'FileSink failure handler',
        );
      }

      return;
    }

    // Rendered here rather than on the write path, which runs after `setupLogFile` and
    // `rotateIfNeeded` have been awaited: by then the caller has had the chance to mutate
    // the bag `entry.redactedParams` points at, since redaction no longer copies it.
    const rendered = renderOnce(() => this.formatEntry(entry));

    // The one deferred report is the recursion fuse. If its handler logs another value
    // that cannot render, count that line but do not enqueue a third generation which
    // would begin after the guard settled and repeat forever.
    if (
      rendered.formatError !== undefined &&
      (this.invokingFormatReport || this.deliveringDeferredFormatReport)
    ) {
      this.countDropped('format');

      return;
    }

    // Add to queue with retry tracking
    this.writeQueue.push({ entry, attempts: 0, ...rendered });
    this.enforceQueueLimit();

    // Process queue if initialized
    if (this.isInitialized) {
      void this.processQueue();
    } else if (this.initPromise) {
      void this.initPromise.then(() => this.processQueue());
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
      droppedEntries: this.droppedEntries,
      droppedByKind: { ...this.droppedByKind },
    };
  }

  /**
   * Flush all pending writes and wait for completion
   * Returns statistics about the flush operation
   * @param requestedTimeoutMS Maximum time to wait in milliseconds (default: 30000ms /
   *        30s). `NaN`, a non-number, or a negative value takes the default; `Infinity`
   *        waits as long as a timer can.
   */
  public async flush(
    requestedTimeoutMS: number = DEFAULT_CLOSE_TIMEOUT_MS,
  ): Promise<FlushResult> {
    // Resolved rather than used literally, for the reason `closeTimeoutMS` is: `NaN` made
    // the deadline check below never true, so `flush(Number(process.env.UNSET))` waited on
    // a stalled queue for good, and `Infinity` made the init race below give up at once.
    const timeoutMS = resolveTimeoutMS(
      requestedTimeoutMS,
      DEFAULT_CLOSE_TIMEOUT_MS,
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
      let timer: NodeJS.Timeout | undefined;
      try {
        const isReady = await Promise.race([
          previous.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMS);
          }),
        ]);
        if (!isReady) {
          // This caller never owned a counting window. Leave the counters for the
          // active flush, and do not run an abandoned window later.
          return {
            success: false,
            entriesWritten: 0,
            entriesFailed: 0,
            timedOut: true,
          };
        }
      } finally {
        clearTimeout(timer);
      }
      return this.flushWindow(timeoutMS, startTime);
    })();

    this.pendingFlush = previous
      .then(() => run)
      .then(
        () => undefined,
        () => undefined,
      );

    return run;
  }

  /**
   * Close the log file and wait for all pending writes
   */
  public async close(): Promise<void> {
    this.closing = true;

    const startTime = Date.now();

    // Wait for initialization with timeout
    if (this.initPromise) {
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutSentinel = { timedOut: true } as const;

      try {
        const timeoutPromise = new Promise<typeof timeoutSentinel>(
          (resolve) => {
            timeoutHandle = setTimeout(
              () => resolve(timeoutSentinel),
              this.closeTimeoutMS,
            );
          },
        );

        const result = await Promise.race([
          this.initPromise.then(() => undefined),
          timeoutPromise,
        ]);

        // Check if timeout fired
        if (result === timeoutSentinel) {
          // Timeout fired - prevent unhandled rejection if initPromise fails later
          Promise.resolve(this.initPromise).catch(() => {
            // Intentionally ignore errors after timeout
          });
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    // Whether the drain gave up with a write still in flight, rather than with only a
    // backlog left. `abandonQueueOnClose()` reports the backlog; the entry already shifted
    // out of the queue and handed to `stream.write` belongs to neither counter, so a close
    // that timed out mid-write answered exactly like a clean one.
    let didAbandonInFlightWrite = false;

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > this.closeTimeoutMS) {
        didAbandonInFlightWrite = this.isProcessing;

        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
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

    // Close stream, on what is left of the *whole* close's budget. `endStream()` waits on
    // `stream.end(cb)`, which flushes before it calls back - so with `logDir` on a hung
    // network mount, or a path that resolves to a FIFO or device with no reader, that
    // callback never fired and `await sink.close()` never resolved: a shutdown hang from
    // the one method that documents a bound. `closeTimeoutMS` covered the init wait and
    // the drain loop above and stopped short of the flush that follows them.
    //
    // Floored, for the reason `NamedPipeSink.close()` floors its own: the drain loop exits
    // on the same deadline, so a stalled destination arrives here with nothing left, and a
    // zero-millisecond timer registered in the same tick as `end()` always beats a
    // `'finish'` that cannot fire synchronously - which would make the final flush
    // unreachable for a stream that would have flushed at once.
    const remainingCloseMS = Math.max(
      MIN_CLOSE_FLUSH_MS,
      this.closeTimeoutMS - (Date.now() - startTime),
    );

    const bytesLeft = await this.endStreamWithin(remainingCloseMS);

    // What the flush timeout gave up on, said before this resolves - the same report at
    // the same moment as `NamedPipeSink.close()`. This sink writes one line at a time and
    // waits for its callback, so the stream's buffer can hold nothing but the write that
    // was in flight when the drain gave up, and that one is reported just above. This is
    // the backstop for the case the model says cannot happen: bytes the stream still
    // held at the timeout that no report has named. Skipped when the in-flight report
    // fired, since it would describe the same bytes twice.
    if (bytesLeft > 0 && !didAbandonInFlightWrite) {
      const failure = new FileSinkError(
        `Closed with ${String(bytesLeft)} bytes still buffered for ${this.currentLogFile ?? this.logDir} (closeTimeoutMS=${String(this.closeTimeoutMS)}); whether they reached the file is unknown`,
      );

      this.lastError = failure;

      reportThroughHandler(
        this.onError === undefined
          ? undefined
          : () =>
              this.onError?.({
                kind: 'close',
                error: failure,
                target: this.currentLogFile ?? this.logDir,
                disposition: 'no_entry',
              }),
        () => describeError(failure),
        undefined,
        'FileSink failure handler',
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
   * `kind: 'close'`, because a rotation's loss happens while ending a stream and that is
   * what the close channel names; `disposition: 'no_entry'`, because the bytes are a
   * stream buffer rather than any one entry this sink could hand back.
   */
  private reportRotationFlushLoss(bytesLeft: number, target: string): void {
    if (bytesLeft <= 0) {
      return;
    }

    const failure = new FileSinkError(
      `Rotation abandoned ${String(bytesLeft)} bytes still buffered for ${target} (closeTimeoutMS=${String(this.closeTimeoutMS)}); whether they reached the file is unknown`,
    );

    this.lastError = failure;

    reportThroughHandler(
      this.onError === undefined
        ? undefined
        : () =>
            this.onError?.({
              kind: 'close',
              error: failure,
              target,
              disposition: 'no_entry',
            }),
      () => describeError(failure),
      undefined,
      'FileSink failure handler',
    );
  }

  /**
   * End the current stream and wait for it to flush, giving up after `timeoutMS`.
   *
   * The bound is the whole point, and it is needed wherever the sink waits on a flush -
   * not only at `close()`. `end(cb)` flushes before it calls back, so on a hung network
   * mount or a path that resolves to a FIFO with no reader that callback never fires: the
   * first size-triggered rotation then suspended `writeEntry` forever with `isProcessing`
   * still set, so the queue never drained again, later lines were evicted at
   * `maxQueueSize`, and `flush()` and `close()` could only time out. A rotation that gives
   * up on the flush loses what was buffered in that one stream; a rotation that never
   * returns loses the sink.
   */
  private async endStreamWithin(timeoutMS: number): Promise<number> {
    const stream = this.logFileStream;

    let flushTimeout: NodeJS.Timeout | undefined;

    try {
      await Promise.race([
        this.endStream(),
        new Promise<void>((resolve) => {
          flushTimeout = setTimeout(
            resolve,
            Math.max(MIN_CLOSE_FLUSH_MS, timeoutMS),
          );

          // Never a reason to hold the process up, as every timer in `NamedPipeSink` is
          // not. This is armed on ordinary size- and date-triggered rotations too, not
          // only on `close()`, so on a stalled mount a rotation would otherwise keep the
          // event loop alive for the whole `closeTimeoutMS` and block exit.
          flushTimeout.unref?.();
        }),
      ]);
    } finally {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
      }
    }

    // Whatever `end()` did not manage in that window is not going to happen: the descriptor
    // is released rather than held for the life of the process. Cleared only if it is still
    // the stream this found, matching `endStream()`'s own check. How much it still held is
    // answered to the caller, so `close()` can say so.
    let bytesLeft = 0;

    if (stream && !stream.destroyed) {
      bytesLeft = stream.writableLength;

      try {
        stream.destroy();
      } catch {
        // Best effort; the stream is going away either way.
      }
    }

    if (this.logFileStream === stream) {
      this.logFileStream = undefined;
    }

    return bytesLeft;
  }

  /**
   * End the current stream and wait for it to flush.
   *
   * The one place that does this, because every caller has to: `end()` is what flushes
   * what is buffered, and a stream replaced without it keeps its descriptor and loses its
   * buffer. `close()` and both rotation paths reach it through `endStreamWithin`, which is
   * what puts a bound on the wait.
   */
  private async endStream(): Promise<void> {
    const stream = this.logFileStream;

    if (!stream) {
      return;
    }

    await new Promise<void>((resolve) => {
      stream.end(() => {
        resolve();
      });
    });

    // Cleared only if it is still the one this ended: a rotation that ran while `end()`
    // was flushing has already installed its replacement, and clearing unconditionally
    // would drop a live stream on the floor.
    if (this.logFileStream === stream) {
      this.logFileStream = undefined;
    }
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
   */
  private reportInFlightWriteOnClose(didAbandon: boolean): void {
    if (!didAbandon) {
      return;
    }

    const failure = new FileSinkError(
      `Closed with a write still in flight (closeTimeoutMS=${String(this.closeTimeoutMS)}); whether it reached the file is unknown`,
    );

    this.lastError = failure;

    reportThroughHandler(
      this.onError === undefined
        ? undefined
        : () =>
            this.onError?.({
              kind: 'close',
              error: failure,
              target: this.currentLogFile ?? this.logDir,
              disposition: 'no_entry',
            }),
      () => describeError(failure),
      undefined,
      'FileSink failure handler',
    );
  }

  /**
   * Give up on whatever is still queued when `close()` stops waiting, and say so.
   *
   * `close()` is bounded by `closeTimeoutMS`, so a slow or broken destination leaves
   * entries behind - and once `closed` is set nothing will ever process them. Those
   * entries went nowhere, which is the same thing that happens at the queue cap, so they
   * are counted the same way: `droppedEntries` means "lines this sink did not deliver",
   * whatever the reason. Reported once with `disposition: 'lost'` rather than once per
   * entry, for the same reason the cap reports once - a shutdown that abandons a full
   * queue would otherwise fire the callback ten thousand times.
   */
  private abandonQueueOnClose(): void {
    const abandoned = this.writeQueue.length;

    if (abandoned === 0) {
      return;
    }

    const firstAbandoned = this.writeQueue[0]?.entry;

    this.writeQueue = [];
    this.countDropped('close', abandoned);

    const failure = new FileSinkError(
      `Closed with ${String(abandoned)} entr${abandoned === 1 ? 'y' : 'ies'} still queued (closeTimeoutMS=${String(this.closeTimeoutMS)}); they were not written`,
    );

    this.lastError = failure;

    reportThroughHandler(
      this.onError === undefined
        ? undefined
        : () =>
            this.onError?.({
              kind: 'close',
              error: failure,
              target: this.currentLogFile ?? this.logDir,
              // The oldest abandoned entry, as a sample. Every entry in the queue was
              // lost, so unlike the cap's report there is no surviving line to confuse
              // this with.
              entry: firstAbandoned,
              disposition: 'lost',
            }),
      () => describeError(failure),
      undefined,
      'FileSink failure handler',
    );
  }

  /**
   * Initialize the file sink asynchronously
   */
  private async initialize(): Promise<void> {
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

      // Process any queued writes
      await this.processQueue();
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
      // arrives as something else - `mkdir`'s raw `ENOTDIR`, `EACCES` - is given the
      // sentence `failureKindFor` recognizes.
      const failure =
        error instanceof FileSinkError
          ? error
          : new FileSinkError(
              `Failed to setup log file: ${describeError(error)}`,
              toError(error),
            );

      this.lastError = failure;

      reportThroughHandler(
        this.onError === undefined
          ? undefined
          : () =>
              this.onError?.({
                kind: 'setup',
                error: failure,
                target: this.currentLogFile ?? this.logDir,
                // Setup belongs to no particular line, and the queue still holds every
                // entry: a later write retries this, so nothing here is lost.
                disposition: 'retrying',
              }),
        () => describeError(failure),
        undefined,
        'FileSink failure handler',
      );
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

        try {
          await this.writeEntry(queuedEntry);
          this.consecutiveFailures = 0;
          this.totalEntriesWritten++;
        } catch (error) {
          // `toError`, not `String(error)`: the coercion runs inside the `catch` that
          // is the entry's only retry and `onError` handling, and `String()` invokes a
          // `toString` this does not own. A value whose `toString` throws made the
          // coercion throw from inside the handler, skipping `onError`, the re-queue
          // and the failure counters, and escaping `processQueue` as an unhandled
          // rejection that left every queued entry behind it stalled.
          const err = toError(error);
          const kind = this.failureKindFor(err);

          this.lastError = err;

          // A render that failed is not a write-health failure, and is not counted as
          // one. `consecutiveFailures` / `isHealthy` answer "can this sink reach its
          // destination" - a full disk, a directory that went away - and a `formatter`
          // or a `JSON.stringify` that threw says nothing about the file. Counting it
          // reported a sink writing every other line perfectly as broken, and diverged
          // from `NamedPipeSink`, which has never counted a `'format'` failure against
          // the pipe. The line itself is still reported, with `disposition: 'lost'`:
          // this sink substitutes no default format, so there is nothing to fall back
          // to and the entry does not arrive.
          // `'close'` is excluded for a related reason: the destination answered nothing
          // at all, the sink is on its way out, and `NamedPipeSink` does not hold a
          // teardown against the connection either.
          if (kind !== 'format' && kind !== 'close') {
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
            if (this.onError !== undefined || !willRetryEntry) {
              // Held across the report for a `'format'` failure only, and until the handler
              // settles rather than returns - see `scheduleFormatReport`. A write failure
              // is retried and the handler hears every attempt by contract; the chain this
              // breaks is the one where the handler's own line cannot render either.
              const report = (onReported?: () => void) =>
                reportThroughHandler(
                  this.onError === undefined
                    ? undefined
                    : // The handler's result is returned, not dropped: `reportThroughHandler`
                      // follows a promise so an `async` handler that rejects lands on the
                      // console rung instead of becoming an unhandled rejection.
                      () =>
                        this.onError?.({
                          kind,
                          error: err,
                          target: this.currentLogFile ?? this.logDir,
                          entry: queuedEntry.entry,
                          attempt: queuedEntry.attempts + 1,
                          disposition: willRetryEntry ? 'retrying' : 'lost',
                        }),
                  () =>
                    `FileSink error writing to ${this.currentLogFile ?? this.logDir}: ${describeError(err)}`,
                  onReported,
                  'FileSink failure handler',
                );

              if (kind === 'format') {
                this.scheduleFormatReport((onReported) => report(onReported));
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
            this.countDropped(
              kind === 'format' || kind === 'close'
                ? kind
                : this.closed
                  ? 'close'
                  : 'write',
            );
          }
        }
      }
    } finally {
      // A drained queue closes the reported episode. `didReportDrop` gates the report so
      // an overflowing queue does not fire a callback per dropped line, but nothing else
      // cleared it: a sink that overflowed during one brief outage, recovered, and
      // overflowed again hours later stayed silent the second time. Reset only on an
      // empty queue, so a pass that stopped short of draining does not re-arm the flood.
      if (this.writeQueue.length === 0) {
        this.didReportDrop = false;
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
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutSentinel = { timedOut: true } as const;

      try {
        const timeoutPromise = new Promise<typeof timeoutSentinel>(
          (resolve) => {
            timeoutHandle = setTimeout(
              () => resolve(timeoutSentinel),
              // What is left of this call's budget, not the whole of it: the clock
              // started in `flush()`, and this call may have waited behind another.
              Math.max(0, timeoutMS - (Date.now() - startTime)),
            );
          },
        );

        const result = await Promise.race([
          initPromise.then(() => undefined),
          timeoutPromise,
        ]);

        if (result === timeoutSentinel) {
          // Prevent an unhandled rejection if the init fails after this returns, exactly
          // as `close()` does on the same race.
          Promise.resolve(initPromise).catch(() => {
            // Intentionally ignored after the timeout.
          });

          return this.settleFlush({
            success: false,
            entriesWritten: this.totalEntriesWritten - startWritten,
            entriesFailed: this.droppedEntries - startFailed,
            timedOut: true,
          });
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > timeoutMS) {
        // Timeout reached
        const entriesWritten = this.totalEntriesWritten - startWritten;
        const entriesFailed = this.droppedEntries - startFailed;

        return this.settleFlush({
          success: false,
          entriesWritten,
          entriesFailed,
          timedOut: true,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const entriesWritten = this.totalEntriesWritten - startWritten;
    const entriesFailed = this.droppedEntries - startFailed;

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
    this.flushBaselineDropped = this.droppedEntries;

    return result;
  }

  /**
   * Discard the oldest entries once the queue is over `maxQueueSize`.
   *
   * A loop rather than a single shift: a re-queued retry can push the length past the cap
   * by more than one, and a cap that only ever removes one entry per call is not a cap.
   */
  private enforceQueueLimit(): void {
    const limit = this.maxQueueSize;

    if (limit === undefined) {
      return;
    }

    // The first entry this call discards, kept for the report below. `writeQueue[0]` is
    // the oldest *surviving* entry - one that is still going to be written - so naming it
    // told an `onError` handler that a line it will see again was lost, while the entries
    // that genuinely were lost went unnamed.
    let firstDropped: LogEntry | undefined;
    let didEvict = false;

    while (this.writeQueue.length > limit) {
      const dropped = this.writeQueue.shift();

      firstDropped ??= dropped?.entry;
      this.countDropped('queue_full');
      didEvict = true;
    }

    // Gated on an eviction this call made, not on the cumulative count, for the reason
    // `NamedPipeSink.enforceQueueLimit` is: `droppedEntries` now also counts entries
    // `abandonQueueOnClose` gave up on, and those are not an overflow. A `close()` that
    // times out with a write still in flight left the counter non-zero, and the failing
    // write behind it re-queued its entry - so a queue holding one line under a cap of
    // 10,000 reported a `'queue_full'`, and set `didReportDrop`, which suppresses every
    // report until the queue next drains.
    if (!didEvict || this.didReportDrop) {
      return;
    }

    // Reported once, not once per drop: an overflowing queue drops continuously, and a
    // callback fired per entry would be its own flood on a path already in trouble. The
    // running total stays visible through `getHealth()`.
    this.didReportDrop = true;

    const failure = new FileSinkError(
      `Log queue is full (maxQueueSize=${limit}); dropping the oldest entries`,
    );

    this.lastError = failure;

    reportThroughHandler(
      this.onError === undefined
        ? undefined
        : () =>
            this.onError?.({
              kind: 'queue_full',
              error: failure,
              target: this.currentLogFile ?? this.logDir,
              // A dropped entry, never a surviving one: `willRetry` is `false` here, and
              // a handler that reads that as "this line is gone" and writes it elsewhere
              // would otherwise duplicate an entry still queued for the file.
              entry: firstDropped,
              disposition: 'lost',
            }),
      () => describeError(failure),
      undefined,
      'FileSink failure handler',
    );
  }

  /**
   * Which kind of failure a thrown `FileSinkError` describes.
   *
   * The discriminator this sink never had. Every failure arrived as an `Error` whose
   * message was the only way to tell a failed rotation from a failed write, so a consumer
   * that wanted to treat them differently had to match on text.
   */
  private failureKindFor(error: Error): SinkFailureKind {
    const message = describeError(error);

    if (message.startsWith('Failed to format log entry')) {
      return 'format';
    }

    if (
      message.startsWith('Failed to setup log file') ||
      message.startsWith('Error rotating log file')
    ) {
      return 'setup';
    }

    // An entry `close()` finished under is not a write that failed: the destination was
    // fine and the sink was shut down out from under a pass still in flight (see the
    // second `closed` check in `writeEntry`). Reported and counted as `'write'`, it made a
    // timed-out shutdown look like a broken disk in `droppedByKind`, and disagreed with
    // `NamedPipeSink`, which counts the identical event as `'close'`.
    if (message.startsWith('Cannot write to closed sink')) {
      return 'close';
    }

    return 'write';
  }

  /**
   * Write a single entry to the file
   * If stream is broken, it will be recreated on next attempt
   */
  private async writeEntry(queued: QueuedEntry): Promise<void> {
    // Before the stream is touched: there is no line to write, and this cannot become one
    // by trying again. Raised as an ordinary write failure so `onError`, `lastError` and
    // the counters treat it like any other, rather than re-rendering the entry.
    if (queued.formatError !== undefined) {
      throw new FileSinkError('Failed to format log entry', queued.formatError);
    }

    if (this.closed) {
      throw new FileSinkError('Cannot write to closed sink');
    }

    if (!this.logFileStream) {
      await this.setupLogFile();
    }

    // Setup may return without a stream when close finishes while it is suspended.
    if (this.closed) {
      throw new FileSinkError('Cannot write to closed sink');
    }

    if (!this.logFileStream) {
      throw new FileSinkError('No log file stream available');
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
      throw new FileSinkError('Cannot write to closed sink');
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
      throw new FileSinkError('Cannot write to closed sink');
    }

    // Write to file
    return new Promise<void>((resolve, reject) => {
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
        return reject(new FileSinkError('No log file stream available'));
      }

      const writingTo = this.logFileStream;

      writingTo.write(messageToWrite, (err) => {
        if (err) {
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
      let text = '';

      if (entry.type !== 'raw') {
        text = `[${entry.type}] `;
        if (entry.serviceName) {
          text += `[${entry.serviceName}] `;
        }

        if (entry.entityName) {
          text += `[${entry.entityName}] `;
        }
      }
      text += renderTextLine(entry.message);
      formatted = text;
    }

    return formatted + '\n';
  }

  /**
   * Setup the log file
   */
  private async setupLogFile(shouldSkipRotation = false): Promise<void> {
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
    // open creates is still the one `close()` ends afterwards, since `endStreamWithin`
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
        );

        this.lastError = failure;

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
        }

        reportThroughHandler(
          this.onError === undefined
            ? undefined
            : () =>
                this.onError?.({
                  kind,
                  error: failure,
                  target: this.currentLogFile ?? this.logDir,
                  // No `entry`: the stream failed on its own, not while carrying a line
                  // this sink can name. Anything queued is retried on the reopened stream
                  // and reported on its own terms if that fails.
                  disposition: 'no_entry',
                }),
          () => describeError(failure),
          undefined,
          'FileSink failure handler',
        );
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
      // awaits `endStreamWithin(this.closeTimeoutMS)` - a *fresh* full-length wait, begun
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
      // Bounded, like every other flush this sink waits on: see `endStreamWithin`. What
      // the bound gave up on is reported rather than dropped: see
      // `reportRotationFlushLoss`.
      const bytesLeft = await this.endStreamWithin(this.closeTimeoutMS);

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
    // that starts as `close()` runs calls `endStreamWithin(this.closeTimeoutMS)` of its
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

    // Close current stream, bounded: see `endStreamWithin`. Read before the rename below
    // moves the file, so the report names the file the bytes were written for.
    const bytesLeft = await this.endStreamWithin(this.closeTimeoutMS);

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
    // awaits above are long: `endStreamWithin` waits out `closeTimeoutMS` on a stalled
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
      this.lastError = failure;
      const shouldReport = this.rotationRetryDelayMS === 0;
      this.rotationRetryDelayMS = Math.min(
        this.rotationRetryDelayMS === 0
          ? ROTATION_RETRY_INITIAL_MS
          : this.rotationRetryDelayMS * 2,
        ROTATION_RETRY_MAX_MS,
      );
      this.nextRotationAttemptAt = Date.now() + this.rotationRetryDelayMS;
      if (shouldReport) {
        reportThroughHandler(
          this.onError === undefined
            ? undefined
            : () =>
                this.onError?.({
                  kind: 'setup',
                  error: failure,
                  target: this.currentLogFile ?? this.logDir,
                  disposition: 'no_entry',
                }),
          () => describeError(failure),
          undefined,
          'FileSink failure handler',
        );
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

    const failure = new FileSinkError(
      `No free archive name after ${String(MAX_ROTATION_NAME_ATTEMPTS + 1)} candidates; rotating over ${candidate}`,
    );

    this.lastError = failure;

    reportThroughHandler(
      this.onError === undefined
        ? undefined
        : () =>
            this.onError?.({
              kind: 'setup',
              error: failure,
              target: candidate,
              disposition: 'no_entry',
            }),
      () => describeError(failure),
      undefined,
      'FileSink failure handler',
    );

    return candidate;
  }

  /**
   * A value in `entry` would not render and a marker was written in its place.
   *
   * `'fallback'`, because the line goes out: this is advisory, and does not touch
   * `consecutiveFailures`. Guarded by `scheduleFormatReport` for the same reason the
   * lost-line report is - an `onError` that logs the failure back with the same
   * unrenderable value in it would report from inside its own report, without bound.
   * Under the guard the handler's line still renders, marker and all, and is queued;
   * only the nested report is skipped.
   */
  private reportRenderFallback(entry: LogEntry, error: Error): void {
    const failure = new FileSinkError(
      'Failed to render a value in the log entry; a marker was written in its place',
      error,
    );

    this.lastError = failure;
    this.scheduleFormatReport((onReported) => {
      reportThroughHandler(
        this.onError === undefined
          ? undefined
          : () =>
              this.onError?.({
                kind: 'format',
                error: failure,
                target: this.currentLogFile ?? this.logDir,
                entry,
                disposition: 'fallback',
              }),
        () =>
          `FileSink error rendering an entry for ${this.currentLogFile ?? this.logDir}: ${describeError(failure)}`,
        onReported,
        'FileSink failure handler',
      );
    });
  }

  /** Deliver one format report now and retain at most one that arrives while it settles. */
  private scheduleFormatReport(report: (onReported: () => void) => void): void {
    if (this.formatReportActive) {
      // While delivering the one deferred report, do not let self-logging create another
      // generation. The lost entry is still reflected in health; only its callback is
      // coalesced. No async-context machinery is needed, so browser-capable logger code
      // remains portable.
      if (
        !this.invokingFormatReport &&
        !this.deliveringDeferredFormatReport &&
        this.deferredFormatReport === undefined
      ) {
        this.deferredFormatReport = report;
      }

      return;
    }

    this.startFormatReport(report, false);
  }

  private startFormatReport(
    report: (onReported: () => void) => void,
    isDeferred: boolean,
  ): void {
    this.formatReportActive = true;
    this.deliveringDeferredFormatReport = isDeferred;

    this.invokingFormatReport = true;

    report(() => {
      this.formatReportActive = false;
      this.deliveringDeferredFormatReport = false;

      if (isDeferred) {
        return;
      }

      const pending = this.deferredFormatReport;

      this.deferredFormatReport = undefined;

      if (pending !== undefined) {
        this.startFormatReport(pending, true);
      }
    });

    this.invokingFormatReport = false;
  }

  /**
   * One more line this sink did not deliver, and why. The total and the breakdown move
   * together so they cannot disagree.
   */
  private countDropped(kind: DroppedEntryKind, count = 1): void {
    this.droppedEntries += count;
    this.droppedByKind[kind] += count;
  }
}
