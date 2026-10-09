import { expect, test } from 'bun:test';
import { describeEntryCount, LossLedger } from './loss-ledger';
import { markDiagnosticEntry } from '../../internal/sink-failure-routing';
import type { LogEntry } from '../../types';

const entry = (message: string): LogEntry => ({
  timestamp: 0,
  type: 'info',
  template: message,
  message,
});

interface Report {
  kind: 'close' | 'queue_full';
  message: string;
  entry: LogEntry | undefined;
}

function makeLedger(): { ledger: LossLedger; reports: Report[] } {
  const reports: Report[] = [];
  const ledger = new LossLedger((kind, message, lost) => {
    reports.push({ kind, message, entry: lost });
  });

  return { ledger, reports };
}

test('entries refused after close are all counted and reported once per origin', () => {
  const { ledger, reports } = makeLedger();
  const first = entry('first');
  const diagnostic = markDiagnosticEntry(entry('diagnostic'));

  ledger.refuseAfterClose(first, () => 'refused');
  ledger.refuseAfterClose(entry('second'), () => 'refused again');
  // A diagnostic's refusal does not spend the ordinary report, nor vice versa.
  ledger.refuseAfterClose(diagnostic, () => 'refused diagnostic');

  expect(ledger.droppedEntries).toBe(3);
  expect(ledger.droppedByKind().close).toBe(3);
  expect(reports).toEqual([
    { kind: 'close', message: 'refused', entry: first },
    { kind: 'close', message: 'refused diagnostic', entry: diagnostic },
  ]);
});

test('eviction is counted per entry and reported once per overflow episode', () => {
  const { ledger, reports } = makeLedger();
  const oldest = entry('oldest');
  const queue = [
    { entry: oldest },
    { entry: entry('b') },
    { entry: entry('c') },
  ];

  ledger.evict(queue, undefined, () => 'unreachable');
  expect(queue).toHaveLength(3);

  ledger.evict(queue, 1, (limit) => `full at ${String(limit)}`);
  expect(queue).toHaveLength(1);
  expect(reports).toEqual([
    { kind: 'queue_full', message: 'full at 1', entry: oldest },
  ]);

  queue.push({ entry: entry('d') });
  ledger.evict(queue, 1, () => 'still full');
  // Nothing evicted is never a report, and the episode's report has already gone out.
  ledger.evict(queue, 1, () => 'nothing evicted');
  expect(reports).toHaveLength(1);
  expect(ledger.droppedByKind().queue_full).toBe(3);

  ledger.endOverflowEpisode();
  queue.push({ entry: entry('e') });
  ledger.evict(queue, 1, () => 'next episode');
  expect(reports.map((report) => report.message)).toEqual([
    'full at 1',
    'next episode',
  ]);
  expect(ledger.droppedEntries).toBe(4);
});

test('an abandoned queue is emptied, counted, and reported once with its count', () => {
  const { ledger, reports } = makeLedger();
  const oldest = entry('oldest');
  const queue = [{ entry: oldest }, { entry: entry('newer') }];

  ledger.abandon([], () => 'unreachable');
  expect(reports).toHaveLength(0);

  ledger.abandon(queue, (count) => `abandoned ${describeEntryCount(count)}`);
  expect(queue).toEqual([]);
  expect(reports).toEqual([
    { kind: 'close', message: 'abandoned 2 entries', entry: oldest },
  ]);
  expect(ledger.droppedByKind().close).toBe(2);
  expect(describeEntryCount(1)).toBe('1 entry');
});

test('the breakdown is a copy that always sums to the total', () => {
  const { ledger } = makeLedger();

  ledger.count('write');
  ledger.count('format', 2);

  const byKind = ledger.droppedByKind();
  byKind.write = 100;

  expect(ledger.droppedByKind()).toEqual({
    queue_full: 0,
    write: 1,
    setup: 0,
    format: 2,
    close: 0,
  });
  expect(ledger.droppedEntries).toBe(3);
});
