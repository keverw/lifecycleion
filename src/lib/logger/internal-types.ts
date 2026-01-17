/**
 * Internal types used by Logger and LoggerService
 * These are not part of the public API
 */

/**
 * Internal options for handleLog method
 */
export interface HandleLogOptions {
  exitCode?: number;
  serviceName?: string;
  params?: Record<string, unknown>;
  error?: unknown;
}
