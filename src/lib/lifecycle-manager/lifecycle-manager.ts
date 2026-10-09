import { ComponentMetadataReader } from './internal/component-metadata-reader';
import { TransitionEventDispatcher } from './internal/transition-event-dispatcher';
import { RegistrationReadTracker } from './internal/registration-read-tracker';
import { LifecycleManagerState } from './internal/manager-state';
import {
  type ManagerConfig,
  resolveManagerConfig,
} from './internal/manager-config';
import { ManagerCore } from './internal/manager-core';
import { readComponentStatus } from './internal/read-status';
import type { ComponentAccessContext } from './internal/component-access-context';
import {
  checkComponentHealthOperation,
  checkAllHealthOperation,
} from './internal/component-inspection';
import {
  settleOperation,
  crashedStartupResult,
  crashedShutdownResult,
  crashedHealthCheckResult,
  crashedHealthReport,
  crashedComponentResult,
  observeFailureAfterTimeout,
} from './internal/operation-policy';
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
 *
 * This class is the public facade. It builds the manager's state, config, loggers and
 * event plumbing once, in its constructor, and hands them to a `ManagerCore` whose
 * subsystems do the work; each public method answers from that state or delegates to
 * its subsystem, under the public-method safety net where it has one. Subsystems call
 * the public methods back through the core at call time, so a subclass override or an
 * instance patch of one is the one that runs. See `internal/README.md`.
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
   * The manager's own logging surface, shared with every subsystem: guarded, so no log
   * call can throw or reject at its call site. See {@link createGuardedLoggerService}.
   */
  private readonly logger: LoggerService;
  /**
   * The caller's own `Logger`, never wrapped. `enableLoggerExitHook` registers a
   * `beforeExit` callback on it, and components build their own service loggers from the
   * instance the caller handed them, so the object identity and behaviour here stay the
   * caller's.
   */
  private readonly rootLogger: Logger;
  /** Registration generations and bounded reads of the live registry. */
  private readonly registrationReads = new RegistrationReadTracker(
    () => this.state.components,
  );
  /** Guarded dependency and optional-status reads, named by the registry. */
  private readonly componentMetadata = new ComponentMetadataReader(
    (component) => this.core.registry.nameOf(component),
  );
  /** Typed event emitters, queued through the dispatcher. */
  private readonly lifecycleEvents: LifecycleManagerEvents;
  /** Transition depth and the notification queue, delivered through `deliverEvent()`. */
  private readonly eventDispatcher = new TransitionEventDispatcher(
    (event, data) => this.deliverEvent(event, data),
  );
  /** The live view and dispatch callbacks the component-facing operations use. */
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
    // Its `entity()` cache keeps room for every registered component, so a bulk pass
    // logging each in turn reuses their children.
    this.logger = createGuardedLoggerService(this.rootLogger.service(name), {
      entityCacheReserve: () => this.state.components.length,
    });
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
      createProcessSignalManager: (signalOptions) =>
        new ProcessSignalManager(signalOptions),
    });

    // Enable logger exit hook if requested: only the literal `true` enables it, like
    // every other constructor flag
    if (options.enableLoggerExitHook === true) {
      this.enableLoggerExitHook();
    }
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
  ): Promise<RegisterComponentResult> {
    return this.core.registration
      .registerComponentSettled(component, 'end', undefined, false, options)
      .then((result): RegisterComponentResult => {
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
      });
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
  ): Promise<InsertComponentAtResult> {
    return this.core.registration.registerComponentSettled(
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
    // overridable `hasComponent()`, so it describes this call's component rather than
    // whatever holds the name when a failure is answered, and an override that throws
    // cannot make this safety net reject.
    const progress = {
      wasStopped: false,
      wasRegistered: this.core.registry.isNameRegistered(name),
    };

    return settleOperation(
      'unregisterComponent',
      () =>
        this.core.unregistration.unregisterComponentOperation(
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
   * Get statuses for all components, each read through `getComponentStatus()` so a
   * subclass override or an instance patch is the one that runs, as for the statuses
   * on results and events. An entry the override throws for or answers `undefined`
   * for is left out; a throw is reported on the global `'error'` channel.
   */
  public getAllComponentStatuses(): ComponentStatus[] {
    const statuses: ComponentStatus[] = [];
    // The array in hand: an override that changes the registry replaces it, not this.
    for (const component of this.state.components) {
      const status = readComponentStatus(
        this.core,
        this.core.registry.nameOf(component),
        'lifecycle-manager getAllComponentStatuses',
      );
      if (status !== undefined) {
        statuses.push(status);
      }
    }
    return statuses;
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
        // From the same state as the counts, so one snapshot always agrees with itself.
        running: Array.from(this.state.runningComponents),
        stopped: stoppedNames,
        stalled: Array.from(this.state.stalledComponents.keys()),
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
    // The manager's own sets, asked directly, so the call allocates nothing beyond the
    // filtered names.
    return this.getComponentNames().filter(
      (name) =>
        !this.state.runningComponents.has(name) &&
        !this.state.stalledComponents.has(name),
    );
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
  // Dependencies
  // ============================================================================

  /**
   * Get resolved startup order after applying dependency constraints.
   */
  public getStartupOrder(): StartupOrderResult {
    return this.core.startupOrdering.getStartupOrderOperation();
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
    return this.core.startupOrdering.validateDependenciesOperation();
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
      () => this.core.startup.startAllComponentsOperation(options),
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
   * `startupSkippedByShutdownRequest`.
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
      () => this.core.componentStart.startComponentOperation(name, options),
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
   * Attaching again while attached adds no second set of handlers, but every call
   * cancels a pending automatic detach (`detachSignalsOnStop`).
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
   * Manually trigger a reload event.
   * @returns Result of broadcasting reload to components
   */
  public triggerReload(): Promise<SignalBroadcastResult> {
    return this.core.signals.settleSignalRequest('reload', 'trigger');
  }

  /**
   * Manually trigger an info event.
   * @returns Result of broadcasting info to components
   */
  public triggerInfo(): Promise<SignalBroadcastResult> {
    return this.core.signals.settleSignalRequest('info', 'trigger');
  }

  /**
   * Manually trigger a debug event.
   * @returns Result of broadcasting debug to components
   */
  public triggerDebug(): Promise<SignalBroadcastResult> {
    return this.core.signals.settleSignalRequest('debug', 'trigger');
  }

  // ============================================================================
  // Logger Exit Hook
  // ============================================================================

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
    return this.core.messaging.sendMessageSettled(
      componentName,
      payload,
      null,
      options,
    );
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
    return this.core.messaging.broadcastMessageSettled(payload, null, options);
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
    return this.core.messaging.getValueSettled<T>(
      componentName,
      key,
      null,
      options,
    );
  }

  // ============================================================================
  // Wiring
  // ============================================================================

  /**
   * The access context the component-facing modules - messaging, value reads, health
   * checks, signal broadcasts and shutdown warnings - work through. These modules can
   * inspect live state and dispatch hooks, but cannot own lifecycle
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
        manager.core.startSettlements.isRawStartPending(name),
      // A late start's cleanup marks its component running only to stop it: messaging,
      // value reads, health checks, signals and shutdown warnings must not enter it as
      // if it were up.
      isLateStartCleanupPending: (name) =>
        manager.state.pendingBulkStartupCleanup.has(name),
      sendMessageSettled: (name, payload, from, options) =>
        manager.core.messaging.sendMessageSettled(name, payload, from, options),
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

  /**
   * Where the dispatcher delivers each event: this manager's own `emit()`. Safe delivery
   * also contains an overridden emitter that throws.
   */
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
