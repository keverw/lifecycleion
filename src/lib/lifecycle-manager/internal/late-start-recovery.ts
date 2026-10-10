import { observeRejection } from '../../internal/promise-reactions';
import { reportCallbackError } from '../../safe-handle-callback';
import { toError } from '../../to-error';
import type { ManagerCore } from './manager-core';
import type { StartSettlement } from './manager-state';

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
  // The settlements whose late start came up and whose recovery began cleaning it up: an
  // older late start waiting on one of them (`pendingRetry()`) leaves the component to
  // that cleanup.
  private readonly cleanedUpLateStarts = new WeakSet<StartSettlement>();

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
    // Whether the registration the attempt started is still the one under the name.
    isSameRegistration: () => boolean,
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
      // The start token the cleanup runs under: the attempt's own, or that of a newer
      // attempt that left the component down (`adoptableStartToken()`).
      let cleanupToken = startAttemptToken;
      let isCleanupSuperseded = isSuperseded;
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
        let timeoutState = this.core.state.componentStates.get(name);
        let timeoutError = this.core.state.componentErrors.get(name) ?? null;
        // A start - forced or not - that reported an unexpected stop before its deadline
        // ended as that stop, not as a timeout. Read before cleanup's own stop clears it.
        const didStopUnexpectedly =
          this.core.state.componentUnexpectedStopHadError.has(name);

        // A retry of the same registration took the name over, and it has ended without
        // the component up - its own `start()` failed, say. Nothing else will stop what
        // this late start brought up, so the cleanup runs under that retry's token,
        // leaving the state the retry left. A retry still in flight - its attempt, or its
        // own late-start recovery - is waited out and the decision made again once it
        // ends. A retry that came up - even late, its own cleanup stopping the component
        // - or a replacement, is left alone. A retry whose `start()` never settles is
        // waited on for as long: `stop()` never runs beside a pending `start()` of the
        // same instance, and a shutdown reports that start as `cleanup_incomplete`.
        if (isSuperseded()) {
          let adoptedToken = this.adoptableStartToken(name, isSameRegistration);
          while (adoptedToken === undefined) {
            const retry = this.pendingRetry(name, isSameRegistration);
            if (retry === undefined) {
              return;
            }
            await (retry.didSettle ? retry.rawStartDone : retry.promise);
            if (this.cleanedUpLateStarts.has(retry)) {
              return;
            }
            adoptedToken = this.adoptableStartToken(name, isSameRegistration);
            timeoutState = this.core.state.componentStates.get(name);
            timeoutError = this.core.state.componentErrors.get(name) ?? null;
          }
          cleanupToken = adoptedToken;
          isCleanupSuperseded = (): boolean =>
            !isSameRegistration() ||
            this.core.state.componentStartAttemptTokens.get(name) !==
              adoptedToken;
        }

        // A forced start still owes cleanup if the old stalled stop finished first.
        // So does any start, forced or not, that reported an unexpected stop before its
        // deadline: `start()` fulfilled anyway, and what it brought up is owned by nothing.
        // The instance and startup token must still belong to this attempt; a retry it
        // adopted above has had its state checked there.
        if (
          this.core.state.runningComponents.has(name) ||
          timeoutState === undefined ||
          (cleanupToken === startAttemptToken &&
            timeoutState !== 'starting-timed-out' &&
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
        this.core.state.pendingBulkStartupCleanup.set(name, cleanupToken);
        if (settlement) {
          // Cleanup now holds the registry latch; shutdown joins its stop rather
          // than treating it as startup that has not finished yet.
          settlement.isAwaitingLateStart = false;
          this.cleanedUpLateStarts.add(settlement);
        }
        // What the cleanup's stop leaves, applied by `markComponentStopped()` so its
        // `component:stopped` carries it: the state and error the failed start left -
        // `starting-timed-out` for a deadline, the state an observation failure or an
        // unexpected stop put back - so its failure is retained. Successful cleanup
        // retires any pre-existing stall from a forced start, leaving the timeout for a
        // deadline and `stopped` for the others.
        this.core.state.lateStartCleanupOutcomes.set(name, {
          token: cleanupToken,
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
        if (isCleanupSuperseded()) {
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
          this.core.state.pendingBulkStartupCleanup.get(name) === cleanupToken
        ) {
          this.core.state.pendingBulkStartupCleanup.delete(name);
        }
        if (
          this.core.state.lateStartCleanupOutcomes.get(name)?.token ===
            cleanupToken &&
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

  /**
   * The start token of the newer attempt that superseded a late start, when that start's
   * cleanup may run under it: the same registration, with nothing in flight on the name
   * - no claim, no pending `start()`, no cleanup, and no late-start recovery of the newer
   * attempt's own - and the component neither up nor stalled. `undefined` when the newer
   * attempt or a replacement owns the name.
   */
  private adoptableStartToken(
    name: string,
    isSameRegistration: () => boolean,
  ): string | undefined {
    const { state } = this.core;
    const componentState = state.componentStates.get(name);
    const token = state.componentStartAttemptTokens.get(name);
    if (
      token === undefined ||
      Array.from(state.startSettlementsByName.get(name) ?? []).some(
        (settlement) =>
          settlement.token === token && settlement.recovery !== undefined,
      )
    ) {
      return undefined;
    }
    if (
      !isSameRegistration() ||
      state.componentClaims.has(name) ||
      state.runningComponents.has(name) ||
      state.stalledComponents.has(name) ||
      state.pendingBulkStartupCleanup.has(name) ||
      this.core.startSettlements.isRawStartPending(name) ||
      (componentState !== 'registered' &&
        componentState !== 'stopped' &&
        componentState !== 'failed' &&
        componentState !== 'starting-timed-out')
    ) {
      return undefined;
    }
    return token;
  }

  /**
   * The settlement a late start that `adoptableStartToken()` turned away waits on before
   * deciding again: the newer attempt of the same registration that holds the name - its
   * claim, or the start token it last issued - while that attempt, with any late-start
   * recovery of its own (`promise`), or its raw start (`rawStartDone`), has not ended.
   * `undefined` when there is nothing of that registration's to wait for: the component
   * is up or stalled, a stop holds the name, or it was unregistered or replaced.
   */
  private pendingRetry(
    name: string,
    isSameRegistration: () => boolean,
  ): StartSettlement | undefined {
    const { state } = this.core;
    if (
      !isSameRegistration() ||
      state.runningComponents.has(name) ||
      state.stalledComponents.has(name)
    ) {
      return undefined;
    }
    const claim = state.componentClaims.get(name)?.claim;
    const token = state.componentStartAttemptTokens.get(name);
    for (const settlement of state.startSettlementsByName.get(name) ?? []) {
      if (
        ((claim !== undefined &&
          state.startSettlements.get(claim) === settlement) ||
          (token !== undefined && settlement.token === token)) &&
        (!settlement.didSettle || settlement.rawStartPending)
      ) {
        return settlement;
      }
    }
    return undefined;
  }
}
