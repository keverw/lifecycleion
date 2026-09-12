import { expect, test } from 'bun:test';
import type * as ReportToHostModule from './report-to-host';

/** Import separately evaluated copies, as code splitting or dependency duplication can. */
function importReportToHostCopy(name: string): Promise<typeof ReportToHostModule> {
  return import(`./report-to-host.ts?test-copy=${name}`) as Promise<
    typeof ReportToHostModule
  >;
}

test('reportToHost shares its re-entrancy guard across module copies', async () => {
  const [firstCopy, secondCopy] = await Promise.all([
    importReportToHostCopy('first'),
    importReportToHostCopy('second'),
  ]);
  const nestedError = new Error('nested report');
  const consoled: unknown[] = [];
  let listenerCalls = 0;

  const onError = (event: ErrorEvent): void => {
    listenerCalls++;
    event.preventDefault();

    if (listenerCalls === 1) {
      secondCopy.reportToHost(nestedError);
    }
  };

  const originalConsoleError = console.error;
  console.error = (...args: unknown[]): void => {
    consoled.push(args[0]);
  };
  globalThis.addEventListener('error', onError);

  try {
    firstCopy.reportToHost(new Error('outer report'));

    // The nested call came from a separately evaluated module but still saw the first
    // copy's lease, so it terminated at the console instead of dispatching again.
    expect(listenerCalls).toBe(1);
    expect(consoled).toEqual([nestedError]);

    // Once the outer dispatch returns, either copy can acquire the shared lease again.
    secondCopy.reportToHost(new Error('later report'));
    expect(listenerCalls).toBe(2);
    expect(consoled).toEqual([nestedError]);
  } finally {
    globalThis.removeEventListener('error', onError);
    console.error = originalConsoleError;
  }
});

/** The key the shared lease lives under. Duplicated here deliberately: a test that
 * imported it would not notice the constant changing out from under the global it is
 * standing in for. */
const HOST_REPORT_STATE_KEY = Symbol.for('lifecycleion.reportToHost.v1');

/** Remove whatever a test installed, so the next one starts from a clean global. */
function clearSharedHostReportState(): void {
  delete (globalThis as unknown as Record<symbol, unknown>)[
    HOST_REPORT_STATE_KEY
  ];
}

test('a global that refuses the shared state still guards each copy on its own', async () => {
  // `Object.freeze(globalThis)` is the real-world shape and is not something a test in a
  // shared process can do; a non-writable property under the same key refuses the write
  // the same way, which is what the fallback turns on.
  Object.defineProperty(globalThis, HOST_REPORT_STATE_KEY, {
    // Invalid on purpose, so the state is rejected and a fresh install is attempted -
    // and refused.
    value: { dispatchDepth: -1 },
    writable: false,
    configurable: true,
  });

  const [firstCopy, secondCopy] = await Promise.all([
    importReportToHostCopy('frozen-first'),
    importReportToHostCopy('frozen-second'),
  ]);
  const nestedError = new Error('nested report');
  const consoled: unknown[] = [];
  let listenerCalls = 0;

  const onError = (event: ErrorEvent): void => {
    listenerCalls++;
    event.preventDefault();

    if (listenerCalls === 1) {
      secondCopy.reportToHost(nestedError);
    }
  };

  const originalConsoleError = console.error;
  console.error = (...args: unknown[]): void => {
    consoled.push(args[0]);
  };
  globalThis.addEventListener('error', onError);

  try {
    firstCopy.reportToHost(new Error('outer report'));

    // The documented degradation: with no shared lease, the second copy does not see the
    // first copy's dispatch and re-enters the listeners once. Bounded by the number of
    // loaded copies rather than growing with the listeners they hold between them - each
    // copy still refuses to re-enter its *own* dispatch, which is what stops the
    // recursion from running away.
    expect(listenerCalls).toBe(2);
    expect(consoled).toEqual([]);
  } finally {
    globalThis.removeEventListener('error', onError);
    console.error = originalConsoleError;
    clearSharedHostReportState();
  }
});

test('a shared object that refuses to release its lease is replaced, not abandoned', async () => {
  // The unrecoverable shape: the decrement throws, the lease is never put down, and every
  // later report - in this copy and in every other one reading the same object - takes the
  // emergency console rung and never reaches an `'error'` listener again.
  let depth = 0;
  let writes = 0;

  const hostile = {
    get dispatchDepth(): number {
      return depth;
    },
    set dispatchDepth(value: number) {
      writes++;

      // The release write, after the acquire's increment was accepted.
      if (writes === 2) {
        throw new Error('refused');
      }

      depth = value;
    },
  };

  Object.defineProperty(globalThis, HOST_REPORT_STATE_KEY, {
    value: hostile,
    writable: true,
    configurable: true,
  });

  const copy = await importReportToHostCopy('hostile-release');
  const consoled: unknown[] = [];
  let listenerCalls = 0;

  const onError = (event: ErrorEvent): void => {
    listenerCalls++;
    event.preventDefault();
  };

  const originalConsoleError = console.error;
  console.error = (...args: unknown[]): void => {
    consoled.push(args[0]);
  };
  globalThis.addEventListener('error', onError);

  try {
    copy.reportToHost(new Error('first report'));
    expect(listenerCalls).toBe(1);

    // The object that could not be released is gone, replaced by a fresh one - which is
    // what lets the *other* copies recover too, since they re-read the global every time.
    expect(
      (globalThis as unknown as Record<symbol, unknown>)[
        HOST_REPORT_STATE_KEY
      ],
    ).not.toBe(hostile);

    copy.reportToHost(new Error('second report'));

    // Reached the listener rather than the console: the stuck lease did not outlive the
    // report that could not put it down.
    expect(listenerCalls).toBe(2);
    expect(consoled).toEqual([]);
  } finally {
    globalThis.removeEventListener('error', onError);
    console.error = originalConsoleError;
    clearSharedHostReportState();
  }
});

test('a global that silently drops the write still guards one copy against itself', async () => {
  // The case a refusal does not cover, and the one the read-back in
  // `installFreshHostReportState` exists for. A setter that ignores the value does not
  // throw under strict mode, so the install *returned* the object it had just built and
  // nobody else could ever see - which meant every call built another one, at depth zero,
  // and a copy stopped guarding even against itself: the nested report below dispatched
  // again. Reading the property back afterwards is what catches it.
  const squatter = { dispatchDepth: -1 };

  Object.defineProperty(globalThis, HOST_REPORT_STATE_KEY, {
    // Invalid, so the state is rejected and a fresh install is attempted.
    get: () => squatter,
    set: () => {
      // Dropped on the floor, silently.
    },
    configurable: true,
  });

  const copy = await importReportToHostCopy('ignored-write');
  const nestedError = new Error('nested report');
  const consoled: unknown[] = [];
  let listenerCalls = 0;

  const onError = (event: ErrorEvent): void => {
    listenerCalls++;
    event.preventDefault();

    if (listenerCalls === 1) {
      copy.reportToHost(nestedError);
    }
  };

  const originalConsoleError = console.error;
  console.error = (...args: unknown[]): void => {
    consoled.push(args[0]);
  };
  globalThis.addEventListener('error', onError);

  try {
    copy.reportToHost(new Error('outer report'));

    // One dispatch. The nested report found the same copy's own lease held and terminated
    // at the console, which is the whole point of the guard.
    expect(listenerCalls).toBe(1);
    expect(consoled).toEqual([nestedError]);
  } finally {
    globalThis.removeEventListener('error', onError);
    console.error = originalConsoleError;
    clearSharedHostReportState();
  }
});
