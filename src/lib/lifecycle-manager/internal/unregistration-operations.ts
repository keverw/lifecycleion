import { reportCallbackError } from '../../safe-handle-callback';
import type { BaseComponent } from '../base-component';
import {
  LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
} from '../constants';
import type {
  ComponentLifecycleRef,
  ComponentOperationFailureCode,
  ComponentOperationResult,
  UnregisterComponentResult,
  UnregisterFailureCode,
  UnregisterOptions,
} from '../types';
import type { ManagerCore } from './manager-core';
import { isStartUnfinished } from './manager-state';
import {
  snapshotUnregisterOptions,
  type UnregisterOptionsSnapshot,
} from './operation-options';

/**
 * One unregister call: the name it was asked to remove, the instance registered under
 * that name when it began and that registration's generation, the options it read, and
 * what it has done so far - `progress`, shared with the safety net that wraps it, so a
 * crash still reports a stop that happened. Created once the options are read, and
 * handed to every phase of `unregisterComponentOperation()`. It runs no code of its own.
 */
class UnregisterAttempt {
  constructor(
    public readonly name: string,
    public readonly component: BaseComponent,
    public readonly registrationGeneration: number | undefined,
    public readonly options: UnregisterOptionsSnapshot,
    public readonly progress: { wasStopped: boolean },
  ) {}
}

/**
 * Unregistration: `unregisterComponent()`'s body.
 *
 * An unregister refuses while a bulk operation owns the registry or a start or stop is in
 * flight, stops a running component first when asked to, and checks after every step
 * that runs caller code that the name still belongs to the registration it began with.
 *
 * Registration (`RegistrationOperations`) changes the registry the other way; the
 * registry's lookups and publication are `core.registry`'s.
 */
export class UnregistrationOperations {
  constructor(private readonly core: ManagerCore) {}

  /**
   * `unregisterComponent()`'s body. Refuses up front for a bulk operation or a name
   * nothing holds, then runs the phases in order over one `UnregisterAttempt`: the
   * refusals before any stop (`refuseBeforeStop()`), the stop of a running component -
   * `refuseBeforeStopping()`, the stop itself, and `answerStop()` - the refusals the
   * stop's caller code can still cause (`refuseAfterStop()`), and the removal
   * (`removeComponent()`). Every phase is synchronous; the stop is the one thing
   * awaited, here, directly.
   */
  public async unregisterComponentOperation(
    name: string,
    options: UnregisterOptions | undefined,
    progress: { wasStopped: boolean },
  ): Promise<UnregisterComponentResult> {
    // Block unregistration during bulk operations
    if (this.isBulkOperationBlockingUnregister(name)) {
      return this.refuseUnregisterForBulkOperation(
        name,
        false,
        this.core.registry.isNameRegistered(name),
      );
    }

    const component = this.core.registry.getComponent(name);

    if (!component) {
      this.core.logger
        .entity(name)
        .warn(LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND);
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
        code: 'component_not_found',
        wasStopped: false,
        wasRegistered: false,
      };
    }

    // `component` is captured before any caller code runs, and every step below acts on
    // the name. Option getters and the stop's `await` all run caller code that can
    // unregister this component and register a replacement under the same name, so
    // ownership is checked again after each, before anything acts on the name: the
    // in-flight and running checks would answer for the replacement, `stopComponent()`
    // would stop it, and removal - by instance from the registry, but by name from every
    // state map - would wipe its state while leaving it registered, and report success
    // for a removal it never made.
    //
    // By registration, not only by instance: the same instance unregistered and
    // registered again across the stop's `await` is a new registration - with its own
    // auto-start policy, state and owner - and removing it reported success for a
    // removal this call was never asked to make.
    const registrationGeneration =
      this.core.registryReads.currentGeneration(component);

    // Both options, read once, here (`stopIfRunning` defaults to true). Their getters
    // are caller code, so the replacement check follows.
    const unregisterOptions = snapshotUnregisterOptions(options);
    const attempt = new UnregisterAttempt(
      name,
      component,
      registrationGeneration,
      unregisterOptions,
      progress,
    );

    const refusedBeforeStop = this.refuseBeforeStop(attempt);

    if (refusedBeforeStop !== undefined) {
      return refusedBeforeStop;
    }

    const isRunning = this.core.manager.isComponentRunning(name);

    // If running and stopIfRunning explicitly set to false, reject
    if (isRunning && !attempt.options.stopIfRunning) {
      // `isComponentRunning()` is overridable, so its answer may describe a
      // replacement it registered rather than this call's component.
      const replacedWhileChecking = this.refuseIfReplaced(attempt);

      if (replacedWhileChecking !== undefined) {
        return replacedWhileChecking;
      }

      this.core.logger
        .entity(name)
        .warn(
          'Cannot unregister running component. Call stopComponent() first or pass { stopIfRunning: true }',
        );

      return {
        success: false,
        componentName: name,
        reason:
          'Component is running. Use stopIfRunning: true option or stop manually first',
        code: 'component_running',
        wasStopped: false,
        wasRegistered: true,
      };
    }

    // If running and stopIfRunning is true (default), stop first
    if (isRunning && attempt.options.stopIfRunning) {
      const refusedBeforeStopping = this.refuseBeforeStopping(attempt);

      if (refusedBeforeStopping !== undefined) {
        return refusedBeforeStopping;
      }

      const stopResult = await this.core.manager.stopComponent(name, {
        allowStopWithRunningDependents: attempt.options.forceStop,
      });

      const failedStop = this.answerStop(attempt, stopResult);

      if (failedStop !== undefined) {
        return failedStop;
      }
    }

    const refusedAfterStop = this.refuseAfterStop(attempt);

    if (refusedAfterStop !== undefined) {
      return refusedAfterStop;
    }

    return this.removeComponent(attempt);
  }

  /**
   * The refusal for a name that no longer belongs to the registration this call began
   * with, or `undefined` while it still does. Asked after every step that runs caller
   * code, for the reasons `unregisterComponentOperation()` gives.
   */
  private refuseIfReplaced(
    attempt: UnregisterAttempt,
  ): UnregisterComponentResult | undefined {
    const { name, component, progress } = attempt;

    if (
      this.core.registry.isCurrentRegistration(
        name,
        component,
        attempt.registrationGeneration,
      )
    ) {
      return undefined;
    }

    return {
      success: false,
      componentName: name,
      reason: progress.wasStopped
        ? 'Component was unregistered while it was being stopped'
        : 'Component was unregistered while this unregister was in progress',
      code: 'component_not_found',
      wasStopped: progress.wasStopped,
      // Registered when this call started, which is what this field reports - the
      // name may belong to a replacement by now, which is not this call's component.
      wasRegistered: true,
    };
  }

  /**
   * The refusals once the options are read, before the component's running state is:
   * a replacement registered by an option getter, a start or stop in flight, or a
   * stalled component this call was asked to stop.
   */
  private refuseBeforeStop(
    attempt: UnregisterAttempt,
  ): UnregisterComponentResult | undefined {
    const { name } = attempt;
    const replacedAfterOptions = this.refuseIfReplaced(attempt);

    if (replacedAfterOptions !== undefined) {
      return replacedAfterOptions;
    }

    const inFlightRefusal = this.refuseUnregisterWhileInFlight(name, false);

    if (inFlightRefusal !== null) {
      return inFlightRefusal;
    }

    const isStalled = this.core.state.stalledComponents.has(name);

    if (isStalled && attempt.options.stopIfRunning) {
      this.core.logger
        .entity(name)
        .warn('Cannot unregister stalled component when stopIfRunning is set');
      return {
        success: false,
        componentName: name,
        reason: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
        code: 'stop_failed',
        stopFailureReason: 'stalled',
        wasStopped: false,
        wasRegistered: true,
      };
    }

    return undefined;
  }

  /**
   * Announce that a running component is to be stopped first, then refuse if that log
   * line's caller code replaced the component or began an operation of its own.
   *
   * Logged before the rechecks rather than after them: the line runs the caller's sinks,
   * and the rechecks are what answer for anything a sink changes before the stop. So it
   * is worded as the intent - a refusal below means the stop never runs.
   */
  private refuseBeforeStopping(
    attempt: UnregisterAttempt,
  ): UnregisterComponentResult | undefined {
    const { name } = attempt;

    this.core.logger
      .entity(name)
      .info('Unregistering running component; stopping it first');

    const replacedBeforeStop = this.refuseIfReplaced(attempt);

    if (replacedBeforeStop !== undefined) {
      return replacedBeforeStop;
    }

    // The log line above ran caller code, which may have begun a stop or a bulk
    // operation of its own. Answer for that one, rather than reporting the refusal it
    // causes in the stop `unregisterComponentOperation()` runs next as this
    // unregister's failed stop.
    const inFlightBeforeStop = this.refuseUnregisterWhileInFlight(name, false);

    if (inFlightBeforeStop !== null) {
      return inFlightBeforeStop;
    }

    if (this.isBulkOperationBlockingUnregister(name)) {
      return this.refuseUnregisterForBulkOperation(name, false, true);
    }

    return undefined;
  }

  /**
   * Answer the stop this unregister ran: the refusal when the name was replaced across
   * it or the component is not safely stopped, or `undefined` once it is, with
   * `progress.wasStopped` set.
   */
  private answerStop(
    attempt: UnregisterAttempt,
    stopResult: ComponentOperationResult,
  ): UnregisterComponentResult | undefined {
    const { name, progress } = attempt;

    // Before reading any state by name: the stop's `await` ran caller code, and a
    // replacement registered under the name would answer for this component - a
    // stopped replacement made a failed stop report `wasStopped: true`. Only the
    // stop's own answer is about this component then.
    progress.wasStopped = stopResult.success;
    const replacedDuringStop = this.refuseIfReplaced(attempt);

    if (replacedDuringStop !== undefined) {
      return replacedDuringStop;
    }

    // If stop fails and leaves the component stalled, do NOT unregister.
    // Caller expectation: success with stopIfRunning implies the component is stopped and unregistered.
    const stateAfterStopAttempt = this.core.state.componentStates.get(name);
    const isRunningAfterStopAttempt =
      this.core.manager.isComponentRunning(name);

    const isSafelyStopped =
      stopResult.success ||
      (!isRunningAfterStopAttempt && stateAfterStopAttempt === 'stopped');

    if (!isSafelyStopped) {
      this.core.logger
        .entity(name)
        .warn('Failed to stop component before unregistering', {
          params: {
            reason: stopResult.reason,
            code: stopResult.code,
            state: stateAfterStopAttempt,
          },
        });

      // A stop refused before it ran `stop()` is answered with the unregister's own
      // code for that refusal, not as a failed stop.
      const refusalCode = unregisterCodeForRefusedStop(stopResult.code);

      if (refusalCode !== undefined) {
        return {
          success: false,
          componentName: name,
          reason: stopResult.reason ?? 'Failed to stop component',
          code: refusalCode,
          error: stopResult.error,
          wasStopped: false,
          wasRegistered: true,
        };
      }

      return {
        success: false,
        componentName: name,
        reason: stopResult.reason ?? 'Failed to stop component',
        code: 'stop_failed',
        stopFailureReason:
          stopResult.code === 'component_shutdown_timeout'
            ? 'timeout'
            : stopResult.code === 'operation_crashed'
              ? 'operation_crashed'
              : stopResult.code === 'component_stalled'
                ? 'stalled'
                : 'error',
        error: stopResult.error,
        wasStopped: false,
        wasRegistered: true,
      };
    }

    progress.wasStopped = true;

    return undefined;
  }

  /**
   * The refusals between the stop, or the decision that there was nothing to stop, and
   * the removal: a replacement, a start or stop a `component:stopped` listener began,
   * and a bulk operation that took the registry meanwhile.
   */
  private refuseAfterStop(
    attempt: UnregisterAttempt,
  ): UnregisterComponentResult | undefined {
    const { name, progress } = attempt;

    // After the stop's `await` - a `component:stopped` listener can do the same - and
    // before the post-stop checks below, which would otherwise answer for a replacement.
    const replacedAfterStop = this.refuseIfReplaced(attempt);

    if (replacedAfterStop !== undefined) {
      return replacedAfterStop;
    }

    if (progress.wasStopped) {
      // Asked first, as the checks below follow caller code: `isComponentRunning()` is
      // overridable, and an override can replace the registration - which the removal
      // would then wipe by name - or begin a start or stop of its own.
      const isRunningAgain = this.core.manager.isComponentRunning(name);
      const replacedWhileChecking = this.refuseIfReplaced(attempt);

      if (replacedWhileChecking !== undefined) {
        return replacedWhileChecking;
      }

      // A `component:stopped` listener may also have started it again, or begun another
      // stop. Removing it now would orphan that operation: a start that finished on an
      // unregistered component left whatever it brought up running, owned by nothing.
      const inFlightAfterStop = this.refuseUnregisterWhileInFlight(name, true);

      if (inFlightAfterStop !== null) {
        return inFlightAfterStop;
      }

      // Or started it again and it is already up: a start that settles within the
      // same turn is past `starting` by now.
      if (isRunningAgain) {
        this.core.logger
          .entity(name)
          .warn('Component was started again while it was being stopped');

        return {
          success: false,
          componentName: name,
          reason: 'Component was started again while it was being stopped',
          code: 'component_running',
          wasStopped: true,
          wasRegistered: true,
        };
      }
    }

    // Checked again here rather than only at the top of `unregisterComponentOperation()`:
    // a bulk startup or shutdown that began while this component was stopping - or
    // inside one of this call's option getters - now owns the registry, and removing a
    // component from under it is what that first guard exists to prevent. The component
    // stays registered, in whatever state it reached: stopped on the stop path,
    // untouched on the one that had nothing to stop.
    if (this.isBulkOperationBlockingUnregister(name)) {
      return this.refuseUnregisterForBulkOperation(
        name,
        progress.wasStopped,
        true,
      );
    }

    return undefined;
  }

  /**
   * Remove the component, in one transition: from the registry, then from every state
   * map, then the component's own side and the auto-detach, then the announcement.
   */
  private removeComponent(
    attempt: UnregisterAttempt,
  ): UnregisterComponentResult {
    const { name, component, progress } = attempt;

    return this.core.dispatcher.withTransition(() => {
      // Remove from registry
      this.core.state.componentEntries =
        this.core.state.componentEntries.filter((c) => c !== component);

      this.core.registry.publishRegistry();

      // Clean up state - the manager's own maps first, all of them, so the component is
      // either fully registered or fully gone. The component's hooks run after, contained:
      // they can be overridden, and one that throws must not leave the component out of
      // the registry but still in every state map.
      // A removed registration must not survive as deferred work in a restart
      // handoff. A later registration of the name decides its own auto-start policy.
      // `deferredAutoStartNames` needs no such step: it holds names only while a
      // startup holds the latch, and the bulk-operation check in `refuseAfterStop()`
      // refuses then.
      for (const pending of this.core.state.pendingRestartAutoStarts) {
        pending.delete(name);
      }
      this.core.state.componentStates.delete(name);
      this.core.state.componentTimestamps.delete(name);
      this.core.state.componentErrors.delete(name);
      this.core.state.componentUnexpectedStopHadError.delete(name);
      this.core.state.componentStartAttemptTokens.delete(name);
      this.core.state.lateStartCleanupOutcomes.delete(name);
      this.core.state.componentStopAttemptTokens.delete(name);
      this.core.state.stalledStopEarlierTokens.delete(name);
      this.core.state.pendingForceStopWaiters.delete(name);
      // A later registration of the same instance reports a broken list afresh.
      this.core.componentMetadata.clearReports(component);
      // Its commit's validated list belongs to this registration only.
      this.core.state.committedDependencyReads.delete(component);
      this.core.state.stalledComponents.delete(name);
      this.core.state.runningComponents.delete(name);
      this.core.state.componentClaims.delete(name);
      this.core.startSettlements.releaseStartSettlements(name);
      // `registeredNames` keeps this entry: work still in flight - a broadcast that
      // captured the instance, a late-stop monitor - can still name it without asking the
      // component. A later registration of the same instance reads its name fresh and
      // overwrites the entry when it commits.
      this.core.registry.updateStartedFlag();

      this.core.unexpectedStops.clearUnexpectedStopHandler(
        component,
        'unregister',
      );

      markComponentUnregistered(component, 'lifecycle-manager unregister');

      this.core.signals.detachSignalsAfterLastStop(
        'last component unregistered',
        'Auto-detached process signals on last component unregistered',
      );

      this.core.logger.entity(name).info('Component unregistered');
      this.core.lifecycleEvents.componentUnregistered(name, false);

      return {
        success: true,
        componentName: name,
        wasStopped: progress.wasStopped,
        wasRegistered: true,
      };
    });
  }

  /**
   * Refuse an unregister while a start or stop is in flight for the component, or `null`
   * when none is. The operation writes its outcome by name when it settles: a start
   * marked an unregistered component running - a ghost no shutdown would stop, which
   * blocked a replacement under the same name - and a force retry marked a replacement
   * stalled or stopped. A graceful stop is refused the same way rather than being
   * stopped a second time, which only failed as `stop_failed`.
   */
  private refuseUnregisterWhileInFlight(
    name: string,
    wasStopped: boolean,
  ): UnregisterComponentResult | null {
    const hasUnfinishedStart = (): boolean => {
      for (const settlement of this.core.state.startSettlementsByName.get(
        name,
      ) ?? []) {
        if (
          this.core.startSettlements.isCurrentStartAttempt(
            name,
            settlement.component,
            settlement.token,
          ) &&
          ((settlement.didFailRawStartObservation === true &&
            isStartUnfinished(settlement)) ||
            (!settlement.rawStartPending &&
              settlement.isAwaitingLateStart === true))
        ) {
          return true;
        }
      }
      return false;
    };
    const isStarting =
      this.core.state.componentStates.get(name) === 'starting' ||
      hasUnfinishedStart();
    if (!this.core.claims.isInFlight(name) && !isStarting) {
      return null;
    }

    const reason = isStarting
      ? 'Component is starting. Wait for the start to settle before unregistering'
      : 'Component is stopping. Wait for the stop to settle before unregistering';

    this.core.logger.entity(name).warn(reason);

    return {
      success: false,
      componentName: name,
      reason,
      code: isStarting ? 'component_starting' : 'component_stopping',
      wasStopped,
      wasRegistered: true,
    };
  }

  /**
   * Whether a bulk operation owns the registry, so a component must not be removed from
   * under it: a startup or shutdown latch, or a late-startup cleanup for this component.
   */
  private isBulkOperationBlockingUnregister(name: string): boolean {
    return (
      this.core.state.isStarting ||
      this.core.shutdownPass.isShuttingDown ||
      this.core.state.pendingBulkStartupCleanup.has(name)
    );
  }

  private refuseUnregisterForBulkOperation(
    name: string,
    wasStopped: boolean,
    wasRegistered: boolean,
  ): UnregisterComponentResult {
    this.core.logger
      .entity(name)
      .warn(LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS, {
        params: {
          isStarting: this.core.state.isStarting,
          isShuttingDown: this.core.shutdownPass.isShuttingDown,
        },
      });

    return {
      success: false,
      componentName: name,
      reason: LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
      code: 'bulk_operation_in_progress',
      wasStopped,
      wasRegistered,
    };
  }
}

/**
 * The unregister code for a stop refused before it ran `stop()`, or `undefined` for one
 * that ran and failed, answered `stop_failed`: an invalid option, running dependents
 * without `forceStop` (the component is left running), a start or stop that owns the
 * component, or a bulk operation that owns the registry.
 */
function unregisterCodeForRefusedStop(
  code: ComponentOperationFailureCode | undefined,
): UnregisterFailureCode | undefined {
  switch (code) {
    case 'invalid_options':
      return 'invalid_options';
    case 'has_running_dependents':
      return 'component_running';
    case 'component_already_starting':
      return 'component_starting';
    case 'component_already_stopping':
      return 'component_stopping';
    case 'startup_in_progress':
    case 'shutdown_in_progress':
      return 'bulk_operation_in_progress';
    default:
      return undefined;
  }
}

/**
 * Tell a component it is no longer registered. Its own `_markUnregistered()` first, so
 * an override that extends it still runs; if that throws, the two fields it would have
 * cleared are cleared directly, so the instance never goes on believing it is
 * registered and having its next registration refused as `duplicate_instance`.
 */
export function markComponentUnregistered(
  component: BaseComponent,
  label: string,
): void {
  try {
    component._markUnregistered();
  } catch (unmarkError) {
    reportCallbackError(`${label} _markUnregistered`, unmarkError);

    try {
      const fields = component as unknown as {
        _isRegistered: boolean;
        lifecycle?: ComponentLifecycleRef;
      };

      fields._isRegistered = false;
      fields.lifecycle = undefined;
    } catch (clearError) {
      reportCallbackError(label, clearError);
    }
  }
}
