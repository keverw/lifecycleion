import { describe, expect, test } from 'bun:test';
import {
  getGlobalEventTarget,
  installGlobalEventTarget,
  isGlobalEventTargetAvailable,
  isGlobalEventTargetPolyfilled,
} from './global-event-target';

// Bun exposes the EventTarget methods on `globalThis` natively, so this suite pins down
// the "leave it alone" half of the contract. The Node side — where the methods are
// missing and actually get installed — is covered by `global-event-target-node.test.ts`,
// which runs the real `node` binary.
describe('installGlobalEventTarget under Bun', () => {
  test('reports the native implementation and installs nothing', () => {
    expect(installGlobalEventTarget()).toBe('native');
    expect(isGlobalEventTargetPolyfilled()).toBe(false);
    expect(getGlobalEventTarget()).toBeNull();
  });

  test('is idempotent', () => {
    expect(installGlobalEventTarget()).toBe('native');
    expect(installGlobalEventTarget()).toBe('native');
    expect(installGlobalEventTarget()).toBe('native');
  });

  test('leaves the native methods in place', () => {
    const before = {
      addEventListener: globalThis.addEventListener,
      removeEventListener: globalThis.removeEventListener,
      dispatchEvent: globalThis.dispatchEvent,
    };

    installGlobalEventTarget();

    expect(globalThis.addEventListener).toBe(before.addEventListener);
    expect(globalThis.removeEventListener).toBe(before.removeEventListener);
    expect(globalThis.dispatchEvent).toBe(before.dispatchEvent);
  });

  test('native dispatch still reaches listeners', () => {
    const received: string[] = [];

    const listener = (event: Event): void => {
      const errorEvent = event as ErrorEvent;

      received.push(
        errorEvent.error instanceof Error ? errorEvent.error.message : '',
      );
    };

    globalThis.addEventListener('reportError', listener);

    globalThis.dispatchEvent(
      new ErrorEvent('reportError', { error: new Error('native dispatch') }),
    );

    globalThis.removeEventListener('reportError', listener);

    expect(received).toEqual(['native dispatch']);
  });
});

describe('isGlobalEventTargetAvailable', () => {
  test('is true when the event methods and ErrorEvent are present', () => {
    expect(isGlobalEventTargetAvailable()).toBe(true);
  });
});

// The shared state object lives on a global anyone can reach, so these pin down
// that a hostile or malformed value there cannot throw out of installation —
// which, because installation runs during module initialization, would take down
// the import of `safe-handle-callback` and everything downstream of it.
describe('installGlobalEventTarget with untrusted shared state', () => {
  const GLOBAL_KEY = '__lifecycleion_global_event_target__';
  const g = globalThis as typeof globalThis & Record<string, unknown>;

  function withGlobalState(value: unknown, run: () => void): void {
    const hasExisting = Object.prototype.hasOwnProperty.call(g, GLOBAL_KEY);
    const previous = hasExisting
      ? Object.getOwnPropertyDescriptor(g, GLOBAL_KEY)
      : undefined;

    Object.defineProperty(g, GLOBAL_KEY, {
      value,
      enumerable: false,
      writable: true,
      configurable: true,
    });

    try {
      run();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(g, GLOBAL_KEY);
      } else {
        Object.defineProperty(g, GLOBAL_KEY, previous);
      }
    }
  }

  test('survives a throwing isInstalled getter', () => {
    const hostile = {
      target: new EventTarget(),
      get isInstalled(): boolean {
        throw new Error('hostile isInstalled getter');
      },
    };

    withGlobalState(hostile, () => {
      // Reading `.isInstalled` off shared state must not escape as an exception.
      expect(() => installGlobalEventTarget()).not.toThrow();
      expect(installGlobalEventTarget()).toBe('native');
    });
  });

  test('survives a throwing target getter', () => {
    const hostile = {
      get target(): EventTarget {
        throw new Error('hostile target getter');
      },
      isInstalled: true,
    };

    withGlobalState(hostile, () => {
      expect(() => installGlobalEventTarget()).not.toThrow();
      // Unreadable target means the state cannot be vouched for, so it is not
      // reported as a previous install of ours.
      expect(installGlobalEventTarget()).toBe('native');
    });
  });

  test('ignores state that is not shaped like ours', () => {
    for (const value of [
      'not an object',
      42,
      null,
      {},
      { target: null, isInstalled: true },
      { target: {}, isInstalled: true },
      { target: { addEventListener: 'nope' }, isInstalled: true },
    ]) {
      withGlobalState(value, () => {
        expect(() => installGlobalEventTarget()).not.toThrow();
        expect(installGlobalEventTarget()).toBe('native');
      });
    }
  });

  test('the public helpers survive hostile state too', () => {
    const hostile = {
      get target(): EventTarget {
        throw new Error('hostile target getter');
      },
      get isInstalled(): boolean {
        throw new Error('hostile isInstalled getter');
      },
    };

    withGlobalState(hostile, () => {
      // Every entry point reads the same shared object, so guarding only the
      // install path would leave these two able to crash a caller.
      expect(() => isGlobalEventTargetPolyfilled()).not.toThrow();
      expect(isGlobalEventTargetPolyfilled()).toBe(false);

      expect(() => getGlobalEventTarget()).not.toThrow();
      expect(getGlobalEventTarget()).toBeNull();
    });
  });

  test('still reports already-installed for genuine state', () => {
    withGlobalState({ target: new EventTarget(), isInstalled: true }, () => {
      expect(installGlobalEventTarget()).toBe('already-installed');
    });
  });
});
