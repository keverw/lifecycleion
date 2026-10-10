import type { SinkFailureKind } from './sink-failure';

/**
 * How many distinct open failures are reported before one outage has said enough.
 *
 * The set in {@link OutageReporter} is what bounds reporting, and in practice it bounds it
 * at three or four: three kinds, and a small number of `errno`s each. This is the guard
 * for the case where that assumption does not hold - a message that varies for reasons
 * the sink cannot see - which without a cap is a set that grows for as long as the outage
 * does, on the one path whose whole job is to survive a long outage quietly.
 *
 * Eight, so the realistic ceiling is never the one reached, and the sink says when it is
 * rather than falling silent.
 */
export const MAX_REPORTED_OPEN_FAILURES = 8;

/**
 * How an {@link OutageReporter} hands a report to the sink that owns it.
 *
 * The sink owns the routing, `lastError` and whatever re-entrancy its handlers bring; the
 * reporter owns only whether a report is owed. `isDiagnostic` is passed through untouched
 * so the sink routes the report the way the attempt that failed would have been routed.
 */
export type OutageReport = (
  kind: SinkFailureKind,
  error: Error,
  isDiagnostic: boolean,
) => void;

export interface OutageReporterOptions {
  /** Delivers a report that is owed. */
  report: OutageReport;
  /**
   * The message for the one notice said when a budget reaches its cap. Reported as
   * `'setup'`, since it is about the destination and no entry.
   */
  describeCap: (maxReports: number) => string;
  /** Distinct failures per budget before the cap notice. Defaults to {@link MAX_REPORTED_OPEN_FAILURES}. */
  maxReports?: number;
}

/**
 * One budget: the failures it has reported and whether its cap notice has gone out.
 */
interface ReportBudget {
  readonly reported: Set<string>;
  /**
   * Whether the cap has been reported, so it is said once.
   *
   * Said at all, rather than the sink simply going quiet at the cap: a sink that has
   * stopped telling you things has to tell you that.
   */
  didReportCap: boolean;
}

/**
 * The open failures reported during this outage, so one outage is not reported every
 * second.
 *
 * A queueing sink retries a destination it cannot open on its own timer, which is what
 * makes recovery independent of traffic, and which without this would make a mistyped
 * path call the caller's `onError` every few seconds for the life of the process. The
 * reporting the sinks already do elsewhere works exactly this way: `queueFullReport` for
 * the queue cap.
 *
 * A set rather than a boolean, so a *different* failure still gets through: a path that
 * goes from missing to present-but-unreadable is a new fact, and a consumer watching this
 * channel is entitled to it. Keyed on the kind as well as the message, since messages
 * from one sink commonly share a prefix.
 *
 * A set rather than just the last one, which is the stricter of the two and the reason
 * this is a hard ceiling. Remembering only the previous failure reports on every
 * *change*, so a path genuinely flapping between two states - a deploy script creating
 * and removing it - is a report per transition, which at one attempt a second is the
 * flood again by another route. Remembering all of them means a state already reported
 * this outage stays quiet however many times it comes back, and one outage costs at most
 * {@link MAX_REPORTED_OPEN_FAILURES} callbacks however long it lasts or how it thrashes.
 *
 * Two budgets: terminal diagnostic failures cannot spend the ordinary outage report
 * budget, nor the other way round.
 *
 * The owner calls {@link clear} when the destination opens, so the next outage speaks up
 * again, and when the caller asks for an attempt by name, which it is owed an answer to.
 */
export class OutageReporter {
  private readonly ordinary: ReportBudget = {
    reported: new Set<string>(),
    didReportCap: false,
  };
  private readonly diagnostic: ReportBudget = {
    reported: new Set<string>(),
    didReportCap: false,
  };
  private readonly report: OutageReport;
  private readonly describeCap: (maxReports: number) => string;
  private readonly maxReports: number;

  constructor(options: OutageReporterOptions) {
    this.report = options.report;
    this.describeCap = options.describeCap;
    this.maxReports = options.maxReports ?? MAX_REPORTED_OPEN_FAILURES;
  }

  /**
   * Report a failed open, once per distinct failure per outage rather than once per
   * attempt.
   *
   * State is updated before the report goes out, so a handler that re-enters the sink -
   * and through it this reporter - sees the failure as already said.
   */
  public reportFailure(
    kind: SinkFailureKind,
    message: string,
    cause: unknown,
    isDiagnostic = false,
  ): void {
    // Keyed on the kind as well as the text. The two are not redundant: a sink's open
    // failures commonly build the same `Could not open ... at <path>: ` prefix, so two
    // failures that rendered alike would otherwise be one - and the second would be
    // swallowed while carrying a *different* kind, which is the one thing a consumer
    // switching on `kind` cannot afford to miss.
    const key = `${kind}\u0000${message}`;
    const budget = isDiagnostic ? this.diagnostic : this.ordinary;

    // Already said this outage. Not "already said last time": see the class comment for
    // why a path that flaps between two states must not report on every transition.
    if (budget.reported.has(key)) {
      return;
    }

    if (budget.reported.size >= this.maxReports) {
      if (!budget.didReportCap) {
        budget.didReportCap = true;

        this.report(
          'setup',
          new Error(this.describeCap(this.maxReports)),
          isDiagnostic,
        );
      }

      return;
    }

    budget.reported.add(key);

    this.report(kind, new Error(message, { cause }), isDiagnostic);
  }

  /** Forget this outage, in both budgets, so the next failure is reported again. */
  public clear(): void {
    for (const budget of [this.ordinary, this.diagnostic]) {
      budget.reported.clear();
      budget.didReportCap = false;
    }
  }
}
