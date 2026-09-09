import fs, { promises as fsPromises } from 'fs';
import { describeError, toError } from '../../to-error';
import { reportToConsole } from '../../internal/report-to-console';
import type { LogEntry, LogSink } from '../types';
import { LogLevel, getLogLevel } from '../types';

export interface FileSinkOptions {
  logDir: string;
  basename: string;
  maxSizeMB?: number;
  jsonFormat?: boolean;
  maxRetries?: number;
  closeTimeoutMS?: number;
  minLevel?: LogLevel;
  onError?: (
    error: Error,
    entry: LogEntry,
    attempt: number,
    willRetry: boolean,
  ) => void;
}

export interface FileSinkHealth {
  isHealthy: boolean;
  queueSize: number;
  lastError?: Error;
  consecutiveFailures: number;
  isInitialized: boolean;
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

interface QueuedEntry {
  entry: LogEntry;
  attempts: number;
  /**
   * The line to write, rendered while `write` still held the caller's stack.
   *
   * `entry.redactedParams` is not a snapshot - it is the caller's own bag, or shares
   * every subtree that held nothing redacted - so serializing it after an `await` writes
   * whatever the caller has done to it since. A bag reused across calls then wrote a
   * secret added *after* the log call under a key that was named in `redactedKeys`, and
   * wrote params that disagreed with the message rendered beside them.
   *
   * `undefined` only when the render threw, in which case {@link formatError} holds the
   * failure and the line is never rendered again.
   */
  formatted: string | undefined;
  /**
   * The failure from rendering at `write` time, kept rather than the chance to try again.
   *
   * Re-rendering on the write path is the very thing {@link formatted} exists to avoid,
   * and a first render that *threw* is not the safe exception it looks like. Leaving it
   * to happen again reopened the window on precisely the entries most likely to change
   * underneath it: whatever made `JSON.stringify` throw usually sits in one of the
   * subtrees `redactedParams` shares with the caller's own bag, so the caller removing it
   * is what lets the second render succeed - carrying with it anything else that changed
   * in the meantime. Verified: a `BigInt` under `params.user`, deleted after the log call
   * along with `params.user.token = '<secret>'` set on the same shared object, wrote that
   * token to the file in clear text under a `redactedKeys: ['user.token']` that had
   * masked nothing because the key did not exist yet.
   *
   * Carried through the ordinary failure path instead, so `onError`, `lastError` and the
   * failure counters all see it - but not through the retry, since a render this refuses
   * to repeat cannot come out differently on a second attempt.
   */
  formatError: Error | undefined;
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
  private onError?: (
    error: Error,
    entry: LogEntry,
    attempt: number,
    willRetry: boolean,
  ) => void;
  private logFileStream?: fs.WriteStream;
  private currentLogFile?: string;
  private currentLogSize = 0;
  private writeQueue: QueuedEntry[] = [];
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
    this.maxRetries = options.maxRetries ?? 3;
    this.closeTimeoutMS = options.closeTimeoutMS ?? 30000;
    this.minLevel = options.minLevel ?? LogLevel.INFO;
    this.onError = options.onError;

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
    let formatted: string | undefined;
    let formatError: Error | undefined;

    try {
      formatted = this.formatEntry(entry);
    } catch (error) {
      // Kept, not retried. See `QueuedEntry.formatError`: rendering again on the write
      // path is what this render exists to prevent, and a failed first render is the case
      // where doing so is most likely to serialize something the caller has since added.
      formatError = toError(error);
    }

    // Add to queue with retry tracking
    this.writeQueue.push({ entry, attempts: 0, formatted, formatError });

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

          // Call error callback if provided
          if (this.onError) {
            try {
              this.onError(
                err,
                queuedEntry.entry,
                queuedEntry.attempts + 1,
                willRetry,
              );
            } catch (callbackError) {
              // Fall through to the console, as `NamedPipeSink.handleError` does for its
              // own callback. Swallowing it lost both failures at once: the write error
              // the callback was told about, and the callback's own throw - so a sink
              // that could not write anything reported nothing anywhere.
              reportToConsole(
                `FileSink onError callback failed: ${describeError(callbackError)}`,
                err,
              );
            }
          }

          if (willRetry) {
            // Re-queue with incremented attempt count
            queuedEntry.attempts++;
            this.writeQueue.push(queuedEntry);
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

      this.logFileStream = fs.createWriteStream(currentLogFile, { flags: 'a' });
      this.currentLogFile = currentLogFile;

      this.logFileStream.on('error', () => {
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
