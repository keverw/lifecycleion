import type { ArrayLogTransformer, LogEntry, LogSink } from '../types';

/**
 * ArraySink stores logs in memory for testing and debugging
 */
export class ArraySink implements LogSink {
  public logs: LogEntry[] = [];
  private transformer?: ArrayLogTransformer;
  private closed = false;

  constructor(options?: { transformer?: ArrayLogTransformer }) {
    this.transformer = options?.transformer;
  }

  public write(entry: LogEntry): void {
    if (this.closed) {
      return;
    }

    if (this.transformer) {
      try {
        const transformed = this.transformer(entry);

        if (transformed !== false) {
          // Store the transformed entry
          this.logs.push(transformed);
          return;
        }
      } catch {
        // If transformer fails, fall through to store original entry
      }
    }
    // Store the original entry
    this.logs.push(entry);
  }

  /**
   * Clear all stored logs
   */
  public clear(): void {
    this.logs = [];
  }

  /**
   * Get logs in a snapshot-friendly format for testing
   */
  public getSnapshotFriendlyLogs(): string[] {
    return this.logs.map((log) => `${log.type}: ${log.message}`);
  }

  /**
   * Close the sink and stop accepting new logs
   */
  public close(): void {
    this.closed = true;
  }
}
