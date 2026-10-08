import { reportCallbackError } from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import {
  LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP,
  LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
} from '../constants';
import { DependencyCycleError } from '../errors';
import type { StartupResult } from '../types';
import type { RestartStartSnapshot } from './component-start';
import { type DependencyRead, dependenciesOf } from './dependency-policy';
import type { ManagerCore } from './manager-core';
import {
  snapshotStartOptions,
  type StartupOptionsSnapshot,
} from './operation-options';
import {
  crashedStartupResult,
  refusedStartupResult,
  resolveOperationTimeoutMS,
} from './operation-policy';

/**
 * Bulk startup: `startAllComponents()`'s body, and a restart's startup phase. It refuses
 * a startup that would overlap another bulk operation or a partial state, takes the
 * startup latch (`isStarting`), starts the registry in dependency order - and the
 * auto-starts registered while it runs, in follow-up batches - under one deadline, rolls
 * back what it started when a required component fails, and releases everything it
 * holds from whichever exit it leaves by.
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
   * `readOptions` takes the options snapshot: the caller's object for a public startup,
   * or the one a restart already took. Called once, after the refusals that need no
   * options.
   */
  public async startAllComponentsOperation(
    readOptions: () => StartupOptionsSnapshot,
    restartSnapshots?: Map<string, RestartStartSnapshot>,
  ): Promise<StartupResult> {
    const startTime = Date.now();
    const alreadyActive = this.refuseActiveBulkStartup(startTime);
    if (alreadyActive) {
      return alreadyActive;
    }
    // Every option is read up front, before the startup takes its latch: `options` is
    // the caller's object, and a getter that threw once `isStarting` was set left it set
    // for good. The timeout is only validated once the availability refusals below are
    // past - still before the latch: a startup that refuses never uses it, and an
    // availability refusal takes precedence over an option that would not be used.
    const startupOptions = readOptions();
    const shouldIgnoreStalledComponents =
      startupOptions.ignoreStalledComponents;
    const requestedTimeoutMS = startupOptions.timeoutMS;

    // Option getters can start a nested operation. Keep the post-read check too;
    // passing the initial guard does not reserve the startup latch.
    const becameActive = this.refuseActiveBulkStartup(startTime);
    if (becameActive) {
      return becameActive;
    }

    const totalCount = this.core.manager.getComponentCount();
    const runningCount = this.core.manager.getRunningComponentCount();

    if (totalCount === 0) {
      this.core.logger.warn('Cannot start all components: none registered');

      return refusedStartupResult(
        'no_components_registered',
        'No components registered',
        Date.now() - startTime,
      );
    }

    // Check for stalled components
    if (
      this.core.state.stalledComponents.size > 0 &&
      !shouldIgnoreStalledComponents
    ) {
      const stalledNames = Array.from(this.core.state.stalledComponents.keys());
      this.core.logger.warn('Cannot start: stalled components exist', {
        params: { stalled: stalledNames },
      });

      return {
        ...refusedStartupResult(
          'stalled_components_exist',
          'Stalled components exist',
          Date.now() - startTime,
        ),
        blockedByStalledComponents: stalledNames,
      };
    }

    // A component still stopping is counted as running, but it is on its way down: the
    // shortcut below would report it "already running" - listing it as started though
    // its `start()` never ran - and a start of it now would only be refused. Refused
    // until the stop settles, as a partial state is. A late start's cleanup marks its
    // component running only so it can be stopped, so it is on its way down too.
    const stillStartingNames: string[] = [];
    const stillStoppingNames = this.core.manager
      .getComponentNames()
      .filter((name) => {
        const state = this.core.state.componentStates.get(name);
        if (state === 'starting') {
          stillStartingNames.push(name);
        }

        return (
          state === 'stopping' ||
          state === 'force-stopping' ||
          this.core.state.pendingBulkStartupCleanup.has(name)
        );
      });

    if (stillStoppingNames.length > 0) {
      this.core.logger.warn('Cannot start: components are still stopping', {
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
      this.core.logger.warn('Cannot start: components are still starting', {
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

    // Stalled components this startup would skip (`ignoreStalledComponents`): they are
    // neither running nor left for it to start, so they count toward neither side.
    const stalledToSkip = (): string[] =>
      shouldIgnoreStalledComponents
        ? this.core.manager
            .getComponentNames()
            .filter((name) => this.core.state.stalledComponents.has(name))
        : [];

    // All running - nothing to do. At least one: an empty registry was refused above,
    // and one whose components are all stalled is left to the startup below to skip.
    if (
      runningCount > 0 &&
      runningCount === totalCount - stalledToSkip().length
    ) {
      this.core.logger.info('All components already running');
      // The sink can begin teardown or change registrations. Decide from the same
      // post-log snapshot we return, rather than the count captured before it ran.
      const startedComponents = this.runningStartupSnapshot();
      const skippedDueToStall = stalledToSkip();
      const isStillAllRunning =
        startedComponents.length > 0 &&
        startedComponents.length ===
          this.core.state.components.length - skippedDueToStall.length &&
        !this.core.shutdownPass.isShuttingDown &&
        !this.core.state.isStarting;
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
        // As the startup below reports the stalled components it skipped.
        ...(skippedDueToStall.length > 0 ? { skippedDueToStall } : {}),
        durationMS: Date.now() - startTime,
      };
    }

    // Partial state - reject to avoid inconsistent startup
    if (runningCount > 0) {
      // Neither latch is held here: `refuseActiveBulkStartup()` refused both, and
      // nothing since has run caller code.
      this.core.logger.error(
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
      const registeredCount = this.core.state.components.length;
      const didChangeDuringLog =
        startedComponents.length !== runningCount ||
        registeredCount !== totalCount ||
        this.core.state.isStarting ||
        this.core.shutdownPass.isShuttingDown;
      let reason = `${runningCount} of ${totalCount} components already running`;
      if (didChangeDuringLog) {
        reason =
          `Startup refused because ${runningCount} of ${totalCount} components were already running. ` +
          `Currently ${startedComponents.length} of ${registeredCount} components are running.`;
        if (this.core.shutdownPass.isShuttingDown) {
          reason += ' A shutdown is now in progress.';
        }
        if (this.core.state.isStarting) {
          reason += ' A startup is now in progress.';
        }
      }
      return {
        ...refusedStartupResult(
          'partial_state',
          reason,
          Date.now() - startTime,
        ),
        startedComponents,
      };
    }

    const effectiveTimeout = resolveOperationTimeoutMS(
      requestedTimeoutMS,
      this.core.config.startupTimeoutMS,
      'startAllComponents timeoutMS',
    );

    // The latch goes up before the attach, not after it: attaching emits
    // `lifecycle-manager:signals-attached` synchronously, and a listener that calls
    // `startAllComponents()` from there must find a startup already in progress rather
    // than run a second one alongside this. Only the restart handoff below (and the
    // auto-attach flag) moves before the attach; the shutdown state this startup resets waits until the attach has
    // succeeded and no shutdown has begun, so a refusal releases the latch, which also
    // reports the handed-off auto-starts as abandoned.
    this.core.state.isStarting = true;
    // The startup that actually takes the latch owns the current registry, even if
    // a listener started it before the original restart resumed. Transfer every
    // pending handoff before signal attachment can run caller code, and empty each
    // token so an older restart finalizer cannot warn for work already claimed.
    for (const names of this.core.state.pendingRestartAutoStarts) {
      for (const name of names) {
        if (this.core.internals.getComponent(name) !== undefined) {
          this.core.state.deferredAutoStartNames.add(name);
        }
      }
      names.clear();
    }
    this.core.state.pendingRestartAutoStarts.clear();
    this.core.state.autoAttachedSignalsDuringStartup = false;

    // This startup's baseline for every "did a shutdown start meanwhile" check below,
    // including the one right after the attach.
    const shutdownTokenAtBulkStart = this.core.state.shutdownToken;
    const hasShutdownBegun = (): boolean =>
      this.core.shutdownPass.isShuttingDown ||
      this.core.state.shutdownToken !== shutdownTokenAtBulkStart;

    // Tracked so failure cleanup does not detach handlers that were attached earlier by
    // some other path.
    const bulkSignalAttach = this.core.config.attachSignalsBeforeStartup
      ? this.core.internals.autoAttachSignals('bulk startup')
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
    this.core.state.unexpectedStopsDuringStartup.clear();
    this.core.shutdownEscalation.resetRepeatedShutdownRequestState();
    this.core.state.shutdownMethod = null; // Clear previous shutdown method on fresh start
    this.core.state.lastShutdownResult = null; // Clear last shutdown result on fresh start

    this.core.logger.info('Starting all components');

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
      this.core.logger.warn(
        'Startup timeout exceeded, returning partial results',
        {
          params: { timeoutMS: effectiveTimeout },
        },
      );
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
      initialOrderNames: new Set<string>(),
      reachedNames: new Set<string>(),
      frozenAutoStarts: new Set<string>(),
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
      this.core.state.activeBulkStartup = bulkStartup;

      // What every answer of this startup reports of its progress, read as it answers:
      // what is still running of what it started, and what it had already given up on.
      const startupProgress = (): Pick<
        StartupResult,
        | 'startedComponents'
        | 'failedOptionalComponents'
        | 'skippedDueToDependency'
      > => ({
        startedComponents: this.runningStartupSnapshot(startedComponents),
        failedOptionalComponents,
        skippedDueToDependency: Array.from(skippedDueToDependency),
      });
      // A startup that failed part-way: its progress, and why it failed.
      const failedStartup = (
        failure: Pick<StartupResult, 'reason' | 'code'> &
          Partial<Pick<StartupResult, 'error' | 'timedOut'>>,
      ): StartupResult => ({
        success: false,
        ...startupProgress(),
        ...failure,
        durationMS: Date.now() - startTime,
      });

      // The answer for a startup a shutdown cut short, wherever it notices. Shutdown
      // retains running-set membership while stop hooks settle; that teardown is
      // no longer available and must not be reported as a successful startup.
      const abortedByShutdown = (
        reason = 'Shutdown triggered during startup',
        error?: Error,
      ): StartupResult => {
        abandonReason = 'was interrupted by shutdown';
        detachReason = 'interrupted bulk startup';
        return failedStartup({
          reason,
          code: 'shutdown_in_progress',
          ...(error === undefined ? {} : { error }),
        });
      };

      // Where the startup itself notices a shutdown begun by caller code it ran. The log
      // comes first: `abortedByShutdown()` snapshots what is still running after it.
      const abortOnShutdownSignal = (): StartupResult => {
        this.core.logger.warn(
          'Shutdown signal received during startup, aborting',
        );
        return abortedByShutdown();
      };

      const unexpectedStopFailure = (error: Error): StartupResult => {
        // Rollback preparation and stop hooks also run caller code. A shutdown
        // accepted while awaiting rollback owns the resulting teardown snapshot.
        if (hasShutdownBegun()) {
          return abortedByShutdown();
        }
        return failedStartup({
          reason: describeError(error),
          code: 'component_unexpected_stop',
          error,
        });
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
        const reconciled =
          this.core.unexpectedStops.consumeUnexpectedStopsDuringStartup(
            startedComponents,
            failedOptionalComponents,
          );
        startedComponents.splice(0, startedComponents.length);
        startedComponents.push(...reconciled.startedComponents);

        // Optionality getters and log sinks can start shutdown. It owns teardown
        // from that point, before any required-stop rollback decision is made.
        if (hasShutdownBegun()) {
          return { kind: 'result', value: abortOnShutdownSignal() };
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
        const frozenAutoStarts = bulkStartup.frozenAutoStarts;

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
            () => !hasShutdownBegun(),
          );

          if (hasShutdownBegun()) {
            return abortOnShutdownSignal();
          }

          if (!registryRead.isSettled) {
            throw new Error(
              'The registry kept changing while the startup order was being read',
            );
          }

          startupOrder = this.core.startupOrdering.getStartupOrderInternal(
            this.core.state.components,
            undefined,
            startupReads,
          );
          bulkStartup.isOrdering = false;
          for (const name of startupOrder) {
            bulkStartup.initialOrderNames.add(name);
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
              Date.now() - startTime,
            ),
            error: failure.error,
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
        function* startupBatches(
          this: StartupOrchestration,
        ): Generator<string> {
          try {
            yield* startupOrder;
            while (this.core.state.deferredAutoStartNames.size > 0) {
              if (!canContinueOrdering()) {
                return;
              }
              const registryRead = this.core.registryReads.readRegistry(
                (component) =>
                  this.core.componentMetadata.readDependenciesReported(
                    component,
                    'startup',
                  ),
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
              const batch = this.core.startupOrdering
                .getStartupOrderInternal(
                  this.core.state.components,
                  undefined,
                  startupReads,
                )
                .filter((name) =>
                  this.core.state.deferredAutoStartNames.has(name),
                );
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

        // Final reconciliation can run optionality hooks and logging sinks. Any
        // auto-starts they register still belong to this pass, including rollback
        // and its original deadline, so drain them before publishing completion.
        do {
          // Initial and follow-up batches share every deadline and failure check below.
          for (const name of startupBatches.call(this)) {
            // Synchronous starts can exhaust the budget without yielding to timers.
            refreshStartupDeadline();
            if (hasTimedOut) {
              this.core.logger.warn(
                'Startup timeout reached, stopping component initiation',
              );
              break;
            }
            bulkStartup.reachedNames.add(name);

            const component = this.core.internals.getComponent(name);
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
            if (hasShutdownBegun()) {
              return abortOnShutdownSignal();
            }

            // Skip stalled components during bulk startup (even with ignoreStalledComponents:true bulk option)
            if (this.core.state.stalledComponents.has(name)) {
              frozenAutoStarts.delete(name);
              this.core.logger
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
              const depComponent = this.core.internals.getComponent(depName);
              // Read only where it decides something - a dependency that stalled, was
              // skipped or failed - and guarded: a healthy dependency's `isOptional()`
              // that threw used to crash, and roll back, the whole startup.
              const isDependencyOptional = (): boolean =>
                depComponent !== undefined &&
                this.core.componentMetadata.isComponentOptional(depComponent);

              // A stalled dependency follows the optional-dependency rule as a skipped or
              // failed one does: an optional one does not block its dependents, which an
              // individual start of them allows too.
              if (skippedDueToStall.has(depName)) {
                if (!isDependencyOptional()) {
                  shouldSkip = true;
                  skipReason = `Dependency "${depName}" is stalled`;
                  break;
                }
                continue;
              }

              if (skippedDueToDependency.has(depName)) {
                if (!isDependencyOptional()) {
                  shouldSkip = true;
                  skipReason = `Dependency "${depName}" was skipped`;
                  break;
                }
                continue;
              }

              if (depComponent) {
                const depState = this.core.state.componentStates.get(depName);
                if (depState === 'failed' && !isDependencyOptional()) {
                  shouldSkip = true;
                  skipReason = `Dependency "${depName}" failed to start`;
                  break;
                }
              }
            }

            if (shouldSkip) {
              frozenAutoStarts.delete(name);
              this.core.logger
                .entity(name)
                .warn('Skipping component due to dependency', {
                  params: { reason: skipReason },
                });
              this.core.lifecycleEvents.componentStartSkipped(name, skipReason);
              skippedDueToDependency.add(name);
              continue;
            }

            // Check if shutdown was triggered during startup
            if (hasShutdownBegun()) {
              return abortOnShutdownSignal();
            }

            // Start the component (allow during bulk startup since we ARE the bulk operation)
            frozenAutoStarts.delete(name);
            // Whether this start's timeout was the bulk deadline's, as opposed to the
            // component's own `startupTimeoutMS`: the bulk timer can also fire after the
            // component's own timer and before this loop resumes, and that timeout is
            // still a required failure to roll back, not a bulk timeout.
            let didStartMeetBulkDeadline = false;
            const startDeadlineContext =
              deadlineContext === undefined
                ? undefined
                : {
                    ...deadlineContext,
                    onTimeout: (): void => {
                      didStartMeetBulkDeadline = true;
                      deadlineContext.onTimeout();
                    },
                  };
            const result =
              await this.core.componentStart.startComponentInternal(
                name,
                snapshotStartOptions({
                  allowDuringBulkStartup: true,
                }),
                // Every follow-up batch shares the original deadline.
                startDeadlineContext,
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
            // Only a timeout the bulk deadline caused: the component's own one is a
            // failure like any other, even when the bulk deadline has also passed.
            if (
              hasTimedOut &&
              didStartMeetBulkDeadline &&
              result.code === 'component_startup_timeout'
            ) {
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
              return failedStartup({
                code: 'partial_state',
                reason: isLateTimeoutCleanup
                  ? `Component "${name}": ${LIFECYCLE_MANAGER_MESSAGE_TIMED_OUT_STARTUP_CLEANUP}`
                  : `Component "${name}" has an independent ${operation} in progress`,
              });
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
              this.core.state.unexpectedStopsDuringStartup.delete(name);

              const error =
                result.error ||
                new Error(
                  result.reason || `Component "${name}" stopped unexpectedly`,
                );

              const isOptional =
                this.core.unexpectedStops.noteUnexpectedStopDuringStartup(
                  name,
                  component,
                  error,
                  failedOptionalComponents,
                );
              if (!isOptional) {
                clearTimeout(timeoutHandle);
                await rollBackOnce(startedComponents);
                return unexpectedStopFailure(error);
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
                this.core.state.runningComponents.has(name)
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
                // Whatever the rollback could not stop, so the result matches the registry,
                // excluding teardown as every other failure exit does.
                startedComponents: this.runningStartupSnapshot([
                  ...startedComponents,
                  name,
                ]),
                failedOptionalComponents,
                skippedDueToDependency: Array.from(skippedDueToDependency),
                error: result.error,
              };
            } else {
              // Check if component is optional
              if (this.core.componentMetadata.isComponentOptional(component)) {
                // Built once, so the log, the event and the result name the same error
                // - one standing in for a result that carried none, too.
                const failure =
                  result.error ||
                  new Error(
                    result.reason || LIFECYCLE_MANAGER_MESSAGE_UNKNOWN_ERROR,
                  );
                this.core.logger
                  .entity(name)
                  .warn(
                    'Optional component failed to start, continuing: {{error.message}}',
                    { params: { error: failure } },
                  );

                this.core.lifecycleEvents.componentStartFailedOptional(
                  name,
                  failure,
                );

                // Mark as failed state - unless stopping it again after a crash already
                // left it stalled, which `stalledComponents` still says and the state
                // must agree with. Nor over a component something else now owns -
                // running again, or with another start or stop in flight. Overwritten,
                // its in-flight guard would be gone, and a second `stop()` could run
                // alongside the one already underway.
                const isOwnedElsewhere =
                  this.core.state.runningComponents.has(name) ||
                  this.core.claims.isInFlight(name);

                if (
                  !this.core.state.stalledComponents.has(name) &&
                  !isOwnedElsewhere
                ) {
                  this.core.state.componentStates.set(name, 'failed');

                  if (result.error) {
                    this.core.state.componentErrors.set(name, result.error);
                  }
                }

                failedOptionalComponents.push({ name, error: failure });
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

                return failedStartup({
                  reason:
                    result.reason ||
                    `Required component "${name}" failed: ${result.code || 'unknown'}`,
                  code: 'required_component_failed',
                  error: result.error,
                });
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
            this.core.logger.warn('Startup completed with timeout', {
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
              return abortOnShutdownSignal();
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
          this.core.state.deferredAutoStartNames.size > 0 &&
          !hasTimedOut &&
          !hasShutdownBegun()
        );

        // The loop checks for a shutdown after each start, but the events it emits for
        // the last component - `start-failed-optional`, `start-skipped` - come after that
        // check, and a listener there can start one. Reporting success and emitting
        // `started` would then describe a startup that a shutdown is already undoing.
        if (hasShutdownBegun()) {
          return abortOnShutdownSignal();
        }

        // Check if startup timed out during the process
        if (hasTimedOut) {
          return failedStartup({
            timedOut: true,
            reason: `Startup timeout exceeded (${effectiveTimeout}ms)`,
            code: 'startup_timeout',
          });
        }

        this.core.internals.updateStartedFlag();
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
        this.core.logger.success('All components started', {
          params: {
            started: startedComponents.length,
            failed: failedOptionalComponents.length,
            skipped: skippedComponentsArray.length,
            durationMS,
          },
        });

        this.core.lifecycleEvents.lifecycleManagerStarted(
          startedComponents,
          failedOptionalComponents,
          skippedComponentsArray,
        );

        // Asked once more, after both notifications: each runs caller code, and a
        // `started` listener or log sink that begins a shutdown left this answering
        // `success: true` while `getSystemState()` already said `shutting-down` - the
        // very contradiction the check ahead of them exists to prevent. The `started`
        // event stands, since the startup did complete; the result reports the shutdown
        // that is now undoing it, as a startup a shutdown cut short does.
        if (hasShutdownBegun()) {
          this.core.logger.warn('Shutdown began as startup completed');
          return abortedByShutdown('Shutdown triggered as startup completed');
        }

        detachReason = 'completed bulk startup';
        return {
          success: true,
          ...startupProgress(),
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
          this.core.logger.error(
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
            return abortedByShutdown(undefined, crashError);
          }
        } catch (rollbackError) {
          reportCallbackError(
            'lifecycle-manager startup rollback',
            rollbackError,
          );
        }

        return {
          ...crashedStartupResult(
            crashError,
            `startAllComponents() failed unexpectedly: ${describeError(crashError)}`,
            // Reported above, so a crash even for a branded option refusal: this
            // startup's own options were validated before it took the latch, and
            // anything met since is the startup failing part-way, not a refusal.
            'operation_crashed',
            Date.now() - startTime,
          ),
          ...(isDependencyCycle
            ? {
                code: 'dependency_cycle' as const,
                reason: describeError(crashError),
              }
            : {}),
          // Whatever the rollback could not stop, so the result matches the registry.
          ...startupProgress(),
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
          this.core.internals.nameOf(c),
        ) &&
        dependenciesOf(
          this.core.internals.currentReadOf(
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

  /** Refuse an active bulk operation before reading unused caller options. */
  private refuseActiveBulkStartup(
    startTime: number,
  ): StartupResult | undefined {
    // Reject if already starting
    if (this.core.state.isStarting) {
      this.core.logger.warn(
        'Cannot start all components: startup already in progress',
      );

      return refusedStartupResult(
        'already_in_progress',
        'Startup already in progress',
        Date.now() - startTime,
      );
    }

    // Reject if shutdown is in progress
    if (this.core.shutdownPass.isShuttingDown) {
      this.core.logger.warn(
        'Cannot start all components: shutdown in progress',
      );

      return refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
        Date.now() - startTime,
      );
    }

    // Reject once a logger exit has committed the process to ending, or while a simulated
    // one is still closing the sinks
    if (this.core.loggerExit.isLoggerExitInProgress()) {
      this.core.logger.warn('Cannot start all components: process is exiting');

      return refusedStartupResult(
        'shutdown_in_progress',
        LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
        Date.now() - startTime,
      );
    }

    return undefined;
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
        this.core.internals.detachSignalsIfIdle(input.detachReason);
      } else {
        this.core.internals.runDeferredSignalDetach('bulk startup');
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
            if (this.core.internals.getComponent(name) !== undefined) {
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

  /**
   * The names that are up, in order - what every startup result reports as started:
   * success, abort, timeout, and also a startup that failed and rolled back. A rollback
   * that could not stop a component leaves it up, and the result must match the
   * registry rather than claim nothing is. One answer for all of them: the failure
   * paths used running-set membership alone, and listed teardown as started.
   */
  private runningStartupSnapshot(
    names: readonly string[] = this.core.state.components.map((component) =>
      this.core.internals.nameOf(component),
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

    this.core.logger.warn('Rolling back startup, stopping started components', {
      params: { components: componentsToRollback },
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
}
