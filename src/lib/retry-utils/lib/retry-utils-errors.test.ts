import { describe, expect, test } from 'bun:test';
import {
  RetryUtilsErrPolicyConfigInvalidStrategy,
  RetryUtilsErrRunnerAlreadyCompleted,
  RetryUtilsErrRunnerAlreadyRunning,
  RetryUtilsErrRunnerAttemptsExhausted,
  RetryUtilsErrRunnerCancelPending,
  RetryUtilsErrRunnerForceTryRetryInProgress,
  RetryUtilsErrRunnerLastRetryFatallyFailed,
  RetryUtilsErrRunnerLockAcquisitionError,
  RetryUtilsErrRunnerNotPaused,
  RetryUtilsErrRunnerNotRunning,
  RetryUtilsErrRunnerRetryCanceled,
  RetryUtilsErrRunnerUnexpectedError,
  RetryUtilsErrRunnerUnknownState,
} from './retry-utils-errors';

/**
 * These are thrown from state transitions that a normal run never reaches, so nothing
 * else constructs them. Each is pinned here so a rename, a dropped `name`, or a lost
 * constructor field is caught - `name` in particular is what callers branch on, and it
 * is assigned separately from the class, so the two can silently drift apart.
 */
describe('retry-utils errors', () => {
  test('every error is an Error, names itself, and has a message', () => {
    const errors: Error[] = [
      new RetryUtilsErrPolicyConfigInvalidStrategy('nope', ['fixed']),
      new RetryUtilsErrRunnerAlreadyCompleted('run'),
      new RetryUtilsErrRunnerAlreadyRunning('run'),
      new RetryUtilsErrRunnerForceTryRetryInProgress('forceTry'),
      new RetryUtilsErrRunnerNotPaused('resume'),
      new RetryUtilsErrRunnerCancelPending('run'),
      new RetryUtilsErrRunnerRetryCanceled('run'),
      new RetryUtilsErrRunnerLastRetryFatallyFailed('run'),
      new RetryUtilsErrRunnerAttemptsExhausted('run'),
      new RetryUtilsErrRunnerLockAcquisitionError('forceTry'),
      new RetryUtilsErrRunnerUnexpectedError('run', new Error('cause')),
      new RetryUtilsErrRunnerUnknownState('waitForCompletion', 'weird'),
      new RetryUtilsErrRunnerNotRunning('waitForCompletion'),
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message.length).toBeGreaterThan(0);
      // The assigned `name` must match the class it came from.
      expect(error.name).toBe(error.constructor.name);
    }
  });

  test('keeps the fields the caller needs to act on', () => {
    const invalidStrategy = new RetryUtilsErrPolicyConfigInvalidStrategy(
      'nope',
      ['fixed', 'exponential'],
    );

    expect(invalidStrategy.strategyProvided).toBe('nope');
    expect(invalidStrategy.validStrategies).toEqual(['fixed', 'exponential']);

    const unexpected = new RetryUtilsErrRunnerUnexpectedError(
      'resume',
      new Error('underlying'),
    );

    expect(unexpected.invokedMethod).toBe('resume');
    expect(unexpected.originalError.message).toBe('underlying');

    const unknownState = new RetryUtilsErrRunnerUnknownState(
      'waitForCompletion',
      'weird',
    );

    expect(unknownState.runnerState).toBe('weird');
  });
});
