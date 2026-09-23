import { EventEmitterProtected } from '../event-emitter';
import { ulid } from 'ulid';
import type { BeforeExitResult, Logger } from '../logger';
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
  ComponentHealthResult,
  LifecycleInternalCallbacks,
  RepeatedShutdownRequestPolicy,
  ForceShutdownContext,
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
  LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP,
  LIFECYCLE_MANAGER_LOG_LOGGER_EXIT_DURING_SHUTDOWN,
  LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED,
  LIFECYCLE_MANAGER_LOG_OPTIONAL_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
  LIFECYCLE_MANAGER_LOG_REQUIRED_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
  LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE,
  LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE_EXTERNAL,
  LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
  LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
  LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
} from './constants';
import {
  ProcessSignalManager,
  type ShutdownSignal,
} from '../process-signal-manager';
import { isPromise } from '../is-promise';
import {
  reportCallbackError,
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from '../safe-handle-callback';
import { createGuardedLoggerService } from './guarded-logger';
import { describeError, isErrorValue, toError } from '../to-error';
import { finiteClamp, finiteClampMin } from '../clamp';
import { MAX_TIMER_MS } from '../internal/timer-limits';

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
/**
 * A delay a timer can actually keep, from whatever a caller or component supplied.
 *
 * `setTimeout` holds its delay in a signed 32-bit integer and reads anything past
 * `MAX_TIMER_MS` as `1` - and reads `Infinity` and `NaN` as `0`. Every failure is the same
 * inversion: the longer the wait someone writes, the sooner it happens. Here that means a
 * `startupTimeoutMS: Infinity` - the honest spelling of "let it take as long as it needs" -
 * aborted a perfectly healthy startup on the next tick.
 *
 * Applied at the timer rather than only where the options are read, because these delays
 * arrive from four places: the constructor's own fields, a per-call `timeoutMS` override, a
 * shutdown policy, and `component.signalTimeoutMS`, which the component supplies. Bounding
 * every one of them at its source is a list that has to stay complete; bounding them here
 * is the same list, at the one point they all pass through.
 *
 * A non-finite delay becomes the longest wait a timer can keep rather than the shortest.
 * These are safety timeouts, and the two ways to be wrong are not symmetric: waiting too
 * long leaves a hung component hanging, which is the failure the operator is already
 * watching for, while firing at once tears down a healthy one that was doing nothing
 * wrong. Constructor-owned fields resolve `NaN` to their documented defaults; component
 * fields and per-call overrides still reach this boundary directly.
 */
function toTimerDelayMS(requested: number): number {
  if (!Number.isFinite(requested) || requested < 0) {
    return MAX_TIMER_MS;
  }

  return Math.min(Math.max(requested, 0), MAX_TIMER_MS);
}

/**
 * A shutdown pass's options, resolved against the manager's defaults.
 *
 * Resolved by the acceptance step rather than by the pass, so the reads that could throw
 * happen on the side of the latch where a throw costs nothing.
 */
interface ShutdownPassOptions {
  /** Already clamped to a usable timer delay by `toTimerDelayMS()`; `0` means no timer. */
  readonly timeoutMS: number;
  readonly retryStalled: boolean;
  readonly haltOnStall: boolean;
}

/**
 * A shutdown pass that has been accepted and is running.
 *
 * "A shutdown was requested while this pass was running" is a property of the pass, not of
 * the manager: a request path marks the pass that refused it, and a caller that owns a
 * pass - a `restartAllComponents()` stop phase - reads its own. The two have the same
 * lifetime by construction, so there is no window to open, close, or hand over.
 */
interface ShutdownPass {
  /**
   * Set when a shutdown request lands while this pass is running, so the restart that
   * owns the pass skips its startup phase and the components stay stopped.
   */
  shutdownRequested: boolean;
}

/**
 * What `acceptShutdownPass()` answers: either the refusal the caller reports as its own
 * `ShutdownResult`, or the pass it started.
 *
 * Discriminated rather than inferred from whether a callback fired, so a caller can tell
 * the two apart without depending on which statements in between can throw.
 */
type ShutdownPassAcceptance =
  | { readonly accepted: false; readonly result: ShutdownResult }
  | {
      readonly accepted: true;
      readonly pass: ShutdownPass;
      readonly promise: Promise<ShutdownResult>;
    };

export class LifecycleManager
  extends EventEmitterProtected
  implements LifecycleCommon
{
  // Configuration
  private readonly name: string;
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
  private readonly shutdownWarningTimeoutMS: number;
  private readonly messageTimeoutMS: number;
  private readonly startupTimeoutMS: number;
  private readonly shutdownOptions?: StopAllOptions;
  private readonly attachSignalsBeforeStartup: boolean;
  private readonly attachSignalsOnStart: boolean;
  private readonly detachSignalsOnStop: boolean;
  private readonly repeatedShutdownRequestPolicy?: {
    forceAfterCount: number;
    withinMS: number;
    armedAfterFailureMS: number;
    countManualRetriesTowardEscalation: boolean;
    hasExplicitArmedAfterFailureMS: boolean;
    onForceShutdown: RepeatedShutdownRequestPolicy['onForceShutdown'];
  };

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
  /**
   * Whether `reportUnexpectedStop()` was called with a real `Error`, as opposed to with
   * nothing or with an off-type value.
   *
   * Recorded separately because `componentErrors` now holds a *normalized* error:
   * `toError` turns any reported value into an `Error`, which is what keeps a hostile
   * value from stranding the manager, but it also means `instanceof Error` can no longer
   * answer "did the component explain why it stopped?". The overlapping-startup-failure
   * rule in `startComponent` depends on that distinction.
   */
  private componentUnexpectedStopHadError: Map<string, boolean> = new Map();
  private componentStartAttemptTokens: Map<string, string> = new Map();
  private pendingBulkStartupCleanup = new Map<string, string>();
  // Use per-stop ULIDs instead of incrementing counters because a stalled
  // component can be unregistered and replaced by a same-name instance before
  // the old floating stop promise settles.
  private componentStopAttemptTokens: Map<string, string> = new Map();
  private pendingForceStopWaiters: Map<string, Set<() => void>> = new Map();
  private unexpectedStopsDuringStartup: Map<string, Error | null> = new Map();

  // State flags
  private isStarting = false;
  private autoAttachedSignalsDuringStartup = false;
  private isStarted = false;
  private isShuttingDown = false;
  // Unique token used to detect shutdowns that happened during async start().
  private shutdownToken = ulid();
  // The shutdown pass currently running, or `null` when none is. Shares the latch's
  // lifetime exactly - taken with it, cleared with it - so a request refused because
  // `isShuttingDown` hid it behind "already in progress" can be recorded against the
  // pass that refused it. See {@link ShutdownPass}.
  private activeShutdownPass: ShutdownPass | null = null;
  // Resolver for the first logger.exit() deferred during an already-running shutdown.
  private pendingLoggerExitResolve:
    ((result: BeforeExitResult) => void) | null = null;
  private shutdownMethod: ShutdownMethod | null = null;
  private lastShutdownResult: ShutdownResult | null = null;
  private repeatedShutdownExpiryTimer: NodeJS.Timeout | null = null;
  private repeatedShutdownRequestState: {
    requestCount: number;
    firstMethod: ShutdownMethod | null;
    latestMethod: ShutdownMethod | null;
    firstRequestAt: number | null;
    latestRequestAt: number | null;
    repeatedWindowStartedAt: number | null;
    hasTriggeredForceShutdown: boolean;
    remainsArmedUntil: number | null;
  } = {
    requestCount: 0,
    firstMethod: null,
    latestMethod: null,
    firstRequestAt: null,
    latestRequestAt: null,
    repeatedWindowStartedAt: null,
    hasTriggeredForceShutdown: false,
    remainsArmedUntil: null,
  };

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
    // Guarded once, here, rather than at the ~140 call sites that log: the logger is
    // caller-supplied, and a method that throws or rejects would otherwise propagate
    // into whatever lifecycle operation happened to be logging at the time.
    this.logger = createGuardedLoggerService(
      this.rootLogger.service(this.name),
    );
    // Floored at `-1`, not at `0`: a negative value is the documented way to skip the
    // warning phase entirely, so clamping it up to zero would silently turn the opt-out
    // into a zero-length warning. Every negative means the same thing to the check that
    // reads it, so they collapse to one.
    this.shutdownWarningTimeoutMS = finiteClamp(
      options.shutdownWarningTimeoutMS === Infinity
        ? MAX_TIMER_MS
        : options.shutdownWarningTimeoutMS === -Infinity
          ? -1
          : (options.shutdownWarningTimeoutMS ?? 500),
      -1,
      MAX_TIMER_MS,
      500,
    );
    this.messageTimeoutMS = finiteClamp(
      options.messageTimeoutMS === Infinity
        ? MAX_TIMER_MS
        : (options.messageTimeoutMS ?? 5000),
      0,
      MAX_TIMER_MS,
      5000,
    );
    this.startupTimeoutMS = finiteClamp(
      options.startupTimeoutMS === Infinity
        ? MAX_TIMER_MS
        : (options.startupTimeoutMS ?? 60000),
      0,
      MAX_TIMER_MS,
      60000,
    );
    this.shutdownOptions = {
      retryStalled: true,
      haltOnStall: true,
      ...options.shutdownOptions,
      // Constructor NaN means the documented default, as for startup and messaging.
      // Other values retain their timer-boundary semantics, including zero disabling it.
      timeoutMS: Number.isNaN(options.shutdownOptions?.timeoutMS)
        ? 30000
        : (options.shutdownOptions?.timeoutMS ?? 30000),
    };
    this.attachSignalsBeforeStartup =
      options.attachSignalsBeforeStartup ?? false;
    this.attachSignalsOnStart = options.attachSignalsOnStart ?? false;
    this.detachSignalsOnStop = options.detachSignalsOnStop ?? false;
    const repeatedShutdownRequestPolicy = options.repeatedShutdownRequestPolicy;
    if (repeatedShutdownRequestPolicy === undefined) {
      this.repeatedShutdownRequestPolicy = undefined;
    } else {
      const hasFiniteExplicitArmedAfterFailureMS = Number.isFinite(
        repeatedShutdownRequestPolicy.armedAfterFailureMS,
      );
      // Require at least one follow-up request so threshold comparisons stay meaningful.
      const forceAfterCount = finiteClampMin(
        repeatedShutdownRequestPolicy.forceAfterCount,
        1,
        3,
      );
      // A zero-width window is valid and means only same-tick follow-up requests count.
      const withinMS = finiteClampMin(
        repeatedShutdownRequestPolicy.withinMS,
        0,
        2000,
      );
      // Invalid explicit durations fall back to the derived default instead of
      // breaking the post-failure arming timer.
      const armedAfterFailureMS = toTimerDelayMS(
        finiteClampMin(
          repeatedShutdownRequestPolicy.armedAfterFailureMS,
          0,
          withinMS * forceAfterCount,
        ),
      );
      this.repeatedShutdownRequestPolicy = {
        forceAfterCount,
        withinMS,
        armedAfterFailureMS,
        countManualRetriesTowardEscalation:
          repeatedShutdownRequestPolicy.countManualRetriesTowardEscalation ??
          false,
        hasExplicitArmedAfterFailureMS: hasFiniteExplicitArmedAfterFailureMS,
        onForceShutdown: repeatedShutdownRequestPolicy.onForceShutdown,
      };
    }

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
    const result = await this.registerComponentSettled(
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
    return this.registerComponentSettled(
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
  public unregisterComponent(
    name: string,
    options?: UnregisterOptions,
  ): Promise<UnregisterComponentResult> {
    return this.settleOperation(
      'unregisterComponent',
      () => this.unregisterComponentOperation(name, options),
      (error, reason) => ({
        success: false,
        componentName: name,
        reason,
        code: 'unknown_error',
        error,
        wasStopped: false,
        wasRegistered: this.componentStates.has(name),
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
   * Get components whose last start attempt timed out
   */
  public getStartTimedOutComponentCount(): number {
    return this.getStartTimedOutComponentNames().length;
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
    const startTimedOut = this.getStartTimedOutComponentCount();
    const registeredNames = this.getComponentNames();
    const runningNames = this.getRunningComponentNames();
    const stalledNames = this.getStalledComponentNames();
    const stoppedNames = this.getStoppedComponentNames();
    const startTimedOutNames = this.getStartTimedOutComponentNames();

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
        startTimedOut,
      },
      components: {
        registered: registeredNames,
        running: runningNames,
        stopped: stoppedNames,
        stalled: stalledNames,
        startTimedOut: startTimedOutNames,
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
   * Get components whose last start attempt timed out
   */
  public getStartTimedOutComponentNames(): string[] {
    return this.getComponentNames().filter(
      (name) => this.componentStates.get(name) === 'starting-timed-out',
    );
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
      const err = toError(error);
      const code =
        err instanceof DependencyCycleError
          ? 'dependency_cycle'
          : 'unknown_error';

      this.logger.error('Failed to resolve startup order: {{error.message}}', {
        params: { error: err },
      });

      return {
        success: false,
        startupOrder: [],
        // `describeError`, not `err.message`: `toError` returns a brand-claiming value
        // unchanged, so `message` can be an accessor that throws - and this `catch` is
        // the whole reason `getStartupOrder` does not throw, so a throw here would defeat
        // it. Same guard as the `component_startup_failed` path below.
        reason: describeError(err),
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

  /**
   * Get the result of the last shutdown operation.
   * Useful for debugging stalled components or tracking shutdown metrics.
   * Returns null if no shutdown has occurred yet or after a successful restart.
   *
   * @returns The last shutdown result or null
   */
  public getLastShutdownResult(): ShutdownResult | null {
    return this.lastShutdownResult;
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
   * - Handles shutdown during startup (aborts; shutdown owns cleanup)
   */
  public startAllComponents(options?: StartupOptions): Promise<StartupResult> {
    return this.settleOperation(
      'startAllComponents',
      () => this.startAllComponentsOperation(options),
      (error, reason) => ({
        ...this.refusedStartupResult('unknown_error', reason),
        error,
      }),
    );
  }

  /**
   * Stop all running components in reverse dependency order
   *
   * Components stop in reverse topological order (dependents before dependencies).
   *
   * Never rejects. Stalls and timeouts are reported in the resolved `ShutdownResult`, and
   * so is a pass that throws outright: it resolves with `code: 'unknown_error'` and the
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
   * @param options - Optional shutdown options
   */
  public stopAllComponents(options?: StopAllOptions): Promise<ShutdownResult> {
    return this.settleOperation(
      'stopAllComponents',
      () => this.stopAllComponentsOperation(options),
      (error, reason) => this.crashedShutdownResult(error, reason),
    );
  }

  /**
   * Restart all components (stop then start)
   *
   * Never rejects: see {@link stopAllComponents}. A stop phase that throws outright
   * resolves with its `unknown_error` result and the startup phase is skipped, since
   * nothing can be said about what state it left the components in.
   *
   * A shutdown request that arrives while the stop phase is running wins: the startup
   * phase is skipped and the result says so through
   * `startupSkippedByShutdownRequest`. See {@link ShutdownPass}.
   *
   * A restart that starts while a shutdown is already running has its stop phase refused
   * and so owns no pass; it never reports a skipped startup, and gets whatever that
   * refusal and `startAllComponents()` answer.
   */
  public restartAllComponents(
    options?: RestartAllOptions,
  ): Promise<RestartResult> {
    // Filled in once the stop phase has answered, so a crash after it - in the startup
    // phase's bookkeeping, say - still reports the shutdown that actually happened, the
    // same result `shutdown-completed` and `getLastShutdownResult()` already carry.
    const phases: { shutdownResult?: ShutdownResult } = {};

    return this.settleOperation(
      'restartAllComponents',
      () => this.restartAllComponentsOperation(options, phases),
      (error, reason) => ({
        shutdownResult:
          phases.shutdownResult ?? this.crashedShutdownResult(error, reason),
        startupResult: {
          ...this.refusedStartupResult('unknown_error', reason),
          error,
        },
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
    return this.settleOperation(
      'startComponent',
      () => this.startComponentInternal(name, options),
      (error, reason) => this.crashedComponentResult(name, error, reason),
    );
  }

  /**
   * Stop a specific component
   */
  public stopComponent(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    return this.settleOperation(
      'stopComponent',
      () => this.stopComponentOperation(name, options),
      (error, reason) => this.crashedComponentResult(name, error, reason),
    );
  }

  /**
   * Restart a component (stop then start)
   */
  public restartComponent(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult> {
    return this.settleOperation(
      'restartComponent',
      () => this.restartComponentOperation(name, options),
      (error, reason) => this.crashedComponentResult(name, error, reason),
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
   * Get status information about repeated shutdown escalation configuration and runtime state.
   */
  public getShutdownEscalationStatus(): ShutdownEscalationStatus {
    if (this.repeatedShutdownRequestPolicy === undefined) {
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

    const armedUntil = this.repeatedShutdownRequestState.remainsArmedUntil;
    const isArmed = armedUntil !== null;

    return {
      configured: true,
      isShuttingDown: this.isShuttingDown,
      isArmed,
      forceAfterCount: this.repeatedShutdownRequestPolicy.forceAfterCount,
      withinMS: this.repeatedShutdownRequestPolicy.withinMS,
      armedAfterFailureMS:
        this.repeatedShutdownRequestPolicy.armedAfterFailureMS,
      armedAfterFailureMSSource: this.repeatedShutdownRequestPolicy
        .hasExplicitArmedAfterFailureMS
        ? 'explicit'
        : 'derived',
      countManualRetriesTowardEscalation:
        this.repeatedShutdownRequestPolicy.countManualRetriesTowardEscalation,
      requestCount: this.repeatedShutdownRequestState.requestCount,
      firstMethod: this.repeatedShutdownRequestState.firstMethod,
      latestMethod: this.repeatedShutdownRequestState.latestMethod,
      firstRequestAt: this.repeatedShutdownRequestState.firstRequestAt,
      latestRequestAt: this.repeatedShutdownRequestState.latestRequestAt,
      repeatedWindowStartedAt:
        this.repeatedShutdownRequestState.repeatedWindowStartedAt,
      armedUntil: isArmed ? armedUntil : null,
      hasTriggeredForceShutdown:
        this.repeatedShutdownRequestState.hasTriggeredForceShutdown,
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
        // Defer the first logger.exit() that arrives during an already-running
        // shutdown. Later duplicate exit calls stay ignored so they cannot
        // override the eventual exit code after shutdown completes.
        if (this.isShuttingDown) {
          // The process is on its way out, so a restart stopping right now must not
          // start everything back up behind the exit.
          this.noteShutdownRequestDuringActivePass();

          if (isFirstExit && this.pendingLoggerExitResolve === null) {
            this.logger.debug(
              LIFECYCLE_MANAGER_LOG_LOGGER_EXIT_DURING_SHUTDOWN,
              {
                params: { exitCode },
              },
            );

            return await new Promise<BeforeExitResult>((resolve) => {
              this.pendingLoggerExitResolve = resolve;
            });
          }

          this.logger.debug(LIFECYCLE_MANAGER_LOG_LOGGER_EXIT_DURING_SHUTDOWN, {
            params: { exitCode },
          });

          return { action: 'wait' as const };
        }

        if (isFirstExit) {
          this.logger.info('Logger exit triggered, stopping components...', {
            params: { exitCode, timeoutMS: this.shutdownOptions?.timeoutMS },
          });

          // Stop all components with the manager's `shutdownOptions` defaults
          await this.stopAllComponents();
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
  public triggerReload(): Promise<SignalBroadcastResult> {
    return this.settleOperation(
      'triggerReload',
      () => this.handleReloadRequest(),
      (error) => this.crashedSignalBroadcastResult('reload', error),
    );
  }

  /**
   * Manually trigger an info event.
   * @returns Result of broadcasting info to components
   */
  public triggerInfo(): Promise<SignalBroadcastResult> {
    return this.settleOperation(
      'triggerInfo',
      () => this.handleInfoRequest(),
      (error) => this.crashedSignalBroadcastResult('info', error),
    );
  }

  /**
   * Manually trigger a debug event.
   * @returns Result of broadcasting debug to components
   */
  public triggerDebug(): Promise<SignalBroadcastResult> {
    return this.settleOperation(
      'triggerDebug',
      () => this.handleDebugRequest(),
      (error) => this.crashedSignalBroadcastResult('debug', error),
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
    return this.settleOperation(
      'checkComponentHealth',
      () => this.checkComponentHealthOperation(name),
      (error) => this.crashedHealthCheckResult(name, error),
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
    return this.settleOperation(
      'checkAllHealth',
      () => this.checkAllHealthOperation(),
      (error) => ({
        healthy: false,
        components: [],
        checkedAt: Date.now(),
        durationMS: 0,
        timedOut: false,
        code: 'error',
        error,
      }),
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

    // Startup and teardown are unavailable states, not handler failures.
    const state = this.componentStates.get(componentName);
    if (
      state === 'starting' ||
      state === 'starting-timed-out' ||
      state === 'stopping' ||
      state === 'force-stopping'
    ) {
      return {
        sent: false,
        componentFound: true,
        componentRunning: false,
        handlerImplemented: false,
        data: undefined,
        error: null,
        timedOut: false,
        code: 'stopped',
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
        const err = toError(error);

        this.logger
          .entity(componentName)
          .error(LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED, {
            params: { error: err, from },
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
      }

      const handlerPromise = isPromise(result)
        ? result
        : Promise.resolve(result);

      const outcome =
        toTimerDelayMS(timeoutMS) > 0
          ? await Promise.race([
              handlerPromise,
              new Promise<typeof timeoutResult>((resolve) => {
                timeoutHandle = setTimeout(() => {
                  resolve(timeoutResult);
                }, toTimerDelayMS(timeoutMS));
              }),
            ])
          : await handlerPromise;

      if (outcome === timeoutResult) {
        this.logger.entity(componentName).warn('Message handler timed out', {
          params: { from, timeoutMS },
        });
        // Prevent unhandled rejection if handler throws after timeout
        // Logged, not discarded. Preventing the unhandled rejection is why this
        // `catch` exists and it stays; swallowing the *cause* was a separate
        // decision, and it left the caller knowing the operation timed out and
        // never why it ultimately failed. The timeout warning is logged just
        // above, so this is that line's missing second half.
        Promise.resolve(handlerPromise)
          .catch((error: unknown) => {
            this.logger
              .entity(componentName)
              .debug('Message handler failed after it had already timed out', {
                params: { error: toError(error), from },
              });
          })
          // Terminal, for the reason the shutdown-warning chain carries one: nothing
          // retains this chain, so a throw out of the reporting handler above becomes an
          // unhandled rejection mid-lifecycle - fatal under Node's default
          // `--unhandled-rejections=throw`. Logging is guarded, but a floating chain
          // should not have to rely on that.
          .catch(() => {
            // Nothing left to report with.
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
      const err = toError(error);

      this.logger
        .entity(componentName)
        .error(LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED, {
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
    if (hasExplicitTargets && options.componentNames) {
      const names = options.componentNames;
      targetComponents = targetComponents.filter((c) =>
        names.includes(c.getName()),
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
      // Per component, so one that breaks its contract becomes its own `error` entry
      // rather than crashing the broadcast and losing every answer already collected.
      const name = this.readComponentNameSafely(component);
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

      // Through the per-message safety net, for the same reason as the name read above.
      const messageResult = await this.sendMessageSettled(
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

    // Neither override permits entering a provider during startup or teardown.
    const state = this.componentStates.get(componentName);
    const isUnavailable =
      state === 'starting' ||
      state === 'starting-timed-out' ||
      state === 'stopping' ||
      state === 'force-stopping';
    const isRunning = !isUnavailable && this.isComponentRunning(componentName);
    const isStalled =
      !isUnavailable && this.stalledComponents.has(componentName);
    const allowStopped = options?.includeStopped === true;
    const allowStalled = options?.includeStalled === true;
    const isStopped = !isRunning && !isStalled;

    if (
      isUnavailable ||
      (!isRunning &&
        !((isStopped && allowStopped) || (isStalled && allowStalled)))
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
      const err = toError(error);

      this.logger
        .entity(componentName)
        .error('getValue handler failed: {{error.message}}', {
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
    return this.settleOperation(
      'sendMessageToComponent',
      () => this.sendMessageInternal(componentName, payload, from, options),
      (error) => ({
        sent: false,
        componentFound: this.componentStates.has(componentName),
        componentRunning: this.runningComponents.has(componentName),
        handlerImplemented: false,
        data: undefined,
        error,
        timedOut: false,
        code: 'error',
      }),
    );
  }

  /**
   * `broadcastMessageInternal()` under the public-method safety net, shared the same way
   * as {@link sendMessageSettled}. A crash leaves no per-component answers to return; it
   * is reported on the global channel instead.
   */
  private broadcastMessageSettled(
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    return this.settleOperation(
      'broadcastMessage',
      () => this.broadcastMessageInternal(payload, from, options),
      () => [],
    );
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
    return this.settleOperation(
      isInsertAction ? 'insertComponentAt' : 'registerComponent',
      () =>
        this.registerComponentInternal(
          component,
          position,
          targetComponentName,
          isInsertAction,
          options,
        ),
      (error, reason) => {
        const registrationIndex = this.components.indexOf(component);

        return {
          action: 'insert',
          success: false,
          // Whatever the registry actually holds, not what the failure implies: a throw
          // after the commit leaves the component registered.
          registered: registrationIndex !== -1,
          componentName: this.readComponentNameSafely(component),
          reason,
          code: 'unknown_error',
          error,
          registrationIndexBefore: null,
          registrationIndexAfter:
            registrationIndex === -1 ? null : registrationIndex,
          startupOrder: [],
          requestedPosition: { position, targetComponentName },
          manualPositionRespected: false,
        };
      },
    );
  }

  private async unregisterComponentOperation(
    name: string,
    options?: UnregisterOptions,
  ): Promise<UnregisterComponentResult> {
    // Block unregistration during bulk operations
    if (
      this.isStarting ||
      this.isShuttingDown ||
      this.pendingBulkStartupCleanup.has(name)
    ) {
      this.logger
        .entity(name)
        .warn(LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS, {
          params: {
            isStarting: this.isStarting,
            isShuttingDown: this.isShuttingDown,
          },
        });

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
        code: 'bulk_operation_in_progress',
        wasStopped: false,
        wasRegistered: this.hasComponent(name),
      };
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
    let wasStopped = false;
    if (isRunning && shouldStopIfRunning) {
      this.logger.entity(name).info('Stopping component before unregistering');
      const stopResult = await this.stopComponent(name, {
        allowStopWithRunningDependents: options?.forceStop,
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
            stopResult.code === 'component_shutdown_timeout'
              ? 'timeout'
              : 'error',
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
    component._clearUnexpectedStopHandler();
    component._markUnregistered();
    this.componentStates.delete(name);
    this.componentTimestamps.delete(name);
    this.componentErrors.delete(name);
    this.componentUnexpectedStopHadError.delete(name);
    this.componentStartAttemptTokens.delete(name);
    this.componentStopAttemptTokens.delete(name);
    this.pendingForceStopWaiters.delete(name);
    this.stalledComponents.delete(name);
    this.runningComponents.delete(name);
    this.updateStartedFlag();

    this.detachSignalsAfterLastStop(
      'last component unregistered',
      'Auto-detaching process signals on last component unregistered',
    );

    this.logger.entity(name).info('Component unregistered');
    this.lifecycleEvents.componentUnregistered(name, false);

    return {
      success: true,
      componentName: name,
      wasStopped,
      wasRegistered: true,
    };
  }

  private async startAllComponentsOperation(
    options?: StartupOptions,
  ): Promise<StartupResult> {
    const startTime = Date.now();

    // Reject if already starting
    if (this.isStarting) {
      this.logger.warn(
        'Cannot start all components: startup already in progress',
      );

      return this.refusedStartupResult(
        'already_in_progress',
        'Startup already in progress',
        Date.now() - startTime,
      );
    }

    // Reject if shutdown is in progress
    if (this.isShuttingDown) {
      this.logger.warn('Cannot start all components: shutdown in progress');

      return this.refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        Date.now() - startTime,
      );
    }

    const totalCount = this.getComponentCount();
    const runningCount = this.getRunningComponentCount();

    if (totalCount === 0) {
      this.logger.warn('Cannot start all components: none registered');

      return this.refusedStartupResult(
        'no_components_registered',
        'No components registered',
        Date.now() - startTime,
      );
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
        reason: `${runningCount} of ${totalCount} components already running`,
        code: 'partial_state',
        durationMS: Date.now() - startTime,
      };
    }

    // The latch goes up before the attach, not after it: attaching emits
    // `lifecycle-manager:signals-attached` synchronously, and a listener that calls
    // `startAllComponents()` from there must find a startup already in progress rather
    // than run a second one alongside this. Everything else this startup resets waits
    // until the attach has succeeded, so a refusal only has the latch to release.
    this.isStarting = true;
    this.autoAttachedSignalsDuringStartup = false;

    const shutdownTokenBeforeAttach = this.shutdownToken;

    // Tracked so failure cleanup does not detach handlers that were attached earlier by
    // some other path.
    const bulkSignalAttach = this.attachSignalsBeforeStartup
      ? this.autoAttachSignals('bulk startup')
      : null;

    if (bulkSignalAttach?.outcome === 'failed') {
      this.isStarting = false;
      this.autoAttachedSignalsDuringStartup = false;

      return {
        ...this.refusedStartupResult(
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
    if (
      this.isShuttingDown ||
      this.shutdownToken !== shutdownTokenBeforeAttach
    ) {
      this.isStarting = false;

      if (didAutoAttachSignalsForBulkStartup) {
        this.autoDetachSignalsIfIdle('refused bulk startup');
      }

      this.autoAttachedSignalsDuringStartup = false;

      return this.refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        Date.now() - startTime,
      );
    }

    // Clear previous shutdown state
    const shutdownTokenAtBulkStart = this.shutdownToken;
    this.unexpectedStopsDuringStartup.clear();
    this.resetRepeatedShutdownRequestState();
    this.shutdownMethod = null; // Clear previous shutdown method on fresh start
    this.lastShutdownResult = null; // Clear last shutdown result on fresh start

    this.logger.info('Starting all components');

    const startedComponents: string[] = [];
    const failedOptionalComponents: Array<{ name: string; error: Error }> = [];
    const skippedDueToDependency = new Set<string>();
    const skippedDueToStall = new Set<string>();
    const effectiveTimeout = options?.timeoutMS ?? this.startupTimeoutMS;
    let hasTimedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;

    const bulkDelay = toTimerDelayMS(effectiveTimeout);
    const deadline = bulkDelay > 0 ? Date.now() + bulkDelay : undefined;
    const expireStartup = (): void => {
      if (hasTimedOut) {
        return;
      }
      hasTimedOut = true;
      this.logger.warn('Startup timeout exceeded, returning partial results', {
        params: { timeoutMS: effectiveTimeout },
      });
    };
    // The startup deadline bounds starts. Rollback has its own stop timeouts.
    if (bulkDelay > 0) {
      timeoutHandle = setTimeout(expireStartup, bulkDelay);
    }

    const operation = async (): Promise<StartupResult> => {
      try {
        // Get startup order (topological sort)
        let startupOrder: string[];

        try {
          startupOrder = this.getStartupOrderInternal();
        } catch (error) {
          const err = toError(error);
          const code =
            err instanceof DependencyCycleError
              ? 'dependency_cycle'
              : 'unknown_error';

          this.logger.error(
            'Failed to resolve startup order: {{error.message}}',
            {
              params: { error: err },
            },
          );

          return {
            success: false,
            startedComponents: [],
            failedOptionalComponents: [],
            skippedDueToDependency: [],
            // `describeError`, not `err.message`, for the reason `getStartupOrder` uses it:
            // a brand-claiming throw can make `message` an accessor that throws, and this
            // `try` has only a `finally` above it, so that would reject `startAllComponents`
            // instead of returning a failed `StartupResult`.
            reason: describeError(err),
            code,
            error: err,
            durationMS: Date.now() - startTime,
          };
        }

        // Start each component in dependency order
        for (const name of startupOrder) {
          // Synchronous starts can exhaust the budget without yielding to timers.
          if (deadline !== undefined && Date.now() >= deadline) {
            expireStartup();
          }
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

          // Skip stalled components during bulk startup (even with ignoreStalledComponents:true bulk option)
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
          if (
            this.isShuttingDown ||
            this.shutdownToken !== shutdownTokenAtBulkStart
          ) {
            this.logger.warn(
              'Shutdown signal received during startup, aborting',
            );

            return {
              success: false,
              startedComponents: startedComponents.filter((name) =>
                this.isComponentRunning(name),
              ),
              failedOptionalComponents: [],
              skippedDueToDependency: [],
              reason: 'Shutdown triggered during startup',
              code: 'shutdown_in_progress',
              durationMS: Date.now() - startTime,
            };
          }

          // Start the component (allow during bulk startup since we ARE the bulk operation)
          const result = await this.startComponentInternal(
            name,
            {
              allowDuringBulkStartup: true,
            },
            deadline === undefined
              ? undefined
              : {
                  deadline,
                  onTimeout: expireStartup,
                  hasExpired: () => hasTimedOut,
                },
          );

          if (this.shutdownToken !== shutdownTokenAtBulkStart) {
            if (result.success || result.code === 'component_already_running') {
              startedComponents.push(name);
            }
            return {
              success: false,
              startedComponents: startedComponents.filter((name) =>
                this.isComponentRunning(name),
              ),
              failedOptionalComponents,
              skippedDueToDependency: [...skippedDueToDependency],
              reason: 'Shutdown triggered during startup',
              code: 'shutdown_in_progress',
              durationMS: Date.now() - startTime,
            };
          }

          // A bulk timeout has no completed outcome to account for. Other results
          // must be handled before checking the clock so failures retain their errors
          // and rollback, and already-running components remain in the snapshot.
          if (hasTimedOut && result.code === 'component_startup_timeout') {
            break;
          }

          if (result.success) {
            startedComponents.push(name);
          } else if (result.code === 'component_already_running') {
            // Component is already running - this is fine (might have been started manually)
            // Add to startedComponents so it's tracked as part of this bulk operation
            startedComponents.push(name);
          } else if (result.code === 'shutdown_in_progress') {
            return {
              success: false,
              startedComponents: startedComponents.filter((name) =>
                this.isComponentRunning(name),
              ),
              failedOptionalComponents,
              skippedDueToDependency: Array.from(skippedDueToDependency),
              reason: result.reason || 'Shutdown triggered during startup',
              code: 'shutdown_in_progress',
              error: result.error,
              durationMS: Date.now() - startTime,
            };
          } else if (result.code === 'component_unexpected_stop') {
            // This branch is for components that reported an unexpected stop
            // before startComponentInternal() returned. That is distinct from the
            // post-success reconciliation below, which handles components that
            // had already been counted as started during this bulk pass.
            this.unexpectedStopsDuringStartup.delete(name);

            const error =
              result.error ||
              new Error(
                result.reason || `Component "${name}" stopped unexpectedly`,
              );

            if (component.isOptional()) {
              if (
                !failedOptionalComponents.some((entry) => entry.name === name)
              ) {
                failedOptionalComponents.push({ name, error });
              }

              this.logger
                .entity(name)
                .warn(
                  LIFECYCLE_MANAGER_LOG_OPTIONAL_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
                  {
                    params: { error },
                  },
                );
            } else {
              this.logger
                .entity(name)
                .error(
                  LIFECYCLE_MANAGER_LOG_REQUIRED_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
                  {
                    params: { error },
                  },
                );

              clearTimeout(timeoutHandle);
              await this.rollbackStartup(startedComponents);

              return {
                success: false,
                startedComponents: [],
                failedOptionalComponents,
                skippedDueToDependency: Array.from(skippedDueToDependency),
                // Guarded: this is the component's own reported error.
                reason: describeError(error),
                code: 'component_unexpected_stop',
                error,
                durationMS: Date.now() - startTime,
              };
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
            await this.rollbackStartup(
              this.runningComponents.has(name)
                ? [...startedComponents, name]
                : startedComponents,
            );

            return {
              ...this.refusedStartupResult(
                'signal_attach_failed',
                result.reason ?? 'Could not attach process signals',
                Date.now() - startTime,
              ),
              failedOptionalComponents,
              skippedDueToDependency: Array.from(skippedDueToDependency),
              error: result.error,
            };
          } else {
            // Check if component is optional
            if (component.isOptional()) {
              this.logger
                .entity(name)
                .warn(
                  'Optional component failed to start, continuing: {{error.message}}',
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
                  result.error ||
                  new Error(
                    result.reason || LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
                  ),
              });
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
              await this.rollbackStartup(startedComponents);

              return {
                success: false,
                startedComponents: [],
                failedOptionalComponents,
                skippedDueToDependency: Array.from(skippedDueToDependency),
                reason:
                  result.reason ||
                  `Required component "${name}" failed: ${result.code || 'unknown'}`,
                code: 'required_component_failed',
                error: result.error,
                durationMS: Date.now() - startTime,
              };
            }
          }

          const unexpectedStopResult = this.consumeUnexpectedStopsDuringStartup(
            startedComponents,
            failedOptionalComponents,
          );

          startedComponents.splice(0, startedComponents.length);
          startedComponents.push(...unexpectedStopResult.startedComponents);

          if (unexpectedStopResult.requiredFailure) {
            clearTimeout(timeoutHandle);
            await this.rollbackStartup(startedComponents);

            return {
              success: false,
              startedComponents: [],
              failedOptionalComponents,
              skippedDueToDependency: Array.from(skippedDueToDependency),
              reason: describeError(unexpectedStopResult.requiredFailure.error),
              code: 'component_unexpected_stop',
              error: unexpectedStopResult.requiredFailure.error,
              durationMS: Date.now() - startTime,
            };
          }

          // Promise continuations and completion observers can exhaust the budget
          // before timers run. Account for the settled result before expiring startup.
          if (deadline !== undefined && Date.now() >= deadline) {
            expireStartup();
          }
          if (hasTimedOut) {
            break;
          }
        }

        // Reconcile stops even when the loop exited on a startup timeout.
        const unexpectedStopResult = this.consumeUnexpectedStopsDuringStartup(
          startedComponents,
          failedOptionalComponents,
        );

        startedComponents.splice(0, startedComponents.length);
        startedComponents.push(...unexpectedStopResult.startedComponents);

        if (unexpectedStopResult.requiredFailure) {
          clearTimeout(timeoutHandle);
          await this.rollbackStartup(startedComponents);

          return {
            success: false,
            startedComponents: [],
            failedOptionalComponents,
            skippedDueToDependency: Array.from(skippedDueToDependency),
            reason: describeError(unexpectedStopResult.requiredFailure.error),
            code: 'component_unexpected_stop',
            error: unexpectedStopResult.requiredFailure.error,
            durationMS: Date.now() - startTime,
          };
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
      } catch (error) {
        // Something unplanned threw mid-startup - a component getter, say. Handled here
        // rather than left to the public safety net, which cannot see what this startup
        // had already started: rolled back like any other failed startup, so a failure
        // never leaves a partial set running behind a result that says otherwise.
        clearTimeout(timeoutHandle);
        reportCallbackError('lifecycle-manager startAllComponents', error);

        try {
          await this.rollbackStartup(startedComponents);
        } catch (rollbackError) {
          reportCallbackError(
            'lifecycle-manager startup rollback',
            rollbackError,
          );
        }

        return {
          ...this.refusedStartupResult(
            'unknown_error',
            `startAllComponents() failed unexpectedly: ${describeError(error)}`,
            Date.now() - startTime,
          ),
          // Whatever the rollback could not stop, so the result matches the registry.
          startedComponents: startedComponents.filter((name) =>
            this.runningComponents.has(name),
          ),
          failedOptionalComponents,
          skippedDueToDependency: Array.from(skippedDueToDependency),
          error: toError(error),
        };
      } finally {
        // Release the deadline callback when startup settles so it cannot report
        // a timeout after this operation has completed.
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        this.isStarting = false;

        if (
          didAutoAttachSignalsForBulkStartup ||
          this.autoAttachedSignalsDuringStartup
        ) {
          this.autoDetachSignalsIfIdle('failed bulk startup');
        }

        this.autoAttachedSignalsDuringStartup = false;
        this.unexpectedStopsDuringStartup.clear();
      }
    };
    // Component starts already race against the bulk deadline. Await their bookkeeping
    // and our finally block before exposing the result to a caller that may retry.
    return operation();
  }

  private async stopAllComponentsOperation(
    options?: StopAllOptions,
  ): Promise<ShutdownResult> {
    // Always the manual method for the public API, as it is not from a signal. A direct
    // stop call made while a shutdown is running expresses the same intent a signal
    // does, so a refusal is recorded on the running pass.
    const acceptance = this.acceptShutdownPass('manual', options, true);

    return acceptance.accepted ? acceptance.promise : acceptance.result;
  }

  private async restartAllComponentsOperation(
    options: RestartAllOptions | undefined,
    phases: { shutdownResult?: ShutdownResult },
  ): Promise<RestartResult> {
    this.logger.info('Restarting all components');

    // Phase 1: Stop all components (explicit defaults for restart semantics)
    const stopPhase = this.acceptShutdownPass(
      'manual',
      {
        timeoutMS: options?.shutdownTimeoutMS,
        // Always retry/halt during restart for deterministic shutdown behavior.
        retryStalled: true,
        haltOnStall: true,
      },
      // Not a request to stay down: see `acceptShutdownPass()`.
      false,
    );

    // A refused stop phase is somebody else's pass: this restart has nothing of its own
    // for a request to cancel, so it behaves exactly as it did before cancellation
    // existed.
    const shutdownResult = stopPhase.accepted
      ? await stopPhase.promise
      : stopPhase.result;

    phases.shutdownResult = shutdownResult;

    // Requests that land after the pass ends reach a later pass instead, and one made
    // during phase 2 aborts that startup on its own via `shutdownToken`.
    const wasCanceledByShutdownRequest =
      stopPhase.accepted && stopPhase.pass.shutdownRequested;

    // Phase 2: Start all components - unless something asked us to stay down while
    // phase 1 ran. Checked ahead of a stalled/failed stop phase: the request is the
    // stronger statement, and reporting it beats reporting whatever startup would
    // have refused for instead.
    if (wasCanceledByShutdownRequest) {
      const startupResult = this.refusedStartupResult(
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

    // A stop phase that crashed leaves the components in no state anyone can vouch for,
    // so starting them again on top of it is not a restart. It used to reject here.
    if (shutdownResult.code === 'unknown_error') {
      this.logger.warn('Restart abandoned: the shutdown phase failed', {
        params: { reason: shutdownResult.reason },
      });

      return {
        shutdownResult,
        startupResult: this.refusedStartupResult(
          'unknown_error',
          'Startup skipped: the restart shutdown phase failed unexpectedly',
        ),
        success: false,
      };
    }

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

  private async stopComponentOperation(
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
        reason: LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
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
        reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        code: 'shutdown_in_progress',
      };
    }

    // Check for running dependents unless allowStopWithRunningDependents option is true
    if (!options?.allowStopWithRunningDependents) {
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
          reason: `Component has running dependents: ${runningDependents.join(', ')}. Use { allowStopWithRunningDependents: true } option to bypass.`,
          code: 'has_running_dependents',
        };
      }
    }

    return this.stopComponentInternal(name, options);
  }

  private async restartComponentOperation(
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
          ? LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS
          : LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
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

  private async checkComponentHealthOperation(
    name: string,
  ): Promise<HealthCheckResult> {
    const startTime = Date.now();

    // Check if component exists
    const component = this.components.find((c) => c.getName() === name);

    if (!component) {
      return {
        name,
        healthy: false,
        message: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
        checkedAt: startTime,
        durationMS: 0,
        error: null,
        timedOut: false,
        code: 'not_found',
      };
    }

    // Teardown may outlive the bulk shutdown latch. Do not enter a health hook
    // while either stop phase is still using the component.
    const state = this.componentStates.get(name);
    if (
      !this.isComponentRunning(name) ||
      state === 'stopping' ||
      state === 'force-stopping'
    ) {
      const isStalled = this.stalledComponents.has(name);
      return {
        name,
        healthy: false,
        message: isStalled
          ? LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED
          : LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
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
      const timeoutMS = component.healthCheckTimeoutMS;
      const timeoutDelayMS = toTimerDelayMS(timeoutMS);
      const timeoutResult: ComponentHealthResult = {
        healthy: false,
        message: 'Health check timed out',
      };

      const healthCheckPromise = component.healthCheck();
      // Match startup and signal timeout semantics: zero means no timer. Racing against
      // `setTimeout(..., 0)` made the outcome depend on whether an otherwise healthy
      // check happened to settle before or after its first asynchronous turn.
      const result =
        timeoutDelayMS === 0
          ? await healthCheckPromise
          : await Promise.race([
              healthCheckPromise,
              new Promise<ComponentHealthResult>((resolve) => {
                timeoutHandle = setTimeout(() => {
                  resolve(timeoutResult);
                }, timeoutDelayMS);
              }),
            ]);

      // Normalize boolean to ComponentHealthResult
      const isTimedOut = result === timeoutResult;
      if (isTimedOut) {
        this.logger.entity(name).warn('Health check timed out', {
          params: { timeoutMS },
        });
        // Prevent unhandled rejection if health check throws after timeout
        // Logged, not discarded. Preventing the unhandled rejection is why this
        // `catch` exists and it stays; swallowing the *cause* was a separate
        // decision, and it left the caller knowing the operation timed out and
        // never why it ultimately failed. The timeout warning is logged just
        // above, so this is that line's missing second half.
        Promise.resolve(healthCheckPromise)
          .catch((error: unknown) => {
            this.logger
              .entity(name)
              .debug('Health check failed after it had already timed out', {
                params: { error: toError(error) },
              });
          })
          // Terminal, for the reason the shutdown-warning chain carries one: nothing
          // retains this chain, so a throw out of the reporting handler above becomes an
          // unhandled rejection mid-lifecycle - fatal under Node's default
          // `--unhandled-rejections=throw`. Logging is guarded, but a floating chain
          // should not have to rely on that.
          .catch(() => {
            // Nothing left to report with.
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
      const err = toError(error);

      this.logger.entity(name).error('Health check failed: {{error.message}}', {
        params: { error: err },
      });

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

  private async checkAllHealthOperation(): Promise<HealthReport> {
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
          message: LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
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
          reason: LIFECYCLE_MANAGER_MESSAGE_REGISTER_SHUTDOWN_IN_PROGRESS,
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
            LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
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
            LIFECYCLE_MANAGER_MESSAGE_REGISTER_REQUIRED_DEPENDENCY_DURING_STARTUP,
          targetFound: undefined,
        });
      }

      // Check if component instance is already registered
      if (component._isRegisteredWithManager()) {
        const isRegisteredHere = this.hasComponentInstance(component);
        const message = isRegisteredHere
          ? LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE
          : LIFECYCLE_MANAGER_MESSAGE_DUPLICATE_COMPONENT_INSTANCE_EXTERNAL;

        this.logger
          .entity(componentName)
          .warn(
            isRegisteredHere
              ? 'Component instance already registered'
              : 'Component instance already registered with another lifecycle manager',
          );

        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: 'duplicate_instance',
          message,
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
          reason: message,
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
        ) => this.getValueInternal<T>(compName, key, from, options),
      };

      // Assign lifecycle reference to component
      (component as unknown as { lifecycle: ComponentLifecycleRef }).lifecycle =
        new ComponentLifecycle(this, componentName, internalCallbacks);
      component._markRegistered();

      // Initialize state
      this.componentStates.set(componentName, 'registered');
      this.componentTimestamps.set(componentName, {
        startedAt: null,
        stoppedAt: null,
      });
      this.componentErrors.set(componentName, null);
      this.componentUnexpectedStopHadError.delete(componentName);
      this.componentStartAttemptTokens.set(componentName, ulid());

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

      // Generate position description
      let positionDescription: string | undefined;

      if (registrationIndexAfter !== null) {
        const totalComponents = this.components.length;

        if (totalComponents === 1) {
          positionDescription = 'only component';
        } else if (registrationIndexAfter === 0) {
          const nextComponent = this.components[1]?.getName();
          positionDescription = nextComponent
            ? `at start, before ${nextComponent}`
            : 'at start';
        } else if (registrationIndexAfter === totalComponents - 1) {
          const prevComponent = this.components[totalComponents - 2]?.getName();
          positionDescription = prevComponent
            ? `at end, after ${prevComponent}`
            : 'at end';
        } else {
          const prevComponent =
            this.components[registrationIndexAfter - 1]?.getName();
          const nextComponent =
            this.components[registrationIndexAfter + 1]?.getName();
          if (prevComponent && nextComponent) {
            positionDescription = `after ${prevComponent}, before ${nextComponent}`;
          } else if (prevComponent) {
            positionDescription = `after ${prevComponent}`;
          } else if (nextComponent) {
            positionDescription = `before ${nextComponent}`;
          }
        }
      }

      const actualPosition =
        registrationIndexAfter !== null
          ? { index: registrationIndexAfter, description: positionDescription }
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
        actualPosition,
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
        actualPosition,
        manualPositionRespected: isManualPositionRespected,
        targetFound: isTargetFound,
        duringStartup: this.isStarting,
        autoStartAttempted: didAutoStartAttempt,
        autoStartSucceeded: didAutoStartSucceed,
        startResult,
      };
    } catch (error) {
      // Handle unexpected errors during registration
      const err = toError(error);
      const code: RegistrationFailureCode =
        err instanceof DependencyCycleError
          ? 'dependency_cycle'
          : 'unknown_error';

      this.logger
        .entity(componentName)
        .error('Registration failed with unexpected error: {{error.message}}', {
          params: { error: err },
        });

      // Read back from the registry rather than assumed: a throw after the commit - from
      // an auto-start, say - leaves the component registered, and both the event and the
      // result must say so.
      const registrationIndexNow = this.components.indexOf(component);
      const isRegistered = registrationIndexNow !== -1;

      if (isRegistered) {
        // Committed, so it is a registration as far as anyone tracking the registry is
        // concerned; the failure is reported through the result and the log line above.
        this.lifecycleEvents.componentRegistered({
          name: componentName,
          index: registrationIndexNow,
          action: isInsertAction ? 'insert' : 'register',
          registrationIndexBefore,
          registrationIndexAfter: registrationIndexNow,
          startupOrder: [],
          requestedPosition: isInsertAction
            ? { position, targetComponentName }
            : undefined,
          duringStartup: this.isStarting,
        });
      } else {
        this.lifecycleEvents.componentRegistrationRejected({
          name: componentName,
          reason: code,
          // Guarded like every other failure-path read of a normalized throw: a
          // brand-claiming value reaches `.message` unchanged, and a throw here would
          // reject `registerComponent`/`insertComponentAt` rather than answering with the
          // rejected result below.
          message: describeError(err),
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
      }

      return {
        action: 'insert',
        success: false,
        registered: isRegistered,
        componentName,
        reason: describeError(err),
        code,
        error: err,
        registrationIndexBefore,
        registrationIndexAfter: isRegistered
          ? registrationIndexNow
          : registrationIndexBefore,
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
   * callers' {@link settleOperation} net turns into an `unknown_error` result. The pass takes the
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
    options: StopAllOptions | undefined,
    isRequestToStayDown: boolean,
  ): ShutdownPassAcceptance {
    const passOptions: ShutdownPassOptions = {
      // The one place a pass's options meet the manager's `shutdownOptions` defaults:
      // callers pass only their own overrides.
      timeoutMS: toTimerDelayMS(
        options?.timeoutMS ?? this.shutdownOptions?.timeoutMS ?? 30000,
      ),
      retryStalled:
        options?.retryStalled ?? this.shutdownOptions?.retryStalled ?? true,
      haltOnStall:
        options?.haltOnStall ?? this.shutdownOptions?.haltOnStall ?? true,
    };

    // Reject if already shutting down
    if (this.isShuttingDown) {
      this.logger.warn(
        'Cannot stop all components: shutdown already in progress',
        {
          params: { method },
        },
      );

      return this.refuseShutdownPass(isRequestToStayDown);
    }

    this.normalizeRepeatedShutdownRequestStateArmedStatus();

    const repeatedShutdownPolicy = this.repeatedShutdownRequestPolicy;
    const isManualRetryWhileArmed =
      repeatedShutdownPolicy !== undefined &&
      method === 'manual' &&
      this.repeatedShutdownRequestState.firstRequestAt !== null &&
      this.repeatedShutdownRequestState.remainsArmedUntil !== null;

    // Taken before the bookkeeping below, not after it, and unconditionally: this request
    // is the one about to start a pass, so the window is spent on it either way. Doing it
    // first is what makes the spending atomic - the counting a line down can reach
    // `onForceShutdown`, and a shutdown request made from inside that callback must find
    // no armed window to count itself against. It is a continuation of this request, not a
    // second operator press.
    const consumedArmedUntil = this.consumeRepeatedShutdownArmedWindow();

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

    // The bookkeeping above runs user code before the latch is taken: an expiring armed
    // window emits `shutdown-escalation-expired`, and a counted manual retry can reach
    // `onForceShutdown` and `shutdown-escalation-forced`. A listener or callback that
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
      this.logger.warn(
        'Cannot stop all components: a shutdown started while this request was being processed',
        {
          params: { method },
        },
      );

      return this.refuseShutdownPass(isRequestToStayDown);
    }

    const pass: ShutdownPass = { shutdownRequested: false };

    // An async method, but it runs synchronously up to its first `await`, which is well
    // past the latch: the caller this returns to already sees a shutdown in progress.
    return {
      accepted: true,
      pass,
      promise: this.runShutdownPass(method, passOptions, pass),
    };
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
    const startTime = Date.now();
    const {
      timeoutMS: effectiveTimeout,
      retryStalled: shouldRetryStalled,
      haltOnStall: shouldHaltOnStall,
    } = options;

    let hasTimedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let pendingShutdownOperation: Promise<void> | null = null;
    let isDuringStartup = false;
    // Set once the normal path has its result. Nothing after that point is expected to
    // throw - the emit goes through `safeEmit` - but if something ever did, the `catch`
    // answers with this rather than emitting a second, contradictory result.
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
        .map((name) => this.stalledComponents.get(name))
        .filter((stallInfo): stallInfo is ComponentStallInfo => !!stallInfo);
    // Also shared by both paths: the stop loop only records what it stopped itself, so
    // a candidate the manager already has as `stopped` - one that stopped itself through
    // `reportUnexpectedStop()` during the warning phase, say - is reconciled in here.
    // Without this the `catch` would under-report a pass that threw before reaching such
    // a component.
    const collectStoppedComponents = (
      excludedNames?: Set<string>,
    ): string[] => {
      for (const name of stopCandidateNames ?? []) {
        if (
          excludedNames?.has(name) ||
          this.componentStates.get(name) !== 'stopped'
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
      this.isShuttingDown = true;
      this.activeShutdownPass = pass;
      this.shutdownToken = ulid();
      this.shutdownMethod = method;
      if (
        this.repeatedShutdownRequestPolicy &&
        this.repeatedShutdownRequestState.firstRequestAt === null
      ) {
        this.seedRepeatedShutdownRequestState(method);
      }
      isDuringStartup = this.isStarting;

      this.logger.info('Stopping all components', {
        params: { method },
      });
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

        shutdownOrder = this.components.map((c) => c.getName()).reverse();
      }

      const stalledComponentNames = new Set(this.stalledComponents.keys());

      // Filter to running components, plus stalled ones if retrying
      const runningComponentsToStop = shutdownOrder.filter(
        (name) =>
          this.isComponentRunning(name) ||
          (shouldRetryStalled && stalledComponentNames.has(name)),
      );

      // The pass's stop list, plus the stalls it is leaving alone: with `retryStalled`
      // off those are not this pass's to clear, but they are still part of the state it
      // reports. With it on they are already in the stop list.
      stallCandidateNames = new Set(runningComponentsToStop);
      stopCandidateNames = runningComponentsToStop;

      if (!shouldRetryStalled) {
        for (const name of stalledComponentNames) {
          stallCandidateNames.add(name);
        }
      }

      const protectedDependencies = new Set<string>();
      const protectDependencies = (name: string): void => {
        for (const dependency of this.getComponent(name)?.getDependencies() ??
          []) {
          if (!protectedDependencies.has(dependency)) {
            protectedDependencies.add(dependency);
            protectDependencies(dependency);
          }
        }
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

      // Create shutdown operation
      const shutdownOperation = async () => {
        await this.runShutdownWarningPhase(runningComponentsToStop);

        // Stop each component in reverse dependency order
        for (const name of runningComponentsToStop) {
          if (hasTimedOut) {
            this.logger.warn(
              'Shutdown timeout reached, stopping further component shutdown',
              {
                params: { timeoutMS: effectiveTimeout },
              },
            );
            break;
          }

          if (protectedDependencies.has(name)) {
            stoppingComponents.add(name);
            continue;
          }

          this.logger.entity(name).info('Stopping component');

          // Use internal method to bypass bulk operation checks.
          // - If running: normal stop flow
          // - If stalled and retryStalled: force-phase retry
          // - If stalled and no retry: report component_stalled
          // - If already stopped during this shutdown (for example, via
          //   reportUnexpectedStop() during the warning phase), count it as a
          //   successful stop for shutdown accounting
          // - Otherwise: component_not_running
          const isRunning = this.isComponentRunning(name);
          const isStalled = stalledComponentNames.has(name);
          const currentState = this.componentStates.get(name);

          if (currentState === 'stopped') {
            stoppedComponents.add(name);
            continue;
          }

          const result: ComponentOperationResult = isRunning
            ? await this.stopComponentInternal(name)
            : shouldRetryStalled && isStalled
              ? await this.retryStalledComponent(name)
              : isStalled
                ? {
                    success: false,
                    componentName: name,
                    reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
                    code: 'component_stalled',
                    status: this.getComponentStatus(name),
                  }
                : {
                    success: false,
                    componentName: name,
                    reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
                    code: 'component_not_running',
                    status: this.getComponentStatus(name),
                  };

          if (result.success) {
            stoppedComponents.add(name);
          } else if (result.code === 'component_already_stopping') {
            // Preserve reverse dependency order. A concurrent stop still owns this
            // component; its dependencies must remain available until it settles.
            stoppingComponents.add(name);
            protectDependencies(name);
            if (shouldHaltOnStall) {
              break;
            }
            continue;
          } else {
            // Component failed to stop - track as stalled but continue
            this.logger
              .entity(name)
              .error(
                'Component failed to stop, continuing with others: {{error.message}}',
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
      const isSuccess =
        !hasTimedOut &&
        stalledComponents.length === 0 &&
        stoppingComponents.size === 0;

      // The guard matters here: a logger that threw would otherwise land in the `catch`
      // below and replace the result of a pass that finished - even a clean one - with
      // a failure.
      this.logger[isSuccess ? 'success' : 'warn'](
        isSuccess
          ? 'Shutdown completed successfully'
          : 'Shutdown attempt completed with stalled components or timeout',
        {
          params: {
            method,
            stopped: stoppedComponents.size,
            stalled: stalledComponents.length,
            durationMS,
          },
        },
      );

      const result: ShutdownResult = {
        success: isSuccess,
        stoppedComponents: settledStoppedComponents,
        stalledComponents,
        durationMS,
        timedOut: hasTimedOut || undefined,
        ...(hasTimedOut
          ? {
              code: 'shutdown_timeout' as const,
              reason: `Shutdown timeout exceeded (${effectiveTimeout}ms)`,
            }
          : stoppingComponents.size > 0
            ? {
                reason: `Shutdown is still in progress for: ${Array.from(stoppingComponents).join(', ')}`,
              }
            : {}),
      };

      // Store for getLastShutdownResult() - useful for debugging and metrics
      this.lastShutdownResult = result;

      // "Completed" means the manager finished waiting and a shutdown result
      // snapshot exists, not necessarily that every component stopped cleanly.
      // Callers must inspect success / stalledComponents / timedOut to decide
      // what to do next.
      completedResult = result;

      this.lifecycleEvents.lifecycleManagerShutdownCompleted({
        ...result,
        method,
        duringStartup: isDuringStartup,
      });

      if (isSuccess) {
        this.resetRepeatedShutdownRequestState();
      } else {
        this.armRepeatedShutdownAfterFailure();
      }

      return result;
    } catch (error) {
      // A pass that dies resolves with a failed result rather than rejecting, so a caller
      // that fired `stopAllComponents()` without awaiting it can never be handed an
      // unhandled rejection. The failure itself is not lost: it goes on the global
      // channel here, rides on the result as `error`, and the completed event carries it.
      reportCallbackError(`shutdown after ${method}`, error);

      if (completedResult !== null) {
        return completedResult;
      }

      // The pass announced itself first thing, and callers block on that
      // announcement's pair, so a pass that dies anywhere in here still owes them a
      // result - otherwise they wait forever. In the one case where the
      // `shutdown-initiated` emit is itself what threw, this is a `shutdown-completed`
      // without its opening half; a listener that never ran is still better served by
      // an event it can ignore than by a pass that reports nothing.
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
        code: 'unknown_error',
        error: toError(error),
      };

      this.lastShutdownResult = result;

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
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (hasTimedOut && pendingShutdownOperation !== null) {
        // The public timeout remains an early return, and the operation it raced cannot
        // be cancelled. Per-component `stopping` state continues to prevent overlap, but
        // the process-wide shutdown latch must be released so logger.exit() and a later
        // shutdown/escalation are not held forever by a stop() that never settles.
        void pendingShutdownOperation.catch((error: unknown) => {
          this.logger.warn(
            'Shutdown operation failed after the global timeout: {{error.message}}',
            { params: { error: toError(error) } },
          );
        });
      }

      this.isShuttingDown = false;
      this.activeShutdownPass = null;
      this.updateStartedFlag();
      this.finalizePendingLoggerExit();
    }
  }

  /**
   * Release a deferred logger.exit() request after shutdown fully settles.
   */
  private finalizePendingLoggerExit(): void {
    if (this.pendingLoggerExitResolve === null || this.isShuttingDown) {
      return;
    }

    const resolve = this.pendingLoggerExitResolve;
    this.pendingLoggerExitResolve = null;
    resolve({ action: 'proceed' });
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
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
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
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
        code: 'component_not_running',
        status: this.getComponentStatus(name),
      };
    }

    this.logger
      .entity(name)
      .warn('Retrying stalled component shutdown (force phase)');

    // Only bump the generation if a force handler exists. Without one,
    // shutdownComponentForce stalls immediately with no async work, so there is
    // no running operation to protect — and bumping would orphan any floating
    // graceful-stop promise that could still auto-clear the stall via late resolution.
    if (component.onShutdownForce) {
      this.issueStopAttemptToken(name);
    }

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
  /**
   * `startComponentAttempt()` with a net under it that settles the component's state.
   *
   * The attempt claims `starting` before work that runs the component's own code - its
   * `startupTimeoutMS`, its handlers - and not all of that sits inside the attempt's own
   * `try`. The public safety net would still answer with `unknown_error`, but it cannot
   * see the component, which stayed `starting` for good: every later start answered
   * `component_already_starting`. A start that crashes before the component is running
   * is put back to the state it had before the attempt; one already running is left
   * running, which is what the registry says.
   */
  private async startComponentInternal(
    name: string,
    options?: StartComponentOptions,
    bulkStartup?: {
      deadline: number;
      onTimeout: () => void;
      hasExpired: () => boolean;
    },
  ): Promise<ComponentOperationResult> {
    const stateBeforeStart = this.componentStates.get(name);

    try {
      return await this.startComponentAttempt(name, options, bulkStartup);
    } catch (error) {
      // A crash after the component was already marked running - building its status
      // for the result, say - still fails the start, so it is stopped again: a failed
      // start means a component that is not running, which is what every caller,
      // bulk rollback included, acts on.
      if (this.runningComponents.has(name)) {
        reportCallbackError('lifecycle-manager component start', error);

        const stopResult = await this.stopComponentInternal(name);

        return this.crashedComponentResult(
          name,
          toError(error),
          `Start failed unexpectedly after the component was running: ${describeError(error)}; ${
            stopResult.success
              ? 'component stopped again'
              : `stopping it again also failed: ${stopResult.reason ?? 'unknown reason'}`
          }`,
        );
      }

      // Back to the state it had before this attempt - `registered`, `stopped`,
      // `failed` - so a crashed retry does not erase that history from the status APIs.
      if (
        this.componentStates.get(name) === 'starting' &&
        !this.runningComponents.has(name) &&
        stateBeforeStart !== undefined &&
        stateBeforeStart !== 'starting'
      ) {
        this.componentStates.set(name, stateBeforeStart);
      }

      reportCallbackError('lifecycle-manager component start', error);

      return this.crashedComponentResult(
        name,
        toError(error),
        `Start failed unexpectedly: ${describeError(error)}`,
      );
    }
  }

  private async startComponentAttempt(
    name: string,
    options?: StartComponentOptions,
    bulkStartup?: {
      deadline: number;
      onTimeout: () => void;
      hasExpired: () => boolean;
    },
  ): Promise<ComponentOperationResult> {
    // A timed-out bulk start owns the component until it settles and cleanup ends.
    if (this.pendingBulkStartupCleanup.has(name)) {
      return {
        success: false,
        componentName: name,
        code: 'component_already_starting',
        reason: 'Timed-out startup is still awaiting completion or cleanup',
        status: this.getComponentStatus(name),
      };
    }
    // ALWAYS reject during shutdown (never bypass this check)
    if (this.isShuttingDown) {
      this.logger.entity(name).warn('Cannot start component during shutdown', {
        params: { isShuttingDown: this.isShuttingDown },
      });

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
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
        reason: LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
        code: 'startup_in_progress',
      };
    }

    const allowNonRunningDependencies =
      options?.allowNonRunningDependencies === true;

    const component = this.getComponent(name);

    if (!component) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
        code: 'component_not_found',
      };
    }

    // Check if component is stalled (unless explicitly forced)
    const shouldForceStalled = options?.forceStalled === true;
    if (!shouldForceStalled && this.stalledComponents.has(name)) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
        code: 'component_stalled',
        status: this.getComponentStatus(name),
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
        if (allowNonRunningDependencies) {
          // Explicit override - allow skipping both optional and required dependencies
          this.logger
            .entity(name)
            .warn(
              `Starting with non-running dependency "${dependencyName}" (allowNonRunningDependencies=true)`,
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

    if (currentState === 'stopping' || currentState === 'force-stopping') {
      return {
        success: false,
        componentName: name,
        reason: `Component is already ${currentState}`,
        code: 'component_already_stopping',
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

    // The component is claimed as `starting` before the attach, not after it: attaching
    // emits `lifecycle-manager:signals-attached` synchronously, and a listener that
    // starts or stops this component from there must find it already starting rather
    // than slip in between. The state it had is put back if the attach fails, which is
    // all a refusal has to release. Tracked so failure cleanup only detaches what this
    // start attempt attached.
    const stateBeforeStart = currentState;
    const restoreStateBeforeStart = (): void => {
      if (stateBeforeStart === undefined) {
        this.componentStates.delete(name);
      } else {
        this.componentStates.set(name, stateBeforeStart);
      }
    };

    this.componentStates.set(name, 'starting');

    const shutdownTokenBeforeAttach = this.shutdownToken;
    const componentSignalAttach = this.attachSignalsBeforeStartup
      ? this.autoAttachSignals('component startup')
      : null;

    if (componentSignalAttach?.outcome === 'failed') {
      restoreStateBeforeStart();

      return {
        success: false,
        componentName: name,
        reason: `Could not attach process signals: ${describeError(componentSignalAttach.error)}`,
        code: 'signal_attach_failed',
        error: componentSignalAttach.error,
      };
    }

    const didAutoAttachSignalsForComponentStartup =
      componentSignalAttach?.outcome === 'attached';

    // A `signals-attached` listener that started a shutdown: refused as any start that
    // arrives during a shutdown is, rather than adopting that pass's token as this
    // start's baseline and starting the component underneath it.
    if (
      this.isShuttingDown ||
      this.shutdownToken !== shutdownTokenBeforeAttach
    ) {
      restoreStateBeforeStart();

      if (didAutoAttachSignalsForComponentStartup) {
        this.autoDetachSignalsIfIdle('refused component startup');
      }

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        code: 'shutdown_in_progress',
      };
    }

    // The unexpected-stop record from the previous run is cleared with the `starting`
    // claim above: that flag describes a stop that already happened, and a start that
    // reads it later would take an old failure for a new one.
    this.componentUnexpectedStopHadError.delete(name);
    this.logger.entity(name).info('Starting component');
    this.lifecycleEvents.componentStarting(name);

    const componentTimeout = toTimerDelayMS(component.startupTimeoutMS);
    const remainingBudget =
      bulkStartup === undefined
        ? undefined
        : Math.max(1, bulkStartup.deadline - Date.now());
    const useBulkDeadline =
      remainingBudget !== undefined &&
      (componentTimeout === 0 || remainingBudget <= componentTimeout);
    const timeoutMS = useBulkDeadline
      ? remainingBudget
      : component.startupTimeoutMS;
    const startAttemptToken = ulid();
    this.componentStartAttemptTokens.set(name, startAttemptToken);
    component._setUnexpectedStopHandler((error) =>
      this.handleComponentUnexpectedStop(name, startAttemptToken, error),
    );
    const shutdownTokenAtStart = this.shutdownToken;

    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      // Race against timeout
      const startPromise = component.start();

      if (toTimerDelayMS(timeoutMS) > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Settle before notifications: user callbacks cannot swallow the deadline.
            reject(
              new ComponentStartTimeoutError({
                componentName: name,
                timeoutMS,
              }),
            );
            if (useBulkDeadline) {
              bulkStartup?.onTimeout();
            }
            if (useBulkDeadline || !component.onStartupAborted) {
              this.monitorLateStartupCompletion(
                name,
                component,
                startPromise,
                startAttemptToken,
              );
            }
            // Call abort callback if implemented
            if (component.onStartupAborted) {
              try {
                Promise.resolve(component.onStartupAborted()).catch(
                  (error: unknown) => {
                    try {
                      const err = toError(error);

                      this.logger
                        .entity(name)
                        .warn(
                          'Error in onStartupAborted callback: {{error.message}}',
                          { params: { error: err } },
                        );
                    } catch {
                      // Terminal rejection handler: reporting must not create another
                      // unhandled rejection from this timer path.
                    }
                  },
                );
              } catch (error) {
                const err = toError(error);

                this.logger
                  .entity(name)
                  .warn(
                    'Error in onStartupAborted callback: {{error.message}}',
                    {
                      params: { error: err },
                    },
                  );
              }
            }

            // Prevent unhandled rejection if start() throws after timeout
            // Logged, not discarded. Preventing the unhandled rejection is why this
            // `catch` exists and it stays; swallowing the *cause* was a separate
            // decision, and it left the caller knowing the operation timed out and
            // never why it ultimately failed. The timeout warning is logged just
            // above, so this is that line's missing second half.
            Promise.resolve(startPromise)
              .catch((error: unknown) => {
                this.logger
                  .entity(name)
                  .debug('start() failed after it had already timed out', {
                    params: { error: toError(error) },
                  });
              })
              // Terminal, for the reason the shutdown-warning chain carries one: nothing
              // retains this chain, so a throw out of the reporting handler above becomes an
              // unhandled rejection mid-lifecycle - fatal under Node's default
              // `--unhandled-rejections=throw`. Logging is guarded, but a floating chain
              // should not have to rely on that.
              .catch(() => {
                // Nothing left to report with.
              });
          }, toTimerDelayMS(timeoutMS));
        });

        await Promise.race([startPromise, timeoutPromise]);
      } else {
        await startPromise;
      }

      // The startup deadline no longer applies once start() has settled.
      clearTimeout(timeoutHandle);

      // A component can self-report an unexpected stop from inside start()
      // before the manager has promoted it to running. If that happened, do
      // not fall through into the normal success path and resurrect it.
      if (
        this.componentStartAttemptTokens.get(name) === startAttemptToken &&
        this.componentStates.get(name) === 'stopped' &&
        !this.runningComponents.has(name)
      ) {
        component._clearUnexpectedStopHandler();
        const error =
          this.componentErrors.get(name) ??
          new Error(`Component "${name}" stopped unexpectedly during startup`);

        return {
          success: false,
          componentName: name,
          // Guarded: `error` came from the component's own `reportUnexpectedStop`, and
          // `toError` returns an `Error` unchanged, so `message` is whatever accessor the
          // component put there. An unguarded read threw out of the `try` and then again
          // out of the `catch` below, so `startComponent` rejected instead of returning
          // this `component_unexpected_stop` result.
          reason: describeError(error),
          code: 'component_unexpected_stop',
          error,
          status: this.getComponentStatus(name),
        };
      }

      // If shutdown began while start() was in flight, treat the component as
      // running long enough to send it through the normal stop pipeline.
      if (this.isShuttingDown || shutdownTokenAtStart !== this.shutdownToken) {
        this.componentStates.set(name, 'running');
        this.runningComponents.add(name);
        this.componentErrors.set(name, null);
        this.stalledComponents.delete(name);
        this.updateStartedFlag();

        const timestamps = this.componentTimestamps.get(name) ?? {
          startedAt: null,
          stoppedAt: null,
        };

        timestamps.startedAt = Date.now();
        this.componentTimestamps.set(name, timestamps);

        this.logger
          .entity(name)
          .warn(
            'Component finished starting after shutdown began, stopping immediately',
          );

        const stopResult = await this.stopComponentInternal(name);

        return {
          success: false,
          componentName: name,
          reason: 'Shutdown triggered during component startup',
          code: 'shutdown_in_progress',
          error: stopResult.error,
          status: this.getComponentStatus(name),
        };
      }

      // The outer deadline can win before the inner timer fires. A successful
      // start after that snapshot must follow late cleanup, not become running.
      if (
        bulkStartup &&
        (bulkStartup.hasExpired() || Date.now() >= bulkStartup.deadline)
      ) {
        bulkStartup.onTimeout();
        this.monitorLateStartupCompletion(
          name,
          component,
          startPromise,
          startAttemptToken,
        );
        throw new ComponentStartTimeoutError({
          componentName: name,
          timeoutMS,
        });
      }

      // Update state. The previous run's error goes with it: `lastError` on a component
      // that is running again described a run that is over, and a reader taking it for
      // the current one - a health dashboard, a restart policy - was told the restart
      // had not worked. A clean late stop already clears it for the same reason.
      this.componentStates.set(name, 'running');
      this.runningComponents.add(name);
      this.componentErrors.set(name, null);
      this.stalledComponents.delete(name); // Clear stalled state if component was previously stalled
      if (shouldForceStalled) {
        // A successful forceStalled start creates a new run. Any late stop
        // promise from the previous stalled run must no longer own state.
        this.issueStopAttemptToken(name);
      }
      this.updateStartedFlag();

      const timestamps = this.componentTimestamps.get(name) ?? {
        startedAt: null,
        stoppedAt: null,
      };
      timestamps.startedAt = Date.now();
      this.componentTimestamps.set(name, timestamps);

      this.logger.entity(name).success('Component started');
      const status = this.getComponentStatus(name);
      this.lifecycleEvents.componentStarted(name, status);

      // `attachSignalsOnStart` attaches once the first component is actually up, not
      // before. A process configured to handle signals must not stay up without them, so
      // a failed attach takes this component back down and fails the start - after its
      // `started` event, so observers see an ordinary start followed by a stop.
      if (this.attachSignalsOnStart && this.runningComponents.size === 1) {
        const signalAttach = this.autoAttachSignals('first component start');

        if (signalAttach.outcome === 'failed') {
          return this.rollBackStartForSignalAttach(name, signalAttach.error);
        }
      }

      return {
        success: true,
        componentName: name,
        status: this.getComponentStatus(name),
      };
    } catch (error) {
      // Everything below describes a start that never got as far as running. A throw
      // after the component was marked running - building its status for the result,
      // say - is not that: it is left to `startComponentInternal()`, which stops the
      // component again so the failed start it reports is true.
      if (this.runningComponents.has(name)) {
        throw error;
      }

      component._clearUnexpectedStopHandler();
      const err = toError(error);

      // Decision rule for overlapping startup failures:
      // - If the component explicitly self-reported an unexpected stop *with
      //   its own error*, keep that more specific lifecycle outcome instead of
      //   overwriting it with a later throw from the same start() promise.
      // - If the competing failure is the manager's startup timeout, also keep
      //   the unexpected-stop result, even when reportUnexpectedStop() did not
      //   provide an error, because the timeout is only an observation made
      //   after the component already told us it had stopped.
      // - Otherwise, let the later thrown startup error win. This preserves
      //   useful diagnostic detail for cases where reportUnexpectedStop() was
      //   only used as a state signal and did not explain why startup failed.
      const isStartupTimeout =
        err instanceof ComponentStartTimeoutError &&
        err.additionalInfo.componentName === name;

      const unexpectedStopError = this.componentErrors.get(name);
      if (
        this.componentStartAttemptTokens.get(name) === startAttemptToken &&
        this.componentStates.get(name) === 'stopped' &&
        !this.runningComponents.has(name) &&
        (isStartupTimeout ||
          this.componentUnexpectedStopHadError.get(name) === true)
      ) {
        return {
          success: false,
          componentName: name,
          // Guarded for the same reason as the `try` path above, and it matters more
          // here: this runs inside the `catch`, so a `message` that throws has nothing
          // left above it to catch and escapes as a rejection.
          //
          // Both empty cases, not just `undefined`: `componentErrors` holds
          // `Error | null`, and `null` is how `reportUnexpectedStop()` records a stop
          // reported without a reason. Handing that `null` to `describeError` gets an
          // honest answer - `Non-error value thrown: null` - but a non-empty one, which
          // satisfies the `||` and hands the caller coercion text in place of the
          // sentence that says what actually happened. `== null` would say this in one
          // comparison; `eqeqeq` does not allow it. The `error` field below already
          // treats `null` as absent, so this only makes the two agree.
          reason:
            (unexpectedStopError === undefined || unexpectedStopError === null
              ? undefined
              : describeError(unexpectedStopError)) ||
            `Component "${name}" stopped unexpectedly during startup`,
          code: 'component_unexpected_stop',
          error:
            unexpectedStopError ||
            new Error(
              `Component "${name}" stopped unexpectedly during startup`,
            ),
          status: this.getComponentStatus(name),
        };
      }

      // Store error
      this.componentErrors.set(name, err);

      // Guarded for the same reason as the `component_unexpected_stop` branch above:
      // `toError` returns a brand-claiming value unchanged, so `.message` can be an
      // accessor that throws, and here that throw has nothing left above it to catch.
      const reason = describeError(err);

      // Check if it was a timeout
      if (isStartupTimeout) {
        this.componentStates.set(name, 'starting-timed-out'); // Timeout state (observability)

        this.logger
          .entity(name)
          .error('Component startup timed out: {{error.message}}', {
            params: { error: err },
          });

        this.lifecycleEvents.componentStartTimeout(name, err, {
          timeoutMS,
          reason,
        });
      } else {
        this.componentStates.set(name, 'registered'); // Reset state

        this.logger
          .entity(name)
          .error('Component failed to start: {{error.message}}', {
            params: { error: err },
          });

        this.lifecycleEvents.componentStartFailed(name, err, {
          reason,
        });
      }

      return {
        success: false,
        componentName: name,
        reason,
        code:
          err instanceof ComponentStartTimeoutError
            ? 'component_startup_timeout'
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

      if (didAutoAttachSignalsForComponentStartup) {
        this.autoDetachSignalsIfIdle('failed component startup');
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
    const startedAt = Date.now();

    try {
      return await this.stopComponentAttempt(name, options);
    } catch (error) {
      // The attempt claims `stopping` / `force-stopping` before work that runs the
      // component's own code - its timeout getters, its hooks - and not all of it sits
      // inside a `try`. Left alone, a throw there held that state for good: every later
      // start or stop answered `component_already_stopping`, and it could never be
      // unregistered. Nobody can vouch for what the component did stop, which is what
      // `stalled` means, and a stalled component can be retried or unregistered.
      const err = toError(error);
      const state = this.componentStates.get(name);

      if (state === 'stopping' || state === 'force-stopping') {
        const stallInfo: ComponentStallInfo = {
          name,
          phase: state === 'stopping' ? 'graceful' : 'force',
          reason: 'error',
          startedAt,
          stalledAt: Date.now(),
          error: err,
        };

        this.stalledComponents.set(name, stallInfo);
        this.componentStates.set(name, 'stalled');
        this.componentErrors.set(name, err);
        this.runningComponents.delete(name);
        this.updateStartedFlag();
        // Settled like every other stall: a force-stop waiter for this name is released,
        // and signals come off if this was the last running component.
        this.resolvePendingForceStopWaiters(name);
        this.detachSignalsAfterLastStop();
        this.lifecycleEvents.componentStalled(name, stallInfo, {
          reason: 'error',
          code: 'unknown_error',
        });
      }

      reportCallbackError('lifecycle-manager component stop', error);

      return this.crashedComponentResult(
        name,
        err,
        `Stop failed unexpectedly: ${describeError(error)}`,
      );
    }
  }

  private async stopComponentAttempt(
    name: string,
    options?: StopComponentOptions,
  ): Promise<ComponentOperationResult> {
    const component = this.getComponent(name);

    if (!component) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
        code: 'component_not_found',
      };
    }

    // Check if stalled
    if (this.stalledComponents.has(name)) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
        code: 'component_stalled',
        status: this.getComponentStatus(name),
      };
    }

    // Check if not running
    if (!this.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
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
      // Only bump if a force handler exists. Without onShutdownForce(), there is
      // no new async force-phase work to protect here, and the existing floating
      // graceful stop() promise is still intentionally allowed to late-resolve
      // the stall if it eventually completes. Bumping unconditionally would
      // orphan that promise and prevent the original stop from being monitored.
      if (component.onShutdownForce) {
        this.issueStopAttemptToken(name);
      }
      component._clearUnexpectedStopHandler();
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
      gracefulTimedOut: gracefulResult.code === 'component_shutdown_timeout',
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
      const state = this.componentStates.get(name);

      // A global timeout releases the manager-wide latch while this component can still
      // be stopping. Do not run its warning hook alongside stop()/onShutdownForce().
      if (
        component?.onShutdownWarning &&
        state !== 'stopping' &&
        state !== 'force-stopping'
      ) {
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
            const err = toError(error);

            this.logger
              .entity(name)
              .warn('Shutdown warning phase failed: {{error.message}}', {
                params: { error: err },
              });
          })
          // Terminal, because this chain is deliberately not retained: unlike the
          // timed branch below, nothing collects it into `Promise.allSettled`, so a
          // throw from the reporting handler above would become an unhandled rejection
          // mid-shutdown — fatal under Node's default `--unhandled-rejections=throw`.
          // Logging is guarded, but a floating chain should not have to rely on that.
          .catch(() => {
            // Nothing left to report with.
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
            const err = toError(error);

            this.logger
              .entity(name)
              .warn('Shutdown warning phase failed: {{error.message}}', {
                params: { error: err },
              });
          }),
      );
    }

    // Race overall completion vs global timeout.
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve('timeout'),
        toTimerDelayMS(timeoutMS),
      );
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
    // Set state to stopping — clear the unexpected-stop handler before any async
    // work so a concurrent reportUnexpectedStop() call has no effect from here on.
    component._clearUnexpectedStopHandler();
    this.componentStates.set(name, 'stopping');
    this.logger.entity(name).info('Graceful shutdown started');
    this.lifecycleEvents.componentStopping(name);

    const stopAttemptToken = this.issueStopAttemptToken(name);

    // Use custom timeout if provided, otherwise use component's configured timeout
    const timeoutMS = options?.timeout ?? component.shutdownGracefulTimeoutMS;
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      // Race against graceful timeout
      const stopPromise = component.stop();

      if (toTimerDelayMS(timeoutMS) > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Call abort callback if implemented
            if (component.onGracefulStopTimeout) {
              try {
                Promise.resolve(component.onGracefulStopTimeout()).catch(
                  (error: unknown) => {
                    try {
                      const err = toError(error);

                      this.logger
                        .entity(name)
                        .warn(
                          'Error in onGracefulStopTimeout callback: {{error.message}}',
                          { params: { error: err } },
                        );
                    } catch {
                      // See the startup-abort hook above.
                    }
                  },
                );
              } catch (error) {
                const err = toError(error);

                this.logger
                  .entity(name)
                  .warn(
                    'Error in onGracefulStopTimeout callback: {{error.message}}',
                    {
                      params: { error: err },
                    },
                  );
              }
            }

            // Detect if stop() eventually resolves after the timeout so the stall
            // can be cleared automatically without a manual retry.
            Promise.resolve(stopPromise)
              .then(
                () =>
                  this.handleLateStopResolution(
                    name,
                    stopAttemptToken,
                    'graceful',
                  ),
                (error: unknown) => {
                  this.logger
                    .entity(name)
                    .warn('Component stop failed after timeout', {
                      params: { error: toError(error) },
                    });
                },
              )
              // Suppressed so it cannot become an unhandled rejection, and logged because
              // `handleLateStopResolution` mutates state in sequence: a throw partway
              // leaves the component half-transitioned, which is better said outright than
              // inferred from a stuck state later.
              .catch((error: unknown) => {
                this.logger.entity(name).warn('Late stop resolution failed', {
                  params: { error: toError(error) },
                });
              })
              // Terminal, for the reason the shutdown-warning chain carries one: nothing
              // retains this chain, so a throw out of the reporting handler above becomes an
              // unhandled rejection mid-lifecycle - fatal under Node's default
              // `--unhandled-rejections=throw`. Logging is guarded, but a floating chain
              // should not have to rely on that.
              .catch(() => {
                // Nothing left to report with.
              });
            reject(
              new ComponentStopTimeoutError({
                componentName: name,
                timeoutMS,
              }),
            );
          }, toTimerDelayMS(timeoutMS));
        });

        await Promise.race([stopPromise, timeoutPromise]);
      } else {
        await stopPromise;
      }

      // Update state - graceful succeeded
      this.componentStates.set(name, 'stopped');
      this.runningComponents.delete(name);
      this.stalledComponents.delete(name); // Clear stalled status on successful stop
      this.componentErrors.set(name, null);
      this.componentUnexpectedStopHadError.delete(name);
      this.updateStartedFlag();

      this.detachSignalsAfterLastStop();

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
      const err = toError(error);

      // Store error
      this.componentErrors.set(name, err);

      // Check if it was a timeout
      if (
        err instanceof ComponentStopTimeoutError &&
        err.additionalInfo.componentName === name
      ) {
        this.logger
          .entity(name)
          .warn(LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT);
        this.lifecycleEvents.componentStopTimeout(name, err, {
          timeoutMS,
          reason: LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT,
        });

        return {
          success: false,
          componentName: name,
          reason: LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT,
          code: 'component_shutdown_timeout',
          error: err,
          status: this.getComponentStatus(name),
        };
      } else {
        // Error during graceful stop
        this.logger
          .entity(name)
          .warn('Graceful shutdown threw error: {{error.message}}', {
            params: { error: err },
          });

        return {
          success: false,
          componentName: name,
          // Guarded: this runs inside the `catch`, and `toError` returns a
          // brand-claiming value unchanged, so a `message` accessor that throws
          // here escapes as a rejection instead of this failure result.
          reason: describeError(err),
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
        code: context.gracefulTimedOut
          ? 'component_shutdown_timeout'
          : 'unknown_error',
      });

      // Return the original graceful phase error
      return {
        success: false,
        componentName: name,
        reason: context.gracefulTimedOut
          ? 'Component stop timed out'
          : // Guarded: `gracefulError` is the `toError` result carried over from the
            // graceful phase, so its `message` can be an accessor that throws.
            ((context.gracefulError === undefined
              ? undefined
              : describeError(context.gracefulError)) ??
            'Graceful shutdown failed'),
        code: context.gracefulTimedOut
          ? 'component_shutdown_timeout'
          : 'unknown_error',
        error: context.gracefulError,
        status: this.getComponentStatus(name),
      };
    }

    const timeoutMS = component.shutdownForceTimeoutMS;
    const { promise: stoppedDuringForcePromise, cleanup: cleanupForceWaiter } =
      this.createPendingForceStopWaiter(name);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const reportFailureAfterGracefulStop = (error: unknown): void => {
      this.logger
        .entity(name)
        .warn('Force shutdown failed after graceful stop completed', {
          params: { error: toError(error) },
        });
    };

    try {
      const forcePromise = component.onShutdownForce();

      // A late graceful completion can win the race and abandon this attempt. Observe
      // its rejection immediately, including when the force timeout is disabled.
      void Promise.resolve(forcePromise).catch(() => {});

      if (toTimerDelayMS(timeoutMS) > 0) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Call abort callback if implemented
            if (component.onShutdownForceAborted) {
              try {
                Promise.resolve(component.onShutdownForceAborted()).catch(
                  (error: unknown) => {
                    try {
                      const err = toError(error);

                      this.logger
                        .entity(name)
                        .warn(
                          'Error in onShutdownForceAborted callback: {{error.message}}',
                          { params: { error: err } },
                        );
                    } catch {
                      // See the startup-abort hook above.
                    }
                  },
                );
              } catch (error) {
                const err = toError(error);

                this.logger
                  .entity(name)
                  .warn(
                    'Error in onShutdownForceAborted callback: {{error.message}}',
                    {
                      params: { error: err },
                    },
                  );
              }
            }

            // Detect if onShutdownForce() eventually resolves after the timeout
            // so the stall can be cleared automatically, same as stop().
            const forceAttemptToken =
              this.componentStopAttemptTokens.get(name) ?? ulid();
            Promise.resolve(forcePromise)
              .then(
                () =>
                  this.handleLateStopResolution(
                    name,
                    forceAttemptToken,
                    'force',
                  ),
                (error: unknown) => {
                  this.logger
                    .entity(name)
                    .warn('Force shutdown failed after timeout', {
                      params: { error: toError(error) },
                    });
                },
              )
              // Suppressed so it cannot become an unhandled rejection, and logged because
              // `handleLateStopResolution` mutates state in sequence: a throw partway
              // leaves the component half-transitioned, which is better said outright than
              // inferred from a stuck state later.
              .catch((error: unknown) => {
                this.logger.entity(name).warn('Late stop resolution failed', {
                  params: { error: toError(error) },
                });
              })
              // Terminal, for the reason the shutdown-warning chain carries one: nothing
              // retains this chain, so a throw out of the reporting handler above becomes an
              // unhandled rejection mid-lifecycle - fatal under Node's default
              // `--unhandled-rejections=throw`. Logging is guarded, but a floating chain
              // should not have to rely on that.
              .catch(() => {
                // Nothing left to report with.
              });
            reject(
              new Error(LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT),
            );
          }, toTimerDelayMS(timeoutMS));
        });

        await Promise.race([
          forcePromise,
          timeoutPromise,
          stoppedDuringForcePromise,
        ]);
      } else {
        await Promise.race([forcePromise, stoppedDuringForcePromise]);
      }

      if (
        this.componentStates.get(name) === 'stopped' &&
        !this.runningComponents.has(name)
      ) {
        // Graceful completion won. Report abandoned cleanup failures without
        // changing this or a subsequent run's state.
        void Promise.resolve(forcePromise).catch(
          reportFailureAfterGracefulStop,
        );
        return {
          success: true,
          componentName: name,
          status: this.getComponentStatus(name),
        };
      }

      // Update state - force succeeded
      this.componentStates.set(name, 'stopped');
      this.runningComponents.delete(name);
      this.stalledComponents.delete(name); // Clear stalled status on successful force stop
      this.componentErrors.set(name, null);
      this.componentUnexpectedStopHadError.delete(name);
      this.updateStartedFlag();

      this.detachSignalsAfterLastStop();

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
      if (
        this.componentStates.get(name) === 'stopped' &&
        !this.runningComponents.has(name)
      ) {
        // The force rejection can win Promise.race in the same turn that graceful
        // completion marks the component stopped. It still needs to be reported.
        reportFailureAfterGracefulStop(error);
        return {
          success: true,
          componentName: name,
          status: this.getComponentStatus(name),
        };
      }

      const err = toError(error);

      // Guarded: `toError` returns a brand-claiming value unchanged, so `.message` can
      // be an accessor that throws. Unguarded, that throw lands on the comparison below
      // and skips the whole stall path - the component is never marked stalled and
      // `componentStalled` never fires.
      const message = describeError(err);

      // Determine if timeout or error
      const isTimeout =
        message === LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT;

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
        this.logger
          .entity(name)
          .error('Force shutdown failed - stalled: {{error.message}}', {
            params: { error: err },
          });
      }

      this.lifecycleEvents.componentStalled(name, stallInfo, {
        reason: stallInfo.reason,
        code: isTimeout ? 'component_shutdown_timeout' : 'unknown_error',
      });

      return {
        success: false,
        componentName: name,
        reason: isTimeout
          ? LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT
          : message,
        code: isTimeout ? 'component_shutdown_timeout' : 'unknown_error',
        error: err,
        status: this.getComponentStatus(name),
      };
    } finally {
      cleanupForceWaiter();
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
    if (this.processSignalManager?.getStatus().isAttached) {
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

    if (this.isStarting) {
      this.autoAttachedSignalsDuringStartup = true;
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
    const stopResult = await this.stopComponentInternal(name);
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
    if (
      !this.detachSignalsOnStop ||
      this.runningComponents.size > 0 ||
      !this.processSignalManager
    ) {
      return;
    }

    this.logger.info(logMessage);
    this.autoDetachSignals(trigger);
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
  private autoDetachSignals(trigger: string): void {
    try {
      this.detachSignals();
    } catch (error) {
      this.logger.error(
        'Could not detach process signals after {{trigger}}: {{error.message}}',
        { params: { trigger, error: toError(error) } },
      );
      reportCallbackError(
        `lifecycle-manager signal detach after ${trigger}`,
        error,
      );
    }
  }

  private autoDetachSignalsIfIdle(trigger: string): void {
    if (
      !this.detachSignalsOnStop ||
      this.isStarting ||
      this.runningComponents.size > 0 ||
      !this.processSignalManager?.getStatus().isAttached
    ) {
      return;
    }

    this.logger.info(`Auto-detaching process signals after ${trigger}`);
    this.autoDetachSignals(trigger);
  }

  private monitorLateStartupCompletion(
    name: string,
    component: BaseComponent,
    startPromise: Promise<void> | void,
    startAttemptToken: string,
  ): void {
    this.logger
      .entity(name)
      .warn('Startup timed out, stopping component if startup completes later');

    Promise.resolve(startPromise)
      .then(async () => {
        // An abort hook can settle start() inside the timeout callback. Let the
        // timed-out start's catch record its state before beginning late cleanup.
        await Promise.resolve();
        const timeoutState = this.componentStates.get(name);
        const timeoutError = this.componentErrors.get(name) ?? null;

        if (
          this.getComponent(name) !== component ||
          this.componentStartAttemptTokens.get(name) !== startAttemptToken ||
          this.isComponentRunning(name) ||
          (timeoutState !== 'starting-timed-out' && timeoutState !== 'failed')
        ) {
          return;
        }

        // Late startup completed after the manager had already timed out. Mark
        // it running briefly so the normal stop path can clean it up.
        // Lock recovery only while cleanup is actually running. An abandoned
        // start may never settle; the attempt token protects a replacement run.
        this.pendingBulkStartupCleanup.set(name, startAttemptToken);
        this.componentStates.set(name, 'running');
        this.runningComponents.add(name);
        this.stalledComponents.delete(name);
        this.updateStartedFlag();

        const timestamps = this.componentTimestamps.get(name) ?? {
          startedAt: null,
          stoppedAt: null,
        };

        timestamps.startedAt = Date.now();
        this.componentTimestamps.set(name, timestamps);

        this.logger
          .entity(name)
          .warn(
            'Component completed startup after timeout, stopping automatically',
          );

        const stopResult = await this.stopComponentInternal(name);

        if (!stopResult.success) {
          this.logger
            .entity(name)
            .warn('Automatic stop after startup timeout failed', {
              params: {
                error: stopResult.error,
                code: stopResult.code,
              },
            });
          return;
        }

        this.componentStates.set(name, timeoutState);
        this.componentErrors.set(name, timeoutError);
      })
      .catch((error: unknown) => {
        // A rejection from `start()` itself needs nothing further - the component is
        // already recorded as timed out. But this `catch` also covers the recovery body
        // above, including the `stopComponentInternal` that exists to stop a late-starting
        // component, and a failure there means that stop silently did not happen.
        this.logger
          .entity(name)
          .debug('Late startup completion handling ended in a failure', {
            params: { error: toError(error) },
          });
      })
      // Terminal, for the reason the shutdown-warning chain carries one: nothing
      // retains this chain, so a throw out of the reporting handler above becomes an
      // unhandled rejection mid-lifecycle - fatal under Node's default
      // `--unhandled-rejections=throw`. Logging is guarded, but a floating chain
      // should not have to rely on that.
      .catch(() => {
        // Nothing left to report with.
      })
      .finally(() => {
        if (this.pendingBulkStartupCleanup.get(name) === startAttemptToken) {
          this.pendingBulkStartupCleanup.delete(name);
        }
      });
  }

  private consumeUnexpectedStopsDuringStartup(
    startedComponents: string[],
    failedOptionalComponents: Array<{ name: string; error: Error }>,
  ): {
    startedComponents: string[];
    requiredFailure?: { name: string; error: Error };
  } {
    if (this.unexpectedStopsDuringStartup.size === 0) {
      return { startedComponents: [...startedComponents] };
    }

    const remainingStartedComponents: string[] = [];
    let requiredFailure: { name: string; error: Error } | undefined;

    for (const name of startedComponents) {
      const startupStopError = this.unexpectedStopsDuringStartup.get(name);

      if (startupStopError === undefined) {
        remainingStartedComponents.push(name);
        continue;
      }

      this.unexpectedStopsDuringStartup.delete(name);

      const error =
        startupStopError ??
        new Error(`Component "${name}" stopped unexpectedly during startup`);
      const component = this.getComponent(name);

      if (component?.isOptional()) {
        if (!failedOptionalComponents.some((entry) => entry.name === name)) {
          failedOptionalComponents.push({ name, error });
        }

        this.logger
          .entity(name)
          .warn(
            LIFECYCLE_MANAGER_LOG_OPTIONAL_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
            {
              params: { error },
            },
          );

        continue;
      }

      this.logger
        .entity(name)
        .error(
          LIFECYCLE_MANAGER_LOG_REQUIRED_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
          {
            params: { error },
          },
        );

      requiredFailure ??= { name, error };
    }

    return {
      startedComponents: remainingStartedComponents,
      requiredFailure,
    };
  }

  /**
   * Issues and returns a unique stop attempt token for a component.
   *
   * Each stop attempt (graceful or force-retry) gets a unique token.
   * The late-resolution handler captures this token in its closure so it can
   * skip any stall entries that were created by a *later* stop attempt — e.g. a
   * force-retry that also timed out after the original graceful promise floated
   * in the background.
   */
  private issueStopAttemptToken(name: string): string {
    const next = ulid();
    this.componentStopAttemptTokens.set(name, next);
    return next;
  }

  private createPendingForceStopWaiter(name: string): {
    promise: Promise<void>;
    cleanup: () => void;
  } {
    let isResolved = false;
    let waiters = this.pendingForceStopWaiters.get(name);

    if (!waiters) {
      waiters = new Set();
      this.pendingForceStopWaiters.set(name, waiters);
    }

    let resolveWaiter!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveWaiter = () => {
        if (isResolved) {
          return;
        }

        isResolved = true;
        resolve();
      };
    });

    waiters.add(resolveWaiter);

    return {
      promise,
      cleanup: () => {
        const pending = this.pendingForceStopWaiters.get(name);
        if (!pending) {
          return;
        }

        pending.delete(resolveWaiter);
        if (pending.size === 0) {
          this.pendingForceStopWaiters.delete(name);
        }
      },
    };
  }

  private resolvePendingForceStopWaiters(name: string): void {
    const waiters = this.pendingForceStopWaiters.get(name);
    if (!waiters || waiters.size === 0) {
      return;
    }

    this.pendingForceStopWaiters.delete(name);
    for (const resolve of waiters) {
      resolve();
    }
  }

  /**
   * Called when a stop promise eventually resolves after its timeout path already fired.
   *
   * Usually this means a previously stalled component's original stop() or
   * onShutdownForce() promise finally resolved, so the manager can clear the
   * stall and transition the component to stopped without a manual retry.
   *
   * There is one extra overlap case for graceful stop(): stop() can resolve
   * after the graceful timeout but before onShutdownForce() itself times out.
   * In that window no stall entry exists yet, but the component still finished
   * stopping cleanly, so we finalize it here and let the later force-timeout
   * path observe the already-stopped state and no-op. This overlap fix is
   * scoped to the same stop token and will not cross a later retry attempt.
   *
   * Two guards prevent stale floating promises from incorrectly clearing state:
   *
   * 1. token guard — if a newer stop attempt (e.g. a retryStalled
   *    force-retry) has started since this promise was launched, its token
   *    won't match and we bail out immediately.
   *
   * 2. state/stall guard — if the component was unregistered, restarted, or
   *    already cleared by another path, there will be neither a matching stall
   *    entry nor the force-phase overlap state, so we bail out.
   */
  private handleLateStopResolution(
    name: string,
    token: string,
    source: 'graceful' | 'force',
  ): void {
    // Guard 1: bail if a newer stop attempt has superseded this one. The newer
    // attempt owns any stop/stall state and must manage its own late resolution.
    if (this.componentStopAttemptTokens.get(name) !== token) {
      return;
    }

    const currentState = this.componentStates.get(name);
    const stallInfo = this.stalledComponents.get(name);

    // Graceful stop can also complete during the force-stopping window before a
    // stall record exists. In that overlap, finalize the stop directly so the
    // later force timeout path can detect the already-stopped state and no-op.
    const isCompletedDuringForcePhase =
      source === 'graceful' && !stallInfo && currentState === 'force-stopping';

    // Guard 2: once the component is no longer in the stalled state because a
    // newer lifecycle attempt changed its state, the old stop promise no longer
    // owns the component state. Clear the stale stall bookkeeping, but do not
    // emit stopped or overwrite the newer state.
    if (stallInfo && currentState !== 'stalled') {
      this.stalledComponents.delete(name);
      return;
    }

    // Guard 3: bail if neither a stall entry nor the force-phase overlap case
    // exists. This covers unregistered, restarted, or already-cleared paths.
    if (!stallInfo && !isCompletedDuringForcePhase) {
      return;
    }

    const stalledDurationMS = stallInfo
      ? Date.now() - stallInfo.stalledAt
      : undefined;

    if (stallInfo) {
      this.stalledComponents.delete(name);
    }
    this.componentStates.set(name, 'stopped');
    this.runningComponents.delete(name);
    // Clear the stall/timeout error so lastError reflects a clean stop, not the
    // timeout that caused the stall.
    this.componentErrors.set(name, null);
    this.componentUnexpectedStopHadError.delete(name);
    this.updateStartedFlag();
    this.resolvePendingForceStopWaiters(name);

    this.detachSignalsAfterLastStop();

    const timestamps = this.componentTimestamps.get(name) ?? {
      startedAt: null,
      stoppedAt: null,
    };

    timestamps.stoppedAt = Date.now();
    this.componentTimestamps.set(name, timestamps);

    this.logger
      .entity(name)
      .info(
        stallInfo
          ? 'Stalled component completed stop late, stall cleared'
          : 'Graceful stop completed after force phase started',
        stalledDurationMS ? { params: { stalledDurationMS } } : undefined,
      );

    // If the force promise itself completed late, preserve the same "force
    // finished" signal that a normal in-time force shutdown would have emitted.
    if (source === 'force') {
      this.lifecycleEvents.componentShutdownForceCompleted(name);
    }

    if (stallInfo && stalledDurationMS !== undefined) {
      // Late resolution is modeled as: stalled -> stall cleared -> stopped.
      // Emit both events so observers can distinguish "the stall ended" from
      // "the component is now fully stopped".
      this.lifecycleEvents.componentStalledResolved(
        name,
        stallInfo,
        stalledDurationMS,
      );
    }

    this.lifecycleEvents.componentStopped(name, this.getComponentStatus(name));
  }

  private handleComponentUnexpectedStop(
    name: string,
    startAttemptToken: string,
    error?: Error,
  ): boolean {
    // Handler is cleared before stop begins, so a call here means the component
    // stopped on its own during the current start/run.
    const currentState = this.componentStates.get(name);
    if (
      // Startup-time self-stops are valid too: start() may still be awaiting
      // some async work while an internal listener has already observed that
      // the component died and reported it.
      (currentState !== 'starting' && currentState !== 'running') ||
      this.componentStartAttemptTokens.get(name) !== startAttemptToken
    ) {
      return false;
    }

    // Normalized at the boundary. `error` is declared `Error`, but it arrives from the
    // component's own `reportUnexpectedStop()` and is never validated, so it can be any
    // value at all. It is stored here and dereferenced in several places later — the
    // warning below, `startAllComponents`'s failure summary, `getComponentStatus` — and
    // every one of those reads would otherwise be an unguarded `.message` on user input.
    // Normalized here, before a single field is written, and that ordering is the point:
    // a throw from an unguarded `.message` once the mutations below had run would leave
    // the component recorded as stopped with none of the events at the bottom emitted.
    // Taking the bad value's measure first means the only thing it can cost is itself.
    const failure =
      error === undefined || error === null ? null : toError(error);

    // Captured before the normalization above is allowed to blur the distinction, and
    // asked with the same check `toError` just used. A bare `instanceof` contradicted the
    // line above it: `toError` keeps a cross-realm error - from a `vm` context, an
    // iframe - as-is, so `componentErrors` held a real error while this recorded that the
    // component had reported none, and `startComponent`'s overlapping-failure rule read
    // the wrong answer. Guarded internally, so the local `try` this replaces is no longer
    // needed.
    const didReportError = isErrorValue(error);

    this.componentUnexpectedStopHadError.set(name, didReportError);

    this.runningComponents.delete(name);
    this.componentStates.set(name, 'stopped');
    this.componentErrors.set(name, failure);
    if (this.isStarting) {
      this.unexpectedStopsDuringStartup.set(name, failure);
    }
    this.updateStartedFlag();

    // Mirror the normal stop path: if this was the last running component, the
    // manager should release process signal handlers instead of staying attached
    // to an otherwise idle application.
    // Not during bulk startup: the startup's own cleanup decides what to detach.
    if (!this.isStarting) {
      this.detachSignalsAfterLastStop();
    }

    const timestamps = this.componentTimestamps.get(name) ?? {
      startedAt: null,
      stoppedAt: null,
    };
    timestamps.stoppedAt = Date.now();
    this.componentTimestamps.set(name, timestamps);

    this.logger.entity(name).warn(
      // A placeholder, never the message concatenated in. The component's own text
      // becomes the *template* otherwise, and the path grammar admits ordinary name
      // punctuation - `-`, `@`, `$` - so a failure reported as
      // `Cannot reach {{svc-a}}` parses as a placeholder, resolves to nothing, and is
      // rendered as the `(null)` fallback. Substituted text is not re-scanned, so the
      // message survives verbatim here however it is spelled.
      failure
        ? 'Component stopped unexpectedly: {{error.message}}'
        : 'Component stopped unexpectedly',
      { params: { error: failure } },
    );

    // Model this the same as other terminal transitions: emit the abnormal-cause
    // event first, then the canonical stopped-state event that generic listeners
    // can rely on regardless of why the component stopped.
    this.lifecycleEvents.componentUnexpectedStop(name, failure ?? undefined);
    this.lifecycleEvents.componentStopped(name, this.getComponentStatus(name));
    return true;
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
      const err = toError(error);

      this.logger.error('Event handler error: {{error.message}}', {
        params: { event, error: err },
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
    if (this.isShuttingDown) {
      this.noteShutdownRequestDuringActivePass();
      this.lifecycleEvents.signalShutdown(method, true);

      // No window to consume: `acceptShutdownPass()` spends it on the request that starts
      // the pass. A window armed by this very pass - from a listener on its completed
      // event, before the latch comes down - that has already expired is cleared by
      // this call. Either way the request is answered here: falling through would emit
      // `signal:shutdown` a second time and reseed escalation under a running pass.
      this.handleRepeatedShutdownRequest(method, null);

      return;
    }

    let didEmitShutdownSignal = false;
    let shouldSeedRepeatedShutdownState =
      this.repeatedShutdownRequestPolicy !== undefined;

    // This branch is only for the post-failure "armed" state.
    // A previous shutdown request already happened, shutdown has already
    // finished returning, and we intentionally keep escalation alive for a
    // short period so follow-up presses can continue the same force count.
    if (
      this.repeatedShutdownRequestPolicy &&
      this.repeatedShutdownRequestState.firstRequestAt !== null &&
      this.normalizeRepeatedShutdownRequestStateArmedStatus()
    ) {
      // Consumed first, ahead of every line below that can run user code - the emit's
      // listeners as much as the force handler `handleRepeatedShutdownRequest()` can
      // reach. The same ordering `acceptShutdownPass()` uses, and for the same reason: a
      // shutdown request made from inside any of them continues this one rather than
      // counting as a press of its own. The pass this request goes on to start would have
      // cleared the window a moment later regardless.
      const consumedArmedUntil = this.consumeRepeatedShutdownArmedWindow();

      this.lifecycleEvents.signalShutdown(method, false);
      didEmitShutdownSignal = true;
      shouldSeedRepeatedShutdownState = false;
      this.handleRepeatedShutdownRequest(method, consumedArmedUntil);
    }

    if (shouldSeedRepeatedShutdownState) {
      this.seedRepeatedShutdownRequestState(method);
    }

    this.logger.info('Shutdown signal received', {
      params: { method },
    });

    if (!didEmitShutdownSignal) {
      this.lifecycleEvents.signalShutdown(method, false);
    }

    // Signal handlers cannot consume a return value, so the acknowledgement is dropped;
    // a pass that failed to start has already been reported on the global channel.
    this.startShutdownPass(method);
  }

  /**
   * Final step of a signal-driven shutdown request: starts the pass in the background and
   * returns without waiting for components to stop, since a signal handler has nobody to
   * hand a result to. The outcome arrives on `lifecycle-manager:shutdown-completed`.
   */
  private startShutdownPass(method: ShutdownSignal): void {
    // A signal means the process should stay down, so a refusal is recorded on the
    // running pass - including one started from inside this request's own escalation
    // bookkeeping, which was not there when `handleShutdownRequest()` checked the latch.
    const acceptance = this.acceptShutdownPass(method, undefined, true);

    if (!acceptance.accepted) {
      return;
    }

    // `runShutdownPass()` resolves even when the pass dies, reporting the failure itself.
    // The handler stays anyway: this promise floats, and on `SIGINT`/`SIGTERM` an
    // unhandled rejection is fatal under Node's default `--unhandled-rejections=throw`,
    // taking the process down before the components it was about to stop were stopped.
    acceptance.promise.catch((error: unknown) => {
      reportCallbackError(`shutdown after ${method}`, error);
    });
  }

  /**
   * Records a shutdown request that landed while a shutdown pass was already running.
   *
   * Such a request is still refused as "already in progress" - the running pass is the
   * shutdown the requester gets, and starting a second pass on top of it would be wrong.
   * What must not happen is a `restartAllComponents()` whose stop phase that pass is
   * starting everything back up afterwards, so the request is recorded on the pass and
   * phase 2 is skipped instead.
   *
   * Reached from `acceptShutdownPass()`'s refusals for every request that asks to stay
   * down (its `isRequestToStayDown`), and directly from the two places that see a running
   * pass without going through it: `handleShutdownRequest()`'s own latch check for a
   * signal, and the `enableLoggerExitHook()` callback, where `logger.exit()` says the
   * process is going down.
   */
  private noteShutdownRequestDuringActivePass(): void {
    if (this.activeShutdownPass !== null) {
      this.activeShutdownPass.shutdownRequested = true;
    }
  }

  /**
   * Both of `acceptShutdownPass()`'s refusals, so they cannot drift apart on whether the
   * refusal is recorded against the running pass.
   */
  private refuseShutdownPass(
    isRequestToStayDown: boolean,
  ): ShutdownPassAcceptance {
    if (isRequestToStayDown) {
      this.noteShutdownRequestDuringActivePass();
    }

    return { accepted: false, result: this.refusedShutdownResult() };
  }

  /**
   * The refusal `acceptShutdownPass()` returns when it will not run a pass because one
   * is already running - whether the latch was already set on entry or was taken by a
   * nested request while this one was still being set up. Shared so the two refusals
   * cannot drift into reporting different things for the same situation.
   */
  private refusedShutdownResult(): ShutdownResult {
    return {
      success: false,
      stoppedComponents: [],
      stalledComponents: [],
      durationMS: 0,
      reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
      code: 'already_in_progress',
    };
  }

  /**
   * The safety net under every public async method: whatever `run` throws or rejects with
   * comes back as the failed result `toFailure` builds, and the original is reported on the
   * global `'error'` channel.
   *
   * The public methods answer with result objects rather than rejections, so a caller can
   * start one without awaiting it - `const pending = manager.stopAllComponents()` - and read
   * the outcome whenever it likes, or drop it with `void`. A rejection would break that:
   * with nothing attached it is an unhandled rejection, fatal under Node's default
   * `--unhandled-rejections=throw`. Nothing that lands here is an expected outcome - it is
   * a bug in the manager, or a component that broke its contract with a throwing getter -
   * so it is reported rather than swallowed, and the result says `unknown_error`.
   *
   * `toFailure` runs on the failure path with nothing left above it, so it must build its
   * result from values it can read without running caller code.
   */
  private async settleOperation<T>(
    operation: string,
    run: () => Promise<T>,
    toFailure: (error: Error, reason: string) => T,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      reportCallbackError(`lifecycle-manager ${operation}`, error);

      return toFailure(
        toError(error),
        `${operation}() failed unexpectedly: ${describeError(error)}`,
      );
    }
  }

  /**
   * The `ShutdownResult` for a shutdown call that crashed before any pass could report its
   * own result - so nothing stopped that this call knows of. A pass that dies reports
   * itself from inside `runShutdownPass()` instead, with what it did stop.
   */
  private crashedShutdownResult(error: Error, reason: string): ShutdownResult {
    return {
      success: false,
      stoppedComponents: [],
      stalledComponents: [],
      durationMS: 0,
      reason,
      code: 'unknown_error',
      error,
    };
  }

  /**
   * The `SignalBroadcastResult` for a `trigger*()` call that failed as a whole - its
   * custom `on*Requested` callback threw or rejected, or the call itself crashed - so
   * there are no per-component results to report.
   */
  private crashedSignalBroadcastResult(
    signal: SignalBroadcastResult['signal'],
    error: Error,
  ): SignalBroadcastResult {
    return { signal, results: [], timedOut: false, code: 'error', error };
  }

  /**
   * The `HealthCheckResult` for a health check that crashed outside the component's own
   * `healthCheck()` - which is timed and caught on its own.
   */
  private crashedHealthCheckResult(
    name: string,
    error: Error,
  ): HealthCheckResult {
    return {
      name,
      healthy: false,
      checkedAt: Date.now(),
      durationMS: 0,
      error,
      timedOut: false,
      code: 'error',
    };
  }

  /**
   * The `ComponentOperationResult` for a per-component operation that crashed. Carries no
   * `status`: building one reads component state through code that may be what threw.
   */
  private crashedComponentResult(
    name: string,
    error: Error,
    reason: string,
  ): ComponentOperationResult {
    return {
      success: false,
      componentName: name,
      reason,
      code: 'unknown_error',
      error,
    };
  }

  /**
   * A component's name for a failure result, without letting an overridden `getName()`
   * that throws turn the failure report into a second failure.
   */
  private readComponentNameSafely(component: unknown): string {
    try {
      const name: unknown = (component as BaseComponent).getName();

      return typeof name === 'string' ? name : String(name);
    } catch {
      return '<unknown>';
    }
  }

  /**
   * The `StartupResult` a startup path returns when it starts nothing at all: no
   * component started, none failed, none skipped, and a code and reason saying why.
   * Shared for the same reason as {@link refusedShutdownResult}, so the refusals cannot
   * drift into reporting different shapes for the same kind of answer.
   *
   * Only for refusals that are exactly that. A refusal carrying more - the names a stall
   * blocked startup with, or the components that were already running - builds its own
   * literal rather than passing them through here.
   */
  private refusedStartupResult(
    code: NonNullable<StartupResult['code']>,
    reason: string,
    durationMS = 0,
  ): StartupResult {
    return {
      success: false,
      startedComponents: [],
      failedOptionalComponents: [],
      skippedDueToDependency: [],
      reason,
      code,
      durationMS,
    };
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
   * nothing left here to tell an armed request apart from a fresh one.
   * @returns true when the request was consumed as part of the repeated-shutdown
   * escalation flow, false when the caller should treat it as a fresh shutdown request
   */
  private handleRepeatedShutdownRequest(
    method: ShutdownMethod,
    consumedArmedUntil: number | null,
  ): boolean {
    const policy = this.repeatedShutdownRequestPolicy;

    if (!policy) {
      // Signals only: a `'manual'` request never reaches here without a policy.
      this.logger.warn('Shutdown already in progress, ignoring signal', {
        params: { method },
      });
      return true;
    }

    const now = Date.now();
    const state = this.repeatedShutdownRequestState;

    // Skipped when this request consumed the window on its way in: the caller already
    // checked the deadline before consuming, and refreshing a window that the pass it is
    // about to start would clear again immediately says nothing.
    if (consumedArmedUntil === null && state.remainsArmedUntil !== null) {
      if (now >= state.remainsArmedUntil) {
        this.expireRepeatedShutdownRequestState();
        return false;
      }

      // Keep the post-failure escalation window alive while shutdown requests
      // are still arriving. This avoids a stale deadline expiring mid-stream
      // when an operator is actively trying to force the process down.
      this.refreshRepeatedShutdownArmedWindow(now);
    }

    // What the window looked like for this request, whether it is still on the state or
    // this request took it. Both the log lines and `wasArmedAfterFailure` describe the
    // request, so neither may go blind just because the window was consumed early.
    const armedUntil = consumedArmedUntil ?? state.remainsArmedUntil;
    const wasArmedAfterFailure = armedUntil !== null;

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
      return true;
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
    return true;
  }

  /**
   * Clears repeated shutdown request tracking so a new shutdown cycle starts fresh.
   */
  private resetRepeatedShutdownRequestState(): void {
    this.clearRepeatedShutdownExpiryTimer();
    this.repeatedShutdownRequestState = {
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
    const armedUntil = this.repeatedShutdownRequestState.remainsArmedUntil;

    if (armedUntil === null) {
      return null;
    }

    this.clearRepeatedShutdownExpiryTimer();
    this.repeatedShutdownRequestState.remainsArmedUntil = null;

    return armedUntil;
  }

  /**
   * Clear any pending expiration timer for the post-failure escalation window.
   */
  private clearRepeatedShutdownExpiryTimer(): void {
    if (this.repeatedShutdownExpiryTimer === null) {
      return;
    }

    clearTimeout(this.repeatedShutdownExpiryTimer);
    this.repeatedShutdownExpiryTimer = null;
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
    const armedUntil = this.repeatedShutdownRequestState.remainsArmedUntil;

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
    const policy = this.repeatedShutdownRequestPolicy;
    const state = this.repeatedShutdownRequestState;

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

    // The guard matters here: this runs on the shutdown-request path and in the expiry
    // timer, ahead of the reset below, so a logger that threw would otherwise leave the
    // stale state armed.
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

    this.resetRepeatedShutdownRequestState();
  }

  /**
   * Arms or refreshes the post-failure escalation window and its expiration timer.
   */
  private refreshRepeatedShutdownArmedWindow(now = Date.now()): void {
    const policy = this.repeatedShutdownRequestPolicy;

    if (!policy) {
      return;
    }

    this.clearRepeatedShutdownExpiryTimer();

    const armedUntil = now + policy.armedAfterFailureMS;
    this.repeatedShutdownRequestState.remainsArmedUntil = armedUntil;
    this.repeatedShutdownExpiryTimer = setTimeout(() => {
      this.expireRepeatedShutdownRequestState();
    }, toTimerDelayMS(policy.armedAfterFailureMS));
    // Expiry should not keep the process alive when nothing else is pending.
    this.repeatedShutdownExpiryTimer.unref();
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
    this.repeatedShutdownRequestState = {
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
    const policy = this.repeatedShutdownRequestPolicy;
    const state = this.repeatedShutdownRequestState;

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
      const outcome = await safeHandleCallbackAndWait(
        `lifecycle-manager ${descriptor.signal} request callback`,
        descriptor.customCallback,
        descriptor.broadcast,
      );

      if (!outcome.success) {
        return this.crashedSignalBroadcastResult(
          descriptor.signal,
          outcome.error,
        );
      }

      // Return empty result (custom callback handled it)
      return {
        signal: descriptor.signal,
        results: [],
        timedOut: false,
        code: 'ok',
      };
    }

    return descriptor.broadcast();
  }

  private async handleReloadRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return this.handleSignalRequest(
      {
        signal: 'reload',
        dispatchedLogLabel: 'Reload dispatched',
        emitSignal: () => this.lifecycleEvents.signalReload(),
        customCallback: this.onReloadRequested,
        broadcast: () => this.broadcastReload(),
      },
      source,
    );
  }

  private async handleInfoRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return this.handleSignalRequest(
      {
        signal: 'info',
        dispatchedLogLabel: 'Info dispatched',
        emitSignal: () => this.lifecycleEvents.signalInfo(),
        customCallback: this.onInfoRequested,
        broadcast: () => this.broadcastInfo(),
      },
      source,
    );
  }

  private async handleDebugRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return this.handleSignalRequest(
      {
        signal: 'debug',
        dispatchedLogLabel: 'Debug dispatched',
        emitSignal: () => this.lifecycleEvents.signalDebug(),
        customCallback: this.onDebugRequested,
        broadcast: () => this.broadcastDebug(),
      },
      source,
    );
  }

  /**
   * Shared signal broadcast pipeline used by reload/info/debug.
   * Iterates running components, runs the picked handler with timeout, and
   * aggregates per-component results into a SignalBroadcastResult.
   */
  private async runSignalBroadcast(descriptor: {
    signal: 'reload' | 'info' | 'debug';
    pickHandler: (
      component: BaseComponent,
    ) => (() => Promise<void> | void) | undefined;
    startupLog: string;
    timeoutLog: string;
    errorLog: string;
    emitStarted: (name: string) => void;
    emitCompleted: (name: string) => void;
    emitFailed: (name: string, error: Error) => void;
  }): Promise<SignalBroadcastResult> {
    const results: ComponentSignalResult[] = [];

    const canDispatch = (component: BaseComponent): boolean =>
      this.getComponent(component.getName()) === component &&
      this.componentStates.get(component.getName()) === 'running' &&
      this.runningComponents.has(component.getName());
    const targets = this.components.filter(canDispatch);

    if (this.isStarting) {
      this.logger.info(descriptor.startupLog);
    }

    for (const component of targets) {
      const name = component.getName();
      if (!canDispatch(component)) {
        continue;
      }
      const handler = descriptor.pickHandler(component);

      if (!handler) {
        results.push({
          name,
          called: false,
          error: null,
          timedOut: false,
          code: 'no_handler',
        });
        continue;
      }

      descriptor.emitStarted(name);
      // Event listeners can synchronously begin teardown too.
      if (!canDispatch(component)) {
        results.push({
          name,
          called: false,
          error: null,
          timedOut: false,
          code: 'unavailable',
        });
        continue;
      }

      const timeoutMS = component.signalTimeoutMS;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const timeoutResult = { timedOut: true } as const;

      try {
        const handlerResult = handler();
        const handlerPromise: Promise<unknown> = isPromise(handlerResult)
          ? handlerResult
          : Promise.resolve(handlerResult as unknown);

        const outcome: unknown =
          toTimerDelayMS(timeoutMS) > 0
            ? await Promise.race([
                handlerPromise,
                new Promise<typeof timeoutResult>((resolve) => {
                  timeoutHandle = setTimeout(() => {
                    resolve(timeoutResult);
                  }, toTimerDelayMS(timeoutMS));
                }),
              ])
            : await handlerPromise;

        if (outcome === timeoutResult) {
          this.logger.entity(name).warn(descriptor.timeoutLog, {
            params: { timeoutMS },
          });
          // Prevent unhandled rejection if handler throws after timeout
          // Logged, not discarded. Preventing the unhandled rejection is why this
          // `catch` exists and it stays; swallowing the *cause* was a separate
          // decision, and it left the caller knowing the operation timed out and
          // never why it ultimately failed. The timeout warning is logged just
          // above, so this is that line's missing second half.
          Promise.resolve(handlerPromise)
            .catch((error: unknown) => {
              this.logger
                .entity(name)
                .debug(
                  'Lifecycle handler failed after it had already timed out',
                  {
                    params: { error: toError(error) },
                  },
                );
            })
            // Terminal, for the reason the shutdown-warning chain carries one: nothing
            // retains this chain, so a throw out of the reporting handler above becomes an
            // unhandled rejection mid-lifecycle - fatal under Node's default
            // `--unhandled-rejections=throw`. Logging is guarded, but a floating chain
            // should not have to rely on that.
            .catch(() => {
              // Nothing left to report with.
            });
          results.push({
            name,
            called: true,
            error: null,
            timedOut: true,
            code: 'timeout',
          });
        } else {
          descriptor.emitCompleted(name);
          results.push({
            name,
            called: true,
            error: null,
            timedOut: false,
            code: 'called',
          });
        }
      } catch (error) {
        const err = toError(error);

        this.logger.entity(name).error(descriptor.errorLog, {
          params: { error: err },
        });

        descriptor.emitFailed(name, err);

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
      signal: descriptor.signal,
      results,
      timedOut: hasTimeout,
      code,
    };
  }

  /**
   * Broadcast reload signal to all running components.
   * Calls onReload() on components that implement it.
   * Continues on errors - collects all results.
   */
  private async broadcastReload(): Promise<SignalBroadcastResult> {
    return this.runSignalBroadcast({
      signal: 'reload',
      pickHandler: (component) => component.onReload?.bind(component),
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
  private async broadcastInfo(): Promise<SignalBroadcastResult> {
    return this.runSignalBroadcast({
      signal: 'info',
      pickHandler: (component) => component.onInfo?.bind(component),
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
  private async broadcastDebug(): Promise<SignalBroadcastResult> {
    return this.runSignalBroadcast({
      signal: 'debug',
      pickHandler: (component) => component.onDebug?.bind(component),
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
