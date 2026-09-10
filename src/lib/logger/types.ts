import type { RedactValueFunction } from '../internal/default-redact-function';
import type { RedactionErrorHandler } from '../internal/redaction-reporter';
import type { RenderErrorHandler } from '../internal/render-reporter';

// Re-exported, not merely imported: it is half of what a `redactFunction` may return, so
// a caller cannot annotate one without it.
export type { RedactMaskConfig } from '../internal/default-redact-function';
export type { RedactionErrorHandler } from '../internal/redaction-reporter';
export type { RenderErrorHandler } from '../internal/render-reporter';
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

  // Security
  redactFunction?: RedactValueFunction;

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

  /**
   * Notified when redaction fails for a param, so a broken `redactFunction` leaves a
   * diagnosis and not only a `***REDACTION FAILED***` marker in the output.
   * Defaults to `console.error`.
   *
   * Deliberately not the global `'error'` channel, for the reason `onEventHandlerError`
   * is not either: a listening logger would log the report, logging renders a message,
   * rendering redacts, and redaction throws again - a cycle no re-entrancy guard closes,
   * since each pass is a fresh turn.
   *
   * Fires at most once per redaction pass. A failure is raised per leaf, so an
   * unconditionally throwing `redactFunction` would otherwise report once for every value
   * inside a named container. The markers left in the output show the full extent; this
   * names the cause. `errorObject()` redacts twice - the error it renders, and the params -
   * so it can report twice, for two genuinely different failures.
   *
   * The error may contain the value: it is your `redactFunction`'s own, and that function
   * was handed the value. The `key` never does.
   *
   * Do not call this logger's own log methods from here.
   */
  onRedactionError?: RedactionErrorHandler;

  /**
   * Notified when a value could not be rendered into a log line, so an `[unrenderable]` or
   * `<unrenderable: ...>` marker leaves a diagnosis and not only a marker.
   * Defaults to discarding.
   *
   * Rendering degrades rather than failing - a value that refuses to be read becomes a
   * marker and the line still goes out, so one bad param never costs you the log entry.
   * That is the right trade and it was also completely silent: a `{{user.token}}` that
   * rendered `(null)` because its accessor threw looked exactly like a typo, and an
   * `additionalInfo` entry behind a revoked `Proxy` looked like a key that was never set.
   * This is where the cause goes.
   *
   * Deliberately not the global `'error'` channel, for the reason `onRedactionError` is
   * not either: a listening logger would log the report, and logging renders, which is
   * what just failed.
   *
   * The error may contain the value - it came from your own getter or `toString`, which
   * were handed it. The `path` never does: it is structural, built from keys the renderer
   * already holds. That asymmetry is why the marker in the log line carries no cause at
   * all; a cause written into the output would travel to every sink past `redactedKeys`.
   *
   * Fires at most once per render. `errorObject()` renders twice - the error, then the
   * message - so it can report twice, for two genuinely different failures.
   *
   * Do not call this logger's own log methods from here.
   */
  onRenderError?: RenderErrorHandler;
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
