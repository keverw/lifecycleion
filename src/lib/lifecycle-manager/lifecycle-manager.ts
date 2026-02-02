import { EventEmitterProtected } from '../event-emitter';
import type { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import type { BaseComponent } from './base-component';
import { ComponentLifecycle } from './component-lifecycle';
import type {
  ComponentState,
  ComponentStatus,
  ComponentStallInfo,
  LifecycleManagerStatus,
  ComponentOperationResult,
  StartComponentOptions,
  StopComponentOptions,
  RestartComponentOptions,
  LifecycleManagerOptions,
  RegisterOptions,
  RegisterComponentResult,
  InsertPosition,
  InsertComponentAtResult,
  UnregisterOptions,
  UnregisterComponentResult,
  SystemState,
  RegistrationFailureCode,
  StartupOrderResult,
  StartupOptions,
  StartupResult,
  ShutdownResult,
  StopAllOptions,
  RestartResult,
  RestartAllOptions,
  DependencyValidationResult,
  ShutdownMethod,
  SignalBroadcastResult,
  ComponentSignalResult,
  LifecycleSignalStatus,
  ComponentLifecycleRef,
  LifecycleCommon,
  MessageResult,
  BroadcastResult,
  BroadcastOptions,
  SendMessageOptions,
  GetValueOptions,
  HealthCheckResult,
  HealthReport,
  ValueResult,
  ComponentHealthResult,
  LifecycleInternalCallbacks,
} from './types';
import {
  LifecycleManagerEvents,
  type LifecycleManagerEventMap,
  type LifecycleManagerEventName,
} from './events';
import {
  ComponentStartTimeoutError,
  ComponentStopTimeoutError,
  DependencyCycleError,
} from './errors';
import {
  ProcessSignalManager,
  type ShutdownSignal,
} from '../process-signal-manager';
import { isPromise } from '../is-promise';

/**
 * LifecycleManager - Comprehensive lifecycle orchestration system
 *
 * Manages startup, shutdown, and runtime control of application components.
 * Features:
 * - Multi-phase shutdown (global warning -> per-component graceful -> force)
 * - Dependency-ordered component startup
 * - Process signal integration
 * - Component messaging and value sharing
 * - Health checks and monitoring
 * - Event-driven architecture
 */
export class LifecycleManager
  extends EventEmitterProtected
  implements LifecycleCommon
{
  // Configuration
  private readonly name: string;
  private readonly logger: LoggerService;
  private readonly rootLogger: Logger;
  private readonly shutdownWarningTimeoutMS: number;
  private readonly messageTimeoutMS: number;
  private readonly startupTimeoutMS: number;
  private readonly shutdownOptions?: StopAllOptions;
  private readonly attachSignalsOnStart: boolean;
  private readonly detachSignalsOnStop: boolean;

  // Component management
  private components: BaseComponent[] = [];
  private runningComponents: Set<string> = new Set();
  private componentStates: Map<string, ComponentState> = new Map();
  private stalledComponents: Map<string, ComponentStallInfo> = new Map();

  // State tracking for individual components
  private componentTimestamps: Map<
    string,
    { startedAt: number | null; stoppedAt: number | null }
  > = new Map();
  private componentErrors: Map<string, Error | null> = new Map();

  // State flags
  private isStarting = false;
  private isStarted = false;
  private isShuttingDown = false;
  private shutdownMethod: ShutdownMethod | null = null;

  // Signal management
  private processSignalManager: ProcessSignalManager | null = null;
  private readonly onReloadRequested?: (
    broadcastReload: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
  private readonly onInfoRequested?: (
    broadcastInfo: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
  private readonly onDebugRequested?: (
    broadcastDebug: () => Promise<SignalBroadcastResult>,
  ) => void | Promise<void>;
  private readonly lifecycleEvents: LifecycleManagerEvents;

  constructor(options: LifecycleManagerOptions & { logger: Logger }) {
    super();

    if (!options.logger) {
      throw new Error('LifecycleManager requires a root logger');
    }

    this.name = options.name ?? 'lifecycle-manager';
    this.rootLogger = options.logger;
    this.logger = this.rootLogger.service(this.name);
    this.shutdownWarningTimeoutMS = options.shutdownWarningTimeoutMS ?? 500;
    this.messageTimeoutMS = options.messageTimeoutMS ?? 5000;
    this.startupTimeoutMS = options.startupTimeoutMS ?? 60000;
    this.shutdownOptions = {
      timeoutMS: 30000,
      retryStalled: true,
      haltOnStall: true,
      ...options.shutdownOptions,
    };
    this.attachSignalsOnStart = options.attachSignalsOnStart ?? false;
    this.detachSignalsOnStop = options.detachSignalsOnStop ?? false;

    // Store custom signal callbacks
    this.onReloadRequested = options.onReloadRequested;
    this.onInfoRequested = options.onInfoRequested;
    this.onDebugRequested = options.onDebugRequested;
    this.lifecycleEvents = new LifecycleManagerEvents(this.safeEmit.bind(this));

    // Enable logger exit hook if requested
    if (options.enableLoggerExitHook) {
      this.enableLoggerExitHook();
    }
  }

  // ============================================================================
  // Component Registration
  // ============================================================================

  /**
   * Register a component at the end of the registry list.
   */
  public async registerComponent(
    component: BaseComponent,
    options?: RegisterOptions,
  ): Promise<RegisterComponentResult> {
    const result = await this.registerComponentInternal(
      component,
      'end',
      undefined,
      false,
      options,
    );

    return {
      action: 'register',
      success: result.success,
      registered: result.registered,
      componentName: result.componentName,
      reason: result.reason,
      code: result.code,
      error: result.error,
      registrationIndexBefore: result.registrationIndexBefore,
      registrationIndexAfter: result.registrationIndexAfter,
      startupOrder: result.startupOrder,
      duringStartup: result.duringStartup,
      autoStartAttempted: result.autoStartAttempted,
      autoStartSucceeded: result.autoStartSucceeded,
      startResult: result.startResult,
    };
  }

  /**
   * Insert a component at a specific position within the registry list.
   *
   * Notes:
   * - The registry list is a manual ordering preference only.
   * - Dependencies may override this preference; the result object includes `startupOrder`
   *   and `manualPositionRespected` so callers can see if the request was achievable.
   */
  public async insertComponentAt(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName?: string,
    options?: RegisterOptions,
  ): Promise<InsertComponentAtResult> {
    return await this.registerComponentInternal(
      component,
      position,
      targetComponentName,
      true,
      options,
    );
  }

  /**
   * Unregister a component
   *
   * @param name - Component name to unregister
   * @param options - Unregister options (stopIfRunning defaults to true)
   *
   * Notes:
   * - Stopped or stalled components can be unregistered directly
   * - Running components are stopped first by default (stopIfRunning: true)
   * - Set stopIfRunning: false to require manual stop before unregister
   * - If stopIfRunning is true and stop fails, unregister is aborted
   * - If stopIfRunning is true and the component is stalled, unregister is aborted
   * @returns True if component was unregistered, false otherwise
   */
  public async unregisterComponent(
    name: string,
    options?: UnregisterOptions,
  ): Promise<UnregisterComponentResult> {
    // Block unregistration during bulk operations
    if (this.isStarting || this.isShuttingDown) {
      this.logger.entity(name).warn('Cannot unregister during bulk operation', {
        params: {
          isStarting: this.isStarting,
          isShuttingDown: this.isShuttingDown,
        },
      });

      return {
        success: false,
        componentName: name,
        reason: 'Cannot unregister during bulk operation',
        code: 'bulk_operation_in_progress',
        wasStopped: false,
        wasRegistered: this.hasComponent(name),
      };
    }

    const component = this.getComponent(name);

    if (!component) {
      this.logger.entity(name).warn('Component not found');
      return {
        success: false,
        componentName: name,
        reason: 'Component not found',
        code: 'component_not_found',
        wasStopped: false,
        wasRegistered: false,
      };
    }

    // Default stopIfRunning to true (opt-out behavior)
    const shouldStopIfRunning = options?.stopIfRunning !== false;

    const isStalled = this.stalledComponents.has(name);

    if (isStalled && shouldStopIfRunning) {
      this.logger
        .entity(name)
        .warn('Cannot unregister stalled component when stopIfRunning is set');
      return {
        success: false,
        componentName: name,
        reason: 'Component is stalled',
        code: 'stop_failed',
        stopFailureReason: 'stalled',
        wasStopped: false,
        wasRegistered: true,
      };
    }

    const isRunning = this.isComponentRunning(name);

    // If running and stopIfRunning explicitly set to false, reject
    if (isRunning && !shouldStopIfRunning) {
      this.logger
        .entity(name)
        .warn(
          'Cannot unregister running component. Call stopComponent() first or pass { stopIfRunning: true }',
        );
      return {
        success: false,
        componentName: name,
        reason:
          'Component is running. Use stopIfRunning: true option or stop manually first',
        code: 'component_running',
        wasStopped: false,
        wasRegistered: true,
      };
    }

    // If running and stopIfRunning is true (default), stop first
    let wasStopped = false;
    if (isRunning && shouldStopIfRunning) {
      this.logger.entity(name).info('Stopping component before unregistering');
      const stopResult = await this.stopComponent(name, {
        force: options?.forceStop,
      });

      // If stop fails and leaves the component stalled, do NOT unregister.
      // Caller expectation: success with stopIfRunning implies the component is stopped and unregistered.
      const stateAfterStopAttempt = this.componentStates.get(name);
      const isRunningAfterStopAttempt = this.isComponentRunning(name);

      const isSafelyStopped =
        stopResult.success ||
        (!isRunningAfterStopAttempt && stateAfterStopAttempt === 'stopped');

      if (!isSafelyStopped) {
        this.logger
          .entity(name)
          .warn('Failed to stop component before unregistering', {
            params: {
              reason: stopResult.reason,
              code: stopResult.code,
              state: stateAfterStopAttempt,
            },
          });

        return {
          success: false,
          componentName: name,
          reason: stopResult.reason ?? 'Failed to stop component',
          code: 'stop_failed',
          stopFailureReason:
            stopResult.code === 'stop_timeout' ? 'timeout' : 'error',
          error: stopResult.error,
          wasStopped: false,
          wasRegistered: true,
        };
      }

      wasStopped = true;
    }

    // Remove from registry
    this.components = this.components.filter((c) => c.getName() !== name);

    // Clean up state
    this.componentStates.delete(name);
    this.componentTimestamps.delete(name);
    this.componentErrors.delete(name);
    this.stalledComponents.delete(name);
    this.runningComponents.delete(name);
    this.updateStartedFlag();

    // Auto-detach signals if this was the last component and option is enabled
    if (
      this.detachSignalsOnStop &&
      this.runningComponents.size === 0 &&
      this.processSignalManager
    ) {
      this.logger.info(
        'Auto-detaching process signals on last component unregistered',
      );
      this.detachSignals();
    }

    this.logger.entity(name).info('Component unregistered');
    this.lifecycleEvents.componentUnregistered(name, false);

    return {
      success: true,
      componentName: name,
      wasStopped,
      wasRegistered: true,
    };
  }

  // ============================================================================
  // Status Tracking
  // ============================================================================

  /**
   * Check if a component is registered
   */
  public hasComponent(name: string): boolean {
    return this.components.some((c) => c.getName() === name);
  }

  /**
   * Check if a component is currently running
   */
  public isComponentRunning(name: string): boolean {
    return this.runningComponents.has(name);
  }

  /**
   * Get all registered component names
   */
  public getComponentNames(): string[] {
    return this.components.map((c) => c.getName());
  }

  /**
   * Get all running component names
   */
  public getRunningComponentNames(): string[] {
    return Array.from(this.runningComponents);
  }

  /**
   * Get the actual component instance by name.
   *
   * Note: This returns the live instance registered with the manager. Mutating it
   * directly can bypass lifecycle invariants, so treat it as read-only unless you
   * fully control the component and understand the implications.
   */
  public getComponentInstance(name: string): BaseComponent | undefined {
    return this.getComponent(name);
  }

  /**
   * Get total component count
   */
  public getComponentCount(): number {
    return this.components.length;
  }

  /**
   * Get running component count
   */
  public getRunningComponentCount(): number {
    // Stalled components are not counted as running.
    return this.runningComponents.size;
  }

  /**
   * Get stalled component count
   */
  public getStalledComponentCount(): number {
    return this.stalledComponents.size;
  }

  /**
   * Get stopped (not running, not stalled) component count
   */
  public getStoppedComponentCount(): number {
    return this.getStoppedComponentNames().length;
  }

  /**
   * Get detailed status for a specific component
   */
  public getComponentStatus(name: string): ComponentStatus | undefined {
    const component = this.getComponent(name);
    if (!component) {
      return undefined;
    }

    const state = this.componentStates.get(name) || 'registered';
    const timestamps = this.componentTimestamps.get(name) || {
      startedAt: null,
      stoppedAt: null,
    };
    const lastError = this.componentErrors.get(name) || null;
    const stallInfo = this.stalledComponents.get(name) || null;

    return {
      name,
      state,
      startedAt: timestamps.startedAt,
      stoppedAt: timestamps.stoppedAt,
      lastError,
      stallInfo,
    };
  }

  /**
   * Get statuses for all components
   */
  public getAllComponentStatuses(): ComponentStatus[] {
    return this.components
      .map((component) => this.getComponentStatus(component.getName()))
      .filter((status): status is ComponentStatus => status !== undefined);
  }

  /**
   * Get overall system state
   */
  public getSystemState(): SystemState {
    const totalCount = this.getComponentCount();
    const runningCount = this.getRunningComponentCount();

    if (this.isShuttingDown) {
      return 'shutting-down';
    }

    if (this.isStarting) {
      return 'starting';
    }

    if (totalCount === 0) {
      return 'no-components';
    }

    // Check for stalled components (failed to stop)
    if (this.stalledComponents.size > 0) {
      return 'stalled';
    }

    if (runningCount === 0) {
      return 'ready';
    }

    if (runningCount === totalCount) {
      return 'running';
    }

    // Some components running, some not - this is valid for individual start/stop
    // Just report as 'running' since something is running
    if (runningCount > 0) {
      return 'running';
    }

    return 'ready';
  }

  /**
   * Get aggregated status snapshot for the manager.
   */
  public getStatus(): LifecycleManagerStatus {
    const running = this.getRunningComponentCount();
    const stalled = this.getStalledComponentCount();
    const stopped = this.getStoppedComponentCount();
    const registeredNames = this.getComponentNames();
    const runningNames = this.getRunningComponentNames();
    const stalledNames = this.getStalledComponentNames();
    const stoppedNames = this.getStoppedComponentNames();

    return {
      systemState: this.getSystemState(),
      isStarted: this.isStarted,
      isStarting: this.isStarting,
      isShuttingDown: this.isShuttingDown,
      counts: {
        total: this.getComponentCount(),
        running,
        stopped,
        stalled,
      },
      components: {
        registered: registeredNames,
        running: runningNames,
        stopped: stoppedNames,
        stalled: stalledNames,
      },
    };
  }

  /**
   * Get information about components that are stalled (failed to stop)
   */
  public getStalledComponents(): ComponentStallInfo[] {
    return Array.from(this.stalledComponents.values());
  }

  /**
   * Get stalled component names
   */
  public getStalledComponentNames(): string[] {
    return Array.from(this.stalledComponents.keys());
  }

  /**
   * Get stopped (not running, not stalled) component names
   */
  public getStoppedComponentNames(): string[] {
    const registeredNames = this.getComponentNames();
    const runningNameSet = new Set(this.getRunningComponentNames());
    const stalledNameSet = new Set(this.getStalledComponentNames());

    return registeredNames.filter(
      (name) => !runningNameSet.has(name) && !stalledNameSet.has(name),
    );
  }

  /**
   * Get resolved startup order after applying dependency constraints.
   */
  public getStartupOrder(): StartupOrderResult {
    try {
      return {
        success: true,
        startupOrder: this.getStartupOrderInternal(),
      };
    } catch (error) {
      const err = error as Error;
      const code =
        err instanceof DependencyCycleError
          ? 'dependency_cycle'
          : 'unknown_error';

      this.logger.error('Failed to resolve startup order', {
        params: { error: err },
      });

      return {
        success: false,
        startupOrder: [],
        reason: err.message,
        code,
        error: err,
      };
    }
  }

  /**
   * Validate all component dependencies without throwing.
   *
   * Returns a report of dependency issues:
   * - Missing dependencies (components that depend on non-registered components)
   * - Circular dependency cycles (e.g., A→B→C→A)
   *
   * Reports all issues regardless of whether components are optional.
   * The optional flag affects startup behavior (whether failures trigger rollback),
   * not whether dependencies must exist in the registry.
   *
   * This is useful for pre-flight checks before starting components.
   */
  public validateDependencies(): DependencyValidationResult {
    const missingDependencies: Array<{
      componentName: string;
      componentIsOptional: boolean;
      missingDependency: string;
    }> = [];

    // Check for missing dependencies
    for (const component of this.components) {
      const componentName = component.getName();
      const isComponentOptional = component.isOptional();
      const dependencies = component.getDependencies();

      for (const dep of dependencies) {
        if (!this.hasComponent(dep)) {
          missingDependencies.push({
            componentName,
            componentIsOptional: isComponentOptional,
            missingDependency: dep,
          });
        }
      }
    }

    // Build adjacency graph for cycle detection
    const names = this.components.map((c) => c.getName());
    const adjacency = new Map<string, Set<string>>();

    for (const name of names) {
      adjacency.set(name, new Set());
    }

    // Build edges: dependency -> dependent (only when dependency is registered)
    for (const component of this.components) {
      const dependent = component.getName();
      for (const dep of component.getDependencies()) {
        if (adjacency.has(dep)) {
          adjacency.get(dep)?.add(dependent);
        }
      }
    }

    // Find circular dependency cycles
    const circularCycles = this.findAllCircularCycles(adjacency);

    const isValid =
      missingDependencies.length === 0 && circularCycles.length === 0;

    // Calculate summary counts
    const totalMissingDependencies = missingDependencies.length;
    const requiredMissingDependencies = missingDependencies.filter(
      (md) => !md.componentIsOptional,
    ).length;
    const optionalMissingDependencies = missingDependencies.filter(
      (md) => md.componentIsOptional,
    ).length;

    return {
      valid: isValid,
      missingDependencies,
      circularCycles,
      summary: {
        totalMissingDependencies,
        requiredMissingDependencies,
        optionalMissingDependencies,
        totalCircularCycles: circularCycles.length,
      },
    };
  }

  // ============================================================================
  // Bulk Operations
  // ============================================================================

  /**
   * Start all registered components in dependency order.
   *
   * Components start in topological order (dependencies before dependents).
   * Shutdown occurs in reverse topological order.
   *
   * Behavior:
   * - Rejects if some components are already running (partial state)
   * - Sets isStarting flag during operation
   * - On failure: triggers rollback (stops all started components)
   * - Optional components don't trigger rollback on failure
   * - Dependents still attempt to start if an optional dependency fails
   * - Handles shutdown signal during startup (aborts and rolls back)
   */
  public async startAllComponents(
    options?: StartupOptions,
  ): Promise<StartupResult> {
    const startTime = Date.now();

    // Reject if already starting
    if (this.isStarting) {
      this.logger.warn(
        'Cannot start all components: startup already in progress',
      );

      return {
        success: false,
        startedComponents: [],
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        reason: 'Startup already in progress',
        code: 'already_in_progress',
        durationMS: Date.now() - startTime,
      };
    }

    // Reject if shutdown is in progress
    if (this.isShuttingDown) {
      this.logger.warn('Cannot start all components: shutdown in progress');
      return {
        success: false,
        startedComponents: [],
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        reason: 'Shutdown in progress',
        code: 'shutdown_in_progress',
        durationMS: Date.now() - startTime,
      };
    }

    const totalCount = this.getComponentCount();
    const runningCount = this.getRunningComponentCount();

    if (totalCount === 0) {
      this.logger.warn('Cannot start all components: none registered');

      return {
        success: false,
        startedComponents: [],
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        reason: 'No components registered',
        code: 'no_components_registered',
        durationMS: Date.now() - startTime,
      };
    }

    // Check for stalled components
    if (this.stalledComponents.size > 0 && !options?.ignoreStalledComponents) {
      const stalledNames = Array.from(this.stalledComponents.keys());
      this.logger.warn('Cannot start: stalled components exist', {
        params: { stalled: stalledNames },
      });

      return {
        success: false,
        startedComponents: [],
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        blockedByStalledComponents: stalledNames,
        reason: 'Stalled components exist',
        code: 'stalled_components_exist',
        durationMS: Date.now() - startTime,
      };
    }

    // All running - nothing to do
    if (runningCount === totalCount && totalCount > 0) {
      this.logger.info('All components already running');
      return {
        success: true,
        startedComponents: this.components
          .filter((c) => this.runningComponents.has(c.getName()))
          .map((c) => c.getName()),
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        durationMS: Date.now() - startTime,
      };
    }

    // Partial state - reject to avoid inconsistent startup
    if (runningCount > 0) {
      this.logger.error(
        `Cannot start: ${runningCount}/${totalCount} components already running. ` +
          `Call stopAllComponents() first to ensure clean state.`,
      );

      return {
        success: false,
        startedComponents: this.components
          .filter((c) => this.runningComponents.has(c.getName()))
          .map((c) => c.getName()),
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        durationMS: Date.now() - startTime,
      };
    }

    // Set starting flag and clear previous shutdown state
    this.isStarting = true;
    this.shutdownMethod = null; // Clear previous shutdown method on fresh start
    this.logger.info('Starting all components');

    const effectiveTimeout = options?.timeoutMS ?? this.startupTimeoutMS;
    let hasTimedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    // Race startup against timeout if specified
    if (effectiveTimeout > 0) {
      timeoutHandle = setTimeout(() => {
        hasTimedOut = true;

        this.logger.warn(
          'Startup timeout exceeded, returning partial results',
          {
            params: { timeoutMS: effectiveTimeout },
          },
        );
      }, effectiveTimeout);
    }

    try {
      // Get startup order (topological sort)
      let startupOrder: string[];

      try {
        startupOrder = this.getStartupOrderInternal();
      } catch (error) {
        const err = error as Error;
        const code =
          err instanceof DependencyCycleError
            ? 'dependency_cycle'
            : 'unknown_error';

        this.logger.error('Failed to resolve startup order', {
          params: { error: err.message },
        });

        return {
          success: false,
          startedComponents: [],
          failedOptionalComponents: [],
          skippedDueToDependency: [],
          reason: err.message,
          code,
          error: err,
          durationMS: Date.now() - startTime,
        };
      }

      const startedComponents: string[] = [];
      const failedOptionalComponents: Array<{ name: string; error: Error }> =
        [];
      const skippedDueToDependency = new Set<string>();
      const skippedDueToStall = new Set<string>();

      // Start each component in dependency order
      for (const name of startupOrder) {
        // Check if startup has timed out
        if (hasTimedOut) {
          this.logger.warn(
            'Startup timeout reached, stopping component initiation',
          );
          break;
        }

        const component = this.getComponent(name);
        if (!component) {
          // Should not happen since unregisterComponent() is blocked during startup
          this.logger
            .entity(name)
            .error('Component not found in startup order');
          continue;
        }

        // Skip stalled components (even with ignoreStalledComponents:true)
        if (this.stalledComponents.has(name)) {
          this.logger
            .entity(name)
            .info('Skipping stalled component during startup');
          skippedDueToStall.add(name);
          continue;
        }

        // Check if any required dependency failed or was skipped
        const dependencies = component.getDependencies();
        let shouldSkip = false;
        let skipReason = '';

        for (const depName of dependencies) {
          if (skippedDueToStall.has(depName)) {
            shouldSkip = true;
            skipReason = `Dependency "${depName}" is stalled`;
            break;
          }

          const depComponent = this.getComponent(depName);
          const isDependencyOptional = depComponent?.isOptional() ?? false;

          if (skippedDueToDependency.has(depName)) {
            if (!isDependencyOptional) {
              shouldSkip = true;
              skipReason = `Dependency "${depName}" was skipped`;
              break;
            }
            continue;
          }

          if (depComponent) {
            const depState = this.componentStates.get(depName);
            if (depState === 'failed' && !isDependencyOptional) {
              shouldSkip = true;
              skipReason = `Dependency "${depName}" failed to start`;
              break;
            }
          }
        }

        if (shouldSkip) {
          this.logger
            .entity(name)
            .warn('Skipping component due to dependency', {
              params: { reason: skipReason },
            });
          this.lifecycleEvents.componentStartSkipped(name, skipReason);
          skippedDueToDependency.add(name);
          continue;
        }

        // Check if shutdown was triggered during startup
        if (this.isShuttingDown) {
          this.logger.warn('Shutdown signal received during startup, aborting');

          // Rollback: stop all started components in reverse order
          // Note: Do NOT emit shutdown-initiated/shutdown-completed here, as
          // stopAllComponents() has already emitted them. We just need to rollback.
          await this.rollbackStartup(startedComponents);

          return {
            success: false,
            startedComponents: [],
            failedOptionalComponents: [],
            skippedDueToDependency: [],
            durationMS: Date.now() - startTime,
          };
        }

        // Start the component (allow during bulk startup since we ARE the bulk operation)
        const result = await this.startComponentInternal(name, {
          allowDuringBulkStartup: true,
        });

        if (result.success) {
          startedComponents.push(name);
        } else if (result.code === 'component_already_running') {
          // Component is already running - this is fine (might have been started manually)
          // Add to startedComponents so it's tracked as part of this bulk operation
          startedComponents.push(name);
        } else {
          // Check if component is optional
          if (component.isOptional()) {
            this.logger
              .entity(name)
              .warn('Optional component failed to start, continuing', {
                params: { error: result.error?.message },
              });

            this.lifecycleEvents.componentStartFailedOptional(
              name,
              result.error,
            );

            // Mark as failed state
            this.componentStates.set(name, 'failed');
            if (result.error) {
              this.componentErrors.set(name, result.error);
            }

            failedOptionalComponents.push({
              name,
              error:
                result.error || new Error(result.reason || 'Unknown error'),
            });
          } else {
            // Required component failed - trigger rollback
            this.logger
              .entity(name)
              .error('Required component failed to start, rolling back', {
                params: { error: result.error?.message },
              });

            await this.rollbackStartup(startedComponents);

            return {
              success: false,
              startedComponents: [],
              failedOptionalComponents,
              skippedDueToDependency: Array.from(skippedDueToDependency),
              durationMS: Date.now() - startTime,
            };
          }
        }
      }

      // Check if startup timed out during the process
      if (hasTimedOut) {
        const durationMS = Date.now() - startTime;

        this.logger.warn('Startup completed with timeout', {
          params: {
            started: startedComponents.length,
            failed: failedOptionalComponents.length,
            skipped: skippedDueToDependency.size + skippedDueToStall.size,
            durationMS,
            timeoutMS: effectiveTimeout,
          },
        });

        return {
          success: false,
          startedComponents,
          failedOptionalComponents,
          skippedDueToDependency: Array.from(skippedDueToDependency),
          durationMS,
          timedOut: true,
          reason: `Startup timeout exceeded (${effectiveTimeout}ms)`,
          code: 'startup_timeout',
        };
      }

      // Success - all components started (or optional ones failed gracefully)
      this.updateStartedFlag();
      const skippedComponentsArray = [
        ...Array.from(skippedDueToDependency),
        ...Array.from(skippedDueToStall),
      ];

      const durationMS = Date.now() - startTime;

      this.logger.success('All components started', {
        params: {
          started: startedComponents.length,
          failed: failedOptionalComponents.length,
          skipped: skippedComponentsArray.length,
          durationMS,
        },
      });

      this.lifecycleEvents.lifecycleManagerStarted(
        startedComponents,
        failedOptionalComponents,
        skippedComponentsArray,
      );

      return {
        success: true,
        startedComponents,
        failedOptionalComponents,
        skippedDueToDependency: Array.from(skippedDueToDependency),
        durationMS,
        timedOut: hasTimedOut,
      };
    } finally {
      // Clear timeout if still running
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      this.isStarting = false;
    }
  }

  /**
   * Stop all running components in reverse dependency order
   *
   * Components stop in reverse topological order (dependents before dependencies).
   *
   * @param options - Optional shutdown options
   */

  public async stopAllComponents(
    options?: StopAllOptions,
  ): Promise<ShutdownResult> {
    // always use manual method for external public API as not from a signal
    return this.stopAllComponentsInternal('manual', {
      ...this.shutdownOptions,
      ...options,
    });
  }

  /**
   * Restart all components (stop then start)
   */
  public async restartAllComponents(
    options?: RestartAllOptions,
  ): Promise<RestartResult> {
    this.logger.info('Restarting all components');

    // Phase 1: Stop all components (explicit defaults for restart semantics)
    const shutdownResult = await this.stopAllComponentsInternal('manual', {
      ...this.shutdownOptions,
      timeoutMS:
        options?.shutdownTimeoutMS ?? this.shutdownOptions?.timeoutMS ?? 30000,
      // Always retry/halt during restart for deterministic shutdown behavior.
      retryStalled: true,
      haltOnStall: true,
    });

    // Phase 2: Start all components
    const startupResult = await this.startAllComponents(
      options?.startupOptions,
    );

    const isSuccess = shutdownResult.success && startupResult.success;

    this.logger[isSuccess ? 'success' : 'warn']('Restart completed', {
      params: {
        shutdownSuccess: shutdownResult.success,
        startupSuccess: startupResult.success,
      },
    });

    return {
      shutdownResult,
      startupResult,
      success: isSuccess,
    };
  }

  // ============================================================================
  // Individual Component Lifecycle
  // ============================================================================

  /**
   * Start a specific component
   */
  public async startComponent(
    name: string,
    options?: StartComponentOptions,
  ): Promise<ComponentOperationResult> {
    return this.startComponentInternal(name, options);
  }

  /**
   * Stop a specific component
   */
  public async stopComponent(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    // Reject during bulk operations
    if (this.isStarting) {
      this.logger
        .entity(name)
        .warn('Cannot stop component during bulk startup', {
          params: { isStarting: this.isStarting },
        });

      return {
        success: false,
        componentName: name,
        reason: 'Bulk startup in progress',
        code: 'startup_in_progress',
      };
    }

    if (this.isShuttingDown) {
      this.logger.entity(name).warn('Cannot stop component during shutdown', {
        params: { isShuttingDown: this.isShuttingDown },
      });

      return {
        success: false,
        componentName: name,
        reason: 'Shutdown in progress',
        code: 'shutdown_in_progress',
      };
    }

    // Check for running dependents unless force option is true
    if (!options?.force) {
      const runningDependents = this.getRunningDependents(name);
      if (runningDependents.length > 0) {
        this.logger
          .entity(name)
          .warn('Cannot stop component with running dependents', {
            params: { runningDependents },
          });

        return {
          success: false,
          componentName: name,
          reason: `Component has running dependents: ${runningDependents.join(', ')}. Use { force: true } option to bypass.`,
          code: 'has_running_dependents',
        };
      }
    }

    return this.stopComponentInternal(name, options);
  }

  /**
   * Restart a component (stop then start)
   */
  public async restartComponent(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult> {
    // Reject during bulk operations
    if (this.isStarting || this.isShuttingDown) {
      this.logger
        .entity(name)
        .warn('Cannot restart component during bulk operation', {
          params: {
            isStarting: this.isStarting,
            isShuttingDown: this.isShuttingDown,
          },
        });

      return {
        success: false,
        componentName: name,
        reason: this.isStarting
          ? 'Bulk startup in progress'
          : 'Shutdown in progress',
        code: this.isStarting ? 'startup_in_progress' : 'shutdown_in_progress',
      };
    }

    // First stop the component
    const stopResult = await this.stopComponent(name, options?.stopOptions);

    if (!stopResult.success) {
      return {
        success: false,
        componentName: name,
        reason: `Failed to stop: ${stopResult.reason}`,
        code: 'restart_stop_failed',
        error: stopResult.error,
      };
    }

    // Then start it
    const startResult = await this.startComponent(name, options?.startOptions);

    if (!startResult.success) {
      return {
        success: false,
        componentName: name,
        reason: `Failed to start: ${startResult.reason}`,
        code: 'restart_start_failed',
        error: startResult.error,
      };
    }

    return {
      success: true,
      componentName: name,
      status: this.getComponentStatus(name),
    };
  }

  // ============================================================================
  // Signal Integration
  // ============================================================================

  /**
   * Attach signal handlers for graceful shutdown, reload, info, and debug.
   * Creates ProcessSignalManager instance if needed and attaches it.
   * Idempotent - calling multiple times has no effect.
   */
  public attachSignals(): void {
    // Check if already attached (not just if instance exists)
    if (this.processSignalManager?.getStatus().isAttached) {
      return; // Already attached
    }

    // Create instance if it doesn't exist
    if (!this.processSignalManager) {
      this.processSignalManager = new ProcessSignalManager({
        onShutdownRequested: (method: ShutdownSignal) => {
          this.handleShutdownRequest(method);
        },
        // Note: Signal-triggered handlers are fire-and-forget by design.
        // Node.js signal handlers (process.on) cannot return values, so these
        // async handlers execute but their return values are not accessible.
        // Use triggerReload(), triggerInfo(), triggerDebug() for programmatic
        // access to results.
        onReloadRequested: () => this.handleReloadRequest('signal'),
        onInfoRequested: () => this.handleInfoRequest('signal'),
        onDebugRequested: () => this.handleDebugRequest('signal'),
      });
    }

    this.processSignalManager.attach();
    this.lifecycleEvents.lifecycleManagerSignalsAttached();
  }

  /**
   * Detach signal handlers.
   * Idempotent - calling multiple times has no effect.
   */
  public detachSignals(): void {
    if (!this.processSignalManager?.getStatus().isAttached) {
      return; // Not attached
    }

    this.processSignalManager.detach();
    this.lifecycleEvents.lifecycleManagerSignalsDetached();
  }

  /**
   * Get status information about signal handling.
   */
  public getSignalStatus(): LifecycleSignalStatus {
    if (!this.processSignalManager) {
      return {
        isAttached: false,
        handlers: {
          shutdown: false,
          reload: false,
          info: false,
          debug: false,
        },
        listeningFor: {
          shutdownSignals: false,
          reloadSignal: false,
          infoSignal: false,
          debugSignal: false,
          keypresses: false,
        },
        shutdownMethod: this.shutdownMethod,
      };
    }

    return {
      ...this.processSignalManager.getStatus(),
      shutdownMethod: this.shutdownMethod,
    };
  }

  /**
   * Enable Logger exit hook integration
   *
   * Sets up the logger's beforeExit callback to trigger graceful component shutdown.
   * When `logger.exit(code)` is called (or `logger.error('msg', { exitCode: 1 })`),
   * the LifecycleManager will stop all components before the process exits.
   *
   * The shutdown is subject to the configured shutdown timeout (default: 30000ms).
   * If shutdown exceeds this timeout, the process will exit anyway to prevent hanging.
   *
   * This method is idempotent and can be called multiple times safely.
   *
   * **Note:** This overwrites any existing beforeExit callback on the logger.
   * If you need custom exit logic, set it up manually with `logger.setBeforeExitCallback()`.
   *
   * @example
   * ```typescript
   * const logger = new Logger();
   * const lifecycle = new LifecycleManager({
   *   logger,
   *   enableLoggerExitHook: true, // Auto-enable
   *   shutdownOptions: { timeoutMS: 30000 },   // Max 30s for shutdown
   * });
   *
   * // Or enable manually later
   * lifecycle.enableLoggerExitHook();
   *
   * // Now logger.exit() will trigger graceful shutdown
   * logger.error('Fatal error', { exitCode: 1 });
   * // Components stop gracefully (up to shutdown timeout) before process exits
   * ```
   */
  public enableLoggerExitHook(): void {
    this.rootLogger.setBeforeExitCallback(
      async (exitCode: number, isFirstExit: boolean) => {
        // If shutdown is already in progress, tell logger to wait
        if (this.isShuttingDown) {
          this.logger.debug('Logger exit called during shutdown, waiting...', {
            params: { exitCode },
          });

          return { action: 'wait' as const };
        }

        if (isFirstExit) {
          this.logger.info('Logger exit triggered, stopping components...', {
            params: { exitCode, timeoutMS: this.shutdownOptions?.timeoutMS },
          });

          // Stop all components with global timeout
          await this.stopAllComponents({
            ...this.shutdownOptions,
          });
        }

        // Proceed with exit
        return { action: 'proceed' as const };
      },
    );

    this.logger.debug('Logger exit hook enabled', {
      params: { timeoutMS: this.shutdownOptions?.timeoutMS },
    });
  }

  /**
   * Manually trigger a reload event.
   * @returns Result of broadcasting reload to components
   */
  public async triggerReload(): Promise<SignalBroadcastResult> {
    return this.handleReloadRequest();
  }

  /**
   * Manually trigger an info event.
   * @returns Result of broadcasting info to components
   */
  public async triggerInfo(): Promise<SignalBroadcastResult> {
    return this.handleInfoRequest();
  }

  /**
   * Manually trigger a debug event.
   * @returns Result of broadcasting debug to components
   */
  public async triggerDebug(): Promise<SignalBroadcastResult> {
    return this.handleDebugRequest();
  }

  // ============================================================================
  // Component Messaging
  // ============================================================================

  /**
   * Send a message to a specific component
   *
   * Delivers a message to the component's onMessage handler if implemented.
   * The 'from' parameter is automatically tracked based on calling context.
   *
   * @param componentName - Name of target component
   * @param payload - Message payload (any type)
   * @param options - Optional message options (timeout override)
   * @returns Result with sent status, data returned from handler, and any errors
   */
  public async sendMessageToComponent(
    componentName: string,
    payload: unknown,
    options?: SendMessageOptions,
  ): Promise<MessageResult> {
    return this.sendMessageInternal(componentName, payload, null, options);
  }

  /**
   * Broadcast a message to multiple components
   *
   * Sends the same message to multiple components (by default, all running components).
   * The 'from' parameter is automatically tracked based on calling context.
   *
   * @param payload - Message payload (any type)
   * @param options - Filtering options and message timeout override
   * @returns Array of results, one per component
   */
  public async broadcastMessage(
    payload: unknown,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    return this.broadcastMessageInternal(payload, null, options);
  }

  // ============================================================================
  // Health Checks
  // ============================================================================

  /**
   * Check the health of a specific component
   *
   * Calls the component's healthCheck() method if implemented.
   * Times out after component's healthCheckTimeoutMS.
   *
   * @param name - Component name
   * @returns Health check result with status, message, details, and timing
   */
  public async checkComponentHealth(name: string): Promise<HealthCheckResult> {
    const startTime = Date.now();

    // Check if component exists
    const component = this.components.find((c) => c.getName() === name);

    if (!component) {
      return {
        name,
        healthy: false,
        message: 'Component not found',
        checkedAt: startTime,
        durationMS: 0,
        error: null,
        timedOut: false,
        code: 'not_found',
      };
    }

    // Check if component is running
    if (!this.isComponentRunning(name)) {
      const isStalled = this.stalledComponents.has(name);
      return {
        name,
        healthy: false,
        message: isStalled ? 'Component is stalled' : 'Component not running',
        checkedAt: startTime,
        durationMS: Date.now() - startTime,
        error: null,
        timedOut: false,
        code: isStalled ? 'stalled' : 'stopped',
      };
    }

    // Check if component implements healthCheck
    if (!component.healthCheck) {
      // No health check implemented - assume healthy
      return {
        name,
        healthy: true,
        message: 'No health check implemented',
        checkedAt: startTime,
        durationMS: Date.now() - startTime,
        error: null,
        timedOut: false,
        code: 'no_handler',
      };
    }

    this.lifecycleEvents.componentHealthCheckStarted(name);

    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      // Create timeout promise
      const timeoutMS = component.healthCheckTimeoutMS;
      const timeoutResult: ComponentHealthResult = {
        healthy: false,
        message: 'Health check timed out',
      };
      const timeoutPromise = new Promise<ComponentHealthResult>((resolve) => {
        timeoutHandle = setTimeout(() => {
          resolve(timeoutResult);
        }, timeoutMS);
      });

      // Race health check against timeout
      const healthCheckPromise = component.healthCheck();
      const result = await Promise.race([healthCheckPromise, timeoutPromise]);

      // Normalize boolean to ComponentHealthResult
      const isTimedOut = result === timeoutResult;
      if (isTimedOut) {
        this.logger.entity(name).warn('Health check timed out', {
          params: { timeoutMS },
        });
        // Prevent unhandled rejection if health check throws after timeout
        Promise.resolve(healthCheckPromise).catch(() => {
          // Intentionally ignore errors after timeout
        });
      }
      const healthResult: ComponentHealthResult =
        typeof result === 'boolean' ? { healthy: result } : result;

      const durationMS = Date.now() - startTime;
      this.lifecycleEvents.componentHealthCheckCompleted({
        name,
        healthy: healthResult.healthy,
        message: healthResult.message,
        details: healthResult.details,
        durationMS,
        timedOut: isTimedOut,
      });

      return {
        name,
        healthy: healthResult.healthy,
        message: healthResult.message,
        details: healthResult.details,
        checkedAt: startTime,
        durationMS,
        error: null,
        timedOut: isTimedOut,
        code: isTimedOut ? 'timeout' : 'ok',
      };
    } catch (error) {
      const durationMS = Date.now() - startTime;
      const err = error as Error;

      this.logger
        .entity(name)
        .error('Health check failed', { params: { error: err.message } });
      this.lifecycleEvents.componentHealthCheckFailed(name, err);

      return {
        name,
        healthy: false,
        message: 'Health check threw error',
        checkedAt: startTime,
        durationMS,
        error: err,
        timedOut: false,
        code: 'error',
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Check the health of all running components
   *
   * Runs health checks on all running components in parallel.
   * Overall health is true only if ALL components are healthy.
   *
   * @returns Aggregate health report with individual component results
   */
  public async checkAllHealth(): Promise<HealthReport> {
    const startTime = Date.now();

    // Get all running components
    const runningComponents = this.components.filter((c) =>
      this.isComponentRunning(c.getName()),
    );

    // Check health of all running components in parallel
    const healthChecks = runningComponents.map((c) =>
      this.checkComponentHealth(c.getName()),
    );

    const results = await Promise.all(healthChecks);

    // Overall healthy only if all components are healthy
    const isOverallHealthy = results.every((r) => r.healthy);
    const hasTimeout = results.some((r) => r.timedOut);
    const hasError = results.some((r) => r.code === 'error');
    // "no_handler" is treated as healthy by design (implicit OK).
    const hasDegraded = results.some(
      (r) =>
        r.code === 'stopped' ||
        r.code === 'stalled' ||
        (r.code !== 'no_handler' && !r.healthy),
    );
    const code = hasError
      ? 'error'
      : hasTimeout
        ? 'timeout'
        : hasDegraded
          ? 'degraded'
          : 'ok';

    return {
      healthy: isOverallHealthy,
      components: results,
      checkedAt: startTime,
      durationMS: Date.now() - startTime,
      timedOut: hasTimeout,
      code,
    };
  }

  // ============================================================================
  // Shared Values (getValue Pattern)
  // ============================================================================

  /**
   * Request a value from a component by key
   *
   * Calls the component's getValue(key, from) method if implemented.
   * The 'from' parameter is automatically tracked based on calling context.
   *
   * @param componentName - Name of component to request value from
   * @param key - Value key to request
   * @returns Result with found status, value, and metadata
   */
  public getValue<T = unknown>(
    componentName: string,
    key: string,
    options?: GetValueOptions,
  ): ValueResult<T> {
    return this.getValueInternal<T>(componentName, key, null, options);
  }

  // ============================================================================
  // Internal Methods (Private - accessed via callbacks)
  // ============================================================================

  /**
   * Internal message sending with explicit 'from' parameter
   *
   * @param componentName - Target component name
   * @param payload - Message payload
   * @param from - Sender component name (null if external)
   */
  private async sendMessageInternal(
    componentName: string,
    payload: unknown,
    from: string | null,
    options?: SendMessageOptions,
  ): Promise<MessageResult> {
    // Check if shutting down
    if (this.isShuttingDown) {
      return {
        sent: false,
        componentFound: this.hasComponent(componentName),
        componentRunning: false,
        handlerImplemented: false,
        data: undefined,
        error: new Error('Cannot send message: shutdown in progress'),
        timedOut: false,
        code: 'error',
      };
    }

    // Find component
    const component = this.components.find(
      (c) => c.getName() === componentName,
    );

    if (!component) {
      return {
        sent: false,
        componentFound: false,
        componentRunning: false,
        handlerImplemented: false,
        data: undefined,
        error: null,
        timedOut: false,
        code: 'not_found',
      };
    }

    const isRunning = this.isComponentRunning(componentName);
    const isStalled = this.stalledComponents.has(componentName);
    const allowStopped = options?.includeStopped === true;
    const allowStalled = options?.includeStalled === true;
    const isStopped = !isRunning && !isStalled;

    // Check if running or explicitly allowed
    if (!isRunning) {
      if ((isStalled && allowStalled) || (isStopped && allowStopped)) {
        // Allowed to send to non-running component
      } else {
        return {
          sent: false,
          componentFound: true,
          componentRunning: false,
          handlerImplemented: false,
          data: undefined,
          error: null,
          timedOut: false,
          code: isStalled ? 'stalled' : 'stopped',
        };
      }
    }

    // Check if handler implemented
    if (!component.onMessage) {
      return {
        sent: false,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: false,
        data: undefined,
        error: null,
        timedOut: false,
        code: 'no_handler',
      };
    }

    // Send message
    this.lifecycleEvents.componentMessageSent({ componentName, from, payload });

    const timeoutMS = options?.timeout ?? this.messageTimeoutMS;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutResult = { timedOut: true } as const;

    try {
      let result: unknown;
      try {
        result = component.onMessage(payload, from);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger
          .entity(componentName)
          .error('Message handler failed', { params: { error: err, from } });
        this.lifecycleEvents.componentMessageFailed(componentName, from, err, {
          timedOut: false,
          code: 'error',
          componentFound: true,
          componentRunning: isRunning,
          handlerImplemented: true,
          data: undefined,
        });

        return {
          sent: true,
          componentFound: true,
          componentRunning: isRunning,
          handlerImplemented: true,
          data: undefined,
          error: err,
          timedOut: false,
          code: 'error',
        };
      }

      const handlerPromise = isPromise(result)
        ? result
        : Promise.resolve(result);

      const outcome =
        timeoutMS > 0
          ? await Promise.race([
              handlerPromise,
              new Promise<typeof timeoutResult>((resolve) => {
                timeoutHandle = setTimeout(() => {
                  resolve(timeoutResult);
                }, timeoutMS);
              }),
            ])
          : await handlerPromise;

      if (outcome === timeoutResult) {
        this.logger.entity(componentName).warn('Message handler timed out', {
          params: { from, timeoutMS },
        });
        // Prevent unhandled rejection if handler throws after timeout
        Promise.resolve(handlerPromise).catch(() => {
          // Intentionally ignore errors after timeout
        });
        return {
          sent: true,
          componentFound: true,
          componentRunning: isRunning,
          handlerImplemented: true,
          data: undefined,
          error: null,
          timedOut: true,
          code: 'timeout',
        };
      }

      return {
        sent: true,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: true,
        data: outcome,
        error: null,
        timedOut: false,
        code: 'sent',
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.entity(componentName).error('Message handler failed', {
        params: { error: err, from, timeoutMS },
      });
      this.lifecycleEvents.componentMessageFailed(componentName, from, err, {
        timedOut: false,
        code: 'error',
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: true,
        data: undefined,
      });

      return {
        sent: true,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: true,
        data: undefined,
        error: err,
        timedOut: false,
        code: 'error',
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Internal broadcast with explicit 'from' parameter
   *
   * @param payload - Message payload
   * @param from - Sender component name (null if external)
   * @param options - Filtering options
   */
  private async broadcastMessageInternal(
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    this.lifecycleEvents.componentBroadcastStarted(from, payload);

    const results: BroadcastResult[] = [];

    // Determine which components to broadcast to
    let targetComponents = this.components;

    const hasExplicitTargets =
      options?.componentNames !== undefined &&
      options.componentNames.length > 0;

    // Filter by names if specified
    if (hasExplicitTargets) {
      const componentNames = options.componentNames;
      targetComponents = targetComponents.filter((c) =>
        componentNames.includes(c.getName()),
      );
    }

    const allowStopped = options?.includeStopped === true;
    const allowStalled = options?.includeStalled === true;

    // Filter by running/stalled/stopped state unless explicitly included
    if (!allowStopped && !allowStalled && !hasExplicitTargets) {
      targetComponents = targetComponents.filter((c) =>
        this.isComponentRunning(c.getName()),
      );
    } else if (!hasExplicitTargets) {
      targetComponents = targetComponents.filter((c) => {
        const name = c.getName();
        const isRunning = this.isComponentRunning(name);

        if (isRunning) {
          return true;
        }

        const isStalled = this.stalledComponents.has(name);

        if (isStalled) {
          return allowStalled;
        }

        return allowStopped;
      });
    }

    // Send to each component
    for (const component of targetComponents) {
      const name = component.getName();
      const isRunning = this.isComponentRunning(name);
      const isStalled = this.stalledComponents.has(name);
      const isStopped = !isRunning && !isStalled;
      const allowNonRunning =
        (isStalled && allowStalled) || (isStopped && allowStopped);

      // Skip if not running and not explicitly allowed
      if (!isRunning && !allowNonRunning) {
        results.push({
          name,
          sent: false,
          running: false,
          data: undefined,
          error: null,
          timedOut: false,
          code: isStalled ? 'stalled' : 'stopped',
        });
        continue;
      }

      // Send message using internal method
      const messageResult = await this.sendMessageInternal(
        name,
        payload,
        from,
        options,
      );

      results.push({
        name,
        sent: messageResult.sent,
        running: messageResult.componentRunning,
        data: messageResult.data,
        error: messageResult.error,
        timedOut: messageResult.timedOut,
        code: messageResult.code === 'not_found' ? 'error' : messageResult.code,
      });
    }

    this.lifecycleEvents.componentBroadcastCompleted(
      from,
      results.length,
      results,
    );

    return results;
  }

  /**
   * Internal getValue with explicit 'from' parameter
   *
   * @param componentName - Target component name
   * @param key - Value key
   * @param from - Requester component name (null if external)
   */
  private getValueInternal<T = unknown>(
    componentName: string,
    key: string,
    from: string | null,
    options?: GetValueOptions,
  ): ValueResult<T> {
    this.lifecycleEvents.componentValueRequested(componentName, key, from);

    // Find component
    const component = this.components.find(
      (c) => c.getName() === componentName,
    );

    if (!component) {
      this.lifecycleEvents.componentValueReturned(componentName, key, from, {
        found: false,
        value: undefined,
        componentFound: false,
        componentRunning: false,
        handlerImplemented: false,
        requestedBy: from,
        code: 'not_found',
      });
      return {
        found: false,
        value: undefined,
        componentFound: false,
        componentRunning: false,
        handlerImplemented: false,
        requestedBy: from,
        code: 'not_found',
      };
    }

    // Check if running
    const isRunning = this.isComponentRunning(componentName);
    const isStalled = this.stalledComponents.has(componentName);
    const allowStopped = options?.includeStopped === true;
    const allowStalled = options?.includeStalled === true;
    const isStopped = !isRunning && !isStalled;

    if (
      !isRunning &&
      !((isStopped && allowStopped) || (isStalled && allowStalled))
    ) {
      const code = isStalled ? 'stalled' : 'stopped';
      this.lifecycleEvents.componentValueReturned(componentName, key, from, {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: false,
        handlerImplemented: false,
        requestedBy: from,
        code,
      });
      return {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: false,
        handlerImplemented: false,
        requestedBy: from,
        code,
      };
    }

    // Check if handler implemented
    if (!component.getValue) {
      this.lifecycleEvents.componentValueReturned(componentName, key, from, {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: false,
        requestedBy: from,
        code: 'no_handler',
      });
      return {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: false,
        requestedBy: from,
        code: 'no_handler',
      };
    }

    // Get value
    try {
      const componentResult = component.getValue(key, from);
      const wasFound = componentResult.found;
      const value = componentResult.value;

      this.lifecycleEvents.componentValueReturned(componentName, key, from, {
        found: wasFound,
        value,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: true,
        requestedBy: from,
        code: wasFound ? 'found' : 'not_found',
      });

      return {
        found: wasFound,
        value: value as T | undefined,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: true,
        requestedBy: from,
        code: wasFound ? 'found' : 'not_found',
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.entity(componentName).error('getValue handler failed', {
        params: { error: err, key, from },
      });

      this.lifecycleEvents.componentValueReturned(componentName, key, from, {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: true,
        requestedBy: from,
        code: 'error',
      });

      return {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: isRunning,
        handlerImplemented: true,
        requestedBy: from,
        code: 'error',
      };
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  private updateStartedFlag(): void {
    this.isStarted =
      this.runningComponents.size > 0 || this.stalledComponents.size > 0;
  }

  /**
   * Internal method that handles component registration logic.
   * Used by both registerComponent and insertComponentAt.
   */
  private async registerComponentInternal(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName?: string,
    isInsertAction = false,
    _options?: RegisterOptions,
  ): Promise<InsertComponentAtResult> {
    const componentName = component.getName();
    const registrationIndexBefore = this.getComponentIndex(componentName);

    try {
      if (!this.isInsertPosition(position)) {
        this.logger.entity(componentName).warn('Invalid insertion position', {
          params: { position },
        });
        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: 'invalid_position',
          message: `Invalid insert position: "${String(position)}". Expected one of: start, end, before, after.`,
          registrationIndexBefore,
          registrationIndexAfter: registrationIndexBefore,
          requestedPosition: isInsertAction
            ? { position, targetComponentName }
            : undefined,
          manualPositionRespected: false,
        });

        return this.buildInsertResultFailure({
          componentName,
          position,
          targetComponentName,
          registrationIndexBefore,
          code: 'invalid_position',
          reason: `Invalid insert position: "${String(position)}". Expected one of: start, end, before, after.`,
          targetFound: undefined,
        });
      }

      // Block registration during shutdown
      if (this.isShuttingDown) {
        this.logger
          .entity(componentName)
          .warn('Cannot register component during shutdown');
        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: 'shutdown_in_progress',
          message:
            'Cannot register component while shutdown is in progress (isShuttingDown=true).',
          registrationIndexBefore,
          registrationIndexAfter: registrationIndexBefore,
          requestedPosition: isInsertAction
            ? { position, targetComponentName }
            : undefined,
          manualPositionRespected: false,
        });

        return this.buildInsertResultFailure({
          componentName,
          position,
          targetComponentName,
          registrationIndexBefore,
          code: 'shutdown_in_progress',
          reason:
            'Cannot register component while shutdown is in progress (isShuttingDown=true).',
          targetFound: undefined,
        });
      }

      // Block registration during startup if this component would be a dependency
      // for any already-registered component (would break dependency ordering)
      if (this.isRequiredDependencyDuringStartup(componentName)) {
        this.logger
          .entity(componentName)
          .warn(
            'Cannot register component during startup - it is a required dependency for other components',
          );
        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: 'startup_in_progress',
          message:
            'Cannot register component during startup when it is a required dependency for other components.',
          registrationIndexBefore,
          registrationIndexAfter: registrationIndexBefore,
          requestedPosition: isInsertAction
            ? { position, targetComponentName }
            : undefined,
          manualPositionRespected: false,
        });

        return this.buildInsertResultFailure({
          componentName,
          position,
          targetComponentName,
          registrationIndexBefore,
          code: 'startup_in_progress',
          reason:
            'Cannot register component during startup when it is a required dependency for other components.',
          targetFound: undefined,
        });
      }

      // Check if component instance is already registered
      if (this.hasComponentInstance(component)) {
        this.logger
          .entity(componentName)
          .warn('Component instance already registered');
        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: 'duplicate_instance',
          message: 'Component instance is already registered.',
          registrationIndexBefore,
          registrationIndexAfter: registrationIndexBefore,
          requestedPosition: isInsertAction
            ? { position, targetComponentName }
            : undefined,
          manualPositionRespected: false,
        });

        return this.buildInsertResultFailure({
          componentName,
          position,
          targetComponentName,
          registrationIndexBefore,
          code: 'duplicate_instance',
          reason: 'Component instance is already registered.',
          targetFound: undefined,
        });
      }

      // Check if component name is already registered
      if (registrationIndexBefore !== null) {
        this.logger
          .entity(componentName)
          .warn('Component with this name already registered');
        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: 'duplicate_name',
          message: `Component "${componentName}" is already registered.`,
          registrationIndexBefore,
          registrationIndexAfter: registrationIndexBefore,
          requestedPosition: isInsertAction
            ? { position, targetComponentName }
            : undefined,
          manualPositionRespected: false,
        });

        return this.buildInsertResultFailure({
          componentName,
          position,
          targetComponentName,
          registrationIndexBefore,
          code: 'duplicate_name',
          reason: `Component "${componentName}" is already registered.`,
          targetFound: undefined,
        });
      }

      // Get the insertion index for the component
      const insertIndex = this.getInsertIndex(position, targetComponentName);
      if (insertIndex === null) {
        this.logger.entity(componentName).warn('Target component not found', {
          params: { target: targetComponentName },
        });
        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: 'target_not_found',
          target: targetComponentName,
          message: `Target component "${targetComponentName ?? ''}" not found in registry.`,
          registrationIndexBefore,
          registrationIndexAfter: null,
          requestedPosition: isInsertAction
            ? { position, targetComponentName }
            : undefined,
          manualPositionRespected: false,
          targetFound: false,
        });

        // Block registration during startup if this component would be a dependency
        // for any already-registered component (would break dependency ordering)
        let startupOrder: string[];

        try {
          startupOrder = this.getStartupOrderInternal();
        } catch (error) {
          // Defensive: This should never happen in normal operation since we validate
          // cycles before registration. However, if this.components somehow contains
          // a cycle (e.g., due to internal bugs or direct mutations), we must not
          // throw from an error handler. Return empty array to fail gracefully.
          this.logger.warn('Failed to compute startup order in error handler', {
            params: { error: error instanceof Error ? error.message : error },
          });

          startupOrder = [];
        }

        return {
          action: 'insert',
          success: false,
          registered: false,
          componentName,
          reason: `Target component "${targetComponentName ?? ''}" not found in registry.`,
          code: 'target_not_found',
          registrationIndexBefore: null,
          registrationIndexAfter: null,
          startupOrder,
          requestedPosition: { position, targetComponentName },
          manualPositionRespected: false,
          targetFound: false,
          duringStartup: this.isStarting,
          autoStartAttempted: false,
          startResult: undefined,
        };
      }

      // Compute dependency order *before* committing registration mutations.
      // This avoids leaving the registry/state maps inconsistent if a dependency
      // cycle is detected.
      const nextComponents = [...this.components];
      nextComponents.splice(insertIndex, 0, component);

      let startupOrder: string[];

      try {
        startupOrder = this.getStartupOrderInternal(nextComponents);
      } catch (error) {
        if (error instanceof DependencyCycleError) {
          this.logger
            .entity(componentName)
            .warn('Registration rejected due to dependency cycle', {
              params: { cycle: error.additionalInfo.cycle },
            });
          this.lifecycleEvents.componentRegistrationRejected({
            name: componentName,
            reason: 'dependency_cycle',
            cycle: error.additionalInfo.cycle,
            message: error.message,
            registrationIndexBefore,
            registrationIndexAfter: registrationIndexBefore,
            requestedPosition: isInsertAction
              ? { position, targetComponentName }
              : undefined,
            manualPositionRespected: false,
            targetFound:
              position === 'before' || position === 'after' ? true : undefined,
          });

          return this.buildInsertResultFailure({
            componentName,
            position,
            targetComponentName,
            registrationIndexBefore,
            code: 'dependency_cycle',
            reason: error.message,
            error,
            targetFound:
              position === 'before' || position === 'after' ? true : undefined,
          });
        }
        throw error;
      }

      // Commit registration
      this.components.splice(insertIndex, 0, component);

      // Create callbacks for component-scoped lifecycle
      const internalCallbacks: LifecycleInternalCallbacks = {
        sendMessageInternal: (
          compName: string,
          payload: unknown,
          from: string | null,
          options?: SendMessageOptions,
        ) => this.sendMessageInternal(compName, payload, from, options),
        broadcastMessageInternal: (
          payload: unknown,
          from: string | null,
          opts?: BroadcastOptions,
        ) => this.broadcastMessageInternal(payload, from, opts),
        getValueInternal: <T = unknown>(
          compName: string,
          key: string,
          from: string | null,
        ) => this.getValueInternal<T>(compName, key, from),
      };

      // Assign lifecycle reference to component
      (component as unknown as { lifecycle: ComponentLifecycleRef }).lifecycle =
        new ComponentLifecycle(this, componentName, internalCallbacks);

      // Initialize state
      this.componentStates.set(componentName, 'registered');
      this.componentTimestamps.set(componentName, {
        startedAt: null,
        stoppedAt: null,
      });
      this.componentErrors.set(componentName, null);

      // Check if manual position was respected for logging
      const isManualPositionRespected = this.isManualPositionRespected({
        componentName,
        position,
        targetComponentName,
        startupOrder,
      });

      // Get the final registration index after insertion
      const registrationIndexAfter = this.getComponentIndex(componentName);
      const isTargetFound =
        position === 'before' || position === 'after'
          ? this.getComponentIndex(targetComponentName ?? '') !== null
          : undefined;

      if (isInsertAction) {
        this.logger.entity(componentName).info('Component inserted', {
          params: { position, index: registrationIndexAfter },
        });
      } else {
        this.logger.entity(componentName).info('Component registered', {
          params: { index: registrationIndexAfter },
        });
      }

      // Determine if auto-start will be attempted
      const shouldAutoStart = _options?.autoStart === true;
      let didAutoStartAttempt = false;

      // Handle AutoStart if requested and capture result
      let startResult: ComponentOperationResult | undefined;

      if (shouldAutoStart) {
        if (this.isStarted) {
          // Manager is already running - start the component directly
          this.logger
            .entity(componentName)
            .info('AutoStart: starting component (manager is running)');
          startResult = await this.startComponentInternal(componentName);
          didAutoStartAttempt = true;
        } else if (this.isStarting) {
          // Manager is currently starting - allow during bulk startup
          this.logger
            .entity(componentName)
            .info('AutoStart: starting component (during bulk startup)');
          startResult = await this.startComponentInternal(componentName, {
            allowDuringBulkStartup: true,
          });
          didAutoStartAttempt = true;
        } else {
          // Manager is not running - attempt to start just this component
          this.logger
            .entity(componentName)
            .info('AutoStart: starting component (manager not running)');
          startResult = await this.startComponentInternal(componentName);
          didAutoStartAttempt = true;
        }
      }

      const didAutoStartSucceed = didAutoStartAttempt
        ? startResult?.success === true
        : undefined;

      // Emit registration event
      this.lifecycleEvents.componentRegistered({
        name: componentName,
        index: registrationIndexAfter,
        action: isInsertAction ? 'insert' : 'register',
        registrationIndexBefore,
        registrationIndexAfter,
        startupOrder,
        requestedPosition: isInsertAction
          ? { position, targetComponentName }
          : undefined,
        manualPositionRespected: isManualPositionRespected,
        targetFound: isTargetFound,
        duringStartup: this.isStarting,
        autoStartAttempted: didAutoStartAttempt,
        autoStartSucceeded: didAutoStartSucceed,
      });

      return {
        action: 'insert',
        success: true,
        registered: true,
        componentName,
        registrationIndexBefore: null,
        registrationIndexAfter,
        startupOrder,
        requestedPosition: { position, targetComponentName },
        manualPositionRespected: isManualPositionRespected,
        targetFound: isTargetFound,
        duringStartup: this.isStarting,
        autoStartAttempted: didAutoStartAttempt,
        autoStartSucceeded: didAutoStartSucceed,
        startResult,
      };
    } catch (error) {
      // Handle unexpected errors during registration
      const err = error as Error;
      const code: RegistrationFailureCode =
        err instanceof DependencyCycleError
          ? 'dependency_cycle'
          : 'unknown_error';

      this.logger
        .entity(componentName)
        .error('Registration failed with unexpected error', {
          params: { error: err },
        });
      this.lifecycleEvents.componentRegistrationRejected({
        name: componentName,
        reason: code,
        message: err.message,
        registrationIndexBefore,
        registrationIndexAfter: registrationIndexBefore,
        startupOrder: [],
        requestedPosition: isInsertAction
          ? { position, targetComponentName }
          : undefined,
        manualPositionRespected: false,
        targetFound:
          position === 'before' || position === 'after' ? false : undefined,
        ...(err instanceof DependencyCycleError
          ? { cycle: err.additionalInfo.cycle }
          : {}),
      });

      return {
        action: 'insert',
        success: false,
        registered: false,
        componentName,
        reason: err.message,
        code,
        error: err,
        registrationIndexBefore,
        registrationIndexAfter: registrationIndexBefore,
        startupOrder: [],
        requestedPosition: { position, targetComponentName },
        manualPositionRespected: false,
        targetFound:
          position === 'before' || position === 'after' ? false : undefined,
        duringStartup: this.isStarting,
        autoStartAttempted: false,
        startResult: undefined,
      };
    }
  }

  private async stopAllComponentsInternal(
    method: ShutdownMethod,
    options?: StopAllOptions,
  ): Promise<ShutdownResult> {
    const startTime = Date.now();
    const effectiveTimeout =
      options?.timeoutMS ?? this.shutdownOptions?.timeoutMS ?? 30000;
    const shouldRetryStalled = options?.retryStalled ?? true;
    const shouldHaltOnStall = options?.haltOnStall ?? true;

    // Reject if already shutting down
    if (this.isShuttingDown) {
      this.logger.warn(
        'Cannot stop all components: shutdown already in progress',
      );

      return {
        success: false,
        stoppedComponents: [],
        stalledComponents: [],
        durationMS: 0,
        reason: 'Shutdown already in progress',
        code: 'already_in_progress',
      };
    }

    // Set shutting down flag and track how shutdown was triggered
    this.isShuttingDown = true;
    this.shutdownMethod = method;
    const isDuringStartup = this.isStarting;
    this.logger.info('Stopping all components', { params: { method } });
    this.lifecycleEvents.lifecycleManagerShutdownInitiated(
      method,
      isDuringStartup,
    );

    // Get shutdown order (reverse topological order)
    let shutdownOrder: string[];

    try {
      const startupOrder = this.getStartupOrderInternal();
      shutdownOrder = [...startupOrder].reverse();
    } catch (error) {
      // If we can't resolve order due to cycle, fall back to reverse registration order
      this.logger.warn(
        'Could not resolve shutdown order, using registration order',
        {
          params: { error: (error as Error).message },
        },
      );
      shutdownOrder = this.components.map((c) => c.getName()).reverse();
    }

    const stalledComponentNames = new Set(this.stalledComponents.keys());

    // Filter to running components, plus stalled ones if retrying
    const runningComponentsToStop = shutdownOrder.filter(
      (name) =>
        this.isComponentRunning(name) ||
        (shouldRetryStalled && stalledComponentNames.has(name)),
    );

    const stoppedComponents: string[] = [];
    const stalledComponents: ComponentStallInfo[] = [];
    let hasTimedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      // Create shutdown operation promise
      const shutdownOperation = async () => {
        await this.runShutdownWarningPhase(runningComponentsToStop);

        // Stop each component in reverse dependency order
        for (const name of runningComponentsToStop) {
          this.logger.entity(name).info('Stopping component');

          // Use internal method to bypass bulk operation checks.
          // - If running: normal stop flow
          // - If stalled and retryStalled: force-phase retry
          // - If stalled and no retry: report component_stalled
          // - Otherwise: component_not_running
          const isRunning = this.isComponentRunning(name);
          const isStalled = stalledComponentNames.has(name);

          const result: ComponentOperationResult = isRunning
            ? await this.stopComponentInternal(name)
            : shouldRetryStalled && isStalled
              ? await this.retryStalledComponent(name)
              : isStalled
                ? {
                    success: false,
                    componentName: name,
                    reason: 'Component is stalled',
                    code: 'component_stalled',
                    status: this.getComponentStatus(name),
                  }
                : {
                    success: false,
                    componentName: name,
                    reason: 'Component not running',
                    code: 'component_not_running',
                    status: this.getComponentStatus(name),
                  };

          if (result.success) {
            stoppedComponents.push(name);
          } else {
            // Component failed to stop - track as stalled but continue
            this.logger
              .entity(name)
              .error('Component failed to stop, continuing with others', {
                params: { error: result.error?.message },
              });

            const stallInfo = this.stalledComponents.get(name);
            if (stallInfo) {
              stalledComponents.push(stallInfo);
            }

            if (shouldHaltOnStall) {
              this.logger.warn(
                'Halting shutdown after stall (haltOnStall=true)',
                { params: { stalledComponent: name } },
              );
              break;
            }
          }
        }
      };

      // Race shutdown against timeout if specified
      if (effectiveTimeout > 0) {
        const timeoutPromise = new Promise<void>((resolve) => {
          timeoutHandle = setTimeout(() => {
            hasTimedOut = true;

            this.logger.warn(
              'Shutdown timeout exceeded, returning partial results',
              {
                params: { timeoutMS: effectiveTimeout },
              },
            );

            resolve();
          }, effectiveTimeout);
        });

        await Promise.race([shutdownOperation(), timeoutPromise]);
      } else {
        await shutdownOperation();
      }

      const durationMS = Date.now() - startTime;
      const isSuccess = stalledComponents.length === 0;

      this.logger[isSuccess ? 'success' : 'warn']('Shutdown completed', {
        params: {
          stopped: stoppedComponents.length,
          stalled: stalledComponents.length,
          durationMS,
        },
      });

      this.lifecycleEvents.lifecycleManagerShutdownCompleted({
        durationMS,
        stoppedComponents,
        stalledComponents,
        method,
        duringStartup: isDuringStartup,
      });

      return {
        success: isSuccess,
        stoppedComponents,
        stalledComponents,
        durationMS,
        timedOut: hasTimedOut || undefined,
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      // Reset state
      this.isShuttingDown = false;
      this.updateStartedFlag();
    }
  }

  /**
   * Retry shutdown for a stalled component.
   * Attempts the force phase directly to avoid re-running a failing stop().
   */
  private async retryStalledComponent(
    name: string,
  ): Promise<ComponentOperationResult> {
    const component = this.getComponent(name);

    if (!component) {
      return {
        success: false,
        componentName: name,
        reason: 'Component not found',
        code: 'component_not_found',
      };
    }

    if (!this.stalledComponents.has(name)) {
      if (this.isComponentRunning(name)) {
        return this.stopComponentInternal(name);
      }

      return {
        success: false,
        componentName: name,
        reason: 'Component not running',
        code: 'component_not_running',
        status: this.getComponentStatus(name),
      };
    }

    this.logger
      .entity(name)
      .warn('Retrying stalled component shutdown (force phase)');

    return this.shutdownComponentForce(name, component, {
      gracefulPhaseRan: false,
      gracefulTimedOut: false,
      gracefulError: undefined,
      startedAt: Date.now(),
    });
  }

  /**
   * Internal start component method - bypasses bulk operation checks
   * Used by both startComponent() and startAllComponents()
   */
  private async startComponentInternal(
    name: string,
    options?: StartComponentOptions,
  ): Promise<ComponentOperationResult> {
    // ALWAYS reject during shutdown (never bypass this check)
    if (this.isShuttingDown) {
      this.logger.entity(name).warn('Cannot start component during shutdown', {
        params: { isShuttingDown: this.isShuttingDown },
      });

      return {
        success: false,
        componentName: name,
        reason: 'Shutdown in progress',
        code: 'shutdown_in_progress',
      };
    }

    // Reject during bulk startup (unless allowDuringBulkStartup is enabled)
    const allowDuringBulkStartup = options?.allowDuringBulkStartup === true;
    if (!allowDuringBulkStartup && this.isStarting) {
      this.logger
        .entity(name)
        .warn('Cannot start component during bulk startup', {
          params: { isStarting: this.isStarting },
        });

      return {
        success: false,
        componentName: name,
        reason: 'Bulk startup in progress',
        code: 'startup_in_progress',
      };
    }

    const allowRequiredDependencies =
      options?.allowRequiredDependencies === true;

    const component = this.getComponent(name);

    if (!component) {
      return {
        success: false,
        componentName: name,
        reason: 'Component not found',
        code: 'component_not_found',
      };
    }

    // Ensure dependencies are registered and running before starting.
    for (const dependencyName of component.getDependencies()) {
      const dependency = this.getComponent(dependencyName);
      if (!dependency) {
        return {
          success: false,
          componentName: name,
          reason: `Missing dependency "${dependencyName}"`,
          code: 'missing_dependency',
          status: this.getComponentStatus(name),
        };
      }

      if (!this.isComponentRunning(dependencyName)) {
        const isDependencyOptional = dependency.isOptional();

        // Check if we can skip this dependency
        if (allowRequiredDependencies) {
          // Explicit override - allow skipping both optional and required dependencies
          this.logger
            .entity(name)
            .warn(
              `Starting with non-running dependency "${dependencyName}" (allowRequiredDependencies=true)`,
            );
          continue;
        }

        if (isDependencyOptional) {
          // Optional dependencies never block startup
          this.logger
            .entity(name)
            .warn(
              `Starting with non-running optional dependency "${dependencyName}"`,
            );
          continue;
        }

        return {
          success: false,
          componentName: name,
          reason: `Dependency "${dependencyName}" is not running`,
          code: 'dependency_not_running',
          status: this.getComponentStatus(name),
        };
      }
    }

    const currentState = this.componentStates.get(name);
    if (currentState === 'starting') {
      return {
        success: false,
        componentName: name,
        reason: 'Component already starting',
        code: 'component_already_starting',
        status: this.getComponentStatus(name),
      };
    }

    // Check if already running
    if (this.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        reason: 'Component already running',
        code: 'component_already_running',
        status: this.getComponentStatus(name),
      };
    }

    // Set state to starting
    this.componentStates.set(name, 'starting');
    this.logger.entity(name).info('Starting component');
    this.lifecycleEvents.componentStarting(name);

    const timeoutMS = component.startupTimeoutMS;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      // Race against timeout
      const startPromise = component.start();

      if (timeoutMS > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Call abort callback if implemented
            if (component.onStartupAborted) {
              try {
                component.onStartupAborted();
              } catch (error) {
                this.logger
                  .entity(name)
                  .warn('Error in onStartupAborted callback', {
                    params: { error },
                  });
              }
            }
            // Prevent unhandled rejection if start() throws after timeout
            Promise.resolve(startPromise).catch(() => {
              // Intentionally ignore errors after timeout
            });
            reject(
              new ComponentStartTimeoutError({
                componentName: name,
                timeoutMS,
              }),
            );
          }, timeoutMS);
        });

        await Promise.race([startPromise, timeoutPromise]);
      } else {
        await startPromise;
      }

      // Update state
      this.componentStates.set(name, 'running');
      this.runningComponents.add(name);
      this.updateStartedFlag();

      // Auto-attach signals if this is the first component and option is enabled
      if (
        this.attachSignalsOnStart &&
        this.runningComponents.size === 1 &&
        !this.processSignalManager
      ) {
        this.logger.info(
          'Auto-attaching process signals on first component start',
        );
        this.attachSignals();
      }

      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.startedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component started');
      const status = this.getComponentStatus(name);
      this.lifecycleEvents.componentStarted(name, status);

      return {
        success: true,
        componentName: name,
        status: this.getComponentStatus(name),
      };
    } catch (error) {
      const err = error as Error;

      // Store error
      this.componentErrors.set(name, err);

      // Check if it was a timeout
      if (
        err instanceof ComponentStartTimeoutError &&
        err.additionalInfo.componentName === name
      ) {
        this.componentStates.set(name, 'registered'); // Reset state
        this.logger.entity(name).error('Component startup timed out', {
          params: { error: err.message },
        });
        this.lifecycleEvents.componentStartTimeout(name, err, {
          timeoutMS,
          reason: err.message,
        });
      } else {
        this.componentStates.set(name, 'registered'); // Reset state
        this.logger.entity(name).error('Component failed to start', {
          params: { error: err.message },
        });
        this.lifecycleEvents.componentStartFailed(name, err, {
          reason: err.message,
        });
      }

      return {
        success: false,
        componentName: name,
        reason: err.message,
        code:
          err instanceof ComponentStartTimeoutError
            ? 'start_timeout'
            : 'unknown_error',
        error: err,
        status: this.getComponentStatus(name),
      };
    } finally {
      // Ensure we always clean up the timeout handle, even if component.start()
      // rejects (non-timeout failure). Otherwise onStartupAborted() can fire
      // unexpectedly later and the timer handle leaks.
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Internal stop component method - bypasses bulk operation checks
   * Implements individual component graceful -> force shutdown (global warning handled elsewhere)
   */
  private async stopComponentInternal(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    const component = this.getComponent(name);

    if (!component) {
      return {
        success: false,
        componentName: name,
        reason: 'Component not found',
        code: 'component_not_found',
      };
    }

    // Check if stalled
    if (this.stalledComponents.has(name)) {
      return {
        success: false,
        componentName: name,
        reason: 'Component is stalled',
        code: 'component_stalled',
        status: this.getComponentStatus(name),
      };
    }

    // Check if not running
    if (!this.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        reason: 'Component not running',
        code: 'component_not_running',
        status: this.getComponentStatus(name),
      };
    }

    // Check if already stopping to prevent concurrent stop operations
    const currentState = this.componentStates.get(name);
    if (currentState === 'stopping' || currentState === 'force-stopping') {
      return {
        success: false,
        componentName: name,
        reason: `Component is already ${currentState}`,
        code: 'component_already_stopping',
        status: this.getComponentStatus(name),
      };
    }

    // Handle forceImmediate option - skip all phases and go straight to force
    if (options?.forceImmediate) {
      return this.shutdownComponentForce(name, component, {
        gracefulPhaseRan: false,
        gracefulTimedOut: false,
        gracefulError: undefined,
        startedAt: Date.now(),
      });
    }

    // Run three-phase shutdown
    return this.shutdownComponent(name, component, options);
  }

  /**
   * Two-phase shutdown: graceful -> force (global warning handled by stopAllComponents)
   *
   * Phase 1: Graceful (always - calls stop())
   * Phase 2: Force (if Phase 1 failed - calls onShutdownForce())
   */
  private async shutdownComponent(
    name: string,
    component: BaseComponent,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    const shutdownStartedAt = Date.now();

    // ============================================================================
    // Phase 1: Graceful (always)
    // ============================================================================
    const gracefulResult = await this.shutdownComponentGraceful(
      name,
      component,
      options,
    );

    if (gracefulResult.success) {
      return gracefulResult; // Graceful shutdown succeeded
    }

    // ============================================================================
    // Phase 2: Force (graceful failed)
    // ============================================================================
    this.logger
      .entity(name)
      .warn('Graceful shutdown failed, proceeding to force phase', {
        params: {
          reason: gracefulResult.reason,
          code: gracefulResult.code,
        },
      });

    return this.shutdownComponentForce(name, component, {
      gracefulPhaseRan: true,
      gracefulTimedOut: gracefulResult.code === 'stop_timeout',
      gracefulError: gracefulResult.error,
      startedAt: shutdownStartedAt,
    });
  }

  /**
   * Global warning phase (stopAllComponents only)
   * Calls onShutdownWarning() on running components with a global timeout
   */
  private async runShutdownWarningPhase(
    componentNames: string[],
  ): Promise<void> {
    const timeoutMS = this.shutdownWarningTimeoutMS;
    if (timeoutMS < 0 || componentNames.length === 0) {
      return;
    }

    // Only target running components that implement onShutdownWarning().
    const warningTargets: Array<{ name: string; component: BaseComponent }> =
      [];

    for (const name of componentNames) {
      const component = this.getComponent(name);

      if (component?.onShutdownWarning) {
        warningTargets.push({ name, component });
      }
    }

    if (warningTargets.length === 0) {
      return;
    }

    this.logger.info('Shutdown warning phase');
    this.lifecycleEvents.lifecycleManagerShutdownWarning(timeoutMS);

    if (timeoutMS === 0) {
      // Fire-and-forget: broadcast warnings without waiting for completion
      for (const { name, component } of warningTargets) {
        this.lifecycleEvents.componentShutdownWarning(name);
        Promise.resolve()
          .then(() => component.onShutdownWarning?.())
          .then(() => {
            this.lifecycleEvents.componentShutdownWarningCompleted(name);
          })
          .catch((error) => {
            this.logger.entity(name).warn('Shutdown warning phase failed', {
              params: { error: (error as Error).message },
            });
          });
      }

      // Flush microtask queue to ensure promises start executing before emitting completion
      await Promise.resolve();

      // Now that warnings are executing, emit global completion event
      this.lifecycleEvents.lifecycleManagerShutdownWarningCompleted(timeoutMS);

      return;
    }

    // Track completion so we can identify which components are still pending at timeout.
    const statuses = new Map<string, 'pending' | 'resolved' | 'rejected'>();
    const warningPromises: Promise<void>[] = [];

    for (const { name, component } of warningTargets) {
      statuses.set(name, 'pending');
      this.lifecycleEvents.componentShutdownWarning(name);

      const warningPromise = Promise.resolve().then(() =>
        component.onShutdownWarning?.(),
      );

      warningPromises.push(
        warningPromise
          .then(() => {
            statuses.set(name, 'resolved');
            this.lifecycleEvents.componentShutdownWarningCompleted(name);
          })
          .catch((error) => {
            statuses.set(name, 'rejected');
            this.logger.entity(name).warn('Shutdown warning phase failed', {
              params: { error: (error as Error).message },
            });
          }),
      );
    }

    // Race overall completion vs global timeout.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => resolve('timeout'), timeoutMS);
    });

    try {
      const result = await Promise.race([
        Promise.allSettled(warningPromises).then(() => 'completed' as const),
        timeoutPromise,
      ]);

      if (result === 'timeout') {
        const pendingComponents = warningTargets.filter(
          ({ name }) => statuses.get(name) === 'pending',
        );

        for (const { name } of pendingComponents) {
          this.logger.entity(name).warn('Shutdown warning phase timed out', {
            params: { timeoutMS },
          });

          this.lifecycleEvents.componentShutdownWarningTimeout(name, timeoutMS);
        }

        // Global timeout: proceed to graceful shutdown regardless of pending warnings.
        this.logger.warn('Shutdown warning phase timed out', {
          params: { timeoutMS, pending: pendingComponents.length },
        });

        this.lifecycleEvents.lifecycleManagerShutdownWarningTimeout(
          timeoutMS,
          pendingComponents.map(({ name }) => name),
        );

        return;
      }

      this.lifecycleEvents.lifecycleManagerShutdownWarningCompleted(timeoutMS);
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Phase 2: Graceful shutdown
   * Calls stop() with timeout
   */
  private async shutdownComponentGraceful(
    name: string,
    component: BaseComponent,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    // Set state to stopping
    this.componentStates.set(name, 'stopping');
    this.logger.entity(name).info('Graceful shutdown started');
    this.lifecycleEvents.componentStopping(name);

    // Use custom timeout if provided, otherwise use component's configured timeout
    const timeoutMS = options?.timeout ?? component.shutdownGracefulTimeoutMS;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      // Race against graceful timeout
      const stopPromise = component.stop();

      if (timeoutMS > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Call abort callback if implemented
            if (component.onGracefulStopTimeout) {
              try {
                component.onGracefulStopTimeout();
              } catch (error) {
                this.logger
                  .entity(name)
                  .warn('Error in onGracefulStopTimeout callback', {
                    params: { error },
                  });
              }
            }

            // Prevent unhandled rejection if stop() throws after timeout
            Promise.resolve(stopPromise).catch(() => {
              // Intentionally ignore errors after timeout
            });
            reject(
              new ComponentStopTimeoutError({
                componentName: name,
                timeoutMS,
              }),
            );
          }, timeoutMS);
        });

        await Promise.race([stopPromise, timeoutPromise]);
      } else {
        await stopPromise;
      }

      // Update state - graceful succeeded
      this.componentStates.set(name, 'stopped');
      this.runningComponents.delete(name);
      this.stalledComponents.delete(name); // Clear stalled status on successful stop
      this.updateStartedFlag();

      // Auto-detach signals if this was the last component and option is enabled
      if (
        this.detachSignalsOnStop &&
        this.runningComponents.size === 0 &&
        this.processSignalManager
      ) {
        this.logger.info(
          'Auto-detaching process signals on last component stop',
        );
        this.detachSignals();
      }

      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.stoppedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component stopped gracefully');
      this.lifecycleEvents.componentStopped(
        name,
        this.getComponentStatus(name),
      );

      return {
        success: true,
        componentName: name,
        status: this.getComponentStatus(name),
      };
    } catch (error) {
      const err = error as Error;

      // Store error
      this.componentErrors.set(name, err);

      // Check if it was a timeout
      if (
        err instanceof ComponentStopTimeoutError &&
        err.additionalInfo.componentName === name
      ) {
        this.logger.entity(name).warn('Graceful shutdown timed out');
        this.lifecycleEvents.componentStopTimeout(name, err, {
          timeoutMS,
          reason: 'Graceful shutdown timed out',
        });

        return {
          success: false,
          componentName: name,
          reason: 'Graceful shutdown timed out',
          code: 'stop_timeout',
          error: err,
          status: this.getComponentStatus(name),
        };
      } else {
        // Error during graceful stop
        this.logger.entity(name).warn('Graceful shutdown threw error', {
          params: { error: err.message },
        });

        return {
          success: false,
          componentName: name,
          reason: err.message,
          code: 'unknown_error',
          error: err,
          status: this.getComponentStatus(name),
        };
      }
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Phase 3: Force shutdown
   * Calls onShutdownForce() with timeout, or marks as stalled if not implemented
   */
  private async shutdownComponentForce(
    name: string,
    component: BaseComponent,
    context: {
      gracefulPhaseRan: boolean;
      gracefulTimedOut: boolean;
      gracefulError?: Error;
      startedAt: number;
    },
  ): Promise<ComponentOperationResult> {
    this.componentStates.set(name, 'force-stopping');
    this.logger.entity(name).info('Force shutdown started', {
      params: {
        gracefulPhaseRan: context.gracefulPhaseRan,
        gracefulTimedOut: context.gracefulTimedOut,
      },
    });

    this.lifecycleEvents.componentShutdownForce({
      name,
      context: {
        gracefulPhaseRan: context.gracefulPhaseRan,
        gracefulTimedOut: context.gracefulTimedOut,
      },
    });

    const timeoutMS = component.shutdownForceTimeoutMS;
    let timeoutHandle: NodeJS.Timeout | undefined;

    // If component doesn't implement onShutdownForce, mark as stalled immediately
    if (!component.onShutdownForce) {
      const stallInfo: ComponentStallInfo = {
        name,
        phase: 'graceful', // Failed in graceful phase
        reason: context.gracefulTimedOut ? 'timeout' : 'error',
        startedAt: context.startedAt,
        stalledAt: Date.now(),
        error: context.gracefulError,
      };

      this.stalledComponents.set(name, stallInfo);
      this.componentStates.set(name, 'stalled');
      this.runningComponents.delete(name);
      this.updateStartedFlag();

      this.logger
        .entity(name)
        .error('Component stalled - graceful shutdown failed', {
          params: {
            reason: context.gracefulTimedOut ? 'timeout' : 'error',
            hasForceHandler: false,
          },
        });

      this.lifecycleEvents.componentStalled(name, stallInfo, {
        reason: stallInfo.reason,
        code: context.gracefulTimedOut ? 'stop_timeout' : 'unknown_error',
      });

      // Return the original graceful phase error
      return {
        success: false,
        componentName: name,
        reason: context.gracefulTimedOut
          ? 'Component stop timed out'
          : (context.gracefulError?.message ?? 'Graceful shutdown failed'),
        code: context.gracefulTimedOut ? 'stop_timeout' : 'unknown_error',
        error: context.gracefulError,
        status: this.getComponentStatus(name),
      };
    }

    try {
      const forcePromise = component.onShutdownForce();

      if (timeoutMS > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Call abort callback if implemented
            if (component.onShutdownForceAborted) {
              try {
                component.onShutdownForceAborted();
              } catch (error) {
                this.logger
                  .entity(name)
                  .warn('Error in onShutdownForceAborted callback', {
                    params: { error },
                  });
              }
            }

            // Prevent unhandled rejection if onShutdownForce() throws after timeout
            Promise.resolve(forcePromise).catch(() => {
              // Intentionally ignore errors after timeout
            });
            reject(new Error('Force shutdown timed out'));
          }, timeoutMS);
        });

        await Promise.race([forcePromise, timeoutPromise]);
      } else {
        await forcePromise;
      }

      // Update state - force succeeded
      this.componentStates.set(name, 'stopped');
      this.runningComponents.delete(name);
      this.stalledComponents.delete(name); // Clear stalled status on successful force stop
      this.updateStartedFlag();

      // Auto-detach signals if this was the last component and option is enabled
      if (
        this.detachSignalsOnStop &&
        this.runningComponents.size === 0 &&
        this.processSignalManager
      ) {
        this.logger.info(
          'Auto-detaching process signals on last component stop',
        );
        this.detachSignals();
      }

      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.stoppedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component force stopped');
      this.lifecycleEvents.componentShutdownForceCompleted(name);
      this.lifecycleEvents.componentStopped(
        name,
        this.getComponentStatus(name),
      );

      return {
        success: true,
        componentName: name,
        status: this.getComponentStatus(name),
      };
    } catch (error) {
      const err = error as Error;

      // Determine if timeout or error
      const isTimeout = err.message === 'Force shutdown timed out';

      // Mark as stalled - force phase failed
      const stallInfo: ComponentStallInfo = {
        name,
        phase: 'force',
        reason: isTimeout
          ? 'timeout'
          : context.gracefulTimedOut
            ? 'both'
            : 'error',
        startedAt: context.startedAt,
        stalledAt: Date.now(),
        error: err,
      };
      this.stalledComponents.set(name, stallInfo);
      this.componentStates.set(name, 'stalled');
      this.runningComponents.delete(name);
      this.componentErrors.set(name, err);
      this.updateStartedFlag();

      if (isTimeout) {
        this.logger.entity(name).error('Force shutdown timed out - stalled', {
          params: { timeoutMS },
        });
        this.lifecycleEvents.componentShutdownForceTimeout(name, timeoutMS);
      } else {
        this.logger.entity(name).error('Force shutdown failed - stalled', {
          params: { error: err.message },
        });
      }

      this.lifecycleEvents.componentStalled(name, stallInfo, {
        reason: stallInfo.reason,
        code: isTimeout ? 'stop_timeout' : 'unknown_error',
      });

      return {
        success: false,
        componentName: name,
        reason: isTimeout ? 'Force shutdown timed out' : err.message,
        code: isTimeout ? 'stop_timeout' : 'unknown_error',
        error: err,
        status: this.getComponentStatus(name),
      };
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Get a component by name
   */
  private getComponent(name: string): BaseComponent | undefined {
    return this.components.find((c) => c.getName() === name);
  }

  /**
   * Get all components that depend on the specified component (reverse lookup)
   * @param name - Component name to find dependents for
   * @returns Array of component names that depend on this component
   */
  private getDependents(name: string): string[] {
    const dependents: string[] = [];
    for (const component of this.components) {
      const dependencies = component.getDependencies();
      if (dependencies.includes(name)) {
        dependents.push(component.getName());
      }
    }
    return dependents;
  }

  /**
   * Get running components that depend on the specified component
   * @param name - Component name to check
   * @returns Array of running component names that depend on this component
   */
  private getRunningDependents(name: string): string[] {
    const dependents = this.getDependents(name);
    return dependents.filter((dep) => this.isComponentRunning(dep));
  }

  /**
   * Check if a component is a required dependency during startup
   * Used to prevent registering dependencies mid-startup which would break ordering
   * @param componentName - Component name to check
   * @returns true if this component would be a required dependency
   */
  private isRequiredDependencyDuringStartup(componentName: string): boolean {
    if (!this.isStarting) {
      return false;
    }

    // Check if any existing component lists this new component as a dependency
    return this.components.some((c) =>
      c.getDependencies().includes(componentName),
    );
  }

  /**
   * Check if a component instance is already registered
   */
  private hasComponentInstance(component: BaseComponent): boolean {
    return this.components.includes(component);
  }

  /**
   * Rollback startup by stopping all started components in reverse order
   * Used when a required component fails to start during startAllComponents()
   */
  private async rollbackStartup(startedComponents: string[]): Promise<void> {
    this.logger.warn('Rolling back startup, stopping started components', {
      params: { components: startedComponents },
    });

    // Stop components in reverse order
    const componentsToRollback = [...startedComponents].reverse();

    for (const name of componentsToRollback) {
      this.logger.entity(name).info('Rolling back component');
      this.lifecycleEvents.componentStartupRollback(name);

      // Use internal method to bypass bulk operation checks
      const result = await this.stopComponentInternal(name);
      if (!result.success) {
        this.logger
          .entity(name)
          .warn('Failed to stop component during rollback, continuing', {
            params: { error: result.error?.message },
          });
      }
    }

    this.logger.info('Rollback completed');
  }

  /**
   * Safe emit wrapper - prevents event handler errors from breaking lifecycle
   */
  private safeEmit<K extends LifecycleManagerEventName>(
    event: K,
    data: LifecycleManagerEventMap[K],
  ): void {
    try {
      this.emit(event, data);
    } catch (error) {
      this.logger.error('Event handler error', {
        params: { event, error },
      });
    }
  }

  private buildRegisterResultFailure(input: {
    componentName: string;
    registrationIndexBefore: number | null;
    code: RegistrationFailureCode;
    reason: string;
    error?: Error;
  }): RegisterComponentResult {
    let startupOrder: string[];

    try {
      startupOrder = this.getStartupOrderInternal();
    } catch (error) {
      // Defensive: This should never happen in normal operation since we validate
      // cycles before registration. However, if this.components somehow contains
      // a cycle (e.g., due to internal bugs or direct mutations), we must not
      // throw from an error handler. Return empty array to fail gracefully.
      this.logger.warn('Failed to compute startup order in error handler', {
        params: { error: error instanceof Error ? error.message : error },
      });

      startupOrder = [];
    }
    return {
      action: 'register',
      success: false,
      registered: false,
      componentName: input.componentName,
      reason: input.reason,
      code: input.code,
      error: input.error,
      registrationIndexBefore: input.registrationIndexBefore,
      registrationIndexAfter: input.registrationIndexBefore,
      startupOrder,
    };
  }

  private buildInsertResultFailure(input: {
    componentName: string;
    position: InsertPosition | (string & {});
    targetComponentName?: string;
    registrationIndexBefore: number | null;
    code: RegistrationFailureCode;
    reason: string;
    error?: Error;
    targetFound?: boolean;
  }): InsertComponentAtResult {
    let startupOrder: string[];

    try {
      startupOrder = this.getStartupOrderInternal();
    } catch (error) {
      // Defensive: This should never happen in normal operation since we validate
      // cycles before registration. However, if this.components somehow contains
      // a cycle (e.g., due to internal bugs or direct mutations), we must not
      // throw from an error handler. Return empty array to fail gracefully.
      this.logger.warn('Failed to compute startup order in error handler', {
        params: { error: error instanceof Error ? error.message : error },
      });
      startupOrder = [];
    }
    return {
      action: 'insert',
      success: false,
      registered: false,
      componentName: input.componentName,
      reason: input.reason,
      code: input.code,
      error: input.error,
      registrationIndexBefore: input.registrationIndexBefore,
      registrationIndexAfter: input.registrationIndexBefore,
      startupOrder,
      requestedPosition: {
        position: input.position,
        targetComponentName: input.targetComponentName,
      },
      manualPositionRespected: false,
      targetFound: input.targetFound,
      duringStartup: this.isStarting,
      autoStartAttempted: false,
      startResult: undefined,
    };
  }

  private getComponentIndex(name: string): number | null {
    const idx = this.components.findIndex((c) => c.getName() === name);
    return idx === -1 ? null : idx;
  }

  private isInsertPosition(value: unknown): value is InsertPosition {
    return (
      value === 'start' ||
      value === 'end' ||
      value === 'before' ||
      value === 'after'
    );
  }

  private getInsertIndex(
    position: InsertPosition,
    targetComponentName?: string,
  ): number | null {
    if (position === 'start') {
      return 0;
    } else if (position === 'end') {
      return this.components.length;
    } else if (position !== 'before' && position !== 'after') {
      return null;
    }

    const targetIdx = this.getComponentIndex(targetComponentName ?? '');
    if (targetIdx === null) {
      return null;
    }
    if (position === 'before') {
      return targetIdx;
    } else {
      return targetIdx + 1;
    }
  }

  private isManualPositionRespected(input: {
    componentName: string;
    position: InsertPosition;
    targetComponentName?: string;
    startupOrder: string[];
  }): boolean {
    const compIdx = input.startupOrder.indexOf(input.componentName);
    if (compIdx === -1) {
      return false;
    }

    if (input.position === 'start') {
      return compIdx === 0;
    } else if (input.position === 'end') {
      return compIdx === input.startupOrder.length - 1;
    } else if (input.position === 'before' || input.position === 'after') {
      const targetIdx = input.startupOrder.indexOf(
        input.targetComponentName ?? '',
      );
      if (targetIdx === -1) {
        return false;
      }
      if (input.position === 'before') {
        return compIdx < targetIdx;
      }
      return compIdx > targetIdx;
    }

    return false;
  }

  /**
   * Dependency-aware startup order.
   *
   * - Only registered components are included.
   * - Missing dependencies are ignored for ordering (they are validated at start time).
   * - Cycles throw DependencyCycleError (programmer error).
   */
  private getStartupOrderInternal(
    components: BaseComponent[] = this.components,
  ): string[] {
    const names = components.map((c) => c.getName());
    const regIndex = new Map<string, number>(
      names.map((name, idx) => [name, idx]),
    );

    const adjacency = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    for (const name of names) {
      adjacency.set(name, new Set());
      inDegree.set(name, 0);
    }

    // Build edges: dependency -> dependent (only when dependency is registered)
    for (const component of components) {
      const dependent = component.getName();
      for (const dep of component.getDependencies()) {
        if (!regIndex.has(dep)) {
          continue;
        }
        const neighbors = adjacency.get(dep);
        if (!neighbors) {
          continue;
        }
        if (neighbors.has(dependent)) {
          continue;
        }
        neighbors.add(dependent);
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1);
      }
    }

    const available = new Set<string>();
    for (const name of names) {
      if ((inDegree.get(name) ?? 0) === 0) {
        available.add(name);
      }
    }

    const order: string[] = [];
    while (available.size > 0) {
      // Stable pick: lowest registration index
      const next = [...available].sort((a, b) => {
        return (regIndex.get(a) ?? 0) - (regIndex.get(b) ?? 0);
      })[0];

      available.delete(next);
      order.push(next);

      for (const neighbor of adjacency.get(next) ?? []) {
        const nextInDegree = (inDegree.get(neighbor) ?? 0) - 1;
        inDegree.set(neighbor, nextInDegree);
        if (nextInDegree === 0) {
          available.add(neighbor);
        }
      }
    }

    if (order.length !== names.length) {
      const remaining = names.filter((n) => !order.includes(n));
      const cycle = this.findDependencyCycle(adjacency);
      throw new DependencyCycleError({
        cycle: cycle.length > 0 ? cycle : remaining,
      });
    }

    return order;
  }

  /**
   * Find a single dependency cycle (for error reporting during registration)
   * Returns the first cycle found, or empty array if no cycle exists
   *
   * Performance note: This method exits early after finding the first cycle,
   * which is optimal for hot paths (registration, startup order resolution).
   * For comprehensive validation that needs ALL cycles, use findAllCircularCycles().
   */
  private findDependencyCycle(adjacency: Map<string, Set<string>>): string[] {
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const path: string[] = [];

    const visit = (node: string): string[] | null => {
      visited.add(node);
      inStack.add(node);
      path.push(node);

      for (const neighbor of adjacency.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          const result = visit(neighbor);
          if (result) {
            return result;
          }
        } else if (inStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          return cycleStart >= 0 ? path.slice(cycleStart) : [neighbor];
        }
      }

      inStack.delete(node);
      path.pop();
      return null;
    };

    for (const node of adjacency.keys()) {
      if (visited.has(node)) {
        continue;
      }
      const result = visit(node);
      if (result) {
        return result;
      }
    }

    return [];
  }

  /**
   * Find circular dependency cycles using Depth-First Search (DFS) with cycle detection.
   *
   * Algorithm: DFS with visited set and recursion stack tracking
   * - Uses 'visited' set to ensure each node is processed exactly once (prevents infinite loops)
   * - Uses 'inStack' set to track the current DFS recursion path
   * - When a node in the current path is encountered again, a cycle is detected
   * - Extracts the cycle from the path and continues searching for more cycles
   *
   * Time Complexity: O(V + E) where V = components, E = dependency edges
   * Space Complexity: O(V) for visited/inStack sets and recursion stack
   *
   * Performance note: This method finds a representative set of cycles while ensuring
   * each node is visited once (prevents infinite loops). For hot paths that only need
   * one cycle, use findDependencyCycle() which exits early.
   *
   * Returns an array of detected cycles, where each cycle is an array of component names.
   */
  private findAllCircularCycles(
    adjacency: Map<string, Set<string>>,
  ): string[][] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const path: string[] = [];

    const visit = (node: string): void => {
      visited.add(node);
      inStack.add(node);
      path.push(node);

      for (const neighbor of adjacency.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          // Continue DFS to unvisited neighbor
          visit(neighbor);
        } else if (inStack.has(neighbor)) {
          // Found a cycle - extract it from the path
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart >= 0) {
            const cycle = path.slice(cycleStart);
            cycles.push(cycle);
          }
        }
      }

      inStack.delete(node);
      path.pop();
    };

    // Visit all nodes to find all cycles (including disconnected components)
    for (const node of adjacency.keys()) {
      if (!visited.has(node)) {
        visit(node);
      }
    }

    return cycles;
  }

  /**
   * Handle shutdown signal - initiates stopAllComponents().
   * Double signal protection: if already shutting down, log warning and ignore.
   */
  private handleShutdownRequest(method: ShutdownSignal): void {
    if (this.isShuttingDown) {
      this.logger.warn('Shutdown already in progress, ignoring signal', {
        params: { method },
      });
      return;
    }

    this.logger.info('Shutdown signal received', { params: { method } });
    this.lifecycleEvents.signalShutdown(method);

    // Initiate shutdown asynchronously (don't await in signal handler)
    void this.stopAllComponentsInternal(method, {
      ...this.shutdownOptions,
    });
  }

  /**
   * Handle reload request - calls custom callback or broadcasts to components.
   *
   * When called from signal handlers (source='signal'), the Promise is started
   * but not awaited due to Node.js signal handler constraints. Components are
   * still notified and the work completes, but return values are not accessible.
   *
   * When called from manual triggers (source='trigger'), the Promise is awaited
   * and results are returned for programmatic use.
   *
   * @param source - Whether triggered from signal manager or manual trigger
   */
  private async handleReloadRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    this.logger.info('Reload request received', { params: { source } });
    this.lifecycleEvents.signalReload();

    if (this.onReloadRequested) {
      // Call custom callback with broadcast function
      const broadcastFn = () => this.broadcastReload();
      const result = this.onReloadRequested(broadcastFn);

      if (isPromise(result)) {
        await result;
      }

      // Return empty result (custom callback handled it)
      return {
        signal: 'reload',
        results: [],
        timedOut: false,
        code: 'ok',
      };
    }

    // No custom callback - broadcast to all components
    return this.broadcastReload();
  }

  /**
   * Handle info request - calls custom callback or broadcasts to components.
   *
   * When called from signal handlers, the Promise executes but return values
   * are not accessible due to Node.js signal handler constraints.
   *
   * @param source - Whether triggered from signal manager or manual trigger
   */
  private async handleInfoRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    this.logger.info('Info request received', { params: { source } });
    this.lifecycleEvents.signalInfo();

    if (this.onInfoRequested) {
      // Call custom callback with broadcast function
      const broadcastFn = () => this.broadcastInfo();
      const result = this.onInfoRequested(broadcastFn);
      if (isPromise(result)) {
        await result;
      }

      // Return empty result (custom callback handled it)
      return {
        signal: 'info',
        results: [],
        timedOut: false,
        code: 'ok',
      };
    }

    // No custom callback - broadcast to all components
    return this.broadcastInfo();
  }

  /**
   * Handle debug request - calls custom callback or broadcasts to components.
   *
   * When called from signal handlers, the Promise executes but return values
   * are not accessible due to Node.js signal handler constraints.
   *
   * @param source - Whether triggered from signal manager or manual trigger
   */
  private async handleDebugRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    this.logger.info('Debug request received', { params: { source } });
    this.lifecycleEvents.signalDebug();

    if (this.onDebugRequested) {
      // Call custom callback with broadcast function
      const broadcastFn = () => this.broadcastDebug();
      const result = this.onDebugRequested(broadcastFn);
      if (isPromise(result)) {
        await result;
      }

      // Return empty result (custom callback handled it)
      return {
        signal: 'debug',
        results: [],
        timedOut: false,
        code: 'ok',
      };
    }

    // No custom callback - broadcast to all components
    return this.broadcastDebug();
  }

  /**
   * Broadcast reload signal to all running components.
   * Calls onReload() on components that implement it.
   * Continues on errors - collects all results.
   */
  private async broadcastReload(): Promise<SignalBroadcastResult> {
    const results: ComponentSignalResult[] = [];

    // Only call onReload() on running components
    const componentsToReload = this.components.filter((component) =>
      this.runningComponents.has(component.getName()),
    );

    if (this.isStarting) {
      this.logger.info(
        'Reload during startup: only reloading already-started components',
      );
    }

    for (const component of componentsToReload) {
      const name = component.getName();

      if (!component.onReload) {
        // Component doesn't implement onReload
        results.push({
          name,
          called: false,
          error: null,
          timedOut: false,
          code: 'no_handler',
        });
        continue;
      }

      this.lifecycleEvents.componentReloadStarted(name);

      const timeoutMS = component.signalTimeoutMS;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutResult = { timedOut: true } as const;

      try {
        const result = component.onReload();
        const handlerPromise: Promise<unknown> = isPromise(result)
          ? (result as Promise<unknown>)
          : Promise.resolve(result as unknown);

        const outcome: unknown =
          timeoutMS > 0
            ? await Promise.race([
                handlerPromise,
                new Promise<typeof timeoutResult>((resolve) => {
                  timeoutHandle = setTimeout(() => {
                    resolve(timeoutResult);
                  }, timeoutMS);
                }),
              ])
            : await handlerPromise;

        if (outcome === timeoutResult) {
          this.logger.entity(name).warn('Reload handler timed out', {
            params: { timeoutMS },
          });
          // Prevent unhandled rejection if handler throws after timeout
          Promise.resolve(handlerPromise).catch(() => {
            // Intentionally ignore errors after timeout
          });
          results.push({
            name,
            called: true,
            error: null,
            timedOut: true,
            code: 'timeout',
          });
        } else {
          this.lifecycleEvents.componentReloadCompleted(name);
          results.push({
            name,
            called: true,
            error: null,
            timedOut: false,
            code: 'called',
          });
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger
          .entity(name)
          .error('Reload failed', { params: { error: err } });
        this.lifecycleEvents.componentReloadFailed(name, err);
        results.push({
          name,
          called: true,
          error: err,
          timedOut: false,
          code: 'error',
        });
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    const calledResults = results.filter((result) => result.called);
    const hasError = calledResults.some((result) => result.error);
    const isAllError =
      calledResults.length > 0 && calledResults.every((result) => result.error);
    const hasTimeout = calledResults.some((result) => result.timedOut);
    const isAllTimeout =
      calledResults.length > 0 &&
      calledResults.every((result) => result.timedOut);
    const code = hasError
      ? isAllError
        ? 'error'
        : 'partial_error'
      : hasTimeout
        ? isAllTimeout
          ? 'timeout'
          : 'partial_timeout'
        : 'ok';

    return {
      signal: 'reload',
      results,
      timedOut: hasTimeout,
      code,
    };
  }

  /**
   * Broadcast info signal to all running components.
   * Calls onInfo() on components that implement it.
   * Continues on errors - collects all results.
   */
  private async broadcastInfo(): Promise<SignalBroadcastResult> {
    const results: ComponentSignalResult[] = [];

    // Only call onInfo() on running components
    const componentsToNotify = this.components.filter((component) =>
      this.runningComponents.has(component.getName()),
    );

    if (this.isStarting) {
      this.logger.info(
        'Info during startup: only notifying already-started components',
      );
    }

    for (const component of componentsToNotify) {
      const name = component.getName();

      if (!component.onInfo) {
        // Component doesn't implement onInfo
        results.push({
          name,
          called: false,
          error: null,
          timedOut: false,
          code: 'no_handler',
        });
        continue;
      }

      this.lifecycleEvents.componentInfoStarted(name);

      const timeoutMS = component.signalTimeoutMS;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutResult = { timedOut: true } as const;

      try {
        const result = component.onInfo();
        const handlerPromise: Promise<unknown> = isPromise(result)
          ? (result as Promise<unknown>)
          : Promise.resolve(result as unknown);

        const outcome: unknown =
          timeoutMS > 0
            ? await Promise.race([
                handlerPromise,
                new Promise<typeof timeoutResult>((resolve) => {
                  timeoutHandle = setTimeout(() => {
                    resolve(timeoutResult);
                  }, timeoutMS);
                }),
              ])
            : await handlerPromise;

        if (outcome === timeoutResult) {
          this.logger.entity(name).warn('Info handler timed out', {
            params: { timeoutMS },
          });
          // Prevent unhandled rejection if handler throws after timeout
          Promise.resolve(handlerPromise).catch(() => {
            // Intentionally ignore errors after timeout
          });
          results.push({
            name,
            called: true,
            error: null,
            timedOut: true,
            code: 'timeout',
          });
        } else {
          this.lifecycleEvents.componentInfoCompleted(name);
          results.push({
            name,
            called: true,
            error: null,
            timedOut: false,
            code: 'called',
          });
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger
          .entity(name)
          .error('Info handler failed', { params: { error: err } });
        this.lifecycleEvents.componentInfoFailed(name, err);
        results.push({
          name,
          called: true,
          error: err,
          timedOut: false,
          code: 'error',
        });
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    const calledResults = results.filter((result) => result.called);
    const hasError = calledResults.some((result) => result.error);
    const isAllError =
      calledResults.length > 0 && calledResults.every((result) => result.error);
    const hasTimeout = calledResults.some((result) => result.timedOut);
    const isAllTimeout =
      calledResults.length > 0 &&
      calledResults.every((result) => result.timedOut);
    const code = hasError
      ? isAllError
        ? 'error'
        : 'partial_error'
      : hasTimeout
        ? isAllTimeout
          ? 'timeout'
          : 'partial_timeout'
        : 'ok';

    return {
      signal: 'info',
      results,
      timedOut: hasTimeout,
      code,
    };
  }

  /**
   * Broadcast debug signal to all running components.
   * Calls onDebug() on components that implement it.
   * Continues on errors - collects all results.
   */
  private async broadcastDebug(): Promise<SignalBroadcastResult> {
    const results: ComponentSignalResult[] = [];

    // Only call onDebug() on running components
    const componentsToNotify = this.components.filter((component) =>
      this.runningComponents.has(component.getName()),
    );

    if (this.isStarting) {
      this.logger.info(
        'Debug during startup: only notifying already-started components',
      );
    }

    for (const component of componentsToNotify) {
      const name = component.getName();

      if (!component.onDebug) {
        // Component doesn't implement onDebug
        results.push({
          name,
          called: false,
          error: null,
          timedOut: false,
          code: 'no_handler',
        });
        continue;
      }

      this.lifecycleEvents.componentDebugStarted(name);

      const timeoutMS = component.signalTimeoutMS;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutResult = { timedOut: true } as const;

      try {
        const result = component.onDebug();
        const handlerPromise: Promise<unknown> = isPromise(result)
          ? (result as Promise<unknown>)
          : Promise.resolve(result as unknown);

        const outcome: unknown =
          timeoutMS > 0
            ? await Promise.race([
                handlerPromise,
                new Promise<typeof timeoutResult>((resolve) => {
                  timeoutHandle = setTimeout(() => {
                    resolve(timeoutResult);
                  }, timeoutMS);
                }),
              ])
            : await handlerPromise;

        if (outcome === timeoutResult) {
          this.logger.entity(name).warn('Debug handler timed out', {
            params: { timeoutMS },
          });
          // Prevent unhandled rejection if handler throws after timeout
          Promise.resolve(handlerPromise).catch(() => {
            // Intentionally ignore errors after timeout
          });
          results.push({
            name,
            called: true,
            error: null,
            timedOut: true,
            code: 'timeout',
          });
        } else {
          this.lifecycleEvents.componentDebugCompleted(name);
          results.push({
            name,
            called: true,
            error: null,
            timedOut: false,
            code: 'called',
          });
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.logger
          .entity(name)
          .error('Debug handler failed', { params: { error: err } });
        this.lifecycleEvents.componentDebugFailed(name, err);
        results.push({
          name,
          called: true,
          error: err,
          timedOut: false,
          code: 'error',
        });
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    const calledResults = results.filter((result) => result.called);
    const hasError = calledResults.some((result) => result.error);
    const isAllError =
      calledResults.length > 0 && calledResults.every((result) => result.error);
    const hasTimeout = calledResults.some((result) => result.timedOut);
    const isAllTimeout =
      calledResults.length > 0 &&
      calledResults.every((result) => result.timedOut);
    const code = hasError
      ? isAllError
        ? 'error'
        : 'partial_error'
      : hasTimeout
        ? isAllTimeout
          ? 'timeout'
          : 'partial_timeout'
        : 'ok';

    return {
      signal: 'debug',
      results,
      timedOut: hasTimeout,
      code,
    };
  }
}
