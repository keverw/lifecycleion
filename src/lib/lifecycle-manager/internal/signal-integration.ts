import type { ShutdownSignal } from '../../process-signal-manager';
import {
  reportCallbackError,
  safeHandleCallbackAndWait,
} from '../../safe-handle-callback';
import { describeError, toError } from '../../to-error';
import { LIFECYCLE_MANAGER_LOG_AUTO_DETACH_LAST_COMPONENT_STOP } from '../constants';
import type { LifecycleManagerEvents } from '../events';
import type {
  ComponentOperationResult,
  LifecycleSignalStatus,
  SignalBroadcastResult,
} from '../types';
import { runSignalBroadcast } from './component-inspection';
import type { ManagerConfig } from './manager-config';
import type { ManagerCore } from './manager-core';
import {
  crashedSignalBroadcastResult,
  failedSignalCallbackResult,
  settleOperation,
} from './operation-policy';

type SignalRequestKind = SignalBroadcastResult['signal'];

/** Where a reload, info or debug request came from. */
type SignalRequestSource = 'signal' | 'trigger';

/** Everything a reload, info or debug request and its broadcast differ by. */
interface SignalRequestDescriptor {
  /** The public method a `trigger*()` call of this request settles under. */
  triggerOperation: string;
  dispatchedLogLabel: string;
  emitSignal: (events: LifecycleManagerEvents) => void;
  customCallback: (
    config: ManagerConfig,
  ) =>
    | ((
        broadcastFn: () => Promise<SignalBroadcastResult>,
      ) => void | Promise<void>)
    | undefined;
  /** The component hook the broadcast calls. */
  handlerName: 'onReload' | 'onInfo' | 'onDebug';
  startupLog: string;
  timeoutLog: string;
  errorLog: string;
  emitStarted: (events: LifecycleManagerEvents, name: string) => void;
  emitCompleted: (events: LifecycleManagerEvents, name: string) => void;
  emitFailed: (
    events: LifecycleManagerEvents,
    name: string,
    error: Error,
  ) => void;
}

const SIGNAL_REQUESTS: Readonly<
  Record<SignalRequestKind, SignalRequestDescriptor>
> = {
  reload: {
    triggerOperation: 'triggerReload',
    dispatchedLogLabel: 'Reload dispatched',
    emitSignal: (events) => events.signalReload(),
    customCallback: (config) => config.onReloadRequested,
    handlerName: 'onReload',
    startupLog:
      'Reload during startup: only reloading already-started components',
    timeoutLog: 'Reload handler timed out',
    errorLog: 'Reload failed: {{error.message}}',
    emitStarted: (events, name) => events.componentReloadStarted(name),
    emitCompleted: (events, name) => events.componentReloadCompleted(name),
    emitFailed: (events, name, error) =>
      events.componentReloadFailed(name, error),
  },
  info: {
    triggerOperation: 'triggerInfo',
    dispatchedLogLabel: 'Info dispatched',
    emitSignal: (events) => events.signalInfo(),
    customCallback: (config) => config.onInfoRequested,
    handlerName: 'onInfo',
    startupLog:
      'Info during startup: only notifying already-started components',
    timeoutLog: 'Info handler timed out',
    errorLog: 'Info handler failed: {{error.message}}',
    emitStarted: (events, name) => events.componentInfoStarted(name),
    emitCompleted: (events, name) => events.componentInfoCompleted(name),
    emitFailed: (events, name, error) =>
      events.componentInfoFailed(name, error),
  },
  debug: {
    triggerOperation: 'triggerDebug',
    dispatchedLogLabel: 'Debug dispatched',
    emitSignal: (events) => events.signalDebug(),
    customCallback: (config) => config.onDebugRequested,
    handlerName: 'onDebug',
    startupLog:
      'Debug during startup: only notifying already-started components',
    timeoutLog: 'Debug handler timed out',
    errorLog: 'Debug handler failed: {{error.message}}',
    emitStarted: (events, name) => events.componentDebugStarted(name),
    emitCompleted: (events, name) => events.componentDebugCompleted(name),
    emitFailed: (events, name, error) =>
      events.componentDebugFailed(name, error),
  },
};

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
  /**
   * Set when a `detachSignalsOnStop` detach was due - nothing left running or stalled -
   * but something transient was still in flight: a startup or shutdown latch, a start or
   * stop, a late-startup cleanup. Whichever of those ends runs the check again.
   */
  private isSignalDetachDeferred = false;
  /**
   * The line the detach deferred in `isSignalDetachDeferred` logs once it runs: worded
   * for what asked for it - the last component stop, say - not for the transient that
   * held it. Set and cleared with that flag.
   */
  private deferredDetachLogMessage: string | undefined;

  constructor(private readonly core: ManagerCore) {}

  /**
   * `attachSignals()`'s body: create the `ProcessSignalManager` on first use, wired to
   * shutdown escalation and the reload/info/debug requests, and attach it. A no-op
   * when attached already; supersedes a detach still waiting to run.
   */
  public attach(): void {
    this.core.dispatcher.withTransition(() => {
      // A new attach supersedes a detach that was still waiting to run.
      this.isSignalDetachDeferred = false;
      this.deferredDetachLogMessage = undefined;

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
              this.settleSignalRequest('reload', 'signal'),
            onInfoRequested: () => this.settleSignalRequest('info', 'signal'),
            onDebugRequested: () => this.settleSignalRequest('debug', 'signal'),
          });
      }

      this.core.state.processSignalManager.attach();
      this.core.lifecycleEvents.lifecycleManagerSignalsAttached();
    });
  }
  /** `detachSignals()`'s body: detach, if attached, and announce it. */
  public detach(): void {
    this.core.dispatcher.withTransition(() => {
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
   * SIGINT/SIGTERM for escalation, and decides once it ends, running a detach it
   * deferred only after a clean pass. The detach is deferred rather than dropped, with
   * the line it logs, and whichever of those ends runs it again through
   * {@link runDeferredSignalDetach}.
   */
  public detachSignalsIfIdle(
    trigger: string,
    options: { logMessage?: string; isEndingShutdownPass?: boolean } = {},
  ): void {
    this.core.dispatcher.withTransition(() => {
      if (
        !this.core.config.detachSignalsOnStop ||
        !this.core.state.processSignalManager?.getStatus().isAttached ||
        this.core.state.runningComponents.size > 0 ||
        this.core.state.stalledComponents.size > 0
      ) {
        return;
      }

      const logMessage =
        options.logMessage ?? `Auto-detached process signals after ${trigger}`;

      if (this.isSignalDetachWaitingOnTransient(options.isEndingShutdownPass)) {
        this.isSignalDetachDeferred = true;
        this.deferredDetachLogMessage = logMessage;
        return;
      }

      this.isSignalDetachDeferred = false;
      this.deferredDetachLogMessage = undefined;
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
            this.core.logger.info(logMessage);
          }
        });
      }
    });
  }

  /**
   * Run a detach {@link detachSignalsIfIdle} deferred, once one of the transient
   * operations that held it has ended, logging the line it was deferred with. Nothing
   * when none is deferred: nothing asked for one, or an attach since superseded it.
   *
   * `isEndingShutdownPass` is for a clean shutdown pass, which runs this before it
   * releases its own latch.
   */
  public runDeferredSignalDetach(
    trigger: string,
    options: { isEndingShutdownPass?: boolean } = {},
  ): void {
    if (this.isSignalDetachDeferred) {
      this.detachSignalsIfIdle(trigger, {
        logMessage: this.deferredDetachLogMessage,
        isEndingShutdownPass: options.isEndingShutdownPass,
      });
    }
  }

  /**
   * A reload, info or debug request under the public-method safety net: `trigger*()`'s
   * body for a `trigger` source, settled under that method's name, and the
   * `ProcessSignalManager` callback's for a `signal` source, settled as `<signal> signal`.
   */
  public settleSignalRequest(
    signal: SignalRequestKind,
    source: SignalRequestSource,
  ): Promise<SignalBroadcastResult> {
    return settleOperation(
      source === 'signal'
        ? `${signal} signal`
        : SIGNAL_REQUESTS[signal].triggerOperation,
      () => this.handleSignalRequest(signal, source),
      (error, _reason, code) =>
        crashedSignalBroadcastResult(signal, error, code),
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
   * settling a stop, an unregister, or a failed start, and must finish it whatever the
   * detach does - a clean graceful stop stays clean rather than going on to the force
   * phase, and an unregister that has removed the component resolves. A failure is
   * logged and reported instead. `ProcessSignalManager.detach()` marks itself detached
   * even when it throws, so there is nothing to retry.
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
    signal: SignalRequestKind,
    source: SignalRequestSource,
  ): Promise<SignalBroadcastResult> {
    const descriptor = SIGNAL_REQUESTS[signal];
    this.core.logger.info(descriptor.dispatchedLogLabel, {
      params: { source },
    });
    descriptor.emitSignal(this.core.lifecycleEvents);

    const customCallback = descriptor.customCallback(this.core.config);
    if (customCallback) {
      // Guarded: the callback is the caller's, so a throw or rejection from it is
      // reported, and the result says `error`.
      // The broadcast handed to the callback is settled as well, so a callback that
      // fires it without awaiting - `void broadcast()` - can never be left holding an
      // unhandled rejection.
      const outcome = await safeHandleCallbackAndWait(
        `lifecycle-manager ${signal} request callback`,
        customCallback,
        (): Promise<SignalBroadcastResult> =>
          settleOperation(
            `${signal} broadcast`,
            () => this.broadcastSignal(signal),
            (error, _reason, code) =>
              crashedSignalBroadcastResult(signal, error, code),
          ),
      );

      if (!outcome.success) {
        return failedSignalCallbackResult(signal, outcome.error);
      }

      // Return empty result (custom callback handled it)
      return {
        signal,
        results: [],
        timedOut: false,
        code: 'ok',
      };
    }

    return await this.broadcastSignal(signal);
  }

  /**
   * Broadcast a reload, info or debug signal to all running components.
   * Calls the component's `onReload()`, `onInfo()` or `onDebug()` where it implements it.
   * Continues on errors - collects all results.
   */
  private broadcastSignal(
    signal: SignalRequestKind,
  ): Promise<SignalBroadcastResult> {
    const descriptor = SIGNAL_REQUESTS[signal];
    const events = this.core.lifecycleEvents;

    return runSignalBroadcast(this.core.componentAccess, {
      signal,
      pickHandler: (component) =>
        Reflect.get(component, descriptor.handlerName),
      startupLog: descriptor.startupLog,
      timeoutLog: descriptor.timeoutLog,
      errorLog: descriptor.errorLog,
      emitStarted: (name) => descriptor.emitStarted(events, name),
      emitCompleted: (name) => descriptor.emitCompleted(events, name),
      emitFailed: (name, error) => descriptor.emitFailed(events, name, error),
    });
  }
}
