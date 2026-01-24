/**
 * LifecycleManager - Comprehensive lifecycle orchestration system
 *
 * Manages startup, shutdown, and runtime control of application components with:
 * - Multi-phase shutdown (warning -> graceful -> force)
 * - Dependency-ordered component startup
 * - Process signal integration (SIGINT, SIGTERM, SIGHUP, etc.)
 * - Component messaging and value sharing
 * - Health checks and monitoring
 * - Event-driven architecture
 *
 * @module lifecycle-manager
 */

// Core classes
export { BaseComponent } from './base-component';

// Types
export type {
  ComponentOptions,
  ComponentState,
  ComponentStatus,
  ComponentStallInfo,
  ShutdownMethod,
  ComponentOperationResult,
  StartupResult,
  ShutdownResult,
  RestartResult,
  MessageResult,
  BroadcastResult,
  ComponentHealthResult,
  HealthCheckResult,
  HealthReport,
  SignalBroadcastResult,
  ComponentSignalResult,
  GetValueResult,
  SystemState,
  RegisterOptions,
  UnregisterOptions,
  StartupOptions,
  InsertPosition,
  RegistrationFailureCode,
  RegisterComponentResult,
  InsertComponentAtResult,
  LifecycleManagerOptions,
} from './types';

// Errors
export {
  InvalidComponentNameError,
  ComponentRegistrationError,
  DependencyCycleError,
  MissingDependencyError,
  ComponentStartupError,
  StartupTimeoutError,
  ComponentNotFoundError,
  lifecycleManagerErrPrefix,
  lifecycleManagerErrTypes,
  lifecycleManagerErrCodes,
} from './errors';
