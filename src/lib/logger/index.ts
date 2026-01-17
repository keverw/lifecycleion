import { EventEmitter } from '../event-emitter';
import { ms } from '../unix-time-helpers';
import { safeHandleCallbackAndWait } from '../safe-handle-callback';
import { CurlyBrackets } from '../curly-brackets';
import { isNumber } from '../is-number';
import { isPromise } from '../is-promise';
import type { LogEntry, LogSink, LogType, LoggerOptions } from './types';
import type { HandleLogOptions } from './internal-types';
import { ArraySink } from './sinks/array';
import { ConsoleSink } from './sinks/console';
import { applyRedaction } from './utils/redaction';
import { prepareErrorObjectLog } from './utils/error-object';
import { LoggerService } from './logger-service';

/**
 * Main Logger class with sink-based architecture and EventEmitter support
 */
export class Logger extends EventEmitter {
  public readonly isLoggerClass = true;

  private sinks: LogSink[];
  private redactedKeys?: string[];
  private redactFunction?: (key: string, value: unknown) => unknown;
  private callProcessExit: boolean;
  private beforeExitCallback?: (
    exitCode: number,
    isFirstExit: boolean,
  ) => void | Promise<void>;
  private onSinkError?: (
    error: Error,
    context: 'write' | 'close',
    sink: LogSink,
  ) => void;

  private _didExit = false;
  private _exitCode: number = 0;
  private _exitRequested = false;
  private _isPendingExit = false;
  private _closed = false;

  private _reportErrorListenerRegistered = false;
  private _reportErrorListener: ((event: Event) => void) | null = null;

  constructor(options: LoggerOptions = {}) {
    super();

    this.sinks = options.sinks || [];
    this.redactedKeys = options.redactedKeys;
    this.redactFunction = options.redactFunction;
    this.callProcessExit = options.callProcessExit ?? true;
    this.beforeExitCallback = options.beforeExitCallback;
    this.onSinkError = options.onSinkError;
  }

  public get didExit(): boolean {
    return this._didExit;
  }

  public get exitCode(): number {
    return this._exitCode;
  }

  public get isPendingExit(): boolean {
    return this._isPendingExit;
  }

  public get hasExitedOrPending(): boolean {
    return this._didExit || this._isPendingExit;
  }

  public get closed(): boolean {
    return this._closed;
  }

  /**
   * Exit the process with the specified code
   */
  public exit(code: number): void {
    const isFirstExit = !this._exitRequested;
    this._exitRequested = true;

    if (!this._didExit) {
      this._isPendingExit = true;
    }

    this.emit('logger', { eventType: 'exit-called', code, isFirstExit });

    if (this.beforeExitCallback) {
      safeHandleCallbackAndWait(
        'beforeExit',
        this.beforeExitCallback,
        code,
        isFirstExit,
      )
        // If the callback fails, we still want to exit either way,
        // but want to give it a chance to finish if it doesn't throw an error
        .then(() => {
          this.processExit(code);
        })
        .catch(() => {
          this.processExit(code);
        });
    } else {
      this.processExit(code);
    }
  }

  /**
   * Log an error message
   */
  public error(
    message: string,
    options?: { exitCode?: number; params?: Record<string, unknown> },
  ): void {
    this.handleLog('error', message, {
      exitCode: options?.exitCode,
      params: options?.params,
    });
  }

  /**
   * Log an error object with optional prefix
   */
  public errorObject(
    prefix: string,
    error: unknown,
    options?: { exitCode?: number; params?: Record<string, unknown> },
  ): void {
    const message = prepareErrorObjectLog(prefix, error);

    this.handleLog('error', message, {
      exitCode: options?.exitCode,
      params: options?.params,
      error,
    });
  }

  /**
   * Log an informational message
   */
  public info(
    message: string,
    options?: { exitCode?: number; params?: Record<string, unknown> },
  ): void {
    this.handleLog('info', message, {
      exitCode: options?.exitCode,
      params: options?.params,
    });
  }

  /**
   * Log a warning message
   */
  public warn(
    message: string,
    options?: { params?: Record<string, unknown> },
  ): void {
    this.handleLog('warn', message, {
      params: options?.params,
    });
  }

  /**
   * Log a success message
   */
  public success(
    message: string,
    options?: { exitCode?: number; params?: Record<string, unknown> },
  ): void {
    this.handleLog('success', message, {
      exitCode: options?.exitCode,
      params: options?.params,
    });
  }

  /**
   * Log a note message
   */
  public note(
    message: string,
    options?: { exitCode?: number; params?: Record<string, unknown> },
  ): void {
    this.handleLog('note', message, {
      exitCode: options?.exitCode,
      params: options?.params,
    });
  }

  /**
   * Log a raw message without any formatting
   */
  public raw(
    message: string,
    options?: { exitCode?: number; params?: Record<string, unknown> },
  ): void {
    this.handleLog('raw', message, {
      exitCode: options?.exitCode,
      params: options?.params,
    });
  }

  /**
   * Create a scoped logger with a service name
   */
  public service(serviceName: string): LoggerService {
    return new LoggerService(this.handleLog.bind(this), serviceName);
  }

  /**
   * Registers a listener for the 'reportError' event.
   *
   * If the listener is already registered, it returns 'already_registered'.
   * If 'globalThis.reportError' is not available, it returns 'not_available'.
   * Otherwise, it registers the listener and returns 'success'.
   *
   * @param prefix - The prefix to use when logging the error object. Default is 'Uncaught exception'.
   * @returns 'success' if the listener is registered successfully,
   *          'already_registered' if the listener is already registered,
   *          'not_available' if 'globalThis.reportError' is not available.
   */

  public registerReportErrorListener(
    prefix: string = 'Uncaught exception',
  ): 'success' | 'already_registered' | 'not_available' {
    if (this._reportErrorListenerRegistered) {
      return 'already_registered';
    }

    if (typeof globalThis.reportError === 'undefined') {
      return 'not_available';
    }

    this._reportErrorListener = (event: Event): void => {
      const errorEvent = event as ErrorEvent;
      this.errorObject(prefix, errorEvent.error);
      this.emit('logger', {
        eventType: 'uncaughtException',
        error: errorEvent.error as unknown,
      });
    };

    globalThis.addEventListener('reportError', this._reportErrorListener);
    this._reportErrorListenerRegistered = true;

    return 'success';
  }

  /**
   * Unregister the listener for the 'reportError' event.
   *
   * If the listener is not registered, it returns 'not_registered'.
   * Otherwise, it unregister the listener and returns 'success'.
   *
   * @returns 'success' if the listener is unregistered successfully,
   *          'not_registered' if the listener is not registered.
   */

  public unregisterReportErrorListener(): 'success' | 'not_registered' {
    if (!this._reportErrorListenerRegistered || !this._reportErrorListener) {
      return 'not_registered';
    }

    globalThis.removeEventListener('reportError', this._reportErrorListener);

    this._reportErrorListener = null;
    this._reportErrorListenerRegistered = false;

    return 'success';
  }

  /**
   * Check if the 'reportError' event listener is registered
   *
   * @returns 'true' if the listener is registered, 'false' otherwise.
   */
  public isReportErrorListenerRegistered(): boolean {
    return this._reportErrorListenerRegistered;
  }

  /**
   * Check if 'globalThis.reportError' is available
   *
   * @returns 'true' if 'globalThis.reportError' is available, 'false' otherwise.
   */
  public isReportErrorAvailable(): boolean {
    return typeof globalThis.reportError !== 'undefined';
  }

  /**
   * Add a sink to the logger
   */
  public addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  /**
   * Remove a sink from the logger
   * Returns true if the sink was found and removed, false otherwise
   */
  public removeSink(sink: LogSink): boolean {
    const index = this.sinks.indexOf(sink);
    if (index !== -1) {
      this.sinks.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get a readonly copy of the current sinks
   */
  public getSinks(): readonly LogSink[] {
    return [...this.sinks];
  }

  /**
   * Close all sinks and cleanup resources
   * After closing, the logger is marked as closed and all sinks are removed
   */
  public async close(): Promise<void> {
    this._closed = true;

    // Close all sinks
    await Promise.all(
      this.sinks.map(async (sink) => {
        if (sink.close) {
          try {
            await sink.close();
          } catch (error) {
            this.handleSinkError(error as Error, 'close', sink);
          }
        }
      }),
    );

    // Remove all sinks from the array after closing
    this.sinks = [];

    this.emit('logger', { eventType: 'close' });
  }

  /**
   * Create a logger optimized for testing.
   * Includes an ArraySink by default for easy log inspection.
   * Process exit is disabled to prevent tests from terminating.
   */
  public static createTestOptimizedLogger(options?: {
    sinks?: LogSink[];
    redactedKeys?: string[];
    arrayLogTransformer?: (entry: LogEntry) => LogEntry | false;
    includeConsoleSink?: boolean;
    muteConsole?: boolean;
  }): { logger: Logger; arraySink: ArraySink; consoleSink?: ConsoleSink } {
    const arraySink = new ArraySink({
      transformer: options?.arrayLogTransformer,
    });

    const consoleSink = options?.includeConsoleSink
      ? new ConsoleSink({ muted: options?.muteConsole ?? true })
      : undefined;

    const sinks: LogSink[] = [arraySink];

    if (consoleSink) {
      sinks.push(consoleSink);
    }

    sinks.push(...(options?.sinks || []));

    return {
      logger: new Logger({
        sinks,
        callProcessExit: false,
        redactedKeys: options?.redactedKeys,
      }),
      arraySink,
      consoleSink,
    };
  }

  /**
   * Create a logger optimized for frontend/browser use.
   * Includes a ConsoleSink by default for browser devtools output.
   * Process exit is disabled since browsers don't have process.exit.
   */
  public static createFrontendOptimizedLogger(options?: {
    sinks?: LogSink[];
    redactedKeys?: string[];
    muteConsole?: boolean;
  }): { logger: Logger; consoleSink: ConsoleSink } {
    const consoleSink = new ConsoleSink({
      muted: options?.muteConsole ?? false,
    });

    return {
      logger: new Logger({
        sinks: [consoleSink, ...(options?.sinks || [])],
        callProcessExit: false,
        redactedKeys: options?.redactedKeys,
      }),
      consoleSink,
    };
  }

  /**
   * Internal method to handle all log operations
   */
  protected handleLog(
    type: LogType,
    template: string,
    options?: HandleLogOptions,
  ): void {
    // Don't log if logger is closed
    if (this._closed) {
      return;
    }

    const timestamp = ms();

    // Extract options
    const exitCode = options?.exitCode;
    const serviceName = options?.serviceName?.trim() || '';
    const params = options?.params;

    // Process template and apply redaction
    const message = params ? CurlyBrackets(template, params) : template;
    const redactedParams = params
      ? applyRedaction(params, this.redactedKeys, this.redactFunction)
      : undefined;

    // Create log entry
    const entry: LogEntry = {
      timestamp,
      type,
      serviceName,
      template,
      message,
      params,
      redactedParams,
      redactedKeys:
        params && this.redactedKeys && this.redactedKeys.length > 0
          ? this.redactedKeys
          : undefined,
      error: options?.error,
      exitCode: isNumber(exitCode) ? exitCode : undefined,
    };

    // Write to all sinks
    for (const sink of this.sinks) {
      try {
        const result = sink.write(entry);
        // Handle async errors from sinks that return promises
        if (isPromise(result)) {
          result.catch((error: unknown) => {
            this.handleSinkError(error as Error, 'write', sink);
          });
        }
      } catch (error) {
        // Handle sync errors
        this.handleSinkError(error as Error, 'write', sink);
      }
    }

    // Emit log event
    this.emit('logger', {
      eventType: 'log',
      logType: type,
      message,
      timestamp,
    });

    // Handle exit if requested (only if exitCode is a valid number)
    if (isNumber(exitCode)) {
      this.exit(exitCode);
    }
  }

  /**
   * Handle sink errors by calling the onSinkError callback or falling back to console.error
   */
  private handleSinkError(
    error: Error,
    context: 'write' | 'close',
    sink: LogSink,
  ): void {
    if (this.onSinkError) {
      try {
        this.onSinkError(error, context, sink);
      } catch {
        // Ignore errors in the error handler to prevent infinite loops
        // eslint-disable-next-line no-console
        console.error(`Error in onSinkError handler: ${error.message}`);
      }
    } else {
      // Fallback to console.error
      // eslint-disable-next-line no-console
      console.error(
        `Error ${context === 'write' ? 'writing to' : 'closing'} sink: ${error.message}`,
      );
    }
  }

  /**
   * Process the exit
   */
  private processExit(code: number): void {
    this._didExit = true;
    this._exitCode = code;
    this._isPendingExit = false;

    this.emit('logger', { eventType: 'exit-process', code });

    // Close sinks and then exit
    void this.close().finally(() => {
      if (this.callProcessExit) {
        if (
          typeof globalThis.process !== 'undefined' &&
          typeof globalThis.process.exit === 'function'
        ) {
          globalThis.process.exit(code);
        }
      }
    });
  }
}

// Re-export types and sinks
export * from './types';
export * from './sinks';
export type { LoggerService } from './logger-service';
