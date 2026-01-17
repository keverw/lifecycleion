import type { LogType } from './types';
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

  constructor(
    handleLog: (
      type: LogType,
      template: string,
      options?: HandleLogOptions,
    ) => void,
    serviceName: string,
  ) {
    this.handleLog = handleLog;
    this.serviceName = serviceName;
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
      serviceName: this.serviceName,
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
      serviceName: this.serviceName,
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
      serviceName: this.serviceName,
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
      serviceName: this.serviceName,
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
      serviceName: this.serviceName,
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
      serviceName: this.serviceName,
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
      serviceName: this.serviceName,
      params: options?.params,
    });
  }
}
