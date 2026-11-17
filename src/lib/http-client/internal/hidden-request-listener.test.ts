import { expect, test } from 'bun:test';
import { notifyHiddenRequestListener } from './hidden-request-listener';

test("a hidden request listener's first throw is reported, and the work that told it goes on", () => {
  const reports: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  const failure = new Error('listener broke');
  let calls = 0;
  const listener = (): void => {
    calls++;
    throw failure;
  };

  globalThis.addEventListener('error', onError);
  try {
    expect(() => notifyHiddenRequestListener(listener)).not.toThrow();
    notifyHiddenRequestListener(listener);
  } finally {
    globalThis.removeEventListener('error', onError);
  }

  expect(calls).toBe(2);
  expect(reports).toHaveLength(1);
  expect((reports[0] as Error).message).toContain('hidden request listener');
  expect((reports[0] as Error).cause).toBe(failure);
});
