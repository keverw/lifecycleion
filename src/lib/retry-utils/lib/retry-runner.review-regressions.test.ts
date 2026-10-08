import { expect, spyOn, test } from 'bun:test';
import {
  RetryRunner,
  type ReportResult,
  type OnAttemptHandledInfo,
} from './retry-runner';

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
