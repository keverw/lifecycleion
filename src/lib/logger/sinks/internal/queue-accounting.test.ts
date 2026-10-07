import { expect, test } from 'bun:test';
import { evictQueuedEntries } from './queue-accounting';
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
  expect(evictQueuedEntries(queue, 1)).toEqual({ count: 2, entry: lost });
  expect(queue).toEqual([kept]);
  expect(evictQueuedEntries(queue, 1)).toEqual({ count: 0 });
});

test('overflow containing only diagnostics retains its terminal-report provenance', () => {
  const diagnostic = markDiagnosticEntry(entry('diagnostic'));
  const queue = [{ entry: diagnostic }, { entry: entry('kept') }];
  expect(evictQueuedEntries(queue, 1)).toEqual({ count: 1, entry: diagnostic });
});
