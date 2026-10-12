import type { LogEntry, LoggerDiagnostic } from '../types';
import { markDiagnosticEntry } from './sink-failure-routing';

/** Turn a diagnostic into an entry without re-running logger formatting. */
export function diagnosticEntry(diagnostic: LoggerDiagnostic): LogEntry {
  return markDiagnosticEntry({
    timestamp: diagnostic.timestamp,
    type: 'error',
    template: diagnostic.message,
    message: diagnostic.message,
    tags: ['lifecycleion-diagnostic'],
  });
}
