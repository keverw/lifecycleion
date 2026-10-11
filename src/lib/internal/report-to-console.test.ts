import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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

  test('a shared state whose flag cannot be written is replaced', async () => {
    const key = Symbol.for('lifecycleion.reportToConsole.v1');
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    const squatter = Object.freeze({ active: false });
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: squatter,
    });
    try {
      const copy = await importConsoleReportCopy('frozen-state');
      const captured = muteConsoleError();
      // Writing the frozen flag would throw out of the console rung.
      expect(() => {
        copy.reportToConsole('first failure');
      }).not.toThrow();
      expect(captured).toEqual(['first failure']);
      expect((globalThis as unknown as Record<symbol, unknown>)[key]).not.toBe(
        squatter,
      );
      expect(copy.isConsoleReportActive()).toBe(false);
    } finally {
      if (descriptor === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.defineProperty(globalThis, key, descriptor);
      }
    }
  });

  test('a global that refuses the shared slot is tried once, and re-entry is still bounded', async () => {
    // `Object.preventExtensions(globalThis)` cannot be undone, so it runs in a process of
    // its own. Every check after the refused install reads this copy's own state.
    const script = `
      Object.preventExtensions(globalThis);
      const { isConsoleReportActive, reportToConsole } = await import(
        ${JSON.stringify(join(import.meta.dir, 'report-to-console.ts'))}
      );
      let defines = 0;
      const defineProperty = Reflect.defineProperty;
      const key = Symbol.for('lifecycleion.reportToConsole.v1');
      Reflect.defineProperty = (target, property, descriptor) => {
        if (target === globalThis && property === key) {
          defines++;
        }
        return defineProperty(target, property, descriptor);
      };
      for (let index = 0; index < 5; index++) {
        isConsoleReportActive();
      }
      let calls = 0;
      let wasActive = false;
      console.error = () => {
        calls++;
        wasActive = isConsoleReportActive();
        reportToConsole('nested failure');
      };
      reportToConsole('first failure');
      reportToConsole('later failure');
      process.stdout.write(
        JSON.stringify({ defines, calls, wasActive, isActive: isConsoleReportActive() }),
      );
    `;
    const child = Bun.spawn([process.execPath, '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      defines: 1,
      calls: 2,
      wasActive: true,
      isActive: false,
    });
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

  test('does not throw when console.error is missing', () => {
    removeConsoleError();

    expect(() => {
      reportToConsole('something failed');
    }).not.toThrow();
  });
});
