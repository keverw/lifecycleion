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
