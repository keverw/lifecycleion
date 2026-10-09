import {
  LIFECYCLE_MANAGER_MESSAGE_PROCESS_EXITING,
  LIFECYCLE_MANAGER_MESSAGE_SHUTDOWN_IN_PROGRESS,
} from '../constants';
import type { StartupResult } from '../types';
import type { ManagerCore } from './manager-core';
import { refusedStartupResult } from './operation-policy';

/**
 * A bulk startup's answers before it takes the startup latch: refusing one that would
 * overlap another bulk operation or a process exit, and the registry preflight - nothing
 * registered, stalled components, components still starting or stopping, and components
 * already running, all of them a success with nothing to do and some a partial state.
 *
 * `StartupOrchestration` asks these before it takes the latch. A partial state lists
 * what is up through `core.startup.runningStartupSnapshot()`, as the startup's own
 * results do. Nothing here holds state: each answer reads the registry as it stands.
 */
export class StartupPreflight {
  constructor(private readonly core: ManagerCore) {}

  /** Refuse an active bulk operation before reading unused caller options. */
  public refuseActiveBulkStartup(startTime: number): StartupResult | undefined {
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
   * The answers a startup gives from the registry as it stands, before it takes the
   * latch: nothing registered, stalled components it was not told to ignore, components
   * still stopping or starting, and - through `answerRunningComponents()` - components
   * already running. `undefined` when the startup may go ahead.
   */
  public preflightStartup(
    startTime: number,
    shouldIgnoreStalledComponents: boolean,
  ): StartupResult | undefined {
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
    // all-running shortcut in `answerRunningComponents()` would report it "already
    // running" - listing it as started though its `start()` never ran - and a start of
    // it now would only be refused. Refused until the stop settles, as a partial state
    // is. A late start's cleanup marks its component running only so it can be stopped,
    // so it is on its way down too.
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
        startedComponents: this.core.startup.runningStartupSnapshot(),
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
        // Match the already-running partial-state result of
        // `answerRunningComponents()`: pending starts are excluded, but completed
        // components remain visible to the caller.
        startedComponents: this.core.startup.runningStartupSnapshot(),
      };
    }

    return this.answerRunningComponents(
      startTime,
      shouldIgnoreStalledComponents,
      totalCount,
      runningCount,
    );
  }

  /**
   * The preflight's answer when components are already running, from the counts it
   * took before logging anything: all of them running is a success with nothing to do,
   * some of them a partial state. `undefined` when none is.
   */
  private answerRunningComponents(
    startTime: number,
    shouldIgnoreStalledComponents: boolean,
    totalCount: number,
    runningCount: number,
  ): StartupResult | undefined {
    // Stalled components this startup would skip (`ignoreStalledComponents`): they are
    // neither running nor left for it to start, so they count toward neither side.
    const stalledToSkip = (names: readonly string[]): string[] =>
      shouldIgnoreStalledComponents
        ? names.filter((name) => this.core.state.stalledComponents.has(name))
        : [];

    // All running - nothing to do. At least one: an empty registry was refused earlier,
    // and one whose components are all stalled is left to the startup itself to skip.
    if (
      runningCount > 0 &&
      runningCount ===
        totalCount - stalledToSkip(this.core.manager.getComponentNames()).length
    ) {
      this.core.logger.info('All components already running');
      // The sink can begin teardown or change registrations. Decide from the same
      // post-log snapshot we return, rather than the count captured before it ran: the
      // registry's names, read once, for every part of it - not the overridable
      // `getComponentNames()`, whose answer the count check could disagree with.
      const names = this.core.state.components.map((component) =>
        this.core.registry.nameOf(component),
      );
      const startedComponents = this.core.startup.runningStartupSnapshot(names);
      const skippedDueToStall = stalledToSkip(names);
      const isStillAllRunning =
        startedComponents.length > 0 &&
        startedComponents.length === names.length - skippedDueToStall.length &&
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
        // As the startup itself reports the stalled components it skipped.
        ...(skippedDueToStall.length > 0 ? { skippedDueToStall } : {}),
        durationMS: Date.now() - startTime,
      };
    }

    // Partial state - reject to avoid inconsistent startup
    if (runningCount > 0) {
      // `refuseActiveBulkStartup()` refused both latches, and since then only the
      // manager's count and name getters have run - which a subclass can override, so
      // one may have taken a latch. The reads after the log check both latches again.
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
      const startedComponents = this.core.startup.runningStartupSnapshot();
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

    return undefined;
  }
}
