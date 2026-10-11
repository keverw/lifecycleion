import { expect, test } from 'bun:test';
import {
  Backoff,
  OPEN_RETRY_BACKOFF,
  openRetryBackoff,
  setOpenRetryBackoffForTesting,
} from './reopen-backoff';

test('a run starts at initialMS and doubles up to maxMS', () => {
  const backoff = new Backoff({ initialMS: 1000, maxMS: 30_000 });

  expect(backoff.isAtRest).toBe(true);
  expect(Array.from({ length: 7 }, () => backoff.next())).toEqual([
    1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
  ]);
  expect(backoff.isAtRest).toBe(false);
});

test('reset starts the next failure on a fresh run', () => {
  const backoff = new Backoff({ initialMS: 1000, maxMS: 30_000 });

  backoff.next();
  backoff.next();
  backoff.reset();

  expect(backoff.isAtRest).toBe(true);
  expect(backoff.next()).toBe(1000);
});

test('initialMS equal to maxMS is a flat cooldown', () => {
  const backoff = new Backoff({ initialMS: 1000, maxMS: 1000 });

  expect(Array.from({ length: 4 }, () => backoff.next())).toEqual([
    1000, 1000, 1000, 1000,
  ]);
});

test('maxMS caps the first wait as well', () => {
  const backoff = new Backoff({ initialMS: 2000, maxMS: 500 });

  expect(backoff.next()).toBe(500);
  expect(backoff.next()).toBe(500);
});

test('the open backoff is 1 s doubling to a 5 s cap, overridable for tests', () => {
  const backoff = new Backoff(openRetryBackoff());

  expect(Array.from({ length: 5 }, () => backoff.next())).toEqual([
    1000, 2000, 4000, 5000, 5000,
  ]);

  setOpenRetryBackoffForTesting({ initialMS: 10, maxMS: 20 });

  try {
    expect(openRetryBackoff()).toEqual({ initialMS: 10, maxMS: 20 });
  } finally {
    setOpenRetryBackoffForTesting(undefined);
  }

  expect(openRetryBackoff()).toEqual(OPEN_RETRY_BACKOFF);
});
