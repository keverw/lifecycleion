/**
 * LifecycleManager - Comprehensive lifecycle orchestration system
 *
 * Manages startup, shutdown, and runtime control of application components with:
 * - Multi-phase shutdown (global warning -> per-component graceful -> force)
 * - Dependency-ordered component startup
 * - Process signal integration (SIGINT, SIGTERM, SIGHUP, etc.)
 * - Component messaging and value sharing
 * - Health checks and monitoring
 * - Event-driven architecture
 *
 * @module lifecycle-manager
 */

// Core classes
export { LifecycleManager } from './lifecycle-manager';
export { BaseComponent } from './base-component';
export {
  LifecycleManagerEvents,
  type LifecycleManagerEventMap,
  type LifecycleManagerEventName,
  type LifecycleManagerEmit,
} from './events';

// Types
export type {
  ComponentOptions,
  ComponentState,
  ComponentStatus,
  ComponentStallInfo,
  ShutdownMethod,
  BaseOperationResult,
  ComponentOperationResult,
  ComponentOperationFailureCode,
  StartComponentOptions,
  StopComponentOptions,
  RestartComponentOptions,
  UnregisterComponentResult,
  UnregisterFailureCode,
  StartupResult,
  ShutdownResult,
  RestartResult,
  MessageResult,
  SendMessageOptions,
  BroadcastResult,
  BroadcastOptions,
  ComponentHealthResult,
  HealthCheckResult,
  HealthReport,
  SignalBroadcastResult,
  ComponentSignalResult,
  ValueResult,
  SystemState,
  RegisterOptions,
  UnregisterOptions,
  StartupOptions,
  InsertPosition,
  RegistrationFailureCode,
  StartupOrderFailureCode,
  StartupOrderResult,
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
  ComponentStartTimeoutError,
  ComponentStopTimeoutError,
  StartupTimeoutError,
  ComponentNotFoundError,
  lifecycleManagerErrPrefix,
  lifecycleManagerErrTypes,
  lifecycleManagerErrCodes,
} from './errors';
