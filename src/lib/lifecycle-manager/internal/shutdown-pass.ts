import { ulid } from 'ulid';
import { observeRejection } from '../../internal/intrinsics';
import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import {
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
} from '../constants';
import { StartupInterruptedByShutdownError } from '../errors';
import type {
  ComponentOperationResult,
  ComponentStallInfo,
  ShutdownMethod,
  ShutdownResult,
  StopAllOptions,
} from '../types';
import type { ShutdownPassOptions } from './manager-config';
import type { ManagerCore } from './manager-core';
import {
  isStartUnfinished,
  type ShutdownPass,
  type StartSettlement,
} from './manager-state';
import {
  snapshotStopAllOptions,
  type StopAllOptionsSnapshot,
} from './operation-options';
import {
  refusedShutdownResult,
  resolveOperationTimeoutMS,
} from './operation-policy';
import { runShutdownWarningPhase } from './shutdown-warning';

/** A shutdown request refused because a pass is already running. */
export interface ShutdownPassRefusal {
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
export type ShutdownPassAcceptance =
  | ShutdownPassRefusal
  | {
      readonly accepted: true;
      readonly pass: ShutdownPass;
      readonly promise: Promise<ShutdownResult>;
    };

/**
 * The shutdown pass: the latch (`isShuttingDown`), deciding whether a pass may start,
 * and the pass itself - the warning phase, the stop loop in reverse dependency order,
 * joining the starts in flight as it began, and the result it reports.
 *
 * Every pass starts through `acceptShutdownPass()`: `stopAllComponents()`, a signal
 * through `core.shutdownEscalation`, the logger exit hook through the public method,
 * and a restart's stop phase. A request that finds a pass already running is refused,
 * and - when it asks to stay down - noted on that pass. How the pass's outcome settles
 * repeated-request escalation is `core.shutdownEscalation`'s.
 */
export class ShutdownPassRunner {
  constructor(private readonly core: ManagerCore) {}

  /** The shutdown latch: set exactly while a shutdown pass is running. */
  public get isShuttingDown(): boolean {
    return this.core.state.activeShutdownPass !== null;
  }

  public async stopAllComponentsOperation(
    options?: StopAllOptions,
  ): Promise<ShutdownResult> {
    // Always the manual method for the public API, as it is not from a signal. A direct
    // stop call made while a shutdown is running expresses the same intent a signal
    // does, so a refusal is recorded on the running pass - before reading `options`:
    // they are the caller's, and a getter that threw there skipped this refusal, so a
    // request to stay down was never recorded and a restart started everything again.
    const refusal = this.core.dispatcher.withTransition(() =>
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
  public acceptShutdownPass(
    method: ShutdownMethod,
    options: StopAllOptionsSnapshot | undefined,
    isRequestToStayDown: boolean,
    pendingRestartAutoStarts?: Set<string>,
  ): ShutdownPassAcceptance {
    return this.core.dispatcher.withTransition(() => {
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
          this.core.config.shutdownOptions.timeoutMS,
          'stopAllComponents timeoutMS',
        ),
        retryStalled:
          (options?.retryStalled ??
            this.core.config.shutdownOptions.retryStalled) !== false,
        haltOnStall:
          (options?.haltOnStall ??
            this.core.config.shutdownOptions.haltOnStall) !== false,
        allowStopWithPendingStarts:
          (options?.allowStopWithPendingStarts ??
            this.core.config.shutdownOptions.allowStopWithPendingStarts) ===
          true,
        waitForAbandonedStarts:
          (options?.waitForAbandonedStarts ??
            this.core.config.shutdownOptions.waitForAbandonedStarts) === true,
        abortPendingStarts:
          (options?.abortPendingStarts ??
            this.core.config.shutdownOptions.abortPendingStarts) === true,
      };

      // A restart's stop phase expired a lapsed window itself, before its preflight
      // checks (see `restartAllComponentsOperation()`): the expiry logs through the
      // caller's sinks, which must not run between those checks and this pass.
      if (isRequestToStayDown) {
        this.core.shutdownEscalation.normalizeRepeatedShutdownRequestStateArmedStatus();
      }

      const repeatedShutdownPolicy =
        this.core.config.repeatedShutdownRequestPolicy;
      const isManualRetryWhileArmed =
        repeatedShutdownPolicy !== undefined &&
        method === 'manual' &&
        this.core.state.repeatedShutdownRequestState.firstRequestAt !== null &&
        this.core.state.repeatedShutdownRequestState.remainsArmedUntil !== null;

      // Taken before the bookkeeping below, not after it, and unconditionally: this request
      // is the one about to start a pass, so the window is spent on it either way. Doing it
      // first is what makes the spending atomic - the counting a line down can reach
      // `onForceShutdown`, and a shutdown request made from inside that callback must find
      // no armed window to count itself against. It is a continuation of this request, not a
      // second operator press.
      const consumedArmedUntil =
        this.core.shutdownEscalation.consumeRepeatedShutdownArmedWindow();

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
        this.core.state.escalationHandlingDepth === 0 &&
        !this.isShuttingDown &&
        this.core.state.repeatedShutdownRequestState.firstRequestAt !== null
      ) {
        this.core.shutdownEscalation.resetRepeatedShutdownRequestState();
      }

      // Only a request to stay down is an operator's retry. A restart's stop phase does not
      // advance the escalation count - it would force-kill a process it was asked to
      // restart - and does not clear it as a request either. It is still a shutdown pass,
      // so its outcome settles escalation as any pass's does: a clean stop resets it, a
      // failed one re-arms it with the count carried over.
      if (isManualRetryWhileArmed && isRequestToStayDown) {
        if (repeatedShutdownPolicy.countManualRetriesTowardEscalation) {
          this.core.shutdownEscalation.handleRepeatedShutdownRequest(
            method,
            consumedArmedUntil,
          );
        } else {
          this.core.shutdownEscalation.resetRepeatedShutdownRequestState();
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
          this.core.logger.warn(
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
        this.core.state.stayDownPassCount++;
        this.core.state.stayDownRequestCount++;
      }

      if (pendingRestartAutoStarts !== undefined) {
        this.core.state.pendingRestartAutoStarts.add(pendingRestartAutoStarts);
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
  public noteShutdownRequestDuringActivePass(): void {
    if (this.core.state.activeShutdownPass !== null) {
      this.core.state.activeShutdownPass.shutdownRequested = true;
      this.core.state.stayDownRequestCount++;
    }
  }

  /**
   * A start that already timed out - abandoned to late cleanup, or settled by its abort
   * hook - while its raw `start()` is still unresolved. A shutdown pass does not spend
   * its budget waiting for one, and reports it as `cleanup_incomplete`.
   */
  public isUnresolvedTimedOutStart(
    settlement: StartSettlement | undefined,
  ): boolean {
    return (
      settlement !== undefined &&
      settlement.rawStartPending &&
      (settlement.isAwaitingLateStart === true || settlement.didSettle)
    );
  }

  /** Names whose current start is {@link isUnresolvedTimedOutStart}, in registry order. */
  public unresolvedTimedOutStartNames(): string[] {
    const currentStarts = this.core.componentStart.currentStartSettlements();
    return this.core.state.components
      .map((component) => this.core.registry.nameOf(component))
      .filter((name) =>
        this.isUnresolvedTimedOutStart(currentStarts.get(name)),
      );
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
      this.core.logger.warn(
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
    const requestingStarts = new Set(this.core.state.invokingStarts);
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
        .map((name) => this.core.state.stalledComponents.get(name))
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
          this.core.state.componentStates.get(name) !== 'stopped' ||
          (startOnlyBaselines.has(name) &&
            !pass.cameUp.has(name) &&
            startOnlyBaselines.get(name) ===
              this.core.state.componentStopAttemptTokens.get(name))
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
      this.core.state.activeShutdownPass = pass;
      this.core.state.shutdownToken = ulid();
      this.core.state.shutdownMethod = method;
      this.core.state.pendingStartAbortRequest = shouldAbortPendingStarts
        ? {
            shutdownToken: this.core.state.shutdownToken,
            method,
            requestingStarts,
          }
        : undefined;
      isDuringStartup = this.core.state.isStarting;
      if (
        this.core.config.repeatedShutdownRequestPolicy &&
        !pass.isRestartStopPhase &&
        this.core.state.repeatedShutdownRequestState.firstRequestAt === null
      ) {
        this.core.shutdownEscalation.seedRepeatedShutdownRequestState(method);
      }

      this.core.logger.info('Stopping all components', {
        params: { method, allowStopWithPendingStarts },
      });
      didAnnounceShutdown = true;
      this.core.lifecycleEvents.lifecycleManagerShutdownInitiated(
        method,
        isDuringStartup,
      );

      // Get shutdown order (reverse topological order)
      let shutdownOrder: string[];

      try {
        const startupOrder =
          this.core.startupOrdering.getStartupOrderInternal();
        shutdownOrder = [...startupOrder].reverse();
      } catch (error) {
        // If we can't resolve order due to cycle, fall back to reverse registration order
        const err = toError(error);

        this.core.logger.warn(
          'Could not resolve shutdown order, using registration order: {{error.message}}',
          { params: { error: err, method } },
        );

        shutdownOrder = this.core.state.components
          .map((c) => this.core.registry.nameOf(c))
          .reverse();
      }

      const stalledComponentNames = new Set(
        this.core.state.stalledComponents.keys(),
      );

      // Filter to running components, plus stalled ones if retrying
      const runningComponentsToStop = shutdownOrder.filter(
        (name) =>
          this.core.manager.isComponentRunning(name) ||
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
          this.core.state.componentStates.get(name) === 'starting' ||
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
            this.core.state.componentStopAttemptTokens.get(name),
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
        const component = this.core.registry.getComponent(name);

        return component === undefined
          ? []
          : this.core.componentMetadata.readDependencies(component, 'shutdown');
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
        !this.core.state.runningComponents.has(owner) &&
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
                this.core.logger.warn(
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
        const state = this.core.state.componentStates.get(name);
        return (
          allowStopWithPendingStarts &&
          currentStarts.get(name)?.rawStartPending === true &&
          state !== 'stopping' &&
          state !== 'force-stopping' &&
          !this.core.state.stalledComponents.has(name)
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
              this.core.state.stalledComponents.has(name))
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
              this.core.state.stalledComponents.has(name)
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
            this.core.logger.warn(
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
              !this.core.registry.isComponentUp(name) &&
              !isRetryingStall
            ) {
              continue;
            }
            if (currentStarts.has(name) || startupDependencies.has(name)) {
              await joinStarts();
            }
            if (
              currentStarts.has(name) &&
              !this.core.registry.isComponentUp(name) &&
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
              shouldHaltOnStall && this.core.state.stalledComponents.size > 0
                ? [...concurrentOwners].find(
                    (owner) =>
                      this.core.state.stalledComponents.has(owner) &&
                      !isStartStillInProgress(owner),
                  )
                : undefined;
            if (concurrentStall !== undefined) {
              for (const skipped of names.slice(index)) {
                haltSkippedNames.add(skipped);
              }
              this.core.logger.warn(
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

            this.core.logger.entity(name).info('Stopping component');

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
            const isRunning = this.core.manager.isComponentRunning(name);
            // Read now, not from the snapshot taken as the pass began: a stall can clear
            // mid-pass - an old stop settling - and a retry of a component that is no
            // longer stalled or running only failed, halting the loop.
            const isStalled = this.core.state.stalledComponents.has(name);
            const currentState = this.core.state.componentStates.get(name);

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
                    status: this.core.manager.getComponentStatus(name),
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
                !this.core.state.runningComponents.has(name) &&
                !this.core.state.stalledComponents.has(name)
              ) {
                if (this.core.state.componentStates.get(name) === 'stopped') {
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
              if (this.core.manager.isComponentRunning(name)) {
                concurrentOwners.add(name);
              }
              this.core.logger
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
                this.core.logger.warn(
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
          (!this.core.state.runningComponents.has(name) &&
            !this.core.claims.isInFlight(name) &&
            !this.core.state.stalledComponents.has(name))
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
          this.core.state.runningComponents.has(name) &&
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
      this.core.logger[isSuccess ? 'success' : 'warn'](
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
          this.core.state.runningComponents.has(name) ||
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

      return this.core.dispatcher.withTransition(() => {
        // Store for getLastShutdownResult() - useful for debugging and metrics
        this.core.state.lastShutdownResult = result;

        // Before the completed event, as the last component's stop detached them before
        // this pass took the detach over: a listener there - one that calls
        // `process.exit()`, say - finds stdin restored and `signals-detached` already
        // emitted, and one that attaches again is not undone afterwards. Covers the detach
        // this pass's own stops deferred, and one a refused or aborted startup left to it.
        // Only after a clean pass: a failed one keeps them, so the operator's next Ctrl+C
        // still reaches escalation.
        if (isSuccess) {
          this.core.signals.detachSignalsIfIdle('shutdown', {
            isEndingShutdownPass: true,
          });
        }

        this.core.lifecycleEvents.lifecycleManagerShutdownCompleted({
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

        this.core.shutdownEscalation.settleRepeatedShutdownAfterPass(isSuccess);

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
          this.core.shutdownEscalation.settleRepeatedShutdownAfterPass(
            completedResult.success,
          );
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

      return this.core.dispatcher.withTransition(() => {
        this.core.state.lastShutdownResult = result;

        if (!didAnnounceShutdown) {
          didAnnounceShutdown = true;
          this.core.lifecycleEvents.lifecycleManagerShutdownInitiated(
            method,
            isDuringStartup,
          );
        }
        this.core.lifecycleEvents.lifecycleManagerShutdownCompleted({
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
        this.core.shutdownEscalation.armRepeatedShutdownAfterFailure();

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
          this.core.logger.warn(
            'Shutdown operation failed after the global timeout: {{error.message}}',
            { params: { error: toError(error) } },
          );
        });
      }

      this.core.dispatcher.withTransition(() => {
        this.core.state.activeShutdownPass = null;
        // Its cue is this pass's alone, and it holds the pass's requesting starts.
        this.core.state.pendingStartAbortRequest = undefined;
        this.core.registry.updateStartedFlag();

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
        this.core.logger
          .entity(name)
          .info('Aborted pending start for shutdown');
      }
    }
  }

  /**
   * Global warning phase (stopAllComponents only)
   * Calls onShutdownWarning() on running components with a global timeout.
   * Kept as a method, not inlined: it is the seam tests use to make a pass crash.
   */
  private runShutdownWarningPhase(componentNames: string[]): Promise<void> {
    return runShutdownWarningPhase(
      this.core.componentAccess,
      componentNames,
      this.core.config.shutdownWarningTimeoutMS,
    );
  }
}
