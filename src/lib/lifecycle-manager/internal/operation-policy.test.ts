import { expect, test } from 'bun:test';
import { toTimerDelayMS as sharedTimerDelay } from '../../internal/timer-limits';
import { claimReports } from '../test-helpers';
import {
  crashedComponentResult,
  crashedShutdownResult,
  crashedStartupResult,
  isOperationTimeoutValidationError,
  resolveOperationTimeoutMS,
  settleOperation,
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
        return Promise.resolve(crashedStartupResult(undefined, 'unreachable'));
      },
      crashedStartupResult,
    );
    expect(result.code).toBe('invalid_options');
    expect(result.reason).toContain('start() refused:');
    expect(isOperationTimeoutValidationError(result.error)).toBe(true);
    expect(reports).toHaveLength(0);
    if (result.error === undefined) {
      throw new Error('Expected a timeout error');
    }
    expect(crashedShutdownResult(result.error, 'failure').code).toBe(
      'invalid_options',
    );
    expect(
      crashedComponentResult('example', result.error, 'failure').code,
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
        return Promise.resolve(crashedStartupResult(undefined, 'unreachable'));
      },
      () => {
        return Promise.reject(callerError);
      },
    ]) {
      const result = await settleOperation('start', run, crashedStartupResult);
      expect(result.code).toBe('operation_crashed');
      expect(result.reason).toContain('start() failed unexpectedly:');
      expect(isOperationTimeoutValidationError(result.error)).toBe(false);
      expect((reports.at(-1) as Error).cause).toBe(result.error);
    }
    expect(reports).toHaveLength(2);
    expect((reports[1] as Error).cause).toBe(callerError);
  } finally {
    release();
  }
});
