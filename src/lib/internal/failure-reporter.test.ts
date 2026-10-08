import { expect, spyOn, test } from 'bun:test';
import * as consoleRung from './report-to-console';
import {
  createFailureReporter,
  reportThroughHandler,
} from './failure-reporter';
import { muteConsoleError, restoreConsoleError } from './console-test-utils';

test.each([false, true])(
  'console-origin reports skip handlers and settle once (queued: %s)',
  async (isQueued) => {
    muteConsoleError();
    let consoleCalls = 0;
    let handlerCalls = 0;
    let settlements = 0;
    const failure = new Error('forwarding failed');
    const forward = (shouldSuppressDiagnostics: boolean): void => {
      reportThroughHandler(
        async () => {
          handlerCalls++;
          await Promise.resolve();
          throw failure;
        },
        () => 'original failure',
        {
          suppressDiagnostics: shouldSuppressDiagnostics,
          onSettled: () => {
            settlements++;
            throw new Error('settlement failed too');
          },
        },
      );
    };
    console.error = () => {
      if (++consoleCalls >= 20) {
        return;
      }
      if (isQueued) {
        const wasConsoleOrigin = consoleRung.isConsoleReportActive();
        queueMicrotask(() => forward(wasConsoleOrigin));
      } else {
        forward(false);
      }
    };
    try {
      consoleRung.reportToConsole('first failure');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(consoleCalls).toBe(1);
      expect(handlerCalls).toBe(0);
      expect(settlements).toBe(1);

      consoleRung.reportToConsole('independent failure');
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(consoleCalls).toBe(2);
      expect(handlerCalls).toBe(0);
      expect(settlements).toBe(2);
    } finally {
      restoreConsoleError();
    }
  },
);

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

test('a console-origin failure does not spend the operation report', () => {
  muteConsoleError();
  const delivered: string[] = [];
  let settlements = 0;
  const report = createFailureReporter(
    'Render',
    (error, subject) => {
      delivered.push(`${subject}: ${error.message}`);
    },
    () => {
      settlements++;
    },
  );
  try {
    console.error = () => {
      // A shim forwarding the console line back into the operation.
      report(new Error('inside the shim'), 'first');
    };
    consoleRung.reportToConsole('terminal line');
    expect(delivered).toEqual([]);
    expect(settlements).toBe(1);

    report(new Error('outside the shim'), 'second');
    report(new Error('one too many'), 'third');
    expect(delivered).toEqual(['second: outside the shim']);
    expect(settlements).toBe(2);
  } finally {
    restoreConsoleError();
  }
});
