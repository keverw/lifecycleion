import { describe, expect, test } from 'bun:test';
import { callQuietly } from './call-quietly';

describe('callQuietly', () => {
  test('calls the method on its target, and calls nothing that is not a function', () => {
    const target = { calls: 0 };
    callQuietly(function (this: { calls: number }) {
      this.calls++;
    }, target);
    callQuietly(undefined, target);
    callQuietly('cancel', target);

    expect(target.calls).toBe(1);
  });

  test('contains a throw and observes a rejection, of a promise or any thenable', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      expect(() =>
        callQuietly(() => {
          throw new Error('refused');
        }, {}),
      ).not.toThrow();
      callQuietly(() => Promise.reject(new Error('rejected')), {});
      callQuietly(
        () => ({
          then: (_: unknown, reject: (error: unknown) => void) => {
            reject(new Error('thenable'));
          },
        }),
        {},
      );

      // Long enough for an unobserved rejection to be reported.
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
