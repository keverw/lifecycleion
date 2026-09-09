import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import type { LogEntry, LogSink } from '../types';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import { reportToConsole } from '../../internal/report-to-console';

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
 * One entry waiting for the pipe, reduced to what the flush actually needs.
 *
 * {@link RenderedLine} alone: the `LogEntry` is deliberately not kept. Rendering happens at
 * `write` time, so nothing on the flush path reads the entry again, and holding it would
 * pin the caller's whole params graph beside a serialized copy of it for as long as the
 * queue is stalled. `FileSink` keeps its entry because its public `onError` hands it to the
 * caller; this sink's `onError` takes only the error type and the pipe path.
 */
type QueuedPipeEntry = RenderedLine;

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

    // Queue entry if not initialized. Rendered now rather than at flush time, so the
    // line is fixed while `write` still holds the caller's stack.
    if (!this.isInitialized) {
      this.writeQueue.push(this.renderEntry(entry));

      return;
    }

    // Nothing to render for. `writeEntry` drops an entry the pipe cannot take, and the
    // stream `'error'` handler clears `pipeStream` while leaving `isInitialized` set - so
    // every write after a pipe failure reaches here. Rendering first would run a
    // caller-supplied `formatter`, side effects and all, for a line that is then thrown
    // away, which the direct path did not do before it started rendering eagerly.
    // `writeEntry` still checks for itself, since the queued path arrives by another route.
    if (!this.pipeStream || this.pipeStream.destroyed) {
      return;
    }

    this.writeEntry(this.renderEntry(entry));
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
        this.writeEntry(queued);
      }
    }
  }

  /**
   * Render one entry into the line to write, keeping a failure rather than retrying it.
   *
   * See {@link QueuedPipeEntry.formatError}: a render is attempted exactly once, while
   * the caller's stack is still held, whether the entry goes out now or waits for the
   * pipe.
   */
  private renderEntry(entry: LogEntry): QueuedPipeEntry {
    return renderOnce(() => this.formatEntry(entry));
  }

  /**
   * Write a single entry
   */
  private writeEntry(queued: QueuedPipeEntry): void {
    if (this.closed) {
      return;
    }

    if (!this.pipeStream || this.pipeStream.destroyed) {
      // Silently skip if pipe is not available
      return;
    }

    // Reported where the render used to happen, so a failure surfaces exactly as it did
    // before - but from the single attempt made in `write`, never from a second one.
    if (queued.formatError !== undefined) {
      this.handleError(PipeErrorType.WRITE, queued.formatError);

      return;
    }

    try {
      const messageToWrite = queued.formatted ?? '';

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

    // Default: log to console, through the guarded rung. The requirement stated above for
    // `onError` applies just as much to the fall-back beneath it: `console.error` throws
    // on a broken stdout, and this runs from a Node stream `'error'` handler - where that
    // is an uncaught exception - and from `initializePipe`'s uncaught promise.
    reportToConsole(
      `NamedPipeSink error (${errorType}): ${describeError(failure)}`,
    );
  }
}
