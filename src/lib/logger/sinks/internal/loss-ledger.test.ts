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

    return true;
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
    format: 2,
    close: 0,
  });
  expect(ledger.droppedEntries).toBe(3);
});

test('a suppressed report does not spend the once-only report it was claimed for', () => {
  const reports: string[] = [];
  let isSuppressed = true;
  const ledger = new LossLedger((_kind, message) => {
    if (isSuppressed) {
      return false;
    }

    reports.push(message);

    return true;
  });

  ledger.refuseAfterClose(entry('inside a console report'), () => 'refused');
  const queue = [{ entry: entry('a') }, { entry: entry('b') }];
  ledger.evict(queue, 1, () => 'evicted');

  isSuppressed = false;
  ledger.refuseAfterClose(entry('after'), () => 'refused after');
  ledger.refuseAfterClose(entry('later'), () => 'refused later');
  queue.push({ entry: entry('c') });
  ledger.evict(queue, 1, () => 'evicted after');
  queue.push({ entry: entry('d') });
  ledger.evict(queue, 1, () => 'evicted later');

  expect(reports).toEqual(['refused after', 'evicted after']);
  expect(ledger.droppedByKind()).toMatchObject({ close: 3, queue_full: 3 });
});
