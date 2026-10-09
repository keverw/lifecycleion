import { expect, spyOn, test } from 'bun:test';
import {
  RetryRunner,
  type ReportResult,
  type OnAttemptHandledInfo,
} from './retry-runner';
import * as idHelpers from '../../id-helpers';

const policy = { strategy: 'fixed', delayMS: 1, maxRetryAttempts: 1 } as const;

test.each(['shouldWaitForCompletion', 'shouldAbortRunning'] as const)(
  'forceTry guards and validates %s before dispatch',
  async (field) => {
    let calls = 0;
    const runner = new RetryRunner(policy, (report) => {
      calls++;
      report('success');
    });
    const options = Object.defineProperty({}, field, {
      get() {
        throw new Error('unreadable option');
      },
    });
    expect(await runner.forceTry(options)).toMatchObject({
      status: 'pre_operation_error',
      code: 'unexpected_error',
    });
    for (const value of [null, 1, 'false', {}]) {
      expect(await runner.forceTry({ [field]: value })).toMatchObject({
        status: 'pre_operation_error',
        code: 'unexpected_error',
      });
    }
    expect(calls).toBe(0);
    expect(runner.runnerState).toBe('not-started');
    expect(
      await runner.forceTry({ shouldWaitForCompletion: true }),
    ).toMatchObject({ status: 'attempt_success' });
    expect(calls).toBe(1);
  },
);

test.each(['typo', undefined, null, 0, {}])(
  'invalid runtime report status %j is fatal without a retry',
  async (status) => {
    let calls = 0;
    const runner = new RetryRunner(policy, (report) => {
      calls++;
      (report as (status: unknown) => void)(status);
    });
    const result = await runner.run(true);
    expect(result.status).toBe('attempt_fatal');
    expect(runner.lastError).toBeInstanceOf(TypeError);
    expect(runner.isRetryPending).toBe(false);
    expect(calls).toBe(1);
  },
);

test('force replacement accounts for a silent aborted attempt before starting the next', async () => {
  const handled: OnAttemptHandledInfo<unknown>[] = [];
  const started: string[] = [];
  const events: string[] = [];
  let calls = 0;
  let oldReport: ReportResult | undefined;
  const runner = new RetryRunner(
    policy,
    (report) => {
      if (++calls === 1) {
        oldReport = report;
      } else {
        report('success');
      }
    },
    {
      onAttemptStarted: ({ attemptID }) => {
        started.push(attemptID);
        events.push('started');
      },
      onAttemptHandled: (info) => {
        handled.push(info);
        events.push('handled');
      },
    },
  );
  await runner.run();
  expect(
    await runner.forceTry({
      shouldAbortRunning: true,
      shouldWaitForCompletion: true,
    }),
  ).toMatchObject({ status: 'attempt_success' });
  expect(events).toEqual(['started', 'handled', 'started', 'handled']);
  expect(handled[0]).toMatchObject({
    attemptID: started[0],
    status: 'skip',
    wasCanceled: true,
  });
  expect(handled[0].attemptTimeElapsedMS).toBeGreaterThanOrEqual(0);
  expect(runner.errors).toEqual([]);
  oldReport?.('skip');
  expect(handled).toHaveLength(2);
});

test('a newer cancel from the forced skip prevents replacement', async () => {
  let calls = 0;
  const runner = new RetryRunner(policy, () => {
    calls++;
  });
  runner.on('attempt-handled', () => {
    void runner.cancel();
  });
  await runner.run();
  expect(await runner.forceTry({ shouldAbortRunning: true })).toMatchObject({
    status: 'pre_operation_error',
    code: 'force_try_superseded',
  });
  expect(await runner.waitForCompletion()).toMatchObject({
    status: 'canceled',
  });
  expect(calls).toBe(1);
});

test('a newer cancel from the forced skip settles a pending cancellation', async () => {
  const runner = new RetryRunner(policy, () => {});
  runner.overrideGraceCancelPeriodMS(50);
  const listenerCancels: Promise<unknown>[] = [];
  const runResult = runner.run(true);
  const firstCancel = runner.cancel();
  expect(runner.runnerState).toBe('stopping');
  runner.on('attempt-handled', () => {
    listenerCancels.push(runner.cancel());
  });
  expect(await runner.forceTry({ shouldAbortRunning: true })).toMatchObject({
    status: 'pre_operation_error',
    code: 'force_try_superseded',
  });
  expect(runner.runnerState).toBe('stopped');
  expect(await firstCancel).toBe('canceled');
  expect(await Promise.all(listenerCancels)).toEqual(['canceled']);
  expect(await runResult).toMatchObject({ status: 'canceled' });
  expect(await runner.waitForCompletion()).toMatchObject({
    status: 'canceled',
  });
});

test('fatal reports record their error without invoking retry jitter', async () => {
  const failure = new Error('original fatal');
  const runner = new RetryRunner({ strategy: 'exponential' }, (report) => {
    report('fatal', failure);
  });
  const random = spyOn(Math, 'random').mockImplementation(() => {
    throw new Error('jitter must not run');
  });
  try {
    expect(await runner.run(true)).toEqual({
      status: 'attempt_fatal',
      error: failure,
    });
    expect(runner.lastError).toBe(failure);
    expect(random).not.toHaveBeenCalled();
  } finally {
    random.mockRestore();
  }
});

test('an invalid report status keeps the reported value on cause', async () => {
  const failure = new Error('reported with a typo');
  const runner = new RetryRunner(policy, (report) => {
    (report as (status: unknown, value: unknown) => void)('eror', failure);
  });
  const result = await runner.run(true);
  expect(result.status).toBe('attempt_fatal');
  expect(runner.lastError).toBeInstanceOf(TypeError);
  expect((runner.lastError as TypeError).cause).toBe(failure);
});

test('rethrowing the value reported with an invalid status is not reported again', async () => {
  const failure = new Error('reported with a typo, then rethrown');
  const reports: unknown[] = [];
  const onGlobalError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onGlobalError);
  try {
    const runner = new RetryRunner(policy, (report) => {
      (report as (status: unknown, value: unknown) => void)('eror', failure);
      throw failure;
    });
    expect((await runner.run(true)).status).toBe('attempt_fatal');
    expect(((runner.lastError as TypeError).cause as Error) === failure).toBe(
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reports).toEqual([]);
  } finally {
    globalThis.removeEventListener('error', onGlobalError);
  }
});

test('a late report with a symbol status is reported, not thrown out of reportResult', async () => {
  const reports: unknown[] = [];
  const onGlobalError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onGlobalError);
  try {
    let lateCall: (() => void) | undefined;
    const runner = new RetryRunner(policy, (report) => {
      report('success', 'done');
      lateCall = () =>
        (report as (status: unknown) => void)(Symbol('late-status'));
    });
    expect(await runner.run(true)).toEqual({
      status: 'attempt_success',
      data: 'done',
    });
    expect(() => lateCall?.()).not.toThrow();
    expect(reports).toHaveLength(1);
    expect(String((reports[0] as Error).message)).toContain(
      'attempt already settled',
    );
    expect(String(((reports[0] as Error).cause as Error).message)).toContain(
      "reportResult('Symbol(late-status)')",
    );
  } finally {
    globalThis.removeEventListener('error', onGlobalError);
  }
});

test('a throw while setting up an attempt ends the operation as an unexpected fatal error', async () => {
  const setupError = new Error('id generation failed');
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  const generateID = spyOn(idHelpers, 'generateID').mockImplementation(() => {
    throw setupError;
  });
  let calls = 0;
  try {
    const runner = new RetryRunner(policy, (report) => {
      calls++;
      report('success');
    });
    expect(await runner.run(true)).toEqual({
      status: 'attempt_fatal',
      code: 'unexpected_error',
      error: setupError,
    });
    expect(runner.runnerState).toBe('fatal-error');
    expect(await runner.waitForCompletion()).toMatchObject({
      status: 'attempt_fatal',
      code: 'unexpected_error',
    });
    expect(calls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
  } finally {
    generateID.mockRestore();
    process.off('unhandledRejection', onUnhandled);
  }
});
