import type { RedactValueFunction } from '../internal/default-redact-function';

// Re-exported, not merely imported: it is half of what a `redactFunction` may return, so
// a caller cannot annotate one without it.
export type { RedactMaskConfig } from '../internal/default-redact-function';
export type {
  FormatErrorHandler,
  FormatFailureKind,
} from '../internal/format-reporter';
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
   *
   * **Not an independent copy, and not a snapshot.** The bag itself is always a fresh
   * object - what a sink can read is exactly what redaction walked - but copies below it
   * are built only along the branches that lead to a mask, which is what keeps a `Date`,
   * an `Error`, or a `URL` logged beside a secret from being flattened. Everything the
   * walk did not touch is therefore the caller's own object, by reference.
   *
   * Two consequences for a sink:
   *
   * - **Do not write into it.** Adding or replacing a top-level field is safe, since the
   *   bag belongs to the entry, but a sink or transformer that normalizes a value *in
   *   place* writes into the caller's own object. Build your own instead.
   * - **Read it before you await.** A caller reusing one params object across log calls
   *   is ordinary, and an unmasked subtree reflects whatever that object holds at the
   *   moment you read it, not at the moment the entry was created. Serialize
   *   synchronously, or take your own copy first - `FileSink` and `NamedPipeSink` render
   *   the line in `write()` and queue the string for this reason.
   *
   * The masked values themselves are fresh strings and are never affected by either.
   */
  redactedParams?: Record<string, unknown>; // Present when redaction is configured: { userID: 456, password: '***' }
  redactedKeys?: string[]; // List of keys that were redacted (e.g., ['password', 'user.apiKey'])
  error?: unknown; // Original error object from errorObject() calls
  /**
   * Exit code this log requested, normalized as `exit()` normalizes it: an invalid code
   * for a real exit reads 1. This is the request, not the outcome. Overlapping exits,
   * real or simulated, settle on one code while an exit is pending: the last non-zero
   * request wins, a request with code 0 never downgrades a pending failure, and nothing
   * changes the code once `exit-process` has fired. That holds for an absorbed request
   * too (an `exit-called` listener's exit, or one `beforeExitCallback` answers
   * `{ action: 'wait' }` for). Read `logger.exitCode` or the `exit-process` event for the
   * code the exit uses.
   */
  exitCode?: number;
  tags?: string[]; // Optional tags for categorizing/filtering logs (e.g., ['auth', 'security'])
}

/**
 * Sink interface - all sinks must implement this
 */
export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
  /**
   * Write a failure raised by the logging system itself.
   *
   * The logger calls this directly, outside its normal formatting and event path. A sink
   * that does not implement it receives an already-rendered diagnostic through `write()`
   * instead. A failure here falls straight to the guarded console rung; it never creates
   * another diagnostic. The sink that raised a diagnostic is excluded from its
   * destinations, including when it appears in both sink lists.
   */
  writeDiagnostic?(diagnostic: LoggerDiagnostic): void | Promise<void>;
  close?(): void | Promise<void>;
}

export type LoggerDiagnosticKind =
  'sink' | 'event-handler' | 'redaction' | 'render';

/** A failure raised while the logger itself was formatting, emitting, or writing. */
export interface LoggerDiagnostic {
  timestamp: number;
  kind: LoggerDiagnosticKind;
  error: Error;
  /**
   * Guardedly rendered text suitable for the fallback `LogEntry`.
   *
   * Safe to persist. With no `diagnosticSinks` configured this string is written to the
   * ordinary log sinks, so it names *what* failed and *where* but never interpolates the
   * thrown value: a `redaction` failure's cause is derived from the secret being masked,
   * and a message carrying it would route around the masking on the line above it.
   *
   * Read {@link LoggerDiagnostic.error} for the cause. It is handed to every
   * `'diagnostic'` listener and every sink implementing `writeDiagnostic`, which is where
   * a caller decides for itself whether that text may be written down.
   */
  message: string;
  context?: 'write' | 'close';
  /** Source of a sink failure, excluded from that diagnostic's destinations. */
  sink?: LogSink;
  event?: string;
  path?: string;
}

/**
 * Result from beforeExit callback indicating whether to proceed with exit
 */
export interface BeforeExitResult {
  /**
   * Whether to proceed with the exit
   * - 'proceed': Continue with process exit
   * - 'wait': Shutdown is already in progress, wait for it to complete. The request's
   *   code still counts: a non-zero code replaces the pending exit's code until that
   *   exit publishes `exit-process`.
   */
  action: 'proceed' | 'wait';
}

/**
 * What a `redactFunction` may return, and the function itself.
 *
 * Both are the shared definitions, re-exported under the logger's own names so a single
 * change to the contract reaches every entry point. See {@link RedactFunctionResult} for
 * the return values and what each one signals.
 *
 * Values are stringified before they are passed to the redaction function, so `value` is
 * always a `string` whatever it started as.
 *
 * A `string` is the replacement, used as-is; to render a literal null, return the string.
 * Everything else is a control signal rather than a replacement value. Return `null` to
 * defer to the default masking for that value, so a caller can special-case a few keys
 * without reproducing the default for the rest. **Returning nothing defers the same way:**
 * `undefined` is treated exactly as `null`, so a function that returns nothing for the
 * keys it does not handle masks them rather than dropping them or writing the word
 * `undefined` into the output.
 *
 * The same shape and the same deferral rules apply to `errorToString`'s `redactFunction`
 * option, so one function can serve both.
 */
export type {
  RedactFunctionResult,
  RedactValueFunction as RedactFunction,
} from '../internal/default-redact-function';

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

  /**
   * Optional destinations for logger diagnostics. When absent or empty, diagnostics are
   * offered to the regular `sinks` instead.
   */
  diagnosticSinks?: LogSink[];

  // Security
  redactFunction?: RedactValueFunction;

  // Behavior
  callProcessExit?: boolean;
  /**
   * Maximum time `close()` waits for all owned sinks together, in milliseconds.
   * Defaults to 60,000. Zero waits through the current microtasks only; Infinity
   * and larger values are bounded by the longest usable timer delay. Invalid
   * values throw during construction: TypeError for NaN/non-numbers, RangeError
   * for negatives. Null or undefined uses the default. A deadline reports
   * still-pending sink cleanup as unconfirmed and lets the logger finish closing.
   * This cap overrides longer sink close budgets; exit() may then terminate with
   * buffered output unflushed. Raise this budget too when a sink needs more time.
   */
  closeTimeoutMS?: number | null;
  beforeExitCallback?: (
    exitCode: number,
    isFirstExit: boolean,
  ) => BeforeExitResult | Promise<BeforeExitResult>;
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
  'exit-completed': {
    eventType: 'exit-completed';
    code: number;
    endedProcess: boolean;
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
