import { isString } from '../../strings';
import { RetryUtilsErrPolicyConfigInvalidStrategy } from './retry-utils-errors';
import type {
  RetryPolicyOptions,
  RetryPolicyValidated,
  RetryQueryResult,
} from './types';
import { clamp } from '../../clamp';
import { calculateExponentialDelay, getMostCommonError } from './utils';

interface CurrentState {
  wasInitialAttemptTaken: boolean; // Represents if the initial attempt was taken or not since if errors is empty, it should return 1
  wasSuccessful: boolean;
  errors: unknown[];
  mostCommonErrorCached: {
    has: boolean;
    value: unknown;
  };
}

export class RetryPolicy {
  private policy!: RetryPolicyValidated;
  private currentState: CurrentState = this.getEmptyCurrentState();

  /**
   * Gets the validated policy information for this retry policy instance.
   * @returns {RetryPolicyValidated} The current retry policy settings.
   */

  public get policyInfo(): RetryPolicyValidated {
    return this.policy;
  }

  /**
   * Gets the total number of attempts made, including the initial attempt and any retries.
   * @returns {number} The total number of attempts.
   */

  public get attempts(): number {
    if (this.currentState.wasSuccessful) {
      // When successful, include the initial attempt in the total.
      return this.currentState.errors.length + 1;
    } else {
      // When not successful, clamp to ensure at least 1 once the initial attempt was taken.
      return clamp(
        this.currentState.errors.length,
        this.wasInitialAttemptTaken ? 1 : 0,
        Infinity,
      );
    }
  }

  /**
   * Checks if the initial attempt has been taken.
   */

  public get wasInitialAttemptTaken(): boolean {
    return this.currentState.wasInitialAttemptTaken;
  }

  /**
   * Checks if the last operation attempt was successful. (used to calculate the number of attempts made)
   */

  public get wasSuccessful(): boolean {
    return this.currentState.wasSuccessful;
  }

  /**
   * Gets the maximum number of retry attempts allowed by the current policy.
   * @returns {number} The maximum number of retry attempts.
   */

  public get maxRetryAttempts(): number {
    return this.policy.maxRetryAttempts;
  }

  /**
   * Gets the number of retry attempts made, excluding the initial attempt.
   * @returns {number} The number of retries.
   */

  public get retryCount(): number {
    // Retry count is always attempts minus the initial attempt,
    // but only once the initial attempt has been taken.
    if (!this.wasInitialAttemptTaken) {
      return 0;
    }

    return Math.max(this.attempts - 1, 0);
  }

  /**
   * Checks if the retry attempts have been exhausted.
   * @returns {boolean} True if the number of retries has reached the maximum allowed attempts; otherwise, false.
   */

  public get areAttemptsExhausted(): boolean {
    return this.retryCount >= this.maxRetryAttempts;
  }

  /**
   * Gets a list of errors recorded from each retry attempt.
   * @returns {unknown[]} An array of errors encountered during retry attempts.
   */

  public get errors(): unknown[] {
    return [...this.currentState.errors];
  }

  /**
   * Gets the most common error encountered across all retry attempts.
   *
   * This method caches the most common error for performance. If the cache is invalidated due to a new error,
   * it recalculates the most common error.
   *
   * @returns {unknown} The most common error, or null if no errors have been encountered.
   */

  public get mostCommonError(): unknown {
    if (this.currentState.mostCommonErrorCached.has) {
      return this.currentState.mostCommonErrorCached.value;
    } else {
      const mostCommon = getMostCommonError(this.currentState.errors);

      this.currentState.mostCommonErrorCached.has = true;
      this.currentState.mostCommonErrorCached.value = mostCommon;

      return mostCommon;
    }
  }

  /**
   * Gets the last error encountered during the retry attempts.
   * @returns {unknown} The last error encountered, or null if no errors have been recorded.
   */

  public get lastError(): unknown {
    if (this.currentState.errors.length === 0) {
      return null;
    } else {
      return this.currentState.errors[this.currentState.errors.length - 1];
    }
  }

  /**
   * Constructs a RetryPolicy instance with specified options.
   *
   * @param {RetryPolicyOptions} policy The retry policy options, including strategy, maximum retry attempts,
   * and other parameters specific to the fixed or exponential strategy.
   *
   * Throws an error if an invalid retry strategy is provided.
   */

  constructor(policy: RetryPolicyOptions) {
    const DEFAULT_MAX_RETRY_ATTEMPTS = 10;
    const DEFAULT_FACTOR = 1.5;
    const DEFAULT_MIN_TIMEOUT_MS = 1000;
    const DEFAULT_MAX_TIMEOUT_MS = 30000;
    const DEFAULT_DISPERSION = 0.1;

    if (policy.strategy === 'fixed') {
      this.policy = {
        strategy: 'fixed',
        maxRetryAttempts: Math.floor(
          clamp(
            policy.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS,
            1,
            Infinity,
          ),
        ),
        delayMS: clamp(policy.delayMS ?? DEFAULT_MIN_TIMEOUT_MS, 1, Infinity),
      };
    } else if (policy.strategy === 'exponential') {
      const minTimeoutMS = clamp(
        policy.minTimeoutMS ?? DEFAULT_MIN_TIMEOUT_MS,
        1,
        Infinity,
      );
      const maxTimeoutMS = clamp(
        policy.maxTimeoutMS ?? DEFAULT_MAX_TIMEOUT_MS,
        1,
        Infinity,
      );

      // Ensure maxTimeoutMS >= minTimeoutMS by swapping if needed
      const finalMin = Math.min(minTimeoutMS, maxTimeoutMS);
      const finalMax = Math.max(minTimeoutMS, maxTimeoutMS);

      this.policy = {
        strategy: 'exponential',
        maxRetryAttempts: Math.floor(
          clamp(
            policy.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS,
            1,
            Infinity,
          ),
        ),
        factor: clamp(policy.factor ?? DEFAULT_FACTOR, 1, Infinity),
        minTimeoutMS: finalMin,
        maxTimeoutMS: finalMax,
        dispersion: clamp(policy.dispersion ?? DEFAULT_DISPERSION, 0, 1),
      };
    } else {
      throw new RetryUtilsErrPolicyConfigInvalidStrategy(
        isString(policy['strategy']) ? policy['strategy'] : 'unknown',
        ['fixed', 'exponential'],
      );
    }
  }

  /**
   * Resets the retry policy to its initial state.
   *
   * This method clears all recorded errors and marks the initial attempt as not taken,
   * effectively resetting the state of the retry policy for a new operation.
   */

  public reset(): void {
    this.currentState = this.getEmptyCurrentState();
  }

  /**
   * Determines if the initial operation attempt should proceed.
   *
   * This method checks if the initial attempt has already been taken and updates the state to reflect that
   * the initial attempt is now being made. This method is used to ensure that the retry logic only kicks in after
   * the first attempt has failed.
   *
   * Note that even upon success, you should call the reset method to clear the state for the next operation.
   *
   * @returns {boolean} True if the initial attempt has not been made yet; otherwise, false.
   */

  public shouldDoFirstTry(): boolean {
    if (this.currentState.wasInitialAttemptTaken) {
      return false;
    } else {
      this.currentState.wasInitialAttemptTaken = true; // Mark the initial attempt as taken.

      return true;
    }
  }

  /**
   * Marks the last operation attempt as successful.
   */

  public markAsSuccessful(): void {
    this.currentState.wasSuccessful = true;
  }

  /**
   * Records an error that occurred during the last operation attempt.
   *
   * Does not check if was successful or not, nor checks if should retry or not.
   */

  public reportError(error: unknown): void {
    this.currentState.errors.push(error);

    // Invalidate the mostCommonError cache
    this.currentState.mostCommonErrorCached.has = false;
  }

  /**
   * Determines if a retry should be made based on the current state and the provided error.
   *
   * When called, this method stores the provided error, checks if further retries are allowed based on the
   * maximum retry attempts, and calculates the delay for the next retry if applicable.
   *
   * It also invalidates the cached most common error since the error state has changed.
   *
   * @param {unknown} error The error that resulted from the last operation attempt. Can be omitted when `isQueryOnly` is `true`.
   * @param {boolean} isQueryOnly If true, the method only queries if a retry should be made without storing the error.
   * @returns {RetryQueryResult} An object indicating whether a retry should be attempted and the delay before the next attempt.
   */

  public shouldRetry(
    error?: unknown,
    isQueryOnly: boolean = false,
  ): RetryQueryResult {
    if (this.currentState.wasSuccessful) {
      if (!isQueryOnly) {
        // push the error into the errors array anyways if it was not a query only
        this.reportError(error);
      }

      // Once successful, retries are never allowed.
      return { shouldRetry: false, delayMS: 0 };
    }

    if (!isQueryOnly) {
      // push the error into the errors array
      this.reportError(error);
    }

    // Decide if we should retry - check if we've exhausted our retry attempts
    if (this.areAttemptsExhausted) {
      return { shouldRetry: false, delayMS: 0 };
    } else {
      // Calculate the delay for the next retry attempt
      const delayMS = this.calculateNextDelay();

      return { shouldRetry: true, delayMS };
    }
  }

  /**
   * Returning a fresh copy of the current state
   * to be immutable and not changed by the caller
   */

  private getEmptyCurrentState(): CurrentState {
    return {
      wasInitialAttemptTaken: false,
      wasSuccessful: false,
      errors: [],
      mostCommonErrorCached: {
        has: false,
        value: null,
      },
    };
  }

  /**
   * Calculates the delay before the next retry attempt based on the current retry policy.
   *
   * For a fixed strategy, it returns the specified delay. For an exponential strategy, it calculates the delay
   * based on the exponential backoff formula, considering the number of retry attempts, the base delay,
   * the exponential factor, and any specified dispersion to introduce randomness.
   *
   * @returns {number} The calculated delay in milliseconds before the next retry attempt.
   */

  private calculateNextDelay(): number {
    if (this.policy.strategy === 'fixed') {
      return this.policy.delayMS;
    } else if (this.policy.strategy === 'exponential') {
      return calculateExponentialDelay({
        retryCount: this.retryCount,
        minTimeoutMS: this.policy.minTimeoutMS,
        maxTimeoutMS: this.policy.maxTimeoutMS,
        factor: this.policy.factor,
        dispersion: this.policy.dispersion,
        randomFn: Math.random,
      });
    }

    return 1; // Should never reach here
  }
}
