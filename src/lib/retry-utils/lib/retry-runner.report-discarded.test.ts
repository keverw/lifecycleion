import { afterEach, beforeEach, expect, test } from 'bun:test';
import { REPORT_DISCARDED, RetryRunner } from './retry-runner';
import type { OnReportDiscardedInfo, ReportResult } from './retry-runner';

const policy = { strategy: 'fixed' as const, maxRetryAttempts: 1, delayMS: 1 };

// Global `'error'` reports, so a test can tell a discard that is also reported as a caller
// bug from one that is only published as `report-discarded`.
let globalErrors: string[] = [];
const onGlobalError = (event: Event): void => {
  globalErrors.push(((event as ErrorEvent).error as Error).message);
  event.preventDefault();
};

beforeEach(() => {
  globalErrors = [];
  globalThis.addEventListener('error', onGlobalError);
});

afterEach(() => {
  globalThis.removeEventListener('error', onGlobalError);
});

function recordDiscards(runner: RetryRunner<unknown>): OnReportDiscardedInfo[] {
  const discarded: OnReportDiscardedInfo[] = [];
  runner.on(REPORT_DISCARDED, (info: OnReportDiscardedInfo) => {
    discarded.push(info);
  });
  return discarded;
}

test('a second report from an attempt that was not aborted is published and still reported', async () => {
  const failure = new Error('late failure');
  let attemptID: string | undefined;
  const runner = new RetryRunner(policy, (report) => {
    report('success', 'done');
    report('error', failure);
  });
  runner.on('attempt-started', (info: { attemptID: string }) => {
    attemptID = info.attemptID;
  });
  const discarded = recordDiscards(runner);

  expect(await runner.run(true)).toMatchObject({ status: 'attempt_success' });
  expect(discarded).toEqual([
    {
      attemptID: attemptID as string,
      status: 'error',
      value: failure,
      reason: 'already-reported',
    },
  ]);
  expect(globalErrors).toEqual([
    'Error in a callback RetryRunner reportResult (attempt already settled)',
  ]);
});

test('a throw after the attempt reported is published as status throw', async () => {
  const thrown = new Error('cleanup failed');
  const runner = new RetryRunner(policy, (report) => {
    report('success', 'done');
    throw thrown;
  });
  const discarded = recordDiscards(runner);

  await runner.run(true);
  expect(discarded).toMatchObject([
    { status: 'throw', value: thrown, reason: 'already-reported' },
  ]);
});

test('a report after the grace period gave up on the attempt is published as abandoned, not reported', async () => {
  let report: ReportResult | undefined;
  const runner = new RetryRunner(policy, (reportResult) => {
    report = reportResult;
  });
  runner.overrideGraceCancelPeriodMS(5);
  const discarded = recordDiscards(runner);

  await runner.run();
  expect(await runner.cancel()).toBe('abandoned');
  report?.('success', 'finished late');

  expect(discarded).toMatchObject([
    { status: 'success', value: 'finished late', reason: 'abandoned' },
  ]);
  expect(globalErrors).toEqual([]);
});

test('a report from an attempt a force-abort replaced is published as replaced, not reported', async () => {
  const reports: ReportResult[] = [];
  const runner = new RetryRunner(policy, (reportResult) => {
    reports.push(reportResult);
  });
  const discarded = recordDiscards(runner);

  try {
    await runner.run();
    await runner.forceTry({ shouldAbortRunning: true });
    const failure = new Error('cleanup failed');
    reports[0]('error', failure);

    expect(discarded).toMatchObject([
      { status: 'error', value: failure, reason: 'replaced' },
    ]);
    expect(globalErrors).toEqual([]);
  } finally {
    runner.overrideGraceCancelPeriodMS(0);
    await runner.cancel();
  }
});

test('an aborted attempt that acknowledges twice is published as already-reported, not reported', async () => {
  let report: ReportResult | undefined;
  const runner = new RetryRunner(policy, (reportResult, signal) => {
    report = reportResult;
    signal.addEventListener('abort', () => reportResult('skip', 'aborted'));
  });
  const discarded = recordDiscards(runner);

  await runner.run();
  expect(await runner.cancel()).toBe('canceled');
  // The main code noticing `signal.aborted` too, as the docs suggest.
  report?.('skip', 'aborted');

  expect(discarded).toMatchObject([
    { status: 'skip', value: 'aborted', reason: 'already-reported' },
  ]);
  expect(globalErrors).toEqual([]);
});

test('onReportDiscarded registers a report-discarded listener', async () => {
  const discarded: OnReportDiscardedInfo[] = [];
  const runner = new RetryRunner(
    policy,
    (report) => {
      report('success', 'done');
      report('success', 'again');
    },
    {
      onReportDiscarded: (info) => {
        discarded.push(info);
      },
    },
  );

  await runner.run(true);
  expect(discarded).toMatchObject([
    { status: 'success', value: 'again', reason: 'already-reported' },
  ]);
});

test('a null late error and a throw null are published as null', async () => {
  const reporting = new RetryRunner(policy, (report) => {
    report('success', 'done');
    report('error', null);
  });
  const throwing = new RetryRunner(policy, (report) => {
    report('success', 'done');
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- the case under test
    throw null;
  });
  const discarded = recordDiscards(reporting);
  const thrown = recordDiscards(throwing);

  await reporting.run(true);
  await throwing.run(true);
  expect(discarded.map(({ status, value }) => ({ status, value }))).toEqual([
    { status: 'error', value: null },
  ]);
  expect(thrown.map(({ status, value }) => ({ status, value }))).toEqual([
    { status: 'throw', value: null },
  ]);
});

test('a late report with an unrecognized status is published as invalid', async () => {
  const runner = new RetryRunner(policy, (report) => {
    report('success', 'done');
    (report as (status: unknown, value: unknown) => void)(
      Symbol('oops'),
      'late',
    );
  });
  const discarded = recordDiscards(runner);

  await runner.run(true);
  expect(discarded).toMatchObject([
    { status: 'invalid', value: 'late', reason: 'already-reported' },
  ]);
});
