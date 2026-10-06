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

test('an AbortController global replaced after import does not stop an attempt', async () => {
  const escaped = watchUncaught();
  const original = globalThis.AbortController;
  globalThis.AbortController = class {
    constructor() {
      throw new Error('replaced AbortController');
    }
  } as unknown as typeof AbortController;
  cleanups.push(() => {
    globalThis.AbortController = original;
  });

  const signals: AbortSignal[] = [];
  const runner = new RetryRunner(policy, (reportResult, signal) => {
    signals.push(signal);
    reportResult('success', 'done');
  });

  const result = await runner.run(true);
  await sleep(10);

  expect(escaped).toEqual([]);
  expect(result).toEqual({ status: 'attempt_success', data: 'done' });
  expect(runner.runnerState).toBe('completed');
  expect(signals).toHaveLength(1);
});

test('an AbortSignal aborted getter replaced after import does not stop an attempt', async () => {
  const escaped = watchUncaught();
  const descriptor = Object.getOwnPropertyDescriptor(
    AbortSignal.prototype,
    'aborted',
  );
  if (descriptor === undefined) {
    throw new Error('AbortSignal.prototype.aborted is missing');
  }
  Object.defineProperty(AbortSignal.prototype, 'aborted', {
    ...descriptor,
    get: () => {
      throw new Error('replaced aborted');
    },
  });
  cleanups.push(() => {
    Object.defineProperty(AbortSignal.prototype, 'aborted', descriptor);
  });

  const runner = new RetryRunner(policy, (reportResult) => {
    reportResult('success', 'done');
  });

  const result = await runner.run(true);
  await sleep(10);

  expect(escaped).toEqual([]);
  expect(result).toEqual({ status: 'attempt_success', data: 'done' });
  expect(runner.runnerState).toBe('completed');
});

test('an attempt that cannot be set up ends the operation instead of escaping', async () => {
  const escaped = watchUncaught();
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const thrown = new Error('replaced crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: {
      getRandomValues: () => {
        throw thrown;
      },
    },
  });
  cleanups.push(() => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'crypto');
    } else {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  let calls = 0;
  const runner = new RetryRunner(policy, (reportResult) => {
    calls++;
    reportResult('success');
  });

  const result = await runner.run(true);
  await sleep(10);

  expect(escaped).toEqual([]);
  expect(calls).toBe(0);
  expect(result).toEqual({
    status: 'attempt_fatal',
    code: 'unexpected_error',
    error: thrown,
  });
  expect(runner.runnerState).toBe('fatal-error');
  expect(runner.lastError).toBe(thrown);
});

test('a forced replacement that cannot be set up detaches the aborted attempt', async () => {
  // `forceTry({ shouldAbortRunning: true })` aborts the running attempt and moves on
  // without handling it. If the replacement cannot even be set up, the operation ends
  // fatally - and the aborted attempt must end with it, not stay current, where its late
  // `reportResult` would be accepted, arm a retry in `fatal-error`, and let a later
  // `forceTry` claim to be running.
  const escaped = watchUncaught();
  let reportAborted: (() => void) | undefined;
  let attemptsHandled = 0;
  const runner = new RetryRunner(policy, (reportResult, signal) => {
    reportAborted = () => {
      if (signal.aborted) {
        reportResult('skip', 'aborted');
      } else {
        reportResult('success', 'stale');
      }
    };
  });
  runner.on('attempt-handled', () => {
    attemptsHandled++;
  });

  expect(await runner.run()).toEqual({ status: 'running' });
  expect(runner.isAttemptRunning).toBe(true);

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const thrown = new Error('replaced crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: {
      getRandomValues: () => {
        throw thrown;
      },
    },
  });
  cleanups.push(() => {
    if (descriptor === undefined) {
      Reflect.deleteProperty(globalThis, 'crypto');
    } else {
      Object.defineProperty(globalThis, 'crypto', descriptor);
    }
  });

  const forced = await runner.forceTry({
    shouldAbortRunning: true,
    shouldWaitForCompletion: true,
  });
  cleanups.pop()?.();

  expect(forced).toEqual({
    status: 'attempt_fatal',
    code: 'unexpected_error',
    error: thrown,
  });
  expect(runner.runnerState).toBe('fatal-error');
  expect(runner.isAttemptRunning).toBe(false);

  // The aborted attempt's late acknowledgement is discarded.
  reportAborted?.();
  await sleep(20);

  expect(escaped).toEqual([]);
  expect(attemptsHandled).toBe(0);
  expect(runner.isRetryPending).toBe(false);
  expect(runner.runnerState).toBe('fatal-error');

  // A later forceTry starts a fresh attempt rather than reattaching to the aborted one.
  expect(await runner.forceTry()).toEqual({
    status: 'running',
    reattached: false,
  });
  expect(runner.runnerState).toBe('running');
  expect(runner.isAttemptRunning).toBe(true);
  const canceled = runner.cancel();
  reportAborted?.();
  expect(await canceled).toBe('canceled');
});
