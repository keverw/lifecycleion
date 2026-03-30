import { describe, expect, test } from 'bun:test';
import { RequestTracker } from './request-tracker';
import type { TrackedRequest } from './request-tracker';

function makeEntry(overrides?: Partial<TrackedRequest>): TrackedRequest {
  return {
    requestID: 'req-1',
    clientID: 'client-1',
    state: 'pending',
    abortController: new AbortController(),
    ...overrides,
  };
}

describe('RequestTracker', () => {
  describe('add / get / remove', () => {
    test('get returns entry after add', () => {
      const tracker = new RequestTracker();
      const entry = makeEntry();
      tracker.add(entry);
      expect(tracker.get('req-1')).toBe(entry);
    });

    test('get returns undefined for unknown requestID', () => {
      expect(new RequestTracker().get('nope')).toBeUndefined();
    });

    test('remove deletes the entry', () => {
      const tracker = new RequestTracker();
      tracker.add(makeEntry());
      tracker.remove('req-1');
      expect(tracker.get('req-1')).toBeUndefined();
    });

    test('remove is a no-op for unknown requestID', () => {
      expect(() => new RequestTracker().remove('nope')).not.toThrow();
    });
  });

  describe('cancel', () => {
    test('sets state to cancelled and aborts the signal', () => {
      const tracker = new RequestTracker();
      const entry = makeEntry();
      tracker.add(entry);
      expect(tracker.cancel('req-1')).toBe(1);
      expect(entry.state).toBe('cancelled');
      expect(entry.abortController.signal.aborted).toBe(true);
    });

    test('returns 0 for unknown requestID', () => {
      expect(new RequestTracker().cancel('nope')).toBe(0);
    });
  });

  describe('cancelAll', () => {
    test('cancels every tracked request and returns the count', () => {
      const tracker = new RequestTracker();
      const a = makeEntry({ requestID: 'a' });
      const b = makeEntry({ requestID: 'b' });
      tracker.add(a);
      tracker.add(b);
      expect(tracker.cancelAll()).toBe(2);
      expect(a.state).toBe('cancelled');
      expect(b.state).toBe('cancelled');
      expect(a.abortController.signal.aborted).toBe(true);
      expect(b.abortController.signal.aborted).toBe(true);
    });

    test('returns 0 when tracker is empty', () => {
      expect(new RequestTracker().cancelAll()).toBe(0);
    });
  });

  describe('cancelOwn', () => {
    test('cancels only requests belonging to the given clientID and returns the count', () => {
      const tracker = new RequestTracker();
      const mine = makeEntry({ requestID: 'mine', clientID: 'client-a' });
      const other = makeEntry({ requestID: 'other', clientID: 'client-b' });

      tracker.add(mine);
      tracker.add(other);

      expect(tracker.cancelOwn('client-a')).toBe(1);
      expect(mine.state).toBe('cancelled');
      expect(other.state).toBe('pending');
    });

    test('returns 0 when no requests match the clientID', () => {
      const tracker = new RequestTracker();
      tracker.add(makeEntry({ requestID: 'a', clientID: 'c1' }));
      expect(tracker.cancelOwn('nobody')).toBe(0);
    });
  });

  describe('cancelAllWithLabel', () => {
    test('cancels requests with matching label across all clients and returns the count', () => {
      const tracker = new RequestTracker();
      const labeled = makeEntry({
        requestID: 'a',
        clientID: 'c1',
        label: 'search',
      });

      const other = makeEntry({ requestID: 'b', clientID: 'c2', label: 'nav' });
      tracker.add(labeled);
      tracker.add(other);

      expect(tracker.cancelAllWithLabel('search')).toBe(1);
      expect(labeled.state).toBe('cancelled');
      expect(other.state).toBe('pending');
    });

    test('does not cancel requests with no label and returns 0', () => {
      const tracker = new RequestTracker();
      const unlabeled = makeEntry({ requestID: 'a' });
      tracker.add(unlabeled);
      expect(tracker.cancelAllWithLabel('search')).toBe(0);
      expect(unlabeled.state).toBe('pending');
    });
  });

  describe('cancelOwnWithLabel', () => {
    test('cancels only requests matching both clientID and label and returns the count', () => {
      const tracker = new RequestTracker();
      const match = makeEntry({
        requestID: 'a',
        clientID: 'c1',
        label: 'search',
      });
      const wrongClient = makeEntry({
        requestID: 'b',
        clientID: 'c2',
        label: 'search',
      });
      const wrongLabel = makeEntry({
        requestID: 'c',
        clientID: 'c1',
        label: 'nav',
      });
      tracker.add(match);
      tracker.add(wrongClient);
      tracker.add(wrongLabel);
      expect(tracker.cancelOwnWithLabel('c1', 'search')).toBe(1);
      expect(match.state).toBe('cancelled');
      expect(wrongClient.state).toBe('pending');
      expect(wrongLabel.state).toBe('pending');
    });

    test('returns 0 when no requests match', () => {
      const tracker = new RequestTracker();
      tracker.add(makeEntry({ requestID: 'a', clientID: 'c1', label: 'nav' }));
      expect(tracker.cancelOwnWithLabel('c1', 'search')).toBe(0);
    });
  });

  describe('list', () => {
    test('returns all requests with no filter', () => {
      const tracker = new RequestTracker();
      tracker.add(makeEntry({ requestID: 'a' }));
      tracker.add(makeEntry({ requestID: 'b' }));
      const result = tracker.list();
      expect(result.count).toBe(2);
      expect(result.requests.map((r) => r.requestID)).toEqual(
        expect.arrayContaining(['a', 'b']),
      );
    });

    test('filters by clientID', () => {
      const tracker = new RequestTracker();
      tracker.add(makeEntry({ requestID: 'a', clientID: 'c1' }));
      tracker.add(makeEntry({ requestID: 'b', clientID: 'c2' }));
      const result = tracker.list({ clientID: 'c1' });
      expect(result.count).toBe(1);
      expect(result.requests[0].requestID).toBe('a');
    });

    test('filters by label', () => {
      const tracker = new RequestTracker();
      tracker.add(makeEntry({ requestID: 'a', label: 'search' }));
      tracker.add(makeEntry({ requestID: 'b', label: 'nav' }));
      const result = tracker.list({ label: 'search' });
      expect(result.count).toBe(1);
      expect(result.requests[0].requestID).toBe('a');
    });

    test('filters by both clientID and label', () => {
      const tracker = new RequestTracker();
      tracker.add(
        makeEntry({ requestID: 'a', clientID: 'c1', label: 'search' }),
      );
      tracker.add(makeEntry({ requestID: 'b', clientID: 'c1', label: 'nav' }));
      tracker.add(
        makeEntry({ requestID: 'c', clientID: 'c2', label: 'search' }),
      );
      const result = tracker.list({ clientID: 'c1', label: 'search' });
      expect(result.count).toBe(1);
      expect(result.requests[0].requestID).toBe('a');
    });

    test('returns count 0 and empty array when nothing matches', () => {
      const tracker = new RequestTracker();
      const result = tracker.list({ clientID: 'nobody' });
      expect(result.count).toBe(0);
      expect(result.requests).toEqual([]);
    });

    test('exposed RequestInfo omits abortController', () => {
      const tracker = new RequestTracker();
      tracker.add(
        makeEntry({ requestID: 'a', clientID: 'client-x', label: 'x' }),
      );
      const [info] = tracker.list().requests;
      expect(info).toEqual({
        requestID: 'a',
        clientID: 'client-x',
        label: 'x',
        state: 'pending',
      });
      expect((info as any).abortController).toBeUndefined();
    });
  });
});
