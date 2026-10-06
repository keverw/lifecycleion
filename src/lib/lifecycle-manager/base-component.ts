import type { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import type {
  ComponentOptions,
  ComponentHealthResult,
  ComponentLifecycleRef,
  ComponentStatus,
  ComponentValueResult,
} from './types';
import { InvalidComponentNameError } from './errors';
import { resolveTimeoutMS } from '../internal/timer-limits';

/**
 * Abstract base class for all lifecycle-managed components
 *
 * Components extend this class and implement the required start() and stop() methods.
 * They can optionally implement lifecycle hooks for shutdown phases, signal handling,
 * health checks, messaging, and value sharing.
 *
 * The component's lifecycle is managed by a LifecycleManager instance which:
 * - Calls start() during startup (with dependency ordering)
 * - Calls stop() and optional shutdown hooks during shutdown
 * - Provides messaging and value sharing between components
 * - Handles signals (SIGINT, SIGTERM, SIGHUP, etc.)
 *
 * @example
 * ```typescript
 * class DatabaseComponent extends BaseComponent {
 *   private pool?: Pool;
 *
 *   constructor(logger: Logger) {
 *     super(logger, {
 *       name: 'database',
 *       dependencies: [],
 *       startupTimeoutMS: 10000,
 *       shutdownGracefulTimeoutMS: 5000,
 *     });
 *   }
 *
 *   async start() {
 *     this.logger.info('Connecting to database...');
 *     this.pool = await createPool(config);
 *     this.logger.success('Connected to database');
 *   }
 *
 *   async stop() {
 *     this.logger.info('Closing database connections...');
 *     await this.pool?.end();
 *     this.logger.success('Database connections closed');
 *   }
 *
 *   // Optional: handle graceful shutdown warning
 *   async onShutdownWarning() {
 *     this.logger.info('Shutdown warning - stopping new connections');
 *     this.pool?.stopAcceptingConnections();
 *   }
 *
 *   // Optional: handle reload signal
 *   async onReload() {
 *     this.logger.info('Reloading database configuration');
 *     await this.reloadConfig();
 *   }
 *
 *   // Optional: health check
 *   async healthCheck() {
 *     const isHealthy = await this.pool?.ping();
 *     return { healthy: isHealthy, message: 'Database connection active' };
 *   }
 * }
 * ```
 */
export abstract class BaseComponent {
  /** Names of components this one depends on */
  public readonly dependencies: string[];

  /** If true, startup failure doesn't trigger rollback */
  public readonly optional: boolean;

  /** Time to wait for start() in milliseconds */
  public readonly startupTimeoutMS: number;

  /** Time to wait for graceful shutdown in milliseconds */
  public readonly shutdownGracefulTimeoutMS: number;

  /** Time to wait for force shutdown in milliseconds */
  public readonly shutdownForceTimeoutMS: number;

  /** Time to wait for healthCheck() in milliseconds; 0 disables the timeout */
  public readonly healthCheckTimeoutMS: number;

  /** Time to wait for onReload/onInfo/onDebug in milliseconds */
  public readonly signalTimeoutMS: number;

  /**
   * Whether this component cleans up after its own timed-out start. When `false` (the
   * default), a `start()` that passes its `startupTimeoutMS` and then completes anyway
   * is stopped by the manager with `stop()`. When `true`, the manager leaves that late
   * start to the component. A bulk startup deadline cleans up regardless.
   */
  public readonly ownsLateStartCleanup: boolean;

  /** Component logger (scoped to component name) */
  protected logger: LoggerService;

  /** Component name (kebab-case) */
  protected name: string;

  /** Reference to component-scoped lifecycle (set by manager when registered) */
  protected lifecycle!: ComponentLifecycleRef;

  /** @internal Set by LifecycleManager while the component is running. */
  private _unexpectedStopHandler?: (error?: Error) => boolean;
  /** @internal Incremented whenever the unexpected-stop handler is re-armed or cleared. */
  private _unexpectedStopGeneration = 0;
  /** @internal Flag indicating whether this component is currently registered with a LifecycleManager */
  private _isRegistered = false;

  /**
   * Create a new component
   *
   * @param rootLogger - Root logger instance (component will create scoped logger)
   * @param options - Component configuration
   * @throws {InvalidComponentNameError} If name doesn't match kebab-case pattern
   */
  constructor(rootLogger: Logger, options: ComponentOptions) {
    // Validate kebab-case name
    const kebabCaseRegex = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    if (!kebabCaseRegex.test(options.name)) {
      throw new InvalidComponentNameError({ name: options.name });
    }

    this.name = options.name;

    // Create component logger (component logs as its own service)
    this.logger = rootLogger.service(this.name);

    // Dependency configuration
    this.dependencies = options.dependencies ?? [];
    this.optional = options.optional ?? false;

    // Null or omitted selects the default, as for the timeouts below. Anything else that
    // is not a boolean is a configuration mistake, refused here rather than read as
    // truthy or falsy.
    const doesOwnLateStartCleanup = options.ownsLateStartCleanup ?? false;
    if (typeof doesOwnLateStartCleanup !== 'boolean') {
      throw new TypeError('ownsLateStartCleanup must be a boolean');
    }
    this.ownsLateStartCleanup = doesOwnLateStartCleanup;

    // Null or omitted configuration selects defaults. Validate before any lifecycle
    // operation can acquire resources; shutdown durations retain their documented
    // minimums after validation, while Infinity is bounded at the timer ceiling.
    this.startupTimeoutMS = resolveTimeoutMS(
      options.startupTimeoutMS,
      30000,
      'startupTimeoutMS',
    );
    this.healthCheckTimeoutMS = resolveTimeoutMS(
      options.healthCheckTimeoutMS,
      5000,
      'healthCheckTimeoutMS',
    );
    this.signalTimeoutMS = resolveTimeoutMS(
      options.signalTimeoutMS,
      5000,
      'signalTimeoutMS',
    );
    this.shutdownGracefulTimeoutMS = Math.max(
      1000,
      resolveTimeoutMS(
        options.shutdownGracefulTimeoutMS,
        5000,
        'shutdownGracefulTimeoutMS',
      ),
    );
    this.shutdownForceTimeoutMS = Math.max(
      500,
      resolveTimeoutMS(
        options.shutdownForceTimeoutMS,
        2000,
        'shutdownForceTimeoutMS',
      ),
    );
  }

  /** @internal Called by LifecycleManager after a successful start. */
  public _setUnexpectedStopHandler(handler: (error?: Error) => boolean): void {
    this._unexpectedStopGeneration += 1;
    this._unexpectedStopHandler = handler;
    const generation = this._unexpectedStopGeneration;
    this.reportUnexpectedStop = (error?: Error) => {
      if (this._unexpectedStopGeneration !== generation) {
        return false;
      }

      return this._unexpectedStopHandler?.(error) ?? false;
    };
  }

  /** @internal Called by LifecycleManager when stop begins or component is unregistered. */
  public _clearUnexpectedStopHandler(): void {
    this._unexpectedStopGeneration += 1;
    this._unexpectedStopHandler = undefined;
    this.reportUnexpectedStop = () => false;
  }

  /** @internal Called by LifecycleManager when registering the component. */
  public _markRegistered(): void {
    this._isRegistered = true;
  }

  /** @internal Called by LifecycleManager when unregistering the component. */
  public _markUnregistered(): void {
    this._isRegistered = false;

    // Clear lifecycle to prevent stale calls and memory leaks
    (this as unknown as { lifecycle?: ComponentLifecycleRef }).lifecycle =
      undefined;
  }

  /** @internal Check if the component is registered with any LifecycleManager. */
  public _isRegisteredWithManager(): boolean {
    return this._isRegistered;
  }

  /**
   * Start the component
   *
   * Called by the LifecycleManager when starting components.
   * Should perform all initialization, connection setup, etc.
   * Dependencies are guaranteed to have started before this is called.
   *
   * Can be sync or async - manager will await if Promise is returned.
   *
   * `signal` is fresh for each start attempt. The manager aborts it when it stops
   * waiting on this call while it is still pending - its `startupTimeoutMS` or a
   * `startAllComponents()` deadline passed - with the `ComponentStartTimeoutError`
   * the start's result carries as `signal.reason`. It is never aborted because
   * `start()` resolved or threw, nor by a stop. A shutdown pass aborts it only with
   * `abortPendingStarts`, as the pass begins, with a
   * `StartupInterruptedByShutdownError` as `signal.reason` - a cue: the pass still
   * waits for this call. A rejection after it that is linked to the abort - the reason
   * itself, an `AbortError`, or an error carrying either on its `cause` chain - is
   * answered `shutdown_in_progress`; any other failure is answered `error`, as without
   * the option. Like the stop signals, it aborts only when the manager no longer needs
   * this call's work. Pass it to cancellable work (`fetch`, `listen`, a pool connect)
   * or check `signal.aborted` between steps; settling promptly once it aborts releases the
   * dependencies the manager keeps up for this start. It is scoped to this start, not
   * to the run it begins. Declaring `start()` without the parameter is fine.
   *
   * A timed-out `start()` that completes anyway is stopped by the manager with `stop()`,
   * unless the component sets `ownsLateStartCleanup: true` and undoes it itself - for
   * example `if (signal.aborted) { await this.teardown(); }` once its work finishes.
   *
   * An `'abort'` listener added through `signal.addEventListener()`, or `signal.onabort`,
   * that throws (or rejects) is reported on the global `'error'` channel as
   * `lifecycle-manager start abort listener for <name>` instead of becoming an uncaught
   * exception; the listeners after it still run. Listeners on a signal derived from it
   * (`AbortSignal.any()`) and ones added through `EventTarget.prototype` directly are
   * not guarded - catch inside those.
   *
   * @throws Should throw an error if startup fails
   */
  public abstract start(signal: AbortSignal): Promise<void> | void;

  /**
   * Stop the component (graceful shutdown)
   *
   * Called by the LifecycleManager when stopping components.
   * Should perform graceful cleanup, close connections, save state, etc.
   * Dependents are guaranteed to have stopped before this is called.
   *
   * Can be sync or async - manager will await if Promise is returned.
   *
   * `signal` is fresh for each graceful stop attempt. The manager aborts it when this
   * call's `shutdownGracefulTimeoutMS` (or a `stopComponent()` `timeout`) passes while
   * it is still pending, with the `ComponentStopTimeoutError` of that timeout as
   * `signal.reason`. It is never aborted because `stop()` resolved or threw, nor by the
   * force phase or a shutdown's `timeoutMS`. Use it as the cue to give up on graceful
   * work (pass it to `server.close()` waits, drains, flushes); a `stop()` that settles
   * promptly once it aborts may still complete the stop before the force phase begins.
   * Declaring `stop()` without the parameter is fine.
   *
   * An `'abort'` listener added through `signal.addEventListener()`, or `signal.onabort`,
   * that throws (or rejects) is reported on the global `'error'` channel as
   * `lifecycle-manager stop abort listener for <name>`, as for the start signal.
   *
   * @throws Should throw an error if stop fails (will trigger force phase)
   */
  public abstract stop(signal: AbortSignal): Promise<void> | void;

  /**
   * Called before graceful shutdown to warn component
   *
   * Optional lifecycle hook called before stopAllComponents() begins stopping components.
   * Use this to prepare for shutdown (stop accepting new work, drain queues, etc.)
   *
   * Can be sync or async - manager will await if Promise is returned.
   */
  public onShutdownWarning?(): Promise<void> | void;

  /**
   * Called for force shutdown if graceful shutdown times out or throws
   *
   * Optional lifecycle hook called after stop() fails, for a `forceImmediate` stop, and
   * for a stalled component's retry.
   * Use this for more aggressive cleanup (kill connections, abandon work, etc.)
   *
   * Can be sync or async - manager will await if Promise is returned.
   *
   * `signal` is fresh for each force attempt, a stalled retry's included, and separate
   * from the one `stop()` received. The manager aborts it when it no longer needs this
   * call's work while the call is still pending: when `shutdownForceTimeoutMS` passes,
   * with a `ComponentForceTimeoutError` (`errCode: 'ForceTimeout'`) - the error the
   * stall result carries - as `signal.reason`; and when the graceful `stop()` it
   * escalated from, still running within the same stop, completes late and ends the
   * force phase early, with a `ForceShutdownSupersededError`
   * (`errCode: 'ForceSuperseded'`) as `signal.reason`. It is never aborted because the
   * call resolved or threw. Listener errors are reported as
   * `lifecycle-manager force abort listener for <name>`. Declaring it without the
   * parameter is fine.
   */
  public onShutdownForce?(signal: AbortSignal): Promise<void> | void;

  /**
   * Called when reload signal (SIGHUP, R key) is received
   *
   * Optional signal handler for runtime reload.
   * Use this to reload configuration, reconnect, etc. without full restart.
   *
   * Can be sync or async - manager will await if Promise is returned.
   * Errors are caught and logged but don't stop the broadcast.
   */
  public onReload?(): Promise<void> | void;

  /**
   * Called when info signal (SIGUSR1, I key) is received
   *
   * Optional signal handler for info requests.
   * Use this to log status, metrics, or other runtime information.
   *
   * Can be sync or async - manager will await if Promise is returned.
   * Errors are caught and logged but don't stop the broadcast.
   */
  public onInfo?(): Promise<void> | void;

  /**
   * Called when debug signal (SIGUSR2, D key) is received
   *
   * Optional signal handler for debug requests.
   * Use this to toggle debug mode, dump state, etc.
   *
   * Can be sync or async - manager will await if Promise is returned.
   * Errors are caught and logged but don't stop the broadcast.
   */
  public onDebug?(): Promise<void> | void;

  /**
   * Optional health check for runtime monitoring
   *
   * Return a simple boolean or a rich result with metadata.
   * Called by the manager when checking component health.
   * Only called on 'running' components.
   *
   * @returns boolean (healthy/unhealthy) or rich result with details
   *
   * @example
   * ```typescript
   * // Simple boolean
   * healthCheck() {
   *   return this.isConnected;
   * }
   *
   * // Rich result with metadata
   * async healthCheck() {
   *   const stats = await this.getStats();
   *   return {
   *     healthy: stats.errorRate < 0.05,
   *     message: stats.errorRate < 0.05 ? 'Healthy' : 'High error rate',
   *     details: { errorRate: stats.errorRate, requestsPerSec: stats.rps }
   *   };
   * }
   * ```
   */
  public healthCheck?():
    Promise<boolean | ComponentHealthResult> | boolean | ComponentHealthResult;

  /**
   * Optional message handler for arbitrary component messaging
   *
   * Receives messages from other components or external code.
   * Can return data which will be included in MessageResult.data.
   *
   * @param payload - The message content (any type)
   * @param from - Sender component name (null if external)
   * @returns Optional data to include in response
   *
   * @example
   * ```typescript
   * async onMessage(payload: unknown, from: string | null) {
   *   const msg = payload as { action: string; data?: unknown };
   *
   *   if (msg.action === 'reset') {
   *     await this.reset();
   *     return { success: true };
   *   }
   *
   *   if (msg.action === 'getStats') {
   *     return { connections: this.pool.size, uptime: this.uptime };
   *   }
   * }
   * ```
   */
  public onMessage?<TData = unknown>(
    payload: unknown,
    from: string | null,
  ): TData | Promise<TData>;

  /**
   * Optional value provider - return values on-demand for other components
   *
   * Called when other components or external code request a value by key.
   * Return a structured result indicating if the value was found.
   *
   * @param key - The value key being requested
   * @param from - Component name if another component requested, null if external
   * @returns Structured result with found status and value
   *
   * @example
   * ```typescript
   * getValue(key: string, from: string | null): ComponentValueResult {
   *   if (key === 'pool') return { found: true, value: this.pool };
   *   else if (key === 'config') return { found: true, value: this.config };
   *   return { found: false, value: undefined }; // Key not found
   * }
   * ```
   */
  public getValue?<T = unknown>(
    key: string,
    from: string | null,
  ): ComponentValueResult<T>;

  /**
   * Get component name
   */
  public getName(): string {
    return this.name;
  }

  /**
   * Get component dependencies
   */
  public getDependencies(): string[] {
    return this.dependencies;
  }

  /**
   * Check if component is optional
   */
  public isOptional(): boolean {
    return this.optional;
  }

  /**
   * Run-scoped unexpected-stop callback. Rebound by LifecycleManager on each
   * successful start so captured references from older runs go stale.
   */
  protected reportUnexpectedStop: (error?: Error) => boolean = () => false;

  /**
   * Get this component's own status from the manager's perspective.
   *
   * Equivalent to `this.lifecycle.getComponentStatus(this.getName())` but without
   * needing to pass the name. Returns `undefined` if the component is not registered.
   *
   * Check `status?.state === 'running'` to test whether the component is currently running.
   */
  protected getSelfStatus(): ComponentStatus | undefined {
    return this.lifecycle?.getComponentStatus(this.name);
  }

  /**
   * Capture a run-scoped unexpected-stop reporter for async listeners created during start().
   *
   * Unlike calling `this.reportUnexpectedStop()` later, the returned callback becomes a no-op
   * once the component is stopped, unregistered, or restarted. This prevents stale listeners
   * from a previous run from stopping a newer run of the same component instance.
   */
  protected getUnexpectedStopReporter(): (error?: Error) => boolean {
    const generation = this._unexpectedStopGeneration;

    return (error?: Error) => {
      if (this._unexpectedStopGeneration !== generation) {
        return false;
      }

      return this._unexpectedStopHandler?.(error) ?? false;
    };
  }
}
