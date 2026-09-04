import type { RedactMaskConfig } from '../internal/default-redact-function';
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
  'error' | 'info' | 'warn' | 'success' | 'notice' | 'debug' | 'raw';

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
  message: string; // Computed message: "User 456 logged in"
  /**
   * The caller's own params object, by reference and never redacted.
   *
   * An escape hatch for a sink that needs the real values. A sink that writes anywhere
   * the values could outlive the process should read `redactedParams ?? params` instead,
   * or a redacted log line still ships the secret.
   */
  params?: Record<string, unknown>; // Raw params: { userID: 456, password: 'secret' }
  /**
   * `params` with every configured `redactedKeys` path masked, and nothing else changed.
   * Present only when redaction is configured.
   */
  redactedParams?: Record<string, unknown>; // Present when redaction is configured: { userID: 456, password: '***' }
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
 * Redaction function type.
 *
 * Values are stringified before they are passed to the redaction function.
 */
/**
 * Produces the replacement for a redacted value.
 *
 * Return `null` to defer to the default masking for that value, so a caller can
 * special-case a few keys without reproducing the default for the rest. To render a
 * literal null, return the string. Returning nothing is not a deferral: `undefined` is
 * used literally and drops the value.
 *
 * The same shape and the same deferral rule apply to `errorToString`'s `redactFunction`
 * option, so one function can serve both.
 */
/**
 * What a `redactFunction` may return.
 *
 * A **string** is the answer in the ordinary case: the function is handed one
 * already-stringified leaf and hands back the text that stands in for it. The rest are
 * control signals rather than replacement values - ways of saying "you do the masking":
 *
 * - `null` - use the default masking
 * - a `number` - use the default masking at that percent, shorthand for `{ percent: n }`
 * - a {@link RedactMaskConfig} - use the library's masking with these settings
 * - `undefined` - drop the value, which is what a function that returns nothing does
 *
 * An object is therefore always read as a masking request, never as a replacement. One
 * that is not a usable request - `{}`, an unrecognized key, a mixture - falls back to the
 * default masking rather than being emitted, so a rendered `{"note":"x"}` can never stand
 * where a masked value belonged.
 */
export type RedactFunctionResult =
  string | number | RedactMaskConfig | null | undefined;

export type RedactFunction = (
  keyName: string,
  value: string,
) => RedactFunctionResult;

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

  /**
   * Handle a failure thrown or rejected by one of this logger's own `'logger'` event
   * handlers. Defaults to `console.error`.
   *
   * These cannot be logged: logging emits a `'logger'` event, so reporting a handler's
   * failure through the logger would emit again and cycle without end. They are kept off
   * the global `'error'` channel for the same reason. If this callback itself throws, the
   * failure falls back to `console.error`.
   *
   * Do not call this logger's own log methods from here.
   */
  onEventHandlerError?: (error: Error, event: string) => void;
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
