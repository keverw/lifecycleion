import { ComponentMetadataReader } from './internal/component-metadata-reader';
import { TransitionEventDispatcher } from './internal/transition-event-dispatcher';
import { RegistrationReadTracker } from './internal/registration-read-tracker';
import {
  LifecycleManagerState,
  isStartUnfinished,
  type StartSettlement,
} from './internal/manager-state';
import {
  type ManagerConfig,
  resolveManagerConfig,
} from './internal/manager-config';
import { ManagerCore, type ManagerInternals } from './internal/manager-core';
import type { ComponentAccessContext } from './internal/component-access-context';
import type { RestartStartSnapshot } from './internal/component-start';
import type { IndividualStopContext } from './internal/component-stop';
import {
  sendMessageInternal,
  broadcastMessageInternal,
  getValueInternal,
} from './internal/component-messaging';
import {
  checkComponentHealthOperation,
  checkAllHealthOperation,
  runSignalBroadcast,
} from './internal/component-inspection';
import {
  type DependencyRead,
  dependenciesOf,
  tryReadDependencies,
  findAllCircularCycles,
} from './internal/dependency-policy';
import {
  resolveOperationTimeoutMS,
  toOperationTimerDelayMS,
  settleOperation,
  refusedShutdownResult,
  crashedStartupResult,
  crashedShutdownResult,
  crashedSignalBroadcastResult,
  failedSignalCallbackResult,
  crashedHealthCheckResult,
  crashedHealthReport,
  crashedComponentResult,
  refusedStartupResult,
  invalidOperationOptionError,
  observeFailureAfterTimeout,
  toOperationFlag,
} from './internal/operation-policy';
import {
  snapshotRegisterOptions,
  snapshotRestartAllOptions,
  snapshotRestartComponentOptions,
  snapshotStartOptions,
  snapshotStartupOptions,
  snapshotStopAllOptions,
  snapshotUnregisterOptions,
  type StartupOptionsSnapshot,
  type StopOptionsSnapshot,
} from './internal/operation-options';
import {
  type RegistrationProgress,
  newRegistrationProgress,
  positionHasTarget,
  defaultTargetFound,
  reportedComponentName,
  committedRegistrationReport,
  isInsertPosition,
  isManualPositionRespected,
  removedTimeoutHooksReason,
} from './internal/registration-policy';
import { EventEmitterProtected } from '../event-emitter';
import { ulid } from 'ulid';
import type { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import type { BaseComponent } from './base-component';
import { ComponentLifecycle } from './component-lifecycle';
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
  RegistrationFailureCode,
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
  LifecycleInternalCallbacks,
} from './types';
import {
  LifecycleManagerEvents,
  type LifecycleManagerEventMap,
  type LifecycleManagerEventName,
} from './events';
import { DependencyCycleError } from './errors';
import {
  LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP,
  LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE,
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE_EXTERNAL,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
} from './constants';
import {
  ProcessSignalManager,
  type ShutdownSignal,
} from '../process-signal-manager';
import {
  reportCallbackError,
  safeHandleCallbackAndWait,
} from '../safe-handle-callback';
import { createGuardedLoggerService } from './guarded-logger';
import { describeError, toError } from '../to-error';

/** Everything restart preparation reads from the caller, validated before any stop. */
interface RestartPreparation {
  readonly startupOptions: StartupOptionsSnapshot;
  readonly shutdownTimeoutMS: number;
  readonly restartSnapshots: Map<string, RestartStartSnapshot>;
  /** The stop budgets validated so far, per component: see `restartStopNeed()`. */
  readonly validatedStops: Map<string, RestartStopNeed>;
}

/**
 * What a restart's stop phase will call for one component: `stop` - its `stop()` and
 * force handler - for a running one or a start in flight, `force` - the force handler
 * alone - for a stalled one it retries.
 */
type RestartStopNeed = 'stop' | 'force';

/**
 * Thrown by `readRestartInput()` when a caller read began a shutdown: it unwinds the
 * rest of restart preparation to the one catch in `restartAllComponentsOperation()`,
 * which answers with `result`. Thrown rather than returned, so a newly added read
 * cannot forget the check and let validation run under that shutdown. Never escapes
 * that catch; any other throw - a getter's own, a rejected budget - passes through it.
 */
class RestartPreparationRefusal extends Error {
  readonly #result: RestartResult;

  constructor(result: RestartResult) {
    super('Restart refused during preparation');
    this.#result = result;
  }

  /**
   * The refusal `error` carries, or rethrow an unrelated failure for the public net.
   * A private brand check, not `instanceof`:
   * that walks the thrown value's prototype chain, and a getter's own throw - a proxy
   * with a `getPrototypeOf` trap - would run caller code there that can replace it.
   */
  public static resultOrRethrow(error: unknown): RestartResult {
    if (typeof error === 'object' && error !== null && #result in error) {
      return error.#result;
    }
    throw error;
  }
}

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
    (component) => this.nameOf(component),
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
    const result = await this.registerComponentSettled(
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
    return await this.registerComponentSettled(
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
      wasRegistered: this.isNameRegistered(name),
    };

    return settleOperation(
      'unregisterComponent',
      () => this.unregisterComponentOperation(name, options, progress),
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
    return this.isNameRegistered(name);
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
    return this.state.components.map((c) => this.nameOf(c));
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
    return this.getComponent(name);
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
    return this.isNameRegistered(name) ? this.statusOf(name) : undefined;
  }

  /**
   * Get statuses for all components
   */
  public getAllComponentStatuses(): ComponentStatus[] {
    // One walk: each entry is already in hand, so it is not looked up by name again.
    return this.state.components.map((component) =>
      this.statusOf(this.nameOf(component)),
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
      const name = this.nameOf(component);
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
      const { reads, isSettled } = this.readRegistry((component) =>
        this.componentMetadata.readDependenciesReported(component, 'ordering'),
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
    const { reads } = this.readRegistry((component) => ({
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
      const name = this.nameOf(component);
      // A registry the reads kept changing can leave a component with a list read for a
      // registration that has since been replaced, or with none at all. Only that
      // component is reported as unread: one holding its current registration's answer
      // is part of an exact snapshot of the live registry, since nothing runs between
      // the last read and this answer.
      const isUnread = !this.isReadCurrent(reads, component);
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
      () => this.restartAllComponentsOperation(options, phases),
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
      () => this.restartComponentOperation(name, options),
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
    return this.withTransition(() => {
      // A new attach supersedes a detach that was still waiting to run.
      this.state.isSignalDetachDeferred = false;

      // Check if already attached (not just if instance exists)
      if (this.state.processSignalManager?.getStatus().isAttached) {
        return; // Already attached
      }

      // Create instance if it doesn't exist
      if (!this.state.processSignalManager) {
        this.state.processSignalManager = new ProcessSignalManager({
          onShutdownRequested: (method: ShutdownSignal) => {
            this.core.shutdownEscalation.handleShutdownRequest(method);
          },
          // Note: Signal-triggered handlers are fire-and-forget by design.
          // Node.js signal handlers (process.on) cannot return values, so these
          // async handlers execute but their return values are not accessible.
          // Use triggerReload(), triggerInfo(), triggerDebug() for programmatic
          // access to results.
          // Settled like `triggerReload()` and friends, so a signal-driven broadcast
          // resolves under this manager's own label rather than relying on
          // `ProcessSignalManager` to catch its rejection.
          onReloadRequested: () =>
            settleOperation(
              'reload signal',
              () => this.handleReloadRequest('signal'),
              (error, _reason, code) =>
                crashedSignalBroadcastResult('reload', error, code),
            ),
          onInfoRequested: () =>
            settleOperation(
              'info signal',
              () => this.handleInfoRequest('signal'),
              (error, _reason, code) =>
                crashedSignalBroadcastResult('info', error, code),
            ),
          onDebugRequested: () =>
            settleOperation(
              'debug signal',
              () => this.handleDebugRequest('signal'),
              (error, _reason, code) =>
                crashedSignalBroadcastResult('debug', error, code),
            ),
        });
      }

      this.state.processSignalManager.attach();
      this.lifecycleEvents.lifecycleManagerSignalsAttached();
    });
  }

  /**
   * Detach signal handlers.
   * Idempotent - calling multiple times has no effect.
   */
  public detachSignals(): void {
    return this.withTransition(() => {
      if (!this.state.processSignalManager?.getStatus().isAttached) {
        return; // Not attached
      }

      const signalManager = this.state.processSignalManager;
      try {
        signalManager.detach();
      } finally {
        // detach() marks itself detached even when a listener removal throws, so
        // announce it whenever the handlers are no longer attached.
        if (!signalManager.getStatus().isAttached) {
          this.lifecycleEvents.lifecycleManagerSignalsDetached();
        }
      }
    });
  }

  /**
   * Get status information about signal handling.
   */
  public getSignalStatus(): LifecycleSignalStatus {
    if (!this.state.processSignalManager) {
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
        shutdownMethod: this.state.shutdownMethod,
      };
    }

    return {
      ...this.state.processSignalManager.getStatus(),
      shutdownMethod: this.state.shutdownMethod,
    };
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
      () => this.handleReloadRequest(),
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
      () => this.handleInfoRequest(),
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
      () => this.handleDebugRequest(),
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
      getComponent: (name) => manager.getComponent(name),
      nameOf: (component) => manager.nameOf(component),
      currentReadOf: (component, snapshot, preferred) =>
        manager.currentReadOf(component, snapshot, preferred),
      statusOf: (name) => manager.statusOf(name),
      updateStartedFlag: () => manager.updateStartedFlag(),
      stampTimestamp: (name, field) => manager.stampTimestamp(name, field),
      detachSignalsAfterLastStop: () => manager.detachSignalsAfterLastStop(),
      isComponentUp: (name) => manager.isComponentUp(name),
      refuseStaleRestartSnapshot: (name, snapshot) =>
        manager.refuseStaleRestartSnapshot(name, snapshot),
      autoAttachSignals: (trigger) => manager.autoAttachSignals(trigger),
      rollBackStartForSignalAttach: (name, error) =>
        manager.rollBackStartForSignalAttach(name, error),
      detachSignalsIfIdle: (trigger, options) =>
        manager.detachSignalsIfIdle(trigger, options),
      runDeferredSignalDetach: (trigger) =>
        manager.runDeferredSignalDetach(trigger),
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
      nameOf: (component) => manager.nameOf(component),
      isComponentRunning: (name) => manager.isComponentRunning(name),
      getComponent: (name) => manager.getComponent(name),
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
        componentFound: this.isNameRegistered(componentName),
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
        componentFound: this.isNameRegistered(componentName),
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

  /**
   * Create retained callbacks in their own activation. Creating these inside the
   * registration transaction retains its rollback closures and registry snapshots
   * on engines that share the lexical environment, making retained memory quadratic.
   * Components need only the manager, never the transaction that registered them.
   */
  private createLifecycleInternalCallbacks(
    component: BaseComponent,
  ): LifecycleInternalCallbacks {
    return {
      sendMessageInternal: (
        compName: string,
        payload: unknown,
        from: string | null,
        options?: SendMessageOptions,
      ) => this.sendMessageSettled(compName, payload, from, options),
      broadcastMessageInternal: (
        payload: unknown,
        from: string | null,
        opts?: BroadcastOptions,
      ) => this.broadcastMessageSettled(payload, from, opts),
      getValueInternal: <T = unknown>(
        compName: string,
        key: string,
        from: string | null,
        options?: GetValueOptions,
      ) => this.getValueSettled<T>(compName, key, from, options),
      stopAllComponentsInternal: (options?: StopAllOptions) =>
        this.requestedBy(component, () => this.stopAllComponents(options)),
      restartAllComponentsInternal: (options?: RestartAllOptions) =>
        this.requestedBy(component, () => this.restartAllComponents(options)),
    };
  }

  /**
   * A bulk stop or restart requested through a component's own `lifecycle` handle. Its
   * unfinished start is the requester, exactly as a synchronous request from inside
   * `start()` is: the pass does not join a start that may be awaiting it. Unlike the
   * synchronous check, this still holds once the hook has yielded, which no
   * runtime-neutral check of the caller can recognise.
   */
  private requestedBy<T>(
    component: BaseComponent,
    request: () => Promise<T>,
  ): Promise<T> {
    const requesting: StartSettlement[] = [];
    for (const [claim, settlement] of this.state.startSettlements) {
      // An attempt records its instance only once its `component:starting` listeners
      // have run; from its claim on, the name's registered instance is the one it starts.
      const startingComponent =
        settlement.component ??
        (this.state.componentClaims.get(settlement.name)?.claim === claim
          ? this.getComponent(settlement.name)
          : undefined);
      if (
        startingComponent === component &&
        isStartUnfinished(settlement) &&
        !this.state.invokingStarts.has(settlement)
      ) {
        requesting.push(settlement);
        this.state.invokingStarts.add(settlement);
      }
    }
    try {
      // The pass captures its requesters synchronously, before its first await.
      return request();
    } finally {
      for (const settlement of requesting) {
        this.state.invokingStarts.delete(settlement);
      }
    }
  }

  /**
   * `registerComponentInternal()` under the public-method safety net (see
   * {@link settleOperation}). Its own `catch` covers the registration body, but the name
   * and index reads ahead of it run the component's own getters.
   */
  private registerComponentSettled(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName: string | undefined,
    isInsertAction: boolean,
    options?: RegisterOptions,
  ): Promise<InsertComponentAtResult> {
    // Shared with the registration, so this net answers `registered` and the auto-start
    // fields as it would.
    const progress = newRegistrationProgress();

    return settleOperation(
      isInsertAction ? 'insertComponentAt' : 'registerComponent',
      () =>
        this.registerComponentInternal(
          component,
          position,
          targetComponentName,
          isInsertAction,
          options,
          progress,
        ),
      // Reached only for what fails before the registration's own `try` - in practice a
      // `getName()` that threw or answered a non-string: every later failure is answered
      // inside the registration by the same method, which cannot throw. Named from what `getName()` answered, never by asking again.
      (error, reason) =>
        this.answerRegistrationFailure({
          component,
          componentName: reportedComponentName(progress),
          error,
          // `settleOperation` has reported it.
          isErrorReported: true,
          reason,
          position,
          targetComponentName,
          isInsertAction,
          // Unknown: there is no name to look it up by.
          registrationIndexBefore: null,
          progress,
        }),
    );
  }

  private async unregisterComponentOperation(
    name: string,
    options: UnregisterOptions | undefined,
    progress: { wasStopped: boolean },
  ): Promise<UnregisterComponentResult> {
    // Block unregistration during bulk operations
    if (this.isBulkOperationBlockingUnregister(name)) {
      return this.refuseUnregisterForBulkOperation(
        name,
        false,
        this.isNameRegistered(name),
      );
    }

    const component = this.getComponent(name);

    if (!component) {
      this.logger
        .entity(name)
        .warn(LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND);
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
        code: 'component_not_found',
        wasStopped: false,
        wasRegistered: false,
      };
    }

    // `component` is captured before any caller code runs, and every step below acts on
    // the name. Option getters and the stop's `await` all run caller code that can
    // unregister this component and register a replacement under the same name, so
    // ownership is checked again after each, before anything acts on the name: the
    // in-flight and running checks would answer for the replacement, `stopComponent()`
    // would stop it, and removal - by instance from the registry, but by name from every
    // state map - would wipe its state while leaving it registered, and report success
    // for a removal it never made.
    //
    // By registration, not only by instance: the same instance unregistered and
    // registered again across the stop's `await` is a new registration - with its own
    // auto-start policy, state and owner - and removing it reported success for a
    // removal this call was never asked to make.
    const registrationGeneration =
      this.registrationReads.currentGeneration(component);
    const refuseIfReplaced = (): UnregisterComponentResult | undefined => {
      if (
        this.getComponent(name) === component &&
        this.registrationReads.currentGeneration(component) ===
          registrationGeneration
      ) {
        return undefined;
      }

      return {
        success: false,
        componentName: name,
        reason: progress.wasStopped
          ? 'Component was unregistered while it was being stopped'
          : 'Component was unregistered while this unregister was in progress',
        code: 'component_not_found',
        wasStopped: progress.wasStopped,
        // Registered when this call started, which is what this field reports - the
        // name may belong to a replacement by now, which is not this call's component.
        wasRegistered: true,
      };
    };

    // Both options, read once, here (`stopIfRunning` defaults to true). Their getters
    // are caller code, so the replacement check follows.
    const unregisterOptions = snapshotUnregisterOptions(options);
    const shouldStopIfRunning = unregisterOptions.stopIfRunning;

    const replacedAfterOptions = refuseIfReplaced();

    if (replacedAfterOptions !== undefined) {
      return replacedAfterOptions;
    }

    const inFlightRefusal = this.refuseUnregisterWhileInFlight(name, false);

    if (inFlightRefusal !== null) {
      return inFlightRefusal;
    }

    const isStalled = this.state.stalledComponents.has(name);

    if (isStalled && shouldStopIfRunning) {
      this.logger
        .entity(name)
        .warn('Cannot unregister stalled component when stopIfRunning is set');
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
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
    if (isRunning && shouldStopIfRunning) {
      this.logger.entity(name).info('Stopping component before unregistering');

      const replacedBeforeStop = refuseIfReplaced();

      if (replacedBeforeStop !== undefined) {
        return replacedBeforeStop;
      }

      // The log line above ran caller code, which may have begun a stop or a bulk
      // operation of its own. Answer for that one, rather than reporting the refusal it
      // causes below as this unregister's failed stop.
      const inFlightBeforeStop = this.refuseUnregisterWhileInFlight(
        name,
        false,
      );

      if (inFlightBeforeStop !== null) {
        return inFlightBeforeStop;
      }

      if (this.isBulkOperationBlockingUnregister(name)) {
        return this.refuseUnregisterForBulkOperation(name, false, true);
      }

      const stopResult = await this.stopComponent(name, {
        allowStopWithRunningDependents: unregisterOptions.forceStop,
      });

      // Before reading any state by name: the stop's `await` ran caller code, and a
      // replacement registered under the name would answer for this component - a
      // stopped replacement made a failed stop report `wasStopped: true`. Only the
      // stop's own answer is about this component then.
      progress.wasStopped = stopResult.success;
      const replacedDuringStop = refuseIfReplaced();

      if (replacedDuringStop !== undefined) {
        return replacedDuringStop;
      }

      // If stop fails and leaves the component stalled, do NOT unregister.
      // Caller expectation: success with stopIfRunning implies the component is stopped and unregistered.
      const stateAfterStopAttempt = this.state.componentStates.get(name);
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

        // A stop refused for its own configuration never ran: the unregister's own
        // `invalid_options`, not a failed stop.
        if (stopResult.code === 'invalid_options') {
          return {
            success: false,
            componentName: name,
            reason: stopResult.reason ?? 'Failed to stop component',
            code: 'invalid_options',
            error: stopResult.error,
            wasStopped: false,
            wasRegistered: true,
          };
        }

        return {
          success: false,
          componentName: name,
          reason: stopResult.reason ?? 'Failed to stop component',
          code: 'stop_failed',
          stopFailureReason:
            stopResult.code === 'component_shutdown_timeout'
              ? 'timeout'
              : stopResult.code === 'operation_crashed'
                ? 'operation_crashed'
                : 'error',
          error: stopResult.error,
          wasStopped: false,
          wasRegistered: true,
        };
      }

      progress.wasStopped = true;
    }

    // After the stop's `await` - a `component:stopped` listener can do the same - and
    // before the post-stop checks below, which would otherwise answer for a replacement.
    const replacedAfterStop = refuseIfReplaced();

    if (replacedAfterStop !== undefined) {
      return replacedAfterStop;
    }

    if (progress.wasStopped) {
      // A `component:stopped` listener may also have started it again, or begun another
      // stop. Removing it now would orphan that operation: a start that finished on an
      // unregistered component left whatever it brought up running, owned by nothing.
      const inFlightAfterStop = this.refuseUnregisterWhileInFlight(name, true);

      if (inFlightAfterStop !== null) {
        return inFlightAfterStop;
      }

      // Or started it again and it is already up: a start that settles within the
      // same turn is past `starting` by now.
      if (this.isComponentRunning(name)) {
        this.logger
          .entity(name)
          .warn('Component was started again while it was being stopped');

        return {
          success: false,
          componentName: name,
          reason: 'Component was started again while it was being stopped',
          code: 'component_running',
          wasStopped: true,
          wasRegistered: true,
        };
      }
    }

    // Checked again here rather than only at the top: a bulk startup or shutdown that
    // began while this component was stopping - or inside that same option getter - now
    // owns the registry, and removing a component from under it is what the guard at the
    // top exists to prevent. The component stays registered, in whatever state it
    // reached: stopped on the stop path, untouched on the one that had nothing to stop.
    if (this.isBulkOperationBlockingUnregister(name)) {
      return this.refuseUnregisterForBulkOperation(
        name,
        progress.wasStopped,
        true,
      );
    }

    return this.withTransition(() => {
      // Remove from registry
      this.state.componentEntries = this.state.componentEntries.filter(
        (c) => c !== component,
      );

      this.publishRegistry();

      // Clean up state - the manager's own maps first, all of them, so the component is
      // either fully registered or fully gone. The component's hooks run after, contained:
      // they can be overridden, and one that threw used to leave the component out of the
      // registry but still in every state map.
      // A removed registration must not survive as deferred work in a restart
      // handoff. A later registration of the name decides its own auto-start policy.
      // `deferredAutoStartNames` needs no such step: it holds names only while a
      // startup holds the latch, and the bulk-operation check above refuses then.
      for (const pending of this.state.pendingRestartAutoStarts) {
        pending.delete(name);
      }
      this.state.componentStates.delete(name);
      this.state.componentTimestamps.delete(name);
      this.state.componentErrors.delete(name);
      this.state.componentUnexpectedStopHadError.delete(name);
      this.state.componentStartAttemptTokens.delete(name);
      this.state.lateStartCleanupOutcomes.delete(name);
      this.state.componentStopAttemptTokens.delete(name);
      this.state.stalledStopEarlierTokens.delete(name);
      this.state.pendingForceStopWaiters.delete(name);
      // A later registration of the same instance reports a broken list afresh.
      this.componentMetadata.clearReports(component);
      this.state.stalledComponents.delete(name);
      this.state.runningComponents.delete(name);
      this.state.componentClaims.delete(name);
      this.core.componentStart.releaseStartSettlements(name);
      // `registeredNames` keeps this entry: work still in flight - a broadcast that
      // captured the instance, a late-stop monitor - can still name it without asking the
      // component. A later registration of the same instance reads its name fresh and
      // overwrites the entry when it commits.
      this.updateStartedFlag();

      this.core.unexpectedStops.clearUnexpectedStopHandler(
        component,
        'unregister',
      );

      this.markComponentUnregistered(component, 'lifecycle-manager unregister');

      this.detachSignalsAfterLastStop(
        'last component unregistered',
        'Auto-detached process signals on last component unregistered',
      );

      this.logger.entity(name).info('Component unregistered');
      this.lifecycleEvents.componentUnregistered(name, false);

      return {
        success: true,
        componentName: name,
        wasStopped: progress.wasStopped,
        wasRegistered: true,
      };
    });
  }

  /**
   * Refuse an unregister while a start or stop is in flight for the component, or `null`
   * when none is. The operation writes its outcome by name when it settles: a start
   * marked an unregistered component running - a ghost no shutdown would stop, which
   * blocked a replacement under the same name - and a force retry marked a replacement
   * stalled or stopped. A graceful stop is refused the same way rather than being
   * stopped a second time, which only failed as `stop_failed`.
   */
  private refuseUnregisterWhileInFlight(
    name: string,
    wasStopped: boolean,
  ): UnregisterComponentResult | null {
    const component = this.getComponent(name);
    const hasUnfinishedStart = (): boolean => {
      for (const settlement of this.state.startSettlementsByName.get(name) ??
        []) {
        if (
          settlement.component === component &&
          this.state.componentStartAttemptTokens.get(name) ===
            settlement.token &&
          ((settlement.didFailRawStartObservation === true &&
            isStartUnfinished(settlement)) ||
            (!settlement.rawStartPending &&
              settlement.isAwaitingLateStart === true))
        ) {
          return true;
        }
      }
      return false;
    };
    const isStarting =
      this.state.componentStates.get(name) === 'starting' ||
      hasUnfinishedStart();
    if (!this.core.claims.isInFlight(name) && !isStarting) {
      return null;
    }

    const reason = isStarting
      ? 'Component is starting. Wait for the start to settle before unregistering'
      : 'Component is stopping. Wait for the stop to settle before unregistering';

    this.logger.entity(name).warn(reason);

    return {
      success: false,
      componentName: name,
      reason,
      code: isStarting ? 'component_starting' : 'component_stopping',
      wasStopped,
      wasRegistered: true,
    };
  }

  /**
   * Whether a bulk operation owns the registry, so a component must not be removed from
   * under it: a startup or shutdown latch, or a late-startup cleanup for this component.
   */
  private isBulkOperationBlockingUnregister(name: string): boolean {
    return (
      this.state.isStarting ||
      this.core.shutdownPass.isShuttingDown ||
      this.state.pendingBulkStartupCleanup.has(name)
    );
  }

  private refuseUnregisterForBulkOperation(
    name: string,
    wasStopped: boolean,
    wasRegistered: boolean,
  ): UnregisterComponentResult {
    this.logger
      .entity(name)
      .warn(LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS, {
        params: {
          isStarting: this.state.isStarting,
          isShuttingDown: this.core.shutdownPass.isShuttingDown,
        },
      });

    return {
      success: false,
      componentName: name,
      reason: LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
      code: 'bulk_operation_in_progress',
      wasStopped,
      wasRegistered,
    };
  }

  /** A refused restart owns no stop pass and cannot cancel the active one. */
  private refuseRestartDuringActiveShutdown(): RestartResult | undefined {
    if (!this.core.shutdownPass.isShuttingDown) {
      return undefined;
    }

    return this.restartRefusedDuringShutdown(refusedShutdownResult());
  }

  /**
   * A restart that meets somebody else's bulk startup: refused before it stops anything,
   * as `startAllComponents()` refuses a second startup. Its stop phase would interrupt
   * that startup, and its own startup phase would then be refused while the interrupted
   * one unwound - leaving everything down.
   */
  private refuseRestartDuringActiveStartup(): RestartResult | undefined {
    if (!this.state.isStarting) {
      return undefined;
    }

    const reason = LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS;
    const result: RestartResult = {
      shutdownResult: refusedShutdownResult('partial_state', reason),
      startupResult: refusedStartupResult('already_in_progress', reason),
      success: false,
    };
    // Built before the sink runs, as the shutdown refusal is.
    this.logger.warn('Cannot restart all components during startup');
    return result;
  }

  /** Either active-operation refusal, the shutdown one first. */
  private refuseRestartDuringActiveBulkOperation(): RestartResult | undefined {
    return (
      this.refuseRestartDuringActiveShutdown() ??
      this.refuseRestartDuringActiveStartup()
    );
  }

  /** The refusal for a restart that met somebody else's shutdown, with its stop answer. */
  private restartRefusedDuringShutdown(
    shutdownResult: ShutdownResult,
  ): RestartResult {
    const result: RestartResult = {
      shutdownResult,
      startupResult: refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
      ),
      success: false,
    };
    // Capture the refusal before the sink runs: diagnostics must not acquire or
    // cancel the pass this restart was refused from, even when a sink re-enters.
    this.logger.warn('Cannot restart all components during shutdown');
    return result;
  }

  /**
   * One caller read during restart preparation - the options snapshot, or one component
   * getter - followed by the active-operation check it requires: the read can start a
   * shutdown or a startup, which must stop preparation before validation or the next
   * getter runs. Throws a {@link RestartPreparationRefusal} carrying the refusal when
   * one did.
   */
  private readRestartInput<V>(read: () => V): V {
    const value = read();
    const refusal = this.refuseRestartDuringActiveBulkOperation();
    if (refusal) {
      throw new RestartPreparationRefusal(refusal);
    }
    return value;
  }

  /**
   * Validate and snapshot both phases before stopping anything. Discovering an
   * invalid startup budget only after shutdown would leave a healthy application
   * down for a configuration typo. The snapshot also prevents a caller getter or
   * mutation during stop from swapping the value after validation.
   *
   * Every caller read goes through `readRestartInput()`: each is a re-entry boundary,
   * and a shutdown begun there must prevent both validation and the next getter from
   * running. The options are one read - every field, then one check - and each
   * component getter another.
   */
  private prepareRestart(
    options: RestartAllOptions | undefined,
  ): RestartPreparation {
    const restartOptions = this.readRestartInput(() =>
      snapshotRestartAllOptions(options),
    );
    const startupTimeoutMS = resolveOperationTimeoutMS(
      restartOptions.startupOptions.timeoutMS,
      this.config.startupTimeoutMS,
      'restartAllComponents startupOptions.timeoutMS',
    );
    const startupOptions = snapshotStartupOptions({
      ignoreStalledComponents:
        restartOptions.startupOptions.ignoreStalledComponents,
      timeoutMS: startupTimeoutMS,
    });
    const shutdownTimeoutMS = resolveOperationTimeoutMS(
      restartOptions.shutdownTimeoutMS,
      this.config.shutdownOptions.timeoutMS,
      'restartAllComponents shutdownTimeoutMS',
    );

    // A restart must discover an invalid component timeout while the existing
    // application is still running. Hold both the value and its registration:
    // shutdown hooks can mutate the property or replace an instance before startup.
    const restartSnapshots = new Map<string, RestartStartSnapshot>();
    const validatedStops = new Map<string, RestartStopNeed>();
    // Read once: no caller code runs between here and the loop, and the stop pass reads
    // the same set as it begins.
    const currentStarts = this.core.componentStart.currentStartSettlements();
    for (const component of [...this.state.components]) {
      const name = this.nameOf(component);
      const generation = this.registrationReads.currentGeneration(component);
      const componentTimeoutMS = this.readRestartInput(
        () => component.startupTimeoutMS,
      );
      const timeoutMS = toOperationTimerDelayMS(
        componentTimeoutMS,
        `${name}.startupTimeoutMS`,
      );
      const doesOwnLateStartCleanup = toOperationFlag(
        this.readRestartInput(() => component.ownsLateStartCleanup),
        `${name}.ownsLateStartCleanup`,
      );
      restartSnapshots.set(name, {
        component,
        generation,
        timeoutMS,
        ownsLateStartCleanup: doesOwnLateStartCleanup,
      });
      const stopNeed = this.restartStopNeed(name, currentStarts);
      if (stopNeed !== undefined) {
        this.validateRestartStopBudgets(name, component, stopNeed);
        validatedStops.set(name, stopNeed);
      }
    }
    // The getters above are caller code, and can start a component the loop had already
    // passed while it was idle.
    this.validateLateRestartStopBudgets(restartSnapshots, validatedStops);

    return {
      startupOptions,
      shutdownTimeoutMS,
      restartSnapshots,
      validatedStops,
    };
  }

  /**
   * What the restart's stop phase will call for `name` as things stand, if anything.
   *
   * `stop()` of a running component, and the force handler of a running or stalled one
   * (`retryStalled` is on for restart). A start still in flight counts as running: the
   * stop phase joins it and sends the component through the stop pipeline once `start()`
   * settles. One that already timed out does not - the pass reports it as
   * `cleanup_incomplete` instead of stopping it.
   */
  private restartStopNeed(
    name: string,
    currentStarts: ReadonlyMap<string, StartSettlement>,
  ): RestartStopNeed | undefined {
    const settlement = currentStarts.get(name);
    const isStartInFlight =
      (this.state.componentStates.get(name) === 'starting' ||
        settlement !== undefined) &&
      !this.core.shutdownPass.isUnresolvedTimedOutStart(settlement);
    if (this.state.runningComponents.has(name) || isStartInFlight) {
      return 'stop';
    }
    return this.state.stalledComponents.has(name) ? 'force' : undefined;
  }

  /**
   * The stop budgets the restart's stop phase will read for `component`, validated
   * before it stops anything - for the same reason as the startup budgets above. The
   * stop phase reads them per component as it reaches each one, so a typo on one stopped
   * late was found only after its dependents were already down; the halted pass then
   * skipped startup and left the application half down. Only validated, not
   * snapshotted: each stop still reads its own when it runs, as any stop does.
   *
   * Only for what that stop phase will call - see `restartStopNeed()`.
   */
  private validateRestartStopBudgets(
    name: string,
    component: BaseComponent,
    stopNeed: RestartStopNeed,
  ): void {
    if (stopNeed === 'stop') {
      toOperationTimerDelayMS(
        this.readRestartInput(() => component.shutdownGracefulTimeoutMS),
        `${name}.shutdownGracefulTimeoutMS`,
      );
    }

    const onShutdownForce: unknown = this.readRestartInput(() =>
      Reflect.get(component, 'onShutdownForce'),
    );
    if (typeof onShutdownForce === 'function') {
      toOperationTimerDelayMS(
        this.readRestartInput(() => component.shutdownForceTimeoutMS),
        `${name}.shutdownForceTimeoutMS`,
      );
    }
  }

  /**
   * Validate the stop budgets of every component the stop phase would now stop that
   * restart preparation has not validated for that yet. Caller code that runs after the
   * preparation loop passed a component - another component's getter, a sink of the
   * restart's own log - can start it while it was idle, or stall it; left unvalidated,
   * an invalid budget there halted the stop phase after the others were already down.
   *
   * Repeated until a pass finds nothing new, since the reads it makes are caller code
   * too; each pass validates more, so it ends. Only the registrations preparation
   * snapshotted: any other is refused before the stop phase as changed.
   */
  private validateLateRestartStopBudgets(
    restartSnapshots: ReadonlyMap<string, RestartStartSnapshot>,
    validatedStops: Map<string, RestartStopNeed>,
  ): void {
    for (;;) {
      let didValidate = false;
      // Read once per round, and again only after a validation: its timeout getters are
      // caller code, which can start or settle a start.
      let currentStarts = this.core.componentStart.currentStartSettlements();
      for (const component of [...this.state.components]) {
        const name = this.nameOf(component);
        if (restartSnapshots.get(name)?.component !== component) {
          continue;
        }
        const stopNeed = this.restartStopNeed(name, currentStarts);
        const validated = validatedStops.get(name);
        if (
          stopNeed === undefined ||
          validated === 'stop' ||
          validated === stopNeed
        ) {
          continue;
        }
        this.validateRestartStopBudgets(name, component, stopNeed);
        validatedStops.set(name, stopNeed);
        didValidate = true;
        currentStarts = this.core.componentStart.currentStartSettlements();
      }
      if (!didValidate) {
        return;
      }
    }
  }

  private async restartAllComponentsOperation(
    options: RestartAllOptions | undefined,
    phases: { shutdownResult?: ShutdownResult },
  ): Promise<RestartResult> {
    // A restart arriving during somebody else's shutdown has no stop pass to own, and
    // one arriving during a bulk startup would stop it partway. Refuse either before
    // reading options or component getters, without recording a request to stay down
    // against a running pass.
    const alreadyActive = this.refuseRestartDuringActiveBulkOperation();
    if (alreadyActive) {
      return alreadyActive;
    }

    let preparation: RestartPreparation;
    try {
      preparation = this.prepareRestart(options);
    } catch (error) {
      // Only the refusal is answered here. Anything else - a getter's own throw, a
      // rejected budget - still reaches `settleOperation()` to be classified.
      return RestartPreparationRefusal.resultOrRethrow(error);
    }
    const {
      startupOptions,
      shutdownTimeoutMS,
      restartSnapshots,
      validatedStops,
    } = preparation;

    const changedSnapshotName = (): string | undefined => {
      const [staleName] = this.staleRestartSnapshotNames(restartSnapshots);
      if (staleName !== undefined) {
        return staleName;
      }
      // A timeout getter or logger callback can also register a new component.
      // It has no approved startup timeout, so it cannot join this restart.
      for (const component of this.state.components) {
        const name = this.nameOf(component);
        if (!restartSnapshots.has(name)) {
          return name;
        }
      }
      return undefined;
    };

    // A lapsed escalation window is expired here, ahead of the checks below, rather
    // than by the stop phase's acceptance: expiring it logs through the caller's sinks,
    // and a sink there that registered or started a component would get past them.
    this.core.shutdownEscalation.normalizeRepeatedShutdownRequestStateArmedStatus();
    this.logger.info('Restarting all components');
    // Sinks are caller code too. A shutdown or startup begun by this log, or by the
    // expiry above, owns the registry; refuse before attempting either restart phase.
    const afterInfoLog = this.refuseRestartDuringActiveBulkOperation();
    if (afterInfoLog) {
      return afterInfoLog;
    }
    // A sink can also have started or stalled a component preparation found idle.
    // Ahead of the registration check below, which also covers these reads.
    try {
      this.validateLateRestartStopBudgets(restartSnapshots, validatedStops);
    } catch (error) {
      return RestartPreparationRefusal.resultOrRethrow(error);
    }
    // A refusal made before the stop phase: nothing was stopped, and no shutdown pass
    // is announced.
    const refuseBeforeStop = (
      reason: string,
      shutdownCode: 'partial_state' | 'cleanup_incomplete',
    ): RestartResult => {
      this.logger.warn('Restart refused before shutdown: {{reason}}', {
        params: { reason },
      });
      return {
        shutdownResult: refusedShutdownResult(shutdownCode, reason),
        startupResult: refusedStartupResult('partial_state', reason),
        success: false,
      };
    };
    // The info log above can itself change registration through a sink. Keep the
    // check after it.
    const changedBeforeStop = changedSnapshotName();
    if (changedBeforeStop !== undefined) {
      return refuseBeforeStop(
        `Component "${changedBeforeStop}" changed while restart was being prepared`,
        'partial_state',
      );
    }
    // A start that already timed out with its `start()` still unresolved is not waited
    // for by the stop phase, which then ends `cleanup_incomplete` and skips startup -
    // after stopping every component that start does not depend on, leaving the
    // application half down. Known now, so refused now, as an invalid stop budget is.
    // Nothing between here and the stop phase's acceptance runs caller code: that
    // acceptance leaves escalation expiry, which logs, to requests to stay down.
    const unresolvedStarts =
      this.core.shutdownPass.unresolvedTimedOutStartNames();
    if (unresolvedStarts.length > 0) {
      return refuseBeforeStop(
        `Abandoned start still unresolved for: ${unresolvedStarts.join(', ')}; restart refused before stopping anything, startup skipped`,
        'cleanup_incomplete',
      );
    }

    const pendingAutoStarts = new Set<string>();
    try {
      // Phase 1: Stop all components (explicit defaults for restart semantics)
      const stopPhase = this.core.shutdownPass.acceptShutdownPass(
        'manual',
        snapshotStopAllOptions({
          timeoutMS: shutdownTimeoutMS,
          // Always retry/halt during restart for deterministic shutdown behavior.
          retryStalled: true,
          haltOnStall: true,
          // Restart cannot safely bring up replacements while old starts remain.
          // Keep their dependencies protected even if shutdown hooks opt out.
          allowStopWithPendingStarts: false,
          // One rule for abandoned starts, whatever `shutdownOptions` says: one known
          // before the stop phase is refused up front, and one abandoned during it
          // ends the phase `cleanup_incomplete`. Waiting would only trade that for a
          // `shutdown_timeout` after stopping more components, startup skipped either way.
          waitForAbandonedStarts: false,
          // Not a request to stay down: the starts it would interrupt are ones this
          // restart waits for and then starts again. Cancelling them would only turn a
          // slow start into a failed one ahead of the same start, and a global setting
          // meant for signal or logger shutdowns must not reach a restart.
          abortPendingStarts: false,
        }),
        // Not a request to stay down: see `acceptShutdownPass()`.
        false,
        pendingAutoStarts,
      );

      // A refused stop phase is somebody else's pass - one a sink or callback began
      // while this one was being set up. Refuse as a restart arriving during that
      // shutdown does, without starting anything on top of it.
      if (!stopPhase.accepted) {
        phases.shutdownResult = stopPhase.result;
        return this.restartRefusedDuringShutdown(stopPhase.result);
      }

      const stayDownPassCountAtStopPhase = this.state.stayDownPassCount;
      const shutdownResult = await stopPhase.promise;

      phases.shutdownResult = shutdownResult;

      // Requests that land after the pass ends reach a later pass instead, and one made
      // during phase 2 aborts that startup on its own via `shutdownToken`.
      //
      // Or one that lands in the gap between the pass releasing its latch and this
      // restart resuming - a stop deferred out of `shutdown-completed` with
      // `queueMicrotask`, as the docs suggest for listeners, runs there. It starts a new
      // pass by then rather than being recorded on this one, but it asks the same thing.
      // Only a pass asking to stay down counts: another restart started in that gap is
      // not a request to stop this one.
      //
      // Two mechanisms, deliberately. The count is global, so it cannot say which pass a
      // refused request landed on: counted there too, a stop refused by a follow-up
      // restart's own stop phase would cancel this restart as well. The per-pass flag is
      // what attributes those; the count only covers passes accepted in the gap, when no
      // pass is running for a request to land on.
      const wasCanceledByShutdownRequest =
        stopPhase.pass.shutdownRequested ||
        this.state.stayDownPassCount !== stayDownPassCountAtStopPhase;

      // Phase 2: Start all components - unless something asked us to stay down while
      // phase 1 ran. Checked ahead of a stalled/failed stop phase: the request is the
      // stronger statement, and reporting it beats reporting whatever startup would
      // have refused for instead.
      if (wasCanceledByShutdownRequest) {
        const startupResult = refusedStartupResult(
          'shutdown_requested_during_restart',
          'Shutdown requested during the restart shutdown phase; startup skipped',
        );

        this.logger.warn('Restart canceled by shutdown request', {
          params: { shutdownSuccess: shutdownResult.success },
        });

        return {
          shutdownResult,
          startupResult,
          startupSkippedByShutdownRequest: true,
          success: false,
        };
      }

      // A deadline ended the wait, not the stop work. Starting again can merely
      // report old components as already running while their teardown is pending.
      // `timedOut` is set exactly when the code is `shutdown_timeout`.
      if (
        shutdownResult.code === 'shutdown_timeout' ||
        shutdownResult.code === 'cleanup_incomplete'
      ) {
        const reason =
          shutdownResult.code === 'cleanup_incomplete'
            ? 'Restart cleanup is incomplete; startup skipped'
            : 'Restart shutdown timed out; startup skipped';
        // Logged as the sibling refusals below are: this one answered silently, and a
        // restart that left the application down said nothing in the logs about why.
        this.logger.warn('Restart abandoned: {{reason}}', {
          params: { reason, shutdownReason: shutdownResult.reason },
        });

        return {
          shutdownResult,
          startupResult: refusedStartupResult('partial_state', reason),
          success: false,
        };
      }

      // A crashed stop or invalid stop configuration cannot confirm cleanup. Do not
      // initiate startup on top of components that this restart could not stop.
      if (
        shutdownResult.code === 'operation_crashed' ||
        shutdownResult.code === 'invalid_options'
      ) {
        const wasRefused = shutdownResult.code === 'invalid_options';
        this.logger.warn(
          wasRefused
            ? 'Restart abandoned: the shutdown phase refused invalid options'
            : 'Restart abandoned: the shutdown phase failed',
          { params: { reason: shutdownResult.reason } },
        );

        return {
          shutdownResult,
          startupResult: crashedStartupResult(
            shutdownResult.error,
            wasRefused
              ? 'Startup skipped: the restart shutdown phase refused invalid options'
              : 'Startup skipped: the restart shutdown phase failed unexpectedly',
            shutdownResult.code,
          ),
          success: false,
        };
      }

      // A stop phase that ended with components still up - a `haltOnStall` break, which
      // restart always sets, or a stop that failed and left its component running -
      // cannot be followed by a startup. That startup refused as `partial_state` anyway,
      // but listed the components the stop phase never restarted as started, while the
      // ones it had already stopped stayed down. Skipped and said so, as a timed-out
      // stop phase is. Read live: anything up now is equally something a startup would
      // refuse over.
      if (
        shutdownResult.code === 'partial_state' &&
        this.state.runningComponents.size > 0
      ) {
        const reason =
          'Restart shutdown phase left components running; startup skipped';
        this.logger.warn('Restart abandoned: {{reason}}', {
          params: { reason, shutdownReason: shutdownResult.reason },
        });

        return {
          shutdownResult,
          startupResult: refusedStartupResult('partial_state', reason),
          success: false,
        };
      }

      // A deferred shutdown listener can remove or replace a component after the
      // pass releases its latch. The startup still serves the current registry;
      // only the exact registrations approved before stop keep their timeout snapshots.
      // New and replaced registrations use ordinary startup validation. They did not
      // exist at preflight: invalid settings can fail this startup after shutdown,
      // and restart cannot restore the old registry or running application atomically.
      for (const name of this.staleRestartSnapshotNames(restartSnapshots)) {
        restartSnapshots.delete(name);
      }
      const startupResult = await settleOperation(
        'startAllComponents',
        () =>
          this.core.startup.startAllComponentsOperation(
            () => startupOptions,
            restartSnapshots,
          ),
        (error, reason, code) => crashedStartupResult(error, reason, code),
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
    } finally {
      // Remove only this restart before warning: a sink may begin a new restart.
      this.state.pendingRestartAutoStarts.delete(pendingAutoStarts);
      const abandoned = Array.from(pendingAutoStarts);
      pendingAutoStarts.clear();
      this.core.startup.warnAbandonedAutoStarts(
        abandoned,
        'restart abandoned before startup',
      );
    }
  }

  /**
   * A restart's stop: its options were read, and its dependents checked, by
   * `restartComponentOperation()`.
   */
  private async restartStopOperation(
    name: string,
    stopOptions: StopOptionsSnapshot,
    stopContext: IndividualStopContext,
  ): Promise<ComponentOperationResult> {
    const bulkRefusal =
      this.core.componentStop.checkIndividualBulkPreconditions(name, 'restart');
    if (bulkRefusal) {
      return bulkRefusal;
    }

    return await this.core.componentStop.stopComponentInternal(
      name,
      stopOptions,
      stopContext,
    );
  }

  /**
   * Whether a restart timeout still belongs to the same live registration. The
   * historical registeredNames cache deliberately survives unregister, so neither
   * that cache nor a generation alone can replace the live membership check.
   */
  private isCurrentRestartSnapshot(
    name: string,
    snapshot: RestartStartSnapshot,
    currentComponents?: ReadonlySet<BaseComponent>,
  ): boolean {
    return (
      (currentComponents === undefined
        ? this.getComponent(name) === snapshot.component
        : currentComponents.has(snapshot.component)) &&
      this.registrationReads.currentGeneration(snapshot.component) ===
        snapshot.generation
    );
  }

  /**
   * The names among a restart's snapshots whose registration is no longer the one
   * approved before the stop - unregistered, replaced, or registered again. No caller
   * code runs here, so registry membership is captured once rather than rescanned for
   * every snapshot.
   */
  private staleRestartSnapshotNames(
    snapshots: ReadonlyMap<string, RestartStartSnapshot>,
  ): string[] {
    const currentComponents = new Set(this.state.components);
    const stale: string[] = [];
    for (const [name, snapshot] of snapshots) {
      if (!this.isCurrentRestartSnapshot(name, snapshot, currentComponents)) {
        stale.push(name);
      }
    }
    return stale;
  }

  /**
   * A restart's start of `name` refused because its registration changed since the
   * restart approved it - checked by the start both before and after the reads that run
   * the component's code. `undefined` for an ordinary start, which has no snapshot.
   */
  private refuseStaleRestartSnapshot(
    name: string,
    snapshot: RestartStartSnapshot | undefined,
  ): ComponentOperationResult | undefined {
    if (
      snapshot === undefined ||
      this.isCurrentRestartSnapshot(name, snapshot)
    ) {
      return undefined;
    }

    return {
      success: false,
      componentName: name,
      reason: 'Component registration changed while restart was starting it',
      code: 'component_not_found',
    };
  }

  private async restartComponentOperation(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult> {
    const bulkRefusal =
      this.core.componentStop.checkIndividualBulkPreconditions(name, 'restart');
    if (bulkRefusal) {
      return bulkRefusal;
    }

    // Snapshot both phases' options before tearing down a healthy component: every
    // field is read once, here, then the bulk check is made again. A property may be a
    // getter, and the stop can await arbitrary component code; a second read after
    // that await need not describe the same configuration.
    const { stopOptions, startOptions } =
      snapshotRestartComponentOptions(options);
    const afterOptionsRefusal =
      this.core.componentStop.checkIndividualBulkPreconditions(name, 'restart');
    if (afterOptionsRefusal) {
      return afterOptionsRefusal;
    }
    const preconditions = this.core.componentStop.checkStopPreconditions(name);
    if ('success' in preconditions) {
      return preconditions;
    }
    const { component } = preconditions;
    // Track this call's claim, rather than comparing the name's shared stop token:
    // an option getter can start a nested stop and then fail before this one claims.
    const stopContext: IndividualStopContext = {
      operation: 'restart',
      claimed: false,
      allowStopWithRunningDependents:
        stopOptions.allowStopWithRunningDependents,
    };
    // Ahead of the timeout reads below, as `stopComponent()` checks ahead of its own.
    // The checks after those reads catch a component the dependency getters stopped
    // or replaced, and the stop checks again for a bulk operation they began.
    const dependentRefusal =
      this.core.componentStop.checkIndividualStopDependents(name, stopContext);
    if (dependentRefusal) {
      return dependentRefusal;
    }
    const startSnapshot: RestartStartSnapshot = {
      component,
      generation: this.registrationReads.currentGeneration(component),
      timeoutMS: toOperationTimerDelayMS(
        component.startupTimeoutMS,
        `${name}.startupTimeoutMS`,
      ),
      ownsLateStartCleanup: toOperationFlag(
        component.ownsLateStartCleanup,
        `${name}.ownsLateStartCleanup`,
      ),
    };

    // A timeout getter can synchronously stop or replace its own component.
    // Never carry that snapshot into a different registration or stop its replacement.
    const isCurrentSnapshot = this.isCurrentRestartSnapshot(
      name,
      startSnapshot,
    );
    if (
      !isCurrentSnapshot ||
      !this.isComponentRunning(name) ||
      this.core.claims.isInFlight(name)
    ) {
      if (!isCurrentSnapshot) {
        return {
          success: false,
          componentName: name,
          reason:
            'Component was unregistered or replaced while restart was being prepared',
          code: 'component_not_found',
        };
      }
      const preconditions = this.core.componentStop.checkStopPreconditions(
        name,
        startSnapshot.component,
      );
      if ('success' in preconditions) {
        return preconditions;
      }
      // A reentrant start can own the component even when its stop preconditions
      // still see it running. Do not issue another stop against that claim.
      return {
        success: false,
        componentName: name,
        reason: 'Component is already starting',
        code: 'component_already_starting',
      };
    }

    // A shutdown that asks the process to stay down can be accepted and finish while
    // the stop awaits, so the start below would no longer find it running. A request
    // refused by a concurrent restart's stop phase asks the same, and leaves no pass
    // running either once that restart skips its startup.
    const stayDownRequestCountAtStop = this.state.stayDownRequestCount;
    const stopResult = await settleOperation(
      'stopComponent',
      () => this.restartStopOperation(name, stopOptions, stopContext),
      (error, reason, code) =>
        crashedComponentResult(name, error, reason, code),
    );

    if (!stopResult.success) {
      // Once this restart took a stop claim, even a later refusal or validation
      // error describes an attempted stop. Only pre-claim failures pass through.
      if (!stopContext.claimed) {
        return stopResult;
      }
      return {
        success: false,
        componentName: name,
        reason: `Failed to stop: ${stopResult.reason}`,
        code: 'restart_stop_failed',
        error: stopResult.error,
      };
    }

    // A stop listener may have unregistered or replaced this instance while the
    // stop awaited. The restart may only start the registration it stopped.
    if (!this.isCurrentRestartSnapshot(name, startSnapshot)) {
      // Replaced or unregistered, and asked to stay down meanwhile: the request is why
      // no start follows, and it is reported as such. Neither a replacement's status nor
      // a missing one is this restart's, so none is attached.
      if (this.state.stayDownRequestCount !== stayDownRequestCountAtStop) {
        return {
          success: false,
          componentName: name,
          reason:
            'Shutdown requested while restart was stopping the component, which was replaced or unregistered meanwhile; startup skipped',
          code: 'shutdown_requested_during_restart',
        };
      }

      return {
        success: false,
        componentName: name,
        reason: 'Component changed while restart was stopping it',
        code: 'restart_start_failed',
      };
    }

    if (this.state.stayDownRequestCount !== stayDownRequestCountAtStop) {
      return {
        success: false,
        componentName: name,
        reason:
          'Shutdown requested while restart was stopping the component; startup skipped',
        code: 'shutdown_requested_during_restart',
        status: this.getComponentStatus(name),
      };
    }

    const startResult = await settleOperation(
      'startComponent',
      () =>
        this.core.componentStart.startComponentInternal(
          name,
          startOptions,
          undefined,
          undefined,
          undefined,
          startSnapshot,
        ),
      (error, reason, code) =>
        crashedComponentResult(name, error, reason, code),
    );

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

  private updateStartedFlag(): void {
    this.state.isStarted =
      this.state.runningComponents.size > 0 ||
      this.state.stalledComponents.size > 0;
  }

  /**
   * Internal method that handles component registration logic.
   * Used by both registerComponent and insertComponentAt.
   */
  private async registerComponentInternal(
    component: BaseComponent,
    position: InsertPosition,
    targetComponentName: string | undefined,
    isInsertAction: boolean,
    options: RegisterOptions | undefined,
    // Whether this call committed, and the auto-start it attempted or deferred, kept
    // where the safety net above it can read them. Required: a call that made its own
    // would leave the net reading one that never changes.
    progress: RegistrationProgress,
  ): Promise<InsertComponentAtResult> {
    const componentName: unknown = component.getName();
    progress.nameRead = { value: componentName };

    // The name is recorded here and trusted from then on - see `nameOf()` - so a
    // `getName()` that breaks its contract is refused now rather than recorded as a
    // name every later lookup would fall through. Thrown, and answered like a throwing
    // `getName()`: with `operation_crashed`.
    if (typeof componentName !== 'string') {
      throw new TypeError(
        `Component getName() must return a string, got ${typeof componentName}`,
      );
    }

    // Read again once the reads below are done: they can register the name.
    let registrationIndexBefore = this.getComponentIndex(componentName);
    // What a committed registration has done so far, for a failure after the commit to
    // report rather than contradict: a caller told `autoStartAttempted: false` for an
    // auto-start that ran could start the component a second time. Whether it committed
    // is `progress.hasCommitted`: set by this registration's own commit, not inferred
    // from the registry, since a re-entrant registration of the same instance - from its
    // own `getDependencies()` - can put it there while this one goes on to fail before
    // committing anything.
    const { committed } = progress;

    try {
      // Everything of the caller's code registration needs is read first - whether the
      // instance says it is registered, its own dependency list, and every registered
      // component's list - and every check that decides the registration runs after,
      // synchronously, up to the commit. Those reads can register, unregister, start a
      // bulk startup or begin a shutdown re-entrantly; checks made before them committed
      // a second component under a taken name, inserted at a stale index, and trusted a
      // cycle check made against a registry that had since changed. A refusal may still
      // log and emit its event - it returns straight after.
      //
      // The checks that need none of the caller's code come first: a registration they
      // refuse reads nothing - no component's `getDependencies()` during a shutdown that
      // may be tearing them down - and answers with its own code, not with whatever
      // the reads would have made of it. Asked again before each read, since any read
      // can begin a shutdown; the checks below refuse once one has.
      const canRead = (): boolean =>
        isInsertPosition(position) && !this.core.shutdownPass.isShuttingDown;
      let shouldAutoStart = false;
      if (canRead()) {
        shouldAutoStart = snapshotRegisterOptions(options).autoStart;
      }
      let isRegisteredWithAManager = false;
      // Strict: a `getDependencies()` that throws, or reports an implausible length,
      // refuses the registration - once the checks ahead of it have passed, as before. A
      // non-string entry does not - its own start fails on it - but is reported once the
      // registration commits: a refused one must not spend the report the next
      // registration makes.
      let candidateRead: DependencyRead = { dependencies: [] };
      // Kept as reads, as a bulk startup keeps them: one snapshot type for ordering.
      const readRegistered = (registered: BaseComponent): DependencyRead =>
        this.componentMetadata.readDependenciesReported(
          registered,
          'registration',
        );
      let registryRead = {
        reads: new Map<BaseComponent, DependencyRead>(),
        isSettled: true,
      };
      // Why the component cannot be registered because it still defines a removed
      // timeout hook. Read first, as the component's own: a getter there is its code.
      let removedHooksReason: string | undefined;

      if (canRead()) {
        removedHooksReason = removedTimeoutHooksReason(
          component,
          componentName,
        );
      }

      if (canRead()) {
        candidateRead = tryReadDependencies(component);
      }

      if (canRead()) {
        // Before the registry's lists, so a component it registers is read with the
        // rest, and after the candidate's own, which could register this instance
        // elsewhere with nothing else read to ask again after.
        isRegisteredWithAManager = component._isRegisteredWithManager();
      }

      // The registry's lists, and the instance's answer each time they settle, until
      // neither brings anything new: a list read can register this instance with
      // another manager, and asking about that can register components whose lists
      // are then unread. Either answer of the instance's counts.
      if (canRead()) {
        registryRead = this.readRegistry(
          readRegistered,
          registryRead.reads,
          canRead,
          () => {
            isRegisteredWithAManager =
              component._isRegisteredWithManager() || isRegisteredWithAManager;
          },
          () => this.state.componentEntries,
        );
      }

      const dependencySnapshot = registryRead.reads;
      registrationIndexBefore = this.getComponentIndex(componentName);

      // A registry that kept changing under the reads above - each read registering
      // another component whose own list then had to be read - is refused as a broken
      // contract, the way a throwing `getName()` is. Reads cut short by a shutdown are
      // not: the shutdown check below refuses those.
      if (!registryRead.isSettled && !this.core.shutdownPass.isShuttingDown) {
        throw new Error(
          `The registry kept changing while "${componentName}" was being registered; registration refused`,
        );
      }

      // What every refusal below shares; see `refuseRegistration()`.
      const refusal = {
        progress,
        componentName,
        registrationIndexBefore,
        position,
        targetComponentName,
        isInsertAction,
        dependencySnapshot,
      };

      if (!isInsertPosition(position)) {
        return this.refuseRegistration({
          ...refusal,
          code: 'invalid_position',
          message: `Invalid insert position: "${String(position)}". Expected one of: start, end, before, after.`,
          logLine: 'Invalid insertion position',
          logParams: { position },
        });
      }

      // Block registration during shutdown
      if (this.core.shutdownPass.isShuttingDown) {
        return this.refuseRegistration({
          ...refusal,
          code: 'shutdown_in_progress',
          message: LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
          logLine: 'Cannot register component during shutdown',
        });
      }

      // A component written for the timeout hooks the abort signals replaced. Refused
      // rather than registered with those hooks silently ignored - along with, for the
      // startup one, the late-start cleanup opt-out it implied.
      if (removedHooksReason !== undefined) {
        return this.refuseRegistration({
          ...refusal,
          code: 'invalid_options',
          message: removedHooksReason,
          logLine: 'Component defines a removed timeout hook',
          error: invalidOperationOptionError(removedHooksReason),
        });
      }

      // Block registration during startup if this component would be a dependency
      // for any already-registered component (would break dependency ordering)
      if (
        this.core.startup.isRequiredDependencyDuringStartup(
          componentName,
          dependencySnapshot,
        )
      ) {
        return this.refuseRegistration({
          ...refusal,
          code: 'startup_in_progress',
          message:
            LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
          logLine:
            'Cannot register component during startup - it is a required dependency for other components',
        });
      }

      // Check if component instance is already registered - here, by the instance's own
      // answer, or with this manager since that answer was read
      const isRegisteredHere = this.isInstanceReserved(component);
      if (isRegisteredWithAManager || isRegisteredHere) {
        const message = isRegisteredHere
          ? LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE
          : LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE_EXTERNAL;

        return this.refuseRegistration({
          ...refusal,
          code: 'duplicate_instance',
          message,
          logLine: isRegisteredHere
            ? 'Component instance already registered'
            : 'Component instance already registered with another lifecycle manager',
        });
      }

      // Check if component name is already registered
      if (this.isNameReserved(componentName)) {
        return this.refuseRegistration({
          ...refusal,
          code: 'duplicate_name',
          message: `Component "${componentName}" is already registered.`,
          logLine: 'Component with this name already registered',
        });
      }

      // Get the insertion index for the component
      const insertIndex = this.getInsertIndex(position, targetComponentName);
      if (insertIndex === null) {
        return this.refuseRegistration({
          ...refusal,
          code: 'target_not_found',
          message: `Target component "${targetComponentName ?? ''}" not found in registry.`,
          logLine: 'Target component not found',
          logParams: { target: targetComponentName },
          target: targetComponentName,
          targetFound: false,
        });
      }

      // Compute dependency order *before* committing registration mutations.
      // This avoids leaving the registry/state maps inconsistent if a dependency
      // cycle is detected.
      const nextComponents = [
        ...this.state.componentEntries.slice(0, insertIndex),
        component,
        ...this.state.componentEntries.slice(insertIndex),
      ];

      if (!('dependencies' in candidateRead)) {
        throw candidateRead.error;
      }

      let startupOrder: string[];

      try {
        startupOrder = this.core.startupOrdering.getStartupOrderInternal(
          nextComponents,
          {
            component,
            name: componentName,
            dependencies: candidateRead.dependencies,
          },
          dependencySnapshot,
        );
      } catch (error) {
        if (error instanceof DependencyCycleError) {
          return this.refuseRegistration({
            ...refusal,
            code: 'dependency_cycle',
            message: error.message,
            logLine: 'Registration rejected due to dependency cycle',
            logParams: { cycle: error.additionalInfo.cycle },
            cycle: error.additionalInfo.cycle,
            error,
            targetFound: positionHasTarget(position) ? true : undefined,
          });
        }
        throw error;
      }

      // Prepare registration - the registry entry and every state map together,
      // before the component's own code runs. Startup remains blocked until its
      // registration hook succeeds, because failure rolls these provisional writes back.
      // An instance registered before keeps its old recorded name after unregistering,
      // for work still in flight; a rollback below puts that back rather than dropping
      // it.
      const previousRecordedName = this.state.registeredNames.get(component);
      const previousGeneration =
        this.registrationReads.currentGeneration(component);
      // What the report-once marks held before this attempt, so a rollback clears only
      // marks it made itself.
      const previousMetadataReports =
        this.componentMetadata.reportMarks(component);

      let interruptionCode:
        'shutdown_in_progress' | 'startup_in_progress' | undefined;
      // Both expected bulk-operation refusals and unexpected failures undo only
      // this attempt. Keep the reservation until finally so rollback hooks cannot
      // claim its name while cleanup is still in progress.
      const rollBack = (): void => {
        this.state.rollbackReservations.set(component, componentName);
        this.state.componentEntries = this.state.componentEntries.filter(
          (registered) => registered !== component,
        );
        // Rolled back, so this registration did not commit after all.
        progress.hasCommitted = false;
        this.registrationReads.restoreRegistration(
          component,
          previousGeneration,
        );

        this.state.componentStates.delete(componentName);
        this.state.componentTimestamps.delete(componentName);
        this.state.componentErrors.delete(componentName);
        this.state.componentStartAttemptTokens.delete(componentName);

        // The component's side too: a hook that marked it registered before throwing
        // would otherwise leave it believing it is, and its next registration refused as
        // `duplicate_instance`.
        this.markComponentUnregistered(
          component,
          'lifecycle-manager registration rollback',
        );
        // The separate reservation retains the attempted name while bookkeeping is
        // restored; finally releases it after cleanup has completely finished.
        if (previousRecordedName === undefined) {
          this.state.registeredNames.delete(component);
        } else {
          this.state.registeredNames.set(component, previousRecordedName);
        }

        // "Reported once per registration": this one never happened, so a report made
        // under it - by the hook's own code reading the component - does not count
        // against the next. Only such a report: a mark that was already there stays, or
        // a caller retrying a failing registration would be told the same thing each
        // time.
        this.componentMetadata.rollBackReports(
          component,
          previousMetadataReports,
        );
      };
      this.withTransition(() => {
        try {
          // A new array rather than a splice, as unregister does: a loop over the registry
          // that a re-entrant registration lands in keeps walking the array it started on.
          this.state.pendingRegistrations.add(component);
          this.state.componentEntries = nextComponents;
          this.registrationReads.advanceRegistration(component);
          this.state.registeredNames.set(component, componentName);

          const internalCallbacks =
            this.createLifecycleInternalCallbacks(component);

          // The lifecycle setter and registration hook can both be overridden. Keep
          // the entry unavailable to startup throughout them and their rollback, and
          // release the guard on every exit before queued notifications are delivered.
          (
            component as unknown as { lifecycle: ComponentLifecycleRef }
          ).lifecycle = new ComponentLifecycle(
            this,
            componentName,
            internalCallbacks,
          );
          component._markRegistered();
          // A hook may start shutdown while this entry is invisible to that pass.
          // It must not publish a new component into the pass after its snapshot.
          progress.wasDuringStartup = this.state.isStarting;
          if (this.core.shutdownPass.isShuttingDown) {
            interruptionCode = 'shutdown_in_progress';
            rollBack();
            return;
          }
          // Startup can also begin inside either hook. Its order excludes this
          // provisional entry, so publishing a dependency needed by that pass would
          // contradict the same ordering rule checked before calling the hooks.
          if (
            this.core.startup.isRequiredDependencyDuringStartup(
              componentName,
              dependencySnapshot,
            )
          ) {
            interruptionCode = 'startup_in_progress';
            rollBack();
            return;
          }
          this.state.componentStates.set(componentName, 'registered');
          this.state.componentTimestamps.set(componentName, {
            startedAt: null,
            stoppedAt: null,
          });
          this.state.componentErrors.set(componentName, null);
          this.state.componentUnexpectedStopHadError.delete(componentName);
          this.state.componentStartAttemptTokens.set(componentName, ulid());
          progress.hasCommitted = true;
          this.state.committedDependencyReads.set(component, candidateRead);
        } catch (error) {
          rollBack();
          throw error;
        } finally {
          this.state.pendingRegistrations.delete(component);
          this.state.rollbackReservations.delete(component);
          // Publish only after hooks succeed (or rebuild after rollback), before
          // notifications flush. Nested commits and unregisters remain in the live
          // entries; never restore the stale array captured before calling hooks.
          this.publishRegistry();
          if (progress.hasCommitted) {
            // Capture the report before queued listeners can mutate the registry.
            // The pre-hook order was only the reserved-entry cycle check; hooks may
            // have committed more components. Merge their validated reads into this
            // report snapshot without invoking more caller code during publication.
            try {
              const reportReads = new Map<BaseComponent, DependencyRead>();
              let hasCompleteReportReads = true;
              for (const entry of this.state.components) {
                const read =
                  entry === component
                    ? candidateRead
                    : this.currentReadOf(entry, dependencySnapshot);
                // Every committed entry receives metadata before publication. If
                // this invariant ever breaks, the report is unavailable: inventing
                // an empty list would report a plausible but unjustified order.
                if (read === undefined) {
                  hasCompleteReportReads = false;
                  break;
                }
                reportReads.set(entry, read);
              }
              startupOrder = hasCompleteReportReads
                ? this.core.startupOrdering.getStartupOrderInternal(
                    this.state.components,
                    undefined,
                    reportReads,
                  )
                : [];
            } catch {
              // This diagnostic cannot undo publication, regardless of why its
              // order is unavailable. Snapshots observed at different times can disagree even though
              // every registration passed its own cycle check. This is a report,
              // not a failed commit: use an unavailable order rather than throw
              // after publication or re-enter caller getters to manufacture one.
              startupOrder = [];
            }
            committed.startupOrder = startupOrder;
            committed.manualPositionRespected =
              startupOrder.length === 0
                ? undefined
                : this.isManualPositionRespected({
                    componentName,
                    position,
                    targetComponentName,
                    startupOrder,
                  });
            // As found at insertion: `getInsertIndex()` refused a relative position
            // whose target was missing. The hooks since may have unregistered the
            // target, which does not undo that this registration was placed by it.
            committed.targetFound = positionHasTarget(position)
              ? true
              : undefined;
          }
        }
      });
      if (interruptionCode !== undefined) {
        return this.refuseRegistration({
          ...refusal,
          code: interruptionCode,
          message:
            interruptionCode === 'shutdown_in_progress'
              ? LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS
              : LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
          logLine: 'Cannot commit component registration during bulk operation',
        });
      }
      // Only now: a registration refused above - a dependency cycle, a failed hook - used
      // to have spent this component's one report, leaving the registration that
      // followed silent about the same broken list.
      if (candidateRead.invalidEntry !== undefined) {
        this.reportDependencyReadFailureOnce(
          component,
          'registration',
          candidateRead.invalidEntry,
          componentName,
        );
      }

      const registrationIndexAfter = this.state.components.indexOf(component);

      if (isInsertAction) {
        this.logger.entity(componentName).info('Component inserted', {
          params: { position, index: registrationIndexAfter },
        });
      } else {
        this.logger.entity(componentName).info('Component registered', {
          params: { index: registrationIndexAfter },
        });
      }

      // The log lines and dependency report above ran caller code, which can unregister
      // this component and register another under its name. Every auto-start branch
      // below acts by name: it would start the replacement and report that as this
      // registration's auto-start, or reserve the name in a startup for it.
      const isStillThisRegistration = (): boolean =>
        this.getComponent(componentName) === component;
      const skipReplacedAutoStart = (): void => {
        this.logger
          .entity(componentName)
          .warn(
            'AutoStart: skipped, the component was unregistered during its registration',
          );
      };

      if (shouldAutoStart && !isStillThisRegistration()) {
        skipReplacedAutoStart();
      } else if (shouldAutoStart) {
        // Capture this pass before logging runs caller code. Its queue/rollback state
        // decides whether registration defers, refuses auto-start, or starts work
        // independently after the completion boundary.
        const bulkStartup = this.state.activeBulkStartup;
        // Reserve before logging: a sink can synchronously register more components.
        // The initial order or a follow-up batch owns this start and its outcome.
        const deferToBulkStartup = (startup: typeof bulkStartup): void => {
          progress.isAutoStartDeferred = true;
          // A startup this registration's own log line began has ordered it already.
          // Queued as well, it would be started twice and, after a rollback, also
          // reported as an auto-start the startup never attempted. Frozen with the
          // initial order's deferred names instead, so one the loop never reaches is.
          if (!startup?.initialOrderNames.has(componentName)) {
            this.state.deferredAutoStartNames.add(componentName);
          } else if (!startup.reachedNames.has(componentName)) {
            startup.frozenAutoStarts.add(componentName);
          }
          this.logger
            .entity(componentName)
            .info('AutoStart: left to the bulk startup about to run');
        };
        // The restart this start would race: it has accepted its stop phase, and its
        // upcoming startup reads the registry, this registration included. Reserve
        // before logs, since sinks can synchronously take the startup latch and claim
        // the set.
        const deferToRestart = (pendingRestart: Set<string>): void => {
          pendingRestart.add(componentName);
          progress.isAutoStartDeferred = true;
          this.logger
            .entity(componentName)
            .info('AutoStart: left to the restart startup about to run');
        };

        // Bulk startup first: `isStarted` turns true as soon as its first component is
        // running, and a start without `allowDuringBulkStartup` is refused with
        // `startup_in_progress` for the rest of it.
        const pendingRestart = Array.from(
          this.state.pendingRestartAutoStarts,
        ).at(-1);
        if (!this.state.isStarting && pendingRestart !== undefined) {
          // The restart has released shutdown's latch but has not claimed startup's
          // yet. Its upcoming order includes this registration.
          deferToRestart(pendingRestart);
        } else if (this.state.isStarting && bulkStartup?.isRollingBack) {
          progress.didAutoStartAttempt = true;
          progress.startResult = {
            success: false,
            componentName,
            reason:
              'The bulk startup this auto-start would join is rolling back',
            code: 'startup_rolled_back',
            status: this.getComponentStatus(componentName),
          };
        } else if (this.state.isStarting && !bulkStartup?.isCompleting) {
          deferToBulkStartup(bulkStartup);
        } else if (this.state.isStarting && bulkStartup !== null) {
          // The pass has closed its queue before terminal notifications. A start from
          // those callbacks is independent, while the public bulk latch stays held.
          this.logger
            .entity(componentName)
            .info('AutoStart: starting component (bulk startup completing)');
          // That log line ran caller code too.
          if (isStillThisRegistration()) {
            progress.didAutoStartAttempt = true;
            progress.startResult =
              await this.core.componentStart.startComponentInternal(
                componentName,
                snapshotStartOptions({
                  // Logging runs caller code. Only the captured completion still owns
                  // this permission; a replacement pass must retain its own bulk guard.
                  allowDuringBulkStartup:
                    this.state.activeBulkStartup === bulkStartup &&
                    bulkStartup.isCompleting &&
                    !bulkStartup.isRollingBack,
                }),
              );
          } else {
            skipReplacedAutoStart();
          }
        } else {
          this.logger
            .entity(componentName)
            .info(
              this.state.isStarted
                ? 'AutoStart: starting component (manager is running)'
                : 'AutoStart: starting component (manager not running)',
            );
          // That log line ran caller code too. A bulk startup or restart it began owns
          // this start: started here as well, it would be refused `startup_in_progress`
          // or `shutdown_in_progress` and reported as a failed auto-start while that
          // startup started the component.
          const startupBegunByLog = this.state.activeBulkStartup;
          const restartBegunByLog = Array.from(
            this.state.pendingRestartAutoStarts,
          ).at(-1);
          if (!isStillThisRegistration()) {
            skipReplacedAutoStart();
          } else if (
            this.state.isStarting &&
            !startupBegunByLog?.isCompleting &&
            !startupBegunByLog?.isRollingBack
          ) {
            deferToBulkStartup(startupBegunByLog);
          } else if (
            !this.state.isStarting &&
            restartBegunByLog !== undefined
          ) {
            deferToRestart(restartBegunByLog);
          } else {
            progress.didAutoStartAttempt = true;
            progress.startResult =
              await this.core.componentStart.startComponentInternal(
                componentName,
              );
          }
        }
      }

      // Where it is now, not where it landed: an auto-start can register or remove
      // components around it. By instance, as the failure path reads it: one unregistered
      // and replaced under its name by a listener must not be described as the other.
      const indexOfComponent = this.state.components.indexOf(component);
      const registrationIndexNow =
        indexOfComponent === -1 ? null : indexOfComponent;
      // The same report, and the same event, as a failure after the commit gives.
      const report = committedRegistrationReport(
        progress,
        position,
        this.describeRegistryPosition(registrationIndexNow),
      );

      this.emitCommittedRegistration({
        progress,
        componentName,
        index: registrationIndexNow,
        isInsertAction,
        position,
        targetComponentName,
        report,
      });

      return {
        action: 'insert',
        success: true,
        registered: true,
        componentName,
        registrationIndexBefore: null,
        registrationIndexAfter: registrationIndexNow,
        requestedPosition: { position, targetComponentName },
        ...report,
        startResult: progress.startResult,
      };
    } catch (error) {
      // Answered by the same guarded code the safety net above uses, which cannot throw:
      // the net is then reached only for a `getName()` that failed, before this `try`.
      return this.answerRegistrationFailure({
        component,
        componentName,
        error,
        isErrorReported: false,
        reason: undefined,
        position,
        targetComponentName,
        isInsertAction,
        registrationIndexBefore,
        progress,
      });
    }
  }

  /**
   * The answer to a registration that failed unexpectedly - from its own catch, or from
   * the safety net above it for a `getName()` that failed first. One place, every step
   * guarded, so it cannot throw: the report on the global `'error'` channel, the log
   * line, the announcement - `component:registered` for one that committed,
   * `component:registration-rejected` otherwise, once - and the result, which says what
   * a committed registration had done rather than a refusal's defaults.
   */
  private answerRegistrationFailure(input: {
    component: BaseComponent;
    componentName: string;
    error: unknown;
    // Whether the error is on the global channel already - the net's is.
    isErrorReported: boolean;
    // The net's wording; the error's own when not given.
    reason: string | undefined;
    position: InsertPosition;
    targetComponentName: string | undefined;
    isInsertAction: boolean;
    registrationIndexBefore: number | null;
    progress: RegistrationProgress;
  }): InsertComponentAtResult {
    return this.withTransition(() => {
      const { componentName, position, progress } = input;
      const err = toError(input.error);
      // A step that throws is reported and skipped, never allowed to replace the answer.
      const contain = (step: string, run: () => void): void => {
        try {
          run();
        } catch (stepError) {
          reportCallbackError(
            `lifecycle-manager registerComponent ${step}`,
            stepError,
          );
        }
      };
      let cycle: string[] | undefined;

      contain('cycle', () => {
        if (err instanceof DependencyCycleError) {
          cycle = err.additionalInfo.cycle;
        }
      });

      const code: RegistrationFailureCode =
        cycle !== undefined ? 'dependency_cycle' : 'operation_crashed';

      // Reported for the reason `getStartupOrder()` reports it; a cycle is the caller's
      // configuration, answered by the result.
      if (code === 'operation_crashed' && !input.isErrorReported) {
        reportCallbackError('lifecycle-manager registerComponent', input.error);
      }

      contain('log', () => {
        this.logger
          .entity(componentName)
          .error(
            'Registration failed with unexpected error: {{error.message}}',
            {
              params: { error: err },
            },
          );
      });

      // `registered` is whether this call added the component, as on success: a throw
      // after the commit - from an auto-start, say - leaves it added, and both the event
      // and the result must say so. Where it is now is read back from the registry, and
      // is `null` if a listener has removed it since.
      const isRegistered = progress.hasCommitted;
      const indexOfComponent = this.state.components.indexOf(input.component);
      const registrationIndexNow =
        isRegistered && indexOfComponent !== -1 ? indexOfComponent : null;
      let actualPosition: InsertComponentAtResult['actualPosition'];

      contain('position', () => {
        actualPosition = this.describeRegistryPosition(registrationIndexNow);
      });

      const report = committedRegistrationReport(
        progress,
        position,
        actualPosition,
      );
      const reason = input.reason ?? describeError(err);

      if (!progress.isAnnounced) {
        contain('event', () => {
          if (isRegistered) {
            this.emitCommittedRegistration({
              progress,
              componentName,
              index: registrationIndexNow,
              isInsertAction: input.isInsertAction,
              position,
              targetComponentName: input.targetComponentName,
              report,
            });
          } else {
            this.emitRegistrationRejected({
              progress,
              name: componentName,
              reason: code,
              message: reason,
              registrationIndexBefore: input.registrationIndexBefore,
              startupOrder: [],
              targetFound: defaultTargetFound(position),
              ...(cycle !== undefined ? { cycle } : {}),
              isInsertAction: input.isInsertAction,
              position,
              targetComponentName: input.targetComponentName,
            });
          }
        });
      }

      return {
        action: 'insert',
        success: false,
        registered: isRegistered,
        componentName,
        reason,
        code,
        error: err,
        registrationIndexBefore: input.registrationIndexBefore,
        registrationIndexAfter: isRegistered
          ? registrationIndexNow
          : input.registrationIndexBefore,
        requestedPosition: {
          position,
          targetComponentName: input.targetComponentName,
        },
        duringStartup: this.state.isStarting,
        ...report,
        startResult: isRegistered ? progress.startResult : undefined,
      };
    });
  }

  /**
   * `component:registration-rejected`, built in one place for every refusal and
   * failure. `registrationIndexAfter` is `registrationIndexBefore` unless given: a
   * refusal leaves the registry as it was.
   */
  private emitRegistrationRejected(input: {
    // Marked announced here once emitted, so the rule lives in one place.
    progress: RegistrationProgress;
    name: string;
    reason: RegistrationFailureCode;
    message: string;
    registrationIndexBefore: number | null;
    registrationIndexAfter?: number | null;
    target?: string;
    cycle?: string[];
    startupOrder?: string[];
    targetFound?: boolean;
    isInsertAction: boolean;
    position: InsertPosition;
    targetComponentName: string | undefined;
  }): void {
    return this.withTransition(() => {
      this.lifecycleEvents.componentRegistrationRejected({
        name: input.name,
        reason: input.reason,
        ...('target' in input ? { target: input.target } : {}),
        ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
        message: input.message,
        registrationIndexBefore: input.registrationIndexBefore,
        registrationIndexAfter:
          'registrationIndexAfter' in input
            ? input.registrationIndexAfter
            : input.registrationIndexBefore,
        ...(input.startupOrder !== undefined
          ? { startupOrder: input.startupOrder }
          : {}),
        requestedPosition: input.isInsertAction
          ? {
              position: input.position,
              targetComponentName: input.targetComponentName,
            }
          : undefined,
        manualPositionRespected: undefined,
        ...('targetFound' in input ? { targetFound: input.targetFound } : {}),
      });
      // Once queued: a payload builder that throws leaves it unannounced for the
      // failure path to announce. Delivery waits until this flag is consistent,
      // and listener failures cannot cause a duplicate announcement.
      input.progress.isAnnounced = true;
    });
  }

  /**
   * `component:registered` for a registration that committed, from wherever it is
   * reported - the success path, the registration's catch, or the safety net above it -
   * so the payload is built once. `registrationIndexBefore` is always `null`: a
   * registration commits only for a name that was not registered.
   */
  private emitCommittedRegistration(input: {
    // Marked announced here once emitted, so the rule lives in one place.
    progress: RegistrationProgress;
    componentName: string;
    index: number | null;
    isInsertAction: boolean;
    position: InsertPosition;
    targetComponentName: string | undefined;
    report: ReturnType<typeof committedRegistrationReport>;
  }): void {
    return this.withTransition(() => {
      this.lifecycleEvents.componentRegistered({
        name: input.componentName,
        index: input.index,
        action: input.isInsertAction ? 'insert' : 'register',
        registrationIndexBefore: null,
        registrationIndexAfter: input.index,
        requestedPosition: input.isInsertAction
          ? {
              position: input.position,
              targetComponentName: input.targetComponentName,
            }
          : undefined,
        ...input.report,
      });
      // Once queued: a payload builder that throws leaves it unannounced for the
      // failure path to announce. Delivery waits until this flag is consistent,
      // and listener failures cannot cause a duplicate announcement.
      input.progress.isAnnounced = true;
    });
  }

  /**
   * Where the registry entry at `index` sits, described by its neighbours, as a
   * registration reports it. Read at report time, from the registry as it is then: an
   * auto-start can register or remove components around the new one, and a position
   * captured before it described a registry that had moved on.
   */
  private describeRegistryPosition(
    index: number | null,
  ): InsertComponentAtResult['actualPosition'] {
    let positionDescription: string | undefined;

    if (index !== null) {
      const totalComponents = this.state.components.length;

      if (totalComponents === 1) {
        positionDescription = 'only component';
      } else if (index === 0) {
        const nextComponent = this.nameOfAt(1);
        positionDescription = nextComponent
          ? `at start, before ${nextComponent}`
          : 'at start';
      } else if (index === totalComponents - 1) {
        const prevComponent = this.nameOfAt(totalComponents - 2);
        positionDescription = prevComponent
          ? `at end, after ${prevComponent}`
          : 'at end';
      } else {
        const prevComponent = this.nameOfAt(index - 1);
        const nextComponent = this.nameOfAt(index + 1);
        if (prevComponent && nextComponent) {
          positionDescription = `after ${prevComponent}, before ${nextComponent}`;
        } else if (prevComponent) {
          positionDescription = `after ${prevComponent}`;
        } else if (nextComponent) {
          positionDescription = `before ${nextComponent}`;
        }
      }
    }

    return index !== null
      ? { index, description: positionDescription }
      : undefined;
  }

  private reportDependencyReadFailureOnce(
    component: BaseComponent,
    context: string,
    failure: unknown,
    name?: string,
  ): void {
    this.componentMetadata.reportDependencyReadFailureOnce(
      component,
      context,
      failure,
      name,
    );
  }

  /** Whether a component is registered under `name`, without calling any public method. */
  private isNameRegistered(name: string): boolean {
    return this.state.componentsByName.has(name);
  }

  /** The status of the component registered under `name`; the caller has checked it is. */
  private statusOf(name: string): ComponentStatus {
    const state = this.state.componentStates.get(name) || 'registered';
    const timestamps = this.state.componentTimestamps.get(name) || {
      startedAt: null,
      stoppedAt: null,
    };
    const lastError = this.state.componentErrors.get(name) || null;
    const stallInfo = this.state.stalledComponents.get(name) || null;

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

  /**
   * Get a component by name
   */
  private getComponent(name: string): BaseComponent | undefined {
    return this.state.componentsByName.get(name);
  }

  /**
   * Attach signals on the manager's own initiative, ahead of a start.
   *
   * A failure here fails the start: on Node and Bun an attach only throws when something
   * is really wrong - a `process.on` or raw-mode stdin failure - and a process that was
   * configured to handle `SIGTERM` must not come up without doing so. Every caller takes
   * its start state first (`isStarting`, or a component's `starting`) so that a
   * `signals-attached` listener re-entering the manager finds the work already claimed,
   * and releases that state if this fails. Caught rather than thrown so each caller can
   * answer with its own result; an explicit `attachSignals()` call still throws to its
   * caller.
   *
   * @returns `attached` when this call attached them, `failed` with the error when it
   * could not, and `unchanged` when they were already attached
   */
  private autoAttachSignals(
    trigger: string,
  ):
    | { outcome: 'attached' | 'unchanged' }
    | { outcome: 'failed'; error: Error } {
    if (this.state.processSignalManager?.getStatus().isAttached) {
      return { outcome: 'unchanged' };
    }

    this.logger.info(`Auto-attaching process signals on ${trigger}`);

    try {
      this.attachSignals();
    } catch (error) {
      const err = toError(error);

      this.logger.error(
        'Could not attach process signals on {{trigger}}: {{error.message}}',
        { params: { trigger, error: err } },
      );

      return { outcome: 'failed', error: err };
    }

    if (this.state.isStarting) {
      this.state.autoAttachedSignalsDuringStartup = true;
    }

    return { outcome: 'attached' };
  }

  /**
   * Stop a component that started but could not be left running because
   * `attachSignalsOnStart` failed to attach process signals, and answer its start with
   * `signal_attach_failed`. The stop is the normal graceful-then-force one; if it does not
   * complete, the reason says so and the component is left as that stop left it.
   */
  private async rollBackStartForSignalAttach(
    name: string,
    error: Error,
  ): Promise<ComponentOperationResult> {
    this.logger
      .entity(name)
      .warn('Stopping component: process signals could not be attached');

    // `stopComponentInternal()` answers every failure it can foresee with a result and
    // turns anything else into a stall, so the component's state is settled either way;
    // this result only has to describe it. No `status`: this runs inside the start's
    // `try`, and a throw from building one would land in the start's `catch`, which
    // would mark a component this stop may not have stopped as `registered`.
    const stopResult =
      await this.core.componentStop.stopComponentInternal(name);
    const attachReason = `Could not attach process signals: ${describeError(error)}`;

    return {
      success: false,
      componentName: name,
      reason: stopResult.success
        ? `${attachReason}; component stopped again`
        : `${attachReason}; stopping it again also failed: ${stopResult.reason ?? 'unknown reason'}`,
      code: 'signal_attach_failed',
      error,
    };
  }

  /**
   * The `detachSignalsOnStop` check every stop and unregister path runs once it has
   * settled: detach when nothing is left running. `detachSignals()` is idempotent, so a
   * path that reaches this twice for one stop is harmless.
   */
  private detachSignalsAfterLastStop(
    trigger = 'last component stop',
    logMessage: string = LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP,
  ): void {
    this.detachSignalsIfIdle(trigger, { logMessage });
  }

  /**
   * The one `detachSignalsOnStop` check: detach once the manager is idle.
   *
   * Not while anything is running or stalled. A stalled component is not counted as
   * running, but Ctrl+C is how the operator retries or forces it; the stop or
   * unregister that clears the last stall runs this again.
   *
   * Nor while anything transient is in flight - a startup or shutdown latch, a
   * component starting or stopping, a late-startup cleanup or the timed-out start it
   * waits on - since each of those can
   * still leave something running or stalled. A shutdown pass in particular still needs
   * SIGINT/SIGTERM for escalation, and decides once it ends, detaching only after a
   * clean pass. The detach is deferred rather than dropped, and whichever of those ends
   * runs it again through {@link runDeferredSignalDetach}.
   */
  private detachSignalsIfIdle(
    trigger: string,
    options: { logMessage?: string; isEndingShutdownPass?: boolean } = {},
  ): void {
    return this.withTransition(() => {
      if (
        !this.config.detachSignalsOnStop ||
        !this.state.processSignalManager?.getStatus().isAttached ||
        this.state.runningComponents.size > 0 ||
        this.state.stalledComponents.size > 0
      ) {
        return;
      }

      if (this.isSignalDetachWaitingOnTransient(options.isEndingShutdownPass)) {
        this.state.isSignalDetachDeferred = true;
        return;
      }

      this.state.isSignalDetachDeferred = false;
      // Detached before the line is logged, not after: logging runs the caller's sinks,
      // and one that starts a startup from here attached nothing - the handlers were still
      // up - so detaching after it pulled them out from under that startup. Worded in the
      // past, and only on success: a failed detach has already said so. Nor once a
      // `signals-detached` listener has attached them again - a startup it began with
      // `attachSignalsBeforeStartup` - where the line would contradict the state.
      if (this.autoDetachSignals(trigger)) {
        this.eventDispatcher.afterNotifications(() => {
          if (
            this.state.processSignalManager?.getStatus().isAttached !== true
          ) {
            this.logger.info(
              options.logMessage ??
                `Auto-detached process signals after ${trigger}`,
            );
          }
        });
      }
    });
  }

  /**
   * Run a detach {@link detachSignalsIfIdle} deferred, once one of the transient
   * operations that held it has ended.
   */
  private runDeferredSignalDetach(trigger: string): void {
    if (this.state.isSignalDetachDeferred) {
      this.detachSignalsIfIdle(trigger);
    }
  }

  private isSignalDetachWaitingOnTransient(
    isEndingShutdownPass = false,
  ): boolean {
    if (
      this.state.isStarting ||
      (this.core.shutdownPass.isShuttingDown && !isEndingShutdownPass) ||
      this.state.pendingBulkStartupCleanup.size > 0 ||
      this.core.lateStartRecovery.hasAbandonedStartAwaitingCleanup()
    ) {
      return true;
    }

    for (const name of this.state.componentStates.keys()) {
      if (this.core.claims.isInFlight(name)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detach signals on the manager's own initiative, once nothing is left running.
   *
   * Contained for the reason {@link autoAttachSignals} is: every caller is partway through
   * settling a stop, an unregister, or a failed start, and a detach that throws there
   * derailed the rest - a clean graceful stop was sent on to the force phase, and an
   * unregister rejected after it had already removed the component.
   * `ProcessSignalManager.detach()` marks itself detached even when it throws, so there
   * is nothing to retry.
   */
  private autoDetachSignals(trigger: string): boolean {
    try {
      this.detachSignals();

      return true;
    } catch (error) {
      this.logger.error(
        'Could not detach process signals after {{trigger}}: {{error.message}}',
        { params: { trigger, error: toError(error) } },
      );
      reportCallbackError(
        `lifecycle-manager signal detach after ${trigger}`,
        error,
      );

      return false;
    }
  }

  /**
   * Tell a component it is no longer registered. Its own `_markUnregistered()` first, so
   * an override that extends it still runs; if that throws, the two fields it would have
   * cleared are cleared directly. Left set, the instance believed it was still
   * registered, and registering it again was refused as `duplicate_instance`.
   */
  private markComponentUnregistered(
    component: BaseComponent,
    label: string,
  ): void {
    try {
      component._markUnregistered();
    } catch (unmarkError) {
      reportCallbackError(`${label} _markUnregistered`, unmarkError);

      try {
        const fields = component as unknown as {
          _isRegistered: boolean;
          lifecycle?: ComponentLifecycleRef;
        };

        fields._isRegistered = false;
        fields.lifecycle = undefined;
      } catch (clearError) {
        reportCallbackError(label, clearError);
      }
    }
  }

  /** Record now as `field`, keeping the other timestamp from the component's last run. */
  private stampTimestamp(name: string, field: 'startedAt' | 'stoppedAt'): void {
    const timestamps = this.state.componentTimestamps.get(name) ?? {
      startedAt: null,
      stoppedAt: null,
    };
    timestamps[field] = Date.now();
    this.state.componentTimestamps.set(name, timestamps);
  }

  private withTransition<T>(operation: () => T): T {
    return this.eventDispatcher.withTransition(operation);
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

  /**
   * Refuse a registration: log it, announce it with `component:registration-rejected`,
   * and answer with the refused result - one input for all three, so the event and the
   * result cannot disagree. `targetFound` goes on the event only when given.
   */
  private refuseRegistration(input: {
    progress: RegistrationProgress;
    componentName: string;
    registrationIndexBefore: number | null;
    position: InsertPosition;
    targetComponentName: string | undefined;
    isInsertAction: boolean;
    dependencySnapshot: ReadonlyMap<BaseComponent, DependencyRead>;
    code: RegistrationFailureCode;
    message: string;
    logLine: string;
    logParams?: Record<string, unknown>;
    target?: string;
    cycle?: string[];
    error?: Error;
    targetFound?: boolean;
  }): InsertComponentAtResult {
    return this.withTransition(() => {
      // Built before the log: sinks still run caller code, which may register
      // something the snapshot never read, or end the startup `duringStartup` describes.
      // The event itself is queued until this refusal has its complete result.
      const result = this.buildInsertResultFailure({
        componentName: input.componentName,
        position: input.position,
        targetComponentName: input.targetComponentName,
        registrationIndexBefore: input.registrationIndexBefore,
        code: input.code,
        reason: input.message,
        error: input.error,
        targetFound: input.targetFound,
        dependencySnapshot: input.dependencySnapshot,
      });

      this.logger
        .entity(input.componentName)
        .warn(
          input.logLine,
          input.logParams === undefined
            ? undefined
            : { params: input.logParams },
        );

      this.emitRegistrationRejected({
        progress: input.progress,
        name: input.componentName,
        reason: input.code,
        message: input.message,
        registrationIndexBefore: input.registrationIndexBefore,
        ...('target' in input ? { target: input.target } : {}),
        ...(input.cycle !== undefined ? { cycle: input.cycle } : {}),
        ...('targetFound' in input ? { targetFound: input.targetFound } : {}),
        isInsertAction: input.isInsertAction,
        position: input.position,
        targetComponentName: input.targetComponentName,
        startupOrder: result.startupOrder,
      });

      return result;
    });
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
    // The lists the registration already read - none, for one refused before reading
    // any - so building a refusal runs no caller code. Reading them here ran every
    // component's `getDependencies()` for a refusal made during a shutdown, and a read
    // that registered again was refused the same way, recursing.
    dependencySnapshot: ReadonlyMap<BaseComponent, DependencyRead>;
  }): InsertComponentAtResult {
    let startupOrder: string[];

    try {
      // Only from a snapshot that read every registered component. One refused before
      // reading - an invalid position, a shutdown - or cut short by a shutdown has no
      // list for some of them, and ordering those as though they had no dependencies
      // reported an order that ignored them. Empty, rather than an order that is not the
      // startup order - on the result and on `registration-rejected` alike.
      const isSnapshotComplete = this.state.components.every((component) =>
        this.isReadCurrent(input.dependencySnapshot, component),
      );

      startupOrder = isSnapshotComplete
        ? this.core.startupOrdering.getStartupOrderInternal(
            undefined,
            undefined,
            input.dependencySnapshot,
          )
        : [];
    } catch (error) {
      // Defensive: This should never happen in normal operation since we validate
      // cycles before registration. However, if this.components somehow contains
      // a cycle (e.g., due to internal bugs or direct mutations), we must not
      // throw from an error handler. Return empty array to fail gracefully.
      const err = toError(error);

      this.logger.warn(
        'Failed to compute startup order in error handler: {{error.message}}',
        {
          params: { error: err },
        },
      );

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
      manualPositionRespected: undefined,
      targetFound: input.targetFound,
      duringStartup: this.state.isStarting,
      autoStartAttempted: false,
      startResult: undefined,
    };
  }

  private getComponentIndex(name: string): number | null {
    // The name index holds the first committed entry with this name, published with
    // `components` itself (`publishRegistry()`), so its position is the one a scan by
    // name would find - and a name nothing holds needs no scan at all.
    const component = this.state.componentsByName.get(name);
    const idx =
      component === undefined ? -1 : this.state.components.indexOf(component);
    return idx === -1 ? null : idx;
  }

  private isInstanceReserved(component: BaseComponent): boolean {
    return (
      this.state.componentEntries.includes(component) ||
      this.state.rollbackReservations.has(component)
    );
  }

  private isNameReserved(name: string): boolean {
    if (
      this.state.componentEntries.some(
        (component) => this.nameOf(component) === name,
      )
    ) {
      return true;
    }
    for (const reservedName of this.state.rollbackReservations.values()) {
      if (reservedName === name) {
        return true;
      }
    }
    return false;
  }

  /** Current-generation dependency metadata, without running caller getters. */
  private currentReadOf(
    component: BaseComponent,
    snapshot: ReadonlyMap<BaseComponent, DependencyRead>,
    preferred?: ReadonlyMap<BaseComponent, DependencyRead>,
  ): DependencyRead | undefined {
    if (preferred !== undefined && this.isReadCurrent(preferred, component)) {
      return preferred.get(component);
    }
    return (
      (this.isReadCurrent(snapshot, component)
        ? snapshot.get(component)
        : undefined) ?? this.state.committedDependencyReads.get(component)
    );
  }

  /** Publish the live committed subset after registry mutations, without caller code. */
  private publishRegistry(): void {
    const published = this.state.componentEntries.filter(
      (component) => !this.state.pendingRegistrations.has(component),
    );
    if (
      published.length !== this.state.components.length ||
      published.some((entry, index) => this.state.components[index] !== entry)
    ) {
      this.state.components = published;
      const byName = new Map<string, BaseComponent>();
      for (const component of published) {
        const name = this.nameOf(component);
        // The first entry wins, as a scan of the registry would find it.
        if (!byName.has(name)) {
          byName.set(name, component);
        }
      }
      this.state.componentsByName = byName;
    }
  }

  private getInsertIndex(
    position: InsertPosition,
    targetComponentName?: string,
  ): number | null {
    if (position === 'start') {
      return 0;
    } else if (position === 'end') {
      return this.state.componentEntries.length;
    } else if (position !== 'before' && position !== 'after') {
      return null;
    }

    // Targets must be published, but placement is adjacent to that exact instance
    // in the reserved order. Translating through its next committed neighbour would
    // put an "after" insertion beyond an interleaved provisional component.
    const target = this.getComponent(targetComponentName ?? '');
    if (target === undefined) {
      return null;
    }
    const targetIdx = this.state.componentEntries.indexOf(target);
    if (position === 'before') {
      return targetIdx;
    } else {
      return targetIdx + 1;
    }
  }

  // Kept as a method, not inlined: it is the seam tests use to fail a registration
  // right after its commit.
  private isManualPositionRespected(input: {
    componentName: string;
    position: InsertPosition;
    targetComponentName?: string;
    startupOrder: string[];
  }): boolean {
    return isManualPositionRespected(input);
  }

  private isReadCurrent(
    reads: ReadonlyMap<BaseComponent, unknown>,
    component: BaseComponent,
  ): boolean {
    return this.registrationReads.isReadCurrent(reads, component);
  }

  private readRegistry<T>(
    read: (component: BaseComponent) => T,
    reads: Map<BaseComponent, T> = new Map(),
    canContinue: () => boolean = () => true,
    onSettled?: () => void,
    source: () => BaseComponent[] = () => this.state.components,
  ): { reads: Map<BaseComponent, T>; isSettled: boolean } {
    return this.registrationReads.readRegistry(
      read,
      reads,
      canContinue,
      onSettled,
      source,
    );
  }

  /**
   * A component's name, as recorded when it was registered.
   *
   * Read once, at registration - where it is validated, and where a `getName()` that
   * throws fails the registration and nothing else - and never again. The manager looks
   * names up in dozens of places, including the middle of broadcasts, health checks and
   * shutdown passes; re-reading each time meant a component that broke its contract
   * could crash any of them. The entry outlives an unregister, so work still in flight
   * can name the instance, and a later registration of the same instance reads the name
   * fresh and overwrites it on commit. Falls back to asking the component only for an
   * instance that was never registered.
   */
  private nameOf(component: BaseComponent): string {
    const recordedName = this.state.registeredNames.get(component);

    return recordedName !== undefined ? recordedName : component.getName();
  }

  /**
   * {@link nameOf} for the registry entry at `index`, or `undefined` when there is none.
   */
  private nameOfAt(index: number): string | undefined {
    const component = this.state.components[index];

    return component === undefined ? undefined : this.nameOf(component);
  }

  /**
   * Shared dispatch path for reload/info/debug requests. Logs the dispatch,
   * emits the signal event, then either invokes the user-supplied callback
   * (passing the broadcast function so the user controls when/whether to
   * broadcast) or broadcasts directly when no callback is configured.
   *
   * When called from signal handlers (source='signal'), the Promise is started
   * but not awaited — Node.js signal handlers cannot return values, so results
   * are not accessible. Components are still notified and the work completes.
   * When called from manual triggers (source='trigger'), the Promise is awaited
   * and results are returned for programmatic use.
   */
  private async handleSignalRequest(
    descriptor: {
      signal: 'reload' | 'info' | 'debug';
      dispatchedLogLabel: string;
      emitSignal: () => void;
      customCallback?: (
        broadcastFn: () => Promise<SignalBroadcastResult>,
      ) => void | Promise<void>;
      broadcast: () => Promise<SignalBroadcastResult>;
    },
    source: 'signal' | 'trigger',
  ): Promise<SignalBroadcastResult> {
    this.logger.info(descriptor.dispatchedLogLabel, { params: { source } });
    descriptor.emitSignal();

    if (descriptor.customCallback) {
      // Guarded: the callback is the caller's, and a throw or rejection from it rejected
      // `triggerReload()` and friends. It is reported, and the result says `error`.
      // The broadcast handed to the callback is settled as well, so a callback that
      // fires it without awaiting - `void broadcast()` - can never be left holding an
      // unhandled rejection.
      const outcome = await safeHandleCallbackAndWait(
        `lifecycle-manager ${descriptor.signal} request callback`,
        descriptor.customCallback,
        (): Promise<SignalBroadcastResult> =>
          settleOperation(
            `${descriptor.signal} broadcast`,
            descriptor.broadcast,
            (error, _reason, code) =>
              crashedSignalBroadcastResult(descriptor.signal, error, code),
          ),
      );

      if (!outcome.success) {
        return failedSignalCallbackResult(descriptor.signal, outcome.error);
      }

      // Return empty result (custom callback handled it)
      return {
        signal: descriptor.signal,
        results: [],
        timedOut: false,
        code: 'ok',
      };
    }

    return await descriptor.broadcast();
  }

  private async handleReloadRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return await this.handleSignalRequest(
      {
        signal: 'reload',
        dispatchedLogLabel: 'Reload dispatched',
        emitSignal: () => this.lifecycleEvents.signalReload(),
        customCallback: this.config.onReloadRequested,
        broadcast: () => this.broadcastReload(),
      },
      source,
    );
  }

  private async handleInfoRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return await this.handleSignalRequest(
      {
        signal: 'info',
        dispatchedLogLabel: 'Info dispatched',
        emitSignal: () => this.lifecycleEvents.signalInfo(),
        customCallback: this.config.onInfoRequested,
        broadcast: () => this.broadcastInfo(),
      },
      source,
    );
  }

  private async handleDebugRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return await this.handleSignalRequest(
      {
        signal: 'debug',
        dispatchedLogLabel: 'Debug dispatched',
        emitSignal: () => this.lifecycleEvents.signalDebug(),
        customCallback: this.config.onDebugRequested,
        broadcast: () => this.broadcastDebug(),
      },
      source,
    );
  }

  /**
   * Broadcast reload signal to all running components.
   * Calls onReload() on components that implement it.
   * Continues on errors - collects all results.
   */
  private broadcastReload(): Promise<SignalBroadcastResult> {
    return runSignalBroadcast(this.componentAccess, {
      signal: 'reload',
      pickHandler: (component) => Reflect.get(component, 'onReload'),
      startupLog:
        'Reload during startup: only reloading already-started components',
      timeoutLog: 'Reload handler timed out',
      errorLog: 'Reload failed: {{error.message}}',
      emitStarted: (name) => this.lifecycleEvents.componentReloadStarted(name),
      emitCompleted: (name) =>
        this.lifecycleEvents.componentReloadCompleted(name),
      emitFailed: (name, error) =>
        this.lifecycleEvents.componentReloadFailed(name, error),
    });
  }

  /**
   * Broadcast info signal to all running components.
   * Calls onInfo() on components that implement it.
   * Continues on errors - collects all results.
   */
  private broadcastInfo(): Promise<SignalBroadcastResult> {
    return runSignalBroadcast(this.componentAccess, {
      signal: 'info',
      pickHandler: (component) => Reflect.get(component, 'onInfo'),
      startupLog:
        'Info during startup: only notifying already-started components',
      timeoutLog: 'Info handler timed out',
      errorLog: 'Info handler failed: {{error.message}}',
      emitStarted: (name) => this.lifecycleEvents.componentInfoStarted(name),
      emitCompleted: (name) =>
        this.lifecycleEvents.componentInfoCompleted(name),
      emitFailed: (name, error) =>
        this.lifecycleEvents.componentInfoFailed(name, error),
    });
  }

  /**
   * Broadcast debug signal to all running components.
   * Calls onDebug() on components that implement it.
   * Continues on errors - collects all results.
   */
  private broadcastDebug(): Promise<SignalBroadcastResult> {
    return runSignalBroadcast(this.componentAccess, {
      signal: 'debug',
      pickHandler: (component) => Reflect.get(component, 'onDebug'),
      startupLog:
        'Debug during startup: only notifying already-started components',
      timeoutLog: 'Debug handler timed out',
      errorLog: 'Debug handler failed: {{error.message}}',
      emitStarted: (name) => this.lifecycleEvents.componentDebugStarted(name),
      emitCompleted: (name) =>
        this.lifecycleEvents.componentDebugCompleted(name),
      emitFailed: (name, error) =>
        this.lifecycleEvents.componentDebugFailed(name, error),
    });
  }
}
