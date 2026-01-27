import type { Logger } from '../logger';
import type { LoggerService } from '../logger/logger-service';
import type {
  ComponentOptions,
  ComponentHealthResult,
  ComponentLifecycleRef,
} from './types';
import { InvalidComponentNameError } from './errors';

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

  /** Time to wait for healthCheck() in milliseconds */
  public readonly healthCheckTimeoutMS: number;

  /** Component logger (scoped to component name) */
  protected logger: LoggerService;

  /** Component name (kebab-case) */
  protected name: string;

  /** Reference to component-scoped lifecycle (set by manager when registered) */
  protected lifecycle!: ComponentLifecycleRef;

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

    // Timeout configuration with defaults
    this.startupTimeoutMS = options.startupTimeoutMS ?? 30000;
    this.healthCheckTimeoutMS = options.healthCheckTimeoutMS ?? 5000;

    // Enforce minimums for shutdown timeouts
    this.shutdownGracefulTimeoutMS = Math.max(
      options.shutdownGracefulTimeoutMS ?? 5000,
      1000, // Minimum 1 second
    );
    this.shutdownForceTimeoutMS = Math.max(
      options.shutdownForceTimeoutMS ?? 2000,
      500, // Minimum 500ms
    );
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
   * @throws Should throw an error if startup fails
   */
  public abstract start(): Promise<void> | void;

  /**
   * Stop the component (graceful shutdown)
   *
   * Called by the LifecycleManager when stopping components.
   * Should perform graceful cleanup, close connections, save state, etc.
   * Dependents are guaranteed to have stopped before this is called.
   *
   * Can be sync or async - manager will await if Promise is returned.
   *
   * @throws Should throw an error if stop fails (will trigger force phase)
   */
  public abstract stop(): Promise<void> | void;

  /**
   * Called when start() times out
   *
   * Invoked when start() exceeds startupTimeoutMS before rollback begins.
   * Use this to set flags, abort pending work, or cleanup resources.
   * Must be synchronous and fast - manager won't wait for it to complete.
   */
  public onStartupAborted?(): void;

  /**
   * Called when stop() times out
   *
   * Invoked when stop() exceeds shutdownGracefulTimeoutMS before force shutdown begins.
   * Use this to set flags or prepare for more aggressive cleanup in onShutdownForce().
   * Must be synchronous and fast - manager won't wait for it to complete.
   */
  public onStopAborted?(): void;

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
   * Optional lifecycle hook called after stop() fails.
   * Use this for more aggressive cleanup (kill connections, abandon work, etc.)
   *
   * Can be sync or async - manager will await if Promise is returned.
   */
  public onShutdownForce?(): Promise<void> | void;

  /**
   * Called when onShutdownForce() times out
   *
   * Invoked when onShutdownForce() exceeds shutdownForceTimeoutMS before component is marked stalled.
   * Must be synchronous and fast - manager won't wait for it to complete.
   */
  public onShutdownForceAborted?(): void;

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
    | Promise<boolean | ComponentHealthResult>
    | boolean
    | ComponentHealthResult;

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
   * Return undefined if key not found.
   *
   * @param key - The value key being requested
   * @param from - Component name if another component requested, null if external
   * @returns The value, or undefined if key not found
   *
   * @example
   * ```typescript
   * getValue(key: string, from: string | null): unknown {
   *   if (key === 'pool') return this.pool;
   *   if (key === 'config') return this.config;
   *   return undefined; // Key not found
   * }
   * ```
   */
  public getValue?(key: string, from: string | null): unknown;

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
}
