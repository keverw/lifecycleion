import { expect, test } from 'bun:test';
import {
  abandonQueuedEntries,
  evictQueuedEntries,
  ReportOnceLatch,
} from './queue-accounting';
import { markDiagnosticEntry } from '../../internal/sink-failure-routing';
import type { LogEntry } from '../../types';

const entry = (message: string): LogEntry => ({
  timestamp: 0,
  type: 'info',
  template: message,
  message,
});

test('overflow samples ordinary lost work instead of a preceding diagnostic', () => {
  const diagnostic = markDiagnosticEntry(entry('diagnostic'));
  const lost = entry('lost application entry');
  const kept = { entry: entry('surviving application entry') };
  const queue = [{ entry: diagnostic }, { entry: lost }, kept];
  expect(evictQueuedEntries(queue, 1)).toEqual({
    count: 2,
    entry: lost,
    start: 0,
  });
  expect(queue).toEqual([kept]);
  expect(evictQueuedEntries(queue, 1)).toEqual({ count: 0, start: 0 });
});

test('overflow containing only diagnostics retains its terminal-report provenance', () => {
  const diagnostic = markDiagnosticEntry(entry('diagnostic'));
  const queue = [{ entry: diagnostic }, { entry: entry('kept') }];
  expect(evictQueuedEntries(queue, 1)).toEqual({
    count: 1,
    entry: diagnostic,
    start: 0,
  });
});

test('with a start, eviction near the front advances it instead of moving the queue', () => {
  const dead = { entry: entry('dead'), isInFlight: false };
  const inFlight = { entry: entry('in flight'), isInFlight: true };
  const oldest = { entry: entry('oldest queued'), isInFlight: false };
  const rest = Array.from({ length: 6 }, (_, index) => ({
    entry: entry(`queued ${String(index)}`),
    isInFlight: false,
  }));
  const queue = [dead, inFlight, oldest, ...rest];
  const result = evictQueuedEntries(queue, 7, {
    start: 1,
    isEvictable: (item) => !item.isInFlight,
  });

  // Only the line in flight moved up, into the place `oldest` left.
  expect(result).toEqual({ count: 1, entry: oldest.entry, start: 2 });
  expect(queue).toHaveLength(9);
  expect(queue.slice(result.start)).toEqual([inFlight, ...rest]);
});

test('an abandoned queue is emptied in place and sampled by ordinary work first', () => {
  const diagnostic = markDiagnosticEntry(entry('diagnostic'));
  const ordinary = entry('ordinary');
  const queue = [{ entry: diagnostic }, { entry: ordinary }];
  expect(abandonQueuedEntries(queue)).toEqual({ count: 2, entry: ordinary });
  expect(queue).toEqual([]);
  expect(abandonQueuedEntries(queue)).toEqual({ count: 0 });
  const onlyDiagnostics = [{ entry: diagnostic }];
  expect(abandonQueuedEntries(onlyDiagnostics)).toEqual({
    count: 1,
    entry: diagnostic,
  });
});

test('a report latch claims once per origin until reset', () => {
  const latch = new ReportOnceLatch();
  const diagnostic = markDiagnosticEntry(entry('diagnostic'));
  expect(latch.claim(diagnostic)).toBe(true);
  expect(latch.claim(diagnostic)).toBe(false);
  // A diagnostic's claim does not spend the ordinary report.
  expect(latch.claim(entry('ordinary'))).toBe(true);
  expect(latch.claim(undefined)).toBe(false);
  latch.reset();
  expect(latch.claim(undefined)).toBe(true);
  expect(latch.claim(diagnostic)).toBe(true);
});

test('a released claim re-arms only its own origin', () => {
  const latch = new ReportOnceLatch();
  const diagnostic = markDiagnosticEntry(entry('diagnostic'));
  expect(latch.claim(diagnostic)).toBe(true);
  expect(latch.claim(entry('ordinary'))).toBe(true);

  latch.release(diagnostic);
  expect(latch.claim(undefined)).toBe(false);
  expect(latch.claim(diagnostic)).toBe(true);

  latch.release(entry('ordinary'));
  expect(latch.claim(diagnostic)).toBe(false);
  expect(latch.claim(undefined)).toBe(true);
});
