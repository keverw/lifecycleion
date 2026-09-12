import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import type { FileHandle } from 'fs/promises';
import * as os from 'os';
import type { LogEntry, LogSink } from '../types';
import { LogLevel, getLogLevel } from '../types';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import { reportThroughHandler } from '../../internal/failure-reporter';
import { readUnknownMember } from '../../internal/read-member';
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
 * The `errno` an `O_NONBLOCK` open for writing gives when the FIFO has no reader.
 *
 * POSIX is explicit about this one, and it is the whole reason the probe in `openPipe`
 * works: `open()` with `O_WRONLY | O_NONBLOCK` on a FIFO "shall return -1 and set errno to
 * `[ENXIO]`" when no process has that FIFO open for reading. Linux and macOS - the only
 * two platforms this sink runs on at all - both implement it as written, so there is no
 * per-platform branch here. Anything else that comes back is a real open failure and is
 * reported as one.
 */
const NO_READER_ERRNO = 'ENXIO';

/**
 * How many distinct open failures are reported before one outage has said enough.
 *
 * The set in {@link NamedPipeSink.reportedOpenFailures} is what bounds reporting, and in
 * practice it bounds it at three or four: three kinds, and a small number of `errno`s each.
 * This is the guard for the case where that assumption does not hold - a message that
 * varies for reasons the sink cannot see - which without a cap is a set that grows for as
 * long as the outage does, on the one path whose whole job is to survive a long outage
 * quietly.
 *
 * Eight, so the realistic ceiling is never the one reached, and the sink says when it is
 * rather than falling silent.
 */
const MAX_REPORTED_OPEN_FAILURES = 8;

/**
 * How long an open is waited on before the caller is told it has not completed.
 *
 * The open the sink commits to is only started once a reader is known to be there - see
 * `openWriteProbe` - so in the ordinary case it completes at once and this is never
 * reached. It still covers the one gap the probe cannot close: the reader may hang up in
 * the instant between the probe answering and `createWriteStream` issuing its own
 * `open(2)`, and that open blocks the way every FIFO open for writing does. Nobody is
 * made to wait on it indefinitely - `reconnect()` answers, and the constructor's
 * `initPromise` settles, whether or not the pipe opened - and if the reader comes back the
 * stream still promotes itself and flushes.
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
 *
 * Reached far less often since the probe: an open is only started once a reader has been
 * seen, so the plain "no reader yet" case - which used to leave an open pending forever,
 * every time - never gets this far. What is left is the narrow race the probe cannot
 * close, and this is still the only thing covering it.
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
 *
 * Kept, and not simplified away, though the probe in `openPipe` means an open is only
 * started when a reader has just been seen. It makes this a backstop rather than the
 * ordinary path - a FIFO nobody reads no longer produces a single blocked open, let alone
 * two - but it does not make it unreachable: the reader can still hang up inside the race
 * the probe leaves, and a FIFO recreated underneath a blocked open still never settles.
 * The accounting is what says so out loud when it happens.
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
   * The open failures reported during this outage, so one outage is not reported every
   * second.
   *
   * Every failed open now schedules another attempt - see `scheduleReopen` - which is what
   * makes recovery independent of traffic, and which without this would make a mistyped
   * `pipePath` call the caller's `onError` once a second for the life of the process. The
   * reporting the sink already does elsewhere works exactly this way: `didReportDrop` for
   * the queue cap, {@link reportedAbandonedOpenCap} for the open cap.
   *
   * A set rather than a boolean, so a *different* failure still gets through: a path that
   * goes from missing to present-but-unreadable is a new fact, and a consumer watching this
   * channel is entitled to it. Keyed on the kind as well as the message, since the two
   * messages share a prefix. Every open failure participates - `not_found`, `not_a_pipe`
   * and `setup`.
   *
   * A set rather than just the last one, which is the stricter of the two and the reason
   * this is a hard ceiling. Remembering only the previous failure reports on every
   * *change*, so a path genuinely flapping between two states - a deploy script creating
   * and removing it - is a report per transition, which at one attempt a second is the
   * flood again by another route. Remembering all of them means a state already reported
   * this outage stays quiet however many times it comes back, and one outage costs at most
   * {@link MAX_REPORTED_OPEN_FAILURES} callbacks however long it lasts or how it thrashes.
   *
   * Cleared when the pipe opens, so the next outage speaks up again, and cleared by
   * `reconnect()`, which is an attempt the caller asked for and is owed an answer to.
   */
  private readonly reportedOpenFailures = new Set<string>();
  /**
   * Whether {@link MAX_REPORTED_OPEN_FAILURES} has been reported, so it is said once.
   *
   * Said at all, rather than the sink simply going quiet at the cap, for the reason
   * {@link reportedAbandonedOpenCap} exists: a sink that has stopped telling you things has
   * to tell you that.
   */
  private reportedOpenFailureCap = false;
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
  /** Whether the one post-close loss report has gone out. See {@link requeue}. */
  private didReportPostCloseLoss = false;
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

  /**
   * Set while a `formatter` failure is being reported, so that report cannot re-enter it.
   *
   * See the guard in {@link formatEntry}. A nested format failure is not lost output: the
   * line still renders through the default format and still goes out.
   */
  private isReportingFormatFailure = false;

  /**
   * Whether the first entry refused because the sink is closing has been reported.
   *
   * See {@link write}. Every such entry is counted; only the first is reported.
   */
  private reportedCloseRefusal = false;

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
    // Before the render, so a filtered entry never runs a caller's `formatter`. Checked
    // the way the other sinks check it, `raw` included.
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
      // Counted and said, not discarded quietly. `close()` waits up to `closeTimeoutMS`
      // for the queue to drain, and everything logged in that window used to leave through
      // this early return with nothing to show for it: `droppedEntries` unmoved, `onError`
      // silent, `getHealth()` claiming a clean shutdown. `abandonQueueOnClose` counts the
      // lines that were already queued; these are the ones refused at the door, and they
      // went nowhere just the same.
      this.droppedEntries++;

      // Once, for the reason the abandoned queue reports once: an application still
      // logging through a thirty-second close would otherwise get a callback per line.
      if (!this.reportedCloseRefusal) {
        this.reportedCloseRefusal = true;

        this.handleError(
          'close',
          new Error(
            `Entry logged after close() began for ${this.pipePath}; it was not written, and further ones are counted in droppedEntries without being reported`,
          ),
          { disposition: 'lost' },
        );
      }

      return;
    }

    // Rendered now rather than at flush time, so the line is fixed while `write` still
    // holds the caller's stack.
    const rendered: QueuedPipeEntry = {
      ...this.renderEntry(entry),
      attempts: 0,
    };

    // Handed straight to `writeEntry`, which reports it, rather than queued. A render is
    // attempted exactly once on purpose, so waiting for a pipe cannot make this line
    // appear - and queueing it meant an unrenderable entry logged during an outage was
    // reported only if the pipe came back: with the reader still gone it sat in the queue
    // until `requeue` gave up on it and counted it in `droppedEntries` with no `onError`
    // call, or until `close()` called it a `'close'` failure. Either way the caller lost
    // the `'format'` diagnosis their own formatter had earned.
    if (rendered.formatError !== undefined) {
      this.writeEntry(rendered);

      return;
    }

    // Queued whenever there is nowhere to put it *yet* - before the first open, and after
    // a failure took the stream away.
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
      this.writeQueue.push(rendered);
      this.enforceQueueLimit();
      this.ensureConnection();

      return;
    }

    this.writeEntry(rendered);
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
      // An open already in flight has to finish before this one starts. `_isReconnecting`
      // is not the flag that covers it: the constructor's `initializePipe()` sets only
      // `isOpening`, so a `reconnect()` issued while the constructor's open was still
      // pending - an app that constructs the sink and reconnects on a "reader is ready"
      // signal - ran a second `openPipe` concurrently against the same FIFO: two probes,
      // two `createWriteStream` opens, one `pendingStream` assignment silently orphaned,
      // and `MAX_ABANDONED_OPENS` reached twice as fast. `_isReconnecting` is already set
      // above, so nothing new starts while this waits.
      if (this.isOpening) {
        await this.initPromise;

        // `close()` can have run while that open was awaited, and it takes the same view
        // the guard above does: a closed sink is not one to reopen.
        if (this.closed || this.closing) {
          return { success: false, reason: 'closed' };
        }
      }

      // Close existing stream if any, bounded. `end()` alone is what `close()` stopped
      // doing: it flushes before calling back, and a FIFO whose reader is attached but not
      // consuming - the exact state that prompts a manual `reconnect()` - never flushes,
      // so `'finish'` never fires, and with the reference dropped here the descriptor and
      // everything buffered behind it were pinned for the life of the process, once per
      // call. Flushed if it can be, destroyed if it cannot.
      if (this.pipeStream && !this.pipeStream.destroyed) {
        this.abandonStream(this.pipeStream);
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

      // The deduplication that keeps an automatic retry from calling `onError` once a
      // second is deliberately not applied to an attempt the caller asked for by name. The
      // docs promise that a failed `reconnect()` reports the failure again, and this is the
      // one path where "you asked, here is what happened" outranks flood control: it is
      // driven by the application, not by a timer, so it cannot run away - and the caller
      // has nowhere else to read the diagnosis, since `ReconnectStatus.error` is a generic
      // `Failed to initialize pipe connection` rather than the underlying failure.
      this.reportedOpenFailures.clear();
      this.reportedOpenFailureCap = false;

      this.initPromise = this.initializePipe();
      await this.initPromise;

      // Check if initialization actually succeeded
      if (this.isInitialized) {
        // The failures counted were about the stream this call just replaced, and nothing
        // else clears them: only a successful *write* did, so a `reconnect()` that opened a
        // fresh pipe over an empty queue returned `{ success: true }` while `getHealth()`
        // went on reporting `isHealthy: false` - until traffic happened to arrive, which in
        // a quiet process is never. A supervisor polling health answers that by restarting
        // a sink that is working. Deliberately not done on the automatic reopen path: there
        // the queue still holds the lines that failed, and their next attempt is the honest
        // answer to whether the connection works.
        this.consecutiveFailures = 0;

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
  /**
   * Let go of a stream this sink will not write to again, without leaking its descriptor.
   *
   * `end()` first, so anything still buffered reaches a reader that is consuming, then
   * `destroy()` on a timer for the one that is not - `end()`'s callback cannot fire on a
   * FIFO that cannot flush, and the caller has already stopped waiting for it. The timer
   * is unreferenced: this must not be a reason the process stays alive.
   */
  private abandonStream(stream: fs.WriteStream): void {
    let isSettled = false;

    const destroy = (): void => {
      if (isSettled) {
        return;
      }

      isSettled = true;

      try {
        stream.destroy();
      } catch {
        // Nothing further to try; the sink has already let go of this stream.
      }
    };

    const timer = setTimeout(destroy, MIN_CLOSE_FLUSH_MS);

    timer.unref?.();

    try {
      stream.end(() => {
        clearTimeout(timer);
        destroy();
      });
    } catch {
      clearTimeout(timer);
      destroy();
    }
  }

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
      // Through the dedup every other open failure goes through. Called directly, this one
      // bypassed it and nothing marked the sink unusable, so each `write()` re-entered
      // `openPipe` once `REOPEN_COOLDOWN_MS` had elapsed and a process logging once a
      // second called the caller's `onError` once a second, forever - the flood
      // {@link reportedOpenFailures} exists to prevent, on the one failure that is
      // certain never to clear: the platform is what it is for the life of the process.
      this.reportOpenFailure(
        'unsupported_platform',
        `Named pipes are only supported on Linux and macOS, current platform: ${platform}`,
        undefined,
      );

      return;
    }

    /**
     * The probe descriptor, held until the real stream has one of its own.
     *
     * Declared out here so the `finally` below can release it on every exit from the `try`
     * - the `not_a_pipe` and no-reader returns, the success, and the failures the `catch`
     * reports. The unsupported-platform return above is the one exit it does not cover,
     * and does not need to: it happens before there is a probe to release.
     */
    let probe: FileHandle | undefined;

    const closeProbe = async (): Promise<void> => {
      if (probe === undefined) {
        return;
      }

      try {
        await probe.close();
      } catch {
        // Nothing further to try, and nothing that depends on it: the real stream already
        // holds a descriptor of its own by the time this runs. A probe that will not close
        // is not worth failing a working connection over.
      }
    };

    try {
      // Check if the pipe exists and is a FIFO
      const stats = await fsPromises.stat(this.pipePath);
      if (!stats.isFIFO()) {
        // Reported and retried on the same terms as every other failed open, which it was
        // not until this was written. Reporting directly meant once per attempt - six
        // callbacks in four seconds against a path that was an ordinary file - and
        // returning with nothing scheduled made this an absorbing state: the retry chain
        // that recovers a missing path walks into it the moment the path exists as
        // something else, and stops. Measured: `rm pipe; touch pipe; rm pipe; mkfifo pipe`
        // with a live reader on the end of it left the sink uninitialized for good, having
        // stopped looking after the second step.
        this.reportOpenFailure(
          'not_a_pipe',
          `${this.pipePath} exists but is not a named pipe (FIFO)`,
          undefined,
        );

        this.scheduleReopen(REOPEN_COOLDOWN_MS);

        return;
      }

      // Ask whether anyone is reading *before* committing to an open that cannot be taken
      // back.
      //
      // `fs.createWriteStream` on a FIFO issues an ordinary blocking `open(2)`, and opening
      // a FIFO for writing does not fail when nothing is reading it - it waits, inside the
      // runtime's file-I/O thread pool, which is four threads for the whole process under
      // libuv's defaults. `destroy()` cannot cancel a syscall already in flight; it only
      // stops this sink waiting on the answer.
      // So the sink's most ordinary state - a pipe whose consumer has not started yet, or
      // has gone away - parked a threadpool thread indefinitely, and a pending threadpool
      // request also keeps the event loop alive: `await sink.close()` could resolve and the
      // process still needed `SIGKILL` to exit, with the queue abandoned, the descriptor
      // held and the thread gone from every other file operation in the program.
      //
      // `openWriteProbe` asks the same question with `O_NONBLOCK` and takes {@link
      // NO_READER_ERRNO} for an answer instead of waiting for one. No reader now costs a
      // syscall that returns immediately and holds nothing at all.
      try {
        probe = (await this.openWriteProbe()) ?? undefined;
      } catch (error) {
        // Not "no reader yet" but a real failure to open: a permissions change, the
        // process out of descriptors, a path replaced since the `stat`.
        //
        // Reported as `'setup'` - "the destination could not be opened" - and deliberately
        // not as the `'not_found'` the `catch` below uses, which means the destination does
        // not exist and is simply false for `EACCES` or `EMFILE`. It is not `'write'`
        // either, though that is the kind this failure used to arrive as: it reached the
        // sink through the stream's `'error'` handler, because `createWriteStream` does not
        // throw for these, it emits. `'write'` is documented as the one kind that means an
        // entry is at risk, and an open that failed before any stream existed is about no
        // entry at all.
        this.reportOpenFailure(
          'setup',
          `Could not open named pipe at ${this.pipePath}: ${describeError(error)}`,
          error,
        );

        // And a retry, because moving this failure off the stream's `'error'` handler took
        // one away. That handler ends with `ensureConnection()` and a `scheduleReopen`
        // backstop, so a pipe that could not be opened kept asking roughly once a second;
        // reported from here with nothing scheduled, it would have gone silent until some
        // later `write()` happened along - and a permission fixed, or descriptor pressure
        // relieved, a minute later is exactly the kind of thing a quiet process never
        // notices.
        this.scheduleReopen(REOPEN_COOLDOWN_MS);

        return;
      }

      if (probe === undefined) {
        // Quiet, deliberately. A pipe waiting for its reader is where this sink starts, not
        // a failure, and it was silent before this too - the blocked open simply sat there
        // saying nothing. Everything a consumer could observe is unchanged: `isInitialized`
        // stays false, `lastError` is untouched, `onError` is not called, and `getHealth()`
        // shows the queue growing behind the outage. Reporting it instead would fire once
        // per reopen attempt, for the whole time a reader is late.
        //
        // The one thing the blocking open did for free was wait: it promoted the stream and
        // flushed the queue the moment a reader arrived, with no timer and no further
        // traffic to prompt it. Something has to replace that, and it has to be
        // unconditional.
        //
        // Retrying only when the queue has something in it is the version that looks
        // frugal and is wrong. Constructing the sink before starting the reader is the
        // ordinary order - `new NamedPipeSink()` in the same tick as the process that will
        // read it, or a fraction of a second before - and at that moment the queue is
        // empty and nothing has been written. With no timer the sink then sat
        // uninitialized until some later `write()` happened to ask, so `getHealth()`
        // reported a pipe that was never going to open and a caller waiting on
        // `isInitialized` waited forever - for a reader that had in fact arrived a second
        // later. This sink's own tests start a reader and construct the sink immediately
        // afterwards, which is exactly that order, and they caught it.
        //
        // So: keep asking. `scheduleReopen` holds one unref'd timer at a time and
        // `ensureConnection` applies its own cooldown, which makes this one `stat` and one
        // non-blocking `open` per {@link REOPEN_COOLDOWN_MS} for as long as the pipe has no
        // reader. That is a real cost where the blocked open had none, and it is the right
        // side of the trade: the blocked open's price was a libuv threadpool thread and a
        // process that would not exit.
        this.scheduleReopen(REOPEN_COOLDOWN_MS);

        return;
      }

      // Create write stream
      //
      // The probe is still open across this, and that overlap is load-bearing rather than
      // untidy. A FIFO's reader sees EOF when the *last* writer closes it, so probing with
      // an open/close pair and then opening for real leaves a gap with no writer in it -
      // and `cat < pipe`, like every other reader that treats end of input as end of job,
      // exits in that gap. Measured: the reader hung up before the first line was written.
      // Holding both descriptors until this one is open means there is no gap to see.
      // Asked again, because both answers above came from an await. `close()` bounds its
      // own drain and cleanup, so an open that started before it can resume after it has
      // finished - and `reconnect()` got exactly this guard while this path did not. The
      // open that follows is the one that cannot be taken back: if the reader hung up in
      // the probe-to-open window it blocks in the runtime's file-I/O thread pool, nothing
      // is left to fire `'open'` and destroy it, and `ensureConnection` returns early on
      // `closed` so `releaseStalePendingOpen` never runs either - a descriptor and a
      // threadpool slot held for the life of the process, behind a `close()` that already
      // resolved.
      if (this.closed || this.closing) {
        return;
      }

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
          if (isCurrent && stream.pending) {
            // An open that failed, not a write: `createWriteStream` does not throw for
            // `EACCES`, `EISDIR` or `EMFILE`, it emits here, and this sink's own probe
            // reports the same failures as `'setup'`. Two things went wrong arriving as
            // `'write'`. The kind is documented as the one that means an entry is at risk,
            // and no entry is at risk from a stream that never had a descriptor; and the
            // report bypassed `reportOpenFailure`, so a persistent post-probe failure - the
            // `O_NONBLOCK` probe succeeding and the stream open then failing `EMFILE` under
            // descriptor pressure - called `onError` once per retry, forever, which is the
            // flood the dedupe and the cap exist to stop.
            this.reportOpenFailure(
              'setup',
              `Could not open named pipe at ${this.pipePath}: ${describeError(err)}`,
              err,
            );
          } else {
            this.handleError('write', err, {
              countsAgainstHealth: isCurrent,
            });
          }
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

        // A later outage is a new fact and is reported as one. See
        // {@link reportedOpenFailures}.
        this.reportedOpenFailures.clear();
        this.reportedOpenFailureCap = false;

        // Process any queued writes
        this.processQueue();
      });

      // Bounded: the reader seen a moment ago may have hung up in the meantime, and the
      // caller asked a question that has to be answered. The open is left in flight either
      // way - see `pendingStream`.
      await this.waitForOpen(stream);

      // The one exit that armed nothing. `waitForOpen` answers at `OPEN_WAIT_MS` whether
      // or not the open has settled, and an open still in flight leaves `pendingStream`
      // set - which `ensureConnection` reads as "an attempt is already running" and
      // refuses every later one until `releaseStalePendingOpen` clears it. That only runs
      // from `ensureConnection`, so a process that stopped logging never got there: the
      // sink sat `isInitialized: false` with no timer behind it, contradicting
      // `scheduleReopen`'s claim that recovery does not wait on traffic. Armed past
      // `STALE_OPEN_MS`, so the timer finds the open old enough to abandon.
      if (
        !this.isInitialized &&
        !this.closed &&
        !this.closing &&
        this.pendingStream === stream
      ) {
        this.scheduleReopen(STALE_OPEN_MS + REOPEN_COOLDOWN_MS);
      }
    } catch (error) {
      this.reportOpenFailure(
        'not_found',
        `Could not open named pipe at ${this.pipePath}: ${describeError(error)}`,
        error,
      );

      // Armed here too, so every way an open can fail leaves the sink still trying. This
      // is the `stat` failing - the FIFO deleted, or not created yet - and it was the one
      // failure with no timer behind it at all: recovery waited on the next `write()`, so
      // a `rm pipe; mkfifo pipe` during a quiet minute was picked up whenever traffic
      // happened to resume, and a process that had stopped logging never picked it up.
      // Throttled by the same means as every other attempt - one timer at a time here, and
      // `ensureConnection`'s cooldown when it fires - so a path that is never coming back
      // costs one `stat` a second and nothing else. Flat rather than backed off, on the
      // same reasoning {@link REOPEN_COOLDOWN_MS} gives: a pipe being recreated is meant to
      // be picked up promptly, and the cost of asking is two syscalls.
      this.scheduleReopen(REOPEN_COOLDOWN_MS);
    } finally {
      // Released once the real stream holds a descriptor of its own - or, on the
      // {@link OPEN_WAIT_MS} path, once this sink has stopped waiting to find out.
      //
      // That second case is not the clean handover the first is: the open may still be in
      // flight, so the probe can be the last writer to let go while a descriptor is yet to
      // arrive. It is reached only when the reader hung up between the probe and the open -
      // with a reader present the open completes at once - so there is normally nobody left
      // to hand an EOF to, and a *new* reader attaching inside that window is the narrow
      // case this does not cover. Holding the probe until the open settles instead would
      // trade that for a descriptor pinned to an open that may never settle at all, which
      // is the shape of the bug this whole path exists to remove.
      await closeProbe();
    }
  }

  /**
   * Report a failed open, once per distinct failure per outage rather than once per
   * attempt.
   *
   * See {@link reportedOpenFailures}. The retry behind every failed open is what makes this
   * necessary: without it a path that is never coming back is a callback a second, forever,
   * from a sink whose whole job on this path is to wait quietly and keep trying.
   */
  private reportOpenFailure(
    kind: SinkFailureKind,
    message: string,
    cause: unknown,
  ): void {
    // Keyed on the kind as well as the text. The two are not redundant: both callers here
    // build the same `Could not open named pipe at <path>: ` prefix, so two failures that
    // rendered alike would otherwise be one - and the second would be swallowed while
    // carrying a *different* kind, which is the one thing a consumer switching on `kind`
    // cannot afford to miss.
    const key = `${kind}\u0000${message}`;

    // Already said this outage. Not "already said last time": see
    // {@link reportedOpenFailures} for why a path that flaps between two states must not
    // report on every transition.
    if (this.reportedOpenFailures.has(key)) {
      return;
    }

    if (this.reportedOpenFailures.size >= MAX_REPORTED_OPEN_FAILURES) {
      if (!this.reportedOpenFailureCap) {
        this.reportedOpenFailureCap = true;

        this.handleError(
          'setup',
          new Error(
            `Reported ${String(MAX_REPORTED_OPEN_FAILURES)} distinct failures opening the named pipe at ${this.pipePath}; further ones are not reported until it opens`,
          ),
        );
      }

      return;
    }

    this.reportedOpenFailures.add(key);

    this.handleError(kind, new Error(message, { cause }));
  }

  /**
   * Ask whether the FIFO has a reader, without waiting for one.
   *
   * The open costs a syscall that returns immediately in both directions, which is the
   * entire point: the blocking open this stands in front of cannot be cancelled once it is
   * in flight, so the sink asks a question it can get out of before asking one it cannot.
   * See {@link NO_READER_ERRNO} for why one `errno` covers both supported platforms.
   *
   * @returns An open descriptor, which the caller **must** keep open until the real stream
   *          has one of its own and then close - see `openPipe`, where the overlap is what
   *          keeps the reader from seeing EOF - or `null` when nothing is reading the pipe.
   */
  private async openWriteProbe(): Promise<FileHandle | null> {
    try {
      return await fsPromises.open(
        this.pipePath,
        fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
      );
    } catch (error) {
      if (readUnknownMember(error, 'code') === NO_READER_ERRNO) {
        return null;
      }

      // Anything else is a real failure to open, and the caller decides what to call it -
      // see `openPipe`, which reports it as `'setup'` and schedules another attempt. Read
      // through `readUnknownMember` because `code` is a property on somebody else's value
      // and this is a reporting path.
      throw error;
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

      // And said out loud, once. The drain loop in `close()` pushes the backlog into the
      // stream's buffer and sets `closed` without awaiting the write callbacks, so every
      // callback that errors afterwards lands here - reported by the caller as
      // `disposition: 'retrying'` while this made it final. An `onError` consumer whose
      // job is to fall back to another destination on `'lost'` was told the opposite of
      // what happened, and `abandonQueueOnClose()` had already run against an empty queue,
      // so nothing else was going to tell it. Once per close, like the cap's report and
      // that one: a close abandoning a full stream buffer would otherwise fire the
      // callback for every entry in it.
      if (!this.didReportPostCloseLoss) {
        this.didReportPostCloseLoss = true;

        this.handleError(
          'close',
          new Error(
            `Write to ${this.pipePath} failed after the sink was closed; the entry was not written`,
          ),
          { disposition: 'lost' },
        );
      }

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
   * One timer at a time, `unref`'d, so a sink waiting to recover never stacks attempts and
   * never holds the process open.
   *
   * Every way an open can fail arms this, which is what makes recovery independent of
   * traffic: no reader on the FIFO, the open itself refused, the `stat` finding nothing
   * there, the path there but not a FIFO. The alternative is what the sink used to do for
   * three of those four - wait for the next `write()` to ask - and that is only a retry
   * policy for a process that is still logging. A pipe recreated, a reader restarted, or a
   * permission fixed during a quiet minute would otherwise be picked up whenever traffic
   * happened to resume, or never.
   *
   * One standing exception, and it is deliberate: an open still in flight. Past
   * {@link MAX_ABANDONED_OPENS}, `ensureConnection` returns at its in-flight guard and
   * nothing here re-arms, because the sink has said out loud that it has stopped trying
   * rather than starve the process of I/O threads. Recovery there waits on one of those
   * opens returning, or on the next `write()`.
   *
   * Throttled rather than unthrottled, by two things at once: this holds a single timer, and
   * `ensureConnection` applies {@link REOPEN_COOLDOWN_MS} again when it fires. So a pipe
   * that is gone for good costs one `stat` and at most one non-blocking `open` per second,
   * indefinitely, and nothing else. Flat rather than backed off on purpose - the point of a
   * one-second cooldown is that a reader coming back is noticed promptly, and backing off
   * to save two syscalls would trade that away.
   *
   * Failures that are not about opening keep their own shape: a write that failed schedules
   * from its own handler, once, for the thing that actually happened.
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

    // Before the stream check, not after it, because this entry has no line to write and
    // the pipe's state cannot change that. Checked second, an unrenderable entry logged
    // during an outage was requeued instead of reported, and once its retries ran out
    // `requeue` dropped it on `droppedEntries` with no `onError` call at all - a silent
    // loss for the one failure this sink promises is never retried and always reported as
    // `'format'`/`'lost'`.
    //
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

    if (!this.pipeStream || this.pipeStream.destroyed) {
      // Back on the queue rather than skipped. This is reached from `processQueue`, where
      // the stream can go away between one entry and the next, and an entry dropped here
      // is one the caller asked to log and will never see.
      this.requeue(queued);

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
        // Guarded against the report re-entering the throw that produced it. An `onError`
        // that logs through this same logger is the shape `close()`'s abandoned-queue
        // report is documented safe for, and it reaches `write()` again - which renders
        // again, runs the same throwing `formatter` again, and reports again, without
        // bound. The queue short-circuit that stops the no-pipe path does not help here:
        // the render happens before anything is queued.
        if (!this.isReportingFormatFailure) {
          this.isReportingFormatFailure = true;

          try {
            this.handleError('format', error, { disposition: 'fallback' });
          } finally {
            this.isReportingFormatFailure = false;
          }
        }
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
