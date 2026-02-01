/**
 * Simple LifecycleManager Demo
 *
 * Demonstrates:
 * - Basic component start/stop
 * - Dependencies
 * - Graceful shutdown
 * - Signal handling
 * - Logger exit hook integration
 */

import { Logger, ConsoleSink } from '../../logger';
import { sleep } from '../../sleep';
import { LifecycleManager, BaseComponent } from '../index';
import type { LifecycleManagerEventMap } from '../events';

// Simple database component
class DatabaseComponent extends BaseComponent {
  private connected = false;

  constructor(logger: Logger) {
    super(logger, { name: 'database' });
  }

  public async start() {
    this.logger.info('Connecting to database...');
    await sleep(500);
    this.connected = true;
    this.logger.success('Database connected');
  }

  public async stop() {
    this.logger.info('Closing database...');
    await sleep(200);
    this.connected = false;
    this.logger.success('Database closed');
  }

  public onShutdownWarning(): void {
    this.logger.warn('Shutdown warning - preparing to close');
  }

  public healthCheck() {
    return {
      healthy: this.connected,
      message: this.connected ? 'Connected' : 'Disconnected',
    };
  }
}

// API component that depends on database
class APIComponent extends BaseComponent {
  private running = false;

  constructor(logger: Logger) {
    super(logger, {
      name: 'api',
      dependencies: ['database'], // Starts after database
    });
  }

  public async start() {
    this.logger.info('Starting API server...');
    await sleep(300);
    this.running = true;
    this.logger.success('API server started on port 3000');
  }

  public async stop() {
    this.logger.info('Stopping API server...');
    await sleep(200);
    this.running = false;
    this.logger.success('API server stopped');
  }

  public onReload(): void {
    this.logger.info('Reloading API configuration');
  }
}

// Main
async function main() {
  const logger = new Logger();

  // Add console sink so logs are visible
  logger.addSink(new ConsoleSink());

  logger.info('=== LifecycleManager Simple Demo ===\n');

  // Create lifecycle manager with logger exit hook integration
  // This allows logger.exit() or logger.error('msg', { exitCode: 1 }) to trigger graceful shutdown
  const lifecycle = new LifecycleManager({
    name: 'demo',
    logger,
    enableLoggerExitHook: true, // Enables graceful shutdown on logger.exit()
    shutdownOptions: { timeoutMS: 30000 }, // Max 30s for shutdown before process exits
  });

  // Listen to events
  lifecycle.on(
    'component:started',
    (data: LifecycleManagerEventMap['component:started']) => {
      logger.success(`✓ ${data.name} started`);
    },
  );

  lifecycle.on(
    'component:stopped',
    (data: LifecycleManagerEventMap['component:stopped']) => {
      logger.info(`✓ ${data.name} stopped`);
    },
  );

  lifecycle.on('lifecycle-manager:shutdown-completed', () => {
    logger.success('Shutdown complete');
    process.exit(0);
  });

  // Register components
  await lifecycle.registerComponent(new DatabaseComponent(logger));
  await lifecycle.registerComponent(new APIComponent(logger));

  // Validate dependencies
  const validation = lifecycle.validateDependencies();

  if (!validation.valid) {
    logger.error('Invalid dependencies!');
    process.exit(1);
  }

  const orderResult = lifecycle.getStartupOrder();

  if (orderResult.success) {
    logger.info(`Startup order: ${orderResult.startupOrder.join(' → ')}\n`);
  }

  // Start all
  const result = await lifecycle.startAllComponents();
  if (!result.success) {
    logger.error('Startup failed');
    process.exit(1);
  }

  logger.success(`\nAll components started!\n`);

  // Check health
  const health = await lifecycle.checkAllHealth();
  logger.info(`Health: ${health.healthy ? 'HEALTHY ✓' : 'UNHEALTHY ✗'}`);
  for (const component of health.components) {
    logger.info(`  ${component.name}: ${component.message}`);
  }

  // Attach signals
  lifecycle.attachSignals();

  logger.info('\n=== Demo Running ===');
  logger.info('Press Ctrl+C to trigger graceful shutdown');
  logger.info('Press R to trigger reload\n');

  // Note: With enableLoggerExitHook enabled, fatal errors will also trigger graceful shutdown:
  // logger.error('Database connection lost', { exitCode: 1 });
  // This would gracefully stop all components before exiting with code 1
}

main().catch((error: unknown) => {
  const logger = new Logger();
  const message = error instanceof Error ? error.message : String(error);
  logger.error(`Failed: ${message}`);
  process.exit(1);
});
