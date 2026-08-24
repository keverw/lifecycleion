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
