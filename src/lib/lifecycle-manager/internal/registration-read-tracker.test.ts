import { expect, test } from 'bun:test';
import { Logger } from '../../logger';
import type { BaseComponent } from '../base-component';
import { Plain } from '../test-helpers';
import { RegistrationReadTracker } from './registration-read-tracker';

const component = (name: string): BaseComponent =>
  new Plain(new Logger(), name);

test('a replaced registration during a read is read again using its new generation', () => {
  const first = component('first');
  const tracker = new RegistrationReadTracker(() => [first]);
  tracker.advanceRegistration(first);
  let count = 0;
  const result = tracker.readRegistry(() => {
    count++;
    if (count === 1) {
      tracker.advanceRegistration(first);
    }
    return count;
  });
  expect(result.isSettled).toBe(true);
  expect(result.reads.get(first)).toBe(2);
  expect(count).toBe(2);
  expect(tracker.isReadCurrent(result.reads, first)).toBe(true);
});

test('rollback restores prior read identity but never reuses a generation number', () => {
  const first = component('first');
  const second = component('second');
  const tracker = new RegistrationReadTracker(() => [first]);
  tracker.advanceRegistration(first);
  const original = tracker.currentGeneration(first);
  const reads = tracker.readRegistry(() => 'original').reads;
  tracker.advanceRegistration(first);
  const rolledBack = tracker.currentGeneration(first);
  expect(tracker.isReadCurrent(reads, first)).toBe(false);
  tracker.restoreRegistration(first, original);
  expect(tracker.isReadCurrent(reads, first)).toBe(true);
  tracker.advanceRegistration(second);
  expect(tracker.currentGeneration(second)).toBeGreaterThan(rolledBack ?? 0);
  tracker.restoreRegistration(second, undefined);
  expect(tracker.currentGeneration(second)).toBeUndefined();
});

test('reads follow live registry publication and additions from the settled callback', () => {
  const first = component('first');
  const second = component('second');
  const third = component('third');
  let source = [first];
  const tracker = new RegistrationReadTracker(() => source);
  tracker.advanceRegistration(first);
  const visits: BaseComponent[] = [];
  let settled = 0;
  const result = tracker.readRegistry(
    (item) => {
      visits.push(item);
      if (item === first) {
        tracker.advanceRegistration(second);
        source = [second];
      }
      return item.getName();
    },
    new Map(),
    () => true,
    () => {
      settled++;
      if (settled === 1) {
        tracker.advanceRegistration(third);
        source = [second, third];
      }
    },
  );
  expect(result.isSettled).toBe(true);
  expect(visits).toEqual([first, second, third]);
  expect(settled).toBe(2);
  tracker.readRegistry(
    () => {
      throw new Error('current answers must be reused');
    },
    result.reads,
    () => true,
    () => settled++,
  );
  expect(settled).toBe(2);
});

test('cancellation is checked before every read and perpetual generation changes are bounded', () => {
  const first = component('first');
  const second = component('second');
  const tracker = new RegistrationReadTracker(() => [first, second]);
  let count = 0;
  const cancelled = tracker.readRegistry(
    () => ++count,
    new Map(),
    () => count === 0,
  );
  expect(cancelled.isSettled).toBe(false);
  expect(count).toBe(1);
  count = 0;
  const bounded = tracker.readRegistry((item) => {
    tracker.advanceRegistration(item);
    return ++count;
  });
  expect(bounded.isSettled).toBe(false);
  expect(count).toBe(32);
});
