import fs, { promises as fsPromises } from 'fs';
import type { LogEntry, LogSink } from '../types';

export interface FileSinkOptions {
  logDir: string;
  basename: string;
  maxSizeMB?: number;
  jsonFormat?: boolean;
  maxRetries?: number;
  closeTimeoutMs?: number;
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
  private closeTimeoutMs: number;

  constructor(options: FileSinkOptions) {
    this.logDir = options.logDir;
    this.basename = options.basename;
    this.maxSizeMB = options.maxSizeMB ?? 10;
    this.jsonFormat = options.jsonFormat ?? false;
    this.maxRetries = options.maxRetries ?? 3;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 30000;
    this.onError = options.onError;

    // Initialize asynchronously
    this.initPromise = this.initialize();
  }

  public write(entry: LogEntry): void {
    if (this.closing || this.closed) {
      return;
    }

    // Add to queue with retry tracking
    this.writeQueue.push({ entry, attempts: 0 });

    // Process queue if initialized
    if (this.isInitialized) {
      void this.processQueue();
    } else if (this.initPromise) {
      void this.initPromise.then(() => this.processQueue());
    }
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
   * @param timeoutMs Maximum time to wait in milliseconds (default: 30000ms / 30s)
   */
  public async flush(timeoutMs: number = 30000): Promise<FlushResult> {
    // Wait for initialization
    if (this.initPromise) {
      await this.initPromise;
    }

    const startWritten = this.totalEntriesWritten;
    const startFailed = this.totalEntriesFailed;
    const startTime = Date.now();

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > timeoutMs) {
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
      await Promise.race([
        this.initPromise,
        new Promise<void>((resolve) =>
          setTimeout(resolve, this.closeTimeoutMs),
        ),
      ]);
    }

    // Wait for queue to finish processing with timeout
    while (this.writeQueue.length > 0 || this.isProcessing) {
      if (Date.now() - startTime > this.closeTimeoutMs) {
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
          await this.writeEntry(queuedEntry.entry);
          this.consecutiveFailures = 0;
          this.totalEntriesWritten++;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          this.lastError = err;
          this.consecutiveFailures++;

          // Determine if we should retry
          const willRetry = queuedEntry.attempts < this.maxRetries;

          // Call error callback if provided
          if (this.onError) {
            try {
              this.onError(
                err,
                queuedEntry.entry,
                queuedEntry.attempts + 1,
                willRetry,
              );
            } catch {
              // Ignore errors in error callback
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
  private async writeEntry(entry: LogEntry): Promise<void> {
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

    // Format the entry
    const messageToWrite = this.formatEntry(entry);
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
        error as Error,
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
        error as Error,
      );
    }

    // Setup new file (queue processing will resume after this)
    await this.setupLogFile();
  }
}
