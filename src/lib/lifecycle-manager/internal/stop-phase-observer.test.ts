import { expect, test } from 'bun:test';
import { createStopPhaseObserver } from './stop-phase-observer';

function setup(): {
  observer: ReturnType<typeof createStopPhaseObserver>;
  reports: { error: unknown; message: string; level: 'warn' | 'error' }[];
} {
  const reports: {
    error: unknown;
    message: string;
    level: 'warn' | 'error';
  }[] = [];
  return {
    observer: createStopPhaseObserver((error, message, level) => {
      reports.push({ error, message, level });
    }),
    reports,
  };
}

// Wait through the terminal rejection observer as well as the first reaction.
async function flushObservers(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test('foreground reports preserve error identity and phase severity', () => {
  const { observer, reports } = setup();
  const error = { reason: 'hook failure' };
  observer.reportForeground(error, 'graceful failed');
  observer.reportForeground(error, 'force failed', 'error');
  expect(reports).toEqual([
    { error, message: 'graceful failed', level: 'warn' },
    { error, message: 'force failed', level: 'error' },
  ]);
});

test('observation transfers reporting synchronously and the first observer retains ownership', async () => {
  const { observer, reports } = setup();
  const error = new Error('late failure');
  const pending = Promise.reject(error);
  observer.observe(pending, 'deadline failure');
  observer.reportForeground(error, 'foreground failure');
  observer.observe(pending, 'abandoned force failure');
  expect(reports).toHaveLength(0);
  await flushObservers();
  expect(reports).toEqual([
    { error, message: 'deadline failure', level: 'warn' },
  ]);
  observer.reportForeground(error, 'after settlement');
  expect(reports).toHaveLength(1);
});

test('late rejection selects reporting details at settlement time', async () => {
  const { observer, reports } = setup();
  const error = new Error('late failure');
  let currentReport: { message: string; level: 'warn' | 'error' } = {
    message: 'before transfer',
    level: 'warn',
  };
  observer.observe(Promise.reject(error), 'fallback', {
    getReport: () => currentReport,
  });
  currentReport = { message: 'after transfer', level: 'error' };
  await flushObservers();
  expect(reports).toEqual([{ error, ...currentReport }]);
});

// Observed promises are adopted ones, the library's own, so their methods are the
// built-ins; only the once-per-phase ownership is the observer's to enforce.
test('observation reconciles successful work once', async () => {
  const { observer, reports } = setup();
  const pending = Promise.resolve();
  let resolutions = 0;
  const onResolved = (): void => {
    resolutions++;
  };
  observer.observe(pending, 'deadline failure', { onResolved });
  observer.observe(pending, 'abandoned force failure', { onResolved });
  await flushObservers();
  expect(resolutions).toBe(1);
  expect(reports).toEqual([]);
});

test('late reconciliation and report-selection failures reach the terminal warning under their own labels', async () => {
  const reconciliationError = new Error('reconciliation failed');
  const selectionError = new Error('report selection failed');
  const resolved = setup();
  const rejected = setup();
  resolved.observer.observe(Promise.resolve(), 'unused', {
    onResolved: () => {
      throw reconciliationError;
    },
  });
  rejected.observer.observe(
    Promise.reject(new Error('hook failure')),
    'unused',
    {
      getReport: () => {
        throw selectionError;
      },
    },
  );
  await flushObservers();
  expect(resolved.reports).toEqual([
    {
      error: reconciliationError,
      message: 'Late stop resolution failed',
      level: 'warn',
    },
  ]);
  // The hook's own failure is still reported, under the fallback message and - with no
  // selector to downgrade it - at `error`. The selection failure has its own label:
  // neither a resolution failure nor a hook failure that went unreported.
  expect(rejected.reports).toEqual([
    {
      error: expect.objectContaining({ message: 'hook failure' }),
      message: 'unused',
      level: 'error',
    },
    {
      error: selectionError,
      message: 'Late stop report selection failed',
      level: 'warn',
    },
  ]);
});

test('terminal reporting contains a reporter that throws again', async () => {
  const hookError = new Error('hook failed');
  const reportError = new Error('report failed');
  const reports: {
    error: unknown;
    message: string;
    level: 'warn' | 'error';
  }[] = [];
  const observer = createStopPhaseObserver((error, message, level) => {
    reports.push({ error, message, level });
    throw reportError;
  });
  observer.observe(Promise.reject(hookError), 'hook failure');
  await flushObservers();
  expect(reports).toEqual([
    { error: hookError, message: 'hook failure', level: 'warn' },
    {
      error: reportError,
      message: 'Late stop failure could not be reported',
      level: 'warn',
    },
  ]);
});

test('a selection failure is still reported when reporting the hook failure throws', async () => {
  const hookError = new Error('hook failed');
  const selectionError = new Error('report selection failed');
  const reportError = new Error('report failed');
  const reports: {
    error: unknown;
    message: string;
    level: 'warn' | 'error';
  }[] = [];
  const observer = createStopPhaseObserver((error, message, level) => {
    reports.push({ error, message, level });
    // Only the hook's own error breaks the reporter, as a hostile error value can.
    if (error === hookError) {
      throw reportError;
    }
  });
  observer.observe(Promise.reject(hookError), 'hook failure', {
    getReport: () => {
      throw selectionError;
    },
  });
  await flushObservers();
  expect(reports).toEqual([
    { error: hookError, message: 'hook failure', level: 'error' },
    {
      error: reportError,
      message: 'Late stop failure could not be reported',
      level: 'warn',
    },
    {
      error: selectionError,
      message: 'Late stop report selection failed',
      level: 'warn',
    },
  ]);
});
