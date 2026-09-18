import { reportThroughHandler } from './failure-reporter';
import type {
  RenderBudget,
  TruncationHandler,
  TruncationInfo,
} from './render-budget';

/**
 * Watch one render's budget and tell a handler if it was cut short.
 *
 * Shared so `curlyBrackets`, `stringifyValue` and `errorToString` answer "is my output
 * complete" identically. Each of them creates a budget, renders into it, and needs the
 * same three things afterwards: whether anything was cut, which bound did it, and how
 * much was lost where that is knowable. Written out at each call site, the three drifted
 * on the details that matter most - whether a nested cut counts, whether a dropped tail
 * counts, whether `dropped` is zero or absent when nothing measured it.
 *
 * Read off the budget's counters rather than by inspecting the rendered string: a payload
 * may legitimately contain the marker's own words, and a string says nothing about where
 * in the walk the cut happened or how much went with it.
 *
 * Fires at most once per render, not once per cut, for the reason `createFormatReporter`
 * does: a render past its budget degrades continuously, and a handler per occurrence is a
 * flood on a path already in trouble. The first cut is also the informative one -
 * everything after it is a consequence.
 */
export function createTruncationReporter(
  budget: RenderBudget,
  handler: TruncationHandler | undefined,
): (subject: string) => void {
  if (handler === undefined) {
    // Nothing to report to, so nothing to watch. The counters still move - they are the
    // render's own bookkeeping - and this costs the caller a closure that does nothing.
    return () => {};
  }

  let didReport = false;
  let truncationsSeen = budget.truncations;
  let droppedSeen = budget.droppedChars;

  return (subject: string): void => {
    if (didReport || budget.truncations === truncationsSeen) {
      return;
    }

    const dropped = budget.droppedChars - droppedSeen;

    truncationsSeen = budget.truncations;
    droppedSeen = budget.droppedChars;
    didReport = true;

    const info: TruncationInfo = {
      // The budget's own first reason, not this call's: a render is one operation, and the
      // bound that stopped it first is what explains everything after.
      reason: budget.firstReason ?? 'length',
      subject,
      // Absent rather than zero where nothing measured it. See `TruncationInfo.dropped`.
      dropped: dropped > 0 ? dropped : undefined,
    };

    // The same rung `onFormatError` and the sinks' `onError` stand on. A notification
    // about a degradation is not a step in producing the output, so a handler that throws
    // must not take the render down with it - but it was swallowed outright, the one
    // callback in the logger whose breakage nobody could see. The console, never
    // `onFormatError`: that channel is for a value that refused to render, and spending
    // its one report on a broken callback would hide the failure it exists for.
    reportThroughHandler(
      () => handler(info),
      () =>
        `Truncation of ${subject} (${info.reason}) could not be reported to onTruncate`,
    );
  };
}
