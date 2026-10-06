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

test('a handlerName builder runs only when the handler return is unreadable', () => {
  const lines: string[] = [];
  const rung = spyOn(consoleRung, 'reportToConsole').mockImplementation(
    (line: unknown) => {
      lines.push(line as string);
    },
  );
  const unreadable = (): unknown =>
    Object.defineProperty({}, 'then', {
      get(): never {
        throw new Error('then refused');
      },
    });
  let builds = 0;
  try {
    reportThroughHandler(
      () => undefined,
      () => 'original failure',
      {
        handlerName: () => {
          builds++;
          return 'quiet handler';
        },
      },
    );
    expect(builds).toBe(0);

    reportThroughHandler(unreadable, () => 'original failure', {
      handlerName: () => {
        builds++;
        return 'built handler';
      },
    });
    reportThroughHandler(unreadable, () => 'original failure', {
      handlerName: () => {
        throw new Error('name builder failed');
      },
    });
  } finally {
    rung.mockRestore();
  }
  expect(builds).toBe(1);
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('Failure handler (built handler)');
  expect(lines[1]).toContain('Failure handler (<unnamed callback>)');
  expect(lines[1]).toContain('original failure');
});
