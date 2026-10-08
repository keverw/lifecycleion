import type { ShutdownSignal } from '../../process-signal-manager';
import {
  reportCallbackError,
  safeHandleCallbackAndWait,
} from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import { LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP } from '../constants';
import type {
  ComponentOperationResult,
  LifecycleSignalStatus,
  SignalBroadcastResult,
} from '../types';
import { runSignalBroadcast } from './component-inspection';
import type { ManagerCore } from './manager-core';
import {
  crashedSignalBroadcastResult,
  failedSignalCallbackResult,
  settleOperation,
} from './operation-policy';

/**
 * Process signal integration: attaching and detaching the `ProcessSignalManager`
 * (`attachSignals()` and `detachSignals()`'s bodies), the attach a start makes on the
 * manager's own initiative (`attachSignalsOnStart`, `attachSignalsBeforeStartup`) and
 * rolling a start back when it fails, the `detachSignalsOnStop` detach once the manager
 * is idle - deferred while anything transient is in flight - and the reload, info and
 * debug requests, from a signal or a `trigger*()` call, with their broadcasts.
 *
 * Shutdown signals are `core.shutdownEscalation`'s. The automatic attach and detach go
 * through the manager's public `attachSignals()` / `detachSignals()`, so an override of
 * either is the one that runs.
 */
export class SignalIntegration {
  constructor(private readonly core: ManagerCore) {}

  /**
   * `attachSignals()`'s body: create the `ProcessSignalManager` on first use, wired to
   * shutdown escalation and the reload/info/debug requests, and attach it. A no-op
   * when attached already; supersedes a detach still waiting to run.
   */
  public attach(): void {
    return this.core.dispatcher.withTransition(() => {
      // A new attach supersedes a detach that was still waiting to run.
      this.core.state.isSignalDetachDeferred = false;

      // Check if already attached (not just if instance exists)
      if (this.core.state.processSignalManager?.getStatus().isAttached) {
        return; // Already attached
      }

      // Create instance if it doesn't exist
      if (!this.core.state.processSignalManager) {
        this.core.state.processSignalManager =
          this.core.createProcessSignalManager({
            onShutdownRequested: (method: ShutdownSignal) => {
              this.core.shutdownEscalation.handleShutdownRequest(method);
            },
            // Note: Signal-triggered handlers are fire-and-forget by design.
            // Node.js signal handlers (process.on) cannot return values, so these
            // async handlers execute but their return values are not accessible.
            // Use triggerReload(), triggerInfo(), triggerDebug() for programmatic
            // access to results.
            // Settled like `triggerReload()` and friends, so a signal-driven broadcast
            // resolves under this manager's own label rather than relying on
            // `ProcessSignalManager` to catch its rejection.
            onReloadRequested: () =>
              settleOperation(
                'reload signal',
                () => this.handleReloadRequest('signal'),
                (error, _reason, code) =>
                  crashedSignalBroadcastResult('reload', error, code),
              ),
            onInfoRequested: () =>
              settleOperation(
                'info signal',
                () => this.handleInfoRequest('signal'),
                (error, _reason, code) =>
                  crashedSignalBroadcastResult('info', error, code),
              ),
            onDebugRequested: () =>
              settleOperation(
                'debug signal',
                () => this.handleDebugRequest('signal'),
                (error, _reason, code) =>
                  crashedSignalBroadcastResult('debug', error, code),
              ),
          });
      }

      this.core.state.processSignalManager.attach();
      this.core.lifecycleEvents.lifecycleManagerSignalsAttached();
    });
  }
  /** `detachSignals()`'s body: detach, if attached, and announce it. */
  public detach(): void {
    return this.core.dispatcher.withTransition(() => {
      if (!this.core.state.processSignalManager?.getStatus().isAttached) {
        return; // Not attached
      }

      const signalManager = this.core.state.processSignalManager;
      try {
        signalManager.detach();
      } finally {
        // detach() marks itself detached even when a listener removal throws, so
        // announce it whenever the handlers are no longer attached.
        if (!signalManager.getStatus().isAttached) {
          this.core.lifecycleEvents.lifecycleManagerSignalsDetached();
        }
      }
    });
  }
  /** `getSignalStatus()`'s answer. */
  public status(): LifecycleSignalStatus {
    if (!this.core.state.processSignalManager) {
      return {
        isAttached: false,
        handlers: {
          shutdown: false,
          reload: false,
          info: false,
          debug: false,
        },
        listeningFor: {
          shutdownSignals: false,
          reloadSignal: false,
          infoSignal: false,
          debugSignal: false,
          keypresses: false,
        },
        shutdownMethod: this.core.state.shutdownMethod,
      };
    }

    return {
      ...this.core.state.processSignalManager.getStatus(),
      shutdownMethod: this.core.state.shutdownMethod,
    };
  }

  /**
   * Attach signals on the manager's own initiative, ahead of a start.
   *
   * A failure here fails the start: on Node and Bun an attach only throws when something
   * is really wrong - a `process.on` or raw-mode stdin failure - and a process that was
   * configured to handle `SIGTERM` must not come up without doing so. Every caller takes
   * its start state first (`isStarting`, or a component's `starting`) so that a
   * `signals-attached` listener re-entering the manager finds the work already claimed,
   * and releases that state if this fails. Caught rather than thrown so each caller can
   * answer with its own result; an explicit `attachSignals()` call still throws to its
   * caller.
   *
   * @returns `attached` when this call attached them, `failed` with the error when it
   * could not, and `unchanged` when they were already attached
   */
  public autoAttachSignals(
    trigger: string,
  ):
    | { outcome: 'attached' | 'unchanged' }
    | { outcome: 'failed'; error: Error } {
    if (this.core.state.processSignalManager?.getStatus().isAttached) {
      return { outcome: 'unchanged' };
    }

    this.core.logger.info(`Auto-attaching process signals on ${trigger}`);

    try {
      this.core.manager.attachSignals();
    } catch (error) {
      const err = toError(error);

      this.core.logger.error(
        'Could not attach process signals on {{trigger}}: {{error.message}}',
        { params: { trigger, error: err } },
      );

      return { outcome: 'failed', error: err };
    }

    if (this.core.state.isStarting) {
      this.core.state.autoAttachedSignalsDuringStartup = true;
    }

    return { outcome: 'attached' };
  }

  /**
   * Stop a component that started but could not be left running because
   * `attachSignalsOnStart` failed to attach process signals, and answer its start with
   * `signal_attach_failed`. The stop is the normal graceful-then-force one; if it does not
   * complete, the reason says so and the component is left as that stop left it.
   */
  public async rollBackStartForSignalAttach(
    name: string,
    error: Error,
  ): Promise<ComponentOperationResult> {
    this.core.logger
      .entity(name)
      .warn('Stopping component: process signals could not be attached');

    // `stopComponentInternal()` answers every failure it can foresee with a result and
    // turns anything else into a stall, so the component's state is settled either way;
    // this result only has to describe it. No `status`: this runs inside the start's
    // `try`, and a throw from building one would land in the start's `catch`, which
    // would mark a component this stop may not have stopped as `registered`.
    const stopResult =
      await this.core.componentStop.stopComponentInternal(name);
    const attachReason = `Could not attach process signals: ${describeError(error)}`;

    return {
      success: false,
      componentName: name,
      reason: stopResult.success
        ? `${attachReason}; component stopped again`
        : `${attachReason}; stopping it again also failed: ${stopResult.reason ?? 'unknown reason'}`,
      code: 'signal_attach_failed',
      error,
    };
  }

  /**
   * The `detachSignalsOnStop` check every stop and unregister path runs once it has
   * settled: detach when nothing is left running. `detachSignals()` is idempotent, so a
   * path that reaches this twice for one stop is harmless.
   */
  public detachSignalsAfterLastStop(
    trigger = 'last component stop',
    logMessage: string = LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP,
  ): void {
    this.detachSignalsIfIdle(trigger, { logMessage });
  }

  /**
   * The one `detachSignalsOnStop` check: detach once the manager is idle.
   *
   * Not while anything is running or stalled. A stalled component is not counted as
   * running, but Ctrl+C is how the operator retries or forces it; the stop or
   * unregister that clears the last stall runs this again.
   *
   * Nor while anything transient is in flight - a startup or shutdown latch, a
   * component starting or stopping, a late-startup cleanup or the timed-out start it
   * waits on - since each of those can
   * still leave something running or stalled. A shutdown pass in particular still needs
   * SIGINT/SIGTERM for escalation, and decides once it ends, detaching only after a
   * clean pass. The detach is deferred rather than dropped, and whichever of those ends
   * runs it again through {@link runDeferredSignalDetach}.
   */
  public detachSignalsIfIdle(
    trigger: string,
    options: { logMessage?: string; isEndingShutdownPass?: boolean } = {},
  ): void {
    return this.core.dispatcher.withTransition(() => {
      if (
        !this.core.config.detachSignalsOnStop ||
        !this.core.state.processSignalManager?.getStatus().isAttached ||
        this.core.state.runningComponents.size > 0 ||
        this.core.state.stalledComponents.size > 0
      ) {
        return;
      }

      if (this.isSignalDetachWaitingOnTransient(options.isEndingShutdownPass)) {
        this.core.state.isSignalDetachDeferred = true;
        return;
      }

      this.core.state.isSignalDetachDeferred = false;
      // Detached before the line is logged, not after: logging runs the caller's sinks,
      // and one that starts a startup from here attached nothing - the handlers were still
      // up - so detaching after it pulled them out from under that startup. Worded in the
      // past, and only on success: a failed detach has already said so. Nor once a
      // `signals-detached` listener has attached them again - a startup it began with
      // `attachSignalsBeforeStartup` - where the line would contradict the state.
      if (this.autoDetachSignals(trigger)) {
        this.core.dispatcher.afterNotifications(() => {
          if (
            this.core.state.processSignalManager?.getStatus().isAttached !==
            true
          ) {
            this.core.logger.info(
              options.logMessage ??
                `Auto-detached process signals after ${trigger}`,
            );
          }
        });
      }
    });
  }

  /**
   * Run a detach {@link detachSignalsIfIdle} deferred, once one of the transient
   * operations that held it has ended.
   */
  public runDeferredSignalDetach(trigger: string): void {
    if (this.core.state.isSignalDetachDeferred) {
      this.detachSignalsIfIdle(trigger);
    }
  }

  public async handleReloadRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return await this.handleSignalRequest(
      {
        signal: 'reload',
        dispatchedLogLabel: 'Reload dispatched',
        emitSignal: () => this.core.lifecycleEvents.signalReload(),
        customCallback: this.core.config.onReloadRequested,
        broadcast: () => this.broadcastReload(),
      },
      source,
    );
  }

  public async handleInfoRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return await this.handleSignalRequest(
      {
        signal: 'info',
        dispatchedLogLabel: 'Info dispatched',
        emitSignal: () => this.core.lifecycleEvents.signalInfo(),
        customCallback: this.core.config.onInfoRequested,
        broadcast: () => this.broadcastInfo(),
      },
      source,
    );
  }

  public async handleDebugRequest(
    source: 'signal' | 'trigger' = 'trigger',
  ): Promise<SignalBroadcastResult> {
    return await this.handleSignalRequest(
      {
        signal: 'debug',
        dispatchedLogLabel: 'Debug dispatched',
        emitSignal: () => this.core.lifecycleEvents.signalDebug(),
        customCallback: this.core.config.onDebugRequested,
        broadcast: () => this.broadcastDebug(),
      },
      source,
    );
  }

  private isSignalDetachWaitingOnTransient(
    isEndingShutdownPass = false,
  ): boolean {
    if (
      this.core.state.isStarting ||
      (this.core.shutdownPass.isShuttingDown && !isEndingShutdownPass) ||
      this.core.state.pendingBulkStartupCleanup.size > 0 ||
      this.core.lateStartRecovery.hasAbandonedStartAwaitingCleanup()
    ) {
      return true;
    }

    for (const name of this.core.state.componentStates.keys()) {
      if (this.core.claims.isInFlight(name)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Detach signals on the manager's own initiative, once nothing is left running.
   *
   * Contained for the reason {@link autoAttachSignals} is: every caller is partway through
   * settling a stop, an unregister, or a failed start, and a detach that throws there
   * derailed the rest - a clean graceful stop was sent on to the force phase, and an
   * unregister rejected after it had already removed the component.
   * `ProcessSignalManager.detach()` marks itself detached even when it throws, so there
   * is nothing to retry.
   */
  private autoDetachSignals(trigger: string): boolean {
    try {
      this.core.manager.detachSignals();

      return true;
    } catch (error) {
      this.core.logger.error(
        'Could not detach process signals after {{trigger}}: {{error.message}}',
        { params: { trigger, error: toError(error) } },
      );
      reportCallbackError(
        `lifecycle-manager signal detach after ${trigger}`,
        error,
      );

      return false;
    }
  }

  /**
   * Shared dispatch path for reload/info/debug requests. Logs the dispatch,
   * emits the signal event, then either invokes the user-supplied callback
   * (passing the broadcast function so the user controls when/whether to
   * broadcast) or broadcasts directly when no callback is configured.
   *
   * When called from signal handlers (source='signal'), the Promise is started
   * but not awaited — Node.js signal handlers cannot return values, so results
   * are not accessible. Components are still notified and the work completes.
   * When called from manual triggers (source='trigger'), the Promise is awaited
   * and results are returned for programmatic use.
   */
  private async handleSignalRequest(
    descriptor: {
      signal: 'reload' | 'info' | 'debug';
      dispatchedLogLabel: string;
      emitSignal: () => void;
      customCallback?: (
        broadcastFn: () => Promise<SignalBroadcastResult>,
      ) => void | Promise<void>;
      broadcast: () => Promise<SignalBroadcastResult>;
    },
    source: 'signal' | 'trigger',
  ): Promise<SignalBroadcastResult> {
    this.core.logger.info(descriptor.dispatchedLogLabel, {
      params: { source },
    });
    descriptor.emitSignal();

    if (descriptor.customCallback) {
      // Guarded: the callback is the caller's, and a throw or rejection from it rejected
      // `triggerReload()` and friends. It is reported, and the result says `error`.
      // The broadcast handed to the callback is settled as well, so a callback that
      // fires it without awaiting - `void broadcast()` - can never be left holding an
      // unhandled rejection.
      const outcome = await safeHandleCallbackAndWait(
        `lifecycle-manager ${descriptor.signal} request callback`,
        descriptor.customCallback,
        (): Promise<SignalBroadcastResult> =>
          settleOperation(
            `${descriptor.signal} broadcast`,
            descriptor.broadcast,
            (error, _reason, code) =>
              crashedSignalBroadcastResult(descriptor.signal, error, code),
          ),
      );

      if (!outcome.success) {
        return failedSignalCallbackResult(descriptor.signal, outcome.error);
      }

      // Return empty result (custom callback handled it)
      return {
        signal: descriptor.signal,
        results: [],
        timedOut: false,
        code: 'ok',
      };
    }

    return await descriptor.broadcast();
  }

  /**
   * Broadcast reload signal to all running components.
   * Calls onReload() on components that implement it.
   * Continues on errors - collects all results.
   */
  private broadcastReload(): Promise<SignalBroadcastResult> {
    return runSignalBroadcast(this.core.componentAccess, {
      signal: 'reload',
      pickHandler: (component) => Reflect.get(component, 'onReload'),
      startupLog:
        'Reload during startup: only reloading already-started components',
      timeoutLog: 'Reload handler timed out',
      errorLog: 'Reload failed: {{error.message}}',
      emitStarted: (name) =>
        this.core.lifecycleEvents.componentReloadStarted(name),
      emitCompleted: (name) =>
        this.core.lifecycleEvents.componentReloadCompleted(name),
      emitFailed: (name, error) =>
        this.core.lifecycleEvents.componentReloadFailed(name, error),
    });
  }

  /**
   * Broadcast info signal to all running components.
   * Calls onInfo() on components that implement it.
   * Continues on errors - collects all results.
   */
  private broadcastInfo(): Promise<SignalBroadcastResult> {
    return runSignalBroadcast(this.core.componentAccess, {
      signal: 'info',
      pickHandler: (component) => Reflect.get(component, 'onInfo'),
      startupLog:
        'Info during startup: only notifying already-started components',
      timeoutLog: 'Info handler timed out',
      errorLog: 'Info handler failed: {{error.message}}',
      emitStarted: (name) =>
        this.core.lifecycleEvents.componentInfoStarted(name),
      emitCompleted: (name) =>
        this.core.lifecycleEvents.componentInfoCompleted(name),
      emitFailed: (name, error) =>
        this.core.lifecycleEvents.componentInfoFailed(name, error),
    });
  }

  /**
   * Broadcast debug signal to all running components.
   * Calls onDebug() on components that implement it.
   * Continues on errors - collects all results.
   */
  private broadcastDebug(): Promise<SignalBroadcastResult> {
    return runSignalBroadcast(this.core.componentAccess, {
      signal: 'debug',
      pickHandler: (component) => Reflect.get(component, 'onDebug'),
      startupLog:
        'Debug during startup: only notifying already-started components',
      timeoutLog: 'Debug handler timed out',
      errorLog: 'Debug handler failed: {{error.message}}',
      emitStarted: (name) =>
        this.core.lifecycleEvents.componentDebugStarted(name),
      emitCompleted: (name) =>
        this.core.lifecycleEvents.componentDebugCompleted(name),
      emitFailed: (name, error) =>
        this.core.lifecycleEvents.componentDebugFailed(name, error),
    });
  }
}
