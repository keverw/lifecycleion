import type { LogType, LogOptions } from './types';
import type { HandleLogOptions } from './internal-types';
import { prepareErrorObjectLog } from './utils/error-object';

/**
 * LoggerService for scoped logging with service names
 */
export class LoggerService {
  private handleLog: (
    type: LogType,
    template: string,
    options?: HandleLogOptions,
  ) => void;
  private serviceName: string;
  private entityName?: string;

  constructor(
    handleLog: (
      type: LogType,
      template: string,
      options?: HandleLogOptions,
    ) => void,
    serviceName: string,
    entityName?: string,
  ) {
    this.handleLog = handleLog;
    this.serviceName = serviceName;
    this.entityName = entityName;
  }

  /**
   * Create a scoped logger for a specific entity within this service
   */
  public entity(entityName: string): LoggerService {
    return new LoggerService(this.handleLog, this.serviceName, entityName);
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
    const message = prepareErrorObjectLog(prefix, error);

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
   * Log a note message
   */
  public note(message: string, options?: LogOptions): void {
    this.handleLog('note', message, {
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
