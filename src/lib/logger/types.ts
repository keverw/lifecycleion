/**
 * Log level enum for filtering logs by severity
 * Lower numbers = more important/higher priority
 * Higher numbers = less important/lower priority
 */
export enum LogLevel {
  ERROR = 0,
  WARN = 1,
  NOTICE = 2, // Normal but significant condition
  SUCCESS = 3,
  // eslint-disable-next-line @typescript-eslint/no-duplicate-enum-values
  INFO = 3, // Same level as SUCCESS (routine operational info)
  DEBUG = 4,
  RAW = 99,
}

/**
 * Log level types
 */
export type LogType =
  | 'error'
  | 'info'
  | 'warn'
  | 'success'
  | 'notice'
  | 'debug'
  | 'raw';

/**
 * Maps a LogType to its corresponding LogLevel
 */
export function getLogLevel(type: LogType): LogLevel {
  switch (type) {
    case 'error':
      return LogLevel.ERROR;
    case 'warn':
      return LogLevel.WARN;
    case 'notice':
      return LogLevel.NOTICE;
    case 'success':
      return LogLevel.SUCCESS;
    case 'info':
      return LogLevel.INFO;
    case 'debug':
      return LogLevel.DEBUG;
    case 'raw':
      return LogLevel.RAW;
  }
}

/**
 * Options for log methods
 */
export interface LogOptions {
  exitCode?: number;
  params?: Record<string, unknown>;
  tags?: string[];
  redactedKeys?: string[];
}

/**
 * Complete log entry that gets passed to sinks
 */
export interface LogEntry {
  timestamp: number;
  type: LogType;
  serviceName?: string; // Service name (if using service logger)
  entityName?: string; // Optional entity identifier (e.g., 'audio-component-123', 'door-main', UUID)
  template: string; // Original template: "User {{userID}} logged in"
  message: string; // Computed: "User 456 logged in"
  params?: Record<string, unknown>; // Raw params: { userID: 456, password: 'secret' }
  redactedParams?: Record<string, unknown>; // Redacted params: { userID: 456, password: '***' }
  redactedKeys?: string[]; // List of keys that were redacted (e.g., ['password', 'user.apiKey'])
  error?: unknown; // Original error object from errorObject() calls
  exitCode?: number; // Exit code if this log triggers a process exit
  tags?: string[]; // Optional tags for categorizing/filtering logs (e.g., ['auth', 'security'])
}

/**
 * Sink interface - all sinks must implement this
 */
export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
  close?(): void | Promise<void>;
}

/**
 * Result from beforeExit callback indicating whether to proceed with exit
 */
export interface BeforeExitResult {
  /**
   * Whether to proceed with the exit
   * - 'proceed': Continue with process exit
   * - 'wait': Shutdown is already in progress, wait for it to complete
   */
  action: 'proceed' | 'wait';
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
  redactFunction?: RedactFunction;

  // Behavior
  callProcessExit?: boolean;
  beforeExitCallback?: (
    exitCode: number,
    isFirstExit: boolean,
  ) => BeforeExitResult | Promise<BeforeExitResult>;
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
