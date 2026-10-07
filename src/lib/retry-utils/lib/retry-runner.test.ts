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
  muteConsoleError,
  restoreConsoleError,
} from '../../internal/console-test-utils';
import {
  RetryUtilsErrRunnerAlreadyCompleted,
  RetryUtilsErrRunnerAlreadyRunning,
  RetryUtilsErrRunnerNotPaused,
  RetryUtilsErrRunnerNotRunning,
} from './retry-utils-errors';
import { MAX_TIMER_MS } from '../../internal/timer-limits';
import { hostileRejections } from '../../internal/hostile-promise-test-utils';

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

    expect(() => runner.overrideGraceCancelPeriodMS(-1)).toThrow(RangeError);
    expect(runner.graceCancelPeriodMS).toBe(500);

    expect(() => runner.overrideGraceCancelPeriodMS(Number.NaN)).toThrow(
      TypeError,
    );
    expect(() =>
      runner.overrideGraceCancelPeriodMS('500' as unknown as number),
    ).toThrow(TypeError);

    for (const value of [null, undefined]) {
      expect(() =>
        runner.overrideGraceCancelPeriodMS(value as unknown as number),
      ).toThrow(TypeError);
      expect(runner.graceCancelPeriodMS).toBe(500);
    }

    runner.overrideGraceCancelPeriodMS(Infinity);
    expect(runner.graceCancelPeriodMS).toBe(MAX_TIMER_MS);

    runner.overrideGraceCancelPeriodMS(3e9);
    expect(runner.graceCancelPeriodMS).toBe(MAX_TIMER_MS);
  });

  test('a NaN retry delay waits on a timer instead of retrying synchronously', async () => {
    let invoked = 0;
    const runner = new RetryRunner(policy, (reportResult: ReportResult) => {
      invoked++;
      if (invoked === 1) {
        reportResult('error', new Error('boom'));
      } else {
        reportResult('success', 'done');
      }
    });
    // Unreachable through RetryPolicy itself, so the backstop is reached by stubbing it.
    const internals = runner as unknown as {
      policy: { shouldRetry: (...args: unknown[]) => unknown };
    };
    const original = internals.policy.shouldRetry.bind(internals.policy);
    internals.policy.shouldRetry = (...args: unknown[]) => {
      original(...args);
      return { shouldRetry: true, delayMS: NaN };
    };

    const completion = runner.run(true);
    expect(invoked).toBe(1);
    expect(runner.isRetryPending).toBe(true);
    expect(Number.isFinite(runner.retryTimeRemaining)).toBe(true);
    expect(await completion).toMatchObject({ status: 'attempt_success' });
    expect(invoked).toBe(2);
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

    test('an aborted attempt reporting its abort is not called a double report', async () => {
      // `reportResult` discards a result whose context is no longer current, and the
      // discard is reported on the global `'error'` channel so a genuine double report is
      // not left to be inferred from a missing event. But the id no longer matching *is*
      // this API's documented abort flow: `forceTry({ shouldAbortRunning: true })` aborts
      // the running context and moves on, and the contract tells the operation to call
      // `reportResult('skip', 'aborted')` when it notices `signal.aborted`. Doing exactly
      // what it was asked dispatched a synthetic uncaught error - which in a browser also
      // reaches `window.onerror` and any monitoring attached to it.
      const captured = muteConsoleError();
      const events: unknown[] = [];
      const onGlobalError = (event: unknown): void => {
        events.push(event);
      };

      globalThis.addEventListener?.('error', onGlobalError);

      try {
        const operation = async (
          reportResult: ReportResult,
          signal: AbortSignal,
        ): Promise<void> => {
          await sleep(50);

          if (signal.aborted) {
            reportResult('skip', 'aborted');
          } else {
            reportResult('success', 'completed');
          }
        };

        const runner = new RetryRunner(policy, operation);
        void runner.run(false);

        await sleep(10);

        await runner.forceTry({
          shouldWaitForCompletion: true,
          shouldAbortRunning: true,
        });

        // Long enough for the aborted attempt's own `reportResult` to land.
        await sleep(100);

        expect(
          captured.filter((line) => line.includes('already settled')),
        ).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        globalThis.removeEventListener?.('error', onGlobalError);
        restoreConsoleError();
      }
    });

    test('a throw of undefined after reportResult(success) is still reported', async () => {
      // The rethrow guard compared the thrown value to whatever was last reported, and a
      // no-arg `reportResult('success')` stores `undefined` - so `throw undefined`, or a
      // bare `Promise.reject()` from a cleanup step, compared equal and was dropped. The
      // runner stayed `completed`/`success` and the `'error'` channel never heard of it,
      // which is the post-success failure `handleReportResult` exists to keep.
      const captured = muteConsoleError();
      const events: unknown[] = [];
      const onGlobalError = (event: unknown): void => {
        events.push(event);
      };

      globalThis.addEventListener?.('error', onGlobalError);

      try {
        const operation = async (reportResult: ReportResult): Promise<void> => {
          reportResult('success');
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the bare rejection is the case
          await Promise.reject();
        };

        const runner = new RetryRunner(policy, operation);

        await runner.run(true);
        await sleep(10);

        const didSurface =
          captured.some((line) => line.includes('already settled')) ||
          events.length > 0;

        expect(didSurface).toBe(true);
      } finally {
        globalThis.removeEventListener?.('error', onGlobalError);
        restoreConsoleError();
      }
    });

    test('a throw of undefined after reportResult(skip) is still reported', async () => {
      const captured = muteConsoleError();
      const events: unknown[] = [];
      const onGlobalError = (event: unknown): void => {
        events.push(event);
      };

      globalThis.addEventListener?.('error', onGlobalError);

      try {
        // A skip is retried and never counts as a failure, so a second attempt succeeds
        // to let the run finish; the throw under test is on the first.
        let attempt = 0;

        const operation = (reportResult: ReportResult): void => {
          attempt++;

          if (attempt > 1) {
            reportResult('success');

            return;
          }

          reportResult('skip');
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- `throw undefined` is the case
          throw undefined;
        };

        const runner = new RetryRunner(policy, operation);

        await runner.run(true);
        await sleep(10);

        const didSurface =
          captured.some((line) => line.includes('already settled')) ||
          events.length > 0;

        expect(didSurface).toBe(true);
      } finally {
        globalThis.removeEventListener?.('error', onGlobalError);
        restoreConsoleError();
      }
    });

    test('a rethrow of the error already reported is not a second outcome', async () => {
      // The shape the guard exists for: `catch (e) { reportResult('error', e); throw e; }`
      // is one outcome recorded once, not a double report.
      const captured = muteConsoleError();
      const events: unknown[] = [];
      const onGlobalError = (event: unknown): void => {
        events.push(event);
      };

      globalThis.addEventListener?.('error', onGlobalError);

      try {
        const failure = new Error('once');

        const operation = (reportResult: ReportResult): void => {
          reportResult('error', failure);
          throw failure;
        };

        const runner = new RetryRunner(
          { ...policy, maxRetryAttempts: 1 },
          operation,
        );

        await runner.run(true);
        await sleep(10);

        expect(
          captured.filter((line) => line.includes('already settled')),
        ).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        globalThis.removeEventListener?.('error', onGlobalError);
        restoreConsoleError();
      }
    });

    test('a rethrow of the error reported as fatal is not a second outcome either', async () => {
      // `catch (e) { reportResult('fatal', e); throw e; }` is the same shape with the
      // other error status, and was still dispatched as a late throw.
      const captured = muteConsoleError();
      const events: unknown[] = [];
      const onGlobalError = (event: unknown): void => {
        events.push(event);
      };

      globalThis.addEventListener?.('error', onGlobalError);

      try {
        const failure = new Error('fatal once');

        const operation = (reportResult: ReportResult): void => {
          reportResult('fatal', failure);
          throw failure;
        };

        const runner = new RetryRunner(policy, operation);
        const result = await runner.run(true);

        await sleep(10);

        expect(result.status).toBe('attempt_fatal');
        expect(
          captured.filter((line) => line.includes('already settled')),
        ).toEqual([]);
        expect(events).toEqual([]);
      } finally {
        globalThis.removeEventListener?.('error', onGlobalError);
        restoreConsoleError();
      }
    });

    test('a genuine double report on an unaborted attempt is still surfaced', async () => {
      // The other half of the same rule: nothing here was aborted, so a second
      // `reportResult` is the caller bug this diagnostic exists for.
      const captured = muteConsoleError();
      const events: unknown[] = [];
      const onGlobalError = (event: unknown): void => {
        events.push(event);
      };

      globalThis.addEventListener?.('error', onGlobalError);

      try {
        const operation = (reportResult: ReportResult): void => {
          reportResult('success', 'first');
          reportResult('success', 'second');
        };

        const runner = new RetryRunner(policy, operation);

        await runner.run(true);
        await sleep(10);

        const didSurface =
          captured.some((line) => line.includes('already settled')) ||
          events.length > 0;

        expect(didSurface).toBe(true);
      } finally {
        globalThis.removeEventListener?.('error', onGlobalError);
        restoreConsoleError();
      }
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
      expect(attemptTime).toBeLessThan(1000); // Room for noisy CI timers

      // Should remain stable
      await sleep(10);
      expect(runner.attemptTimeTakenMS).toBe(attemptTime);
    });

    test('attemptTimeTakenMS should update for each new attempt', async () => {
      let attemptCount = 0;

      const operation = async (reportResult: ReportResult): Promise<void> => {
        attemptCount++;
        if (attemptCount === 1) {
          await sleep(40);
          reportResult('error', new Error('First fails'));
        } else if (attemptCount === 2) {
          // Keep a wide gap vs attempt 1 so noisy CI cannot invert the order.
          await sleep(250);
          reportResult('error', new Error('Second fails'));
        } else {
          await sleep(20);
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

      // Each attempt should have recorded its own duration (floors leave room for
      // timer undershoot; relative order uses a large sleep gap instead of tight bounds).
      expect(attempt1Time).toBeGreaterThanOrEqual(30);
      expect(attempt2Time).toBeGreaterThanOrEqual(200);
      expect(attempt3Time).toBeGreaterThanOrEqual(10);
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

describe('RetryRunner - an operation returning a hostile rejected promise', () => {
  test.each(hostileRejections)(
    'one with %s fails the attempt',
    async (_label, make) => {
      // The failure is reported; kept out of the run output.
      muteConsoleError();
      const runner = new RetryRunner(
        { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 1 },
        () => make(new Error('operation rejected')),
      );

      try {
        const outcome = await Promise.race([
          runner.run(true).then(() => 'settled'),
          sleep(200).then(() => 'hung'),
        ]);

        expect(outcome).toBe('settled');
        expect(runner.lastError).toBeInstanceOf(Error);
        expect((runner.lastError as Error).message).toBe('operation rejected');
      } finally {
        restoreConsoleError();
      }
    },
  );
});

test('operation thenable uses its first then read and observes rejection', async () => {
  muteConsoleError();
  let reads = 0;
  let attempts = 0;
  const failure = new Error('operation failed');
  const runner = new RetryRunner(
    { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 1 },
    () => {
      attempts++;
      let resultReads = 0;
      return {
        get then() {
          reads++;
          if (++resultReads > 1) {
            return undefined;
          }
          return (
            _resolve: unknown,
            reject: (reason: unknown) => void,
          ): void => {
            reject(failure);
          };
        },
      } as unknown as Promise<void>;
    },
  );
  try {
    const outcome = await Promise.race([
      runner.run(true).then(() => 'settled'),
      sleep(200).then(() => 'hung'),
    ]);
    expect(outcome).toBe('settled');
    expect(reads).toBe(attempts);
    expect(runner.lastError).toBe(failure);
  } finally {
    restoreConsoleError();
  }
});

test('waiting for completion does not retain the dispatch lock', async () => {
  const gate = Promise.withResolvers<void>();
  const runner = new RetryRunner(
    { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 0 },
    async (report) => {
      await gate.promise;
      report('success');
    },
  );
  const pending = runner.run(true);
  try {
    // An indiscriminate return-await inside run's try/finally would hold the lock
    // for the whole attempt and wrongly refuse this legitimate attachment.
    expect(await runner.forceTry({ shouldWaitForCompletion: false })).toEqual({
      status: 'running',
      reattached: true,
    });
  } finally {
    gate.resolve();
    await pending;
  }
});

test('operation then getter failure preserves its original error identity', async () => {
  class FatalError extends Error {
    public readonly code = 'FATAL';
  }
  const failure = new FatalError('cannot read operation then');
  const handledErrors: unknown[] = [];
  const runner = new RetryRunner(
    { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 0 },
    () =>
      ({
        get then() {
          throw failure;
        },
      }) as unknown as Promise<void>,
    { onAttemptHandled: (info) => handledErrors.push(info.error) },
  );

  const result = await runner.run(true);

  expect(result.status).toBe('attempts_exhausted');
  expect('error' in result && result.error).toBe(failure);
  expect(runner.lastError).toBe(failure);
  expect(handledErrors.length).toBeGreaterThan(0);
  for (const error of handledErrors) {
    expect(error).toBe(failure);
  }
});

test.each(['error', 'fatal'] as const)(
  'operation then getter rethrow of reported %s is not a second outcome',
  async (status) => {
    const captured = muteConsoleError();
    const events: unknown[] = [];
    const onGlobalError = (event: unknown): void => {
      events.push(event);
    };
    globalThis.addEventListener?.('error', onGlobalError);

    try {
      const failure = new Error('already reported');
      const runner = new RetryRunner(
        { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 0 },
        (reportResult) => {
          if (status === 'fatal') {
            reportResult('fatal', failure);
          } else {
            reportResult('error', failure);
          }
          return {
            get then() {
              throw failure;
            },
          } as unknown as Promise<void>;
        },
      );

      const result = await runner.run(true);
      await sleep(10);

      expect(result.status).toBe(
        status === 'fatal' ? 'attempt_fatal' : 'attempts_exhausted',
      );
      expect(runner.lastError).toBe(failure);
      expect(captured).toEqual([]);
      expect(events).toEqual([]);
    } finally {
      globalThis.removeEventListener?.('error', onGlobalError);
      restoreConsoleError();
    }
  },
);

test('an unreadable then after a settled attempt is reported as a return-contract failure, not a throw', async () => {
  const getterError = new Error('then getter failed');
  const reports: unknown[] = [];
  const onGlobalError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onGlobalError);

  try {
    const runner = new RetryRunner(
      { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 0 },
      (reportResult) => {
        reportResult('success', 'done');
        return {
          get then() {
            throw getterError;
          },
        } as unknown as Promise<void>;
      },
    );

    const result = await runner.run(true);
    await sleep(10);

    expect(result).toEqual({ status: 'attempt_success', data: 'done' });
    expect(runner.runnerState).toBe('completed');
    expect(reports).toHaveLength(1);

    const report = reports[0] as Error;
    expect(report.message).toContain('returned an unreadable then');
    expect(report.message).not.toContain('threw');

    const cause = report.cause as Error;
    expect(cause.message).toContain(
      'RetryRunner operation returned a value whose then could not be read',
    );
    expect(cause.cause).toBe(getterError);
  } finally {
    globalThis.removeEventListener('error', onGlobalError);
  }
});

test('runner options are each read exactly once', async () => {
  const reads: Record<string, number> = {};
  const calls: string[] = [];
  // Each getter hands out a usable value the first time only, so a second read would
  // see a non-function (or a non-string label) the first check never did.
  const once = <V>(name: string, value: V): (() => V | undefined) => {
    return () => {
      reads[name] = (reads[name] ?? 0) + 1;
      return reads[name] === 1 ? value : undefined;
    };
  };
  const options = {};
  for (const [name, value] of [
    ['operationLabel', 'labelled'],
    ['onOperationStarted', () => calls.push('operation-started')],
    ['onOperationEnded', () => calls.push('operation-ended')],
    ['onAttemptStarted', () => calls.push('attempt-started')],
    ['onAttemptHandled', () => calls.push('attempt-handled')],
  ] as const) {
    Object.defineProperty(options, name, {
      get: once(name, value),
      enumerable: true,
    });
  }

  const reports: unknown[] = [];
  const onGlobalError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onGlobalError);

  try {
    const runner = new RetryRunner(
      { strategy: 'fixed', maxRetryAttempts: 0, delayMS: 0 },
      (reportResult) => {
        reportResult('success');
      },
      options,
    );

    expect(await runner.run(true)).toEqual({ status: 'attempt_success' });
    expect(runner.operationLabel).toBe('labelled');
    expect(reads).toEqual({
      operationLabel: 1,
      onOperationStarted: 1,
      onOperationEnded: 1,
      onAttemptStarted: 1,
      onAttemptHandled: 1,
    });
    expect(calls).toEqual([
      'operation-started',
      'attempt-started',
      'attempt-handled',
      'operation-ended',
    ]);
    expect(reports).toEqual([]);
  } finally {
    globalThis.removeEventListener('error', onGlobalError);
  }
});

for (const failingDependency of ['random', 'timer'] as const) {
  test(`a throwing retry ${failingDependency} settles the operation as fatal`, async () => {
    const failure = new Error(`broken ${failingDependency}`);
    const runner = new RetryRunner(
      {
        strategy: 'exponential',
        maxRetryAttempts: 3,
        minTimeoutMS: 1,
        maxTimeoutMS: 100,
        factor: 2,
        dispersion: 0.2,
      },
      (report) => report('error', new Error('attempt failed')),
    );
    const random = Math.random;
    const timer = globalThis.setTimeout;
    let pending: ReturnType<typeof runner.run>;
    try {
      if (failingDependency === 'random') {
        Math.random = (): never => {
          throw failure;
        };
      } else {
        globalThis.setTimeout = (() => {
          throw failure;
        }) as unknown as typeof setTimeout;
      }
      pending = runner.run(true);
    } finally {
      Math.random = random;
      globalThis.setTimeout = timer;
    }
    const result = await Promise.race([pending, sleep(100).then(() => 'hung')]);
    expect(result).toEqual({
      status: 'attempt_fatal',
      code: 'unexpected_error',
      error: failure,
    });
    expect(runner.runnerState).toBe('fatal-error');
    expect(runner.isAttemptRunning).toBe(false);
    expect(runner.isRetryPending).toBe(false);
  });
}

function collectRetryCallbackReports(callbackName: string): {
  reports: Error[];
  release: () => void;
} {
  const reports: Error[] = [];
  const onGlobalError = (event: Event): void => {
    const reported = (event as ErrorEvent).error as Error;
    if (reported.message === `Error in a callback ${callbackName}`) {
      reports.push(reported);
      event.preventDefault();
    }
  };
  globalThis.addEventListener('error', onGlobalError);
  return {
    reports,
    release: () => globalThis.removeEventListener('error', onGlobalError),
  };
}

test('a cancellation timer that throws forces cancellation and settles existing waiters', async () => {
  const { reports, release } = collectRetryCallbackReports(
    'RetryRunner cancellation timer',
  );
  try {
    const failure = new Error('cancel timer failed');
    const runner = new RetryRunner(
      { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 1 },
      () => {},
    );
    const completion = runner.run(true);
    const timer = globalThis.setTimeout;
    let cancellation: ReturnType<typeof runner.cancel>;
    try {
      globalThis.setTimeout = (() => {
        throw failure;
      }) as unknown as typeof setTimeout;
      cancellation = runner.cancel();
    } finally {
      globalThis.setTimeout = timer;
    }
    expect(await cancellation).toBe('forced');
    expect(await completion).toEqual({ status: 'canceled' });
    expect(runner.runnerState).toBe('stopped');
    expect(runner.isAttemptRunning).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.cause).toBe(failure);
  } finally {
    release();
  }
});

for (const replacement of ['forceTry', 'cancel'] as const) {
  test(`a retry policy throw after ${replacement} preserves the newer outcome`, async () => {
    const { reports, release } = collectRetryCallbackReports(
      'RetryRunner retry scheduling',
    );
    try {
      const failure = new Error('policy threw after reentry');
      let reportFirst: ReportResult<string> | undefined;
      let attempts = 0;
      const runner = new RetryRunner<string>(
        {
          strategy: 'exponential',
          maxRetryAttempts: 3,
          minTimeoutMS: 1,
          maxTimeoutMS: 100,
          factor: 2,
          dispersion: 0.2,
        },
        (report) => {
          attempts++;
          if (attempts === 1) {
            reportFirst = report;
          } else {
            report('success', 'replacement');
          }
        },
      );
      const completion = runner.run(true);
      const random = Math.random;
      let replacementCall: Promise<unknown> | undefined;
      try {
        Math.random = () => {
          replacementCall =
            replacement === 'forceTry' ? runner.forceTry() : runner.cancel();
          throw failure;
        };
        if (reportFirst === undefined) {
          throw new Error('first attempt did not start');
        }
        reportFirst('error', new Error('attempt failed'));
      } finally {
        Math.random = random;
      }
      const outcome = await Promise.race([
        completion,
        sleep(100).then(() => 'hung'),
      ]);
      expect(outcome).toEqual(
        replacement === 'forceTry'
          ? { status: 'attempt_success', data: 'replacement' }
          : { status: 'canceled' },
      );
      await replacementCall;
      expect(runner.runnerState).toBe(
        replacement === 'forceTry' ? 'completed' : 'stopped',
      );
      expect(reports).toHaveLength(1);
      expect(reports[0]?.cause).toBe(failure);
    } finally {
      release();
    }
  });
}
