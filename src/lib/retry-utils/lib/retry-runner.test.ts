import { describe, expect, test } from 'bun:test';
import {
  ATTEMPT_HANDLED,
  ATTEMPT_STARTED,
  OPERATION_ENDED,
  OPERATION_STARTED,
  type ReportResult,
  RetryRunner,
} from './retry-runner';
import type { RetryPolicyOptionsStrategyFixed } from './types';
import { sleep } from '../../sleep';
import {
  RetryUtilsErrRunnerAlreadyCompleted,
  RetryUtilsErrRunnerAlreadyRunning,
  RetryUtilsErrRunnerNotPaused,
  RetryUtilsErrRunnerNotRunning,
} from './retry-utils-errors';

interface CustomResult {
  message: string;
  errorCode: number;
}

describe('RetryRunner', () => {
  const policy: RetryPolicyOptionsStrategyFixed = {
    strategy: 'fixed',
    maxRetryAttempts: 3,
    delayMS: 10, // Set a low delay for testing
  };

  test('should have the correct initial state', () => {
    const operation = (): void => {};
    const runner = new RetryRunner(policy, operation);

    expect(runner.runnerState).toBe('not-started');
    expect(runner.canForceTry).toBe(true);
    expect(runner.wasLastAttemptForced).toBe(false);
    expect(runner.operationLabel).toBe('Unnamed Operation');
    expect(runner.errors).toEqual([]);
    expect(runner.wasInitialAttemptTaken).toBe(false);
    expect(runner.areAttemptsExhausted).toBe(false);
    expect(runner.attempts).toBe(0);
    expect(runner.mostCommonError).toBeNull();
    expect(runner.lastError).toBeNull();
    expect(runner.maxRetryAttempts).toBe(3);
    expect(runner.policyInfo).toEqual({
      strategy: 'fixed',
      maxRetryAttempts: 3,
      delayMS: 10,
    });
    expect(runner.retryCount).toBe(0);
    expect(runner.wasSuccessful).toBe(false);
    expect(runner.isRetryPending).toBe(false);
    expect(runner.isOperationRunning).toBe(false);
    expect(runner.isAttemptRunning).toBe(false);
    expect(runner.graceCancelPeriodMS).toBe(1000);
    expect(runner.timeTakenMS).toBe(-1);
    expect(runner.attemptTimeTakenMS).toBe(-1);
  });

  test('should honor operation label and grace period overrides', () => {
    const operation = (): void => {};
    const runner = new RetryRunner(policy, operation, {
      operationLabel: 'My Operation',
    });

    expect(runner.operationLabel).toBe('My Operation');

    runner.overrideGraceCancelPeriodMS(500);
    expect(runner.graceCancelPeriodMS).toBe(500);

    runner.overrideGraceCancelPeriodMS(-1);
    expect(runner.graceCancelPeriodMS).toBe(1000);
  });

  describe('run', () => {
    test('should run successfully on first attempt', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success', 'result');
      };

      const runner = new RetryRunner(policy, operation);
      const result = await runner.run(true);

      expect(result.status).toBe('attempt_success');
      if (result.status === 'attempt_success') {
        expect(result.data).toBe('result');
      }
      expect(runner.runnerState).toBe('completed');
      expect(runner.wasSuccessful).toBe(true);
      expect(runner.attempts).toBe(1);
    });

    test('should retry on error and eventually succeed', async () => {
      let attemptCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 3) {
          reportResult('error', new Error('Temporary failure'));
        } else {
          reportResult('success', 'result');
        }
      };

      const runner = new RetryRunner(policy, operation);
      const result = await runner.run(true);

      expect(result.status).toBe('attempt_success');
      expect(runner.runnerState).toBe('completed');
      expect(runner.attempts).toBe(3);
      expect(attemptCount).toBe(3);
    });

    test('should exhaust attempts after max retries', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('error', new Error('Always fails'));
      };

      const runner = new RetryRunner(policy, operation);
      const result = await runner.run(true);

      expect(result.status).toBe('attempts_exhausted');
      expect(runner.runnerState).toBe('exhausted');
      expect(runner.attempts).toBe(4); // 1 initial + 3 retries
      expect(runner.areAttemptsExhausted).toBe(true);
    });

    test('should handle fatal error without retry', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('fatal', new Error('Fatal error'));
      };

      const runner = new RetryRunner(policy, operation);
      const result = await runner.run(true);

      expect(result.status).toBe('attempt_fatal');
      expect(runner.runnerState).toBe('fatal-error');
      expect(runner.attempts).toBe(1);
    });

    test('should throw error if already running', async () => {
      const operation = async (reportResult: ReportResult): Promise<void> => {
        await sleep(50);
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false); // Start without waiting

      await sleep(10); // Give it time to start

      const result = await runner.run(true);

      expect(result.status).toBe('pre_operation_error');
      if (result.status === 'pre_operation_error') {
        expect(result.code).toBe('already_running');
        expect(result.error).toBeInstanceOf(RetryUtilsErrRunnerAlreadyRunning);
      }
    });

    test('should throw error if already completed', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      await runner.run(true);

      const result = await runner.run(true);

      expect(result.status).toBe('pre_operation_error');
      if (result.status === 'pre_operation_error') {
        expect(result.code).toBe('already_completed');
        expect(result.error).toBeInstanceOf(
          RetryUtilsErrRunnerAlreadyCompleted,
        );
      }
    });
  });

  describe('events', () => {
    test('should emit operation-started event', async () => {
      let didEventFired = false;

      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      runner.on(OPERATION_STARTED, (data) => {
        didEventFired = true;
        expect(data).toHaveProperty('operationType');
      });

      await runner.run(true);
      expect(didEventFired).toBe(true);
    });

    test('should emit operation-ended event', async () => {
      let didEventFired = false;

      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      runner.on(OPERATION_ENDED, (data) => {
        didEventFired = true;
        expect(data).toHaveProperty('runnerState');
        expect(data).toHaveProperty('timeTakenMS');
      });

      await runner.run(true);
      expect(didEventFired).toBe(true);
    });

    test('should emit attempt-started event', async () => {
      let eventCount = 0;

      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      runner.on(ATTEMPT_STARTED, (data) => {
        eventCount++;
        expect(data).toHaveProperty('attemptID');
        expect(data).toHaveProperty('operationTimeElapsedMS');
        expect(data).toHaveProperty('attemptTimeElapsedMS');
      });

      await runner.run(true);
      expect(eventCount).toBe(1);
    });

    test('should emit attempt-handled event', async () => {
      let didEventFired = false;

      const operation = (reportResult: ReportResult): void => {
        reportResult('success', 'result');
      };

      const runner = new RetryRunner(policy, operation);
      runner.on(ATTEMPT_HANDLED, (data) => {
        didEventFired = true;
        expect(data).toHaveProperty('attemptID');
        expect(data).toHaveProperty('status');
        expect(data).toHaveProperty('operationTimeElapsedMS');
        expect(data).toHaveProperty('attemptTimeElapsedMS');
        expect((data as { wasCanceled: boolean }).wasCanceled).toBe(false);
      });

      await runner.run(true);
      expect(didEventFired).toBe(true);
    });

    test('should emit events for each retry attempt', async () => {
      let attemptCount = 0;
      let attemptStartedCount = 0;
      let attemptHandledCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 3) {
          reportResult('error', new Error('Temporary failure'));
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      runner.on(ATTEMPT_STARTED, () => {
        attemptStartedCount++;
      });
      runner.on(ATTEMPT_HANDLED, () => {
        attemptHandledCount++;
      });

      await runner.run(true);

      expect(attemptStartedCount).toBe(3);
      expect(attemptHandledCount).toBe(3);
    });
  });

  describe('cancel', () => {
    test('should cancel running operation', async () => {
      let wasCanceledValue: boolean | undefined;

      const operation = async (
        reportResult: ReportResult,
        signal: AbortSignal,
      ): Promise<void> => {
        await sleep(100);
        if (signal.aborted) {
          reportResult('skip', 'canceled');
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      runner.on(ATTEMPT_HANDLED, (data) => {
        wasCanceledValue = (data as { wasCanceled: boolean }).wasCanceled;
      });
      void runner.run(false);

      await sleep(10);

      const cancelResult = await runner.cancel();
      expect(cancelResult).toBe('canceled');
      expect(runner.runnerState).toBe('stopped');
      expect(runner.wasSuccessful).toBe(false);
      expect(wasCanceledValue).toBe(true);
    });

    test('should return not-running if nothing is running', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      const cancelResult = await runner.cancel();

      expect(cancelResult).toBe('not-running');
    });

    test('should force cancel after grace period when attempt does not respond', async () => {
      let handledInfo: { wasCanceled?: boolean; status?: string } = {};

      const operation = async (): Promise<void> => {
        await sleep(50);
        // Intentionally do not call reportResult to simulate a hung attempt.
      };

      const runner = new RetryRunner(policy, operation);
      runner.overrideGraceCancelPeriodMS(0);
      runner.on(ATTEMPT_HANDLED, (data) => {
        handledInfo = {
          wasCanceled: (data as { wasCanceled: boolean }).wasCanceled,
          status: (data as { status: string }).status,
        };
      });

      void runner.run(false);
      await sleep(1);

      const cancelResult = await runner.cancel();

      expect(cancelResult).toBe('forced');
      expect(runner.runnerState).toBe('stopped');
      expect(handledInfo.wasCanceled).toBe(true);
      expect(handledInfo.status).toBe('skip');
    });
  });

  describe('reset', () => {
    test('should reset after completion', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      await runner.run(true);

      expect(runner.runnerState).toBe('completed');
      expect(runner.attempts).toBe(1);

      await runner.reset();

      expect(runner.runnerState).toBe('not-started');
      expect(runner.attempts).toBe(0);
      expect(runner.wasSuccessful).toBe(false);
    });

    test('should cancel before resetting if running', async () => {
      const operation = async (reportResult: ReportResult): Promise<void> => {
        await sleep(100);
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(10);

      await runner.reset();

      expect(runner.runnerState).toBe('not-started');
    });
  });

  describe('resume', () => {
    test('should resume after cancel', async () => {
      const operation = async (
        reportResult: ReportResult,
        signal: AbortSignal,
      ): Promise<void> => {
        await sleep(100);
        if (signal.aborted) {
          reportResult('skip');
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(10);
      await runner.cancel();

      const result = await runner.resume(true);

      expect(result.status).toBe('attempt_success');
      expect(runner.runnerState).toBe('completed');
    });

    test('should throw error if not paused', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      const result = await runner.resume(true);

      expect(result.status).toBe('pre_operation_error');
      if (result.status === 'pre_operation_error') {
        expect(result.code).toBe('not_paused');
        expect(result.error).toBeInstanceOf(RetryUtilsErrRunnerNotPaused);
      }
    });
  });

  describe('forceTry', () => {
    test('should force immediate retry when retry is pending', async () => {
      let attemptCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 2) {
          reportResult('error', new Error('First attempt fails'));
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(5); // Wait for first attempt to fail

      const result = await runner.forceTry({
        shouldWaitForCompletion: true,
      });

      expect(result.status).toBe('attempt_success');
      expect(runner.wasLastAttemptForced).toBe(true);
    });

    test('should return reattached: false when accelerating pending retry', async () => {
      let attemptCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 2) {
          reportResult('error', new Error('First attempt fails'));
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(5); // Wait for first attempt to fail and retry to be scheduled

      const result = await runner.forceTry({
        shouldWaitForCompletion: false,
      });

      expect(result.status).toBe('running');
      if (result.status === 'running') {
        expect(result.reattached).toBe(false);
      }
    });

    test('should not reset operation timer when accelerating pending retry', async () => {
      let attemptCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 2) {
          reportResult('error', new Error('First attempt fails'));
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(5); // Wait for first attempt to fail

      const timeBefore = runner.timeTakenMS;
      expect(timeBefore).toBeGreaterThan(0);

      await runner.forceTry({
        shouldWaitForCompletion: false,
      });

      await sleep(2);

      const timeAfter = runner.timeTakenMS;
      // Time should have continued from before, not reset
      expect(timeAfter).toBeGreaterThanOrEqual(timeBefore);
    });

    test('should attach to running attempt by default (no abort)', async () => {
      let attemptCount = 0;

      const operation = async (reportResult: ReportResult): Promise<void> => {
        attemptCount++;
        await sleep(50);
        reportResult('success', 'from-original');
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(10); // Attempt is now in-flight

      expect(runner.isAttemptRunning).toBe(true);

      // Default: attach to current attempt instead of aborting
      const result = await runner.forceTry({
        shouldWaitForCompletion: true,
      });

      expect(result.status).toBe('attempt_success');
      if (result.status === 'attempt_success') {
        expect(result.data).toBe('from-original');
      }
      expect(attemptCount).toBe(1); // Only one attempt was made
    });

    test('should return reattached: true when attaching to running attempt', async () => {
      const operation = async (reportResult: ReportResult): Promise<void> => {
        await sleep(50);
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(10); // Attempt is now in-flight

      const result = await runner.forceTry({
        shouldWaitForCompletion: false,
      });

      expect(result.status).toBe('running');
      if (result.status === 'running') {
        expect(result.reattached).toBe(true);
      }
    });

    test('should abort running attempt when shouldAbortRunning is true', async () => {
      let attemptCount = 0;

      const operation = async (
        reportResult: ReportResult,
        signal: AbortSignal,
      ): Promise<void> => {
        attemptCount++;
        await sleep(50);
        if (signal.aborted) {
          reportResult('skip', 'aborted');
        } else {
          reportResult('success', 'completed');
        }
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(10); // Attempt is now in-flight

      expect(runner.isAttemptRunning).toBe(true);

      const result = await runner.forceTry({
        shouldWaitForCompletion: true,
        shouldAbortRunning: true,
      });

      expect(result.status).toBe('attempt_success');
      expect(attemptCount).toBe(2); // Original was aborted, forced attempt ran
    });

    test('should throw error if already completed', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      await runner.run(true);

      const result = await runner.forceTry({
        shouldWaitForCompletion: true,
      });

      expect(result.status).toBe('pre_operation_error');
      if (result.status === 'pre_operation_error') {
        expect(result.code).toBe('already_completed');
        expect(result.error).toBeInstanceOf(
          RetryUtilsErrRunnerAlreadyCompleted,
        );
      }
    });
  });

  describe('waitForCompletion', () => {
    test('should wait for running operation to complete', async () => {
      const operation = async (reportResult: ReportResult): Promise<void> => {
        await sleep(50);
        reportResult('success', 'result');
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      const result = await runner.waitForCompletion();

      expect(result.status).toBe('attempt_success');
      if (result.status === 'attempt_success') {
        expect(result.data).toBe('result');
      }
    });

    test('should return not-started if not running', async () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      const result = await runner.waitForCompletion();

      expect(result.status).toBe('not_started');
      if (result.status === 'not_started') {
        expect(result.code).toBe('not_running');
        expect(result.error).toBeInstanceOf(RetryUtilsErrRunnerNotRunning);
      }
    });
  });

  describe('custom types', () => {
    test('should handle custom result types', async () => {
      const operation = (reportResult: ReportResult<CustomResult>): void => {
        reportResult('success', { message: 'Success', errorCode: 0 });
      };

      const runner = new RetryRunner<CustomResult>(policy, operation);
      const result = await runner.run(true);

      expect(result.status).toBe('attempt_success');
      if (result.status === 'attempt_success') {
        expect(result.data).toEqual({ message: 'Success', errorCode: 0 });
      }
    });
  });

  describe('skip status', () => {
    test('should handle skip status', async () => {
      let attemptCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 3) {
          reportResult('skip'); // Skip attempt
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      const result = await runner.run(true);

      expect(result.status).toBe('attempt_success');
      expect(attemptCount).toBe(3);
    });
  });

  describe('timers', () => {
    test('attemptTimeTakenMS should return -1 initially', () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      expect(runner.attemptTimeTakenMS).toBe(-1);
    });

    test('attemptTimeTakenMS should keep last attempt duration after completion', async () => {
      const operation = async (reportResult: ReportResult): Promise<void> => {
        await sleep(20);
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      await runner.run(true);

      // After completion, should show the duration of the last attempt
      const attemptTime = runner.attemptTimeTakenMS;
      expect(attemptTime).toBeGreaterThanOrEqual(20);
      expect(attemptTime).toBeLessThan(100); // Reasonable upper bound

      // Should remain stable
      await sleep(10);
      expect(runner.attemptTimeTakenMS).toBe(attemptTime);
    });

    test('attemptTimeTakenMS should update for each new attempt', async () => {
      let attemptCount = 0;

      const operation = async (reportResult: ReportResult): Promise<void> => {
        attemptCount++;
        if (attemptCount === 1) {
          await sleep(10);
          reportResult('error', new Error('First fails'));
        } else if (attemptCount === 2) {
          await sleep(30);
          reportResult('error', new Error('Second fails'));
        } else {
          await sleep(5);
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);

      let attempt1Time = 0;
      let attempt2Time = 0;
      let attempt3Time = 0;

      runner.on(ATTEMPT_HANDLED, () => {
        if (attemptCount === 1) {
          attempt1Time = runner.attemptTimeTakenMS;
        } else if (attemptCount === 2) {
          attempt2Time = runner.attemptTimeTakenMS;
        } else if (attemptCount === 3) {
          attempt3Time = runner.attemptTimeTakenMS;
        }
      });

      await runner.run(true);

      // Each attempt should have recorded its own duration
      expect(attempt1Time).toBeGreaterThanOrEqual(10);
      expect(attempt2Time).toBeGreaterThanOrEqual(30);
      expect(attempt3Time).toBeGreaterThanOrEqual(5);
      expect(attempt2Time).toBeGreaterThan(attempt1Time);

      // Final value should be the last attempt
      expect(runner.attemptTimeTakenMS).toBeCloseTo(attempt3Time, 0);
    });

    test('timeTakenMS should track total operation time', async () => {
      let attemptCount = 0;

      const operation = async (reportResult: ReportResult): Promise<void> => {
        attemptCount++;
        await sleep(10);
        if (attemptCount < 3) {
          reportResult('error', new Error('Temporary failure'));
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      await runner.run(true);

      // Total time should include all attempts + delays
      const totalTime = runner.timeTakenMS;
      expect(totalTime).toBeGreaterThan(30); // At least 3 attempts * 10ms each
    });
  });

  describe('retryTimeRemaining', () => {
    test('should return -1 when no retry is pending', () => {
      const operation = (reportResult: ReportResult): void => {
        reportResult('success');
      };

      const runner = new RetryRunner(policy, operation);
      expect(runner.retryTimeRemaining).toBe(-1);
    });

    test('should return remaining time when retry is pending', async () => {
      let attemptCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 2) {
          reportResult('error', new Error('First attempt fails'));
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      void runner.run(false);

      await sleep(5); // Wait for first attempt to fail and retry to be scheduled

      const remaining = runner.retryTimeRemaining;
      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(remaining).toBeLessThanOrEqual(10); // Should be <= delayMS (10ms in policy)
    });

    test('should return -1 after retry completes', async () => {
      let attemptCount = 0;

      const operation = (reportResult: ReportResult): void => {
        attemptCount++;
        if (attemptCount < 2) {
          reportResult('error', new Error('First attempt fails'));
        } else {
          reportResult('success');
        }
      };

      const runner = new RetryRunner(policy, operation);
      await runner.run(true);

      expect(runner.retryTimeRemaining).toBe(-1);
    });
  });
});
