/**
 * Demo script showing multiple ProcessSignalManager instances coexisting
 *
 * This demonstrates that multiple instances can attach/detach independently
 * without breaking each other's functionality.
 *
 * Run with: bun run scripts/demo-multiple-instances.ts
 */

import { ProcessSignalManager } from '../src/lib/process-signal-manager';

console.log('='.repeat(60));
console.log('Multiple ProcessSignalManager Instances Demo');
console.log('='.repeat(60));
console.log();

let dbShutdownCalled = false;
let serverShutdownCalled = false;

// Instance 1: Database manager
const dbManager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log(`[DB Manager] Shutdown requested via ${method}`);
    console.log('[DB Manager] Closing database connections...');
    dbShutdownCalled = true;
  },
  onInfoRequested: () => {
    console.log('[DB Manager] Database stats:');
    console.log('  - Active connections: 5');
    console.log('  - Query queue size: 12');
  },
});

// Instance 2: HTTP Server manager
const serverManager = new ProcessSignalManager({
  onShutdownRequested: (method) => {
    console.log(`[HTTP Server] Shutdown requested via ${method}`);
    console.log('[HTTP Server] Closing server and active connections...');
    serverShutdownCalled = true;
  },
  onInfoRequested: () => {
    console.log('[HTTP Server] Server stats:');
    console.log('  - Active requests: 3');
    console.log('  - Uptime: 42s');
  },
});

console.log('Attaching both managers...');
dbManager.attach();
serverManager.attach();

console.log(`DB Manager attached: ${dbManager.isAttached}`);
console.log(`Server Manager attached: ${serverManager.isAttached}`);
console.log();

// Test 1: Both instances receive info trigger
console.log('Test 1: Triggering info on both managers');
console.log('-'.repeat(60));
dbManager.triggerInfo();
serverManager.triggerInfo();
console.log();

// Test 2: Detach one instance, other should still work
console.log('Test 2: Detaching DB Manager');
console.log('-'.repeat(60));
dbManager.detach();
console.log(`DB Manager attached: ${dbManager.isAttached}`);
console.log(`Server Manager attached: ${serverManager.isAttached}`);
console.log();

// Test 3: Remaining instance still works
console.log('Test 3: Triggering info again - only server should respond');
console.log('-'.repeat(60));
dbManager.triggerInfo(); // Should do nothing (detached)
serverManager.triggerInfo(); // Should work
console.log();

// Test 4: Re-attach the first instance
console.log('Test 4: Re-attaching DB Manager');
console.log('-'.repeat(60));
dbManager.attach();
console.log(`DB Manager attached: ${dbManager.isAttached}`);
console.log(`Server Manager attached: ${serverManager.isAttached}`);
console.log();

// Test 5: Both instances receive shutdown trigger
console.log('Test 5: Triggering shutdown on both managers');
console.log('-'.repeat(60));
dbManager.triggerShutdown('SIGTERM');
serverManager.triggerShutdown('SIGTERM');
console.log();

// Verify both received the signal
console.log('Results:');
console.log(`  DB Manager shutdown called: ${dbShutdownCalled}`);
console.log(`  Server Manager shutdown called: ${serverShutdownCalled}`);
console.log();

// Cleanup
console.log('Cleaning up...');
dbManager.detach();
serverManager.detach();

console.log('='.repeat(60));
console.log('Demo complete!');
console.log();
console.log('Key takeaways:');
console.log('  ✅ Multiple instances can coexist');
console.log('  ✅ All instances receive the same signals');
console.log('  ✅ Instances can attach/detach independently');
console.log('  ✅ stdin/raw mode properly coordinated');
console.log('='.repeat(60));
