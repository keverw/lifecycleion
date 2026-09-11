import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import type { LogEntry, LogSink } from '../types';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import { reportThroughHandler } from '../../internal/failure-reporter';
import {
  resolveMaxQueueSize,
  resolveMaxRetries,
} from './internal/queue-policy';

/**
 * Types of pipe errors that can occur
 */
export enum PipeErrorType {
  WRITE = 'write',
  /**
   * A custom `formatter` threw and the default format was used instead.
   *
   * Its own type rather than {@link PipeErrorType.WRITE}, because nothing was lost: the
   * line is still written, and the pipe is healthy. Reported as `WRITE`, a handler that
   * reads that as "this entry is gone" - reconnecting, or counting a dropped line - acted
   * on every single entry while the sink was working perfectly.
   */
  FORMAT = 'format',
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
  /**
   * Cap on entries queued while the pipe is unavailable. Defaults to 10,000; pass `-1` to
   * hold everything, which is what this did before the option had a default.
   *
   * A named pipe with no reader is the ordinary case for this sink - the reader restarts,
   * or has not started yet - and every line logged in the meantime is held. Without a cap
   * an outage of any length is unbounded memory growth, which is why the cap is on by
   * default rather than waiting to be asked for.
   *
   * The **oldest** entry is dropped to make room: during an outage the newest lines
   * describe what is happening now. Drops are counted in
   * {@link NamedPipeSinkHealth.droppedEntries} and the first one is reported through
   * `onError` as a `WRITE` failure, so a silently truncated log is never the only
   * evidence.
   *
   * Shared with `FileSink`, which reads the same option the same way.
   */
  maxQueueSize?: number;
  /**
   * Attempts a failed write gets before the entry is given up on. Defaults to 3, matching
   * `FileSink`; `0` writes once and never retries.
   *
   * A pipe write fails for the same reasons a file write does - the far end went away,
   * the stream was torn down - and the entry is no more lost in one case than the other.
   * It is re-queued and goes out when the pipe is next usable, rather than being dropped
   * where it stood.
   */
  maxRetries?: number;
}

/**
 * What a `NamedPipeSink` will tell you about itself.
 *
 * The shape `FileSink.getHealth()` returns, plus the one thing only this sink has
 * (`isReconnecting`). The two sinks now answer a failure the same way, and there was no
 * reason for only one of them to be able to say how that was going: this sink exposed a
 * single `droppedEntryCount` getter, so a queue growing behind a pipe nobody was reading
 * was invisible until entries started falling off the end of it.
 */
export interface NamedPipeSinkHealth {
  /** No failed writes since the last successful one, and the pipe is open. */
  isHealthy: boolean;
  /** Entries rendered and waiting for the pipe. */
  queueSize: number;
  /**
   * Entries this sink did not deliver - evicted at `maxQueueSize`, or out of retries.
   *
   * The same meaning as `FileSinkHealth.droppedEntries`.
   */
  droppedEntries: number;
  /** Whether the pipe is currently open for writing. */
  isInitialized: boolean;
  /** Whether a reconnect - manual or automatic - is in flight. */
  isReconnecting: boolean;
  /** The most recent failure of any kind, including a `formatter` that threw. */
  lastError?: Error;
  /**
   * Failed writes since the last successful one.
   *
   * Write failures only: a `FORMAT` failure still produced a line and left the pipe
   * healthy, so counting it would report a sink that is working perfectly as broken.
   */
  consecutiveFailures: number;
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
interface QueuedPipeEntry extends RenderedLine {
  /**
   * Writes already attempted for this line.
   *
   * The one thing this sink keeps beyond the rendered line, and it is what makes a failed
   * write recoverable rather than terminal: the entry goes back on the queue and is tried
   * again when the pipe is usable, up to `maxRetries`, exactly as `FileSink` has always
   * done. The `LogEntry` itself is still deliberately not kept - holding it would pin the
   * caller's whole params graph for as long as the queue is stalled, and this sink's
   * `onError` takes only the error type and the pipe path.
   */
  attempts: number;
}

/**
 * How long the sink waits between automatic reopen attempts.
 *
 * A reopen is a `stat` plus an `open`, and a dead pipe is exactly when the application is
 * logging hardest, so one attempt per entry would answer an outage with a syscall storm.
 * A second is short enough that a reader restarting is picked up promptly and long enough
 * that a pipe which is never coming back costs nothing to keep asking about.
 */
const REOPEN_COOLDOWN_MS = 1000;

/**
 * How long an open is waited on before the caller is told it has not completed.
 *
 * Opening a FIFO for writing does not complete until a reader opens the other end, and a
 * reader may never come. The open itself is left running - it costs one pending
 * descriptor, and if a reader does appear the sink promotes the stream and flushes - but
 * nobody is made to wait on it indefinitely: `reconnect()` answers, and the constructor's
 * `initPromise` settles, whether or not the pipe opened.
 */
const OPEN_WAIT_MS = 2000;

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
   * A stream that has been created but whose `open` has not completed.
   *
   * `createWriteStream` returns before the file is open, and for a FIFO that open waits
   * for a reader. Treating the stream as usable at creation time is what let the queue
   * cap be bypassed: every queued entry was handed straight to the stream, where Node
   * buffers without limit, so `maxQueueSize` bounded nothing and `getHealth().queueSize`
   * read zero while memory grew. Entries now stay in this sink's own queue until the pipe
   * is genuinely open.
   *
   * Kept rather than abandoned on a timeout, and never joined by a second: one pending
   * open costs one descriptor and one libuv threadpool slot (four by default), and it
   * still promotes itself if a reader arrives later.
   */
  private pendingStream?: fs.WriteStream;
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
  private maxQueueSize?: number;
  private maxRetries: number;
  private droppedEntries = 0;
  private didReportDrop = false;
  private lastError?: Error;
  private consecutiveFailures = 0;
  /**
   * Whether the stream has told us to stop and wait for `'drain'`.
   *
   * Backpressure is the third way this sink's own queue could be bypassed. `write()`
   * returning `false` means the stream's buffer is over its high-water mark, and ignoring
   * it drains the managed queue into Node's buffer, which has no cap: with a reader
   * attached but not consuming, 500 entries went there while `maxQueueSize` held none of
   * them and `getHealth()` reported an empty queue and no drops.
   */
  private isAwaitingDrain = false;
  /**
   * When the last automatic reopen was attempted.
   *
   * A reopen costs a `stat` and an `open`, and an outage is exactly when the log loop is
   * busiest, so attempting one per entry would turn a dead pipe into a syscall storm. One
   * attempt per {@link REOPEN_COOLDOWN_MS} is enough to recover promptly without that.
   */
  private lastReopenAttempt = 0;
  /**
   * A reopen deferred until the cooldown has elapsed, if one is pending.
   *
   * One at a time, and `unref`'d, so a sink waiting to recover never holds the process
   * open and never stacks attempts.
   */
  private reopenTimer?: NodeJS.Timeout;
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
    this.maxQueueSize = resolveMaxQueueSize(options.maxQueueSize);
    this.maxRetries = resolveMaxRetries(options.maxRetries);

    this.initPromise = this.initializePipe();
  }

  public write(entry: LogEntry): void {
    if (this.closing || this.closed) {
      return;
    }

    // Queued whenever there is nowhere to put it *yet* - before the first open, and after
    // a failure took the stream away. Rendered now rather than at flush time, so the line
    // is fixed while `write` still holds the caller's stack.
    //
    // Held rather than dropped, which is the whole of what changed here. A pipe failure
    // used to end the sink: the stream `'error'` handler cleared `pipeStream` and left
    // `isInitialized` set, so every later entry fell through a silent early return -
    // uncounted, unreported, and not recoverable by the `reconnect()` the class documents,
    // since there was nothing left to flush. `FileSink` answers the identical failure by
    // queueing, retrying and reopening; there was never a reason for the two to differ.
    if (
      !this.isInitialized ||
      !this.pipeStream ||
      this.pipeStream.destroyed ||
      // Under backpressure the stream will take it, into a buffer with no cap. It waits
      // here instead, where `maxQueueSize` applies and `getHealth()` can see it.
      this.isAwaitingDrain
    ) {
      this.writeQueue.push({ ...this.renderEntry(entry), attempts: 0 });
      this.enforceQueueLimit();
      this.ensureConnection();

      return;
    }

    this.writeEntry({ ...this.renderEntry(entry), attempts: 0 });
  }

  /**
   * Current state of the sink, in the shape `FileSink.getHealth()` uses.
   *
   * The one place this sink reports on itself. It replaced a `droppedEntryCount` getter
   * and an `isReconnecting` getter, which between them answered two of the seven
   * questions worth asking and left a queue growing behind an unusable pipe invisible
   * until entries began falling off the end of it. One method, the same shape as the
   * other queueing sink, so a consumer can watch both the same way.
   *
   * Cheap enough to poll: every field is already being tracked.
   */
  public getHealth(): NamedPipeSinkHealth {
    return {
      isHealthy: this.consecutiveFailures === 0 && this.isInitialized,
      queueSize: this.writeQueue.length,
      droppedEntries: this.droppedEntries,
      isInitialized: this.isInitialized,
      isReconnecting: this._isReconnecting,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Attempt to reconnect to the named pipe.
   * Useful when the pipe reader restarts or after a temporary error.
   * Queued writes during the outage will be flushed on successful reconnection.
   */

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

      // Whatever the old stream was waiting to drain is no longer anyone's business.
      this.isAwaitingDrain = false;

      // And abandon an open still in flight, which a caller asking to reconnect has
      // implicitly given up on. Left in place it would make the attempt below a no-op.
      if (this.pendingStream) {
        const pending = this.pendingStream;

        this.pendingStream = undefined;

        try {
          pending.destroy();
        } catch {
          // Nothing further to try; a new stream is about to replace it.
        }
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

    if (this.reopenTimer !== undefined) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = undefined;
    }

    // An open still waiting for a reader is abandoned rather than waited on: it cannot
    // complete without the reader that never came, and holding it would keep a descriptor
    // and a threadpool slot for the life of the process.
    if (this.pendingStream) {
      const pending = this.pendingStream;

      this.pendingStream = undefined;

      try {
        pending.destroy();
      } catch {
        // Nothing further to try; the sink is closing either way.
      }
    }

    if (this.pipeStream && !this.pipeStream.destroyed) {
      const stream = this.pipeStream;

      return new Promise<void>((resolve) => {
        // Bounded by `closeTimeoutMS`, which until now covered only the wait for
        // *initialization* and not the close itself. `end()` flushes before it calls back,
        // and a FIFO with no reader cannot flush - so on the sink's most ordinary failure
        // this callback never fired and `close()` never resolved, hanging whatever was
        // shutting the process down. The timeout matters more now that the sink reopens on
        // its own: a stream created during an outage is one `close()` will find here.
        let isSettled = false;

        const finish = (): void => {
          if (isSettled) {
            return;
          }

          isSettled = true;
          clearTimeout(timeoutHandle);
          this.pipeStream = undefined;
          resolve();
        };

        const timeoutHandle = setTimeout(() => {
          // Destroyed rather than left pending, so the descriptor is not held for the life
          // of the process by a flush that is never going to happen.
          try {
            stream.destroy();
          } catch {
            // Nothing further to try; the sink is closing either way.
          }

          finish();
        }, this.closeTimeoutMS);

        timeoutHandle.unref?.();

        try {
          stream.end(() => {
            finish();
          });
        } catch (error) {
          this.handleError(PipeErrorType.CLOSE, error);
          finish();
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
      const stream = fs.createWriteStream(this.pipePath, {
        flags: 'a', // Append mode
      });

      this.pendingStream = stream;

      stream.on('error', (err) => {
        // A stream this sink has already moved on from - ended by `reconnect()`, replaced
        // after a failure - can still deliver its error afterwards, and that error says
        // nothing about the connection now in hand. Reported, because it did happen, but
        // it changes no state and is not counted against the health of a stream that is
        // working: left ungated, an error arriving a tick after `reconnect()` succeeded
        // marked the fresh connection uninitialized and sent every later entry to the
        // queue.
        const isCurrent =
          this.pendingStream === stream || this.pipeStream === stream;

        this.handleError(PipeErrorType.WRITE, err, {
          countsAgainstHealth: isCurrent,
        });

        if (!isCurrent) {
          return;
        }

        this.pendingStream = undefined;
        this.pipeStream = undefined;
        // Nothing is going to drain now, so a later stream is not made to wait on a
        // `'drain'` this one will never emit.
        this.isAwaitingDrain = false;

        // Uninitialized as well as streamless, so `write` queues what comes next instead
        // of discarding it. Leaving this set was what made a single pipe error terminal:
        // the sink looked ready, had nowhere to write, and silently lost every entry until
        // the application happened to call `reconnect()` itself.
        this.isInitialized = false;

        // And recovery starts here, because this is the first moment it can. A failed
        // write reports through its callback *before* the stream emits `'error'`, so the
        // `requeue` that callback performs asks for a reconnection while this sink still
        // looks connected - and is told there is nothing to do. Without this the requeued
        // entry sat until some unrelated later write happened along, which in a quiet
        // process is never.
        this.ensureConnection();
      });

      // Initialized means *open*, not merely constructed. Until this fires there is
      // nowhere to put a line that Node would not buffer without limit, so entries wait
      // in this sink's own queue, under its own cap, where `getHealth()` can see them.
      stream.on('open', () => {
        // Only the stream this sink is still waiting on may be promoted. An open that
        // completes after `reconnect()` abandoned it belongs to nothing, and installing it
        // would replace a live connection with one nobody is holding.
        if (this.closed || this.closing || this.pendingStream !== stream) {
          try {
            stream.destroy();
          } catch {
            // Nothing further to try for a stream nothing is using.
          }

          return;
        }

        this.pendingStream = undefined;
        this.pipeStream = stream;
        this.isInitialized = true;

        // Process any queued writes
        this.processQueue();
      });

      // Bounded: a reader may never arrive, and the caller asked a question that has to be
      // answered. The open is left in flight either way - see `pendingStream`.
      await this.waitForOpen(stream);
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
    while (
      this.writeQueue.length > 0 &&
      !this.closed &&
      // Stops at backpressure rather than emptying the managed queue into Node's
      // unbounded one. `'drain'` resumes it; see `pauseUntilDrain`.
      !this.isAwaitingDrain &&
      this.pipeStream !== undefined &&
      !this.pipeStream.destroyed
    ) {
      const queued = this.writeQueue.shift();
      if (queued) {
        this.writeEntry(queued);
      }
    }
  }

  /**
   * Hold the queue until the stream asks for more.
   *
   * One listener at a time, which is what the flag is for: a `'drain'` listener per
   * backpressured write is the leak this sink had before, and it handled nothing.
   */
  private pauseUntilDrain(): void {
    const stream = this.pipeStream;

    if (this.isAwaitingDrain || stream === undefined) {
      return;
    }

    this.isAwaitingDrain = true;

    stream.once('drain', () => {
      // The stream may have been replaced while this was pending, in which case its
      // successor decides when to drain and this one's `'drain'` means nothing.
      if (this.pipeStream !== stream) {
        return;
      }

      this.isAwaitingDrain = false;
      this.processQueue();
    });
  }

  /**
   * Put a failed entry back on the queue, or give up on it.
   *
   * The retry half of the policy `FileSink` has always had and this sink had none of: a
   * write that did not land is not the same as a line the caller did not want. It goes
   * back on the queue and out when the pipe is next usable, up to `maxRetries`.
   *
   * Re-queued at the **back**, which is the same trade `FileSink` makes: it costs
   * ordering against a failing entry blocking everything behind it, and during an outage
   * nothing is being written in order anyway.
   *
   * An entry that has used up its attempts is counted as a drop rather than vanishing,
   * so `getHealth().droppedEntries` means "lines this sink did not deliver" whatever the
   * reason.
   */
  private requeue(queued: QueuedPipeEntry): void {
    if (this.closed || this.closing) {
      return;
    }

    if (queued.attempts >= this.maxRetries) {
      this.droppedEntries++;

      return;
    }

    this.writeQueue.push({ ...queued, attempts: queued.attempts + 1 });
    this.enforceQueueLimit();
    this.ensureConnection();
  }

  /**
   * Try again once the cooldown has elapsed.
   *
   * A single deferred attempt, not a retry loop: it is scheduled by something that
   * actually happened - a write that failed, or an entry queued with nowhere to go - and
   * an attempt that fails does not schedule another on its own. A sink whose pipe is gone
   * for good therefore costs one attempt per event rather than a timer running forever.
   */
  private scheduleReopen(delayMS: number): void {
    if (this.reopenTimer !== undefined || this.closed || this.closing) {
      return;
    }

    const timer = setTimeout(() => {
      this.reopenTimer = undefined;
      this.ensureConnection();
    }, delayMS);

    // So a pending attempt cannot hold the process open.
    timer.unref?.();

    this.reopenTimer = timer;
  }

  /**
   * Wait for a freshly created stream to open, fail, or take too long.
   *
   * Resolves rather than rejecting in every case: the caller's contract is a status, and
   * "the pipe has not opened yet" is one of the answers, not a failure to report. Which
   * of the three happened is read off `isInitialized` afterwards.
   */
  private async waitForOpen(stream: fs.WriteStream): Promise<void> {
    if (stream.destroyed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let isSettled = false;

      const finish = (): void => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        clearTimeout(timeoutHandle);
        stream.off('open', finish);
        stream.off('error', finish);
        resolve();
      };

      const timeoutHandle = setTimeout(finish, OPEN_WAIT_MS);

      // So a pending open cannot hold the process open on its own.
      timeoutHandle.unref?.();

      stream.once('open', finish);
      stream.once('error', finish);
    });
  }

  /**
   * Reopen the pipe if it is not usable, at most one attempt at a time.
   *
   * `initializePipe` flushes the queue itself once it succeeds, so recovery needs nothing
   * further from here.
   *
   * Two guards, and both are load-bearing. Only one attempt may be in flight, because
   * opening a FIFO with no reader does not fail - it *blocks* until a reader appears,
   * holding a libuv threadpool slot (four by default) for as long as it waits, so
   * concurrent attempts would starve every other file operation in the process. And
   * attempts are spaced by {@link REOPEN_COOLDOWN_MS}, because this is called from
   * `write`, which during an outage is called as often as the application logs.
   */
  private ensureConnection(): void {
    if (
      this.closed ||
      this.closing ||
      this.isInitialized ||
      this._isReconnecting ||
      // An open is already in flight. Starting a second would add a descriptor and a
      // threadpool slot for an answer the first one is going to give.
      this.pendingStream !== undefined
    ) {
      return;
    }

    const now = Date.now();
    const sinceLastAttempt = now - this.lastReopenAttempt;

    if (sinceLastAttempt < REOPEN_COOLDOWN_MS) {
      // Deferred rather than dropped. The cooldown is there to keep a dead pipe from
      // becoming a syscall storm, not to make recovery wait for the next log call: an
      // entry requeued by a failed write would otherwise sit until unrelated traffic
      // arrived, and a process that has just lost its log pipe may have nothing else to
      // say.
      this.scheduleReopen(REOPEN_COOLDOWN_MS - sinceLastAttempt);

      return;
    }

    this.lastReopenAttempt = now;
    this._isReconnecting = true;

    this.initPromise = this.initializePipe().finally(() => {
      this._isReconnecting = false;
    });

    // `initializePipe` reports its own failures through `handleError` and never rejects,
    // but this chain is not awaited by anyone, so a throw from the `finally` above would
    // be an unhandled rejection raised out of an ordinary `logger.info()`.
    void this.initPromise.catch(() => {
      // Nothing left to report with.
    });
  }

  /**
   * Discard the oldest entries once the queue is over `maxQueueSize`.
   *
   * Reported once rather than per entry: an outage drops continuously, and a callback
   * fired per line would be its own flood on a path already in trouble.
   */
  private enforceQueueLimit(): void {
    const limit = this.maxQueueSize;

    if (limit === undefined) {
      return;
    }

    while (this.writeQueue.length > limit) {
      this.writeQueue.shift();
      this.droppedEntries++;
    }

    if (this.droppedEntries === 0 || this.didReportDrop) {
      return;
    }

    this.didReportDrop = true;

    this.handleError(
      PipeErrorType.WRITE,
      new Error(
        `Pipe queue is full (maxQueueSize=${limit}); dropping the oldest entries`,
      ),
    );
  }

  /**
   * Render one entry into the line to write, keeping a failure rather than retrying it.
   *
   * See {@link QueuedPipeEntry.formatError}: a render is attempted exactly once, while
   * the caller's stack is still held, whether the entry goes out now or waits for the
   * pipe.
   */
  private renderEntry(entry: LogEntry): RenderedLine {
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
      // Back on the queue rather than skipped. This is reached from `processQueue`, where
      // the stream can go away between one entry and the next, and an entry dropped here
      // is one the caller asked to log and will never see.
      this.requeue(queued);

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

      // The return value is deliberately ignored. It says the stream's buffer is over its
      // high-water mark, which for this sink changes nothing: entries are handed over as
      // they arrive and Node buffers what the pipe has not taken yet.
      //
      // A `once('drain')` listener used to be attached here with an empty body - it
      // handled nothing, and one was added per backpressured write, so a stalled pipe
      // reached Node's listener-leak warning within a few thousand entries. Queueing
      // instead of dropping makes that path far busier, which is what turned a harmless
      // no-op into a real leak.
      //
      // The *callback* is where a write is confirmed, and it is why this entry is not
      // considered delivered yet. `write` returning is not success: a stream reports
      // `EPIPE` and its kin asynchronously, through this callback and an `'error'` event,
      // so treating the synchronous return as delivery meant the one entry that actually
      // failed was the one entry never retried - it had already been dropped from the
      // queue, and the `'error'` handler has no idea which line it belonged to.
      const canContinue = this.pipeStream.write(messageToWrite, (error) => {
        if (error) {
          // Not reported here: the stream raises `'error'` for the same failure and
          // `handleError` answers it once. This is the half that error cannot do - put
          // the line back.
          this.requeue(queued);

          return;
        }

        this.consecutiveFailures = 0;
      });

      if (!canContinue) {
        this.pauseUntilDrain();
      }
    } catch (error) {
      this.handleError(PipeErrorType.WRITE, error);
      // The line never reached the pipe, so it goes back on the queue and out on a later
      // attempt - the same answer `FileSink` gives a throwing write.
      this.requeue(queued);
    }
  }

  /**
   * Format a log entry for pipe output
   */
  private formatEntry(entry: LogEntry): string {
    // Use custom formatter if provided.
    //
    // A formatter that throws still falls back to the default format, because losing the
    // line is the worse failure of the two - but it is reported now rather than swallowed.
    // Silently falling back meant a caller whose formatter was broken saw perfectly
    // ordinary log lines and never learned it had not run.
    if (this.formatter) {
      try {
        return this.formatter(entry) + '\n';
      } catch (error) {
        // `FORMAT`, not `WRITE`: the fallback below still produces a line and the pipe is
        // untouched, so this is advisory. It also keeps the both-threw case honest - if
        // the default format throws too, `writeEntry` reports that as the one `WRITE`
        // failure, so a caller counting lost entries counts one rather than two.
        this.handleError(PipeErrorType.FORMAT, error);
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
  private handleError(
    errorType: PipeErrorType,
    error: unknown,
    options?: { countsAgainstHealth?: boolean },
  ): void {
    // Normalized rather than trusted: `error` reaches here from Node's stream and
    // filesystem callbacks as well as from `catch` blocks, so it is not guaranteed to be
    // an `Error`, and `onError` declares one.
    const failure = toError(error);

    this.lastError = failure;

    // Write failures only, and only from the stream in hand. A `FORMAT` failure still
    // wrote a line and left the pipe untouched - the distinction the error type itself
    // exists to draw - and a failure delivered late by a stream this sink has already
    // replaced says nothing about the one that replaced it.
    if (
      errorType === PipeErrorType.WRITE &&
      options?.countsAgainstHealth !== false
    ) {
      this.consecutiveFailures++;
    }

    // The shared rung, so this channel cannot drift from the logger's four. Nothing here
    // may escape: `handleError` runs from a Node stream `'error'` handler, where a throw is
    // an uncaught exception that ends the process, and from `initializePipe`, whose promise
    // the constructor starts without a `.catch`, where it would be an unhandled rejection
    // raised out of a constructor. The console rung is guarded for the same reason -
    // `console.error` throws on a broken stdout, which is exactly the condition a pipe sink
    // fails under.
    reportThroughHandler(
      this.onError === undefined
        ? undefined
        : () => {
            this.onError?.(errorType, failure, this.pipePath);
          },
      () => `NamedPipeSink error (${errorType}): ${describeError(failure)}`,
    );
  }
}
