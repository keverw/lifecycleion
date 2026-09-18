import { describe, expect, test } from 'bun:test';
import { calculateExponentialDelay, getMostCommonError } from './utils';

describe('calculateExponentialDelay', () => {
  // Test without dispersion
  test('calculates exponential delay without dispersion correctly', () => {
    const params = {
      retryCount: 2,
      minTimeoutMS: 100,
      maxTimeoutMS: 10000,
      factor: 2,
      dispersion: 0,
      randomFn: (): number => 0.5, // Not used in this test, but required
    };

    const expectedDelay = 400; // 100 * 2^2

    expect(calculateExponentialDelay(params)).toBe(expectedDelay);
  });

  // Test with dispersion
  test('calculates exponential delay with dispersion correctly', () => {
    const params = {
      retryCount: 1,
      minTimeoutMS: 100,
      maxTimeoutMS: 10000,
      factor: 2,
      dispersion: 0.1, // 10% dispersion
      randomFn: (): number => 0.5, // This would simulate the dispersion effect
    };

    const baseDelay = 200; // 100 * 2^1
    const dispersionAmount = baseDelay * 0.1;

    const expectedDelay =
      baseDelay + (0.5 * (dispersionAmount * 2) - dispersionAmount);

    expect(calculateExponentialDelay(params)).toBeCloseTo(expectedDelay);
  });

  // Test clamping to maxTimeoutMS
  test('ensures delay does not exceed maxTimeoutMS', () => {
    const params = {
      retryCount: 10, // High retry count to exceed maxTimeoutMS
      minTimeoutMS: 100,
      maxTimeoutMS: 5000, // Lower max timeout for testing
      factor: 2,
      dispersion: 0,
      randomFn: (): number => 0.5,
    };

    expect(calculateExponentialDelay(params)).toBe(params.maxTimeoutMS);
  });

  // A delay that overflows to `Infinity` used to make jitter `Infinity - Infinity`, which
  // is `NaN`, which `clamp` (`Math.max`/`Math.min`) passes straight through. The runner
  // asks `delayMS > 0`, `NaN > 0` is false, and the retry then ran synchronously on the
  // same stack until it overflowed.
  test('an overflowing delay is capped rather than turning into NaN', () => {
    const delay = calculateExponentialDelay({
      retryCount: 2,
      minTimeoutMS: 100,
      maxTimeoutMS: 10000,
      factor: Infinity,
      dispersion: 0.1,
      randomFn: (): number => 0.5,
    });

    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(10000);
  });

  test('enough attempts at an ordinary factor also stay finite', () => {
    const delay = calculateExponentialDelay({
      retryCount: 5000,
      minTimeoutMS: 100,
      maxTimeoutMS: 10000,
      factor: 2,
      dispersion: 0.1,
      randomFn: (): number => 0.5,
    });

    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBe(10000);
  });

  // Test clamping to minTimeoutMS
  test('ensures delay does not fall below minTimeoutMS', () => {
    const params = {
      retryCount: 0, // No retries yet, but with dispersion that could reduce delay
      minTimeoutMS: 100,
      maxTimeoutMS: 10000,
      factor: 2,
      dispersion: 0.5, // Large dispersion for testing
      randomFn: (): number => 0, // This would give the minimum possible delay with dispersion
    };

    expect(calculateExponentialDelay(params)).toBe(params.minTimeoutMS);
  });
});

describe('getMostCommonError', () => {
  test('returns the most common error', () => {
    const errors = [
      new Error('Error 1'),
      new Error('Error 2'),
      new Error('Error 1'),
      new Error('Error 3'),
      new Error('Error 1'),
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toEqual(new Error('Error 1'));
  });

  test('handles errors with nested error objects', () => {
    const errors = [
      { error: new Error('Error 1') },
      { error: new Error('Error 2') },
      { error: new Error('Error 1') },
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toEqual({ error: new Error('Error 1') });
  });

  test('handles non-object errors', () => {
    const errors = ['Error 1', 'Error 2', 'Error 1', 'Error 3', 'Error 1'];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toBe('Error 1');
  });

  test('returns null when there are no errors', () => {
    const errors: unknown[] = [];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toBeNull();
  });

  test('handles objects with message property (not Error instances)', () => {
    const errors = [
      { message: 'Custom error 1' },
      { message: 'Custom error 2' },
      { message: 'Custom error 1' },
      { message: 'Custom error 1' },
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toEqual({ message: 'Custom error 1' });
  });

  test('handles nested error objects with message property (not Error instances)', () => {
    const errors = [
      { error: { message: 'Nested error 1' } },
      { error: { message: 'Nested error 2' } },
      { error: { message: 'Nested error 1' } },
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toEqual({ error: { message: 'Nested error 1' } });
  });

  test('handles nested error objects without message (falls back to String)', () => {
    const errors = [
      { error: { code: 123 } },
      { error: { code: 456 } },
      { error: { code: 123 } },
      { error: { code: 123 } },
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toEqual({ error: { code: 123 } });
  });

  test('handles mixed error types', () => {
    const errors = [
      new Error('Error 1'),
      { message: 'Error 1' },
      'Error 1',
      { error: new Error('Error 1') },
      new Error('Error 2'),
    ];

    const mostCommonError = getMostCommonError(errors);

    // All have the same message "Error 1", so the first one should be returned
    expect(mostCommonError).toEqual(new Error('Error 1'));
  });

  test('handles null and undefined errors', () => {
    const errors = [null, undefined, null, 'Error 1', null];

    const mostCommonError = getMostCommonError(errors);

    // null appears 3 times (most common)
    expect(mostCommonError).toBeNull();
  });

  test('handles numeric and boolean errors', () => {
    const errors = [404, 500, 404, 404, true, false];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toBe(404);
  });

  test('handles objects without message or error properties', () => {
    const errors = [
      { code: 'ERR_1', status: 500 },
      { code: 'ERR_2', status: 404 },
      { code: 'ERR_1', status: 500 },
      { code: 'ERR_1', status: 500 },
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toEqual({ code: 'ERR_1', status: 500 });
  });

  test('returns first error when all have same count', () => {
    const errors = [
      new Error('Error 1'),
      new Error('Error 2'),
      new Error('Error 3'),
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toEqual(new Error('Error 1'));
  });

  test('groups by reference equality when the same object is reused', () => {
    const reusedError = { code: 'TIMEOUT' };
    const otherError = { code: 'OTHER' };
    const errors = [reusedError, otherError, reusedError, reusedError];

    const mostCommonError = getMostCommonError(errors);

    // Same reference appears 3 times — should be identified as most common
    expect(mostCommonError).toBe(reusedError);
  });

  test('reference equality wins over message grouping for unstable messages', () => {
    let callCount = 0;
    const dynamicError = {
      get message(): string {
        callCount++;
        return `Error #${callCount}`;
      },
    };

    const stableError = new Error('stable');
    // dynamicError produces a different message string each time .message is accessed,
    // so message-based grouping would give it count 1 per call.
    // Reference equality correctly groups all 3 as the same error.
    const errors = [
      dynamicError,
      dynamicError,
      dynamicError,
      stableError,
      stableError,
    ];

    const mostCommonError = getMostCommonError(errors);

    expect(mostCommonError).toBe(dynamicError);
  });
});

describe('getMostCommonError - values that resist being read', () => {
  /**
   * Whether the call completed, as a boolean.
   *
   * Not `expect(fn).not.toThrow()`: this function *returns* the hostile value, and the
   * matcher formats what it receives - which reads the very accessor these tests make
   * throw, failing the assertion from inside the assertion.
   */
  const completes = (fn: () => unknown): boolean => {
    try {
      fn();

      return true;
    } catch {
      return false;
    }
  };

  // `RetryPolicy.mostCommonError` is a public getter holding whatever the retried
  // operation threw. An unguarded read here threw out of a property access the caller
  // made in order to *report* a failure, replacing the failure with one of its own.

  test('survives an error whose message accessor throws', () => {
    const hostile = new Error('placeholder');

    Object.defineProperty(hostile, 'message', {
      get() {
        throw new Error('message refused');
      },
    });

    expect(completes(() => getMostCommonError([hostile, hostile]))).toBe(true);

    // Compared as a boolean rather than handed to `expect` directly: the matcher formats
    // the value it receives, which reads the very accessor this test makes throw.
    expect(getMostCommonError([hostile, hostile]) === hostile).toBe(true);
  });

  test('survives a hostile has trap', () => {
    const hostile = new Proxy(
      {},
      {
        has() {
          throw new Error('has refused');
        },
        get() {
          throw new Error('get refused');
        },
      },
    );

    expect(completes(() => getMostCommonError([hostile, hostile]))).toBe(true);
  });

  test('survives a value whose toString throws', () => {
    const hostile = {
      toString() {
        throw new Error('toString refused');
      },
    };

    expect(completes(() => getMostCommonError([hostile, {}]))).toBe(true);
  });

  test('survives a revoked Proxy', () => {
    const { proxy, revoke } = Proxy.revocable({ message: 'x' }, {});

    revoke();

    expect(completes(() => getMostCommonError([proxy, proxy]))).toBe(true);
  });

  test('still groups readable errors by message', () => {
    // The guards must not cost the grouping this function exists to do.
    const a = new Error('same');
    const b = new Error('same');
    const c = new Error('different');

    expect(getMostCommonError([a, b, c]) === a).toBe(true);
  });

  test('still reads a nested error under an error property', () => {
    const wrapped = { error: new Error('nested failure') };
    const other = { error: new Error('nested failure') };

    expect(
      getMostCommonError([wrapped, other, new Error('x')]) === wrapped,
    ).toBe(true);
  });
});
