import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import type { LogEntry, LogSink } from '../types';
import { describeError, toError } from '../../to-error';

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

interface QueuedPipeEntry {
  entry: LogEntry;
  /** The rendered line, or `undefined` when rendering it threw at `write` time. */
  formatted: string | undefined;
}

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
  /**
   * Entries waiting for the pipe, each with the line already rendered.
   *
   * Rendered at `write` time rather than at flush time: `entry.redactedParams` is not a
   * snapshot - it is the caller's own bag, or shares every subtree that held nothing
   * redacted - so serializing it after the outage writes whatever the caller has done to
   * it since, including a secret added under a key that was named in `redactedKeys`.
   */
  private writeQueue: QueuedPipeEntry[] = [];
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
      let formatted: string | undefined;

      try {
        formatted = this.formatEntry(entry);
      } catch {
        // Left for the flush to hit again, where `handleError` already reports it.
        formatted = undefined;
      }

      this.writeQueue.push({ entry, formatted });

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
          this.handleError(PipeErrorType.CLOSE, error);
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
          `Could not open named pipe at ${this.pipePath}: ${describeError(error)}`,
          { cause: error },
        ),
      );
    }
  }

  /**
   * Process queued entries
   */
  private processQueue(): void {
    while (this.writeQueue.length > 0 && !this.closed) {
      const queued = this.writeQueue.shift();
      if (queued) {
        this.writeEntry(queued.entry, queued.formatted);
      }
    }
  }

  /**
   * Write a single entry
   */
  private writeEntry(entry: LogEntry, preformatted?: string): void {
    if (this.closed) {
      return;
    }

    if (!this.pipeStream || this.pipeStream.destroyed) {
      // Silently skip if pipe is not available
      return;
    }

    try {
      // Already rendered when the entry was queued, unless that render threw.
      const messageToWrite = preformatted ?? this.formatEntry(entry);

      // Write to pipe with backpressure handling
      if (!this.pipeStream.write(messageToWrite)) {
        this.pipeStream.once('drain', () => {
          // Handle backpressure - stream is ready again
        });
      }
    } catch (error) {
      this.handleError(PipeErrorType.WRITE, error);
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
  private handleError(errorType: PipeErrorType, error: unknown): void {
    // Normalized rather than trusted: `error` reaches here from Node's stream and
    // filesystem callbacks as well as from `catch` blocks, so it is not guaranteed to be
    // an `Error`, and `onError` declares one.
    const failure = toError(error);

    if (this.onError) {
      try {
        this.onError(errorType, failure, this.pipePath);

        return;
      } catch {
        // Fall through to the console, exactly as `FileSink` does for its own callback.
        // This must not escape: `handleError` is called from a Node stream 'error'
        // handler, where a throw is an uncaught exception and ends the process, and
        // from `initializePipe`, whose promise the constructor starts without a
        // `.catch`, where it would become an unhandled rejection from a constructor.
      }
    }

    // Default: log to console
    // eslint-disable-next-line no-console
    console.error(
      `NamedPipeSink error (${errorType}): ${describeError(failure)}`,
    );
  }
}
