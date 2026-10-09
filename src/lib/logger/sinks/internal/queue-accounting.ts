import { isDiagnosticEntry } from '../../internal/sink-failure-routing';
import type { LogEntry } from '../../types';

/** Evict the oldest excess entries and select a lost entry for the overflow report. */
export function evictQueuedEntries<T extends { entry: LogEntry }>(
  queue: T[],
  limit: number,
): { count: number; entry?: LogEntry } {
  let count = 0;
  let entry: LogEntry | undefined;
  while (queue.length > limit) {
    const dropped = queue.shift();
    // Prefer ordinary work so a diagnostic at the head of a mixed queue cannot
    // suppress the owner's report about application entries lost in the same batch.
    if (
      entry === undefined ||
      (isDiagnosticEntry(entry) && !isDiagnosticEntry(dropped?.entry))
    ) {
      entry = dropped?.entry;
    }
    count++;
  }
  return { count, ...(entry === undefined ? {} : { entry }) };
}

/**
 * Empty the queue a closing sink is giving up on, and select a lost entry for the
 * abandoned-queue report: the oldest ordinary entry, or the oldest diagnostic one when
 * nothing else was queued - the same preference {@link evictQueuedEntries} applies.
 */
export function abandonQueuedEntries<T extends { entry: LogEntry }>(
  queue: T[],
): { count: number; entry?: LogEntry } {
  const count = queue.length;
  const entry = (
    queue.find((queued) => !isDiagnosticEntry(queued.entry)) ?? queue[0]
  )?.entry;

  queue.length = 0;

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
