import { afterEach, describe, expect, test } from 'bun:test';
import {
  breakConsoleError,
  muteConsoleError,
  removeConsoleError,
  restoreConsoleError,
} from './console-test-utils';
import { isConsoleReportActive, reportToConsole } from './report-to-console';
import type * as ConsoleReportModule from './report-to-console';

function importConsoleReportCopy(
  name: string,
): Promise<typeof ConsoleReportModule> {
  return import(`./report-to-console.ts?test-copy=${name}`) as Promise<
    typeof ConsoleReportModule
  >;
}

afterEach(() => {
  restoreConsoleError();
});

describe('reportToConsole', () => {
  test('separate module copies share console origin across delayed forwarding', async () => {
    const copies = await Promise.all([
      importConsoleReportCopy('first'),
      importConsoleReportCopy('second'),
    ]);
    muteConsoleError();
    let calls = 0;
    console.error = () => {
      if (++calls > 20) {
        return;
      }
      const next = copies[calls % 2];
      // A queued failure reporter captures origin before its asynchronous work.
      const wasConsoleOrigin = next.isConsoleReportActive();
      queueMicrotask(() => {
        if (!wasConsoleOrigin) {
          next.reportToConsole('forwarded failure');
        }
      });
      next.reportToConsole('synchronous forwarded failure');
    };
    copies[0].reportToConsole('initial failure');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    expect(copies.every((copy) => !copy.isConsoleReportActive())).toBe(true);

    copies[1].reportToConsole('independent later failure');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(2);
  });

  test('shared console origin releases despite frozen state and replaced methods', async () => {
    const copy = await importConsoleReportCopy('frozen-state');
    const key = Symbol.for('lifecycleion.reportToConsole.v1');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    const hostileMethod = (): never => {
      throw new Error('shared method must not run');
    };
    const state = Object.freeze(
      Object.assign(new Set<boolean>(), {
        has: hostileMethod,
        add: hostileMethod,
        delete: hostileMethod,
      }),
    );
    Object.defineProperty(globalThis, key, {
      value: state,
      configurable: true,
      writable: true,
    });
    const captured = muteConsoleError();
    try {
      reportToConsole('first failure');
      expect(copy.isConsoleReportActive()).toBe(false);
      copy.reportToConsole('later failure');
      expect(captured).toEqual(['first failure', 'later failure']);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
  });

  test('a hostile shared-state accessor is repaired without invoking it', () => {
    const key = Symbol.for('lifecycleion.reportToConsole.v1');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    let reads = 0;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get() {
        reads++;
        throw new Error('shared state unavailable');
      },
    });
    const captured = muteConsoleError();
    try {
      reportToConsole('first failure');
      reportToConsole('later failure');
      expect(captured).toEqual(['first failure', 'later failure']);
      expect(reads).toBe(0);
      expect(isConsoleReportActive()).toBe(false);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
  });

  test('bounds a console shim that reports another failure and releases the guard', () => {
    muteConsoleError();
    let calls = 0;
    console.error = () => {
      calls++;
      expect(isConsoleReportActive()).toBe(true);
      if (calls < 20) {
        reportToConsole('nested failure');
      }
    };

    reportToConsole('first failure');
    expect(calls).toBe(1);
    expect(isConsoleReportActive()).toBe(false);
    reportToConsole('independent failure');
    expect(calls).toBe(2);
  });

  test('holds the guard while reading a console accessor and releases it on throw', () => {
    const descriptor = Object.getOwnPropertyDescriptor(console, 'error');
    if (descriptor === undefined) {
      throw new Error('Missing console.error descriptor');
    }
    let reads = 0;
    Object.defineProperty(console, 'error', {
      configurable: true,
      get() {
        reads++;
        if (reads < 20) {
          reportToConsole('getter failure');
        }
        throw new Error('console accessor failed');
      },
    });

    try {
      reportToConsole('first failure');
      expect(reads).toBe(1);
      expect(isConsoleReportActive()).toBe(false);
    } finally {
      Object.defineProperty(console, 'error', descriptor);
    }

    const captured = muteConsoleError();
    reportToConsole('independent failure');
    expect(captured).toEqual(['independent failure']);
  });

  test('writes the arguments through to console.error', () => {
    const captured = muteConsoleError();

    reportToConsole('something failed');

    expect(captured).toEqual(['something failed']);
  });

  test('passes several arguments through verbatim', () => {
    const captured = muteConsoleError();
    const error = new Error('boom');

    reportToConsole('context:', error);

    // The helper joins with a space and renders an `Error` by its message, so this also
    // confirms the `Error` arrived as an object rather than pre-stringified.
    expect(captured).toEqual(['context: boom']);
  });

  test('does not throw when console.error throws', () => {
    const calls = breakConsoleError();

    expect(() => {
      reportToConsole('something failed');
    }).not.toThrow();

    // The rung was genuinely reached rather than skipped by some earlier guard.
    expect(calls.attempts).toBe(1);
  });

  test('still writes when the array iterator is patched to throw', () => {
    const captured = muteConsoleError();
    const iterator = Array.prototype[Symbol.iterator];

    Array.prototype[Symbol.iterator] = function () {
      throw new Error('iterator patched');
    };

    try {
      reportToConsole('context:', 'still reported');
    } finally {
      Array.prototype[Symbol.iterator] = iterator;
    }

    expect(captured).toEqual(['context: still reported']);
  });

  test('does not throw when console.error is missing', () => {
    removeConsoleError();

    expect(() => {
      reportToConsole('something failed');
    }).not.toThrow();
  });
});
