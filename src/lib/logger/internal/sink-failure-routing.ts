import type { LogEntry, LoggerDiagnostic, LogSink } from '../types';
import { reportThroughHandler } from '../../internal/failure-reporter';
import { applyIntrinsic, snapshotSet } from '../../internal/intrinsics';

export type SinkFailureReport = Omit<LoggerDiagnostic, 'timestamp' | 'sink'> & {
  /** Detailed console-only text; never included in the public diagnostic or entry. */
  terminalLine?: () => string;
};
type SinkFailureReporter = (report: SinkFailureReport) => void;

interface RoutingRecord {
  reporters?: Set<SinkFailureReporter>;
  isDiagnostic?: boolean;
}

// Keep associations off caller-owned objects, including frozen sinks and proxies.
// Bundled copies share both ownership and terminal-entry identity in the same realm.
const STATE_KEY = Symbol.for('lifecycleion.sinkFailureRouting.v1');
const weakMapConstructorIntrinsic = WeakMap;
const setConstructorIntrinsic = Set;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapGetIntrinsic = WeakMap.prototype.get;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapSetIntrinsic = WeakMap.prototype.set;
// eslint-disable-next-line @typescript-eslint/unbound-method
const weakMapHasIntrinsic = WeakMap.prototype.has;
// eslint-disable-next-line @typescript-eslint/unbound-method
const setAddIntrinsic = Set.prototype.add;
// eslint-disable-next-line @typescript-eslint/unbound-method
const setDeleteIntrinsic = Set.prototype.delete;
const state = getSharedState();

function getSharedState(): WeakMap<object, RoutingRecord> {
  const fallback = new weakMapConstructorIntrinsic<object, RoutingRecord>();
  try {
    const existing: unknown = Object.getOwnPropertyDescriptor(
      globalThis,
      STATE_KEY,
    )?.value;
    try {
      applyIntrinsic(weakMapHasIntrinsic, existing, [fallback]);
      return existing as WeakMap<object, RoutingRecord>;
    } catch {
      // Missing or unusable shared state; do not invoke a global accessor.
    }
    Object.defineProperty(globalThis, STATE_KEY, {
      value: fallback,
      configurable: true,
    });
  } catch {
    // Non-extensible globals still support routing within this module copy.
  }
  return fallback;
}

/** Associate one owner with a sink without inspecting or modifying the sink. */
export function registerSinkFailureReporter(
  sink: LogSink,
  reporter: SinkFailureReporter,
): () => void {
  let record = applyIntrinsic(weakMapGetIntrinsic, state, [sink]) as
    RoutingRecord | undefined;
  if (record === undefined) {
    record = {};
    applyIntrinsic(weakMapSetIntrinsic, state, [sink, record]);
  }
  const reporters = (record.reporters ??= new setConstructorIntrinsic());
  // Each registration has its own lifetime, even when callbacks are equal.
  const subscription: SinkFailureReporter = (report) => reporter(report);
  applyIntrinsic(setAddIntrinsic, reporters, [subscription]);
  return () => {
    applyIntrinsic(setDeleteIntrinsic, reporters, [subscription]);
  };
}

/** Return true when the sink has an owner, even if an owner's reporter fails. */
export function reportSinkFailure(
  sink: LogSink,
  report: SinkFailureReport,
): boolean {
  const record = applyIntrinsic(weakMapGetIntrinsic, state, [sink]) as
    RoutingRecord | undefined;
  const reporters = record?.reporters;
  if (reporters === undefined) {
    return false;
  }
  // Registration changes during a report apply to later failures.
  const snapshot = snapshotSet(reporters);
  // eslint-disable-next-line unicorn/no-for-loop
  for (let index = 0; index < snapshot.length; index++) {
    const reporter = snapshot[index];
    reportThroughHandler(
      () => reporter(report),
      report.terminalLine ?? (() => report.message),
    );
  }
  return snapshot.length > 0;
}

/** Mark the exact entry passed to a sink so delayed failures remain terminal. */
export function markDiagnosticEntry(entry: LogEntry): LogEntry {
  let record = applyIntrinsic(weakMapGetIntrinsic, state, [entry]) as
    RoutingRecord | undefined;
  if (record === undefined) {
    record = {};
    applyIntrinsic(weakMapSetIntrinsic, state, [entry, record]);
  }
  record.isDiagnostic = true;
  return entry;
}

export function isDiagnosticEntry(entry: LogEntry | undefined): boolean {
  const record = applyIntrinsic(weakMapGetIntrinsic, state, [entry]) as
    RoutingRecord | undefined;
  return record?.isDiagnostic === true;
}
