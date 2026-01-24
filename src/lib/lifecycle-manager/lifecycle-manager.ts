import { EventEmitterProtected } from '../event-emitter';
import type { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import type { BaseComponent } from './base-component';
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
} from './types';
import {
  ComponentStartTimeoutError,
  ComponentStopTimeoutError,
  DependencyCycleError,
} from './errors';

/**
 * LifecycleManager - Comprehensive lifecycle orchestration system
 *
 * Manages startup, shutdown, and runtime control of application components.
 * Features:
 * - Multi-phase shutdown (warning -> graceful -> force)
 * - Dependency-ordered component startup
 * - Process signal integration
 * - Component messaging and value sharing
 * - Health checks and monitoring
 * - Event-driven architecture
 */
export class LifecycleManager extends EventEmitterProtected {
  // Configuration
  private readonly name: string;
  private readonly logger: LoggerService;
  private readonly rootLogger: Logger;

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

  constructor(options: LifecycleManagerOptions & { logger: Logger }) {
    super();

    this.name = options.name ?? 'lifecycle-manager';
    this.rootLogger = options.logger;
    this.logger = this.rootLogger.service(this.name);
  }

  // ============================================================================
  // Component Registration
  // ============================================================================

  /**
   * Register a component at the end of the registry list.
   */
  public registerComponent(
    component: BaseComponent,
    _options?: RegisterOptions,
  ): RegisterComponentResult {
    const componentName = component.getName();
    const registrationIndexBefore = this.getComponentIndex(componentName);

    try {
      if (this.isShuttingDown) {
        this.logger
          .entity(componentName)
          .warn('Cannot register component during shutdown');
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'shutdown_in_progress',
        });

        return this.buildRegisterResultFailure({
          componentName,
          registrationIndexBefore,
          code: 'shutdown_in_progress',
        });
      }

      if (registrationIndexBefore !== null) {
        this.logger
          .entity(componentName)
          .warn('Component with this name already registered');
        this.safeEmit('component:registration-rejected', {
          name: componentName,
          reason: 'duplicate_name',
        });

        return this.buildRegisterResultFailure({
          componentName,
          registrationIndexBefore,
          code: 'duplicate_name',
        });
      }

      // Compute dependency order *before* committing registration mutations.
      // This avoids leaving the registry/state maps inconsistent if a dependency
      // cycle is detected.
      let startupOrder: string[];
      try {
        startupOrder = this.getStartupOrderInternal([
          ...this.components,
          component,
        ]);
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

          return this.buildRegisterResultFailure({
            componentName,
            registrationIndexBefore,
            code: 'dependency_cycle',
            error,
          });
        }
        throw error;
      }

      // Commit registration
      this.components.push(component);
      (component as unknown as { lifecycle: unknown }).lifecycle = this;

      // Initialize state
      this.componentStates.set(componentName, 'registered');
      this.componentTimestamps.set(componentName, {
        startedAt: null,
        stoppedAt: null,
      });
      this.componentErrors.set(componentName, null);

      const registrationIndexAfter = this.getComponentIndex(componentName);

      this.logger.entity(componentName).info('Component registered', {
        params: { index: registrationIndexAfter },
      });
      this.safeEmit('component:registered', {
        name: componentName,
        index: registrationIndexAfter,
      });

      return {
        action: 'register',
        success: true,
        registered: true,
        componentName,
        registrationIndexBefore: null,
        registrationIndexAfter,
        startupOrder,
      };
    } catch (error) {
      const err = error as Error;
      const code: RegistrationFailureCode =
        err instanceof DependencyCycleError ? 'dependency_cycle' : 'unknown_error';

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
        action: 'register',
        success: false,
        registered: false,
        componentName,
        code,
        error: err,
        registrationIndexBefore,
        registrationIndexAfter: registrationIndexBefore,
        startupOrder: [],
      };
    }
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
          targetFound: undefined,
        });
      }

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
          targetFound: undefined,
        });
      }

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
          targetFound: undefined,
        });
      }

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

        const startupOrder = this.getStartupOrderInternal();
        return {
          action: 'insert',
          success: false,
          registered: false,
          componentName,
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
            error,
            targetFound:
              position === 'before' || position === 'after' ? true : undefined,
          });
        }
        throw error;
      }

      // Commit registration
      this.components.splice(insertIndex, 0, component);
      (component as unknown as { lifecycle: unknown }).lifecycle = this;

      // Initialize state
      this.componentStates.set(componentName, 'registered');
      this.componentTimestamps.set(componentName, {
        startedAt: null,
        stoppedAt: null,
      });
      this.componentErrors.set(componentName, null);

      const isManualPositionRespected = this.isManualPositionRespected({
        componentName,
        position,
        targetComponentName,
        startupOrder,
      });

      const registrationIndexAfter = this.getComponentIndex(componentName);

      this.logger.entity(componentName).info('Component inserted', {
        params: { position, index: registrationIndexAfter },
      });
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
      const err = error as Error;
      const code: RegistrationFailureCode =
        err instanceof DependencyCycleError ? 'dependency_cycle' : 'unknown_error';

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

  /**
   * Unregister a component
   *
   * @param name - Component name to unregister
   * @param options - Unregister options (stopIfRunning)
   * @returns True if component was unregistered, false otherwise
   */
  public async unregisterComponent(
    name: string,
    options?: UnregisterOptions,
  ): Promise<UnregisterComponentResult> {
    const component = this.getComponent(name);

    if (!component) {
      this.logger.entity(name).warn('Component not found');
      return {
        success: false,
        componentName: name,
        code: 'component_not_found',
        wasStopped: false,
        wasRegistered: false,
      };
    }

    const isRunning = this.isComponentRunning(name);

    // If running and stopIfRunning not set, reject
    if (isRunning && !options?.stopIfRunning) {
      this.logger
        .entity(name)
        .warn(
          'Cannot unregister running component. Call stopComponent() first or pass { stopIfRunning: true }',
        );
      return {
        success: false,
        componentName: name,
        code: 'component_running',
        wasStopped: false,
        wasRegistered: true,
      };
    }

    // If running and stopIfRunning is true, stop first
    let wasStopped = false;
    if (isRunning && options?.stopIfRunning) {
      this.logger.entity(name).info('Stopping component before unregistering');
      const stopResult = await this.stopComponent(name);

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
              code: stopResult.code,
              state: stateAfterStopAttempt,
            },
          });

        return {
          success: false,
          componentName: name,
          code: 'stop_failed',
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
        err instanceof DependencyCycleError ? 'dependency_cycle' : 'unknown_error';

      this.logger.error('Failed to resolve startup order', {
        params: { error: err },
      });

      return {
        success: false,
        startupOrder: [],
        code,
        error: err,
      };
    }
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
    const component = this.getComponent(name);

    if (!component) {
      return {
        success: false,
        componentName: name,
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
          code: 'missing_dependency',
        };
      }

      if (!this.isComponentRunning(dependencyName)) {
        if (options?.allowOptionalDependencies && dependency.isOptional()) {
          continue;
        }
        return {
          success: false,
          componentName: name,
          code: 'dependency_not_running',
        };
      }
    }

    const currentState = this.componentStates.get(name);
    if (currentState === 'starting') {
      return {
        success: false,
        componentName: name,
        code: 'component_already_starting',
      };
    }

    // Check if already running
    if (this.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        code: 'component_already_running',
      };
    }

    // Check if shutdown in progress
    if (this.isShuttingDown) {
      return {
        success: false,
        componentName: name,
        code: 'shutdown_in_progress',
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
   * Stop a specific component
  /**
   * Stop a single component
   */
  public async stopComponent(
    name: string,
    _options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    const component = this.getComponent(name);

    if (!component) {
      return {
        success: false,
        componentName: name,
        code: 'component_not_found',
      };
    }

    // Check if not running
    if (!this.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        code: 'component_not_running',
      };
    }

    // Set state to stopping
    this.componentStates.set(name, 'stopping');
    this.logger.entity(name).info('Stopping component');
    this.safeEmit('component:stopping', { name });

    const timeoutMS = component.shutdownGracefulTimeoutMS;
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

      // Update state
      this.componentStates.set(name, 'stopped');
      this.runningComponents.delete(name);
      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.stoppedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component stopped');
      this.safeEmit('component:stopped', { name });

      return {
        success: true,
        componentName: name,
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
        // Mark as stalled
        const stallInfo: ComponentStallInfo = {
          name,
          reason: 'timeout',
          stalledAt: Date.now(),
          error: err,
        };
        this.stalledComponents.set(name, stallInfo);
        this.componentStates.set(name, 'stalled');
        this.runningComponents.delete(name);

        this.logger
          .entity(name)
          .error('Component stop timed out - marked as stalled');
        this.safeEmit('component:stop-timeout', { name, error: err });
        this.safeEmit('component:stalled', { name, stallInfo });

        return {
          success: false,
          componentName: name,
          code: 'stop_timeout',
          error: err,
        };
      } else {
        // Error during stop - also mark as stalled
        const stallInfo: ComponentStallInfo = {
          name,
          reason: 'error',
          stalledAt: Date.now(),
          error: err,
        };
        this.stalledComponents.set(name, stallInfo);
        this.componentStates.set(name, 'stalled');
        this.runningComponents.delete(name);

        this.logger
          .entity(name)
          .error('Component failed to stop - marked as stalled', {
            params: { error: err.message },
          });
        this.safeEmit('component:stalled', { name, stallInfo });

        return {
          success: false,
          componentName: name,
          code: 'unknown_error',
          error: err,
        };
      }
    } finally {
      // Ensure we always clean up the timeout handle, even if component.stop()
      // rejects (non-timeout failure). Otherwise onStopAborted() can fire
      // unexpectedly later and the timer handle leaks.
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Restart a component (stop then start)
   */
  public async restartComponent(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult> {
    // First stop the component
    const stopResult = await this.stopComponent(name, options?.stopOptions);

    if (!stopResult.success) {
      return {
        success: false,
        componentName: name,
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
        code: 'restart_start_failed',
        error: startResult.error,
      };
    }

    return {
      success: true,
      componentName: name,
    };
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
    error?: Error;
  }): RegisterComponentResult {
    const startupOrder = this.getStartupOrderInternal();
    return {
      action: 'register',
      success: false,
      registered: false,
      componentName: input.componentName,
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
    error?: Error;
    targetFound?: boolean;
  }): InsertComponentAtResult {
    const startupOrder = this.getStartupOrderInternal();
    return {
      action: 'insert',
      success: false,
      registered: false,
      componentName: input.componentName,
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
      throw new DependencyCycleError({ cycle: cycle.length > 0 ? cycle : remaining });
    }

    return order;
  }

  private findDependencyCycle(
    adjacency: Map<string, Set<string>>,
  ): string[] {
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
}
