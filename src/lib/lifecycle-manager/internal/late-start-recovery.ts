import { observeRejection } from '../../internal/promise-reactions';
import { reportCallbackError } from '../../safe-handle-callback';
import { toError } from '../../to-error';
import type { ManagerCore } from './manager-core';

/**
 * Late-start recovery: a start the manager stopped waiting for - its deadline passed,
 * or observing it failed - whose `start()` is still pending. If it comes up anyway,
 * nothing owns what it brought up, so recovery marks it running only to stop it again
 * through the normal stop path, and leaves the state the abandoned start recorded.
 *
 * The cleanup holds the registry latch while it runs (`pendingBulkStartupCleanup`), and
 * the start's settlement says whether a late start is still awaited, which a shutdown
 * pass and a signal detach both consult.
 */
export class LateStartRecovery {
  constructor(private readonly core: ManagerCore) {}

  /**
   * Watch a start the manager stopped waiting for, and stop its component if `start()`
   * completes later, while the attempt still owns the name. The recovery task floats:
   * it is recorded on the attempt's settlement as `recovery`, and its failures are
   * reported, never rejected.
   */
  public monitorLateStartupCompletion(
    name: string,
    startPromise: Promise<unknown>,
    startAttemptToken: string,
    claim: symbol,
    wasForcedFromStall: boolean,
    // The attempt's own check: whether its instance and start token still own the name.
    isSuperseded: () => boolean,
    failureKind: 'timeout' | 'observation-failed' = 'timeout',
  ): void {
    const settlement = this.core.state.startSettlements.get(claim);
    if (settlement) {
      settlement.isAwaitingLateStart = true;
    }
    this.core.logger
      .entity(name)
      .warn(
        failureKind === 'timeout'
          ? 'Startup timed out, stopping component if startup completes later'
          : 'Startup observation failed, stopping component if startup completes later',
      );

    // Timeout callers pass the startup race's adopted promise; an observation failure
    // passes a manager-owned promise attached to that same raw startup instead.
    const recovery = (async (): Promise<void> => {
      try {
        try {
          await startPromise;
        } catch {
          // observeFailureAfterTimeout() reports a late start() rejection.
          return;
        }
        // An abort listener can settle start() inside the timeout callback. Let the
        // timed-out start's catch record its state before beginning late cleanup.
        await Promise.resolve(undefined);
        const timeoutState = this.core.state.componentStates.get(name);
        const timeoutError = this.core.state.componentErrors.get(name) ?? null;
        // A start - forced or not - that reported an unexpected stop before its deadline
        // ended as that stop, not as a timeout. Read before cleanup's own stop clears it.
        const didStopUnexpectedly =
          this.core.state.componentUnexpectedStopHadError.has(name);

        // A forced start still owes cleanup if the old stalled stop finished first.
        // So does any start, forced or not, that reported an unexpected stop before its
        // deadline: `start()` fulfilled anyway, and what it brought up is owned by nothing.
        // The instance and startup token must still belong to this attempt.
        if (
          isSuperseded() ||
          this.core.state.runningComponents.has(name) ||
          (timeoutState !== 'starting-timed-out' &&
            timeoutState !== 'failed' &&
            !(
              failureKind === 'observation-failed' &&
              (timeoutState === 'registered' || timeoutState === 'stopped')
            ) &&
            !(
              wasForcedFromStall &&
              timeoutState === 'stalled' &&
              this.core.state.stalledComponents.has(name)
            ) &&
            !(
              (wasForcedFromStall || didStopUnexpectedly) &&
              timeoutState === 'stopped'
            ))
        ) {
          return;
        }

        // Late startup completed after the manager had stopped waiting. Mark
        // it running briefly so the normal stop path can clean it up.
        // Lock recovery only while cleanup is actually running. An abandoned
        // start may never settle; the attempt token protects a replacement run.
        this.core.state.pendingBulkStartupCleanup.set(name, startAttemptToken);
        if (settlement) {
          // Cleanup now holds the registry latch; shutdown joins its stop rather
          // than treating it as startup that has not finished yet.
          settlement.isAwaitingLateStart = false;
        }
        // What the cleanup's stop leaves, applied by `markComponentStopped()` so its
        // `component:stopped` carries it. Successful cleanup retires any pre-existing
        // stall from a forced start. A deadline leaves the timeout; an observation
        // failure or unexpected stop leaves stopped, retaining its failure.
        this.core.state.lateStartCleanupOutcomes.set(name, {
          token: startAttemptToken,
          state:
            timeoutState === 'stalled'
              ? didStopUnexpectedly || failureKind === 'observation-failed'
                ? 'stopped'
                : 'starting-timed-out'
              : timeoutState,
          error: timeoutError,
        });
        // forceStalled already permits overlap with the old stop. A successful late
        // start now needs its own cleanup; the old stall's retirement is announced
        // rather than silently losing its terminal notification. Not a forced start's
        // new run, so the old stop keeps its token.
        this.core.dispatcher.withTransition(() => {
          this.core.componentStart.markStartRunning(
            name,
            false,
            'late-start-cleanup',
          );
        });
        this.core.logger
          .entity(name)
          .warn(
            failureKind === 'timeout'
              ? 'Component completed startup after timeout, stopping automatically'
              : 'Component completed startup after observation failed, stopping automatically',
          );

        // Retirement events and logging can replace this registration. Cleanup
        // and its final state belong only to the start that completed late.
        if (isSuperseded()) {
          return;
        }
        const stopResult =
          await this.core.componentStop.stopComponentInternal(name);

        if (!stopResult.success) {
          this.core.logger
            .entity(name)
            .warn(
              failureKind === 'timeout'
                ? 'Automatic stop after startup timeout failed'
                : 'Automatic stop after startup observation failed',
              {
                params: {
                  error: stopResult.error,
                  code: stopResult.code,
                },
              },
            );
        }
      } catch (error) {
        // The recovery body above failed - after the component was marked running, and
        // around the `stopComponentInternal` that exists to stop it. That stop may not
        // have happened, so this is reported, not just logged at debug.
        this.core.logger
          .entity(name)
          .warn('Late startup completion handling failed', {
            params: { error: toError(error) },
          });
        reportCallbackError('lifecycle-manager late startup cleanup', error);
      } finally {
        if (settlement) {
          settlement.isAwaitingLateStart = false;
        }
        if (
          this.core.state.pendingBulkStartupCleanup.get(name) ===
          startAttemptToken
        ) {
          this.core.state.pendingBulkStartupCleanup.delete(name);
        }
        if (
          this.core.state.lateStartCleanupOutcomes.get(name)?.token ===
            startAttemptToken &&
          !this.core.state.stalledComponents.has(name)
        ) {
          this.core.state.lateStartCleanupOutcomes.delete(name);
        }
        // Whichever way the late start ended - rejected, superseded, or cleaned up - the
        // pending start held a detach back (`hasAbandonedStartAwaitingCleanup()`), so the
        // deferred one runs now. It does nothing unless one was deferred.
        try {
          this.core.signals.runDeferredSignalDetach('late startup cleanup');
        } catch (error) {
          reportCallbackError(
            'lifecycle-manager late startup cleanup finalization',
            error,
          );
        }
      }
    })();
    // `component` and `token` are already this attempt's: both callers run after the
    // attempt recorded them on its settlement.
    if (settlement) {
      settlement.recovery = recovery;
    }
    // This task floats after the timeout; contain failures in the reporting path.
    observeRejection(recovery, () => {});
  }

  /**
   * Whether a timed-out start of a current registration is still pending, with late
   * cleanup waiting on it (`monitorLateStartupCompletion()`). Its component reads
   * `starting-timed-out`, not in flight, yet a late `start()` brings it up and the
   * cleanup's stop of it can stall - and a stall the operator cannot reach with Ctrl+C,
   * because the handlers came off while the start was still pending, is what keeping them
   * attached for a stall exists to prevent. A start superseded by a newer attempt, or
   * whose component was unregistered or replaced, leaves nothing for cleanup to stop.
   */
  public hasAbandonedStartAwaitingCleanup(): boolean {
    for (const settlement of this.core.state.startSettlements.values()) {
      if (
        settlement.isAwaitingLateStart === true &&
        this.core.startSettlements.isCurrentStartAttempt(
          settlement.name,
          settlement.component,
          settlement.token,
        )
      ) {
        return true;
      }
    }

    return false;
  }
}
