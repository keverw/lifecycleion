import { EventEmitterProtected } from '../event-emitter';
import type { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import type { BaseComponent } from './base-component';
import { ComponentLifecycle } from './component-lifecycle';
import type {
  ComponentState,
  ComponentStatus,
  ComponentStallInfo,
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
  RestartResult,
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
  HealthCheckResult,
  HealthReport,
  ValueResult,
  ComponentHealthResult,
  LifecycleInternalCallbacks,
} from './types';
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

    // Store custom signal callbacks
    this.onReloadRequested = options.onReloadRequested;
    this.onInfoRequested = options.onInfoRequested;
    this.onDebugRequested = options.onDebugRequested;
  }

  // ============================================================================
  // Component Registration
  // ============================================================================

  /**
   * Register a component at the end of the registry list.
   */
  public registerComponent(
    component: BaseComponent,
    options?: RegisterOptions,
  ): RegisterComponentResult {
    const result = this.registerComponentInternal(
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
  public insertComponentAt(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName?: string,
    options?: RegisterOptions,
  ): InsertComponentAtResult {
    return this.registerComponentInternal(
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
      // Caller expectation: success with stopIfRunning implies the component is stopped.
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

    this.logger.entity(name).info('Component unregistered');
    this.safeEmit('component:unregistered', { name });

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
    return this.runningComponents.size;
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

    if (totalCount === 0) {
      return 'idle';
    }

    if (this.isShuttingDown) {
      return 'shutting-down';
    }

    if (this.isStarting) {
      return 'starting';
    }

    if (runningCount === 0) {
      return totalCount > 0 ? 'ready' : 'idle';
    }

    if (runningCount === totalCount && this.isStarted) {
      return 'running';
    }

    if (runningCount > 0 && runningCount < totalCount) {
      return 'partial';
    }

    if (runningCount === totalCount) {
      return 'running';
    }

    return 'ready';
  }

  /**
   * Get information about components that are stalled (failed to stop)
   */
  public getStalledComponents(): ComponentStallInfo[] {
    return Array.from(this.stalledComponents.values());
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
   * - If optional component fails, its dependents are skipped
   * - Handles shutdown signal during startup (aborts and rolls back)
   */
  public async startAllComponents(
    options?: StartupOptions,
  ): Promise<StartupResult> {
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
      };
    }

    const totalCount = this.getComponentCount();
    const runningCount = this.getRunningComponentCount();

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
      };
    }

    // Set starting flag and clear previous shutdown state
    this.isStarting = true;
    this.shutdownMethod = null; // Clear previous shutdown method on fresh start
    this.logger.info('Starting all components');

    // Get startup order (topological sort)
    let startupOrder: string[];

    try {
      startupOrder = this.getStartupOrderInternal();
    } catch (error) {
      this.isStarting = false;
      const err = error as Error;
      this.logger.error('Failed to resolve startup order', {
        params: { error: err.message },
      });

      return {
        success: false,
        startedComponents: [],
        failedOptionalComponents: [],
        skippedDueToDependency: [],
      };
    }

    const startedComponents: string[] = [];
    const failedOptionalComponents: Array<{ name: string; error: Error }> = [];
    const skippedDueToDependency = new Set<string>();
    const skippedDueToStall = new Set<string>();

    try {
      // Start each component in dependency order
      for (const name of startupOrder) {
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

          if (skippedDueToDependency.has(depName)) {
            shouldSkip = true;
            skipReason = `Dependency "${depName}" was skipped`;
            break;
          }

          const depComponent = this.getComponent(depName);
          if (depComponent) {
            const depState = this.componentStates.get(depName);
            if (depState === 'failed') {
              shouldSkip = true;
              skipReason = `Optional dependency "${depName}" failed to start`;
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
          this.safeEmit('component:start-skipped', {
            name,
            reason: skipReason,
          });
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
          };
        }

        // Start the component (using internal method to bypass bulk operation check)
        const result = await this.startComponentInternal(name);

        if (result.success) {
          startedComponents.push(name);
        } else {
          // Check if component is optional
          if (component.isOptional()) {
            this.logger
              .entity(name)
              .warn('Optional component failed to start, continuing', {
                params: { error: result.error?.message },
              });

            this.safeEmit('component:start-failed-optional', {
              name,
              error: result.error,
            });

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
            };
          }
        }
      }

      // Success - all components started (or optional ones failed gracefully)
      this.isStarted = true;
      const skippedComponentsArray = [
        ...skippedDueToDependency,
        ...skippedDueToStall,
      ];

      this.logger.success('All components started', {
        params: {
          started: startedComponents.length,
          failed: failedOptionalComponents.length,
          skipped: skippedComponentsArray.length,
        },
      });

      this.safeEmit('lifecycle-manager:started', {
        startedComponents,
        failedOptionalComponents,
        skippedComponents: skippedComponentsArray,
      });

      return {
        success: true,
        startedComponents,
        failedOptionalComponents,
        skippedDueToDependency: Array.from(skippedDueToDependency),
      };
    } finally {
      this.isStarting = false;
    }
  }

  /**
   * Stop all running components in reverse dependency order
   *
   * Components stop in reverse topological order (dependents before dependencies).
   */

  public async stopAllComponents(): Promise<ShutdownResult> {
    // always use manual method for external public API as not from a signal
    return this.stopAllComponentsInternal('manual');
  }

  /**
   * Restart all components (stop then start)
   */
  public async restartAllComponents(
    options?: StartupOptions,
  ): Promise<RestartResult> {
    this.logger.info('Restarting all components');

    // Phase 1: Stop all components
    const shutdownResult = await this.stopAllComponentsInternal('manual');

    // Phase 2: Start all components
    const startupResult = await this.startAllComponents(options);

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
    // Reject during bulk operations
    if (this.isStarting) {
      this.logger
        .entity(name)
        .warn('Cannot start component during bulk startup', {
          params: { isStarting: this.isStarting },
        });

      return {
        success: false,
        componentName: name,
        reason: 'Bulk startup in progress',
        code: 'shutdown_in_progress', // Reuse this code for any bulk operation
      };
    }

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
        code: 'shutdown_in_progress',
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
        code: 'shutdown_in_progress',
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
    this.safeEmit('lifecycle-manager:signals-attached');
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
    this.safeEmit('lifecycle-manager:signals-detached');
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
      return {
        name,
        healthy: false,
        message: 'Component not running',
        checkedAt: startTime,
        durationMS: Date.now() - startTime,
        error: null,
        timedOut: false,
        code: 'not_running',
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

    this.safeEmit('component:health-check-started', { name });

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
      this.safeEmit('component:health-check-completed', {
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
      this.safeEmit('component:health-check-failed', { name, error: err });

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
        r.code === 'not_running' || (r.code !== 'no_handler' && !r.healthy),
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
  ): ValueResult<T> {
    return this.getValueInternal<T>(componentName, key, null);
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

    // Check if running
    if (!this.isComponentRunning(componentName)) {
      return {
        sent: false,
        componentFound: true,
        componentRunning: false,
        handlerImplemented: false,
        data: undefined,
        error: null,
        timedOut: false,
        code: 'not_running',
      };
    }

    // Check if handler implemented
    if (!component.onMessage) {
      return {
        sent: false,
        componentFound: true,
        componentRunning: true,
        handlerImplemented: false,
        data: undefined,
        error: null,
        timedOut: false,
        code: 'no_handler',
      };
    }

    // Send message
    this.safeEmit('component:message-sent', {
      componentName,
      from,
      payload,
    });

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
        this.safeEmit('component:message-failed', {
          componentName,
          from,
          error: err,
        });

        return {
          sent: true,
          componentFound: true,
          componentRunning: true,
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
          componentRunning: true,
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
        componentRunning: true,
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
      this.safeEmit('component:message-failed', {
        componentName,
        from,
        error: err,
      });

      return {
        sent: true,
        componentFound: true,
        componentRunning: true,
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
    this.safeEmit('component:broadcast-started', { from, payload });

    const results: BroadcastResult[] = [];

    // Determine which components to broadcast to
    let targetComponents = this.components;

    // Filter by names if specified
    if (options?.componentNames && options.componentNames.length > 0) {
      const componentNames = options.componentNames;
      targetComponents = targetComponents.filter((c) =>
        componentNames.includes(c.getName()),
      );
    }

    // Filter by running state unless includeNonRunning
    if (!options?.includeNonRunning) {
      targetComponents = targetComponents.filter((c) =>
        this.isComponentRunning(c.getName()),
      );
    }

    // Send to each component
    for (const component of targetComponents) {
      const name = component.getName();
      const isRunning = this.isComponentRunning(name);

      // Skip if not running (only happens when includeNonRunning is true)
      if (!isRunning) {
        results.push({
          name,
          sent: false,
          running: false,
          data: undefined,
          error: null,
          timedOut: false,
          code: 'not_running',
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

    this.safeEmit('component:broadcast-completed', {
      from,
      resultsCount: results.length,
    });

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
  ): ValueResult<T> {
    this.safeEmit('component:value-requested', { componentName, key, from });

    // Find component
    const component = this.components.find(
      (c) => c.getName() === componentName,
    );

    if (!component) {
      this.safeEmit('component:value-returned', {
        componentName,
        key,
        from,
        found: false,
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
    if (!isRunning) {
      this.safeEmit('component:value-returned', {
        componentName,
        key,
        from,
        found: false,
      });
      return {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: false,
        handlerImplemented: false,
        requestedBy: from,
        code: 'not_running',
      };
    }

    // Check if handler implemented
    if (!component.getValue) {
      this.safeEmit('component:value-returned', {
        componentName,
        key,
        from,
        found: false,
      });
      return {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: true,
        handlerImplemented: false,
        requestedBy: from,
        code: 'no_handler',
      };
    }

    // Get value
    try {
      const value = component.getValue(key, from) as T | undefined;
      const wasFound = value !== undefined;

      this.safeEmit('component:value-returned', {
        componentName,
        key,
        from,
        found: wasFound,
      });

      return {
        found: wasFound,
        value,
        componentFound: true,
        componentRunning: true,
        handlerImplemented: true,
        requestedBy: from,
        code: wasFound ? 'found' : 'not_found',
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.entity(componentName).error('getValue handler failed', {
        params: { error: err, key, from },
      });

      this.safeEmit('component:value-returned', {
        componentName,
        key,
        from,
        found: false,
      });

      return {
        found: false,
        value: undefined,
        componentFound: true,
        componentRunning: true,
        handlerImplemented: true,
        requestedBy: from,
        code: 'error',
      };
    }
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * Internal method that handles component registration logic.
   * Used by both registerComponent and insertComponentAt.
   */
  private registerComponentInternal(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName?: string,
    isInsertAction = false,
    _options?: RegisterOptions,
  ): InsertComponentAtResult {
    const componentName = component.getName();
    const registrationIndexBefore = this.getComponentIndex(componentName);

    try {
      if (!this.isInsertPosition(position)) {
        this.logger.entity(componentName).warn('Invalid insertion position', {
          params: { position },
        });
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'invalid_position',
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
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'shutdown_in_progress',
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
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'startup_in_progress',
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
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'duplicate_instance',
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
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'duplicate_name',
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
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'target_not_found',
          target: targetComponentName,
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
          this.safeEmit('component:registration-rejected', {
            name: componentName,
            reason: 'dependency_cycle',
            cycle: error.additionalInfo.cycle,
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

      if (isInsertAction) {
        this.logger.entity(componentName).info('Component inserted', {
          params: { position, index: registrationIndexAfter },
        });
      } else {
        this.logger.entity(componentName).info('Component registered', {
          params: { index: registrationIndexAfter },
        });
      }

      // Emit registration event
      this.safeEmit('component:registered', {
        name: componentName,
        index: registrationIndexAfter,
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
        targetFound:
          position === 'before' || position === 'after'
            ? this.getComponentIndex(targetComponentName ?? '') !== null
            : undefined,
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
      this.safeEmit('component:registration-rejected', {
        name: componentName,
        reason: code,
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
      };
    }
  }

  private async stopAllComponentsInternal(
    method: ShutdownMethod,
  ): Promise<ShutdownResult> {
    const startTime = Date.now();

    // Reject if already shutting down
    if (this.isShuttingDown) {
      this.logger.warn(
        'Cannot stop all components: shutdown already in progress',
      );
      return {
        success: true,
        stoppedComponents: [],
        stalledComponents: [],
        durationMS: 0,
      };
    }

    // Set shutting down flag and track how shutdown was triggered
    this.isShuttingDown = true;
    this.shutdownMethod = method;
    const isDuringStartup = this.isStarting;
    this.logger.info('Stopping all components', { params: { method } });
    this.safeEmit('lifecycle-manager:shutdown-initiated', {
      method,
      duringStartup: isDuringStartup,
    });

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

    // Filter to only running components
    const runningComponentsToStop = shutdownOrder.filter((name) =>
      this.isComponentRunning(name),
    );

    const stoppedComponents: string[] = [];
    const stalledComponents: ComponentStallInfo[] = [];

    try {
      await this.runShutdownWarningPhase(runningComponentsToStop);

      // Stop each component in reverse dependency order
      for (const name of runningComponentsToStop) {
        this.logger.entity(name).info('Stopping component');
        // Use internal method to bypass bulk operation checks
        const result = await this.stopComponentInternal(name);

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
        }
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

      this.safeEmit('lifecycle-manager:shutdown-completed', {
        durationMS,
        stoppedComponents,
        stalledComponents,
      });

      return {
        success: isSuccess,
        stoppedComponents,
        stalledComponents,
        durationMS,
      };
    } finally {
      // Reset state
      this.isShuttingDown = false;
      this.isStarted = false;
    }
  }

  /**
   * Internal start component method - bypasses bulk operation checks
   * Used by both startComponent() and startAllComponents()
   */
  private async startComponentInternal(
    name: string,
    options?: StartComponentOptions,
  ): Promise<ComponentOperationResult> {
    const allowOptionalDependencies =
      options?.allowOptionalDependencies === true;
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

        if (allowOptionalDependencies && isDependencyOptional) {
          // Allow skipping optional dependencies only
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
      };
    }

    // Check if already running
    if (this.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        reason: 'Component already running',
        code: 'component_already_running',
      };
    }

    // Set state to starting
    this.componentStates.set(name, 'starting');
    this.logger.entity(name).info('Starting component');
    this.safeEmit('component:starting', { name });

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
      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.startedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component started');
      this.safeEmit('component:started', { name });

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
        this.safeEmit('component:start-timeout', { name, error: err });
      } else {
        this.componentStates.set(name, 'registered'); // Reset state
        this.logger.entity(name).error('Component failed to start', {
          params: { error: err.message },
        });
        this.safeEmit('component:start-failed', { name, error: err });
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

    // Check if not running
    if (!this.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        reason: 'Component not running',
        code: 'component_not_running',
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
    this.safeEmit('lifecycle-manager:shutdown-warning', { timeoutMS });

    if (timeoutMS === 0) {
      // Fire-and-forget: broadcast warnings without waiting for completion
      for (const { name, component } of warningTargets) {
        this.safeEmit('component:shutdown-warning', { name });
        Promise.resolve()
          .then(() => component.onShutdownWarning?.())
          .then(() => {
            this.safeEmit('component:shutdown-warning-completed', { name });
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
      this.safeEmit('lifecycle-manager:shutdown-warning-completed', {
        timeoutMS,
      });

      return;
    }

    // Track completion so we can identify which components are still pending at timeout.
    const statuses = new Map<string, 'pending' | 'resolved' | 'rejected'>();
    const warningPromises: Promise<void>[] = [];

    for (const { name, component } of warningTargets) {
      statuses.set(name, 'pending');
      this.safeEmit('component:shutdown-warning', { name });

      const warningPromise = Promise.resolve().then(() =>
        component.onShutdownWarning?.(),
      );

      warningPromises.push(
        warningPromise
          .then(() => {
            statuses.set(name, 'resolved');
            this.safeEmit('component:shutdown-warning-completed', { name });
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

          this.safeEmit('component:shutdown-warning-timeout', {
            name,
            timeoutMS,
          });
        }

        // Global timeout: proceed to graceful shutdown regardless of pending warnings.
        this.logger.warn('Shutdown warning phase timed out', {
          params: { timeoutMS, pending: pendingComponents.length },
        });

        this.safeEmit('lifecycle-manager:shutdown-warning-timeout', {
          timeoutMS,
          pending: pendingComponents.map(({ name }) => name),
        });

        return;
      }

      this.safeEmit('lifecycle-manager:shutdown-warning-completed', {
        timeoutMS,
      });
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
    this.safeEmit('component:stopping', { name });

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
            if (component.onStopAborted) {
              try {
                component.onStopAborted();
              } catch (error) {
                this.logger
                  .entity(name)
                  .warn('Error in onStopAborted callback', {
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
      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.stoppedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component stopped gracefully');
      this.safeEmit('component:stopped', { name });

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
        this.safeEmit('component:stop-timeout', { name, error: err });

        return {
          success: false,
          componentName: name,
          reason: 'Graceful shutdown timed out',
          code: 'stop_timeout',
          error: err,
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

    this.safeEmit('component:shutdown-force', {
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

      this.logger
        .entity(name)
        .error('Component stalled - graceful shutdown failed', {
          params: {
            reason: context.gracefulTimedOut ? 'timeout' : 'error',
            hasForceHandler: false,
          },
        });

      this.safeEmit('component:stalled', { name, stallInfo });

      // Return the original graceful phase error
      return {
        success: false,
        componentName: name,
        reason: context.gracefulTimedOut
          ? 'Component stop timed out'
          : (context.gracefulError?.message ?? 'Graceful shutdown failed'),
        code: context.gracefulTimedOut ? 'stop_timeout' : 'unknown_error',
        error: context.gracefulError,
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
      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.stoppedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component force stopped');
      this.safeEmit('component:shutdown-force-completed', { name });
      this.safeEmit('component:stopped', { name });

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

      if (isTimeout) {
        this.logger.entity(name).error('Force shutdown timed out - stalled', {
          params: { timeoutMS },
        });
        this.safeEmit('component:shutdown-force-timeout', {
          name,
          timeoutMS,
        });
      } else {
        this.logger.entity(name).error('Force shutdown failed - stalled', {
          params: { error: err.message },
        });
      }

      this.safeEmit('component:stalled', { name, stallInfo });

      return {
        success: false,
        componentName: name,
        reason: isTimeout ? 'Force shutdown timed out' : err.message,
        code: 'unknown_error',
        error: err,
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
      this.safeEmit('component:startup-rollback', { name });

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
  private safeEmit(event: string, data?: unknown): void {
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
    this.safeEmit('signal:shutdown', { method });

    // Initiate shutdown asynchronously (don't await in signal handler)
    void this.stopAllComponentsInternal(method);
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
    this.safeEmit('signal:reload');

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
    this.safeEmit('signal:info');

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
    this.safeEmit('signal:debug');

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

      this.safeEmit('component:reload-started', { name });

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
          this.safeEmit('component:reload-completed', { name });
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
        this.safeEmit('component:reload-failed', { name, error: err });
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

      this.safeEmit('component:info-started', { name });

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
          this.safeEmit('component:info-completed', { name });
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
        this.safeEmit('component:info-failed', { name, error: err });
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

      this.safeEmit('component:debug-started', { name });

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
          this.safeEmit('component:debug-completed', { name });
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
        this.safeEmit('component:debug-failed', { name, error: err });
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
