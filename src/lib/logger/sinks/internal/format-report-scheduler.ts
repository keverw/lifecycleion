import { reportThroughHandler } from '../../../internal/failure-reporter';

/**
 * One `'format'` report, handed the callback that marks it settled. The report calls it
 * once its handler has settled, `async` or not - `reportThroughHandler`'s `onSettled`.
 */
export type FormatReport = (onReported: () => void) => void;

/**
 * Delivers a queueing sink's `'format'` reports so an `onError` that logs through the same
 * sink cannot feed the loop that reported it.
 *
 * A handler that re-logs the failure it was handed - `logger.error('sink failed',
 * { failure })` is the natural one - serializes the `entry` the failure carries, and the
 * value that made *that* entry unrenderable makes the handler's own line unrenderable
 * too. Reported to the handler again, that is a loop without end: synchronous for a
 * handler that logs before returning, one report per turn of the event loop for an
 * `async` one.
 *
 * One report is delivered at a time, and the guard is held until its handler *settles*,
 * not until it returns: an `async` handler returns at its first `await`, and a guard
 * cleared there was down again by the time the handler resumed and logged. A failure that
 * arrives while a report is outstanding is held in a single deferred slot and delivered
 * once that report settles - an independent failure must not be hidden for as long as a
 * slow handler takes. What cannot be held goes to the console instead: a report raised
 * while the handler is being invoked or while the deferred report is being delivered is
 * the handler's own line coming back, and a second deferred report would start a new
 * generation after the guard came down. The console is the terminal rung, so nothing it
 * reports reaches the handler again; a console shim that logs back into the sink is
 * contained by a guard of its own, under which a nested console report is dropped.
 *
 * `ArraySink` follows the same policy for its `onFormatError`, with its own counters.
 */
export class FormatReportScheduler {
  private isActive = false;
  private isInvoking = false;
  private isDeliveringDeferred = false;
  private isReportingToConsole = false;
  private deferred?: FormatReport;

  /** Whether a report's handler has been called and has not settled yet. */
  public get isReportActive(): boolean {
    return this.isActive;
  }

  /** Whether a console report is being written right now. */
  public get isConsoleReportActive(): boolean {
    return this.isReportingToConsole;
  }

  /**
   * Whether a failure raised now is the handler's own line coming back: the handler is
   * being called, or the one deferred report is being delivered. Such a failure is
   * reported on the console, never queued for the handler.
   */
  public get isFused(): boolean {
    return this.isInvoking || this.isDeliveringDeferred;
  }

  /**
   * Deliver `report` now, hold it in the deferred slot, or send `consoleLine` to the
   * console - whichever the guard allows. See the class comment.
   */
  public schedule(report: FormatReport, consoleLine: () => string): void {
    if (!this.isActive) {
      this.start(report, false);

      return;
    }

    if (!this.isFused && this.deferred === undefined) {
      this.deferred = report;

      return;
    }

    this.reportToConsole(consoleLine);
  }

  /**
   * Report a format failure on the console, with the guard raised while it does, so a
   * console shim that logs back into the sink cannot recurse. A failure raised by such a
   * shim is dropped.
   */
  public reportToConsole(line: () => string): void {
    if (this.isReportingToConsole) {
      return;
    }

    this.isReportingToConsole = true;

    try {
      // No handler, so this is the console rung alone - with `line` rendered under the
      // reporter's own guard, since it is the caller's to build and may throw.
      reportThroughHandler(undefined, line);
    } finally {
      this.isReportingToConsole = false;
    }
  }

  private start(report: FormatReport, isDeferred: boolean): void {
    this.isActive = true;
    this.isDeliveringDeferred = isDeferred;
    this.isInvoking = true;

    try {
      report(() => {
        this.isActive = false;
        this.isDeliveringDeferred = false;

        if (isDeferred) {
          return;
        }

        const pending = this.deferred;

        this.deferred = undefined;

        if (pending !== undefined) {
          this.start(pending, true);
        }
      });
    } finally {
      this.isInvoking = false;
    }
  }
}
