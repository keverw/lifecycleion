import type { LogEntry, LogSink } from '../../types';
import { reportThroughHandler } from '../../../internal/failure-reporter';
import {
  isConsoleReportActive,
  reportToConsole,
} from '../../../internal/report-to-console';
import { describeError } from '../../../to-error';
import { reportSinkFailure } from '../../internal/sink-failure-routing';

/**
 * What a sink reports when it cannot do its job, in one shape.
 *
 * The two queueing sinks described the same failures in two different vocabularies.
 * `FileSink` handed back `(error, entry, attempt, willRetry)` and no way to tell a
 * rotation failure from a failed write except by matching on message text; `NamedPipeSink`
 * handed back `(errorType, error, pipePath)` - a discriminator the file sink needed just
 * as much, and no retry context at all, though this sink retries now too. Neither half of
 * the difference was about pipes or files.
 *
 * So: one object, one callback shape, every field answering a question a consumer actually
 * asks - what failed, where, whether the line is lost, and whether it is coming back.
 */

/**
 * Which part of a sink's work failed.
 *
 * Open-ended by intent: a sink reports the kinds it can produce, and a consumer switching
 * on them should treat an unfamiliar kind as "something failed" rather than assuming the
 * set is closed.
 *
 * - `'write'` - a line could not be written. The one kind that means an entry is at risk.
 * - `'format'` - a line could not be formatted. `disposition` says what that cost:
 *   `'fallback'` when a custom `formatter` threw and the sink substituted its own default
 *   format, `'lost'` when no line could be produced at all. Never retried either way: a
 *   line is rendered once, on purpose, so a second attempt could not come out
 *   differently.
 * - `'close'` - shutting the destination down failed.
 * - `'setup'` - the destination could not be opened, created, or rotated.
 * - `'queue_full'` - entries were discarded to stay under `maxQueueSize`.
 * - `'not_found'` - the destination does not exist.
 * - `'not_a_pipe'` - the path exists but is not a FIFO.
 * - `'unsupported_platform'` - this sink cannot run here at all.
 */
export type SinkFailureKind =
  | 'write'
  | 'format'
  | 'close'
  | 'setup'
  | 'queue_full'
  | 'not_found'
  | 'not_a_pipe'
  | 'unsupported_platform';

/**
 * Why a line this sink did not deliver was lost, keyed as {@link SinkFailure.kind} names
 * the failure - so a count here and the `onError` calls that reported it use one word.
 *
 * - `'queue_full'` - evicted at `maxQueueSize` to make room.
 * - `'write'` - out of retries writing to a destination.
 * - `'format'` - could not be rendered, so there was never a line to write.
 * - `'close'` - refused or abandoned because `close()` had begun.
 *
 * A destination that cannot be opened loses no line by itself: lines wait in the queue
 * until it opens, and an outage shows up as `'queue_full'` or `'close'`.
 */
export type DroppedEntryKind = 'queue_full' | 'write' | 'format' | 'close';

/**
 * How many lines were lost to each reason. The counts always sum to `droppedEntries`; a
 * total alone said *that* lines were lost and left "why" to whoever kept the `onError`
 * calls, which is not the shape an operator polling health is in.
 */
export type DroppedEntryCounts = Record<DroppedEntryKind, number>;

/** A zeroed {@link DroppedEntryCounts}. */
export function createDroppedEntryCounts(): DroppedEntryCounts {
  return { queue_full: 0, write: 0, format: 0, close: 0 };
}

/** What became of the line a failure is about. See {@link SinkFailure.disposition}. */
export type SinkFailureDisposition =
  'retrying' | 'lost' | 'fallback' | 'no_entry';

/** One failure, as a sink reports it. */
export interface SinkFailure {
  /** Which part of the work failed. See {@link SinkFailureKind}. */
  kind: SinkFailureKind;
  /**
   * The failure itself, always an `Error`.
   *
   * Normalized by the sink, since what a stream or a caller's `formatter` throws is not
   * obliged to be one, and the original value travels on `cause`.
   */
  error: Error;
  /**
   * What the sink was writing to: the current log file, or the pipe path.
   *
   * The current one, which for a file sink is not a constant - rotation changes it, so a
   * failure names the file it actually happened to.
   */
  target: string;
  /**
   * The entry that failed, when the sink still has it.
   *
   * Absent for a failure that belongs to no particular entry - a failed rotation, a
   * reconnect that never came back. An aggregate queue loss carries an ordinary entry
   * when one was lost, otherwise the oldest diagnostic entry, as a sample rather than
   * every lost line. Both `FileSink` and `NamedPipeSink` keep
   * the entry queued alongside its rendered line and hand it over here, so a handler can
   * write a lost line somewhere else.
   */
  entry?: LogEntry;
  /** Which attempt this was, 1-based, for a failure that is tied to an entry. */
  attempt?: number;
  /**
   * What became of the line this failure is about: whether to write it somewhere else,
   * which retry intent alone cannot say.
   *
   * - `'retrying'` - the sink will try this line again. Do nothing; a fallback write here
   *   duplicates it.
   * - `'lost'` - the line will not arrive: out of retries, unrenderable, or dropped to
   *   stay under the queue cap. **This is the one that means write it somewhere else.**
   * - `'fallback'` - the sink substituted something of its own and carried on with the
   *   line: a custom `formatter` threw and the default format was used, or a param would
   *   not render and a marker stands in for it. Worth knowing, but the line is not lost
   *   *by this failure*.
   *
   *   Not a confirmation that the line was written: the substitution happens while it is
   *   still being rendered, before anything reaches the destination, and a line that is
   *   afterwards queued, evicted at the cap, or failed on is reported again on its own
   *   terms. Nothing to do here either way: `'lost'` is what asks for a fallback write.
   * - `'no_entry'` - the failure belongs to no particular line: a pipe that could not be
   *   opened, a rotation that failed, a close that did not complete.
   */
  disposition: SinkFailureDisposition;
}

/**
 * Notified when a sink cannot do its job.
 *
 * Never called for an ordinary success, and never called more than once for one failure -
 * including a failed write that a stream reports twice, once through the write callback
 * and again as an `'error'` event. A line reported `'retrying'` keeps its place in the
 * queue whatever this handler does: lines it logs through the same sink cannot push it
 * out, and a `close()` it calls takes the line in its drain. Should the queue cap later
 * drop that line, it is reported again, as `'queue_full'` / `'lost'` with its `entry` -
 * the final word, so a fallback consumer told `'retrying'` learns that it did not arrive.
 *
 * May be `async`. A handler that throws *or rejects* is reported to the console rather
 * than being allowed to turn one failure into two - see `reportThroughHandler`. Declaring
 * the return type as `void | Promise<void>` is part of that: typed `void`, an `async`
 * handler was a `no-misused-promises` error in the caller's own lint run, for a shape the
 * sink docs demonstrate and the reporter supports.
 *
 * A handler that logs a close-time `'lost'` / `'no_entry'` through the `Logger` that owns
 * this sink is dropped: `Logger.close()` marks the logger closed first so shutdown cannot
 * re-enter logging, and a successful handler is not a diagnostic delivery failure, so
 * nothing falls through to `console.error`. Report those with `console.error` or a
 * destination that logger is not closing. With no handler, the sink offers the
 * failure to its owning loggers, then uses guarded `console.error` if unowned.
 * Failures of diagnostic entries always use the terminal console path.
 */
export type SinkErrorHandler = (failure: SinkFailure) => void | Promise<void>;

/**
 * Preserve explicit handlers, otherwise offer the failure to every owning logger.
 *
 * Answers whether the report went out: `false` when it was suppressed because a console
 * report was in progress, the check `reportThroughHandler` makes.
 */
export function reportSinkError(
  sink: LogSink,
  failure: SinkFailure,
  handler: SinkErrorHandler | undefined,
  line: () => string,
  options: { label: string; isDiagnostic?: boolean; onSettled?: () => void },
): boolean {
  const didReport = !isConsoleReportActive();

  reportThroughHandler(
    options.isDiagnostic === true
      ? undefined
      : handler === undefined
        ? () => {
            if (
              !reportSinkFailure(sink, {
                kind: 'sink',
                error: failure.error,
                context: failure.kind === 'close' ? 'close' : 'write',
                message: describeRoutedFailure(options.label, failure),
                terminalLine: line,
              })
            ) {
              reportToConsole(line());
            }
          }
        : () => handler(failure),
    line,
    { handlerName: `${options.label} onError`, onSettled: options.onSettled },
  );

  return didReport;
}

/**
 * The routed diagnostic's `message`, which the owning logger's other sinks persist.
 *
 * Names the target and what became of the line, and for an I/O failure the error's own
 * text - the sink's wording around a path and errno, which is what an operator acts on.
 * A `'format'` failure's error comes from a caller's `formatter` or a value in the entry,
 * so its text stays on `diagnostic.error`, as `LoggerDiagnostic.message` requires.
 */
function describeRoutedFailure(label: string, failure: SinkFailure): string {
  const details = [
    failure.disposition === 'no_entry' ? undefined : failure.disposition,
    failure.attempt === undefined
      ? undefined
      : `attempt ${String(failure.attempt)}`,
  ].filter((detail) => detail !== undefined);
  const head = `${label} ${failure.kind} failed for ${failure.target}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
  return failure.kind === 'format'
    ? head
    : `${head}: ${describeError(failure.error)}`;
}
