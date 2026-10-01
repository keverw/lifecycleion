import { expect, spyOn, test } from 'bun:test';
import {
  ATTEMPT_HANDLED,
  OPERATION_ENDED,
  OPERATION_STARTED,
  RetryRunner,
  type CancelResult,
  type ReportResult,
  type RunResult,
} from './retry-runner';

const policy = { strategy: 'fixed' as const, maxRetryAttempts: 1, delayMS: 0 };

test('operation-started listeners can wait and cancel before an attempt begins', async () => {
  let invoked = 0;
  const runner = new RetryRunner(policy, () => {
    invoked++;
  });
  let completion: Promise<RunResult<unknown>> | undefined;
  let cancellation: Promise<CancelResult> | undefined;
  runner.on(OPERATION_STARTED, () => {
    completion = runner.waitForCompletion();
    cancellation = runner.cancel();
  });

  expect(await runner.run(true)).toMatchObject({ status: 'canceled' });
  expect(await completion).toMatchObject({ status: 'canceled' });
  expect(await cancellation).toBe('canceled');
  expect(invoked).toBe(0);
  expect(runner.runnerState).toBe('stopped');
});

test('a resumed operation publishes its completion promise before the start event', async () => {
  let invoked = 0;
  const runner = new RetryRunner(policy, () => {
    invoked++;
  });
  runner.overrideGraceCancelPeriodMS(0);
  await runner.run();
  await runner.cancel();

  let completion: Promise<RunResult<unknown>> | undefined;
  let cancellation: Promise<CancelResult> | undefined;
  runner.on(OPERATION_STARTED, () => {
    completion = runner.waitForCompletion();
    cancellation = runner.cancel();
  });

  expect(await runner.resume(true)).toMatchObject({ status: 'canceled' });
  expect(await completion).toMatchObject({ status: 'canceled' });
  expect(await cancellation).toBe('canceled');
  expect(invoked).toBe(1);
});

test('a forced operation publishes its completion promise before the start event', async () => {
  let invoked = 0;
  const runner = new RetryRunner(policy, () => {
    invoked++;
  });
  let completion: Promise<RunResult<unknown>> | undefined;
  let cancellation: Promise<CancelResult> | undefined;
  runner.on(OPERATION_STARTED, () => {
    completion = runner.waitForCompletion();
    cancellation = runner.cancel();
  });

  expect(
    await runner.forceTry({ shouldWaitForCompletion: true }),
  ).toMatchObject({
    status: 'canceled',
  });
  expect(await completion).toMatchObject({ status: 'canceled' });
  expect(await cancellation).toBe('canceled');
  expect(invoked).toBe(0);
});

test('attempt-handled listeners cannot cancel or force an outcome already reported', async () => {
  const runner = new RetryRunner(policy, (reportResult) => {
    reportResult('success', 'finished');
  });
  let cancellation: Promise<CancelResult> | undefined;
  let forced: Promise<RunResult<unknown>> | undefined;
  let completion: Promise<RunResult<unknown>> | undefined;
  let stateDuringHandled: string | undefined;
  runner.on(ATTEMPT_HANDLED, () => {
    stateDuringHandled = runner.runnerState;
    cancellation = runner.cancel();
    forced = runner.forceTry({ shouldWaitForCompletion: true });
    completion = runner.waitForCompletion();
  });

  expect(await runner.run(true)).toMatchObject({
    status: 'attempt_success',
    data: 'finished',
  });
  expect(await cancellation).toBe('not-running');
  expect(await forced).toMatchObject({
    status: 'pre_operation_error',
    code: 'lock_error',
  });
  expect(await completion).toMatchObject({ status: 'attempt_success' });
  expect(stateDuringHandled).toBe('running');
  expect(runner.runnerState).toBe('completed');
});

test('a terminal attempt listener cannot replace the operation before its result settles', async () => {
  let firstReport: ReportResult | undefined;
  let attempts = 0;
  const runner = new RetryRunner(policy, (reportResult) => {
    attempts++;
    if (attempts === 1) {
      firstReport = reportResult;
    } else {
      reportResult('success', 'second operation');
    }
  });
  expect(await runner.run()).toMatchObject({ status: 'running' });

  let forced: Promise<RunResult<unknown>> | undefined;
  let resetting: Promise<void> | undefined;
  runner.on(ATTEMPT_HANDLED, (info: { status: string }) => {
    if (info.status === 'fatal') {
      forced = runner.forceTry({ shouldWaitForCompletion: true });
      resetting = runner.reset();
    }
  });
  firstReport?.('fatal', new Error('first operation failed'));

  expect(await runner.waitForCompletion()).toMatchObject({
    status: 'attempt_fatal',
  });
  expect(await forced).toMatchObject({
    status: 'pre_operation_error',
    code: 'lock_error',
  });
  await resetting;
  expect(runner.runnerState).toBe('not-started');
  expect(attempts).toBe(1);
  expect(await runner.run(true)).toMatchObject({
    status: 'attempt_success',
    data: 'second operation',
  });
});

test('operation-ended listeners see the settled state and can wait for its result', async () => {
  const runner = new RetryRunner(policy, (reportResult) => {
    reportResult('success', 'finished');
  });
  let observedState: string | undefined;
  let completion: Promise<RunResult<unknown>> | undefined;
  runner.on(OPERATION_ENDED, () => {
    observedState = runner.runnerState;
    completion = runner.waitForCompletion();
  });

  expect(await runner.run(true)).toMatchObject({ status: 'attempt_success' });
  expect(observedState).toBe('completed');
  expect(await completion).toMatchObject({ status: 'attempt_success' });
});

test('operation-ended listeners cannot replace an unresolved fatal operation', async () => {
  let firstReport: ReportResult | undefined;
  let attempts = 0;
  const runner = new RetryRunner(policy, (reportResult) => {
    attempts++;
    if (attempts === 1) {
      firstReport = reportResult;
    } else {
      reportResult('success', 'after reset');
    }
  });
  await runner.run();

  let forced: Promise<RunResult<unknown>> | undefined;
  let resetting: Promise<void> | undefined;
  runner.on(OPERATION_ENDED, () => {
    if (attempts !== 1) {
      return;
    }
    forced = runner.forceTry({ shouldWaitForCompletion: true });
    resetting = runner.reset();
  });
  firstReport?.('fatal', new Error('fatal'));

  expect(await runner.waitForCompletion()).toMatchObject({
    status: 'attempt_fatal',
  });
  expect(await forced).toMatchObject({
    status: 'pre_operation_error',
    code: 'lock_error',
  });
  await resetting;
  expect(runner.runnerState).toBe('not-started');
  expect(attempts).toBe(1);
  expect(await runner.run(true)).toMatchObject({
    status: 'attempt_success',
    data: 'after reset',
  });
});

test('synchronous abort acknowledgement leaves no cancellation grace timer', async () => {
  const runnerURL = new URL('./retry-runner.ts', import.meta.url).href;
  const script = `
    const { RetryRunner } = await import(${JSON.stringify(runnerURL)});
    const runner = new RetryRunner(
      { strategy: 'fixed', maxRetryAttempts: 1, delayMS: 0 },
      (reportResult, signal) => {
        signal.addEventListener('abort', () => reportResult('skip', 'aborted'));
      },
    );
    runner.overrideGraceCancelPeriodMS(5000);
    await runner.run();
    const result = await runner.cancel();
    process.stdout.write(result);
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => child.kill(), 500);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('canceled');
    expect(stderr).toBe('');
  } finally {
    clearTimeout(timeout);
  }
});

test('an old attempt cannot complete cancellation of a forced replacement', async () => {
  let report: ReportResult | undefined;
  let attempts = 0;
  const runner = new RetryRunner(
    { strategy: 'fixed', maxRetryAttempts: 3, delayMS: 10 },
    (reportResult) => {
      attempts++;
      report = reportResult;
    },
  );
  runner.overrideGraceCancelPeriodMS(10);
  let forced: Promise<RunResult<unknown>> | undefined;
  let cancellation: Promise<CancelResult> | undefined;
  let resetting: Promise<void> | undefined;
  runner.once(ATTEMPT_HANDLED, () => {
    forced = runner.forceTry();
    cancellation = runner.cancel();
  });
  runner.once(OPERATION_ENDED, () => {
    resetting = runner.reset();
  });
  const running = runner.run(true);
  report?.('error', new Error('first attempt failed'));
  expect(await running).toMatchObject({ status: 'canceled' });
  expect(await forced).toMatchObject({ status: 'running' });
  expect(await cancellation).toBe('forced');
  expect(resetting).toBeDefined();
  await resetting;
  expect(attempts).toBe(2);
  expect(runner.runnerState).toBe('not-started');
}, 1000);

test.each([0, 1000])(
  'cancel from a retry-scheduled handled listener clears timers (delay %sms)',
  async (delayMS) => {
    let report: ReportResult | undefined;
    let attempts = 0;
    const runner = new RetryRunner(
      { strategy: 'fixed', maxRetryAttempts: 3, delayMS },
      (reportResult, signal) => {
        attempts++;
        report = reportResult;
        signal.addEventListener('abort', () => reportResult('skip', 'aborted'));
      },
    );
    const timer = spyOn(globalThis, 'setTimeout');
    const clear = spyOn(globalThis, 'clearTimeout');
    let cancellation: Promise<CancelResult> | undefined;
    runner.once(ATTEMPT_HANDLED, () => {
      cancellation = runner.cancel();
    });
    try {
      const running = runner.run(true);
      expect(report).toBeDefined();
      report?.('error', new Error('retryable failure'));
      expect(await cancellation).toBe('canceled');
      expect(await running).toMatchObject({ status: 'canceled' });
      expect(runner.runnerState).toBe('stopped');
      expect(runner.isRetryPending).toBe(false);
      // RetryPolicy floors even a requested zero delay to 1ms, so cancellation
      // must remove the scheduled retry before it invokes another attempt.
      expect(attempts).toBe(1);
      expect(timer).toHaveBeenCalledTimes(1);
      for (const result of timer.mock.results) {
        if (result.type === 'return') {
          expect(clear).toHaveBeenCalledWith(result.value);
        }
      }
    } finally {
      for (const result of timer.mock.results) {
        if (result.type === 'return') {
          clearTimeout(result.value);
        }
      }
      timer.mockRestore();
      clear.mockRestore();
      await runner.cancel();
    }
  },
);

test('a deferred terminal reset does not cancel a newer forced operation', async () => {
  let report: ReportResult | undefined;
  let attempts = 0;
  let wasAborted = false;
  const runner = new RetryRunner(policy, (reportResult, signal) => {
    attempts++;
    report = reportResult;
    signal.addEventListener('abort', () => {
      wasAborted = true;
      reportResult('skip');
    });
  });
  await runner.run();
  let resetting: Promise<void> | undefined;
  let replacement: Promise<RunResult<unknown>> | undefined;
  runner.once(ATTEMPT_HANDLED, () => {
    queueMicrotask(() => {
      replacement = runner.forceTry({ shouldWaitForCompletion: true });
    });
    resetting = runner.reset();
  });
  report?.('fatal', new Error('old operation'));
  await resetting;
  expect(attempts).toBe(2);
  expect(wasAborted).toBe(false);
  expect(runner.runnerState).toBe('running');
  report?.('success', 'replacement');
  expect(await replacement).toMatchObject({
    status: 'attempt_success',
    data: 'replacement',
  });
});

test('reset does not clear a forced restart that reuses its unresolved result', async () => {
  const reports: ReportResult[] = [];
  const runner = new RetryRunner(policy, (reportResult) => {
    reports.push(reportResult);
  });
  const originalResult = runner.run(true);
  const resetting = runner.reset();
  expect(runner.runnerState).toBe('stopping');
  const replacement = runner.forceTry({
    shouldAbortRunning: true,
    shouldWaitForCompletion: true,
  });
  await resetting;
  expect(reports).toHaveLength(2);
  expect(runner.runnerState).toBe('running');
  reports[0]('success', 'stale');
  reports[1]('success', 'replacement');
  expect(await replacement).toMatchObject({
    status: 'attempt_success',
    data: 'replacement',
  });
  expect(await originalResult).toMatchObject({
    status: 'attempt_success',
    data: 'replacement',
  });
});

test('forceTry respects success reported synchronously by its abort listener', async () => {
  let attempts = 0;
  const runner = new RetryRunner(policy, (reportResult, signal) => {
    attempts++;
    signal.addEventListener('abort', () =>
      reportResult('success', 'finished on abort'),
    );
  });
  const original = runner.run(true);
  const forced = await runner.forceTry({ shouldAbortRunning: true });
  expect(forced).toMatchObject({ code: 'already_completed' });
  expect(await original).toMatchObject({
    status: 'attempt_success',
    data: 'finished on abort',
  });
  expect(attempts).toBe(1);
  expect(runner.runnerState).toBe('completed');
});

test('reset leaves an operation resumed before its cancellation continuation alone', async () => {
  const reports: ReportResult[] = [];
  const runner = new RetryRunner(policy, (reportResult) => {
    reports.push(reportResult);
  });
  await runner.run();
  let resumed: Promise<RunResult<unknown>> | undefined;
  runner.once(OPERATION_ENDED, () => {
    // Terminal listeners intentionally cannot resume until dispatch has finished.
    queueMicrotask(() => {
      resumed = runner.resume(true);
    });
  });
  const resetting = runner.reset();
  reports[0]('skip');
  await resetting;
  expect(reports).toHaveLength(2);
  expect(runner.runnerState).toBe('running');
  reports[1]('success', 'resumed');
  expect(await resumed).toMatchObject({
    status: 'attempt_success',
    data: 'resumed',
  });
});
