import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import {
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
  LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
} from '../constants';
import { DependencyCycleError } from '../errors';
import type {
  ComponentOperationResult,
  StartupOptions,
  StartupResult,
} from '../types';
import type { RestartStartSnapshot } from './component-start';
import { type DependencyRead, dependenciesOf } from './dependency-policy';
import type { ManagerCore } from './manager-core';
import type { ActiveBulkStartup } from './manager-state';
import {
  snapshotStartOptions,
  snapshotStartupOptions,
} from './operation-options';
import {
  crashedStartupResult,
  refusedStartupResult,
  resolveOperationTimeoutMS,
} from './operation-policy';
import { takeRestartStartupDispatch } from './restart-dispatch';

/**
 * One bulk startup that has taken the latch and begun: what it has started, skipped and
 * given up on, its deadline, the record it publishes as `activeBulkStartup`, and the
 * reasons its release will report. Created once the startup has attached signals and
 * cleared the previous shutdown state, and handed to every phase of
 * `StartupOrchestration` that follows, which reads and updates it in place. It runs no
 * code of its own.
 */
class StartupRun {
  public readonly startedComponents: string[] = [];
  public readonly failedOptionalComponents: Array<{
    name: string;
    error: Error;
  }> = [];
  public readonly skippedDueToDependency = new Set<string>();
  public readonly skippedDueToStall = new Set<string>();
  public hasTimedOut = false;
  // What the release reports of auto-starts left unattempted, and why it detaches.
  public abandonReason = 'failed before starting components';
  public detachReason = 'failed bulk startup';
  public timeoutHandle: NodeJS.Timeout | undefined;
  public readonly deadline: number | undefined;
  // Every rollback in this startup goes through `rollBackOnce()`, tracking which names it
  // has already rolled back: one that throws partway - and lands in the crash path, which
  // rolls back too - neither stops the same component twice nor skips the ones it had
  // not reached.
  public readonly rolledBackNames = new Set<string>();
  public readonly bulkStartup: ActiveBulkStartup = {
    dependencyReads: new Map<BaseComponent, DependencyRead>(),
    isRollingBack: false,
    isOrdering: true,
    isCompleting: false,
    initialOrderNames: new Set<string>(),
    reachedNames: new Set<string>(),
    frozenAutoStarts: new Set<string>(),
  };
  // The order the next drain of the batch loop starts with: the initial order, then
  // empty for the drains that only own follow-up batches.
  public startupOrder: string[] = [];

  constructor(
    public readonly startTime: number,
    public readonly effectiveTimeout: number,
    public readonly restartSnapshots:
      Map<string, RestartStartSnapshot> | undefined,
    public readonly didAutoAttachSignals: boolean,
    // Whether a shutdown has begun since this startup took the latch.
    public readonly hasShutdownBegun: () => boolean,
  ) {
    this.deadline =
      effectiveTimeout > 0 ? Date.now() + effectiveTimeout : undefined;
  }
}

/** What `reconcileOrFail()` decided: an answer now, or one once its rollback settles. */
type ReconciliationOutcome =
  | { kind: 'result'; value: StartupResult }
  | { kind: 'rollback'; pending: Promise<void>; error: Error };

/**
 * How a step of the batch loop ends the loop: leaving it for the deadline (`break`),
 * answering now, or answering once the rollback the step began settles. The step only
 * begins that rollback and the loop awaits it directly, so rolling back adds no async
 * wrapper ahead of the answer.
 */
type BatchExit =
  | { readonly kind: 'break' }
  | { readonly kind: 'result'; readonly value: StartupResult }
  | {
      readonly kind: 'rollback';
      readonly pending: Promise<void>;
      readonly finish: () => StartupResult;
    };

/**
 * A crash of the run as `reportStartupCrash()` classified it: asked once, since a
 * thrown value's prototype chain can be caller code.
 */
interface StartupCrash {
  readonly error: Error;
  readonly isDependencyCycle: boolean;
}

/**
 * Bulk startup: `startAllComponents()`'s body, and a restart's startup phase. It refuses
 * a startup that would overlap another bulk operation or a partial state (through
 * `core.startupPreflight`), takes the startup latch (`isStarting`), starts the registry
 * in dependency order - and the auto-starts registered while it runs, in follow-up
 * batches - under one deadline, rolls back what it started when a required component
 * fails, and releases everything it holds from whichever exit it leaves by.
 *
 * While it runs it publishes its record as `activeBulkStartup`, which registration
 * consults: an auto-start registered from one of its callbacks joins it, and a
 * registration that would supply a dependency of its fixed order is refused
 * (`isRequiredDependencyDuringStartup()`). Individual starts go through
 * `core.componentStart`, rollback stops through `core.componentStop`.
 */
export class StartupOrchestration {
  constructor(private readonly core: ManagerCore) {}

  /**
   * The body of the manager's public `startAllComponents()`. `options` is the caller's
   * object, read once, after the refusals that need no options - or the object
   * `restartAllComponents()` handed the public method for its startup phase
   * (`restart-dispatch.ts`), which carries the options that restart already read and
   * validated and the snapshots of the registrations it approved. That lookup runs no
   * caller code.
   *
   * The phases, in order: refusals before the options are read and after, the registry
   * preflight (both `StartupPreflight`'s), taking the latch (`beginStartup()`), and the run
   * itself (`runStartup()`) - ordering, the batch loop, reconciliation, and finishing.
   */
  public async startAllComponentsOperation(
    options: StartupOptions | undefined,
  ): Promise<StartupResult> {
    const restart = takeRestartStartupDispatch(this.core, options);
    // A restart asked to stay down while an override awaited before handing this on.
    const canceledRestart =
      restart && this.core.restart.refuseCanceledRestartStartup(restart);
    if (canceledRestart) {
      return canceledRestart;
    }
    const startTime = Date.now();
    const alreadyActive =
      this.core.startupPreflight.refuseActiveBulkStartup(startTime);
    if (alreadyActive) {
      return alreadyActive;
    }
    // Every option is read up front, before the startup takes its latch: `options` is
    // the caller's object, and a getter that throws once `isStarting` is set would leave
    // it set for good. The timeout is only validated once the availability refusals
    // below are past - still before the latch: a startup that refuses never uses it, and
    // an availability refusal takes precedence over an option that would not be used.
    const startupOptions =
      restart?.startupOptions ?? snapshotStartupOptions(options);
    const shouldIgnoreStalledComponents =
      startupOptions.ignoreStalledComponents;
    const requestedTimeoutMS = startupOptions.timeoutMS;

    // Option getters can start a nested operation. Keep the post-read check too;
    // passing the initial guard does not reserve the startup latch.
    const becameActive =
      this.core.startupPreflight.refuseActiveBulkStartup(startTime);
    if (becameActive) {
      return becameActive;
    }

    const preflight = this.core.startupPreflight.preflightStartup(
      startTime,
      shouldIgnoreStalledComponents,
    );
    if (preflight) {
      return preflight;
    }
    // The preflight reads the registry through the manager's count and name getters,
    // which a subclass can override - and one can start a bulk operation of its own.
    const becameActiveDuringPreflight =
      this.core.startupPreflight.refuseActiveBulkStartup(startTime);
    if (becameActiveDuringPreflight) {
      return becameActiveDuringPreflight;
    }

    const effectiveTimeout = resolveOperationTimeoutMS(
      requestedTimeoutMS,
      this.core.config.startupTimeoutMS,
      'startAllComponents timeoutMS',
    );

    const run = this.beginStartup(
      startTime,
      effectiveTimeout,
      restart?.restartSnapshots,
    );
    if (!(run instanceof StartupRun)) {
      return run;
    }

    // Component starts already race against the bulk deadline. Await their bookkeeping
    // and our finally block before exposing the result to a caller that may retry.
    const result = await this.runStartup(run);
    // Preserve the stalled components actually skipped on every exit, including
    // partial results, failures, and deadlines before the remaining order runs.
    return run.skippedDueToStall.size === 0
      ? result
      : { ...result, skippedDueToStall: Array.from(run.skippedDueToStall) };
  }

  /**
   * Check if a component is a required dependency during startup
   * Used to prevent registering dependencies mid-startup which would break ordering
   * @param componentName - Component name to check
   * @returns true if this component would be a required dependency
   */
  public isRequiredDependencyDuringStartup(
    componentName: string,
    // Registration's lists, read before its checks; see `readRegistry()`.
    dependencySnapshot: ReadonlyMap<BaseComponent, DependencyRead>,
  ): boolean {
    // Not before the startup's loop has begun - a `signals-attached` listener
    // registering it: the loop computes its order after this, and starts it in turn.
    // Nor while it reads the registry to compute that order: this one is read with it.
    if (
      !this.core.state.isStarting ||
      this.core.state.activeBulkStartup === null ||
      this.core.state.activeBulkStartup.isOrdering
    ) {
      return false;
    }

    // Check if any existing component lists this new component as a dependency
    // Guarded: another component's dependency getter must not fail this registration.
    return this.core.state.components.some(
      (c) =>
        // Pending follow-ups have no fixed order yet. Their dependencies can still be
        // registered before that batch is frozen; original/planned components cannot.
        !this.core.state.deferredAutoStartNames.has(
          this.core.registry.nameOf(c),
        ) &&
        dependenciesOf(
          this.core.registry.currentReadOf(
            c,
            dependencySnapshot,
            this.core.state.activeBulkStartup?.dependencyReads,
          ),
        ).includes(componentName),
    );
  }

  /**
   * Warn about auto-starts left to a bulk startup that ended before its loop could start
   * them. Their registration already answered `autoStartDeferred: true`, so this is the
   * one place that says so. Callers hand over only names nothing else will start - a
   * newer startup that has already ordered a name takes it over instead (see
   * `releaseStartupLatch()`). Handed the names, already taken off the set: the warning
   * runs caller code, and the set may by then belong to the next startup.
   */
  public warnAbandonedAutoStarts(components: string[], reason: string): void {
    if (components.length === 0) {
      return;
    }

    this.core.logger.warn(
      'Bulk startup {{reason}}; deferred auto-starts were not attempted',
      { params: { reason, components } },
    );
  }

  /**
   * The names that are up, in order - what every startup result reports as started:
   * success, abort, timeout, and also a startup that failed and rolled back. A rollback
   * that could not stop a component leaves it up, and the result must match the
   * registry rather than claim nothing is. One answer for all of them, so no exit lists
   * a component in teardown as started.
   */
  public runningStartupSnapshot(
    names: readonly string[] = this.core.state.components.map((component) =>
      this.core.registry.nameOf(component),
    ),
  ): string[] {
    // Unlike running-set membership alone, a startup availability snapshot must
    // exclude teardown: stop keeps that membership until cleanup has settled, and a
    // late start's cleanup marks its component running only to stop it.
    return names.filter(
      (name) =>
        this.core.state.runningComponents.has(name) &&
        this.core.state.componentStates.get(name) === 'running' &&
        !this.core.state.pendingBulkStartupCleanup.has(name),
    );
  }

  /**
   * Take the startup latch, attach signals if configured, and clear the previous
   * shutdown's state: the run that follows, with its deadline armed - or the refusal
   * when the attach failed or a shutdown began from it, with the latch released again.
   */
  private beginStartup(
    startTime: number,
    effectiveTimeout: number,
    restartSnapshots: Map<string, RestartStartSnapshot> | undefined,
  ): StartupRun | StartupResult {
    // The latch goes up before the attach, not after it: attaching emits
    // `lifecycle-manager:signals-attached` synchronously, and a listener that calls
    // `startAllComponents()` from there must find a startup already in progress rather
    // than run a second one alongside this. Only the restart handoff below (and the
    // auto-attach flag) moves before the attach; the shutdown state this startup resets
    // waits until the attach has succeeded and no shutdown has begun, so a refusal
    // releases the latch, which also reports the handed-off auto-starts as abandoned.
    this.core.state.isStarting = true;
    // The startup that actually takes the latch owns the current registry, even if
    // a listener started it before the original restart resumed. Transfer every
    // pending handoff before signal attachment can run caller code, and empty each
    // token so an older restart finalizer cannot warn for work already claimed.
    for (const names of this.core.state.pendingRestartAutoStarts) {
      for (const name of names) {
        if (this.core.registry.getComponent(name) !== undefined) {
          this.core.state.deferredAutoStartNames.add(name);
        }
      }
      names.clear();
    }
    this.core.state.pendingRestartAutoStarts.clear();
    this.core.state.autoAttachedSignalsDuringStartup = false;

    // This startup's baseline for every "did a shutdown start meanwhile" check it makes,
    // including the one right after the attach.
    const shutdownTokenAtBulkStart = this.core.state.shutdownToken;
    const hasShutdownBegun = (): boolean =>
      this.core.shutdownPass.isShuttingDown ||
      this.core.state.shutdownToken !== shutdownTokenAtBulkStart;

    // Tracked so failure cleanup does not detach handlers that were attached earlier by
    // some other path.
    const bulkSignalAttach = this.core.config.attachSignalsBeforeStartup
      ? this.core.signals.autoAttachSignals('bulk startup')
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
    // have hidden it from every such check this startup makes. Refuse as a startup
    // arriving during a shutdown is refused.
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
    this.core.state.unexpectedStopsDuringStartup.clear();
    this.core.shutdownEscalation.resetRepeatedShutdownRequestState();
    this.core.state.shutdownMethod = null; // Clear previous shutdown method on fresh start
    this.core.state.lastShutdownResult = null; // Clear last shutdown result on fresh start

    this.core.logger.info('Starting all components');

    const run = new StartupRun(
      startTime,
      effectiveTimeout,
      restartSnapshots,
      didAutoAttachSignalsForBulkStartup,
      hasShutdownBegun,
    );
    // The startup deadline bounds starts. Rollback has its own stop timeouts.
    if (effectiveTimeout > 0) {
      run.timeoutHandle = setTimeout(() => {
        this.expireStartup(run);
      }, effectiveTimeout);
    }

    return run;
  }

  /**
   * The run itself, once the latch is held: order the registry, drain the batch loop -
   * the initial order, then follow-up batches of auto-starts registered meanwhile -
   * reconciling unexpected stops as it goes, and finish. A crash anywhere is rolled back
   * here, and every exit releases the latch.
   */
  private async runStartup(run: StartupRun): Promise<StartupResult> {
    // Exposed while this startup runs, so an `autoStart` registration made from one of
    // its listeners joins it - and its rollback - rather than escaping both.
    this.core.state.activeBulkStartup = run.bulkStartup;

    try {
      const orderingAnswer = this.orderStartup(run);
      if (orderingAnswer !== undefined) {
        return orderingAnswer;
      }

      // Final reconciliation can run optionality hooks and logging sinks. Any
      // auto-starts they register still belong to this pass, including rollback
      // and its original deadline, so drain them before publishing completion.
      do {
        // Initial and follow-up batches share every deadline and failure check below.
        for (const name of this.startupBatches(run)) {
          const prepared = this.prepareBatchMember(run, name);
          if (prepared.kind === 'break') {
            break;
          }
          if (prepared.kind === 'result') {
            return prepared.value;
          }
          if (prepared.kind === 'skip') {
            continue;
          }
          const { component, dependencyRead } = prepared;

          // Start the component (allow during bulk startup since we ARE the bulk operation)
          run.bulkStartup.frozenAutoStarts.delete(name);
          // Whether this start's timeout was the bulk deadline's, as opposed to the
          // component's own `startupTimeoutMS`: the bulk timer can also fire after the
          // component's own timer and before this loop resumes, and that timeout is
          // still a required failure to roll back, not a bulk timeout.
          let didStartMeetBulkDeadline = false;
          const deadline = run.deadline;
          const startDeadlineContext =
            deadline === undefined
              ? undefined
              : {
                  deadline,
                  onTimeout: (): void => {
                    didStartMeetBulkDeadline = true;
                    this.expireStartup(run);
                  },
                  hasExpired: () => run.hasTimedOut,
                };
          const result = await this.core.componentStart.startComponentInternal(
            name,
            snapshotStartOptions({
              allowDuringBulkStartup: true,
            }),
            // Every follow-up batch shares the original deadline.
            startDeadlineContext,
            dependencyRead,
            run.bulkStartup.dependencyReads,
            run.restartSnapshots?.get(name),
          );

          const settled = this.settleBatchMemberStart(
            run,
            name,
            component,
            result,
            didStartMeetBulkDeadline,
          );
          if (settled !== undefined) {
            if (settled.kind === 'break') {
              break;
            }
            if (settled.kind === 'result') {
              return settled.value;
            }
            await settled.pending;
            return settled.finish();
          }

          const reconciliation = this.reconcileOrFail(run);
          if (reconciliation !== undefined) {
            return reconciliation.kind === 'rollback'
              ? await this.finishReconciliationRollback(run, reconciliation)
              : reconciliation.value;
          }

          // Promise continuations and completion observers can exhaust the budget
          // before timers run. Account for the settled result before expiring startup.
          this.refreshStartupDeadline(run);
          if (run.hasTimedOut) {
            break;
          }
        }

        const reconciliation = this.reconcileAfterBatches(run);
        if (reconciliation !== undefined) {
          return reconciliation.kind === 'rollback'
            ? await this.finishReconciliationRollback(run, reconciliation)
            : reconciliation.value;
        }

        // Only the first drain includes the original order. Later drains own
        // registrations made by reconciliation, not components already attempted.
        run.startupOrder = [];
        // Do not expire the deadline in this condition: its log can report a
        // required unexpected stop. The generator checks the deadline before
        // another batch, and the reconciliation above then observes that stop.
      } while (
        this.core.state.deferredAutoStartNames.size > 0 &&
        !run.hasTimedOut &&
        !run.hasShutdownBegun()
      );

      return this.finishStartup(run);
    } catch (error) {
      // Something unplanned threw mid-startup - a component getter, say. Handled here
      // rather than left to the public safety net, which cannot see what this startup
      // had already started: rolled back like any other failed startup, so a failure
      // never leaves a partial set running behind a result that says otherwise.
      const crash = this.reportStartupCrash(run, error);

      try {
        await this.rollBackOnce(run, run.startedComponents);
        if (run.hasShutdownBegun()) {
          return this.abortedByShutdown(run, undefined, crash.error);
        }
      } catch (rollbackError) {
        reportCallbackError(
          'lifecycle-manager startup rollback',
          rollbackError,
        );
      }

      return this.crashedStartup(run, crash);
    } finally {
      // Release the deadline callback when startup settles so it cannot report
      // a timeout after this operation has completed.
      if (run.timeoutHandle) {
        clearTimeout(run.timeoutHandle);
      }

      this.releaseStartupLatch({
        didAutoAttachSignals: run.didAutoAttachSignals,
        detachReason: run.detachReason,
        abandonReason: run.abandonReason,
      });
    }
  }

  /**
   * Read every component's dependency list and compute the initial order from those
   * reads, freezing the auto-starts deferred so far into it. The answer when the
   * startup cannot go on - a shutdown begun by a read, or an order that could not be
   * computed - and `undefined` once `run.startupOrder` holds the order.
   */
  private orderStartup(run: StartupRun): StartupResult | undefined {
    // Get startup order (topological sort)
    // Every list read once, here, and used both for the order and by the batch loop:
    // read again there, a list that answered differently could put a component ahead
    // of a dependency it then failed on, rolling the whole startup back.
    const startupReads = run.bulkStartup.dependencyReads;
    // Deferred registrations included in any frozen batch still need an
    // abandonment warning if the loop ends before it attempts them.
    const frozenAutoStarts = run.bulkStartup.frozenAutoStarts;

    try {
      // Every component's list, including those of components the reads themselves
      // register: those are ordered with the rest - their auto-starts deferred to
      // this loop while `isOrdering` holds - rather than left out, or started ahead
      // of dependencies this loop had not started yet. Any read can begin a
      // shutdown; the lists left are then not read under it - their components may
      // be tearing down - and the startup is over, without going on to clear the
      // deferred auto-starts as if it would start them.
      const registryRead = this.core.registryReads.readRegistry(
        (component) =>
          this.core.componentMetadata.readDependenciesReported(
            component,
            'startup',
          ),
        startupReads,
        () => !run.hasShutdownBegun(),
      );

      if (run.hasShutdownBegun()) {
        return this.abortOnShutdownSignal(run);
      }

      if (!registryRead.isSettled) {
        throw new Error(
          'The registry kept changing while the startup order was being read',
        );
      }

      run.startupOrder = this.core.startupOrdering.getStartupOrderInternal(
        this.core.state.components,
        undefined,
        startupReads,
      );
      run.bulkStartup.isOrdering = false;
      for (const name of run.startupOrder) {
        run.bulkStartup.initialOrderNames.add(name);
      }
      // Freeze deferred registrations included in the initial order too. Their
      // start is now this loop's responsibility, but it may leave before them.
      for (const name of this.core.state.deferredAutoStartNames) {
        frozenAutoStarts.add(name);
      }
      this.core.state.deferredAutoStartNames.clear();
    } catch (error) {
      const failure = this.core.startupOrdering.answerStartupOrderFailure(
        error,
        'lifecycle-manager startAllComponents',
      );

      return {
        ...refusedStartupResult(
          failure.code,
          failure.reason,
          Date.now() - run.startTime,
        ),
        error: failure.error,
      };
    }

    return undefined;
  }

  /**
   * The names one drain of the batch loop attempts: the order it starts with, then each
   * follow-up batch of auto-starts registered meanwhile, ordered from the run's reads.
   *
   * Freeze each batch before attempting it. Hooks can await registration without
   * awaiting a start that depends on the hook's own component finishing first.
   * Frozen names remain protected by their fixed dependency order. Track the
   * unattempted remainder separately so an early exit can still report it.
   */
  private *startupBatches(run: StartupRun): Generator<string> {
    const startupReads = run.bulkStartup.dependencyReads;
    const frozenAutoStarts = run.bulkStartup.frozenAutoStarts;
    try {
      yield* run.startupOrder;
      while (this.core.state.deferredAutoStartNames.size > 0) {
        if (!this.canContinueOrdering(run)) {
          return;
        }
        const registryRead = this.core.registryReads.readRegistry(
          (component) =>
            this.core.componentMetadata.readDependenciesReported(
              component,
              'startup',
            ),
          startupReads,
          () => this.canContinueOrdering(run),
        );
        if (!this.canContinueOrdering(run)) {
          return;
        }
        if (!registryRead.isSettled) {
          throw new Error(
            'The registry kept changing while the follow-up startup order was being read',
          );
        }
        const batch = this.core.startupOrdering
          .getStartupOrderInternal(
            this.core.state.components,
            undefined,
            startupReads,
          )
          .filter((name) => this.core.state.deferredAutoStartNames.has(name));
        if (batch.length === 0) {
          throw new Error(
            'Deferred auto-starts were absent from the follow-up startup order',
          );
        }
        // Freeze the whole batch, including members not yet attempted: later
        // registrations cannot supply a missing dependency to this fixed order.
        for (const name of batch) {
          this.core.state.deferredAutoStartNames.delete(name);
          frozenAutoStarts.add(name);
        }
        yield* batch;
      }
    } finally {
      // The iterator has ended, so these names can no longer participate in
      // registration checks for this batch. Release reports them with any
      // later batch that was queued but never frozen.
      for (const name of frozenAutoStarts) {
        this.core.state.deferredAutoStartNames.add(name);
      }
      // Reconciliation and crash reporting can still run caller code before
      // rollback. Keep their registrations owned by this startup until it has
      // actually reached successful terminal notifications.
    }
  }

  /**
   * Everything the batch loop checks of a member before starting it: the deadline, a
   * shutdown, a stall, and the dependencies its start would need. Either the member to
   * start, with the dependency read its start acts on, a skip, or how the loop ends.
   */
  private prepareBatchMember(
    run: StartupRun,
    name: string,
  ):
    | Exclude<BatchExit, { kind: 'rollback' }>
    | { readonly kind: 'skip' }
    | {
        readonly kind: 'start';
        readonly component: BaseComponent;
        readonly dependencyRead: DependencyRead;
      } {
    // Synchronous starts can exhaust the budget without yielding to timers.
    this.refreshStartupDeadline(run);
    if (run.hasTimedOut) {
      this.core.logger.warn(
        'Startup timeout reached, stopping component initiation',
      );
      return { kind: 'break' };
    }
    run.bulkStartup.reachedNames.add(name);

    const component = this.core.registry.getComponent(name);
    if (!component) {
      // Should not happen since unregisterComponent() is blocked during startup.
      // Thrown into the crash path, as a component never read is below: skipped,
      // it was in no result list, and the startup could still report success.
      throw new Error(
        `Component "${name}" is in the startup order but not registered`,
      );
    }

    // A skip below runs caller code (logging, isOptional(), skip listeners) that
    // can begin a shutdown. Later components then belong to it: stop here
    // rather than read or announce them under it.
    if (run.hasShutdownBegun()) {
      return { kind: 'result', value: this.abortOnShutdownSignal(run) };
    }

    // Skip stalled components during bulk startup (even with ignoreStalledComponents:true bulk option)
    if (this.core.state.stalledComponents.has(name)) {
      run.bulkStartup.frozenAutoStarts.delete(name);
      this.core.logger
        .entity(name)
        .info('Skipping stalled component during startup');
      run.skippedDueToStall.add(name);
      return { kind: 'skip' };
    }

    // Check if any required dependency failed or was skipped
    // The list the order was computed from, handed to the component's own start in
    // `runStartup()` too: the order, the skip check and that start all act on one
    // read. Tolerant here - its valid entries still decide the skip - and the start
    // fails it on a broken list; reported when read, in case it is skipped.
    const dependencyRead = run.bulkStartup.dependencyReads.get(component);

    // Every name in the order was read when ordered, and nothing can be unregistered
    // while the startup runs - so this is a bug, not a component to read now.
    // Thrown, into the crash path that rolls the startup back, rather than
    // skipped: a skipped component is in no result list, and the startup could
    // still report success.
    if (dependencyRead === undefined) {
      throw new Error(
        `Component "${name}" is in the startup order but was never read`,
      );
    }

    const skipReason = this.dependencySkipReason(run, dependencyRead);
    if (skipReason !== undefined) {
      run.bulkStartup.frozenAutoStarts.delete(name);
      this.core.logger
        .entity(name)
        .warn('Skipping component due to dependency', {
          params: { reason: skipReason },
        });
      this.core.lifecycleEvents.componentStartSkipped(name, skipReason);
      run.skippedDueToDependency.add(name);
      return { kind: 'skip' };
    }

    // Check if shutdown was triggered during startup
    if (run.hasShutdownBegun()) {
      return { kind: 'result', value: this.abortOnShutdownSignal(run) };
    }

    return { kind: 'start', component, dependencyRead };
  }

  /**
   * Why a batch member is skipped for its dependencies - one that stalled, was skipped
   * or failed, unless it is optional - or `undefined` when none blocks it.
   */
  private dependencySkipReason(
    run: StartupRun,
    dependencyRead: DependencyRead,
  ): string | undefined {
    const dependencies = dependenciesOf(dependencyRead);

    for (const depName of dependencies) {
      const depComponent = this.core.registry.getComponent(depName);
      // Read only where it decides something - a dependency that stalled, was
      // skipped or failed - and guarded, so a healthy dependency's `isOptional()`
      // that throws cannot crash, and roll back, the whole startup.
      const isDependencyOptional = (): boolean =>
        depComponent !== undefined &&
        this.core.componentMetadata.isComponentOptional(depComponent);

      // A stalled dependency follows the optional-dependency rule as a skipped or
      // failed one does: an optional one does not block its dependents, which an
      // individual start of them allows too.
      if (run.skippedDueToStall.has(depName)) {
        if (!isDependencyOptional()) {
          return `Dependency "${depName}" is stalled`;
        }
        continue;
      }

      if (run.skippedDueToDependency.has(depName)) {
        if (!isDependencyOptional()) {
          return `Dependency "${depName}" was skipped`;
        }
        continue;
      }

      if (depComponent) {
        const depState = this.core.state.componentStates.get(depName);
        if (depState === 'failed' && !isDependencyOptional()) {
          return `Dependency "${depName}" failed to start`;
        }
      }
    }

    return undefined;
  }

  /**
   * Account for a batch member's start once it has answered: record it as started, or
   * as an optional failure, and carry on (`undefined`) - or end the loop, beginning the
   * rollback a required failure calls for.
   */
  private settleBatchMemberStart(
    run: StartupRun,
    name: string,
    component: BaseComponent,
    result: ComponentOperationResult,
    didStartMeetBulkDeadline: boolean,
  ): BatchExit | undefined {
    if (run.hasShutdownBegun()) {
      // Every member the branches below would count as this startup's: one that
      // started or was already running, and one still up after an unexpected stop - a
      // listener started it again - or after a failed signal attach whose rollback stop
      // did not take. The snapshot drops whatever is in teardown by now.
      if (
        result.success ||
        result.code === 'component_already_running' ||
        ((result.code === 'component_unexpected_stop' ||
          result.code === 'signal_attach_failed') &&
          this.core.registry.isComponentUp(name))
      ) {
        run.startedComponents.push(name);
      }
      return { kind: 'result', value: this.abortedByShutdown(run) };
    }

    // A bulk timeout has no completed outcome to account for. Other results
    // must be handled before checking the clock so failures retain their errors
    // and rollback, and already-running components remain in the snapshot.
    // Only a timeout the bulk deadline caused: the component's own one is a
    // failure like any other, even when the bulk deadline has also passed.
    if (
      run.hasTimedOut &&
      didStartMeetBulkDeadline &&
      result.code === 'component_startup_timeout'
    ) {
      return { kind: 'break' };
    }

    if (result.success) {
      run.startedComponents.push(name);
    } else if (result.code === 'component_already_running') {
      // Component is already running - this is fine (might have been started manually)
      // Add to startedComponents so it's tracked as part of this bulk operation
      run.startedComponents.push(name);
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
        result.code === 'component_already_starting' ? 'startup' : 'stop';
      const isLateTimeoutCleanup =
        result.reason === LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP;
      run.abandonReason = isLateTimeoutCleanup
        ? 'was interrupted by timed-out startup cleanup'
        : `was interrupted by independent component ${operation}`;
      run.detachReason = 'partial bulk startup';
      return {
        kind: 'result',
        value: this.failedStartup(run, {
          code: 'partial_state',
          reason: isLateTimeoutCleanup
            ? `Component "${name}": ${LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP}`
            : `Component "${name}" has an independent ${operation} in progress`,
        }),
      };
    } else if (result.code === 'shutdown_in_progress') {
      // A shutdown pass that began answered above, and owns the teardown. Refused
      // without one - a logger exit in progress - nothing else will stop what this
      // startup started, so it is rolled back as for a required failure.
      return {
        kind: 'rollback',
        pending: this.rollBackOnce(run, run.startedComponents),
        finish: () =>
          this.abortedByShutdown(
            run,
            result.reason || 'Shutdown triggered during startup',
            result.error,
          ),
      };
    } else if (result.code === 'component_unexpected_stop') {
      // This branch is for components that reported an unexpected stop
      // before startComponentInternal() returned. That is distinct from the
      // post-success reconciliation in `reconcileOrFail()`, which handles
      // components that had already been counted as started during this bulk pass.
      this.core.state.unexpectedStopsDuringStartup.delete(name);

      const error =
        result.error ||
        new Error(result.reason || `Component "${name}" stopped unexpectedly`);

      const isOptional =
        this.core.unexpectedStops.noteUnexpectedStopDuringStartup(
          name,
          component,
          error,
          run.failedOptionalComponents,
        );
      // Up again by now - a listener on its stop started it again - it is still this
      // startup's to report and to roll back, as in reconciliation. Asked after the
      // callbacks above, which can report it stopped again.
      if (this.core.registry.isComponentUp(name)) {
        run.startedComponents.push(name);
      }
      if (!isOptional) {
        return {
          kind: 'rollback',
          pending: this.rollBackOnce(run, run.startedComponents),
          finish: () => this.unexpectedStopFailure(run, error),
        };
      }
    } else if (result.code === 'signal_attach_failed') {
      // Fatal to the whole startup, optional component or not: the process was
      // configured to handle signals and cannot, so it does not come up at all.
      // Continuing would retry the attach on every later component, and an all-
      // optional registry would report success with nothing running.
      //
      // The failed component itself is included if stopping it again did not take:
      // it is not in `startedComponents`, and leaving it running is exactly what a
      // failed attach must not do.
      return {
        kind: 'rollback',
        pending: this.rollBackOnce(
          run,
          this.core.state.runningComponents.has(name)
            ? [...run.startedComponents, name]
            : run.startedComponents,
        ),
        finish: () => this.signalAttachFailure(run, name, result),
      };
    } else {
      // Check if component is optional
      if (this.core.componentMetadata.isComponentOptional(component)) {
        this.recordOptionalStartFailure(run, name, result);
      } else {
        // Required component failed - trigger rollback
        this.core.logger
          .entity(name)
          .error(
            'Required component failed to start, rolling back: {{error.message}}',
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

        return {
          kind: 'rollback',
          pending: this.rollBackOnce(run, run.startedComponents),
          finish: () => this.requiredStartFailure(run, name, result),
        };
      }
    }

    return undefined;
  }

  /** An optional batch member that failed to start: announced, marked, and recorded. */
  private recordOptionalStartFailure(
    run: StartupRun,
    name: string,
    result: ComponentOperationResult,
  ): void {
    // Built once, so the log, the event and the result name the same error
    // - one standing in for a result that carried none, too.
    const failure =
      result.error ||
      new Error(result.reason || LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR);
    this.core.logger
      .entity(name)
      .warn(
        'Optional component failed to start, continuing: {{error.message}}',
        { params: { error: failure } },
      );

    this.core.lifecycleEvents.componentStartFailedOptional(name, failure);

    // Mark as failed state - unless stopping it again after a crash already
    // left it stalled, which `stalledComponents` still says and the state
    // must agree with. Nor over a component something else now owns -
    // running again, or with another start or stop in flight. Overwritten,
    // its in-flight guard would be gone, and a second `stop()` could run
    // alongside the one already underway.
    const isOwnedElsewhere =
      this.core.state.runningComponents.has(name) ||
      this.core.claims.isInFlight(name);

    if (!this.core.state.stalledComponents.has(name) && !isOwnedElsewhere) {
      this.core.state.componentStates.set(name, 'failed');

      if (result.error) {
        this.core.state.componentErrors.set(name, result.error);
      }
    }

    run.failedOptionalComponents.push({ name, error: failure });
  }

  /** The answer for a batch member whose signal attach failed, once rollback settled. */
  private signalAttachFailure(
    run: StartupRun,
    name: string,
    result: ComponentOperationResult,
  ): StartupResult {
    if (run.hasShutdownBegun()) {
      return this.abortedByShutdown(run);
    }

    return {
      ...refusedStartupResult(
        'signal_attach_failed',
        result.reason ?? 'Could not attach process signals',
        Date.now() - run.startTime,
      ),
      // Whatever the rollback could not stop, so the result matches the registry,
      // excluding teardown as every other failure exit does.
      startedComponents: this.runningStartupSnapshot([
        ...run.startedComponents,
        name,
      ]),
      failedOptionalComponents: run.failedOptionalComponents,
      skippedDueToDependency: Array.from(run.skippedDueToDependency),
      error: result.error,
    };
  }

  /** The answer for a required batch member that failed to start, once rollback settled. */
  private requiredStartFailure(
    run: StartupRun,
    name: string,
    result: ComponentOperationResult,
  ): StartupResult {
    if (run.hasShutdownBegun()) {
      return this.abortedByShutdown(run);
    }

    return this.failedStartup(run, {
      reason:
        result.reason ||
        `Required component "${name}" failed: ${result.code || 'unknown'}`,
      code: 'required_component_failed',
      error: result.error,
    });
  }

  /**
   * The reconciliation that ends each drain of the batch loop, with the timeout report
   * between its checks when the deadline passed. `undefined` when the run goes on.
   */
  private reconcileAfterBatches(
    run: StartupRun,
  ): ReconciliationOutcome | undefined {
    // Reconcile known stops before timeout reporting, then drain any new
    // reports its sinks produce. Neither successful check yields a microtask.
    const reconciliation = this.reconcileOrFail(run);
    if (reconciliation !== undefined) {
      return reconciliation;
    }
    if (run.hasTimedOut) {
      this.core.logger.warn('Startup completed with timeout', {
        params: {
          started: run.startedComponents.length,
          failed: run.failedOptionalComponents.length,
          skipped: run.skippedDueToDependency.size + run.skippedDueToStall.size,
          durationMS: Date.now() - run.startTime,
          timeoutMS: run.effectiveTimeout,
        },
      });

      // Timeout reporting can start shutdown, which owns teardown before
      // another reconciliation gets to invoke optionality hooks or logs.
      if (run.hasShutdownBegun()) {
        return { kind: 'result', value: this.abortOnShutdownSignal(run) };
      }
      return this.reconcileOrFail(run);
    }

    return undefined;
  }

  /**
   * Reconcile the unexpected stops reported during the run with what it started: an
   * optional one is recorded, a required one begins the rollback. `undefined` when the
   * run goes on.
   */
  private reconcileOrFail(run: StartupRun): ReconciliationOutcome | undefined {
    const reconciled =
      this.core.unexpectedStops.consumeUnexpectedStopsDuringStartup(
        run.startedComponents,
        run.failedOptionalComponents,
      );
    run.startedComponents.splice(0, run.startedComponents.length);
    run.startedComponents.push(...reconciled.startedComponents);

    // Optionality getters and log sinks can start shutdown. It owns teardown
    // from that point, before any required-stop rollback decision is made.
    if (run.hasShutdownBegun()) {
      return { kind: 'result', value: this.abortOnShutdownSignal(run) };
    }
    if (reconciled.requiredFailure) {
      return {
        kind: 'rollback',
        pending: this.rollBackOnce(run, run.startedComponents),
        error: reconciled.requiredFailure.error,
      };
    }
    // Only rollback is awaited; even a shutdown refusal must release its latch
    // without an extra microtask. With no outcome, callers must not yield between
    // successful reconciliation and the next synchronous startup decision.
    return undefined;
  }

  /** Await a reconciliation's rollback, then answer for the stop that required it. */
  private async finishReconciliationRollback(
    run: StartupRun,
    outcome: Extract<ReconciliationOutcome, { kind: 'rollback' }>,
  ): Promise<StartupResult> {
    await outcome.pending;
    return this.unexpectedStopFailure(run, outcome.error);
  }

  /**
   * The answer once the batch loop has drained: a shutdown or the deadline that ended
   * it, or success - after the terminal notifications of a startup that completed.
   */
  private finishStartup(run: StartupRun): StartupResult {
    // The loop checks for a shutdown after each start, but the events it emits for
    // the last component - `start-failed-optional`, `start-skipped` - come after that
    // check, and a listener there can start one. Reporting success and emitting
    // `started` would then describe a startup that a shutdown is already undoing.
    if (run.hasShutdownBegun()) {
      return this.abortOnShutdownSignal(run);
    }

    // Check if startup timed out during the process
    if (run.hasTimedOut) {
      return this.failedStartup(run, {
        timedOut: true,
        reason: `Startup timeout exceeded (${run.effectiveTimeout}ms)`,
        code: 'startup_timeout',
      });
    }

    this.core.registry.updateStartedFlag();
    const skippedComponentsArray = [
      ...Array.from(run.skippedDueToDependency),
      ...Array.from(run.skippedDueToStall),
    ];

    const durationMS = Date.now() - run.startTime;

    // Reconciliation and every rollback decision have finished. Only these
    // successful terminal callbacks can start independent auto-start work.
    // They are notifications of committed success, not another reconciliation
    // phase: reopening rollback here could stop dependencies of that new work.
    // Stops reported here retain their normal stopped event/state, while the
    // result below snapshots availability after both notifications return.
    run.bulkStartup.isCompleting = true;
    run.abandonReason = 'completed before deferred auto-starts were attempted';
    this.core.logger.success('All components started', {
      params: {
        started: run.startedComponents.length,
        failed: run.failedOptionalComponents.length,
        skipped: skippedComponentsArray.length,
        durationMS,
      },
    });

    // Copies: listeners receive the payload by reference, and the result below is
    // built from this run's own lists, which a listener must not be able to change.
    this.core.lifecycleEvents.lifecycleManagerStarted(
      [...run.startedComponents],
      run.failedOptionalComponents.map((entry) => ({ ...entry })),
      skippedComponentsArray,
    );

    // Asked once more, after both notifications: each runs caller code, and a
    // `started` listener or log sink can begin a shutdown, which would leave a
    // `success: true` answer contradicting a `getSystemState()` that already says
    // `shutting-down` - the contradiction the check ahead of them prevents. The `started`
    // event stands, since the startup did complete; the result reports the shutdown
    // that is now undoing it, as a startup a shutdown cut short does.
    if (run.hasShutdownBegun()) {
      this.core.logger.warn('Shutdown began as startup completed');
      return this.abortedByShutdown(
        run,
        'Shutdown triggered as startup completed',
      );
    }

    run.detachReason = 'completed bulk startup';
    return {
      success: true,
      ...this.startupProgress(run),
      durationMS,
      timedOut: false,
    };
  }

  /**
   * Report a crash of the run: a dependency cycle a follow-up batch introduced is logged
   * as the configuration failure it is, anything else reported as unplanned.
   */
  private reportStartupCrash(run: StartupRun, error: unknown): StartupCrash {
    run.detachReason = 'failed bulk startup';
    const crashError = toError(error);

    const isDependencyCycle = crashError instanceof DependencyCycleError;
    if (isDependencyCycle) {
      // A follow-up can introduce a cycle after earlier batches started. It is
      // the same configuration failure as initial ordering, with rollback now
      // needed for the components this pass has already brought up.
      this.core.logger.error(
        'Failed to resolve startup order: {{error.message}}',
        {
          params: { error: crashError },
        },
      );
    } else {
      reportCallbackError('lifecycle-manager startAllComponents', error);
    }

    return { error: crashError, isDependencyCycle };
  }

  /** The answer for a run that crashed, once its rollback has been attempted. */
  private crashedStartup(run: StartupRun, crash: StartupCrash): StartupResult {
    return {
      ...crashedStartupResult(
        crash.error,
        `startAllComponents() failed unexpectedly: ${describeError(crash.error)}`,
        // Reported by `reportStartupCrash()`, so a crash even for a branded option refusal: this
        // startup's own options were validated before it took the latch, and
        // anything met since is the startup failing part-way, not a refusal.
        'operation_crashed',
        Date.now() - run.startTime,
      ),
      ...(crash.isDependencyCycle
        ? {
            code: 'dependency_cycle' as const,
            reason: describeError(crash.error),
          }
        : {}),
      // Whatever the rollback could not stop, so the result matches the registry.
      ...this.startupProgress(run),
    };
  }

  /** The run's deadline passed: stop initiating starts and report partial results. */
  private expireStartup(run: StartupRun): void {
    if (run.hasTimedOut) {
      return;
    }
    run.hasTimedOut = true;
    run.abandonReason = 'timed out';
    this.core.logger.warn(
      'Startup timeout exceeded, returning partial results',
      {
        params: { timeoutMS: run.effectiveTimeout },
      },
    );
  }

  /** Expire the run now if its deadline has passed without its timer having fired. */
  private refreshStartupDeadline(run: StartupRun): void {
    if (run.deadline !== undefined && Date.now() >= run.deadline) {
      this.expireStartup(run);
    }
  }

  /** Whether the run may read and order another follow-up batch. */
  private canContinueOrdering(run: StartupRun): boolean {
    this.refreshStartupDeadline(run);
    return !run.hasTimedOut && !run.hasShutdownBegun();
  }

  /**
   * Roll back what the run started, unless a shutdown that owns the teardown began. The
   * run's deadline is stopped first either way: every caller is ending the run's starts,
   * and the rollback has its own stop timeouts.
   */
  private async rollBackOnce(run: StartupRun, names: string[]): Promise<void> {
    clearTimeout(run.timeoutHandle);
    if (run.hasShutdownBegun()) {
      return;
    }
    run.abandonReason = 'failed and rolled back';
    run.bulkStartup.isRollingBack = true;
    await this.rollbackStartup(run, names);
  }

  /**
   * Roll the startup back by stopping what it started, in reverse order: for a required
   * component that failed or stopped unexpectedly, a failed signal attach, or a crash of
   * the run. Only through `rollBackOnce()`.
   */
  private async rollbackStartup(
    run: StartupRun,
    startedComponents: string[],
  ): Promise<void> {
    const { rolledBackNames, hasShutdownBegun } = run;
    // Stop components in reverse order - skipping any an earlier rollback of this same
    // startup already reached, which is marked before its stop, so a stop that throws is
    // not retried either.
    const componentsToRollback = [...startedComponents]
      .reverse()
      .filter((name) => !rolledBackNames.has(name));

    if (componentsToRollback.length === 0) {
      return;
    }

    // A copy: a sink receives its params by reference, and the loop below must stop
    // every one of these whatever a sink does to the list it was handed.
    this.core.logger.warn('Rolling back startup, stopping started components', {
      params: { components: [...componentsToRollback] },
    });

    for (const name of componentsToRollback) {
      // A shutdown that began while the previous stop was awaited owns the rest of the
      // teardown: announcing or marking a rollback this loop will not run would mislead.
      if (hasShutdownBegun()) {
        return;
      }
      rolledBackNames.add(name);
      this.core.logger.entity(name).info('Rolling back component');
      this.core.lifecycleEvents.componentStartupRollback(name);

      // Shutdown may also begin from either rollback notification. It owns teardown
      // and its halt-on-stall policy must not be bypassed by this older startup. Not
      // marked rolled back, as the refusal below is not: this rollback never stopped it.
      if (hasShutdownBegun()) {
        rolledBackNames.delete(name);
        return;
      }
      // Retain dependency protection for independently started work, while allowing
      // this rollback to run under the startup latch it already owns.
      const result = await this.core.componentStop.stopComponentInternal(
        name,
        undefined,
        {
          operation: 'stop',
          claimed: false,
          isStartupRollback: true,
          rolledBackNames,
          hasShutdownBegun,
        },
      );
      // Refused because a shutdown began while the stop was being prepared - one of
      // its getters began it. Not a failed stop: that shutdown owns this component and
      // the rest of the teardown, as the checks above already hand it over. Not marked
      // rolled back either, since this rollback never stopped it.
      if (result.code === 'shutdown_in_progress') {
        rolledBackNames.delete(name);
        return;
      }
      // Refused for its running dependents: its stop never ran, so a later rollback of
      // this startup, after those dependents have stopped, must still reach it.
      if (result.code === 'has_running_dependents') {
        rolledBackNames.delete(name);
      }
      if (!result.success) {
        this.core.logger
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

    this.core.logger.info('Rollback completed');
  }

  /**
   * What every answer of this startup reports of its progress, read as it answers:
   * what is still running of what it started, and what it had already given up on.
   */
  private startupProgress(
    run: StartupRun,
  ): Pick<
    StartupResult,
    'startedComponents' | 'failedOptionalComponents' | 'skippedDueToDependency'
  > {
    return {
      startedComponents: this.runningStartupSnapshot(run.startedComponents),
      failedOptionalComponents: run.failedOptionalComponents,
      skippedDueToDependency: Array.from(run.skippedDueToDependency),
    };
  }

  /** A startup that failed part-way: its progress, and why it failed. */
  private failedStartup(
    run: StartupRun,
    failure: Pick<StartupResult, 'reason' | 'code'> &
      Partial<Pick<StartupResult, 'error' | 'timedOut'>>,
  ): StartupResult {
    return {
      success: false,
      ...this.startupProgress(run),
      ...failure,
      durationMS: Date.now() - run.startTime,
    };
  }

  /**
   * The answer for a startup a shutdown cut short, wherever it notices. Shutdown
   * retains running-set membership while stop hooks settle; that teardown is
   * no longer available and must not be reported as a successful startup.
   */
  private abortedByShutdown(
    run: StartupRun,
    reason = 'Shutdown triggered during startup',
    error?: Error,
  ): StartupResult {
    run.abandonReason = 'was interrupted by shutdown';
    run.detachReason = 'interrupted bulk startup';
    return this.failedStartup(run, {
      reason,
      code: 'shutdown_in_progress',
      ...(error === undefined ? {} : { error }),
    });
  }

  /**
   * Where the startup itself notices a shutdown begun by caller code it ran. The log
   * comes first: `abortedByShutdown()` snapshots what is still running after it.
   */
  private abortOnShutdownSignal(run: StartupRun): StartupResult {
    this.core.logger.warn('Shutdown signal received during startup, aborting');
    return this.abortedByShutdown(run);
  }

  /** The answer for a required component's unexpected stop, once rollback settled. */
  private unexpectedStopFailure(run: StartupRun, error: Error): StartupResult {
    // Rollback preparation and stop hooks also run caller code. A shutdown
    // accepted while awaiting rollback owns the resulting teardown snapshot.
    if (run.hasShutdownBegun()) {
      return this.abortedByShutdown(run);
    }
    return this.failedStartup(run, {
      reason: describeError(error),
      code: 'component_unexpected_stop',
      error,
    });
  }

  /**
   * Everything a bulk startup releases as it ends, from whichever exit: the latch, the
   * signal handlers it attached if it leaves nothing running - or any detach deferred
   * while it held the latch - the startup record, and auto-starts left to it that it
   * never reached. One place, so an early exit cannot forget a step the others take.
   *
   * Every piece of this startup's state is cleared before any caller code runs. The
   * detach logs through the caller's sinks, which may start the next startup. That
   * startup runs synchronously up to its first `await` and installs its own record,
   * which clearing this one afterwards would wipe out from under it: `isStarting` true
   * with no `activeBulkStartup`, so every auto-start registered for the rest of it
   * would be deferred, never started, and left out of its rollback.
   */
  private releaseStartupLatch(input: {
    didAutoAttachSignals: boolean;
    detachReason: string;
    abandonReason: string;
  }): void {
    return this.core.dispatcher.withTransition(() => {
      const shouldDetach =
        input.didAutoAttachSignals ||
        this.core.state.autoAttachedSignalsDuringStartup;
      const abandonedAutoStarts = Array.from(
        this.core.state.deferredAutoStartNames,
      );

      // `isStarting` first of all: the detach below defers while it is set.
      this.core.state.isStarting = false;
      this.core.state.autoAttachedSignalsDuringStartup = false;
      this.core.state.activeBulkStartup = null;
      this.core.state.deferredAutoStartNames.clear();
      this.core.state.unexpectedStopsDuringStartup.clear();

      if (shouldDetach) {
        this.core.signals.detachSignalsIfIdle(input.detachReason);
      } else {
        this.core.signals.runDeferredSignalDetach('bulk startup');
      }

      // A startup begun from the detach (or a listener before this drains) reads the
      // whole registry, so it would start these too. Handed to its deferred set rather
      // than dropped: that startup can itself fail before reaching them, and only names
      // it owns are frozen into its order or reported as abandoned when it ends.
      this.core.dispatcher.afterNotifications(() => {
        const nextStartup = this.core.state.activeBulkStartup;
        if (
          this.core.state.isStarting &&
          (nextStartup === null || nextStartup.isOrdering)
        ) {
          for (const name of abandonedAutoStarts) {
            if (this.core.registry.getComponent(name) !== undefined) {
              this.core.state.deferredAutoStartNames.add(name);
            }
          }
          return;
        }

        // One that has already frozen its order no longer collects deferred names, but
        // that order is the registry it read: the names in it are its to start, not
        // abandoned. The detach's own log runs its sinks ahead of this callback, so a
        // startup begun there has always ordered by now - and warning for every name
        // said "not attempted" of auto-starts it was about to start. Frozen into its
        // auto-starts instead, as a registration made after its order is, so it is the
        // one to report any it leaves before reaching; only names outside its order
        // are this startup's to report.
        const notTakenOver =
          this.core.state.isStarting && nextStartup !== null
            ? abandonedAutoStarts.filter((name) => {
                if (!nextStartup.initialOrderNames.has(name)) {
                  return true;
                }
                if (!nextStartup.reachedNames.has(name)) {
                  nextStartup.frozenAutoStarts.add(name);
                }
                return false;
              })
            : abandonedAutoStarts;
        this.warnAbandonedAutoStarts(notTakenOver, input.abandonReason);
      });
    });
  }
}
