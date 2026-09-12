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
