import { ulid } from 'ulid';
import { isNullish } from '../../internal/is-nullish';
import { adoptPromise } from '../../internal/adopt-promise';
import {
  attachIntrinsicReactions,
  noop,
  observeRejection,
  queueMicrotaskSafely,
} from '../../internal/intrinsics';
import { optionalValidatedTimerDelayMS } from '../../internal/timer-limits';
import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import {
  LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
} from '../constants';
import {
  ComponentStartTimeoutError,
  StartupInterruptedByShutdownError,
} from '../errors';
import type { ComponentOperationResult, ComponentState } from '../types';
import type { DependencyRead } from './dependency-policy';
import { abortHookSignal, createHookAbortController } from './hook-abort';
import type { ManagerCore } from './manager-core';
import type { StartSettlement } from './manager-state';
import {
  crashedComponentResult,
  isLinkedToAbort,
  observeFailureAfterTimeout,
  takeSettledFailureCode,
  toOperationFlag,
  toOperationTimerDelayMS,
} from './operation-policy';
import {
  DEFAULT_START_OPTIONS,
  type StartOptionsSnapshot,
} from './operation-options';

/** The running registration and start options approved before restart stops it. */
export interface RestartStartSnapshot {
  readonly component: BaseComponent;
  readonly generation: number | undefined;
  readonly timeoutMS: number;
  readonly ownsLateStartCleanup: boolean;
}

/**
 * A start's options: a snapshot already taken, or - for a public `startComponent()` - the
 * read that takes it, which the start makes first, under its own net.
 */
type StartOptionsInput = StartOptionsSnapshot | (() => StartOptionsSnapshot);

/**
 * The per-component start pipeline: the net under every start, the checks a start makes
 * before it may claim its component, the attempt itself - `start()` raced against its
 * deadline - and the bookkeeping it leaves: the start settlements that track a start
 * and the cleanup it owns, and the component marked running.
 *
 * Every per-component start runs through here: `startComponent()`, a bulk startup's
 * loop, a registration's auto-start, and a restart's start. Those callers own their bulk
 * policy and pass it in; claims are taken through `core.claims`, and a start that must
 * be undone again is stopped through `core.componentStop`. A start the manager stops
 * waiting for is handed to `core.lateStartRecovery`, and a running component's
 * unexpected-stop handler comes from `core.unexpectedStops`. Signal attachment is still
 * the manager's, reached through `core.internals`.
 */
export class ComponentStart {
  constructor(private readonly core: ManagerCore) {}

  /**
   * `startComponentAttempt()` with a net under it that settles the component's state.
   *
   * The attempt validates its timeout before claiming `starting`, but later work
   * still runs component-owned handlers and not all of that sits inside the attempt's own
   * `try`. The public safety net would still answer with `operation_crashed`, but it cannot
   * see the component, which stayed `starting` for good: every later start answered
   * `component_already_starting`. A start that crashes before the component is running
   * is put back to the state it had before the attempt; one already running is stopped
   * again, since a failed start means a component that is not running.
   */
  public async startComponentInternal(
    name: string,
    options?: StartOptionsInput,
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
    let resolveRawStart!: () => void;
    let abandon!: () => void;
    const finishSettlement = (): void => {
      settlement.didSettle = true;
      // An aborted start may not have actually settled raw startup. Keep its
      // dependency protection until that work finishes or ownership is released.
      if (!settlement.rawStartPending) {
        this.deleteStartSettlement(claim);
      }
      resolveSettlement();
    };
    const settlement: StartSettlement = {
      name,
      finish: () => {
        // Released ownership ends the raw start for every holder of this settlement,
        // not only the registry: a pass that captured it must stop protecting for it.
        settlement.rawStartPending = false;
        finishSettlement();
        this.deleteStartSettlement(claim);
        resolveRawStart();
      },
      abandon: () => abandon(),
      abandoned: new Promise<void>((resolve) => {
        abandon = resolve;
      }),
      didSettle: false,
      rawStartPending: false,
      rawStartDone: new Promise<void>((resolve) => {
        resolveRawStart = resolve;
      }),
      settleRawStart: () => {
        settlement.rawStartPending = false;
        resolveRawStart();
      },
      promise: new Promise<void>((resolve) => {
        resolveSettlement = resolve;
      }),
    };
    this.addStartSettlement(claim, settlement);

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
        // One rule for every failure below, as `settleOperation()` applies it: our own
        // option refusal, met before this attempt claimed the component, is a refusal -
        // `invalid_options`, not reported. Anything after the claim is a crash, branded
        // or not: the attempt has already acted, so it is reported and answered
        // `operation_crashed`, never both reported and called a refusal. The brand is
        // dropped either way: a bulk startup logs the result's error and announces it
        // to listeners before it settles.
        if (
          takeSettledFailureCode(error) === 'invalid_options' &&
          !this.core.state.claimsTaken.has(claim)
        ) {
          return crashedComponentResult(
            name,
            error as Error,
            `Start refused: ${describeError(error)}`,
            'invalid_options',
          );
        }

        // Nothing below touches the component unless this attempt claimed it - and still
        // holds that claim. An attempt that crashed before claiming, while another start
        // or stop got in across an `await`, must leave that other one's work alone.
        const doesOwnComponent = this.core.claims.owns(name, claim);

        // A crash after this attempt marked the component running - building its status
        // for the result, say - still fails the start, so it is stopped again: a failed
        // start means a component that is not running, which is what every caller,
        // bulk rollback included, acts on.
        if (doesOwnComponent && this.core.state.runningComponents.has(name)) {
          reportCallbackError('lifecycle-manager component start', error);

          const stopResult =
            await this.core.componentStop.stopComponentInternal(name);

          return crashedComponentResult(
            name,
            toError(error),
            `Start failed unexpectedly after the component was running: ${describeError(error)}; ${
              stopResult.success
                ? 'component stopped again'
                : `stopping it again also failed: ${stopResult.reason ?? 'unknown reason'}`
            }`,
            'operation_crashed',
          );
        }

        // Back to the state it had before this attempt claimed it - `registered`,
        // `stopped`, `failed` - so a crashed retry does not erase that history from the
        // status APIs.
        if (
          doesOwnComponent &&
          this.core.state.componentStates.get(name) === 'starting' &&
          !this.core.state.runningComponents.has(name)
        ) {
          this.restoreStateAfterFailedStart(
            name,
            this.core.state.componentClaims.get(name)?.previousState,
          );

          // The attempt's own `finally` ran while it still held `starting`, so a detach
          // it would have run is still waiting.
          this.core.internals.runDeferredSignalDetach('component startup');
        }

        reportCallbackError('lifecycle-manager component start', error);

        return crashedComponentResult(
          name,
          toError(error),
          `Start failed unexpectedly: ${describeError(error)}`,
          'operation_crashed',
        );
      }
    } finally {
      this.core.state.claimsTaken.delete(claim);
      try {
        this.core.claims.release(name, claim);
      } finally {
        if (settlement.recovery) {
          void settlement.recovery.then(finishSettlement, finishSettlement);
        } else {
          finishSettlement();
        }
      }
    }
  }

  /**
   * The start settlements that still describe each component's current start: the
   * attempt holding its claim, or the registration and attempt token it last ran under.
   * Keyed by name. Shared by the shutdown pass and restart's preflight so the two agree
   * on which starts are current.
   */
  public currentStartSettlements(): Map<string, StartSettlement> {
    const currentStarts = new Map<string, StartSettlement>();
    for (const [claim, settlement] of this.core.state.startSettlements) {
      if (
        this.core.state.componentClaims.get(settlement.name)?.claim === claim ||
        (settlement.component !== undefined &&
          this.core.registry.getComponent(settlement.name) ===
            settlement.component &&
          this.core.state.componentStartAttemptTokens.get(settlement.name) ===
            settlement.token)
      ) {
        currentStarts.set(settlement.name, settlement);
      }
    }
    return currentStarts;
  }

  /**
   * Release every start settlement of `name` but the one `exceptClaim` holds: each ends
   * the raw start it tracks for whoever captured it, not only in the registry.
   */
  public releaseStartSettlements(name: string, exceptClaim?: symbol): void {
    const exceptSettlement =
      exceptClaim === undefined
        ? undefined
        : this.core.state.startSettlements.get(exceptClaim);
    for (const settlement of this.core.state.startSettlementsByName.get(name) ??
      []) {
      if (settlement !== exceptSettlement) {
        settlement.finish();
      }
    }
  }

  /** Whether a `start()` of the current registration of `name` has not settled yet. */
  public isRawStartPending(name: string): boolean {
    const settlements = this.core.state.startSettlementsByName.get(name);
    if (settlements === undefined) {
      return false;
    }
    const component = this.core.registry.getComponent(name);
    for (const settlement of settlements) {
      if (
        settlement.rawStartPending &&
        (settlement.component === undefined ||
          settlement.component === component)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Mark a component running whose start may have been forced past a stall: the new run
   * supersedes the old stop, so its stall record goes, and with it that stop's token -
   * a late settlement of the old stop must not own this run's state. The retirement is
   * announced as every other way a stall ends is, so a `component:stalled` observer
   * always sees it end. For use inside a transition, which queues the notification.
   */
  public markStartRunning(
    name: string,
    isForcedStart: boolean,
    // `late-start-cleanup` when a timed-out start came up late and is about to be
    // stopped again; see `component:stalled-resolved`.
    retirementReason: 'forced-start' | 'late-start-cleanup' = 'forced-start',
  ): void {
    const retiredStall = this.core.state.stalledComponents.get(name);
    if (retirementReason !== 'late-start-cleanup') {
      this.core.state.lateStartCleanupOutcomes.delete(name);
    }
    if (isForcedStart) {
      this.core.componentStop.issueStopAttemptToken(name);
    }
    this.markComponentRunning(name);
    if (retiredStall !== undefined) {
      this.core.lifecycleEvents.componentStalledResolved(
        name,
        retiredStall,
        Date.now() - retiredStall.stalledAt,
        retirementReason,
      );
    }
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
    flags: StartOptionsSnapshot,
    // On the check before the claim: the instance the attempt read, which must still be
    // the one registered under `name` - it may have been unregistered, or replaced by
    // another, while its code ran.
    expected?: BaseComponent,
  ):
    | ComponentOperationResult
    | { component: BaseComponent; currentState: ComponentState | undefined } {
    // A timed-out bulk start owns the component until it settles and cleanup ends.
    // Answered as the stop refuses it, and as `startAllComponents()` lists it: that
    // ownership exists to tear the late start down, so `component_already_starting`
    // told a caller to expect the component up - and the two calls disagreed over the
    // same condition.
    if (this.core.state.pendingBulkStartupCleanup.has(name)) {
      return {
        success: false,
        componentName: name,
        code: 'component_already_stopping',
        reason: LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
        status: this.core.manager.getComponentStatus(name),
      };
    }
    // ALWAYS reject during shutdown (never bypass this check)
    if (this.core.shutdownPass.isShuttingDown) {
      this.core.logger
        .entity(name)
        .warn('Cannot start component during shutdown', {
          params: { isShuttingDown: this.core.shutdownPass.isShuttingDown },
        });

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        code: 'shutdown_in_progress',
      };
    }

    // ALWAYS reject once a logger exit has committed the process to ending, or while a
    // simulated one is still closing the sinks
    if (this.core.loggerExit.isLoggerExitInProgress()) {
      this.core.logger
        .entity(name)
        .warn('Cannot start component: process is exiting');

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
        code: 'shutdown_in_progress',
      };
    }

    // Reject during bulk startup (unless allowDuringBulkStartup is enabled)
    if (!flags.allowDuringBulkStartup && this.core.state.isStarting) {
      this.core.logger
        .entity(name)
        .warn('Cannot start component during bulk startup', {
          params: { isStarting: this.core.state.isStarting },
        });

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
        code: 'startup_in_progress',
      };
    }

    // The committed name index also verifies the captured registration's identity.
    const registered = this.core.registry.getComponent(name);
    const component =
      expected === undefined || registered === expected
        ? registered
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
    if (!flags.forceStalled && this.core.state.stalledComponents.has(name)) {
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
        code: 'component_stalled',
        status: this.core.manager.getComponentStatus(name),
      };
    }

    // Ahead of the dependency checks: a component already running, starting or stopping
    // answers as such, whatever its dependency list says now. Checked after them, a
    // running component whose list had since broken failed instead - and a bulk startup
    // took that for a required failure and rolled back everything else.
    const currentState = this.core.state.componentStates.get(name);
    if (currentState === 'starting') {
      return {
        success: false,
        componentName: name,
        reason: 'Component already starting',
        code: 'component_already_starting',
        status: this.core.manager.getComponentStatus(name),
      };
    }

    if (currentState === 'stopping' || currentState === 'force-stopping') {
      return {
        success: false,
        componentName: name,
        reason: `Component is already ${currentState}`,
        code: 'component_already_stopping',
        status: this.core.manager.getComponentStatus(name),
      };
    }

    // Check if already running
    if (this.core.manager.isComponentRunning(name)) {
      return {
        success: false,
        componentName: name,
        reason: 'Component already running',
        code: 'component_already_running',
        status: this.core.manager.getComponentStatus(name),
      };
    }

    return { component, currentState };
  }

  /**
   * The start itself, under `startComponentInternal()`'s net - bypasses bulk operation checks
   * Used by both startComponent() and startAllComponents()
   */
  private async startComponentAttempt(
    name: string,
    options: StartOptionsInput | undefined,
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
    // Each option read once, before anything else: the checks below run twice, and a
    // caller's getter that answered differently the second time - `forceStalled` true
    // for the stalled check, false where a forced start retires the stalled run's late
    // stop - split the start. A public start's read is deferred to here, so a getter
    // that throws fails under this start's net, as every other early failure does.
    const flags =
      typeof options === 'function'
        ? options()
        : (options ?? DEFAULT_START_OPTIONS);

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
    const staleBeforeReads = this.core.restart.refuseStaleRestartSnapshot(
      name,
      restartSnapshot,
    );
    if (staleBeforeReads !== undefined) {
      return staleBeforeReads;
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
        ? this.core.registryReads.readGeneration(
            startupDependencyReads,
            component,
          )
        : this.core.registryReads.currentGeneration(component);
    const ownDependencies =
      preReadDependencies ??
      this.core.componentMetadata.readDependenciesReported(component, 'start');

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
        status: this.core.manager.getComponentStatus(name),
      };
    }

    // Read only where it decides something: a dependency that is not up, and only
    // without the override, which ignores the answer. One that stops after this read
    // has no answer and is held to required below - the conservative reading. Kept by
    // registration: the same instance can be unregistered and registered again while
    // its optionality is read, so instance identity alone does not keep the answer
    // current.
    const optionalDependencies = new Map<
      string,
      { component: BaseComponent; generation: number | undefined }
    >();

    if (!flags.allowNonRunningDependencies) {
      for (const dependencyName of ownDependencies.dependencies) {
        const dependency = this.core.registry.getComponent(dependencyName);

        if (
          dependency !== undefined &&
          !this.core.internals.isComponentUp(dependencyName)
        ) {
          const generation =
            this.core.registryReads.currentGeneration(dependency);
          if (this.core.componentMetadata.isComponentOptional(dependency)) {
            optionalDependencies.set(dependencyName, {
              component: dependency,
              generation,
            });
          }
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
    // to a Node process - and skipped the late-completion monitor as well. Validated
    // like the timeout: anything but a boolean is refused (`invalid_options`).
    const doesOwnLateStartCleanup =
      restartSnapshot?.ownsLateStartCleanup ??
      toOperationFlag(
        component.ownsLateStartCleanup,
        `${name}.ownsLateStartCleanup`,
      );

    // From here to the claim, nothing runs the component's code - logging included,
    // since the logger is the caller's too: the warnings wait until the claim is made.
    const recheck = this.checkStartPreconditions(name, flags, component);

    if ('success' in recheck) {
      return recheck;
    }
    const staleBeforeClaim = this.core.restart.refuseStaleRestartSnapshot(
      name,
      restartSnapshot,
    );
    if (staleBeforeClaim !== undefined) {
      return staleBeforeClaim;
    }
    // The same instance may have been unregistered and registered again by one of the
    // component-owned reads above. Its old dependency list and optionality answers no
    // longer describe the registration this start would claim.
    if (
      this.core.registryReads.currentGeneration(component) !==
      dependencyGeneration
    ) {
      return {
        success: false,
        componentName: name,
        reason: `Component "${name}" was re-registered while its start was being prepared`,
        code: 'component_not_found',
      };
    }

    const skippedDependencyWarnings: string[] = [];

    for (const dependencyName of ownDependencies.dependencies) {
      const dependency = this.core.registry.getComponent(dependencyName);

      if (dependency === undefined) {
        return {
          success: false,
          componentName: name,
          reason: `Missing dependency "${dependencyName}"`,
          code: 'missing_dependency',
          status: this.core.manager.getComponentStatus(name),
        };
      }

      if (this.core.internals.isComponentUp(dependencyName)) {
        continue;
      }

      if (flags.allowNonRunningDependencies) {
        // Explicit override - allow skipping both optional and required dependencies
        skippedDependencyWarnings.push(
          `Starting with non-running dependency "${dependencyName}" (allowNonRunningDependencies=true)`,
        );
        continue;
      }

      const optionalDependency = optionalDependencies.get(dependencyName);
      if (
        optionalDependency?.component === dependency &&
        optionalDependency.generation ===
          this.core.registryReads.currentGeneration(dependency)
      ) {
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
        status: this.core.manager.getComponentStatus(name),
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
      // The claim held `starting`, so a detach requested by caller code that ran under
      // it - the warnings, the attach's own log and listeners, removing the last running
      // or stalled component - waited on this attempt, as the crash path's does.
      this.core.internals.runDeferredSignalDetach('component startup');
    };

    this.core.claims.take(name, 'starting', claim);
    // The previous run's handler is still keyed to its token, which this attempt only
    // replaces after the logs and listeners below run caller code. A reporter kept from
    // that run and called there would otherwise end this start as its unexpected stop.
    this.core.unexpectedStops.clearUnexpectedStopHandler(component, 'start');

    for (const warning of skippedDependencyWarnings) {
      this.core.logger.entity(name).warn(warning);
    }

    const shutdownTokenBeforeAttach = this.core.state.shutdownToken;
    const componentSignalAttach = this.core.config.attachSignalsBeforeStartup
      ? this.core.internals.autoAttachSignals('component startup')
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
      this.core.shutdownPass.isShuttingDown ||
      this.core.state.shutdownToken !== shutdownTokenBeforeAttach
    ) {
      restoreStateBeforeStart();

      if (didAutoAttachSignalsForComponentStartup) {
        this.core.internals.detachSignalsIfIdle('refused component startup');
      }

      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        code: 'shutdown_in_progress',
      };
    }

    // The unexpected-stop record from the previous run is cleared once the attach checks
    // are past: that flag describes a stop that already happened, and a start that
    // reads it later would take an old failure for a new one.
    this.core.state.componentUnexpectedStopHadError.delete(name);
    const shutdownTokenAtStart = shutdownTokenBeforeAttach;
    this.core.logger.entity(name).info('Starting component');

    // Taken before the starting log and event, not after: a listener there that calls
    // `stopAllComponents()` starts a pass this start must notice, so the component is
    // sent through the stop pipeline once `start()` settles rather than coming up after
    // the shutdown.
    this.core.lifecycleEvents.componentStarting(name);

    const remainingBudget =
      bulkStartup === undefined
        ? undefined
        : Math.max(1, bulkStartup.deadline - Date.now());
    const useBulkDeadline =
      remainingBudget !== undefined &&
      (componentTimeout === 0 || remainingBudget <= componentTimeout);
    const timeoutMS = useBulkDeadline ? remainingBudget : componentTimeout;
    const startAttemptToken = ulid();
    this.core.state.componentStartAttemptTokens.set(name, startAttemptToken);
    this.releaseStartSettlements(name, claim);
    const settlement = this.core.state.startSettlements.get(claim);
    if (settlement) {
      settlement.component = component;
      settlement.token = startAttemptToken;
    }

    let timeoutHandle: NodeJS.Timeout | undefined;
    let startupTimeoutError: ComponentStartTimeoutError | undefined;
    // What first aborted this attempt's start signal: its deadline, or a shutdown pass's
    // `abortPendingStarts` cue. The signal aborts once; the cause decides how a failure
    // of `start()` after that is answered.
    let startAbortCause: 'timeout' | 'shutdown' | undefined;
    // The reason a shutdown's cue aborted the signal with: a failure linked to it is the
    // interruption that cue asked for, not a failed start (see `isLinkedToAbort()`).
    let shutdownAbortReason: StartupInterruptedByShutdownError | undefined;
    // What the `finally` names a detach of the signals this start attached after:
    // only a failure is a failed startup. Set by the paths that end otherwise.
    let detachTrigger = 'failed component startup';
    // Whether the failure is `start()`'s own - `error` - rather than the attempt's own
    // bookkeeping crashing around it - `operation_crashed`.
    let didStartHookFail = false;
    // Set once `start()` has resolved: the component holds whatever it brought up.
    let didStartResolve = false;
    // Another attempt or registration owns the name now: the component reported an
    // unexpected stop and a listener started it again, or it was replaced or
    // unregistered after stopping. Asked at each boundary caller code may have crossed.
    const isSuperseded = (): boolean =>
      this.core.registry.getComponent(name) !== component ||
      this.core.state.componentStartAttemptTokens.get(name) !==
        startAttemptToken;
    // Names what superseded the attempt rather than always claiming a restart: a
    // replacement or an unregistration is not one.
    const supersededReason = (): string => {
      const current = this.core.registry.getComponent(name);
      return current === undefined
        ? 'Component stopped unexpectedly during startup and was unregistered'
        : current !== component
          ? 'Component stopped unexpectedly during startup and was replaced'
          : 'Component stopped unexpectedly during startup and was started again';
    };

    try {
      // Inside the `try`, so a failure here is a failed start like any other - reported
      // with `component:start-failed`, and its auto-attached signals detached.
      component._setUnexpectedStopHandler(
        this.core.unexpectedStops.createUnexpectedStopHandler(
          name,
          startAttemptToken,
        ),
      );

      // All refusal points and the overridable handler setup are past. Only now
      // record this accepted start, with its registration generation; failed attach
      // or shutdown checks must not change the pass's dependency facts.
      if (
        startupDependencyReads ===
          this.core.state.activeBulkStartup?.dependencyReads &&
        startupDependencyReads !== undefined
      ) {
        this.core.registryReads.recordRead(
          startupDependencyReads,
          component,
          ownDependencies,
          dependencyGeneration,
        );
      }
      // One controller per attempt, its signal handed to `start()`. Aborted only where
      // the manager stops waiting on this attempt's still-pending `start()` - the timer
      // below - never because `start()` settled, either way. Guarded before `start()`
      // sees it, so a listener the component adds cannot throw out of that abort.
      const startAbort = createHookAbortController(name, 'start');
      if (settlement) {
        settlement.interruptStart = (reason): boolean => {
          if (startAbortCause !== undefined || !settlement.rawStartPending) {
            return false;
          }
          startAbortCause = 'shutdown';
          shutdownAbortReason = reason;
          abortHookSignal(startAbort, reason, name, 'start');
          return true;
        };
      }
      // Race against timeout
      // Adopted, not raced as it is: a native promise carrying its own no-op `then`
      // never settled the race, and its rejection went unhandled. See `adoptPromise()`.
      let startPromise: Promise<unknown>;
      // Read before `start()` runs: a shutdown it requests itself is left to it (see
      // `interruptPendingStarts()`), so only a pass already running by then counts below.
      const startAbortRequest = this.core.state.pendingStartAbortRequest;
      const shutdownTokenBeforeStartHook = this.core.state.shutdownToken;
      if (settlement) {
        this.core.state.invokingStarts.add(settlement);
      }
      // A `start` getter that throws has not run `start()`: it is a crash of this
      // attempt (`operation_crashed`, reported), not a failed hook (`error`).
      let didReadStartHook = false;
      let didRawStartObservationFail = false;
      try {
        if (settlement) {
          settlement.rawStartPending = true;
        }
        const startHook: unknown = Reflect.get(component, 'start');
        didReadStartHook = true;
        const rawStart = Reflect.apply(
          startHook as (signal: AbortSignal) => void | Promise<void>,
          component,
          [startAbort.signal],
        );
        const markRawStartSettled = (): void => {
          if (settlement) {
            settlement.settleRawStart();
            if (settlement.didSettle) {
              this.deleteStartSettlement(claim);
            }
          }
        };
        let adoptionFailure: { error: unknown } | undefined;
        // Marked settled by the reaction that settles the adopted promise, before the
        // race below or any late-cleanup observer hears of it.
        startPromise = adoptPromise(rawStart, {
          onObservationFailure: (error) => {
            adoptionFailure = { error };
          },
          onSettled: settlement ? markRawStartSettled : undefined,
        });
        if (settlement) {
          if (adoptionFailure) {
            observeRejection(startPromise, noop);
            // Failing to observe start() does not mean it settled. Keep ownership of
            // its resources and dependencies, and retry attachment once through a
            // manager-owned promise. A permanently broken constructor/species may
            // refuse this too; then ownership must remain pending rather than falsely
            // announcing that the still-running hook finished.
            didRawStartObservationFail = true;
            settlement.didFailRawStartObservation = true;
            const recoveryStart = new Promise<void>((resolve, reject) => {
              try {
                attachIntrinsicReactions(
                  rawStart as object,
                  () => {
                    markRawStartSettled();
                    resolve();
                  },
                  (reason) => {
                    markRawStartSettled();
                    // Preserve the raw hook's arbitrary rejection value.
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
                    reject(reason);
                  },
                );
              } catch {
                // The public result carries the original observation failure.
              }
            });
            this.core.lateStartRecovery.monitorLateStartupCompletion(
              name,
              recoveryStart,
              startAttemptToken,
              claim,
              stateBeforeStart === 'stalled',
              isSuperseded,
              'observation-failed',
            );
            settlement.abandon();
            // The manager has stopped waiting, just as on timeout. Notify the hook
            // even when a broken constructor prevented arming the startup race.
            abortHookSignal(
              startAbort,
              toError(adoptionFailure.error),
              name,
              'start',
            );
            observeFailureAfterTimeout(
              this.core.logger,
              recoveryStart,
              name,
              'start() failed after its observation failed',
            );
            throw adoptionFailure.error;
          }
          // Later setup can fail before it installs the deadline wait.
          observeRejection(startPromise, noop);
        }
      } catch (error) {
        if (!didRawStartObservationFail) {
          settlement?.settleRawStart();
        }
        didStartHookFail = didReadStartHook;
        throw error;
      } finally {
        if (settlement) {
          this.core.state.invokingStarts.delete(settlement);
        }
      }

      // A pass with `abortPendingStarts` that began after the claim - from caller code
      // this attempt ran since: the warnings, the starting log or event, the
      // unexpected-stop handler - found no `interruptStart()` here yet and skipped this
      // start, then waited on it. Its cue is delivered now that `start()` has the signal,
      // unless its own lifecycle handle requested the pass. A starting listener can
      // use that handle before the hook runs; it still counts as a requesting start.
      //
      // A microtask later, queued after `markRawStartSettled` above: a `start()` that
      // settled synchronously has cleared `rawStartPending` by then, and a settled start
      // is not aborted.
      if (
        settlement !== undefined &&
        startAbortRequest !== undefined &&
        startAbortRequest.shutdownToken === shutdownTokenBeforeStartHook &&
        shutdownTokenAtStart !== shutdownTokenBeforeStartHook &&
        !startAbortRequest.requestingStarts.has(settlement)
      ) {
        const deliverShutdownCue = (): void => {
          try {
            if (
              settlement.interruptStart?.(
                new StartupInterruptedByShutdownError({
                  componentName: name,
                  method: startAbortRequest.method,
                }),
              ) === true
            ) {
              this.core.logger
                .entity(name)
                .info('Aborted pending start for shutdown');
            }
          } catch (error) {
            // Nothing above this microtask would catch it.
            reportCallbackError('lifecycle-manager start shutdown cue', error);
          }
        };
        queueMicrotaskSafely(deliverShutdownCue);
      }

      // Both ways a deadline can win - this attempt's timer, and a bulk deadline found
      // expired once `start()` resolved - answer with the same timeout and hand the
      // still-unowned start to the same late cleanup.
      const recordStartupTimeout = (): ComponentStartTimeoutError => {
        startupTimeoutError = new ComponentStartTimeoutError({
          componentName: name,
          timeoutMS,
        });
        return startupTimeoutError;
      };
      const monitorLateStart = (): void => {
        this.core.lateStartRecovery.monitorLateStartupCompletion(
          name,
          startPromise,
          startAttemptToken,
          claim,
          stateBeforeStart === 'stalled',
          isSuperseded,
        );
      };

      const delayMS = optionalValidatedTimerDelayMS(timeoutMS);
      if (delayMS !== undefined) {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            // Settle before notifications: user callbacks cannot swallow the deadline.
            const timeoutError = recordStartupTimeout();
            reject(timeoutError);
            // Recorded before any caller code below runs: a shutdown a sink starts
            // with `abortPendingStarts` must find this start already timed out, not
            // abort it as interrupted. A shutdown that aborted it first keeps its cause.
            startAbortCause ??= 'timeout';
            // This attempt must settle, but its old deadline must not abort or
            // announce a timeout for a newer run of the same component. Its own
            // signal is still aborted: that is this attempt's alone, and nothing
            // waits on this `start()` any more.
            if (isSuperseded()) {
              observeFailureAfterTimeout(
                this.core.logger,
                startPromise,
                name,
                'Superseded start() failed after its deadline',
              );
              abortHookSignal(startAbort, timeoutError, name, 'start');
              return;
            }
            if (useBulkDeadline) {
              bulkStartup?.onTimeout();
            }
            // A component that owns its late-start cleanup undoes a late success of
            // its own timed-out start itself; a bulk deadline cleans up regardless.
            if (useBulkDeadline || !doesOwnLateStartCleanup) {
              monitorLateStart();
              // Only this timer path abandons an unresolved start. The other
              // monitor call handles an already fulfilled start and must join cleanup.
              settlement?.abandon();
            }
            // After the bookkeeping above, so abort listeners (the component's code)
            // find the abandonment and any late cleanup already arranged. Aborted
            // even when those sinks superseded the attempt: the signal is only this
            // attempt's. A shutdown that already aborted it keeps its reason;
            // aborting again does nothing.
            abortHookSignal(startAbort, timeoutError, name, 'start');

            observeFailureAfterTimeout(
              this.core.logger,
              startPromise,
              name,
              'start() failed after it had already timed out',
            );
          }, delayMS);
        });

        try {
          await Promise.race([startPromise, timeoutPromise]);
        } catch (error) {
          // Before the timer fires its error is `undefined`, which a start() may
          // reject with too.
          didStartHookFail =
            startupTimeoutError === undefined || error !== startupTimeoutError;
          throw error;
        }
      } else {
        try {
          await startPromise;
        } catch (error) {
          didStartHookFail = true;
          throw error;
        }
      }
      didStartResolve = true;

      // The startup deadline no longer applies once start() has settled.
      clearTimeout(timeoutHandle);

      // Superseded while `start()` ran: the component reported an unexpected stop from
      // inside it, and a `component:unexpected-stop` listener started it again. That
      // newer attempt owns the state now, whether it worked or not, so this one must not
      // mark the component running over it - nor clear the unexpected-stop handler it
      // installed.
      if (isSuperseded()) {
        return {
          success: false,
          componentName: name,
          reason: supersededReason(),
          code: 'component_unexpected_stop',
          status: this.core.manager.getComponentStatus(name),
        };
      }

      // A component can self-report an unexpected stop from inside start()
      // before the manager has promoted it to running. If that happened, do
      // not fall through into the normal success path and resurrect it. Still this
      // attempt's: the check above returned otherwise, and no caller code ran since.
      if (this.hasStoppedUnexpectedlyDuringStart(name)) {
        this.core.unexpectedStops.clearUnexpectedStopHandler(
          component,
          'start',
        );
        const error =
          this.core.state.componentErrors.get(name) ??
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
          status: this.core.manager.getComponentStatus(name),
        };
      }

      // If shutdown began while start() was in flight, treat the component as
      // running long enough to send it through the normal stop pipeline.
      if (
        this.core.shutdownPass.isShuttingDown ||
        shutdownTokenAtStart !== this.core.state.shutdownToken
      ) {
        this.core.dispatcher.withTransition(() => {
          this.core.state.componentErrors.set(name, null);
          // A new run, as on the success path below: a forced start retires the old
          // stall and its stop token before this stop takes the component over.
          this.markStartRunning(name, flags.forceStalled);
          // Announced as started, as the signal-attach rollback below announces its
          // component before stopping it: observers see an ordinary start followed by
          // a stop. Without it, `component:stopping` / `component:stopped` arrived for
          // a component whose `component:starting` never ended in `started`.
          this.core.lifecycleEvents.componentStarted(
            name,
            this.core.manager.getComponentStatus(name),
          );
        });
        detachTrigger = 'interrupted component startup';
        // The pass this stop is for, read before the log below runs caller code.
        const shutdownPass = this.core.state.activeShutdownPass;
        this.core.logger
          .entity(name)
          .warn(
            'Component finished starting after shutdown began, stopping immediately',
          );

        // A stop that fails here - an invalid shutdown timeout, say - leaves the
        // component up with no start owning it, so the result says so rather than
        // answer only that shutdown began. Not when the `started` listeners or the log
        // above already took it down - an unexpected stop it reported there - or began
        // stopping it: there is nothing left to stop, or that stop owns it, and stopping
        // it again only failed as not running or already stopping.
        const stopResult = this.core.internals.isComponentUp(name)
          ? await this.core.componentStop.stopComponentInternal(name)
          : undefined;
        // A refusal is the pass's to report, as one its own stop met would be: the
        // component is left up either way, whichever path reached its stop first.
        if (
          stopResult?.code === 'invalid_options' &&
          shutdownPass !== null &&
          !shutdownPass.invalidOptionsRefusals.has(name)
        ) {
          shutdownPass.invalidOptionsRefusals.set(name, stopResult.error);
        }
        const shutdownReason = 'Shutdown triggered during component startup';

        return {
          success: false,
          componentName: name,
          reason:
            stopResult === undefined || stopResult.success
              ? shutdownReason
              : `${shutdownReason}; stopping it again failed: ${stopResult.reason ?? 'unknown reason'}`,
          code: 'shutdown_in_progress',
          error: stopResult?.error,
          status: this.core.manager.getComponentStatus(name),
        };
      }

      // The outer deadline can win before the inner timer fires. A successful
      // start after that snapshot must follow late cleanup, not become running.
      if (
        bulkStartup &&
        (bulkStartup.hasExpired() || Date.now() >= bulkStartup.deadline)
      ) {
        bulkStartup.onTimeout();
        monitorLateStart();
        throw recordStartupTimeout();
      }

      this.core.dispatcher.withTransition(() => {
        // Update state. The previous run's error goes with it: `lastError` on a component
        // that is running again described a run that is over, and a reader taking it for
        // the current one - a health dashboard, a restart policy - was told the restart
        // had not worked. A clean late stop already clears it for the same reason.
        this.core.state.componentErrors.set(name, null);
        // A successful forceStalled start creates a new run. Any late stop
        // promise from the previous stalled run must no longer own state.
        this.markStartRunning(name, flags.forceStalled);

        this.core.logger.entity(name).success('Component started');
        const status = this.core.manager.getComponentStatus(name);
        this.core.lifecycleEvents.componentStarted(name, status);
      });
      // `attachSignalsOnStart` attaches once a component is actually up, not before. A
      // process configured to handle signals must not stay up without them, so a failed
      // attach takes this component back down and fails the start - after its `started`
      // event, so observers see an ordinary start followed by a stop.
      //
      // For the first component up, not the first counted as running: a start rolled
      // back for a failed attach is still counted as running while it is stopped again,
      // and a start finishing in that window came up without handlers. Another component
      // already up means handlers were attached, or deliberately detached since.
      // `autoAttachSignals()` is a no-op when they are already attached.
      //
      // Only if it is still up: this runs after `component:started`, and a listener
      // there may have had it report an unexpected stop or begin stopping it. Attaching
      // now would leave handlers on an idle manager, or roll back a stop already owned.
      if (
        this.core.config.attachSignalsOnStart &&
        this.core.internals.isComponentUp(name) &&
        ![...this.core.state.runningComponents].some(
          (other) => other !== name && this.core.internals.isComponentUp(other),
        )
      ) {
        const signalAttach = this.core.internals.autoAttachSignals(
          'first component start',
        );

        if (signalAttach.outcome === 'failed') {
          return await this.core.internals.rollBackStartForSignalAttach(
            name,
            signalAttach.error,
          );
        }
      }

      const startedResult: ComponentOperationResult = {
        success: true,
        componentName: name,
        status: this.core.manager.getComponentStatus(name),
      };
      detachTrigger = 'completed component startup';
      return startedResult;
    } catch (error) {
      // Superseded, as the `try` path checks after `start()` settles: the component
      // reported an unexpected stop and a listener started it again, or it is no longer
      // the registered instance. That newer attempt or replacement owns the state, its
      // unexpected-stop handler, and any `running` mark - so nothing below may touch
      // them, and a failure here is not `startComponentInternal()`'s to stop again.
      const supersededResult = (): ComponentOperationResult => ({
        success: false,
        componentName: name,
        reason: supersededReason(),
        code: 'component_unexpected_stop',
        error: toError(error),
      });
      if (isSuperseded()) {
        return supersededResult();
      }

      // Everything below describes a start that never got as far as running. A throw
      // after the component was marked running - building its status for the result,
      // say - is not that: it is left to `startComponentInternal()`, which stops the
      // component again so the failed start it reports is true.
      if (this.core.state.runningComponents.has(name)) {
        throw error;
      }

      // `start()` resolved and the bookkeeping after it threw before marking it running.
      // Answered as `registered`, what it brought up would be owned by nothing. Mark it
      // running so `startComponentInternal()` stops it again, as it does above. A
      // deadline that already won hands a fulfilled start to late cleanup instead.
      // A forced start retires the old stall's stop token, as the success path does, so a
      // late stop from that stall cannot settle this run before the net stops it.
      const isStartupTimeout =
        startupTimeoutError !== undefined && error === startupTimeoutError;
      if (didStartResolve && !isStartupTimeout) {
        if (this.core.state.componentStates.get(name) === 'starting') {
          try {
            this.core.dispatcher.withTransition(() => {
              this.markStartRunning(name, flags.forceStalled);
            });
          } catch {
            // The start net contains the bookkeeping failure as well.
          }
        }
        // Cleanup may already have stopped this resolved start. The start net keeps
        // that state; the failed-hook path below would restore the pre-start state.
        throw error;
      }

      // Contained, as unregister contains it: an override that throws here escaped to the
      // start net, which restored the state from before the start - `registered`, not
      // `starting-timed-out` - lost the timeout result and its event, and left a late
      // `start()` that nothing would stop.
      this.core.unexpectedStops.clearUnexpectedStopHandler(component, 'start');

      const err = toError(error);
      // Guarded for the same reason as the `component_unexpected_stop` branch below:
      // `toError` returns a brand-claiming value unchanged, so `.message` can be an
      // accessor that throws, and here that throw has nothing left above it to catch.
      // Read before the writes below, with the hook above, so all of the caller code this
      // failure path runs ahead of them is behind the supersession check that follows.
      const reason = describeError(err);
      // A shutdown pass asked this start to give up (`abortPendingStarts`) and it did:
      // answered as a start a shutdown interrupted, as one that resolved anyway is. Only
      // a failure linked to that abort - its reason, an `AbortError`, or an error carrying
      // either on `cause` - counts: an unrelated failure is answered as it would be without
      // the option. Its members are the caller's, so this is read here, with `reason`,
      // ahead of the supersession check below.
      const wasInterruptedByShutdown =
        !isStartupTimeout &&
        didStartHookFail &&
        startAbortCause === 'shutdown' &&
        isLinkedToAbort(error, shutdownAbortReason);

      // Asked again, not only at the top of the `catch`: the hook above is overridable,
      // and the error's own `message` is the caller's. Either can have the component
      // report an unexpected stop on this attempt's handler and a listener start it
      // again. That newer attempt owns `starting` now; writing this failure's
      // `registered` over it let a third start run `start()` alongside the second.
      if (isSuperseded()) {
        return supersededResult();
      }

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
      const unexpectedStopError = this.core.state.componentErrors.get(name);
      if (
        this.hasStoppedUnexpectedlyDuringStart(name) &&
        (isStartupTimeout ||
          this.core.state.componentUnexpectedStopHadError.get(name) === true)
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
          status: this.core.manager.getComponentStatus(name),
        };
      }

      const code = isStartupTimeout
        ? 'component_startup_timeout'
        : wasInterruptedByShutdown
          ? 'shutdown_in_progress'
          : didStartHookFail
            ? 'error'
            : 'operation_crashed';
      const result =
        this.core.dispatcher.withTransition<ComponentOperationResult>(() => {
          // Store error
          this.core.state.componentErrors.set(name, err);

          // Check if it was a timeout
          if (isStartupTimeout) {
            this.core.state.componentStates.set(
              name,
              this.core.state.stalledComponents.has(name)
                ? 'stalled'
                : 'starting-timed-out',
            );

            this.core.logger
              .entity(name)
              .error('Component startup timed out: {{error.message}}', {
                params: { error: err },
              });

            this.core.lifecycleEvents.componentStartTimeout(name, err, {
              timeoutMS,
              reason,
            });
          } else {
            // Back to the state the component had before this attempt claimed it, as the
            // start net restores it: a failed restart of a stopped component was answered
            // `registered` - never started - beside the `startedAt` / `stoppedAt` of the
            // run it had. The claim is still this attempt's: the supersession check above
            // returned otherwise.
            this.restoreStateAfterFailedStart(
              name,
              this.core.claims.owns(name, claim)
                ? this.core.state.componentClaims.get(name)?.previousState
                : 'registered',
            );

            if (wasInterruptedByShutdown) {
              this.core.logger
                .entity(name)
                .warn(
                  'Component startup interrupted by shutdown: {{error.message}}',
                  { params: { error: err } },
                );
            } else {
              this.core.logger
                .entity(name)
                .error('Component failed to start: {{error.message}}', {
                  params: { error: err },
                });
            }

            this.core.lifecycleEvents.componentStartFailed(name, err, {
              reason,
            });
          }

          return {
            success: false,
            componentName: name,
            reason: wasInterruptedByShutdown
              ? `Shutdown interrupted component startup: ${reason}`
              : reason,
            code,
            error: err,
            status: this.core.manager.getComponentStatus(name),
          };
        });

      // Reported once the result is built: a throw building it reaches the start net,
      // which reports it there instead.
      if (code === 'operation_crashed') {
        reportCallbackError('lifecycle-manager component start', error);
      }

      return result;
    } finally {
      // Ensure we always clean up the timeout handle, even if component.start()
      // rejects (non-timeout failure). Otherwise the deadline can abort the signal of a
      // start that already settled, and the timer handle leaks.
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (didAutoAttachSignalsForComponentStartup) {
        this.core.internals.detachSignalsIfIdle(detachTrigger);
      } else {
        this.core.internals.runDeferredSignalDetach('component startup');
      }
    }
  }

  /**
   * Whether the start attempt that owns `name` ended in an unexpected stop reported
   * while `start()` was still in flight: `stopped`, or `stalled` for a forced start whose
   * old stop is still unfinished (see `UnexpectedStops.handleComponentUnexpectedStop()`).
   * Asked only by an attempt that has already checked it is not superseded, so the state
   * is its own.
   */
  private hasStoppedUnexpectedlyDuringStart(name: string): boolean {
    if (this.core.state.runningComponents.has(name)) {
      return false;
    }
    const state = this.core.state.componentStates.get(name);
    return (
      state === 'stopped' ||
      (state === 'stalled' && this.core.state.stalledComponents.has(name))
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
      this.core.state.componentStates.delete(name);
    } else {
      this.core.state.componentStates.set(name, state);
    }
  }

  /**
   * Where a start that failed before the component was running leaves its state: the
   * one it replaced (`registered`, `stopped`, `failed`, ...), so the failure does not
   * erase that history from the status APIs. Except that the stall a forced start was
   * made over is read live, not from that state: a failed forced start does not retire
   * the old stop's stall, and one whose old stop settled while it ran has nothing left
   * to restore `stalled` for - that stop did finish, so the component is `stopped`.
   */
  private restoreStateAfterFailedStart(
    name: string,
    previousState: ComponentState | undefined,
  ): void {
    if (this.core.state.stalledComponents.has(name)) {
      this.core.state.componentStates.set(name, 'stalled');
    } else if (previousState === 'stalled') {
      this.core.state.componentStates.set(name, 'stopped');
    } else {
      this.restoreComponentState(name, previousState);
    }
  }

  /** Publish a start's settlement, by its claim and by its component's name. */
  private addStartSettlement(claim: symbol, settlement: StartSettlement): void {
    this.core.state.startSettlements.set(claim, settlement);
    let byName = this.core.state.startSettlementsByName.get(settlement.name);
    if (byName === undefined) {
      byName = new Set();
      this.core.state.startSettlementsByName.set(settlement.name, byName);
    }
    byName.add(settlement);
  }

  /** Withdraw the settlement `claim` published, from both of its indexes. */
  private deleteStartSettlement(claim: symbol): void {
    const settlement = this.core.state.startSettlements.get(claim);
    if (settlement === undefined) {
      return;
    }
    this.core.state.startSettlements.delete(claim);
    const byName = this.core.state.startSettlementsByName.get(settlement.name);
    byName?.delete(settlement);
    if (byName?.size === 0) {
      this.core.state.startSettlementsByName.delete(settlement.name);
    }
  }

  /**
   * The bookkeeping of a component coming up: running, its stall record gone, `startedAt`
   * stamped, and recorded as come up under a shutdown pass running now.
   */
  private markComponentRunning(name: string): void {
    this.core.state.componentStates.set(name, 'running');
    this.core.state.runningComponents.add(name);
    this.core.state.stalledComponents.delete(name);
    this.core.internals.updateStartedFlag();
    this.core.internals.stampTimestamp(name, 'startedAt');
    this.core.state.activeShutdownPass?.cameUp.add(name);
  }
}
