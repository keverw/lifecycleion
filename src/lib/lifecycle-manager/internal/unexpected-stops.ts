import { isNullish } from '../../internal/is-nullish';
import { reportCallbackError } from '../../safe-handle-callback';
import { isErrorValue, toError } from '../../to-error';
import type { BaseComponent } from '../base-component';
import {
  LIFECYCLE_MANAGER_LOG_OPTIONAL_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
  LIFECYCLE_MANAGER_LOG_REQUIRED_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
} from '../constants';
import type { ManagerCore } from './manager-core';
import { readComponentStatus } from './read-status';

/**
 * Unexpected stops: a component that reports through `reportUnexpectedStop()` that it
 * stopped on its own, outside any stop the manager made.
 *
 * A start installs the handler this hands out; the start, stop and unregister paths
 * clear it again, contained, through here. A report the handler accepts
 * records the component stopped - or stalled again, for a forced start's new run - and
 * announces it. One that lands during a bulk startup is also recorded for that startup,
 * which drains the records here: an optional component's stop is a failed optional
 * start, a required one's fails the startup.
 */
export class UnexpectedStops {
  constructor(private readonly core: ManagerCore) {}

  /** Keep a running component's handler independent of bulk dependency snapshots. */
  public createUnexpectedStopHandler(
    name: string,
    token: string,
  ): (error?: Error) => boolean {
    return (error) => this.handleComponentUnexpectedStop(name, token, error);
  }

  /**
   * Clear a component's unexpected-stop handler, contained. The hook is overridable,
   * and a throw must not skip the operation that clears it. A graceful stop now claims
   * the component before this hook, so re-entry sees the stop in progress; containing
   * a failure still lets stop() run rather than reporting a stall without attempting it.
   */
  public clearUnexpectedStopHandler(
    component: BaseComponent,
    context: string,
  ): void {
    try {
      component._clearUnexpectedStopHandler();
    } catch (error) {
      reportCallbackError(
        `lifecycle-manager ${context} _clearUnexpectedStopHandler`,
        error,
      );
    }
  }

  /**
   * Log a component's unexpected stop during a bulk startup and, when it is optional,
   * record it as a failed optional start. Returns whether it was optional; a required
   * one - or one no longer registered - fails the startup, which each caller unwinds
   * its own way. Shared by the start loop, which meets the stop as the start's own
   * result, and reconciliation, which meets it after the start had been counted.
   */
  public noteUnexpectedStopDuringStartup(
    name: string,
    component: BaseComponent | undefined,
    error: Error,
    failedOptionalComponents: Array<{ name: string; error: Error }>,
  ): boolean {
    if (
      component !== undefined &&
      this.core.componentMetadata.isComponentOptional(component)
    ) {
      if (!failedOptionalComponents.some((entry) => entry.name === name)) {
        failedOptionalComponents.push({ name, error });
      }

      this.core.logger
        .entity(name)
        .warn(
          LIFECYCLE_MANAGER_LOG_OPTIONAL_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
          {
            params: { error },
          },
        );
      return true;
    }

    this.core.logger
      .entity(name)
      .error(
        LIFECYCLE_MANAGER_LOG_REQUIRED_COMPONENT_UNEXPECTED_STOP_DURING_STARTUP,
        {
          params: { error },
        },
      );
    return false;
  }

  /**
   * Drain the unexpected stops recorded during a bulk startup for the components it
   * counted as started, through {@link noteUnexpectedStopDuringStartup}: what is left
   * started, and the first required component that stopped, if any.
   */
  public consumeUnexpectedStopsDuringStartup(
    startedComponents: string[],
    failedOptionalComponents: Array<{ name: string; error: Error }>,
  ): {
    startedComponents: string[];
    requiredFailure?: { name: string; error: Error };
  } {
    if (this.core.state.unexpectedStopsDuringStartup.size === 0) {
      return { startedComponents: [...startedComponents] };
    }

    let remainingStartedComponents = [...startedComponents];
    let requiredFailure: { name: string; error: Error } | undefined;

    // Optionality getters and reconciliation logs run caller code. They can report
    // a stop for a name that this scan already kept, so one scan is not a stable
    // reconciliation boundary. Drain reports for the surviving names before giving
    // control back to startup. Every repeated scan removes at least one survivor;
    // the original finite list bounds this work even if a sink repeatedly reports
    // an already-consumed name. New registrations belong to the batch queue, and
    // reports for names outside this attempt do not keep this drain alive.
    do {
      const candidates = remainingStartedComponents;
      remainingStartedComponents = [];
      for (const name of candidates) {
        const startupStopError =
          this.core.state.unexpectedStopsDuringStartup.get(name);

        if (startupStopError === undefined) {
          remainingStartedComponents.push(name);
          continue;
        }

        // Consume before invoking optionality or logging. Only pending reports
        // reach those callbacks, once per consumed name, not every reconciliation.
        this.core.state.unexpectedStopsDuringStartup.delete(name);

        const error =
          startupStopError ??
          new Error(`Component "${name}" stopped unexpectedly during startup`);
        if (
          !this.noteUnexpectedStopDuringStartup(
            name,
            this.core.registry.getComponent(name),
            error,
            failedOptionalComponents,
          )
        ) {
          requiredFailure ??= { name, error };
        }
        // Up again by now - a listener on its stop started it again before this report
        // was consumed - it is still this startup's to report and to roll back. Asked
        // after the callbacks above, which can report it stopped again.
        if (this.core.registry.isComponentUp(name)) {
          remainingStartedComponents.push(name);
        }
      }
    } while (
      remainingStartedComponents.some((name) =>
        this.core.state.unexpectedStopsDuringStartup.has(name),
      )
    );

    return {
      startedComponents: remainingStartedComponents,
      requiredFailure,
    };
  }

  private handleComponentUnexpectedStop(
    name: string,
    startAttemptToken: string,
    error?: Error,
  ): boolean {
    return this.core.dispatcher.withTransition(() => {
      // Handler is cleared before stop begins, so a call here means the component
      // stopped on its own during the current start/run.
      const currentState = this.core.state.componentStates.get(name);
      if (
        // Startup-time self-stops are valid too: start() may still be awaiting
        // some async work while an internal listener has already observed that
        // the component died and reported it.
        (currentState !== 'starting' && currentState !== 'running') ||
        this.core.state.componentStartAttemptTokens.get(name) !==
          startAttemptToken
      ) {
        return false;
      }

      // Normalized at the boundary. `error` is declared `Error`, but it arrives from the
      // component's own `reportUnexpectedStop()` and is never validated, so it can be any
      // value at all. It is stored here and dereferenced in several places later — the
      // warning below, `startAllComponents`'s failure summary, `getComponentStatus` — and
      // every one of those reads would otherwise be an unguarded `.message` on user input.
      // Normalized here, before a single field is written, and that ordering is the point:
      // a throw from an unguarded `.message` once the mutations below had run would leave
      // the component recorded as stopped with none of the events at the bottom emitted.
      // Taking the bad value's measure first means the only thing it can cost is itself.
      const failure = isNullish(error) ? null : toError(error);

      // Captured before the normalization above is allowed to blur the distinction, and
      // asked with the same check `toError` just used, so the two agree: `toError` keeps
      // a cross-realm error - from a `vm` context, an iframe - as-is, and this records it
      // as a reported error too, which `startComponent`'s overlapping-failure rule reads.
      // `isErrorValue()` is guarded internally, so it cannot throw here.
      const didReportError = isErrorValue(error);

      this.core.state.componentUnexpectedStopHadError.set(name, didReportError);

      // A forced start's unexpected stop ends only the new run: the stop that stalled is
      // still unfinished, so the component is `stalled` again, as a failed forced start
      // leaves it - and the stalled refusal, `retryStalled` and signal detach keep agreeing
      // with the stall record. Set here, not once `start()` settles: in between, the
      // component was reported stopped while its stall stood.
      const isStillStalled = this.core.state.stalledComponents.has(name);
      this.core.state.runningComponents.delete(name);
      this.core.state.componentStates.set(
        name,
        isStillStalled ? 'stalled' : 'stopped',
      );
      this.core.state.componentErrors.set(name, failure);
      if (this.core.state.isStarting) {
        this.core.state.unexpectedStopsDuringStartup.set(name, failure);
      }
      this.core.registry.updateStartedFlag();

      // Mirror the normal stop path: if this was the last running component, the
      // manager should release process signal handlers instead of staying attached
      // to an otherwise idle application. During a bulk startup the check defers to the
      // startup's end.
      this.core.signals.detachSignalsAfterLastStop();

      this.core.registry.stampTimestamp(name, 'stoppedAt');

      this.core.logger.entity(name).warn(
        // A placeholder, never the message concatenated in. The component's own text
        // becomes the *template* otherwise, and the path grammar admits ordinary name
        // punctuation - `-`, `@`, `$` - so a failure reported as
        // `Cannot reach {{svc-a}}` parses as a placeholder, resolves to nothing, and is
        // rendered as the `(null)` fallback. Substituted text is not re-scanned, so the
        // message survives verbatim here however it is spelled.
        failure
          ? 'Component stopped unexpectedly: {{error.message}}'
          : 'Component stopped unexpectedly',
        { params: { error: failure } },
      );

      // Model this the same as other terminal transitions: emit the abnormal-cause
      // event first, then the canonical stopped-state event that generic listeners
      // can rely on regardless of why the component stopped. A component back to
      // `stalled` is not stopped, so it gets only the cause: its stall still ends with
      // `component:stalled-resolved`, as any stall does.
      this.core.lifecycleEvents.componentUnexpectedStop(
        name,
        failure ?? undefined,
      );
      if (!isStillStalled) {
        // Guarded: this answers the component's own `reportUnexpectedStop()`, often
        // from a socket or timer callback, where a throw would go uncaught.
        this.core.lifecycleEvents.componentStopped(
          name,
          readComponentStatus(
            this.core,
            name,
            'lifecycle-manager component unexpected stop',
          ),
        );
      }
      return true;
    });
  }
}
