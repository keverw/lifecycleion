import fs, { promises as fsPromises } from 'fs';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import { reportThroughHandler } from '../../internal/failure-reporter';
import {
  resolveMaxQueueSize,
  resolveMaxRetries,
} from './internal/queue-policy';
import type {
  SinkErrorHandler,
  SinkFailureKind,
} from './internal/sink-failure';

import type { LogEntry, LogSink } from '../types';
import { LogLevel, getLogLevel } from '../types';

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

export interface FileSinkOptions {
  logDir: string;
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
   * time, `entry` / `attempt` which line and try, and `willRetry` whether the line is
   * coming back. See {@link SinkFailure}.
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
}

export interface FlushResult {
  success: boolean;
  entriesWritten: number;
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
  private didReportDrop = false;
  private isInitialized = false;
  private initPromise?: Promise<void>;
  private isProcessing = false;
  private lastError?: Error;
  private consecutiveFailures = 0;
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

  constructor(options: FileSinkOptions) {
    this.logDir = options.logDir;
    this.basename = options.basename;
    this.maxSizeMB = options.maxSizeMB ?? 10;
    this.jsonFormat = options.jsonFormat ?? false;
    this.maxRetries = resolveMaxRetries(options.maxRetries);
    this.closeTimeoutMS = options.closeTimeoutMS ?? 30000;
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
      this.droppedEntries++;

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
        );
      }

      return;
    }

    // Rendered here rather than on the write path, which runs after `setupLogFile` and
    // `rotateIfNeeded` have been awaited: by then the caller has had the chance to mutate
    // the bag `entry.redactedParams` points at, since redaction no longer copies it.
    const rendered = renderOnce(() => this.formatEntry(entry));

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
      isHealthy: this.consecutiveFailures === 0 && this.isInitialized,
      queueSize: this.writeQueue.length,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
      isInitialized: this.isInitialized,
      droppedEntries: this.droppedEntries,
    };
  }

  /**
   * Flush all pending writes and wait for completion
   * Returns statistics about the flush operation
   * @param timeoutMS Maximum time to wait in milliseconds (default: 30000ms / 30s)
   */
  public async flush(timeoutMS: number = 30000): Promise<FlushResult> {
    // Wait for initialization
    if (this.initPromise) {
      await this.initPromise;
    }

    const startWritten = this.totalEntriesWritten;

    // `droppedEntries`, which every loss path bumps. A separate counter held only the
    // writes that exhausted their retries, so a flush that lost lines to a queue overflow
    // or to a `close()` abandoning its backlog - the conditions `maxQueueSize` exists for -
    // answered `{ success: true, entriesFailed: 0 }` about them. One counter, so `flush()`
    // and `getHealth()` cannot disagree about what was lost.
    //
    // A delta over the flush window, as `entriesWritten` is, and it means the same thing
    // as that one: what happened to this sink while the flush was waiting. So an eviction
    // that happened in an earlier `write()` is not in it - `getHealth().droppedEntries` is
    // the cumulative figure and the one to poll for that - and a concurrent burst that
    // overflows the queue during the window is, even though the flush was not waiting on
    // the entries it evicted.
    const startFailed = this.droppedEntries;
    const startTime = Date.now();

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > timeoutMS) {
        // Timeout reached
        const entriesWritten = this.totalEntriesWritten - startWritten;
        const entriesFailed = this.droppedEntries - startFailed;

        return {
          success: false,
          entriesWritten,
          entriesFailed,
          timedOut: true,
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const entriesWritten = this.totalEntriesWritten - startWritten;
    const entriesFailed = this.droppedEntries - startFailed;

    return {
      success: entriesFailed === 0,
      entriesWritten,
      entriesFailed,
      timedOut: false,
    };
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

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > this.closeTimeoutMS) {
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

    await this.endStreamWithin(remainingCloseMS);
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
  private async endStreamWithin(timeoutMS: number): Promise<void> {
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
        }),
      ]);
    } finally {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
      }
    }

    // Whatever `end()` did not manage in that window is not going to happen: the descriptor
    // is released rather than held for the life of the process. Cleared only if it is still
    // the stream this found, matching `endStream()`'s own check.
    if (stream && !stream.destroyed) {
      try {
        stream.destroy();
      } catch {
        // Best effort; the stream is going away either way.
      }
    }

    if (this.logFileStream === stream) {
      this.logFileStream = undefined;
    }
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
    this.droppedEntries += abandoned;

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
    );
  }

  /**
   * Initialize the file sink asynchronously
   */
  private async initialize(): Promise<void> {
    try {
      // Create log directory if it doesn't exist
      await fsPromises.mkdir(this.logDir, { recursive: true });

      // Initialize log file
      await this.setupLogFile();
      this.isInitialized = true;

      // Process any queued writes
      await this.processQueue();
    } catch {
      // Silently fail - entries will be queued until next initialization attempt
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
          if (kind !== 'format') {
            this.consecutiveFailures++;
          }

          // Determine if we should retry.
          //
          // A render that failed is never retried: the line is not re-rendered by design
          // (see `QueuedEntry.formatError`), so every attempt would raise the same
          // failure and call `onError` again for one entry that can never be written.
          const willRetry =
            queuedEntry.formatError === undefined &&
            queuedEntry.attempts < this.maxRetries;

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
          if (this.onError !== undefined || !willRetry) {
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
                      disposition: willRetry ? 'retrying' : 'lost',
                    }),
              () =>
                `FileSink error writing to ${this.currentLogFile ?? this.logDir}: ${describeError(err)}`,
            );
          }

          if (willRetry) {
            // Re-queue with incremented attempt count
            queuedEntry.attempts++;
            this.writeQueue.push(queuedEntry);
            this.enforceQueueLimit();
          } else {
            // Max retries exceeded - entry is lost
            //
            // Counted as a drop, matching `NamedPipeSink`, and the only counter kept for
            // it: an entry lost to an exhausted retry or a failed render reported
            // `disposition: 'lost'` while `getHealth()` still answered
            // `{ isHealthy: true, droppedEntries: 0 }` - against that field's own
            // documented meaning, "lines this sink did not deliver". `flush()` reads the
            // same counter, so the two can no longer disagree about what was lost.
            this.droppedEntries++;
          }
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Write a single entry to the file
   * If stream is broken, it will be recreated on next attempt
   */
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
      this.droppedEntries++;
      didEvict = true;
    }

    // Gated on an eviction this call made, not on the cumulative count, for the reason
    // `NamedPipeSink.enforceQueueLimit` is: `droppedEntries` now also counts entries
    // `abandonQueueOnClose` gave up on, and those are not an overflow. A `close()` that
    // times out with a write still in flight left the counter non-zero, and the failing
    // write behind it re-queued its entry - so a queue holding one line under a cap of
    // 10,000 reported a `'queue_full'`, and set `didReportDrop`, which nothing resets.
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

    return 'write';
  }

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

    if (!this.logFileStream) {
      throw new FileSinkError('No log file stream available');
    }

    // Check rotation before writing (handles date change and size limit)
    await this.rotateIfNeeded();

    // Always the line rendered in `write`. A render that threw has already been raised
    // above, so this is never a second attempt at one.
    const messageToWrite = queued.formatted ?? '';
    const messageBytes = Buffer.byteLength(messageToWrite, 'utf8');

    // Check if writing would exceed limit
    const maxSizeBytes = this.maxSizeMB * 1024 * 1024;
    if (this.currentLogSize + messageBytes > maxSizeBytes) {
      await this.rotateFile();
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
          this.currentLogSize += messageBytes;
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
      formatted = JSON.stringify({
        timestamp: entry.timestamp,
        type: entry.type,
        serviceName: entry.serviceName,
        entityName: entry.entityName,
        message: entry.message,
        params: entry.redactedParams, // Use redacted params for file output
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
      text += entry.message;
      formatted = text;
    }

    return formatted + '\n';
  }

  /**
   * Setup the log file
   */
  private async setupLogFile(): Promise<void> {
    // Nothing to open for a sink that is going away. `close()` bounds its drain loop, so a
    // `writeEntry` suspended in here - a slow `mkdir` on a network mount is enough - resumed
    // *after* that loop gave up, after the stream `close()` found had been destroyed and
    // after `close()` itself resolved. It then opened a fresh descriptor nothing would ever
    // close and set `isInitialized` back to `true`, so `getHealth()` reported a closed sink
    // as initialized - the state `close()` clears the flag to prevent. Checked again below
    // for the same reason: every await here is a place `close()` can run.
    if (this.closing || this.closed) {
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

      if (this.closing || this.closed) {
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
      if (this.currentLogSize >= maxSizeBytes) {
        await this.rotateFile();
      }

      // Closed while the size was being read, so this stream has already outlived the
      // teardown that would have ended it. Torn down here rather than left for nobody: the
      // descriptor is the leak, and `isInitialized` must not go back up behind a `close()`
      // that cleared it.
      if (this.closing || this.closed) {
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
      // Ended first, exactly as `rotateFile()` ends it. `setupLogFile()` overwrites
      // `logFileStream` with no teardown, so the stream this replaces was left open and
      // unreachable: one `WriteStream` and one file descriptor leaked per UTC midnight for
      // the life of the process, and whatever sat in its buffer was never flushed - not by
      // `close()`, which only ends the stream that is current by then.
      //
      // Bounded, like every other flush this sink waits on: see `endStreamWithin`.
      await this.endStreamWithin(this.closeTimeoutMS);
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

    const currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    // Close current stream, bounded: see `endStreamWithin`.
    await this.endStreamWithin(this.closeTimeoutMS);

    // Rename with timestamp, disambiguated when one second holds more than one rotation.
    //
    // A second-resolution suffix alone named the same archive twice under any burst that
    // filled `maxSizeMB` twice inside one second, and `rename` overwrites silently: the
    // earlier archive was gone, with `entriesFailed: 0`, `droppedEntries: 0` and `onError`
    // never firing - lines that this sink had reported as written, lost with nothing
    // anywhere saying so. Milliseconds make the ordinary collision impossible and the
    // counter settles the rest, since rotations are serialized on this sink.
    const rotatedFile = await this.reserveRotatedFileName(currentDate);

    try {
      await fsPromises.rename(this.currentLogFile, rotatedFile);
    } catch (error) {
      throw new FileSinkError(
        `Error rotating log file from ${this.currentLogFile} to ${rotatedFile}`,
        toError(error),
      );
    }

    // Setup new file (queue processing will resume after this)
    await this.setupLogFile();
  }

  /**
   * A rotated-file path that names nothing already on disk.
   *
   * The counter is only reached when two rotations land in the same millisecond, and it is
   * bounded: after {@link MAX_ROTATION_NAME_ATTEMPTS} the caller gets the last candidate
   * anyway rather than this looping while the queue is parked. A `rename` onto an existing
   * archive is still better than a rotation that never finishes.
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

    return candidate;
  }
}
