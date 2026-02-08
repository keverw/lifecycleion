import { describe, expect, test } from 'bun:test';
import { RetryPolicy } from './retry-policy';

describe('RetryPolicy', () => {
  test('should have the correct defaults for fixed strategy', () => {
    const policy = new RetryPolicy({ strategy: 'fixed' });

    // Check initial settings
    expect(policy.policyInfo.strategy).toBe('fixed');
    expect(policy.attempts).toBe(0);
    expect(policy.maxRetryAttempts).toBe(10);
    expect(policy.retryCount).toBe(0);
    expect(policy.areAttemptsExhausted).toBe(false);
    expect(policy.errors).toEqual([]);
    expect(policy.mostCommonError).toBe(null);
    expect(policy.lastError).toBe(null);
  });

  test('should correctly handle retries for fixed strategy', () => {
    const policy = new RetryPolicy({
      strategy: 'fixed',
      maxRetryAttempts: 3,
      delayMS: 1000,
    });

    expect(policy.shouldDoFirstTry()).toBe(true); // Initial attempt

    expect(policy.wasInitialAttemptTaken).toBe(true); // Initial attempt taken
    expect(policy.wasSuccessful).toBe(false);

    policy.shouldRetry(new Error('initial failed'));

    expect(policy.attempts).toBe(1);
    expect(policy.retryCount).toBe(0);

    // Simulate retries
    policy.shouldRetry(new Error('First attempt failed'));

    expect(policy.attempts).toBe(2);
    expect(policy.retryCount).toBe(1);

    policy.shouldRetry(new Error('Second attempt failed'));

    expect(policy.attempts).toBe(3);
    expect(policy.retryCount).toBe(2);
    expect(policy.areAttemptsExhausted).toBe(false);

    policy.shouldRetry(new Error('Third attempt failed'));

    expect(policy.attempts).toBe(4);
    expect(policy.retryCount).toBe(3);
    expect(policy.areAttemptsExhausted).toBe(true);
  });

  test('should calculate delays correctly for exponential strategy', () => {
    const retryPolicy = new RetryPolicy({
      strategy: 'exponential',
      maxRetryAttempts: 3,
      minTimeoutMS: 1000,
      maxTimeoutMS: 8000,
      factor: 2,
      dispersion: 0, // Ensuring no dispersion for simplicity in this test
    });

    // Simulating the initial attempt
    retryPolicy.shouldDoFirstTry();

    // After the first failure, this is technically the first retry
    retryPolicy.shouldRetry(new Error('First attempt failed'));
    // Now, simulating the second retry (third overall attempt including the initial one)
    const result = retryPolicy.shouldRetry(new Error('Second attempt failed'));

    // Given the retry count is now 1, the expected delay is 1000 * 2^1 = 2000.
    // This matches the second retry as per the exponential strategy.
    expect(result.delayMS).toBe(2000);

    // Optionally, verify that the delay does not exceed maxTimeoutMS on subsequent retries

    expect(retryPolicy.retryCount).toBe(1);

    const nextResult = retryPolicy.shouldRetry(
      new Error('Third attempt failed'),
    );

    expect(nextResult.delayMS).toEqual(4000);

    // After the third attempt, the policy should be exhausted
    expect(retryPolicy.areAttemptsExhausted).toBe(false);

    // The fourth attempt should not be allowed
    const finalResult = retryPolicy.shouldRetry(new Error('Fourth attempt'));

    expect(finalResult.shouldRetry).toBe(false);
    expect(finalResult.delayMS).toBe(0);
  });

  test('mostCommonError should be calculated correctly', () => {
    const policy = new RetryPolicy({ strategy: 'fixed', maxRetryAttempts: 5 });
    const commonError = new Error('Common error');
    const uniqueError = new Error('Unique error');

    policy.shouldRetry(commonError);
    policy.shouldRetry(commonError);
    policy.shouldRetry(uniqueError); // Only once

    expect(policy.mostCommonError).toBe(commonError);
  });

  test('should correctly count when successful', () => {
    const policy = new RetryPolicy({ strategy: 'fixed', maxRetryAttempts: 5 });

    expect(policy.wasSuccessful).toBe(false);

    expect(policy.shouldDoFirstTry()).toBe(true); // Initial attempt

    policy.markAsSuccessful();

    expect(policy.wasSuccessful).toBe(true);
    expect(policy.attempts).toBe(1);
    expect(policy.retryCount).toBe(0);

    // retries should not be allowed after success
    const result = policy.shouldRetry(new Error('Error after success'));

    expect(result.shouldRetry).toBe(false);

    expect(policy.attempts).toBe(2);
    expect(policy.retryCount).toBe(1);

    // but it would of still been recorded as an error

    // report another error anyways, just to test the counts change correctly as it will still be recorded as an error
    policy.shouldRetry(new Error('Another error'));

    expect(policy.attempts).toBe(3);
    expect(policy.retryCount).toBe(2);
  });

  test('reset should correctly reset the policy state', () => {
    const policy = new RetryPolicy({ strategy: 'fixed', maxRetryAttempts: 2 });

    expect(policy.wasInitialAttemptTaken).toBe(false); // Initial attempt not taken yet

    const shouldTry = policy.shouldDoFirstTry();
    expect(shouldTry).toBe(true); // Initial attempt

    policy.shouldRetry(new Error('Error after first attempt'));

    expect(policy.wasInitialAttemptTaken).toBe(true); // Initial attempt was taken

    policy.reset();

    // After reset, everything should be back to its initial state
    expect(policy.attempts).toBe(0);
    expect(policy.wasInitialAttemptTaken).toBe(false);
    expect(policy.retryCount).toBe(0);
    expect(policy.areAttemptsExhausted).toBe(false);
    expect(policy.errors).toEqual([]);
    expect(policy.mostCommonError).toBe(null);
    expect(policy.lastError).toBe(null);
  });
});
