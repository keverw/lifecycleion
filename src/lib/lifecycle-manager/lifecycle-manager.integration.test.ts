/**
 * LifecycleManager Integration Tests
 *
 * These tests simulate real-world scenarios with multiple interconnected components,
 * complex dependency chains, signal handling, and health monitoring workflows.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { Logger } from '../logger';
import { ArraySink } from '../logger/sinks/array';
import { LifecycleManager } from './lifecycle-manager';
import {
  MockDatabaseComponent,
  MockCacheComponent,
  MockWebServerComponent,
  MockAPIComponent,
  MockWorkerComponent,
  SlowStartComponent,
  ReloadableComponent,
  ConfigurableHealthComponent,
  MessagingComponent,
  TestComponent,
} from './test-components';
import { BaseComponent } from './base-component';
import { sleep } from '../sleep';

describe('LifecycleManager Integration Tests', () => {
  let logger: Logger;
  let arraySink: ArraySink;
  let lifecycle: LifecycleManager;

  beforeEach(() => {
    arraySink = new ArraySink();
    logger = new Logger({
      sinks: [arraySink],
      callProcessExit: false,
    });
    lifecycle = new LifecycleManager({
      logger,
      name: 'test-lifecycle',
    });
  });

  afterEach(async () => {
    // Clean up: stop all components if running
    if (lifecycle.getRunningComponentCount() > 0) {
      await lifecycle.stopAllComponents();
    }
  });

  describe('Multi-Component Application Stack', () => {
    test('should start and stop a complete application stack in correct order', async () => {
      // Register components in arbitrary order - manager should resolve dependencies
      const api = new MockAPIComponent(logger);
      const webServer = new MockWebServerComponent(logger);
      const cache = new MockCacheComponent(logger);
      const database = new MockDatabaseComponent(logger);

      // Register in "wrong" order to verify dependency resolution
      await lifecycle.registerComponent(api);
      await lifecycle.registerComponent(webServer);
      await lifecycle.registerComponent(cache);
      await lifecycle.registerComponent(database);

      // Verify startup order respects dependencies
      const startupOrder = lifecycle.getStartupOrder();
      expect(startupOrder.success).toBe(true);
      // Database must be first (no deps), api must be last (depends on web-server and cache)
      // Cache and web-server order may vary based on registration order
      expect(startupOrder.startupOrder[0]).toBe('database');
      expect(startupOrder.startupOrder[startupOrder.startupOrder.length - 1]).toBe('api');
      expect(startupOrder.startupOrder).toContain('cache');
      expect(startupOrder.startupOrder).toContain('web-server');

      // Start all components
      const startResult = await lifecycle.startAllComponents();
      expect(startResult.success).toBe(true);
      // Database first, api last - middle order may vary based on registration
      expect(startResult.startedComponents[0]).toBe('database');
      expect(startResult.startedComponents[startResult.startedComponents.length - 1]).toBe('api');
      expect(startResult.startedComponents).toContain('cache');
      expect(startResult.startedComponents).toContain('web-server');

      // Verify all components are running
      expect(database.connected).toBe(true);
      expect(cache.connected).toBe(true);
      expect(webServer.listening).toBe(true);
      expect(api.ready).toBe(true);

      // Verify running count
      expect(lifecycle.getRunningComponentCount()).toBe(4);

      // Stop all components
      const stopResult = await lifecycle.stopAllComponents();
      expect(stopResult.success).toBe(true);
      // Should stop in reverse dependency order: api first, database last
      expect(stopResult.stoppedComponents[0]).toBe('api');
      expect(stopResult.stoppedComponents[stopResult.stoppedComponents.length - 1]).toBe('database');
      expect(stopResult.stoppedComponents).toContain('cache');
      expect(stopResult.stoppedComponents).toContain('web-server');

      // Verify all components are stopped
      expect(database.connected).toBe(false);
      expect(cache.connected).toBe(false);
      expect(webServer.listening).toBe(false);
      expect(api.ready).toBe(false);
    });

    test('should handle diamond dependency patterns', async () => {
      // Create diamond: api depends on both web-server and worker
      // Both web-server and worker depend on database
      //
      //       api
      //      /   \
      //  web-server  worker
      //      \   /
      //     database

      const database = new MockDatabaseComponent(logger);
      const webServer = new MockWebServerComponent(logger, ['database']);
      const worker = new MockWorkerComponent(logger, 'worker', ['database']);

      class DiamondAPIComponent extends BaseComponent {
        public ready = false;
        constructor(log: Logger) {
          super(log, { name: 'diamond-api', dependencies: ['web-server', 'worker'] });
        }
        public start(): void {
          this.ready = true;
        }
        public stop(): void {
          this.ready = false;
        }
      }
      const api = new DiamondAPIComponent(logger);

      await lifecycle.registerComponent(api);
      await lifecycle.registerComponent(worker);
      await lifecycle.registerComponent(webServer);
      await lifecycle.registerComponent(database);

      const startupOrder = lifecycle.getStartupOrder();
      expect(startupOrder.success).toBe(true);
      // Database must be first, api must be last
      expect(startupOrder.startupOrder[0]).toBe('database');
      expect(startupOrder.startupOrder[3]).toBe('diamond-api');

      const startResult = await lifecycle.startAllComponents();
      expect(startResult.success).toBe(true);

      expect(database.connected).toBe(true);
      expect(webServer.listening).toBe(true);
      expect(worker.running).toBe(true);
      expect(api.ready).toBe(true);
    });

    test('should handle optional component failures gracefully', async () => {
      const database = new MockDatabaseComponent(logger);
      const cache = new MockCacheComponent(logger, true); // Optional!
      const webServer = new MockWebServerComponent(logger, ['database']); // Doesn't depend on cache

      // Make cache fail
      cache.start = (): never => {
        throw new Error('Cache connection failed');
      };

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(cache);
      await lifecycle.registerComponent(webServer);

      const startResult = await lifecycle.startAllComponents();
      expect(startResult.success).toBe(true); // Still succeeds because cache is optional
      expect(startResult.failedOptionalComponents.length).toBe(1);
      expect(startResult.failedOptionalComponents[0].name).toBe('cache');

      // Database and web-server should be running
      expect(database.connected).toBe(true);
      expect(webServer.listening).toBe(true);

      // Cache should not be running
      expect(lifecycle.isComponentRunning('cache')).toBe(false);
    });

    test('should skip components that depend on failed optional component', async () => {
      const database = new MockDatabaseComponent(logger);
      const cache = new MockCacheComponent(logger, true); // Optional
      const api = new MockAPIComponent(logger, ['cache']); // Depends on optional cache

      // Make cache fail
      cache.start = (): never => {
        throw new Error('Cache connection failed');
      };

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(cache);
      await lifecycle.registerComponent(api);

      const startResult = await lifecycle.startAllComponents();
      expect(startResult.success).toBe(true);
      expect(startResult.failedOptionalComponents[0].name).toBe('cache');
      expect(startResult.skippedDueToDependency).toContain('api');

      expect(database.connected).toBe(true);
      expect(lifecycle.isComponentRunning('cache')).toBe(false);
      expect(lifecycle.isComponentRunning('api')).toBe(false);
    });
  });

  describe('Signal Handling', () => {
    test('should broadcast reload signal to all running components with onReload', async () => {
      const reloadable1 = new ReloadableComponent(logger, 'reloadable-1');
      const reloadable2 = new ReloadableComponent(logger, 'reloadable-2');
      const noReload = new TestComponent(logger, { name: 'no-reload' });

      await lifecycle.registerComponent(reloadable1);
      await lifecycle.registerComponent(reloadable2);
      await lifecycle.registerComponent(noReload);

      await lifecycle.startAllComponents();

      const reloadResult = await lifecycle.triggerReload();
      expect(reloadResult.signal).toBe('reload');
      expect(reloadResult.code).toBe('ok');

      expect(reloadable1.reloadCount).toBe(1);
      expect(reloadable2.reloadCount).toBe(1);

      // Components without onReload are in results but not called
      const noReloadResult = reloadResult.results.find((r) => r.name === 'no-reload');
      expect(noReloadResult?.code).toBe('no_handler');
    });

    test('should handle reload errors gracefully and continue', async () => {
      const reloadable1 = new ReloadableComponent(logger, 'reloadable-1');
      const reloadable2 = new ReloadableComponent(logger, 'reloadable-2');

      // Make first component fail on reload
      reloadable1.reloadError = new Error('Reload failed');

      await lifecycle.registerComponent(reloadable1);
      await lifecycle.registerComponent(reloadable2);

      await lifecycle.startAllComponents();

      const reloadResult = await lifecycle.triggerReload();
      expect(reloadResult.code).toBe('partial_error');

      // First component failed
      const result1 = reloadResult.results.find((r) => r.name === 'reloadable-1');
      expect(result1?.code).toBe('error');
      expect(result1?.error).not.toBeNull();

      // Second component succeeded
      const result2 = reloadResult.results.find((r) => r.name === 'reloadable-2');
      expect(result2?.code).toBe('called');
      expect(reloadable2.reloadCount).toBe(1);
    });

    test('should trigger info and debug signals', async () => {
      const api = new MockAPIComponent(logger, []);

      await lifecycle.registerComponent(api);
      await lifecycle.startAllComponents();

      const infoResult = await lifecycle.triggerInfo();
      expect(infoResult.signal).toBe('info');
      expect(api.infoCallCount).toBe(1);

      const debugResult = await lifecycle.triggerDebug();
      expect(debugResult.signal).toBe('debug');
      expect(api.debugCallCount).toBe(1);
    });

    test('should use custom reload callback when provided', async () => {
      let wasCustomCallbackCalled = false;
      let wasBroadcastCalled = false;

      const customLifecycle = new LifecycleManager({
        logger,
        name: 'custom-signals',
        onReloadRequested: async (broadcastReload) => {
          wasCustomCallbackCalled = true;
          await broadcastReload();
          wasBroadcastCalled = true;
        },
      });

      const reloadable = new ReloadableComponent(logger, 'reloadable');
      await customLifecycle.registerComponent(reloadable);
      await customLifecycle.startAllComponents();

      await customLifecycle.triggerReload();

      expect(wasCustomCallbackCalled).toBe(true);
      expect(wasBroadcastCalled).toBe(true);
      expect(reloadable.reloadCount).toBe(1);

      await customLifecycle.stopAllComponents();
    });
  });

  describe('Shutdown Scenarios', () => {
    test('should handle shutdown during startup gracefully', async () => {
      const database = new MockDatabaseComponent(logger);
      const slowStart = new SlowStartComponent(logger, 'slow-component', 100);

      // Configure slow component to be part of startup
      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(slowStart);

      // Start in background and immediately trigger shutdown
      const startPromise = lifecycle.startAllComponents();

      // Wait just enough for database to start
      await sleep(30);

      // Trigger shutdown while slow component is still starting
      const stopPromise = lifecycle.stopAllComponents();

      // Both should resolve
      const [_startResult, stopResult] = await Promise.all([startPromise, stopPromise]);

      // Startup may have succeeded or been interrupted
      // Either way, shutdown should complete
      expect(stopResult.success).toBe(true);
    });

    test('should track stalled components during shutdown', async () => {
      // Create a component that hangs during stop
      class HangingStopComponent extends BaseComponent {
        constructor(log: Logger) {
          super(log, {
            name: 'hanging-stop',
            shutdownGracefulTimeoutMS: 1000, // Minimum
            shutdownForceTimeoutMS: 500, // Minimum
          });
        }
        public start(): void {
          // No-op
        }
        public async stop(): Promise<void> {
          // Hang forever (until force timeout)
          await new Promise(() => {});
        }
        public async onShutdownForce(): Promise<void> {
          // Also hang
          await new Promise(() => {});
        }
      }

      const hanging = new HangingStopComponent(logger);
      await lifecycle.registerComponent(hanging);
      await lifecycle.startAllComponents();

      const stopResult = await lifecycle.stopAllComponents();

      // The component should be marked as stalled
      expect(stopResult.stalledComponents.length).toBe(1);
      expect(stopResult.stalledComponents[0].name).toBe('hanging-stop');
      expect(stopResult.stalledComponents[0].phase).toBe('force');
    });

    test('should block restart when stalled components exist', async () => {
      // Create a stall scenario
      class StallingComponent extends BaseComponent {
        constructor(log: Logger) {
          super(log, {
            name: 'stalling',
            shutdownGracefulTimeoutMS: 1000,
            shutdownForceTimeoutMS: 500,
          });
        }
        public start(): void {
          // No-op
        }
        public async stop(): Promise<void> {
          await new Promise(() => {});
        }
        public async onShutdownForce(): Promise<void> {
          await new Promise(() => {});
        }
      }

      const stalling = new StallingComponent(logger);
      await lifecycle.registerComponent(stalling);
      await lifecycle.startAllComponents();
      await lifecycle.stopAllComponents();

      // Try to start again
      const restartResult = await lifecycle.startAllComponents();
      expect(restartResult.success).toBe(false);
      expect(restartResult.blockedByStalledComponents).toContain('stalling');
    });

    test('should respect graceful and force shutdown phases', async () => {
      const events: string[] = [];

      class PhasedShutdownComponent extends BaseComponent {
        constructor(log: Logger) {
          super(log, {
            name: 'phased-shutdown',
            shutdownGracefulTimeoutMS: 2000,
            shutdownForceTimeoutMS: 1000,
          });
        }
        public start(): void {
          events.push('started');
        }
        public stop(): void {
          events.push('stop-called');
        }
        public onShutdownWarning(): void {
          events.push('warning-called');
        }
      }

      const component = new PhasedShutdownComponent(logger);
      await lifecycle.registerComponent(component);
      await lifecycle.startAllComponents();

      await lifecycle.stopAllComponents();

      expect(events).toContain('started');
      expect(events).toContain('warning-called');
      expect(events).toContain('stop-called');

      // Warning should come before stop
      const warningIndex = events.indexOf('warning-called');
      const stopIndex = events.indexOf('stop-called');
      expect(warningIndex).toBeLessThan(stopIndex);
    });
  });

  describe('Health Monitoring', () => {
    test('should check health of all running components', async () => {
      const database = new MockDatabaseComponent(logger);
      const webServer = new MockWebServerComponent(logger);
      const cache = new MockCacheComponent(logger);

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(cache);
      await lifecycle.registerComponent(webServer);

      await lifecycle.startAllComponents();

      const healthReport = await lifecycle.checkAllHealth();
      expect(healthReport.healthy).toBe(true);
      expect(healthReport.components.length).toBe(3);

      for (const component of healthReport.components) {
        expect(component.healthy).toBe(true);
      }
    });

    test('should report degraded health when some components are unhealthy', async () => {
      const healthy = new ConfigurableHealthComponent(logger, 'healthy');
      const unhealthy = new ConfigurableHealthComponent(logger, 'unhealthy');

      await lifecycle.registerComponent(healthy);
      await lifecycle.registerComponent(unhealthy);

      await lifecycle.startAllComponents();

      // Make one component unhealthy
      unhealthy.healthy = false;

      const healthReport = await lifecycle.checkAllHealth();
      expect(healthReport.healthy).toBe(false);
      expect(healthReport.code).toBe('degraded');

      const healthyResult = healthReport.components.find((c) => c.name === 'healthy');
      expect(healthyResult?.healthy).toBe(true);

      const unhealthyResult = healthReport.components.find((c) => c.name === 'unhealthy');
      expect(unhealthyResult?.healthy).toBe(false);
    });

    test('should handle health check timeouts', async () => {
      const slow = new ConfigurableHealthComponent(logger, 'slow-health');
      slow.healthCheckDelay = 200; // Longer than the 100ms timeout

      await lifecycle.registerComponent(slow);
      await lifecycle.startAllComponents();

      const healthResult = await lifecycle.checkComponentHealth('slow-health');
      expect(healthResult.code).toBe('timeout');
      expect(healthResult.timedOut).toBe(true);
    });

    test('should handle health check errors', async () => {
      const errorComponent = new ConfigurableHealthComponent(logger, 'error-health');
      errorComponent.healthCheckError = new Error('Health check failed');

      await lifecycle.registerComponent(errorComponent);
      await lifecycle.startAllComponents();

      const healthResult = await lifecycle.checkComponentHealth('error-health');
      expect(healthResult.code).toBe('error');
      expect(healthResult.error).not.toBeNull();
    });
  });

  describe('Component Messaging', () => {
    test('should send messages between components', async () => {
      const sender = new TestComponent(logger, { name: 'sender' });
      const receiver = new MessagingComponent(logger, 'receiver');

      await lifecycle.registerComponent(sender);
      await lifecycle.registerComponent(receiver);

      await lifecycle.startAllComponents();

      const messageResult = await lifecycle.sendMessageToComponent('receiver', {
        action: 'ping',
      });

      expect(messageResult.sent).toBe(true);
      expect(messageResult.code).toBe('sent');
      expect(receiver.messages.length).toBe(1);
      expect(receiver.messages[0].payload).toEqual({ action: 'ping' });
      expect(receiver.messages[0].from).toBeNull(); // External sender
    });

    test('should broadcast messages to all running components', async () => {
      const receiver1 = new MessagingComponent(logger, 'receiver-1');
      const receiver2 = new MessagingComponent(logger, 'receiver-2');
      const noHandler = new TestComponent(logger, { name: 'no-handler' });

      await lifecycle.registerComponent(receiver1);
      await lifecycle.registerComponent(receiver2);
      await lifecycle.registerComponent(noHandler);

      await lifecycle.startAllComponents();

      const broadcastResults = await lifecycle.broadcastMessage({ type: 'broadcast' });

      expect(broadcastResults.length).toBe(3);

      const result1 = broadcastResults.find((r) => r.name === 'receiver-1');
      expect(result1?.sent).toBe(true);
      expect(receiver1.messages.length).toBe(1);

      const result2 = broadcastResults.find((r) => r.name === 'receiver-2');
      expect(result2?.sent).toBe(true);
      expect(receiver2.messages.length).toBe(1);

      const noHandlerResult = broadcastResults.find((r) => r.name === 'no-handler');
      expect(noHandlerResult?.code).toBe('no_handler');
    });

    test('should handle message errors gracefully', async () => {
      const errorReceiver = new MessagingComponent(logger, 'error-receiver');
      errorReceiver.messageError = new Error('Message handling failed');

      await lifecycle.registerComponent(errorReceiver);
      await lifecycle.startAllComponents();

      const messageResult = await lifecycle.sendMessageToComponent('error-receiver', {});

      // Message was "sent" (delivered to handler), but handler threw an error
      expect(messageResult.sent).toBe(true);
      expect(messageResult.code).toBe('error');
      expect(messageResult.error).not.toBeNull();
    });
  });

  describe('Value Sharing', () => {
    test('should get values from components', async () => {
      const database = new MockDatabaseComponent(logger);
      await lifecycle.registerComponent(database);
      await lifecycle.startAllComponents();

      const connectedResult = lifecycle.getValue<boolean>('database', 'connected');
      expect(connectedResult.found).toBe(true);
      expect(connectedResult.value).toBe(true);

      const countResult = lifecycle.getValue<number>('database', 'connectionCount');
      expect(countResult.found).toBe(true);
      expect(countResult.value).toBe(5);

      const unknownResult = lifecycle.getValue('database', 'unknown-key');
      expect(unknownResult.found).toBe(false);
    });

    test('should fail gracefully for non-existent components', () => {
      const result = lifecycle.getValue('non-existent', 'key');
      expect(result.found).toBe(false);
      expect(result.componentFound).toBe(false);
      expect(result.code).toBe('not_found');
    });

    test('should fail gracefully for stopped components', async () => {
      const database = new MockDatabaseComponent(logger);
      await lifecycle.registerComponent(database);
      // Don't start

      const result = lifecycle.getValue('database', 'connected');
      expect(result.found).toBe(false);
      expect(result.componentRunning).toBe(false);
      expect(result.code).toBe('not_running');
    });
  });

  describe('Dynamic Component Management', () => {
    test('should add and start components at runtime', async () => {
      const database = new MockDatabaseComponent(logger);
      await lifecycle.registerComponent(database);
      await lifecycle.startAllComponents();

      expect(lifecycle.getRunningComponentCount()).toBe(1);

      // Add a new component while running
      const cache = new MockCacheComponent(logger);
      await lifecycle.registerComponent(cache, { autoStart: true });

      // Wait for auto-start
      await sleep(50);

      expect(lifecycle.getRunningComponentCount()).toBe(2);
      expect(cache.connected).toBe(true);
    });

    test('should stop and unregister components at runtime', async () => {
      const database = new MockDatabaseComponent(logger);
      const cache = new MockCacheComponent(logger);

      await lifecycle.registerComponent(database);
      await lifecycle.registerComponent(cache);
      await lifecycle.startAllComponents();

      expect(lifecycle.getComponentCount()).toBe(2);

      // Stop and unregister cache
      const unregisterResult = await lifecycle.unregisterComponent('cache');
      expect(unregisterResult.success).toBe(true);
      expect(unregisterResult.wasStopped).toBe(true);

      expect(lifecycle.getComponentCount()).toBe(1);
      expect(lifecycle.hasComponent('cache')).toBe(false);
    });

    test('should restart individual components', async () => {
      const webServer = new MockWebServerComponent(logger, []);
      await lifecycle.registerComponent(webServer);
      await lifecycle.startAllComponents();

      expect(webServer.listening).toBe(true);

      const restartResult = await lifecycle.restartComponent('web-server');
      expect(restartResult.success).toBe(true);
      expect(webServer.listening).toBe(true);
    });
  });

  describe('Full Application Lifecycle', () => {
    test('should manage complete application lifecycle from start to restart to shutdown', async () => {
      // Create a realistic application stack
      const database = new MockDatabaseComponent(logger);
      const cache = new MockCacheComponent(logger, true); // Optional
      const webServer = new MockWebServerComponent(logger, ['database']);
      const api = new MockAPIComponent(logger, ['web-server']);
      const worker = new MockWorkerComponent(logger, 'worker', ['database']);

      // Register in random order
      await lifecycle.registerComponent(worker);
      await lifecycle.registerComponent(api);
      await lifecycle.registerComponent(webServer);
      await lifecycle.registerComponent(cache);
      await lifecycle.registerComponent(database);

      // Phase 1: Initial startup
      const startResult = await lifecycle.startAllComponents();
      expect(startResult.success).toBe(true);
      expect(lifecycle.getSystemState()).toBe('running');

      // Verify dependency order was respected
      expect(database.connected).toBe(true);
      expect(cache.connected).toBe(true);
      expect(webServer.listening).toBe(true);
      expect(api.ready).toBe(true);
      expect(worker.running).toBe(true);

      // Phase 2: Health check
      const healthReport = await lifecycle.checkAllHealth();
      expect(healthReport.healthy).toBe(true);

      // Phase 3: Reload signal
      const reloadResult = await lifecycle.triggerReload();
      expect(reloadResult.code).toBe('ok');
      expect(api.reloadCount).toBe(1);
      expect(webServer.listening).toBe(true); // Still running after reload

      // Phase 4: Component restart
      const restartResult = await lifecycle.restartComponent('worker');
      expect(restartResult.success).toBe(true);
      expect(worker.running).toBe(true);

      // Phase 5: Full restart
      const fullRestartResult = await lifecycle.restartAllComponents();
      expect(fullRestartResult.success).toBe(true);
      expect(lifecycle.getSystemState()).toBe('running');

      // All components should be running again
      expect(database.connected).toBe(true);
      expect(webServer.listening).toBe(true);
      expect(api.ready).toBe(true);

      // Phase 6: Graceful shutdown
      const stopResult = await lifecycle.stopAllComponents();
      expect(stopResult.success).toBe(true);
      // 'ready' means components are registered but not running (stopped)
      expect(lifecycle.getSystemState()).toBe('ready');

      // All components should be stopped
      expect(database.connected).toBe(false);
      expect(cache.connected).toBe(false);
      expect(webServer.listening).toBe(false);
      expect(api.ready).toBe(false);
      expect(worker.running).toBe(false);
    });
  });
});
