import { describeError } from '../../to-error';
import {
  LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT,
  LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT,
} from '../constants';
import type { ComponentOperationResult, ComponentStallInfo } from '../types';
import type { ManagerCore } from './manager-core';
import type { StopAttempt } from './manager-state';
import { crashedComponentResult } from './operation-policy';
import { readComponentStatus } from './read-status';

/** A force phase's wait for another path to mark its component stopped. */
export interface PendingForceStopWaiter {
  promise: Promise<void>;
  cleanup: () => void;
  // Whether another path has marked the component stopped since the waiter was made.
  hasResolved: () => boolean;
}

/**
 * What a component's stop leaves, and what it answers with: marking the component
 * stopped or stalled, the force-stop waiters a stop releases, a stop that settles after
 * its deadline, and the stopped, stalled and crashed results.
 *
 * `ComponentStop` runs the stop and records its outcome here; a stop that settles late
 * is reconciled here, against the attempt tokens `ComponentStop` issues. Owns the stall
 * details it keeps beside each stall record, which nothing else reads.
 */
export class StopOutcomes {
  // What each stall record cannot say itself, kept beside the record object rather than
  // on the record callers receive: whether its stop had already timed out gracefully - a
  // force timeout reports `reason: 'timeout'` - so a retry that fails can still report
  // `'both'`, and whether the stop net recorded it after a crash. Written only by
  // `markComponentStalled()`; keyed by the record, so it goes when the record does.
  private readonly stallDetails = new WeakMap<
    ComponentStallInfo,
    { readonly gracefulTimedOut: boolean; readonly crashed: boolean }
  >();

  constructor(private readonly core: ManagerCore) {}

  public createPendingForceStopWaiter(name: string): PendingForceStopWaiter {
    let isResolved = false;
    let waiters = this.core.state.pendingForceStopWaiters.get(name);

    if (!waiters) {
      waiters = new Set();
      this.core.state.pendingForceStopWaiters.set(name, waiters);
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
      hasResolved: () => isResolved,
      cleanup: () => {
        const pending = this.core.state.pendingForceStopWaiters.get(name);
        if (!pending) {
          return;
        }

        pending.delete(resolveWaiter);
        if (pending.size === 0) {
          this.core.state.pendingForceStopWaiters.delete(name);
        }
      },
    };
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
   * 1. token guard — if a newer stop attempt has started since this promise was
   *    launched, its token won't match and we bail out immediately. A stalled
   *    component's force retry is the exception: it continues the stop that
   *    stalled, so a late resolution of any earlier attempt of that stop still
   *    clears the stall (see `stalledStopEarlierTokens`).
   *
   * 2. state/stall guard — if the component was unregistered, restarted, or
   *    already cleared by another path, there will be neither a matching stall
   *    entry nor the post-graceful-race overlap state, so we bail out.
   */
  public handleLateStopResolution(
    name: string,
    token: string,
    source: 'graceful' | 'force',
    hasGracefulRaceFinished = false,
  ): boolean {
    return this.core.dispatcher.withTransition(() => {
      // Guard 1: bail if a newer stop attempt has superseded this one. The newer
      // attempt owns any stop/stall state and must manage its own late resolution -
      // unless it is a force retry of the stall this attempt left: that continues the
      // same stop, and this attempt's hook finishing late finishes it.
      const isCurrentAttempt =
        this.core.state.componentStopAttemptTokens.get(name) === token;
      const isEarlierAttemptOfStalledStop =
        !isCurrentAttempt &&
        this.core.state.stalledStopEarlierTokens.get(name)?.has(token) === true;
      if (!isCurrentAttempt && !isEarlierAttemptOfStalledStop) {
        return false;
      }

      const currentState = this.core.state.componentStates.get(name);
      const stallInfo = this.core.state.stalledComponents.get(name);

      // The stalled stop's force retry is still running when an earlier attempt's hook
      // finishes: the component did stop, so it is finalized here, as a graceful stop
      // that finishes during its own escalation is. Marking it stopped releases the
      // retry's force race, which then finds it stopped and ends as superseded.
      const isCompletedDuringStallRetry =
        isEarlierAttemptOfStalledStop &&
        stallInfo !== undefined &&
        currentState === 'force-stopping';

      // Once the graceful race has lost, a successful stop can be finalized before
      // or during force escalation, even without a stall record. Only the caller
      // that consumed the graceful result can admit the pre-force stopping state.
      const isCompletedAfterGracefulRace =
        source === 'graceful' &&
        !stallInfo &&
        (currentState === 'force-stopping' ||
          (hasGracefulRaceFinished && currentState === 'stopping'));

      // Still in flight for this very attempt - it settled as its timeout fired. The
      // attempt decides how it ended: its timeout rejects a macrotask after the abort
      // (`rejectAfterAbort()`), so a stop that settled then wins the race. Ahead of
      // Guard 2, which would take a stalled component's force retry - `force-stopping`,
      // with the old stall entry still in place - for a newer attempt and discard the
      // stall under it.
      if (
        !isCompletedAfterGracefulRace &&
        !isCompletedDuringStallRetry &&
        (currentState === 'stopping' || currentState === 'force-stopping')
      ) {
        return false;
      }

      // Guard 2: once the component is no longer in the stalled state because a
      // newer lifecycle attempt changed its state, the old stop promise no longer
      // owns the component state. Clear the stale stall bookkeeping, but do not
      // emit stopped or overwrite the newer state. It may have been the last stall
      // holding process signals attached, so the last-stop detach check still runs.
      // The stall did end - its own stop finished - so it is announced as any late
      // resolution is: otherwise a forced start that then fails leaves a component
      // whose `component:stalled` never ended.
      if (
        stallInfo &&
        currentState !== 'stalled' &&
        !isCompletedDuringStallRetry
      ) {
        this.core.state.stalledComponents.delete(name);
        this.core.registry.updateStartedFlag();
        this.core.lifecycleEvents.componentStalledResolved(
          name,
          stallInfo,
          Date.now() - stallInfo.stalledAt,
        );
        this.core.signals.detachSignalsAfterLastStop();
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

      this.core.logger.entity(name).info(
        stallInfo
          ? 'Stalled component completed stop late, stall cleared'
          : hasGracefulRaceFinished
            ? 'Graceful stop completed before force phase started'
            : 'Graceful stop completed after force phase started',
        // A stall cleared within the same millisecond lasted 0ms, which is still a
        // duration to report.
        stalledDurationMS !== undefined
          ? { params: { stalledDurationMS } }
          : undefined,
      );

      // If the force promise itself completed late, preserve the same "force
      // finished" signal that a normal in-time force shutdown would have emitted.
      if (source === 'force') {
        this.core.lifecycleEvents.componentShutdownForceCompleted(name);
      }

      if (stallInfo && stalledDurationMS !== undefined) {
        // Late resolution is modeled as: stalled -> stall cleared -> stopped.
        // Emit both events so observers can distinguish "the stall ended" from
        // "the component is now fully stopped".
        this.core.lifecycleEvents.componentStalledResolved(
          name,
          stallInfo,
          stalledDurationMS,
        );
      }

      this.core.lifecycleEvents.componentStopped(
        name,
        readComponentStatus(
          this.core,
          name,
          'lifecycle-manager component stop',
        ),
      );
      return true;
    });
  }

  /**
   * The bookkeeping every path that finds a component stopped shares: a graceful or
   * force stop that succeeded, and a stalled one that finished late. The caller logs and
   * emits.
   */
  public markComponentStopped(name: string): void {
    return this.core.dispatcher.withTransition(() => {
      // A late-start cleanup's stop leaves the state the cleanup recorded - usually
      // `starting-timed-out` with the timeout error - not `stopped`: the start that
      // brought the component up timed out, and the status says so.
      const lateCleanup = this.core.state.lateStartCleanupOutcomes.get(name);
      const isLateStartCleanupStop =
        lateCleanup !== undefined &&
        this.core.state.componentStartAttemptTokens.get(name) ===
          lateCleanup.token;
      this.core.state.componentStates.set(
        name,
        isLateStartCleanupStop ? lateCleanup.state : 'stopped',
      );
      this.core.state.runningComponents.delete(name);
      this.core.state.stalledComponents.delete(name);
      // The stop is over, so no earlier attempt of it is left to finish it.
      this.core.state.stalledStopEarlierTokens.delete(name);
      // Clear the stall/timeout error so lastError reflects a clean stop.
      this.core.state.componentErrors.set(
        name,
        isLateStartCleanupStop ? lateCleanup.error : null,
      );
      this.core.state.lateStartCleanupOutcomes.delete(name);
      this.core.state.componentUnexpectedStopHadError.delete(name);
      this.core.registry.updateStartedFlag();
      this.resolvePendingForceStopWaiters(name);

      this.core.signals.detachSignalsAfterLastStop();

      this.core.registry.stampTimestamp(name, 'stoppedAt');
    });
  }

  /**
   * Record a stall: the bookkeeping every path that stalls a component shares. The
   * caller emits `component:stalled` and anything particular to its path.
   *
   * A stop that settles after the stall is recorded clears it through
   * `handleLateStopResolution()`; one released by its own abort listener never gets here,
   * since its timeout rejects a macrotask later (`rejectAfterAbort()`).
   */
  public markComponentStalled(
    name: string,
    stallInfo: ComponentStallInfo,
    options: { error?: Error; gracefulTimedOut: boolean; crashed?: boolean },
  ): void {
    const { error } = options;

    return this.core.dispatcher.withTransition(() => {
      this.core.state.stalledComponents.set(name, stallInfo);
      this.stallDetails.set(stallInfo, {
        gracefulTimedOut: options.gracefulTimedOut,
        crashed: options.crashed === true,
      });
      this.core.state.componentStates.set(name, 'stalled');
      this.core.state.runningComponents.delete(name);

      if (error !== undefined) {
        this.core.state.componentErrors.set(name, error);
      }

      this.core.registry.updateStartedFlag();
    });
  }

  /**
   * A confirmed stop remains successful even if its diagnostic status cannot be read.
   * Late graceful completion and superseded force attempts share this boundary.
   */
  public successfulStopResult(name: string): ComponentOperationResult {
    return this.withStopStatus(name, { success: true, componentName: name });
  }

  /**
   * `result` with the component's status attached, read through the public
   * `getComponentStatus()` (`readComponentStatus()`): a throwing override is reported
   * under `context` and the status left out, so it cannot turn the result into a crash.
   * The results of a stop that ran read their status here - a stop, a failed graceful
   * phase, a stall, a crash. The stop preconditions' refusals run no caller code and
   * carry the manager's own status instead (`ComponentStop.checkStopPreconditions()`).
   */
  public withStopStatus(
    name: string,
    result: ComponentOperationResult,
    context = 'lifecycle-manager component stop',
  ): ComponentOperationResult {
    const status = readComponentStatus(this.core, name, context);
    if (status !== undefined) {
      result.status = status;
    }
    return result;
  }

  /**
   * The stall record a stop leaves when `phase` fails. A graceful timeout is the reason
   * while the graceful phase is what stalled, and `'both'` once a force phase failed
   * after it; a force phase's own timeout is `'timeout'`.
   */
  public stopStallInfo(
    name: string,
    phase: 'graceful' | 'force',
    stop: StopAttempt,
    error: Error | undefined,
    didForceTimeOut = false,
  ): ComponentStallInfo {
    return {
      name,
      phase,
      reason: didForceTimeOut
        ? 'timeout'
        : stop.gracefulTimedOut
          ? phase === 'force'
            ? 'both'
            : 'timeout'
          : 'error',
      startedAt: stop.startedAt,
      stalledAt: Date.now(),
      error,
    };
  }

  /**
   * The result a stop that crashed answers with. The code is always `operation_crashed`,
   * even for a timeout validation error, since the crash is reported and the stop may
   * have changed state; the reason says when the graceful phase had
   * already timed out, and `status` carries the stall the crash left. Read guarded: the
   * crash may have come from reading state, and this runs where nothing above is left to
   * catch, so a status that cannot be read is reported and left out.
   */
  public crashedStopResult(
    name: string,
    error: Error,
    stall: { gracefulTimedOut: boolean } | undefined,
  ): ComponentOperationResult {
    const result = crashedComponentResult(
      name,
      error,
      stall?.gracefulTimedOut === true
        ? `Stop failed unexpectedly after its graceful phase timed out: ${describeError(error)}`
        : `Stop failed unexpectedly: ${describeError(error)}`,
      // Every caller has reported this failure: a crash, even for a branded option
      // refusal - one the attempt met unclaimed is answered `invalid_options` before
      // it gets here - and even more so once it left a stall.
      'operation_crashed',
    );

    return this.withStopStatus(name, result);
  }

  /**
   * The result a stop that stalled answers with, derived from its stall record so a
   * retry that attempts nothing answers exactly as the stop that recorded it did.
   */
  public stalledStopResult(
    name: string,
    stallInfo: ComponentStallInfo,
  ): ComponentOperationResult {
    const isForcePhase = stallInfo.phase === 'force';
    const didTimeOut = stallInfo.reason === 'timeout';
    const error = stallInfo.error;

    // The stop net recorded this stall after a crash, and answered with its crash result.
    const details = this.stallDetails.get(stallInfo);
    if (details?.crashed === true && error !== undefined) {
      return this.crashedStopResult(name, error, details);
    }

    const result: ComponentOperationResult = {
      success: false,
      componentName: name,
      // A graceful-phase timeout is worded as its `component:stop-timeout` event and log
      // line word it.
      reason: didTimeOut
        ? isForcePhase
          ? LIFECYCLE_MANAGER_MESSAGE_FORCE_SHUTDOWN_TIMED_OUT
          : LIFECYCLE_MANAGER_MESSAGE_GRACEFUL_SHUTDOWN_TIMED_OUT
        : // Guarded: the stall error is a `toError` result, so its `message` can be
          // an accessor that throws.
          error !== undefined
          ? describeError(error)
          : isForcePhase
            ? 'Force shutdown failed'
            : 'Graceful shutdown failed',
      code: didTimeOut ? 'component_shutdown_timeout' : 'error',
      error,
    };

    // Guarded as a stopped component's status is: a throwing override must not turn
    // the stall into a crash. Reported, and left out.
    return this.withStopStatus(
      name,
      result,
      'lifecycle-manager component stall',
    );
  }

  /** Whether the stop that left `name` stalled had its graceful phase time out. */
  public didStallGracefulTimeOut(name: string): boolean {
    const stallInfo = this.core.state.stalledComponents.get(name);
    return (
      stallInfo !== undefined &&
      this.stallDetails.get(stallInfo)?.gracefulTimedOut === true
    );
  }

  private resolvePendingForceStopWaiters(name: string): void {
    const waiters = this.core.state.pendingForceStopWaiters.get(name);
    if (!waiters || waiters.size === 0) {
      return;
    }

    this.core.state.pendingForceStopWaiters.delete(name);
    for (const resolve of waiters) {
      resolve();
    }
  }
}
