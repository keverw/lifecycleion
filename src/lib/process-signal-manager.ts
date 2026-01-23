import { safeHandleCallback } from './safe-handle-callback';
import readline from 'readline';

/**
 * The shutdown signal types that can trigger the shutdown callback
 */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM' | 'SIGTRAP';

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
  onReloadRequested?: () => void | Promise<void>;

  /**
   * Optional callback invoked when info/stats are requested.
   *
   * Triggered by:
   * - Process signal: SIGUSR1
   * - Keyboard: I key press (case-insensitive)
   *
   * Common uses: Print stats, health check, show metrics
   */
  onInfoRequested?: () => void | Promise<void>;

  /**
   * Optional callback invoked when debug mode is toggled or verbose info is requested.
   *
   * Triggered by:
   * - Process signal: SIGUSR2
   * - Keyboard: D key press (case-insensitive)
   *
   * Common uses: Toggle debug mode, dump full state, enable verbose logging
   */
  onDebugRequested?: () => void | Promise<void>;

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
   * @default 200 (200ms throttle, allowing 5 triggers per second maximum)
   * @example 300 // Custom 300ms throttle (3.33 triggers per second max)
   * @example 0 // Disable throttling entirely
   */
  keypressThrottleMS?: number;
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
  // Static flag shared across all instances to track if emitKeypressEvents was called on process.stdin
  // Since process.stdin is a global singleton, this prevents multiple calls to emitKeypressEvents
  private static keypressEventsEmittedOnStdin = false;

  // Static reference counter tracking how many instances are currently listening for keypresses
  // Since process.stdin is a global singleton shared by ALL instances, we use reference counting to:
  // - Only resume stdin when the first instance attaches (counter: 0 -> 1)
  // - Only pause stdin when the last instance detaches (counter: 1 -> 0)
  // This allows multiple instances to coexist without breaking each other's keypress handling
  private static activeKeypressListeners = 0;

  // Static flag tracking whether the ProcessSignalManager class enabled raw mode
  // Only the class should disable raw mode if it was the one that enabled it
  // This prevents disabling raw mode that was enabled by external code
  private static rawModeEnabledByClass = false;

  private onShutdownRequested?: (
    method: ShutdownSignal,
  ) => void | Promise<void>;
  private onReloadRequested?: () => void | Promise<void>;
  private onInfoRequested?: () => void | Promise<void>;
  private onDebugRequested?: () => void | Promise<void>;

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
  private rawModeEnabledByUs = false;
  private _isAttached = false;

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
    this.onShutdownRequested = options.onShutdownRequested;
    this.onReloadRequested = options.onReloadRequested;
    this.onInfoRequested = options.onInfoRequested;
    this.onDebugRequested = options.onDebugRequested;
    this.shutdownCallbackName =
      options.shutdownCallbackName ?? 'onShutdownRequested';
    this.reloadCallbackName = options.reloadCallbackName ?? 'onReloadRequested';
    this.infoCallbackName = options.infoCallbackName ?? 'onInfoRequested';
    this.debugCallbackName = options.debugCallbackName ?? 'onDebugRequested';
    // Default to 200ms throttle (leading-edge rate limiting), 0 disables
    this.keypressThrottleMS = options.keypressThrottleMS ?? 200;

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
          this._isAttached && process.stdin.isTTY && !!this.keypressHandler,
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
      // This prevents partial registration and ensures consistent state
      this.stopListeningForShutdownSignals();
      this.stopListeningForReloadSignal();
      this.stopListeningForInfoSignal();
      this.stopListeningForDebugSignal();
      this.restoreStdin();
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

    try {
      this.stopListeningForShutdownSignals();
      this.stopListeningForReloadSignal();
      this.stopListeningForInfoSignal();
      this.stopListeningForDebugSignal();
      this.restoreStdin();
    } finally {
      // Always mark as detached, even if cleanup threw an error
      // This prevents the manager from being stuck in an "attached" state
      // that blocks re-attachment attempts
      this._isAttached = false;
    }
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
   * Remove handlers for all shutdown signals if they were registered.
   * Uses the same function references to ensure proper cleanup.
   */
  private stopListeningForShutdownSignals(): void {
    if (this.shutdownSignalListeners) {
      for (const signal of Object.keys(
        this.shutdownSignalListeners,
      ) as ShutdownSignal[]) {
        process.off(signal, this.shutdownSignalListeners[signal]);
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
   * Enable keyboard event listening if stdin is a TTY.
   * Sets stdin to raw mode and listens for Ctrl+C, Escape, R, I, and D keypresses.
   *
   * Note: Letter keys are case-insensitive (R/r, I/i, D/d all work).
   *
   * Defensive: Only registers once to prevent duplicate handlers.
   */
  private listenForKeyPresses(): void {
    if (process.stdin.isTTY && !this.keypressHandler) {
      // Only call emitKeypressEvents once per stream to avoid duplicate events
      // Node.js warns against calling this multiple times on the same stream
      // Use static flag since process.stdin is a global singleton shared across all instances
      if (!ProcessSignalManager.keypressEventsEmittedOnStdin) {
        readline.emitKeypressEvents(process.stdin);
        ProcessSignalManager.keypressEventsEmittedOnStdin = true;
      }

      // Enable raw mode only when the first instance attaches (counter is 0)
      // This ensures raw mode stays enabled as long as ANY instance is listening for keypresses
      if (ProcessSignalManager.activeKeypressListeners === 0) {
        if (!process.stdin.isRaw) {
          // Set flags BEFORE enabling raw mode to ensure proper cleanup on exceptions
          ProcessSignalManager.rawModeEnabledByClass = true;
          this.rawModeEnabledByUs = true;

          try {
            process.stdin.setRawMode(true);
          } catch (error) {
            // If setRawMode fails, roll back the flags
            ProcessSignalManager.rawModeEnabledByClass = false;
            this.rawModeEnabledByUs = false;
            throw error;
          }
        }
      }

      // Note: Keypresses directly invoke callbacks
      // They don't emit actual process signals to avoid recursion and keep it simple
      this.keypressHandler = (str, key): void => {
        const keyObj = key as Record<string, unknown>;
        const keyName = keyObj.name as string;
        // Note: key.name is always lowercase for letter keys, regardless of shift state
        // So checking for 'r' catches both 'r' and 'R' (making it case-insensitive)

        // Handle Ctrl+C manually (if shutdown handler is registered)
        if (keyObj.ctrl && keyName === 'c' && this.onShutdownRequested) {
          if (this.shouldThrottle('shutdown')) {
            return;
          }

          safeHandleCallback(
            this.shutdownCallbackName,
            this.onShutdownRequested,
            'SIGINT',
          );
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

      // Increment counter before registering to ensure it's balanced even if registration fails
      ProcessSignalManager.activeKeypressListeners++;

      try {
        // Register this instance's keypress handler
        // Note: Multiple instances can coexist - each gets its own handler, all receive the same keypresses
        process.stdin.on('keypress', this.keypressHandler);
      } catch (error) {
        // If registration fails, roll back the counter increment and clear the handler
        // Clearing the handler prevents restoreStdin() from decrementing the counter again
        // if attach() catches this error and calls cleanup (avoiding double-decrement)
        ProcessSignalManager.activeKeypressListeners--;
        this.keypressHandler = undefined;
        throw error;
      }

      // Resume stdin only when first instance attaches (counter becomes 1)
      // If other instances are already attached (counter > 1), stdin is already resumed
      // Wrapped in separate try-catch so handler registration isn't rolled back if resume fails
      if (ProcessSignalManager.activeKeypressListeners === 1) {
        try {
          process.stdin.resume();
        } catch (error) {
          // If resume fails, clean up the handler we just registered
          // This keeps the state consistent - if we can't resume, we shouldn't leave a dangling handler
          ProcessSignalManager.activeKeypressListeners--;

          try {
            process.stdin.off('keypress', this.keypressHandler);
            // Only clear handler reference if removal succeeded
            // If off() throws, we leave the reference so restoreStdin() can retry removal later
            this.keypressHandler = undefined;
          } catch {
            // Handler removal failed - increment counter back to maintain consistency
            // Leave this.keypressHandler set so restoreStdin() can attempt removal later
            ProcessSignalManager.activeKeypressListeners++;
            // Throw the original resume error, not the off() error, since that's the root cause
            throw error;
          }

          throw error;
        }
      }
    }
  }

  /**
   * Restore stdin to normal mode and clean up keypress listener.
   * Removes the keypress event listener, disables raw mode (only if we enabled it),
   * pauses stdin, and clears the handler reference to prevent memory leaks.
   *
   * Note: Raw mode restoration is performed independently of handler cleanup to ensure
   * raw mode gets disabled even if handler registration failed (preventing broken terminal state).
   * Pause/resume and keypress listener removal only happen if handler was successfully registered.
   */
  private restoreStdin(): void {
    // Track any error that occurs during handler removal so we can rethrow after cleanup
    // This ensures terminal cleanup happens even if handler removal fails
    let handlerRemovalError: Error | undefined;

    // Only perform keypress listener cleanup if a handler was successfully registered
    if (this.keypressHandler) {
      // Decrement counter before removing to ensure it's balanced even if removal fails
      ProcessSignalManager.activeKeypressListeners--;

      // Capture whether this is the last instance BEFORE attempting removal
      // This ensures terminal cleanup proceeds even if handler removal fails
      const isLastInstance = ProcessSignalManager.activeKeypressListeners === 0;

      try {
        // Remove this instance's keypress handler
        process.stdin.off('keypress', this.keypressHandler);
        // Only clear handler reference if removal succeeded
        // This prevents stale references that would block subsequent attach() calls
        this.keypressHandler = undefined;
      } catch (error) {
        // If removal fails, roll back the counter decrement
        // Leave this.keypressHandler set so future attempts can retry removal
        ProcessSignalManager.activeKeypressListeners++;
        // Capture the error but don't throw yet - we need to complete terminal cleanup first
        handlerRemovalError = error as Error;
      }

      // Only restore raw mode when last instance detaches AND the class enabled it
      // This ensures we don't disable raw mode that was enabled by external code
      // Note: "the class" = any ProcessSignalManager instance, not this specific instance
      // IMPORTANT: Use captured isLastInstance flag so cleanup runs even if handler removal failed
      if (isLastInstance && ProcessSignalManager.rawModeEnabledByClass) {
        try {
          if (process.stdin.isTTY && process.stdin.isRaw) {
            process.stdin.setRawMode(false);
          }
          // Clear the flag after attempting restoration
          // If setRawMode wasn't called (stdin not TTY or not raw), that's fine - we've done our cleanup
          // Only exception handling prevents flag clearing (when setRawMode was called but failed)
          ProcessSignalManager.rawModeEnabledByClass = false;
        } catch {
          // If setRawMode fails, leave the flag set so future instances can try to disable it
          // This prevents the terminal from being permanently stuck in raw mode
          // Note: setRawMode failure is extremely rare (stdin closed mid-operation, etc.)
          // Terminal will be restored on process exit anyway, and there's no better solution
          // without making detach() async or changing the API to return status
        }
      }

      // Clear our instance tracking flag if we were the one who enabled it
      if (this.rawModeEnabledByUs) {
        this.rawModeEnabledByUs = false;
      }

      // Pause stdin only when last instance detaches
      // If other instances are still attached, leave stdin running for them
      // Wrapped in separate try-catch - pause failure shouldn't affect the cleanup already done
      // IMPORTANT: Use captured isLastInstance flag so cleanup runs even if handler removal failed
      if (isLastInstance) {
        try {
          process.stdin.pause();
        } catch {
          // If pause fails, we've still successfully cleaned up the handler and raw mode
          // The stdin may remain active but this is a rare edge case and won't cause issues
          // (stdin being active without handlers just means it's doing nothing)
        }
      }

      // Now that cleanup is complete, rethrow the handler removal error if one occurred
      if (handlerRemovalError) {
        throw handlerRemovalError;
      }
    } else if (
      this.rawModeEnabledByUs &&
      ProcessSignalManager.rawModeEnabledByClass
    ) {
      // Edge case: Raw mode was enabled but handler was never registered (registration failed)
      // Only disable raw mode if no other instances are still attached
      // If other instances are attached, they still need raw mode enabled
      if (ProcessSignalManager.activeKeypressListeners === 0) {
        try {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          // Clear the flag after attempting restoration
          // If setRawMode wasn't called (stdin not TTY), that's fine - we've done our cleanup
          // Only exception handling prevents flag clearing (when setRawMode was called but failed)
          ProcessSignalManager.rawModeEnabledByClass = false;
        } catch {
          // If setRawMode fails, leave the flag set so future instances can try to disable it
          // This prevents the terminal from being permanently stuck in raw mode
          // Note: setRawMode failure is extremely rare (stdin closed mid-operation, etc.)
          // Terminal will be restored on process exit anyway, and there's no better solution
          // without making detach() async or changing the API to return status
        }
      }
      this.rawModeEnabledByUs = false;
    }
  }
}
