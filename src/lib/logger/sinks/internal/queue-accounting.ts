import { isDiagnosticEntry } from '../../internal/sink-failure-routing';
import type { LogEntry } from '../../types';

/**
 * Which entries {@link evictQueuedEntries} may take, and how full the queue counts as.
 *
 * Both default to the whole queue. A queue that keeps a line in place while its write is
 * in flight - the delivery engine's - passes `isEvictable` so an entry that may already
 * have been written is never dropped as unwritten, and `occupancy` when only some of its
 * entries count against the cap.
 */
export interface EvictOptions<T> {
  /** Whether an entry may be evicted. Others keep their place. Defaults to every entry. */
  isEvictable?: (item: T) => boolean;
  /** How many entries count against `limit`. Defaults to the entries from `start` on. */
  occupancy?: number;
  /**
   * Where the live queue starts in `queue`, for a caller that leaves a dead prefix in place
   * rather than shifting it out. Given, an entry nearer the front than the back is evicted
   * by moving the live entries before it up one place - only those passed over, the lines
   * in flight - and the start past it, so evicting at the front of a full queue does not
   * move the whole of it. The new start is passed to `onSettled` and returned in the
   * result. Omitted, the queue is kept with no dead prefix.
   */
  start?: number;
  /**
   * Told where the live queue starts once eviction is done, before the caller reports
   * anything about it: a report reaches caller code that may queue more.
   */
  onSettled?: (start: number) => void;
  /**
   * Told about each evicted entry, oldest first, once eviction is done and `onSettled` has
   * been told where the live queue starts.
   */
  onEvicted?: (item: T) => void;
}

/** Evict the oldest excess entries and select a lost entry for the overflow report. */
export function evictQueuedEntries<T extends { entry: LogEntry }>(
  queue: T[],
  limit: number,
  options: EvictOptions<T> = {},
): { count: number; entry?: LogEntry; start: number } {
  const isEvictable = options.isEvictable;
  let start = options.start ?? 0;
  let occupancy = options.occupancy ?? queue.length - start;
  let count = 0;
  let entry: LogEntry | undefined;
  // Where the search for the next evictable entry resumes: everything before it was
  // passed over, and passing over an entry never makes it evictable later in this call.
  let index = start;
  const evicted: T[] = [];
  while (occupancy > limit) {
    while (
      isEvictable !== undefined &&
      index < queue.length &&
      !isEvictable(queue[index])
    ) {
      index++;
    }
    if (index >= queue.length) {
      // Over the cap with nothing that may go: everything left is in flight.
      break;
    }
    const dropped: T | undefined = queue[index];
    if (options.start !== undefined && index - start < queue.length - index) {
      // Nearer the front: what was passed over moves up one place, and the start past it.
      queue.copyWithin(start + 1, start, index);
      start++;
      index++;
    } else if (index === 0) {
      queue.shift();
    } else {
      queue.splice(index, 1);
    }
    // Prefer ordinary work so a diagnostic at the head of a mixed queue cannot
    // suppress the owner's report about application entries lost in the same batch.
    if (
      entry === undefined ||
      (isDiagnosticEntry(entry) && !isDiagnosticEntry(dropped?.entry))
    ) {
      entry = dropped?.entry;
    }
    if (dropped !== undefined && options.onEvicted !== undefined) {
      evicted.push(dropped);
    }
    occupancy--;
    count++;
  }
  options.onSettled?.(start);
  for (const item of evicted) {
    options.onEvicted?.(item);
  }
  return { count, ...(entry === undefined ? {} : { entry }), start };
}

/**
 * Empty the queue a closing sink is giving up on, and select a lost entry for the
 * abandoned-queue report: the oldest ordinary entry, or the oldest diagnostic one when
 * nothing else was queued - the same preference {@link evictQueuedEntries} applies.
 *
 * `isAbandoned` limits it to some entries, the rest kept in place and in order: the
 * delivery engine leaves a line whose write is in flight to that write's own outcome.
 */
export function abandonQueuedEntries<T extends { entry: LogEntry }>(
  queue: T[],
  isAbandoned?: (item: T) => boolean,
): { count: number; entry?: LogEntry } {
  const abandoned =
    isAbandoned === undefined ? queue : queue.filter(isAbandoned);
  const count = abandoned.length;
  const entry = (
    abandoned.find((queued) => !isDiagnosticEntry(queued.entry)) ?? abandoned[0]
  )?.entry;

  if (isAbandoned === undefined) {
    queue.length = 0;
  } else {
    let kept = 0;
    for (const queued of queue) {
      if (!isAbandoned(queued)) {
        queue[kept++] = queued;
      }
    }
    queue.length = kept;
  }

  return { count, ...(entry === undefined ? {} : { entry }) };
}

/**
 * Whether a once-per-episode report has gone out, latched separately for diagnostic
 * entries.
 *
 * A diagnostic's report goes only to the console, so spending the ordinary latch on it
 * would silence the report owed for application entries after it.
 */
export class ReportOnceLatch {
  private hasReported = false;
  private hasReportedDiagnostic = false;

  /**
   * `true`, latching it, when no report has gone out yet for `entry`'s origin; `false`
   * when one already has.
   */
  public claim(entry: LogEntry | undefined): boolean {
    if (isDiagnosticEntry(entry)) {
      if (this.hasReportedDiagnostic) {
        return false;
      }

      this.hasReportedDiagnostic = true;

      return true;
    }

    if (this.hasReported) {
      return false;
    }

    this.hasReported = true;

    return true;
  }

  /**
   * Give back a claim whose report did not go out, so the next one for `entry`'s origin
   * is still made. A report suppressed because a console report was in progress said
   * nothing, and must not stand in for the one owed after it.
   */
  public release(entry: LogEntry | undefined): void {
    if (isDiagnosticEntry(entry)) {
      this.hasReportedDiagnostic = false;
    } else {
      this.hasReported = false;
    }
  }

  /** Re-arm both latches, so the next episode is reported again. */
  public reset(): void {
    this.hasReported = false;
    this.hasReportedDiagnostic = false;
  }
}
