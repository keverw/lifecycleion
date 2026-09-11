import type { LogEntry } from '../../types';

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
   * Absent for a failure that belongs to no particular entry - a failed rotation, a queue
   * that overflowed - and absent from `NamedPipeSink` entirely, which deliberately drops
   * the `LogEntry` once its line is rendered so that a stalled queue does not pin the
   * caller's params graph for the length of an outage.
   */
  entry?: LogEntry;
  /** Which attempt this was, 1-based, for a failure that is tied to an entry. */
  attempt?: number;
  /**
   * What became of the line this failure is about.
   *
   * One field rather than a `willRetry` boolean, because the boolean could not say what a
   * consumer actually needs to know. `willRetry: false` was documented as "the line is
   * gone", and then `NamedPipeSink` reported a `formatter` that threw with `false` and
   * went on to write the line using its own default format - so a handler following that
   * documentation wrote a duplicate. Retry intent and delivery are two questions, and
   * only the second decides whether to write the line somewhere else.
   *
   * - `'retrying'` - the sink will try this line again. Do nothing; a fallback write here
   *   duplicates it.
   * - `'lost'` - the line will not arrive: out of retries, unrenderable, or dropped to
   *   stay under the queue cap. **This is the one that means write it somewhere else.**
   * - `'fallback'` - the sink substituted something of its own and carried on with the
   *   line. `NamedPipeSink` reports this when a custom `formatter` threw and its default
   *   format was used instead: worth knowing, since your formatter is not running, but
   *   the line is not lost *by this failure*.
   *
   *   Deliberately not `'written'`. That would be a promise made too early - the
   *   substitution happens while the line is still being rendered, before anything
   *   reaches the destination - and a line that is afterwards queued, evicted at the cap,
   *   or failed on is reported again on its own terms. Nothing to do here either way:
   *   `'lost'` is what asks for a fallback write.
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
 * and again as an `'error'` event.
 *
 * A handler that throws is reported to the console rather than being allowed to turn one
 * failure into two - see `reportThroughHandler`.
 */
export type SinkErrorHandler = (failure: SinkFailure) => void;
