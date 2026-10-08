import { ComponentMetadataReader } from './internal/component-metadata-reader';
import { TransitionEventDispatcher } from './internal/transition-event-dispatcher';
import { RegistrationReadTracker } from './internal/registration-read-tracker';
import { LifecycleManagerState } from './internal/manager-state';
import {
  type ManagerConfig,
  resolveManagerConfig,
} from './internal/manager-config';
import { ManagerCore, type ManagerInternals } from './internal/manager-core';
import type { ComponentAccessContext } from './internal/component-access-context';
import {
  sendMessageInternal,
  broadcastMessageInternal,
  getValueInternal,
} from './internal/component-messaging';
import {
  checkComponentHealthOperation,
  checkAllHealthOperation,
} from './internal/component-inspection';
import {
  dependenciesOf,
  findAllCircularCycles,
} from './internal/dependency-policy';
import {
  settleOperation,
  crashedStartupResult,
  crashedShutdownResult,
  crashedSignalBroadcastResult,
  crashedHealthCheckResult,
  crashedHealthReport,
  crashedComponentResult,
  observeFailureAfterTimeout,
} from './internal/operation-policy';
import {
  snapshotStartOptions,
  snapshotStartupOptions,
} from './internal/operation-options';
import { EventEmitterProtected } from '../event-emitter';
import type { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import type { BaseComponent } from './base-component';
import type {
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
  StartupOrderResult,
  StartupOptions,
  StartupResult,
  ShutdownResult,
  StopAllOptions,
  RestartResult,
  RestartAllOptions,
  DependencyValidationResult,
  SignalBroadcastResult,
  LifecycleSignalStatus,
  ShutdownEscalationStatus,
  LifecycleCommon,
  MessageResult,
  BroadcastResult,
  BroadcastOptions,
  SendMessageOptions,
  GetValueOptions,
  HealthCheckResult,
  HealthReport,
  ValueResult,
} from './types';
import {
  LifecycleManagerEvents,
  type LifecycleManagerEventMap,
  type LifecycleManagerEventName,
} from './events';
import { ProcessSignalManager } from '../process-signal-manager';
import { reportCallbackError } from '../safe-handle-callback';
import { createGuardedLoggerService } from './guarded-logger';
import { toError } from '../to-error';

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
  /** Everything this manager changes after construction. */
  private readonly state = new LifecycleManagerState();
  /** The constructor's options, validated and frozen. */
  private readonly config: ManagerConfig;
  /**
   * The manager's own logging surface: guarded, so no line in this file can throw or
   * reject at its call site. See {@link createGuardedLoggerService}.
   */
  private readonly logger: LoggerService;
  /**
   * The caller's own `Logger`, never wrapped. `enableLoggerExitHook` registers a
   * `beforeExit` callback on it, and components build their own service loggers from the
   * instance the caller handed them, so the object identity and behaviour here stay the
   * caller's.
   */
  private readonly rootLogger: Logger;
  private readonly registrationReads = new RegistrationReadTracker(
    () => this.state.components,
  );
  private readonly componentMetadata = new ComponentMetadataReader(
    (component) => this.core.registry.nameOf(component),
  );
  private readonly lifecycleEvents: LifecycleManagerEvents;
  private readonly eventDispatcher = new TransitionEventDispatcher(
    (event, data) => this.deliverEvent(event, data),
  );

  private readonly componentAccess: ComponentAccessContext;
  /** The shared core the manager's subsystems are built over, with those subsystems. */
  private readonly core: ManagerCore;

  constructor(options: LifecycleManagerOptions & { logger: Logger }) {
    super();

    if (!options.logger) {
      throw new Error('LifecycleManager requires a root logger');
    }

    const name = options.name ?? 'lifecycle-manager';
    this.rootLogger = options.logger;
    // Guarded once, here, rather than at the ~140 call sites that log: the logger is
    // caller-supplied, and a method that throws or rejects would otherwise propagate
    // into whatever lifecycle operation happened to be logging at the time.
    this.logger = createGuardedLoggerService(this.rootLogger.service(name));
    this.config = resolveManagerConfig(name, options);
    this.lifecycleEvents = new LifecycleManagerEvents((event, data) => {
      this.eventDispatcher.emit(event, data);
    });
    this.componentAccess = LifecycleManager.createComponentAccessContext(this);
    this.core = new ManagerCore({
      manager: this,
      state: this.state,
      config: this.config,
      logger: this.logger,
      rootLogger: this.rootLogger,
      lifecycleEvents: this.lifecycleEvents,
      dispatcher: this.eventDispatcher,
      registryReads: this.registrationReads,
      componentMetadata: this.componentMetadata,
      componentAccess: this.componentAccess,
      internals: LifecycleManager.createManagerInternals(this),
      createProcessSignalManager: (signalOptions) =>
        new ProcessSignalManager(signalOptions),
    });

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
    const result = await this.core.registration.registerComponentSettled(
      component,
      'end',
      undefined,
      false,
      options,
    );

    // Share registration fields without exposing insertion-only metadata.
    const {
      action: _action,
      requestedPosition: _requestedPosition,
      actualPosition: _actualPosition,
      manualPositionRespected: isManualPositionRespectedIgnored,
      targetFound: wasTargetFound,
      ...registration
    } = result;

    return {
      ...registration,
      action: 'register',
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
    return await this.core.registration.registerComponentSettled(
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
   * @returns The outcome: `success`, a `code` on failure, and `wasStopped` / `wasRegistered`
   */
  public unregisterComponent(
    name: string,
    options?: UnregisterOptions,
  ): Promise<UnregisterComponentResult> {
    // What the operation got through before it crashed, so the failure result describes
    // the component as it actually is: stopped, even though unregistering then failed.
    // `wasRegistered` is taken now, as the field is documented - registered when this
    // call started - and through the manager's own registry rather than the public,
    // overridable `hasComponent()`: read at failure time, it described whatever held
    // the name by then, and an override that threw made this safety net reject.
    const progress = {
      wasStopped: false,
      wasRegistered: this.core.registry.isNameRegistered(name),
    };

    return settleOperation(
      'unregisterComponent',
      () =>
        this.core.registration.unregisterComponentOperation(
          name,
          options,
          progress,
        ),
      (error, reason, code) => ({
        success: false,
        componentName: name,
        reason,
        code,
        error,
        wasStopped: progress.wasStopped,
        wasRegistered: progress.wasRegistered,
      }),
    );
  }

  // ============================================================================
  // Status Tracking
  // ============================================================================

  /**
   * Check if a component is registered
   */
  public hasComponent(name: string): boolean {
    return this.core.registry.isNameRegistered(name);
  }

  /**
   * Check if a component is currently running
   */
  public isComponentRunning(name: string): boolean {
    return this.state.runningComponents.has(name);
  }

  /**
   * Get all registered component names
   */
  public getComponentNames(): string[] {
    return this.state.components.map((c) => this.core.registry.nameOf(c));
  }

  /**
   * Get all running component names
   */
  public getRunningComponentNames(): string[] {
    return Array.from(this.state.runningComponents);
  }

  /**
   * Get the actual component instance by name.
   *
   * Note: This returns the live instance registered with the manager. Mutating it
   * directly can bypass lifecycle invariants, so treat it as read-only unless you
   * fully control the component and understand the implications.
   */
  public getComponentInstance(name: string): BaseComponent | undefined {
    return this.core.registry.getComponent(name);
  }

  /**
   * Get total component count
   */
  public getComponentCount(): number {
    return this.state.components.length;
  }

  /**
   * Get running component count
   */
  public getRunningComponentCount(): number {
    // Stalled components are not counted as running.
    return this.state.runningComponents.size;
  }

  /**
   * Get stalled component count
   */
  public getStalledComponentCount(): number {
    return this.state.stalledComponents.size;
  }

  /**
   * Get stopped (not running, not stalled) component count
   */
  public getStoppedComponentCount(): number {
    return this.getStoppedComponentNames().length;
  }

  /**
   * Get components currently in starting-timed-out state. Timed-out forced
   * starts retaining a stall are reported by the stalled APIs instead.
   */
  public getStartTimedOutComponentCount(): number {
    return this.getStartTimedOutComponentNames().length;
  }

  /**
   * Get detailed status for a specific component
   */
  public getComponentStatus(name: string): ComponentStatus | undefined {
    return this.core.registry.isNameRegistered(name)
      ? this.core.registry.statusOf(name)
      : undefined;
  }

  /**
   * Get statuses for all components
   */
  public getAllComponentStatuses(): ComponentStatus[] {
    // One walk: each entry is already in hand, so it is not looked up by name again.
    return this.state.components.map((component) =>
      this.core.registry.statusOf(this.core.registry.nameOf(component)),
    );
  }

  /**
   * Get overall system state
   */
  public getSystemState(): SystemState {
    const totalCount = this.getComponentCount();
    const runningCount = this.getRunningComponentCount();

    if (this.core.shutdownPass.isShuttingDown) {
      return 'shutting-down';
    }

    if (this.state.isStarting) {
      return 'starting';
    }

    if (totalCount === 0) {
      return 'no-components';
    }

    // Check for stalled components (failed to stop)
    if (this.state.stalledComponents.size > 0) {
      return 'stalled';
    }

    if (runningCount === 0) {
      return 'ready';
    }

    // All running, or some: a partial set is valid after individual starts and stops,
    // and something is running.
    return 'running';
  }

  /**
   * Get aggregated status snapshot for the manager.
   */
  public getStatus(): LifecycleManagerStatus {
    // The registry-ordered lists in one walk, as `getStoppedComponentNames()` and
    // `getStartTimedOutComponentNames()` would each build them; their counts are their
    // lengths.
    const registeredNames: string[] = [];
    const stoppedNames: string[] = [];
    const startTimedOutNames: string[] = [];
    for (const component of this.state.components) {
      const name = this.core.registry.nameOf(component);
      registeredNames.push(name);
      if (
        !this.state.runningComponents.has(name) &&
        !this.state.stalledComponents.has(name)
      ) {
        stoppedNames.push(name);
      }
      if (this.state.componentStates.get(name) === 'starting-timed-out') {
        startTimedOutNames.push(name);
      }
    }

    return {
      systemState: this.getSystemState(),
      isStarted: this.state.isStarted,
      isStarting: this.state.isStarting,
      isShuttingDown: this.core.shutdownPass.isShuttingDown,
      counts: {
        total: registeredNames.length,
        running: this.state.runningComponents.size,
        stopped: stoppedNames.length,
        stalled: this.state.stalledComponents.size,
        startTimedOut: startTimedOutNames.length,
      },
      components: {
        registered: registeredNames,
        running: this.getRunningComponentNames(),
        stopped: stoppedNames,
        stalled: this.getStalledComponentNames(),
        startTimedOut: startTimedOutNames,
      },
    };
  }

  /**
   * Get information about components that are stalled (failed to stop)
   */
  public getStalledComponents(): ComponentStallInfo[] {
    return Array.from(this.state.stalledComponents.values());
  }

  /**
   * Get stalled component names
   */
  public getStalledComponentNames(): string[] {
    return Array.from(this.state.stalledComponents.keys());
  }

  /**
   * Get components currently in starting-timed-out state. Timed-out forced
   * starts retaining a stall are reported by the stalled APIs instead.
   */
  public getStartTimedOutComponentNames(): string[] {
    return this.getComponentNames().filter(
      (name) => this.state.componentStates.get(name) === 'starting-timed-out',
    );
  }

  /**
   * Get stopped (not running, not stalled) component names
   */
  public getStoppedComponentNames(): string[] {
    // The manager's own sets, asked directly: copying them into arrays and back into
    // sets cost two allocations per call for the same membership answer.
    return this.getComponentNames().filter(
      (name) =>
        !this.state.runningComponents.has(name) &&
        !this.state.stalledComponents.has(name),
    );
  }

  /**
   * Get resolved startup order after applying dependency constraints.
   */
  public getStartupOrder(): StartupOrderResult {
    try {
      // Read until the reads stop changing the registry, as `validateDependencies()`
      // and a bulk startup read it: a `getDependencies()` that registers or unregisters
      // a component re-entrantly left an order over the registry as it was when the
      // reads began - naming a component that was gone. Ordered over the live registry
      // once they settle, from the lists already read, so ordering runs no caller code.
      const { reads, isSettled } = this.registrationReads.readRegistry(
        (component) =>
          this.componentMetadata.readDependenciesReported(
            component,
            'ordering',
          ),
      );
      if (!isSettled) {
        throw new Error(
          'The registry kept changing while the startup order was being read',
        );
      }

      return {
        success: true,
        startupOrder: this.core.startupOrdering.getStartupOrderInternal(
          this.state.components,
          undefined,
          reads,
        ),
      };
    } catch (error) {
      return {
        success: false,
        startupOrder: [],
        ...this.core.startupOrdering.answerStartupOrderFailure(
          error,
          'lifecycle-manager getStartupOrder',
        ),
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

    // Each component read once, guarded: the reads run its own code, and one whose
    // `getDependencies()` or `isOptional()` threw made this - documented as not
    // throwing - throw to its caller. A component whose dependencies cannot be read is
    // reported, listed in `invalidDependencyLists`, and makes the result invalid: its own
    // start fails on the same list, so "valid" would be a promise it cannot keep. An
    // `isOptional()` that throws does not: startup reads it as required and starts the
    // component normally, so validation answers the same.
    const invalidDependencyLists: Array<{
      componentName: string;
      error: Error;
    }> = [];
    const graph: Array<{
      name: string;
      isOptional: boolean;
      dependencies: string[];
    }> = [];

    // Read until the reads stop changing the registry, as registration reads it: they
    // run components' code, which can register or unregister re-entrantly, and a check
    // over the registry as it was when the loop began listed components that were gone
    // and missed ones that had arrived - `valid: true` for a registry whose startup then
    // failed. The graph is the live registry once the reads settle.
    const { reads } = this.registrationReads.readRegistry((component) => ({
      // The one rule startup applies, through the one helper: a throw is reported once
      // and read as required.
      isOptional: this.componentMetadata.isComponentOptional(component),
      // Reported once per registration, like every other read of it: the failure is in
      // the result already, and a caller polling this would flood the channel.
      read: this.componentMetadata.readDependenciesReported(
        component,
        'validateDependencies',
      ),
    }));

    for (const component of this.state.components) {
      const name = this.core.registry.nameOf(component);
      // A registry the reads kept changing can leave a component with a list read for a
      // registration that has since been replaced, or with none at all. Only that
      // component is reported as unread: one holding its current registration's answer
      // is part of an exact snapshot of the live registry, since nothing runs between
      // the last read and this answer.
      const isUnread = !this.registrationReads.isReadCurrent(reads, component);
      const current = isUnread ? undefined : reads.get(component);
      const { isOptional, read } = current ?? {
        isOptional: false,
        read: {
          error: new Error(
            'The registry kept changing while dependencies were being validated',
          ),
        },
      };

      if (!('dependencies' in read) || read.invalidEntry !== undefined) {
        invalidDependencyLists.push({
          componentName: name,
          error: toError(
            'dependencies' in read ? read.invalidEntry : read.error,
          ),
        });
      }

      graph.push({
        name,
        isOptional,
        dependencies: dependenciesOf(read),
      });
    }

    // Looked up here rather than through the registry per dependency, which rescanned
    // every component for each one.
    const registeredNames = new Set(graph.map(({ name }) => name));

    // Check for missing dependencies
    for (const {
      name: componentName,
      isOptional: isComponentOptional,
      dependencies,
    } of graph) {
      for (const dep of dependencies) {
        if (!registeredNames.has(dep)) {
          missingDependencies.push({
            componentName,
            componentIsOptional: isComponentOptional,
            missingDependency: dep,
          });
        }
      }
    }

    // Build adjacency graph for cycle detection
    const adjacency = new Map<string, Set<string>>();

    for (const { name } of graph) {
      adjacency.set(name, new Set());
    }

    // Build edges: dependency -> dependent (only when dependency is registered)
    for (const { name: dependent, dependencies } of graph) {
      for (const dep of dependencies) {
        if (adjacency.has(dep)) {
          adjacency.get(dep)?.add(dependent);
        }
      }
    }

    // Find circular dependency cycles. Guarded, as `getStartupOrder()` guards its sort:
    // this method is documented as not throwing, and the walk is iterative so chain
    // depth cannot exhaust the stack, but any other failure inside it must not escape
    // either. A graph that could not be checked is no basis for "valid": answered
    // invalid, with the failure on the result and reported as any crash is.
    let circularCycles: string[][] = [];
    let cycleCheckError: Error | undefined;
    try {
      circularCycles = findAllCircularCycles(adjacency);
    } catch (error) {
      cycleCheckError = toError(error);
      reportCallbackError('lifecycle-manager validateDependencies', error);
      this.logger.error(
        'Failed to check dependencies for cycles: {{error.message}}',
        { params: { error: cycleCheckError } },
      );
    }

    const isValid =
      missingDependencies.length === 0 &&
      circularCycles.length === 0 &&
      invalidDependencyLists.length === 0 &&
      cycleCheckError === undefined;

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
      invalidDependencyLists,
      ...(cycleCheckError === undefined ? {} : { cycleCheckError }),
      summary: {
        totalMissingDependencies,
        requiredMissingDependencies,
        optionalMissingDependencies,
        totalCircularCycles: circularCycles.length,
        totalInvalidDependencyLists: invalidDependencyLists.length,
      },
    };
  }

  /**
   * Get the result of the last shutdown operation.
   * Useful for debugging stalled components or tracking shutdown metrics.
   * Returns null if no shutdown has occurred yet, or once a later bulk startup
   * (including a restart's startup phase) has taken the startup latch and passed its
   * signal-attach and shutdown checks - cleared then, whatever that startup's outcome.
   *
   * @returns The last shutdown result or null
   */
  public getLastShutdownResult(): ShutdownResult | null {
    return this.state.lastShutdownResult;
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
   * - Refuses, resolving with `code: 'partial_state'`, if some components are already running
   * - Sets isStarting flag during operation
   * - On failure: attempts rollback; dependencies of unfinished or failed cleanup remain running
   * - Optional components don't trigger rollback on failure
   * - Dependents still attempt to start if an optional dependency fails
   * - Handles shutdown during startup (aborts; shutdown owns cleanup)
   */
  public startAllComponents(options?: StartupOptions): Promise<StartupResult> {
    return settleOperation(
      'startAllComponents',
      () =>
        this.core.startup.startAllComponentsOperation(() =>
          snapshotStartupOptions(options),
        ),
      (error, reason, code) => crashedStartupResult(error, reason, code),
    );
  }

  /**
   * Stop all running components in reverse dependency order
   *
   * Components stop in reverse topological order (dependents before dependencies).
   *
   * Never rejects. Stalls and timeouts are reported in the resolved `ShutdownResult`, and
   * so is a pass that throws outright: it resolves with `code: 'operation_crashed'` and the
   * thrown value on `error`, and is reported on the global `'error'` channel. Such a pass
   * still emits `lifecycle-manager:shutdown-completed` with the same result and updates
   * `getLastShutdownResult()`, so listeners are never left waiting on it either.
   *
   * Not awaiting it is safe, so a caller that cannot block - an HTTP handler, an event
   * listener - can start the shutdown and read the outcome later from the same promise:
   *
   * ```ts
   * const pending = manager.stopAllComponents();
   * // ...carry on...
   * pending.then((result) => { ... });
   * ```
   *
   * Called during a `restartAllComponents()` stop phase this still refuses with
   * `already_in_progress`, but it cancels the restart's startup phase - a direct stop
   * call in that window means the components should stay down.
   *
   * The same refusal applies inside `lifecycle-manager:shutdown-completed` and
   * `shutdown-escalation-armed` listeners: they run while the pass still holds its
   * latch, and `getSystemState()` says `shutting-down` there too. To act on a result,
   * defer out of the listener (`setImmediate`, `queueMicrotask`) or `await` the promise
   * this method returned.
   *
   * @param options - Optional shutdown options
   */
  public stopAllComponents(options?: StopAllOptions): Promise<ShutdownResult> {
    return settleOperation(
      'stopAllComponents',
      () => this.core.shutdownPass.stopAllComponentsOperation(options),
      (error, reason, code) => crashedShutdownResult(error, reason, code),
    );
  }

  /**
   * Restart all components (stop then start)
   *
   * Never rejects: see {@link stopAllComponents}. A stop phase that throws outright
   * resolves with its `operation_crashed` result and the startup phase is skipped, since
   * nothing can be said about what state it left the components in.
   *
   * A shutdown request that arrives while the stop phase is running wins: the startup
   * phase is skipped and the result says so through
   * `startupSkippedByShutdownRequest`. See {@link ShutdownPass}.
   *
   * A restart arriving during an active shutdown returns `already_in_progress` for
   * its stop phase and `shutdown_in_progress` for startup before reading options or
   * component startup getters. It owns no pass, reports no skipped startup, and does
   * not cancel the restart that owns the active shutdown.
   */
  public restartAllComponents(
    options?: RestartAllOptions,
  ): Promise<RestartResult> {
    // Filled in once the stop phase has answered, so a crash after it still reports the
    // shutdown that actually happened - the same result `shutdown-completed` and
    // `getLastShutdownResult()` already carry. Caller options are validated before
    // stopping; failures from later phase bookkeeping still retain this result.
    const phases: { shutdownResult?: ShutdownResult } = {};

    return settleOperation(
      'restartAllComponents',
      () => this.core.restart.restartAllComponentsOperation(options, phases),
      (error, reason, code) => ({
        shutdownResult:
          phases.shutdownResult ?? crashedShutdownResult(error, reason, code),
        startupResult: crashedStartupResult(error, reason, code),
        success: false,
      }),
    );
  }

  // ============================================================================
  // Individual Component Lifecycle
  // ============================================================================

  /**
   * Start a specific component
   */
  public startComponent(
    name: string,
    options?: StartComponentOptions,
  ): Promise<ComponentOperationResult> {
    return settleOperation(
      'startComponent',
      // Read by the start itself, under its own net, as the first thing it does.
      () =>
        this.core.componentStart.startComponentInternal(name, () =>
          snapshotStartOptions(options),
        ),
      (error, reason, code) =>
        crashedComponentResult(name, error, reason, code),
    );
  }

  /**
   * Stop a specific component
   */
  public stopComponent(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    return settleOperation(
      'stopComponent',
      () => this.core.componentStop.stopComponentOperation(name, options),
      (error, reason, code) =>
        crashedComponentResult(name, error, reason, code),
    );
  }

  /**
   * Restart a component (stop then start)
   */
  public restartComponent(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult> {
    return settleOperation(
      'restartComponent',
      () => this.core.restart.restartComponentOperation(name, options),
      (error, reason, code) =>
        crashedComponentResult(name, error, reason, code),
    );
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
    this.core.signals.attach();
  }

  /**
   * Detach signal handlers.
   * Idempotent - calling multiple times has no effect.
   */
  public detachSignals(): void {
    this.core.signals.detach();
  }

  /**
   * Get status information about signal handling.
   */
  public getSignalStatus(): LifecycleSignalStatus {
    return this.core.signals.status();
  }

  /**
   * Get status information about repeated shutdown escalation configuration and runtime state.
   */
  public getShutdownEscalationStatus(): ShutdownEscalationStatus {
    return this.core.shutdownEscalation.status();
  }

  /**
   * Enable Logger exit hook integration
   *
   * Sets up the logger's beforeExit callback to trigger graceful component shutdown.
   * When `logger.exit(code)` is called (or `logger.error('msg', { exitCode: 1 })`),
   * the LifecycleManager will stop all components before the process exits.
   *
   * The shutdown is subject to the configured `shutdownOptions.timeoutMS` (default:
   * 30000ms). If shutdown exceeds this timeout, the exit proceeds anyway to prevent
   * hanging. With `timeoutMS: 0` - no deadline - the exit waits for the pass however long
   * it takes: each component's stop is still bounded by its own graceful and force
   * timeouts, but an in-flight `start()` without a startup timeout is waited for
   * indefinitely. Keep a non-zero timeout when an exit must never hang.
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
    this.core.loggerExit.enable();
  }

  /**
   * Manually trigger a reload event.
   * @returns Result of broadcasting reload to components
   */
  public triggerReload(): Promise<SignalBroadcastResult> {
    return settleOperation(
      'triggerReload',
      () => this.core.signals.handleReloadRequest(),
      (error, _reason, code) =>
        crashedSignalBroadcastResult('reload', error, code),
    );
  }

  /**
   * Manually trigger an info event.
   * @returns Result of broadcasting info to components
   */
  public triggerInfo(): Promise<SignalBroadcastResult> {
    return settleOperation(
      'triggerInfo',
      () => this.core.signals.handleInfoRequest(),
      (error, _reason, code) =>
        crashedSignalBroadcastResult('info', error, code),
    );
  }

  /**
   * Manually trigger a debug event.
   * @returns Result of broadcasting debug to components
   */
  public triggerDebug(): Promise<SignalBroadcastResult> {
    return settleOperation(
      'triggerDebug',
      () => this.core.signals.handleDebugRequest(),
      (error, _reason, code) =>
        crashedSignalBroadcastResult('debug', error, code),
    );
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
  public sendMessageToComponent(
    componentName: string,
    payload: unknown,
    options?: SendMessageOptions,
  ): Promise<MessageResult> {
    return this.sendMessageSettled(componentName, payload, null, options);
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
  public broadcastMessage(
    payload: unknown,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    return this.broadcastMessageSettled(payload, null, options);
  }

  // ============================================================================
  // Health Checks
  // ============================================================================

  /**
   * Check the health of a specific component
   *
   * Calls the component's healthCheck() method if implemented.
   * Times out after component's healthCheckTimeoutMS. A timeout of 0 is disabled.
   *
   * @param name - Component name
   * @returns Health check result with status, message, details, and timing
   */
  public checkComponentHealth(name: string): Promise<HealthCheckResult> {
    return settleOperation(
      'checkComponentHealth',
      () => checkComponentHealthOperation(this.componentAccess, name),
      (error, _reason, code) => crashedHealthCheckResult(name, error, code),
    );
  }

  /**
   * Check the health of all running components
   *
   * Runs health checks on all running components in parallel.
   * Overall health is true only if ALL components are healthy.
   *
   * @returns Aggregate health report with individual component results
   */
  public checkAllHealth(): Promise<HealthReport> {
    return settleOperation(
      'checkAllHealth',
      () => checkAllHealthOperation(this.componentAccess),
      (error, _reason, code) => crashedHealthReport(error, code),
    );
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
    return this.getValueSettled<T>(componentName, key, null, options);
  }

  /**
   * The manager members its subsystems still call on it (see `ManagerInternals`),
   * forwarded at call time like the access context's callbacks, so a patched or
   * overridden member is the one that runs.
   */
  private static createManagerInternals(
    manager: LifecycleManager,
  ): ManagerInternals {
    return {
      sendMessageSettled: (name, payload, from, options) =>
        manager.sendMessageSettled(name, payload, from, options),
      broadcastMessageSettled: (payload, from, options) =>
        manager.broadcastMessageSettled(payload, from, options),
      getValueSettled: <T = unknown>(
        name: string,
        key: string,
        from: string | null,
        options?: GetValueOptions,
      ) => manager.getValueSettled<T>(name, key, from, options),
      updateStartedFlag: () => manager.updateStartedFlag(),
      stampTimestamp: (name, field) => manager.stampTimestamp(name, field),
      isComponentUp: (name) => manager.isComponentUp(name),
    };
  }

  /**
   * These modules can inspect live state and dispatch hooks, but cannot own lifecycle
   * transitions. Keep the view live: publication replaces the registry array, and
   * callbacks can change availability between a selection and its dispatch. Forward
   * methods at call time too, preserving subclass overrides and diagnostic seams.
   * The view is created once; no registry copy or adapter is allocated per request.
   */
  private static createComponentAccessContext(
    manager: LifecycleManager,
  ): ComponentAccessContext {
    return {
      get components() {
        return manager.state.components;
      },
      get componentStates() {
        return manager.state.componentStates;
      },
      get stalledComponents() {
        return manager.state.stalledComponents;
      },
      get isStarting() {
        return manager.state.isStarting;
      },
      get messageTimeoutMS() {
        return manager.config.messageTimeoutMS;
      },
      get logger() {
        return manager.logger;
      },
      get lifecycleEvents() {
        return manager.lifecycleEvents;
      },
      nameOf: (component) => manager.core.registry.nameOf(component),
      isComponentRunning: (name) => manager.isComponentRunning(name),
      getComponent: (name) => manager.core.registry.getComponent(name),
      isRawStartPending: (name) =>
        manager.core.componentStart.isRawStartPending(name),
      // A late start's cleanup marks its component running only to stop it: messaging,
      // value reads, health checks, signals and shutdown warnings must not enter it as
      // if it were up.
      isLateStartCleanupPending: (name) =>
        manager.state.pendingBulkStartupCleanup.has(name),
      sendMessageSettled: (name, payload, from, options) =>
        manager.sendMessageSettled(name, payload, from, options),
      checkComponentHealth: (name) => manager.checkComponentHealth(name),
      observeFailureAfterTimeout: (promise, name, message, params) =>
        observeFailureAfterTimeout(
          manager.logger,
          promise,
          name,
          message,
          params,
        ),
    };
  }

  private sendMessageInternal(
    componentName: string,
    payload: unknown,
    from: string | null,
    options?: SendMessageOptions,
  ): Promise<MessageResult> {
    return sendMessageInternal(
      this.componentAccess,
      componentName,
      payload,
      from,
      options,
    );
  }

  private broadcastMessageInternal(
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    return broadcastMessageInternal(
      this.componentAccess,
      payload,
      from,
      options,
    );
  }

  private getValueInternal<T = unknown>(
    componentName: string,
    key: string,
    from: string | null,
    options?: GetValueOptions,
  ): ValueResult<T> {
    return getValueInternal<T>(
      this.componentAccess,
      componentName,
      key,
      from,
      options,
    );
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /**
   * `getValueInternal()` under a synchronous version of the public-method safety net
   * (see {@link settleOperation}): `getValue()` answers synchronously, so it gets a
   * `try`/`catch` rather than a settled promise, but the same promise - an unexpected
   * failure comes back as `code: 'operation_crashed'` with the original on `error`, and is reported
   * on the global `'error'` channel. Shared by `getValue()` and the component-scoped
   * `ComponentLifecycle.getValue()`.
   */
  private getValueSettled<T = unknown>(
    componentName: string,
    key: string,
    from: string | null,
    options?: GetValueOptions,
  ): ValueResult<T> {
    try {
      return this.getValueInternal<T>(componentName, key, from, options);
    } catch (error) {
      reportCallbackError('lifecycle-manager getValue', error);

      return {
        found: false,
        value: undefined,
        componentFound: this.core.registry.isNameRegistered(componentName),
        componentRunning: this.state.runningComponents.has(componentName),
        handlerImplemented: false,
        requestedBy: from,
        code: 'operation_crashed',
        error: toError(error),
      };
    }
  }

  /**
   * `sendMessageInternal()` under the public-method safety net (see
   * {@link settleOperation}). Shared by `sendMessageToComponent()` and the
   * component-scoped `ComponentLifecycle.sendMessageToComponent()`, so a message sent
   * from inside a component resolves the same way one sent from outside does.
   */
  private sendMessageSettled(
    componentName: string,
    payload: unknown,
    from: string | null,
    options?: SendMessageOptions,
  ): Promise<MessageResult> {
    return settleOperation(
      'sendMessageToComponent',
      () => this.sendMessageInternal(componentName, payload, from, options),
      (error, _reason, code) => ({
        sent: false,
        componentFound: this.core.registry.isNameRegistered(componentName),
        componentRunning: this.state.runningComponents.has(componentName),
        handlerImplemented: false,
        data: undefined,
        error,
        timedOut: false,
        code,
      }),
    );
  }

  /**
   * `broadcastMessageInternal()` under the public-method safety net, shared the same way
   * as {@link sendMessageSettled}. The broadcast loop keeps the answers it collected when
   * it crashes partway. Invalid options - a bad timeout budget or a non-array
   * `componentNames` - refuse the whole broadcast with `[]` before announcing it, with a
   * warning rather than a callback-error report. Unexpected
   * failures before dispatch also answer `[]`, but remain reported on the global channel.
   */
  private broadcastMessageSettled(
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    return settleOperation(
      'broadcastMessage',
      () => this.broadcastMessageInternal(payload, from, options),
      (error, _reason, code) => {
        // The array contract has no aggregate error field. Keep its refusal shape,
        // but make invalid options (a bad timeout budget, a non-array `componentNames`)
        // visible through the configured logger instead of silently looking like an
        // empty recipient list. This is not a callback
        // crash and must not enter the global callback-error channel.
        if (code === 'invalid_options') {
          this.logger.warn('Broadcast refused: {{error.message}}', {
            params: { error },
          });
        }
        return [];
      },
    );
  }

  private updateStartedFlag(): void {
    this.state.isStarted =
      this.state.runningComponents.size > 0 ||
      this.state.stalledComponents.size > 0;
  }

  /**
   * Whether a component is up: running, and not on its way down. A stopping component
   * stays in `runningComponents` until its stop settles. A dependent must not start on
   * one - that stop already checked for running dependents, so the dependent ran on a
   * stopped dependency - and a health check must not call into one mid-stop.
   */
  private isComponentUp(name: string): boolean {
    const state = this.state.componentStates.get(name);

    return (
      this.state.runningComponents.has(name) &&
      state !== 'stopping' &&
      state !== 'force-stopping'
    );
  }

  // ============================================================================
  // Private Helper Methods
  // ============================================================================

  /** Record now as `field`, keeping the other timestamp from the component's last run. */
  private stampTimestamp(name: string, field: 'startedAt' | 'stoppedAt'): void {
    const timestamps = this.state.componentTimestamps.get(name) ?? {
      startedAt: null,
      stoppedAt: null,
    };
    timestamps[field] = Date.now();
    this.state.componentTimestamps.set(name, timestamps);
  }

  /** Safe delivery also contains an overridden emitter that throws. */
  private deliverEvent<K extends LifecycleManagerEventName>(
    event: K,
    data: LifecycleManagerEventMap[K],
  ): void {
    try {
      this.emit(event, data);
    } catch (error) {
      const err = toError(error);

      this.logger.error('Event handler error: {{error.message}}', {
        params: { event, error: err },
      });
    }
  }
}
