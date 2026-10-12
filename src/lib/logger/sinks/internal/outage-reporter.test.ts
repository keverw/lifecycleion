import { expect, test } from 'bun:test';
import { MAX_REPORTED_OPEN_FAILURES, OutageReporter } from './outage-reporter';
import type { SinkFailureKind } from './sink-failure';

interface Report {
  kind: SinkFailureKind;
  message: string;
  cause: unknown;
  isDiagnostic: boolean;
}

function makeReporter(maxReports?: number): {
  reporter: OutageReporter;
  reports: Report[];
} {
  const reports: Report[] = [];
  const reporter = new OutageReporter({
    report: (kind, error, isDiagnostic) => {
      reports.push({
        kind,
        message: error.message,
        cause: error.cause,
        isDiagnostic,
      });
    },
    describeCap: (limit) => `capped at ${String(limit)}`,
    maxReports,
  });

  return { reporter, reports };
}

test('a failure is reported once per outage, with its cause', () => {
  const { reporter, reports } = makeReporter();
  const cause = new Error('ENOENT');

  reporter.reportFailure('not_found', 'missing', cause);
  reporter.reportFailure('not_found', 'missing', cause);
  reporter.reportFailure('not_found', 'missing', undefined);

  expect(reports).toEqual([
    { kind: 'not_found', message: 'missing', cause, isDiagnostic: false },
  ]);
});

test('a different message or a different kind is a new failure', () => {
  const { reporter, reports } = makeReporter();

  reporter.reportFailure('not_found', 'missing', undefined);
  reporter.reportFailure('not_found', 'still missing', undefined);
  // Same text, different kind: a consumer switching on `kind` must still hear it.
  reporter.reportFailure('setup', 'missing', undefined);
  // And a state already reported this outage stays quiet when it comes back.
  reporter.reportFailure('not_found', 'missing', undefined);

  expect(reports.map((report) => [report.kind, report.message])).toEqual([
    ['not_found', 'missing'],
    ['not_found', 'still missing'],
    ['setup', 'missing'],
  ]);
});

test('the cap is reported once as setup, then the outage is quiet', () => {
  const { reporter, reports } = makeReporter();

  for (let index = 0; index < 100; index++) {
    reporter.reportFailure('setup', `failure ${String(index)}`, undefined);
  }

  expect(MAX_REPORTED_OPEN_FAILURES).toBe(8);
  expect(reports).toHaveLength(MAX_REPORTED_OPEN_FAILURES + 1);
  expect(reports.at(-1)).toEqual({
    kind: 'setup',
    message: `capped at ${String(MAX_REPORTED_OPEN_FAILURES)}`,
    cause: undefined,
    isDiagnostic: false,
  });
});

test('diagnostic failures spend their own budget, not the ordinary one', () => {
  const { reporter, reports } = makeReporter(2);

  for (let index = 0; index < 10; index++) {
    reporter.reportFailure(
      'setup',
      `terminal ${String(index)}`,
      undefined,
      true,
    );
  }

  expect(reports).toHaveLength(3);
  expect(reports.every((report) => report.isDiagnostic)).toBe(true);
  expect(reports[2].message).toBe('capped at 2');

  // The same failure on the ordinary budget is still news.
  reporter.reportFailure('setup', 'terminal 0', undefined);
  expect(reports).toHaveLength(4);
  expect(reports[3]).toMatchObject({
    message: 'terminal 0',
    isDiagnostic: false,
  });
});

test('clear forgets both budgets and both cap notices', () => {
  const { reporter, reports } = makeReporter(1);

  reporter.reportFailure('setup', 'a', undefined);
  reporter.reportFailure('setup', 'b', undefined);
  reporter.reportFailure('setup', 'a', undefined, true);
  reporter.reportFailure('setup', 'b', undefined, true);
  expect(reports.map((report) => report.message)).toEqual([
    'a',
    'capped at 1',
    'a',
    'capped at 1',
  ]);

  reporter.clear();
  reports.length = 0;

  reporter.reportFailure('setup', 'a', undefined);
  reporter.reportFailure('setup', 'b', undefined);
  reporter.reportFailure('setup', 'a', undefined, true);
  reporter.reportFailure('setup', 'b', undefined, true);
  expect(reports.map((report) => report.message)).toEqual([
    'a',
    'capped at 1',
    'a',
    'capped at 1',
  ]);
});

test('state is settled before the report, so a re-entrant report is deduplicated', () => {
  const reports: string[] = [];
  let depth = 0;
  const reporter: OutageReporter = new OutageReporter({
    report: (_kind, error) => {
      reports.push(error.message);
      depth++;

      // A hostile handler that reports the same failure, and pushes past the cap, from
      // inside its own report.
      if (depth < 5) {
        reporter.reportFailure('setup', error.message, undefined);
        reporter.reportFailure('setup', `nested ${String(depth)}`, undefined);
      }
    },
    describeCap: () => 'capped',
    maxReports: 2,
  });

  reporter.reportFailure('setup', 'outer', undefined);

  expect(reports).toEqual(['outer', 'nested 1', 'capped']);
});
