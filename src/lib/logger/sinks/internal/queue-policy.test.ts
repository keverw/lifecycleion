import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_MAX_QUEUE_SIZE,
  DEFAULT_MAX_RETRIES,
  MAX_TIMER_MS,
  UNLIMITED_QUEUE,
  resolveMaxQueueSize,
  resolveMaxRetries,
  resolveTimeoutMS,
} from './queue-policy';

describe('resolveTimeoutMS', () => {
  test('takes the default for an absent or unusable request', () => {
    // `NaN` made every `elapsed > timeoutMS` comparison false, so a drain loop bounded
    // by it never timed out and `close()` hung on a stalled destination.
    expect(resolveTimeoutMS(undefined, 30_000)).toBe(30_000);
    expect(resolveTimeoutMS(Number.NaN, 30_000)).toBe(30_000);
    expect(resolveTimeoutMS('5000' as unknown as number, 30_000)).toBe(30_000);
    expect(resolveTimeoutMS(-1, 30_000)).toBe(30_000);
  });

  test('honours zero and any finite wait', () => {
    expect(resolveTimeoutMS(0, 30_000)).toBe(0);
    expect(resolveTimeoutMS(150, 30_000)).toBe(150);
  });

  test('bounds Infinity at the longest wait a timer can keep', () => {
    // `setTimeout` reads a delay past `2^31 - 1` as `1`, so `Infinity` fired the init
    // deadline at once rather than never.
    expect(resolveTimeoutMS(Number.POSITIVE_INFINITY, 30_000)).toBe(
      MAX_TIMER_MS,
    );
    expect(resolveTimeoutMS(MAX_TIMER_MS + 1, 30_000)).toBe(MAX_TIMER_MS);
  });
});

describe('resolveMaxQueueSize', () => {
  test('takes the default for an absent or unusable request', () => {
    expect(resolveMaxQueueSize()).toBe(DEFAULT_MAX_QUEUE_SIZE);
    expect(resolveMaxQueueSize(Number.NaN)).toBe(DEFAULT_MAX_QUEUE_SIZE);
    expect(resolveMaxQueueSize('20' as unknown as number)).toBe(
      DEFAULT_MAX_QUEUE_SIZE,
    );
  });

  test('reads a negative value, and `Infinity`, as unlimited', () => {
    expect(resolveMaxQueueSize(UNLIMITED_QUEUE)).toBeUndefined();
    expect(resolveMaxQueueSize(-42)).toBeUndefined();
    expect(resolveMaxQueueSize(Number.POSITIVE_INFINITY)).toBeUndefined();
  });

  test('takes the default for zero rather than queueing nothing', () => {
    expect(resolveMaxQueueSize(0)).toBe(DEFAULT_MAX_QUEUE_SIZE);
  });

  test('never resolves a positive request to zero', () => {
    // The guard above rejects `0` because a sink that queues nothing discards everything
    // written before it initializes. `Math.floor` alone reached that same answer from a
    // value the caller clearly did not mean as "drop everything": every fraction under
    // one floored to zero, and `enforceQueueLimit`'s `while (queue.length > 0)` then
    // evicted each entry as it arrived.
    expect(resolveMaxQueueSize(0.5)).toBe(1);
    expect(resolveMaxQueueSize(0.001)).toBe(1);
    expect(resolveMaxQueueSize(Number.MIN_VALUE)).toBe(1);
  });

  test('floors a fractional request above one', () => {
    expect(resolveMaxQueueSize(10.9)).toBe(10);
    expect(resolveMaxQueueSize(1.2)).toBe(1);
    expect(resolveMaxQueueSize(500)).toBe(500);
  });
});

describe('resolveMaxRetries', () => {
  test('takes the default for an absent or unusable request', () => {
    expect(resolveMaxRetries()).toBe(DEFAULT_MAX_RETRIES);
    expect(resolveMaxRetries(Number.NaN)).toBe(DEFAULT_MAX_RETRIES);
    expect(resolveMaxRetries(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_MAX_RETRIES,
    );
  });

  test('resolves a non-positive request to no retries at all', () => {
    expect(resolveMaxRetries(0)).toBe(0);
    expect(resolveMaxRetries(-1)).toBe(0);
    expect(resolveMaxRetries(0.5)).toBe(0);
  });

  test('floors a usable request', () => {
    expect(resolveMaxRetries(3)).toBe(3);
    expect(resolveMaxRetries(7.9)).toBe(7);
  });
});
