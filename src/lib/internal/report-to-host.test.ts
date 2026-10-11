import { expect, test } from 'bun:test';
import { join } from 'node:path';
import type * as ReportToHostModule from './report-to-host';

/** Import separately evaluated copies, as code splitting or dependency duplication can. */
function importReportToHostCopy(
  name: string,
): Promise<typeof ReportToHostModule> {
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
  // `Object.preventExtensions(globalThis)` - the shape `Object.freeze(globalThis)` takes for
  // a new key - cannot be undone, so it runs in a process of its own. A squatter that is
  // merely non-writable is no refusal: the slot is configurable, so it is replaced.
  const modulePath = join(import.meta.dir, 'report-to-host.ts');
  const script = `
    Object.preventExtensions(globalThis);
    const first = await import(${JSON.stringify(`${modulePath}?copy=first`)});
    const second = await import(${JSON.stringify(`${modulePath}?copy=second`)});
    let listenerCalls = 0;
    const consoled = [];
    console.error = (value) => {
      consoled.push(String(value?.message ?? value));
    };
    globalThis.addEventListener('error', (event) => {
      listenerCalls++;
      event.preventDefault();
      if (listenerCalls === 1) {
        second.reportToHost(new Error('nested report'));
      }
    });
    first.reportToHost(new Error('outer report'));
    process.stdout.write(JSON.stringify({ listenerCalls, consoled }));
  `;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(stderr).toBe('');
  expect(exitCode).toBe(0);
  // The documented degradation: with no shared lease, the second copy does not see the
  // first copy's dispatch and re-enters the listeners once. Bounded by the number of
  // loaded copies rather than growing with the listeners they hold between them - each
  // copy still refuses to re-enter its *own* dispatch, which is what stops the recursion
  // from running away.
  expect(JSON.parse(stdout)).toEqual({ listenerCalls: 2, consoled: [] });
});

test('a non-writable squatter under the key is replaced, so copies still share', async () => {
  Object.defineProperty(globalThis, HOST_REPORT_STATE_KEY, {
    // Invalid on purpose, and not writable - but configurable, so replaceable.
    value: { dispatchDepth: -1 },
    writable: false,
    configurable: true,
  });

  const [firstCopy, secondCopy] = await Promise.all([
    importReportToHostCopy('readonly-first'),
    importReportToHostCopy('readonly-second'),
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

    // One lease between them: the nested report from the other copy found it held.
    expect(listenerCalls).toBe(1);
    expect(consoled).toEqual([nestedError]);
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
      (globalThis as unknown as Record<symbol, unknown>)[HOST_REPORT_STATE_KEY],
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
  // An accessor under our symbol whose setter drops the value. An assignment would
  // "succeed" into it and leave a state nobody else could see - every call building
  // another at depth zero, so a copy stopped guarding even against itself. Read as a
  // descriptor it is no state at all, and it is replaced with a data property: the nested
  // report below finds this copy's own lease held.
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

test('a throwing message accessor still reaches error listeners without reportError', async () => {
  const { reportToHost } = await importReportToHostCopy('throwing-message');
  const error = new Error('original');
  Object.defineProperty(error, 'message', {
    get() {
      throw new Error('cannot read message');
    },
  });
  const events: ErrorEvent[] = [];
  const reported: unknown[] = [];
  const originalReportError = globalThis.reportError;
  const onError = (event: ErrorEvent): void => {
    events.push(event);
    event.preventDefault();
  };
  globalThis.reportError = (value: unknown): void => {
    reported.push(value);
  };
  globalThis.addEventListener('error', onError);
  try {
    reportToHost(error);
    expect(events).toHaveLength(1);
    expect(events[0].error).toBe(error);
    expect(events[0].message).toBe('');
    expect(reported).toEqual([]);
  } finally {
    globalThis.removeEventListener('error', onError);
    globalThis.reportError = originalReportError;
  }
});

/** Isolate host-hook overrides and restore both globals even when a check fails. */
function withHostMethodOverride(
  method: 'dispatchEvent' | 'reportError',
  handler: (this: unknown, value: unknown) => unknown,
  run: () => void,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, method);
  const eventDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'ErrorEvent',
  );
  try {
    Object.defineProperty(globalThis, method, {
      configurable: true,
      writable: true,
      value: handler,
    });
    if (method === 'reportError') {
      // Keep dispatch unavailable so the host's reportError rung is exercised.
      Object.defineProperty(globalThis, 'ErrorEvent', {
        configurable: true,
        writable: true,
        value: undefined,
      });
    }
    run();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, method, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, method);
    }
    if (eventDescriptor) {
      Object.defineProperty(globalThis, 'ErrorEvent', eventDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'ErrorEvent');
    }
  }
}

for (const method of ['dispatchEvent', 'reportError'] as const) {
  test(`host ${method} ignores an own call override`, async () => {
    const { reportToHost } = await importReportToHostCopy(`own-call-${method}`);
    const error = new Error('original failure');
    const received: unknown[] = [];
    const handler = function (this: unknown, value: unknown): boolean {
      expect(this).toBe(globalThis);
      received.push(value);
      return false;
    };
    Object.defineProperty(handler, 'call', { value: () => false });
    withHostMethodOverride(method, handler, () => {
      reportToHost(error);
      expect(received).toHaveLength(1);
      if (method === 'dispatchEvent') {
        expect((received[0] as ErrorEvent).error).toBe(error);
      }
    });
  });
}
