import { reportCallbackError } from '../../safe-handle-callback';
import type { BaseComponent } from '../base-component';
import {
  LIFECYCLE_MANAGER_MESSAGE_BULK_OPERATION_IN_PROGRESS,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
} from '../constants';
import type {
  ComponentLifecycleRef,
  UnregisterComponentResult,
  UnregisterOptions,
} from '../types';
import type { ManagerCore } from './manager-core';
import { isStartUnfinished } from './manager-state';
import { snapshotUnregisterOptions } from './operation-options';

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
    const refuseIfReplaced = (): UnregisterComponentResult | undefined => {
      if (
        this.core.registry.getComponent(name) === component &&
        this.core.registryReads.currentGeneration(component) ===
          registrationGeneration
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
    };

    // Both options, read once, here (`stopIfRunning` defaults to true). Their getters
    // are caller code, so the replacement check follows.
    const unregisterOptions = snapshotUnregisterOptions(options);
    const shouldStopIfRunning = unregisterOptions.stopIfRunning;

    const replacedAfterOptions = refuseIfReplaced();

    if (replacedAfterOptions !== undefined) {
      return replacedAfterOptions;
    }

    const inFlightRefusal = this.refuseUnregisterWhileInFlight(name, false);

    if (inFlightRefusal !== null) {
      return inFlightRefusal;
    }

    const isStalled = this.core.state.stalledComponents.has(name);

    if (isStalled && shouldStopIfRunning) {
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

    const isRunning = this.core.manager.isComponentRunning(name);

    // If running and stopIfRunning explicitly set to false, reject
    if (isRunning && !shouldStopIfRunning) {
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
    if (isRunning && shouldStopIfRunning) {
      this.core.logger
        .entity(name)
        .info('Stopping component before unregistering');

      const replacedBeforeStop = refuseIfReplaced();

      if (replacedBeforeStop !== undefined) {
        return replacedBeforeStop;
      }

      // The log line above ran caller code, which may have begun a stop or a bulk
      // operation of its own. Answer for that one, rather than reporting the refusal it
      // causes below as this unregister's failed stop.
      const inFlightBeforeStop = this.refuseUnregisterWhileInFlight(
        name,
        false,
      );

      if (inFlightBeforeStop !== null) {
        return inFlightBeforeStop;
      }

      if (this.isBulkOperationBlockingUnregister(name)) {
        return this.refuseUnregisterForBulkOperation(name, false, true);
      }

      const stopResult = await this.core.manager.stopComponent(name, {
        allowStopWithRunningDependents: unregisterOptions.forceStop,
      });

      // Before reading any state by name: the stop's `await` ran caller code, and a
      // replacement registered under the name would answer for this component - a
      // stopped replacement made a failed stop report `wasStopped: true`. Only the
      // stop's own answer is about this component then.
      progress.wasStopped = stopResult.success;
      const replacedDuringStop = refuseIfReplaced();

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

        // A stop refused for its own configuration never ran: the unregister's own
        // `invalid_options`, not a failed stop.
        if (stopResult.code === 'invalid_options') {
          return {
            success: false,
            componentName: name,
            reason: stopResult.reason ?? 'Failed to stop component',
            code: 'invalid_options',
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
                : 'error',
          error: stopResult.error,
          wasStopped: false,
          wasRegistered: true,
        };
      }

      progress.wasStopped = true;
    }

    // After the stop's `await` - a `component:stopped` listener can do the same - and
    // before the post-stop checks below, which would otherwise answer for a replacement.
    const replacedAfterStop = refuseIfReplaced();

    if (replacedAfterStop !== undefined) {
      return replacedAfterStop;
    }

    if (progress.wasStopped) {
      // A `component:stopped` listener may also have started it again, or begun another
      // stop. Removing it now would orphan that operation: a start that finished on an
      // unregistered component left whatever it brought up running, owned by nothing.
      const inFlightAfterStop = this.refuseUnregisterWhileInFlight(name, true);

      if (inFlightAfterStop !== null) {
        return inFlightAfterStop;
      }

      // Or started it again and it is already up: a start that settles within the
      // same turn is past `starting` by now.
      if (this.core.manager.isComponentRunning(name)) {
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

    // Checked again here rather than only at the top: a bulk startup or shutdown that
    // began while this component was stopping - or inside that same option getter - now
    // owns the registry, and removing a component from under it is what the guard at the
    // top exists to prevent. The component stays registered, in whatever state it
    // reached: stopped on the stop path, untouched on the one that had nothing to stop.
    if (this.isBulkOperationBlockingUnregister(name)) {
      return this.refuseUnregisterForBulkOperation(
        name,
        progress.wasStopped,
        true,
      );
    }

    return this.core.dispatcher.withTransition(() => {
      // Remove from registry
      this.core.state.componentEntries =
        this.core.state.componentEntries.filter((c) => c !== component);

      this.core.registry.publishRegistry();

      // Clean up state - the manager's own maps first, all of them, so the component is
      // either fully registered or fully gone. The component's hooks run after, contained:
      // they can be overridden, and one that threw used to leave the component out of the
      // registry but still in every state map.
      // A removed registration must not survive as deferred work in a restart
      // handoff. A later registration of the name decides its own auto-start policy.
      // `deferredAutoStartNames` needs no such step: it holds names only while a
      // startup holds the latch, and the bulk-operation check above refuses then.
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
      this.core.state.stalledComponents.delete(name);
      this.core.state.runningComponents.delete(name);
      this.core.state.componentClaims.delete(name);
      this.core.componentStart.releaseStartSettlements(name);
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
    const component = this.core.registry.getComponent(name);
    const hasUnfinishedStart = (): boolean => {
      for (const settlement of this.core.state.startSettlementsByName.get(
        name,
      ) ?? []) {
        if (
          settlement.component === component &&
          this.core.state.componentStartAttemptTokens.get(name) ===
            settlement.token &&
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
 * Tell a component it is no longer registered. Its own `_markUnregistered()` first, so
 * an override that extends it still runs; if that throws, the two fields it would have
 * cleared are cleared directly. Left set, the instance believed it was still
 * registered, and registering it again was refused as `duplicate_instance`.
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
