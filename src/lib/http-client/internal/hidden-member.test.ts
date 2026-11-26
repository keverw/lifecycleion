import { expect, test } from 'bun:test';
import { notifyHiddenRequestListener } from './hidden-member';

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

test("a hidden request listener's rejection is reported once, and is no unhandled rejection", async () => {
  const reports: unknown[] = [];
  const unhandled: unknown[] = [];
  const onError = (event: Event): void => {
    reports.push((event as ErrorEvent).error);
    event.preventDefault();
  };
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  const failure = new Error('listener rejected');
  // Typed as the listener it stands in for, which is told nothing of its return.
  const listener = (async (): Promise<void> => {
    await Promise.resolve();
    throw failure;
  }) as unknown as () => void;

  globalThis.addEventListener('error', onError);
  process.on('unhandledRejection', onUnhandled);
  try {
    notifyHiddenRequestListener(listener);
    notifyHiddenRequestListener(listener);
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    globalThis.removeEventListener('error', onError);
  }

  expect(unhandled).toEqual([]);
  expect(reports).toHaveLength(1);
  expect((reports[0] as Error).cause).toBe(failure);
});
