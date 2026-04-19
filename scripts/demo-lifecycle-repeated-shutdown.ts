/**
 * Demo script for LifecycleManager repeated shutdown escalation.
 *
 * Run with: bun run scripts/demo-lifecycle-repeated-shutdown.ts
 *
 * Interactive flow:
 * - Press Escape or Ctrl+C once to begin graceful shutdown
 * - The component intentionally stalls during stop()
 * - Then press Escape or Ctrl+C three more times within 2 seconds to trigger onForceShutdown()
 *
 * Notes:
 * - LifecycleManager uses ProcessSignalManager shutdown shortcuts, so both
 *   Escape and Ctrl+C route through the same shutdown path as SIGINT.
 * - Run in the foreground so keyboard shortcuts are available.
 */

import { Logger, ConsoleSink } from '../src/lib/logger';
import { BaseComponent, LifecycleManager } from '../src/lib/lifecycle-manager';

class StalledShutdownComponent extends BaseComponent {
  constructor(logger: Logger) {
    super(logger, {
      name: 'stalled-worker',
      shutdownGracefulTimeoutMS: 5000,
      shutdownForceTimeoutMS: 500,
    });
  }

  public start(): void {
    console.log('[component] started');
  }

  public async stop(): Promise<void> {
    console.log(
      '[component] stop() called - intentionally stalling forever to simulate a hung shutdown',
    );

    await new Promise<void>(() => {
      // Intentionally never resolves.
    });
  }
}

const logger = new Logger({
  sinks: [new ConsoleSink()],
  callProcessExit: false,
});

const lifecycle = new LifecycleManager({
  logger,
  name: 'repeated-shutdown-demo',
  shutdownOptions: {
    timeoutMS: 15000,
    haltOnStall: false,
    retryStalled: false,
  },
  repeatedShutdownRequestPolicy: {
    forceAfterCount: 3,
    withinMS: 2000,
    onForceShutdown: (context) => {
      console.log();
      console.log('='.repeat(60));
      console.log('FORCE SHUTDOWN HOOK FIRED');
      console.log('='.repeat(60));
      console.log(`requestCount: ${context.requestCount}`);
      console.log(`firstMethod: ${context.firstMethod}`);
      console.log(`latestMethod: ${context.latestMethod}`);
      console.log(
        `elapsedSinceFirstShutdownRequestMS: ${context.latestRequestAt - context.firstRequestAt}`,
      );
      console.log('The application decides what to do here.');
      console.log('This demo exits immediately with code 99.');
      console.log();

      lifecycle.detachSignals();
      process.exit(99);
    },
  },
});

console.log('='.repeat(60));
console.log('LifecycleManager Repeated Shutdown Demo');
console.log('='.repeat(60));
console.log(`PID: ${process.pid}`);
console.log();
console.log('Try this:');
console.log('  1. Press Escape or Ctrl+C once');
console.log('  2. Wait for the graceful shutdown to stall');
console.log(
  '  3. Then press Escape or Ctrl+C three more times within 2 seconds',
);
console.log();
console.log('Expected result:');
console.log('  - First Escape starts graceful shutdown');
console.log('  - The component hangs in stop()');
console.log(
  '  - The first shutdown request does not count toward the force threshold',
);
console.log('  - Three more quick shutdown requests trigger onForceShutdown()');
console.log();

if (!process.stdin.isTTY) {
  console.log(
    'No TTY detected. Keyboard shortcuts are unavailable in this session.',
  );
  console.log(
    'Run this script in the foreground terminal to try Escape or Ctrl+C.',
  );
  process.exit(1);
}

await lifecycle.registerComponent(new StalledShutdownComponent(logger));
await lifecycle.startAllComponents();
lifeCycleSetup();

function lifeCycleSetup(): void {
  lifecycle.attachSignals();

  console.log('Signals attached. Waiting for Escape or Ctrl+C...');
  console.log();
}
