import { afterEach, expect, test } from 'bun:test';
import { type ReportResult, RetryRunner } from './retry-runner';
import type { RetryPolicyOptionsStrategyFixed } from './types';
import { sleep } from '../../sleep';
import {
  muteConsoleError,
  restoreConsoleError,
} from '../../internal/console-test-utils';

// An operation's abort listener runs inside `abort()`, but an `EventTarget` never lets a
// listener's error reach `abort()`'s caller: the runtime reports it as an uncaught
// exception, fatal to a process with no handler. These tests record both process-level
// channels explicitly, and claim the `'error'` channel the runner reports on instead.

const policy: RetryPolicyOptionsStrategyFixed = {
  strategy: 'fixed',
  maxRetryAttempts: 3,
  delayMS: 10,
};

const LABEL = 'RetryRunner operation abort listener';

let cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.reverse()) {
    cleanup();
  }
  cleanups = [];
  restoreConsoleError();
});

/** Everything that escaped as an uncaught exception or an unhandled rejection. */
function watchUncaught(): unknown[] {
  const escaped: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    escaped.push(error);
  };
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUncaught);
  cleanups.push(() => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUncaught);
  });
  return escaped;
}

/** Reports on the standard `'error'` channel, claimed so they do not print. */
function claimReports(): Error[] {
  const reports: Error[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error as Error);
    event.preventDefault();
  };
  globalThis.addEventListener('error', onError);
  cleanups.push(() => {
    globalThis.removeEventListener('error', onError);
  });
  return reports;
}

// How an operation attaches a listener that fails when its attempt is aborted.
const FAILING_LISTENERS: [
  string,
  (signal: AbortSignal, thrown: Error) => void,
][] = [
  [
    'addEventListener function',
    (signal, thrown) => {
      signal.addEventListener('abort', () => {
        throw thrown;
      });
    },
  ],
  [
    'handleEvent object',
    (signal, thrown) => {
      signal.addEventListener('abort', {
        handleEvent: () => {
          throw thrown;
        },
      });
    },
  ],
  [
    'onabort handler',
    (signal, thrown) => {
      signal.onabort = () => {
        throw thrown;
      };
    },
  ],
  [
    'async listener that rejects',
    (signal, thrown) => {
      // A rejecting listener is exactly what this covers; the runtime discards its
      // promise, and the guard is what observes it.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      signal.addEventListener('abort', async () => {
        await Promise.resolve();
        throw thrown;
      });
    },
  ],
];

/**
 * An operation whose first attempt waits for its abort, with the failing listener
 * between two that record, and acknowledges the abort as the contract asks. Later
 * attempts succeed at once.
 */
function abortableOperation(
  attach: (signal: AbortSignal, thrown: Error) => void,
  thrown: Error,
): {
  order: string[];
  operation: (reportResult: ReportResult, signal: AbortSignal) => void;
} {
  const order: string[] = [];
  let calls = 0;
  const operation = (reportResult: ReportResult, signal: AbortSignal): void => {
    calls++;
    if (calls > 1) {
      reportResult('success', 'forced');
      return;
    }
    signal.addEventListener('abort', () => order.push('before'));
    attach(signal, thrown);
    signal.addEventListener('abort', () => {
      order.push('after');
      reportResult('skip', 'aborted');
    });
  };
  return { order, operation };
}

for (const [kind, attach] of FAILING_LISTENERS) {
  test(`cancel(): a failing abort listener (${kind}) is reported, not uncaught`, async () => {
    muteConsoleError();
    const escaped = watchUncaught();
    const reports = claimReports();
    const thrown = new Error(`${kind} failed`);
    const { order, operation } = abortableOperation(attach, thrown);

    const runner = new RetryRunner(policy, operation);
    void runner.run(false);
    await sleep(5);

    expect(await runner.cancel()).toBe('canceled');
    await sleep(10);

    expect(escaped).toEqual([]);
    expect(order).toEqual(['before', 'after']);
    expect(runner.runnerState).toBe('stopped');
    expect(reports.map((report) => report.cause)).toEqual([thrown]);
    expect(reports[0].message).toContain(LABEL);
  });

  test(`forceTry({ shouldAbortRunning }): a failing abort listener (${kind}) is reported, not uncaught`, async () => {
    muteConsoleError();
    const escaped = watchUncaught();
    const reports = claimReports();
    const thrown = new Error(`${kind} failed`);
    const { order, operation } = abortableOperation(attach, thrown);

    const runner = new RetryRunner(policy, operation);
    void runner.run(false);
    await sleep(5);

    const result = await runner.forceTry({
      shouldWaitForCompletion: true,
      shouldAbortRunning: true,
    });
    await sleep(10);

    expect(escaped).toEqual([]);
    expect(order).toEqual(['before', 'after']);
    expect(result).toEqual({ status: 'attempt_success', data: 'forced' });
    expect(reports.map((report) => report.cause)).toEqual([thrown]);
    expect(reports[0].message).toContain(LABEL);
  });
}
