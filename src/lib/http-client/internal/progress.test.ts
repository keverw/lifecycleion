import { describe, expect, test } from 'bun:test';

import { guardProgressCallback } from './progress';
import type { AdapterProgressEvent } from '../types';

const event: AdapterProgressEvent = {
  loaded: 10,
  total: 100,
  progress: 0.1,
};

/** Collect what the global `'error'` channel is handed for the length of `run`. */
async function collectGlobalErrors(
  run: () => void | Promise<void>,
): Promise<ErrorEvent[]> {
  const events: ErrorEvent[] = [];
  const onError = (raised: Event): void => {
    events.push(raised as ErrorEvent);
    raised.preventDefault();
  };

  globalThis.addEventListener('error', onError);

  try {
    await run();
    // A rejected `async` callback is reported from a `.catch`, one microtask later.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    globalThis.removeEventListener('error', onError);
  }

  return events;
}

describe('guardProgressCallback', () => {
  test('answers undefined for no callback, so the ?.() call sites stay as they were', () => {
    expect(
      guardProgressCallback(undefined, 'onUploadProgress'),
    ).toBeUndefined();
    expect(guardProgressCallback(null, 'onUploadProgress')).toBeUndefined();
  });

  test('hands the event through to the callback', () => {
    const seen: AdapterProgressEvent[] = [];
    const guarded = guardProgressCallback((progress) => {
      seen.push(progress);
    }, 'onUploadProgress');

    guarded?.(event);

    expect(seen).toEqual([event]);
  });

  test('a throwing callback is reported on the global channel and does not propagate', async () => {
    // Called bare from inside the adapters' stream handlers, a throw here was classified
    // as an `adapter_error` - a network problem the caller went looking for and never
    // found. Progress is advisory, so the failure cannot be allowed to change the result.
    const guarded = guardProgressCallback(() => {
      throw new Error('progress bar broke');
    }, 'onDownloadProgress');

    const events = await collectGlobalErrors(() => {
      expect(() => guarded?.(event)).not.toThrow();
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBeInstanceOf(Error);
    expect((events[0]?.error as Error).message).toContain('onDownloadProgress');
    expect(((events[0]?.error as Error).cause as Error).message).toBe(
      'progress bar broke',
    );
  });

  test('a rejecting async callback is reported too, rather than left unhandled', async () => {
    // The half a hand-rolled `try`/`catch` misses: an `async` callback that rejects sails
    // past a synchronous guard and becomes an unhandled rejection.
    // A JavaScript caller can hand over an `async` function where a `void` one is
    // declared; the guard must cover that shape too.
    const rejecting: unknown = () =>
      Promise.reject(new Error('async progress bar broke'));
    const guarded = guardProgressCallback(
      rejecting as (progress: AdapterProgressEvent) => void,
      'onUploadProgress',
    );

    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };

    process.on('unhandledRejection', onUnhandled);

    try {
      const events = await collectGlobalErrors(() => {
        guarded?.(event);
      });

      expect(events).toHaveLength(1);
      expect(((events[0]?.error as Error).cause as Error).message).toBe(
        'async progress bar broke',
      );
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a non-function is reported once per event instead of throwing a TypeError', async () => {
    const guarded = guardProgressCallback(
      'not a function' as unknown as (progress: AdapterProgressEvent) => void,
      'onUploadProgress',
    );

    const events = await collectGlobalErrors(() => {
      expect(() => guarded?.(event)).not.toThrow();
    });

    expect(events).toHaveLength(1);
  });
});
