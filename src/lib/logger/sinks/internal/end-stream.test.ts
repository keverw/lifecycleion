import { afterEach, expect, test } from 'bun:test';
import type { Writable } from 'stream';
import { endStreamWithin } from './end-stream';
import { MIN_CLOSE_FLUSH_MS } from './queue-policy';

interface FakeStream {
  destroyed: boolean;
  writableLength: number;
  end: (callback: () => void) => void;
  destroy: () => void;
}

function fakeStream(
  end: FakeStream['end'],
  events: string[] = [],
): FakeStream & Writable {
  const stream: FakeStream = {
    destroyed: false,
    writableLength: 64,
    end,
    destroy() {
      events.push('destroy');
      this.destroyed = true;
    },
  };

  return stream as FakeStream & Writable;
}

const originalSetTimeout = globalThis.setTimeout;

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
});

/** Record whether each deadline timer is still referenced once it has been armed. */
function recordTimerRefs(): boolean[] {
  const refs: boolean[] = [];

  globalThis.setTimeout = ((...args: Parameters<typeof originalSetTimeout>) => {
    const timer = originalSetTimeout(...args);

    queueMicrotask(() => {
      refs.push(timer.hasRef());
    });

    return timer;
  }) as typeof setTimeout;

  return refs;
}

test('a stream that flushes reports nothing left and is released', async () => {
  const events: string[] = [];
  const stream = fakeStream((callback) => {
    callback();
  }, events);
  let wasAbandoned = false;

  const bytesLeft = await endStreamWithin(stream, 1000, {
    shouldUnref: false,
    onAbandon: () => {
      wasAbandoned = true;
    },
  });

  expect(bytesLeft).toBe(0);
  expect(wasAbandoned).toBe(false);
  expect(events).toEqual(['destroy']);
});

test('a stalled flush gives up at the floor, reporting before it destroys', async () => {
  const events: string[] = [];
  const stream = fakeStream(() => {}, events);
  const startedAt = Date.now();

  const bytesLeft = await endStreamWithin(stream, 0, {
    shouldUnref: true,
    onAbandon: (bytes) => {
      events.push(`abandon ${String(bytes)}`);
    },
  });

  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(MIN_CLOSE_FLUSH_MS - 5);
  expect(bytesLeft).toBe(64);
  expect(events).toEqual(['abandon 64', 'destroy']);
});

test('an end() that throws is reported and the stream abandoned', async () => {
  const events: string[] = [];
  const failure = new Error('end failed');
  const stream = fakeStream(() => {
    throw failure;
  }, events);
  const endErrors: unknown[] = [];

  const bytesLeft = await endStreamWithin(stream, 1000, {
    shouldUnref: false,
    onAbandon: () => {
      events.push('abandon');
    },
    onEndError: (error) => {
      endErrors.push(error);
    },
  });

  expect(endErrors).toEqual([failure]);
  expect(bytesLeft).toBe(64);
  expect(events).toEqual(['abandon', 'destroy']);
});

test('only a background flush lets its deadline release the process', async () => {
  const refs = recordTimerRefs();

  await endStreamWithin(
    fakeStream(() => {}),
    0,
    { shouldUnref: false },
  );
  await endStreamWithin(
    fakeStream(() => {}),
    0,
    { shouldUnref: true },
  );

  expect(refs).toEqual([true, false]);
});
