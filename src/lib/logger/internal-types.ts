/**
 * Internal types used by Logger and LoggerService
 * These are not part of the public API
 */

import type { LogOptions } from './types';

/**
 * Internal options for handleLog method
 * Extends LogOptions with internal-only fields
 */
export interface HandleLogOptions extends LogOptions {
  serviceName?: string;
  entityName?: string;
  error?: unknown;
}
