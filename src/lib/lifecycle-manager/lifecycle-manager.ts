import { runShutdownWarningPhase } from './internal/shutdown-warning';
import { ComponentMetadataReader } from './internal/component-metadata-reader';
import { TransitionEventDispatcher } from './internal/transition-event-dispatcher';
import { RegistrationReadTracker } from './internal/registration-read-tracker';
import {
  LifecycleManagerState,
  isStartUnfinished,
  type ShutdownPass,
  type StartSettlement,
} from './internal/manager-state';
import {
  type ManagerConfig,
  type ShutdownPassOptions,
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
  getStartupOrder,
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
  type StopAllOptionsSnapshot,
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
import { observeRejection } from '../internal/intrinsics';
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
  ShutdownMethod,
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
  ForceShutdownContext,
} from './types';
import {
  LifecycleManagerEvents,
  type LifecycleManagerEventMap,
  type LifecycleManagerEventName,
} from './events';
import {
  StartupInterruptedByShutdownError,
  DependencyCycleError,
} from './errors';
import {
  LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP,
  LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE,
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE_EXTERNAL,
  LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
  LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
} from './constants';
import {
  ProcessSignalManager,
  type ShutdownSignal,
} from '../process-signal-manager';
import {
  reportCallbackError,
  safeHandleCallback,
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

/** A shutdown request refused because a pass is already running. */
interface ShutdownPassRefusal {
  readonly accepted: false;
  readonly result: ShutdownResult;
}

/**
 * What `acceptShutdownPass()` answers: either the refusal the caller reports as its own
 * `ShutdownResult`, or the pass it started.
 *
 * Discriminated rather than inferred from whether a callback fired, so a caller can tell
 * the two apart without depending on which statements in between can throw.
 */
type ShutdownPassAcceptance =
  | ShutdownPassRefusal
  | {
      readonly accepted: true;
      readonly pass: ShutdownPass;
      readonly promise: Promise<ShutdownResult>;
    };

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

    if (this.isShuttingDown) {
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
      isShuttingDown: this.isShuttingDown,
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
        startupOrder: this.getStartupOrderInternal(
          this.state.components,
          undefined,
          reads,
        ),
      };
    } catch (error) {
      return {
        success: false,
        startupOrder: [],
        ...this.answerStartupOrderFailure(
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
        this.startAllComponentsOperation(() => snapshotStartupOptions(options)),
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
      () => this.stopAllComponentsOperation(options),
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
            this.handleShutdownRequest(method);
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
    if (this.config.repeatedShutdownRequestPolicy === undefined) {
      return {
        configured: false,
        isShuttingDown: this.isShuttingDown,
        isArmed: false,
        forceAfterCount: null,
        withinMS: null,
        armedAfterFailureMS: null,
        armedAfterFailureMSSource: null,
        requestCount: 0,
        firstMethod: null,
        latestMethod: null,
        firstRequestAt: null,
        latestRequestAt: null,
        repeatedWindowStartedAt: null,
        armedUntil: null,
        hasTriggeredForceShutdown: false,
      };
    }

    this.normalizeRepeatedShutdownRequestStateArmedStatus();

    const armedUntil =
      this.state.repeatedShutdownRequestState.remainsArmedUntil;
    const isArmed = armedUntil !== null;

    return {
      configured: true,
      isShuttingDown: this.isShuttingDown,
      isArmed,
      forceAfterCount:
        this.config.repeatedShutdownRequestPolicy.forceAfterCount,
      withinMS: this.config.repeatedShutdownRequestPolicy.withinMS,
      armedAfterFailureMS:
        this.config.repeatedShutdownRequestPolicy.armedAfterFailureMS,
      armedAfterFailureMSSource: this.config.repeatedShutdownRequestPolicy
        .hasExplicitArmedAfterFailureMS
        ? 'explicit'
        : 'derived',
      countManualRetriesTowardEscalation:
        this.config.repeatedShutdownRequestPolicy
          .countManualRetriesTowardEscalation,
      requestCount: this.state.repeatedShutdownRequestState.requestCount,
      firstMethod: this.state.repeatedShutdownRequestState.firstMethod,
      latestMethod: this.state.repeatedShutdownRequestState.latestMethod,
      firstRequestAt: this.state.repeatedShutdownRequestState.firstRequestAt,
      latestRequestAt: this.state.repeatedShutdownRequestState.latestRequestAt,
      repeatedWindowStartedAt:
        this.state.repeatedShutdownRequestState.repeatedWindowStartedAt,
      armedUntil: isArmed ? armedUntil : null,
      hasTriggeredForceShutdown:
        this.state.repeatedShutdownRequestState.hasTriggeredForceShutdown,
    };
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
      get isShuttingDown() {
        return manager.isShuttingDown;
      },
      noteShutdownRequestDuringActivePass: () =>
        manager.noteShutdownRequestDuringActivePass(),
      getComponent: (name) => manager.getComponent(name),
      nameOf: (component) => manager.nameOf(component),
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
      this.isShuttingDown ||
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
          isShuttingDown: this.isShuttingDown,
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

  /** Refuse an active bulk operation before reading unused caller options. */
  private refuseActiveBulkStartup(
    startTime: number,
  ): StartupResult | undefined {
    // Reject if already starting
    if (this.state.isStarting) {
      this.logger.warn(
        'Cannot start all components: startup already in progress',
      );

      return refusedStartupResult(
        'already_in_progress',
        'Startup already in progress',
        Date.now() - startTime,
      );
    }

    // Reject if shutdown is in progress
    if (this.isShuttingDown) {
      this.logger.warn('Cannot start all components: shutdown in progress');

      return refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        Date.now() - startTime,
      );
    }

    // Reject once a logger exit has committed the process to ending, or while a simulated
    // one is still closing the sinks
    if (this.core.loggerExit.isLoggerExitInProgress()) {
      this.logger.warn('Cannot start all components: process is exiting');

      return refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
        Date.now() - startTime,
      );
    }

    return undefined;
  }

  /**
   * `readOptions` takes the options snapshot: the caller's object for a public startup,
   * or the one a restart already took. Called once, after the refusals that need no
   * options.
   */
  private async startAllComponentsOperation(
    readOptions: () => StartupOptionsSnapshot,
    restartSnapshots?: Map<string, RestartStartSnapshot>,
  ): Promise<StartupResult> {
    const startTime = Date.now();
    const alreadyActive = this.refuseActiveBulkStartup(startTime);
    if (alreadyActive) {
      return alreadyActive;
    }
    // Every option is read up front, before the startup takes its latch: `options` is
    // the caller's object, and a getter that threw once `isStarting` was set left it set
    // for good. The timeout is only validated once the availability refusals below are
    // past - still before the latch: a startup that refuses never uses it, and an
    // availability refusal takes precedence over an option that would not be used.
    const startupOptions = readOptions();
    const shouldIgnoreStalledComponents =
      startupOptions.ignoreStalledComponents;
    const requestedTimeoutMS = startupOptions.timeoutMS;

    // Option getters can start a nested operation. Keep the post-read check too;
    // passing the initial guard does not reserve the startup latch.
    const becameActive = this.refuseActiveBulkStartup(startTime);
    if (becameActive) {
      return becameActive;
    }

    const totalCount = this.getComponentCount();
    const runningCount = this.getRunningComponentCount();

    if (totalCount === 0) {
      this.logger.warn('Cannot start all components: none registered');

      return refusedStartupResult(
        'no_components_registered',
        'No components registered',
        Date.now() - startTime,
      );
    }

    // Check for stalled components
    if (
      this.state.stalledComponents.size > 0 &&
      !shouldIgnoreStalledComponents
    ) {
      const stalledNames = Array.from(this.state.stalledComponents.keys());
      this.logger.warn('Cannot start: stalled components exist', {
        params: { stalled: stalledNames },
      });

      return {
        ...refusedStartupResult(
          'stalled_components_exist',
          'Stalled components exist',
          Date.now() - startTime,
        ),
        blockedByStalledComponents: stalledNames,
      };
    }

    // A component still stopping is counted as running, but it is on its way down: the
    // shortcut below would report it "already running" - listing it as started though
    // its `start()` never ran - and a start of it now would only be refused. Refused
    // until the stop settles, as a partial state is. A late start's cleanup marks its
    // component running only so it can be stopped, so it is on its way down too.
    const stillStartingNames: string[] = [];
    const stillStoppingNames = this.getComponentNames().filter((name) => {
      const state = this.state.componentStates.get(name);
      if (state === 'starting') {
        stillStartingNames.push(name);
      }

      return (
        state === 'stopping' ||
        state === 'force-stopping' ||
        this.state.pendingBulkStartupCleanup.has(name)
      );
    });

    if (stillStoppingNames.length > 0) {
      this.logger.warn('Cannot start: components are still stopping', {
        params: { stopping: stillStoppingNames },
      });

      return {
        ...refusedStartupResult(
          'partial_state',
          `Components are still stopping: ${stillStoppingNames.join(', ')}`,
          Date.now() - startTime,
        ),
        // Teardown can retain running-set membership until it settles. Report
        // only siblings still in running state, using the live state after the log.
        startedComponents: this.runningStartupSnapshot(),
      };
    }

    // Independent starts (including completion-callback auto-starts) do not hold
    // the bulk latch. They still own their components; a new bulk pass must neither
    // count unfinished work as started nor treat its refusal as a component failure.
    if (stillStartingNames.length > 0) {
      this.logger.warn('Cannot start: components are still starting', {
        params: { starting: stillStartingNames },
      });
      return {
        ...refusedStartupResult(
          'partial_state',
          `Components are still starting: ${stillStartingNames.join(', ')}`,
          Date.now() - startTime,
        ),
        // Match the already-running partial-state result below: pending starts
        // are excluded, but completed components remain visible to the caller.
        startedComponents: this.runningStartupSnapshot(),
      };
    }

    // Stalled components this startup would skip (`ignoreStalledComponents`): they are
    // neither running nor left for it to start, so they count toward neither side.
    const stalledToSkip = (): string[] =>
      shouldIgnoreStalledComponents
        ? this.getComponentNames().filter((name) =>
            this.state.stalledComponents.has(name),
          )
        : [];

    // All running - nothing to do. At least one: an empty registry was refused above,
    // and one whose components are all stalled is left to the startup below to skip.
    if (
      runningCount > 0 &&
      runningCount === totalCount - stalledToSkip().length
    ) {
      this.logger.info('All components already running');
      // The sink can begin teardown or change registrations. Decide from the same
      // post-log snapshot we return, rather than the count captured before it ran.
      const startedComponents = this.runningStartupSnapshot();
      const skippedDueToStall = stalledToSkip();
      const isStillAllRunning =
        startedComponents.length > 0 &&
        startedComponents.length ===
          this.state.components.length - skippedDueToStall.length &&
        !this.isShuttingDown &&
        !this.state.isStarting;
      return {
        success: isStillAllRunning,
        startedComponents,
        ...(isStillAllRunning
          ? {}
          : {
              code: 'partial_state' as const,
              reason: 'Component availability changed while confirming startup',
            }),
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        // As the startup below reports the stalled components it skipped.
        ...(skippedDueToStall.length > 0 ? { skippedDueToStall } : {}),
        durationMS: Date.now() - startTime,
      };
    }

    // Partial state - reject to avoid inconsistent startup
    if (runningCount > 0) {
      // Neither latch is held here: `refuseActiveBulkStartup()` refused both, and
      // nothing since has run caller code.
      this.logger.error(
        `Cannot start: ${runningCount}/${totalCount} components already running. ` +
          `Call stopAllComponents() first to ensure clean state.`,
      );

      // Refusal was decided before logging and must not become a new startup or
      // a success because a sink changed state. Keep that decision distinct from
      // the live snapshot: a current count of zero is not why this call refused.
      // Latches matter even when the newly started operation has not changed any
      // component state yet. These reads run no caller code, so names and wording
      // describe the same post-log moment without another re-entrant diagnostic.
      const startedComponents = this.runningStartupSnapshot();
      const registeredCount = this.state.components.length;
      const didChangeDuringLog =
        startedComponents.length !== runningCount ||
        registeredCount !== totalCount ||
        this.state.isStarting ||
        this.isShuttingDown;
      let reason = `${runningCount} of ${totalCount} components already running`;
      if (didChangeDuringLog) {
        reason =
          `Startup refused because ${runningCount} of ${totalCount} components were already running. ` +
          `Currently ${startedComponents.length} of ${registeredCount} components are running.`;
        if (this.isShuttingDown) {
          reason += ' A shutdown is now in progress.';
        }
        if (this.state.isStarting) {
          reason += ' A startup is now in progress.';
        }
      }
      return {
        ...refusedStartupResult(
          'partial_state',
          reason,
          Date.now() - startTime,
        ),
        startedComponents,
      };
    }

    const effectiveTimeout = resolveOperationTimeoutMS(
      requestedTimeoutMS,
      this.config.startupTimeoutMS,
      'startAllComponents timeoutMS',
    );

    // The latch goes up before the attach, not after it: attaching emits
    // `lifecycle-manager:signals-attached` synchronously, and a listener that calls
    // `startAllComponents()` from there must find a startup already in progress rather
    // than run a second one alongside this. Only the restart handoff below (and the
    // auto-attach flag) moves before the attach; the shutdown state this startup resets waits until the attach has
    // succeeded and no shutdown has begun, so a refusal releases the latch, which also
    // reports the handed-off auto-starts as abandoned.
    this.state.isStarting = true;
    // The startup that actually takes the latch owns the current registry, even if
    // a listener started it before the original restart resumed. Transfer every
    // pending handoff before signal attachment can run caller code, and empty each
    // token so an older restart finalizer cannot warn for work already claimed.
    for (const names of this.state.pendingRestartAutoStarts) {
      for (const name of names) {
        if (this.getComponent(name) !== undefined) {
          this.state.deferredAutoStartNames.add(name);
        }
      }
      names.clear();
    }
    this.state.pendingRestartAutoStarts.clear();
    this.state.autoAttachedSignalsDuringStartup = false;

    // This startup's baseline for every "did a shutdown start meanwhile" check below,
    // including the one right after the attach.
    const shutdownTokenAtBulkStart = this.state.shutdownToken;
    const hasShutdownBegun = (): boolean =>
      this.isShuttingDown ||
      this.state.shutdownToken !== shutdownTokenAtBulkStart;

    // Tracked so failure cleanup does not detach handlers that were attached earlier by
    // some other path.
    const bulkSignalAttach = this.config.attachSignalsBeforeStartup
      ? this.autoAttachSignals('bulk startup')
      : null;

    if (bulkSignalAttach?.outcome === 'failed') {
      // The attach's own failure report ran caller code - a logger sink - that may have
      // registered an auto-start and left it to this startup, which will not run.
      this.releaseStartupLatch({
        didAutoAttachSignals: false,
        detachReason: 'refused bulk startup',
        abandonReason: 'refused: process signals could not be attached',
      });

      return {
        ...refusedStartupResult(
          'signal_attach_failed',
          `Could not attach process signals: ${describeError(bulkSignalAttach.error)}`,
          Date.now() - startTime,
        ),
        error: bulkSignalAttach.error,
      };
    }

    const didAutoAttachSignalsForBulkStartup =
      bulkSignalAttach?.outcome === 'attached';

    // The other thing a `signals-attached` listener can do: start a shutdown. That pass
    // is running now, with its own token, method, and escalation state - adopting the
    // new token as this startup's baseline, and resetting that state under it, would
    // have hidden it from every check below. Refuse as a startup arriving during a
    // shutdown is refused.
    if (hasShutdownBegun()) {
      this.releaseStartupLatch({
        didAutoAttachSignals: didAutoAttachSignalsForBulkStartup,
        detachReason: 'refused bulk startup',
        abandonReason: 'refused: a shutdown started',
      });

      return refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        Date.now() - startTime,
      );
    }

    // Clear previous shutdown state
    this.state.unexpectedStopsDuringStartup.clear();
    this.resetRepeatedShutdownRequestState();
    this.state.shutdownMethod = null; // Clear previous shutdown method on fresh start
    this.state.lastShutdownResult = null; // Clear last shutdown result on fresh start

    this.logger.info('Starting all components');

    const startedComponents: string[] = [];
    const failedOptionalComponents: Array<{ name: string; error: Error }> = [];
    const skippedDueToDependency = new Set<string>();
    const skippedDueToStall = new Set<string>();
    let hasTimedOut = false;
    let abandonReason = 'failed before starting components';
    let detachReason = 'failed bulk startup';
    let timeoutHandle: NodeJS.Timeout | undefined;

    const bulkDelay = effectiveTimeout;
    const deadline = bulkDelay > 0 ? Date.now() + bulkDelay : undefined;
    const expireStartup = (): void => {
      if (hasTimedOut) {
        return;
      }
      hasTimedOut = true;
      abandonReason = 'timed out';
      this.logger.warn('Startup timeout exceeded, returning partial results', {
        params: { timeoutMS: effectiveTimeout },
      });
    };
    // The startup deadline bounds starts. Rollback has its own stop timeouts.
    if (bulkDelay > 0) {
      timeoutHandle = setTimeout(expireStartup, bulkDelay);
    }

    const deadlineContext =
      deadline === undefined
        ? undefined
        : { deadline, onTimeout: expireStartup, hasExpired: () => hasTimedOut };

    // Every rollback in this startup goes through here, tracking which names it has
    // already rolled back: one that throws partway - and lands in the `catch` below,
    // which rolls back too - neither stops the same component twice nor skips the ones
    // it had not reached.
    const rolledBackNames = new Set<string>();
    const bulkStartup = {
      dependencyReads: new Map<BaseComponent, DependencyRead>(),
      isRollingBack: false,
      isOrdering: true,
      isCompleting: false,
      initialOrderNames: new Set<string>(),
      reachedNames: new Set<string>(),
      frozenAutoStarts: new Set<string>(),
    };
    const rollBackOnce = async (names: string[]): Promise<void> => {
      if (hasShutdownBegun()) {
        return;
      }
      abandonReason = 'failed and rolled back';
      bulkStartup.isRollingBack = true;
      await this.rollbackStartup(names, rolledBackNames, hasShutdownBegun);
    };

    const operation = async (): Promise<StartupResult> => {
      // Exposed while this startup runs, so an `autoStart` registration made from one of
      // its listeners joins it - and its rollback - rather than escaping both.
      this.state.activeBulkStartup = bulkStartup;

      // What every answer of this startup reports of its progress, read as it answers:
      // what is still running of what it started, and what it had already given up on.
      const startupProgress = (): Pick<
        StartupResult,
        | 'startedComponents'
        | 'failedOptionalComponents'
        | 'skippedDueToDependency'
      > => ({
        startedComponents: this.runningStartupSnapshot(startedComponents),
        failedOptionalComponents,
        skippedDueToDependency: Array.from(skippedDueToDependency),
      });
      // A startup that failed part-way: its progress, and why it failed.
      const failedStartup = (
        failure: Pick<StartupResult, 'reason' | 'code'> &
          Partial<Pick<StartupResult, 'error' | 'timedOut'>>,
      ): StartupResult => ({
        success: false,
        ...startupProgress(),
        ...failure,
        durationMS: Date.now() - startTime,
      });

      // The answer for a startup a shutdown cut short, wherever it notices. Shutdown
      // retains running-set membership while stop hooks settle; that teardown is
      // no longer available and must not be reported as a successful startup.
      const abortedByShutdown = (
        reason = 'Shutdown triggered during startup',
        error?: Error,
      ): StartupResult => {
        abandonReason = 'was interrupted by shutdown';
        detachReason = 'interrupted bulk startup';
        return failedStartup({
          reason,
          code: 'shutdown_in_progress',
          ...(error === undefined ? {} : { error }),
        });
      };

      // Where the startup itself notices a shutdown begun by caller code it ran. The log
      // comes first: `abortedByShutdown()` snapshots what is still running after it.
      const abortOnShutdownSignal = (): StartupResult => {
        this.logger.warn('Shutdown signal received during startup, aborting');
        return abortedByShutdown();
      };

      const unexpectedStopFailure = (error: Error): StartupResult => {
        // Rollback preparation and stop hooks also run caller code. A shutdown
        // accepted while awaiting rollback owns the resulting teardown snapshot.
        if (hasShutdownBegun()) {
          return abortedByShutdown();
        }
        return failedStartup({
          reason: describeError(error),
          code: 'component_unexpected_stop',
          error,
        });
      };
      type ReconciliationOutcome =
        | { kind: 'result'; value: StartupResult }
        | { kind: 'rollback'; pending: Promise<void>; error: Error };
      const finishReconciliationRollback = async (
        outcome: Extract<ReconciliationOutcome, { kind: 'rollback' }>,
      ): Promise<StartupResult> => {
        await outcome.pending;
        return unexpectedStopFailure(outcome.error);
      };
      const reconcileOrFail = (): ReconciliationOutcome | undefined => {
        const reconciled =
          this.core.unexpectedStops.consumeUnexpectedStopsDuringStartup(
            startedComponents,
            failedOptionalComponents,
          );
        startedComponents.splice(0, startedComponents.length);
        startedComponents.push(...reconciled.startedComponents);

        // Optionality getters and log sinks can start shutdown. It owns teardown
        // from that point, before any required-stop rollback decision is made.
        if (hasShutdownBegun()) {
          return { kind: 'result', value: abortOnShutdownSignal() };
        }
        if (reconciled.requiredFailure) {
          clearTimeout(timeoutHandle);
          return {
            kind: 'rollback',
            pending: rollBackOnce(startedComponents),
            error: reconciled.requiredFailure.error,
          };
        }
        // Only rollback is awaited; even a shutdown refusal must release its latch
        // without an extra microtask. With no outcome, callers must not yield between
        // successful reconciliation and the next synchronous startup decision.
        return undefined;
      };

      try {
        // Get startup order (topological sort)
        let startupOrder: string[];
        // Every list read once, here, and used both for the order and by the loop below:
        // read again there, a list that answered differently put a component ahead of a
        // dependency it then failed on, and rolled the whole startup back.
        const startupReads = bulkStartup.dependencyReads;
        // Deferred registrations included in any frozen batch still need an
        // abandonment warning if the loop ends before it attempts them.
        const frozenAutoStarts = bulkStartup.frozenAutoStarts;

        try {
          // Every component's list, including those of components the reads themselves
          // register: those are ordered with the rest - their auto-starts deferred to
          // this loop while `isOrdering` holds - rather than left out, or started ahead
          // of dependencies this loop had not started yet. Any read can begin a
          // shutdown; the lists left are then not read under it - their components may
          // be tearing down - and the startup is over, without going on to clear the
          // deferred auto-starts as if it would start them.
          const registryRead = this.readRegistry(
            (component) =>
              this.componentMetadata.readDependenciesReported(
                component,
                'startup',
              ),
            startupReads,
            () => !hasShutdownBegun(),
          );

          if (hasShutdownBegun()) {
            return abortOnShutdownSignal();
          }

          if (!registryRead.isSettled) {
            throw new Error(
              'The registry kept changing while the startup order was being read',
            );
          }

          startupOrder = this.getStartupOrderInternal(
            this.state.components,
            undefined,
            startupReads,
          );
          bulkStartup.isOrdering = false;
          for (const name of startupOrder) {
            bulkStartup.initialOrderNames.add(name);
          }
          // Freeze deferred registrations included in the initial order too. Their
          // start is now this loop's responsibility, but it may leave before them.
          for (const name of this.state.deferredAutoStartNames) {
            frozenAutoStarts.add(name);
          }
          this.state.deferredAutoStartNames.clear();
        } catch (error) {
          const failure = this.answerStartupOrderFailure(
            error,
            'lifecycle-manager startAllComponents',
          );

          return {
            ...refusedStartupResult(
              failure.code,
              failure.reason,
              Date.now() - startTime,
            ),
            error: failure.error,
          };
        }

        // Freeze each batch before attempting it. Hooks can await registration without
        // awaiting a start that depends on the hook's own component finishing first.
        // Frozen names remain protected by their fixed dependency order. Track the
        // unattempted remainder separately so an early exit can still report it.
        const refreshStartupDeadline = (): void => {
          if (deadline !== undefined && Date.now() >= deadline) {
            expireStartup();
          }
        };
        const canContinueOrdering = (): boolean => {
          refreshStartupDeadline();
          return !hasTimedOut && !hasShutdownBegun();
        };
        function* startupBatches(this: LifecycleManager): Generator<string> {
          try {
            yield* startupOrder;
            while (this.state.deferredAutoStartNames.size > 0) {
              if (!canContinueOrdering()) {
                return;
              }
              const registryRead = this.readRegistry(
                (component) =>
                  this.componentMetadata.readDependenciesReported(
                    component,
                    'startup',
                  ),
                startupReads,
                canContinueOrdering,
              );
              if (!canContinueOrdering()) {
                return;
              }
              if (!registryRead.isSettled) {
                throw new Error(
                  'The registry kept changing while the follow-up startup order was being read',
                );
              }
              const batch = this.getStartupOrderInternal(
                this.state.components,
                undefined,
                startupReads,
              ).filter((name) => this.state.deferredAutoStartNames.has(name));
              if (batch.length === 0) {
                throw new Error(
                  'Deferred auto-starts were absent from the follow-up startup order',
                );
              }
              // Freeze the whole batch, including members not yet attempted: later
              // registrations cannot supply a missing dependency to this fixed order.
              for (const name of batch) {
                this.state.deferredAutoStartNames.delete(name);
                frozenAutoStarts.add(name);
              }
              yield* batch;
            }
          } finally {
            // The iterator has ended, so these names can no longer participate in
            // registration checks for this batch. Release reports them with any
            // later batch that was queued but never frozen.
            for (const name of frozenAutoStarts) {
              this.state.deferredAutoStartNames.add(name);
            }
            // Reconciliation and crash reporting can still run caller code before
            // rollback. Keep their registrations owned by this startup until it has
            // actually reached successful terminal notifications.
          }
        }

        // Final reconciliation can run optionality hooks and logging sinks. Any
        // auto-starts they register still belong to this pass, including rollback
        // and its original deadline, so drain them before publishing completion.
        do {
          // Initial and follow-up batches share every deadline and failure check below.
          for (const name of startupBatches.call(this)) {
            // Synchronous starts can exhaust the budget without yielding to timers.
            refreshStartupDeadline();
            if (hasTimedOut) {
              this.logger.warn(
                'Startup timeout reached, stopping component initiation',
              );
              break;
            }
            bulkStartup.reachedNames.add(name);

            const component = this.getComponent(name);
            if (!component) {
              // Should not happen since unregisterComponent() is blocked during startup.
              // Thrown into the crash path, as a component never read is below: skipped,
              // it was in no result list, and the startup could still report success.
              throw new Error(
                `Component "${name}" is in the startup order but not registered`,
              );
            }

            // A skip below runs caller code (logging, isOptional(), skip listeners) that
            // can begin a shutdown. Later components then belong to it: stop here
            // rather than read or announce them under it.
            if (hasShutdownBegun()) {
              return abortOnShutdownSignal();
            }

            // Skip stalled components during bulk startup (even with ignoreStalledComponents:true bulk option)
            if (this.state.stalledComponents.has(name)) {
              frozenAutoStarts.delete(name);
              this.logger
                .entity(name)
                .info('Skipping stalled component during startup');
              skippedDueToStall.add(name);
              continue;
            }

            // Check if any required dependency failed or was skipped
            // The list the order was computed from, handed to the component's own start
            // below too: the order, the skip check and that start all act on one read.
            // Tolerant here - its valid entries still decide the skip - and the start
            // fails it on a broken list; reported when read, in case it is skipped.
            const dependencyRead = startupReads.get(component);

            // Every name in the order was read above, and nothing can be unregistered
            // while the startup runs - so this is a bug, not a component to read now.
            // Thrown, into the crash path that rolls the startup back, rather than
            // skipped: a skipped component is in no result list, and the startup could
            // still report success.
            if (dependencyRead === undefined) {
              throw new Error(
                `Component "${name}" is in the startup order but was never read`,
              );
            }

            const dependencies = dependenciesOf(dependencyRead);
            let shouldSkip = false;
            let skipReason = '';

            for (const depName of dependencies) {
              const depComponent = this.getComponent(depName);
              // Read only where it decides something - a dependency that stalled, was
              // skipped or failed - and guarded: a healthy dependency's `isOptional()`
              // that threw used to crash, and roll back, the whole startup.
              const isDependencyOptional = (): boolean =>
                depComponent !== undefined &&
                this.componentMetadata.isComponentOptional(depComponent);

              // A stalled dependency follows the optional-dependency rule as a skipped or
              // failed one does: an optional one does not block its dependents, which an
              // individual start of them allows too.
              if (skippedDueToStall.has(depName)) {
                if (!isDependencyOptional()) {
                  shouldSkip = true;
                  skipReason = `Dependency "${depName}" is stalled`;
                  break;
                }
                continue;
              }

              if (skippedDueToDependency.has(depName)) {
                if (!isDependencyOptional()) {
                  shouldSkip = true;
                  skipReason = `Dependency "${depName}" was skipped`;
                  break;
                }
                continue;
              }

              if (depComponent) {
                const depState = this.state.componentStates.get(depName);
                if (depState === 'failed' && !isDependencyOptional()) {
                  shouldSkip = true;
                  skipReason = `Dependency "${depName}" failed to start`;
                  break;
                }
              }
            }

            if (shouldSkip) {
              frozenAutoStarts.delete(name);
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
            if (hasShutdownBegun()) {
              return abortOnShutdownSignal();
            }

            // Start the component (allow during bulk startup since we ARE the bulk operation)
            frozenAutoStarts.delete(name);
            // Whether this start's timeout was the bulk deadline's, as opposed to the
            // component's own `startupTimeoutMS`: the bulk timer can also fire after the
            // component's own timer and before this loop resumes, and that timeout is
            // still a required failure to roll back, not a bulk timeout.
            let didStartMeetBulkDeadline = false;
            const startDeadlineContext =
              deadlineContext === undefined
                ? undefined
                : {
                    ...deadlineContext,
                    onTimeout: (): void => {
                      didStartMeetBulkDeadline = true;
                      deadlineContext.onTimeout();
                    },
                  };
            const result =
              await this.core.componentStart.startComponentInternal(
                name,
                snapshotStartOptions({
                  allowDuringBulkStartup: true,
                }),
                // Every follow-up batch shares the original deadline.
                startDeadlineContext,
                dependencyRead,
                bulkStartup.dependencyReads,
                restartSnapshots?.get(name),
              );

            if (hasShutdownBegun()) {
              if (
                result.success ||
                result.code === 'component_already_running'
              ) {
                startedComponents.push(name);
              }
              return abortedByShutdown();
            }

            // A bulk timeout has no completed outcome to account for. Other results
            // must be handled before checking the clock so failures retain their errors
            // and rollback, and already-running components remain in the snapshot.
            // Only a timeout the bulk deadline caused: the component's own one is a
            // failure like any other, even when the bulk deadline has also passed.
            if (
              hasTimedOut &&
              didStartMeetBulkDeadline &&
              result.code === 'component_startup_timeout'
            ) {
              break;
            }

            if (result.success) {
              startedComponents.push(name);
            } else if (result.code === 'component_already_running') {
              // Component is already running - this is fine (might have been started manually)
              // Add to startedComponents so it's tracked as part of this bulk operation
              startedComponents.push(name);
            } else if (
              result.code === 'component_already_starting' ||
              result.code === 'component_already_stopping'
            ) {
              // An independent start may still own a later batch member, including
              // automatic stop cleanup after its signal attachment failed. Late
              // cleanup of an earlier timed-out start uses the same code, but its
              // reason names that unfinished attempt. Do not take over either
              // operation, wait indefinitely, or roll back dependencies it may need.
              const operation =
                result.code === 'component_already_starting'
                  ? 'startup'
                  : 'stop';
              const isLateTimeoutCleanup =
                result.reason ===
                LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP;
              abandonReason = isLateTimeoutCleanup
                ? 'was interrupted by timed-out startup cleanup'
                : `was interrupted by independent component ${operation}`;
              detachReason = 'partial bulk startup';
              return failedStartup({
                code: 'partial_state',
                reason: isLateTimeoutCleanup
                  ? `Component "${name}": ${LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP}`
                  : `Component "${name}" has an independent ${operation} in progress`,
              });
            } else if (result.code === 'shutdown_in_progress') {
              return abortedByShutdown(
                result.reason || 'Shutdown triggered during startup',
                result.error,
              );
            } else if (result.code === 'component_unexpected_stop') {
              // This branch is for components that reported an unexpected stop
              // before startComponentInternal() returned. That is distinct from the
              // post-success reconciliation below, which handles components that
              // had already been counted as started during this bulk pass.
              this.state.unexpectedStopsDuringStartup.delete(name);

              const error =
                result.error ||
                new Error(
                  result.reason || `Component "${name}" stopped unexpectedly`,
                );

              const isOptional =
                this.core.unexpectedStops.noteUnexpectedStopDuringStartup(
                  name,
                  component,
                  error,
                  failedOptionalComponents,
                );
              if (!isOptional) {
                clearTimeout(timeoutHandle);
                await rollBackOnce(startedComponents);
                return unexpectedStopFailure(error);
              }
            } else if (result.code === 'signal_attach_failed') {
              // Fatal to the whole startup, optional component or not: the process was
              // configured to handle signals and cannot, so it does not come up at all.
              // Continuing would retry the attach on every later component, and an all-
              // optional registry would report success with nothing running.
              clearTimeout(timeoutHandle);

              // The failed component itself is included if stopping it again did not take:
              // it is not in `startedComponents`, and leaving it running is exactly what a
              // failed attach must not do.
              await rollBackOnce(
                this.state.runningComponents.has(name)
                  ? [...startedComponents, name]
                  : startedComponents,
              );
              if (hasShutdownBegun()) {
                return abortedByShutdown();
              }

              return {
                ...refusedStartupResult(
                  'signal_attach_failed',
                  result.reason ?? 'Could not attach process signals',
                  Date.now() - startTime,
                ),
                // Whatever the rollback could not stop, so the result matches the registry,
                // excluding teardown as every other failure exit does.
                startedComponents: this.runningStartupSnapshot([
                  ...startedComponents,
                  name,
                ]),
                failedOptionalComponents,
                skippedDueToDependency: Array.from(skippedDueToDependency),
                error: result.error,
              };
            } else {
              // Check if component is optional
              if (this.componentMetadata.isComponentOptional(component)) {
                // Built once, so the log, the event and the result name the same error
                // - one standing in for a result that carried none, too.
                const failure =
                  result.error ||
                  new Error(
                    result.reason || LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
                  );
                this.logger
                  .entity(name)
                  .warn(
                    'Optional component failed to start, continuing: {{error.message}}',
                    { params: { error: failure } },
                  );

                this.lifecycleEvents.componentStartFailedOptional(
                  name,
                  failure,
                );

                // Mark as failed state - unless stopping it again after a crash already
                // left it stalled, which `stalledComponents` still says and the state
                // must agree with. Nor over a component something else now owns -
                // running again, or with another start or stop in flight. Overwritten,
                // its in-flight guard would be gone, and a second `stop()` could run
                // alongside the one already underway.
                const isOwnedElsewhere =
                  this.state.runningComponents.has(name) ||
                  this.core.claims.isInFlight(name);

                if (
                  !this.state.stalledComponents.has(name) &&
                  !isOwnedElsewhere
                ) {
                  this.state.componentStates.set(name, 'failed');

                  if (result.error) {
                    this.state.componentErrors.set(name, result.error);
                  }
                }

                failedOptionalComponents.push({ name, error: failure });
              } else {
                // Required component failed - trigger rollback
                this.logger
                  .entity(name)
                  .error(
                    'Required component failed to start, rolling back: {{error.message}}',
                    {
                      params: {
                        error:
                          result.error ||
                          new Error(
                            result.reason ||
                              LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
                          ),
                      },
                    },
                  );

                clearTimeout(timeoutHandle);
                await rollBackOnce(startedComponents);
                if (hasShutdownBegun()) {
                  return abortedByShutdown();
                }

                return failedStartup({
                  reason:
                    result.reason ||
                    `Required component "${name}" failed: ${result.code || 'unknown'}`,
                  code: 'required_component_failed',
                  error: result.error,
                });
              }
            }

            const reconciliation = reconcileOrFail();
            if (reconciliation !== undefined) {
              return reconciliation.kind === 'rollback'
                ? await finishReconciliationRollback(reconciliation)
                : reconciliation.value;
            }

            // Promise continuations and completion observers can exhaust the budget
            // before timers run. Account for the settled result before expiring startup.
            refreshStartupDeadline();
            if (hasTimedOut) {
              break;
            }
          }

          // Reconcile known stops before timeout reporting, then drain any new
          // reports its sinks produce. Neither successful check yields a microtask.
          const reconciliation = reconcileOrFail();
          if (reconciliation !== undefined) {
            return reconciliation.kind === 'rollback'
              ? await finishReconciliationRollback(reconciliation)
              : reconciliation.value;
          }
          if (hasTimedOut) {
            this.logger.warn('Startup completed with timeout', {
              params: {
                started: startedComponents.length,
                failed: failedOptionalComponents.length,
                skipped: skippedDueToDependency.size + skippedDueToStall.size,
                durationMS: Date.now() - startTime,
                timeoutMS: effectiveTimeout,
              },
            });

            // Timeout reporting can start shutdown, which owns teardown before
            // another reconciliation gets to invoke optionality hooks or logs.
            if (hasShutdownBegun()) {
              return abortOnShutdownSignal();
            }
            const afterTimeoutReporting = reconcileOrFail();
            if (afterTimeoutReporting !== undefined) {
              return afterTimeoutReporting.kind === 'rollback'
                ? await finishReconciliationRollback(afterTimeoutReporting)
                : afterTimeoutReporting.value;
            }
          }

          // Only the first drain includes the original order. Later drains own
          // registrations made by reconciliation, not components already attempted.
          startupOrder = [];
          // Do not expire the deadline in this condition: its log can report a
          // required unexpected stop. The generator checks the deadline before
          // another batch, and the reconciliation above then observes that stop.
        } while (
          this.state.deferredAutoStartNames.size > 0 &&
          !hasTimedOut &&
          !hasShutdownBegun()
        );

        // The loop checks for a shutdown after each start, but the events it emits for
        // the last component - `start-failed-optional`, `start-skipped` - come after that
        // check, and a listener there can start one. Reporting success and emitting
        // `started` would then describe a startup that a shutdown is already undoing.
        if (hasShutdownBegun()) {
          return abortOnShutdownSignal();
        }

        // Check if startup timed out during the process
        if (hasTimedOut) {
          return failedStartup({
            timedOut: true,
            reason: `Startup timeout exceeded (${effectiveTimeout}ms)`,
            code: 'startup_timeout',
          });
        }

        this.updateStartedFlag();
        const skippedComponentsArray = [
          ...Array.from(skippedDueToDependency),
          ...Array.from(skippedDueToStall),
        ];

        const durationMS = Date.now() - startTime;

        // Reconciliation and every rollback decision have finished. Only these
        // successful terminal callbacks can start independent auto-start work.
        // They are notifications of committed success, not another reconciliation
        // phase: reopening rollback here could stop dependencies of that new work.
        // Stops reported here retain their normal stopped event/state, while the
        // result below snapshots availability after both notifications return.
        bulkStartup.isCompleting = true;
        abandonReason = 'completed before deferred auto-starts were attempted';
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

        // Asked once more, after both notifications: each runs caller code, and a
        // `started` listener or log sink that begins a shutdown left this answering
        // `success: true` while `getSystemState()` already said `shutting-down` - the
        // very contradiction the check ahead of them exists to prevent. The `started`
        // event stands, since the startup did complete; the result reports the shutdown
        // that is now undoing it, as a startup a shutdown cut short does.
        if (hasShutdownBegun()) {
          this.logger.warn('Shutdown began as startup completed');
          return abortedByShutdown('Shutdown triggered as startup completed');
        }

        detachReason = 'completed bulk startup';
        return {
          success: true,
          ...startupProgress(),
          durationMS,
          timedOut: false,
        };
      } catch (error) {
        // Something unplanned threw mid-startup - a component getter, say. Handled here
        // rather than left to the public safety net, which cannot see what this startup
        // had already started: rolled back like any other failed startup, so a failure
        // never leaves a partial set running behind a result that says otherwise.
        detachReason = 'failed bulk startup';
        const crashError = toError(error);

        clearTimeout(timeoutHandle);
        const isDependencyCycle = crashError instanceof DependencyCycleError;
        if (isDependencyCycle) {
          // A follow-up can introduce a cycle after earlier batches started. It is
          // the same configuration failure as initial ordering, with rollback now
          // needed for the components this pass has already brought up.
          this.logger.error(
            'Failed to resolve startup order: {{error.message}}',
            {
              params: { error: crashError },
            },
          );
        } else {
          reportCallbackError('lifecycle-manager startAllComponents', error);
        }

        try {
          await rollBackOnce(startedComponents);
          if (hasShutdownBegun()) {
            return abortedByShutdown(undefined, crashError);
          }
        } catch (rollbackError) {
          reportCallbackError(
            'lifecycle-manager startup rollback',
            rollbackError,
          );
        }

        return {
          ...crashedStartupResult(
            crashError,
            `startAllComponents() failed unexpectedly: ${describeError(crashError)}`,
            // Reported above, so a crash even for a branded option refusal: this
            // startup's own options were validated before it took the latch, and
            // anything met since is the startup failing part-way, not a refusal.
            'operation_crashed',
            Date.now() - startTime,
          ),
          ...(isDependencyCycle
            ? {
                code: 'dependency_cycle' as const,
                reason: describeError(crashError),
              }
            : {}),
          // Whatever the rollback could not stop, so the result matches the registry.
          ...startupProgress(),
        };
      } finally {
        // Release the deadline callback when startup settles so it cannot report
        // a timeout after this operation has completed.
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        this.releaseStartupLatch({
          didAutoAttachSignals: didAutoAttachSignalsForBulkStartup,
          detachReason,
          abandonReason,
        });
      }
    };
    // Component starts already race against the bulk deadline. Await their bookkeeping
    // and our finally block before exposing the result to a caller that may retry.
    const result = await operation();
    // Preserve the stalled components actually skipped on every exit, including
    // partial results, failures, and deadlines before the remaining order runs.
    return skippedDueToStall.size === 0
      ? result
      : { ...result, skippedDueToStall: Array.from(skippedDueToStall) };
  }

  /**
   * Everything a bulk startup releases as it ends, from whichever exit: the latch, the
   * signal handlers it attached if it leaves nothing running - or any detach deferred
   * while it held the latch - the startup record, and auto-starts left to it that it
   * never reached. One place, so an early exit cannot forget a step the others take.
   *
   * Every piece of this startup's state is cleared before any caller code runs. The
   * detach logs through the caller's sinks, which may start the next startup. That
   * startup runs synchronously up to its first `await` and installs its own record. Cleared after, that record was wiped out from under it:
   * `isStarting` true with no `activeBulkStartup`, so every auto-start registered for the
   * rest of it was deferred, never started, and left out of its rollback.
   */
  private releaseStartupLatch(input: {
    didAutoAttachSignals: boolean;
    detachReason: string;
    abandonReason: string;
  }): void {
    return this.withTransition(() => {
      const shouldDetach =
        input.didAutoAttachSignals ||
        this.state.autoAttachedSignalsDuringStartup;
      const abandonedAutoStarts = Array.from(this.state.deferredAutoStartNames);

      // `isStarting` first of all: the detach below defers while it is set.
      this.state.isStarting = false;
      this.state.autoAttachedSignalsDuringStartup = false;
      this.state.activeBulkStartup = null;
      this.state.deferredAutoStartNames.clear();
      this.state.unexpectedStopsDuringStartup.clear();

      if (shouldDetach) {
        this.detachSignalsIfIdle(input.detachReason);
      } else {
        this.runDeferredSignalDetach('bulk startup');
      }

      // A startup begun from the detach (or a listener before this drains) reads the
      // whole registry, so it would start these too. Handed to its deferred set rather
      // than dropped: that startup can itself fail before reaching them, and only names
      // it owns are frozen into its order or reported as abandoned when it ends.
      this.eventDispatcher.afterNotifications(() => {
        const nextStartup = this.state.activeBulkStartup;
        if (
          this.state.isStarting &&
          (nextStartup === null || nextStartup.isOrdering)
        ) {
          for (const name of abandonedAutoStarts) {
            if (this.getComponent(name) !== undefined) {
              this.state.deferredAutoStartNames.add(name);
            }
          }
          return;
        }

        // One that has already frozen its order no longer collects deferred names, but
        // that order is the registry it read: the names in it are its to start, not
        // abandoned. The detach's own log runs its sinks ahead of this callback, so a
        // startup begun there has always ordered by now - and warning for every name
        // said "not attempted" of auto-starts it was about to start. Frozen into its
        // auto-starts instead, as a registration made after its order is, so it is the
        // one to report any it leaves before reaching; only names outside its order
        // are this startup's to report.
        const notTakenOver =
          this.state.isStarting && nextStartup !== null
            ? abandonedAutoStarts.filter((name) => {
                if (!nextStartup.initialOrderNames.has(name)) {
                  return true;
                }
                if (!nextStartup.reachedNames.has(name)) {
                  nextStartup.frozenAutoStarts.add(name);
                }
                return false;
              })
            : abandonedAutoStarts;
        this.warnAbandonedAutoStarts(notTakenOver, input.abandonReason);
      });
    });
  }

  private async stopAllComponentsOperation(
    options?: StopAllOptions,
  ): Promise<ShutdownResult> {
    // Always the manual method for the public API, as it is not from a signal. A direct
    // stop call made while a shutdown is running expresses the same intent a signal
    // does, so a refusal is recorded on the running pass - before reading `options`:
    // they are the caller's, and a getter that threw there skipped this refusal, so a
    // request to stay down was never recorded and a restart started everything again.
    const refusal = this.withTransition(() =>
      this.refuseShutdownPassWhileActive('manual', true),
    );
    if (refusal !== undefined) {
      return refusal.result;
    }

    // Read once, outside the acceptance's transition. Its getters are caller code, and
    // can begin a shutdown: the acceptance checks the latch again first.
    const acceptance = this.acceptShutdownPass(
      'manual',
      snapshotStopAllOptions(options),
      true,
    );

    return acceptance.accepted ? await acceptance.promise : acceptance.result;
  }

  /** A refused restart owns no stop pass and cannot cancel the active one. */
  private refuseRestartDuringActiveShutdown(): RestartResult | undefined {
    if (!this.isShuttingDown) {
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
      !this.isUnresolvedTimedOutStart(settlement);
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
    this.normalizeRepeatedShutdownRequestStateArmedStatus();
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
    const unresolvedStarts = this.unresolvedTimedOutStartNames();
    if (unresolvedStarts.length > 0) {
      return refuseBeforeStop(
        `Abandoned start still unresolved for: ${unresolvedStarts.join(', ')}; restart refused before stopping anything, startup skipped`,
        'cleanup_incomplete',
      );
    }

    const pendingAutoStarts = new Set<string>();
    try {
      // Phase 1: Stop all components (explicit defaults for restart semantics)
      const stopPhase = this.acceptShutdownPass(
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
          this.startAllComponentsOperation(
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
      this.warnAbandonedAutoStarts(
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
   * A start that already timed out - abandoned to late cleanup, or settled by its abort
   * hook - while its raw `start()` is still unresolved. A shutdown pass does not spend
   * its budget waiting for one, and reports it as `cleanup_incomplete`.
   */
  private isUnresolvedTimedOutStart(
    settlement: StartSettlement | undefined,
  ): boolean {
    return (
      settlement !== undefined &&
      settlement.rawStartPending &&
      (settlement.isAwaitingLateStart === true || settlement.didSettle)
    );
  }

  /** Names whose current start is {@link isUnresolvedTimedOutStart}, in registry order. */
  private unresolvedTimedOutStartNames(): string[] {
    const currentStarts = this.core.componentStart.currentStartSettlements();
    return this.state.components
      .map((component) => this.nameOf(component))
      .filter((name) =>
        this.isUnresolvedTimedOutStart(currentStarts.get(name)),
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
        isInsertPosition(position) && !this.isShuttingDown;
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
      if (!registryRead.isSettled && !this.isShuttingDown) {
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
      if (this.isShuttingDown) {
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
        this.isRequiredDependencyDuringStartup(
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
        startupOrder = this.getStartupOrderInternal(
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
          if (this.isShuttingDown) {
            interruptionCode = 'shutdown_in_progress';
            rollBack();
            return;
          }
          // Startup can also begin inside either hook. Its order excludes this
          // provisional entry, so publishing a dependency needed by that pass would
          // contradict the same ordering rule checked before calling the hooks.
          if (
            this.isRequiredDependencyDuringStartup(
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
                ? this.getStartupOrderInternal(
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

  /**
   * Decide whether a shutdown pass may start, and start it when it may.
   *
   * Synchronous, and split from the pass itself, because every caller has to know which
   * of the two happened before it does anything else: the `ShutdownResult` a refused
   * `stopAllComponents()` reports, whether a signal needs to note a running pass, and
   * whether a `restartAllComponents()` owns a pass a request could cancel
   * all fall out of this one answer rather than being inferred afterwards.
   *
   * Everything that can throw is on this side of the latch, so a throw is a synchronous
   * throw to the caller with no pass started and nothing to release - which the public
   * callers' {@link settleOperation} net turns into a result: `invalid_options` for a rejected
   * timeout, `operation_crashed` for any other throw. The pass takes the
   * latch itself, as the first statement inside its `try`.
   *
   * `isRequestToStayDown` says whether a refusal should be recorded on the running pass
   * (see {@link noteShutdownRequestDuringActivePass}), so that a restart owning that pass
   * skips its startup phase. True for every shutdown request - a signal, a direct
   * `stopAllComponents()` - and false only for a restart's own stop phase: a restart
   * refused by somebody else's pass is not asking anything to stay down. Recorded here,
   * on both refusals, rather than by each caller afterwards, because the pass that
   * refuses a request need not exist on entry: the escalation bookkeeping below can start
   * one from inside `onForceShutdown`, and that is precisely the pass the request has to
   * reach.
   */
  private acceptShutdownPass(
    method: ShutdownMethod,
    options: StopAllOptionsSnapshot | undefined,
    isRequestToStayDown: boolean,
    pendingRestartAutoStarts?: Set<string>,
  ): ShutdownPassAcceptance {
    return this.withTransition(() => {
      // Reject if already shutting down - including one begun by the getters of the
      // options snapshot this call was handed.
      const refusal = this.refuseShutdownPassWhileActive(
        method,
        isRequestToStayDown,
      );
      if (refusal !== undefined) {
        return refusal;
      }

      const passOptions: ShutdownPassOptions = {
        // The one place a pass's options meet the manager's `shutdownOptions` defaults:
        // callers pass only their own overrides.
        timeoutMS: resolveOperationTimeoutMS(
          options?.timeoutMS,
          this.config.shutdownOptions.timeoutMS,
          'stopAllComponents timeoutMS',
        ),
        retryStalled:
          (options?.retryStalled ??
            this.config.shutdownOptions.retryStalled) !== false,
        haltOnStall:
          (options?.haltOnStall ?? this.config.shutdownOptions.haltOnStall) !==
          false,
        allowStopWithPendingStarts:
          (options?.allowStopWithPendingStarts ??
            this.config.shutdownOptions.allowStopWithPendingStarts) === true,
        waitForAbandonedStarts:
          (options?.waitForAbandonedStarts ??
            this.config.shutdownOptions.waitForAbandonedStarts) === true,
        abortPendingStarts:
          (options?.abortPendingStarts ??
            this.config.shutdownOptions.abortPendingStarts) === true,
      };

      // A restart's stop phase expired a lapsed window itself, before its preflight
      // checks (see `restartAllComponentsOperation()`): the expiry logs through the
      // caller's sinks, which must not run between those checks and this pass.
      if (isRequestToStayDown) {
        this.normalizeRepeatedShutdownRequestStateArmedStatus();
      }

      const repeatedShutdownPolicy = this.config.repeatedShutdownRequestPolicy;
      const isManualRetryWhileArmed =
        repeatedShutdownPolicy !== undefined &&
        method === 'manual' &&
        this.state.repeatedShutdownRequestState.firstRequestAt !== null &&
        this.state.repeatedShutdownRequestState.remainsArmedUntil !== null;

      // Taken before the bookkeeping below, not after it, and unconditionally: this request
      // is the one about to start a pass, so the window is spent on it either way. Doing it
      // first is what makes the spending atomic - the counting a line down can reach
      // `onForceShutdown`, and a shutdown request made from inside that callback must find
      // no armed window to count itself against. It is a continuation of this request, not a
      // second operator press.
      const consumedArmedUntil = this.consumeRepeatedShutdownArmedWindow();

      // A manual request that did not come through an armed window, and is not being made
      // from inside escalation handling, starts a cycle of its own. Any state still left
      // from an earlier one is finished: a failed pass whose arming was disabled
      // (`armedAfterFailureMS` <= 0), or one whose force had already fired, keeps its
      // state with nothing to expire it. Inherited, a restart's or a manual stop's pass
      // counted presses against that old cycle - and with `hasTriggeredForceShutdown` still
      // set, force could never fire for it. Signals need no such step: they reseed when
      // not armed before they get here.
      //
      // Not while a shutdown is running: expiring a lapsed window logs through the
      // caller's sinks, and a sink may start a shutdown and seed its live cycle. This
      // request must not wipe it and is refused below. The expiry event itself is a
      // queued notification, so its listeners cannot interrupt this acceptance.
      if (
        method === 'manual' &&
        consumedArmedUntil === null &&
        this.state.escalationHandlingDepth === 0 &&
        !this.isShuttingDown &&
        this.state.repeatedShutdownRequestState.firstRequestAt !== null
      ) {
        this.resetRepeatedShutdownRequestState();
      }

      // Only a request to stay down is an operator's retry. A restart's stop phase does not
      // advance the escalation count - it would force-kill a process it was asked to
      // restart - and does not clear it as a request either. It is still a shutdown pass,
      // so its outcome settles escalation as any pass's does: a clean stop resets it, a
      // failed one re-arms it with the count carried over.
      if (isManualRetryWhileArmed && isRequestToStayDown) {
        if (repeatedShutdownPolicy.countManualRetriesTowardEscalation) {
          this.handleRepeatedShutdownRequest(method, consumedArmedUntil);
        } else {
          this.resetRepeatedShutdownRequestState();
        }
      }

      // The bookkeeping above runs user code before the latch is taken: an expiring
      // armed window logs through caller sinks, and a counted manual retry can reach
      // `onForceShutdown` and the synchronous `shutdown-escalation-forced` checkpoint.
      // A sink, control listener, or callback that
      // starts its own shutdown from there - `stopAllComponents()` inside
      // `onForceShutdown` is the realistic case - gets a pass that finds no latch, announces itself and
      // starts stopping, and control then returns here. Refuse rather than run a second
      // pass concurrently with it: the nested pass is the shutdown this call asked for,
      // which is exactly what `already_in_progress` says. That nested acceptance counts
      // nothing, because the armed window was consumed above before any of this ran. The
      // latch is deliberately not taken earlier instead - `handleRepeatedShutdownRequest()`
      // reads `isShuttingDown` for its log line and for `ForceShutdownContext.isShuttingDown`,
      // and both would then describe a pass that has not started.
      if (this.isShuttingDown) {
        // Not for a restart's stop phase, as above.
        if (isRequestToStayDown) {
          this.logger.warn(
            'Cannot stop all components: a shutdown started while this request was being processed',
            {
              params: { method },
            },
          );
        }

        return this.refuseShutdownPass(isRequestToStayDown);
      }

      const pass: ShutdownPass = {
        shutdownRequested: false,
        isRestartStopPhase: !isRequestToStayDown,
        cameUp: new Set(),
        invalidOptionsRefusals: new Map(),
      };

      if (isRequestToStayDown) {
        this.state.stayDownPassCount++;
        this.state.stayDownRequestCount++;
      }

      if (pendingRestartAutoStarts !== undefined) {
        this.state.pendingRestartAutoStarts.add(pendingRestartAutoStarts);
      }

      // An async method, but it runs synchronously up to its first `await`, which is well
      // past the latch: the caller this returns to already sees a shutdown in progress.
      return {
        accepted: true,
        pass,
        promise: this.runShutdownPass(method, passOptions, pass),
      };
    });
  }

  /**
   * The shutdown pass `acceptShutdownPass()` accepted, and its only caller.
   *
   * A started pass always reports a `lifecycle-manager:shutdown-completed`, however it
   * ends, and always releases the latch.
   */
  private async runShutdownPass(
    method: ShutdownMethod,
    options: ShutdownPassOptions,
    pass: ShutdownPass,
  ): Promise<ShutdownResult> {
    // Capture the synchronous caller before warning hooks or any await. A start
    // requesting shutdown may await this pass, so the pass must not join it.
    const requestingStarts = new Set(this.state.invokingStarts);
    const startTime = Date.now();
    const {
      timeoutMS: effectiveTimeout,
      retryStalled: shouldRetryStalled,
      haltOnStall: shouldHaltOnStall,
      allowStopWithPendingStarts,
      waitForAbandonedStarts: shouldWaitForAbandonedStarts,
      abortPendingStarts: shouldAbortPendingStarts,
    } = options;

    let hasTimedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let pendingShutdownOperation: Promise<void> | null = null;
    let isDuringStartup = false;
    // Set just before the `shutdown-initiated` emit, so a pass that dies earlier can
    // still announce itself before its `shutdown-completed`, and one whose emit threw
    // does not announce twice.
    let didAnnounceShutdown = false;
    // Set once the normal path has emitted its completed event. Nothing after that point
    // is expected to throw - emits go through the transition dispatcher, which contains
    // listener failures - but if something ever did, the `catch` answers with this rather
    // than emitting a second, contradictory result.
    let completedResult: ShutdownResult | null = null;
    // Declared out here so a pass that dies mid-flight can still report what it stopped.
    const stoppedComponents = new Set<string>();
    // Every component this pass could end up reporting as stalled, filled in once the
    // stop list is known. Out here so the `catch` reports the same scope the normal path
    // does rather than every stall the manager happens to be holding; `null` until then,
    // because a pass that died earlier than that had nothing in view.
    let stallCandidateNames: Set<string> | null = null;
    // This pass's stop list, out here for the same reason: the `catch` reconciles over
    // it exactly as the normal path does. `null` until the list is known.
    let stopCandidateNames: readonly string[] | null = null;
    // Components still starting when the pass began; see where it is filled in.
    let startingAtPassStart: readonly string[] = [];
    // For each of those not also running as the pass began: its stop attempt at that
    // moment. A start that fails on its own puts back the state it replaced - `stopped`,
    // for a component started again after a stop - and that is not a stop by this pass.
    // The pass counts it as stopped only if it came up during the pass (`pass.cameUp`)
    // or a stop issued it a new stop attempt.
    const startOnlyBaselines = new Map<string, string | undefined>();
    // Components a concurrent stop still owns, or whose dependencies must stay up. Out
    // here only so the sweep below can settle them from either path; the `catch` never
    // reads it.
    const stoppingComponents = new Set<string>();
    // Shared by both paths so they cannot drift: a candidate that is no longer stalled
    // has no stall info and drops out.
    const collectStalledComponents = (
      candidates: Set<string> | null,
    ): ComponentStallInfo[] =>
      Array.from(candidates ?? [])
        .map((name) => this.state.stalledComponents.get(name))
        .filter((stallInfo): stallInfo is ComponentStallInfo => !!stallInfo);
    // Also shared by both paths: the stop loop only records what it stopped itself, so
    // a candidate the manager already has as `stopped` - one that stopped itself through
    // `reportUnexpectedStop()` during the warning phase, say - is reconciled in here.
    // Without this the `catch` would under-report a pass that threw before reaching such
    // a component. A start that failed on its own back to `stopped` is not one of them
    // (see `startOnlyBaselines`).
    const collectStoppedComponents = (
      excludedNames?: Set<string>,
    ): string[] => {
      for (const name of stopCandidateNames ?? []) {
        if (
          excludedNames?.has(name) ||
          this.state.componentStates.get(name) !== 'stopped' ||
          (startOnlyBaselines.has(name) &&
            !pass.cameUp.has(name) &&
            startOnlyBaselines.get(name) ===
              this.state.componentStopAttemptTokens.get(name))
        ) {
          continue;
        }

        stoppedComponents.add(name);
        stoppingComponents.delete(name);
      }

      return Array.from(stoppedComponents);
    };

    // Nothing above this point can throw - literal initializers and closures - and
    // everything from the latch on runs inside the `try`/`finally` that releases it, so
    // nothing in the setup below - component getters included - can wedge the manager in
    // `shutting-down`.
    try {
      // Taken as the pass's first act, so the `catch` below owes a `shutdown-completed`
      // however the pass dies from here on - including on the emit a few lines down,
      // which would leave that pairing without its `shutdown-initiated` half. The pass
      // goes up with the latch: a request refused by it is recorded on it, and both are
      // dropped together in the `finally`.
      this.state.activeShutdownPass = pass;
      this.state.shutdownToken = ulid();
      this.state.shutdownMethod = method;
      this.state.pendingStartAbortRequest = shouldAbortPendingStarts
        ? { shutdownToken: this.state.shutdownToken, method, requestingStarts }
        : undefined;
      isDuringStartup = this.state.isStarting;
      if (
        this.config.repeatedShutdownRequestPolicy &&
        !pass.isRestartStopPhase &&
        this.state.repeatedShutdownRequestState.firstRequestAt === null
      ) {
        this.seedRepeatedShutdownRequestState(method);
      }

      this.logger.info('Stopping all components', {
        params: { method, allowStopWithPendingStarts },
      });
      didAnnounceShutdown = true;
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
        const err = toError(error);

        this.logger.warn(
          'Could not resolve shutdown order, using registration order: {{error.message}}',
          { params: { error: err, method } },
        );

        shutdownOrder = this.state.components
          .map((c) => this.nameOf(c))
          .reverse();
      }

      const stalledComponentNames = new Set(
        this.state.stalledComponents.keys(),
      );

      // Filter to running components, plus stalled ones if retrying
      const runningComponentsToStop = shutdownOrder.filter(
        (name) =>
          this.isComponentRunning(name) ||
          (shouldRetryStalled && stalledComponentNames.has(name)),
      );

      // The pass's stop list, plus the stalls it is leaving alone: with `retryStalled`
      // off those are not this pass's to clear, but they are still part of the state it
      // reports. With it on they are already in the stop list.
      // Starts in flight as the pass begins are not stopped by it - the start path sends
      // each through the stop pipeline once `start()` settles - but they are part of what
      // it reports: one that came up during the pass and is still stopping, or stalled
      // stopping, when the pass ends leaves the pass short of its goal, not successful.
      const currentStarts = this.core.componentStart.currentStartSettlements();
      startingAtPassStart = shutdownOrder.filter(
        (name) =>
          this.state.componentStates.get(name) === 'starting' ||
          currentStarts.has(name),
      );
      const startsToJoin = startingAtPassStart.map((name) =>
        currentStarts.get(name),
      );
      // Optional bulk-start failures are labelled failed, not starting-timed-out.
      // The settlement records whether late startup is still pending in either case.
      const timedOutStarts = new Set(
        startsToJoin.filter((settlement) =>
          this.isUnresolvedTimedOutStart(settlement),
        ),
      );
      // Already abandoned as the pass began and still unresolved: not waited for, and
      // its dependencies kept out of the warning phase - unless the caller opted into
      // waiting for abandoned starts.
      const isSkippedTimedOutStart = (settlement: StartSettlement): boolean =>
        !shouldWaitForAbandonedStarts &&
        timedOutStarts.has(settlement) &&
        settlement.rawStartPending;

      stallCandidateNames = new Set([
        ...runningComponentsToStop,
        ...startingAtPassStart,
      ]);
      stopCandidateNames = [...runningComponentsToStop, ...startingAtPassStart];
      for (const name of startingAtPassStart) {
        if (!runningComponentsToStop.includes(name)) {
          startOnlyBaselines.set(
            name,
            this.state.componentStopAttemptTokens.get(name),
          );
        }
      }

      if (!shouldRetryStalled) {
        for (const name of stalledComponentNames) {
          stallCandidateNames.add(name);
        }
      }

      const protectedDependencies = new Set<string>();
      // Contained for the reason the warning phase contains its reads: a
      // `getDependencies()` that throws must not end the pass. Its dependencies are then
      // unknown and go unprotected - the same as a component that declares none.
      const readDependencies = (name: string): string[] => {
        const component = this.getComponent(name);

        return component === undefined
          ? []
          : this.componentMetadata.readDependencies(component, 'shutdown');
      };
      const protectDependencies = (
        name: string,
        target = protectedDependencies,
      ): void => {
        // Keep depth-first getter order without consuming the call stack for each link.
        const frames = [{ dependencies: readDependencies(name), index: 0 }];
        while (frames.length > 0) {
          const frame = frames[frames.length - 1];
          if (frame.index === frame.dependencies.length) {
            frames.pop();
            continue;
          }
          const dependency = frame.dependencies[frame.index++];
          if (!target.has(dependency)) {
            target.add(dependency);
            frames.push({
              dependencies: readDependencies(dependency),
              index: 0,
            });
          }
        }
      };
      // Components a concurrent stop or start owned when the loop reached them, or whose
      // own stop this pass failed and left running. Their dependencies stay protected
      // only while that owner is still running, in flight, or has a start still unfinished:
      // one whose stop has since stalled releases them when haltOnStall is false;
      // otherwise that settled failure halts the remaining stops. A dependency skipped
      // on their account holds its own dependencies the
      // same way: the loop comes back to it only once that owner has settled, so until
      // then it may still be running on them.
      const concurrentOwners = new Set<string>();
      const concurrentlyProtectedSkips = new Set<string>();
      const isStartStillInProgress = (name: string): boolean =>
        isStartUnfinished(currentStarts.get(name)) ||
        this.core.claims.isInFlight(name);
      // An owner holds its dependencies until it settles: not running, and neither its
      // stop nor its start still in progress.
      const hasSettled = (owner: string): boolean =>
        !this.state.runningComponents.has(owner) &&
        !isStartStillInProgress(owner);
      // Walked fresh on every check, not cached for the loop: dependency getters are live
      // caller code, and a stop or a logger sink between two checks can change what an
      // owner - or anything down its chain - depends on (see
      // `protectActiveStartupDependencies()`). One walk is shared by every owner within a
      // check: a component's dependencies are read at most once per check, whether it is
      // reached as an owner, as a skip, or down another owner's chain, and the walk ends
      // as soon as it reaches `name`.
      // Repeated checks can be quadratic for a long protected chain. Even consecutive
      // skips run caller-owned dependency getters, so caching across them would change
      // live dependency semantics; the checks around logging also bracket caller code.
      const isProtectedByConcurrentOwner = (name: string): boolean => {
        const walked = new Set<string>();
        const reaches = (from: string): boolean => {
          if (walked.has(from)) {
            return false;
          }
          walked.add(from);
          const frames = [{ dependencies: readDependencies(from), index: 0 }];
          while (frames.length > 0) {
            const frame = frames[frames.length - 1];
            if (frame.index === frame.dependencies.length) {
              frames.pop();
              continue;
            }
            const dependency = frame.dependencies[frame.index++];
            if (dependency === name) {
              return true;
            }
            if (!walked.has(dependency)) {
              walked.add(dependency);
              frames.push({
                dependencies: readDependencies(dependency),
                index: 0,
              });
            }
          }
          return false;
        };
        for (const owners of [concurrentOwners, concurrentlyProtectedSkips]) {
          for (const owner of owners) {
            if (!hasSettled(owner) && reaches(owner)) {
              return true;
            }
          }
        }
        return false;
      };
      // Start global timeout clock (halts further stop attempts after it fires)
      const timeoutPromise =
        effectiveTimeout > 0
          ? new Promise<'timeout'>((resolve) => {
              timeoutHandle = setTimeout(() => {
                hasTimedOut = true;

                resolve('timeout');
                this.logger.warn(
                  'Shutdown timeout exceeded, halting further stop attempts',
                  { params: { timeoutMS: effectiveTimeout } },
                );
              }, effectiveTimeout);
            })
          : null;

      // Preserve a configuration refusal on the aggregate result as well as the log.
      // It leaves the component running; it is not a fabricated stall or a crash.
      // On the pass, so a joined start's own stop records its refusal there too.
      const { invalidOptionsRefusals } = pass;
      // Components a `haltOnStall` break left behind without trying to stop them. Still
      // running at the end, they are reported apart from the stops that actually failed:
      // naming them under "Failed to stop" said their `stop()` had run and failed.
      const haltSkippedNames = new Set<string>();
      // Components whose stop this pass actually ran. A dependency skipped to keep it
      // available for a component still up after a failed stop never is: still running
      // at the end, it is reported under "Not attempted" too, not as a failed stop.
      const attemptedStopNames = new Set<string>();

      const canReleaseStartupDependencies = (name: string): boolean => {
        const state = this.state.componentStates.get(name);
        return (
          allowStopWithPendingStarts &&
          currentStarts.get(name)?.rawStartPending === true &&
          state !== 'stopping' &&
          state !== 'force-stopping' &&
          !this.state.stalledComponents.has(name)
        );
      };

      // Dependency getters are live caller code. Re-read at each stop boundary,
      // including after logging; a stable startup state does not imply stable dependencies.
      const protectActiveStartupDependencies = (): void => {
        if (!allowStopWithPendingStarts) {
          return;
        }
        // Previously protected names are not a traversal cache: an intermediate
        // dependency may now depend on another component. Walk a fresh graph at
        // this checkpoint, then retain both old and newly discovered protection.
        const currentProtection = new Set<string>();
        for (const name of startingAtPassStart) {
          if (
            !canReleaseStartupDependencies(name) &&
            (isStartStillInProgress(name) ||
              this.state.stalledComponents.has(name))
          ) {
            protectDependencies(name, currentProtection);
          }
        }
        for (const name of currentProtection) {
          protectedDependencies.add(name);
        }
      };

      // Create shutdown operation
      const shutdownOperation = async () => {
        // First, before the warning phase and any wait: the sooner a start learns of the
        // shutdown, the sooner it can settle and release what the pass is holding up.
        if (shouldAbortPendingStarts) {
          this.interruptPendingStarts(
            startingAtPassStart,
            currentStarts,
            requestingStarts,
            method,
          );
        }
        const startupDependencies = new Set<string>();
        const warningExcluded = new Set<string>();
        for (const name of startingAtPassStart) {
          // Retain the join boundary even for released starts: warning callbacks
          // can let startup finish and begin cleanup before we reach its dependencies.
          protectDependencies(name, startupDependencies);
          const settlement = currentStarts.get(name);
          if (
            !canReleaseStartupDependencies(name) &&
            settlement &&
            isSkippedTimedOutStart(settlement)
          ) {
            protectDependencies(name, warningExcluded);
          }
        }
        // These dependencies are already known to remain available this pass.
        // Do not ask them to drain before deciding to preserve them.
        await this.runShutdownWarningPhase(
          runningComponentsToStop.filter((name) => !warningExcluded.has(name)),
        );
        let didJoinStarts = false;
        const joinStarts = async (): Promise<void> => {
          if (didJoinStarts) {
            return;
          }
          didJoinStarts = true;
          // A synchronous requester may reject immediately after asking to exit.
          // Let that settlement drain without joining a hook awaiting this pass.
          if ([...requestingStarts].some((start) => !start.didSettle)) {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (hasTimedOut) {
              return;
            }
          }
          // A startup timeout can abandon an unresolved start while this join waits on
          // it - with or without a shutdown deadline. One abandoned mid-join is then
          // treated as one already abandoned when the pass began: the pass stops
          // waiting rather than spend the rest of its budget on a raw `start()` that
          // may never settle. `waitForAbandonedStarts` opts back into waiting for
          // both, within the budget.
          for (const settlement of startsToJoin) {
            // Do not spend another shutdown budget on an already abandoned
            // start. Recovery already underway at this join is still awaited.
            if (
              settlement &&
              // The explicit override spends the budget on stops, not waiting for
              // unresolved starts. Cleanup already underway at this join is awaited;
              // cleanup beginning after it is protected until a later shutdown pass.
              !canReleaseStartupDependencies(settlement.name) &&
              !requestingStarts.has(settlement) &&
              !isSkippedTimedOutStart(settlement)
            ) {
              if (shouldWaitForAbandonedStarts) {
                await settlement.promise;
                // Settled with `start()` still running: a component that owns its
                // late-start cleanup leaves the manager nothing to own once it times
                // out. The option waits for `start()` itself all the same.
                if (settlement.rawStartPending) {
                  await settlement.rawStartDone;
                }
              } else if (
                !settlement.recovery ||
                settlement.isAwaitingLateStart
              ) {
                await Promise.race([settlement.promise, settlement.abandoned]);
                // Abandonment does not release cleanup already underway. The raw
                // start may have settled while the timeout notification was delivered.
                if (settlement.recovery && !settlement.isAwaitingLateStart) {
                  await settlement.promise;
                }
              } else {
                await settlement.promise;
              }
            }
            if (hasTimedOut) {
              return;
            }
          }
          for (const name of startingAtPassStart) {
            // A stall this pass retries once its forced start has settled is the stop
            // loop's to stop, not unfinished startup: protecting its dependencies here
            // would leave them running after that retry stopped it.
            if (
              shouldRetryStalled &&
              stalledComponentNames.has(name) &&
              !isStartStillInProgress(name)
            ) {
              continue;
            }
            if (
              isStartStillInProgress(name) ||
              this.state.stalledComponents.has(name)
            ) {
              if (!canReleaseStartupDependencies(name)) {
                protectDependencies(name);
              }
              // The override releases dependencies, not ownership or accounting of
              // unfinished startup. Existing late-completion handling remains responsible.
              stoppingComponents.add(name);
            }
          }
        };

        // Keep reverse dependency order within each group, but drain unrelated
        // work before a start join can consume the remaining shutdown budget.
        const needsStartJoin = (name: string): boolean =>
          currentStarts.has(name) || startupDependencies.has(name);
        const stopOrder = [
          ...runningComponentsToStop.filter((name) => !needsStartJoin(name)),
          ...runningComponentsToStop.filter(needsStartJoin),
        ];
        // Whether `name` must stay up for now: a dependency of startup work, or of a
        // concurrent owner still in progress. Recorded as still in progress if so.
        const isSkippedForProtection = (name: string): boolean => {
          protectActiveStartupDependencies();
          if (protectedDependencies.has(name)) {
            stoppingComponents.add(name);
            return true;
          }
          if (isProtectedByConcurrentOwner(name)) {
            stoppingComponents.add(name);
            concurrentlyProtectedSkips.add(name);
            return true;
          }
          return false;
        };
        // Returns true when the pass must stop here: its deadline passed, or a failure
        // halted it under `haltOnStall`.
        const runStopLoop = async (
          names: readonly string[],
        ): Promise<boolean> => {
          const haltForTimeout = (): true => {
            this.logger.warn(
              'Shutdown timeout reached, stopping further component shutdown',
              {
                params: { timeoutMS: effectiveTimeout },
              },
            );
            return true;
          };
          let sliceStartedAt = Date.now();
          for (const [index, name] of names.entries()) {
            // Consecutive protected skips otherwise never yield: their fresh graph
            // walks can starve both the shutdown deadline and the concurrent stop's
            // timers. Yield between candidates, then recheck all live ownership below.
            if (Date.now() - sliceStartedAt >= 8) {
              await new Promise<void>((resolve) => {
                setTimeout(resolve, 0);
              });
              sliceStartedAt = Date.now();
            }
            // Before any join, not only after it: a deadline that fired while the last
            // stop was awaited has already answered the pass, and a join begun now
            // would wait on starts for a pass that is over - with
            // `waitForAbandonedStarts`, on a raw `start()` that may never settle.
            if (hasTimedOut) {
              return haltForTimeout();
            }
            // A stall this pass is retrying, with a forced start of it in flight: joined
            // here, and retried below once that start has settled without bringing it up.
            const isRetryingStall =
              shouldRetryStalled && stalledComponentNames.has(name);
            // Automatic cleanup already owns teardown; unrelated stops can proceed
            // before we join it at a dependency boundary or at the end of the pass.
            if (
              currentStarts.has(name) &&
              !this.isComponentUp(name) &&
              !isRetryingStall
            ) {
              continue;
            }
            if (currentStarts.has(name) || startupDependencies.has(name)) {
              await joinStarts();
            }
            if (
              currentStarts.has(name) &&
              !this.isComponentUp(name) &&
              !(isRetryingStall && !isStartStillInProgress(name))
            ) {
              continue;
            }
            if (hasTimedOut) {
              return haltForTimeout();
            }

            // A stop owned by another caller may have stalled while this pass awaited
            // an unrelated component. Apply the same halt policy as when that stall
            // was already visible when the loop first reached its component.
            const concurrentStall =
              shouldHaltOnStall && this.state.stalledComponents.size > 0
                ? [...concurrentOwners].find(
                    (owner) =>
                      this.state.stalledComponents.has(owner) &&
                      !isStartStillInProgress(owner),
                  )
                : undefined;
            if (concurrentStall !== undefined) {
              for (const skipped of names.slice(index)) {
                haltSkippedNames.add(skipped);
              }
              this.logger.warn(
                'Halting shutdown after component stop failure (haltOnStall=true)',
                { params: { componentName: concurrentStall } },
              );
              return true;
            }

            // An earlier dependency stop can let raw startup settle and begin its
            // automatic cleanup. The override no longer permits releasing that
            // cleanup's remaining dependencies, even though the initial join did.
            if (isSkippedForProtection(name)) {
              continue;
            }

            this.logger.entity(name).info('Stopping component');

            // Logger sinks are caller code and can start cleanup synchronously.
            if (isSkippedForProtection(name)) {
              continue;
            }

            // Use internal method to bypass bulk operation checks.
            // - If running: normal stop flow
            // - If stalled and retryStalled: force-phase retry
            // - If stalled and no retry: report component_stalled
            // - If already stopped during this shutdown (for example, via
            //   reportUnexpectedStop() during the warning phase), count it as a
            //   successful stop for shutdown accounting
            // - Otherwise: not running by some other path, skipped
            const isRunning = this.isComponentRunning(name);
            // Read now, not from the snapshot taken as the pass began: a stall can clear
            // mid-pass - an old stop settling - and a retry of a component that is no
            // longer stalled or running only failed, halting the loop.
            const isStalled = this.state.stalledComponents.has(name);
            const currentState = this.state.componentStates.get(name);

            if (currentState === 'stopped') {
              stoppedComponents.add(name);
              continue;
            }

            // No longer running by some other path, in whatever state that left it - a
            // late-startup cleanup puts a component back to `starting-timed-out`, say.
            // Nothing to stop and nothing that failed, so it must not halt the loop
            // before the components after it; the settlement below agrees.
            if (!isRunning && !isStalled) {
              continue;
            }

            attemptedStopNames.add(name);
            const result: ComponentOperationResult = isRunning
              ? await this.core.componentStop.stopComponentInternal(name)
              : shouldRetryStalled
                ? await this.core.componentStop.retryStalledComponent(name)
                : {
                    success: false,
                    componentName: name,
                    reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
                    code: 'component_stalled',
                    status: this.getComponentStatus(name),
                  };

            if (
              result.code === 'invalid_options' &&
              !invalidOptionsRefusals.has(name)
            ) {
              invalidOptionsRefusals.set(name, result.error);
            }

            if (result.success) {
              stoppedComponents.add(name);
            } else if (
              result.code === 'component_already_stopping' ||
              result.code === 'component_already_starting'
            ) {
              // Preserve reverse dependency order. A concurrent stop still owns this
              // component; its dependencies must remain available until it settles.
              // Not a failure: it does not halt the pass, which goes on to the components
              // after it rather than leaving them running untried.
              stoppingComponents.add(name);
              concurrentOwners.add(name);
              continue;
            } else {
              // A configuration getter can report an unexpected stop after the loop's
              // initial check. Refusing that now-unneeded stop must not halt shutdown.
              if (
                !this.state.runningComponents.has(name) &&
                !this.state.stalledComponents.has(name)
              ) {
                if (this.state.componentStates.get(name) === 'stopped') {
                  stoppedComponents.add(name);
                }
                continue;
              }
              // A refused stop need not be a stall. Final accounting below reads the
              // actual state and keeps validation refusals distinct from failed cleanup.
              // Any refusal before cleanup can leave this component running, whether
              // it is invalid configuration or a throwing caller getter. Protect from
              // the actual state, not the result code: continuing independent cleanup
              // must never remove the dependencies of work that has not stopped. It holds
              // them as a concurrent owner does, so final accounting releases them the
              // same way once nothing in progress needs them.
              if (this.isComponentRunning(name)) {
                concurrentOwners.add(name);
              }
              this.logger
                .entity(name)
                .error('Component failed to stop: {{error.message}}', {
                  params: {
                    error:
                      result.error ||
                      new Error(
                        result.reason ||
                          LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
                      ),
                  },
                });

              if (shouldHaltOnStall) {
                for (const skipped of names.slice(index + 1)) {
                  haltSkippedNames.add(skipped);
                }
                this.logger.warn(
                  'Halting shutdown after component stop failure (haltOnStall=true)',
                  { params: { componentName: name } },
                );
                return true;
              }
            }
          }
          return false;
        };

        // The loop does not wait for a concurrent stop. One that has settled by the end
        // of the loop no longer needs the dependencies skipped on its account: go back
        // to them once, in the same order, rather than leave them running.
        if (
          !(await runStopLoop(stopOrder)) &&
          !hasTimedOut &&
          [...concurrentOwners, ...concurrentlyProtectedSkips].some(hasSettled)
        ) {
          await runStopLoop(
            stopOrder.filter((name) => concurrentlyProtectedSkips.has(name)),
          );
        }
        if (!hasTimedOut) {
          await joinStarts();
        }
      };

      pendingShutdownOperation = shutdownOperation();

      if (timeoutPromise) {
        await Promise.race([pendingShutdownOperation, timeoutPromise]);
      } else {
        await pendingShutdownOperation;
      }

      const stalledComponents = collectStalledComponents(stallCandidateNames);
      const finalStalledNames = new Set(
        stalledComponents.map((stallInfo) => stallInfo.name),
      );
      const settledStoppedComponents =
        collectStoppedComponents(finalStalledNames);

      const durationMS = Date.now() - startTime;
      // Every candidate is settled against the registry once, here, whatever the loop
      // did or did not do with it: stopped, stalled (`stalledComponents`), still owned by
      // a concurrent stop (`stoppingComponents`), or still running. The last is the one
      // the loop cannot see on its own - a stop that failed without stalling, a
      // component a `haltOnStall` break never reached - and it fails the pass. Anything
      // else not running - a component a late-startup cleanup already stopped, say - is
      // simply not running, not a failure.
      // A component another stop owned is settled once that stop is done, however it
      // left it: a late-startup cleanup puts it back to `failed` or `starting-timed-out`
      // rather than `stopped`, which `collectStoppedComponents()` alone would take for
      // "still in progress". One that stop left stalled is reported under
      // `stalledComponents` alone, as if this pass had stopped it - unless its start is
      // still unfinished, which keeps it in progress too.
      //
      // Owners and the dependencies skipped on their account settle by one rule: still
      // in progress only while their own stop or start is, or while something still in
      // progress needs them. One that is merely running - a stop that failed and left
      // it up, say - holds its dependencies up, but nothing in progress needs them,
      // however far down the chain they sit; still running, each is reported as not
      // stopped.
      //
      // What the owners still in progress need is walked once, on first use, rather than
      // once for every component still marked stopping.
      let inProgressOwnerDependencies: Set<string> | undefined;
      const isNeededByInProgressOwner = (name: string): boolean => {
        if (inProgressOwnerDependencies === undefined) {
          inProgressOwnerDependencies = new Set<string>();
          for (const owner of [
            ...concurrentOwners,
            ...concurrentlyProtectedSkips,
          ]) {
            if (isStartStillInProgress(owner)) {
              protectDependencies(owner, inProgressOwnerDependencies);
            }
          }
        }

        return inProgressOwnerDependencies.has(name);
      };
      // A dependency kept up for an unfinished start is settled by the same rules, read
      // fresh: one that has since stopped is not in progress, whatever still needs it.
      // One still running was deliberately left up and never stopped by this pass, so it
      // stays in progress (`cleanup_incomplete`) rather than becoming a failed stop.
      for (const name of Array.from(stoppingComponents)) {
        if (
          (finalStalledNames.has(name) && !isStartStillInProgress(name)) ||
          ((concurrentOwners.has(name) ||
            concurrentlyProtectedSkips.has(name)) &&
            !protectedDependencies.has(name) &&
            !isStartStillInProgress(name) &&
            !isNeededByInProgressOwner(name)) ||
          (!this.state.runningComponents.has(name) &&
            !this.core.claims.isInFlight(name) &&
            !this.state.stalledComponents.has(name))
        ) {
          stoppingComponents.delete(name);
        }
      }

      for (const name of startingAtPassStart) {
        // Completed hook-aborted starts are not unfinished merely because their
        // observability state remains starting-timed-out.
        if (!finalStalledNames.has(name) && isStartStillInProgress(name)) {
          stoppingComponents.add(name);
        }
      }

      // A set first: a component that came up while its start was still settling is in
      // both lists, and would be named twice in the failure reason.
      const stillRunningComponents = Array.from(
        new Set([...runningComponentsToStop, ...startingAtPassStart]),
      ).filter(
        (name) =>
          this.state.runningComponents.has(name) &&
          !stoppingComponents.has(name) &&
          !finalStalledNames.has(name),
      );
      // Never tried by this pass: past a `haltOnStall` break, or held up for a component
      // still running after a failed stop.
      const wasNotAttempted = (name: string): boolean =>
        haltSkippedNames.has(name) ||
        (concurrentlyProtectedSkips.has(name) && !attemptedStopNames.has(name));
      const failedToStopComponents = stillRunningComponents.filter(
        (name) => !wasNotAttempted(name),
      );
      const notAttemptedComponents = stillRunningComponents.filter((name) =>
        wasNotAttempted(name),
      );
      const isSuccess =
        !hasTimedOut &&
        stalledComponents.length === 0 &&
        stoppingComponents.size === 0 &&
        stillRunningComponents.length === 0;

      // The guard matters here: a logger that threw would otherwise land in the `catch`
      // below and replace the result of a pass that finished - even a clean one - with
      // a failure.
      this.logger[isSuccess ? 'success' : 'warn'](
        isSuccess
          ? 'Shutdown completed successfully'
          : 'Shutdown attempt completed without confirming all components stopped',
        {
          params: {
            method,
            stopped: stoppedComponents.size,
            stalled: stalledComponents.length,
            durationMS,
          },
        },
      );

      // Every way the pass fell short, not just the first: a `haltOnStall` break used
      // to name only the components it never reached, leaving out the one that stalled.
      const failureReasonParts = [
        ...(stalledComponents.length > 0
          ? [`Stalled: ${Array.from(finalStalledNames).join(', ')}`]
          : []),
        ...(stoppingComponents.size > 0
          ? [
              `Shutdown is still in progress for: ${Array.from(stoppingComponents).join(', ')}`,
            ]
          : []),
        ...(failedToStopComponents.length > 0
          ? [`Failed to stop: ${failedToStopComponents.join(', ')}`]
          : []),
        ...(notAttemptedComponents.length > 0
          ? [`Not attempted: ${notAttemptedComponents.join(', ')}`]
          : []),
      ];

      // A refused stop only names the pass when it left something behind: its own
      // component still running, or still in progress. One whose component went down by
      // another path is not a failure, so neither its code nor its `error` describes
      // what kept this pass short of its goal - a stall elsewhere, say.
      let hasRelevantRefusal = false;
      let invalidOptionsError: Error | undefined;
      for (const [name, error] of invalidOptionsRefusals) {
        if (
          this.state.runningComponents.has(name) ||
          stoppingComponents.has(name)
        ) {
          hasRelevantRefusal = true;
          invalidOptionsError = error;
          break;
        }
      }

      // The result code, in priority order. A timeout outranks everything and reports
      // only the budget. Pending cleanup outranks a refused stop: a caller waiting for
      // `cleanup_incomplete` must still see it, and the refusal stays on `error`. A
      // refusal left behind always means `!isSuccess`, so `partial_state` is never
      // reached with one.
      let code: ShutdownResult['code'];
      if (hasTimedOut) {
        code = 'shutdown_timeout';
      } else if (stoppingComponents.size > 0) {
        code = 'cleanup_incomplete';
      } else if (hasRelevantRefusal) {
        code = 'invalid_options';
      } else if (failureReasonParts.length > 0) {
        code = 'partial_state';
      }

      const failure: Pick<ShutdownResult, 'code' | 'error' | 'reason'> =
        code === undefined
          ? {}
          : code === 'shutdown_timeout'
            ? {
                code,
                reason: `Shutdown timeout exceeded (${effectiveTimeout}ms)`,
              }
            : {
                code,
                ...(invalidOptionsError !== undefined
                  ? { error: invalidOptionsError }
                  : {}),
                reason: [
                  ...failureReasonParts,
                  ...(invalidOptionsError !== undefined
                    ? [describeError(invalidOptionsError)]
                    : []),
                ].join('; '),
              };

      const result: ShutdownResult = {
        success: isSuccess,
        // A stopped component whose raw start is still pending is reported in progress.
        stoppedComponents: settledStoppedComponents.filter(
          (name) => !stoppingComponents.has(name),
        ),
        stalledComponents,
        durationMS,
        timedOut: hasTimedOut || undefined,
        ...failure,
      };

      return this.withTransition(() => {
        // Store for getLastShutdownResult() - useful for debugging and metrics
        this.state.lastShutdownResult = result;

        // Before the completed event, as the last component's stop detached them before
        // this pass took the detach over: a listener there - one that calls
        // `process.exit()`, say - finds stdin restored and `signals-detached` already
        // emitted, and one that attaches again is not undone afterwards. Covers the detach
        // this pass's own stops deferred, and one a refused or aborted startup left to it.
        // Only after a clean pass: a failed one keeps them, so the operator's next Ctrl+C
        // still reaches escalation.
        if (isSuccess) {
          this.detachSignalsIfIdle('shutdown', { isEndingShutdownPass: true });
        }

        this.lifecycleEvents.lifecycleManagerShutdownCompleted({
          ...result,
          method,
          duringStartup: isDuringStartup,
        });

        // "Completed" means the manager finished waiting and a shutdown result
        // snapshot exists, not necessarily that every component stopped cleanly.
        // Callers must inspect success / stalledComponents / timedOut to decide
        // what to do next. Set once the completed event is out, not before: a throw
        // ahead of it must still reach the `catch`'s own completed event.
        completedResult = result;

        this.settleRepeatedShutdownAfterPass(isSuccess);

        return result;
      });
    } catch (error) {
      // A pass that dies resolves with a failed result rather than rejecting, so a caller
      // that fired `stopAllComponents()` without awaiting it can never be handed an
      // unhandled rejection. The failure itself is not lost: it goes on the global
      // channel here, rides on the result as `error`, and the completed event carries it.
      reportCallbackError(`shutdown after ${method}`, error);

      if (completedResult !== null) {
        // Only the escalation bookkeeping after the completed event threw. Tried once
        // more, contained: a failed pass that skipped arming took the operator's escape
        // hatch away, and a clean one that skipped the reset left a stale cycle.
        try {
          this.settleRepeatedShutdownAfterPass(completedResult.success);
        } catch (settleError) {
          reportCallbackError(
            `shutdown escalation settlement after ${method}`,
            settleError,
          );
        }
        return completedResult;
      }

      // Callers block on the `shutdown-completed` that pairs with `shutdown-initiated`,
      // so a pass that dies anywhere in here still owes them a result - otherwise they
      // wait forever. A pass that died before its announcement (escalation seeding or
      // the opening log line) announces itself first, so the pair holds. Only when the
      // `shutdown-initiated` emit is itself what threw is it not retried.
      //
      // Scoped exactly as the normal path scopes it, and empty for a pass that died
      // before it had a stop list: a stall this pass never had in view belongs to
      // whatever left it behind, not to this failure.
      const stalledComponents = collectStalledComponents(stallCandidateNames);
      const result: ShutdownResult = {
        success: false,
        // Reconciled the same way too, so a component that stopped without the stop
        // loop recording it - during the warning phase, or after the throw - is still
        // reported rather than dropped because the pass died before reaching it.
        stoppedComponents: collectStoppedComponents(
          new Set(stalledComponents.map((stallInfo) => stallInfo.name)),
        ),
        stalledComponents,
        durationMS: Date.now() - startTime,
        reason: `Shutdown failed before it could report a result: ${describeError(error)}`,
        // Not a stall or a timeout: the pass itself threw, which points at a bug in
        // the manager (or a component that broke its contract) rather than at a
        // component's stop.
        code: 'operation_crashed',
        error: toError(error),
      };

      return this.withTransition(() => {
        this.state.lastShutdownResult = result;

        if (!didAnnounceShutdown) {
          didAnnounceShutdown = true;
          this.lifecycleEvents.lifecycleManagerShutdownInitiated(
            method,
            isDuringStartup,
          );
        }
        this.lifecycleEvents.lifecycleManagerShutdownCompleted({
          ...result,
          method,
          duringStartup: isDuringStartup,
        });

        // After the completed event, in the same order as a stalled or timed-out pass,
        // so a listener sees the same sequence whichever way the pass failed. Armed
        // exactly as that path arms it: a crash is the worst way for a pass to end, so it
        // is the last place to take the escape hatch away - dropping the cycle here would
        // reseed the operator's next press as a fresh one, `requestCount` would never
        // reach `forceAfterCount`, and `onForceShutdown` - the one thing left that can
        // still get the process down - would be unreachable. Carrying the count and the
        // force-shutdown flag over is this method's job, and it still declines when the
        // window is disabled or force has already fired.
        this.armRepeatedShutdownAfterFailure();

        return result;
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (hasTimedOut && pendingShutdownOperation !== null) {
        // The public timeout remains an early return, and the operation it raced cannot
        // be cancelled. Per-component `stopping` state continues to prevent overlap, but
        // the process-wide shutdown latch must be released so logger.exit() and a later
        // shutdown/escalation are not held forever by a stop() that never settles.
        observeRejection(pendingShutdownOperation, (error: unknown) => {
          this.logger.warn(
            'Shutdown operation failed after the global timeout: {{error.message}}',
            { params: { error: toError(error) } },
          );
        });
      }

      this.withTransition(() => {
        this.state.activeShutdownPass = null;
        // Its cue is this pass's alone, and it holds the pass's requesting starts.
        this.state.pendingStartAbortRequest = undefined;
        this.updateStartedFlag();

        this.core.loggerExit.finalizePendingLoggerExit();
      });
    }
  }

  /**
   * `abortPendingStarts`: abort the start signal of each start a shutdown pass found in
   * flight as it began - the cue to give up. Only that: the pass still joins those starts
   * and protects their dependencies as it would without it, and nothing here records a
   * timeout. A start that requested this shutdown is left alone - it already knows, and
   * may be awaiting the pass - as is one whose `start()` has settled or whose own
   * deadline already aborted its signal (`interruptStart()` checks both). Each settlement is asked in turn; abort listeners are the component's
   * code and may change the others, which each check again for itself.
   */
  private interruptPendingStarts(
    names: readonly string[],
    currentStarts: ReadonlyMap<string, StartSettlement>,
    requestingStarts: ReadonlySet<StartSettlement>,
    method: ShutdownMethod,
  ): void {
    for (const name of names) {
      const settlement = currentStarts.get(name);
      if (
        settlement?.interruptStart === undefined ||
        requestingStarts.has(settlement) ||
        !settlement.rawStartPending
      ) {
        continue;
      }
      if (
        settlement.interruptStart(
          new StartupInterruptedByShutdownError({
            componentName: name,
            method,
          }),
        )
      ) {
        this.logger.entity(name).info('Aborted pending start for shutdown');
      }
    }
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
   * The names that are up, in order - what every startup result reports as started:
   * success, abort, timeout, and also a startup that failed and rolled back. A rollback
   * that could not stop a component leaves it up, and the result must match the
   * registry rather than claim nothing is. One answer for all of them: the failure
   * paths used running-set membership alone, and listed teardown as started.
   */
  private runningStartupSnapshot(
    names: readonly string[] = this.state.components.map((component) =>
      this.nameOf(component),
    ),
  ): string[] {
    // Unlike running-set membership alone, a startup availability snapshot must
    // exclude teardown: stop keeps that membership until cleanup has settled, and a
    // late start's cleanup marks its component running only to stop it.
    return names.filter(
      (name) =>
        this.state.runningComponents.has(name) &&
        this.state.componentStates.get(name) === 'running' &&
        !this.state.pendingBulkStartupCleanup.has(name),
    );
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

  /**
   * Global warning phase (stopAllComponents only)
   * Calls onShutdownWarning() on running components with a global timeout.
   * Kept as a method, not inlined: it is the seam tests use to make a pass crash.
   */
  private runShutdownWarningPhase(componentNames: string[]): Promise<void> {
    return runShutdownWarningPhase(
      this.componentAccess,
      componentNames,
      this.config.shutdownWarningTimeoutMS,
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
   * Check if a component is a required dependency during startup
   * Used to prevent registering dependencies mid-startup which would break ordering
   * @param componentName - Component name to check
   * @returns true if this component would be a required dependency
   */
  private isRequiredDependencyDuringStartup(
    componentName: string,
    // Registration's lists, read before its checks; see `readRegistry()`.
    dependencySnapshot: ReadonlyMap<BaseComponent, DependencyRead>,
  ): boolean {
    // Not before the startup's loop has begun - a `signals-attached` listener
    // registering it: the loop computes its order after this, and starts it in turn.
    // Nor while it reads the registry to compute that order: this one is read with it.
    if (
      !this.state.isStarting ||
      this.state.activeBulkStartup === null ||
      this.state.activeBulkStartup.isOrdering
    ) {
      return false;
    }

    // Check if any existing component lists this new component as a dependency
    // Guarded: another component's dependency getter must not fail this registration.
    return this.state.components.some(
      (c) =>
        // Pending follow-ups have no fixed order yet. Their dependencies can still be
        // registered before that batch is frozen; original/planned components cannot.
        !this.state.deferredAutoStartNames.has(this.nameOf(c)) &&
        dependenciesOf(
          this.currentReadOf(
            c,
            dependencySnapshot,
            this.state.activeBulkStartup?.dependencyReads,
          ),
        ).includes(componentName),
    );
  }

  /**
   * Rollback startup by stopping all started components in reverse order
   * Used when a required component fails to start during startAllComponents()
   */
  private async rollbackStartup(
    startedComponents: string[],
    rolledBackNames: Set<string> = new Set(),
    hasShutdownBegun: () => boolean = () => false,
  ): Promise<void> {
    // Stop components in reverse order - skipping any an earlier rollback of this same
    // startup already reached, which is marked before its stop, so a stop that throws is
    // not retried either.
    const componentsToRollback = [...startedComponents]
      .reverse()
      .filter((name) => !rolledBackNames.has(name));

    if (componentsToRollback.length === 0) {
      return;
    }

    this.logger.warn('Rolling back startup, stopping started components', {
      params: { components: componentsToRollback },
    });

    for (const name of componentsToRollback) {
      // A shutdown that began while the previous stop was awaited owns the rest of the
      // teardown: announcing or marking a rollback this loop will not run would mislead.
      if (hasShutdownBegun()) {
        return;
      }
      rolledBackNames.add(name);
      this.logger.entity(name).info('Rolling back component');
      this.lifecycleEvents.componentStartupRollback(name);

      // Shutdown may also begin from either rollback notification. It owns teardown
      // and its halt-on-stall policy must not be bypassed by this older startup. Not
      // marked rolled back, as the refusal below is not: this rollback never stopped it.
      if (hasShutdownBegun()) {
        rolledBackNames.delete(name);
        return;
      }
      // Retain dependency protection for independently started work, while allowing
      // this rollback to run under the startup latch it already owns.
      const result = await this.core.componentStop.stopComponentInternal(
        name,
        undefined,
        {
          operation: 'stop',
          claimed: false,
          isStartupRollback: true,
          rolledBackNames,
          hasShutdownBegun,
        },
      );
      // Refused because a shutdown began while the stop was being prepared - one of
      // its getters began it. Not a failed stop: that shutdown owns this component and
      // the rest of the teardown, as the checks above already hand it over. Not marked
      // rolled back either, since this rollback never stopped it.
      if (result.code === 'shutdown_in_progress') {
        rolledBackNames.delete(name);
        return;
      }
      // Refused for its running dependents: its stop never ran, so a later rollback of
      // this startup, after those dependents have stopped, must still reach it.
      if (result.code === 'has_running_dependents') {
        rolledBackNames.delete(name);
      }
      if (!result.success) {
        this.logger
          .entity(name)
          .warn(
            'Failed to stop component during rollback, continuing: {{error.message}}',
            {
              params: {
                error:
                  result.error ||
                  new Error(
                    result.reason || LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
                  ),
              },
            },
          );
      }
    }

    this.logger.info('Rollback completed');
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
      (this.isShuttingDown && !isEndingShutdownPass) ||
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

  /**
   * Warn about auto-starts left to a bulk startup that ended before its loop could start
   * them. Their registration already answered `autoStartDeferred: true`, so this is the
   * one place that says so. Callers hand over only names nothing else will start - a
   * newer startup that has already ordered a name takes it over instead (see
   * `releaseStartupLatch()`). Handed the names, already taken off the set: the warning
   * runs caller code, and the set may by then belong to the next startup.
   */
  private warnAbandonedAutoStarts(components: string[], reason: string): void {
    if (components.length === 0) {
      return;
    }

    this.logger.warn(
      'Bulk startup {{reason}}; deferred auto-starts were not attempted',
      { params: { reason, components } },
    );
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
        ? this.getStartupOrderInternal(
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
   * Classify, report and log a failure to compute the startup order - shared by
   * `getStartupOrder()` and `startAllComponents()`, so the two answer it alike.
   *
   * A cycle is the caller's configuration, answered by its code; anything else is
   * unplanned - dependency lists are read tolerantly there, so not a broken
   * `getDependencies()`, which fails only that component's own start - and is reported
   * on the global channel, as every other `operation_crashed` is.
   */
  private answerStartupOrderFailure(
    error: unknown,
    context: string,
  ): {
    code: 'dependency_cycle' | 'operation_crashed';
    reason: string;
    error: Error;
  } {
    const err = toError(error);
    const code =
      err instanceof DependencyCycleError
        ? 'dependency_cycle'
        : 'operation_crashed';

    if (code === 'operation_crashed') {
      reportCallbackError(context, error);
    }

    this.logger.error('Failed to resolve startup order: {{error.message}}', {
      params: { error: err },
    });

    return {
      code,
      // `describeError`, not `err.message`: `toError` returns a brand-claiming value
      // unchanged, so `message` can be an accessor that throws - and both callers answer
      // from a `catch` whose whole point is not to throw.
      reason: describeError(err),
      error: err,
    };
  }

  /**
   * Dependency-aware startup order.
   *
   * - Only registered components are included.
   * - Missing dependencies are ignored for ordering (they are validated at start time).
   * - Cycles throw DependencyCycleError (programmer error).
   */
  private getStartupOrderInternal(
    components: BaseComponent[] = this.state.components,
    // Read by registration, which refuses it or reports on it: named by the value
    // registration already read, and ordered by the list it already read.
    candidate?: {
      component: BaseComponent;
      name: string;
      dependencies: string[];
    },
    // Lists already read - by registration, or a bulk startup's reads - so ordering
    // runs none of the caller's code.
    dependencySnapshot?: ReadonlyMap<BaseComponent, DependencyRead>,
  ): string[] {
    // Naming, registration snapshots, and guarded reads remain manager policy. The
    // ordering module preserves names-first acquisition and dependency read order;
    // callbacks here do not publish or cache any additional lifecycle state.
    return getStartupOrder(
      components,
      (component) =>
        component === candidate?.component
          ? candidate.name
          : this.nameOf(component),
      (component) =>
        component === candidate?.component
          ? candidate.dependencies
          : dependencySnapshot !== undefined
            ? dependenciesOf(dependencySnapshot.get(component))
            : this.componentMetadata.readDependencies(component, 'ordering'),
    );
  }

  /**
   * Emit `signal:shutdown` for a signal that is about to start (or retry) a pass.
   *
   * The signal has already set up escalation for its cycle by now, and the emit runs
   * listener code: counted as escalation handling, so a listener that calls
   * `stopAllComponents()` from here continues that cycle rather than having its
   * unarmed-manual-stop reset wipe the signal's `firstMethod` and count.
   */
  private emitSignalShutdownForNewRequest(method: ShutdownSignal): void {
    this.state.escalationHandlingDepth++;

    try {
      this.lifecycleEvents.signalShutdown(method, false);
    } finally {
      this.state.escalationHandlingDepth--;
    }
  }

  /**
   * A shutdown signal that lands while a pass is running: noted on the pass, emitted
   * once as already-shutting-down, and counted - or, when no cycle is running yet,
   * made the cycle's initial request.
   */
  private answerShutdownSignalDuringPass(method: ShutdownSignal): void {
    return this.withTransition(() => {
      // A pass can run without a cycle: a restart's stop phase does not seed one, a
      // manual stop does not either, and a stale or expired cycle is cleared under a
      // running pass. The first signal then is where the operator's shutdown actually
      // begins, so it seeds the cycle - the same as a signal that starts a pass - rather
      // than counting as press one. A pass that has a live cycle keeps it, and this
      // signal counts against it.
      //
      // A window armed under this pass that has already lapsed is expired first, so the
      // cycle it held is stale by the time this signal asks: expiring it only once the
      // signal was being counted cleared the cycle and dropped the press - neither counted
      // nor seeding the next cycle.
      if (this.config.repeatedShutdownRequestPolicy !== undefined) {
        this.normalizeRepeatedShutdownRequestStateArmedStatus();
      }
      const isFirstRequestOfCycle =
        this.config.repeatedShutdownRequestPolicy !== undefined &&
        this.state.repeatedShutdownRequestState.firstRequestAt === null;
      // Read before any listener runs; only for the log line below.
      const isDuringRestart =
        this.state.activeShutdownPass?.isRestartStopPhase === true;

      this.noteShutdownRequestDuringActivePass();
      if (isFirstRequestOfCycle) {
        // This is a synchronous control checkpoint. Its listeners must find the
        // restart's new shutdown cycle already seeded, rather than seed a competing
        // cycle when they re-enter through another signal or a manual stop.
        this.seedRepeatedShutdownRequestState(method);
      }
      this.lifecycleEvents.signalShutdown(method, true);

      if (isFirstRequestOfCycle) {
        this.logger.info(
          isDuringRestart
            ? 'Shutdown signal received during restart'
            : 'Shutdown signal received during shutdown, starting its escalation cycle',
          { params: { method } },
        );

        return;
      }

      // No window to consume: `acceptShutdownPass()` spends it on the request that starts
      // the pass. A window armed by this very pass - from a listener on its completed
      // event, before the latch comes down - that lapsed only after the check above, while
      // the emit's listeners ran, is cleared by this call, and this request seeds the next
      // cycle there. Either way the request is answered here: falling through would emit
      // `signal:shutdown` a second time and reseed escalation under a running pass.
      this.handleRepeatedShutdownRequest(method, null);
    });
  }

  /**
   * Handle shutdown signal - initiates stopAllComponents().
   *
   * Four cases depending on the current shutdown state:
   *
   * 1. **Active shutdown** (`isShuttingDown = true`): escalate through the
   *    repeated-shutdown policy if configured, otherwise log and discard.
   *    Emits `signal:shutdown` with `isAlreadyShuttingDown: true` and returns
   *    without starting another shutdown. When that shutdown is a restart's stop
   *    phase, the request also cancels the restart's startup phase.
   *
   * 2. **Armed post-failure** (previous shutdown finished, armed window still
   *    open): count the request toward the escalation window, emit
   *    `signal:shutdown` with `isAlreadyShuttingDown: false`, then start a
   *    new `stopAllComponents()` run to retry.
   *
   * 3. **Armed post-failure expired** (armed window opened but has since
   *    elapsed): expire the stale state, treat the request as a fresh
   *    shutdown - same outcome as case 4.
   *
   * 4. **Fresh shutdown** (no active or armed state): seed escalation tracking
   *    if policy is configured, emit `signal:shutdown` with
   *    `isAlreadyShuttingDown: false`, and start `stopAllComponents()`.
   *
   * In all cases `signal:shutdown` is emitted exactly once.
   */
  private handleShutdownRequest(method: ShutdownSignal): void {
    return this.withTransition(() => {
      if (this.isShuttingDown) {
        this.answerShutdownSignalDuringPass(method);

        return;
      }

      let didEmitShutdownSignal = false;
      // Not from inside escalation handling - `onForceShutdown`, or a listener on
      // `shutdown-escalation-forced` or `signal:shutdown`, raising a signal of its own. The
      // armed window is already spent by then, so the request would otherwise look fresh
      // and reseed, wiping `hasTriggeredForceShutdown` and the count: the next press
      // forced again. It continues the request that fired it, as a manual stop does.
      let shouldSeedRepeatedShutdownState =
        this.config.repeatedShutdownRequestPolicy !== undefined &&
        this.state.escalationHandlingDepth === 0;

      // This branch is only for the post-failure "armed" state.
      // A previous shutdown request already happened, shutdown has already
      // finished returning, and we intentionally keep escalation alive for a
      // short period so follow-up presses can continue the same force count.
      if (
        this.config.repeatedShutdownRequestPolicy &&
        this.state.repeatedShutdownRequestState.firstRequestAt !== null &&
        this.normalizeRepeatedShutdownRequestStateArmedStatus()
      ) {
        // Consumed first, ahead of every line below that can run user code - the emit's
        // listeners as much as the force handler `handleRepeatedShutdownRequest()` can
        // reach. The same ordering `acceptShutdownPass()` uses, and for the same reason: a
        // shutdown request made from inside any of them continues this one rather than
        // counting as a press of its own. The pass this request goes on to start would have
        // cleared the window a moment later regardless.
        const consumedArmedUntil = this.consumeRepeatedShutdownArmedWindow();

        this.emitSignalShutdownForNewRequest(method);
        didEmitShutdownSignal = true;
        shouldSeedRepeatedShutdownState = false;
        this.handleRepeatedShutdownRequest(method, consumedArmedUntil);
      } else if (this.isShuttingDown) {
        // Expiring a lapsed window logs through caller sinks, which can start a
        // shutdown here; the expiry notification stays queued until this transition
        // ends. That pass is the one this signal now lands on, so it is answered as one landing on a
        // running pass: not reseeding escalation over the cycle that pass just seeded, and
        // not emitting `signal:shutdown` as if nothing were running.
        this.answerShutdownSignalDuringPass(method);

        return;
      }

      // Seeded before the log line below: its sinks are caller code, and a shutdown one
      // starts there must find this signal's cycle rather than open its own.
      if (shouldSeedRepeatedShutdownState) {
        this.seedRepeatedShutdownRequestState(method);
      }

      // Counted as escalation handling, as the `signal:shutdown` emit is: a stop a sink
      // starts here continues this request instead of resetting its cycle.
      this.state.escalationHandlingDepth++;
      try {
        this.logger.info('Shutdown signal received', {
          params: { method },
        });
      } finally {
        this.state.escalationHandlingDepth--;
      }

      // That pass is the one this signal asked for. Recorded on it, and announced as
      // landing on a running pass, but not counted as a press: it is this request.
      if (!didEmitShutdownSignal && this.isShuttingDown) {
        this.noteShutdownRequestDuringActivePass();
        this.lifecycleEvents.signalShutdown(method, true);

        return;
      }

      if (!didEmitShutdownSignal) {
        this.emitSignalShutdownForNewRequest(method);
      }

      // Signal handlers cannot consume a return value, so the acknowledgement is dropped;
      // a pass that failed to start has already been reported on the global channel.
      this.startShutdownPass(method);
    });
  }

  /**
   * Final step of a signal-driven shutdown request: starts the pass in the background and
   * returns without waiting for components to stop, since a signal handler has nobody to
   * hand a result to. The outcome arrives on `lifecycle-manager:shutdown-completed`.
   */
  private startShutdownPass(method: ShutdownSignal): void {
    return this.withTransition(() => {
      // A signal means the process should stay down, so a refusal is recorded on the
      // running pass - including one started from inside this request's own escalation
      // bookkeeping, which was not there when `handleShutdownRequest()` checked the latch.
      const acceptance = this.acceptShutdownPass(method, undefined, true);

      if (!acceptance.accepted) {
        return;
      }

      // Deliberate insurance, not dead code - keep it. `runShutdownPass()` resolves even
      // when the pass dies, so today this never runs. But this promise floats inside an OS
      // signal handler, where an unhandled rejection is fatal under Node's default
      // `--unhandled-rejections=throw`: if a future bug ever made the pass reject, this
      // handler is all that stands between it and a crash that takes the process down
      // before the components it was about to stop were stopped.
      observeRejection(acceptance.promise, (error: unknown) => {
        reportCallbackError(`shutdown after ${method}`, error);
      });
    });
  }

  /**
   * Records a shutdown request that landed while a shutdown pass was already running.
   *
   * Such a request is still refused as "already in progress" - the running pass is the
   * shutdown the requester gets, and starting a second pass on top of it would be wrong.
   * What must not happen is a `restartAllComponents()` whose stop phase that pass is
   * starting everything back up afterwards, so the request is recorded on the pass and
   * phase 2 is skipped instead. It is also counted in `stayDownRequestCount`, so an
   * individual `restartComponent()` stopping a component meanwhile skips its start too.
   *
   * Reached from `acceptShutdownPass()`'s refusals for every request that asks to stay
   * down (its `isRequestToStayDown`), and directly from the two places that see a running
   * pass without going through it: `handleShutdownRequest()`'s own latch check for a
   * signal, and the `enableLoggerExitHook()` callback, where `logger.exit()` says the
   * process is going down.
   */
  private noteShutdownRequestDuringActivePass(): void {
    if (this.state.activeShutdownPass !== null) {
      this.state.activeShutdownPass.shutdownRequested = true;
      this.state.stayDownRequestCount++;
    }
  }

  /**
   * The refusal of a shutdown request that finds a pass already running, or `undefined`
   * when none is. Made by `stopAllComponents()` before it reads its options, and by
   * `acceptShutdownPass()` on entry.
   */
  private refuseShutdownPassWhileActive(
    method: ShutdownMethod,
    isRequestToStayDown: boolean,
  ): ShutdownPassRefusal | undefined {
    if (!this.isShuttingDown) {
      return undefined;
    }

    // A restart's stop phase is refused as the restart, which logs that one warning:
    // both lines read as two refusals for the one request.
    if (isRequestToStayDown) {
      this.logger.warn(
        'Cannot stop all components: shutdown already in progress',
        {
          params: { method },
        },
      );
    }

    return this.refuseShutdownPass(isRequestToStayDown);
  }

  /**
   * Both of `acceptShutdownPass()`'s refusals, so they cannot drift apart on whether the
   * refusal is recorded against the running pass.
   */
  private refuseShutdownPass(
    isRequestToStayDown: boolean,
  ): ShutdownPassRefusal {
    if (isRequestToStayDown) {
      this.noteShutdownRequestDuringActivePass();
    }

    return { accepted: false, result: refusedShutdownResult() };
  }

  /** The shutdown latch: set exactly while a shutdown pass is running. */
  private get isShuttingDown(): boolean {
    return this.state.activeShutdownPass !== null;
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
   * Tracks repeated shutdown requests during an active shutdown and optionally
   * invokes the configured force shutdown callback when the threshold is reached.
   *
   * @param consumedArmedUntil the deadline of the post-failure armed window this request
   * already took for itself through {@link consumeRepeatedShutdownArmedWindow}, or `null`
   * when it took none. Passed in rather than read back off the state, because a caller
   * that is about to start a pass consumes the window *before* calling this - the whole
   * point being that the user code below finds none - and there would otherwise be
   * nothing left here to tell an armed request apart from a fresh one. A window found
   * already lapsed is expired and the request is not counted; on a running pass it seeds
   * the next cycle instead.
   */
  private handleRepeatedShutdownRequest(
    method: ShutdownMethod,
    consumedArmedUntil: number | null,
  ): void {
    return this.withTransition(() => {
      this.state.escalationHandlingDepth++;

      try {
        this.handleRepeatedShutdownRequestInner(method, consumedArmedUntil);
      } finally {
        this.state.escalationHandlingDepth--;
      }
    });
  }

  private handleRepeatedShutdownRequestInner(
    method: ShutdownMethod,
    consumedArmedUntil: number | null,
  ): void {
    const policy = this.config.repeatedShutdownRequestPolicy;

    if (!policy) {
      // Signals only: a `'manual'` request never reaches here without a policy.
      this.logger.warn('Shutdown already in progress, ignoring signal', {
        params: { method },
      });
      return;
    }

    const now = Date.now();
    const state = this.state.repeatedShutdownRequestState;

    // Skipped when this request consumed the window on its way in: the caller already
    // checked the deadline before consuming, and refreshing a window that the pass it is
    // about to start would clear again immediately says nothing.
    if (consumedArmedUntil === null && state.remainsArmedUntil !== null) {
      if (now >= state.remainsArmedUntil) {
        this.expireRepeatedShutdownRequestState();
        // The cycle is gone, but this request was still made. On a running pass it is
        // the first press after a stale cycle, which seeds the next one - unless the
        // expiry's sinks already began it with a request of their own.
        if (
          this.isShuttingDown &&
          this.state.repeatedShutdownRequestState.firstRequestAt === null
        ) {
          this.seedRepeatedShutdownRequestState(method);
        }
        return;
      }
    }

    // What the window looked like for this request, whether it is still on the state or
    // this request took it. Both the log lines and `wasArmedAfterFailure` describe the
    // request, so neither may go blind just because the window was consumed early.
    const armedUntil = consumedArmedUntil ?? state.remainsArmedUntil;
    // A request that lands on a running pass is counted against that pass, armed window
    // or not: `wasArmedAfterFailure` and `isShuttingDown` are never both true.
    const wasArmedAfterFailure = armedUntil !== null && !this.isShuttingDown;

    // The initial shutdown request starts graceful shutdown but does not count
    // toward force escalation. Only follow-up escalation presses are windowed.
    const shouldStartNewWindow =
      state.repeatedWindowStartedAt === null ||
      now - state.repeatedWindowStartedAt > policy.withinMS;

    if (shouldStartNewWindow) {
      // This request starts a new escalation window for post-start escalation
      // presses only.
      state.requestCount = 1;
      state.repeatedWindowStartedAt = now;
    } else {
      // Still inside the escalation window, so this request advances the same
      // repeated-request streak.
      state.requestCount++;
    }

    // Always keep the latest request details current so the eventual callback
    // can see both how the window started and what most recently arrived.
    state.latestMethod = method;
    state.latestRequestAt = now;

    // The guard matters here: `requestCount` has already advanced, so a logger that
    // threw would otherwise skip the force-shutdown handler below or escape an OS
    // signal handler.
    this.logger.warn(
      // Only signals reach here mid-shutdown; a `'manual'` request is never counted then.
      this.isShuttingDown
        ? 'Shutdown already in progress, tracking repeated signal'
        : 'Previous shutdown attempt finished with stalled components or timeout, escalation window still armed, tracking repeated request',
      {
        params: {
          method,
          requestCount: state.requestCount,
          firstMethod: state.firstMethod,
          latestMethod: state.latestMethod,
          firstRequestAt: state.firstRequestAt,
          latestRequestAt: state.latestRequestAt,
          repeatedWindowStartedAt: state.repeatedWindowStartedAt,
          remainsArmedUntil: armedUntil,
          withinMS: policy.withinMS,
          forceAfterCount: policy.forceAfterCount,
        },
      },
    );

    // The log's sinks are caller code, and one that resets the cycle - a
    // `startAllComponents()` from there - leaves this request counted on a cycle that
    // is gone. The live one owns escalation from here: marking the old one as forced
    // and firing for it would let the live cycle force again on its own count.
    if (this.state.repeatedShutdownRequestState !== state) {
      return;
    }

    if (
      // Force escalation is single-fire per shutdown cycle. Later requests are
      // still logged but do not re-enter user force-shutdown logic.
      state.hasTriggeredForceShutdown ||
      state.requestCount < policy.forceAfterCount ||
      state.firstMethod === null ||
      state.firstRequestAt === null ||
      state.latestMethod === null ||
      state.latestRequestAt === null
    ) {
      return;
    }

    state.hasTriggeredForceShutdown = true;

    // The callback receives a snapshot of the active window at the moment the
    // threshold is crossed. It does not continue to mutate after dispatch.
    const context: ForceShutdownContext = {
      requestCount: state.requestCount,
      firstMethod: state.firstMethod,
      latestMethod: state.latestMethod,
      firstRequestAt: state.firstRequestAt,
      latestRequestAt: state.latestRequestAt,
      isShuttingDown: this.isShuttingDown,
      wasArmedAfterFailure,
    };

    this.logger.warn(
      'Repeated shutdown request threshold reached, invoking force shutdown handler',
      {
        params: {
          method,
          requestCount: context.requestCount,
          firstMethod: context.firstMethod,
          latestMethod: context.latestMethod,
          firstRequestAt: context.firstRequestAt,
          latestRequestAt: context.latestRequestAt,
          repeatedWindowStartedAt: state.repeatedWindowStartedAt,
          remainsArmedUntil: armedUntil,
          withinMS: policy.withinMS,
          forceAfterCount: policy.forceAfterCount,
        },
      },
    );
    this.state.forceHandlingDepth++;

    try {
      safeHandleCallback(
        'repeatedShutdownRequestPolicy.onForceShutdown',
        policy.onForceShutdown,
        context,
      );
      this.lifecycleEvents.lifecycleManagerShutdownEscalationForced({
        firstMethod: context.firstMethod,
        latestMethod: context.latestMethod,
        requestCount: context.requestCount,
        firstRequestAt: context.firstRequestAt,
        latestRequestAt: context.latestRequestAt,
        wasArmedAfterFailure: context.wasArmedAfterFailure,
      });
    } finally {
      this.state.forceHandlingDepth--;
    }
  }

  /**
   * How a pass's outcome settles escalation: a clean pass ends the cycle, a failed one
   * re-arms it with the count carried over.
   */
  private settleRepeatedShutdownAfterPass(isSuccess: boolean): void {
    if (isSuccess) {
      this.resetRepeatedShutdownRequestState();
    } else {
      this.armRepeatedShutdownAfterFailure();
    }
  }

  /**
   * Clears repeated shutdown request tracking so a new shutdown cycle starts fresh.
   */
  private resetRepeatedShutdownRequestState(): void {
    this.clearRepeatedShutdownExpiryTimer();
    this.state.repeatedShutdownRequestState = {
      requestCount: 0,
      firstMethod: null,
      latestMethod: null,
      firstRequestAt: null,
      latestRequestAt: null,
      repeatedWindowStartedAt: null,
      hasTriggeredForceShutdown: false,
      remainsArmedUntil: null,
    };
  }

  /**
   * Spends the post-failure escalation window on the request that is about to start a
   * shutdown pass: clears it and its expiry timer, and hands back the deadline it carried
   * so the caller can still describe the window it took.
   *
   * Every request that gets as far as starting a pass ends the window - the pass is the
   * retry the window was held open for. What matters is that it ends *before* the
   * escalation bookkeeping runs, because that bookkeeping calls `onForceShutdown` and
   * emits `shutdown-escalation-forced`, and a shutdown request made from inside either
   * one is a continuation of the request that fired it. Consuming first is what lets that
   * nested request see a plain fresh start rather than a second press against a window
   * its own caller has not got around to clearing yet.
   *
   * @returns the deadline of the window this call took, or `null` when none was armed
   */
  private consumeRepeatedShutdownArmedWindow(): number | null {
    const armedUntil =
      this.state.repeatedShutdownRequestState.remainsArmedUntil;

    if (armedUntil === null) {
      return null;
    }

    this.clearRepeatedShutdownExpiryTimer();
    this.state.repeatedShutdownRequestState.remainsArmedUntil = null;

    return armedUntil;
  }

  /**
   * Clear any pending expiration timer for the post-failure escalation window.
   */
  private clearRepeatedShutdownExpiryTimer(): void {
    if (this.state.repeatedShutdownExpiryTimer === null) {
      return;
    }

    clearTimeout(this.state.repeatedShutdownExpiryTimer);
    this.state.repeatedShutdownExpiryTimer = null;
  }

  /**
   * Returns whether post-failure escalation remains armed after first
   * normalizing any stale timer-backed state.
   *
   * The method can expire old armed windows as a side effect because the timer
   * callback may not have run yet on a delayed event loop. Callers use this
   * when they need the effective runtime truth, not just the last timer write.
   */
  private normalizeRepeatedShutdownRequestStateArmedStatus(
    now = Date.now(),
  ): boolean {
    const armedUntil =
      this.state.repeatedShutdownRequestState.remainsArmedUntil;

    if (armedUntil === null) {
      return false;
    }

    if (now >= armedUntil) {
      this.expireRepeatedShutdownRequestState();
      return false;
    }

    return true;
  }

  /**
   * Transition armed post-failure escalation state into its expired/reset state.
   */
  private expireRepeatedShutdownRequestState(): void {
    return this.withTransition(() => {
      const policy = this.config.repeatedShutdownRequestPolicy;
      const state = this.state.repeatedShutdownRequestState;

      if (!policy || state.remainsArmedUntil === null) {
        return;
      }

      // Narrowed to number by the null guard above.
      const armedUntil: number = state.remainsArmedUntil;

      this.clearRepeatedShutdownExpiryTimer();

      const expiredState = {
        firstMethod: state.firstMethod,
        latestMethod: state.latestMethod,
        requestCount: state.requestCount,
        armedUntil,
      };

      // Reset before the warning runs caller sinks: a sink that starts a shutdown
      // must find no state, so its pass seeds a fresh cycle. Resetting afterwards
      // would wipe that cycle and make force escalation unreachable. The expiry
      // notification waits for the enclosing transition to finish.
      this.resetRepeatedShutdownRequestState();

      this.logger.warn(
        'Repeated shutdown escalation window expired, clearing previous shutdown state',
        {
          params: {
            remainsArmedUntil: armedUntil,
            withinMS: policy.withinMS,
            forceAfterCount: policy.forceAfterCount,
          },
        },
      );

      if (expiredState.firstMethod !== null) {
        this.lifecycleEvents.lifecycleManagerShutdownEscalationExpired({
          firstMethod: expiredState.firstMethod,
          latestMethod: expiredState.latestMethod,
          requestCount: expiredState.requestCount,
          armedUntil: expiredState.armedUntil,
        });
      }
    });
  }

  /**
   * Arms or refreshes the post-failure escalation window and its expiration timer.
   */
  private refreshRepeatedShutdownArmedWindow(now = Date.now()): void {
    const policy = this.config.repeatedShutdownRequestPolicy;

    if (!policy) {
      return;
    }

    this.clearRepeatedShutdownExpiryTimer();

    const armedUntil = now + policy.armedAfterFailureMS;
    this.state.repeatedShutdownRequestState.remainsArmedUntil = armedUntil;
    this.state.repeatedShutdownExpiryTimer = setTimeout(() => {
      this.expireRepeatedShutdownRequestState();
    }, policy.armedAfterFailureMS);
    // Expiry should not keep the process alive when nothing else is pending.
    // Where setTimeout returns a numeric id (browsers, Deno) there is nothing to unref.
    if (typeof this.state.repeatedShutdownExpiryTimer === 'object') {
      this.state.repeatedShutdownExpiryTimer.unref?.();
    }
  }

  /**
   * Seeds shutdown escalation tracking for a new shutdown cycle.
   *
   * The first shutdown trigger starts graceful shutdown and arms escalation with
   * an effective post-start count of 0. Later shutdown requests can then count
   * toward the configured force threshold regardless of whether the shutdown
   * started from a signal, keyboard shortcut, or direct API call.
   */
  private seedRepeatedShutdownRequestState(method: ShutdownMethod): void {
    const now = Date.now();
    this.state.repeatedShutdownRequestState = {
      requestCount: 0,
      firstMethod: method,
      latestMethod: method,
      firstRequestAt: now,
      latestRequestAt: now,
      repeatedWindowStartedAt: null,
      hasTriggeredForceShutdown: false,
      remainsArmedUntil: null,
    };
  }

  /**
   * Preserves a short-lived post-failure escalation window after shutdown
   * returns unsuccessfully so operators can keep pressing shutdown without
   * losing the existing force count the moment the graceful attempt finishes.
   */
  private armRepeatedShutdownAfterFailure(): void {
    return this.withTransition(() => {
      const policy = this.config.repeatedShutdownRequestPolicy;
      const state = this.state.repeatedShutdownRequestState;

      if (
        !policy ||
        policy.armedAfterFailureMS <= 0 || // armedAfterFailureMS = 0 disables post-failure arming
        state.firstRequestAt === null ||
        state.hasTriggeredForceShutdown
      ) {
        return;
      }

      this.refreshRepeatedShutdownArmedWindow();
      const armedUntil = state.remainsArmedUntil;
      if (state.firstMethod !== null && armedUntil !== null) {
        this.lifecycleEvents.lifecycleManagerShutdownEscalationArmed({
          firstMethod: state.firstMethod,
          requestCount: state.requestCount,
          armedUntil,
        });
      }
    });
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
