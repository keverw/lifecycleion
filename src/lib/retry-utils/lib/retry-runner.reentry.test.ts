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

test('a forced replacement that fails keeps its retry over the aborted attempt late success', async () => {
  const reports: ReportResult[] = [];
  const runner = new RetryRunner(policy, (reportResult) => {
    reports.push(reportResult);
  });
  await runner.run();
  await runner.forceTry({ shouldAbortRunning: true });
  reports[1]('error', new Error('replacement failed'));
  expect(runner.isRetryPending).toBe(true);
  reports[0]('success', 'stale');
  expect(runner.runnerState).toBe('running');
  expect(runner.isRetryPending).toBe(true);
  expect(runner.errors).toHaveLength(1);
  await runner.cancel();
});

test('an aborted attempt acknowledging after its replacement completed changes nothing', async () => {
  const reports: ReportResult[] = [];
  let endedCount = 0;
  const runner = new RetryRunner(policy, (reportResult) => {
    reports.push(reportResult);
  });
  runner.on(OPERATION_ENDED, () => {
    endedCount++;
  });
  await runner.run();
  const forced = runner.forceTry({
    shouldAbortRunning: true,
    shouldWaitForCompletion: true,
  });
  reports[1]('success', 'replacement');
  expect(await forced).toMatchObject({
    status: 'attempt_success',
    data: 'replacement',
  });
  reports[0]('skip', 'aborted');
  expect(runner.runnerState).toBe('completed');
  expect(runner.wasSuccessful).toBe(true);
  expect(endedCount).toBe(1);
});

test.each([false, true])(
  'forceTry respects synchronous abort success (waiting: %s)',
  async (shouldWaitForCompletion) => {
    let attempts = 0;
    const runner = new RetryRunner(policy, (reportResult, signal) => {
      attempts++;
      signal.addEventListener('abort', () =>
        reportResult('success', 'finished on abort'),
      );
    });
    const original = runner.run(true);
    const forced = await runner.forceTry({
      shouldAbortRunning: true,
      shouldWaitForCompletion,
    });
    expect(forced).toMatchObject(
      shouldWaitForCompletion
        ? { status: 'attempt_success', data: 'finished on abort' }
        : { code: 'already_completed' },
    );
    expect(await original).toMatchObject({
      status: 'attempt_success',
      data: 'finished on abort',
    });
    expect(attempts).toBe(1);
    expect(runner.runnerState).toBe('completed');
  },
);

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

for (const request of ['cancel', 'reset'] as const) {
  test.each([false, true])(
    `forceTry honors ${request} requested by abort (synchronous acknowledgement: %s)`,
    async (isSynchronous) => {
      let attempts = 0;
      let report: ReportResult | undefined;
      let requested: Promise<unknown> | undefined;
      const runner = new RetryRunner(policy, (reportResult, signal) => {
        attempts++;
        report = reportResult;
        signal.addEventListener(
          'abort',
          () => {
            requested = request === 'cancel' ? runner.cancel() : runner.reset();
            if (isSynchronous) {
              reportResult('skip');
            }
          },
          { once: true },
        );
      });
      runner.overrideGraceCancelPeriodMS(10);
      const original = runner.run(true);
      const forced = runner.forceTry({
        shouldAbortRunning: true,
        shouldWaitForCompletion: true,
      });
      if (!isSynchronous) {
        report?.('skip');
      }
      try {
        await requested;
        expect(attempts).toBe(1);
        expect(runner.runnerState).toBe(
          request === 'cancel' ? 'stopped' : 'not-started',
        );
        expect(await forced).toMatchObject({ status: 'canceled' });
        expect(await original).toMatchObject({ status: 'canceled' });
      } finally {
        await runner.cancel();
      }
    },
  );
}

test.each(['cancel', 'reset'] as const)(
  'non-waiting force returns before abort-listener %s settles',
  async (request) => {
    let report: ReportResult | undefined;
    let stopped: Promise<unknown> | undefined;
    const runner = new RetryRunner(policy, (reportResult, signal) => {
      report = reportResult;
      signal.addEventListener(
        'abort',
        () => {
          stopped = request === 'cancel' ? runner.cancel() : runner.reset();
        },
        { once: true },
      );
    });
    const original = runner.run(true);
    const forced = runner.forceTry({ shouldAbortRunning: true });
    try {
      const result = await forced;
      expect(result).toMatchObject({
        status: 'pre_operation_error',
        code: 'force_try_superseded',
      });
      expect(runner.runnerState).toBe('stopping');
    } finally {
      report?.('skip');
      await stopped;
      await original;
      await forced;
    }
  },
);

for (const outcome of ['skip', 'error', 'fatal', 'exhausted'] as const) {
  test(`forceTry chooses the live branch after abort reports ${outcome}`, async () => {
    const reports: ReportResult[] = [];
    const retryStarted = Promise.withResolvers<void>();
    let hasInitialEnded = false;
    const runner = new RetryRunner(
      {
        strategy: 'fixed',
        maxRetryAttempts: outcome === 'exhausted' ? 1 : 5,
        delayMS: outcome === 'exhausted' ? 5 : 1000,
      },
      (report, signal) => {
        reports.push(report);
        if (reports.length === 2) {
          retryStarted.resolve();
        }
        signal.addEventListener(
          'abort',
          () => {
            const failure = new Error('abort outcome');
            if (outcome === 'skip') {
              report('skip');
            } else if (outcome === 'fatal') {
              report('fatal', failure);
            } else {
              report('error', failure);
            }
          },
          { once: true },
        );
      },
    );
    runner.on(OPERATION_ENDED, () => {
      hasInitialEnded = true;
    });
    const original = runner.run(true);
    if (outcome === 'exhausted') {
      reports[0]('error', new Error('initial failure'));
      await retryStarted.promise;
    }
    const beforeForce = reports.length;
    const forced = runner.forceTry({
      shouldAbortRunning: true,
      shouldWaitForCompletion: true,
    });
    expect(reports).toHaveLength(beforeForce + 1);
    expect(runner.wasLastAttemptForced).toBe(true);
    expect(runner.isAttemptRunning).toBe(true);
    expect(hasInitialEnded).toBe(
      outcome === 'fatal' || outcome === 'exhausted',
    );
    reports[beforeForce]('success', 'forced result');
    expect(await forced).toMatchObject({
      status: 'attempt_success',
      data: 'forced result',
    });
    expect(await original).toMatchObject(
      outcome === 'fatal'
        ? { status: 'attempt_fatal' }
        : outcome === 'exhausted'
          ? { status: 'attempts_exhausted' }
          : { status: 'attempt_success', data: 'forced result' },
    );
    expect(reports).toHaveLength(beforeForce + 1);
  });
}

for (const request of ['cancel', 'reset'] as const) {
  test.each([false, true])(
    `abort success followed by ${request} preserves precedence (wait: %s)`,
    async (shouldWaitForCompletion) => {
      let attempts = 0;
      let stopped: Promise<unknown> | undefined;
      const runner = new RetryRunner(policy, (report, signal) => {
        attempts++;
        signal.addEventListener(
          'abort',
          () => {
            report('success', 'finished');
            stopped = request === 'cancel' ? runner.cancel() : runner.reset();
          },
          { once: true },
        );
      });
      const original = runner.run(true);
      const result = await runner.forceTry({
        shouldAbortRunning: true,
        shouldWaitForCompletion,
      });
      await stopped;
      expect(await original).toMatchObject({
        status: 'attempt_success',
        data: 'finished',
      });
      expect(attempts).toBe(1);
      expect(result).toMatchObject(
        request === 'reset'
          ? shouldWaitForCompletion
            ? { status: 'attempt_success', data: 'finished' }
            : { status: 'pre_operation_error', code: 'force_try_superseded' }
          : shouldWaitForCompletion
            ? { status: 'attempt_success', data: 'finished' }
            : { status: 'pre_operation_error', code: 'already_completed' },
      );
      expect(runner.runnerState).toBe(
        request === 'reset' ? 'not-started' : 'completed',
      );
    },
  );
}

test('cancel does not arm its grace timer over a replacement started by its abort listener', async () => {
  let attempts = 0;
  let replacementReport: ReportResult<string> | undefined;
  let forced: Promise<RunResult<string>> | undefined;
  const runner = new RetryRunner<string>(policy, (report, signal) => {
    attempts++;
    if (attempts === 1) {
      signal.addEventListener('abort', () => {
        forced = runner.forceTry({ shouldAbortRunning: true });
      });
    } else {
      replacementReport = report;
    }
  });
  const original = runner.run(true);
  const timers = spyOn(globalThis, 'setTimeout');
  try {
    expect(await runner.cancel()).toBe('superseded');
    expect(await forced).toMatchObject({ status: 'running' });
    expect(attempts).toBe(2);
    expect(runner.runnerState).toBe('running');
    expect(timers).not.toHaveBeenCalled();
    replacementReport?.('success', 'replacement');
    expect(await original).toMatchObject({
      status: 'attempt_success',
      data: 'replacement',
    });
  } finally {
    timers.mockRestore();
    replacementReport?.('success', 'cleanup');
  }
});

test('a forced restart reports supersession to every pending cancel caller', async () => {
  const reports: ReportResult<string>[] = [];
  const runner = new RetryRunner<string>(policy, (report) => {
    reports.push(report);
  });
  const original = runner.run(true);
  const firstCancel = runner.cancel();
  const secondCancel = runner.cancel();
  expect(runner.runnerState).toBe('stopping');
  try {
    const forced = runner.forceTry({
      shouldAbortRunning: true,
      shouldWaitForCompletion: true,
    });
    expect(await firstCancel).toBe('superseded');
    expect(await secondCancel).toBe('superseded');
    expect(runner.runnerState).toBe('running');
    expect(reports).toHaveLength(2);
    reports[0]('success', 'obsolete');
    reports[1]('success', 'replacement');
    expect(await forced).toMatchObject({
      status: 'attempt_success',
      data: 'replacement',
    });
    expect(await original).toMatchObject({
      status: 'attempt_success',
      data: 'replacement',
    });
  } finally {
    reports.at(-1)?.('success', 'cleanup');
    await runner.cancel();
  }
});

test.each(['success', 'fatal'] as const)(
  'cancel reports not-running when the attempt instead reports %s',
  async (outcome) => {
    let report: ReportResult<string> | undefined;
    const runner = new RetryRunner<string>(policy, (callback) => {
      report = callback;
    });
    const original = runner.run(true);
    const cancellation = runner.cancel();
    if (outcome === 'success') {
      report?.('success', 'finished');
    } else {
      report?.('fatal', 'finished');
    }
    expect(await cancellation).toBe('not-running');
    expect(await original).toMatchObject({
      status: outcome === 'success' ? 'attempt_success' : 'attempt_fatal',
    });
    expect(runner.runnerState).toBe(
      outcome === 'success' ? 'completed' : 'fatal-error',
    );
  },
);

test.each([false, true])(
  'force replacement preserves operation events and time (cancel pending: %s)',
  async (shouldCancel) => {
    let now = 1000;
    const clock = spyOn(Date, 'now').mockImplementation(() => now);
    const reports: ReportResult<string>[] = [];
    const runner = new RetryRunner<string>(policy, (report) => {
      reports.push(report);
    });
    const events: string[] = [];
    runner.on(OPERATION_STARTED, () => {
      events.push('started');
    });
    runner.on(OPERATION_ENDED, () => {
      events.push('ended');
    });
    try {
      const original = runner.run(true);
      const cancellation = shouldCancel ? runner.cancel() : undefined;
      now = 1250;
      const forced = runner.forceTry({
        shouldAbortRunning: true,
        shouldWaitForCompletion: true,
      });
      expect(runner.timeTakenMS).toBe(250);
      expect(events).toEqual(['started']);
      reports[1]('success', 'replacement');
      expect(await forced).toMatchObject({
        status: 'attempt_success',
        data: 'replacement',
      });
      expect(await original).toMatchObject({
        status: 'attempt_success',
        data: 'replacement',
      });
      if (cancellation) {
        expect(await cancellation).toBe('superseded');
      }
      expect(events).toEqual(['started', 'ended']);
    } finally {
      reports.at(-1)?.('success', 'cleanup');
      await runner.cancel();
      clock.mockRestore();
    }
  },
);
