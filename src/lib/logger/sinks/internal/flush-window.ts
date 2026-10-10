import { raceDeadline } from '../../../internal/race-deadline';

/**
 * What one flush window counted.
 *
 * `entriesWritten` and `entriesFailed` are counted from where the previous flush stopped
 * counting rather than from this call's entry - see {@link FlushWindows} for why.
 */
export interface FlushWindowResult {
  /** Nothing lost, nothing left waiting, and the deadline not reached. */
  success: boolean;
  /**
   * Entries written since the previous flush returned, or since the sink was made.
   *
   * Counted from the last flush rather than from this call's entry, as `entriesFailed`
   * is: a sink is written to between flushes, not only while one is waiting, so a window
   * that opened at the call would answer for none of it.
   */
  entriesWritten: number;
  /**
   * Entries lost since the previous flush returned - retries exhausted, evicted at
   * `maxQueueSize`, or abandoned by `close()`.
   *
   * `getHealth().droppedEntries` is the cumulative figure. Successive flushes partition
   * the losses between them, so each one is reported exactly once.
   */
  entriesFailed: number;
  /** Whether the flush ran out of time. */
  timedOut: boolean;
}

/** The running totals a flush window is measured against. */
export interface FlushTotals {
  /** Lines delivered since the sink was made. */
  written: number;
  /** Lines not delivered since the sink was made, whatever the reason. */
  dropped: number;
}

/**
 * One counting window, handed to a flush body while it holds its turn.
 *
 * Its baselines were read when the turn began, so a loss that lands while the body is
 * still waiting on something is inside this call's answer rather than deferred to the
 * next one.
 */
export interface FlushWindow {
  /**
   * Close the window: count what happened since it opened, move the baselines past it,
   * and hand the result back.
   *
   * On every exit including the timeouts: a flush that gave up still reported the writes
   * and losses it had seen, and counting them again in the next result would double-report
   * them.
   *
   * @param isTimedOut Whether the flush ran out of time.
   * @param isComplete Whether everything the flush waited for was dealt with. A flush that
   *                   stopped early for a reason other than its deadline is not a success
   *                   even when nothing was lost. Defaults to `true`.
   */
  settle(isTimedOut: boolean, isComplete?: boolean): FlushWindowResult;
}

/**
 * The flush accounting both queueing sinks share: successive flushes partition the lines
 * written and lost between them, so each line is reported exactly once.
 *
 * Measured from where the *last* flush stopped counting rather than from a call's own
 * entry, which is the window a caller is actually asking about. A sink evicts
 * synchronously inside `write()` and drains only between turns of the event loop, so every
 * loss a synchronous logging loop causes has already happened by the time `flush()` is
 * entered: 25,000 `write()` calls under the default 10,000 cap then answered
 * `{ success: true, entriesWritten: 10000, entriesFailed: 0 }` while `getHealth()` reported
 * 15,000 dropped - a batch job's all-clear for losing most of its log. Counted from the
 * last flush, those losses are in the result that follows them.
 *
 * One flush at a time. The counts are windows between baselines that each flush advances
 * as it settles - and two flushes in flight together both read the same baselines before
 * either advanced them, so both reported the same window: two callers each told the same
 * line was written, or the same line lost, and a caller summing results double-counted.
 * Chained rather than shared, since each caller asked about the lines up to its own call.
 */
export class FlushWindows {
  private baselineWritten = 0;
  private baselineDropped = 0;
  /** The flush in flight, if any. Never rejects. */
  private pending: Promise<void> = Promise.resolve(undefined);

  constructor(private readonly totals: () => FlushTotals) {}

  /** The last flush queued, settled: what the next one waits behind. Never rejects. */
  public get settled(): Promise<void> {
    return this.pending;
  }

  /**
   * Run `body` once every earlier flush has settled.
   *
   * @param timeoutMS The caller's budget, already validated. Waiting behind an earlier
   *                  flush spends it: a caller that never got its turn answers
   *                  `timedOut: true` having counted nothing, and the body is told nothing
   *                  about the wait, so it measures its own budget from a clock the caller
   *                  started before calling this.
   * @param body The flush itself, handed its counting window. Settles the window on every
   *             exit; see {@link FlushWindow.settle}.
   */
  public run(
    timeoutMS: number,
    body: (window: FlushWindow) => Promise<FlushWindowResult>,
  ): Promise<FlushWindowResult> {
    const previous = this.pending;
    const run = (async (): Promise<FlushWindowResult> => {
      const isReady = await raceDeadline(
        previous.then(() => true),
        timeoutMS,
        () => false,
      );
      if (!isReady) {
        // This caller never owned a counting window. Its budget includes queueing.
        return {
          success: false,
          entriesWritten: 0,
          entriesFailed: 0,
          timedOut: true,
        };
      }
      return await body(this.open());
    })();

    // `run` may time out while `previous` still owns its counting window. Keep `previous`
    // in the queue barrier so a third flush cannot overtake it.
    this.pending = (async (): Promise<void> => {
      try {
        await previous;
        await run;
      } catch {
        // An unsuccessful flush must not strand the next caller's turn.
      }
    })();

    return run;
  }

  /** Open a window at the current baselines. */
  private open(): FlushWindow {
    const startWritten = this.baselineWritten;
    const startDropped = this.baselineDropped;

    return {
      settle: (isTimedOut, isComplete = true) => {
        const totals = this.totals();
        const entriesWritten = totals.written - startWritten;
        const entriesFailed = totals.dropped - startDropped;

        this.baselineWritten = totals.written;
        this.baselineDropped = totals.dropped;

        return {
          success: !isTimedOut && isComplete && entriesFailed === 0,
          entriesWritten,
          entriesFailed,
          timedOut: isTimedOut,
        };
      },
    };
  }
}
