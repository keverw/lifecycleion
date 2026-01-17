/**
 * Log level types
 */
export type LogType = 'error' | 'info' | 'warn' | 'success' | 'note' | 'raw';

/**
 * Complete log entry that gets passed to sinks
 */
export interface LogEntry {
  timestamp: number;
  type: LogType;
  serviceName: string;
  template: string; // Original template: "User {{userID}} logged in"
  message: string; // Computed: "User 456 logged in"
  params?: Record<string, unknown>; // Raw params: { userID: 456, password: 'secret' }
  redactedParams?: Record<string, unknown>; // Redacted params: { userID: 456, password: '***' }
  redactedKeys?: string[]; // List of keys that were redacted (e.g., ['password', 'user.apiKey'])
  error?: unknown; // Original error object from errorObject() calls
  exitCode?: number; // Exit code if this log triggers a process exit
}

/**
 * Sink interface - all sinks must implement this
 */
export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
  close?(): void | Promise<void>;
}

/**
 * Redaction function type
 */
export type RedactFunction = (keyName: string, value: unknown) => unknown;

/**
 * Array log transformer function type.
 * Receives a log entry and returns either a transformed entry or false to keep the original.
 */
export type ArrayLogTransformer = (entry: LogEntry) => LogEntry | false;

/**
 * Main logger configuration options
 */
export interface LoggerOptions {
  // Output destinations
  sinks?: LogSink[];

  // Security
  redactedKeys?: string[];
  redactFunction?: RedactFunction;

  // Behavior
  callProcessExit?: boolean;
  beforeExitCallback?: (
    exitCode: number,
    isFirstExit: boolean,
  ) => void | Promise<void>;
  onSinkError?: (
    error: Error,
    context: 'write' | 'close',
    sink: LogSink,
  ) => void;
}

/**
 * Logger event types
 */
export interface LoggerEventMap {
  log: {
    eventType: 'log';
    logType: LogType;
    message: string;
    timestamp: number;
  };
  'exit-called': {
    eventType: 'exit-called';
    code: number;
    isFirstExit: boolean;
  };
  'exit-process': {
    eventType: 'exit-process';
    code: number;
  };
  uncaughtException: {
    eventType: 'uncaughtException';
    error: Error;
  };
  close: {
    eventType: 'close';
  };
}

export type LoggerEvent = LoggerEventMap[keyof LoggerEventMap];
