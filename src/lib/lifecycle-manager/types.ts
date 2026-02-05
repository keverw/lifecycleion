import type { Logger } from '../logger';
import type { EventEmitterProtected } from '../event-emitter';
import type { ProcessSignalManagerStatus } from '../process-signal-manager';

/**
 * Component configuration options passed to BaseComponent constructor
 */
export interface ComponentOptions {
  /** Unique component name (must be kebab-case) */
  name: string;

  /** Names of components this one depends on (default: []) */
  dependencies?: string[];

  /** If true, startup failure doesn't trigger rollback (default: false) */
  optional?: boolean;

  /** Time to wait for start() in milliseconds (default: 30000, 0 = disabled) */
  startupTimeoutMS?: number;

  /** Time to wait for graceful shutdown in milliseconds (default: 5000, minimum: 1000) */
  shutdownGracefulTimeoutMS?: number;

  /** Time to wait for force shutdown in milliseconds (default: 2000, minimum: 500) */
  shutdownForceTimeoutMS?: number;

  /** Time to wait for healthCheck() in milliseconds (default: 5000) */
  healthCheckTimeoutMS?: number;

  /** Time to wait for onReload/onInfo/onDebug in milliseconds (default: 5000, 0 = disabled) */
  signalTimeoutMS?: number;
}

/**
 * Possible states a component can be in
 */
export type ComponentState =
  | 'registered' // Registered but never started
  | 'starting' // start() in progress
  | 'starting-timed-out' // start() timed out (observability only)
  | 'running' // start() completed successfully
  | 'failed' // Optional component failed to start
  | 'stopping' // stop() in progress (graceful phase)
  | 'force-stopping' // onShutdownForce() in progress
  | 'stopped' // stop() completed (can be restarted)
  | 'stalled'; // Failed to stop within timeout

/**
 * Detailed status information for a component
 */
export interface ComponentStatus {
  /** Component name */
  name: string;

  /** Current state */
  state: ComponentState;

  /** Unix timestamp (ms) when start() completed */
  startedAt: number | null;

  /** Unix timestamp (ms) when stop() completed */
  stoppedAt: number | null;

  /** Last error from start/stop/message */
  lastError: Error | null;

  /** If stalled, details about why */
  stallInfo: ComponentStallInfo | null;
}

/**
 * Information about why a component is stalled
 */
export interface ComponentStallInfo {
  /** Component name */
  name: string;

  /** Which shutdown phase failed */
  phase: 'graceful' | 'force';

  /** Reason for stall */
  reason: 'timeout' | 'error' | 'both';

  /** When shutdown started for this component */
  startedAt: number;

  /** When the stall occurred */
  stalledAt: number;

  /** Error that caused the stall (if applicable) */
  error?: Error;
}

/**
 * How shutdown was triggered
 */
export type ShutdownMethod = 'manual' | 'SIGINT' | 'SIGTERM' | 'SIGTRAP';

/**
 * Base interface for all operation results
 *
 * Provides consistent structure across all operations with common fields
 * for success status, error handling, and optional component status.
 */
export interface BaseOperationResult {
  /** Whether the operation succeeded */
  success: boolean;

  /** Human-readable explanation if !success */
  reason?: string;

  /** Machine-readable failure code if !success */
  code?: string;

  /** Underlying error if applicable */
  error?: Error;

  /** Component status after the operation (if applicable) */
  status?: ComponentStatus;
}

/**
 * Result of an individual component operation (start/stop/restart)
 */
export interface ComponentOperationResult extends BaseOperationResult {
  /** Component name */
  componentName: string;

  /** Machine-readable failure code if !success */
  code?: ComponentOperationFailureCode;
}

/**
 * Options for manually starting a component
 */
export interface StartComponentOptions {
  /**
   * If true, allow dependencies that are registered but not running
   * even when those dependencies are required components (not optional).
   * This is an explicit override that bypasses normal dependency checks.
   */
  allowRequiredDependencies?: boolean;

  /**
   * If true, allow starting a component during bulk startup (startAllComponents).
   * By default, startComponent() is blocked during bulk operations to prevent
   * interference with dependency ordering. However, if the component's dependencies
   * are already running, this option allows you to start it dynamically.
   *
   * Note: Starting during shutdown is NEVER allowed, regardless of this option.
   *
   * Default: false
   */
  allowDuringBulkStartup?: boolean;

  /**
   * If true, force starting this component even if it's stalled without requiring
   * it to be unregistered or retried via stopAllComponents({ retryStalled: true }) first.
   *
   * Default: false
   */
  forceStalled?: boolean;
}

/**
 * Options for manually stopping a component
 */
export interface StopComponentOptions {
  /**
   * If true, force immediate shutdown without graceful period
   * Calls onShutdownForce() directly, bypassing normal stop() flow
   * (default: false)
   */
  forceImmediate?: boolean;

  /**
   * Override the component's configured shutdown timeout in milliseconds
   * If not specified, uses the component's shutdownGracefulTimeoutMS
   * Only applies when forceImmediate is false
   */
  timeout?: number;

  /**
   * If true, allows stopping a component even if other running components depend on it
   * Without this flag, stopping a component with running dependents will fail
   * (default: false)
   */
  allowStopWithRunningDependents?: boolean;
}

/**
 * Options for restarting a component (stop + start)
 *
 * Combines options for both stop and start phases.
 */
export interface RestartComponentOptions {
  /** Options for the stop phase */
  stopOptions?: StopComponentOptions;

  /** Options for the start phase */
  startOptions?: StartComponentOptions;
}

/**
 * Stable, machine-readable failure codes for individual component operations
 */
export type ComponentOperationFailureCode =
  | 'component_not_found'
  | 'component_already_running'
  | 'component_already_starting'
  | 'component_already_stopping'
  | 'component_not_running'
  | 'component_stalled'
  | 'missing_dependency'
  | 'dependency_not_running'
  | 'has_running_dependents'
  | 'startup_in_progress'
  | 'shutdown_in_progress'
  | 'start_timeout'
  | 'stop_timeout'
  | 'restart_stop_failed'
  | 'restart_start_failed'
  | 'unknown_error';

/**
 * Failure codes for unregister operations
 */
export type UnregisterFailureCode =
  | 'component_not_found'
  | 'component_running'
  | 'stop_failed'
  | 'bulk_operation_in_progress';

/**
 * Additional details for why unregister stop failed
 */
export type UnregisterStopFailureReason = 'stalled' | 'timeout' | 'error';

/**
 * Result of unregistering a component
 */
export interface UnregisterComponentResult extends BaseOperationResult {
  /** Component name */
  componentName: string;

  /** Machine-readable failure code if !success */
  code?: UnregisterFailureCode;

  /** More detail when stop_failed occurs */
  stopFailureReason?: UnregisterStopFailureReason;

  /** Whether the component was stopped before unregistering */
  wasStopped: boolean;

  /** Whether the component was found in registry */
  wasRegistered: boolean;
}

/**
 * Result of starting all components
 */
export interface StartupResult {
  /** True if all required components started */
  success: boolean;

  /** Names of components that started successfully */
  startedComponents: string[];

  /** Optional components that failed (app continues) */
  failedOptionalComponents: Array<{
    name: string;
    error: Error;
  }>;

  /** Components skipped because their optional dependency failed */
  skippedDueToDependency: string[];

  /** Present if stalled components blocked startup */
  blockedByStalledComponents?: string[];

  /** Reason for failure (when success is false) */
  reason?: string;

  /** Error code (when success is false) */
  code?:
    | 'already_in_progress'
    | 'shutdown_in_progress'
    | 'dependency_cycle'
    | 'no_components_registered'
    | 'stalled_components_exist'
    | 'startup_timeout'
    | 'unknown_error';

  /** Error object (when success is false due to dependency cycle or unknown error) */
  error?: Error;

  /** Total startup duration in milliseconds */
  durationMS?: number;

  /** Present if startup timed out */
  timedOut?: boolean;
}

/**
 * Result of stopping all components
 */
export interface ShutdownResult {
  /** True if all components stopped cleanly */
  success: boolean;

  /** Names of components that stopped successfully */
  stoppedComponents: string[];

  /** Components that failed to stop */
  stalledComponents: ComponentStallInfo[];

  /** How long shutdown took */
  durationMS: number;

  /** True if shutdown exceeded the timeout and returned partial results */
  timedOut?: boolean;

  /** Reason for failure (when success is false) */
  reason?: string;

  /** Error code (when success is false) */
  code?: 'already_in_progress';
}

/**
 * Options for stopping all components
 */
export interface StopAllOptions {
  /** Global timeout for entire shutdown process in milliseconds (default: 30000, 0 = disabled) */
  timeoutMS?: number;
  /** Retry stalled components during stopAllComponents (default: true) */
  retryStalled?: boolean;
  /** Stop processing further components after a stall (default: true) */
  haltOnStall?: boolean;
}

/**
 * Result of restarting all components (stop + start)
 */
export interface RestartResult {
  /** Shutdown phase result */
  shutdownResult: ShutdownResult;

  /** Startup phase result */
  startupResult: StartupResult;

  /** True only if both shutdown and startup succeeded */
  success: boolean;
}

/**
 * Result of sending a message to a component
 */
export interface MessageResult {
  /** Was message delivered to handler */
  sent: boolean;

  /** Does component exist */
  componentFound: boolean;

  /** Is component currently running */
  componentRunning: boolean;

  /** Does component have onMessage() method */
  handlerImplemented: boolean;

  /** Data returned from onMessage handler (undefined if handler returned nothing) */
  data: unknown;

  /** Error if handler threw */
  error: Error | null;

  /** True if handler timed out before responding */
  timedOut: boolean;

  /** Machine-readable outcome code */
  code:
    | 'sent'
    | 'not_found'
    | 'stopped'
    | 'stalled'
    | 'no_handler'
    | 'timeout'
    | 'error';
}

/**
 * Options for sending a message to a component
 */
export interface SendMessageOptions {
  /**
   * Timeout in milliseconds for awaiting a response
   * (default: manager messageTimeoutMS, 0 = disabled)
   */
  timeout?: number;

  /**
   * Include stopped (not running, not stalled) components (default: false)
   */
  includeStopped?: boolean;

  /**
   * Include stalled components (default: false)
   */
  includeStalled?: boolean;
}

/**
 * Options for requesting a value from a component
 */
export interface GetValueOptions {
  /**
   * Include stopped (not running, not stalled) components (default: false)
   */
  includeStopped?: boolean;

  /**
   * Include stalled components (default: false)
   */
  includeStalled?: boolean;
}

/**
 * Options for broadcasting messages to components
 */
export interface BroadcastOptions extends SendMessageOptions {
  /** Filter to specific component names (default: all components) */
  componentNames?: string[];
}

/**
 * Result of broadcasting a message to multiple components
 */
export interface BroadcastResult {
  /** Component name */
  name: string;

  /** Was message delivered */
  sent: boolean;

  /** Was component running */
  running: boolean;

  /** Data returned from onMessage handler (undefined if not sent or no return) */
  data: unknown;

  /** Error if handler threw */
  error: Error | null;

  /** True if handler timed out before responding */
  timedOut: boolean;

  /** Machine-readable outcome code */
  code: 'sent' | 'stopped' | 'stalled' | 'no_handler' | 'timeout' | 'error';
}

/**
 * Component health check result (simple or rich)
 */
export interface ComponentHealthResult {
  /** Is the component healthy */
  healthy: boolean;

  /** Human-readable status message */
  message?: string;

  /** Arbitrary metrics/metadata */
  details?: Record<string, unknown>;
}

/**
 * Result of checking a single component's health
 */
export interface HealthCheckResult {
  /** Component name */
  name: string;

  /** Is the component healthy */
  healthy: boolean;

  /** Status message from component */
  message?: string;

  /** Details from component */
  details?: Record<string, unknown>;

  /** When the check was performed */
  checkedAt: number;

  /** How long the check took */
  durationMS: number;

  /** Error if health check threw */
  error: Error | null;

  /** True if health check timed out */
  timedOut: boolean;

  /** Machine-readable outcome code */
  code:
    | 'ok'
    | 'not_found'
    | 'stopped'
    | 'stalled'
    | 'no_handler'
    | 'timeout'
    | 'error';
}

/**
 * Aggregate health report for all components
 */
export interface HealthReport {
  /** True only if ALL components are healthy */
  healthy: boolean;

  /** Health check results for each component */
  components: HealthCheckResult[];

  /** When the check was performed */
  checkedAt: number;

  /** How long the check took */
  durationMS: number;

  /** True if any component timed out */
  timedOut: boolean;

  /** Machine-readable outcome code */
  code: 'ok' | 'degraded' | 'timeout' | 'error';
}

/**
 * Result of broadcasting a signal (reload/info/debug)
 */
export interface SignalBroadcastResult {
  /** Which signal was broadcast */
  signal: 'reload' | 'info' | 'debug';

  /** Results for each component */
  results: ComponentSignalResult[];

  /** True if any component timed out */
  timedOut: boolean;

  /** Machine-readable outcome code */
  code: 'ok' | 'partial_timeout' | 'timeout' | 'partial_error' | 'error';
}

/**
 * Result of a signal handler on a specific component
 */
export interface ComponentSignalResult {
  /** Component name */
  name: string;

  /** True if handler was called (component implements it) */
  called: boolean;

  /** Error if handler threw */
  error: Error | null;

  /** True if handler timed out before completing */
  timedOut: boolean;

  /** Machine-readable outcome code */
  code: 'called' | 'no_handler' | 'timeout' | 'error';
}

/**
 * Simple result type for component getValue() methods
 * Components return this, and LifecycleManager wraps it with additional metadata
 */
export interface ComponentValueResult<T = unknown> {
  /** True if component has a value for the requested key */
  found: boolean;

  /** The value (undefined when not found) */
  value: T | undefined;
}

/**
 * Result of requesting a value from a component
 */
export interface ValueResult<T = unknown> {
  /** True if getValue returned non-undefined */
  found: boolean;

  /** The returned value */
  value: T | undefined;

  /** Component exists in registry */
  componentFound: boolean;

  /** Component is in 'running' state */
  componentRunning: boolean;

  /** Component has getValue() method */
  handlerImplemented: boolean;

  /** Who requested (for logging) */
  requestedBy: string | null;

  /** Machine-readable outcome code */
  code: 'found' | 'not_found' | 'stopped' | 'stalled' | 'no_handler' | 'error';
}

type EventEmitterSurface = Pick<
  EventEmitterProtected,
  'on' | 'once' | 'hasListener' | 'hasListeners' | 'listenerCount'
>;

/**
 * Common lifecycle interface shared by LifecycleManager and ComponentLifecycle
 *
 * Keep in sync with public LifecycleManager API and ComponentLifecycle proxy.
 * Purpose: define the shared surface both expose to avoid drift across the two.
 */
export interface LifecycleCommon extends EventEmitterSurface {
  hasComponent(name: string): boolean;
  isComponentRunning(name: string): boolean;
  getComponentNames(): string[];
  getRunningComponentNames(): string[];
  getComponentCount(): number;
  getRunningComponentCount(): number;
  getStalledComponentCount(): number;
  getStoppedComponentCount(): number;
  getComponentStatus(name: string): ComponentStatus | undefined;
  getAllComponentStatuses(): ComponentStatus[];
  getSystemState(): SystemState;
  getStatus(): LifecycleManagerStatus;
  getStalledComponents(): ComponentStallInfo[];
  getStalledComponentNames(): string[];
  getStoppedComponentNames(): string[];
  getStartupOrder(): StartupOrderResult;
  validateDependencies(): DependencyValidationResult;

  startAllComponents(options?: StartupOptions): Promise<StartupResult>;
  stopAllComponents(options?: StopAllOptions): Promise<ShutdownResult>;
  restartAllComponents(options?: RestartAllOptions): Promise<RestartResult>;

  startComponent(
    name: string,
    options?: StartComponentOptions,
  ): Promise<ComponentOperationResult>;
  stopComponent(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult>;
  restartComponent(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult>;

  attachSignals(): void;
  detachSignals(): void;
  getSignalStatus(): LifecycleSignalStatus;
  triggerReload(): Promise<SignalBroadcastResult>;
  triggerInfo(): Promise<SignalBroadcastResult>;
  triggerDebug(): Promise<SignalBroadcastResult>;

  // Messaging, Health, Values methods
  sendMessageToComponent(
    componentName: string,
    payload: unknown,
    options?: SendMessageOptions,
  ): Promise<MessageResult>;
  broadcastMessage(
    payload: unknown,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]>;
  checkComponentHealth(name: string): Promise<HealthCheckResult>;
  checkAllHealth(): Promise<HealthReport>;
  getValue<T = unknown>(
    componentName: string,
    key: string,
    options?: GetValueOptions,
  ): ValueResult<T>;
}

/**
 * Internal callback functions passed to ComponentLifecycle
 * These allow ComponentLifecycle to call internal implementations with 'from' tracking
 */
export interface LifecycleInternalCallbacks {
  sendMessageInternal: (
    componentName: string,
    payload: unknown,
    from: string | null,
    options?: SendMessageOptions,
  ) => Promise<MessageResult>;
  broadcastMessageInternal: (
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ) => Promise<BroadcastResult[]>;
  getValueInternal: <T = unknown>(
    componentName: string,
    key: string,
    from: string | null,
    options?: GetValueOptions,
  ) => ValueResult<T>;
}

/**
 * Component-scoped lifecycle interface injected into BaseComponent
 * This is a restricted view of LifecycleManager suitable for components.
 */
export type ComponentLifecycleRef = LifecycleCommon;

/**
 * Overall system state
 */
export type SystemState =
  | 'no-components' // No components registered
  | 'ready' // Components registered, not started
  | 'starting' // startAllComponents() in progress
  | 'running' // Any components running (use getRunningComponentCount() to check if all are running)
  | 'stalled' // Some components failed to stop (stuck running)
  | 'shutting-down' // stopAllComponents() in progress
  | 'stopped' // All components stopped (can restart)
  | 'error'; // Startup failed with rollback

/**
 * Aggregated status snapshot for the lifecycle manager.
 */
export interface LifecycleManagerStatus {
  /** Overall system state derived from manager flags and component state */
  systemState: SystemState;

  /** True if any component is running (or stalled) */
  isStarted: boolean;

  /** True while startAllComponents() is running */
  isStarting: boolean;

  /** True while stopAllComponents() is running */
  isShuttingDown: boolean;

  /** Counts of registered, running, stopped, and stalled components */
  counts: {
    total: number;
    running: number;
    stopped: number;
    stalled: number;
    startTimedOut: number;
  };

  /** Component name lists for quick inspection */
  components: {
    registered: string[];
    running: string[];
    stopped: string[];
    stalled: string[];
    startTimedOut: string[];
  };
}

/**
 * Options for registering a component
 */
export interface RegisterOptions {
  /** Auto-start if manager is running/starting (default: false) */
  autoStart?: boolean;
}

/**
 * Options for unregistering a component
 */
export interface UnregisterOptions {
  /**
   * Stop the component first if it's running (default: true)
   * Set to false to require manual stop before unregister
   */
  stopIfRunning?: boolean;

  /**
   * If true (along with stopIfRunning), allows stopping a component even if
   * other components depend on it before unregistering
   * (default: false)
   */
  forceStop?: boolean;
}

/**
 * Options for starting all components
 */
export interface StartupOptions {
  /** Allow start even if stalled components exist (default: false) */
  ignoreStalledComponents?: boolean;
  /** Global timeout for entire startup process in milliseconds (default: constructor's startupTimeoutMS) */
  timeoutMS?: number;
}

/**
 * Options for restarting all components (stop + start)
 */
export interface RestartAllOptions {
  /** Startup options for the start phase */
  startupOptions?: StartupOptions;

  /** Timeout for the shutdown phase in milliseconds (default: shutdownOptions.timeoutMS) */
  shutdownTimeoutMS?: number;
}

/**
 * Insert position for registering a component relative to the current registry list
 */
export type InsertPosition = 'start' | 'end' | 'before' | 'after';

/**
 * Stable, machine-readable failure codes for registration operations
 */
export type RegistrationFailureCode =
  | 'duplicate_name'
  | 'duplicate_instance'
  | 'shutdown_in_progress'
  | 'startup_in_progress'
  | 'target_not_found'
  | 'invalid_position'
  | 'dependency_cycle'
  | 'unknown_error';

/**
 * Common result shape for component registration operations
 */
export interface RegistrationResultBase extends BaseOperationResult {
  /** Whether the component was added to the registry */
  registered: boolean;

  /** Component name */
  componentName: string;

  /** Machine-readable failure code if !success */
  code?: RegistrationFailureCode;

  /** Registration index before the operation (null if not previously registered) */
  registrationIndexBefore: number | null;

  /** Registration index after the operation (null if not registered) */
  registrationIndexAfter: number | null;

  /** Resolved startup order after applying dependency constraints */
  startupOrder: string[];

  /** Whether registration occurred during startup */
  duringStartup?: boolean;

  /** Whether auto-start was attempted after registration */
  autoStartAttempted?: boolean;

  /** Whether auto-start succeeded (only present when autoStartAttempted is true) */
  autoStartSucceeded?: boolean;

  /** Result of auto-start operation (only present when autoStartAttempted is true) */
  startResult?: ComponentOperationResult;
}

/**
 * Stable, machine-readable failure codes for getStartupOrder()
 */
export type StartupOrderFailureCode = 'dependency_cycle' | 'unknown_error';

/**
 * Result of getStartupOrder()
 */
export interface StartupOrderResult extends BaseOperationResult {
  /** Resolved startup order after applying dependency constraints */
  startupOrder: string[];

  /** Machine-readable failure code if !success */
  code?: StartupOrderFailureCode;
}

/**
 * Result of registerComponent()
 */
export interface RegisterComponentResult extends RegistrationResultBase {
  action: 'register';
}

/**
 * Result of insertComponentAt()
 */
export interface InsertComponentAtResult extends RegistrationResultBase {
  action: 'insert';

  /** Requested insertion position */
  requestedPosition: {
    /**
     * The requested position.
     *
     * Note: This is `string` (not just `InsertPosition`) so untyped/JS callers can
     * still get back the original invalid value when the operation fails with
     * `code: 'invalid_position'`.
     */
    position: InsertPosition | (string & {});
    targetComponentName?: string;
  };

  /** True if requested relative positioning was achievable under dependency constraints */
  manualPositionRespected: boolean;

  /** Present when inserting before/after a target */
  targetFound?: boolean;
}

/**
 * Result of validateDependencies()
 *
 * Provides a report of dependency issues without throwing.
 * Reports all issues regardless of whether components are optional - the optional
 * flag affects startup behavior, not whether dependencies must exist.
 */
export interface DependencyValidationResult {
  /** True if all dependencies are valid (no circular cycles, no missing dependencies) */
  valid: boolean;

  /** Missing dependencies: components that depend on non-registered components */
  missingDependencies: Array<{
    componentName: string;
    /** Whether the component with the missing dependency is optional */
    componentIsOptional: boolean;
    missingDependency: string;
  }>;

  /**
   * Detected circular dependency cycles.
   * Each cycle is an array of component names forming a circle (e.g., ['A', 'B', 'C'] means A→B→C→A).
   */
  circularCycles: string[][];

  /** Summary counts for quick overview */
  summary: {
    /** Total number of missing dependencies */
    totalMissingDependencies: number;
    /** Missing dependencies from required components */
    requiredMissingDependencies: number;
    /** Missing dependencies from optional components */
    optionalMissingDependencies: number;
    /** Total number of circular dependency cycles detected */
    totalCircularCycles: number;
  };
}

/**
 * Extended signal status with lifecycle-specific information
 */
export interface LifecycleSignalStatus extends ProcessSignalManagerStatus {
  /** How shutdown was triggered (null if not shut down) */
  shutdownMethod: ShutdownMethod | null;
}

/**
 * Configuration options for LifecycleManager
 */
export interface LifecycleManagerOptions {
  /** Name for logger scope (default: 'lifecycle-manager') */
  name?: string;

  /** Root logger instance (required) */
  logger: Logger;

  /** Global timeout for startup in ms (default: 60000, 0 = disabled) */
  startupTimeoutMS?: number;

  /** Default stopAllComponents options used by signal and logger hooks */
  shutdownOptions?: StopAllOptions;

  /** Global warning phase timeout in ms (default: 500, 0 = fire-and-forget, <0 = skip) */
  shutdownWarningTimeoutMS?: number;

  /** Default message timeout in ms (default: 5000, 0 = disabled) */
  messageTimeoutMS?: number;

  /** Auto-attach signals when first component starts (default: false) */
  attachSignalsOnStart?: boolean;

  /** Auto-detach signals when last component stops (default: false) */
  detachSignalsOnStop?: boolean;

  /** Enable Logger exit hook integration (default: false). When enabled, logger.exit() triggers graceful component shutdown before process exit. */
  enableLoggerExitHook?: boolean;

  /** Custom reload signal handler (called instead of default broadcast, receives broadcast function you can optionally call) */
  onReloadRequested?: (
    broadcastReload: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;

  /** Custom info signal handler (called instead of default broadcast, receives broadcast function you can optionally call) */
  onInfoRequested?: (
    broadcastInfo: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;

  /** Custom debug signal handler (called instead of default broadcast, receives broadcast function you can optionally call) */
  onDebugRequested?: (
    broadcastDebug: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
}
