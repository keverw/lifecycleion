import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { ProcessSignalManager } from './process-signal-manager';
import { sleep } from './sleep';

describe('ProcessSignalManager', () => {
  let manager: ProcessSignalManager;
  let shutdownCallback: ReturnType<typeof mock>;
  let reloadCallback: ReturnType<typeof mock>;
  let infoCallback: ReturnType<typeof mock>;
  let debugCallback: ReturnType<typeof mock>;

  beforeEach(() => {
    shutdownCallback = mock(() => {});
    reloadCallback = mock(() => {});
    infoCallback = mock(() => {});
    debugCallback = mock(() => {});
  });

  afterEach(() => {
    if (manager) {
      manager.detach();
    }
  });

  describe('constructor', () => {
    test('creates instance with no callbacks', () => {
      manager = new ProcessSignalManager({});

      // Verify internal state
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onShutdownRequested).toBeUndefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onReloadRequested).toBeUndefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownSignalListeners).toBeUndefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.reloadSignalListener).toBeUndefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownCallbackName).toBe('onShutdownRequested');
      // @ts-expect-error - Accessing private property for testing
      expect(manager.reloadCallbackName).toBe('onReloadRequested');
    });

    test('creates instance with shutdown callback only', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      // Verify internal state
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onShutdownRequested).toBe(shutdownCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onReloadRequested).toBeUndefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownSignalListeners).toBeDefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownSignalListeners.SIGINT).toBeInstanceOf(Function);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownSignalListeners.SIGTERM).toBeInstanceOf(Function);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownSignalListeners.SIGTRAP).toBeInstanceOf(Function);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.reloadSignalListener).toBeUndefined();
    });

    test('creates instance with reload callback only', () => {
      manager = new ProcessSignalManager({
        onReloadRequested: reloadCallback,
      });

      // Verify internal state
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onShutdownRequested).toBeUndefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onReloadRequested).toBe(reloadCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownSignalListeners).toBeUndefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.reloadSignalListener).toBeDefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.reloadSignalListener).toBeInstanceOf(Function);
    });

    test('creates instance with both shutdown and reload callbacks', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });

      // Verify internal state
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onShutdownRequested).toBe(shutdownCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onReloadRequested).toBe(reloadCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownSignalListeners).toBeDefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.reloadSignalListener).toBeDefined();
    });

    test('creates instance with info callback', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: infoCallback,
      });

      // Verify internal state
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onInfoRequested).toBe(infoCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.infoSignalListener).toBeDefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.infoSignalListener).toBeInstanceOf(Function);
    });

    test('creates instance with debug callback', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: debugCallback,
      });

      // Verify internal state
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onDebugRequested).toBe(debugCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.debugSignalListener).toBeDefined();
      // @ts-expect-error - Accessing private property for testing
      expect(manager.debugSignalListener).toBeInstanceOf(Function);
    });

    test('creates instance with custom callback names', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
        onInfoRequested: infoCallback,
        onDebugRequested: debugCallback,
        shutdownCallbackName: 'customShutdown',
        reloadCallbackName: 'customReload',
        infoCallbackName: 'customInfo',
        debugCallbackName: 'customDebug',
      });

      // Verify internal state
      // @ts-expect-error - Accessing private property for testing
      expect(manager.shutdownCallbackName).toBe('customShutdown');
      // @ts-expect-error - Accessing private property for testing
      expect(manager.reloadCallbackName).toBe('customReload');
      // @ts-expect-error - Accessing private property for testing
      expect(manager.infoCallbackName).toBe('customInfo');
      // @ts-expect-error - Accessing private property for testing
      expect(manager.debugCallbackName).toBe('customDebug');
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onShutdownRequested).toBe(shutdownCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onReloadRequested).toBe(reloadCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onInfoRequested).toBe(infoCallback);
      // @ts-expect-error - Accessing private property for testing
      expect(manager.onDebugRequested).toBe(debugCallback);
    });
  });

  describe('triggerShutdown', () => {
    test('triggers shutdown callback when attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();
      manager.triggerShutdown('SIGINT');

      expect(shutdownCallback).toHaveBeenCalledWith('SIGINT');
    });

    test('does not trigger shutdown callback when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.triggerShutdown('SIGINT');

      expect(shutdownCallback).not.toHaveBeenCalled();
    });

    test('does not error when no shutdown callback is registered', () => {
      manager = new ProcessSignalManager({});
      manager.attach();

      expect(() => manager.triggerShutdown('SIGINT')).not.toThrow();
    });

    test('can bypass attach check to trigger shutdown when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      // Without bypass - should not trigger
      manager.triggerShutdown('SIGINT');
      expect(shutdownCallback).not.toHaveBeenCalled();

      // With bypass - should trigger
      manager.triggerShutdown('SIGTERM', true);
      expect(shutdownCallback).toHaveBeenCalledWith('SIGTERM');
    });

    test('bypass attach check works with async shutdown callback', async () => {
      let asyncValue = 0;
      const asyncCallback = mock(async () => {
        await sleep(10);
        asyncValue = 123;
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: asyncCallback,
      });

      // Trigger with bypass
      manager.triggerShutdown('SIGTRAP', true);

      // Wait for async callback
      await sleep(20);

      expect(asyncCallback).toHaveBeenCalledWith('SIGTRAP');
      expect(asyncValue).toBe(123);
    });

    test('triggers shutdown with different methods', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();

      manager.triggerShutdown('SIGINT');
      manager.triggerShutdown('SIGTERM');
      manager.triggerShutdown('SIGTRAP');

      expect(shutdownCallback).toHaveBeenCalledWith('SIGINT');
      expect(shutdownCallback).toHaveBeenCalledWith('SIGTERM');
      expect(shutdownCallback).toHaveBeenCalledWith('SIGTRAP');
    });

    test('handles async shutdown callback', async () => {
      let asyncValue = 0;
      const asyncCallback = mock(async () => {
        await sleep(10);
        asyncValue = 42;
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: asyncCallback,
      });
      manager.attach();
      manager.triggerShutdown('SIGINT');

      // Wait for async callback
      await sleep(20);

      expect(asyncCallback).toHaveBeenCalledWith('SIGINT');
      expect(asyncValue).toBe(42);
    });
  });

  describe('triggerInfo', () => {
    test('triggers info callback when attached and callback is registered', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: infoCallback,
      });
      manager.attach();
      manager.triggerInfo();

      expect(infoCallback).toHaveBeenCalled();
    });

    test('does not trigger info callback when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: infoCallback,
      });
      manager.triggerInfo();

      expect(infoCallback).not.toHaveBeenCalled();
    });

    test('does not error when info callback is not registered', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();

      expect(() => manager.triggerInfo()).not.toThrow();
      expect(infoCallback).not.toHaveBeenCalled();
    });

    test('handles async info callback', async () => {
      let asyncValue = 0;
      const asyncInfoCallback = mock(async () => {
        await sleep(10);
        asyncValue = 777;
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: asyncInfoCallback,
      });
      manager.attach();
      manager.triggerInfo();

      // Wait for async callback
      await sleep(20);

      expect(asyncInfoCallback).toHaveBeenCalled();
      expect(asyncValue).toBe(777);
    });

    test('can bypass attach check to trigger info when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: infoCallback,
      });

      // Without bypass - should not trigger
      manager.triggerInfo();
      expect(infoCallback).not.toHaveBeenCalled();

      // With bypass - should trigger
      manager.triggerInfo(true);
      expect(infoCallback).toHaveBeenCalled();
    });
  });

  describe('triggerDebug', () => {
    test('triggers debug callback when attached and callback is registered', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: debugCallback,
      });
      manager.attach();
      manager.triggerDebug();

      expect(debugCallback).toHaveBeenCalled();
    });

    test('does not trigger debug callback when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: debugCallback,
      });
      manager.triggerDebug();

      expect(debugCallback).not.toHaveBeenCalled();
    });

    test('does not error when debug callback is not registered', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();

      expect(() => manager.triggerDebug()).not.toThrow();
      expect(debugCallback).not.toHaveBeenCalled();
    });

    test('handles async debug callback', async () => {
      let asyncValue = 0;
      const asyncDebugCallback = mock(async () => {
        await sleep(10);
        asyncValue = 888;
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: asyncDebugCallback,
      });
      manager.attach();
      manager.triggerDebug();

      // Wait for async callback
      await sleep(20);

      expect(asyncDebugCallback).toHaveBeenCalled();
      expect(asyncValue).toBe(888);
    });

    test('can bypass attach check to trigger debug when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: debugCallback,
      });

      // Without bypass - should not trigger
      manager.triggerDebug();
      expect(debugCallback).not.toHaveBeenCalled();

      // With bypass - should trigger
      manager.triggerDebug(true);
      expect(debugCallback).toHaveBeenCalled();
    });
  });

  describe('triggerReload', () => {
    test('triggers reload callback when attached and callback is registered', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });
      manager.attach();
      manager.triggerReload();

      expect(reloadCallback).toHaveBeenCalled();
    });

    test('does not trigger reload callback when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });
      manager.triggerReload();

      expect(reloadCallback).not.toHaveBeenCalled();
    });

    test('does not error when reload callback is not registered', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();

      expect(() => manager.triggerReload()).not.toThrow();
      expect(reloadCallback).not.toHaveBeenCalled();
    });

    test('handles async reload callback', async () => {
      let asyncValue = 0;
      const asyncReloadCallback = mock(async () => {
        await sleep(10);
        asyncValue = 99;
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: asyncReloadCallback,
      });
      manager.attach();
      manager.triggerReload();

      // Wait for async callback
      await sleep(20);

      expect(asyncReloadCallback).toHaveBeenCalled();
      expect(asyncValue).toBe(99);
    });

    test('can bypass attach check to trigger reload when not attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });

      // Without bypass - should not trigger
      manager.triggerReload();
      expect(reloadCallback).not.toHaveBeenCalled();

      // With bypass - should trigger
      manager.triggerReload(true);
      expect(reloadCallback).toHaveBeenCalled();
    });

    test('bypass attach check works with async reload callback', async () => {
      let asyncValue = 0;
      const asyncReloadCallback = mock(async () => {
        await sleep(10);
        asyncValue = 456;
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: asyncReloadCallback,
      });

      // Trigger with bypass
      manager.triggerReload(true);

      // Wait for async callback
      await sleep(20);

      expect(asyncReloadCallback).toHaveBeenCalled();
      expect(asyncValue).toBe(456);
    });
  });

  describe('attach and detach', () => {
    test('isAttached returns correct state', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      expect(manager.isAttached).toBe(false);

      manager.attach();
      expect(manager.isAttached).toBe(true);

      manager.detach();
      expect(manager.isAttached).toBe(false);
    });

    test('getStatus returns detailed information', () => {
      // Mock TTY mode for this test
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
          onReloadRequested: reloadCallback,
          onInfoRequested: infoCallback,
          onDebugRequested: debugCallback,
        });

        // Before listening
        let status = manager.getStatus();
        expect(status.isAttached).toBe(false);
        expect(status.handlers.shutdown).toBe(true);
        expect(status.handlers.reload).toBe(true);
        expect(status.handlers.info).toBe(true);
        expect(status.handlers.debug).toBe(true);
        expect(status.listeningFor.shutdownSignals).toBe(false);
        expect(status.listeningFor.reloadSignal).toBe(false);
        expect(status.listeningFor.infoSignal).toBe(false);
        expect(status.listeningFor.debugSignal).toBe(false);
        expect(status.listeningFor.keypresses).toBe(false);

        // While listening
        manager.attach();
        status = manager.getStatus();
        expect(status.isAttached).toBe(true);
        expect(status.handlers.shutdown).toBe(true);
        expect(status.handlers.reload).toBe(true);
        expect(status.handlers.info).toBe(true);
        expect(status.handlers.debug).toBe(true);
        expect(status.listeningFor.shutdownSignals).toBe(true);
        expect(status.listeningFor.reloadSignal).toBe(true);
        expect(status.listeningFor.infoSignal).toBe(true);
        expect(status.listeningFor.debugSignal).toBe(true);
        expect(status.listeningFor.keypresses).toBe(true);

        // After stopping
        manager.detach();
        status = manager.getStatus();
        expect(status.isAttached).toBe(false);
        expect(status.handlers.shutdown).toBe(true);
        expect(status.handlers.reload).toBe(true);
        expect(status.handlers.info).toBe(true);
        expect(status.handlers.debug).toBe(true);
        expect(status.listeningFor.shutdownSignals).toBe(false);
        expect(status.listeningFor.reloadSignal).toBe(false);
        expect(status.listeningFor.infoSignal).toBe(false);
        expect(status.listeningFor.debugSignal).toBe(false);
        expect(status.listeningFor.keypresses).toBe(false);
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('getStatus shows correct handlers for shutdown-only manager', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      const status = manager.getStatus();
      expect(status.handlers.shutdown).toBe(true);
      expect(status.handlers.reload).toBe(false);
    });

    test('getStatus shows correct handlers for reload-only manager', () => {
      manager = new ProcessSignalManager({
        onReloadRequested: reloadCallback,
      });

      const status = manager.getStatus();
      expect(status.handlers.shutdown).toBe(false);
      expect(status.handlers.reload).toBe(true);
      expect(status.handlers.info).toBe(false);
    });

    test('getStatus shows correct handlers for info-only manager', () => {
      manager = new ProcessSignalManager({
        onInfoRequested: infoCallback,
      });

      const status = manager.getStatus();
      expect(status.handlers.shutdown).toBe(false);
      expect(status.handlers.reload).toBe(false);
      expect(status.handlers.info).toBe(true);
      expect(status.handlers.debug).toBe(false);
    });

    test('getStatus shows correct handlers for debug-only manager', () => {
      manager = new ProcessSignalManager({
        onDebugRequested: debugCallback,
      });

      const status = manager.getStatus();
      expect(status.handlers.shutdown).toBe(false);
      expect(status.handlers.reload).toBe(false);
      expect(status.handlers.info).toBe(false);
      expect(status.handlers.debug).toBe(true);
    });

    test('getStatus shows no handlers for empty manager', () => {
      manager = new ProcessSignalManager({});

      const status = manager.getStatus();
      expect(status.handlers.shutdown).toBe(false);
      expect(status.handlers.reload).toBe(false);
      expect(status.handlers.info).toBe(false);
      expect(status.handlers.debug).toBe(false);
    });

    test('attach enables event handling', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();
      manager.triggerShutdown('SIGINT');

      expect(shutdownCallback).toHaveBeenCalledWith('SIGINT');
    });

    test('detach disables event handling', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();
      manager.detach();
      manager.triggerShutdown('SIGINT');

      expect(shutdownCallback).not.toHaveBeenCalled();
    });

    test('calling attach multiple times is idempotent', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();
      manager.attach();
      manager.attach();
      manager.triggerShutdown('SIGINT');

      // Should only be called once, not three times
      expect(shutdownCallback.mock.calls.length).toBe(1);
    });

    test('calling detach multiple times is idempotent', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();
      manager.detach();
      manager.detach();
      manager.detach();

      expect(() => manager.detach()).not.toThrow();
    });

    test('can re-attach after detaching', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      manager.attach();
      manager.triggerShutdown('SIGINT');
      manager.detach();

      shutdownCallback.mockClear();

      manager.attach();
      manager.triggerShutdown('SIGTERM');

      expect(shutdownCallback).toHaveBeenCalledWith('SIGTERM');
      expect(shutdownCallback.mock.calls.length).toBe(1);
    });
  });

  describe('process signal handling', () => {
    test('registers signal listeners when attached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      const initialListenerCount = process.listenerCount('SIGINT');

      manager.attach();
      const afterListenCount = process.listenerCount('SIGINT');

      expect(afterListenCount).toBeGreaterThan(initialListenerCount);

      manager.detach();
    });

    test('removes signal listeners when detached', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();
      const listeningCount = process.listenerCount('SIGINT');

      manager.detach();
      const stoppedCount = process.listenerCount('SIGINT');

      expect(stoppedCount).toBeLessThan(listeningCount);
    });

    test('registers listeners for all shutdown signals', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      const initialSIGINT = process.listenerCount('SIGINT');
      const initialSIGTERM = process.listenerCount('SIGTERM');
      const initialSIGTRAP = process.listenerCount('SIGTRAP');

      manager.attach();

      expect(process.listenerCount('SIGINT')).toBeGreaterThan(initialSIGINT);
      expect(process.listenerCount('SIGTERM')).toBeGreaterThan(initialSIGTERM);
      expect(process.listenerCount('SIGTRAP')).toBeGreaterThan(initialSIGTRAP);

      manager.detach();
    });

    test('registers listener for SIGHUP when reload callback is provided', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });

      const initialSIGHUP = process.listenerCount('SIGHUP');

      manager.attach();

      expect(process.listenerCount('SIGHUP')).toBeGreaterThan(initialSIGHUP);

      manager.detach();
    });

    test('does not register SIGHUP listener when no reload callback', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      const initialSIGHUP = process.listenerCount('SIGHUP');

      manager.attach();

      expect(process.listenerCount('SIGHUP')).toBe(initialSIGHUP);

      manager.detach();
    });

    test('does not register shutdown listeners when no shutdown callback', () => {
      manager = new ProcessSignalManager({
        onReloadRequested: reloadCallback,
      });

      const initialSIGINT = process.listenerCount('SIGINT');
      const initialSIGTERM = process.listenerCount('SIGTERM');
      const initialSIGTRAP = process.listenerCount('SIGTRAP');

      manager.attach();

      expect(process.listenerCount('SIGINT')).toBe(initialSIGINT);
      expect(process.listenerCount('SIGTERM')).toBe(initialSIGTERM);
      expect(process.listenerCount('SIGTRAP')).toBe(initialSIGTRAP);

      manager.detach();
    });

    test('does not register any listeners when no callbacks provided', () => {
      manager = new ProcessSignalManager({});

      const initialSIGINT = process.listenerCount('SIGINT');
      const initialSIGTERM = process.listenerCount('SIGTERM');
      const initialSIGTRAP = process.listenerCount('SIGTRAP');
      const initialSIGHUP = process.listenerCount('SIGHUP');

      manager.attach();

      expect(process.listenerCount('SIGINT')).toBe(initialSIGINT);
      expect(process.listenerCount('SIGTERM')).toBe(initialSIGTERM);
      expect(process.listenerCount('SIGTRAP')).toBe(initialSIGTRAP);
      expect(process.listenerCount('SIGHUP')).toBe(initialSIGHUP);

      manager.detach();
    });

    test('handles actual SIGINT signal', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();

      // Emit the signal
      process.emit('SIGINT', 'SIGINT');

      // Give time for callback to execute
      await sleep(5);

      expect(shutdownCallback).toHaveBeenCalledWith('SIGINT');
      manager.detach();
    });

    test('handles actual SIGTERM signal', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();

      // Emit the signal
      process.emit('SIGTERM', 'SIGTERM');

      // Give time for callback to execute
      await sleep(5);

      expect(shutdownCallback).toHaveBeenCalledWith('SIGTERM');
      manager.detach();
    });

    test('handles actual SIGTRAP signal', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      manager.attach();

      // Emit the signal
      process.emit('SIGTRAP', 'SIGTRAP');

      // Give time for callback to execute
      await sleep(5);

      expect(shutdownCallback).toHaveBeenCalledWith('SIGTRAP');
      manager.detach();
    });

    test('handles actual SIGHUP signal for reload', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });
      manager.attach();

      // Emit the signal
      process.emit('SIGHUP', 'SIGHUP');

      // Give time for callback to execute
      await sleep(5);

      expect(reloadCallback).toHaveBeenCalled();
      manager.detach();
    });

    test('handles actual SIGUSR1 signal for info', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: infoCallback,
      });
      manager.attach();

      // Emit the signal
      process.emit('SIGUSR1', 'SIGUSR1');

      // Give time for callback to execute
      await sleep(5);

      expect(infoCallback).toHaveBeenCalled();
      manager.detach();
    });

    test('handles actual SIGUSR2 signal for debug', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: debugCallback,
      });
      manager.attach();

      // Emit the signal
      process.emit('SIGUSR2', 'SIGUSR2');

      // Give time for callback to execute
      await sleep(5);

      expect(debugCallback).toHaveBeenCalled();
      manager.detach();
    });

    test('registers listener for SIGUSR1 when info callback is provided', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: infoCallback,
      });

      const initialSIGUSR1 = process.listenerCount('SIGUSR1');

      manager.attach();

      expect(process.listenerCount('SIGUSR1')).toBeGreaterThan(initialSIGUSR1);

      manager.detach();
    });

    test('registers listener for SIGUSR2 when debug callback is provided', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: debugCallback,
      });

      const initialSIGUSR2 = process.listenerCount('SIGUSR2');

      manager.attach();

      expect(process.listenerCount('SIGUSR2')).toBeGreaterThan(initialSIGUSR2);

      manager.detach();
    });

    test('does not register SIGUSR1 listener when no info callback', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      const initialSIGUSR1 = process.listenerCount('SIGUSR1');

      manager.attach();

      expect(process.listenerCount('SIGUSR1')).toBe(initialSIGUSR1);

      manager.detach();
    });

    test('does not register SIGUSR2 listener when no debug callback', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });

      const initialSIGUSR2 = process.listenerCount('SIGUSR2');

      manager.attach();

      expect(process.listenerCount('SIGUSR2')).toBe(initialSIGUSR2);

      manager.detach();
    });
  });

  describe('keyboard event handling', () => {
    test('handles Ctrl+C keypress', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();

        // Simulate Ctrl+C keypress
        process.stdin.emit('keypress', '', { ctrl: true, name: 'c' });

        // Give time for callback to execute
        await sleep(5);

        expect(shutdownCallback).toHaveBeenCalledWith('SIGINT');
        manager.detach();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('handles Escape keypress', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();

        // Simulate Escape keypress
        process.stdin.emit('keypress', '', { name: 'escape' });

        // Give time for callback to execute
        await sleep(5);

        expect(shutdownCallback).toHaveBeenCalledWith('SIGINT');
        manager.detach();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('handles R keypress for reload', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
          onReloadRequested: reloadCallback,
        });
        manager.attach();

        // Simulate R keypress
        process.stdin.emit('keypress', 'r', { name: 'r' });

        // Give time for callback to execute
        await sleep(5);

        expect(reloadCallback).toHaveBeenCalled();
        manager.detach();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('ignores R keypress when no reload callback registered', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();

        // Simulate R keypress
        process.stdin.emit('keypress', 'r', { name: 'r' });

        // Give time for callback to execute
        await sleep(5);

        // Should not crash, reload callback just wasn't called
        expect(shutdownCallback).not.toHaveBeenCalled();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('handles I keypress for info', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
          onInfoRequested: infoCallback,
        });
        manager.attach();

        // Simulate I keypress
        process.stdin.emit('keypress', 'i', { name: 'i' });

        // Give time for callback to execute
        await sleep(5);

        expect(infoCallback).toHaveBeenCalled();
        manager.detach();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('handles D keypress for debug', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
          onDebugRequested: debugCallback,
        });
        manager.attach();

        // Simulate D keypress
        process.stdin.emit('keypress', 'd', { name: 'd' });

        // Give time for callback to execute
        await sleep(5);

        expect(debugCallback).toHaveBeenCalled();
        manager.detach();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('ignores I keypress when no info callback registered', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();

        // Simulate I keypress
        process.stdin.emit('keypress', 'i', { name: 'i' });

        // Give time for callback to execute
        await sleep(5);

        // Should not crash, info callback just wasn't called
        expect(infoCallback).not.toHaveBeenCalled();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('ignores D keypress when no debug callback registered', async () => {
      // Mock TTY mode
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;

      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});

      try {
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();

        // Simulate D keypress
        process.stdin.emit('keypress', 'd', { name: 'd' });

        // Give time for callback to execute
        await sleep(5);

        // Should not crash, debug callback just wasn't called
        expect(debugCallback).not.toHaveBeenCalled();
      } finally {
        // Restore original values
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });
  });

  describe('error handling', () => {
    test('handles error in shutdown callback gracefully', () => {
      const errorCallback = mock(() => {
        throw new Error('Test error');
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: errorCallback,
      });
      manager.attach();

      // Should not throw
      expect(() => manager.triggerShutdown('SIGINT')).not.toThrow();
      expect(errorCallback).toHaveBeenCalled();
    });

    test('handles error in async shutdown callback gracefully', async () => {
      const errorCallback = mock(async () => {
        await sleep(5);
        throw new Error('Async test error');
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: errorCallback,
      });
      manager.attach();

      // Should not throw
      expect(() => manager.triggerShutdown('SIGINT')).not.toThrow();
      expect(errorCallback).toHaveBeenCalled();

      // Wait for async error handling
      await sleep(10);
    });

    test('handles error in reload callback gracefully', () => {
      const errorReloadCallback = mock(() => {
        throw new Error('Reload error');
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: errorReloadCallback,
      });
      manager.attach();

      // Should not throw
      expect(() => manager.triggerReload()).not.toThrow();
      expect(errorReloadCallback).toHaveBeenCalled();
    });

    test('handles error in info callback gracefully', () => {
      const errorInfoCallback = mock(() => {
        throw new Error('Info error');
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: errorInfoCallback,
      });
      manager.attach();

      // Should not throw
      expect(() => manager.triggerInfo()).not.toThrow();
      expect(errorInfoCallback).toHaveBeenCalled();
    });

    test('handles error in async info callback gracefully', async () => {
      const errorInfoCallback = mock(async () => {
        await sleep(5);
        throw new Error('Async info error');
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onInfoRequested: errorInfoCallback,
      });
      manager.attach();

      // Should not throw
      expect(() => manager.triggerInfo()).not.toThrow();
      expect(errorInfoCallback).toHaveBeenCalled();

      // Wait for async error handling
      await sleep(10);
    });

    test('handles error in debug callback gracefully', () => {
      const errorDebugCallback = mock(() => {
        throw new Error('Debug error');
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: errorDebugCallback,
      });
      manager.attach();

      // Should not throw
      expect(() => manager.triggerDebug()).not.toThrow();
      expect(errorDebugCallback).toHaveBeenCalled();
    });

    test('handles error in async debug callback gracefully', async () => {
      const errorDebugCallback = mock(async () => {
        await sleep(5);
        throw new Error('Async debug error');
      });

      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onDebugRequested: errorDebugCallback,
      });
      manager.attach();

      // Should not throw
      expect(() => manager.triggerDebug()).not.toThrow();
      expect(errorDebugCallback).toHaveBeenCalled();

      // Wait for async error handling
      await sleep(10);
    });
  });
});
