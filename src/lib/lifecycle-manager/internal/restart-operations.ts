import {
  LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
} from '../constants';
import type { BaseComponent } from '../base-component';
import type {
  ComponentOperationResult,
  RestartAllOptions,
  RestartComponentOptions,
  RestartResult,
  ShutdownResult,
  StartupResult,
} from '../types';
import type { RestartStartSnapshot } from './component-start';
import type { IndividualStopContext } from './component-stop';
import type { ManagerCore } from './manager-core';
import type { StartSettlement } from './manager-state';
import {
  snapshotRestartAllOptions,
  snapshotRestartComponentOptions,
  snapshotStartupOptions,
  snapshotStopAllOptions,
  type StartupOptionsSnapshot,
} from './operation-options';
import {
  crashedStartupResult,
  refusedShutdownResult,
  refusedStartupResult,
  resolveOperationTimeoutMS,
  toOperationFlag,
  toOperationTimerDelayMS,
} from './operation-policy';
import {
  restartDispatchOptions,
  revokeRestartDispatch,
  type RestartStartDispatch,
  type RestartStartupDispatch,
  type RestartStopDispatch,
} from './restart-dispatch';
import { readComponentStatus } from './read-status';

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
 * rest of restart preparation to the catch around that read in
 * `restartAllComponentsOperation()` - the one around `prepareRestart()`, or the one
 * around the late stop-budget check - which answers with `result`. Thrown rather than
 * returned, so a newly added read cannot forget the check and let validation run under
 * that shutdown. Never escapes those catches; any other throw - a getter's own, a
 * rejected budget - passes through them.
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

/** Why a `restartComponent()` skipped its start for a request to stay down. */
const RESTART_START_SKIPPED_REASON =
  'Shutdown requested while restart was stopping the component; startup skipped';

/** The startup phase of a `restartAllComponents()` a request to stay down skipped. */
function skippedRestartStartupResult(): StartupResult {
  return refusedStartupResult(
    'shutdown_requested_during_restart',
    'Shutdown requested during the restart shutdown phase; startup skipped',
  );
}

/**
 * Restarts: `restartAllComponents()`'s body - refusing one that meets another bulk
 * operation, preparing it by reading and validating everything both phases will need
 * before stopping anything, then a stop phase through `core.shutdownPass` and a
 * startup phase through the manager's public `startAllComponents()` - and
 * `restartComponent()`'s body, a stop and a start of one component through its public
 * `stopComponent()` and `startComponent()`. Those three are called through
 * `core.manager`, so an override or instance patch of one runs for a restart too; the
 * options each is handed carry the restart's context (`restart-dispatch.ts`).
 *
 * A restart's start runs only for the registration the restart approved: the snapshots
 * it took carry each component's generation, and `refuseStaleRestartSnapshot()` is
 * the check the start pipeline makes against them.
 */
export class RestartOperations {
  // `stayDownRequestCount` when each `restartComponent()` stop began, by its dispatch:
  // see `restartStopOperation()`.
  private readonly stayDownRequestCountsAtStop = new WeakMap<
    RestartStopDispatch,
    number
  >();

  constructor(private readonly core: ManagerCore) {}

  public async restartAllComponentsOperation(
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
      for (const component of this.core.state.components) {
        const name = this.core.registry.nameOf(component);
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
    this.core.logger.info('Restarting all components');
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
      this.core.logger.warn('Restart refused before shutdown: {{reason}}', {
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

      const stayDownPassCountAtStopPhase = this.core.state.stayDownPassCount;
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
        this.core.state.stayDownPassCount !== stayDownPassCountAtStopPhase;

      // Phase 2: Start all components - unless something asked us to stay down while
      // phase 1 ran. Checked ahead of a stalled/failed stop phase: the request is the
      // stronger statement, and reporting it beats reporting whatever startup would
      // have refused for instead.
      if (wasCanceledByShutdownRequest) {
        return this.restartCanceledByShutdownRequest(shutdownResult);
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
        // Logged as the sibling refusals below are, so a restart that leaves the
        // application down says why in the logs.
        this.core.logger.warn('Restart abandoned: {{reason}}', {
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
        this.core.logger.warn(
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
      // cannot be followed by a startup: it would refuse as `partial_state`, listing the
      // components still up as started while the ones already stopped stay down.
      // Skipped and said so, as a timed-out stop phase is. Read live: anything up now is
      // equally something a startup would refuse over.
      if (
        shutdownResult.code === 'partial_state' &&
        this.core.state.runningComponents.size > 0
      ) {
        const reason =
          'Restart shutdown phase left components running; startup skipped';
        this.core.logger.warn('Restart abandoned: {{reason}}', {
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
      // Through the public method, so an override or instance patch of it runs. The
      // options it is handed carry this restart's validated options and snapshots, and
      // the baseline its startup checks again for a request to stay down made while an
      // override awaited before handing them on: see `restart-dispatch.ts`.
      const startupDispatch: RestartStartupDispatch = {
        kind: 'startup',
        issuer: this.core,
        startupOptions,
        restartSnapshots,
        stayDownPassCount: stayDownPassCountAtStopPhase,
        canceled: false,
        taken: false,
      };
      const startupDispatchOptions = restartDispatchOptions(startupDispatch);
      let startupResult: StartupResult;
      try {
        startupResult = await this.core.manager.startAllComponents(
          startupDispatchOptions,
        );
      } finally {
        revokeRestartDispatch(startupDispatchOptions);
      }

      if (startupDispatch.canceled) {
        return this.restartCanceledByShutdownRequest(shutdownResult);
      }

      const isSuccess = shutdownResult.success && startupResult.success;

      this.core.logger[isSuccess ? 'success' : 'warn']('Restart completed', {
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
      this.core.state.pendingRestartAutoStarts.delete(pendingAutoStarts);
      const abandoned = Array.from(pendingAutoStarts);
      pendingAutoStarts.clear();
      // A newer restart whose stop phase began in this one's gap - the one that refused
      // this startup - starts the whole registry in its own startup phase. Its handoff
      // takes these names, so it reports them if it leaves them unattempted, and only
      // a restart with no successor warns here.
      const successor = Array.from(this.core.state.pendingRestartAutoStarts).at(
        -1,
      );
      if (successor !== undefined) {
        for (const name of abandoned) {
          successor.add(name);
        }
      } else {
        this.core.startup.warnAbandonedAutoStarts(
          abandoned,
          'restart abandoned before startup',
        );
      }
    }
  }

  public async restartComponentOperation(
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
      generation: this.core.registryReads.currentGeneration(component),
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
      !this.core.manager.isComponentRunning(name) ||
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
    const stayDownRequestCountAtStop = this.core.state.stayDownRequestCount;
    // Stopped and started through the public methods, so an override or instance patch
    // of either runs. The options each is handed carry this restart's context - its
    // option snapshots, this stop's claim, the registration it approved - to
    // `restartStopOperation()` and the start: see `restart-dispatch.ts`.
    const stopDispatch: RestartStopDispatch = {
      kind: 'stop',
      issuer: this.core,
      name,
      stopOptions,
      stopContext,
      startSnapshot,
      taken: false,
    };
    this.stayDownRequestCountsAtStop.set(
      stopDispatch,
      stayDownRequestCountAtStop,
    );
    const stopDispatchOptions = restartDispatchOptions(stopDispatch);
    let stopResult: ComponentOperationResult;
    try {
      stopResult = await this.core.manager.stopComponent(
        name,
        stopDispatchOptions,
      );
    } finally {
      revokeRestartDispatch(stopDispatchOptions);
    }

    if (!stopResult.success) {
      // Once this restart took a stop claim, even a later refusal or validation
      // error describes an attempted stop. Only pre-claim failures pass through. A stop
      // an override ran without this restart's options cannot say whether it claimed,
      // so its failure is answered as an attempted stop.
      if (stopDispatch.taken && !stopContext.claimed) {
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

    const stayDownRefusal = this.refuseRestartAskedToStayDown(
      name,
      startSnapshot,
      stayDownRequestCountAtStop,
    );
    if (stayDownRefusal) {
      return stayDownRefusal;
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

    const startDispatch: RestartStartDispatch = {
      kind: 'start',
      issuer: this.core,
      name,
      startOptions,
      startSnapshot,
      stayDownRequestCount: stayDownRequestCountAtStop,
      canceled: false,
      taken: false,
    };
    const startDispatchOptions = restartDispatchOptions(startDispatch);
    let startResult: ComponentOperationResult;
    try {
      startResult = await this.core.manager.startComponent(
        name,
        startDispatchOptions,
      );
    } finally {
      revokeRestartDispatch(startDispatchOptions);
    }

    // Asked to stay down while an override awaited before handing the options on: the
    // start refused for it, and the restart reports the request, as above.
    if (startDispatch.canceled) {
      return this.skippedRestartStartResult(name, true);
    }

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
      status: readComponentStatus(this.core, name, 'lifecycle-manager restart'),
    };
  }

  /**
   * A restart's start of `name` refused because its registration changed since the
   * restart approved it - checked by the start both before and after the reads that run
   * the component's code. `undefined` for an ordinary start, which has no snapshot.
   */
  public refuseStaleRestartSnapshot(
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

  /**
   * A restart's stop, the body `stopComponent()` runs for the options
   * `restartComponentOperation()` handed it: those options were read, and its dependents
   * checked, by the restart. Refused unless the name still holds the registration the
   * restart approved - an override can await before handing the options on, and an
   * overridable method the restart calls can replace the component - so a replacement
   * is never stopped. Nothing runs caller code between this check and the stop's own
   * lookup of the component, which every later recheck of the stop compares against.
   * Refused first when a shutdown asked to stay down since the restart's stop began:
   * only an override that awaited before handing the options on lets one in, and that
   * shutdown may have stopped the component already. The request is why no start
   * follows, as for one made during the stop itself.
   */
  public async restartStopOperation(
    name: string,
    dispatch: RestartStopDispatch,
  ): Promise<ComponentOperationResult> {
    const stayDownRequestCountAtStop =
      this.stayDownRequestCountsAtStop.get(dispatch);
    const stayDownRefusal =
      stayDownRequestCountAtStop === undefined
        ? undefined
        : this.refuseRestartAskedToStayDown(
            name,
            dispatch.startSnapshot,
            stayDownRequestCountAtStop,
          );
    if (stayDownRefusal) {
      return stayDownRefusal;
    }

    const bulkRefusal =
      this.core.componentStop.checkIndividualBulkPreconditions(name, 'restart');
    if (bulkRefusal) {
      return bulkRefusal;
    }

    if (!this.isCurrentRestartSnapshot(name, dispatch.startSnapshot)) {
      return {
        success: false,
        componentName: name,
        reason: 'Component registration changed before restart could stop it',
        code: 'component_not_found',
      };
    }

    return await this.core.componentStop.stopComponentInternal(
      name,
      dispatch.stopOptions,
      dispatch.stopContext,
    );
  }

  /**
   * A restart's start, the body `startComponent()` runs for the options
   * `restartComponentOperation()` handed it: refused when a shutdown asked to stay down
   * since the restart's stop began - an override can await before handing the options
   * on, and that request can be made and its pass finish meanwhile - otherwise a start
   * of the registration the restart approved, with the options it read.
   */
  public restartStartOperation(
    name: string,
    dispatch: RestartStartDispatch,
  ): Promise<ComponentOperationResult> {
    if (
      this.core.state.stayDownRequestCount !== dispatch.stayDownRequestCount
    ) {
      dispatch.canceled = true;
      return Promise.resolve(this.skippedRestartStartResult(name, false));
    }

    return this.core.componentStart.startComponentInternal(
      name,
      dispatch.startOptions,
      undefined,
      undefined,
      undefined,
      dispatch.startSnapshot,
    );
  }

  /**
   * A restart's startup phase refused when a shutdown that asks to stay down was
   * accepted since the stop phase began - the startup body's first check, for an
   * override that awaited before handing the options on while such a pass ran and
   * finished. `undefined` lets the startup proceed.
   */
  public refuseCanceledRestartStartup(
    dispatch: RestartStartupDispatch,
  ): StartupResult | undefined {
    if (this.core.state.stayDownPassCount === dispatch.stayDownPassCount) {
      return undefined;
    }
    dispatch.canceled = true;
    return skippedRestartStartupResult();
  }

  /**
   * A `restartComponent()` of `name` asked to stay down since its stop began, answered
   * `shutdown_requested_during_restart`; `undefined` when no such request was made.
   * Replaced or unregistered meanwhile, the request is still why no start follows, but
   * neither a replacement's status nor a missing one is this restart's, so none is
   * attached.
   */
  private refuseRestartAskedToStayDown(
    name: string,
    startSnapshot: RestartStartSnapshot,
    stayDownRequestCountAtStop: number,
  ): ComponentOperationResult | undefined {
    if (this.core.state.stayDownRequestCount === stayDownRequestCountAtStop) {
      return undefined;
    }
    if (!this.isCurrentRestartSnapshot(name, startSnapshot)) {
      return this.skippedRestartStartResult(
        name,
        false,
        'Shutdown requested while restart was stopping the component, which was replaced or unregistered meanwhile; startup skipped',
      );
    }
    return this.skippedRestartStartResult(name, true);
  }

  /**
   * A `restartComponent()` of `name` whose start a request to stay down skipped, with the
   * component's status when the restart reports it as this registration's.
   */
  private skippedRestartStartResult(
    name: string,
    shouldIncludeStatus: boolean,
    reason = RESTART_START_SKIPPED_REASON,
  ): ComponentOperationResult {
    return {
      success: false,
      componentName: name,
      reason,
      code: 'shutdown_requested_during_restart',
      ...(shouldIncludeStatus
        ? {
            status: readComponentStatus(
              this.core,
              name,
              'lifecycle-manager restart',
            ),
          }
        : {}),
    };
  }

  /** A restart whose startup phase a request to stay down skipped. */
  private restartCanceledByShutdownRequest(
    shutdownResult: ShutdownResult,
  ): RestartResult {
    this.core.logger.warn('Restart canceled by shutdown request', {
      params: { shutdownSuccess: shutdownResult.success },
    });

    return {
      shutdownResult,
      startupResult: skippedRestartStartupResult(),
      startupSkippedByShutdownRequest: true,
      success: false,
    };
  }

  /** Either active-operation refusal, the shutdown one first. */
  private refuseRestartDuringActiveBulkOperation(): RestartResult | undefined {
    return (
      this.refuseRestartDuringActiveShutdown() ??
      this.refuseRestartDuringActiveStartup()
    );
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
    if (!this.core.state.isStarting) {
      return undefined;
    }

    const reason = LIFECYCLE_MANAGER_MESSAGE_BULK_STARTUP_IN_PROGRESS;
    const result: RestartResult = {
      shutdownResult: refusedShutdownResult('partial_state', reason),
      startupResult: refusedStartupResult('already_in_progress', reason),
      success: false,
    };
    // Built before the sink runs, as the shutdown refusal is.
    this.core.logger.warn('Cannot restart all components during startup');
    return result;
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
    this.core.logger.warn('Cannot restart all components during shutdown');
    return result;
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
      this.core.config.startupTimeoutMS,
      'restartAllComponents startupOptions.timeoutMS',
    );
    const startupOptions = snapshotStartupOptions({
      ignoreStalledComponents:
        restartOptions.startupOptions.ignoreStalledComponents,
      timeoutMS: startupTimeoutMS,
    });
    const shutdownTimeoutMS = resolveOperationTimeoutMS(
      restartOptions.shutdownTimeoutMS,
      this.core.config.shutdownOptions.timeoutMS,
      'restartAllComponents shutdownTimeoutMS',
    );

    // A restart must discover an invalid component timeout while the existing
    // application is still running. Hold both the value and its registration:
    // shutdown hooks can mutate the property or replace an instance before startup.
    const restartSnapshots = new Map<string, RestartStartSnapshot>();
    const validatedStops = new Map<string, RestartStopNeed>();
    // Read once, ahead of the loop: its getters can change it, and
    // `validateLateRestartStopBudgets()` below reads it again for what they changed.
    const currentStarts = this.core.startSettlements.currentStartSettlements();
    for (const component of [...this.core.state.components]) {
      const name = this.core.registry.nameOf(component);
      const generation = this.core.registryReads.currentGeneration(component);
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
      (this.core.state.componentStates.get(name) === 'starting' ||
        settlement !== undefined) &&
      !this.core.shutdownPass.isUnresolvedTimedOutStart(settlement);
    if (this.core.state.runningComponents.has(name) || isStartInFlight) {
      return 'stop';
    }
    return this.core.state.stalledComponents.has(name) ? 'force' : undefined;
  }

  /**
   * The stop budgets the restart's stop phase will read for `component`, validated
   * before it stops anything - for the same reason as the startup budgets above. The
   * stop phase reads them per component as it reaches each one, so a typo on one stopped
   * late would surface only after its dependents were already down, halting the pass
   * with startup skipped and the application half down. Only validated, not
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
   * restart's own log - can start it while it was idle, or stall it; an invalid budget
   * there would halt the stop phase after the others were already down.
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
      let currentStarts = this.core.startSettlements.currentStartSettlements();
      for (const component of [...this.core.state.components]) {
        const name = this.core.registry.nameOf(component);
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
        currentStarts = this.core.startSettlements.currentStartSettlements();
      }
      if (!didValidate) {
        return;
      }
    }
  }

  /**
   * The names among a restart's snapshots whose registration is no longer the one
   * approved before the stop - unregistered, replaced, or registered again. No caller
   * code runs here.
   */
  private staleRestartSnapshotNames(
    snapshots: ReadonlyMap<string, RestartStartSnapshot>,
  ): string[] {
    const stale: string[] = [];
    for (const [name, snapshot] of snapshots) {
      if (!this.isCurrentRestartSnapshot(name, snapshot)) {
        stale.push(name);
      }
    }
    return stale;
  }

  /**
   * Whether a restart timeout still belongs to the same live registration. The
   * historical registeredNames cache deliberately survives unregister, so neither
   * that cache nor a generation alone can replace the live membership check.
   */
  private isCurrentRestartSnapshot(
    name: string,
    snapshot: RestartStartSnapshot,
  ): boolean {
    return this.core.registry.isCurrentRegistration(
      name,
      snapshot.component,
      snapshot.generation,
    );
  }
}
