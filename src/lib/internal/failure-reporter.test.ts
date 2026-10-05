import { expect, spyOn, test } from 'bun:test';
import * as consoleRung from './report-to-console';
import { reportThroughHandler } from './failure-reporter';

test('a rejecting handler settles once even if its rejection report throws', async () => {
  // Stands in for a reaction that throws before its own settle(): the derived promise
  // must still be observed, and the caller's guard still lowered.
  const rung = spyOn(consoleRung, 'reportToConsole').mockImplementation(() => {
    throw new Error('console rung failed');
  });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  let settledCount = 0;
  try {
    reportThroughHandler(
      () => Promise.reject(new Error('handler rejected')),
      () => 'original failure',
      {
        onSettled: () => {
          settledCount++;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    rung.mockRestore();
    process.off('unhandledRejection', onUnhandled);
  }
  expect(settledCount).toBe(1);
  expect(unhandled).toEqual([]);
});
