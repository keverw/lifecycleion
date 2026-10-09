import type { LogEntry, LoggerDiagnostic, LogSink } from '../types';
import { reportThroughHandler } from '../../internal/failure-reporter';

export type SinkFailureReport = Omit<LoggerDiagnostic, 'timestamp' | 'sink'> & {
  /** Detailed console-only text; never included in the public diagnostic or entry. */
  terminalLine?: () => string;
};
type SinkFailureReporter = (report: SinkFailureReport) => void;

interface RoutingRecord {
  /**
   * Weak, so a sink that outlives its owner does not keep it alive. The unsubscribe
   * function an owner holds is what keeps its subscription reachable; an owner dropped
   * without unsubscribing is collected, and its entry is pruned on the next report.
   */
  reporters?: Set<WeakRef<SinkFailureReporter>>;
  isDiagnostic?: boolean;
}

// Keep associations off caller-owned objects, including frozen sinks and proxies.
// Bundled copies share both ownership and terminal-entry identity in the same realm.
const STATE_KEY = Symbol.for('lifecycleion.sinkFailureRouting.v1');
const state = getSharedState();

function getSharedState(): WeakMap<object, RoutingRecord> {
  const fallback = new WeakMap<object, RoutingRecord>();
  try {
    // Read as a data property, so a global accessor in the slot is never invoked.
    const existing: unknown = Object.getOwnPropertyDescriptor(
      globalThis,
      STATE_KEY,
    )?.value;
    if (existing instanceof WeakMap) {
      return existing as WeakMap<object, RoutingRecord>;
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

/**
 * Associate one owner with a sink without inspecting or modifying the sink.
 *
 * The returned function is what keeps the registration alive: the sink holds it only
 * weakly, so an owner that drops the function without calling it stops receiving reports
 * once it is collected.
 */
export function registerSinkFailureReporter(
  sink: LogSink,
  reporter: SinkFailureReporter,
): () => void {
  let record = state.get(sink);
  if (record === undefined) {
    record = {};
    state.set(sink, record);
  }
  const reporters = (record.reporters ??= new Set());
  // Each registration has its own lifetime, even when callbacks are equal.
  let subscription: SinkFailureReporter | undefined = (report) =>
    reporter(report);
  const reference = new WeakRef(subscription);
  reporters.add(reference);
  return () => {
    reporters.delete(reference);
    subscription = undefined;
  };
}

/** Return true when the sink has a live owner, even if an owner's reporter fails. */
export function reportSinkFailure(
  sink: LogSink,
  report: SinkFailureReport,
): boolean {
  const reporters = state.get(sink)?.reporters;
  if (reporters === undefined) {
    return false;
  }
  // Registration changes during a report apply to later failures.
  const snapshot: SinkFailureReporter[] = [];
  for (const reference of Array.from(reporters)) {
    const reporter = reference.deref();
    if (reporter === undefined) {
      reporters.delete(reference);
    } else {
      snapshot.push(reporter);
    }
  }
  for (const reporter of snapshot) {
    reportThroughHandler(
      () => reporter(report),
      report.terminalLine ?? (() => report.message),
    );
  }
  return snapshot.length > 0;
}

/** Mark the exact entry passed to a sink so delayed failures remain terminal. */
export function markDiagnosticEntry(entry: LogEntry): LogEntry {
  let record = state.get(entry);
  if (record === undefined) {
    record = {};
    state.set(entry, record);
  }
  record.isDiagnostic = true;
  return entry;
}

export function isDiagnosticEntry(entry: LogEntry | undefined): boolean {
  if (entry === undefined) {
    return false;
  }
  return state.get(entry)?.isDiagnostic === true;
}
