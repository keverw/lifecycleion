import { observeRejection } from '../../internal/intrinsics';
import type { ShutdownSignal } from '../../process-signal-manager';
import {
  reportCallbackError,
  safeHandleCallback,
} from '../../safe-handle-callback';
import type {
  ForceShutdownContext,
  ShutdownEscalationStatus,
  ShutdownMethod,
} from '../types';
import type { ManagerCore } from './manager-core';

/**
 * Shutdown requests and repeated-request escalation.
 *
 * A shutdown signal arrives here: it starts a pass through `core.shutdownPass`, or -
 * when one is already running - is noted on that pass. Under a
 * `repeatedShutdownRequestPolicy`, the requests of one shutdown cycle are counted, and
 * reaching `forceAfterCount` within `withinMS` invokes `onForceShutdown` once per cycle.
 * A pass that fails can keep the cycle armed for `armedAfterFailureMS`, so a retry
 * continues its count; a clean pass ends it.
 *
 * The cycle itself stays on the state (`repeatedShutdownRequestState`), where the pass
 * seeds and settles it; the armed window's expiry timer is this subsystem's own.
 */
export class ShutdownEscalation {
  /** Expires the post-failure armed window; `null` while none is armed. */
  private repeatedShutdownExpiryTimer: NodeJS.Timeout | null = null;

  constructor(private readonly core: ManagerCore) {}

  /** The body of the manager's public `getShutdownEscalationStatus()`, which documents it. */
  public status(): ShutdownEscalationStatus {
    if (this.core.config.repeatedShutdownRequestPolicy === undefined) {
      return {
        configured: false,
        isShuttingDown: this.core.shutdownPass.isShuttingDown,
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
      this.core.state.repeatedShutdownRequestState.remainsArmedUntil;
    const isArmed = armedUntil !== null;

    return {
      configured: true,
      isShuttingDown: this.core.shutdownPass.isShuttingDown,
      isArmed,
      forceAfterCount:
        this.core.config.repeatedShutdownRequestPolicy.forceAfterCount,
      withinMS: this.core.config.repeatedShutdownRequestPolicy.withinMS,
      armedAfterFailureMS:
        this.core.config.repeatedShutdownRequestPolicy.armedAfterFailureMS,
      armedAfterFailureMSSource: this.core.config.repeatedShutdownRequestPolicy
        .hasExplicitArmedAfterFailureMS
        ? 'explicit'
        : 'derived',
      countManualRetriesTowardEscalation:
        this.core.config.repeatedShutdownRequestPolicy
          .countManualRetriesTowardEscalation,
      requestCount: this.core.state.repeatedShutdownRequestState.requestCount,
      firstMethod: this.core.state.repeatedShutdownRequestState.firstMethod,
      latestMethod: this.core.state.repeatedShutdownRequestState.latestMethod,
      firstRequestAt:
        this.core.state.repeatedShutdownRequestState.firstRequestAt,
      latestRequestAt:
        this.core.state.repeatedShutdownRequestState.latestRequestAt,
      repeatedWindowStartedAt:
        this.core.state.repeatedShutdownRequestState.repeatedWindowStartedAt,
      armedUntil: isArmed ? armedUntil : null,
      hasTriggeredForceShutdown:
        this.core.state.repeatedShutdownRequestState.hasTriggeredForceShutdown,
    };
  }

  /**
   * Handle shutdown signal - initiates stopAllComponents().
   *
   * Four cases depending on the current shutdown state:
   *
   * 1. **Active shutdown** (`isShuttingDown = true`): escalate through the
   *    repeated-shutdown policy if configured, otherwise log and discard. A pass
   *    with no escalation cycle yet - a restart's stop phase - has this request seed
   *    one instead of counting it. Emits `signal:shutdown` with
   *    `isAlreadyShuttingDown: true` and returns without starting another shutdown.
   *    When that shutdown is a restart's stop phase, the request also cancels the
   *    restart's startup phase.
   *
   * 2. **Armed post-failure** (previous shutdown finished, armed window still
   *    open): count the request toward the escalation window, emit
   *    `signal:shutdown` with `isAlreadyShuttingDown: false`, then start a
   *    new `stopAllComponents()` run to retry - unless the force handler or a
   *    listener already started one, which is then this request's pass.
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
  public handleShutdownRequest(method: ShutdownSignal): void {
    return this.core.dispatcher.withTransition(() => {
      if (this.core.shutdownPass.isShuttingDown) {
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
        this.core.config.repeatedShutdownRequestPolicy !== undefined &&
        this.core.state.escalationHandlingDepth === 0;

      // This branch is only for the post-failure "armed" state.
      // A previous shutdown request already happened, shutdown has already
      // finished returning, and we intentionally keep escalation alive for a
      // short period so follow-up presses can continue the same force count.
      if (
        this.core.config.repeatedShutdownRequestPolicy &&
        this.core.state.repeatedShutdownRequestState.firstRequestAt !== null &&
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
      } else if (this.core.shutdownPass.isShuttingDown) {
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
      this.core.state.escalationHandlingDepth++;
      try {
        this.core.logger.info('Shutdown signal received', {
          params: { method },
        });
      } finally {
        this.core.state.escalationHandlingDepth--;
      }

      if (!didEmitShutdownSignal && !this.core.shutdownPass.isShuttingDown) {
        this.emitSignalShutdownForNewRequest(method);
        didEmitShutdownSignal = true;
      }

      // A pass begun by this request's own handling - a sink behind the line above, a
      // `signal:shutdown` listener, or an armed retry's force handler - is the one this
      // signal asked for. Recorded on it, and announced as landing on a running pass if
      // the signal was not announced yet, but neither counted as a press nor refused as
      // a second request: it is this request.
      if (this.core.shutdownPass.isShuttingDown) {
        this.core.shutdownPass.noteShutdownRequestDuringActivePass();
        if (!didEmitShutdownSignal) {
          this.core.lifecycleEvents.signalShutdown(method, true);
        }

        return;
      }

      // Signal handlers cannot consume a return value, so the acknowledgement is dropped;
      // a pass that failed to start has already been reported on the global channel.
      this.startShutdownPass(method);
    });
  }

  /**
   * Counts a repeated shutdown request - a signal landing on a running pass, or a retry
   * through the post-failure armed window (a signal, or a manual stop under
   * `countManualRetriesTowardEscalation`) - and invokes the configured force shutdown
   * callback when the threshold is reached.
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
  public handleRepeatedShutdownRequest(
    method: ShutdownMethod,
    consumedArmedUntil: number | null,
  ): void {
    return this.core.dispatcher.withTransition(() => {
      this.core.state.escalationHandlingDepth++;

      try {
        this.handleRepeatedShutdownRequestInner(method, consumedArmedUntil);
      } finally {
        this.core.state.escalationHandlingDepth--;
      }
    });
  }

  /**
   * How a pass's outcome settles escalation: a clean pass ends the cycle, a failed one
   * re-arms it with the count carried over.
   */
  public settleRepeatedShutdownAfterPass(isSuccess: boolean): void {
    if (isSuccess) {
      this.resetRepeatedShutdownRequestState();
    } else {
      this.armRepeatedShutdownAfterFailure();
    }
  }

  /**
   * Clears repeated shutdown request tracking so a new shutdown cycle starts fresh.
   */
  public resetRepeatedShutdownRequestState(): void {
    this.clearRepeatedShutdownExpiryTimer();
    this.core.state.repeatedShutdownRequestState = {
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
  public consumeRepeatedShutdownArmedWindow(): number | null {
    const armedUntil =
      this.core.state.repeatedShutdownRequestState.remainsArmedUntil;

    if (armedUntil === null) {
      return null;
    }

    this.clearRepeatedShutdownExpiryTimer();
    this.core.state.repeatedShutdownRequestState.remainsArmedUntil = null;

    return armedUntil;
  }

  /**
   * Returns whether post-failure escalation remains armed after first
   * normalizing any stale timer-backed state.
   *
   * The method can expire old armed windows as a side effect because the timer
   * callback may not have run yet on a delayed event loop. Callers use this
   * when they need the effective runtime truth, not just the last timer write.
   */
  public normalizeRepeatedShutdownRequestStateArmedStatus(
    now = Date.now(),
  ): boolean {
    const armedUntil =
      this.core.state.repeatedShutdownRequestState.remainsArmedUntil;

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
   * Seeds shutdown escalation tracking for a new shutdown cycle.
   *
   * The first shutdown trigger starts graceful shutdown and arms escalation with
   * an effective post-start count of 0. Later shutdown requests can then count
   * toward the configured force threshold regardless of whether the shutdown
   * started from a signal, keyboard shortcut, or direct API call.
   */
  public seedRepeatedShutdownRequestState(method: ShutdownMethod): void {
    const now = Date.now();
    this.core.state.repeatedShutdownRequestState = {
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
  public armRepeatedShutdownAfterFailure(): void {
    return this.core.dispatcher.withTransition(() => {
      const policy = this.core.config.repeatedShutdownRequestPolicy;
      const state = this.core.state.repeatedShutdownRequestState;

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
        this.core.lifecycleEvents.lifecycleManagerShutdownEscalationArmed({
          firstMethod: state.firstMethod,
          requestCount: state.requestCount,
          armedUntil,
        });
      }
    });
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
    this.core.state.escalationHandlingDepth++;

    try {
      this.core.lifecycleEvents.signalShutdown(method, false);
    } finally {
      this.core.state.escalationHandlingDepth--;
    }
  }

  /**
   * A shutdown signal that lands while a pass is running: noted on the pass, emitted
   * once as already-shutting-down, and counted - or, when no cycle is running yet,
   * made the cycle's initial request.
   */
  private answerShutdownSignalDuringPass(method: ShutdownSignal): void {
    return this.core.dispatcher.withTransition(() => {
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
      if (this.core.config.repeatedShutdownRequestPolicy !== undefined) {
        this.normalizeRepeatedShutdownRequestStateArmedStatus();
      }
      const isFirstRequestOfCycle =
        this.core.config.repeatedShutdownRequestPolicy !== undefined &&
        this.core.state.repeatedShutdownRequestState.firstRequestAt === null;
      // Read before any listener runs; only for the log line below.
      const isDuringRestart =
        this.core.state.activeShutdownPass?.isRestartStopPhase === true;

      this.core.shutdownPass.noteShutdownRequestDuringActivePass();
      if (isFirstRequestOfCycle) {
        // This is a synchronous control checkpoint. Its listeners must find the
        // restart's new shutdown cycle already seeded, rather than seed a competing
        // cycle when they re-enter through another signal or a manual stop.
        this.seedRepeatedShutdownRequestState(method);
      }
      this.core.lifecycleEvents.signalShutdown(method, true);

      if (isFirstRequestOfCycle) {
        this.core.logger.info(
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
   * Final step of a signal-driven shutdown request: starts the pass in the background and
   * returns without waiting for components to stop, since a signal handler has nobody to
   * hand a result to. The outcome arrives on `lifecycle-manager:shutdown-completed`.
   */
  private startShutdownPass(method: ShutdownSignal): void {
    return this.core.dispatcher.withTransition(() => {
      // A signal means the process should stay down, so a refusal is recorded on the
      // running pass. `handleShutdownRequest()` answers a pass its own handling began
      // before calling this; the acceptance still rechecks the latch itself.
      const acceptance = this.core.shutdownPass.acceptShutdownPass(
        method,
        undefined,
        true,
      );

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

  private handleRepeatedShutdownRequestInner(
    method: ShutdownMethod,
    consumedArmedUntil: number | null,
  ): void {
    const policy = this.core.config.repeatedShutdownRequestPolicy;

    if (!policy) {
      // Signals only: a `'manual'` request never reaches here without a policy.
      this.core.logger.warn('Shutdown already in progress, ignoring signal', {
        params: { method },
      });
      return;
    }

    const now = Date.now();
    const state = this.core.state.repeatedShutdownRequestState;

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
          this.core.shutdownPass.isShuttingDown &&
          this.core.state.repeatedShutdownRequestState.firstRequestAt === null
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
    const wasArmedAfterFailure =
      armedUntil !== null && !this.core.shutdownPass.isShuttingDown;

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
    this.core.logger.warn(
      // Only signals reach here mid-shutdown; a `'manual'` request is never counted then.
      this.core.shutdownPass.isShuttingDown
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
    if (this.core.state.repeatedShutdownRequestState !== state) {
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
      isShuttingDown: this.core.shutdownPass.isShuttingDown,
      wasArmedAfterFailure,
    };

    this.core.logger.warn(
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
    this.core.state.forceHandlingDepth++;

    try {
      safeHandleCallback(
        'repeatedShutdownRequestPolicy.onForceShutdown',
        policy.onForceShutdown,
        context,
      );
      this.core.lifecycleEvents.lifecycleManagerShutdownEscalationForced({
        firstMethod: context.firstMethod,
        latestMethod: context.latestMethod,
        requestCount: context.requestCount,
        firstRequestAt: context.firstRequestAt,
        latestRequestAt: context.latestRequestAt,
        wasArmedAfterFailure: context.wasArmedAfterFailure,
      });
    } finally {
      this.core.state.forceHandlingDepth--;
    }
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
   * Transition armed post-failure escalation state into its expired/reset state.
   */
  private expireRepeatedShutdownRequestState(): void {
    return this.core.dispatcher.withTransition(() => {
      const policy = this.core.config.repeatedShutdownRequestPolicy;
      const state = this.core.state.repeatedShutdownRequestState;

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

      this.core.logger.warn(
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
        this.core.lifecycleEvents.lifecycleManagerShutdownEscalationExpired({
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
    const policy = this.core.config.repeatedShutdownRequestPolicy;

    if (!policy) {
      return;
    }

    this.clearRepeatedShutdownExpiryTimer();

    const armedUntil = now + policy.armedAfterFailureMS;
    this.core.state.repeatedShutdownRequestState.remainsArmedUntil = armedUntil;
    this.repeatedShutdownExpiryTimer = setTimeout(() => {
      this.expireRepeatedShutdownRequestState();
    }, policy.armedAfterFailureMS);
    // Expiry should not keep the process alive when nothing else is pending.
    // Where setTimeout returns a numeric id (browsers, Deno) there is nothing to unref.
    if (typeof this.repeatedShutdownExpiryTimer === 'object') {
      this.repeatedShutdownExpiryTimer.unref?.();
    }
  }
}
