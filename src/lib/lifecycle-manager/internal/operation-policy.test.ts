import { expect, test } from 'bun:test';
import { toTimerDelayMS as sharedTimerDelay } from '../../internal/timer-limits';
import { claimReports } from '../test-helpers';
import {
  crashedComponentResult,
  crashedHealthReport,
  crashedShutdownResult,
  crashedSignalBroadcastResult,
  crashedStartupResult,
  invalidOperationOptionError,
  isOperationOptionRefusal,
  resolveOperationTimeoutMS,
  settleOperation,
  settledFailureCode,
  toOperationTimerDelayMS,
} from './operation-policy';

test('operation settlement preserves successful results and accepts a disabled timeout', async () => {
  const success = { success: true };
  expect(
    await settleOperation(
      'example',
      () => Promise.resolve(success),
      () => {
        throw new Error('unexpected failure');
      },
    ),
  ).toBe(success);
  expect(resolveOperationTimeoutMS(undefined, 0)).toBe(0);
  expect(toOperationTimerDelayMS(0)).toBe(0);
});

test('manager timeout refusals retain provenance across settlement and result factories', async () => {
  const { reports, release } = claimReports();
  try {
    const result = await settleOperation(
      'start',
      () => {
        toOperationTimerDelayMS(NaN, 'test timeout');
        return Promise.resolve(
          crashedStartupResult(undefined, 'unreachable', 'operation_crashed'),
        );
      },
      (error, reason, code) => crashedStartupResult(error, reason, code),
    );
    expect(result.code).toBe('invalid_options');
    expect(result.reason).toContain('start() refused:');
    expect(isOperationOptionRefusal(result.error)).toBe(true);
    expect(reports).toHaveLength(0);
    if (result.error === undefined) {
      throw new Error('Expected a timeout error');
    }
    // Builders carry the code they are handed; the shared classifier supplies it.
    const code = settledFailureCode(result.error);
    expect(code).toBe('invalid_options');
    expect(crashedShutdownResult(result.error, 'failure', code).code).toBe(
      'invalid_options',
    );
    expect(
      crashedComponentResult('example', result.error, 'failure', code).code,
    ).toBe('invalid_options');
  } finally {
    release();
  }
});

test('raw shared timeout failures and caller errors remain reported operation crashes', async () => {
  const { reports, release } = claimReports();
  const callerError = new TypeError('caller bug');
  try {
    for (const run of [
      () => {
        sharedTimerDelay(NaN, 'caller timeout');
        return Promise.resolve(
          crashedStartupResult(undefined, 'unreachable', 'operation_crashed'),
        );
      },
      () => {
        return Promise.reject(callerError);
      },
    ]) {
      const result = await settleOperation(
        'start',
        run,
        (error, reason, code) => crashedStartupResult(error, reason, code),
      );
      expect(result.code).toBe('operation_crashed');
      expect(result.reason).toContain('start() failed unexpectedly:');
      expect(isOperationOptionRefusal(result.error)).toBe(false);
      expect((reports.at(-1) as Error).cause).toBe(result.error);
    }
    expect(reports).toHaveLength(2);
    expect((reports[1] as Error).cause).toBe(callerError);
  } finally {
    release();
  }
});

test('aggregate results of operations without caller options never answer invalid_options', () => {
  const { reports, release } = claimReports();
  try {
    // Neither `trigger*()` nor `checkAllHealth()` takes options, so a branded refusal
    // reaching their net is the manager's own bug: a reported crash, not a refusal.
    const refusal = invalidOperationOptionError('impossible option');
    const signal = crashedSignalBroadcastResult(
      'reload',
      refusal,
      'invalid_options',
    );
    const health = crashedHealthReport(refusal, 'invalid_options');
    expect(signal.code).toBe('operation_crashed');
    expect(signal.error).toBe(refusal);
    expect(health.code).toBe('operation_crashed');
    expect(health.error).toBe(refusal);
    expect(reports).toHaveLength(2);
    expect((reports[0] as Error).message).toContain('reload broadcast');
    expect((reports[1] as Error).message).toContain('checkAllHealth');

    // An ordinary crash was already reported by `settleOperation()`; not again here.
    const crash = new Error('crash');
    expect(crashedHealthReport(crash, 'operation_crashed').code).toBe(
      'operation_crashed',
    );
    expect(reports).toHaveLength(2);
  } finally {
    release();
  }
});
