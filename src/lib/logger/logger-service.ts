import type { LogType, LogOptions } from './types';
import type { HandleLogOptions } from './internal-types';

/**
 * LoggerService for scoped logging with service names
 */
export class LoggerService {
  private handleLog: (
    type: LogType,
    template: string,
    options?: HandleLogOptions,
  ) => void;
  /**
   * Renders an error for `errorObject`, supplied by the `Logger` that made this.
   *
   * Handed down rather than called here, so a service logger masks with the logger's own
   * `redactFunction` and reports a redaction failure to its `onRedactionError`. Calling
   * the shared helper directly instead left this the one surface that rendered an error
   * with the library defaults - masking differently from the same logger's `errorObject`
   * and from its params, and writing failures to the console the caller had replaced.
   */
  private renderErrorObject: (prefix: string, error: unknown) => string;
  private serviceName: string;
  private entityName?: string;

  constructor(
    handleLog: (
      type: LogType,
      template: string,
      options?: HandleLogOptions,
    ) => void,
    renderErrorObject: (prefix: string, error: unknown) => string,
    serviceName: string,
    entityName?: string,
  ) {
    this.handleLog = handleLog;
    this.renderErrorObject = renderErrorObject;
    this.serviceName = serviceName;
    this.entityName = entityName;
  }

  /**
   * Create a scoped logger for a specific entity within this service
   */
  public entity(entityName: string): LoggerService {
    return new LoggerService(
      this.handleLog,
      this.renderErrorObject,
      this.serviceName,
      entityName,
    );
  }

  /**
   * Log an error message
   */
  public error(message: string, options?: LogOptions): void {
    this.handleLog('error', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
    });
  }

  /**
   * Log an error object with optional prefix
   */
  public errorObject(
    prefix: string,
    error: unknown,
    options?: LogOptions,
  ): void {
    const message = this.renderErrorObject(prefix, error);

    this.handleLog('error', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
      error,
    });
  }

  /**
   * Log an informational message
   */
  public info(message: string, options?: LogOptions): void {
    this.handleLog('info', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
    });
  }

  /**
   * Log a warning message
   */
  public warn(message: string, options?: LogOptions): void {
    this.handleLog('warn', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
    });
  }

  /**
   * Log a success message
   */
  public success(message: string, options?: LogOptions): void {
    this.handleLog('success', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
    });
  }

  /**
   * Log a notice message
   */
  public notice(message: string, options?: LogOptions): void {
    this.handleLog('notice', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
    });
  }

  /**
   * Log a debug message
   */
  public debug(message: string, options?: LogOptions): void {
    this.handleLog('debug', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
    });
  }

  /**
   * Log a raw message without any formatting
   */
  public raw(message: string, options?: LogOptions): void {
    this.handleLog('raw', message, {
      ...(options ?? {}),
      serviceName: this.serviceName,
      entityName: this.entityName,
    });
  }
}
