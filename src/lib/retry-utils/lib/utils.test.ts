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
