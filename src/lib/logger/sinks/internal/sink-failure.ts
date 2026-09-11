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
 * - `'format'` - a custom `formatter` threw; the default format was used instead, so the
 *   line still went out and the destination is healthy.
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
   * Whether the sink will try this entry again.
   *
   * `false` means the line is gone: out of retries, unusable, or discarded to stay under
   * the queue cap. That is the signal to write it somewhere else if it matters.
   */
  willRetry: boolean;
}

/**
 * Notified when a sink cannot do its job.
 *
 * Never called for an ordinary success, and never called more than once for one failure.
 * A handler that throws is reported to the console rather than being allowed to turn one
 * failure into two - see `reportThroughHandler`.
 */
export type SinkErrorHandler = (failure: SinkFailure) => void;
