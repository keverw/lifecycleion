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
  isLinkedToAbort,
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

test('manager timeout refusals are classified by settlement and result factories, and released once handed back', async () => {
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
    expect(reports).toHaveLength(0);
    // Handed back, the error is the caller's: rethrown, it is not this manager's refusal.
    expect(result.error).toBeInstanceOf(TypeError);
    expect(isOperationOptionRefusal(result.error)).toBe(false);

    // Builders carry the code they are handed; the shared classifier supplies it.
    const refusal = invalidOperationOptionError(
      'test option must be a boolean',
    );
    const code = settledFailureCode(refusal);
    expect(code).toBe('invalid_options');
    expect(crashedShutdownResult(refusal, 'failure', code).code).toBe(
      'invalid_options',
    );
    expect(
      crashedComponentResult('example', refusal, 'failure', code).code,
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

test('isLinkedToAbort recognizes the reason, an AbortError, and either on the cause chain', () => {
  const reason = new Error('interrupted');
  expect(isLinkedToAbort(reason, reason)).toBe(true);
  expect(isLinkedToAbort(new Error('wrapped', { cause: reason }), reason)).toBe(
    true,
  );
  expect(
    isLinkedToAbort(new DOMException('aborted', 'AbortError'), reason),
  ).toBe(true);
  expect(
    isLinkedToAbort(
      new Error('wrapped', {
        cause: Object.assign(new Error('aborted'), { name: 'AbortError' }),
      }),
      reason,
    ),
  ).toBe(true);

  expect(isLinkedToAbort(new Error('unrelated'), reason)).toBe(false);
  expect(isLinkedToAbort('interrupted', reason)).toBe(false);
  expect(isLinkedToAbort(undefined, reason)).toBe(false);
  expect(
    isLinkedToAbort(new DOMException('late', 'TimeoutError'), reason),
  ).toBe(false);
});

test('isLinkedToAbort reads hostile values defensively and bounds its walk', () => {
  const reason = new Error('interrupted');
  const refusing = new Proxy(
    {},
    {
      get(): never {
        throw new Error('refused');
      },
    },
  );
  const revocable = Proxy.revocable({}, {});
  revocable.revoke();
  const throwingCause = Object.defineProperty(new Error('x'), 'cause', {
    get(): never {
      throw new Error('hostile cause');
    },
  });

  expect(isLinkedToAbort(refusing, reason)).toBe(false);
  expect(isLinkedToAbort(revocable.proxy, reason)).toBe(false);
  expect(isLinkedToAbort(throwingCause, reason)).toBe(false);

  // A cycle is visited once; every link is read at most once.
  let causeReads = 0;
  const first = new Error('first');
  const second = new Error('second', { cause: first });
  Object.defineProperty(first, 'cause', {
    get(): unknown {
      causeReads++;
      return second;
    },
  });
  expect(isLinkedToAbort(first, reason)).toBe(false);
  expect(causeReads).toBe(1);

  // An endless chain: each read mints a fresh wrapper, so only the bound stops it.
  let mints = 0;
  const endless = (): Error =>
    Object.defineProperty(new Error('endless'), 'cause', {
      get(): Error {
        mints++;
        return endless();
      },
    });
  expect(isLinkedToAbort(endless(), reason)).toBe(false);
  expect(mints).toBe(16);

  // Within the bound the reason is found; past it, it is not.
  const wrap = (depth: number): unknown => {
    let error: unknown = reason;
    for (let level = 0; level < depth; level++) {
      error = new Error(`level ${level}`, { cause: error });
    }
    return error;
  };
  expect(isLinkedToAbort(wrap(16), reason)).toBe(true);
  expect(isLinkedToAbort(wrap(17), reason)).toBe(false);
});

test('settlement releases refusals nested in a result, without reading caller data', async () => {
  const nested = invalidOperationOptionError('nested refusal');
  const listed = invalidOperationOptionError('listed refusal');
  const inData = invalidOperationOptionError('caller data');
  let dataReads = 0;
  const data = {
    get error(): Error {
      dataReads++;
      return inData;
    },
  };
  const result = await settleOperation(
    'example',
    () =>
      Promise.resolve({
        startResult: { error: nested },
        results: [{ error: listed }],
        data,
      }),
    () => {
      throw new Error('unexpected failure');
    },
  );
  expect(result.startResult.error).toBe(nested);
  expect(isOperationOptionRefusal(nested)).toBe(false);
  expect(isOperationOptionRefusal(listed)).toBe(false);
  expect(dataReads).toBe(0);
  expect(isOperationOptionRefusal(inData)).toBe(true);
});
