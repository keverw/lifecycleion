import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import {
  muteConsoleError,
  restoreConsoleError,
} from './internal/console-test-utils';
import { reportToConsole } from './internal/report-to-console';
import { ProcessSignalManager } from './process-signal-manager';
import readline from 'readline';
import { sleep } from './sleep';

// These suites deliberately drive the paths that fall through to `console.error` when
// nothing claims the report. Captured rather than printed so a real failure in the run
// output still stands out; flip `DEBUG` in the helper to see them.
beforeEach(() => {
  muteConsoleError();
});

afterEach(() => {
  restoreConsoleError();
});

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
    test.each([null, undefined])(
      'nullish throttle %s uses the default',
      (keypressThrottleMS) => {
        manager = new ProcessSignalManager({ keypressThrottleMS });
        expect(
          (manager as unknown as { keypressThrottleMS: number })
            .keypressThrottleMS,
        ).toBe(200);
      },
    );

    test('rejects invalid throttles and caps Infinity', () => {
      for (const keypressThrottleMS of [NaN, -1, '200' as unknown as number]) {
        expect(
          () => new ProcessSignalManager({ keypressThrottleMS }),
        ).toThrow();
      }
      manager = new ProcessSignalManager({ keypressThrottleMS: Infinity });
      const internal = manager as unknown as { keypressThrottleMS: number };
      expect(internal.keypressThrottleMS).toBe(2_147_483_647);
    });

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

    test('an attach from a process newListener listener inside attach() registers nothing twice', () => {
      // Caller code runs inside attach() - here a 'newListener' listener - and an attach
      // from there must not register this instance's listeners again under the first.
      const before = process.listenerCount('SIGTERM');
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      let nestedCalls = 0;
      const onNewListener = (): void => {
        nestedCalls += 1;
        manager.attach();
      };
      process.on('newListener', onNewListener);

      try {
        manager.attach();
      } finally {
        process.off('newListener', onNewListener);
      }

      expect(nestedCalls).toBeGreaterThan(0);
      expect(manager.isAttached).toBe(true);
      expect(process.listenerCount('SIGTERM')).toBe(before + 1);

      manager.triggerShutdown('SIGTERM');
      expect(shutdownCallback).toHaveBeenCalledTimes(1);

      manager.detach();
      expect(process.listenerCount('SIGTERM')).toBe(before);
    });

    test('a detach from a process newListener listener inside attach() runs once the attach finishes', () => {
      const before = process.listenerCount('SIGTERM');
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      const onNewListener = (): void => {
        manager.detach();
      };
      process.on('newListener', onNewListener);

      try {
        manager.attach();
      } finally {
        process.off('newListener', onNewListener);
      }

      expect(manager.isAttached).toBe(false);
      expect(process.listenerCount('SIGTERM')).toBe(before);
    });

    test('a deferred detach that fails is reported, not thrown out of the attach that ran it', () => {
      // The attach did what it was asked and has returned to its caller by the time the
      // detach asked for inside it runs, so that detach's failure is reported instead.
      const before = process.listeners('SIGTERM');
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
      });
      const removalError = new Error('off failed');
      const originalOff = process.off.bind(process);
      let hasRefused = false;
      const offSpy = spyOn(process, 'off').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        if (event === 'SIGTERM' && !hasRefused) {
          hasRefused = true;
          throw removalError;
        }
        originalOff(event, listener);
        return process;
      }) as typeof process.off);
      const onNewListener = (): void => {
        manager.detach();
      };
      const reports: unknown[] = [];
      const onGlobalError = (event: Event): void => {
        reports.push((event as ErrorEvent).error);
        event.preventDefault();
      };
      globalThis.addEventListener('error', onGlobalError);
      process.on('newListener', onNewListener);

      try {
        expect(() => manager.attach()).not.toThrow();
      } finally {
        process.off('newListener', onNewListener);
        globalThis.removeEventListener('error', onGlobalError);
        offSpy.mockRestore();
        // The listener whose removal was refused is still on `process`.
        for (const listener of process.listeners('SIGTERM')) {
          if (!before.includes(listener)) {
            process.off('SIGTERM', listener);
          }
        }
      }

      expect(hasRefused).toBe(true);
      expect(manager.isAttached).toBe(false);
      expect(reports).toHaveLength(1);
      expect((reports[0] as Error).message).toContain(
        'ProcessSignalManager deferred detach',
      );
      expect((reports[0] as Error).cause).toBe(removalError);
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
    test('an Infinity throttle suppresses repeats until the capped window expires', async () => {
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
          onReloadRequested: reloadCallback,
          keypressThrottleMS: Infinity,
        });
        manager.attach();
        process.stdin.emit('keypress', 'r', { name: 'r' });
        const internal = manager as unknown as {
          lastActionTimes: { reload: number };
        };
        internal.lastActionTimes.reload = Date.now() - 201;
        process.stdin.emit('keypress', 'r', { name: 'r' });
        await sleep(1);
        expect(reloadCallback).toHaveBeenCalledTimes(1);
        internal.lastActionTimes.reload = Date.now() - 2_147_483_647;
        process.stdin.emit('keypress', 'r', { name: 'r' });
        await sleep(1);
        expect(reloadCallback).toHaveBeenCalledTimes(2);
      } finally {
        manager.detach();
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test('an emitKeypressEvents that throws is called again by the next attach', () => {
      const wasTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;
      const stateKey = Symbol.for('lifecycleion.ProcessSignalManager.v1');
      const globals = globalThis as any;
      const savedState = globals[stateKey];
      const shared = {
        keypressEventsEmittedOnStdin: false,
        attachedInstances: new Set<string>(),
        rawModeOwner: null,
        rawModeEnabledByManager: false,
      };
      globals[stateKey] = shared;
      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});
      const emitFailure = new Error('emitKeypressEvents failed');
      const emitSpy = spyOn(readline, 'emitKeypressEvents').mockImplementation(
        () => {
          throw emitFailure;
        },
      );

      try {
        manager = new ProcessSignalManager({
          onReloadRequested: reloadCallback,
          keypressThrottleMS: 0,
        });
        expect(() => manager.attach()).toThrow(emitFailure);
        expect(manager.isAttached).toBe(false);
        // The flag was set before the call, so the next attach skipped it and listened
        // for keypresses nothing would ever emit.
        expect(shared.keypressEventsEmittedOnStdin).toBe(false);

        emitSpy.mockImplementation(() => {});
        manager.attach();
        expect(emitSpy).toHaveBeenCalledTimes(2);
        expect(shared.keypressEventsEmittedOnStdin).toBe(true);
      } finally {
        manager.detach();
        emitSpy.mockRestore();
        globals[stateKey] = savedState;
        (process.stdin as any).isTTY = wasTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

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

    test('forwards Ctrl+C to SIGINT when a TTY manager has no shutdown callback', () => {
      const wasOriginallyTTY = process.stdin.isTTY;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;
      (process.stdin as any).isTTY = true;
      (process.stdin as any).setRawMode = mock(() => {});
      (process.stdin as any).pause = mock(() => {});
      const killSpy = spyOn(process, 'kill').mockImplementation(() => true);

      try {
        manager = new ProcessSignalManager({ onReloadRequested: () => {} });
        manager.attach();

        process.stdin.emit('keypress', '', { ctrl: true, name: 'c' });

        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGINT');
      } finally {
        manager.detach();
        killSpy.mockRestore();
        (process.stdin as any).isTTY = wasOriginallyTTY;
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
      }
    });

    test.each([true, false])(
      'coordinates Ctrl+C with legacy copies (legacy first=%p)',
      (isLegacyFirst) => {
        const wasTTY = process.stdin.isTTY;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const savedSetRawMode = process.stdin.setRawMode;
        // eslint-disable-next-line @typescript-eslint/unbound-method
        const savedPause = process.stdin.pause;
        const stateKey = Symbol.for('lifecycleion.ProcessSignalManager.v1');
        const globals = globalThis as any;
        const savedState = globals[stateKey];
        // The exact old shared-state shape deliberately has no forwarding capability set.
        const shared = {
          keypressEventsEmittedOnStdin: true,
          attachedInstances: new Set<string>(),
          rawModeOwner: null,
          rawModeEnabledByManager: false,
        };
        globals[stateKey] = shared;
        (process.stdin as any).isTTY = true;
        (process.stdin as any).setRawMode = mock(() => {});
        (process.stdin as any).pause = mock(() => {});
        const oldShutdown = mock(() => {});
        const oldKeypress = (_text: string, key: any) => {
          if (key.ctrl && key.name === 'c') {
            oldShutdown();
          }
        };
        const external = mock(() => {});
        const currentShutdown = mock(() => {});
        const secondShutdown = mock(() => {});
        manager = new ProcessSignalManager({
          onShutdownRequested: currentShutdown,
          keypressThrottleMS: 0,
        });
        const second = new ProcessSignalManager({
          onShutdownRequested: secondShutdown,
          keypressThrottleMS: 0,
        });
        const attachOld = () => {
          shared.attachedInstances.add('legacy-instance');
          process.on('SIGINT', oldShutdown);
          process.stdin.on('keypress', oldKeypress);
        };
        try {
          if (isLegacyFirst) {
            attachOld();
          }
          manager.attach();
          if (!isLegacyFirst) {
            attachOld();
          }
          second.attach();
          process.on('SIGINT', external);
          process.stdin.emit('keypress', '', { ctrl: true, name: 'c' });
          expect(oldShutdown).toHaveBeenCalledTimes(1);
          expect(currentShutdown).toHaveBeenCalledTimes(1);
          expect(secondShutdown).toHaveBeenCalledTimes(1);
          expect(external).not.toHaveBeenCalled();

          shared.attachedInstances.delete('legacy-instance');
          process.off('SIGINT', oldShutdown);
          process.stdin.off('keypress', oldKeypress);
          process.stdin.emit('keypress', '', { ctrl: true, name: 'c' });
          expect(currentShutdown).toHaveBeenCalledTimes(2);
          expect(secondShutdown).toHaveBeenCalledTimes(2);
          expect(external).toHaveBeenCalledTimes(1);
        } finally {
          shared.attachedInstances.delete('legacy-instance');
          process.off('SIGINT', oldShutdown);
          process.off('SIGINT', external);
          process.stdin.off('keypress', oldKeypress);
          manager.detach();
          second.detach();
          expect((shared as any).sigintForwardingInstances.size).toBe(0);
          globals[stateKey] = savedState;
          (process.stdin as any).isTTY = wasTTY;
          (process.stdin as any).setRawMode = savedSetRawMode;
          (process.stdin as any).pause = savedPause;
        }
      },
    );

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

  describe('raw mode restore failure', () => {
    const SHARED_STATE_KEY = Symbol.for('lifecycleion.ProcessSignalManager.v1');

    interface SharedState {
      attachedInstances: Set<string>;
      rawModeOwner: string | null;
      rawModeEnabledByManager: boolean;
    }

    function readShared(): SharedState | undefined {
      return (globalThis as unknown as Record<symbol, SharedState | undefined>)[
        SHARED_STATE_KEY
      ];
    }

    function resetShared(): void {
      const shared = readShared();

      // Created lazily by the first manager, so there is nothing to reset before one.
      if (shared === undefined) {
        return;
      }

      shared.attachedInstances.clear();
      shared.rawModeOwner = null;
      shared.rawModeEnabledByManager = false;
    }

    test('a detach whose setRawMode(false) throws reports it and keeps ownership so a later instance can retry', async () => {
      // A terminal left in raw mode is the user's shell broken, and this said nothing
      // about it. Reported on the global `'error'` channel, with the shared state left in
      // the shape a later `attach()` can adopt and repair from.
      const wasOriginallyTTY = process.stdin.isTTY;
      const wasOriginallyRaw = (process.stdin as any).isRaw;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedResume = process.stdin.resume;

      let isRaw = false;
      let shouldFailDisable = true;

      (process.stdin as any).isTTY = true;
      Object.defineProperty(process.stdin, 'isRaw', {
        configurable: true,
        get: () => isRaw,
      });
      (process.stdin as any).setRawMode = mock((enableRaw: boolean) => {
        if (!enableRaw && shouldFailDisable) {
          throw new Error('tty refused');
        }

        isRaw = enableRaw;
      });
      (process.stdin as any).pause = mock(() => {});
      (process.stdin as any).resume = mock(() => {});

      const events: ErrorEvent[] = [];
      const onGlobalError = (event: Event): void => {
        events.push(event as ErrorEvent);
        event.preventDefault();
      };

      globalThis.addEventListener('error', onGlobalError);

      try {
        resetShared();

        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();

        expect(isRaw).toBe(true);

        manager.detach();

        // Reported before detach() returns, as its last step: a caller that exits right
        // after it - a shutdown-completed listener calling process.exit(), which does not
        // drain microtasks - must not lose the one report that its terminal is broken.
        expect(events).toHaveLength(1);
        expect((events[0]?.error as Error).message).toContain(
          'stdin raw mode restore',
        );
        expect(((events[0]?.error as Error).cause as Error).message).toBe(
          'tty refused',
        );

        // Nothing attached, raw mode still ours, and an owner left on record: exactly
        // what a later instance needs to adopt ownership and try again.
        const shared = readShared();

        expect(shared?.attachedInstances.size).toBe(0);
        expect(shared?.rawModeEnabledByManager).toBe(true);
        expect(shared?.rawModeOwner).not.toBeNull();
        expect(isRaw).toBe(true);

        // A later instance adopts and, with a working tty, restores the terminal.
        shouldFailDisable = false;

        const later = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });

        later.attach();
        later.detach();
        await Promise.resolve();

        expect(isRaw).toBe(false);
        expect(readShared()?.rawModeEnabledByManager).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(events).toHaveLength(1);
      } finally {
        globalThis.removeEventListener('error', onGlobalError);
        resetShared();
        (process.stdin as any).isTTY = wasOriginallyTTY;
        Object.defineProperty(process.stdin, 'isRaw', {
          configurable: true,
          writable: true,
          value: wasOriginallyRaw,
        });
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
        (process.stdin as any).resume = savedResume;
      }
    });

    test('an attach() from inside the restore report does not have stdin paused under it by the detach that raised it', async () => {
      // The restore report is the detach's last step, after it has paused stdin, so a
      // listener that answers a broken restore by attaching a fresh instance does so
      // over a finished detach, and its own attach resumes it.
      const wasOriginallyTTY = process.stdin.isTTY;
      const wasOriginallyRaw = (process.stdin as any).isRaw;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedResume = process.stdin.resume;

      let isRaw = false;
      let shouldFailDisable = true;

      (process.stdin as any).isTTY = true;
      Object.defineProperty(process.stdin, 'isRaw', {
        configurable: true,
        get: () => isRaw,
      });
      (process.stdin as any).setRawMode = mock((enableRaw: boolean) => {
        if (!enableRaw && shouldFailDisable) {
          throw new Error('tty refused');
        }

        isRaw = enableRaw;
      });
      const stdinCalls: string[] = [];
      const pause = mock(() => {
        stdinCalls.push('pause');
      });
      (process.stdin as any).pause = pause;
      (process.stdin as any).resume = mock(() => {
        stdinCalls.push('resume');
      });

      let replacement: ProcessSignalManager | undefined;
      const events: ErrorEvent[] = [];
      const onGlobalError = (event: Event): void => {
        events.push(event as ErrorEvent);
        event.preventDefault();

        if (
          replacement === undefined &&
          ((event as ErrorEvent).error as Error).message.includes(
            'stdin raw mode restore',
          )
        ) {
          replacement = new ProcessSignalManager({
            onShutdownRequested: shutdownCallback,
          });
          replacement.attach();
        }
      };

      globalThis.addEventListener('error', onGlobalError);

      try {
        resetShared();

        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        manager.detach();

        expect(events).toHaveLength(1);
        expect(manager.isAttached).toBe(false);
        expect(replacement?.getStatus().isAttached).toBe(true);
        expect(readShared()?.attachedInstances.size).toBe(1);
        // The detach finished - and paused stdin - before the replacement attached, and
        // the replacement's attach resumed it: stdin is running for the instance on it.
        expect(stdinCalls).toEqual(['resume', 'pause', 'resume']);
        // And the replacement adopted the raw-mode ownership the failed restore left.
        expect(readShared()?.rawModeEnabledByManager).toBe(true);
        expect(
          readShared()?.attachedInstances.has(readShared()?.rawModeOwner ?? ''),
        ).toBe(true);

        shouldFailDisable = false;
        replacement?.detach();
        await Promise.resolve();

        expect(isRaw).toBe(false);
        expect(pause).toHaveBeenCalledTimes(2);
        expect(readShared()?.attachedInstances.size).toBe(0);
        expect(events).toHaveLength(1);
      } finally {
        globalThis.removeEventListener('error', onGlobalError);
        resetShared();
        (process.stdin as any).isTTY = wasOriginallyTTY;
        Object.defineProperty(process.stdin, 'isRaw', {
          configurable: true,
          writable: true,
          value: wasOriginallyRaw,
        });
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
        (process.stdin as any).resume = savedResume;
      }
    });

    function mockRawTTY(
      onDisable: () => void,
      onEnable: () => void = () => {},
    ): {
      stdinCalls: string[];
      restore: () => void;
    } {
      const wasOriginallyTTY = process.stdin.isTTY;
      const wasOriginallyRaw = (process.stdin as any).isRaw;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedResume = process.stdin.resume;
      let isRaw = false;
      const stdinCalls: string[] = [];

      (process.stdin as any).isTTY = true;
      Object.defineProperty(process.stdin, 'isRaw', {
        configurable: true,
        get: () => isRaw,
      });
      (process.stdin as any).setRawMode = mock((enableRaw: boolean) => {
        if (enableRaw) {
          onEnable();
        } else {
          onDisable();
        }
        isRaw = enableRaw;
      });
      (process.stdin as any).pause = mock(() => {
        stdinCalls.push('pause');
      });
      (process.stdin as any).resume = mock(() => {
        stdinCalls.push('resume');
      });

      return {
        stdinCalls,
        restore: () => {
          resetShared();
          (process.stdin as any).isTTY = wasOriginallyTTY;
          Object.defineProperty(process.stdin, 'isRaw', {
            configurable: true,
            writable: true,
            value: wasOriginallyRaw,
          });
          (process.stdin as any).setRawMode = savedSetRawMode;
          (process.stdin as any).pause = savedPause;
          (process.stdin as any).resume = savedResume;
        },
      };
    }

    test('a throwing detach reports its raw-mode restore failure before the throw and its listener cleanup failures after', async () => {
      // The first listener failure is the one thrown. The broken terminal is reported
      // before that throw, as a failed attach() reports it: a caller that exits from its
      // catch - try { detach() } catch { process.exit(1) } - never drains a microtask.
      // The later listener failures still wait until the throw has reached the caller.
      let shouldFailDisable = true;
      const tty = mockRawTTY(() => {
        if (shouldFailDisable) {
          throw new Error('tty refused');
        }
      });
      const reports: Error[] = [];
      const onGlobalError = (event: Event): void => {
        reports.push((event as ErrorEvent).error as Error);
        event.preventDefault();
      };
      globalThis.addEventListener('error', onGlobalError);

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
          onReloadRequested: reloadCallback,
        });
        manager.attach();

        // Each removal still happens; it just also reports a failure.
        const originalOff = process.off.bind(process);
        const offSpy = spyOn(process, 'off').mockImplementation(((
          event: string,
          listener: (...args: unknown[]) => void,
        ) => {
          originalOff(event, listener);
          throw new Error(`off ${event} failed`);
        }) as typeof process.off);

        let reportsAtThrow: string[] = [];
        try {
          expect(() => {
            try {
              manager.detach();
            } finally {
              reportsAtThrow = reports.map((report) => report.message);
            }
          }).toThrow('off SIGINT failed');
        } finally {
          offSpy.mockRestore();
        }
        expect(reportsAtThrow).toEqual([
          'Error in a callback ProcessSignalManager stdin raw mode restore',
        ]);
        expect((reports[0]?.cause as Error).message).toBe('tty refused');
        expect(manager.isAttached).toBe(false);

        await Promise.resolve();

        const later = reports.slice(1);
        expect(later.length).toBeGreaterThan(0);
        for (const report of later) {
          expect(report.message).toContain(
            'ProcessSignalManager listener cleanup',
          );
        }
        expect((later.at(-1)?.cause as Error).message).toBe(
          'off SIGHUP failed',
        );
      } finally {
        shouldFailDisable = false;
        globalThis.removeEventListener('error', onGlobalError);
        tty.restore();
      }
    });

    test('an attach from inside setRawMode(false) does not have stdin paused under it', () => {
      // A caller's stdin 'error' listener runs inside a failed `setRawMode()` (see the
      // next test); the mock attaches directly. An attach from there returns
      // into `restoreStdin` after its `isLastInstance` read, and only the live re-check
      // of the attached set keeps the pause from landing under that new instance.
      let replacement: ProcessSignalManager | undefined;
      const tty = mockRawTTY(() => {
        if (replacement === undefined) {
          replacement = new ProcessSignalManager({
            onShutdownRequested: shutdownCallback,
          });
          replacement.attach();
        }
      });

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        manager.detach();

        expect(replacement?.getStatus().isAttached).toBe(true);
        expect(readShared()?.attachedInstances.size).toBe(1);
        // Resumed by the first attach, resumed again by the replacement, never paused.
        expect(tty.stdinCalls).toEqual(['resume', 'resume']);
        // The replacement adopted the raw mode being turned off; it is back on, owned.
        expect((process.stdin as any).isRaw).toBe(true);
        expect(readShared()?.rawModeEnabledByManager).toBe(true);
        expect(readShared()?.rawModeOwner).not.toBeNull();

        replacement?.detach();
        expect(tty.stdinCalls).toEqual(['resume', 'resume', 'pause']);
        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
      } finally {
        if (replacement?.isAttached) {
          replacement.detach();
        }
        tty.restore();
      }
    });

    test("an attach from a caller's stdin 'error' listener during a failed setRawMode(false) keeps its raw-mode claim", () => {
      // Node's and Bun's `setRawMode()` report a failed mode change by emitting 'error'
      // on stdin, synchronously, and leave `isRaw` as it was - so a caller's listener runs
      // inside the restore. An attach from it adopts the raw mode still on, and the
      // detach that was restoring must leave that claim alone rather than clear it.
      let replacement: ProcessSignalManager | undefined;
      let shouldFailDisable = true;
      const tty = mockRawTTY(() => {
        if (shouldFailDisable) {
          shouldFailDisable = false;
          process.stdin.emit('error', new Error('setRawMode failed'));
          throw new Error('setRawMode failed');
        }
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const failingSetRawMode = process.stdin.setRawMode;
      // Like the real one: a failure is emitted, not thrown, and `isRaw` is unchanged.
      (process.stdin as any).setRawMode = mock((enableRaw: boolean) => {
        try {
          failingSetRawMode.call(process.stdin, enableRaw);
        } catch {
          // Emitted above.
        }
        return process.stdin;
      });
      const onStdinError = (): void => {
        replacement ??= new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        replacement.attach();
      };
      process.stdin.on('error', onStdinError);

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        manager.detach();

        expect(replacement?.isAttached).toBe(true);
        expect(readShared()?.attachedInstances.size).toBe(1);
        expect(tty.stdinCalls).not.toContain('pause');
        expect((process.stdin as any).isRaw).toBe(true);
        expect(readShared()?.rawModeEnabledByManager).toBe(true);
        expect(attachedOwner()).not.toBeNull();

        // The claim it kept is what lets its own detach restore the terminal.
        replacement?.detach();
        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(tty.stdinCalls.at(-1)).toBe('pause');
      } finally {
        process.stdin.off('error', onStdinError);
        if (replacement?.isAttached) {
          replacement.detach();
        }
        tty.restore();
      }
    });

    /**
     * Route `setRawMode()` failures the way Node and Bun do: emitted on stdin as 'error',
     * not thrown, with `isRaw` left as it was. `shouldFail` picks the calls that fail.
     */
    function emitRawModeFailures(shouldFail: (enableRaw: boolean) => boolean): {
      restore: () => void;
    } {
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const mockedSetRawMode = process.stdin.setRawMode;
      (process.stdin as any).setRawMode = mock((enableRaw: boolean) => {
        if (shouldFail(enableRaw)) {
          process.stdin.emit('error', new Error('setRawMode failed'));
          return process.stdin;
        }

        return mockedSetRawMode.call(process.stdin, enableRaw);
      });
      return {
        restore: () => {
          (process.stdin as any).setRawMode = mockedSetRawMode;
        },
      };
    }

    test('a detach whose setRawMode(false) failure is emitted on stdin reports it and keeps ownership for a later instance', () => {
      // With an 'error' listener on stdin the failure is not thrown, and raw mode is
      // still on: a failed restore, reported as one, with the claim left for adoption.
      const tty = mockRawTTY(() => {});
      let shouldFailDisable = true;
      const emitted = emitRawModeFailures(
        (enableRaw) => !enableRaw && shouldFailDisable,
      );
      const stdinErrors: Error[] = [];
      const onStdinError = (error: Error): void => {
        stdinErrors.push(error);
      };
      process.stdin.on('error', onStdinError);
      const { reports, stop } = captureReports();

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        manager.detach();

        expect(stdinErrors).toHaveLength(1);
        expect(reports.map((report) => report.message)).toEqual([
          'Error in a callback ProcessSignalManager stdin raw mode restore',
        ]);
        expect((reports[0]?.cause as Error).message).toBe(
          'stdin raw mode is still enabled',
        );
        expect((process.stdin as any).isRaw).toBe(true);
        expect(readShared()?.attachedInstances.size).toBe(0);
        expect(readShared()?.rawModeEnabledByManager).toBe(true);
        expect(readShared()?.rawModeOwner).not.toBeNull();

        // A later instance adopts the claim and, with a working tty, restores it.
        shouldFailDisable = false;
        const later = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        later.attach();
        later.detach();

        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(false);
        expect(reports).toHaveLength(1);
      } finally {
        stop();
        process.stdin.off('error', onStdinError);
        emitted.restore();
        tty.restore();
      }
    });

    test('an attach whose setRawMode(true) failure is emitted on stdin fails and claims nothing', () => {
      const tty = mockRawTTY(() => {});
      const emitted = emitRawModeFailures((enableRaw) => enableRaw);
      const onStdinError = (): void => {};
      process.stdin.on('error', onStdinError);
      const keypressListeners = process.stdin.listenerCount('keypress');

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });

        expect(() => manager.attach()).toThrow(
          'stdin raw mode was not enabled',
        );
        expect(manager.isAttached).toBe(false);
        expect(manager.getStatus().listeningFor.keypresses).toBe(false);
        expect(process.stdin.listenerCount('keypress')).toBe(keypressListeners);
        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.attachedInstances.size).toBe(0);
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(false);
      } finally {
        process.stdin.off('error', onStdinError);
        emitted.restore();
        tty.restore();
      }
    });

    test("an attach from a stdin 'error' listener during this instance's own detach re-attaches it once the detach finishes", () => {
      // The failed setRawMode(false) runs the caller's listener inside detach(), while
      // this instance still reads as attached. Its attach must not be lost to that.
      const tty = mockRawTTY(() => {});
      let shouldFailDisable = true;
      const emitted = emitRawModeFailures(
        (enableRaw) => !enableRaw && shouldFailDisable,
      );
      const onStdinError = (): void => {
        manager.attach();
      };
      process.stdin.on('error', onStdinError);
      const sigtermListeners = process.listenerCount('SIGTERM');
      const { reports, stop } = captureReports();

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        manager.detach();

        expect(manager.isAttached).toBe(true);
        expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners + 1);
        expect(readShared()?.attachedInstances.size).toBe(1);
        expect((process.stdin as any).isRaw).toBe(true);
        expect(attachedOwner()).not.toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(true);
        expect(tty.stdinCalls.at(-1)).toBe('resume');
        expect(reports.map((report) => report.message)).toEqual([
          'Error in a callback ProcessSignalManager stdin raw mode restore',
        ]);

        // The claim it kept is what lets its next detach restore the terminal.
        shouldFailDisable = false;
        process.stdin.off('error', onStdinError);
        manager.detach();

        expect(manager.isAttached).toBe(false);
        expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners);
        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
      } finally {
        stop();
        process.stdin.off('error', onStdinError);
        emitted.restore();
        tty.restore();
      }
    });

    test('an attach from inside a failed attach rollback keeps its raw mode', () => {
      // The failed attach's own rollback turns raw mode off too. An attach from inside
      // that setRawMode(false) adopts the raw mode, and must not have it cleared.
      let replacement: ProcessSignalManager | undefined;
      const tty = mockRawTTY(() => {
        if (replacement === undefined) {
          replacement = new ProcessSignalManager({
            onShutdownRequested: shutdownCallback,
          });
          replacement.attach();
        }
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const mockedResume = process.stdin.resume;
      // Fail only the first attach's own resume, after it enabled raw mode. Keypress
      // setup can resume stdin earlier, and the replacement's resume must succeed.
      (process.stdin as any).resume = mock(() => {
        if (
          (process.stdin as any).isRaw === true &&
          replacement === undefined
        ) {
          throw new Error('resume failed');
        }

        return mockedResume.call(process.stdin);
      });

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        expect(() => manager.attach()).toThrow('resume failed');

        expect(replacement?.getStatus().isAttached).toBe(true);
        expect(readShared()?.attachedInstances.size).toBe(1);
        expect((process.stdin as any).isRaw).toBe(true);
        expect(readShared()?.rawModeEnabledByManager).toBe(true);
        expect(readShared()?.rawModeOwner).not.toBeNull();

        replacement?.detach();
        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
      } finally {
        if (replacement?.isAttached) {
          replacement.detach();
        }
        tty.restore();
      }
    });

    function captureReports(): { reports: Error[]; stop: () => void } {
      const reports: Error[] = [];
      const onGlobalError = (event: Event): void => {
        reports.push((event as ErrorEvent).error as Error);
        event.preventDefault();
      };
      globalThis.addEventListener('error', onGlobalError);
      return {
        reports,
        stop: () => globalThis.removeEventListener('error', onGlobalError),
      };
    }

    /** The recorded owner, if it is an attached instance - the only one when size is 1. */
    function attachedOwner(): string | null {
      const shared = readShared();
      const owner = shared?.rawModeOwner ?? null;
      return owner !== null && shared?.attachedInstances.has(owner) === true
        ? owner
        : null;
    }

    test('a detach whose re-enable for an attach from inside setRawMode(false) fails reports it as a re-enable', () => {
      // The attach adopts the raw mode being turned off, so the detach turns it back on
      // for that instance. When that throws, the report must say what failed - the
      // re-enable, not the restore, which succeeded - and the claim stays with the
      // instance that took over, for its own detach to settle.
      let replacement: ProcessSignalManager | undefined;
      const tty = mockRawTTY(
        () => {
          if (replacement === undefined) {
            replacement = new ProcessSignalManager({
              onShutdownRequested: shutdownCallback,
            });
            replacement.attach();
          }
        },
        () => {
          if (replacement !== undefined) {
            throw new Error('re-enable refused');
          }
        },
      );
      const { reports, stop } = captureReports();

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        manager.detach();

        expect(reports.map((report) => report.message)).toEqual([
          'Error in a callback ProcessSignalManager stdin raw mode re-enable',
        ]);
        expect((reports[0]?.cause as Error).message).toBe('re-enable refused');
        expect(replacement?.isAttached).toBe(true);
        expect(readShared()?.attachedInstances.size).toBe(1);
        expect(attachedOwner()).not.toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(true);
        expect((process.stdin as any).isRaw).toBe(false);

        replacement?.detach();
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(false);
        expect(reports).toHaveLength(1);
      } finally {
        stop();
        if (replacement?.isAttached) {
          replacement.detach();
        }
        tty.restore();
      }
    });

    test('an owner that detaches while another instance remains hands raw mode ownership over', () => {
      const tty = mockRawTTY(() => {});
      let second: ProcessSignalManager | undefined;

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        const owner = readShared()?.rawModeOwner;
        second = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        second.attach();
        expect(readShared()?.rawModeOwner).toBe(owner ?? null);

        manager.detach();

        expect(attachedOwner()).not.toBeNull();
        expect(attachedOwner()).not.toBe(owner ?? null);
        expect((process.stdin as any).isRaw).toBe(true);

        second.detach();

        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(false);
      } finally {
        if (second?.isAttached) {
          second.detach();
        }
        tty.restore();
      }
    });

    test('a failed raw-mode enable adopts a stale owner before restoring stdin', () => {
      const tty = mockRawTTY(() => {});
      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        manager.detach();
        const shared = readShared();
        if (shared === undefined) {
          throw new Error('shared state was not created');
        }
        shared.rawModeOwner = 'detached-instance';
        shared.rawModeEnabledByManager = true;
        Object.defineProperty(process.stdin, 'isRaw', {
          configurable: true,
          writable: true,
          value: false,
        });
        const disabled: boolean[] = [];
        process.stdin.setRawMode = mock((isEnabled: boolean) => {
          process.stdin.isRaw = isEnabled;
          if (isEnabled) {
            throw new Error('enable threw after changing raw mode');
          }
          disabled.push(isEnabled);
          return process.stdin;
        });
        expect(() => manager.attach()).toThrow('enable threw');
        expect(manager.isAttached).toBe(false);
        expect(process.stdin.isRaw).toBe(false);
        expect(disabled).toEqual([false]);
        expect(shared.rawModeOwner).toBeNull();
        expect(shared.rawModeEnabledByManager).toBe(false);
      } finally {
        tty.restore();
      }
    });

    test('a detach re-anchors raw mode ownership left on an instance that is no longer attached', () => {
      const tty = mockRawTTY(() => {});
      let second: ProcessSignalManager | undefined;

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        manager.attach();
        second = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        second.attach();

        const shared = readShared();
        if (shared === undefined) {
          throw new Error('shared state was not created');
        }
        shared.rawModeOwner = 'detached-instance';

        second.detach();

        // The one instance left now owns raw mode, so its detach restores the terminal.
        expect(readShared()?.attachedInstances.size).toBe(1);
        expect(attachedOwner()).not.toBeNull();

        manager.detach();

        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(false);
      } finally {
        if (second?.isAttached) {
          second.detach();
        }
        tty.restore();
      }
    });

    test('a failed attach whose rollback re-enable fails reports it once, as a re-enable', () => {
      // The same re-enable, reached from a failed attach's rollback. `attach()`'s catch
      // does not retry it - ownership went to the instance that attached - so the
      // rollback's failure is the one reported, before the attach error is thrown, as
      // every raw-mode failure from a failed attach is.
      let replacement: ProcessSignalManager | undefined;
      const tty = mockRawTTY(
        () => {
          if (replacement === undefined) {
            replacement = new ProcessSignalManager({
              onShutdownRequested: shutdownCallback,
            });
            replacement.attach();
          }
        },
        () => {
          if (replacement !== undefined) {
            throw new Error('re-enable refused');
          }
        },
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const mockedResume = process.stdin.resume;
      // Fail only the first attach's own resume, after it enabled raw mode.
      (process.stdin as any).resume = mock(() => {
        if (
          (process.stdin as any).isRaw === true &&
          replacement === undefined
        ) {
          throw new Error('resume failed');
        }

        return mockedResume.call(process.stdin);
      });
      const { reports, stop } = captureReports();

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        expect(() => manager.attach()).toThrow('resume failed');

        expect(reports.map((report) => report.message)).toEqual([
          'Error in a callback ProcessSignalManager stdin raw mode re-enable',
        ]);
        expect((reports[0]?.cause as Error).message).toBe('re-enable refused');
        expect(replacement?.isAttached).toBe(true);
        expect(readShared()?.attachedInstances.size).toBe(1);
        expect(attachedOwner()).not.toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(true);

        replacement?.detach();
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(reports).toHaveLength(1);
      } finally {
        stop();
        if (replacement?.isAttached) {
          replacement.detach();
        }
        tty.restore();
      }
    });

    test('a failed attach whose rollback restore fails once is not reported when the retry restores the terminal', async () => {
      // The rollback's failure is held, and `attach()`'s catch retries the same restore.
      // The retry worked, so the terminal is fine and there is nothing to report.
      const tty = mockRawTTY(() => {});
      let isRaw = false;
      let disableCalls = 0;
      Object.defineProperty(process.stdin, 'isRaw', {
        configurable: true,
        get: () => isRaw,
      });
      (process.stdin as any).setRawMode = mock((enableRaw: boolean) => {
        if (enableRaw) {
          // Enabled, then threw.
          isRaw = true;
          throw new Error('enable threw late');
        }

        disableCalls += 1;
        if (disableCalls === 1) {
          throw new Error('disable refused once');
        }

        isRaw = false;
      });
      const { reports, stop } = captureReports();

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        expect(() => manager.attach()).toThrow('enable threw late');
        await Promise.resolve();

        expect(disableCalls).toBe(2);
        expect(reports).toEqual([]);
        expect((process.stdin as any).isRaw).toBe(false);
        expect(readShared()?.rawModeOwner).toBeNull();
        expect(readShared()?.rawModeEnabledByManager).toBe(false);
      } finally {
        stop();
        tty.restore();
      }
    });

    test('a failed attach reports its raw-mode restore failure before throwing and its listener cleanup failures after', async () => {
      // A caller that exits from its catch never drains a microtask, so the broken
      // terminal is reported before the throw. Leaked listeners die with the process,
      // so those reports still wait until the attach error has reached its caller.
      const tty = mockRawTTY(() => {
        throw new Error('tty refused');
      });
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const mockedResume = process.stdin.resume;
      // Fail the attach's own resume, after it enabled raw mode.
      (process.stdin as any).resume = mock(() => {
        if ((process.stdin as any).isRaw === true) {
          throw new Error('resume failed');
        }

        return mockedResume.call(process.stdin);
      });
      const originalOff = process.off.bind(process);
      const offSpy = spyOn(process, 'off').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        originalOff(event, listener);
        throw new Error(`off ${event} failed`);
      }) as typeof process.off);
      const { reports, stop } = captureReports();

      try {
        resetShared();
        manager = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });
        let reportsAtThrow: string[] = [];
        try {
          manager.attach();
        } catch (error) {
          reportsAtThrow = reports.map((report) => report.message);
          expect((error as Error).message).toBe('resume failed');
        }
        offSpy.mockRestore();

        expect(reportsAtThrow).toEqual([
          'Error in a callback ProcessSignalManager stdin raw mode restore',
        ]);
        expect((reports[0]?.cause as Error).message).toBe('tty refused');

        await Promise.resolve();

        const later = reports.slice(1).map((report) => report.message);
        expect(later.length).toBeGreaterThan(1);
        expect(later[0]).toContain('ProcessSignalManager attach cleanup');
        for (const name of later.slice(1)) {
          expect(name).toContain('ProcessSignalManager listener cleanup');
        }
        expect(manager.isAttached).toBe(false);
      } finally {
        offSpy.mockRestore();
        stop();
        resetShared();
        tty.restore();
      }
    });

    test('a failed attach whose raw-mode rollback also fails reports before throwing, after the shared state is repaired', () => {
      // `setRawMode(true)` can throw after actually enabling raw mode, and the rollback's
      // own `setRawMode(false)` can fail too. The report is dispatched before the failed
      // attach throws - a caller that exits from its catch must not lose the one report
      // that its terminal is broken - and a listener that reads the shared state from
      // there must see it already repaired - an owner on record and the manager flag set
      // - rather than the half-way shape where nothing is attached and nothing can be
      // adopted.
      const wasOriginallyTTY = process.stdin.isTTY;
      const wasOriginallyRaw = (process.stdin as any).isRaw;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedSetRawMode = process.stdin.setRawMode;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedPause = process.stdin.pause;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const savedResume = process.stdin.resume;

      let isRaw = false;

      (process.stdin as any).isTTY = true;
      Object.defineProperty(process.stdin, 'isRaw', {
        configurable: true,
        get: () => isRaw,
      });
      (process.stdin as any).setRawMode = mock((enableRaw: boolean) => {
        if (enableRaw) {
          // Enabled, then threw.
          isRaw = true;
          throw new Error('enable threw late');
        }

        throw new Error('disable refused');
      });
      (process.stdin as any).pause = mock(() => {});
      (process.stdin as any).resume = mock(() => {});

      const seenDuringReport: Array<{
        message: string;
        owner: string | null;
        enabled: boolean;
        attached: number;
      }> = [];
      const onGlobalError = (event: Event): void => {
        const shared = readShared();

        seenDuringReport.push({
          message: String(((event as ErrorEvent).error as Error)?.message),
          owner: shared?.rawModeOwner ?? null,
          enabled: shared?.rawModeEnabledByManager ?? false,
          attached: shared?.attachedInstances.size ?? -1,
        });
        event.preventDefault();
      };

      globalThis.addEventListener('error', onGlobalError);

      try {
        resetShared();

        const failing = new ProcessSignalManager({
          onShutdownRequested: shutdownCallback,
        });

        // `process.exit()` from the catch does not drain microtasks, so the report
        // must already be out by the time the throw arrives.
        let reportsAtThrow = -1;
        try {
          failing.attach();
        } catch (error) {
          reportsAtThrow = seenDuringReport.length;
          expect((error as Error).message).toBe('enable threw late');
        }
        expect(reportsAtThrow).toBe(1);
        expect(failing.isAttached).toBe(false);

        // One report, not two: the rollback inside `listenForKeyPresses` tries the
        // restore and fails, and `attach`'s own catch runs `restoreStdin`, which retries
        // it. The retry's outcome is what the terminal is left in, so it replaces the
        // rollback's rather than reporting the same broken terminal twice. It must be
        // dispatched only after the shared state was repaired.
        expect(seenDuringReport.map((entry) => entry.message)).toEqual([
          'Error in a callback ProcessSignalManager stdin raw mode restore',
        ]);

        for (const seen of seenDuringReport) {
          expect(seen.attached).toBe(0);
          expect(seen.enabled).toBe(true);
          expect(seen.owner).not.toBeNull();
        }
      } finally {
        globalThis.removeEventListener('error', onGlobalError);
        resetShared();
        (process.stdin as any).isTTY = wasOriginallyTTY;
        Object.defineProperty(process.stdin, 'isRaw', {
          configurable: true,
          writable: true,
          value: wasOriginallyRaw,
        });
        (process.stdin as any).setRawMode = savedSetRawMode;
        (process.stdin as any).pause = savedPause;
        (process.stdin as any).resume = savedResume;
      }
    });
  });

  describe('error handling', () => {
    test('detach removes every listener when an earlier removal throws', () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
        onInfoRequested: infoCallback,
        onDebugRequested: debugCallback,
      });
      const counts = (): number[] =>
        ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2'].map((signal) =>
          process.listenerCount(signal),
        );
      const before = counts();
      manager.attach();

      const originalOff = process.off.bind(process);
      const failure = new Error('off failed');
      let hasThrown = false;
      const offSpy = spyOn(process, 'off').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        originalOff(event, listener);
        if (event === 'SIGINT' && !hasThrown) {
          hasThrown = true;
          throw failure;
        }
        return process;
      }) as typeof process.off);

      try {
        expect(() => manager.detach()).toThrow(failure);
      } finally {
        offSpy.mockRestore();
      }

      expect(manager.getStatus().isAttached).toBe(false);
      expect(counts()).toEqual(before);
    });

    test('an attach from a detach cleanup report is not undone by that detach', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
        onInfoRequested: infoCallback,
        onDebugRequested: debugCallback,
      });
      const counts = (): number[] =>
        ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2'].map((signal) =>
          process.listenerCount(signal),
        );
      const before = counts();
      manager.attach();

      // Two removals fail, so detach has a later failure to report.
      const originalOff = process.off.bind(process);
      const failure = new Error('off failed');
      const failingSignals = new Set(['SIGINT', 'SIGTERM']);
      const offSpy = spyOn(process, 'off').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        originalOff(event, listener);
        if (failingSignals.delete(event)) {
          throw failure;
        }
        return process;
      }) as typeof process.off);

      let wasAttachedDuringReport: boolean | undefined;
      const onGlobalError = (event: Event): void => {
        event.preventDefault();
        if (wasAttachedDuringReport === undefined) {
          wasAttachedDuringReport = manager.isAttached;
          manager.attach();
        }
      };
      globalThis.addEventListener('error', onGlobalError);

      try {
        try {
          expect(() => manager.detach()).toThrow(failure);
        } finally {
          offSpy.mockRestore();
        }
        // Later failures are reported only after the first has reached the caller.
        expect(wasAttachedDuringReport).toBeUndefined();
        await Promise.resolve();
      } finally {
        globalThis.removeEventListener('error', onGlobalError);
      }

      // The report came after detach finished, so the listener's attach took effect
      // and nothing removed its listeners afterward.
      expect(wasAttachedDuringReport).toBe(false);
      expect(manager.isAttached).toBe(true);
      expect(counts()).toEqual(before.map((count) => count + 1));

      manager.detach();
      expect(counts()).toEqual(before);
    });

    test('a cleanup failure during attach keeps the registration error', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });
      const before = process.listenerCount('SIGINT');
      const registrationError = new Error('on failed');
      const onSpy = spyOn(process, 'on').mockImplementation(((
        event: string,
      ) => {
        if (event === 'SIGHUP') {
          throw registrationError;
        }
        return process;
      }) as typeof process.on);
      const offSpy = spyOn(process, 'off').mockImplementation((() => {
        throw new Error('off failed');
      }) as typeof process.off);

      const reports: unknown[] = [];
      const onGlobalError = (event: Event): void => {
        reports.push((event as ErrorEvent).error);
        event.preventDefault();
      };
      globalThis.addEventListener('error', onGlobalError);

      try {
        try {
          expect(() => manager.attach()).toThrow(registrationError);
        } finally {
          onSpy.mockRestore();
          offSpy.mockRestore();
        }
        // Reported only after the failed attach has reached its caller.
        expect(reports).toEqual([]);
        await Promise.resolve();
      } finally {
        globalThis.removeEventListener('error', onGlobalError);
      }

      expect(manager.getStatus().isAttached).toBe(false);
      expect(process.listenerCount('SIGINT')).toBe(before);
      // Every cleanup failure is reported rather than lost behind the rethrow, in the
      // order the removals failed: the first by attach, then the later ones.
      expect(reports.length).toBeGreaterThan(1);
      for (const report of reports) {
        expect((report as Error).cause).toMatchObject({
          message: 'off failed',
        });
      }
      expect((reports[0] as Error).message).toContain(
        'ProcessSignalManager attach cleanup',
      );
      expect((reports.at(-1) as Error).message).toContain(
        'ProcessSignalManager listener cleanup',
      );
    });

    test('an attach from an attach cleanup report is not thrown over', async () => {
      manager = new ProcessSignalManager({
        onShutdownRequested: shutdownCallback,
        onReloadRequested: reloadCallback,
      });
      const before = process.listenerCount('SIGINT');
      const registrationError = new Error('on failed');
      const originalOn = process.on.bind(process);
      const onSpy = spyOn(process, 'on').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        if (event === 'SIGHUP') {
          throw registrationError;
        }
        originalOn(event, listener);
        return process;
      }) as typeof process.on);
      const originalOff = process.off.bind(process);
      const offSpy = spyOn(process, 'off').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        originalOff(event, listener);
        if (event === 'SIGINT') {
          throw new Error('off failed');
        }
        return process;
      }) as typeof process.off);

      let reattachError: unknown;
      const onGlobalError = (event: Event): void => {
        event.preventDefault();
        try {
          manager.attach();
        } catch (error) {
          reattachError = error;
        }
      };
      globalThis.addEventListener('error', onGlobalError);

      try {
        try {
          expect(() => manager.attach()).toThrow(registrationError);
        } finally {
          onSpy.mockRestore();
          offSpy.mockRestore();
        }
        expect(manager.isAttached).toBe(false);
        expect(process.listenerCount('SIGINT')).toBe(before);
        await Promise.resolve();
      } finally {
        globalThis.removeEventListener('error', onGlobalError);
      }

      // The failed attach had already thrown, so the listener's attach stands.
      expect(reattachError).toBeUndefined();
      expect(manager.isAttached).toBe(true);
      expect(process.listenerCount('SIGINT')).toBe(before + 1);

      manager.detach();
      expect(process.listenerCount('SIGINT')).toBe(before);
    });

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

describe('ProcessSignalManager - piped stdin ownership', () => {
  test.each([false, true])(
    'leaves non-TTY input isFlowing (attach failure=%p)',
    (shouldFailAttach) => {
      const descriptor = Object.getOwnPropertyDescriptor(
        process.stdin,
        'isTTY',
      );
      const resume = spyOn(process.stdin, 'resume').mockImplementation(
        () => process.stdin,
      );
      const pause = spyOn(process.stdin, 'pause').mockImplementation(
        () => process.stdin,
      );
      const manager = new ProcessSignalManager({ onReloadRequested() {} });
      const on = process.on.bind(process);
      const registration = spyOn(process, 'on').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        if (shouldFailAttach && event === 'SIGHUP') {
          throw new Error('registration refused');
        }
        return on(event, listener);
      }) as typeof process.on);
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: false,
      });
      try {
        if (shouldFailAttach) {
          expect(() => manager.attach()).toThrow('registration refused');
        } else {
          manager.attach();
          manager.detach();
        }
        expect(resume).not.toHaveBeenCalled();
        expect(pause).not.toHaveBeenCalled();
      } finally {
        manager.detach();
        registration.mockRestore();
        resume.mockRestore();
        pause.mockRestore();
        if (descriptor) {
          Object.defineProperty(process.stdin, 'isTTY', descriptor);
        } else {
          delete (process.stdin as { isTTY?: boolean }).isTTY;
        }
      }
    },
  );
});

test.each([
  [false, false],
  [true, false],
  [false, true],
])(
  'throwing resume preserves prior flow (isFlowing=%p, doesChangeBeforeThrow=%p)',
  (wasFlowing, doesChangeBeforeThrow) => {
    const keys = ['isTTY', 'isRaw', 'readableFlowing', 'setRawMode'] as const;
    const descriptors = keys.map(
      (key) =>
        [key, Object.getOwnPropertyDescriptor(process.stdin, key)] as const,
    );
    let isFlowing = wasFlowing;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdin, 'isRaw', {
      configurable: true,
      writable: true,
      value: false,
    });
    Object.defineProperty(process.stdin, 'readableFlowing', {
      configurable: true,
      get: () => isFlowing,
    });
    Object.defineProperty(process.stdin, 'setRawMode', {
      configurable: true,
      writable: true,
      value: (isRaw: boolean) => {
        process.stdin.isRaw = isRaw;
        return process.stdin;
      },
    });
    const on = process.stdin.on.bind(process.stdin);
    const register = spyOn(process.stdin, 'on').mockImplementation(((
      event: string,
      listener: (...args: unknown[]) => void,
    ) =>
      event === 'keypress'
        ? process.stdin
        : on(event, listener)) as typeof process.stdin.on);
    const resume = spyOn(process.stdin, 'resume').mockImplementation(() => {
      if (doesChangeBeforeThrow) {
        isFlowing = true;
      }
      throw new Error('resume refused');
    });
    const pause = spyOn(process.stdin, 'pause').mockImplementation(() => {
      isFlowing = false;
      return process.stdin;
    });
    const manager = new ProcessSignalManager({ onReloadRequested() {} });
    try {
      expect(() => manager.attach()).toThrow('resume refused');
      expect(pause).toHaveBeenCalledTimes(
        doesChangeBeforeThrow && !wasFlowing ? 1 : 0,
      );
      expect(isFlowing).toBe(wasFlowing);
      expect(manager.isAttached).toBe(false);
    } finally {
      manager.detach();
      register.mockRestore();
      resume.mockRestore();
      pause.mockRestore();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(process.stdin, key, descriptor);
        } else {
          Reflect.deleteProperty(process.stdin, key);
        }
      }
    }
  },
);

test('one Ctrl+C is forwarded once when its leader detaches during SIGINT', () => {
  const wasTTY = process.stdin.isTTY;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const raw = process.stdin.setRawMode;
  (process.stdin as any).isTTY = true;
  process.stdin.setRawMode = mock(() => process.stdin);
  const callback = mock(() => {});
  const first: ProcessSignalManager = new ProcessSignalManager({
    onShutdownRequested: () => {
      first.detach();
    },
    keypressThrottleMS: 0,
  });
  const second = new ProcessSignalManager({
    onShutdownRequested: callback,
    keypressThrottleMS: 0,
  });
  try {
    first.attach();
    second.attach();
    process.stdin.emit('keypress', '\u0003', { name: 'c', ctrl: true });
    expect(callback).toHaveBeenCalledTimes(1);
    process.stdin.emit('keypress', '\u0003', { name: 'c', ctrl: true });
    expect(callback).toHaveBeenCalledTimes(2);
  } finally {
    first.detach();
    second.detach();
    (process.stdin as any).isTTY = wasTTY;
    process.stdin.setRawMode = raw;
  }
});

describe('callback name options', () => {
  const OPTION_NAMES = [
    'shutdownCallbackName',
    'reloadCallbackName',
    'infoCallbackName',
    'debugCallbackName',
  ] as const;

  // A name that is not a string threw out of every signal and keypress dispatch - an
  // uncaught exception - when the report was built from it. Refused when constructed.
  for (const option of OPTION_NAMES) {
    test(`${option} that is not a string is a TypeError at construction`, () => {
      for (const value of [Symbol('name'), 42, {}, () => 'name']) {
        expect(
          () =>
            new ProcessSignalManager({
              [option]: value as unknown as string,
            }),
        ).toThrow(TypeError);
      }
    });

    test(`${option} that is null or undefined uses the default`, () => {
      for (const value of [null, undefined]) {
        const manager = new ProcessSignalManager({
          [option]: value as unknown as string,
        });
        expect(
          (manager as unknown as Record<string, unknown>)[option],
        ).toBeString();
      }
    });
  }

  test('a custom string name is used in the report', () => {
    const reports: Error[] = [];
    const onError = (event: Event): void => {
      reports.push((event as ErrorEvent).error as Error);
      event.preventDefault();
    };
    globalThis.addEventListener('error', onError);
    try {
      const manager = new ProcessSignalManager({
        onReloadRequested: () => {
          throw new Error('reload failed');
        },
        reloadCallbackName: 'customReload',
      });
      manager.triggerReload(true);
      expect(reports.map((report) => report.message)).toEqual([
        'Error in a callback customReload',
      ]);
    } finally {
      globalThis.removeEventListener('error', onError);
    }
  });
});

describe('callback options', () => {
  const OPTION_NAMES = [
    'onShutdownRequested',
    'onReloadRequested',
    'onInfoRequested',
    'onDebugRequested',
  ] as const;

  // A truthy value that is not a function was stored as a registered handler: attach()
  // installed its signal listeners (taking over Ctrl+C) and every dispatch reported a
  // failed callback instead of running one. Refused when constructed.
  for (const option of OPTION_NAMES) {
    test(`${option} that is not a function is a TypeError at construction`, () => {
      for (const value of ['shutdown', 42, {}, true, Symbol('cb')]) {
        expect(
          () => new ProcessSignalManager({ [option]: value as never }),
        ).toThrow(`${option} must be a function`);
      }
    });

    test(`${option} that is null or undefined registers no handler`, () => {
      for (const value of [null, undefined]) {
        const manager = new ProcessSignalManager({ [option]: value as never });
        expect(Object.values(manager.getStatus().handlers)).not.toContain(true);
      }
    });
  }
});

describe('keypress events whose key is not a readable object', () => {
  const hostileKey = {
    get name(): string {
      throw new Error('name getter failed');
    },
  };

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'r'],
    ['an object whose name getter throws', hostileKey],
  ])('a key that is %s is ignored', (_kind, key) => {
    const wasTTY = process.stdin.isTTY;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const raw = process.stdin.setRawMode;
    (process.stdin as any).isTTY = true;
    process.stdin.setRawMode = mock(() => process.stdin);
    const reload = mock(() => {});
    const manager = new ProcessSignalManager({
      onReloadRequested: reload,
      keypressThrottleMS: 0,
    });
    try {
      manager.attach();
      expect(() => process.stdin.emit('keypress', 'r', key)).not.toThrow();
      expect(reload).not.toHaveBeenCalled();
      // The handler still works for the next ordinary key.
      process.stdin.emit('keypress', 'r', { name: 'r' });
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      manager.detach();
      (process.stdin as any).isTTY = wasTTY;
      process.stdin.setRawMode = raw;
    }
  });
});

test('keypress listening status is false when stdin does not expose isTTY', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const manager = new ProcessSignalManager({ onReloadRequested() {} });
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: undefined,
  });
  try {
    manager.attach();
    expect(manager.getStatus().listeningFor.keypresses).toBe(false);
  } finally {
    manager.detach();
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor);
    } else {
      Reflect.deleteProperty(process.stdin, 'isTTY');
    }
  }
});

test('console-origin attach retries do not enqueue another cleanup report', async () => {
  const originalConsole = console.error;
  const originalOn = process.on.bind(process);
  const originalOff = process.off.bind(process);
  const manager = new ProcessSignalManager({ onReloadRequested: () => {} });
  const attachFailure = new Error('attach failed');
  let consoleCalls = 0;
  let attachCalls = 0;
  let cleanupCalls = 0;
  const on = spyOn(process, 'on').mockImplementation(
    function (event, listener) {
      if (event === 'SIGHUP') {
        attachCalls++;
        throw attachFailure;
      }
      return Reflect.apply(originalOn, process, [event, listener]);
    },
  );
  const off = spyOn(process, 'off').mockImplementation(
    function (event, listener) {
      if (event === 'SIGHUP') {
        cleanupCalls++;
        throw new Error('cleanup failed');
      }
      return Reflect.apply(originalOff, process, [event, listener]);
    },
  );
  console.error = (): void => {
    // Cap a regression before it can create an unbounded microtask chain.
    if (++consoleCalls <= 10) {
      expect(() => manager.attach()).toThrow(attachFailure);
    }
  };
  try {
    // This ordinary attach reports its cleanup failure. The console shim retries it.
    expect(() => manager.attach()).toThrow(attachFailure);
    await sleep(10);
    expect(consoleCalls).toBe(1);
    expect(attachCalls).toBe(2);
    expect(cleanupCalls).toBe(2);
    expect(manager.isAttached).toBe(false);
    console.error = (): void => {
      consoleCalls++;
    };
    expect(() => manager.attach()).toThrow(attachFailure);
    await sleep(10);
    expect(consoleCalls).toBe(2);
  } finally {
    console.error = originalConsole;
    on.mockRestore();
    off.mockRestore();
  }
});

test('a console-origin failed attach still reports its cleanup failure', async () => {
  const originalOn = process.on.bind(process);
  const originalOff = process.off.bind(process);
  const manager = new ProcessSignalManager({ onReloadRequested: () => {} });
  const attachFailure = new Error('attach failed');
  const cleanupFailure = new Error('cleanup failed');
  const heard: unknown[] = [];
  const onError = (event: Event): void => {
    heard.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  const on = spyOn(process, 'on').mockImplementation(
    function (event, listener) {
      if (event === 'SIGHUP') {
        throw attachFailure;
      }
      return Reflect.apply(originalOn, process, [event, listener]);
    },
  );
  const off = spyOn(process, 'off').mockImplementation(
    function (event, listener) {
      if (event === 'SIGHUP') {
        throw cleanupFailure;
      }
      return Reflect.apply(originalOff, process, [event, listener]);
    },
  );
  let attachError: unknown;
  globalThis.addEventListener('error', onError);
  try {
    console.error = (): void => {
      try {
        manager.attach();
      } catch (error) {
        attachError = error;
      }
    };
    reportToConsole('terminal line');
    await sleep(10);
  } finally {
    globalThis.removeEventListener('error', onError);
    on.mockRestore();
    off.mockRestore();
  }
  expect(attachError).toBe(attachFailure);
  expect(manager.isAttached).toBe(false);
  expect(heard).toHaveLength(1);
  expect((heard[0] as Error).message).toContain(
    'ProcessSignalManager attach cleanup',
  );
  expect((heard[0] as Error).cause).toBe(cleanupFailure);
});
