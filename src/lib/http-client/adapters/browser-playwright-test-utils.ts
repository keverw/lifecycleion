import { describe, test, expect } from 'bun:test';
import type { BrowserTestResult, BrowserTestSuite } from './browser-test-utils';

export function assertBrowserResult(
  suite: BrowserTestSuite | undefined,
  name: string,
): void {
  if (!suite) {
    throw new Error('beforeAll did not complete — suite is undefined');
  }

  const entry = suite.results.find((r: BrowserTestResult) => r.name === name);

  if (!entry) {
    throw new Error(`No result found for scenario: "${name}"`);
  }

  expect(
    entry.passed,
    `"${name}" failed in browser: ${entry.error ?? '(no message)'}`,
  ).toBe(true);
}

export function browserScenarios(
  label: string,
  names: string[],
  // Use a getter rather than the suite value directly because these scenario
  // registrations run at module-load time, before beforeAll() populates it.
  getSuite: () => BrowserTestSuite | undefined,
): void {
  describe(label, () => {
    for (const name of names) {
      test(name, () => assertBrowserResult(getSuite(), name));
    }
  });
}
