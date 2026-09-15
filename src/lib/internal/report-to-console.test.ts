import { afterEach, describe, expect, test } from 'bun:test';
import {
  breakConsoleError,
  muteConsoleError,
  removeConsoleError,
  restoreConsoleError,
} from './console-test-utils';
import { reportToConsole } from './report-to-console';

afterEach(() => {
  restoreConsoleError();
});

describe('reportToConsole', () => {
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
