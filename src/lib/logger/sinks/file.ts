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
  consecutiveFailures: number;
  isInitialized: boolean;
  /** Entries discarded because the queue was at `maxQueueSize`. Always 0 when unset. */
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
  private totalEntriesFailed = 0;
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
    if (this.closing || this.closed) {
      return;
    }

    // Check if log level is below minimum threshold (skip for raw logs)
    if (entry.type !== 'raw') {
      const logLevel = getLogLevel(entry.type);
      if (logLevel > this.minLevel) {
        return;
      }
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
    const startFailed = this.totalEntriesFailed;
    const startTime = Date.now();

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > timeoutMS) {
        // Timeout reached
        const entriesWritten = this.totalEntriesWritten - startWritten;
        const entriesFailed = this.totalEntriesFailed - startFailed;

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
    const entriesFailed = this.totalEntriesFailed - startFailed;

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

    // Close stream
    if (this.logFileStream) {
      return new Promise<void>((resolve) => {
        if (!this.logFileStream) {
          return resolve();
        }

        this.logFileStream.end(() => {
          this.logFileStream = undefined;
          resolve();
        });
      });
    }
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
          this.lastError = err;
          this.consecutiveFailures++;

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
                : () => {
                    this.onError?.({
                      kind: this.failureKindFor(err),
                      error: err,
                      target: this.currentLogFile ?? this.logDir,
                      entry: queuedEntry.entry,
                      attempt: queuedEntry.attempts + 1,
                      willRetry,
                    });
                  },
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
            this.totalEntriesFailed++;
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

    while (this.writeQueue.length > limit) {
      const dropped = this.writeQueue.shift();

      firstDropped ??= dropped?.entry;
      this.droppedEntries++;
    }

    if (this.droppedEntries === 0 || this.didReportDrop) {
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
        : () => {
            this.onError?.({
              kind: 'queue_full',
              error: failure,
              target: this.currentLogFile ?? this.logDir,
              // A dropped entry, never a surviving one: `willRetry` is `false` here, and
              // a handler that reads that as "this line is gone" and writes it elsewhere
              // would otherwise duplicate an entry still queued for the file.
              entry: firstDropped,
              willRetry: false,
            });
          },
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
      if (!this.logFileStream) {
        return resolve();
      }

      this.logFileStream.write(messageToWrite, (err) => {
        if (err) {
          // Stream is broken - destroy it so it can be recreated
          this.destroyStream();
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

      const stream = fs.createWriteStream(currentLogFile, { flags: 'a' });

      this.logFileStream = stream;
      this.currentLogFile = currentLogFile;

      stream.on('error', () => {
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

    const currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

    // Close current stream
    await new Promise<void>((resolve) => {
      if (!this.logFileStream) {
        return resolve();
      }

      this.logFileStream.end(() => {
        this.logFileStream = undefined;
        resolve();
      });
    });

    // Rename with timestamp
    const timestamp = Math.floor(Date.now() / 1000);
    const rotatedFile = `${this.logDir}/${this.basename}-${currentDate}-${timestamp}.log`;

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
}
