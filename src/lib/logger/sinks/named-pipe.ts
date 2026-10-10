import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import * as os from 'os';
import type { LogEntry, LogSink, LoggerDiagnostic } from '../types';
import { LogLevel, getLogLevel } from '../types';
import { diagnosticEntry } from '../internal/diagnostic-entry';
import { isDiagnosticEntry } from '../internal/sink-failure-routing';
import { describeError, toError } from '../../to-error';
import { renderOnce, type RenderedLine } from './internal/rendered-line';
import { renderJSONLine } from './internal/render-json-line';
import { renderTextEntry } from './internal/render-text-line';
import { isConsoleReportActive } from '../../internal/report-to-console';
import { adoptResult, UnreadableReturn } from '../../internal/adopt-promise';
import { readUnknownMember } from '../../internal/read-member';
import { observeRejection } from '../../internal/promise-reactions';
import {
  DEFAULT_CLOSE_TIMEOUT_MS,
  MIN_CLOSE_FLUSH_MS,
  resolveMaxQueueSize,
  resolveMaxRetries,
} from './internal/queue-policy';
import { resolveTimeoutMS } from '../../internal/timer-limits';
import {
  reportSinkError,
  type SinkErrorHandler,
  type SinkFailureDisposition,
  type SinkFailureKind,
} from './internal/sink-failure';
import { describeEntryCount, describeWriteCount } from './internal/loss-ledger';
import { endStreamWithin } from './internal/end-stream';
import { FormatReportScheduler } from './internal/format-report-scheduler';
import { NonBlockingPipeStream } from './internal/non-blocking-pipe-stream';
import type { OutageReporter } from './internal/outage-reporter';
import { openRetryBackoff } from './internal/reopen-backoff';
import {
  DeliveryEngine,
  type DeliverySlot,
  type FlushResult,
  type OpenResult,
  type QueueingSinkHealth,
  type ReopenStatus,
  type WriteOutcome,
} from './internal/delivery-engine';

export type {
  SinkErrorHandler,
  SinkFailure,
  SinkFailureDisposition,
  SinkFailureKind,
} from './internal/sink-failure';
export type { FlushResult } from './internal/delivery-engine';

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
  /**
   * Close budget in ms (default: 30000). Null or undefined uses the default.
   * NaN/other non-numbers throw TypeError; negatives throw RangeError.
   * Zero retains the final-flush minimum; Infinity is timer-capped.
   */
  closeTimeoutMS?: number | null;
  /**
   * Notified when this sink cannot do its job, in the shape every sink reports.
   * Explicit handlers take precedence. With no handler, failures go to owning
   * loggers, or to guarded console output when this sink has no owner. Failures
   * while writing diagnostic entries go directly to the console.
   *
   * One object rather than three positional arguments, and the same one `FileSink` hands
   * back: `kind` says what failed - `'write'` means a line is at risk, `'format'` means
   * your `formatter` threw or returned a promise or other non-string and the default
   * format went out in its place - `target` is the pipe path, and `attempt` / `disposition` say which try this
   * was and what became of the line.
   *
   * `entry` is set on a failure tied to a line - a write that failed, a render that
   * threw, the oldest line dropped at the cap or abandoned at close - exactly as
   * `FileSink` sets it, so one handler can fall back on `disposition: 'lost'` for either
   * sink. See {@link SinkFailure}. The queue is bounded by `maxQueueSize`, which is what
   * bounds how much of the caller's params a stalled pipe can hold.
   */
  onError?: SinkErrorHandler;
  formatter?: (entry: LogEntry) => string;
  /**
   * Cap on entries held - queued, or handed to the pipe and not yet confirmed. Defaults to
   * 10,000; pass `-1` to hold everything with no cap.
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
  maxQueueSize?: number | null;
  /**
   * Attempts a failed write gets before the entry is given up on. Defaults to 3, matching
   * `FileSink`; `0` writes once and never retries.
   *
   * A pipe write fails for the same reasons a file write does - the far end went away,
   * the stream was torn down - and the entry is no more lost in one case than the other.
   * It is re-queued and goes out when the pipe is next usable, rather than being dropped
   * where it stood.
   */
  maxRetries?: number | null;
}

/**
 * What a `NamedPipeSink` will tell you about itself: the shape `FileSink.getHealth()`
 * returns, so a consumer can watch both queueing sinks the same way. See
 * {@link QueueingSinkHealth}.
 */
export type NamedPipeSinkHealth = QueueingSinkHealth;

/** What `reconnect()` answers. See {@link ReopenStatus}. */
export type ReconnectStatus = ReopenStatus;

/**
 * The `errno` an `O_NONBLOCK` open for writing gives when the FIFO has no reader.
 *
 * POSIX is explicit about this one, and it is the whole reason the probe in `initializePipe`
 * works: `open()` with `O_WRONLY | O_NONBLOCK` on a FIFO "shall return -1 and set errno to
 * `[ENXIO]`" when no process has that FIFO open for reading. Linux and macOS - the only
 * two platforms this sink runs on at all - both implement it as written, so there is no
 * per-platform branch here. Anything else that comes back is a real open failure and is
 * reported as one.
 */
const NO_READER_ERRNO = 'ENXIO';

/**
 * Which failure kind an open that threw should be reported as.
 *
 * `'not_found'` is a claim about the destination - that it is not there - and only
 * `ENOENT` supports it. Anything else that stops an open is a `'setup'` failure: the
 * destination may well exist and could not be opened.
 */
function openFailureKind(error: unknown): SinkFailureKind {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;

  return code === 'ENOENT' ? 'not_found' : 'setup';
}

/**
 * NamedPipeSink writes logs to a named pipe (FIFO)
 * Only supported on Linux and macOS
 *
 * The queue, retries, reopening, reporting and close belong to a {@link DeliveryEngine};
 * this class is the pipe: options, rendering, and the pipe adapter - opening the FIFO
 * without blocking, writing to it, and pairing a failed write's two reports.
 */
export class NamedPipeSink implements LogSink {
  private pipePath: string;
  private jsonFormat: boolean;
  private onError?: SinkErrorHandler;
  private formatter?: (entry: LogEntry) => string;
  private pipeStream?: NonBlockingPipeStream;
  private minLevel: LogLevel;
  private readonly closeTimeoutMS: number;
  /**
   * The queue and everything that happens to a line after it is rendered. See
   * {@link DeliveryEngine}.
   */
  private readonly engine: DeliveryEngine;
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
  private readonly failedWriteStreams = new WeakSet<object>();
  private readonly diagnosticFailedStreams = new WeakSet<object>();
  private readonly consoleFailedStreams = new WeakSet<object>();

  /**
   * The `'format'` reports in flight, so a report cannot re-enter the failure that raised
   * it. See the guard in {@link formatEntry}, and {@link FormatReportScheduler} for what
   * is delivered to the handler, what waits, and what goes to the console instead. A
   * nested format failure is not lost output: the line still renders through the default
   * format and still goes out.
   */
  private readonly formatReports = new FormatReportScheduler();

  constructor(options: NamedPipeSinkOptions) {
    this.closeTimeoutMS = resolveTimeoutMS(
      options.closeTimeoutMS,
      DEFAULT_CLOSE_TIMEOUT_MS,
      'NamedPipeSink closeTimeoutMS',
    );

    this.pipePath = options.pipePath;
    this.jsonFormat = options.jsonFormat ?? false;
    this.onError = options.onError;
    this.formatter = options.formatter;
    const maxQueueSize = resolveMaxQueueSize(
      options.maxQueueSize,
      'NamedPipeSink maxQueueSize',
    );
    const maxRetries = resolveMaxRetries(
      options.maxRetries,
      'NamedPipeSink maxRetries',
    );
    this.minLevel = options.minLevel ?? LogLevel.INFO;

    this.engine = new DeliveryEngine({
      adapter: {
        label: 'NamedPipeSink',
        // Bounded by the stream's backpressure, not by a count.
        maxInFlight: Infinity,
        target: () => this.pipePath,
        open: (context) =>
          this.initializePipe(
            context.isDiagnosticRetry,
            context.shouldSuppressRetryReport,
            context.isExplicit,
          ),
        isUsable: () => this.isStreamUsable(),
        hasConnection: () => this.hasLiveStream(),
        write: (slot, _context, done, onCommitted) =>
          this.writeEntry(slot, done, onCommitted),
        onDrain: (resume) => this.awaitDrain(resume),
        checkReopen: () => this.refuseReconnect(),
        release: () => this.releaseStream(),
        end: (timeoutMS) => this.endStreamOnClose(timeoutMS),
      },
      maxQueueSize,
      maxRetries,
      closeTimeoutMS: this.closeTimeoutMS,
      // A reopen is a `stat` plus an `open`, and a dead pipe is exactly when the
      // application is logging hardest, so only this timer asks: the first attempt of an
      // outage at once, then 1 s doubling to 5 s. See `OPEN_RETRY_BACKOFF`.
      backoff: openRetryBackoff(),
      messages: {
        queueFull: (limit) =>
          `Pipe queue is full (maxQueueSize=${limit}); dropping the oldest entries`,
        abandoned: (count) =>
          `Closed with ${describeEntryCount(count)} still queued for ${this.pipePath}; they were not written`,
        refusedAfterClose: () =>
          `Entry logged after close() began for ${this.pipePath}; it was not written, and further ones are counted in droppedEntries without being reported`,
        unconfirmed: (attempts) =>
          `Write to ${this.pipePath} was never confirmed by a stream since replaced, after ${String(attempts)} attempts; the entry was given up on and may not have been written`,
        outageCap: (maxReports) =>
          `Reported ${String(maxReports)} distinct failures opening the named pipe at ${this.pipePath}; further ones are not reported until it opens`,
        reopenFailed: () => 'Failed to initialize pipe connection',
        inFlightUnknown: (count) =>
          `Closed with ${describeWriteCount(count)} in flight to ${this.pipePath}; whether the reader took them is unknown`,
        lostAtClose: (count, bytesLeft) =>
          `Closed with ${describeWriteCount(count)} failing as ${this.pipePath} was closed (${String(bytesLeft)} bytes still buffered); they were not written`,
      },
      report: (failure, routing) =>
        // The shared rung, so this channel cannot drift from the logger's four. Nothing
        // here may escape: reports run from a Node stream `'error'` handler, where a throw
        // is an uncaught exception that ends the process, and from open attempts nothing
        // awaits. The console rung is guarded for the same reason - `console.error` can
        // throw synchronously, and a pipe sink fails at exactly the shutdown-time moments
        // a console is most likely to be replaced or torn down.
        reportSinkError(
          this,
          failure,
          this.onError,
          () => this.describeFailure(failure.kind, failure.error),
          {
            label: 'NamedPipeSink',
            isDiagnostic: routing.isDiagnostic,
            onSettled: routing.onSettled,
          },
        ),
      hasHandler: () => this.onError !== undefined,
    });

    // Nothing observes the attempt until `close()` races it or `reconnect()` awaits it;
    // the engine contains it, so neither has to.
    this.engine.start();
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

    if (this.engine.isClosing) {
      // Counted and said, not discarded quietly: `close()` waits up to `closeTimeoutMS`
      // for the queue to drain, and a line logged in that window is one this sink did not
      // deliver.
      this.engine.refuseAfterClose(entry);

      return;
    }

    // Before the render, so a report the render makes cannot change what this line is.
    const shouldSuppressFailureReport = isConsoleReportActive();
    // Rendered now rather than at flush time, so the line is fixed while `write` still
    // holds the caller's stack.
    //
    // `entry.redactedParams` is not a snapshot - it is the caller's own bag, or shares
    // every subtree that held nothing redacted - so serializing it after an outage writes
    // whatever the caller has done to it since, including a secret added under a key that
    // was named in `redactedKeys`.
    const rendered = this.renderEntry(entry);

    // Reported here rather than queued. A render is attempted exactly once on purpose, so
    // waiting for a pipe cannot make this line appear - and queueing it meant an
    // unrenderable entry logged during an outage was reported only if the pipe came back:
    // with the reader still gone it sat in the queue until its retries ran out and was
    // counted in `droppedEntries` with no `onError` call, or until `close()` called it a
    // `'close'` failure. Either way the caller lost the `'format'` diagnosis their own
    // formatter had earned.
    if (rendered.formatError !== undefined) {
      this.reportUnrenderable(entry, rendered.formatError);

      return;
    }

    // Queued whenever there is nowhere to put it *yet* - before the first open, and after
    // a failure took the stream away - and written at once when there is.
    //
    // Held rather than dropped, which is the whole of what changed here once. A pipe
    // failure used to end the sink: the stream `'error'` handler cleared `pipeStream` and
    // left the sink looking initialized, so every later entry fell through a silent early
    // return - uncounted, unreported, and not recoverable by the `reconnect()` the class
    // documents, since there was nothing left to flush. `FileSink` answers the identical
    // failure by queueing, retrying and reopening; there was never a reason for the two to
    // differ.
    this.engine.enqueue({
      line: rendered.formatted ?? '',
      entry,
      shouldSuppressFailureReport,
    });
  }

  /**
   * Set the minimum log level for this sink
   */
  public setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  public writeDiagnostic(diagnostic: LoggerDiagnostic): void {
    this.write(diagnosticEntry(diagnostic));
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
    return this.engine.getHealth();
  }

  /**
   * Attempt to reconnect to the named pipe.
   * Useful when the pipe reader restarts or after a temporary error.
   * Queued writes during the outage will be flushed on successful reconnection.
   *
   * Refused while closing, and while the current stream still holds writes for the reader
   * (see {@link refuseReconnect}). Waits for an open already in flight rather than racing
   * it. A failed reconnect reports its failure through `onError` every time: the
   * deduplication that keeps an automatic retry from calling it every few seconds is
   * deliberately not applied to an attempt the caller asked for by name.
   */
  public async reconnect(): Promise<ReconnectStatus> {
    return await this.engine.reopenNow();
  }

  /**
   * Wait for every queued line to be written, and say what happened since the last flush.
   *
   * Resolves when the queue is empty; while the pipe is not open, once an attempt to open
   * it made after this call has failed - a pipe with no reader fails at once - or at once
   * when the next attempt falls after the deadline (`success: false`, `timedOut: false`,
   * the lines still queued in `entriesQueued`); or at the deadline (`timedOut: true`).
   * Successive flushes partition what was written and lost between them.
   *
   * @param requestedTimeoutMS Maximum time to wait in milliseconds (default: 30000ms /
   *        30s). Null or undefined uses the default. Invalid values reject before a
   *        flush starts: `NaN` and other non-numbers produce TypeError; negative
   *        values produce RangeError. `Infinity` is capped
   *        at the largest timer delay; zero keeps its immediate deadline semantics.
   */
  public async flush(
    requestedTimeoutMS: number | null = DEFAULT_CLOSE_TIMEOUT_MS,
  ): Promise<FlushResult> {
    // Read before validating, so the whole call is inside its own budget.
    const startTime = Date.now();
    // Validated before joining the flush queue or advancing any counting window.
    const timeoutMS = resolveTimeoutMS(
      requestedTimeoutMS,
      DEFAULT_CLOSE_TIMEOUT_MS,
      'NamedPipeSink flush timeoutMS',
    );

    return await this.engine.flush(timeoutMS, startTime);
  }

  public close(): Promise<void> {
    return this.engine.close();
  }

  /** The most recent open attempt, settled. Never rejects. */
  private get initPromise(): Promise<void> {
    return this.engine.openSettled;
  }

  /**
   * The open failures reported during this outage. See
   * {@link DeliveryEngine.outages}; kept here under its old name as a seam.
   */
  private get reportedOpenFailures(): OutageReporter {
    return this.engine.outages;
  }

  /**
   * Whether this sink currently holds a stream it can still write through.
   *
   * The test `close()` makes: a `WriteStream` marks itself `destroyed` synchronously on a
   * failed write while `pipeStream` is cleared only when the `'error'` event lands, so
   * "set" and "usable" are not the same question.
   */
  private hasLiveStream(): boolean {
    return this.pipeStream !== undefined && !this.pipeStream.destroyed;
  }

  /**
   * Whether a line handed over now can be written: a live stream that no write has failed
   * on yet. A failed write callback precedes the stream's error event and its automatic
   * destruction, so the stream is marked failed there and nothing more goes to it.
   */
  private isStreamUsable(): boolean {
    return (
      this.pipeStream !== undefined &&
      !this.pipeStream.destroyed &&
      !this.failedWriteStreams.has(this.pipeStream)
    );
  }

  /**
   * Hold the queue until the stream asks for more. The stream may have been replaced
   * while this was pending, in which case its successor decides when to drain and this
   * one's `'drain'` means nothing.
   */
  private awaitDrain(resume: () => void): boolean {
    const stream = this.pipeStream;

    if (stream === undefined) {
      return false;
    }

    stream.once('drain', () => {
      if (this.pipeStream !== stream) {
        return;
      }

      resume();
    });

    return true;
  }

  /**
   * Why `reconnect()` must not replace the stream right now, if it must not.
   *
   * Let pending writes finish before replacing the stream. Destroying it does not cancel
   * an in-flight FIFO write, so a replacement writer could interleave records with it.
   * Keep this connection intact; reconnect can be retried once the reader has drained the
   * pending writes. Calling close() is not required.
   */
  private refuseReconnect(): Error | undefined {
    if (
      this.pipeStream &&
      !this.pipeStream.destroyed &&
      !this.pipeStream.errored &&
      this.pipeStream.writableLength > 0
    ) {
      return new Error(
        'Cannot reconnect until pending pipe writes finish; retry after the reader drains them',
      );
    }

    return undefined;
  }

  /**
   * Let go of the existing stream, bounded. {@link refuseReconnect} has already refused a
   * live stream with buffered writes, so what reaches here holds nothing, or has failed.
   * `end()` alone could still leave the descriptor pinned if `'finish'` never fired, so
   * {@link abandonStream} flushes it if it can and destroys it if it cannot.
   *
   * The reference is dropped whether or not the stream was worth flushing, and only the
   * flush is gated on `destroyed`. A `WriteStream` sets `destroyed` synchronously on a
   * failed write while `pipeStream` is cleared only from the asynchronous `'error'`
   * handler, so a `reconnect()` entered in that window - the ordinary shape, an `onError`
   * handler reconnecting - would otherwise leave the dead stream installed, and its
   * deferred `'error'` would read itself as current and tear down the replacement.
   */
  private releaseStream(): void {
    if (this.pipeStream) {
      if (!this.pipeStream.destroyed) {
        this.abandonStream(this.pipeStream);
      }

      this.pipeStream = undefined;
    }
  }

  /**
   * Let go of a stream this sink will not write to again, without leaking its descriptor.
   *
   * `end()` first, so anything still buffered reaches a reader that is consuming, then
   * `destroy()` after {@link MIN_CLOSE_FLUSH_MS} for the one that is not - `end()`'s
   * callback cannot fire on a FIFO that cannot flush, and the caller does not wait for it.
   * The timer is unreferenced: this must not be a reason the process stays alive.
   */
  private abandonStream(stream: NonBlockingPipeStream): void {
    void endStreamWithin(stream, MIN_CLOSE_FLUSH_MS, { shouldUnref: true });
  }

  /**
   * End the stream for `close()`, within what is left of the close's budget: the engine's
   * `end`.
   *
   * What is left of the *whole* close's budget, not a fresh one, so the open wait, the
   * drain and this flush share one deadline. Bounded and floored as `endStreamWithin`
   * describes: `end()` flushes before it calls back, and a FIFO with no reader cannot
   * flush. Held open by its timer, since the caller is awaiting this close and the
   * stream's own retries keep nothing alive: unreferenced, a stalled reader let the
   * process exit before the engine's report of the writes it failed went out.
   *
   * Resolves with the bytes the stream still held, which that report names. A throw from
   * `end()` is said here, since nothing else knows of it.
   */
  private async endStreamOnClose(timeoutMS: number): Promise<number> {
    if (!this.pipeStream || this.pipeStream.destroyed) {
      return 0;
    }

    const stream = this.pipeStream;

    const bytesLeft = await endStreamWithin(stream, timeoutMS, {
      shouldUnref: false,
      onEndError: (error) => {
        this.engine.report('close', error);
      },
    });

    this.pipeStream = undefined;

    return bytesLeft;
  }

  /**
   * Open the pipe: the engine's `open`, routed by where the request came from and what is
   * queued (see {@link DeliveryEngine.openRouting}).
   *
   * `shouldReportNoReader` is an explicit `reconnect()`: the one attempt that reports a
   * pipe with no reader, and whose failure is owed to `onError` whatever is queued.
   */
  private async initializePipe(
    isDiagnosticRetry = false,
    shouldSuppressRetryReport = false,
    shouldReportNoReader = false,
  ): Promise<OpenResult> {
    const routing = this.engine.openRouting({
      isDiagnosticRetry,
      shouldSuppressRetryReport,
      isExplicit: shouldReportNoReader,
    });
    // Reported once per distinct failure per outage rather than once per attempt; see
    // {@link DeliveryEngine.outages}. This closure retains the attempt's routing through
    // awaits.
    const reportOpenFailure = (
      kind: SinkFailureKind,
      message: string,
      cause: unknown,
    ): void => {
      this.engine.reportOpenFailure(
        kind,
        message,
        cause,
        routing.isDiagnostic,
        routing.shouldSuppressFailureReport,
      );
    };
    const unavailable: OpenResult = { status: 'unavailable' };
    // Check platform support
    const platform = os.platform();
    if (platform !== 'linux' && platform !== 'darwin') {
      // Through the dedup every other open failure goes through. Called directly, this one
      // bypassed it, so every reopen attempt called the caller's `onError` again, forever -
      // the flood {@link reportedOpenFailures} exists to prevent, on the one failure that
      // is certain never to clear: the platform is what it is for the life of the process.
      reportOpenFailure(
        'unsupported_platform',
        `Named pipes are only supported on Linux and macOS, current platform: ${platform}`,
        undefined,
      );

      return unavailable;
    }

    /**
     * The probe descriptor, held until the real stream has one of its own.
     *
     * Declared out here so the `finally` below can release it on every exit from the `try`
     * - the `not_a_pipe` and no-reader returns, the success, and the failures the `catch`
     * reports. The unsupported-platform return above is the one exit it does not cover,
     * and does not need to: it happens before there is a probe to release.
     */
    let probe: number | undefined;

    const closeProbe = async (): Promise<void> => {
      if (probe === undefined) {
        return;
      }

      const descriptor = probe;

      probe = undefined;

      await new Promise<void>((resolve) => {
        fs.close(descriptor, () => resolve());
      });
    };

    // Every way an open can fail answers `unavailable`, and the engine arms the next
    // attempt behind each one - which is what makes recovery independent of traffic: no
    // reader on the FIFO, the open itself refused, the `stat` finding nothing there, the
    // path there but not a FIFO. The alternative is what the sink used to do for three of
    // those four - wait for the next `write()` to ask - and that is only a retry policy
    // for a process that is still logging. A pipe recreated, a reader restarted, or a
    // permission fixed during a quiet minute would otherwise be picked up whenever traffic
    // happened to resume, or never.
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
        reportOpenFailure(
          'not_a_pipe',
          `${this.pipePath} exists but is not a named pipe (FIFO)`,
          undefined,
        );

        return unavailable;
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
        //
        // And retried, because moving this failure off the stream's `'error'` handler took
        // a retry away: reported from here with nothing behind it, it would have gone
        // silent until some later `write()` happened along - and a permission fixed, or
        // descriptor pressure relieved, a minute later is exactly the kind of thing a quiet
        // process never notices.
        reportOpenFailure(
          'setup',
          `Could not open named pipe at ${this.pipePath}: ${describeError(error)}`,
          error,
        );

        return unavailable;
      }

      if (probe === undefined) {
        if (shouldReportNoReader) {
          reportOpenFailure(
            'setup',
            `No reader is connected to named pipe at ${this.pipePath}`,
            undefined,
          );
        }
        // Automatic probes stay quiet: a pipe waiting for its reader is where this
        // sink starts. Only the explicit reconnect above reports this result;
        // reporting every timer attempt would fire every few seconds while a reader is late.
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
        // So: keep asking. The engine holds one unref'd timer at a time and spaces
        // attempts, backing off to one `stat` and one non-blocking `open` every five
        // seconds for as long as the pipe has no reader. That is a real cost where the
        // blocked open had none, and it is the right side of the trade: the
        // blocked open's price was a libuv threadpool thread and a process that would not
        // exit.
        return unavailable;
      }

      // Turn the descriptor that answered the non-blocking probe into the stream itself.
      // There is no second `open(2)` here: besides avoiding a gap in which the reader can
      // observe EOF, this removes the probe-to-open race where the reader disappeared and
      // the second, blocking open remained pinned in libuv after `close()` resolved.
      // Asked again because both answers above came from an await. `close()` bounds its
      // own drain and cleanup, so an attempt started before it can resume after shutdown
      // has finished. The descriptor is cancellable now, but installing it after `closed`
      // would still leak ownership into a sink that can never write again.
      //
      // `closed`, not `closing`: while a close is merely draining it is parked on the
      // attempt in flight, which is this one. Refusing during that phase would guarantee
      // the drain never receives the stream it is waiting for.
      if (this.engine.isClosed) {
        return unavailable;
      }

      // Describe the descriptor, not the path checked before the open. A path can be
      // replaced between `stat` and `open`; the descriptor is what subsequent writes use.
      let isProbeFIFO = false;

      try {
        isProbeFIFO = fs.fstatSync(probe).isFIFO();
      } catch {
        // A descriptor that cannot be described is not trusted with log output.
      }

      if (!isProbeFIFO) {
        reportOpenFailure(
          'not_a_pipe',
          `${this.pipePath} was not a named pipe (FIFO) when opened`,
          undefined,
        );

        return unavailable;
      }

      const stream = new NonBlockingPipeStream(probe);

      // Ownership moved to the stream. The `finally` block must not close the same fd.
      probe = undefined;

      stream.on('error', (err) => {
        this.handleStreamError(stream, err);
      });

      // The writable built over an already-open numeric descriptor emits no `open` event,
      // and the descriptor has already passed the probe and the FIFO check above, so it is
      // promoted now. The engine takes it from here: connected, the outage forgotten, the
      // queue drained.
      this.pipeStream = stream;

      return { status: 'open' };
    } catch (error) {
      // Classified rather than assumed. This block is reached by the `stat` failing and
      // by a synchronous stream-construction failure, and only `ENOENT` means what
      // `'not_found'` says - "the destination does not exist". `EACCES`, `ELOOP` and
      // `ENOTDIR` all arrive here too, and a handler switching on `kind` to decide whether
      // to recreate the FIFO acted on a false premise for every one of them. `'setup'` is
      // the kind the probe path above already chose for exactly these.
      //
      // Retried like every other failure: this is the `stat` failing - the FIFO deleted,
      // or not created yet - and it was once the one failure with no timer behind it at
      // all, so a `rm pipe; mkfifo pipe` during a quiet minute was picked up whenever
      // traffic happened to resume. On the same backoff as every other failure, capped at
      // five seconds: a pipe being recreated is meant to be picked up promptly, and the
      // cost of asking is two syscalls.
      reportOpenFailure(
        openFailureKind(error),
        `Could not open named pipe at ${this.pipePath}: ${describeError(error)}`,
        error,
      );

      return unavailable;
    } finally {
      // Released on every path that did not transfer the numeric descriptor to the active
      // writable.
      await closeProbe();
    }
  }

  /**
   * A stream this sink opened reported an error.
   *
   * Reported unless its write callback already said it (see {@link suppressedWriteErrors}),
   * and - when it is the stream in hand - the end of that connection, which the engine
   * recovers from.
   */
  private handleStreamError(stream: NonBlockingPipeStream, err: Error): void {
    const isDiagnosticFailure = this.diagnosticFailedStreams.has(stream);
    const shouldSuppressStreamFailure = this.consoleFailedStreams.has(stream);
    this.diagnosticFailedStreams.delete(stream);
    this.consoleFailedStreams.delete(stream);
    // `close()` has finished with the queue: a stream it ended failing as it was destroyed
    // has already been answered for, write by write, before `close()` resolved.
    if (this.engine.isClosed) {
      return;
    }
    // A stream this sink has already moved on from - ended by `reconnect()`, replaced
    // after a failure - can still deliver its error afterwards, and that error says
    // nothing about the connection now in hand. Reported, because it did happen, but it
    // changes no state and is not counted against the health of a stream that is working:
    // left ungated, an error arriving a tick after `reconnect()` succeeded marked the fresh
    // connection uninitialized and sent every later entry to the queue.
    const isCurrent = this.pipeStream === stream;

    // Already said, by the write callback that knew which line it was. Consumed only when
    // it matches: clearing on any error at all is what let an unrelated one - from a
    // stream this sink had already replaced - unsuppress the report that was waiting for
    // its own event.
    const wasReported =
      typeof err === 'object' &&
      err !== null &&
      this.suppressedWriteErrors.has(err);

    if (wasReported) {
      this.suppressedWriteErrors.delete(err);
    }

    // When it was reported, nothing further is recorded here: the write callback's own
    // report already set `lastError` and counted the failure. Counting it again made one
    // failed write read as two in `getHealth()` until a later success reset the tally.
    const report = (): void => {
      if (!wasReported) {
        this.engine.report('write', err, {
          countsAgainstHealth: isCurrent,
          isDiagnostic: isDiagnosticFailure,
          shouldSuppressFailureReport: shouldSuppressStreamFailure,
        });
      }
    };

    if (!isCurrent) {
      report();

      return;
    }

    this.pipeStream = undefined;

    // Disconnected as well as streamless, so `write` queues what comes next instead of
    // discarding it - leaving the sink looking ready with nowhere to write was what once
    // made a single pipe error terminal. And recovery starts here, because this is the
    // first moment it can: a failed write reports through its callback *before* the
    // stream emits `'error'`, so the retry that callback arranges asks for a reconnection
    // while this sink still looks connected - and is told there is nothing to do.
    this.engine.connectionLost(
      {
        isDiagnosticRetry: isDiagnosticFailure,
        shouldSuppressRetryReport: shouldSuppressStreamFailure,
      },
      report,
    );
  }

  /**
   * Ask whether the FIFO has a reader, without waiting for one.
   *
   * The open costs a syscall that returns immediately in both directions. On success the
   * returned descriptor is the connection itself, so no blocking open follows it. See
   * {@link NO_READER_ERRNO} for why one `errno` covers both supported platforms.
   *
   * @returns The open descriptor that becomes the write stream, or `null` when nothing is
   *          reading the pipe. Reusing it means there is no second pathname open.
   */
  private async openWriteProbe(): Promise<number | null> {
    return await new Promise<number | null>((resolve, reject) => {
      fs.open(
        this.pipePath,
        fs.constants.O_WRONLY | fs.constants.O_NONBLOCK,
        (error, descriptor) => {
          if (error === null) {
            resolve(descriptor);

            return;
          }

          if (readUnknownMember(error, 'code') === NO_READER_ERRNO) {
            resolve(null);

            return;
          }

          reject(error);
        },
      );
    });
  }

  /**
   * Write a single line: the engine's `write`.
   *
   * A `false` return says the stream's buffer is over its high-water mark, and the engine
   * holds later lines in its capped queue until `'drain'`.
   *
   * The *callback* is where a write is confirmed, and it is why this line is not considered
   * delivered yet. `write` returning is not success: a stream reports `EPIPE` and its kin
   * asynchronously, through this callback and an `'error'` event, so treating the
   * synchronous return as delivery meant the one entry that actually failed was the one
   * entry never retried - and the `'error'` handler has no idea which line it belonged to.
   * A throw from `write` is the engine's to handle.
   */
  private writeEntry(
    slot: DeliverySlot,
    done: (outcome: WriteOutcome) => void,
    onCommitted: () => void,
  ): boolean {
    if (!this.pipeStream || this.pipeStream.destroyed) {
      // Not attempted: the stream went away between the engine's check and this one, and
      // the line goes back to the engine rather than being skipped.
      done({ status: 'unavailable' });

      return true;
    }

    const stream = this.pipeStream;

    onCommitted();

    return stream.write(slot.line, (error) => {
      if (error) {
        // A write callback precedes the error event and automatic destruction.
        // Stop all drains now; the error event owns connection teardown/recovery.
        this.failedWriteStreams.add(stream);
        if (slot.shouldSuppressFailureReport) {
          this.consoleFailedStreams.add(stream);
        }
        if (isDiagnosticEntry(slot.entry)) {
          this.diagnosticFailedStreams.add(stream);
        }
        // Reported from here, by the engine, not left to the `'error'` event. Both describe
        // the same failure, but only this one knows *which line* it was and whether it is
        // coming back - the event reported `attempt: undefined` and a disposition of
        // `'no_entry'`, which reads as "nothing to retry" for a line the sink was about to
        // retry, so a handler writing a fallback copy duplicated it.
        //
        // The event is told to keep quiet about this particular error; it still does the
        // connection bookkeeping, which is the half it does know about. Remembered by
        // identity, so the `'error'` event carrying this same failure can recognize it. A
        // non-object is not trackable and is simply not suppressed: the event then reports
        // it, which is noisier than ideal but never silent.
        if (typeof error === 'object') {
          this.suppressedWriteErrors.add(error);
        }

        // Never replay a record whose prefix may already have been consumed.
        const wasPartiallyWritten = stream.consumePartialWriteFailure(error);

        done({ status: 'failed', error, isRetryable: !wasPartiallyWritten });

        return;
      }

      done({ status: 'written' });
    });
  }

  /**
   * Render one entry into the line to write, keeping a failure rather than retrying it.
   *
   * See {@link RenderedLine.formatError}: a render is attempted exactly once, while the
   * caller's stack is still held, whether the entry goes out now or waits for the pipe.
   */
  private renderEntry(entry: LogEntry): RenderedLine {
    return renderOnce(() => this.formatEntry(entry));
  }

  /**
   * Report an entry that could not be rendered at all.
   *
   * `'format'`, as `FileSink` reports the same failure, and never retried: the line is
   * rendered once, on purpose, so a second attempt could not come out differently. Counted,
   * like every other line this sink does not deliver. `disposition: 'lost'` and a
   * `droppedEntries` that never moved disagreed about the same entry: three failed renders
   * reported three `format`/`lost` callbacks while `getHealth()` still answered
   * `{ isHealthy: true, queueSize: 0, droppedEntries: 0 }`, so an operator polling health
   * saw a sink in perfect condition that had delivered nothing.
   */
  private reportUnrenderable(entry: LogEntry, formatError: Error): void {
    this.engine.countLoss('format');

    // The same guard `formatEntry` holds over a throwing `formatter`, for the half it did
    // not cover. That guard stops a formatter that throws from being reported without
    // bound, but a line that fails to render *without* a formatter - `jsonFormat` over a
    // `BigInt`, say - arrives here from `write()` on the caller's stack, and an `onError`
    // that logs through this sink re-entered `write()`, failed to render its own line for
    // the same reason, and reached this branch again: a synchronous recursion that ended in
    // a stack overflow. The nested line is counted above and reported on the console
    // rather than to the handler, which is where the chain stops.
    this.scheduleFormatReport(
      new Error('Failed to format a log entry; no line was written', {
        cause: toError(formatError),
      }),
      {
        attempt: 1,
        // No line was produced, and rendering is never repeated, so this one is gone.
        disposition: 'lost',
        entry,
      },
    );
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
        const custom: unknown = this.formatter(entry);

        if (typeof custom !== 'string') {
          this.refuseDeferredFormat(custom, entry);
          // Any other non-string is no more a line than a promise is: concatenated, it
          // wrote `undefined` (a formatter missing its `return`) or `[object Object]`
          // with nothing reported. Thrown into the catch below, so it is reported and
          // replaced by the default format exactly as a throwing formatter is. Named by
          // `typeof` alone, since stringifying the value would run its own code.
          throw new TypeError(
            `NamedPipeSink formatter returned ${custom === null ? 'null' : typeof custom}; it must return a string`,
          );
        }

        return custom + '\n';
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
        // Held until the handler settles, not until it returns: an `async` handler logs
        // after its first `await`, past a guard cleared on return. See
        // `FormatReportScheduler` for what a second report meanwhile does.
        this.scheduleFormatReport(
          new Error(
            'NamedPipeSink formatter failed; the default format was used',
            { cause: toError(error) },
          ),
          { disposition: 'fallback', entry },
        );
      }
    }

    let formatted: string;

    if (this.jsonFormat) {
      // The logger's own renderer over the redacted bag, not a second `JSON.stringify`:
      // see `renderJSONLine`. A value it cannot render becomes a marker and is reported
      // as `'format'`/`'fallback'` - the line is still written. Guarded like the
      // throwing-formatter report above, and for the same reason.
      formatted = renderJSONLine(entry, (error) => {
        this.scheduleFormatReport(
          new Error(
            'Failed to render a value in the log entry; a marker was written in its place',
            { cause: toError(error) },
          ),
          { disposition: 'fallback', entry },
        );
      });
    } else {
      formatted = renderTextEntry(entry);
    }

    return formatted + '\n';
  }

  /**
   * Throw if the formatter answered with a promise or other thenable.
   *
   * The formatter is called synchronously, so a promise is never a line: concatenated, it
   * wrote the text `[object Promise]` to the pipe, and a promise that rejected - an
   * `async` formatter that throws - had nothing observing it, which is an unhandled
   * rejection and fatal under Node's default `--unhandled-rejections=throw`.
   *
   * The throw lands in `formatEntry`'s `catch`, so this is treated exactly as a throwing
   * formatter is: the default format goes out and a `'format'`/`'fallback'` failure is
   * reported. The promise's rejection is observed and reported the same way when it
   * arrives, through the same re-entry guard. A value whose `then` cannot be read is
   * thrown with the read's own failure.
   *
   * Where that rejection goes is decided when the promise is born, not when it rejects -
   * the rule `ArraySink` applies to its transformer. A promise returned while a report is
   * being delivered came from a line that report wrote - an `onError` logging the failure
   * back through this sink - and handing its rejection to the handler fed it the next one:
   * the rejection arrived after the guard came down, started the next report, whose line
   * returned the next promise, one `onError` call per microtask without end. Born during a
   * handler's report, the rejection goes to the console instead; born during a console
   * report, it is dropped, as the immediate failure of that same nested line already was.
   * The line itself still went out in the default format either way.
   */
  private refuseDeferredFormat(custom: unknown, entry: LogEntry): void {
    const pending = adoptResult(custom);

    if (pending instanceof UnreadableReturn) {
      throw pending;
    }

    if (pending !== undefined) {
      const wasBornDuringConsoleReport =
        this.formatReports.isConsoleReportActive || isConsoleReportActive();
      const wasBornDuringReport = this.formatReports.isReportActive;

      observeRejection(pending, (error: unknown) => {
        if (wasBornDuringConsoleReport) {
          return;
        }

        const failure = new Error(
          'NamedPipeSink formatter returned a promise that rejected; the default format was used',
          { cause: toError(error) },
        );

        if (wasBornDuringReport) {
          this.formatReports.reportToConsole(() =>
            this.describeFailure('format', failure),
          );

          return;
        }

        this.scheduleFormatReport(failure, {
          disposition: 'fallback',
          entry,
        });
      });

      throw new TypeError(
        'NamedPipeSink formatter returned a promise; it is called synchronously and must return a string directly',
      );
    }
  }

  /**
   * Report a `'format'` failure through {@link formatReports}: to `onError` when the guard
   * allows, otherwise held or sent to the console. See {@link FormatReportScheduler}.
   */
  private scheduleFormatReport(
    failure: Error,
    options: {
      attempt?: number;
      disposition: SinkFailureDisposition;
      entry: LogEntry;
    },
  ): void {
    this.formatReports.schedule(
      (onReported) => {
        this.engine.report('format', failure, { ...options, onReported });
      },
      () => this.describeFailure('format', failure),
    );
  }

  /** The console line for a failure, the one a report falls back to. */
  private describeFailure(kind: SinkFailureKind, failure: Error): string {
    return `NamedPipeSink error (${kind}): ${describeError(failure)}`;
  }
}
