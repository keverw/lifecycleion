import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import type { LogEntry, LogSink } from '../types';
import { LogLevel, getLogLevel } from '../types';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import { reportThroughHandler } from '../../internal/failure-reporter';
import {
  resolveMaxQueueSize,
  resolveMaxRetries,
} from './internal/queue-policy';
import type {
  SinkErrorHandler,
  SinkFailureDisposition,
  SinkFailureKind,
} from './internal/sink-failure';

export type {
  SinkErrorHandler,
  SinkFailure,
  SinkFailureDisposition,
  SinkFailureKind,
} from './internal/sink-failure';

export interface NamedPipeSinkOptions {
  pipePath: string;
  /**
   * Lowest level this sink writes. Defaults to {@link LogLevel.INFO}, matching `FileSink`
   * and `ConsoleSink`.
   *
   * This sink had no level filtering at all, so every entry went down the pipe on the
   * reasoning that whatever is reading it decides. That is still a reasonable posture for
   * an aggregator - pass `LogLevel.DEBUG` to restore it - but a sink that cannot be told
   * what to send was the odd one out of the three, and the asymmetry is paid for in
   * bandwidth to a reader that is only going to discard it.
   *
   * A `raw` entry is written whatever this is set to, as in the other sinks.
   */
  minLevel?: LogLevel;
  jsonFormat?: boolean;
  closeTimeoutMS?: number;
  /**
   * Notified when this sink cannot do its job, in the shape every sink reports.
   *
   * One object rather than three positional arguments, and the same one `FileSink` hands
   * back: `kind` says what failed - `'write'` means a line is at risk, `'format'` means
   * your `formatter` threw and the default format went out in its place - `target` is the
   * pipe path, and `attempt` / `disposition` say which try this was and what became of
   * the line.
   *
   * `entry` is always absent here: this sink drops the `LogEntry` once its line is
   * rendered, so that a queue stalled behind an unusable pipe does not pin the caller's
   * params graph for the length of the outage. See {@link SinkFailure}.
   */
  onError?: SinkErrorHandler;
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
   * `onError` as a `'queue_full'` failure carrying `disposition: 'lost'` - it is about the
   * oldest lines and they are gone - so a silently truncated log is never the only
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
   * Entries this sink did not deliver - evicted at `maxQueueSize`, out of retries, still
   * queued when `close()` gave up on them, or failed by a write that was already in flight
   * when `close()` finished.
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
  | { success: false; reason: 'closed' }
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
/**
 * The least time `close()`'s final flush is given, however little of `closeTimeoutMS` is
 * left by the time it is reached.
 *
 * The init wait, the drain loop and the flush share one deadline, which is what keeps a
 * documented thirty-second close from taking sixty. Shared exactly, though, the flush can
 * be handed zero - and a zero-millisecond destroy registered before `end()` is called in
 * the same tick beats a `'finish'` that cannot fire synchronously, so the flush would not
 * merely be short but impossible. This is the floor that keeps it a flush.
 */
const MIN_CLOSE_FLUSH_MS = 100;

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
 * How long a pending open may stay in flight before `ensureConnection` gives up on it.
 *
 * An open that has outlived this is not slow, it is stuck: `waitForOpen` already answered
 * at {@link OPEN_WAIT_MS}, so anything still pending has had several times that. The case
 * that matters is a reader that recreates the FIFO - `rm pipe; mkfifo pipe` - which leaves
 * the blocked open pointing at an unlinked inode, so it can never emit `'open'` or
 * `'error'` and `pendingStream` is never cleared. Every later `write()` and every
 * `scheduleReopen` then returned at `ensureConnection`'s in-flight guard, and the sink sat
 * wedged with a growing queue, `lastError` undefined and `onError` silent - dropping the
 * oldest lines once the cap was reached, for the life of the process.
 */
const STALE_OPEN_MS = OPEN_WAIT_MS * 3;

/**
 * How many abandoned opens may be outstanding before no further attempt is made.
 *
 * `destroy()` cannot cancel an `open(2)` already blocked in the libuv threadpool, so each
 * abandoned attempt holds one of the four default slots until the kernel releases it -
 * possibly never. Retrying without a cap would trade a wedged sink for a process whose
 * every other file operation is starved, which is the worse of the two. Two leaves half
 * the pool for the rest of the process, and the sink reports rather than falls silent once
 * it is reached.
 */
const MAX_ABANDONED_OPENS = 2;

/**
 * NamedPipeSink writes logs to a named pipe (FIFO)
 * Only supported on Linux and macOS
 */
export class NamedPipeSink implements LogSink {
  private pipePath: string;
  private jsonFormat: boolean;
  private onError?: SinkErrorHandler;
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
   * When {@link pendingStream} was created, so {@link STALE_OPEN_MS} can be measured.
   */
  private pendingStreamSince?: number;
  /**
   * Opens abandoned as stale and still unaccounted for. See {@link MAX_ABANDONED_OPENS}.
   */
  private abandonedOpens = 0;
  /**
   * Whether {@link MAX_ABANDONED_OPENS} has already been reported, so it is said once.
   */
  private reportedAbandonedOpenCap = false;
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
  private minLevel: LogLevel;
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
  /** Whether a drain pass is already running; see `processQueue`. */
  private isProcessing = false;
  /**
   * Failures already reported from a write callback, so the stream's own `'error'` event
   * does not report them a second time.
   *
   * A stream delivers one failed write through both channels, and they know different
   * halves of it: the callback knows the line and the retry, the event knows the
   * connection. Reporting both put two entries in a consumer's hands for one failure, the
   * second contradicting the first about whether the line was coming back.
   *
   * A set keyed on the error itself, not a single slot holding the last one. One slot was
   * wrong in two directions: a *different* error arriving in between - a stale stream
   * emitting while a current callback waited for its event - cleared the entry and let the
   * real one be reported twice, and two failed callbacks in flight together overwrote each
   * other, so the first was reported twice as well. Identity is what actually pairs the
   * two channels, so identity is what this tracks.
   *
   * Weak, so remembering a failure cannot keep the error - or whatever its `cause` holds -
   * alive; an entry that never sees its event is simply collected.
   */
  private readonly suppressedWriteErrors = new WeakSet<object>();
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
  /**
   * Whether an open is in flight, from the moment one is asked for.
   *
   * Separate from `_isReconnecting`, which `getHealth` reports and which means what it
   * says - a *re*-open after a failure. This covers the constructor's first open too, and
   * covers all of them from the synchronous instant the attempt starts rather than from
   * whenever `pendingStream` is finally assigned.
   *
   * That gap was the whole bug. `ensureConnection` refuses a second open on
   * `_isReconnecting` and `pendingStream`, but the constructor's `initializePipe()` sets
   * neither until *after* its `await fsPromises.stat()` - so a `write()` in the same tick
   * as `new NamedPipeSink(...)`, which is the ordinary case, walked through every guard
   * and started a second open of the same FIFO. Opening a FIFO with no reader does not
   * fail, it blocks: two of libuv's four threadpool slots held indefinitely, and an
   * orphaned stream destroyed only if its open ever completes. That is exactly the
   * starvation the guards' own documentation says they prevent.
   */
  private isOpening = false;
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
    this.minLevel = options.minLevel ?? LogLevel.INFO;

    this.initPromise = this.initializePipe();
  }

  public write(entry: LogEntry): void {
    if (this.closing || this.closed) {
      return;
    }

    // Before the render, so a filtered entry never runs a caller's `formatter`. Checked
    // the way the other sinks check it, `raw` included.
    if (entry.type !== 'raw') {
      const logLevel = getLogLevel(entry.type);

      if (logLevel > this.minLevel) {
        return;
      }
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
    // The guard every other entry point carries - `write`, `ensureConnection`,
    // `scheduleReopen`, `writeEntry` - and the only public one that was missing it. A
    // `reconnect()` after `close()` re-opened the FIFO, and on the sink's ordinary failure
    // that open never completes: `close()` had already run its `pendingStream` cleanup, so
    // the fresh descriptor and the libuv threadpool slot behind it were held for the life
    // of the process, for a sink nothing can write to again.
    if (this.closed || this.closing) {
      return { success: false, reason: 'closed' };
    }

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
        this.pendingStreamSince = undefined;

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

    const startTime = Date.now();

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

    // Drain what the pipe can still take before giving up on it, the way
    // `FileSink.close()` has always waited on its own queue. This sink went straight to
    // `abandonQueueOnClose()` with no attempt at all, so a backlog present at `close()` was
    // discarded even with the pipe open and a reader actively consuming: measured at 200
    // writes, 192 still queued, `droppedEntries: 192` after an `await close()` that could
    // have written every one of them. A graceful shutdown losing the tail of the log it is
    // shutting down is the one moment those lines matter most.
    //
    // Conditioned on the stream, which is what makes this different from `FileSink`'s
    // wait. A FIFO with no reader cannot flush, and there is no progress to wait for: with
    // the stream gone or destroyed the queue is abandoned immediately, exactly as before,
    // rather than holding a shutdown for `closeTimeoutMS` to achieve nothing.
    while (
      (this.writeQueue.length > 0 || this.isProcessing) &&
      this.pipeStream !== undefined &&
      !this.pipeStream.destroyed &&
      Date.now() - startTime <= this.closeTimeoutMS
    ) {
      // Asked for explicitly: nothing else drives a pass while this loop is awaiting, and
      // the queue may have been left parked by a failed write rather than by backpressure.
      this.processQueue();

      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    this.closed = true;

    // `isHealthy` is `consecutiveFailures === 0 && isInitialized`, so a sink that closed
    // cleanly went on reporting itself healthy to anything polling `getHealth()` - with no
    // stream, and `write()` discarding everything handed to it. Closed is not healthy.
    this.isInitialized = false;

    this.abandonQueueOnClose();

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
      this.pendingStreamSince = undefined;

      try {
        pending.destroy();
      } catch {
        // Nothing further to try; the sink is closing either way.
      }
    }

    if (this.pipeStream && !this.pipeStream.destroyed) {
      const stream = this.pipeStream;

      // What is left of the *whole* close's budget, not a fresh one. `closeTimeoutMS`
      // counted from here on top of the drain loop above - which counts from `startTime`
      // and spins its full length against a reader that has stalled - made a documented
      // thirty-second bound a sixty-second one, which is the stall a shutdown timeout
      // exists to prevent. Measured from `startTime`, so the init wait, the drain, and
      // this flush share one deadline.
      //
      // Floored rather than allowed to reach zero. The drain loop exits on the same
      // deadline, so a stalled reader arrives here with nothing left, and a `0` ms timer
      // registered before `end()` is called in the same tick always wins the race against
      // a `'finish'` that cannot fire synchronously - which would make the final flush
      // unreachable for the very stream that has a reader again by the time it is asked.
      // The floor is what the whole close can overshoot by, and it is a tenth of a second
      // against a default of thirty.
      const remainingCloseMS = Math.max(
        MIN_CLOSE_FLUSH_MS,
        this.closeTimeoutMS - (Date.now() - startTime),
      );

      return new Promise<void>((resolve) => {
        // Bounded, by `remainingCloseMS` above. Until this existed the close itself had no
        // timeout at all - `closeTimeoutMS` covered only the wait for *initialization*. `end()` flushes before it calls back,
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
        }, remainingCloseMS);

        timeoutHandle.unref?.();

        try {
          stream.end(() => {
            finish();
          });
        } catch (error) {
          this.handleError('close', error);
          finish();
        }
      });
    }
  }

  /**
   * Give up on whatever is still queued when the sink closes, and say so.
   *
   * A FIFO with no reader is this sink's ordinary failure, and the queue behind it is
   * exactly what `close()` cannot flush - there is nothing to flush it into. Those lines
   * went nowhere, so they are counted like any other line this sink did not deliver
   * rather than vanishing: `droppedEntries` means the same thing here as at the queue cap
   * and at the end of an entry's retries.
   *
   * Reported once, not once per entry, for the reason `enforceQueueLimit` reports once: a
   * shutdown that abandons a full queue would otherwise fire the callback ten thousand
   * times, on the way out of the process. `'close'` rather than `'write'`, so it is not
   * counted against a connection that is being torn down anyway.
   */
  private abandonQueueOnClose(): void {
    const abandoned = this.writeQueue.length;

    if (abandoned === 0) {
      return;
    }

    this.writeQueue = [];
    this.droppedEntries += abandoned;

    this.handleError(
      'close',
      new Error(
        `Closed with ${String(abandoned)} entr${abandoned === 1 ? 'y' : 'ies'} still queued for ${this.pipePath}; they were not written`,
      ),
      { disposition: 'lost' },
    );
  }

  /**
   * Initialize the named pipe connection
   */
  /**
   * Open the pipe, refusing to let two opens overlap.
   *
   * The flag is set here rather than at each call site because the call sites are what
   * kept getting it wrong: `ensureConnection` guards, `reconnect` guards, and the
   * constructor did not. An `async` function body runs synchronously up to its first
   * `await`, so setting it here closes the window for every caller at once - including the
   * constructor's, where there is no `await` in front of it to hide behind.
   */
  private async initializePipe(): Promise<void> {
    this.isOpening = true;

    try {
      await this.openPipe();
    } finally {
      this.isOpening = false;
    }
  }

  private async openPipe(): Promise<void> {
    // Check platform support
    const platform = os.platform();
    if (platform !== 'linux' && platform !== 'darwin') {
      this.handleError(
        'unsupported_platform',
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
          'not_a_pipe',
          new Error(`${this.pipePath} exists but is not a named pipe (FIFO)`),
        );
        return;
      }

      // Create write stream
      const stream = fs.createWriteStream(this.pipePath, {
        flags: 'a', // Append mode
      });

      this.pendingStream = stream;
      this.pendingStreamSince = Date.now();

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

        // Already said, by the write callback that knew which line it was. Consumed only
        // when it matches: clearing on any error at all is what let an unrelated one -
        // from a stream this sink had already replaced - unsuppress the report that was
        // waiting for its own event.
        const wasReported =
          typeof err === 'object' &&
          err !== null &&
          this.suppressedWriteErrors.has(err);

        if (wasReported) {
          this.suppressedWriteErrors.delete(err);
        }

        if (!wasReported) {
          this.handleError('write', err, {
            countsAgainstHealth: isCurrent,
          });
        }
        // When it was reported, nothing further is recorded here: the write callback's
        // own `handleError` already set `lastError` and counted the failure. Counting it
        // again made one failed write read as two in `getHealth()` until a later success
        // reset the tally.

        if (!isCurrent) {
          return;
        }

        this.pendingStream = undefined;
        this.pendingStreamSince = undefined;
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

        // And a backstop, because the call above is refused for the one failure it matters
        // most for. This handler is registered before `waitForOpen` attaches its own
        // `once('error')`, so a stream that errors *during* the open window runs it while
        // `isOpening` - and, on every path but the constructor's, `_isReconnecting` - is
        // still set, and `ensureConnection` returns having scheduled nothing at all. A pipe
        // that failed while opening had no retry pending, and whatever its failed write had
        // requeued waited for unrelated traffic that a quiet process never produces.
        //
        // A timer rather than a second direct call, because a timer is the one thing those
        // flags cannot refuse: it fires after the open window has closed and they are down.
        // Bounded the way every other reopen is - `scheduleReopen` holds one timer at a
        // time and `ensureConnection` still applies its own cooldown when it fires - and a
        // no-op when the call above already did the work, since by then there is either a
        // connection or an open in flight.
        this.scheduleReopen(REOPEN_COOLDOWN_MS);
      });

      // Initialized means *open*, not merely constructed. Until this fires there is
      // nowhere to put a line that Node would not buffer without limit, so entries wait
      // in this sink's own queue, under its own cap, where `getHealth()` can see them.
      stream.on('open', () => {
        // Only the stream this sink is still waiting on may be promoted. An open that
        // completes after `reconnect()` abandoned it belongs to nothing, and installing it
        // would replace a live connection with one nobody is holding.
        if (this.closed || this.closing || this.pendingStream !== stream) {
          // Cleared when it is this sink's own pending stream being turned away, not only
          // when it belongs to nobody. Left set, it named a stream that had just been
          // destroyed, so `ensureConnection` went on seeing an open in flight and refused
          // every later attempt - and `close()`'s own cleanup had already run.
          if (this.pendingStream === stream) {
            this.pendingStream = undefined;
            this.pendingStreamSince = undefined;
          }

          try {
            stream.destroy();
          } catch {
            // Nothing further to try for a stream nothing is using.
          }

          return;
        }

        this.pendingStream = undefined;
        this.pendingStreamSince = undefined;
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
        'not_found',
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
    // Not re-entered. `writeEntry` can fail synchronously, and the `requeue` that follows
    // asks for a drain - which, without this, would recurse through the same loop for as
    // many retries as the queue holds. The pass already running picks the entry up.
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      this.drainQueue();
    } finally {
      this.isProcessing = false;
    }
  }

  private drainQueue(): void {
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
    if (this.closed) {
      // Past `abandonQueueOnClose()`, so nothing is going to carry this one any further.
      // Counted rather than dropped silently, because the entry was already shifted off
      // `writeQueue` and so was not among the ones that call reported.
      this.droppedEntries++;

      return;
    }

    if (queued.attempts >= this.maxRetries) {
      this.droppedEntries++;

      return;
    }

    this.writeQueue.push({ ...queued, attempts: queued.attempts + 1 });
    this.enforceQueueLimit();

    // `closing`, but not yet `closed`: `close()` sets the flag before its drain loop runs,
    // and that loop is what is driving this write. Returning early here - as this did for
    // both flags together - dropped the entry on the floor: not put back, not counted, and
    // `abandonQueueOnClose()` afterwards saw an empty queue and reported nothing, so a
    // failure during the shutdown the drain loop was added to improve was the one failure
    // `droppedEntries` did not know about. Put back so the loop can try it again, and
    // counted and reported by `abandonQueueOnClose()` if the loop runs out of time.
    //
    // No reconnect and no `processQueue()` from here: the loop calls `processQueue()`
    // itself every pass, and `close()` has already decided this sink is not opening
    // another pipe.
    if (this.closing) {
      return;
    }

    // Drained through the stream in hand, or reconnected when there is none. A write
    // callback can arrive after `reconnect()` has already put a working stream in place -
    // its failure belongs to the stream that is gone - and asking `ensureConnection` for
    // help then gets nothing, correctly, because the sink is connected. Without this the
    // requeued entry sat in a queue nothing was draining while every later write went
    // straight past it to the new stream.
    if (
      this.isInitialized &&
      this.pipeStream !== undefined &&
      !this.pipeStream.destroyed &&
      !this.isAwaitingDrain
    ) {
      this.processQueue();

      return;
    }

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
   * Give up on an open that has been in flight too long, so recovery can start again.
   *
   * `destroy()` does not cancel the underlying `open(2)`; it only stops this sink from
   * waiting on a descriptor that is never going to answer. The stream's own `'open'` and
   * `'error'` handlers already refuse to promote anything that is no longer
   * `pendingStream`, so abandoning one here is safe whenever it does eventually settle.
   *
   * Bounded by {@link MAX_ABANDONED_OPENS}, and reported either way: the failure this
   * exists for was silent, and a sink that has stopped trying has to say so.
   */
  private releaseStalePendingOpen(): void {
    const pending = this.pendingStream;
    const since = this.pendingStreamSince;

    if (pending === undefined || since === undefined) {
      return;
    }

    if (Date.now() - since < STALE_OPEN_MS) {
      return;
    }

    if (this.abandonedOpens >= MAX_ABANDONED_OPENS) {
      // Said once, not on every `write()` that arrives afterwards: this state persists for
      // as long as the kernel holds those opens, and a sink already in trouble must not
      // become its own flood. Without it the cap put the sink straight back into the
      // wedged-and-silent state `STALE_OPEN_MS` exists to end - refusing every attempt with
      // nothing anywhere saying it had stopped trying.
      if (!this.reportedAbandonedOpenCap) {
        this.reportedAbandonedOpenCap = true;

        this.handleError(
          'write',
          new Error(
            `Gave up reopening named pipe at ${this.pipePath}: ${String(MAX_ABANDONED_OPENS)} opens are still blocked and will not be retried until one of them returns`,
          ),
          { countsAgainstHealth: false },
        );
      }

      return;
    }

    this.pendingStream = undefined;
    this.pendingStreamSince = undefined;
    this.abandonedOpens++;

    // Decremented if the kernel ever releases it, so a pipe that recovers after a long
    // outage is not held against the cap forever. `'close'` fires once `destroy()` has
    // been able to run, which for a blocked open is when that open finally returns.
    pending.once('close', () => {
      this.abandonedOpens--;

      // Armed again, because the sink is no longer at the cap: a later outage that reaches
      // it is a new fact and has to be reported as one.
      this.reportedAbandonedOpenCap = false;
    });

    try {
      pending.destroy();
    } catch {
      // Nothing further to try for a stream this sink has already let go of.
    }

    this.handleError(
      'write',
      new Error(
        `Open of named pipe at ${this.pipePath} did not complete within ${String(STALE_OPEN_MS)}ms and was abandoned; retrying`,
      ),
      { countsAgainstHealth: false },
    );
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
    if (this.closed || this.closing) {
      return;
    }

    // Before the in-flight guard below, because that guard is what a stuck open turns into
    // a permanent refusal. See {@link STALE_OPEN_MS}.
    this.releaseStalePendingOpen();

    if (
      this.isInitialized ||
      this._isReconnecting ||
      // An open is already in flight. Starting a second would add a descriptor and a
      // threadpool slot for an answer the first one is going to give.
      //
      // `isOpening` as well as `pendingStream`, because `pendingStream` is only assigned
      // once the `stat` has come back: the constructor's open is in flight from the
      // instant it is asked for, and a `write()` in that same tick is the ordinary case,
      // not an edge one.
      this.isOpening ||
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

    let didEvict = false;

    while (this.writeQueue.length > limit) {
      this.writeQueue.shift();
      this.droppedEntries++;
      didEvict = true;
    }

    // Gated on an eviction this call made, not on the cumulative count.
    // `droppedEntries` also counts entries given up on by `requeue` after their retries
    // ran out, and those are not an overflow: reading the counter here reported a
    // `'queue_full'` the queue never had, and set `didReportDrop`, which nothing resets -
    // so the real overflow that followed was suppressed.
    if (!didEvict || this.didReportDrop) {
      return;
    }

    this.didReportDrop = true;

    // `'queue_full'` and `'lost'`, as `FileSink` reports the same event. Sent as a
    // `'write'` failure it was counted against the connection's health - which is fine -
    // and carried the default `'no_entry'` disposition, which says the failure is about no
    // particular line. It is about several: the oldest ones, and they are gone.
    this.handleError(
      'queue_full',
      new Error(
        `Pipe queue is full (maxQueueSize=${limit}); dropping the oldest entries`,
      ),
      { disposition: 'lost' },
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
      // `'format'`, as `FileSink` reports the same failure, and never retried: the line is
      // rendered once, on purpose, so a second attempt could not come out differently.
      // Counted, like every other line this sink does not deliver. `disposition: 'lost'`
      // and a `droppedEntries` that never moved disagreed about the same entry: three
      // failed renders reported three `format`/`lost` callbacks while `getHealth()` still
      // answered `{ isHealthy: true, queueSize: 0, droppedEntries: 0 }`, so an operator
      // polling health saw a sink in perfect condition that had delivered nothing.
      this.droppedEntries++;

      this.handleError('format', queued.formatError, {
        attempt: queued.attempts + 1,
        // No line was produced, and rendering is never repeated, so this one is gone.
        disposition: 'lost',
      });

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
      const stream = this.pipeStream;
      const canContinue = stream.write(messageToWrite, (error) => {
        if (error) {
          // Reported here, not left to the `'error'` event. Both describe the same
          // failure, but only this one knows *which line* it was and whether it is coming
          // back - the event reported `attempt: undefined` and a disposition of
          // `'no_entry'`, which reads as "nothing to retry" for a line the sink was about
          // to retry, so a handler writing a fallback copy duplicated it.
          //
          // The event is told to keep quiet about this particular error; it still does the
          // connection bookkeeping, which is the half it does know about.
          // Remembered by identity, so the `'error'` event carrying this same failure can
          // recognize it. A non-object is not trackable and is simply not suppressed: the
          // event then reports it, which is noisier than ideal but never silent.
          if (typeof error === 'object') {
            this.suppressedWriteErrors.add(error);
          }

          this.handleError('write', error, {
            attempt: queued.attempts + 1,
            disposition:
              queued.attempts < this.maxRetries ? 'retrying' : 'lost',
            // Only the stream still in hand may be marked unhealthy by this. The callback
            // runs later than the write that started it, and `reconnect()` may have put a
            // working stream in place in between - the failure belongs to the one that is
            // gone, exactly as it does in the `'error'` handler, which has always asked
            // this question. Reported either way: the line is still owed.
            countsAgainstHealth: this.pipeStream === stream,
          });

          this.requeue(queued);

          return;
        }

        // Only the stream in hand may clear the failure count. A callback from one that
        // has since been replaced says nothing about the connection that replaced it.
        if (this.pipeStream === stream) {
          this.consecutiveFailures = 0;
        }
      });

      if (!canContinue) {
        this.pauseUntilDrain();
      }
    } catch (error) {
      this.handleError('write', error, {
        attempt: queued.attempts + 1,
        disposition: queued.attempts < this.maxRetries ? 'retrying' : 'lost',
      });
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
        // `'fallback'`, not a claim that the line was written: this runs *inside*
        // rendering, before the default format has been produced and long before anything
        // reaches the pipe. What is true at this moment is only that the sink substituted
        // its own format; the line then takes the ordinary path, and if it is queued,
        // evicted, or fails to write, that is reported on its own terms.
        this.handleError('format', error, { disposition: 'fallback' });
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
    kind: SinkFailureKind,
    error: unknown,
    options?: {
      countsAgainstHealth?: boolean;
      attempt?: number;
      disposition?: SinkFailureDisposition;
    },
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
    if (kind === 'write' && options?.countsAgainstHealth !== false) {
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
        : // Returned, not dropped, so a promise from an `async` handler can be followed.
          () =>
            this.onError?.({
              kind,
              error: failure,
              target: this.pipePath,
              // No `entry`: this sink keeps the rendered line, not the `LogEntry`.
              attempt: options?.attempt,
              disposition: options?.disposition ?? 'no_entry',
            }),
      () => `NamedPipeSink error (${kind}): ${describeError(failure)}`,
    );
  }
}
