/**
 * Demo script for ProcessSignalManager
 * Shows how shutdown, reload, info, and debug callbacks work with signals and keypresses
 *
 * Run with: bun run scripts/demo-process-signal-manager.ts
 *
 * Note: Must run in foreground (not with &) for keyboard shortcuts to work!
 *
 * Try:
 * - Press Ctrl+C or Escape to trigger shutdown
 * - Press R (or r) to trigger reload
 * - Press I (or i) to show info/stats
 * - Press D (or d) to toggle debug mode
 * - Run `kill -HUP <pid>` from another terminal to trigger reload
 * - Run `kill -USR1 <pid>` from another terminal to show info
 * - Run `kill -USR2 <pid>` from another terminal to toggle debug
 * - Run `kill -TERM <pid>` from another terminal to trigger shutdown
 */

import { ProcessSignalManager } from '../src/lib/process-signal-manager';

console.log('='.repeat(60));
console.log('ProcessSignalManager Demo');
console.log('='.repeat(60));
console.log();
console.log(`Process ID: ${process.pid}`);
console.log();
console.log('Available actions:');
console.log('  Keyboard:');
console.log('    - Press Ctrl+C or Escape to trigger shutdown');
console.log('    - Press R (or r) to trigger reload');
console.log('    - Press I (or i) to show info/stats');
console.log('    - Press D (or d) to toggle debug mode');
console.log('  Signals (from another terminal):');
console.log(`    - kill -INT ${process.pid}  (SIGINT - shutdown)`);
console.log(`    - kill -TERM ${process.pid} (SIGTERM - shutdown)`);
console.log(`    - kill -TRAP ${process.pid} (SIGTRAP - shutdown)`);
console.log(`    - kill -HUP ${process.pid}  (SIGHUP - reload)`);
console.log(`    - kill -USR1 ${process.pid} (SIGUSR1 - info)`);
console.log(`    - kill -USR2 ${process.pid} (SIGUSR2 - debug)`);
console.log();
console.log('Waiting for events...');
console.log('='.repeat(60));
console.log();

let reloadCount = 0;
let infoCount = 0;
let debugCount = 0;
let isDebugMode = false;

const manager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log();
    console.log('🛑 SHUTDOWN TRIGGERED');
    console.log(`   Method: ${method}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    console.log();
    console.log('Performing graceful shutdown...');

    // Note: In a real application, you would:
    // - Close database connections
    // - Wait for in-flight requests to complete
    // - Save state to disk
    // - Notify other services
    // - Then call process.exit(0)

    console.log('Goodbye! 👋');
    console.log();

    // Clean up and exit
    manager.detach();
    process.exit(0);
  },
  onReloadRequested: () => {
    reloadCount++;
    console.log();
    console.log('🔄 RELOAD TRIGGERED');
    console.log(`   Reload count: ${reloadCount}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    console.log();
    console.log('Configuration reloaded successfully! ✨');
    console.log('Still attached - waiting for more events...');
    console.log();
  },
  onInfoRequested: () => {
    infoCount++;
    console.log();
    console.log('ℹ️  INFO/STATS REQUESTED (SIGUSR1 / I key)');
    console.log(`   Info request count: ${infoCount}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    console.log();
    console.log('Current process stats:');
    console.log(`   Process ID: ${process.pid}`);
    console.log(`   Uptime: ${process.uptime().toFixed(2)}s`);
    console.log(
      `   Memory usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`,
    );
    console.log(`   Reload count: ${reloadCount}`);
    console.log(`   Info count: ${infoCount}`);
    console.log(`   Debug count: ${debugCount}`);
    console.log(`   Debug mode: ${isDebugMode ? 'ON' : 'OFF'}`);
    console.log();
    console.log('Still attached - waiting for more events...');
    console.log();
  },
  onDebugRequested: () => {
    debugCount++;
    isDebugMode = !isDebugMode;
    console.log();
    console.log('🐛 DEBUG MODE TOGGLED (SIGUSR2 / D key)');
    console.log(`   Debug count: ${debugCount}`);
    console.log(`   Debug mode: ${isDebugMode ? 'ON ✅' : 'OFF ❌'}`);
    console.log(`   Timestamp: ${new Date().toISOString()}`);
    console.log();

    if (isDebugMode) {
      console.log('Verbose logging enabled!');
      console.log('Full process state:');
      const status = manager.getStatus();
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log('Verbose logging disabled!');
    }

    console.log();
    console.log('Still attached - waiting for more events...');
    console.log();
  },
});

// Attach signal handlers
manager.attach();

// Show status
const status = manager.getStatus();
console.log('Manager Status:');
console.log('  Attached:', status.isAttached);
console.log('  Handlers registered:', {
  shutdown: status.handlers.shutdown,
  reload: status.handlers.reload,
  info: status.handlers.info,
  debug: status.handlers.debug,
});
console.log('  Attached to:', {
  shutdownSignals: status.listeningFor.shutdownSignals,
  reloadSignal: status.listeningFor.reloadSignal,
  infoSignal: status.listeningFor.infoSignal,
  debugSignal: status.listeningFor.debugSignal,
  keypresses: status.listeningFor.keypresses,
});
console.log();

// Show TTY status
if (process.stdin.isTTY) {
  console.log('✅ TTY detected - keyboard shortcuts enabled');
} else {
  console.log(
    '⚠️  No TTY - keyboard shortcuts unavailable (signal handling still works)',
  );
}
console.log();

// Keep the process alive
console.log('Process running... (waiting for signals/keypresses)');
console.log();

// Keep alive interval (prevents process from exiting)
const keepAliveInterval = setInterval(() => {
  // Just to keep process running
}, 1000);

// Clean up interval on shutdown (though we exit anyway)
process.on('exit', () => {
  clearInterval(keepAliveInterval);
});
