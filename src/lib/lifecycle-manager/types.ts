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

  /** Time to wait after warning in milliseconds (default: 0 = skip warning) */
  shutdownWarningTimeoutMS?: number;

  /** Time to wait for graceful shutdown in milliseconds (default: 5000, minimum: 1000) */
  shutdownGracefulTimeoutMS?: number;

  /** Time to wait for force shutdown in milliseconds (default: 2000, minimum: 500) */
  shutdownForceTimeoutMS?: number;

  /** Time to wait for healthCheck() in milliseconds (default: 5000) */
  healthCheckTimeoutMS?: number;
}

/**
 * Possible states a component can be in
 */
export type ComponentState =
  | 'registered' // Registered but never started
  | 'starting' // start() in progress
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

  /** Reason for stall */
  reason: 'timeout' | 'error' | 'both';

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
   * when those dependencies are optional components.
   */
  allowOptionalDependencies?: boolean;

  /**
   * If true, allow dependencies that are registered but not running
   * even when those dependencies are required components (not optional).
   * This is an explicit override that bypasses normal dependency checks.
   */
  allowRequiredDependencies?: boolean;
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
   * If true, allows stopping a component even if other components depend on it
   * Without this flag, stopping a component with running dependents will fail
   * (default: false)
   */
  force?: boolean;
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
  | 'missing_dependency'
  | 'dependency_not_running'
  | 'has_running_dependents'
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
}

/**
 * Result of broadcasting a signal (reload/info/debug)
 */
export interface SignalBroadcastResult {
  /** Which signal was broadcast */
  signal: 'reload' | 'info' | 'debug';

  /** Results for each component */
  results: ComponentSignalResult[];
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
}

/**
 * Overall system state
 */
export type SystemState =
  | 'idle' // No components, nothing happening
  | 'ready' // Components registered, not started
  | 'starting' // startAllComponents() in progress
  | 'running' // All components running
  | 'partial' // Some components running (after individual start/stop)
  | 'shutting-down' // stopAllComponents() in progress
  | 'stopped' // All components stopped (can restart)
  | 'error'; // Startup failed with rollback

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
  /** Stop the component first if it's running (default: false) */
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
 * Configuration options for LifecycleManager
 */
export interface LifecycleManagerOptions {
  /** Name for logger scope (default: 'lifecycle-manager') */
  name?: string;

  /** Root logger instance (required) */
  logger: unknown; // Will be Logger type, but avoiding circular dependency

  /** Global timeout for startup in ms (default: 60000, 0 = disabled) */
  startupTimeoutMS?: number;

  /** Global timeout for shutdown in ms (default: 30000, 0 = disabled) */
  shutdownTimeoutMS?: number;

  /** Auto-attach signals when first component starts (default: false) */
  attachSignalsOnStart?: boolean;

  /** Auto-detach signals when last component stops (default: false) */
  detachSignalsOnStop?: boolean;

  /** Custom reload signal handler (called instead of default broadcast) */
  onReloadRequested?: (
    broadcastReload: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;

  /** Custom info signal handler */
  onInfoRequested?: () => void | Promise<void>;

  /** Custom debug signal handler */
  onDebugRequested?: () => void | Promise<void>;
}
