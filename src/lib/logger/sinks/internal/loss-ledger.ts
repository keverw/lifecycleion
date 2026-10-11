import type { LogEntry } from '../../types';
import {
  abandonQueuedEntries,
  evictQueuedEntries,
  ReportOnceLatch,
  type EvictOptions,
} from './queue-accounting';
import {
  createDroppedEntryCounts,
  type DroppedEntryCounts,
  type DroppedEntryKind,
} from './sink-failure';

/**
 * How a {@link LossLedger} hands a report to the sink that owns it.
 *
 * Every report the ledger makes is about lines that will not arrive, so the sink sends it
 * as `disposition: 'lost'` with `entry` as the sample. The sink owns the error class, the
 * routing and `lastError`; the ledger owns when a report is owed.
 *
 * Answers whether the report went out. `false` - suppressed, because a console report was
 * in progress - gives back a once-only claim, so the report is still made for the next
 * line lost the same way.
 */
export type LossReporter = (
  kind: 'close' | 'queue_full',
  message: string,
  entry: LogEntry | undefined,
) => boolean;

/** `1 entry` or `N entries`, for a loss report's message. */
export function describeEntryCount(count: number): string {
  return `${String(count)} entr${count === 1 ? 'y' : 'ies'}`;
}

/** `1 write` or `N writes`, for a close report's message. */
export function describeWriteCount(count: number): string {
  return `${String(count)} write${count === 1 ? '' : 's'}`;
}

/**
 * The lines a queueing sink did not deliver, counted by reason and reported without a
 * flood.
 *
 * `FileSink` and `NamedPipeSink` lose lines the same three ways outside a write - refused
 * after `close()` began, evicted at `maxQueueSize`, still queued when `close()` stops
 * waiting - and count and report each the same way, so the bookkeeping lives here. A
 * failed write's loss stays with the sink, which knows the attempt and whether it is
 * retried, and only {@link count}s here. Messages are the sink's own, built only when a
 * report is actually owed.
 *
 * `droppedEntries` means "lines this sink did not deliver", whatever the reason, and the
 * per-reason breakdown always sums to it.
 */
export class LossLedger {
  private total = 0;
  private readonly byKind = createDroppedEntryCounts();
  /** Whether the current overflow episode's `'queue_full'` report has gone out. */
  private readonly queueFullReport = new ReportOnceLatch();
  /** Whether the first entry refused because the sink is closing has been reported. */
  private readonly closeRefusalReport = new ReportOnceLatch();

  constructor(private readonly report: LossReporter) {}

  /** Every line not delivered, whatever the reason. */
  public get droppedEntries(): number {
    return this.total;
  }

  /** A copy of the per-reason breakdown. See {@link DroppedEntryCounts}. */
  public droppedByKind(): DroppedEntryCounts {
    return { ...this.byKind };
  }

  /**
   * `count` more lines this sink did not deliver, and why. The total and the breakdown
   * move together so they cannot disagree.
   */
  public count(kind: DroppedEntryKind, count = 1): void {
    this.total += count;
    this.byKind[kind] += count;
  }

  /**
   * An entry `write()` refused because `close()` had begun.
   *
   * Called after the level filter, never before it: an entry below `minLevel` was never
   * going to be written, so it is not a line the sink failed to deliver. Every refused
   * entry is counted under `'close'`; only the first of each origin is reported, since an
   * application still logging through a thirty-second close would otherwise get a callback
   * per line. The queued entries `close()` abandons are {@link abandon}'s; these are the
   * ones refused at the door. A report suppressed because a console report was in progress
   * does not count as that first one.
   */
  public refuseAfterClose(entry: LogEntry, message: () => string): void {
    this.count('close');

    if (
      this.closeRefusalReport.claim(entry) &&
      !this.report('close', message(), entry)
    ) {
      this.closeRefusalReport.release(entry);
    }
  }

  /**
   * Discard the oldest entries once `queue` is over `limit` (`undefined` for no cap), count
   * them under `'queue_full'`, and report the first eviction of each overflow episode.
   *
   * Gated on an eviction this call made rather than on the cumulative count, which also
   * holds retries that ran out and entries `close()` abandoned - neither is an overflow.
   * Reported once per episode rather than per drop: an overflowing queue drops
   * continuously, and a callback per entry would be its own flood on a path already in
   * trouble. A diagnostic's report goes only to the console, so it is latched separately
   * and cannot silence the report owed for application entries dropped after it. The
   * sample is a dropped entry, never a surviving one, so a handler that writes `'lost'`
   * lines elsewhere cannot duplicate one still queued. A report suppressed because a
   * console report was in progress does not count as the episode's.
   *
   * `options` narrows which entries may go and how full the queue counts as; see
   * {@link EvictOptions}.
   *
   * Answers the entry the episode's report carried, when this call made that report, so a
   * caller that owes some evicted entries a word of their own does not say it twice. A
   * caller that passed `options.start` hears where the live queue now starts through
   * `options.onSettled`, before that report.
   */
  public evict<T extends { entry: LogEntry }>(
    queue: T[],
    limit: number | undefined,
    message: (limit: number) => string,
    options?: EvictOptions<T>,
  ): LogEntry | undefined {
    // Every enqueue comes through here, so a queue within its cap allocates nothing.
    if (
      limit === undefined ||
      (options?.occupancy ?? queue.length - (options?.start ?? 0)) <= limit
    ) {
      return undefined;
    }

    const dropped = evictQueuedEntries(queue, limit, options);
    this.count('queue_full', dropped.count);

    if (dropped.count === 0 || !this.queueFullReport.claim(dropped.entry)) {
      return undefined;
    }

    if (!this.report('queue_full', message(limit), dropped.entry)) {
      this.queueFullReport.release(dropped.entry);

      return undefined;
    }

    return dropped.entry;
  }

  /**
   * Close the overflow episode once the queue has drained, so a later overflow is
   * reported again. Called only on an empty queue, so a pass that stopped short of
   * draining does not re-arm the flood.
   */
  public endOverflowEpisode(): void {
    this.queueFullReport.reset();
  }

  /**
   * Empty the queue a closing sink is giving up on, count it under `'close'`, and report it
   * once, with the oldest abandoned entry as the sample.
   *
   * Once rather than per entry, for the reason {@link evict} reports once: a shutdown that
   * abandons a full queue would otherwise fire the callback ten thousand times on the way
   * out of the process. Every entry in the queue was lost, so there is no surviving line to
   * confuse the sample with.
   *
   * `isAbandoned` limits it to some entries; see {@link abandonQueuedEntries}.
   */
  public abandon<T extends { entry: LogEntry }>(
    queue: T[],
    message: (count: number) => string,
    isAbandoned?: (item: T) => boolean,
  ): void {
    const abandoned = abandonQueuedEntries(queue, isAbandoned);

    if (abandoned.count === 0) {
      return;
    }

    this.count('close', abandoned.count);
    this.report('close', message(abandoned.count), abandoned.entry);
  }
}
