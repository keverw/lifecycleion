import { isNullish } from '../internal/is-nullish';
import { runShutdownWarningPhase } from './internal/shutdown-warning';
import { ComponentMetadataReader } from './internal/component-metadata-reader';
import { createStopPhaseObserver } from './internal/stop-phase-observer';
import { TransitionEventDispatcher } from './internal/transition-event-dispatcher';
import { RegistrationReadTracker } from './internal/registration-read-tracker';
import type { ComponentAccessContext } from './internal/component-access-context';
import {
  sendMessageInternal,
  broadcastMessageInternal,
  getValueInternal,
} from './internal/component-messaging';
import {
  checkComponentHealthOperation,
  checkAllHealthOperation,
  runSignalBroadcast,
  type SignalBroadcastDescriptor,
} from './internal/component-inspection';
import {
  type DependencyRead,
  dependenciesOf,
  tryReadDependencies,
  getStartupOrder,
  findAllCircularCycles,
} from './internal/dependency-policy';
import {
  isOperationTimeoutValidationError,
  resolveOperationTimeoutMS,
  toOperationTimerDelayMS,
  settleOperation,
  refusedShutdownResult,
  crashedStartupResult,
  crashedShutdownResult,
  crashedSignalBroadcastResult,
  crashedHealthCheckResult,
  crashedComponentResult,
  refusedStartupResult,
} from './internal/operation-policy';
import {
  type RegistrationProgress,
  newRegistrationProgress,
  positionHasTarget,
  defaultTargetFound,
  reportedComponentName,
  committedRegistrationReport,
  isInsertPosition,
  isManualPositionRespected,
} from './internal/registration-policy';
import {
  observeRejection,
  observePromise,
  awaitBoxedPromise,
  promiseConstructorIntrinsic,
  applyIntrinsic,
  promiseResolveIntrinsic,
  racePromises,
} from '../internal/intrinsics';
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
  LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
  LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
} from './constants';
import {
  ProcessSignalManager,
  type ShutdownSignal,
} from '../process-signal-manager';
import { adoptPromise } from '../internal/adopt-promise';
import {
  reportCallbackError,
  runCallbackSafely,
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from '../safe-handle-callback';
import { createGuardedLoggerService } from './guarded-logger';
import { describeError, isErrorValue, toError } from '../to-error';
import { finiteClampMin } from '../clamp';
import {
  assertDurationMS,
  resolveTimeoutMS,
  optionalValidatedTimerDelayMS,
  toTimerDelayMS,
} from '../internal/timer-limits';

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
 * A shutdown pass's options, resolved against the manager's defaults.
 *
 * Resolved by the acceptance step rather than by the pass, so the reads that could throw
 * happen on the side of the latch where a throw costs nothing.
 */
interface ShutdownPassOptions {
  /** Already clamped to a usable timer delay by `toOperationTimerDelayMS()`; `0` means no timer. */
  readonly timeoutMS: number;
  readonly retryStalled: boolean;
  readonly haltOnStall: boolean;
  readonly allowStopWithPendingStarts: boolean;
}

/** A start and any automatic cleanup it still owns. */
interface StartSettlement {
  readonly name: string;
  readonly promise: Promise<void>;
  /** The raw start timed out; its eventual cleanup is still owned by `promise`. */
  readonly abandoned: Promise<void>;
  readonly abandon: () => void;
  readonly finish: () => void;
  didSettle: boolean;
  rawStartPending: boolean;
  recovery?: Promise<void>;
  isAwaitingLateStart?: boolean;
  component?: BaseComponent;
  token?: string;
}

/** Raw startup or its owned cleanup has not finished, regardless of display state. */
function isStartUnfinished(settlement: StartSettlement | undefined): boolean {
  return (
    settlement !== undefined &&
    (settlement.rawStartPending || !settlement.didSettle)
  );
}

/** The running registration and timeout approved before restart stops it. */
interface RestartStartSnapshot {
  readonly component: BaseComponent;
  readonly generation: number | undefined;
  readonly timeoutMS: number;
}

/** Call-local policy and claim history for an individual stop or restart. */
interface IndividualStopContext {
  readonly operation: 'stop' | 'restart';
  /** Stays true after this attempt claims, even if its claim is later released. */
  claimed: boolean;
  allowStopWithRunningDependents?: boolean;
  isStartupRollback?: boolean;
  hasShutdownBegun?: () => boolean;
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
   * owns the pass skips its startup phase and nothing is started again.
   */
  shutdownRequested: boolean;

  /**
   * A `restartAllComponents()` stop phase, rather than a request to stay down. It does
   * not seed escalation: nobody has asked the process to go down yet, so there is no
   * operator cycle to start. The first signal that lands on it seeds one - see
   * `answerShutdownSignalDuringPass()`.
   */
  readonly isRestartStopPhase: boolean;
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
  private readonly shutdownOptions: ShutdownPassOptions;
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
  private componentEntries: BaseComponent[] = [];

  // Operations share this committed snapshot. Publication and unregister replace
  // it once; reads during registration hooks never allocate a filtered copy.
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

  // Published before start callbacks run; settlement includes automatic stop cleanup.
  private readonly startSettlements = new Map<symbol, StartSettlement>();
  private readonly invokingStarts = new Set<StartSettlement>();
  // Set when a `detachSignalsOnStop` detach was due - nothing left running or stalled -
  // but something transient was still in flight: a startup or shutdown latch, a start or
  // stop, a late-startup cleanup. Whichever of those ends runs the check again.
  private isSignalDetachDeferred = false;
  // Use per-stop ULIDs instead of incrementing counters because a stalled
  // component can be unregistered and replaced by a same-name instance before
  // the old floating stop promise settles.
  private componentStopAttemptTokens: Map<string, string> = new Map();
  private pendingForceStopWaiters: Map<string, Set<() => void>> = new Map();
  private unexpectedStopsDuringStartup: Map<string, Error | null> = new Map();

  // State flags
  private isStarting = false;
  private autoAttachedSignalsDuringStartup = false;
  // Auto-starts inherited from a restart gap, accepted during initial ordering, or
  // queued for a follow-up batch. Removed when their batch freezes its order; those
  // still pending when startup ends are reported as abandoned.
  // Only ever non-empty while `isStarting` holds, which also refuses every unregister.
  private deferredAutoStartNames = new Set<string>();
  // Accepted restart stop phases awaiting a startup latch. Each owns its gap
  // registrations until a startup claims the registry or that restart abandons them.
  private readonly pendingRestartAutoStarts = new Set<Set<string>>();
  private readonly registrationReads = new RegistrationReadTracker(
    () => this.components,
  );
  private readonly componentMetadata = new ComponentMetadataReader(
    (component) => this.nameOf(component),
  );
  // The running bulk startup's ordering snapshot and registration boundary.
  private activeBulkStartup: {
    readonly dependencyReads: Map<BaseComponent, DependencyRead>;
    // Registrations made from rollback callbacks are refused auto-start.
    isRollingBack: boolean;
    // During initial ordering, new registrations are included in the original batch.
    isOrdering: boolean;
    // Registrations from terminal notifications start independently of this pass.
    isCompleting: boolean;
  } | null = null;
  private isStarted = false;
  // Unique token used to detect shutdowns that happened during async start().
  private shutdownToken = ulid();
  // The shutdown pass currently running, or `null` when none is. It is the shutdown
  // latch - `isShuttingDown` reads it - so a request refused as "already in progress"
  // can always be recorded against the pass that refused it. See {@link ShutdownPass}.
  private activeShutdownPass: ShutdownPass | null = null;
  // How many shutdown passes that asked the process to stay down have been accepted. A
  // restart compares it across its stop phase: see `restartAllComponentsOperation()`.
  private stayDownPassCount = 0;
  // Each registered component's name, read once when it is committed to the registry.
  // See {@link nameOf}.
  private readonly registeredNames = new WeakMap<BaseComponent, string>();

  // Registry bookkeeping exists while the component receives its lifecycle ref and
  // registration hook. Those overrides can re-enter, but may still throw and roll
  // registration back. Never let start() acquire resources for an uncommitted entry:
  // rollback would remove the only manager record capable of stopping them.
  private readonly pendingRegistrations = new Set<BaseComponent>();
  // Rollback removes registry entries before cleanup hooks, but keeps their original
  // names reserved independently until cleanup returns. Registry readers never need
  // to know about half-rolled-back entries or filter them at individual call sites.
  private readonly rollbackReservations = new Map<BaseComponent, string>();
  // Successful registrations retain their validated read for reports and checks of
  // components committed by nested hooks, without probing caller getters again.
  private readonly committedDependencyReads = new WeakMap<
    BaseComponent,
    DependencyRead
  >();
  // How deep the manager is inside escalation handling - `onForceShutdown` and the
  // escalation events it emits. A shutdown request made from in there continues the
  // cycle being handled rather than starting one. See `acceptShutdownPass()`.
  private escalationHandlingDepth = 0;
  // Narrower than `escalationHandlingDepth`: only while `onForceShutdown` and the
  // `shutdown-escalation-forced` listeners run. The logger exit hook keys on this one - an
  // exit from there is the force itself - and not on the wider depth, which also covers a
  // fresh request's `signal:shutdown` listeners, where an exit must still wait.
  private forceHandlingDepth = 0;
  // Which attempt last claimed each component as `starting`, `stopping` or
  // `force-stopping`, and the state it replaced. The start and stop nets act on a
  // component only through a claim they own: an attempt that crashed before claiming
  // it - while another claimed it across an `await` - must leave that other attempt's
  // claim alone.
  private readonly componentClaims = new Map<
    string,
    {
      readonly claim: symbol;
      readonly previousState: ComponentState | undefined;
    }
  >();
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
  private readonly eventDispatcher = new TransitionEventDispatcher(
    (event, data) => this.deliverEvent(event, data),
  );

  private readonly componentAccess: ComponentAccessContext;

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
    // Invalid configuration is refused before registering signal/exit hooks. Warning
    // timeouts retain their documented negative opt-out; other durations do not have
    // a negative sentinel. Null and undefined select a configured default.
    const requestedWarningTimeout = options.shutdownWarningTimeoutMS;
    const warningTimeout = requestedWarningTimeout ?? 500;
    // Constructor failures are synchronous and have no lifecycle result net to
    // classify. Do not mark them as this manager's operation refusals: a caller
    // can construct another manager inside a component getter.
    assertDurationMS(warningTimeout, 'shutdownWarningTimeoutMS');
    this.shutdownWarningTimeoutMS =
      warningTimeout < 0 ? -1 : toTimerDelayMS(warningTimeout);
    this.messageTimeoutMS = resolveTimeoutMS(
      options.messageTimeoutMS,
      5000,
      'messageTimeoutMS',
    );
    this.startupTimeoutMS = resolveTimeoutMS(
      options.startupTimeoutMS,
      60000,
      'startupTimeoutMS',
    );
    const shutdownOptions = {
      ...options.shutdownOptions,
    };
    this.shutdownOptions = {
      ...shutdownOptions,
      retryStalled: shutdownOptions.retryStalled ?? true,
      haltOnStall: shutdownOptions.haltOnStall ?? true,
      allowStopWithPendingStarts:
        shutdownOptions.allowStopWithPendingStarts === true,
      timeoutMS: resolveTimeoutMS(
        shutdownOptions.timeoutMS,
        30000,
        'shutdownOptions.timeoutMS',
      ),
    };
    this.attachSignalsBeforeStartup =
      options.attachSignalsBeforeStartup ?? false;
    this.attachSignalsOnStart = options.attachSignalsOnStart ?? false;
    this.detachSignalsOnStop = options.detachSignalsOnStop ?? false;
    const repeatedShutdownRequestPolicy = options.repeatedShutdownRequestPolicy;
    if (repeatedShutdownRequestPolicy === undefined) {
      this.repeatedShutdownRequestPolicy = undefined;
    } else {
      const requestedArmedAfterFailureMS =
        repeatedShutdownRequestPolicy.armedAfterFailureMS;
      // Require at least one follow-up request so threshold comparisons stay meaningful.
      const forceAfterCount = finiteClampMin(
        repeatedShutdownRequestPolicy.forceAfterCount,
        1,
        3,
      );
      // A zero-width window is valid and counts only same-tick requests. Invalid
      // explicit durations fail instead of changing the operator's escalation policy.
      const withinMS = resolveTimeoutMS(
        repeatedShutdownRequestPolicy.withinMS,
        2000,
        'repeatedShutdownRequestPolicy.withinMS',
      );
      const armedAfterFailureMS = resolveTimeoutMS(
        requestedArmedAfterFailureMS,
        toTimerDelayMS(withinMS * forceAfterCount),
        'repeatedShutdownRequestPolicy.armedAfterFailureMS',
      );
      this.repeatedShutdownRequestPolicy = {
        forceAfterCount,
        withinMS,
        armedAfterFailureMS,
        countManualRetriesTowardEscalation:
          repeatedShutdownRequestPolicy.countManualRetriesTowardEscalation ??
          false,
        hasExplicitArmedAfterFailureMS: !isNullish(
          requestedArmedAfterFailureMS,
        ),
        onForceShutdown: repeatedShutdownRequestPolicy.onForceShutdown,
      };
    }

    // Store custom signal callbacks
    this.onReloadRequested = options.onReloadRequested;
    this.onInfoRequested = options.onInfoRequested;
    this.onDebugRequested = options.onDebugRequested;
    this.lifecycleEvents = new LifecycleManagerEvents(this.safeEmit.bind(this));
    this.componentAccess = LifecycleManager.createComponentAccessContext(this);

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
      // Present only when deferred, as `insertComponentAt()` reports it.
      ...(result.autoStartDeferred === true ? { autoStartDeferred: true } : {}),
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
   * @returns True if component was unregistered, false otherwise
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

    return this.settleOperation(
      'unregisterComponent',
      () => this.unregisterComponentOperation(name, options, progress),
      (error, reason) => ({
        success: false,
        componentName: name,
        reason,
        code: 'unknown_error',
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
    return this.components.some((c) => this.nameOf(c) === name);
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
    return this.components.map((c) => this.nameOf(c));
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
      .map((component) => this.getComponentStatus(this.nameOf(component)))
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
   * Get components currently in starting-timed-out state. Timed-out forced
   * starts retaining a stall are reported by the stalled APIs instead.
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

      // A cycle is the caller's configuration, answered by its code; anything else is
      // unplanned - dependency lists are read tolerantly here, so not a broken
      // `getDependencies()`, which fails only that component's own start - and is
      // reported on the global channel, as every other `unknown_error` is.
      if (code === 'unknown_error') {
        reportCallbackError('lifecycle-manager getStartupOrder', error);
      }

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

    // Each component read once, guarded: the reads run its own code, and one whose
    // `getDependencies()` or `isOptional()` threw made this - documented as not
    // throwing - throw to its caller. A component whose dependencies cannot be read is
    // reported, listed in `unreadableDependencies`, and makes the result invalid: its own
    // start fails on the same list, so "valid" would be a promise it cannot keep. An
    // `isOptional()` that throws does not: startup reads it as required and starts the
    // component normally, so validation answers the same.
    const unreadableDependencies: Array<{
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
      isOptional: this.isComponentOptional(component),
      // Reported once per registration, like every other read of it: the failure is in
      // the result already, and a caller polling this would flood the channel.
      read: this.readDependenciesReported(component, 'validateDependencies'),
    }));

    for (const component of this.components) {
      const name = this.nameOf(component);
      // Only missing for a registry that every read kept changing: nothing is known
      // about the component, which is no basis for "valid".
      const { isOptional, read } = reads.get(component) ?? {
        isOptional: false,
        read: {
          error: new Error(
            'The registry kept changing while dependencies were being validated',
          ),
        },
      };

      if (!('dependencies' in read) || read.invalidEntry !== undefined) {
        unreadableDependencies.push({
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

    // Find circular dependency cycles
    const circularCycles = findAllCircularCycles(adjacency);

    const isValid =
      missingDependencies.length === 0 &&
      circularCycles.length === 0 &&
      unreadableDependencies.length === 0;

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
      unreadableDependencies,
      summary: {
        totalMissingDependencies,
        requiredMissingDependencies,
        optionalMissingDependencies,
        totalCircularCycles: circularCycles.length,
        totalUnreadableDependencies: unreadableDependencies.length,
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
   * - On failure: attempts rollback; dependencies of unfinished or failed cleanup remain running
   * - Optional components don't trigger rollback on failure
   * - Dependents still attempt to start if an optional dependency fails
   * - Handles shutdown during startup (aborts; shutdown owns cleanup)
   */
  public startAllComponents(options?: StartupOptions): Promise<StartupResult> {
    return this.settleOperation(
      'startAllComponents',
      () => this.startAllComponentsOperation(options),
      (error, reason) => this.crashedStartupResult(error, reason),
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
   * The same refusal applies inside `lifecycle-manager:shutdown-completed` and
   * `shutdown-escalation-armed` listeners: they run while the pass still holds its
   * latch, and `getSystemState()` says `shutting-down` there too. To act on a result,
   * defer out of the listener (`setImmediate`, `queueMicrotask`) or `await` the promise
   * this method returned.
   *
   * @param options - Optional shutdown options
   */
  public stopAllComponents(options?: StopAllOptions): Promise<ShutdownResult> {
    return this.settleOperation(
      'stopAllComponents',
      () => this.stopAllComponentsOperation(options),
      (error, reason) => crashedShutdownResult(error, reason),
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

    return this.settleOperation(
      'restartAllComponents',
      () => this.restartAllComponentsOperation(options, phases),
      (error, reason) => ({
        shutdownResult:
          phases.shutdownResult ?? crashedShutdownResult(error, reason),
        startupResult: this.crashedStartupResult(error, reason),
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
      (error, reason) => crashedComponentResult(name, error, reason),
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
      (error, reason) => crashedComponentResult(name, error, reason),
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
      (error, reason) => crashedComponentResult(name, error, reason),
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
      this.isSignalDetachDeferred = false;

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
          // Settled like `triggerReload()` and friends, so a signal-driven broadcast
          // resolves under this manager's own label rather than relying on
          // `ProcessSignalManager` to catch its rejection.
          onReloadRequested: () =>
            this.settleOperation(
              'reload signal',
              () => this.handleReloadRequest('signal'),
              (error) => crashedSignalBroadcastResult('reload', error),
            ),
          onInfoRequested: () =>
            this.settleOperation(
              'info signal',
              () => this.handleInfoRequest('signal'),
              (error) => crashedSignalBroadcastResult('info', error),
            ),
          onDebugRequested: () =>
            this.settleOperation(
              'debug signal',
              () => this.handleDebugRequest('signal'),
              (error) => crashedSignalBroadcastResult('debug', error),
            ),
        });
      }

      this.processSignalManager.attach();
      this.lifecycleEvents.lifecycleManagerSignalsAttached();
    });
  }

  /**
   * Detach signal handlers.
   * Idempotent - calling multiple times has no effect.
   */
  public detachSignals(): void {
    return this.withTransition(() => {
      if (!this.processSignalManager?.getStatus().isAttached) {
        return; // Not attached
      }

      this.processSignalManager.detach();
      this.lifecycleEvents.lifecycleManagerSignalsDetached();
    });
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
        // Called from inside escalation handling - `onForceShutdown` calling
        // `logger.exit(1)`, the documented way to force - it is the force itself, so it
        // proceeds at once. Deferred like any other exit, it waited out the running pass
        // (its whole timeout, for the stall that prompted the force) or, from the armed
        // window, started and waited out a new one.
        if (this.forceHandlingDepth > 0) {
          if (this.isShuttingDown) {
            this.noteShutdownRequestDuringActivePass();
          }

          this.logger.info('Logger exit during forced shutdown, exiting now', {
            params: { exitCode },
          });

          return { action: 'proceed' as const };
        }

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

            return await new promiseConstructorIntrinsic<BeforeExitResult>(
              (resolve) => {
                this.pendingLoggerExitResolve = resolve;
              },
            );
          }

          this.logger.debug(LIFECYCLE_MANAGER_LOG_LOGGER_EXIT_DURING_SHUTDOWN, {
            params: { exitCode },
          });

          return { action: 'wait' as const };
        }

        if (isFirstExit) {
          this.logger.info('Logger exit triggered, stopping components...', {
            params: { exitCode, timeoutMS: this.shutdownOptions.timeoutMS },
          });

          // Stop all components with the manager's `shutdownOptions` defaults
          await this.stopAllComponents();
        }

        // Proceed with exit
        return { action: 'proceed' as const };
      },
    );

    this.logger.debug('Logger exit hook enabled', {
      params: { timeoutMS: this.shutdownOptions.timeoutMS },
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
      (error) => crashedSignalBroadcastResult('reload', error),
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
      (error) => crashedSignalBroadcastResult('info', error),
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
      (error) => crashedSignalBroadcastResult('debug', error),
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
      (error) => crashedHealthCheckResult(name, error),
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
    return this.getValueSettled<T>(componentName, key, null, options);
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
        return manager.components;
      },
      get componentStates() {
        return manager.componentStates;
      },
      get stalledComponents() {
        return manager.stalledComponents;
      },
      get runningComponents() {
        return manager.runningComponents;
      },
      get isStarting() {
        return manager.isStarting;
      },
      get messageTimeoutMS() {
        return manager.messageTimeoutMS;
      },
      get logger() {
        return manager.logger;
      },
      get lifecycleEvents() {
        return manager.lifecycleEvents;
      },
      nameOf: (component) => manager.nameOf(component),
      isComponentRunning: (name) => manager.isComponentRunning(name),
      isComponentUp: (name) => manager.isComponentUp(name),
      getComponent: (name) => manager.getComponent(name),
      sendMessageSettled: (name, payload, from, options) =>
        manager.sendMessageSettled(name, payload, from, options),
      checkComponentHealth: (name) => manager.checkComponentHealth(name),
      observeFailureAfterTimeout: (promise, name, message, params) =>
        manager.observeFailureAfterTimeout(promise, name, message, params),
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
   * failure comes back as `code: 'error'` with the original on `error`, and is reported
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
        componentRunning: this.runningComponents.has(componentName),
        handlerImplemented: false,
        requestedBy: from,
        code: 'error',
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
    return this.settleOperation(
      'sendMessageToComponent',
      () => this.sendMessageInternal(componentName, payload, from, options),
      (error) => ({
        sent: false,
        componentFound: this.isNameRegistered(componentName),
        componentRunning: this.runningComponents.has(componentName),
        handlerImplemented: false,
        data: undefined,
        error,
        timedOut: false,
        code: isOperationTimeoutValidationError(error)
          ? 'invalid_options'
          : 'error',
      }),
    );
  }

  /**
   * `broadcastMessageInternal()` under the public-method safety net, shared the same way
   * as {@link sendMessageSettled}. The broadcast loop keeps the answers it collected when
   * it crashes partway. Invalid timeout options refuse the whole broadcast with `[]`
   * before announcing it, with a warning rather than a callback-error report. Unexpected
   * failures before dispatch also answer `[]`, but remain reported on the global channel.
   */
  private broadcastMessageSettled(
    payload: unknown,
    from: string | null,
    options?: BroadcastOptions,
  ): Promise<BroadcastResult[]> {
    return this.settleOperation(
      'broadcastMessage',
      () => this.broadcastMessageInternal(payload, from, options),
      (error) => {
        // The array contract has no aggregate error field. Keep its refusal shape,
        // but make an invalid budget visible through the configured logger instead
        // of silently looking like an empty recipient list. This is not a callback
        // crash and must not enter the global callback-error channel.
        if (isOperationTimeoutValidationError(error)) {
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
  private createLifecycleInternalCallbacks(): LifecycleInternalCallbacks {
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
    };
  }

  /** Keep a running component's handler independent of bulk dependency snapshots. */
  private createUnexpectedStopHandler(
    name: string,
    token: string,
  ): (error?: Error) => boolean {
    return (error) => this.handleComponentUnexpectedStop(name, token, error);
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

    return this.settleOperation(
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

    // Default stopIfRunning to true (opt-out behavior)
    const shouldStopIfRunning = options?.stopIfRunning !== false;

    const inFlightRefusal = this.refuseUnregisterWhileInFlight(name, false);

    if (inFlightRefusal !== null) {
      return inFlightRefusal;
    }

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

      progress.wasStopped = true;

      // The stop's `await` let other code run. A `component:stopped` listener may have
      // unregistered this component already - and registered a replacement under the
      // same name - so nothing below may act on the name alone: it would remove the
      // replacement and wipe its state.
      if (this.getComponent(name) !== component) {
        return {
          success: false,
          componentName: name,
          reason: 'Component was unregistered while it was being stopped',
          code: 'component_not_found',
          wasStopped: true,
          // Registered when this call started, which is what this field reports - the
          // name may belong to a replacement by now, which is not this call's component.
          wasRegistered: true,
        };
      }

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

    // Last check before anything is removed, for both paths. `component` was captured
    // before `options?.stopIfRunning` was read, and that read runs caller code: a getter
    // that unregistered this component and registered a replacement under the same name
    // left the capture stale with no `await` anywhere to re-check it. The registry entry
    // below is removed by instance, but every state map is keyed by name, so a stale
    // instance wipes the replacement's state while leaving it registered - and reports
    // success for a removal it never made.
    if (this.getComponent(name) !== component) {
      return {
        success: false,
        componentName: name,
        reason:
          'Component was unregistered while this unregister was in progress',
        code: 'component_not_found',
        wasStopped: progress.wasStopped,
        // Registered when this call started, which is what this field reports - the
        // name may belong to a replacement by now, which is not this call's component.
        wasRegistered: true,
      };
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
      this.componentEntries = this.componentEntries.filter(
        (c) => c !== component,
      );

      this.publishRegistry();

      // Clean up state - the manager's own maps first, all of them, so the component is
      // either fully registered or fully gone. The component's hooks run after, contained:
      // they can be overridden, and one that threw used to leave the component out of the
      // registry but still in every state map.
      // A removed registration must not survive as deferred work in a restart
      // handoff. A later registration of the name decides its own auto-start policy.
      this.deferredAutoStartNames.delete(name);
      for (const pending of this.pendingRestartAutoStarts) {
        pending.delete(name);
      }
      this.componentStates.delete(name);
      this.componentTimestamps.delete(name);
      this.componentErrors.delete(name);
      this.componentUnexpectedStopHadError.delete(name);
      this.componentStartAttemptTokens.delete(name);
      this.componentStopAttemptTokens.delete(name);
      this.pendingForceStopWaiters.delete(name);
      // A later registration of the same instance reports a broken list afresh.
      this.componentMetadata.clearReports(component);
      this.stalledComponents.delete(name);
      this.runningComponents.delete(name);
      this.componentClaims.delete(name);
      this.releaseStartSettlements(name);
      // `registeredNames` keeps this entry: work still in flight - a broadcast that
      // captured the instance, a late-stop monitor - can still name it without asking the
      // component. A later registration of the same instance reads its name fresh and
      // overwrites the entry when it commits.
      this.updateStartedFlag();

      this.clearUnexpectedStopHandler(component, 'unregister');

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
    if (!this.isComponentInFlight(name)) {
      return null;
    }

    const isStarting = this.componentStates.get(name) === 'starting';
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
      this.isStarting ||
      this.isShuttingDown ||
      this.pendingBulkStartupCleanup.has(name)
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
          isStarting: this.isStarting,
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
    if (this.isStarting) {
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

    return undefined;
  }

  private async startAllComponentsOperation(
    options?: StartupOptions,
    restartSnapshots?: Map<string, RestartStartSnapshot>,
  ): Promise<StartupResult> {
    const startTime = Date.now();
    const alreadyActive = this.refuseActiveBulkStartup(startTime);
    if (alreadyActive) {
      return alreadyActive;
    }
    // Every option is read up front, before the startup takes its latch: `options` is
    // the caller's object, and a getter that threw once `isStarting` was set left it set
    // for good.
    const shouldIgnoreStalledComponents =
      options?.ignoreStalledComponents === true;
    const effectiveTimeout = resolveOperationTimeoutMS(
      options?.timeoutMS,
      this.startupTimeoutMS,
      'startAllComponents timeoutMS',
    );

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
    if (this.stalledComponents.size > 0 && !shouldIgnoreStalledComponents) {
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

    // A component still stopping is counted as running, but it is on its way down: the
    // shortcut below would report it "already running" - listing it as started though
    // its `start()` never ran - and a start of it now would only be refused. Refused
    // until the stop settles, as a partial state is.
    const stillStartingNames: string[] = [];
    const stillStoppingNames = this.getComponentNames().filter((name) => {
      const state = this.componentStates.get(name);
      if (state === 'starting') {
        stillStartingNames.push(name);
      }

      return state === 'stopping' || state === 'force-stopping';
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

    // All running - nothing to do
    if (runningCount === totalCount && totalCount > 0) {
      this.logger.info('All components already running');
      // The sink can begin teardown or change registrations. Decide from the same
      // post-log snapshot we return, rather than the count captured before it ran.
      const startedComponents = this.runningStartupSnapshot();
      const isStillAllRunning =
        this.components.length > 0 &&
        startedComponents.length === this.components.length &&
        !this.isShuttingDown &&
        !this.isStarting;
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
        durationMS: Date.now() - startTime,
      };
    }

    // Partial state - reject to avoid inconsistent startup
    if (runningCount > 0) {
      const wasStarting = this.isStarting;
      const wasShuttingDown = this.isShuttingDown;
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
      const registeredCount = this.components.length;
      const didChangeDuringLog =
        startedComponents.length !== runningCount ||
        registeredCount !== totalCount ||
        this.isStarting !== wasStarting ||
        this.isShuttingDown !== wasShuttingDown;
      let reason = `${runningCount} of ${totalCount} components already running`;
      if (didChangeDuringLog) {
        reason =
          `Startup refused because ${runningCount} of ${totalCount} components were already running. ` +
          `Currently ${startedComponents.length} of ${registeredCount} components are running.`;
        if (this.isShuttingDown) {
          reason += ' A shutdown is now in progress.';
        }
        if (this.isStarting) {
          reason += ' A startup is now in progress.';
        }
      }
      return {
        success: false,
        startedComponents,
        failedOptionalComponents: [],
        skippedDueToDependency: [],
        reason,
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
    // The startup that actually takes the latch owns the current registry, even if
    // a listener started it before the original restart resumed. Transfer every
    // pending handoff before signal attachment can run caller code, and empty each
    // token so an older restart finalizer cannot warn for work already claimed.
    for (const names of this.pendingRestartAutoStarts) {
      for (const name of names) {
        if (this.getComponent(name) !== undefined) {
          this.deferredAutoStartNames.add(name);
        }
      }
      names.clear();
    }
    this.pendingRestartAutoStarts.clear();
    this.autoAttachedSignalsDuringStartup = false;

    // This startup's baseline for every "did a shutdown start meanwhile" check below,
    // including the one right after the attach.
    const shutdownTokenAtBulkStart = this.shutdownToken;
    const hasShutdownBegun = (): boolean =>
      this.isShuttingDown || this.shutdownToken !== shutdownTokenAtBulkStart;

    // Tracked so failure cleanup does not detach handlers that were attached earlier by
    // some other path.
    const bulkSignalAttach = this.attachSignalsBeforeStartup
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
    this.unexpectedStopsDuringStartup.clear();
    this.resetRepeatedShutdownRequestState();
    this.shutdownMethod = null; // Clear previous shutdown method on fresh start
    this.lastShutdownResult = null; // Clear last shutdown result on fresh start

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
      this.activeBulkStartup = bulkStartup;

      // The answer for a startup a shutdown cut short, wherever it notices: what is still
      // running of what it started, and what it had already given up on. Shutdown
      // retains running-set membership while stop hooks settle; that teardown is
      // no longer available and must not be reported as a successful startup.
      const abortedByShutdown = (
        reason = 'Shutdown triggered during startup',
        error?: Error,
      ): StartupResult => {
        abandonReason = 'was interrupted by shutdown';
        detachReason = 'interrupted bulk startup';
        return {
          success: false,
          startedComponents: this.runningStartupSnapshot(startedComponents),
          failedOptionalComponents,
          skippedDueToDependency: Array.from(skippedDueToDependency),
          reason,
          code: 'shutdown_in_progress',
          ...(error === undefined ? {} : { error }),
          durationMS: Date.now() - startTime,
        };
      };

      const unexpectedStopFailure = (error: Error): StartupResult => {
        // Rollback preparation and stop hooks also run caller code. A shutdown
        // accepted while awaiting rollback owns the resulting teardown snapshot.
        if (hasShutdownBegun()) {
          return abortedByShutdown();
        }
        return {
          success: false,
          startedComponents: this.stillRunning(startedComponents),
          failedOptionalComponents,
          skippedDueToDependency: Array.from(skippedDueToDependency),
          reason: describeError(error),
          code: 'component_unexpected_stop',
          error,
          durationMS: Date.now() - startTime,
        };
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
        const reconciled = this.consumeUnexpectedStopsDuringStartup(
          startedComponents,
          failedOptionalComponents,
        );
        startedComponents.splice(0, startedComponents.length);
        startedComponents.push(...reconciled.startedComponents);

        // Optionality getters and log sinks can start shutdown. It owns teardown
        // from that point, before any required-stop rollback decision is made.
        if (hasShutdownBegun()) {
          this.logger.warn('Shutdown signal received during startup, aborting');
          return { kind: 'result', value: abortedByShutdown() };
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
        const frozenAutoStarts = new Set<string>();

        try {
          // Every component's list, including those of components the reads themselves
          // register: those are ordered with the rest - their auto-starts deferred to
          // this loop while `isOrdering` holds - rather than left out, or started ahead
          // of dependencies this loop had not started yet. Any read can begin a
          // shutdown; the lists left are then not read under it - their components may
          // be tearing down - and the startup is over, without going on to clear the
          // deferred auto-starts as if it would start them.
          const registryRead = this.readRegistry(
            (component) => this.readDependenciesReported(component, 'startup'),
            startupReads,
            () => !hasShutdownBegun(),
          );

          if (hasShutdownBegun()) {
            this.logger.warn(
              'Shutdown signal received during startup, aborting',
            );

            return abortedByShutdown();
          }

          if (!registryRead.isSettled) {
            throw new Error(
              'The registry kept changing while the startup order was being read',
            );
          }

          startupOrder = this.getStartupOrderInternal(
            this.components,
            undefined,
            startupReads,
          );
          bulkStartup.isOrdering = false;
          // Freeze deferred registrations included in the initial order too. Their
          // start is now this loop's responsibility, but it may leave before them.
          for (const name of this.deferredAutoStartNames) {
            frozenAutoStarts.add(name);
          }
          this.deferredAutoStartNames.clear();
        } catch (error) {
          const err = toError(error);
          const code =
            err instanceof DependencyCycleError
              ? 'dependency_cycle'
              : 'unknown_error';

          // Reported for the reason `getStartupOrder()` reports it.
          if (code === 'unknown_error') {
            reportCallbackError('lifecycle-manager startAllComponents', error);
          }

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
            while (this.deferredAutoStartNames.size > 0) {
              if (!canContinueOrdering()) {
                return;
              }
              const registryRead = this.readRegistry(
                (component) =>
                  this.readDependenciesReported(component, 'startup'),
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
                this.components,
                undefined,
                startupReads,
              ).filter((name) => this.deferredAutoStartNames.has(name));
              if (batch.length === 0) {
                throw new Error(
                  'Deferred auto-starts were absent from the follow-up startup order',
                );
              }
              // Freeze the whole batch, including members not yet attempted: later
              // registrations cannot supply a missing dependency to this fixed order.
              for (const name of batch) {
                this.deferredAutoStartNames.delete(name);
                frozenAutoStarts.add(name);
              }
              yield* batch;
            }
          } finally {
            // The iterator has ended, so these names can no longer participate in
            // registration checks for this batch. Release reports them with any
            // later batch that was queued but never frozen.
            for (const name of frozenAutoStarts) {
              this.deferredAutoStartNames.add(name);
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

            const component = this.getComponent(name);
            if (!component) {
              // Should not happen since unregisterComponent() is blocked during startup.
              // Thrown into the crash path, as a component never read is below: skipped,
              // it was in no result list, and the startup could still report success.
              throw new Error(
                `Component "${name}" is in the startup order but not registered`,
              );
            }

            // Skip stalled components during bulk startup (even with ignoreStalledComponents:true bulk option)
            if (this.stalledComponents.has(name)) {
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
              if (skippedDueToStall.has(depName)) {
                shouldSkip = true;
                skipReason = `Dependency "${depName}" is stalled`;
                break;
              }

              const depComponent = this.getComponent(depName);
              // Read only where it decides something - a dependency that was skipped or
              // failed - and guarded: a healthy dependency's `isOptional()` that threw used
              // to crash, and roll back, the whole startup.
              const isDependencyOptional = (): boolean =>
                depComponent !== undefined &&
                this.isComponentOptional(depComponent);

              if (skippedDueToDependency.has(depName)) {
                if (!isDependencyOptional()) {
                  shouldSkip = true;
                  skipReason = `Dependency "${depName}" was skipped`;
                  break;
                }
                continue;
              }

              if (depComponent) {
                const depState = this.componentStates.get(depName);
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
              this.logger.warn(
                'Shutdown signal received during startup, aborting',
              );

              return abortedByShutdown();
            }

            // Start the component (allow during bulk startup since we ARE the bulk operation)
            frozenAutoStarts.delete(name);
            const result = await this.startComponentInternal(
              name,
              {
                allowDuringBulkStartup: true,
              },
              // Every follow-up batch shares the original deadline.
              deadlineContext,
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
            if (hasTimedOut && result.code === 'component_startup_timeout') {
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
              return {
                success: false,
                startedComponents:
                  this.runningStartupSnapshot(startedComponents),
                failedOptionalComponents,
                skippedDueToDependency: Array.from(skippedDueToDependency),
                code: 'partial_state',
                reason: isLateTimeoutCleanup
                  ? `Component "${name}": ${LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP}`
                  : `Component "${name}" has an independent ${operation} in progress`,
                durationMS: Date.now() - startTime,
              };
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
              this.unexpectedStopsDuringStartup.delete(name);

              const error =
                result.error ||
                new Error(
                  result.reason || `Component "${name}" stopped unexpectedly`,
                );

              if (this.isComponentOptional(component)) {
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
                await rollBackOnce(startedComponents);
                if (hasShutdownBegun()) {
                  return abortedByShutdown();
                }

                return {
                  success: false,
                  startedComponents: this.stillRunning(startedComponents),
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
              await rollBackOnce(
                this.runningComponents.has(name)
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
                // Whatever the rollback could not stop, so the result matches the registry.
                startedComponents: [...startedComponents, name].filter(
                  (startedName) => this.runningComponents.has(startedName),
                ),
                failedOptionalComponents,
                skippedDueToDependency: Array.from(skippedDueToDependency),
                error: result.error,
              };
            } else {
              // Check if component is optional
              if (this.isComponentOptional(component)) {
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

                // Mark as failed state - unless stopping it again after a crash already
                // left it stalled, which `stalledComponents` still says and the state
                // must agree with. Nor over a component something else still owns: a
                // start refused as `component_already_starting` because a late-startup
                // cleanup is stopping it, say. Overwritten, its `stopping` guard was
                // gone - a `stopComponent()` ran `stop()` again alongside the cleanup's.
                const isOwnedElsewhere =
                  this.runningComponents.has(name) ||
                  this.isComponentInFlight(name);

                if (!this.stalledComponents.has(name) && !isOwnedElsewhere) {
                  this.componentStates.set(name, 'failed');

                  if (result.error) {
                    this.componentErrors.set(name, result.error);
                  }
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
                await rollBackOnce(startedComponents);
                if (hasShutdownBegun()) {
                  return abortedByShutdown();
                }

                return {
                  success: false,
                  startedComponents: this.stillRunning(startedComponents),
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
              this.logger.warn(
                'Shutdown signal received during startup, aborting',
              );
              return abortedByShutdown();
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
          this.deferredAutoStartNames.size > 0 &&
          !hasTimedOut &&
          !hasShutdownBegun()
        );

        // The loop checks for a shutdown after each start, but the events it emits for
        // the last component - `start-failed-optional`, `start-skipped` - come after that
        // check, and a listener there can start one. Reporting success and emitting
        // `started` would then describe a startup that a shutdown is already undoing.
        if (hasShutdownBegun()) {
          this.logger.warn('Shutdown signal received during startup, aborting');

          return abortedByShutdown();
        }

        // Check if startup timed out during the process
        if (hasTimedOut) {
          const durationMS = Date.now() - startTime;

          return {
            success: false,
            startedComponents: this.runningStartupSnapshot(startedComponents),
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

        detachReason = 'completed bulk startup';
        return {
          success: true,
          startedComponents: this.runningStartupSnapshot(startedComponents),
          failedOptionalComponents,
          skippedDueToDependency: Array.from(skippedDueToDependency),
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
            return abortedByShutdown();
          }
        } catch (rollbackError) {
          reportCallbackError(
            'lifecycle-manager startup rollback',
            rollbackError,
          );
        }

        return {
          ...this.crashedStartupResult(
            crashError,
            `startAllComponents() failed unexpectedly: ${describeError(crashError)}`,
            Date.now() - startTime,
          ),
          ...(isDependencyCycle
            ? {
                code: 'dependency_cycle' as const,
                reason: describeError(crashError),
              }
            : {}),
          // Whatever the rollback could not stop, so the result matches the registry.
          startedComponents: this.stillRunning(startedComponents),
          failedOptionalComponents,
          skippedDueToDependency: Array.from(skippedDueToDependency),
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
        input.didAutoAttachSignals || this.autoAttachedSignalsDuringStartup;
      const abandonedAutoStarts = Array.from(this.deferredAutoStartNames);

      // `isStarting` first of all: the detach below defers while it is set.
      this.isStarting = false;
      this.autoAttachedSignalsDuringStartup = false;
      this.activeBulkStartup = null;
      this.deferredAutoStartNames.clear();
      this.unexpectedStopsDuringStartup.clear();

      if (shouldDetach) {
        this.detachSignalsIfIdle(input.detachReason);
      } else {
        this.runDeferredSignalDetach('bulk startup');
      }

      // Not while a startup started from the detach is running: it reads the whole
      // registry, so these are in its order, and it is the one that starts them.
      this.eventDispatcher.afterNotifications(() => {
        if (!this.isStarting) {
          this.warnAbandonedAutoStarts(
            abandonedAutoStarts,
            input.abandonReason,
          );
        }
      });
    });
  }

  private async stopAllComponentsOperation(
    options?: StopAllOptions,
  ): Promise<ShutdownResult> {
    // Always the manual method for the public API, as it is not from a signal. A direct
    // stop call made while a shutdown is running expresses the same intent a signal
    // does, so a refusal is recorded on the running pass.
    const acceptance = this.acceptShutdownPass('manual', options, true);

    return acceptance.accepted ? await acceptance.promise : acceptance.result;
  }

  /** A refused restart owns no stop pass and cannot cancel the active one. */
  private refuseRestartDuringActiveShutdown(): RestartResult | undefined {
    if (!this.isShuttingDown) {
      return undefined;
    }

    const result: RestartResult = {
      shutdownResult: refusedShutdownResult(),
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

  private async restartAllComponentsOperation(
    options: RestartAllOptions | undefined,
    phases: { shutdownResult?: ShutdownResult },
  ): Promise<RestartResult> {
    // A restart arriving during somebody else's shutdown has no stop pass to own.
    // Refuse it before reading options or component getters, without recording a
    // request to stay down against the running pass. Keep the checks after individual
    // caller reads explicit below: each is a re-entry boundary, and a shutdown begun
    // there must prevent both validation and the next getter from running.
    const alreadyShuttingDown = this.refuseRestartDuringActiveShutdown();
    if (alreadyShuttingDown) {
      return alreadyShuttingDown;
    }

    // Validate and snapshot both phases before stopping anything. Discovering an
    // invalid startup budget only after shutdown would leave a healthy application
    // down for a configuration typo. The snapshot also prevents a caller getter or
    // mutation during stop from swapping the value after validation.
    const requestedStartupOptions = options?.startupOptions;
    const afterStartupOptionsRead = this.refuseRestartDuringActiveShutdown();
    if (afterStartupOptionsRead) {
      return afterStartupOptionsRead;
    }
    const requestedStartupTimeoutMS = requestedStartupOptions?.timeoutMS;
    const afterStartupTimeoutRead = this.refuseRestartDuringActiveShutdown();
    if (afterStartupTimeoutRead) {
      return afterStartupTimeoutRead;
    }
    const startupTimeoutMS = resolveOperationTimeoutMS(
      requestedStartupTimeoutMS,
      this.startupTimeoutMS,
      'restartAllComponents startupOptions.timeoutMS',
    );
    const shouldIgnoreStalledComponents =
      requestedStartupOptions?.ignoreStalledComponents === true;
    const afterIgnoreStalledRead = this.refuseRestartDuringActiveShutdown();
    if (afterIgnoreStalledRead) {
      return afterIgnoreStalledRead;
    }
    const startupOptions: StartupOptions = {
      timeoutMS: startupTimeoutMS,
      ignoreStalledComponents: shouldIgnoreStalledComponents,
    };
    const requestedShutdownTimeoutMS = options?.shutdownTimeoutMS;
    const afterShutdownTimeoutRead = this.refuseRestartDuringActiveShutdown();
    if (afterShutdownTimeoutRead) {
      return afterShutdownTimeoutRead;
    }
    const shutdownTimeoutMS = resolveOperationTimeoutMS(
      requestedShutdownTimeoutMS,
      this.shutdownOptions.timeoutMS,
      'restartAllComponents shutdownTimeoutMS',
    );

    // A restart must discover an invalid component timeout while the existing
    // application is still running. Hold both the value and its registration:
    // shutdown hooks can mutate the property or replace an instance before startup.
    const restartSnapshots = new Map<string, RestartStartSnapshot>();
    for (const component of [...this.components]) {
      const name = this.nameOf(component);
      const generation = this.registrationReads.currentGeneration(component);
      const requestedComponentTimeoutMS = component.startupTimeoutMS;
      const afterComponentTimeoutRead =
        this.refuseRestartDuringActiveShutdown();
      if (afterComponentTimeoutRead) {
        return afterComponentTimeoutRead;
      }
      restartSnapshots.set(name, {
        component,
        generation,
        timeoutMS: toOperationTimerDelayMS(
          requestedComponentTimeoutMS,
          `${name}.startupTimeoutMS`,
        ),
      });
    }
    const changedSnapshotName = (): string | undefined => {
      // No caller code runs during this check. Capture membership once so checking
      // every snapshot does not repeatedly scan the full registry.
      const currentComponents = new Set(this.components);
      for (const [name, snapshot] of restartSnapshots) {
        if (!this.isCurrentRestartSnapshot(name, snapshot, currentComponents)) {
          return name;
        }
      }
      // A timeout getter or logger callback can also register a new component.
      // It has no approved startup timeout, so it cannot join this restart.
      for (const component of this.components) {
        const name = this.nameOf(component);
        if (!restartSnapshots.has(name)) {
          return name;
        }
      }
      return undefined;
    };

    this.logger.info('Restarting all components');
    // Sinks are caller code too. A shutdown begun by this log owns both the
    // registry and shutdown pass; refuse before attempting either restart phase.
    const afterInfoLog = this.refuseRestartDuringActiveShutdown();
    if (afterInfoLog) {
      return afterInfoLog;
    }
    const changedBeforeStop = changedSnapshotName();
    if (changedBeforeStop !== undefined) {
      const reason = `Component "${changedBeforeStop}" changed while restart was being prepared`;
      // The info log above can itself change registration through a sink. Keep the
      // check after it, and report this refusal without announcing a shutdown pass.
      this.logger.warn('Restart refused before shutdown: {{reason}}', {
        params: { reason },
      });
      return {
        shutdownResult: {
          success: false,
          stoppedComponents: [],
          stalledComponents: [],
          durationMS: 0,
          reason,
          code: 'partial_state',
        },
        startupResult: refusedStartupResult('partial_state', reason),
        success: false,
      };
    }

    const pendingAutoStarts = new Set<string>();
    try {
      // Phase 1: Stop all components (explicit defaults for restart semantics)
      const stopPhase = this.acceptShutdownPass(
        'manual',
        {
          timeoutMS: shutdownTimeoutMS,
          // Always retry/halt during restart for deterministic shutdown behavior.
          retryStalled: true,
          haltOnStall: true,
          // Restart cannot safely bring up replacements while old starts remain.
          // Keep their dependencies protected even if shutdown hooks opt out.
          allowStopWithPendingStarts: false,
        },
        // Not a request to stay down: see `acceptShutdownPass()`.
        false,
        pendingAutoStarts,
      );

      const stayDownPassCountAtStopPhase = this.stayDownPassCount;

      // A refused stop phase is somebody else's pass: this restart has nothing of its own
      // for a request to cancel, so it behaves exactly as it did before cancellation
      // existed.
      const shutdownResult = stopPhase.accepted
        ? await stopPhase.promise
        : stopPhase.result;

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
        stopPhase.accepted &&
        (stopPhase.pass.shutdownRequested ||
          this.stayDownPassCount !== stayDownPassCountAtStopPhase);

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
      if (
        shutdownResult.timedOut ||
        shutdownResult.code === 'shutdown_timeout' ||
        shutdownResult.code === 'cleanup_incomplete'
      ) {
        return {
          shutdownResult,
          startupResult: refusedStartupResult(
            'partial_state',
            shutdownResult.code === 'cleanup_incomplete'
              ? 'Restart cleanup is incomplete; startup skipped'
              : 'Restart shutdown timed out; startup skipped',
          ),
          success: false,
        };
      }

      // A crashed stop or invalid stop configuration cannot confirm cleanup. Do not
      // initiate startup on top of components that this restart could not stop.
      if (
        shutdownResult.code === 'unknown_error' ||
        shutdownResult.code === 'invalid_options'
      ) {
        this.logger.warn('Restart abandoned: the shutdown phase failed', {
          params: { reason: shutdownResult.reason },
        });

        return {
          shutdownResult,
          startupResult: this.crashedStartupResult(
            shutdownResult.error,
            'Startup skipped: the restart shutdown phase failed unexpectedly',
          ),
          success: false,
        };
      }

      // A deferred shutdown listener can remove or replace a component after the
      // pass releases its latch. The startup still serves the current registry;
      // only the exact registrations approved before stop keep their timeout snapshots.
      // New and replaced registrations use ordinary startup validation. They did not
      // exist at preflight: invalid settings can fail this startup after shutdown,
      // and restart cannot restore the old registry or running application atomically.
      const currentComponents = new Set(this.components);
      for (const [name, snapshot] of restartSnapshots) {
        if (!this.isCurrentRestartSnapshot(name, snapshot, currentComponents)) {
          restartSnapshots.delete(name);
        }
      }
      const startupResult = await this.settleOperation(
        'startAllComponents',
        () =>
          this.startAllComponentsOperation(startupOptions, restartSnapshots),
        (error, reason) => this.crashedStartupResult(error, reason),
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
      this.pendingRestartAutoStarts.delete(pendingAutoStarts);
      const abandoned = Array.from(pendingAutoStarts);
      pendingAutoStarts.clear();
      this.warnAbandonedAutoStarts(
        abandoned,
        'restart abandoned before startup',
      );
    }
  }

  /** Snapshot the refusal before a guarded logger can re-enter either operation. */
  private checkIndividualBulkPreconditions(
    name: string,
    operation: 'stop' | 'restart',
  ): ComponentOperationResult | undefined {
    const isStarting = this.isStarting;
    const isShuttingDown = this.isShuttingDown;
    if (!isStarting && !isShuttingDown) {
      return undefined;
    }
    const result: ComponentOperationResult = {
      success: false,
      componentName: name,
      reason: isStarting
        ? LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS
        : LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
      code: isStarting ? 'startup_in_progress' : 'shutdown_in_progress',
    };
    let message: string;
    let params: Record<string, boolean>;
    if (operation === 'restart') {
      message = 'Cannot restart component during bulk operation';
      params = { isStarting, isShuttingDown };
    } else if (isStarting) {
      message = 'Cannot stop component during bulk startup';
      params = { isStarting };
    } else {
      message = 'Cannot stop component during shutdown';
      params = { isShuttingDown };
    }
    this.logger.entity(name).warn(message, { params });
    return result;
  }

  private async stopComponentOperation(
    name: string,
    options?: StopComponentOptions,
    stopContext: IndividualStopContext = { operation: 'stop', claimed: false },
  ): Promise<ComponentOperationResult> {
    const bulkRefusal = this.checkIndividualBulkPreconditions(
      name,
      stopContext.operation,
    );
    if (bulkRefusal) {
      return bulkRefusal;
    }

    // Check for running dependents unless allowStopWithRunningDependents option is true
    const allowStopWithRunningDependents =
      options?.allowStopWithRunningDependents;
    const afterOptionsRefusal = this.checkIndividualBulkPreconditions(
      name,
      stopContext.operation,
    );
    if (afterOptionsRefusal) {
      return afterOptionsRefusal;
    }
    stopContext.allowStopWithRunningDependents = allowStopWithRunningDependents;
    const dependentRefusal = this.checkIndividualStopDependents(
      name,
      stopContext,
    );
    if (dependentRefusal) {
      return dependentRefusal;
    }

    return await this.stopComponentInternal(name, options, stopContext);
  }

  /**
   * Prepared hook and timeout getters can start a dependent before this stop owns
   * its component. Include start claims as well as running membership: a dependent
   * awaiting start() already relies on this component, even before it is published
   * as running. Keep the caller's override in the call-local context so checking
   * again does not re-read an option getter. Dependency reads are caller code too,
   * so the phase must still check bulk and component ownership after this helper.
   */
  private checkIndividualStopDependents(
    name: string,
    context: IndividualStopContext,
  ): ComponentOperationResult | undefined {
    if (context.allowStopWithRunningDependents) {
      return undefined;
    }
    // Re-read at each claim boundary: dependency getters can change their answers
    // without a registration-generation change, so prior reads cannot be reused.
    // A dependency getter can also register a new dependent. Use the settled
    // registry read rather than an array captured before those getters ran. If
    // caller code keeps changing registrations beyond the bounded read, an unread
    // active component is not evidence that stopping its dependency is safe.
    const readActiveWork = (): Map<
      BaseComponent,
      'running' | 'starting' | 'pending'
    > => {
      const current = new Map(
        this.components.map((component) => [this.nameOf(component), component]),
      );
      const pending = new Set<BaseComponent>();
      for (const settlement of this.startSettlements.values()) {
        if (
          isStartUnfinished(settlement) &&
          settlement.component !== undefined &&
          settlement.component === current.get(settlement.name) &&
          settlement.token ===
            this.componentStartAttemptTokens.get(settlement.name)
        ) {
          pending.add(settlement.component);
        }
      }
      const activity = new Map<
        BaseComponent,
        'running' | 'starting' | 'pending'
      >();
      for (const [dependent, component] of current) {
        if (this.isComponentRunning(dependent)) {
          activity.set(component, 'running');
        } else if (this.componentStates.get(dependent) === 'starting') {
          activity.set(component, 'starting');
        } else if (pending.has(component)) {
          activity.set(component, 'pending');
        }
      }
      return activity;
    };
    const { reads } = this.readRegistry(
      (component) => this.readDependencies(component, 'dependents'),
      undefined,
      undefined,
      undefined,
      // Refresh each round: a dependency getter can start an idle component.
      () => [...readActiveWork().keys()],
    );
    const activeWork = readActiveWork();
    const dependents = this.components.filter(
      (component) =>
        activeWork.has(component) &&
        (!this.isReadCurrent(reads, component) ||
          reads.get(component)?.includes(name) === true),
    );
    if (dependents.length === 0) {
      return undefined;
    }
    const runningDependents: string[] = [];
    const startingDependents: string[] = [];
    const pendingStartupDependents: string[] = [];
    for (const component of dependents) {
      const dependent = this.nameOf(component);
      if (activeWork.get(component) === 'running') {
        runningDependents.push(dependent);
      } else if (activeWork.get(component) === 'starting') {
        startingDependents.push(dependent);
      } else {
        pendingStartupDependents.push(dependent);
      }
    }
    const activity = [
      runningDependents.length
        ? `running dependents: ${runningDependents.join(', ')}`
        : undefined,
      startingDependents.length
        ? `starting dependents: ${startingDependents.join(', ')}`
        : undefined,
      pendingStartupDependents.length
        ? `dependents with pending startup work: ${pendingStartupDependents.join(', ')}`
        : undefined,
    ]
      .filter(Boolean)
      .join('; ');
    const result: ComponentOperationResult = {
      success: false,
      componentName: name,
      reason: `Component has ${activity}. Use { allowStopWithRunningDependents: true } option to bypass.`,
      code: 'has_running_dependents',
    };
    this.logger
      .entity(name)
      .warn('Cannot stop component with active dependents', {
        params: {
          runningDependents,
          startingDependents,
          pendingStartupDependents,
        },
      });
    return result;
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

  private async restartComponentOperation(
    name: string,
    options?: RestartComponentOptions,
  ): Promise<ComponentOperationResult> {
    const bulkRefusal = this.checkIndividualBulkPreconditions(name, 'restart');
    if (bulkRefusal) {
      return bulkRefusal;
    }

    // Snapshot start options and the timeout before tearing down a healthy component. The
    // property may be a getter, and the stop can await arbitrary component code;
    // a second read after that await need not describe the same configuration.
    const stopOptions = options?.stopOptions;
    const startOptions = this.snapshotStartOptions(options?.startOptions);
    const afterOptionsRefusal = this.checkIndividualBulkPreconditions(
      name,
      'restart',
    );
    if (afterOptionsRefusal) {
      return afterOptionsRefusal;
    }
    const preconditions = this.checkStopPreconditions(name);
    if ('success' in preconditions) {
      return preconditions;
    }
    const { component } = preconditions;
    const startSnapshot: RestartStartSnapshot = {
      component,
      generation: this.registrationReads.currentGeneration(component),
      timeoutMS: toOperationTimerDelayMS(
        component.startupTimeoutMS,
        `${name}.startupTimeoutMS`,
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
      this.isComponentInFlight(name)
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
      const preconditions = this.checkStopPreconditions(
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

    // Track this call's claim, rather than comparing the name's shared stop token:
    // an option getter can start a nested stop and then fail before this one claims.
    const stopContext: IndividualStopContext = {
      operation: 'restart',
      claimed: false,
    };
    const stopResult = await this.settleOperation(
      'stopComponent',
      () => this.stopComponentOperation(name, stopOptions, stopContext),
      (error, reason) => crashedComponentResult(name, error, reason),
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
      return {
        success: false,
        componentName: name,
        reason: 'Component changed while restart was stopping it',
        code: 'restart_start_failed',
      };
    }

    const startResult = await this.settleOperation(
      'startComponent',
      () =>
        this.startComponentInternal(
          name,
          startOptions,
          undefined,
          undefined,
          undefined,
          startSnapshot,
        ),
      (error, reason) => crashedComponentResult(name, error, reason),
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

  private checkComponentHealthOperation(
    name: string,
  ): Promise<HealthCheckResult> {
    return checkComponentHealthOperation(this.componentAccess, name);
  }

  private checkAllHealthOperation(): Promise<HealthReport> {
    return checkAllHealthOperation(this.componentAccess);
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
    targetComponentName: string | undefined,
    isInsertAction: boolean,
    _options: RegisterOptions | undefined,
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
    // `getName()`: with `unknown_error`.
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
        shouldAutoStart = _options?.autoStart === true;
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
        this.readDependenciesReported(registered, 'registration');
      let registryRead = {
        reads: new Map<BaseComponent, DependencyRead>(),
        isSettled: true,
      };

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
          () => this.componentEntries,
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
        ...this.componentEntries.slice(0, insertIndex),
        component,
        ...this.componentEntries.slice(insertIndex),
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
      const previousRecordedName = this.registeredNames.get(component);
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
        this.rollbackReservations.set(component, componentName);
        this.componentEntries = this.componentEntries.filter(
          (registered) => registered !== component,
        );
        // Rolled back, so this registration did not commit after all.
        progress.hasCommitted = false;
        this.registrationReads.restoreRegistration(
          component,
          previousGeneration,
        );

        this.componentStates.delete(componentName);
        this.componentTimestamps.delete(componentName);
        this.componentErrors.delete(componentName);
        this.componentStartAttemptTokens.delete(componentName);

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
          this.registeredNames.delete(component);
        } else {
          this.registeredNames.set(component, previousRecordedName);
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
          this.pendingRegistrations.add(component);
          this.componentEntries = nextComponents;
          this.registrationReads.advanceRegistration(component);
          this.registeredNames.set(component, componentName);

          const internalCallbacks = this.createLifecycleInternalCallbacks();

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
          progress.wasDuringStartup = this.isStarting;
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
          this.componentStates.set(componentName, 'registered');
          this.componentTimestamps.set(componentName, {
            startedAt: null,
            stoppedAt: null,
          });
          this.componentErrors.set(componentName, null);
          this.componentUnexpectedStopHadError.delete(componentName);
          this.componentStartAttemptTokens.set(componentName, ulid());
          progress.hasCommitted = true;
          this.committedDependencyReads.set(component, candidateRead);
        } catch (error) {
          rollBack();
          throw error;
        } finally {
          this.pendingRegistrations.delete(component);
          this.rollbackReservations.delete(component);
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
              for (const entry of this.components) {
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
                    this.components,
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
            committed.targetFound = positionHasTarget(position)
              ? this.getComponentIndex(targetComponentName ?? '') !== null
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

      const registrationIndexAfter = this.components.indexOf(component);

      if (isInsertAction) {
        this.logger.entity(componentName).info('Component inserted', {
          params: { position, index: registrationIndexAfter },
        });
      } else {
        this.logger.entity(componentName).info('Component registered', {
          params: { index: registrationIndexAfter },
        });
      }

      if (shouldAutoStart) {
        // Capture this pass before logging runs caller code. Its queue/rollback state
        // decides whether registration defers, refuses auto-start, or starts work
        // independently after the completion boundary.
        const bulkStartup = this.activeBulkStartup;

        // Bulk startup first: `isStarted` turns true as soon as its first component is
        // running, and a start without `allowDuringBulkStartup` is refused with
        // `startup_in_progress` for the rest of it.
        const pendingRestart = Array.from(this.pendingRestartAutoStarts).at(-1);
        if (!this.isStarting && pendingRestart !== undefined) {
          // The restart has released shutdown's latch but has not claimed startup's
          // yet. Its upcoming order includes this registration. Reserve before logs,
          // since sinks can synchronously take the startup latch and claim the set.
          pendingRestart.add(componentName);
          progress.isAutoStartDeferred = true;
          this.logger
            .entity(componentName)
            .info('AutoStart: left to the restart startup about to run');
        } else if (this.isStarting && bulkStartup?.isRollingBack) {
          progress.didAutoStartAttempt = true;
          progress.startResult = {
            success: false,
            componentName,
            reason:
              'The bulk startup this auto-start would join is rolling back',
            code: 'startup_rolled_back',
            status: this.getComponentStatus(componentName),
          };
        } else if (this.isStarting && !bulkStartup?.isCompleting) {
          // Reserve before logging: a sink can synchronously register more components.
          // The initial order or a follow-up batch owns this start and its outcome.
          progress.isAutoStartDeferred = true;
          this.deferredAutoStartNames.add(componentName);
          this.logger
            .entity(componentName)
            .info('AutoStart: left to the bulk startup about to run');
        } else if (this.isStarting && bulkStartup !== null) {
          // The pass has closed its queue before terminal notifications. A start from
          // those callbacks is independent, while the public bulk latch stays held.
          this.logger
            .entity(componentName)
            .info('AutoStart: starting component (bulk startup completing)');
          progress.didAutoStartAttempt = true;
          progress.startResult = await this.startComponentInternal(
            componentName,
            {
              // Logging runs caller code. Only the captured completion still owns
              // this permission; a replacement pass must retain its own bulk guard.
              allowDuringBulkStartup:
                this.activeBulkStartup === bulkStartup &&
                bulkStartup.isCompleting &&
                !bulkStartup.isRollingBack,
            },
          );
        } else {
          this.logger
            .entity(componentName)
            .info(
              this.isStarted
                ? 'AutoStart: starting component (manager is running)'
                : 'AutoStart: starting component (manager not running)',
            );
          progress.didAutoStartAttempt = true;
          progress.startResult =
            await this.startComponentInternal(componentName);
        }
      }

      // Where it is now, not where it landed: an auto-start can register or remove
      // components around it. By instance, as the failure path reads it: one unregistered
      // and replaced under its name by a listener must not be described as the other.
      const indexOfComponent = this.components.indexOf(component);
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
        cycle !== undefined ? 'dependency_cycle' : 'unknown_error';

      // Reported for the reason `getStartupOrder()` reports it; a cycle is the caller's
      // configuration, answered by the result.
      if (code === 'unknown_error' && !input.isErrorReported) {
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
      const indexOfComponent = this.components.indexOf(input.component);
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
        duringStartup: this.isStarting,
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
      const totalComponents = this.components.length;

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
    pendingRestartAutoStarts?: Set<string>,
  ): ShutdownPassAcceptance {
    return this.withTransition(() => {
      // Reject if already shutting down - before reading `options`: they are the caller's,
      // and a getter that threw there skipped this refusal, so a request to stay down
      // was never recorded on the running pass and a restart started everything again.
      if (this.isShuttingDown) {
        this.logger.warn(
          'Cannot stop all components: shutdown already in progress',
          {
            params: { method },
          },
        );

        return this.refuseShutdownPass(isRequestToStayDown);
      }

      const passOptions: ShutdownPassOptions = {
        // The one place a pass's options meet the manager's `shutdownOptions` defaults:
        // callers pass only their own overrides.
        timeoutMS: resolveOperationTimeoutMS(
          options?.timeoutMS,
          this.shutdownOptions.timeoutMS,
          'stopAllComponents timeoutMS',
        ),
        retryStalled:
          options?.retryStalled ?? this.shutdownOptions.retryStalled,
        haltOnStall: options?.haltOnStall ?? this.shutdownOptions.haltOnStall,
        allowStopWithPendingStarts:
          (options?.allowStopWithPendingStarts ??
            this.shutdownOptions.allowStopWithPendingStarts) === true,
      };

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
        this.escalationHandlingDepth === 0 &&
        !this.isShuttingDown &&
        this.repeatedShutdownRequestState.firstRequestAt !== null
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
        this.logger.warn(
          'Cannot stop all components: a shutdown started while this request was being processed',
          {
            params: { method },
          },
        );

        return this.refuseShutdownPass(isRequestToStayDown);
      }

      const pass: ShutdownPass = {
        shutdownRequested: false,
        isRestartStopPhase: !isRequestToStayDown,
      };

      if (isRequestToStayDown) {
        this.stayDownPassCount++;
      }

      if (pendingRestartAutoStarts !== undefined) {
        this.pendingRestartAutoStarts.add(pendingRestartAutoStarts);
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
    const requestingStarts = new Set(this.invokingStarts);
    const startTime = Date.now();
    const {
      timeoutMS: effectiveTimeout,
      retryStalled: shouldRetryStalled,
      haltOnStall: shouldHaltOnStall,
      allowStopWithPendingStarts,
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
    // Components still starting when the pass began; see where it is filled in.
    let startingAtPassStart: readonly string[] = [];
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
      this.activeShutdownPass = pass;
      this.shutdownToken = ulid();
      this.shutdownMethod = method;
      if (
        this.repeatedShutdownRequestPolicy &&
        !pass.isRestartStopPhase &&
        this.repeatedShutdownRequestState.firstRequestAt === null
      ) {
        this.seedRepeatedShutdownRequestState(method);
      }
      isDuringStartup = this.isStarting;

      this.logger.info('Stopping all components', {
        params: { method, allowStopWithPendingStarts },
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

        shutdownOrder = this.components.map((c) => this.nameOf(c)).reverse();
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
      // Starts in flight as the pass begins are not stopped by it - the start path sends
      // each through the stop pipeline once `start()` settles - but they are part of what
      // it reports: one that came up during the pass and is still stopping, or stalled
      // stopping, when the pass ends leaves the pass short of its goal, not successful.
      const currentStarts = new Map<string, StartSettlement>();
      for (const [claim, settlement] of this.startSettlements) {
        if (
          this.componentClaims.get(settlement.name)?.claim === claim ||
          (settlement.component !== undefined &&
            this.getComponent(settlement.name) === settlement.component &&
            this.componentStartAttemptTokens.get(settlement.name) ===
              settlement.token)
        ) {
          currentStarts.set(settlement.name, settlement);
        }
      }
      startingAtPassStart = shutdownOrder.filter(
        (name) =>
          this.componentStates.get(name) === 'starting' ||
          currentStarts.has(name),
      );
      const startsToJoin = startingAtPassStart.map((name) =>
        currentStarts.get(name),
      );
      // Optional bulk-start failures are labelled failed, not starting-timed-out.
      // The settlement records whether late startup is still pending in either case.
      const timedOutStarts = new Set(
        startsToJoin.filter(
          (settlement) =>
            settlement?.rawStartPending &&
            (settlement.isAwaitingLateStart || settlement.didSettle),
        ),
      );

      stallCandidateNames = new Set([
        ...runningComponentsToStop,
        ...startingAtPassStart,
      ]);
      stopCandidateNames = [...runningComponentsToStop, ...startingAtPassStart];

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
          : this.readDependencies(component, 'shutdown');
      };
      const protectDependencies = (
        name: string,
        target = protectedDependencies,
      ): void => {
        for (const dependency of readDependencies(name)) {
          if (!target.has(dependency)) {
            target.add(dependency);
            protectDependencies(dependency, target);
          }
        }
      };
      // Start global timeout clock (halts further stop attempts after it fires)
      const timeoutPromise =
        effectiveTimeout > 0
          ? new promiseConstructorIntrinsic<'timeout'>((resolve) => {
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
      let invalidOptionsError: Error | undefined;

      const isStartStillInProgress = (name: string): boolean =>
        isStartUnfinished(currentStarts.get(name)) ||
        this.isComponentInFlight(name);

      const canReleaseStartupDependencies = (name: string): boolean => {
        const state = this.componentStates.get(name);
        return (
          allowStopWithPendingStarts &&
          currentStarts.get(name)?.rawStartPending === true &&
          state !== 'stopping' &&
          state !== 'force-stopping' &&
          !this.stalledComponents.has(name)
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
            (isStartStillInProgress(name) || this.stalledComponents.has(name))
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
            timedOutStarts.has(settlement) &&
            settlement.rawStartPending
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
            await new promiseConstructorIntrinsic<void>((resolve) => {
              setTimeout(resolve, 0);
            });
            if (hasTimedOut) {
              return;
            }
          }
          // Zero disables the shutdown deadline, but a startup timeout can still
          // abandon an unresolved start. Finite budgets keep joining recovery.
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
              !(timedOutStarts.has(settlement) && settlement.rawStartPending)
            ) {
              if (
                effectiveTimeout === 0 &&
                (!settlement.recovery || settlement.isAwaitingLateStart)
              ) {
                await racePromises([settlement.promise, settlement.abandoned]);
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
            if (
              isStartStillInProgress(name) ||
              this.stalledComponents.has(name)
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
        for (const name of stopOrder) {
          // Automatic cleanup already owns teardown; unrelated stops can proceed
          // before we join it at a dependency boundary or at the end of the pass.
          if (currentStarts.has(name) && !this.isComponentUp(name)) {
            continue;
          }
          if (currentStarts.has(name) || startupDependencies.has(name)) {
            await joinStarts();
          }
          if (currentStarts.has(name) && !this.isComponentUp(name)) {
            continue;
          }
          if (hasTimedOut) {
            this.logger.warn(
              'Shutdown timeout reached, stopping further component shutdown',
              {
                params: { timeoutMS: effectiveTimeout },
              },
            );
            break;
          }

          // An earlier dependency stop can let raw startup settle and begin its
          // automatic cleanup. The override no longer permits releasing that
          // cleanup's remaining dependencies, even though the initial join did.
          protectActiveStartupDependencies();
          if (protectedDependencies.has(name)) {
            stoppingComponents.add(name);
            continue;
          }

          this.logger.entity(name).info('Stopping component');

          // Logger sinks are caller code and can start cleanup synchronously.
          protectActiveStartupDependencies();
          if (protectedDependencies.has(name)) {
            stoppingComponents.add(name);
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
          const isStalled = this.stalledComponents.has(name);
          const currentState = this.componentStates.get(name);

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

          const result: ComponentOperationResult = isRunning
            ? await this.stopComponentInternal(name)
            : shouldRetryStalled
              ? await this.retryStalledComponent(name)
              : {
                  success: false,
                  componentName: name,
                  reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
                  code: 'component_stalled',
                  status: this.getComponentStatus(name),
                };

          if (
            result.code === 'invalid_options' &&
            invalidOptionsError === undefined
          ) {
            invalidOptionsError = result.error;
          }

          if (result.success) {
            stoppedComponents.add(name);
          } else if (
            result.code === 'component_already_stopping' ||
            result.code === 'component_already_starting'
          ) {
            // Preserve reverse dependency order. A concurrent stop still owns this
            // component; its dependencies must remain available until it settles.
            stoppingComponents.add(name);
            protectDependencies(name);
            if (shouldHaltOnStall) {
              break;
            }
            continue;
          } else {
            // A refused stop need not be a stall. Final accounting below reads the
            // actual state and keeps validation refusals distinct from failed cleanup.
            // Any refusal before cleanup can leave this component running, whether
            // it is invalid configuration or a throwing caller getter. Protect from
            // the actual state, not the result code: continuing independent cleanup
            // must never remove the dependencies of work that has not stopped.
            if (this.isComponentRunning(name)) {
              protectDependencies(name);
            }
            this.logger
              .entity(name)
              .error('Component failed to stop: {{error.message}}', {
                params: {
                  error:
                    result.error ||
                    new Error(
                      result.reason || LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
                    ),
                },
              });

            if (shouldHaltOnStall) {
              this.logger.warn(
                'Halting shutdown after component stop failure (haltOnStall=true)',
                { params: { componentName: name } },
              );
              break;
            }
          }
        }
        if (!hasTimedOut) {
          await joinStarts();
        }
      };

      pendingShutdownOperation = shutdownOperation();

      if (timeoutPromise) {
        await racePromises([pendingShutdownOperation, timeoutPromise]);
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
      // "still in progress".
      for (const name of Array.from(stoppingComponents)) {
        if (
          !this.runningComponents.has(name) &&
          !this.isComponentInFlight(name) &&
          !this.stalledComponents.has(name)
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

      const stillRunningComponents = [
        ...runningComponentsToStop,
        ...startingAtPassStart,
      ].filter(
        (name) =>
          this.runningComponents.has(name) &&
          !stoppingComponents.has(name) &&
          !finalStalledNames.has(name),
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
        ...(stillRunningComponents.length > 0
          ? [`Failed to stop: ${stillRunningComponents.join(', ')}`]
          : []),
      ];

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
          : !isSuccess && invalidOptionsError !== undefined
            ? {
                code: 'invalid_options' as const,
                error: invalidOptionsError,
                reason: [
                  ...failureReasonParts,
                  describeError(invalidOptionsError),
                ].join('; '),
              }
            : failureReasonParts.length > 0
              ? {
                  code:
                    stoppingComponents.size > 0
                      ? ('cleanup_incomplete' as const)
                      : ('partial_state' as const),
                  reason: failureReasonParts.join('; '),
                }
              : {}),
      };

      return this.withTransition(() => {
        // Store for getLastShutdownResult() - useful for debugging and metrics
        this.lastShutdownResult = result;

        // "Completed" means the manager finished waiting and a shutdown result
        // snapshot exists, not necessarily that every component stopped cleanly.
        // Callers must inspect success / stalledComponents / timedOut to decide
        // what to do next.
        completedResult = result;

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

        if (isSuccess) {
          this.resetRepeatedShutdownRequestState();
        } else {
          this.armRepeatedShutdownAfterFailure();
        }

        return result;
      });
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

      return this.withTransition(() => {
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
        this.activeShutdownPass = null;
        this.updateStartedFlag();

        this.finalizePendingLoggerExit();
      });
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
   * Retry shutdown for a stalled component: the force phase directly, to avoid re-running
   * a failing `stop()`. Under the same net as any other stop, so a failure outside the
   * component's own hooks marks it stalled rather than taking the whole shutdown pass
   * down with it.
   */
  private retryStalledComponent(
    name: string,
  ): Promise<ComponentOperationResult> {
    return this.withComponentStopNet(name, (claim) =>
      this.retryStalledComponentAttempt(name, claim),
    );
  }

  private async retryStalledComponentAttempt(
    name: string,
    claim: symbol,
  ): Promise<ComponentOperationResult> {
    // A stale retry request may now name an ordinary in-progress start. Preserve
    // its former not-running result; only an actual stalled retry reports the
    // more specific in-flight refusal from the force preconditions below.
    if (
      this.getComponent(name) !== undefined &&
      !this.stalledComponents.has(name) &&
      !this.isComponentRunning(name)
    ) {
      return {
        success: false,
        componentName: name,
        code: 'component_not_running',
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
        status: this.getComponentStatus(name),
      };
    }
    const preconditions = this.checkStopPreconditions(name, undefined, {
      claim,
      isStalledRetry: true,
    });
    if ('success' in preconditions) {
      return preconditions;
    }
    const { component } = preconditions;

    if (!this.stalledComponents.has(name)) {
      return await this.stopComponentInternal(name);
    }

    this.logger
      .entity(name)
      .warn('Retrying stalled component shutdown (force phase)');

    return await this.shutdownComponentForce(
      name,
      component,
      {
        gracefulPhaseRan: false,
        gracefulTimedOut: false,
        gracefulError: undefined,
        startedAt: Date.now(),
        isStalledRetry: true,
      },
      claim,
    );
  }

  private createStopPhaseObserver(
    name: string,
  ): ReturnType<typeof createStopPhaseObserver> {
    return createStopPhaseObserver((error, message, level) => {
      this.logger.entity(name)[level](message, {
        params: { error: toError(error) },
      });
    });
  }

  /**
   * Reject a stop's timeout one macrotask after its timeout hook ran, not at once.
   *
   * A hook that releases what `stop()` or `onShutdownForce()` awaits settles it
   * synchronously, but the settlement reaches the race through several promise hops -
   * the component's own `async` function, then `adoptPromise()` - while a rejection made
   * in the same turn gets there in one. The stop finished, yet the timeout won, and the
   * component was stalled or sent on to a force phase it no longer needed. Past a
   * macrotask every such hop has run, so a released stop wins the race as the success it
   * is, however many hops it took. This is the one mechanism for that race.
   *
   * Returns the timer, which the caller keeps as its timeout handle so its `finally`
   * clears it once the stop has settled either way.
   *
   * Stops only. A start's timeout still rejects at once: its abort hook exists to abort
   * the start, and a `start()` it released is a timed-out start, not a successful one.
   */
  private rejectAfterTimeoutHook(
    reject: (error: Error) => void,
    error: Error,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      reject(error);
    }, 0);
  }

  /**
   * Call a component's timeout hook - `onStartupAborted`, `onGracefulStopTimeout`,
   * `onShutdownForceAborted` - from inside the timer that fired.
   *
   * Takes the hook already read: each caller reads it before its timer starts, because
   * the timer callback runs outside every guard, and a hook behind a getter that threw
   * there was an uncaught exception - fatal to a Node process - that also skipped the
   * timeout's rejection and its late-settlement watcher, leaving the operation waiting
   * forever. A sync throw and a returned rejection are both logged and contained.
   */
  private invokeAbortHook(
    component: BaseComponent,
    hook: unknown,
    hookName: string,
    name: string,
  ): void {
    if (typeof hook !== 'function') {
      return;
    }

    runCallbackSafely(
      `${name}.${hookName}`,
      hook,
      [],
      (error) => {
        this.logger
          .entity(name)
          .warn(`Error in ${hookName} callback: {{error.message}}`, {
            params: { error: toError(error) },
          });
      },
      component,
    );
  }

  /**
   * Watch a component's promise that the manager already stopped waiting for - it timed
   * out - so its eventual rejection is logged rather than left unhandled.
   *
   * The `catch` is what prevents the unhandled rejection, fatal under Node's default
   * `--unhandled-rejections=throw`; logging the reason, rather than discarding it, is the
   * second half of the timeout warning the caller has already logged. The chain ends in a
   * terminal `catch` because nothing retains it: logging is guarded, but a floating chain
   * should not have to rely on that.
   */
  private observeFailureAfterTimeout(
    // Already adopted by every caller - see `adoptPromise()` - so chained on directly.
    promise: Promise<unknown>,
    name: string,
    message: string,
    params: Record<string, unknown> = {},
  ): void {
    observeRejection(promise, (error: unknown) => {
      this.logger.entity(name).debug(message, {
        params: { error: toError(error), ...params },
      });
    });
  }

  /** Claim `name` for the attempt holding `claim`, recording the state it replaces. */
  private claimComponent(
    name: string,
    state: 'starting' | 'stopping' | 'force-stopping',
    claim: symbol,
  ): void {
    this.componentClaims.set(name, {
      claim,
      previousState: this.componentStates.get(name),
    });
    this.componentStates.set(name, state);
  }

  /** Whether `claim` is the attempt that last claimed `name`. */
  private ownsClaim(name: string, claim: symbol): boolean {
    return this.componentClaims.get(name)?.claim === claim;
  }

  // Metadata policy and report-once state live together; these small delegates retain
  // the manager's existing read boundaries for orchestration callers.
  private readDependencies(
    component: BaseComponent,
    context: string,
  ): string[] {
    return this.componentMetadata.readDependencies(component, context);
  }

  private readDependenciesReported(
    component: BaseComponent,
    context: string,
  ): DependencyRead {
    return this.componentMetadata.readDependenciesReported(component, context);
  }

  private isComponentOptional(component: BaseComponent): boolean {
    return this.componentMetadata.isComponentOptional(component);
  }

  private reportDependencyReadFailureOnce(
    component: BaseComponent,
    context: string,
    failure: unknown,
    name: string = this.nameOf(component),
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
    return this.components.some((component) => this.nameOf(component) === name);
  }

  private runningStartupSnapshot(
    names: readonly string[] = this.components.map((component) =>
      this.nameOf(component),
    ),
  ): string[] {
    // Unlike running-set membership alone, a startup availability snapshot must
    // exclude teardown: stop keeps that membership until cleanup has settled.
    return names.filter(
      (name) =>
        this.runningComponents.has(name) &&
        this.componentStates.get(name) === 'running',
    );
  }

  /**
   * The names still running, in order - what a startup that stopped partway, or rolled
   * back, reports as started. A rollback that could not stop a component leaves it up,
   * and the result must match the registry rather than claim nothing is.
   */
  private stillRunning(names: readonly string[]): string[] {
    return names.filter((name) => this.runningComponents.has(name));
  }

  /**
   * Whether a start or stop is in flight for the component - the states an attempt
   * claims. Whatever holds one writes its outcome when it settles, so nothing else may
   * start, stop, retry, or remove the component under it.
   */
  private isComponentInFlight(name: string): boolean {
    const state = this.componentStates.get(name);

    return (
      state === 'starting' || state === 'stopping' || state === 'force-stopping'
    );
  }

  /** Drop an attempt's claim, if it still holds it. */
  private releaseClaim(name: string, claim: symbol): void {
    if (this.ownsClaim(name, claim)) {
      this.componentClaims.delete(name);
    }
  }

  /**
   * Whether a force attempt resuming after its `await` no longer owns the component.
   *
   * The graceful stop it was escalating from finished late, and something claimed the
   * component since - a `component:stopped` listener that started it again, say - or it
   * is no longer the registered instance. The stop did happen, so the attempt answers
   * as one whose graceful completion won, without writing its outcome over that newer
   * state: marking a running component stopped, or a replacement stalled.
   */
  private isForceAttemptSuperseded(
    name: string,
    component: BaseComponent,
    claim: symbol,
  ): boolean {
    return (
      !this.ownsClaim(name, claim) || this.getComponent(name) !== component
    );
  }

  /**
   * Put a component's state back to what it was before an attempt claimed it - removing
   * the entry when there was none - so every refusal and crash path restores it the same
   * way.
   */
  private restoreComponentState(
    name: string,
    state: ComponentState | undefined,
  ): void {
    if (state === undefined) {
      this.componentStates.delete(name);
    } else {
      this.componentStates.set(name, state);
    }
  }

  /**
   * `startComponentAttempt()` with a net under it that settles the component's state.
   *
   * The attempt validates its timeout before claiming `starting`, but later work
   * still runs component-owned handlers and not all of that sits inside the attempt's own
   * `try`. The public safety net would still answer with `unknown_error`, but it cannot
   * see the component, which stayed `starting` for good: every later start answered
   * `component_already_starting`. A start that crashes before the component is running
   * is put back to the state it had before the attempt; one already running is left
   * running, which is what the registry says.
   */
  private releaseStartSettlements(name: string, exceptClaim?: symbol): void {
    for (const [claim, settlement] of this.startSettlements) {
      if (settlement.name === name && claim !== exceptClaim) {
        settlement.finish();
      }
    }
  }

  private async startComponentInternal(
    name: string,
    options?: StartComponentOptions,
    bulkStartup?: {
      deadline: number;
      onTimeout: () => void;
      hasExpired: () => boolean;
    },
    // The bulk loop's read of the component's list, so its skip check and this start act
    // on the same one - and the component's code runs once for both.
    preReadDependencies?: DependencyRead,
    startupDependencyReads?: Map<BaseComponent, DependencyRead>,
    restartSnapshot?: RestartStartSnapshot,
  ): Promise<ComponentOperationResult> {
    const claim = Symbol(name);
    let resolveSettlement!: () => void;
    let abandon!: () => void;
    const finishSettlement = (): void => {
      settlement.didSettle = true;
      // An abort hook may return without actually settling raw startup. Keep its
      // dependency protection until that work finishes or ownership is released.
      if (!settlement.rawStartPending) {
        this.startSettlements.delete(claim);
      }
      resolveSettlement();
    };
    const settlement: StartSettlement = {
      name,
      finish: () => {
        finishSettlement();
        this.startSettlements.delete(claim);
      },
      abandon: () => abandon(),
      abandoned: new promiseConstructorIntrinsic<void>((resolve) => {
        abandon = resolve;
      }),
      didSettle: false,
      rawStartPending: false,
      promise: new promiseConstructorIntrinsic<void>((resolve) => {
        resolveSettlement = resolve;
      }),
    };
    this.startSettlements.set(claim, settlement);

    // Released once this attempt settles, however it settled: a claim outlived the attempt
    // that took it, keeping a stale `previousState` until the next attempt overwrote it.
    try {
      try {
        return await this.startComponentAttempt(
          name,
          options,
          bulkStartup,
          claim,
          preReadDependencies,
          startupDependencyReads,
          restartSnapshot,
        );
      } catch (error) {
        if (
          isOperationTimeoutValidationError(error) &&
          !this.ownsClaim(name, claim)
        ) {
          return crashedComponentResult(
            name,
            error,
            `Start refused: ${describeError(error)}`,
          );
        }

        // Nothing below touches the component unless this attempt claimed it - and still
        // holds that claim. An attempt that crashed before claiming, while another start
        // or stop got in across an `await`, must leave that other one's work alone.
        const doesOwnComponent = this.ownsClaim(name, claim);

        // A crash after this attempt marked the component running - building its status
        // for the result, say - still fails the start, so it is stopped again: a failed
        // start means a component that is not running, which is what every caller,
        // bulk rollback included, acts on.
        if (doesOwnComponent && this.runningComponents.has(name)) {
          reportCallbackError('lifecycle-manager component start', error);

          const stopResult = await this.stopComponentInternal(name);

          return crashedComponentResult(
            name,
            toError(error),
            `Start failed unexpectedly after the component was running: ${describeError(error)}; ${
              stopResult.success
                ? 'component stopped again'
                : `stopping it again also failed: ${stopResult.reason ?? 'unknown reason'}`
            }`,
          );
        }

        // Back to the state it had before this attempt claimed it - `registered`,
        // `stopped`, `failed` - so a crashed retry does not erase that history from the
        // status APIs.
        if (
          doesOwnComponent &&
          this.componentStates.get(name) === 'starting' &&
          !this.runningComponents.has(name)
        ) {
          this.restoreComponentState(
            name,
            this.componentClaims.get(name)?.previousState,
          );

          // The attempt's own `finally` ran while it still held `starting`, so a detach
          // it would have run is still waiting.
          this.runDeferredSignalDetach('component startup');
        }

        reportCallbackError('lifecycle-manager component start', error);

        return crashedComponentResult(
          name,
          toError(error),
          `Start failed unexpectedly: ${describeError(error)}`,
        );
      }
    } finally {
      try {
        this.releaseClaim(name, claim);
      } finally {
        if (settlement.recovery) {
          void observePromise(
            settlement.recovery,
            finishSettlement,
            finishSettlement,
          );
        } else {
          finishSettlement();
        }
      }
    }
  }

  /**
   * Whether a component is up: running, and not on its way down. A stopping component
   * stays in `runningComponents` until its stop settles. A dependent must not start on
   * one - that stop already checked for running dependents, so the dependent ran on a
   * stopped dependency - and a health check must not call into one mid-stop.
   */
  private isComponentUp(name: string): boolean {
    const state = this.componentStates.get(name);

    return (
      this.runningComponents.has(name) &&
      state !== 'stopping' &&
      state !== 'force-stopping'
    );
  }

  /**
   * Every check a start makes before it may claim the component, none of which runs the
   * component's code. Made twice by an attempt: before it reads the component's
   * dependency list, timeout and abort handler, and again right before it claims - those
   * reads run the component's code, which can start, stop, unregister or shut down
   * re-entrantly, and a start that trusted the first answer ran `start()` twice.
   */
  private checkStartPreconditions(
    name: string,
    flags: Required<StartComponentOptions>,
    // On the check before the claim: the instance the attempt read, which must still be
    // the one registered under `name` - it may have been unregistered, or replaced by
    // another, while its code ran.
    expected?: BaseComponent,
  ):
    | ComponentOperationResult
    | { component: BaseComponent; currentState: ComponentState | undefined } {
    // A timed-out bulk start owns the component until it settles and cleanup ends.
    if (this.pendingBulkStartupCleanup.has(name)) {
      return {
        success: false,
        componentName: name,
        code: 'component_already_starting',
        reason: LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
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
    if (!flags.allowDuringBulkStartup && this.isStarting) {
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

    // The instance the attempt read, when there is one, is checked directly rather than
    // looked up by name again.
    const component =
      expected === undefined
        ? this.getComponent(name)
        : this.registeredNames.get(expected) === name &&
            this.components.includes(expected)
          ? expected
          : undefined;

    if (!component) {
      return {
        success: false,
        componentName: name,
        // The instance this start read is gone, whatever now holds its name.
        reason:
          expected === undefined
            ? LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND
            : `Component "${name}" was unregistered or replaced while its start was being prepared`,
        code: 'component_not_found',
      };
    }

    // Check if component is stalled (unless explicitly forced)
    if (!flags.forceStalled && this.stalledComponents.has(name)) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
        code: 'component_stalled',
        status: this.getComponentStatus(name),
      };
    }

    // Ahead of the dependency checks: a component already running, starting or stopping
    // answers as such, whatever its dependency list says now. Checked after them, a
    // running component whose list had since broken failed instead - and a bulk startup
    // took that for a required failure and rolled back everything else.
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

    return { component, currentState };
  }

  private snapshotStartOptions(
    options: StartComponentOptions | undefined,
  ): Required<StartComponentOptions> {
    return {
      allowDuringBulkStartup: options?.allowDuringBulkStartup === true,
      forceStalled: options?.forceStalled === true,
      allowNonRunningDependencies:
        options?.allowNonRunningDependencies === true,
    };
  }

  /**
   * The start itself, under `startComponentInternal()`'s net - bypasses bulk operation checks
   * Used by both startComponent() and startAllComponents()
   */
  private async startComponentAttempt(
    name: string,
    options: StartComponentOptions | undefined,
    bulkStartup:
      | {
          deadline: number;
          onTimeout: () => void;
          hasExpired: () => boolean;
        }
      | undefined,
    claim: symbol,
    preReadDependencies: DependencyRead | undefined,
    startupDependencyReads: Map<BaseComponent, DependencyRead> | undefined,
    restartSnapshot: RestartStartSnapshot | undefined,
  ): Promise<ComponentOperationResult> {
    // Each option read once, here: the checks below run twice, and a caller's getter that
    // answered differently the second time - `forceStalled` true for the stalled check,
    // false where a forced start retires the stalled run's late stop - split the start.
    const flags = this.snapshotStartOptions(options);

    // A refusal is a result; anything else is the component, clear to proceed.
    const preconditions = this.checkStartPreconditions(
      name,
      flags,
      restartSnapshot?.component,
    );

    if ('success' in preconditions) {
      return preconditions;
    }

    const { component } = preconditions;
    if (
      restartSnapshot !== undefined &&
      !this.isCurrentRestartSnapshot(name, restartSnapshot)
    ) {
      return {
        success: false,
        componentName: name,
        reason: 'Component registration changed while restart was starting it',
        code: 'component_not_found',
      };
    }

    // Everything of the component's own code this start needs is read first - its
    // dependency list, its non-running dependencies' `isOptional()`, its timeout and
    // abort handler - and every check that decides the start runs after, synchronously,
    // right before the claim. Any of those reads can start, stop, unregister or shut
    // down re-entrantly; a start that checked before them found its component
    // `starting` under a re-entrant start of its own and ran `start()` a second time,
    // and one that approved a dependency before them started on it after it stopped.

    // Its own list read strictly: a broken one fails this start as `missing_dependency`,
    // naming the component, rather than being read as fewer dependencies than it
    // declares. Reported once per registration, as other reads of it are.
    const dependencyGeneration =
      preReadDependencies !== undefined && startupDependencyReads !== undefined
        ? this.registrationReads.readGeneration(
            startupDependencyReads,
            component,
          )
        : this.registrationReads.currentGeneration(component);
    const ownDependencies =
      preReadDependencies ?? this.readDependenciesReported(component, 'start');

    if (
      !('dependencies' in ownDependencies) ||
      ownDependencies.invalidEntry !== undefined
    ) {
      const err = toError(
        'dependencies' in ownDependencies
          ? ownDependencies.invalidEntry
          : ownDependencies.error,
      );

      return {
        success: false,
        componentName: name,
        reason: `Could not read the dependencies declared by "${name}": ${describeError(err)}`,
        code: 'missing_dependency',
        error: err,
        status: this.getComponentStatus(name),
      };
    }

    // Read only where it decides something: a dependency that is not up, and only
    // without the override, which ignores the answer. One that stops after this read
    // has no answer and is held to required below - the conservative reading. Kept by
    // instance: the answer is that instance's, and one that has since been replaced
    // under its name answered nothing.
    const optionalDependencies = new Map<string, BaseComponent>();

    if (!flags.allowNonRunningDependencies) {
      for (const dependencyName of ownDependencies.dependencies) {
        const dependency = this.getComponent(dependencyName);

        if (
          dependency !== undefined &&
          !this.isComponentUp(dependencyName) &&
          this.isComponentOptional(dependency)
        ) {
          optionalDependencies.set(dependencyName, dependency);
        }
      }
    }

    // Read before the component is claimed: it is the component's own property, and a
    // getter that threw between the claim and the `try` below skipped that `try`'s
    // cleanup, leaving auto-attached signals attached behind a `component:starting`
    // with no terminal event.
    const componentTimeout =
      restartSnapshot?.timeoutMS ??
      toOperationTimerDelayMS(
        component.startupTimeoutMS,
        `${name}.startupTimeoutMS`,
      );
    // Read here for the same reason, and because the timer callback that uses it runs
    // outside every guard: a getter that threw there was an uncaught exception - fatal
    // to a Node process - and skipped the late-completion monitor as well.
    const onStartupAborted: unknown = Reflect.get(
      component,
      'onStartupAborted',
    );

    // From here to the claim, nothing runs the component's code - logging included,
    // since the logger is the caller's too: the warnings wait until the claim is made.
    const recheck = this.checkStartPreconditions(name, flags, component);

    if ('success' in recheck) {
      return recheck;
    }
    if (
      restartSnapshot !== undefined &&
      !this.isCurrentRestartSnapshot(name, restartSnapshot)
    ) {
      return {
        success: false,
        componentName: name,
        reason: 'Component registration changed while restart was starting it',
        code: 'component_not_found',
      };
    }

    const skippedDependencyWarnings: string[] = [];

    for (const dependencyName of ownDependencies.dependencies) {
      const dependency = this.getComponent(dependencyName);

      if (dependency === undefined) {
        return {
          success: false,
          componentName: name,
          reason: `Missing dependency "${dependencyName}"`,
          code: 'missing_dependency',
          status: this.getComponentStatus(name),
        };
      }

      if (this.isComponentUp(dependencyName)) {
        continue;
      }

      if (flags.allowNonRunningDependencies) {
        // Explicit override - allow skipping both optional and required dependencies
        skippedDependencyWarnings.push(
          `Starting with non-running dependency "${dependencyName}" (allowNonRunningDependencies=true)`,
        );
        continue;
      }

      if (optionalDependencies.get(dependencyName) === dependency) {
        // Optional dependencies never block startup
        skippedDependencyWarnings.push(
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

    // The component is claimed as `starting` before the attach, not after it: attaching
    // emits `lifecycle-manager:signals-attached` synchronously, and a listener that
    // starts or stops this component from there must find it already starting rather
    // than slip in between. The state it had is put back if the attach fails, which is
    // all a refusal has to release. Tracked so failure cleanup only detaches what this
    // start attempt attached.
    const stateBeforeStart = recheck.currentState;
    const restoreStateBeforeStart = (): void => {
      this.restoreComponentState(name, stateBeforeStart);
    };

    this.claimComponent(name, 'starting', claim);

    for (const warning of skippedDependencyWarnings) {
      this.logger.entity(name).warn(warning);
    }

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
        this.detachSignalsIfIdle('refused component startup');
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
    const shutdownTokenAtStart = shutdownTokenBeforeAttach;
    this.logger.entity(name).info('Starting component');

    // Taken before the starting log and event, not after: a listener there that calls
    // `stopAllComponents()` starts a pass this start must notice, so the component is
    // sent through the stop pipeline once `start()` settles rather than coming up after
    // the shutdown.
    this.lifecycleEvents.componentStarting(name);

    const remainingBudget =
      bulkStartup === undefined
        ? undefined
        : Math.max(1, bulkStartup.deadline - Date.now());
    const useBulkDeadline =
      remainingBudget !== undefined &&
      (componentTimeout === 0 || remainingBudget <= componentTimeout);
    const timeoutMS = useBulkDeadline ? remainingBudget : componentTimeout;
    const startAttemptToken = ulid();
    this.componentStartAttemptTokens.set(name, startAttemptToken);
    this.releaseStartSettlements(name, claim);
    const settlement = this.startSettlements.get(claim);
    if (settlement) {
      settlement.component = component;
      settlement.token = startAttemptToken;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    let startupTimeoutError: ComponentStartTimeoutError | undefined;

    try {
      // Inside the `try`, so a failure here is a failed start like any other - reported
      // with `component:start-failed`, and its auto-attached signals detached.
      component._setUnexpectedStopHandler(
        this.createUnexpectedStopHandler(name, startAttemptToken),
      );

      // All refusal points and the overridable handler setup are past. Only now
      // record this accepted start, with its registration generation; failed attach
      // or shutdown checks must not change the pass's dependency facts.
      if (
        startupDependencyReads === this.activeBulkStartup?.dependencyReads &&
        startupDependencyReads !== undefined
      ) {
        this.registrationReads.recordRead(
          startupDependencyReads,
          component,
          ownDependencies,
          dependencyGeneration,
        );
      }
      // Race against timeout
      // Adopted, not raced as it is: a native promise carrying its own no-op `then`
      // never settled the race, and its rejection went unhandled. See `adoptPromise()`.
      let startPromise: Promise<void>;
      if (settlement) {
        this.invokingStarts.add(settlement);
      }
      try {
        if (settlement) {
          settlement.rawStartPending = true;
        }
        startPromise = adoptPromise(component.start());
        if (settlement) {
          const markRawStartSettled = (): void => {
            settlement.rawStartPending = false;
            if (settlement.didSettle) {
              this.startSettlements.delete(claim);
            }
          };
          void observePromise(
            startPromise,
            markRawStartSettled,
            markRawStartSettled,
          );
        }
      } catch (error) {
        if (settlement) {
          settlement.rawStartPending = false;
        }
        throw error;
      } finally {
        if (settlement) {
          this.invokingStarts.delete(settlement);
        }
      }

      const delayMS = optionalValidatedTimerDelayMS(timeoutMS);
      if (delayMS !== undefined) {
        const timeoutPromise = new promiseConstructorIntrinsic<never>(
          (_, reject) => {
            timeoutHandle = setTimeout(() => {
              // Settle before notifications: user callbacks cannot swallow the deadline.
              startupTimeoutError = new ComponentStartTimeoutError({
                componentName: name,
                timeoutMS,
              });
              reject(startupTimeoutError);
              // This attempt must settle, but its old deadline must not abort or
              // announce a timeout for a newer run of the same component.
              if (
                this.getComponent(name) !== component ||
                this.componentStartAttemptTokens.get(name) !== startAttemptToken
              ) {
                this.observeFailureAfterTimeout(
                  startPromise,
                  name,
                  'Superseded start() failed after its deadline',
                );
                return;
              }
              if (useBulkDeadline) {
                bulkStartup?.onTimeout();
              }
              if (useBulkDeadline || typeof onStartupAborted !== 'function') {
                this.monitorLateStartupCompletion(
                  name,
                  component,
                  startPromise,
                  startAttemptToken,
                  claim,
                  stateBeforeStart === 'stalled',
                );
                // Only this timer path abandons an unresolved start. The other
                // monitor call handles an already fulfilled start and must join cleanup.
                settlement?.abandon();
              }
              // Both the bulk deadline and late-cleanup announcement can run
              // sinks that supersede this start. Recheck at the hook boundary too.
              if (
                this.getComponent(name) === component &&
                this.componentStartAttemptTokens.get(name) === startAttemptToken
              ) {
                this.invokeAbortHook(
                  component,
                  onStartupAborted,
                  'onStartupAborted',
                  name,
                );
              }

              this.observeFailureAfterTimeout(
                startPromise,
                name,
                'start() failed after it had already timed out',
              );
            }, delayMS);
          },
        );

        await racePromises([startPromise, timeoutPromise]);
      } else {
        await awaitBoxedPromise(startPromise);
      }

      // The startup deadline no longer applies once start() has settled.
      clearTimeout(timeoutHandle);

      // Superseded while `start()` ran: the component reported an unexpected stop from
      // inside it, and a `component:unexpected-stop` listener started it again. That
      // newer attempt owns the state now, whether it worked or not, so this one must not
      // mark the component running over it - nor clear the unexpected-stop handler it
      // installed.
      if (
        this.getComponent(name) !== component ||
        this.componentStartAttemptTokens.get(name) !== startAttemptToken
      ) {
        return {
          success: false,
          componentName: name,
          reason:
            'Component stopped unexpectedly during startup and was started again',
          code: 'component_unexpected_stop',
          status: this.getComponentStatus(name),
        };
      }

      // A component can self-report an unexpected stop from inside start()
      // before the manager has promoted it to running. If that happened, do
      // not fall through into the normal success path and resurrect it.
      if (
        this.componentStartAttemptTokens.get(name) === startAttemptToken &&
        this.componentStates.get(name) === 'stopped' &&
        !this.runningComponents.has(name)
      ) {
        this.clearUnexpectedStopHandler(component, 'start');
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
        this.withTransition(() => {
          this.componentErrors.set(name, null);
          this.markComponentRunning(name);
        });
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
          claim,
          stateBeforeStart === 'stalled',
        );
        startupTimeoutError = new ComponentStartTimeoutError({
          componentName: name,
          timeoutMS,
        });
        throw startupTimeoutError;
      }

      this.withTransition(() => {
        // Update state. The previous run's error goes with it: `lastError` on a component
        // that is running again described a run that is over, and a reader taking it for
        // the current one - a health dashboard, a restart policy - was told the restart
        // had not worked. A clean late stop already clears it for the same reason.
        this.componentErrors.set(name, null);
        if (flags.forceStalled) {
          // A successful forceStalled start creates a new run. Any late stop
          // promise from the previous stalled run must no longer own state.
          this.issueStopAttemptToken(name);
        }
        this.markComponentRunning(name);

        this.logger.entity(name).success('Component started');
        const status = this.getComponentStatus(name);
        this.lifecycleEvents.componentStarted(name, status);
      });
      // `attachSignalsOnStart` attaches once a component is actually up, not before. A
      // process configured to handle signals must not stay up without them, so a failed
      // attach takes this component back down and fails the start - after its `started`
      // event, so observers see an ordinary start followed by a stop.
      //
      // Whenever handlers are not attached, not only for the first running component: a
      // start rolled back for a failed attach is still counted as running while it is
      // stopped again, and a start finishing in that window came up without handlers.
      // `autoAttachSignals()` is a no-op when they are already attached.
      //
      // Only if it is still up: this runs after `component:started`, and a listener
      // there may have had it report an unexpected stop - whose detach check found
      // nothing attached yet. Attaching now would leave handlers on an idle manager.
      if (this.attachSignalsOnStart && this.runningComponents.has(name)) {
        const signalAttach = this.autoAttachSignals('first component start');

        if (signalAttach.outcome === 'failed') {
          return await this.rollBackStartForSignalAttach(
            name,
            signalAttach.error,
          );
        }
      }

      return {
        success: true,
        componentName: name,
        status: this.getComponentStatus(name),
      };
    } catch (error) {
      // Superseded, as the `try` path checks after `start()` settles: the component
      // reported an unexpected stop and a listener started it again, or it is no longer
      // the registered instance. That newer attempt or replacement owns the state, its
      // unexpected-stop handler, and any `running` mark - so nothing below may touch
      // them, and a failure here is not `startComponentInternal()`'s to stop again.
      if (
        this.getComponent(name) !== component ||
        this.componentStartAttemptTokens.get(name) !== startAttemptToken
      ) {
        return {
          success: false,
          componentName: name,
          reason:
            'Component stopped unexpectedly during startup and was started again',
          code: 'component_unexpected_stop',
          error: toError(error),
        };
      }

      // Everything below describes a start that never got as far as running. A throw
      // after the component was marked running - building its status for the result,
      // say - is not that: it is left to `startComponentInternal()`, which stops the
      // component again so the failed start it reports is true.
      if (this.runningComponents.has(name)) {
        throw error;
      }

      // Contained, as unregister contains it: an override that throws here escaped to the
      // start net, which restored the state from before the start - `registered`, not
      // `starting-timed-out` - lost the timeout result and its event, and left a late
      // `start()` that nothing would stop.
      this.clearUnexpectedStopHandler(component, 'start');

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
        startupTimeoutError !== undefined && error === startupTimeoutError;

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
            (isNullish(unexpectedStopError)
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

      return this.withTransition<ComponentOperationResult>(() => {
        // Store error
        this.componentErrors.set(name, err);

        // Guarded for the same reason as the `component_unexpected_stop` branch above:
        // `toError` returns a brand-claiming value unchanged, so `.message` can be an
        // accessor that throws, and here that throw has nothing left above it to catch.
        const reason = describeError(err);

        // Check if it was a timeout
        if (isStartupTimeout) {
          this.componentStates.set(
            name,
            this.stalledComponents.has(name) ? 'stalled' : 'starting-timed-out',
          );

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
          // A failed forced start does not retire the previous stop's stall.
          this.componentStates.set(
            name,
            this.stalledComponents.has(name) ? 'stalled' : 'registered',
          );

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
          code: isStartupTimeout
            ? 'component_startup_timeout'
            : 'unknown_error',
          error: err,
          status: this.getComponentStatus(name),
        };
      });
    } finally {
      // Ensure we always clean up the timeout handle, even if component.start()
      // rejects (non-timeout failure). Otherwise onStartupAborted() can fire
      // unexpectedly later and the timer handle leaks.
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (didAutoAttachSignalsForComponentStartup) {
        this.detachSignalsIfIdle('failed component startup');
      } else {
        this.runDeferredSignalDetach('component startup');
      }
    }
  }

  /**
   * Internal stop component method - bypasses bulk operation checks
   * Implements individual component graceful -> force shutdown (global warning handled elsewhere).
   * The public stop entry explicitly opts into bulk rechecks; bulk shutdown and
   * cleanup call this internal entry under their own ownership. Keep that policy
   * call-local instead of maintaining another per-claim registry to infer it.
   */
  private stopComponentInternal(
    name: string,
    options?: StopComponentOptions,
    stopContext?: IndividualStopContext,
  ): Promise<ComponentOperationResult> {
    return this.withComponentStopNet(name, (claim) =>
      this.stopComponentAttempt(name, options, claim, stopContext),
    );
  }

  /**
   * The net under every per-component stop - `stopComponentInternal()` and a stalled
   * component's force-phase retry alike.
   */
  private async withComponentStopNet(
    name: string,
    run: (claim: symbol) => Promise<ComponentOperationResult>,
  ): Promise<ComponentOperationResult> {
    const startedAt = Date.now();
    const claim = Symbol(name);

    // Released once this attempt settles, however it settled: a claim outlived the attempt
    // that took it, keeping a stale `previousState` until the next attempt overwrote it.
    try {
      try {
        return await run(claim);
      } catch (error) {
        if (
          isOperationTimeoutValidationError(error) &&
          !this.ownsClaim(name, claim)
        ) {
          return crashedComponentResult(
            name,
            error,
            `Stop refused: ${describeError(error)}`,
          );
        }

        // Once an attempt claims `stopping` / `force-stopping`, subsequent hook calls
        // and result bookkeeping can still throw outside the phase's own `try`.
        // Left alone, a throw there held that state for good: every later
        // start or stop answered `component_already_stopping`, and it could never be
        // unregistered. Nobody can vouch for what the component did stop, which is what
        // `stalled` means, and a stalled component can be retried or unregistered.
        const err = toError(error);
        const state = this.componentStates.get(name);

        // Only a stop this attempt claimed: a `stopping` it did not claim belongs to a
        // concurrent stop - one that got in while this attempt was awaiting, before its
        // own claim - and must not be stalled by this attempt's crash.
        if (
          (state === 'stopping' || state === 'force-stopping') &&
          this.ownsClaim(name, claim)
        ) {
          const stallInfo: ComponentStallInfo = {
            name,
            phase: state === 'stopping' ? 'graceful' : 'force',
            reason: 'error',
            startedAt,
            stalledAt: Date.now(),
            error: err,
          };

          this.markComponentStalled(name, stallInfo, err);
          // A force-stop waiter for this name is released. Signals stay attached, as they
          // do for every other stall: a stalled component was not confirmed stopped, and
          // during a shutdown the operator's next Ctrl+C still has to reach escalation.
          this.resolvePendingForceStopWaiters(name);
          this.lifecycleEvents.componentStalled(name, stallInfo, {
            reason: 'error',
            code: 'unknown_error',
          });
        }

        reportCallbackError('lifecycle-manager component stop', error);

        return crashedComponentResult(
          name,
          err,
          `Stop failed unexpectedly: ${describeError(error)}`,
        );
      }
    } finally {
      this.releaseClaim(name, claim);
    }
  }

  /**
   * The stop preconditions, checked without reading component-owned properties. Each
   * phase checks again after reading its timeout and hooks: getters
   * may stop, unregister, or replace the component synchronously. Taking the claim
   * from that newer stop would call stop() twice and let either completion overwrite
   * the other's state. A replacement must not inherit the old instance's outcome.
   */
  private checkStopPreconditions(
    name: string,
    expected?: BaseComponent,
    force?: { claim: symbol; isStalledRetry: boolean },
  ): ComponentOperationResult | { component: BaseComponent } {
    const component = this.getComponent(name);

    if (!component || (expected !== undefined && component !== expected)) {
      return {
        success: false,
        componentName: name,
        reason:
          expected === undefined
            ? LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND
            : `Component "${name}" was unregistered or replaced while its stop was being prepared`,
        code: 'component_not_found',
      };
    }

    // A force phase may continue its own graceful claim, or retry an idle stall.
    // It may never replace another in-flight claim, including a forceStalled start.
    // Do this before the stall check because retries retain the stall record while
    // their force handler runs.
    if (force && this.isComponentInFlight(name)) {
      const state = this.componentStates.get(name);
      if (state === 'stopping' && this.ownsClaim(name, force.claim)) {
        return { component };
      }
      const isStarting = state === 'starting';
      return {
        success: false,
        componentName: name,
        reason: isStarting
          ? 'Component is starting'
          : 'Component is already stopping',
        code: isStarting
          ? 'component_already_starting'
          : 'component_already_stopping',
        status: this.getComponentStatus(name),
      };
    }
    if (force?.isStalledRetry && this.stalledComponents.has(name)) {
      return { component };
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

    return { component };
  }

  private async stopComponentAttempt(
    name: string,
    options: StopComponentOptions | undefined,
    claim: symbol,
    stopContext: IndividualStopContext | undefined,
  ): Promise<ComponentOperationResult> {
    const preconditions = this.checkStopPreconditions(name);
    if ('success' in preconditions) {
      return preconditions;
    }
    const { component } = preconditions;

    // Handle forceImmediate option - skip all phases and go straight to force
    if (options?.forceImmediate) {
      return await this.shutdownComponentForce(
        name,
        component,
        {
          gracefulPhaseRan: false,
          gracefulTimedOut: false,
          gracefulError: undefined,
          startedAt: Date.now(),
        },
        claim,
        undefined,
        stopContext,
      );
    }

    // Run three-phase shutdown
    return await this.shutdownComponent(
      name,
      component,
      options,
      claim,
      stopContext,
    );
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
    options: StopComponentOptions | undefined,
    claim: symbol,
    stopContext: IndividualStopContext | undefined,
  ): Promise<ComponentOperationResult> {
    const shutdownStartedAt = Date.now();
    // Prepare both phases before claiming the component or calling stop(). An invalid
    // force budget must not first shut down part of the component. Keep the values we
    // validated: a getter or stop() can change the component before escalation.
    const onGracefulStopTimeout: unknown = Reflect.get(
      component,
      'onGracefulStopTimeout',
    );
    const requestedTimeoutMS = options?.timeout;
    const isUsingComponentTimeout = isNullish(requestedTimeoutMS);
    const timeoutMS = toOperationTimerDelayMS(
      isUsingComponentTimeout
        ? component.shutdownGracefulTimeoutMS
        : requestedTimeoutMS,
      isUsingComponentTimeout
        ? `${name}.shutdownGracefulTimeoutMS`
        : 'stopComponent timeout',
    );
    const forcePreparation = this.prepareForceShutdown(name, component);

    // ============================================================================
    // Phase 1: Graceful (always)
    // ============================================================================
    // Internal attempt-local handoff, never the caller's options object. The
    // observer records a resolution that the foreground race must consume.
    const gracefulPreparation = {
      timeoutMS,
      onGracefulStopTimeout,
      lateResolution: undefined as string | undefined,
    };
    const gracefulResult = await this.shutdownComponentGraceful(
      name,
      component,
      gracefulPreparation,
      claim,
      stopContext,
    );

    // Only an attempt that claimed the graceful phase may escalate it. A refusal
    // after a re-entrant getter owns no stop, and the current claim may belong to
    // the nested attempt. Its refusal is the result, not a reason to force that
    // other attempt's component. The same applies if our claim was superseded while
    // awaiting the graceful result.
    if (gracefulResult.success || !this.ownsClaim(name, claim)) {
      return gracefulResult;
    }

    // The timeout notification can resolve a bare stop promise before the force
    // claim. Its observer must not finalize while the foreground race is undecided;
    // now that it returned, consume the retained resolution under the same token.
    if (
      gracefulPreparation.lateResolution !== undefined &&
      this.componentStopAttemptTokens.get(name) ===
        gracefulPreparation.lateResolution &&
      this.getComponent(name) === component &&
      this.componentStates.get(name) === 'stopping'
    ) {
      if (
        this.handleLateStopResolution(
          name,
          gracefulPreparation.lateResolution,
          'graceful',
          true,
        )
      ) {
        return {
          success: true,
          componentName: name,
          status: this.getComponentStatus(name),
        };
      }
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

    return await this.shutdownComponentForce(
      name,
      component,
      {
        gracefulPhaseRan: true,
        gracefulTimedOut: gracefulResult.code === 'component_shutdown_timeout',
        gracefulError: gracefulResult.error,
        startedAt: shutdownStartedAt,
      },
      claim,
      forcePreparation,
      stopContext,
    );
  }

  /**
   * Global warning phase (stopAllComponents only)
   * Calls onShutdownWarning() on running components with a global timeout
   */
  private runShutdownWarningPhase(componentNames: string[]): Promise<void> {
    return runShutdownWarningPhase(
      this.componentAccess,
      componentNames,
      this.shutdownWarningTimeoutMS,
    );
  }

  private checkIndividualStopClaim(
    name: string,
    stopContext: IndividualStopContext,
  ): ComponentOperationResult | undefined {
    const dependentRefusal = this.checkIndividualStopDependents(
      name,
      stopContext,
    );
    if (dependentRefusal) {
      return dependentRefusal;
    }
    // Rollback may bypass its own startup latch, never a newer shutdown
    // accepted by one of the preparation/dependency getters just read.
    if (stopContext.hasShutdownBegun?.()) {
      return {
        success: false,
        componentName: name,
        code: 'shutdown_in_progress',
        reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
      };
    }
    const bulkRefusal = stopContext.isStartupRollback
      ? undefined
      : this.checkIndividualBulkPreconditions(name, stopContext.operation);
    if (bulkRefusal) {
      return bulkRefusal;
    }
    return undefined;
  }

  /**
   * Phase 2: Graceful shutdown
   * Calls stop() with timeout
   */
  private async shutdownComponentGraceful(
    name: string,
    component: BaseComponent,
    preparation: {
      timeoutMS: number;
      onGracefulStopTimeout: unknown;
      lateResolution?: string;
    },
    claim: symbol,
    stopContext: IndividualStopContext | undefined,
  ): Promise<ComponentOperationResult> {
    const { timeoutMS, onGracefulStopTimeout } = preparation;

    if (stopContext) {
      const refusal = this.checkIndividualStopClaim(name, stopContext);
      if (refusal) {
        return refusal;
      }
    }

    // All prepared getters are caller code and may already have started another stop.
    const recheck = this.checkStopPreconditions(name, component);
    if ('success' in recheck) {
      return recheck;
    }

    // Nothing between the recheck and claim runs caller code. Claim first, then
    // clear the unexpected-stop handler: even the clearing hook can be overridden
    // to re-enter. It must find this stop already in progress. Both happen before
    // any async work, so reports of an unexpected stop are ignored from here on.
    this.claimComponent(name, 'stopping', claim);
    if (stopContext) {
      stopContext.claimed = true;
    }
    this.clearUnexpectedStopHandler(component, 'stop');
    this.logger.entity(name).info('Graceful shutdown started');
    this.lifecycleEvents.componentStopping(name);

    const stopAttemptToken = this.issueStopAttemptToken(name);
    // Only this attempt's deadline is a timeout. A hook may reject with the same
    // exported error class and component name for an unrelated reason.
    let gracefulTimeoutError: ComponentStopTimeoutError | undefined;
    const outcomeObserver = this.createStopPhaseObserver(name);

    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      // Race against graceful timeout
      // Adopted, for the reason `startComponentAttempt()` adopts `start()`'s.
      const stopPromise = adoptPromise(component.stop());

      const delayMS = optionalValidatedTimerDelayMS(timeoutMS);
      if (delayMS !== undefined) {
        const timeoutPromise = new promiseConstructorIntrinsic<never>(
          (_, reject) => {
            timeoutHandle = setTimeout(() => {
              gracefulTimeoutError = new ComponentStopTimeoutError({
                componentName: name,
                timeoutMS,
              });
              this.invokeAbortHook(
                component,
                onGracefulStopTimeout,
                'onGracefulStopTimeout',
                name,
              );

              // Detect if stop() eventually resolves after the timeout so the stall
              // can be cleared automatically without a manual retry. From here on
              // this observer owns rejection reporting, even if the abort hook makes
              // stop() reject before the deferred deadline wins the foreground race.
              outcomeObserver.observe(
                stopPromise,
                'Component stop failed after deadline fired',
                {
                  onResolved: () => {
                    preparation.lateResolution = stopAttemptToken;
                    this.handleLateStopResolution(
                      name,
                      stopAttemptToken,
                      'graceful',
                    );
                  },
                },
              );
              timeoutHandle = this.rejectAfterTimeoutHook(
                reject,
                gracefulTimeoutError,
              );
            }, delayMS);
          },
        );

        await racePromises([stopPromise, timeoutPromise]);
      } else {
        await awaitBoxedPromise(stopPromise);
      }

      return this.withTransition(() => {
        // Update state - graceful succeeded
        this.markComponentStopped(name);

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
      });
    } catch (error) {
      const err = toError(error);

      // Store error
      this.componentErrors.set(name, err);

      // Check if it was a timeout
      if (
        gracefulTimeoutError !== undefined &&
        error === gracefulTimeoutError
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
        // Keep the failure result even when the timeout observer owns its log.
        // Otherwise a rejection from the abort hook is reported by both paths.
        outcomeObserver.reportForeground(
          err,
          'Graceful shutdown threw error: {{error.message}}',
        );

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
   * Capture the force handler and its budget together before any stop phase runs.
   * Immediate and stalled-retry force attempts prepare themselves at their own entry.
   */
  private prepareForceShutdown(
    name: string,
    component: BaseComponent,
  ): {
    onShutdownForce: unknown;
    timeoutMS: number;
  } {
    const onShutdownForce: unknown = Reflect.get(component, 'onShutdownForce');
    const hasForceHandler = typeof onShutdownForce === 'function';
    const timeoutMS = hasForceHandler
      ? toOperationTimerDelayMS(
          component.shutdownForceTimeoutMS,
          `${name}.shutdownForceTimeoutMS`,
        )
      : 0;
    return { onShutdownForce, timeoutMS };
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
      // A stalled component's force-phase retry: a new stop attempt, which issues its
      // own token - see below.
      isStalledRetry?: boolean;
    },
    claim: symbol,
    preparation?: ReturnType<LifecycleManager['prepareForceShutdown']>,
    stopContext?: IndividualStopContext,
  ): Promise<ComponentOperationResult> {
    const { onShutdownForce, timeoutMS } =
      preparation ?? this.prepareForceShutdown(name, component);
    const hasForceHandler = typeof onShutdownForce === 'function';
    // The abort hook is needed only if this phase actually runs. A graceful success
    // must not consult it merely to preflight the force handler's timeout.
    const onShutdownForceAborted: unknown = hasForceHandler
      ? Reflect.get(component, 'onShutdownForceAborted')
      : undefined;

    // An individual attempt must respect bulk work started by prepared getters.
    // An already claimed graceful stop still owns its escalation during bulk work.
    if (stopContext && !this.ownsClaim(name, claim)) {
      const refusal = this.checkIndividualStopClaim(name, stopContext);
      if (refusal) {
        return refusal;
      }
    }

    // Hook and timeout getters can synchronously start another stop, restart a
    // stalled component, or unregister and replace it. Recheck after all reads and
    // before changing either ownership or the stop generation. In particular, a
    // refused outer attempt must not orphan a nested attempt's late completion.
    const recheck = this.checkStopPreconditions(name, component, {
      claim,
      isStalledRetry: context.isStalledRetry === true,
    });
    if ('success' in recheck) {
      return recheck;
    }

    this.claimComponent(name, 'force-stopping', claim);
    if (stopContext) {
      stopContext.claimed = true;
    }
    // A fresh force-immediate stop needs a token. A stalled retry only advances it
    // when a handler will actually run: without one, the old graceful promise may
    // still settle late and clear the stall. Graceful escalation keeps its token.
    const forceAttemptToken =
      !context.gracefulPhaseRan && (!context.isStalledRetry || hasForceHandler)
        ? this.issueStopAttemptToken(name)
        : this.componentStopAttemptTokens.get(name);

    // The internal claim is not a force-start notification. If bookkeeping is
    // broken, the stop safety net records this attempt as stalled and releases its
    // claim; a stall describes unconfirmed cleanup, not proof that a hook ran.
    // Validate before publishing a force start or invoking any caller code.
    // No-handler retries observe no promise and remain valid without a token.
    if (hasForceHandler && forceAttemptToken === undefined) {
      throw new Error('Force stop attempt is missing its stop token');
    }

    // Claim before calling this overridable hook, just as in the graceful phase.
    // Property-read failures above still leave the unexpected-stop handler intact.
    this.clearUnexpectedStopHandler(component, 'force stop');
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
    if (!hasForceHandler) {
      const stallInfo: ComponentStallInfo = {
        name,
        phase: 'graceful', // Failed in graceful phase
        reason: context.gracefulTimedOut ? 'timeout' : 'error',
        startedAt: context.startedAt,
        stalledAt: Date.now(),
        error: context.gracefulError,
      };

      this.markComponentStalled(name, stallInfo);

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

    const { promise: stoppedDuringForcePromise, cleanup: cleanupForceWaiter } =
      this.createPendingForceStopWaiter(name);
    let timeoutHandle: NodeJS.Timeout | undefined;
    const outcomeObserver = this.createStopPhaseObserver(name);
    const abandonedForceMessage =
      'Force shutdown failed after graceful stop completed';
    // Severity follows the recorded outcome, not whether the deadline fired.
    // Once a failed foreground returns, its released claim alone must not make
    // that real failure look abandoned. Pending attempts may already have lost
    // ownership to late graceful completion before their continuation resumes.
    let forceOutcome: 'pending' | 'failed' | 'abandoned' = 'pending';
    const isSuperseded = (): boolean =>
      this.isForceAttemptSuperseded(name, component, claim) ||
      (this.componentStates.get(name) === 'stopped' &&
        !this.runningComponents.has(name));

    // This attempt's own timeout rejection, so the `catch` can tell it apart from
    // anything `onShutdownForce()` rejects with.
    let forceTimeoutError: Error | undefined;

    try {
      // The value read and checked above, not a second read.
      // Adopted, for the reason `startComponentAttempt()` adopts `start()`'s.
      const forcePromise = adoptPromise(
        applyIntrinsic(onShutdownForce as () => unknown, component, []),
      );

      // Both races attach rejection handlers in this turn, including when the
      // timeout is disabled or graceful completion wins. No separate no-op catch
      // is needed; the outcome observer below adds the abandoned hook's report.
      const delayMS = optionalValidatedTimerDelayMS(timeoutMS);
      if (delayMS !== undefined) {
        const timeoutPromise = new promiseConstructorIntrinsic<never>(
          (_, reject) => {
            timeoutHandle = setTimeout(() => {
              forceTimeoutError = new Error(
                LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
              );
              this.invokeAbortHook(
                component,
                onShutdownForceAborted,
                'onShutdownForceAborted',
                name,
              );

              // Detect if onShutdownForce() eventually resolves after the timeout
              // so the stall can be cleared automatically, same as stop().
              outcomeObserver.observe(
                forcePromise,
                'Force shutdown failed after deadline fired',
                {
                  getReport: () =>
                    forceOutcome === 'abandoned' ||
                    (forceOutcome === 'pending' && isSuperseded())
                      ? { message: abandonedForceMessage, level: 'warn' }
                      : {
                          message: 'Force shutdown failed after deadline fired',
                          level: 'error',
                        },
                  onResolved: () =>
                    this.handleLateStopResolution(
                      name,
                      forceAttemptToken as string,
                      'force',
                    ),
                },
              );
              timeoutHandle = this.rejectAfterTimeoutHook(
                reject,
                forceTimeoutError,
              );
            }, delayMS);
          },
        );

        await racePromises([
          forcePromise,
          timeoutPromise,
          stoppedDuringForcePromise,
        ]);
      } else {
        await racePromises([forcePromise, stoppedDuringForcePromise]);
      }

      if (isSuperseded()) {
        forceOutcome = 'abandoned';
        // Graceful completion won. Report abandoned cleanup failures without
        // changing this or a subsequent run's state.
        // A fired deadline already installed the late-outcome reporter. Keeping
        // both would report the same subsequent hook rejection twice.
        outcomeObserver.observe(forcePromise, abandonedForceMessage);
        return {
          success: true,
          componentName: name,
          status: this.getComponentStatus(name),
        };
      }

      return this.withTransition(() => {
        // Update state - force succeeded
        this.markComponentStopped(name);

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
      });
    } catch (error) {
      if (isSuperseded()) {
        forceOutcome = 'abandoned';
        // A real force rejection can race graceful completion, but this attempt's
        // deadline is not a hook failure. Once the deadline observer is installed,
        // it alone reports any real late rejection, including a same-turn rejection.
        if (forceTimeoutError === undefined || error !== forceTimeoutError) {
          outcomeObserver.reportForeground(error, abandonedForceMessage);
        }
        return {
          success: true,
          componentName: name,
          status: this.getComponentStatus(name),
        };
      }

      forceOutcome = 'failed';
      const err = toError(error);

      // Guarded: `toError` returns a brand-claiming value unchanged, so `.message` can
      // be an accessor that throws. Unguarded, that throw lands on the reason below
      // and skips the whole stall path - the component is never marked stalled and
      // `componentStalled` never fires.
      const message = describeError(err);

      // Determine if timeout or error - by identity, not by message: an
      // `onShutdownForce()` that rejected with the same text is still an error.
      const isTimeout =
        forceTimeoutError !== undefined && error === forceTimeoutError;

      return this.withTransition<ComponentOperationResult>(() => {
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
        this.markComponentStalled(name, stallInfo, err);

        if (isTimeout) {
          this.logger.entity(name).error('Force shutdown timed out - stalled', {
            params: { timeoutMS },
          });
          this.lifecycleEvents.componentShutdownForceTimeout(name, timeoutMS);
        } else {
          outcomeObserver.reportForeground(
            err,
            'Force shutdown failed - stalled: {{error.message}}',
            'error',
          );
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
      });
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
    return this.components.find((c) => this.nameOf(c) === name);
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
      !this.isStarting ||
      this.activeBulkStartup === null ||
      this.activeBulkStartup.isOrdering
    ) {
      return false;
    }

    // Check if any existing component lists this new component as a dependency
    // Guarded: another component's dependency getter must not fail this registration.
    return this.components.some(
      (c) =>
        // Pending follow-ups have no fixed order yet. Their dependencies can still be
        // registered before that batch is frozen; original/planned components cannot.
        !this.deferredAutoStartNames.has(this.nameOf(c)) &&
        dependenciesOf(
          this.currentReadOf(
            c,
            dependencySnapshot,
            this.activeBulkStartup?.dependencyReads,
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
      rolledBackNames.add(name);
      this.logger.entity(name).info('Rolling back component');
      this.lifecycleEvents.componentStartupRollback(name);

      // Shutdown may begin from either rollback notification. It owns teardown
      // and its halt-on-stall policy must not be bypassed by this older startup.
      if (hasShutdownBegun()) {
        return;
      }
      // Retain dependency protection for independently started work, while allowing
      // this rollback to run under the startup latch it already owns.
      const result = await this.stopComponentInternal(name, undefined, {
        operation: 'stop',
        claimed: false,
        isStartupRollback: true,
        hasShutdownBegun,
      });
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
   * component starting or stopping, a late-startup cleanup - since each of those can
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
        !this.detachSignalsOnStop ||
        !this.processSignalManager?.getStatus().isAttached ||
        this.runningComponents.size > 0 ||
        this.stalledComponents.size > 0
      ) {
        return;
      }

      if (this.isSignalDetachWaitingOnTransient(options.isEndingShutdownPass)) {
        this.isSignalDetachDeferred = true;
        return;
      }

      this.isSignalDetachDeferred = false;
      // Detached before the line is logged, not after: logging runs the caller's sinks,
      // and one that starts a startup from here attached nothing - the handlers were still
      // up - so detaching after it pulled them out from under that startup. Worded in the
      // past, and only on success: a failed detach has already said so. Nor once a
      // `signals-detached` listener has attached them again - a startup it began with
      // `attachSignalsBeforeStartup` - where the line would contradict the state.
      if (this.autoDetachSignals(trigger)) {
        this.eventDispatcher.afterNotifications(() => {
          if (this.processSignalManager?.getStatus().isAttached !== true) {
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
    if (this.isSignalDetachDeferred) {
      this.detachSignalsIfIdle(trigger);
    }
  }

  private isSignalDetachWaitingOnTransient(
    isEndingShutdownPass = false,
  ): boolean {
    if (
      this.isStarting ||
      (this.isShuttingDown && !isEndingShutdownPass) ||
      this.pendingBulkStartupCleanup.size > 0
    ) {
      return true;
    }

    for (const name of this.componentStates.keys()) {
      if (this.isComponentInFlight(name)) {
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

  private monitorLateStartupCompletion(
    name: string,
    component: BaseComponent,
    startPromise: Promise<void>,
    startAttemptToken: string,
    claim: symbol,
    wasForcedFromStall: boolean,
  ): void {
    const settlement = this.startSettlements.get(claim);
    if (settlement) {
      settlement.isAwaitingLateStart = true;
    }
    this.logger
      .entity(name)
      .warn('Startup timed out, stopping component if startup completes later');

    // Both callers pass the same adopted promise used by the startup race.
    const recovery = (async (): Promise<void> => {
      try {
        await awaitBoxedPromise(startPromise);
      } catch {
        // observeFailureAfterTimeout() reports a late start() rejection.
        return;
      } finally {
        if (settlement) {
          settlement.isAwaitingLateStart = false;
        }
      }
      try {
        // An abort hook can settle start() inside the timeout callback. Let the
        // timed-out start's catch record its state before beginning late cleanup.
        await promiseResolveIntrinsic(undefined);
        const timeoutState = this.componentStates.get(name);
        const timeoutError = this.componentErrors.get(name) ?? null;

        // A forced start still owes cleanup if the old stalled stop finished first.
        // The instance and startup token must still belong to this attempt.
        if (
          this.getComponent(name) !== component ||
          this.componentStartAttemptTokens.get(name) !== startAttemptToken ||
          this.isComponentRunning(name) ||
          (timeoutState !== 'starting-timed-out' &&
            timeoutState !== 'failed' &&
            !(
              wasForcedFromStall &&
              timeoutState === 'stalled' &&
              this.stalledComponents.has(name)
            ) &&
            !(wasForcedFromStall && timeoutState === 'stopped'))
        ) {
          return;
        }

        // Late startup completed after the manager had already timed out. Mark
        // it running briefly so the normal stop path can clean it up.
        // Lock recovery only while cleanup is actually running. An abandoned
        // start may never settle; the attempt token protects a replacement run.
        this.pendingBulkStartupCleanup.set(name, startAttemptToken);
        this.withTransition(() => {
          const retiredStall = this.stalledComponents.get(name);
          this.markComponentRunning(name);
          // forceStalled already permits overlap with the old stop. A successful
          // late start now needs its own cleanup; announce retirement of the old
          // stall rather than silently losing its terminal notification.
          if (retiredStall) {
            this.lifecycleEvents.componentStalledResolved(
              name,
              retiredStall,
              Date.now() - retiredStall.stalledAt,
              'late-start-cleanup',
            );
          }
        });
        this.logger
          .entity(name)
          .warn(
            'Component completed startup after timeout, stopping automatically',
          );

        // Retirement events and logging can replace this registration. Cleanup
        // and its final state belong only to the start that completed late.
        if (
          this.getComponent(name) !== component ||
          this.componentStartAttemptTokens.get(name) !== startAttemptToken
        ) {
          return;
        }
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

        if (
          this.getComponent(name) !== component ||
          this.componentStartAttemptTokens.get(name) !== startAttemptToken
        ) {
          return;
        }
        // Successful cleanup retired any pre-existing stall from a forced start.
        this.componentStates.set(
          name,
          timeoutState === 'stalled' ? 'starting-timed-out' : timeoutState,
        );
        this.componentErrors.set(name, timeoutError);
      } catch (error) {
        // The recovery body above failed - after the component was marked running, and
        // around the `stopComponentInternal` that exists to stop it. That stop may not
        // have happened, so this is reported, not just logged at debug.
        this.logger
          .entity(name)
          .warn('Late startup completion handling failed', {
            params: { error: toError(error) },
          });
        reportCallbackError('lifecycle-manager late startup cleanup', error);
      } finally {
        if (this.pendingBulkStartupCleanup.get(name) === startAttemptToken) {
          this.pendingBulkStartupCleanup.delete(name);
          try {
            this.runDeferredSignalDetach('late startup cleanup');
          } catch (error) {
            reportCallbackError(
              'lifecycle-manager late startup cleanup finalization',
              error,
            );
          }
        }
      }
    })();
    if (settlement) {
      settlement.recovery = recovery;
      settlement.component = component;
      settlement.token = startAttemptToken;
    }
    // This task floats after the timeout; contain failures in the reporting path.
    observeRejection(recovery, () => {});
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

    let remainingStartedComponents = [...startedComponents];
    let requiredFailure: { name: string; error: Error } | undefined;

    // Optionality getters and reconciliation logs run caller code. They can report
    // a stop for a name that this scan already kept, so one scan is not a stable
    // reconciliation boundary. Drain reports for the surviving names before giving
    // control back to startup. Every repeated scan removes at least one survivor;
    // the original finite list bounds this work even if a sink repeatedly reports
    // an already-consumed name. New registrations belong to the batch queue, and
    // reports for names outside this attempt do not keep this drain alive.
    do {
      const candidates = remainingStartedComponents;
      remainingStartedComponents = [];
      for (const name of candidates) {
        const startupStopError = this.unexpectedStopsDuringStartup.get(name);

        if (startupStopError === undefined) {
          remainingStartedComponents.push(name);
          continue;
        }

        // Consume before invoking optionality or logging. Only pending reports
        // reach those callbacks, once per consumed name, not every reconciliation.
        this.unexpectedStopsDuringStartup.delete(name);

        const error =
          startupStopError ??
          new Error(`Component "${name}" stopped unexpectedly during startup`);
        const component = this.getComponent(name);

        if (component !== undefined && this.isComponentOptional(component)) {
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
    } while (
      remainingStartedComponents.some((name) =>
        this.unexpectedStopsDuringStartup.has(name),
      )
    );

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

  /**
   * Clear a component's unexpected-stop handler, contained. The hook is overridable,
   * and a throw must not skip the operation that clears it. A graceful stop now claims
   * the component before this hook, so re-entry sees the stop in progress; containing
   * a failure still lets stop() run rather than reporting a stall without attempting it.
   */
  private clearUnexpectedStopHandler(
    component: BaseComponent,
    context: string,
  ): void {
    try {
      component._clearUnexpectedStopHandler();
    } catch (error) {
      reportCallbackError(
        `lifecycle-manager ${context} _clearUnexpectedStopHandler`,
        error,
      );
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
   * them. Their registration already answered `autoStartDeferred: true`, and nothing else
   * will start them, so this is the one place that says so. Handed the names, already
   * taken off the set: the warning runs caller code, and the set may by then belong to
   * the next startup.
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

  /**
   * Record a stall: the bookkeeping every path that stalls a component shares. The
   * caller emits `component:stalled` and anything particular to its path.
   *
   * A stop that settles after the stall is recorded clears it through
   * `handleLateStopResolution()`; one released by its own timeout hook never gets here,
   * since its timeout rejects a macrotask later (`rejectAfterTimeoutHook()`).
   */
  private markComponentStalled(
    name: string,
    stallInfo: ComponentStallInfo,
    error?: Error,
  ): void {
    return this.withTransition(() => {
      this.stalledComponents.set(name, stallInfo);
      this.componentStates.set(name, 'stalled');
      this.runningComponents.delete(name);

      if (error !== undefined) {
        this.componentErrors.set(name, error);
      }

      this.updateStartedFlag();
    });
  }

  private markComponentRunning(name: string): void {
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
  }

  /**
   * The bookkeeping every path that finds a component stopped shares: a graceful or
   * force stop that succeeded, and a stalled one that finished late. The caller logs and
   * emits.
   */
  private markComponentStopped(name: string): void {
    return this.withTransition(() => {
      this.componentStates.set(name, 'stopped');
      this.runningComponents.delete(name);
      this.stalledComponents.delete(name);
      // Clear the stall/timeout error so lastError reflects a clean stop.
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
    });
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
    const promise = new promiseConstructorIntrinsic<void>((resolve) => {
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
   *    entry nor the post-graceful-race overlap state, so we bail out.
   */
  private handleLateStopResolution(
    name: string,
    token: string,
    source: 'graceful' | 'force',
    hasGracefulRaceFinished = false,
  ): boolean {
    return this.withTransition(() => {
      // Guard 1: bail if a newer stop attempt has superseded this one. The newer
      // attempt owns any stop/stall state and must manage its own late resolution.
      if (this.componentStopAttemptTokens.get(name) !== token) {
        return false;
      }

      const currentState = this.componentStates.get(name);
      const stallInfo = this.stalledComponents.get(name);

      // Once the graceful race has lost, a successful stop can be finalized before
      // or during force escalation, even without a stall record. Only the caller
      // that consumed the graceful result can admit the pre-force stopping state.
      const isCompletedAfterGracefulRace =
        source === 'graceful' &&
        !stallInfo &&
        (currentState === 'force-stopping' ||
          (hasGracefulRaceFinished && currentState === 'stopping'));

      // Still in flight for this very attempt - it settled as its timeout fired. The
      // attempt decides how it ended: its timeout rejects a macrotask after the hook ran
      // (`rejectAfterTimeoutHook()`), so a stop that settled then wins the race. Ahead of
      // Guard 2, which would take a stalled component's force retry - `force-stopping`,
      // with the old stall entry still in place - for a newer attempt and discard the
      // stall under it.
      if (
        !isCompletedAfterGracefulRace &&
        (currentState === 'stopping' || currentState === 'force-stopping')
      ) {
        return false;
      }

      // Guard 2: once the component is no longer in the stalled state because a
      // newer lifecycle attempt changed its state, the old stop promise no longer
      // owns the component state. Clear the stale stall bookkeeping, but do not
      // emit stopped or overwrite the newer state. It may have been the last stall
      // holding process signals attached, so the last-stop detach check still runs.
      if (stallInfo && currentState !== 'stalled') {
        this.stalledComponents.delete(name);
        this.updateStartedFlag();
        this.detachSignalsAfterLastStop();
        return false;
      }

      // Guard 3: bail if neither a stall entry nor the post-graceful-race overlap
      // exists. This covers unregistered, restarted, or already-cleared paths.
      if (!stallInfo && !isCompletedAfterGracefulRace) {
        return false;
      }

      const stalledDurationMS = stallInfo
        ? Date.now() - stallInfo.stalledAt
        : undefined;

      this.markComponentStopped(name);

      this.logger
        .entity(name)
        .info(
          stallInfo
            ? 'Stalled component completed stop late, stall cleared'
            : hasGracefulRaceFinished
              ? 'Graceful stop completed before force phase started'
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

      this.lifecycleEvents.componentStopped(
        name,
        this.getComponentStatus(name),
      );
      return true;
    });
  }

  private handleComponentUnexpectedStop(
    name: string,
    startAttemptToken: string,
    error?: Error,
  ): boolean {
    return this.withTransition(() => {
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
      const failure = isNullish(error) ? null : toError(error);

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
      // to an otherwise idle application. During a bulk startup the check defers to the
      // startup's end.
      this.detachSignalsAfterLastStop();

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
      this.lifecycleEvents.componentStopped(
        name,
        this.getComponentStatus(name),
      );
      return true;
    });
  }

  private withTransition<T>(operation: () => T): T {
    return this.eventDispatcher.withTransition(operation);
  }

  private safeEmit<K extends LifecycleManagerEventName>(
    event: K,
    data: LifecycleManagerEventMap[K],
  ): void {
    this.eventDispatcher.emit(event, data);
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
      const isSnapshotComplete = this.components.every((component) =>
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
      duringStartup: this.isStarting,
      autoStartAttempted: false,
      startResult: undefined,
    };
  }

  private getComponentIndex(name: string): number | null {
    const idx = this.components.findIndex((c) => this.nameOf(c) === name);
    return idx === -1 ? null : idx;
  }

  private isInstanceReserved(component: BaseComponent): boolean {
    return (
      this.componentEntries.includes(component) ||
      this.rollbackReservations.has(component)
    );
  }

  private isNameReserved(name: string): boolean {
    if (
      this.componentEntries.some((component) => this.nameOf(component) === name)
    ) {
      return true;
    }
    for (const reservedName of this.rollbackReservations.values()) {
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
        : undefined) ?? this.committedDependencyReads.get(component)
    );
  }

  /** Publish the live committed subset after registry mutations, without caller code. */
  private publishRegistry(): void {
    const published = this.componentEntries.filter(
      (component) => !this.pendingRegistrations.has(component),
    );
    if (
      published.length !== this.components.length ||
      published.some((entry, index) => this.components[index] !== entry)
    ) {
      this.components = published;
    }
  }

  private getInsertIndex(
    position: InsertPosition,
    targetComponentName?: string,
  ): number | null {
    if (position === 'start') {
      return 0;
    } else if (position === 'end') {
      return this.componentEntries.length;
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
    const targetIdx = this.componentEntries.indexOf(target);
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
    source: () => BaseComponent[] = () => this.components,
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
   * Dependency-aware startup order.
   *
   * - Only registered components are included.
   * - Missing dependencies are ignored for ordering (they are validated at start time).
   * - Cycles throw DependencyCycleError (programmer error).
   */
  private getStartupOrderInternal(
    components: BaseComponent[] = this.components,
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
            : this.readDependencies(component, 'ordering'),
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
    this.escalationHandlingDepth++;

    try {
      this.lifecycleEvents.signalShutdown(method, false);
    } finally {
      this.escalationHandlingDepth--;
    }
  }

  /**
   * A shutdown signal that lands while a pass is running: noted on the pass, emitted
   * once as already-shutting-down, and counted - or, when no cycle is running yet,
   * made the cycle's initial request.
   */
  private answerShutdownSignalDuringPass(method: ShutdownSignal): void {
    return this.withTransition(() => {
      // Only a restart's stop phase runs without a cycle: it does not seed one. The first
      // signal asking it to stay down is where the operator's shutdown actually begins, so
      // it seeds the cycle - the same as a signal that starts a pass - rather than counting
      // as press one. A restart that inherited a live cycle keeps it, and this signal
      // counts against it.
      const isFirstRequestOfCycle =
        this.repeatedShutdownRequestPolicy !== undefined &&
        this.repeatedShutdownRequestState.firstRequestAt === null;

      this.noteShutdownRequestDuringActivePass();
      if (isFirstRequestOfCycle) {
        // This is a synchronous control checkpoint. Its listeners must find the
        // restart's new shutdown cycle already seeded, rather than seed a competing
        // cycle when they re-enter through another signal or a manual stop.
        this.seedRepeatedShutdownRequestState(method);
      }
      this.lifecycleEvents.signalShutdown(method, true);

      if (isFirstRequestOfCycle) {
        this.logger.info('Shutdown signal received during restart', {
          params: { method },
        });

        return;
      }

      // No window to consume: `acceptShutdownPass()` spends it on the request that starts
      // the pass. A window armed by this very pass - from a listener on its completed
      // event, before the latch comes down - that has already expired is cleared by
      // this call. Either way the request is answered here: falling through would emit
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
        this.repeatedShutdownRequestPolicy !== undefined &&
        this.escalationHandlingDepth === 0;

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

      if (shouldSeedRepeatedShutdownState) {
        this.seedRepeatedShutdownRequestState(method);
      }

      this.logger.info('Shutdown signal received', {
        params: { method },
      });

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

    return { accepted: false, result: refusedShutdownResult() };
  }

  private settleOperation<T>(
    operation: string,
    run: () => Promise<T>,
    toFailure: (error: Error, reason: string) => T,
  ): Promise<T> {
    return settleOperation(operation, run, toFailure);
  }

  private crashedStartupResult(
    error: Error | undefined,
    reason: string,
    durationMS = 0,
  ): StartupResult {
    return crashedStartupResult(error, reason, durationMS);
  }

  /** The shutdown latch: set exactly while a shutdown pass is running. */
  private get isShuttingDown(): boolean {
    return this.activeShutdownPass !== null;
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
    const recordedName = this.registeredNames.get(component);

    return recordedName !== undefined ? recordedName : component.getName();
  }

  /**
   * {@link nameOf} for the registry entry at `index`, or `undefined` when there is none.
   */
  private nameOfAt(index: number): string | undefined {
    const component = this.components[index];

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
   * already lapsed is expired and the request is not counted.
   */
  private handleRepeatedShutdownRequest(
    method: ShutdownMethod,
    consumedArmedUntil: number | null,
  ): void {
    return this.withTransition(() => {
      this.escalationHandlingDepth++;

      try {
        this.handleRepeatedShutdownRequestInner(method, consumedArmedUntil);
      } finally {
        this.escalationHandlingDepth--;
      }
    });
  }

  private handleRepeatedShutdownRequestInner(
    method: ShutdownMethod,
    consumedArmedUntil: number | null,
  ): void {
    const policy = this.repeatedShutdownRequestPolicy;

    if (!policy) {
      // Signals only: a `'manual'` request never reaches here without a policy.
      this.logger.warn('Shutdown already in progress, ignoring signal', {
        params: { method },
      });
      return;
    }

    const now = Date.now();
    const state = this.repeatedShutdownRequestState;

    // Skipped when this request consumed the window on its way in: the caller already
    // checked the deadline before consuming, and refreshing a window that the pass it is
    // about to start would clear again immediately says nothing.
    if (consumedArmedUntil === null && state.remainsArmedUntil !== null) {
      if (now >= state.remainsArmedUntil) {
        this.expireRepeatedShutdownRequestState();
        return;
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
    this.forceHandlingDepth++;

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
      this.forceHandlingDepth--;
    }
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
    return this.withTransition(() => {
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
    const policy = this.repeatedShutdownRequestPolicy;

    if (!policy) {
      return;
    }

    this.clearRepeatedShutdownExpiryTimer();

    const armedUntil = now + policy.armedAfterFailureMS;
    this.repeatedShutdownRequestState.remainsArmedUntil = armedUntil;
    this.repeatedShutdownExpiryTimer = setTimeout(() => {
      this.expireRepeatedShutdownRequestState();
    }, policy.armedAfterFailureMS);
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
    return this.withTransition(() => {
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
          this.settleOperation(
            `${descriptor.signal} broadcast`,
            descriptor.broadcast,
            (error) => crashedSignalBroadcastResult(descriptor.signal, error),
          ),
      );

      if (!outcome.success) {
        return crashedSignalBroadcastResult(descriptor.signal, outcome.error);
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
        customCallback: this.onReloadRequested,
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
        customCallback: this.onInfoRequested,
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
        customCallback: this.onDebugRequested,
        broadcast: () => this.broadcastDebug(),
      },
      source,
    );
  }

  private runSignalBroadcast(
    descriptor: SignalBroadcastDescriptor,
  ): Promise<SignalBroadcastResult> {
    return runSignalBroadcast(this.componentAccess, descriptor);
  }

  /**
   * Broadcast reload signal to all running components.
   * Calls onReload() on components that implement it.
   * Continues on errors - collects all results.
   */
  private async broadcastReload(): Promise<SignalBroadcastResult> {
    return await this.runSignalBroadcast({
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
  private async broadcastInfo(): Promise<SignalBroadcastResult> {
    return await this.runSignalBroadcast({
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
  private async broadcastDebug(): Promise<SignalBroadcastResult> {
    return await this.runSignalBroadcast({
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
