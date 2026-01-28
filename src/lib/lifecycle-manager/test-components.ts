/**
 * Test components for LifecycleManager unit and integration tests
 *
 * These mock components simulate real-world services without actual connections.
 * They are used to test lifecycle orchestration, dependency management,
 * health checks, messaging, and signal handling.
 */

import type { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import type { ComponentHealthResult } from './types';
import { BaseComponent } from './base-component';

// cspell:ignore Reloadable

/**
 * Basic test component with minimal implementation
 */
export class TestComponent extends BaseComponent {
  public startCalled = false;
  public stopCalled = false;

  public start(): Promise<void> | void {
    this.startCalled = true;
    return Promise.resolve();
  }

  public stop(): Promise<void> | void {
    this.stopCalled = true;
    return Promise.resolve();
  }
}

/**
 * Mock database component simulating a database connection pool
 */
export class MockDatabaseComponent extends BaseComponent {
  public connected = false;
  public connectionCount = 0;
  public queries: string[] = [];

  constructor(logger: Logger) {
    super(logger, {
      name: 'database',
      startupTimeoutMS: 5000,
      shutdownGracefulTimeoutMS: 3000,
    });
  }

  public async start(): Promise<void> {
    // Simulate connection delay
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.connected = true;
    this.connectionCount = 5;
    this.logger.info('Database connected');
  }

  public async stop(): Promise<void> {
    // Simulate graceful shutdown
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.connected = false;
    this.connectionCount = 0;
    this.logger.info('Database disconnected');
  }

  public healthCheck(): ComponentHealthResult {
    return {
      healthy: this.connected,
      message: this.connected ? 'Database is connected' : 'Database is disconnected',
      details: { connectionCount: this.connectionCount },
    };
  }

  public getValue(key: string): unknown {
    if (key === 'connectionCount') {
      return this.connectionCount;
    }
    if (key === 'connected') {
      return this.connected;
    }
    return undefined;
  }

  public query(sql: string): void {
    this.queries.push(sql);
  }
}

/**
 * Mock cache component simulating Redis or similar
 */
export class MockCacheComponent extends BaseComponent {
  public connected = false;
  public cache: Map<string, unknown> = new Map();

  constructor(logger: Logger, isOptional = false) {
    super(logger, {
      name: 'cache',
      dependencies: ['database'], // Cache depends on database
      optional: isOptional,
      startupTimeoutMS: 3000,
    });
  }

  public async start(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.connected = true;
    this.logger.info('Cache connected');
  }

  public stop(): void {
    this.connected = false;
    this.cache.clear();
    this.logger.info('Cache disconnected');
  }

  public healthCheck(): boolean {
    return this.connected;
  }

  public getValue(key: string): unknown {
    if (key === 'connected') {
      return this.connected;
    }
    if (key === 'size') {
      return this.cache.size;
    }
    return this.cache.get(key);
  }

  public set(key: string, value: unknown): void {
    this.cache.set(key, value);
  }

  public get(key: string): unknown {
    return this.cache.get(key);
  }
}

/**
 * Mock web server component
 */
export class MockWebServerComponent extends BaseComponent {
  public listening = false;
  public port = 0;
  public requestCount = 0;

  constructor(logger: Logger, dependencies: string[] = ['database']) {
    super(logger, {
      name: 'web-server',
      dependencies,
      startupTimeoutMS: 5000,
      shutdownGracefulTimeoutMS: 5000,
    });
  }

  public async start(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.listening = true;
    this.port = 3000;
    this.logger.info('Web server listening on port 3000');
  }

  public async stop(): Promise<void> {
    // Simulate draining connections
    await new Promise((resolve) => setTimeout(resolve, 10));
    this.listening = false;
    this.port = 0;
    this.logger.info('Web server stopped');
  }

  public onShutdownWarning(): void {
    this.logger.info('Web server received shutdown warning - stopping new connections');
  }

  public onReload(): void {
    this.logger.info('Web server reloading configuration');
  }

  public healthCheck(): ComponentHealthResult {
    return {
      healthy: this.listening,
      message: this.listening ? `Listening on port ${this.port}` : 'Not listening',
      details: { port: this.port, requestCount: this.requestCount },
    };
  }

  public getValue(key: string): unknown {
    if (key === 'port') {
      return this.port;
    }
    if (key === 'listening') {
      return this.listening;
    }
    if (key === 'requestCount') {
      return this.requestCount;
    }
    return undefined;
  }
}

/**
 * Mock API component that depends on web server and cache
 */
export class MockAPIComponent extends BaseComponent {
  public ready = false;
  public reloadCount = 0;
  public infoCallCount = 0;
  public debugCallCount = 0;
  public messages: Array<{ payload: unknown; from: string | null }> = [];

  constructor(logger: Logger, dependencies: string[] = ['web-server', 'cache']) {
    super(logger, {
      name: 'api',
      dependencies,
      startupTimeoutMS: 3000,
    });
  }

  public async start(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.ready = true;
    this.logger.info('API service ready');
  }

  public stop(): void {
    this.ready = false;
    this.logger.info('API service stopped');
  }

  public onReload(): void {
    this.reloadCount++;
    this.logger.info('API service reloaded');
  }

  public onInfo(): void {
    this.infoCallCount++;
    this.logger.info('API info requested');
  }

  public onDebug(): void {
    this.debugCallCount++;
    this.logger.info('API debug requested');
  }

  public onMessage(payload: unknown, from: string | null): { received: true } {
    this.messages.push({ payload, from });
    return { received: true };
  }

  public healthCheck(): boolean {
    return this.ready;
  }

  public getValue(key: string): unknown {
    if (key === 'ready') {
      return this.ready;
    }
    if (key === 'reloadCount') {
      return this.reloadCount;
    }
    return undefined;
  }
}

/**
 * Mock background worker component
 */
export class MockWorkerComponent extends BaseComponent {
  public running = false;
  public processedJobs = 0;
  private aborted = false;

  constructor(logger: Logger, name = 'worker', dependencies: string[] = ['database']) {
    super(logger, {
      name,
      dependencies,
      startupTimeoutMS: 3000,
    });
  }

  public async start(): Promise<void> {
    this.aborted = false;
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.running = true;
    this.logger.info('Worker started');
  }

  public stop(): void {
    this.running = false;
    this.logger.info('Worker stopped');
  }

  public onStartupAborted(): void {
    this.aborted = true;
  }

  public onStopAborted(): void {
    this.logger.warn('Worker stop aborted');
  }

  public healthCheck(): boolean {
    return this.running && !this.aborted;
  }

  public processJob(): void {
    if (this.running) {
      this.processedJobs++;
    }
  }
}

/**
 * Slow-starting component for timeout testing
 */
export class SlowStartComponent extends BaseComponent {
  public started = false;
  public startDuration: number;

  constructor(logger: Logger, name = 'slow-start', startDuration = 100) {
    super(logger, {
      name,
      startupTimeoutMS: 50, // Less than startDuration to trigger timeout
    });
    this.startDuration = startDuration;
  }

  public async start(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.startDuration));
    this.started = true;
  }

  public stop(): void {
    this.started = false;
  }
}

/**
 * Slow-stopping component for shutdown testing
 */
export class SlowStopComponent extends BaseComponent {
  public stopped = false;
  public stopDuration: number;

  constructor(logger: Logger, name = 'slow-stop', stopDuration = 100) {
    super(logger, {
      name,
      shutdownGracefulTimeoutMS: 1000, // Minimum is 1000ms
      shutdownForceTimeoutMS: 500, // Minimum is 500ms
    });
    this.stopDuration = stopDuration;
  }

  public start(): void {
    this.stopped = false;
  }

  public async stop(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.stopDuration));
    this.stopped = true;
  }
}

/**
 * Component that fails during startup
 */
export class FailingStartComponent extends BaseComponent {
  public errorMessage: string;

  constructor(logger: Logger, name = 'failing-start', errorMessage = 'Start failed') {
    super(logger, { name });
    this.errorMessage = errorMessage;
  }

  public start(): void {
    throw new Error(this.errorMessage);
  }

  public stop(): void {
    // Never gets here
  }
}

/**
 * Component that fails during stop
 */
export class FailingStopComponent extends BaseComponent {
  public started = false;
  public errorMessage: string;

  constructor(logger: Logger, name = 'failing-stop', errorMessage = 'Stop failed') {
    super(logger, { name });
    this.errorMessage = errorMessage;
  }

  public start(): void {
    this.started = true;
  }

  public stop(): void {
    throw new Error(this.errorMessage);
  }
}

/**
 * Reloadable component with reload tracking
 */
export class ReloadableComponent extends BaseComponent {
  public running = false;
  public reloadCount = 0;
  public reloadError: Error | null = null;

  constructor(logger: Logger, name = 'reloadable') {
    super(logger, { name });
  }

  public start(): void {
    this.running = true;
  }

  public stop(): void {
    this.running = false;
  }

  public onReload(): void {
    if (this.reloadError) {
      throw this.reloadError;
    }
    this.reloadCount++;
  }
}

/**
 * Component with configurable health check behavior
 */
export class ConfigurableHealthComponent extends BaseComponent {
  public running = false;
  public healthy = true;
  public healthCheckDelay = 0;
  public healthCheckError: Error | null = null;

  constructor(logger: Logger, name = 'configurable-health') {
    super(logger, {
      name,
      healthCheckTimeoutMS: 100,
    });
  }

  public start(): void {
    this.running = true;
  }

  public stop(): void {
    this.running = false;
  }

  public async healthCheck(): Promise<ComponentHealthResult> {
    if (this.healthCheckDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.healthCheckDelay));
    }
    if (this.healthCheckError) {
      throw this.healthCheckError;
    }
    return {
      healthy: this.healthy,
      message: this.healthy ? 'Component is healthy' : 'Component is unhealthy',
    };
  }
}

/**
 * Component with message handling
 */
export class MessagingComponent extends BaseComponent {
  public running = false;
  public messages: Array<{ payload: unknown; from: string | null }> = [];
  public responseData: unknown = undefined;
  public messageError: Error | null = null;

  constructor(logger: Logger, name = 'messaging') {
    super(logger, { name });
  }

  public start(): void {
    this.running = true;
  }

  public stop(): void {
    this.running = false;
  }

  public onMessage(payload: unknown, from: string | null): unknown {
    if (this.messageError) {
      throw this.messageError;
    }
    this.messages.push({ payload, from });
    return this.responseData;
  }
}

/**
 * Helper to create a logger for testing
 */
export function createTestLogger(): { logger: Logger; sink: ArraySink } {
  const sink = new ArraySink();
  const logger = new Logger({
    sinks: [sink],
    callProcessExit: false,
  });
  return { logger, sink };
}

/**
 * Helper to wait for a condition with timeout
 */
export async function waitFor(
  condition: () => boolean,
  timeout = 1000,
  interval = 10,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return condition();
}
