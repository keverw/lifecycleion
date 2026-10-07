import {
  reportCallbackError,
  safeHandleCallback,
} from './safe-handle-callback';
import { ulid } from 'ulid';
import readline from 'readline';
import { resolveTimeoutMS } from './internal/timer-limits';
import { queueMicrotaskIntrinsic } from './internal/intrinsics';
import { isObjectLike } from './internal/is-object-like';
import { reportToConsole } from './internal/report-to-console';
import { describeError } from './to-error';

/**
 * The shutdown signal types that can trigger the shutdown callback
 */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGTRAP';

/**
 * Shared state stored on globalThis to survive module duplication from bundlers.
 * Uses Symbol.for() to ensure the same symbol across all copies of this module.
 */
interface ProcessSignalManagerSharedState {
  /**
   * Whether emitKeypressEvents was called on process.stdin.
   * Since process.stdin is a global singleton, this prevents multiple calls.
   */
  keypressEventsEmittedOnStdin: boolean;

  /**
   * Set of instance IDs that have successfully attached.
   * Used to coordinate shared resources (raw mode, stdin pause/resume).
   */
  attachedInstances: Set<string>;

  /** Instances using shared SIGINT forwarding; absent in older package copies. */
  sigintForwardingInstances?: Set<string>;

  /** Recipients remaining in a keypress dispatch, even if its leader detaches. */
  ctrlCDispatches?: WeakMap<
    object,
    { leader: string | undefined; remaining: Set<string> }
  >;

  /**
   * The instance ID that enabled raw mode, or null if raw mode wasn't enabled by us.
   * Only this instance (or the last remaining instance) should disable raw mode.
   */
  rawModeOwner: string | null;

  /**
   * Whether raw mode was enabled by ProcessSignalManager.
   *
   * This is necessary because an instance may fail to disable raw mode during detach,
   * leaving stdin in raw mode while the recorded owner is stale. When a new instance
   * later attaches and finds raw mode already enabled, it can safely adopt ownership
   * *only if* this flag indicates we were responsible for enabling raw mode.
   *
   * If raw mode was enabled by external code, this stays false and we will not disable it.
   */
  rawModeEnabledByManager: boolean;
}

// Use Symbol.for() for a global symbol registry - survives module duplication
const SHARED_STATE_KEY = Symbol.for('lifecycleion.ProcessSignalManager.v1');

/**
 * Get or initialize the shared state on globalThis.
 * This ensures all copies of this module (from bundler duplication) share the same state.
 */
function getSharedState(): ProcessSignalManagerSharedState {
  const g = globalThis as Record<
    symbol,
    ProcessSignalManagerSharedState | undefined
  >;
  if (!g[SHARED_STATE_KEY]) {
    g[SHARED_STATE_KEY] = {
      keypressEventsEmittedOnStdin: false,
      attachedInstances: new Set(),
      rawModeOwner: null,
      rawModeEnabledByManager: false,
    };
  }
  const shared = g[SHARED_STATE_KEY];
  shared.sigintForwardingInstances ??= new Set();
  shared.ctrlCDispatches ??= new WeakMap();
  return shared;
}

/**
 * Transfer raw mode ownership to another attached instance, or clear it if none remain.
 * This is a centralized helper to ensure ownership is always valid.
 *
 * @param shared - The shared state object
 * @param currentOwner - The instance ID giving up ownership (only transfers if this matches current owner)
 * @returns The new owner ID, or null if ownership was cleared
 */
function transferRawModeOwnership(
  shared: ProcessSignalManagerSharedState,
  currentOwner: string,
): string | null {
  // Only transfer if we're actually the current owner
  if (shared.rawModeOwner !== currentOwner) {
    return shared.rawModeOwner;
  }

  return assignRawModeOwnerFromAttached(shared);
}

/**
 * Hand raw mode ownership to the first attached instance, or clear it when none remain.
 *
 * @returns The new owner ID, or null if ownership was cleared
 */
function assignRawModeOwnerFromAttached(
  shared: ProcessSignalManagerSharedState,
): string | null {
  const next = shared.attachedInstances.values().next();
  const newOwner = next.done === true ? null : next.value;
  shared.rawModeOwner = newOwner;
  return newOwner;
}

/**
 * Defensive: if manager-held raw mode ownership points to an instance that is no longer
 * attached while others remain, re-anchor it on an attached one so a later detach can
 * still restore the terminal.
 */
function reanchorDetachedRawModeOwner(
  shared: ProcessSignalManagerSharedState,
): void {
  if (
    shared.rawModeEnabledByManager &&
    shared.rawModeOwner !== null &&
    shared.attachedInstances.size > 0 &&
    !shared.attachedInstances.has(shared.rawModeOwner)
  ) {
    assignRawModeOwnerFromAttached(shared);
  }
}

/**
 * A `*CallbackName` option: its default when null or undefined, and a `TypeError` when
 * it is not a string, so a name every report is built from fails at construction rather
 * than on each signal or keypress.
 */
function resolveCallbackName(
  requested: unknown,
  defaultName: string,
  label: string,
): string {
  if (requested === null || requested === undefined) {
    return defaultName;
  }
  if (typeof requested !== 'string') {
    throw new TypeError(`${label} must be a string, got: ${typeof requested}`);
  }
  return requested;
}

/**
 * Status information about what the manager is attached to
 */
export interface ProcessSignalManagerStatus {
  /**
   * Whether the manager is currently attached to signals and keypresses
   */
  isAttached: boolean;

  /**
   * Which handlers are registered
   */
  handlers: {
    /**
     * Whether a shutdown handler is registered
     */
    shutdown: boolean;

    /**
     * Whether a reload handler is registered
     */
    reload: boolean;

    /**
     * Whether an info handler is registered
     */
    info: boolean;

    /**
     * Whether a debug handler is registered
     */
    debug: boolean;
  };

  /**
   * What events are currently being listened for (only populated when isListening is true)
   */
  listeningFor: {
    /**
     * Listening for shutdown signals (SIGINT, SIGTERM, SIGTRAP)
     */
    shutdownSignals: boolean;

    /**
     * Listening for reload signal (SIGHUP)
     */
    reloadSignal: boolean;

    /**
     * Listening for info signal (SIGUSR1)
     */
    infoSignal: boolean;

    /**
     * Listening for debug signal (SIGUSR2)
     */
    debugSignal: boolean;

    /**
     * Listening for keypresses (Ctrl+C, Escape, R, I, D)
     */
    keypresses: boolean;
  };
}

/**
 * Configuration options for ProcessSignalManager
 */
export interface ProcessSignalManagerOptions {
  /**
   * Optional callback invoked when a shutdown signal is received.
   *
   * Triggered by:
   * - Process signals: SIGINT, SIGTERM, SIGTRAP
   * - Keyboard: Ctrl+C, Escape
   */
  onShutdownRequested?: (method: ShutdownSignal) => void | Promise<void>;

  /**
   * Optional callback invoked when reload is requested.
   *
   * Triggered by:
   * - Process signal: SIGHUP
   * - Keyboard: R key press (case-insensitive)
   */
  onReloadRequested?: () => void | Promise<unknown>;

  /**
   * Optional callback invoked when info/stats are requested.
   *
   * Triggered by:
   * - Process signal: SIGUSR1
   * - Keyboard: I key press (case-insensitive)
   *
   * Common uses: Print stats, health check, show metrics
   */
  onInfoRequested?: () => void | Promise<unknown>;

  /**
   * Optional callback invoked when debug mode is toggled or verbose info is requested.
   *
   * Triggered by:
   * - Process signal: SIGUSR2
   * - Keyboard: D key press (case-insensitive)
   *
   * Common uses: Toggle debug mode, dump full state, enable verbose logging
   */
  onDebugRequested?: () => void | Promise<unknown>;

  /**
   * Custom name for the shutdown callback used in error reporting.
   * @default 'onShutdownRequested'
   */
  shutdownCallbackName?: string;

  /**
   * Custom name for the reload callback used in error reporting.
   * @default 'onReloadRequested'
   */
  reloadCallbackName?: string;

  /**
   * Custom name for the info callback used in error reporting.
   * @default 'onInfoRequested'
   */
  infoCallbackName?: string;

  /**
   * Custom name for the debug callback used in error reporting.
   * @default 'onDebugRequested'
   */
  debugCallbackName?: string;

  /**
   * Throttle interval in milliseconds for keyboard events (leading-edge rate limiting).
   * Allows an action to trigger at most once per interval. First press fires immediately,
   * subsequent presses within the window are ignored.
   * This prevents accidental double-triggers while allowing predictable repeated actions.
   *
   * Note: This only affects keyboard events, not process signals.
   * Process signals are never throttled as they may come from external sources
   * that expect immediate handling.
   *
   * Null or undefined uses the default. Zero disables throttling. Infinity and
   * values above 2,147,483,647ms use that cap (about 24.8 days between triggers
   * of the same keyboard action); Infinity does not select the default.
   * An explicit `NaN` or non-number value throws a `TypeError`, and a negative one a
   * `RangeError`, from the constructor.
   * @default 200 (200ms throttle, allowing 5 triggers per second maximum)
   * @example 300 // Custom 300ms throttle (3.33 triggers per second max)
   * @example 0 // Disable throttling entirely
   */
  keypressThrottleMS?: number | null;
}

/**
 * Manages process signals and keyboard events for graceful shutdown, reload, and info/debug functionality.
 *
 * Handles:
 * - Shutdown signals: SIGINT, SIGTERM, SIGTRAP
 * - Reload signal: SIGHUP
 * - Info signal: SIGUSR1
 * - Debug signal: SIGUSR2
 * - Keyboard shortcuts: Ctrl+C, Escape (shutdown), R (reload), I (info), D (debug)
 *   All letter keys are case-insensitive
 *
 * All callbacks are executed safely with automatic error handling.
 */
export class ProcessSignalManager {
  // Unique identifier for this instance, used for tracking in shared state
  private readonly instanceID: string;

  private onShutdownRequested?: (
    method: ShutdownSignal,
  ) => void | Promise<void>;
  private onReloadRequested?: () => void | Promise<unknown>;
  private onInfoRequested?: () => void | Promise<unknown>;
  private onDebugRequested?: () => void | Promise<unknown>;

  private shutdownCallbackName: string;
  private reloadCallbackName: string;
  private infoCallbackName: string;
  private debugCallbackName: string;

  private shutdownSignalListeners?: {
    [key in ShutdownSignal]: () => void;
  };
  private reloadSignalListener?: () => void;
  private infoSignalListener?: () => void;
  private debugSignalListener?: () => void;
  private keypressHandler?: (str: string, key: unknown) => void;
  private _isAttached = false;
  private didResumeStdin = false;

  /**
   * A raw-mode failure from the keypress setup's own rollback, held rather than reported:
   * that rollback always throws into `attach()`'s catch, whose `restoreStdin` retries
   * the same restore when this instance still owns it. The retry's outcome supersedes
   * this one, so one broken restore is reported once, not once per attempt.
   */
  private pendingRawModeFailure?: RawModeFailure;

  // Throttle state for keyboard events (default 200ms, 0 disables)
  // Track throttle separately per action type so different keys don't interfere with each other
  // Use -Infinity to ensure first press is never throttled (always fires immediately)
  private keypressThrottleMS: number;
  private lastActionTimes = {
    shutdown: -Infinity,
    reload: -Infinity,
    info: -Infinity,
    debug: -Infinity,
  };

  constructor(options: ProcessSignalManagerOptions) {
    // Generate unique ID for this instance to track it in the activeInstances Set
    this.instanceID = ulid();

    this.onShutdownRequested = options.onShutdownRequested;
    this.onReloadRequested = options.onReloadRequested;
    this.onInfoRequested = options.onInfoRequested;
    this.onDebugRequested = options.onDebugRequested;
    this.shutdownCallbackName = resolveCallbackName(
      options.shutdownCallbackName,
      'onShutdownRequested',
      'shutdownCallbackName',
    );
    this.reloadCallbackName = resolveCallbackName(
      options.reloadCallbackName,
      'onReloadRequested',
      'reloadCallbackName',
    );
    this.infoCallbackName = resolveCallbackName(
      options.infoCallbackName,
      'onInfoRequested',
      'infoCallbackName',
    );
    this.debugCallbackName = resolveCallbackName(
      options.debugCallbackName,
      'onDebugRequested',
      'debugCallbackName',
    );
    // Default to 200ms throttle (leading-edge rate limiting), 0 disables
    this.keypressThrottleMS = resolveTimeoutMS(
      options.keypressThrottleMS,
      200,
      'keypressThrottleMS',
    );

    // Initialize shutdown signal handlers if callback is provided (not yet registered with process)
    // These will be registered when listen() is called
    if (this.onShutdownRequested) {
      const shutdownCallback = this.onShutdownRequested;
      this.shutdownSignalListeners = {
        SIGINT: (): void =>
          safeHandleCallback(
            this.shutdownCallbackName,
            shutdownCallback,
            'SIGINT',
          ),
        SIGTERM: (): void =>
          safeHandleCallback(
            this.shutdownCallbackName,
            shutdownCallback,
            'SIGTERM',
          ),
        SIGTRAP: (): void =>
          safeHandleCallback(
            this.shutdownCallbackName,
            shutdownCallback,
            'SIGTRAP',
          ),
      };
    }

    // Initialize reload signal handler if callback is provided (not yet registered with process)
    // This will be registered when listen() is called
    if (this.onReloadRequested) {
      const reloadCallback = this.onReloadRequested;
      this.reloadSignalListener = (): void =>
        safeHandleCallback(this.reloadCallbackName, reloadCallback);
    }

    // Initialize info signal handler (SIGUSR1) if callback is provided (not yet registered with process)
    // This will be registered when listen() is called
    if (this.onInfoRequested) {
      const infoCallback = this.onInfoRequested;
      this.infoSignalListener = (): void =>
        safeHandleCallback(this.infoCallbackName, infoCallback);
    }

    // Initialize debug signal handler (SIGUSR2) if callback is provided (not yet registered with process)
    // This will be registered when listen() is called
    if (this.onDebugRequested) {
      const debugCallback = this.onDebugRequested;
      this.debugSignalListener = (): void =>
        safeHandleCallback(this.debugCallbackName, debugCallback);
    }
  }

  /**
   * Check if the manager is currently attached to signals and keypresses.
   */
  public get isAttached(): boolean {
    return this._isAttached;
  }

  /**
   * Get detailed status information about what the manager is attached to.
   *
   * @returns Status object with handler registration and attachment state
   */
  public getStatus(): ProcessSignalManagerStatus {
    return {
      isAttached: this._isAttached,
      handlers: {
        shutdown: !!this.onShutdownRequested,
        reload: !!this.onReloadRequested,
        info: !!this.onInfoRequested,
        debug: !!this.onDebugRequested,
      },
      listeningFor: {
        shutdownSignals: this._isAttached && !!this.shutdownSignalListeners,
        reloadSignal: this._isAttached && !!this.reloadSignalListener,
        infoSignal: this._isAttached && !!this.infoSignalListener,
        debugSignal: this._isAttached && !!this.debugSignalListener,
        // Keypresses are only available if stdin is a TTY
        keypresses:
          this._isAttached && !!process.stdin.isTTY && !!this.keypressHandler,
      },
    };
  }

  /**
   * Attach signal handlers and start listening for process signals and keyboard events.
   * Idempotent - calling multiple times has no effect.
   */
  public attach(): void {
    if (this._isAttached) {
      return;
    }

    try {
      this.listenForShutdownSignals();
      this.listenForReloadSignal();
      this.listenForInfoSignal();
      this.listenForDebugSignal();
      this.listenForKeyPresses();
      this._isAttached = true;
    } catch (error) {
      // If any listener registration fails, clean up any handlers that were already registered
      // This prevents partial registration and ensures consistent state. A cleanup failure
      // must not replace the registration error that got us here, but a listener it left
      // on `process` must not go unreported either. Reported in order, after this
      // failed attach has reached its caller: a listener that attaches from a report
      // must not have this attach's error thrown over its own successful attach.
      const {
        failures: [firstFailure, ...laterFailures],
        rawModeRestoreFailure,
      } = this.releaseListeners();
      this.reportCleanupFailuresLater([
        ...(firstFailure
          ? [['ProcessSignalManager attach cleanup', firstFailure] as const]
          : []),
        ...laterFailures.map(
          (failure) =>
            ['ProcessSignalManager listener cleanup', failure] as const,
        ),
      ]);
      // Except a raw-mode restore failure - the terminal left in raw mode - which is
      // reported now, before the throw, as `detach()` reports it when it returns. A
      // caller that exits from its catch - `try { attach() } catch { process.exit(1) }`
      // - never drains the microtask, and a leaked listener dies with the process where
      // a raw terminal outlives it, so this is the one report that cannot wait. The
      // cost: a listener that attaches from this report still has this attach's error
      // thrown after it, though `isAttached` then reads `true`.
      reportCleanupFailures(rawModeRestoreReport(rawModeRestoreFailure));
      throw error;
    }
  }

  /**
   * Detach signal handlers and stop listening for process signals and keyboard events.
   * Cleans up all event listeners and restores stdin to normal mode.
   *
   * Idempotent - calling multiple times has no effect.
   */
  public detach(): void {
    if (!this._isAttached) {
      return;
    }

    const {
      failures: [firstFailure, ...laterFailures],
      rawModeRestoreFailure,
    } = this.releaseListeners();

    // Always mark as detached, even if cleanup threw an error
    // This prevents the manager from being stuck in an "attached" state
    // that blocks re-attachment attempts
    this._isAttached = false;

    const listenerReports = laterFailures.map(
      (failure) => ['ProcessSignalManager listener cleanup', failure] as const,
    );
    const reports = [
      ...listenerReports,
      ...rawModeRestoreReport(rawModeRestoreFailure),
    ];

    if (firstFailure) {
      // Listener failures are reported after the first failure reaches the caller, so
      // they follow it in order and a listener that attaches from a report does so after
      // the caller has seen this detach finish - not before a throw that would read as
      // this detach failing over an instance that listener just attached. A process that
      // exits straight after the throw loses these, but the error it was thrown has
      // already reached it, and a leaked listener dies with the process.
      //
      // Except a raw-mode restore failure, reported now, before the throw, exactly as a
      // failed `attach()` reports it: a caller that exits from its catch -
      // `try { detach() } catch { process.exit(1) }` - never drains the microtask, and a
      // terminal left in raw mode outlives the process.
      reportCleanupFailures(rawModeRestoreReport(rawModeRestoreFailure));
      this.reportCleanupFailuresLater(listenerReports);
      throw firstFailure.error;
    }

    // Nothing to throw, so nothing to wait for: reported now, as the last thing this
    // detach does. Deferred, a raw-mode restore failure - the terminal left in raw mode -
    // was lost to a caller that exits right after `detach()` returns, as a
    // shutdown-completed listener may: `process.exit()` does not drain microtasks.
    // Synchronous is safe here because every step is done - listeners removed, stdin
    // paused, `isAttached` false - so a listener that attaches from the report attaches
    // over a finished detach, and nothing after it undoes that attach.
    reportCleanupFailures(reports);
  }

  /**
   * Manually trigger a shutdown event
   * if the manager is attached and a shutdown handler is registered
   *
   * @param method - The shutdown method (SIGINT, SIGTERM, or SIGTRAP) that will be passed to the shutdown callback
   * @param shouldBypassAttachCheck - If true, triggers the callback even when not attached (useful for testing)
   */
  public triggerShutdown(
    method: ShutdownSignal,
    shouldBypassAttachCheck = false,
  ): void {
    if (
      (this._isAttached || shouldBypassAttachCheck) &&
      this.onShutdownRequested
    ) {
      safeHandleCallback(
        this.shutdownCallbackName,
        this.onShutdownRequested,
        method,
      );
    }
  }

  /**
   * Manually trigger a reload event
   * if the manager is attached and a reload handler is registered
   *
   * @param shouldBypassAttachCheck - If true, triggers the callback even when not attached (useful for testing)
   */
  public triggerReload(shouldBypassAttachCheck = false): void {
    if (
      (this._isAttached || shouldBypassAttachCheck) &&
      this.onReloadRequested
    ) {
      safeHandleCallback(this.reloadCallbackName, this.onReloadRequested);
    }
  }

  /**
   * Manually trigger an info event
   * if the manager is attached and an info handler is registered
   *
   * @param shouldBypassAttachCheck - If true, triggers the callback even when not attached (useful for testing)
   */
  public triggerInfo(shouldBypassAttachCheck = false): void {
    if ((this._isAttached || shouldBypassAttachCheck) && this.onInfoRequested) {
      safeHandleCallback(this.infoCallbackName, this.onInfoRequested);
    }
  }

  /**
   * Manually trigger a debug event
   * if the manager is attached and a debug handler is registered
   *
   * @param shouldBypassAttachCheck - If true, triggers the callback even when not attached (useful for testing)
   */
  public triggerDebug(shouldBypassAttachCheck = false): void {
    if (
      (this._isAttached || shouldBypassAttachCheck) &&
      this.onDebugRequested
    ) {
      safeHandleCallback(this.debugCallbackName, this.onDebugRequested);
    }
  }

  /**
   * Check if an action should be throttled based on the last time it was successfully triggered.
   * Uses leading-edge throttle: first press fires immediately, subsequent presses within the
   * throttle window are ignored. Only updates timestamp when action is allowed (not throttled).
   *
   * This is the standard pattern for keyboard shortcuts and prevents accidental double-triggers
   * while allowing predictable repeated actions at a maximum rate.
   *
   * @param action - The action type to check throttling for
   * @returns true if the action should be throttled (ignored), false otherwise
   */
  private shouldThrottle(action: keyof typeof this.lastActionTimes): boolean {
    if (this.keypressThrottleMS <= 0) {
      return false; // Throttling disabled
    }

    const now = Date.now();
    const timeSinceLastTrigger = now - this.lastActionTimes[action];

    if (timeSinceLastTrigger < this.keypressThrottleMS) {
      return true; // Throttled - too soon after last successful trigger
    }

    // Only update timestamp when allowing the action (leading-edge throttle)
    // This allows predictable rate limiting: action can fire at most once per interval
    this.lastActionTimes[action] = now;
    return false;
  }

  /**
   * Register handlers for all shutdown signals (SIGINT, SIGTERM, SIGTRAP) if callback is provided.
   * Each signal will trigger the shutdown callback with the appropriate method.
   */
  private listenForShutdownSignals(): void {
    if (this.shutdownSignalListeners) {
      for (const signal of Object.keys(
        this.shutdownSignalListeners,
      ) as ShutdownSignal[]) {
        process.on(signal, this.shutdownSignalListeners[signal]);
      }
    }
  }

  /**
   * Register handler for SIGHUP signal if reload callback is provided.
   * SIGHUP is commonly used to trigger configuration reloads.
   */
  private listenForReloadSignal(): void {
    if (this.reloadSignalListener) {
      process.on('SIGHUP', this.reloadSignalListener);
    }
  }

  /**
   * Remove handler for SIGHUP signal.
   * Uses the same function reference to ensure proper cleanup.
   */
  private stopListeningForReloadSignal(): void {
    if (this.reloadSignalListener) {
      process.off('SIGHUP', this.reloadSignalListener);
    }
  }

  /**
   * Register handler for SIGUSR1 signal if info callback is provided.
   * SIGUSR1 is commonly used for printing stats, health checks, etc.
   */
  private listenForInfoSignal(): void {
    if (this.infoSignalListener) {
      process.on('SIGUSR1', this.infoSignalListener);
    }
  }

  /**
   * Remove handler for SIGUSR1 signal.
   * Uses the same function reference to ensure proper cleanup.
   */
  private stopListeningForInfoSignal(): void {
    if (this.infoSignalListener) {
      process.off('SIGUSR1', this.infoSignalListener);
    }
  }

  /**
   * Register handler for SIGUSR2 signal if debug callback is provided.
   * SIGUSR2 is commonly used for toggling debug mode, dumping state, etc.
   */
  private listenForDebugSignal(): void {
    if (this.debugSignalListener) {
      process.on('SIGUSR2', this.debugSignalListener);
    }
  }

  /**
   * Remove handler for SIGUSR2 signal.
   * Uses the same function reference to ensure proper cleanup.
   */
  private stopListeningForDebugSignal(): void {
    if (this.debugSignalListener) {
      process.off('SIGUSR2', this.debugSignalListener);
    }
  }

  /**
   * Run every removal step even when an earlier one throws, so one failed removal
   * cannot leave the remaining handlers - or raw-mode stdin - in place behind a
   * detached status. Returns every failure in order, reporting none: the caller
   * surfaces the first and reports the rest once its own state is final. A raw-mode
   * restore failure comes back separately: it is reported, never thrown, as `detach()`
   * has always returned normally over it. `detach()` reports it after the rest, as its
   * last step; a failed `attach()` reports it before its throw, ahead of the rest.
   */
  private releaseListeners(): {
    failures: Array<{ error: unknown }>;
    rawModeRestoreFailure: RawModeFailure | undefined;
  } {
    const failures: Array<{ error: unknown }> = [];
    let rawModeRestoreFailure: RawModeFailure | undefined;
    const attempt = (step: () => void): void => {
      try {
        step();
      } catch (error) {
        failures.push({ error });
      }
    };

    const shutdownListeners = this.shutdownSignalListeners;
    if (shutdownListeners) {
      for (const signal of Object.keys(shutdownListeners) as ShutdownSignal[]) {
        attempt(() => process.off(signal, shutdownListeners[signal]));
      }
    }

    attempt(() => this.stopListeningForReloadSignal());
    attempt(() => this.stopListeningForInfoSignal());
    attempt(() => this.stopListeningForDebugSignal());
    attempt(() => {
      rawModeRestoreFailure = this.restoreStdin();
    });

    return { failures, rawModeRestoreFailure };
  }

  /**
   * Report cleanup failures in order, in a microtask: after the throw that ends the
   * current `attach()` / `detach()` has reached its caller.
   */
  private reportCleanupFailuresLater(
    reports: ReadonlyArray<readonly [string, { error: unknown }]>,
  ): void {
    if (reports.length === 0) {
      return;
    }

    queueMicrotaskIntrinsic(
      () => {
        reportCleanupFailures(reports);
      },
      // Reporting itself failed. The console is the only rung left, and without it the
      // cleanup failures - listeners possibly left on `process` - would vanish silently.
      (error: unknown) => {
        reportToConsole(
          `ProcessSignalManager could not report its cleanup failures: ${describeError(error)}`,
        );
      },
    );
  }

  /**
   * Enable keyboard event listening if stdin is a TTY.
   * Sets stdin to raw mode and listens for Ctrl+C, Escape, R, I, and D keypresses.
   *
   * Note: Letter keys are case-insensitive (R/r, I/i, D/d all work).
   *
   * Uses add-then-check pattern to prevent race conditions:
   * 1. Add ourselves to attachedInstances first
   * 2. Check if we're the first (size === 1) to enable raw mode
   * This ensures no gap where another instance could read stale state.
   */
  private listenForKeyPresses(): void {
    if (!process.stdin.isTTY || this.keypressHandler) {
      return;
    }

    const shared = getSharedState();

    // Only call emitKeypressEvents once per stream to avoid duplicate events
    // Node.js warns against calling this multiple times on the same stream
    // Set only once the call has succeeded: one that throws fails this attach, which
    // rolls back, and a flag already set would make every later attach skip the call
    // and listen for keypresses that are never emitted.
    if (!shared.keypressEventsEmittedOnStdin) {
      readline.emitKeypressEvents(process.stdin);
      shared.keypressEventsEmittedOnStdin = true;
    }

    // Create the keypress handler. Letter keys and Escape invoke callbacks directly;
    // Ctrl+C is forwarded once as SIGINT because raw mode suppresses the terminal's
    // normal signal generation.
    this.keypressHandler = (str, key): void => {
      // `readline` always passes a plain object, but anything can emit `'keypress'` on
      // stdin, and a throw here goes back to whoever emitted it. A key that is not an
      // object, or whose fields cannot be read, is not a key this handles.
      if (!isObjectLike(key)) {
        return;
      }
      const keyObj = key as Record<string, unknown>;
      let keyName: unknown;
      let isCtrl: unknown;
      try {
        keyName = keyObj.name;
        isCtrl = keyObj.ctrl;
      } catch {
        return;
      }
      // Note: key.name is always lowercase for letter keys, regardless of shift state
      // So checking for 'r' catches both 'r' and 'R' (making it case-insensitive)

      // Raw mode suppresses the terminal driver's normal Ctrl+C -> SIGINT behavior.
      // Forward it once for all attached managers, even when this is a reload-only
      // manager, so the process default (or any external SIGINT listener) still works.
      if (isCtrl && keyName === 'c') {
        // Older copies invoke their callback directly. Forwarding SIGINT alongside
        // them would invoke that callback twice; electing an old leader loses ours.
        // Keep shared terminal ownership, but use direct callbacks in a mixed cohort.
        const hasLegacyInstance = [...shared.attachedInstances].some(
          (id) => !shared.sigintForwardingInstances?.has(id),
        );
        if (hasLegacyInstance) {
          if (this.onShutdownRequested && !this.shouldThrottle('shutdown')) {
            safeHandleCallback(
              this.shutdownCallbackName,
              this.onShutdownRequested,
              'SIGINT',
            );
          }
          return;
        }
        let dispatch = shared.ctrlCDispatches?.get(keyObj);
        if (!dispatch || !dispatch.remaining.has(this.instanceID)) {
          dispatch = {
            leader: shared.attachedInstances.values().next().value,
            remaining: new Set(shared.sigintForwardingInstances),
          };
          shared.ctrlCDispatches?.set(keyObj, dispatch);
        }
        dispatch.remaining.delete(this.instanceID);
        if (dispatch.remaining.size === 0) {
          shared.ctrlCDispatches?.delete(keyObj);
        }
        const leader = dispatch.leader;

        if (leader !== this.instanceID) {
          return;
        }

        if (this.shouldThrottle('shutdown')) {
          return;
        }

        if (process.listenerCount('SIGINT') > 0) {
          process.emit('SIGINT', 'SIGINT');
        } else {
          process.kill(process.pid, 'SIGINT');
        }
      }
      // Treat escape as a SIGINT signal (if shutdown handler is registered)
      else if (keyName === 'escape' && this.onShutdownRequested) {
        if (this.shouldThrottle('shutdown')) {
          return;
        }

        safeHandleCallback(
          this.shutdownCallbackName,
          this.onShutdownRequested,
          'SIGINT',
        );
      }
      // Handle R key for reload (case-insensitive)
      else if (keyName === 'r' && this.onReloadRequested) {
        if (this.shouldThrottle('reload')) {
          return;
        }

        safeHandleCallback(this.reloadCallbackName, this.onReloadRequested);
      }
      // Handle I key for info (case-insensitive)
      else if (keyName === 'i' && this.onInfoRequested) {
        if (this.shouldThrottle('info')) {
          return;
        }

        safeHandleCallback(this.infoCallbackName, this.onInfoRequested);
      }
      // Handle D key for debug (case-insensitive)
      else if (keyName === 'd' && this.onDebugRequested) {
        if (this.shouldThrottle('debug')) {
          return;
        }

        safeHandleCallback(this.debugCallbackName, this.onDebugRequested);
      }
    };

    // ADD FIRST, then check - prevents race condition where two instances
    // both see size === 0 before either adds themselves
    shared.attachedInstances.add(this.instanceID);
    shared.sigintForwardingInstances?.add(this.instanceID);
    const isFirstInstance = shared.attachedInstances.size === 1;

    try {
      // Register this instance's keypress handler
      // Note: Multiple instances can coexist - each gets its own handler, all receive the same keypresses
      process.stdin.on('keypress', this.keypressHandler);
    } catch (error) {
      // If registration fails, clean up and rethrow
      shared.attachedInstances.delete(this.instanceID);
      shared.sigintForwardingInstances?.delete(this.instanceID);
      this.keypressHandler = undefined;
      throw error;
    }

    // Enable raw mode only when the first instance attaches
    // Check AFTER adding ourselves to prevent race condition
    if (isFirstInstance) {
      if (!process.stdin.isRaw) {
        try {
          process.stdin.setRawMode(true);
          // Only record ownership AFTER success - prevents rollback race
          shared.rawModeOwner = this.instanceID;
          shared.rawModeEnabledByManager = true;
        } catch (error) {
          // setRawMode failed - clean up the handler we registered
          // Pass attemptedRawModeEnable=true because setRawMode may have enabled raw mode
          // before throwing (edge case with some terminal emulators)
          this.cleanupKeypressHandler(shared, true);
          throw error;
        }
      } else if (
        shared.rawModeEnabledByManager &&
        (shared.rawModeOwner === null ||
          !shared.attachedInstances.has(shared.rawModeOwner))
      ) {
        // Raw mode is already enabled, and we previously enabled it (per shared flag),
        // but ownership is missing or stale (e.g., last detach failed to disable raw mode).
        // Adopt ownership so the eventual last detach will restore the terminal.
        shared.rawModeOwner = this.instanceID;
      } else if (!shared.rawModeEnabledByManager) {
        // If raw mode is already enabled but we didn't enable it, treat it as external.
        // Ensure we don't carry forward a stale owner value from a prior run/version.
        shared.rawModeOwner = null;
      }
    }

    // Resume stdin only when first instance attaches
    if (isFirstInstance) {
      const wasFlowing = process.stdin.readableFlowing;
      try {
        process.stdin.resume();
        this.didResumeStdin = true;
      } catch (error) {
        // A custom resume can throw after changing flow. Only undo a change
        // we made; a failure before resuming does not confer stdin ownership.
        this.didResumeStdin =
          wasFlowing !== true && process.stdin.readableFlowing === true;
        // resume() failed - clean up everything
        this.cleanupKeypressHandler(shared);
        throw error;
      }
    }
  }

  /**
   * Helper to clean up keypress handler registration on error.
   * Removes handler, clears instance from shared state, and restores raw mode if needed.
   *
   * @param shared - The shared state object
   * @param didAttemptRawModeEnable - If true, we attempted to enable raw mode (even if ownership wasn't recorded).
   *   This handles the edge case where setRawMode(true) throws after actually enabling raw mode.
   */
  private cleanupKeypressHandler(
    shared: ProcessSignalManagerSharedState,
    didAttemptRawModeEnable = false,
  ): void {
    if (this.keypressHandler) {
      try {
        process.stdin.off('keypress', this.keypressHandler);
      } catch {
        // Ignore - best effort cleanup
      }
      this.keypressHandler = undefined;
    }

    shared.attachedInstances.delete(this.instanceID);
    shared.sigintForwardingInstances?.delete(this.instanceID);

    // If we attempted to enable raw mode and it appears to have been enabled,
    // record that raw mode is managed by us (even if the original setRawMode(true) threw).
    // This allows future instances to adopt ownership and restore the terminal.
    if (didAttemptRawModeEnable && process.stdin.isTTY && process.stdin.isRaw) {
      shared.rawModeEnabledByManager = true;
      if (
        shared.rawModeOwner === null ||
        !shared.attachedInstances.has(shared.rawModeOwner)
      ) {
        shared.rawModeOwner = this.instanceID;
      }
    }

    // If we were the raw mode owner but other instances remain, transfer ownership.
    // Use centralized helper to ensure atomic ownership transfer.
    if (
      shared.rawModeEnabledByManager &&
      shared.rawModeOwner === this.instanceID &&
      shared.attachedInstances.size > 0
    ) {
      transferRawModeOwnership(shared, this.instanceID);
    } else {
      reanchorDetachedRawModeOwner(shared);
    }

    // Restore raw mode if we're the last instance AND either:
    // 1. We own raw mode (normal case), OR
    // 2. We attempted to enable raw mode but ownership wasn't recorded (setRawMode threw after enabling)
    const shouldRestoreRawMode =
      shared.attachedInstances.size === 0 &&
      shared.rawModeEnabledByManager &&
      (shared.rawModeOwner === this.instanceID ||
        (didAttemptRawModeEnable && shared.rawModeOwner === null));

    if (shouldRestoreRawMode) {
      try {
        // A re-enable failure leaves ownership with the instance that adopted it, so
        // `restoreStdin` does not retry it and it is reported as held.
        this.pendingRawModeFailure = releaseRawMode(shared, this.instanceID);
      } catch (error) {
        // Ensure there's a non-null owner so future detaches can retry.
        // This matters in the edge case where setRawMode(true) threw after enabling raw mode:
        // rawModeOwner would still be null, and without setting it here we'd never retry disabling.
        if (didAttemptRawModeEnable && shared.rawModeOwner === null) {
          shared.rawModeOwner = this.instanceID;
        }
        // rawModeEnabledByManager stays true so future instances can adopt and retry.
        // Terminal will be restored on process exit anyway.

        // Reported for the reason `restoreStdin`'s twin is: a terminal left in raw mode is
        // the user's shell broken, and this said nothing about it.
        //
        // Held for `attach()`'s catch, not reported here: this runs inside a failing
        // `attach()`, and a listener that attaches from the report must not have that
        // attach's error thrown over its own, nor observe the shared state before the
        // ownership repair above. And the owner left on record is usually this instance,
        // so that catch's `restoreStdin` retries the restore - its outcome replaces this
        // one rather than reporting the same broken terminal twice.
        this.pendingRawModeFailure = { error };
      }
    }
  }

  /**
   * Restore stdin to normal mode and clean up keypress listener.
   * Uses remove-then-check pattern (mirror of add-then-check in attach):
   * 1. Remove ourselves from attachedInstances first
   * 2. Check if we're the last (size === 0) to disable raw mode and pause stdin
   *
   * Note: Can be called even if keypressHandler is undefined (e.g., during error recovery).
   * In that case, we still update shared state and attempt terminal restoration if we
   * were the recorded raw mode owner.
   *
   * Returns a raw-mode restore failure for the caller to report with its others: this
   * one's, or else one the keypress setup's rollback held, unless this retried it.
   */
  private restoreStdin(): RawModeFailure | undefined {
    const shared = getSharedState();
    const didResume = this.didResumeStdin;
    this.didResumeStdin = false;
    let rawModeRestoreFailure = this.pendingRawModeFailure;
    this.pendingRawModeFailure = undefined;

    // Remove handler if it exists
    if (this.keypressHandler) {
      try {
        process.stdin.off('keypress', this.keypressHandler);
      } catch {
        // Best effort - continue with cleanup even if off() fails
        // This is extremely rare (stdin closed mid-operation)
      }
      this.keypressHandler = undefined;
    }

    // Remove this instance from shared state even if we never registered a handler.
    // (Set.delete is a safe no-op if we weren't attached.)
    const wasAttachedToStdin = shared.attachedInstances.delete(this.instanceID);
    shared.sigintForwardingInstances?.delete(this.instanceID);

    // Re-check ownership AFTER deletion to get accurate state
    // (avoids race where ownership is transferred to us between capture and deletion)
    const isLastInstance = shared.attachedInstances.size === 0;
    const isCurrentOwner = shared.rawModeOwner === this.instanceID;

    // If we were the raw mode owner but other instances remain, transfer ownership.
    // Use centralized helper to ensure atomic ownership transfer.
    if (!isLastInstance && isCurrentOwner && shared.rawModeEnabledByManager) {
      transferRawModeOwnership(shared, this.instanceID);
    } else {
      reanchorDetachedRawModeOwner(shared);
    }

    // Restore raw mode when last instance detaches, but only if we are the owner.
    // Re-check isCurrentOwner as ownership may have been transferred above (shouldn't happen)
    // if isLastInstance is true, but be defensive).
    if (
      isLastInstance &&
      shared.rawModeOwner === this.instanceID &&
      shared.rawModeEnabledByManager
    ) {
      try {
        // Replaces any failure the rollback held: this is the same restore, retried,
        // and what the terminal is left in is this attempt's outcome.
        rawModeRestoreFailure = releaseRawMode(shared, this.instanceID);
      } catch (error) {
        // The owner stays set so a future detach can retry - but this is reported
        // rather than left to the exit. "Restored on process exit anyway" is true of a
        // script and false of the long-lived process this library exists for: `detach()`
        // returns normally, `getStatus().isAttached` reads `false`, and the terminal is
        // still in raw mode, so the user's shell is broken and nothing anywhere said so.
        // Returned, not reported here: the caller reports it after its other cleanup
        // failures, once its attach/detach is final, so a listener that attaches from
        // the report is not undone by it.
        rawModeRestoreFailure = { error };
      }
    }

    // Pause stdin when last instance detaches - re-checked here rather than trusted from
    // the `isLastInstance` read above. `setRawMode()` is stdin's own code and can run
    // anything, including an `attach()`: the set is the live answer, and a stale flag
    // paused stdin under a freshly attached instance, leaving its keypress handler
    // registered and silent.
    if (
      (wasAttachedToStdin || didResume) &&
      isLastInstance &&
      shared.attachedInstances.size === 0
    ) {
      try {
        process.stdin.pause();
      } catch {
        // Best effort - stdin staying active without handlers is harmless
      }
    }

    return rawModeRestoreFailure;
  }
}

/**
 * Turn raw mode off for the last attached instance that owned it. An attach from inside
 * `setRawMode(false)` may have adopted the raw mode being turned off; turn it back on
 * for that instance rather than clearing its claim. A disable failure throws, leaving
 * ownership for the caller to repair; a re-enable failure is returned, so it is reported
 * as what it is rather than as a failed restore.
 */
function releaseRawMode(
  shared: ProcessSignalManagerSharedState,
  instanceID: string,
): RawModeFailure | undefined {
  if (process.stdin.isTTY && process.stdin.isRaw) {
    process.stdin.setRawMode(false);
  }

  if (
    shared.attachedInstances.size > 0 &&
    shared.rawModeOwner !== null &&
    shared.rawModeOwner !== instanceID &&
    shared.rawModeEnabledByManager
  ) {
    try {
      if (process.stdin.isTTY && !process.stdin.isRaw) {
        process.stdin.setRawMode(true);
      }
    } catch (error) {
      return { error, isReEnable: true };
    }
    return undefined;
  }

  // Raw mode was disabled, or was already off and needed no disabling.
  shared.rawModeOwner = null;
  shared.rawModeEnabledByManager = false;
  return undefined;
}

/** Report cleanup failures in order, now. */
function reportCleanupFailures(
  reports: ReadonlyArray<readonly [string, { error: unknown }]>,
): void {
  for (const [callbackName, failure] of reports) {
    reportCallbackError(callbackName, failure.error);
  }
}

/** A raw-mode failure to report, and whether it was the re-enable for an adopter. */
interface RawModeFailure {
  error: unknown;
  isReEnable?: boolean;
}

/** The report for a raw-mode restore failure, if there was one. */
function rawModeRestoreReport(
  failure: RawModeFailure | undefined,
): Array<readonly [string, { error: unknown }]> {
  if (!failure) {
    return [];
  }
  return [
    [
      failure.isReEnable
        ? 'ProcessSignalManager stdin raw mode re-enable'
        : 'ProcessSignalManager stdin raw mode restore',
      failure,
    ],
  ];
}
