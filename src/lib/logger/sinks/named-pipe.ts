import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import type { LogEntry, LogSink } from '../types';

/**
 * Types of pipe errors that can occur
 */
export enum PipeErrorType {
  WRITE = 'write',
  CLOSE = 'close',
  NOT_FOUND = 'not_found',
  NOT_A_PIPE = 'not_a_pipe',
  PERMISSION = 'permission',
  UNSUPPORTED_PLATFORM = 'unsupported_platform',
}

export interface NamedPipeSinkOptions {
  pipePath: string;
  jsonFormat?: boolean;
  closeTimeoutMS?: number;
  onError?: (errorType: PipeErrorType, error: Error, pipePath: string) => void;
  formatter?: (entry: LogEntry) => string;
}

export type ReconnectStatus =
  | { success: true }
  | { success: false; reason: 'already_reconnecting' }
  | { success: false; reason: 'error'; error: Error };

/**
 * NamedPipeSink writes logs to a named pipe (FIFO)
 * Only supported on Linux and macOS
 */
export class NamedPipeSink implements LogSink {
  private pipePath: string;
  private jsonFormat: boolean;
  private onError?: (
    errorType: PipeErrorType,
    error: Error,
    pipePath: string,
  ) => void;
  private formatter?: (entry: LogEntry) => string;
  private pipeStream?: fs.WriteStream;
  private writeQueue: LogEntry[] = [];
  private isInitialized = false;
  private _isReconnecting = false;
  private initPromise: Promise<void>;
  private closing = false;
  private closed = false;
  private closeTimeoutMS: number;

  constructor(options: NamedPipeSinkOptions) {
    this.pipePath = options.pipePath;
    this.jsonFormat = options.jsonFormat ?? false;
    this.onError = options.onError;
    this.formatter = options.formatter;
    this.closeTimeoutMS = options.closeTimeoutMS ?? 30000;

    this.initPromise = this.initializePipe();
  }

  public write(entry: LogEntry): void {
    if (this.closing || this.closed) {
      return;
    }

    // Queue entry if not initialized
    if (!this.isInitialized) {
      this.writeQueue.push(entry);
      return;
    }

    this.writeEntry(entry);
  }

  /**
   * Attempt to reconnect to the named pipe.
   * Useful when the pipe reader restarts or after a temporary error.
   * Queued writes during the outage will be flushed on successful reconnection.
   */
  public get isReconnecting(): boolean {
    return this._isReconnecting;
  }

  public async reconnect(): Promise<ReconnectStatus> {
    // If already reconnecting, just wait for the existing attempt
    if (this._isReconnecting) {
      await this.initPromise;
      return { success: false, reason: 'already_reconnecting' };
    }

    this._isReconnecting = true;

    try {
      // Close existing stream if any
      if (this.pipeStream && !this.pipeStream.destroyed) {
        this.pipeStream.end();
        this.pipeStream = undefined;
      }

      this.isInitialized = false;
      this.initPromise = this.initializePipe();
      await this.initPromise;

      // Check if initialization actually succeeded
      if (this.isInitialized) {
        return { success: true };
      } else {
        return {
          success: false,
          reason: 'error',
          error: new Error('Failed to initialize pipe connection'),
        };
      }
    } finally {
      this._isReconnecting = false;
    }
  }

  public async close(): Promise<void> {
    this.closing = true;

    // Wait for initialization with timeout
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutSentinel = { timedOut: true } as const;

    try {
      const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
        timeoutHandle = setTimeout(
          () => resolve(timeoutSentinel),
          this.closeTimeoutMS,
        );
      });

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

    this.closed = true;

    if (this.pipeStream && !this.pipeStream.destroyed) {
      return new Promise<void>((resolve) => {
        try {
          this.pipeStream?.end(() => {
            this.pipeStream = undefined;
            resolve();
          });
        } catch (error) {
          this.handleError(
            PipeErrorType.CLOSE,
            error instanceof Error ? error : new Error(String(error)),
          );
          resolve();
        }
      });
    }
  }

  /**
   * Initialize the named pipe connection
   */
  private async initializePipe(): Promise<void> {
    // Check platform support
    const platform = os.platform();
    if (platform !== 'linux' && platform !== 'darwin') {
      this.handleError(
        PipeErrorType.UNSUPPORTED_PLATFORM,
        new Error(
          `Named pipes are only supported on Linux and macOS, current platform: ${platform}`,
        ),
      );

      return;
    }

    try {
      // Check if the pipe exists and is a FIFO
      const stats = await fsPromises.stat(this.pipePath);
      if (!stats.isFIFO()) {
        this.handleError(
          PipeErrorType.NOT_A_PIPE,
          new Error(`${this.pipePath} exists but is not a named pipe (FIFO)`),
        );
        return;
      }

      // Create write stream
      this.pipeStream = fs.createWriteStream(this.pipePath, {
        flags: 'a', // Append mode
      });

      this.pipeStream.on('error', (err) => {
        this.handleError(PipeErrorType.WRITE, err);
        this.pipeStream = undefined;
      });

      this.isInitialized = true;

      // Process any queued writes
      this.processQueue();
    } catch (error) {
      this.handleError(
        PipeErrorType.NOT_FOUND,
        new Error(
          `Could not open named pipe at ${this.pipePath}: ${(error as Error).message}`,
        ),
      );
    }
  }

  /**
   * Process queued entries
   */
  private processQueue(): void {
    while (this.writeQueue.length > 0 && !this.closed) {
      const entry = this.writeQueue.shift();
      if (entry) {
        this.writeEntry(entry);
      }
    }
  }

  /**
   * Write a single entry
   */
  private writeEntry(entry: LogEntry): void {
    if (this.closed) {
      return;
    }

    if (!this.pipeStream || this.pipeStream.destroyed) {
      // Silently skip if pipe is not available
      return;
    }

    try {
      const messageToWrite = this.formatEntry(entry);

      // Write to pipe with backpressure handling
      if (!this.pipeStream.write(messageToWrite)) {
        this.pipeStream.once('drain', () => {
          // Handle backpressure - stream is ready again
        });
      }
    } catch (error) {
      this.handleError(
        PipeErrorType.WRITE,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  /**
   * Format a log entry for pipe output
   */
  private formatEntry(entry: LogEntry): string {
    // Use custom formatter if provided
    if (this.formatter) {
      try {
        return this.formatter(entry) + '\n';
      } catch {
        // If formatter fails, fall through to default formatting
      }
    }

    let formatted: string;

    if (this.jsonFormat) {
      formatted = JSON.stringify({
        timestamp: entry.timestamp,
        type: entry.type,
        serviceName: entry.serviceName,
        entityName: entry.entityName,
        message: entry.message,
        params: entry.redactedParams,
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
   * Handle errors
   */
  private handleError(errorType: PipeErrorType, error: Error): void {
    if (this.onError) {
      this.onError(errorType, error, this.pipePath);
    } else {
      // Default: log to console
      // eslint-disable-next-line no-console
      console.error(`NamedPipeSink error (${errorType}): ${error.message}`);
    }
  }
}
