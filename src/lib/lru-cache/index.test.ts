import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { runInNewContext } from 'node:vm';
import {
  LRUCache,
  type LRUCacheChangeEvent,
  type LRUCacheChangeReason,
} from '.';

function getFirstReportedError(
  errorHandler: ReturnType<typeof mock>,
): ErrorEvent {
  const [errorEvent] = errorHandler.mock.calls.at(0) ?? [];
  expect(errorEvent).toBeDefined();
  return errorEvent as ErrorEvent;
}

describe('LRUCache', () => {
  describe('Basic operations', () => {
    let cache: LRUCache<string, string>;

    beforeEach(() => {
      cache = new LRUCache<string, string>(3);
    });

    test('should store and retrieve values', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    test('should return undefined for non-existent keys', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    test('should update existing keys', () => {
      cache.set('key1', 'value1');
      cache.set('key1', 'updated');
      expect(cache.get('key1')).toBe('updated');
    });

    test('should track size correctly', () => {
      expect(cache.size).toBe(0);
      cache.set('key1', 'value1');
      expect(cache.size).toBe(1);
      cache.set('key2', 'value2');
      expect(cache.size).toBe(2);
    });

    test('should clear all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.get('key1')).toBeUndefined();
    });

    test('should check if keys exist with has()', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('nonexistent')).toBe(false);
    });

    test('should delete specific entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      expect(cache.size).toBe(3);

      // Delete an existing key
      const wasDeleted = cache.delete('key2');
      expect(wasDeleted).toBe(true);
      expect(cache.size).toBe(2);
      expect(cache.has('key2')).toBe(false);
      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key3')).toBe('value3');

      // Try to delete a non-existent key
      const wasFound = cache.delete('nonexistent');
      expect(wasFound).toBe(false);
      expect(cache.size).toBe(2);
    });

    test('should update byte size when deleting entries', () => {
      const cache = new LRUCache<string, string>(10, { maxSize: 1000 });

      cache.set('key1', 'a'.repeat(10));
      cache.set('key2', 'b'.repeat(20));

      const initialSize = cache.byteSize;
      expect(initialSize).toBeGreaterThan(0);

      // Delete one entry
      cache.delete('key1');

      // Byte size should decrease
      expect(cache.byteSize).toBeLessThan(initialSize);
      expect(cache.byteSize).toBeGreaterThan(0);

      // Delete the last entry
      cache.delete('key2');
      expect(cache.byteSize).toBe(0);
    });
  });

  describe('LRU eviction', () => {
    test('should evict least recently used items when max entries is reached', () => {
      const cache = new LRUCache<string, string>(3);

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // All keys should be present
      expect(cache.get('key1')).toBe('value1');
      expect(cache.get('key2')).toBe('value2');
      expect(cache.get('key3')).toBe('value3');

      // Access key1 to make it most recently used
      cache.get('key1');

      // Add a new key, which should evict key2 (least recently used)
      cache.set('key4', 'value4');

      expect(cache.get('key1')).toBe('value1'); // Still present (was accessed)
      expect(cache.get('key2')).toBeUndefined(); // Evicted (least recently used)
      expect(cache.get('key3')).toBe('value3'); // Still present
      expect(cache.get('key4')).toBe('value4'); // Newly added
    });
  });

  describe('TTL expiration', () => {
    test('should support manual cleanup of expired entries', () => {
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10, { defaultTtl: 100 });

        cache.set('key1', 'value1');
        cache.set('key2', 'value2', 50);

        currentTime += 75;

        expect(cache.size).toBe(2);
        expect(cache.cleanupExpired()).toBe(1);
        expect(cache.size).toBe(1);
        expect(cache.get('key1')).toBe('value1');
        expect(cache.get('key2')).toBeUndefined();

        currentTime += 50;

        expect(cache.cleanupExpired()).toBe(1);
        expect(cache.size).toBe(0);
        expect(cache.byteSize).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should return false from has() for expired items', () => {
      // Mock Date.now to control time
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10, { defaultTtl: 100 });

        cache.set('key1', 'value1');
        expect(cache.has('key1')).toBe(true);

        // Advance time past TTL
        currentTime += 150;

        // Item should be expired
        expect(cache.has('key1')).toBe(false);
        expect(cache.get('key1')).toBeUndefined();
      } finally {
        // Restore original Date.now
        Date.now = originalNow;
      }
    });

    test('should expire items after TTL', () => {
      // Mock Date.now to control time
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10, { defaultTtl: 100 });

        cache.set('key1', 'value1');
        expect(cache.get('key1')).toBe('value1');

        // Advance time past TTL
        currentTime += 150;

        // Item should be expired
        expect(cache.get('key1')).toBeUndefined();
      } finally {
        // Restore original Date.now
        Date.now = originalNow;
      }
    });

    test('should respect custom TTL for specific entries', () => {
      // Mock Date.now to control time
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10, { defaultTtl: 100 });

        cache.set('key1', 'default ttl');
        cache.set('key2', 'custom ttl', 50); // Shorter TTL

        expect(cache.get('key1')).toBe('default ttl');
        expect(cache.get('key2')).toBe('custom ttl');

        // Advance time past custom TTL but before default TTL
        currentTime += 75;

        expect(cache.get('key1')).toBe('default ttl'); // Still valid
        expect(cache.get('key2')).toBeUndefined(); // Expired (custom TTL)

        // Advance time past default TTL
        currentTime += 50;

        expect(cache.get('key1')).toBeUndefined(); // Now expired
      } finally {
        // Restore original Date.now
        Date.now = originalNow;
      }
    });

    test('should keep an entry valid at the exact expiration boundary', () => {
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10, { defaultTtl: 100 });

        cache.set('key1', 'value1');

        currentTime += 100;
        expect(cache.get('key1')).toBe('value1');

        currentTime += 1;
        expect(cache.get('key1')).toBeUndefined();
      } finally {
        Date.now = originalNow;
      }
    });

    test('should not expire when customTtl is 0 even with defaultTtl set', () => {
      // Mock Date.now to control time
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10, { defaultTtl: 100 });

        cache.set('key1', 'default ttl');
        cache.set('key2', 'no expiration', 0); // Explicitly set TTL to 0 (no expiration)

        expect(cache.get('key1')).toBe('default ttl');
        expect(cache.get('key2')).toBe('no expiration');

        // Advance time past default TTL
        currentTime += 150;

        expect(cache.get('key1')).toBeUndefined(); // Expired (default TTL)
        expect(cache.get('key2')).toBe('no expiration'); // Should NOT expire

        // Advance time significantly further
        currentTime += 10000;

        expect(cache.get('key2')).toBe('no expiration'); // Still should not expire
      } finally {
        // Restore original Date.now
        Date.now = originalNow;
      }
    });

    test('should allow manual cleanup for custom TTL entries without defaultTtl', () => {
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10);

        cache.set('key1', 'value1', 100);
        currentTime += 150;

        expect(cache.size).toBe(1);
        expect(cache.cleanupExpired()).toBe(1);
        expect(cache.size).toBe(0);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should run throttled cleanup on successful get() when only per-entry TTLs are used', () => {
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10);

        cache.set('expired', 'value', 100);
        cache.set('live', 'value', 120000);

        currentTime += 150;
        expect(cache.size).toBe(2);

        currentTime += 60 * 1000 + 1;

        expect(cache.get('live')).toBe('value');
        expect(cache.size).toBe(1);
        expect(cache.has('expired')).toBe(false);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should reclaim expired entries before evicting live entries on set()', () => {
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(2, { defaultTtl: 100 });

        cache.set('expired', 'value');
        cache.set('live', 'value', 1000);

        currentTime += 150;

        cache.set('new', 'value');

        expect(cache.has('expired')).toBe(false);
        expect(cache.get('live')).toBe('value');
        expect(cache.get('new')).toBe('value');
        expect(cache.size).toBe(2);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should reset the throttled cleanup timer even when cleanupExpired removes nothing', () => {
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(10);

        cache.set('expired', 'value', 100);
        cache.set('live', 'value', 180000);
        cache.set('soonExpired', 'value', 120000);

        currentTime += 150;
        expect(cache.cleanupExpired()).toBe(1);
        expect(cache.size).toBe(2);

        currentTime += 60 * 1000;
        expect(cache.cleanupExpired()).toBe(0);

        currentTime += 60 * 1000;
        expect(cache.get('live')).toBe('value');
        expect(cache.size).toBe(2);

        currentTime += 1;
        expect(cache.get('live')).toBe('value');
        expect(cache.size).toBe(1);
        expect(cache.has('soonExpired')).toBe(false);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should handle replacement and eviction when maxEntries, maxSize, and TTL interact', () => {
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(2, {
          defaultTtl: 100,
          maxSize: 10,
        });

        cache.set('a', 'aa', 50); // size 4, expires first
        cache.set('b', 'bb'); // size 4
        expect(cache.size).toBe(2);
        expect(cache.byteSize).toBe(8);

        currentTime += 60;

        cache.set('b', 'bbb'); // replace existing entry, size becomes 6
        expect(cache.get('b')).toBe('bbb');
        expect(cache.byteSize).toBe(6);
        expect(cache.size).toBe(1);

        cache.set('c', 'cc'); // size 4, fills cache to maxSize
        expect(cache.size).toBe(2);
        expect(cache.byteSize).toBe(10);

        cache.get('b'); // make b most recently used

        cache.set('d', 'dd'); // exceeds maxEntries and maxSize, should evict c
        expect(cache.get('b')).toBe('bbb');
        expect(cache.get('c')).toBeUndefined();
        expect(cache.get('d')).toBe('dd');
        expect(cache.size).toBe(2);
        expect(cache.byteSize).toBe(10);

        currentTime += 101;

        cache.set('e', 'e'); // cleanup expired b/d before inserting new value
        expect(cache.get('b')).toBeUndefined();
        expect(cache.get('d')).toBeUndefined();
        expect(cache.get('e')).toBe('e');
        expect(cache.size).toBe(1);
        expect(cache.byteSize).toBe(2);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  describe('Change events', () => {
    test('should emit set when adding and updating a key', () => {
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const cache = new LRUCache<string, string>(3, {
        onChange: (event) => {
          events.push(event);
        },
      });

      cache.set('key1', 'value1');
      cache.set('key1', 'value2');

      expect(events).toEqual([
        {
          reason: 'set',
          key: 'key1',
          newValue: 'value1',
        },
        {
          reason: 'set',
          key: 'key1',
          oldValue: 'value1',
          newValue: 'value2',
        },
      ]);
      expect('oldValue' in events[0]).toBe(false);
      expect('oldValue' in events[1]).toBe(true);
      expect(cache.get('key1')).toBe('value2');
    });

    test('should emit delete for manual deletions', () => {
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const cache = new LRUCache<string, string>(3, {
        onChange: (event) => {
          events.push(event);
        },
        onChangeReasons: ['delete'],
      });

      cache.set('key1', 'value1');
      expect(cache.delete('key1')).toBe(true);

      expect(events).toEqual([
        {
          reason: 'delete',
          key: 'key1',
          value: 'value1',
        },
      ]);
    });

    test('should emit clear for each removed entry during clear()', () => {
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const cache = new LRUCache<string, string>(3, {
        onChange: (event) => {
          events.push(event);
        },
        onChangeReasons: ['clear'],
      });

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();

      expect(events).toEqual([
        {
          reason: 'clear',
          key: 'key1',
          value: 'value1',
        },
        {
          reason: 'clear',
          key: 'key2',
          value: 'value2',
        },
      ]);
    });

    test('should emit expired when an expired entry is removed during access', () => {
      const originalNow = Date.now;
      let currentTime = 1000;
      const events: LRUCacheChangeEvent<string, string>[] = [];

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(3, {
          defaultTtl: 100,
          onChange: (event) => {
            events.push(event);
          },
          onChangeReasons: ['expired'],
        });

        cache.set('key1', 'value1');
        currentTime += 150;

        expect(cache.get('key1')).toBeUndefined();
        expect(events).toEqual([
          {
            reason: 'expired',
            key: 'key1',
            value: 'value1',
          },
        ]);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should emit evict when a least recently used entry is removed for capacity', () => {
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const cache = new LRUCache<string, string>(2, {
        onChange: (event) => {
          events.push(event);
        },
        onChangeReasons: ['evict'],
      });

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      expect(events).toEqual([
        {
          reason: 'evict',
          key: 'key1',
          value: 'value1',
        },
      ]);
      expect(cache.get('key1')).toBeUndefined();
    });

    test('should emit set and clear with distinct payload shapes', () => {
      const setEvents: LRUCacheChangeEvent<string, string>[] = [];
      const clearEvents: LRUCacheChangeEvent<string, string>[] = [];

      const replacingCache = new LRUCache<string, string>(1, {
        onChange: (event) => {
          setEvents.push(event);
        },
      });

      const clearingCache = new LRUCache<string, string>(1, {
        onChange: (event) => {
          clearEvents.push(event);
        },
      });

      // `set` events use the write payload shape.
      replacingCache.set('key1', 'value1');
      replacingCache.set('key1', 'value2');

      // `clear` events use the removal payload shape.
      clearingCache.set('key1', 'value1');
      clearingCache.clear();

      const setEvent = setEvents[0];
      const clearEvent = clearEvents[1];

      // `set` carries write-specific fields.
      expect(setEvent.reason).toBe('set');
      expect('newValue' in setEvent).toBe(true);

      // `clear` carries removal-specific fields.
      expect(clearEvent.reason).toBe('clear');
      expect('value' in clearEvent).toBe(true);
      expect('oldValue' in clearEvent).toBe(false);
      expect('newValue' in clearEvent).toBe(false);
    });

    test('should only emit subscribed change reasons when onChangeReasons is provided', () => {
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const onChangeReasons: LRUCacheChangeReason[] = ['expired', 'set'];
      const originalNow = Date.now;
      let currentTime = 1000;

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(2, {
          defaultTtl: 100,
          onChange: (event) => {
            events.push(event);
          },
          onChangeReasons,
        });

        cache.set('a', 'one');
        cache.set('a', 'two'); // set with overwrite
        cache.set('b', 'three');
        cache.delete('b'); // filtered out
        currentTime += 150;
        cache.get('a'); // expired

        expect(events).toEqual([
          {
            reason: 'set',
            key: 'a',
            newValue: 'one',
          },
          {
            reason: 'set',
            key: 'a',
            oldValue: 'one',
            newValue: 'two',
          },
          {
            reason: 'set',
            key: 'b',
            newValue: 'three',
          },
          {
            reason: 'expired',
            key: 'a',
            value: 'two',
          },
        ]);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should emit skip and avoid storing values that cannot fit maxSize', () => {
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const cache = new LRUCache<string, string>(3, {
        maxSize: 4,
        onChange: (event) => {
          events.push(event);
        },
      });

      cache.set('key1', 'abc'); // size 6, too large for maxSize 4

      expect(cache.get('key1')).toBeUndefined();
      expect(cache.size).toBe(0);
      expect(cache.byteSize).toBe(0);
      expect(events).toEqual([
        {
          reason: 'skip',
          key: 'key1',
          newValue: 'abc',
          cause: 'maxSize',
        },
      ]);
      expect('currentValue' in events[0]).toBe(false);
    });

    test('should emit skip and preserve an existing value when an oversized overwrite is attempted', () => {
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const cache = new LRUCache<string, string>(3, {
        maxSize: 8,
        onChange: (event) => {
          events.push(event);
        },
      });

      cache.set('key1', 'ok');
      cache.set('key1', 'abcde'); // size 10, too large for maxSize 8

      expect(cache.get('key1')).toBe('ok');
      expect(cache.size).toBe(1);
      expect(events).toEqual([
        {
          reason: 'set',
          key: 'key1',
          newValue: 'ok',
        },
        {
          reason: 'skip',
          key: 'key1',
          currentValue: 'ok',
          newValue: 'abcde',
          cause: 'maxSize',
        },
      ]);
      expect('oldValue' in events[0]).toBe(false);
      expect('oldValue' in events[1]).toBe(false);
      expect('currentValue' in events[1]).toBe(true);
    });

    test('should cleanup expired entries before emitting skip for an oversized write', () => {
      const originalNow = Date.now;
      let currentTime = 1000;
      const events: LRUCacheChangeEvent<string, string>[] = [];

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(3, {
          defaultTtl: 100,
          maxSize: 4,
          onChange: (event) => {
            events.push(event);
          },
        });

        cache.set('stale', 'x');
        currentTime += 150;
        cache.set('key1', 'abc'); // size 6, too large for maxSize 4

        expect(cache.size).toBe(0);
        expect(cache.byteSize).toBe(0);
        expect(events).toEqual([
          {
            reason: 'set',
            key: 'stale',
            newValue: 'x',
          },
          {
            reason: 'expired',
            key: 'stale',
            value: 'x',
          },
          {
            reason: 'skip',
            key: 'key1',
            newValue: 'abc',
            cause: 'maxSize',
          },
        ]);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should not include oldValue when rewriting a key whose previous entry already expired', () => {
      const originalNow = Date.now;
      let currentTime = 1000;
      const events: LRUCacheChangeEvent<string, string>[] = [];

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(2, {
          defaultTtl: 100,
          onChange: (event) => {
            events.push(event);
          },
        });

        cache.set('key1', 'old');
        currentTime += 150;
        cache.set('key1', 'new');

        expect(events).toEqual([
          {
            reason: 'set',
            key: 'key1',
            newValue: 'old',
          },
          {
            reason: 'expired',
            key: 'key1',
            value: 'old',
          },
          {
            reason: 'set',
            key: 'key1',
            newValue: 'new',
          },
        ]);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should not include currentValue when skipping an oversized write after the previous entry expired', () => {
      const originalNow = Date.now;
      let currentTime = 1000;
      const events: LRUCacheChangeEvent<string, string>[] = [];

      try {
        Date.now = mock(() => currentTime);

        const cache = new LRUCache<string, string>(2, {
          defaultTtl: 100,
          maxSize: 4,
          onChange: (event) => {
            events.push(event);
          },
        });

        cache.set('key1', 'x');
        currentTime += 150;
        cache.set('key1', 'abc');

        expect(events).toEqual([
          {
            reason: 'set',
            key: 'key1',
            newValue: 'x',
          },
          {
            reason: 'expired',
            key: 'key1',
            value: 'x',
          },
          {
            reason: 'skip',
            key: 'key1',
            newValue: 'abc',
            cause: 'maxSize',
          },
        ]);
        expect('currentValue' in events[2]).toBe(false);
      } finally {
        Date.now = originalNow;
      }
    });

    test('should report synchronous onChange errors without breaking cache operations', () => {
      const errorHandler = mock((event: Event) => event.preventDefault());
      const cache = new LRUCache<string, string>(3, {
        onChange: () => {
          throw new Error('onChange sync failure');
        },
      });

      globalThis.addEventListener('error', errorHandler);

      cache.set('key1', 'value1');

      expect(cache.get('key1')).toBe('value1');
      expect(errorHandler).toHaveBeenCalled();

      const errorEvent = getFirstReportedError(errorHandler);
      expect(errorEvent.error.message).toContain('LRUCache onChange');
      expect((errorEvent.error.cause as Error).message).toBe(
        'onChange sync failure',
      );

      globalThis.removeEventListener('error', errorHandler);
    });

    test('should report async onChange rejections without breaking cache operations', async () => {
      const errorHandler = mock((event: Event) => event.preventDefault());
      const cache = new LRUCache<string, string>(3, {
        onChange: () => Promise.reject(new Error('onChange async failure')),
      });

      globalThis.addEventListener('error', errorHandler);

      cache.set('key1', 'value1');

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cache.get('key1')).toBe('value1');
      expect(errorHandler).toHaveBeenCalled();

      const errorEvent = getFirstReportedError(errorHandler);
      expect(errorEvent.error.message).toContain('LRUCache onChange');
      expect((errorEvent.error.cause as Error).message).toBe(
        'onChange async failure',
      );

      globalThis.removeEventListener('error', errorHandler);
    });
  });

  describe('Size-based eviction', () => {
    test('should evict items when max size is reached', () => {
      // Create a cache with max 100 bytes
      const cache = new LRUCache<string, string>(10, { maxSize: 100 });

      // Add items with known sizes (strings are ~2 bytes per char)
      cache.set('key1', 'a'.repeat(20)); // ~40 bytes
      cache.set('key2', 'b'.repeat(20)); // ~40 bytes

      // Both should be present
      expect(cache.get('key1')).toBeDefined();
      expect(cache.get('key2')).toBeDefined();

      // Add another item that pushes us over the limit
      cache.set('key3', 'c'.repeat(30)); // ~60 bytes

      // The oldest item should be evicted
      expect(cache.get('key1')).toBeUndefined(); // Evicted
      expect(cache.get('key2')).toBeDefined(); // Still present
      expect(cache.get('key3')).toBeDefined(); // Newly added
    });

    test('should track byte size correctly', () => {
      const cache = new LRUCache<string, string>(10, { maxSize: 1000 });

      expect(cache.byteSize).toBe(0);

      cache.set('key1', 'a'.repeat(10)); // ~20 bytes
      expect(cache.byteSize).toBeGreaterThan(0);

      const initialSize = cache.byteSize;
      cache.set('key2', 'b'.repeat(20)); // ~40 bytes
      expect(cache.byteSize).toBeGreaterThan(initialSize);

      // Remove an item
      cache.set('key1', ''); // Replace with empty string
      expect(cache.byteSize).toBeLessThan(initialSize + 40);
    });
  });

  describe('Default size estimate of nested arrays', () => {
    test('an array met again is counted once, not walked again', () => {
      const cache = new LRUCache<string, unknown>(10);
      let shared: unknown[] = [1];
      for (let level = 0; level < 22; level++) {
        shared = [shared, shared];
      }

      const startedAt = performance.now();
      cache.set('k', shared);

      // Walked once per reference, it took half a second and counted about 369 MB.
      expect(performance.now() - startedAt).toBeLessThan(200);
      expect(cache.byteSize).toBeLessThan(10_000);
    });

    test('an array nested past the depth the estimate follows takes the fallback, rather than failing set()', () => {
      const cache = new LRUCache<string, unknown>(10);
      let deep: unknown[] = [];
      for (let level = 0; level < 200_000; level++) {
        deep = [deep];
      }

      expect(() => cache.set('deep', deep)).not.toThrow();
      expect(cache.get('deep')).toBe(deep);
      expect(cache.byteSize).toBeGreaterThan(0);
    });
  });

  describe('Custom size calculator', () => {
    test('should use custom size calculator when provided', () => {
      const sizeCalculator = (value: any) => {
        return typeof value === 'string' ? value.length * 3 : 10;
      };

      const cache = new LRUCache<string, any>(10, {
        maxSize: 100,
        sizeCalculator,
      });

      // Add a string that would be under the limit with default calculation
      // but over the limit with our custom calculator (length * 3)
      cache.set('key1', 'a'.repeat(20)); // Custom size: 60
      cache.set('key2', 'b'.repeat(20)); // Custom size: 60

      // Second item should have caused first to be evicted due to custom sizing
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeDefined();
    });

    test('should handle different value types with custom calculator', () => {
      const sizeCalculator = (value: any) => {
        if (typeof value === 'string') {
          return value.length;
        }

        if (typeof value === 'number') {
          return 8;
        }

        if (Array.isArray(value)) {
          return value.length * 10;
        }

        return 50; // Default for objects
      };

      // Create a cache with a small max size
      const cache = new LRUCache<string, any>(10, {
        maxSize: 40, // Small size limit
        sizeCalculator,
      });

      // Add a string
      cache.set('str', 'hello'); // Size: 5
      expect(cache.get('str')).toBeDefined();
      expect(cache.byteSize).toBe(5);

      // Add a number
      cache.set('num', 42); // Size: 8
      expect(cache.get('num')).toBeDefined();
      expect(cache.byteSize).toBe(13); // 5 + 8

      // Add an array that fits within the limit
      cache.set('arr', [1, 2]); // Size: 20 (2 * 10)
      expect(cache.get('arr')).toBeDefined();

      // The total should be 33 (5 + 8 + 20)
      expect(cache.byteSize).toBe(33);

      // All items should still be in the cache
      expect(cache.get('str')).toBeDefined();
      expect(cache.get('num')).toBeDefined();

      // Now add an item that's larger than what's left in the cache
      // but smaller than maxSize
      cache.set('bigArr', [1, 2, 3]); // Size: 30 (3 * 10)

      // This should evict at least the oldest item to make room
      expect(cache.get('str')).toBeUndefined(); // Evicted (oldest)

      // Verify the new item was added
      expect(cache.get('bigArr')).toBeDefined(); // Newly added

      // Check the total size is within the maxSize limit
      expect(cache.byteSize).toBeLessThanOrEqual(40);

      // Clear the cache
      cache.clear();
      expect(cache.byteSize).toBe(0);
    });
  });

  describe('Runtime compatibility', () => {
    test('should not require a global Buffer implementation', () => {
      const originalBuffer = (globalThis as { Buffer?: unknown }).Buffer;

      try {
        delete (globalThis as { Buffer?: unknown }).Buffer;

        const cache = new LRUCache<string, object>(10);
        cache.set('object', { ok: true });

        expect(cache.get('object')).toEqual({ ok: true });
        expect(cache.byteSize).toBeGreaterThan(0);
      } finally {
        if (originalBuffer === undefined) {
          delete (globalThis as { Buffer?: unknown }).Buffer;
        } else {
          (globalThis as { Buffer?: unknown }).Buffer = originalBuffer;
        }
      }
    });

    test('should account for Uint8Array values by byte length', () => {
      const cache = new LRUCache<string, Uint8Array>(10);
      const value = new Uint8Array([1, 2, 3, 4]);

      cache.set('typed-array', value);

      expect(cache.get('typed-array')).toBe(value);
      expect(cache.byteSize).toBe(4);
    });

    test('should handle circular arrays without overflowing the stack', () => {
      const cache = new LRUCache<string, unknown>(10);
      const circularArray: unknown[] = [];

      circularArray.push(circularArray);

      cache.set('circular', circularArray);

      expect(cache.get('circular')).toBe(circularArray);
      expect(cache.byteSize).toBeGreaterThan(0);
    });
  });

  describe('Validation', () => {
    test('should reject invalid maxEntries values', () => {
      expect(() => new LRUCache<string, string>(0)).toThrow(
        'maxEntries must be a positive integer',
      );
      expect(() => new LRUCache<string, string>(1.5)).toThrow(
        'maxEntries must be a positive integer',
      );
    });

    test('should reject invalid TTL and maxSize option values', () => {
      expect(() => new LRUCache<string, string>(1, { defaultTtl: -1 })).toThrow(
        'defaultTtl must be a non-negative finite number',
      );
      expect(() => new LRUCache<string, string>(1, { maxSize: 0 })).toThrow(
        'maxSize must be a positive integer byte count',
      );
      expect(() => new LRUCache<string, string>(1, { maxSize: 1.5 })).toThrow(
        'maxSize must be a positive integer byte count',
      );
    });

    test('should reject non-function sizeCalculator values', () => {
      expect(
        () =>
          new LRUCache<string, string>(1, {
            sizeCalculator: 'not-a-function' as any,
          }),
      ).toThrow('sizeCalculator must be a function');
    });

    test('should reject non-function onChange values', () => {
      expect(
        () =>
          new LRUCache<string, string>(1, {
            onChange: 'not-a-function' as any,
          }),
      ).toThrow('onChange must be a function');
    });

    test('should reject non-array onChangeReasons values', () => {
      expect(
        () =>
          new LRUCache<string, string>(1, {
            onChangeReasons: 'set' as any,
          }),
      ).toThrow('onChangeReasons must be an array');
    });

    test('should reject invalid onChangeReasons entries', () => {
      expect(
        () =>
          new LRUCache<string, string>(1, {
            onChangeReasons: ['set', 'skip', 'bogus' as any],
          }),
      ).toThrow('Invalid onChange reason: bogus');
    });

    test('checks onChangeReasons on the copy it keeps, not through its own iterator', () => {
      let passes = 0;
      const reasons = ['set'] as LRUCacheChangeReason[];
      // Valid on the first pass and another reason after: read twice, the check passes
      // and the cache keeps the other.
      Object.defineProperty(reasons, Symbol.iterator, {
        value: function* () {
          yield passes++ === 0 ? 'set' : 'delete';
        },
      });
      const events: LRUCacheChangeEvent<string, string>[] = [];
      const cache = new LRUCache<string, string>(5, {
        onChange: (event) => {
          events.push(event);
        },
        onChangeReasons: reasons,
      });

      cache.set('a', '1');
      cache.delete('a');

      expect(events.map((event) => event.reason)).toEqual(['set']);
    });

    test('refuses an onChangeReasons length an array cannot have', () => {
      const reasons = new Proxy(['set'], {
        get: (target, key, receiver) =>
          key === 'length' ? Infinity : Reflect.get(target, key, receiver),
      });

      expect(
        () =>
          new LRUCache<string, string>(1, {
            onChangeReasons: reasons as LRUCacheChangeReason[],
          }),
      ).toThrow(new TypeError('onChangeReasons has no array length'));
    });

    test('takes the fallback estimate for an array whose length is not one an array can have', () => {
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });
      const invalid = new Proxy([1], {
        get: (target, key, receiver) =>
          key === 'length' ? 1.5 : Reflect.get(target, key, receiver),
      });

      cache.set('invalid', invalid);
      expect(cache.byteSize).toBe(1000);
    });

    test('sizes a sparse array by its own entries, without walking its length', () => {
      const sparse: unknown[] = [];
      sparse[5] = 'ab';
      sparse[3_000_000_000] = 'cd';
      sparse.length = 2 ** 32 - 1;
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      cache.set('sparse', sparse);

      // 40 for the array and 4 bytes for each of its two strings.
      expect(cache.byteSize).toBe(48);
    });

    test('counts a non-enumerable own entry past enough holes', () => {
      const value: unknown[] = [];
      value.length = 200_000;
      Object.defineProperty(value, 150_000, { value: 'x'.repeat(10) });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      cache.set('a', value);

      expect(cache.byteSize).toBe(40 + 20);
    });

    test('reads a sparse array with an entry every so often by its keys, not its length', () => {
      // An entry every 1,000 indices across the whole length: no run of holes is long,
      // but holes far outnumber entries, counted over the whole walk.
      const length = 2 ** 28;
      const value: unknown[] = [];
      for (let index = 0; index < length; index += 1000) {
        value[index] = 1;
      }
      value.length = length;
      const cache = new LRUCache<string, unknown>(5, { maxSize: 10_000_000 });

      cache.set('a', value);

      expect(cache.byteSize).toBe(40 + Math.ceil(length / 1000) * 8);
    });

    test('does not read a tail index an earlier entry removed', () => {
      let inheritedReads = 0;
      const value: unknown[] = [];
      value.length = 200_000;
      value[150_000] = 'x'.repeat(10);
      Object.defineProperty(value, 100_000, {
        enumerable: true,
        get() {
          Reflect.deleteProperty(value, 150_000);
          Object.setPrototypeOf(
            value,
            Object.defineProperty(Object.create(Array.prototype), 150_000, {
              get: () => {
                inheritedReads++;
                return 'y'.repeat(1000);
              },
            }),
          );
          return 'a';
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      cache.set('a', value);

      // 40 for the array and 2 bytes for the one string still its own.
      expect(cache.byteSize).toBe(42);
      expect(inheritedReads).toBe(0);
    });

    test('counts a dense array past the copy cap in full', () => {
      const dense = new Array<number>(2 ** 24 + 1).fill(1);
      const cache = new LRUCache<string, unknown>(5, { maxSize: 2 ** 30 });

      cache.set('dense', dense);

      expect(cache.byteSize).toBe(40 + (2 ** 24 + 1) * 8);
    });

    test('does not count a hole the prototype fills, nor run its getter', () => {
      let inheritedReads = 0;
      const value = ['keep'];
      value.length = 2;
      Object.setPrototypeOf(
        value,
        Object.defineProperty(Object.create(Array.prototype), 1, {
          get: () => {
            inheritedReads++;
            return 'inherited';
          },
        }),
      );
      const cache = new LRUCache<string, unknown>(5, { maxSize: 1000 });

      cache.set('a', value);

      // 40 for the array and 2 bytes per UTF-16 unit of its own string.
      expect(cache.byteSize).toBe(48);
      expect(inheritedReads).toBe(0);
    });

    test('does not run an inherited getter that answers another holed array', () => {
      let inheritedReads = 0;
      const prototype: object = Object.create(Array.prototype);
      const holed = (): unknown[] => {
        const list: unknown[] = [];
        list.length = 1;
        Object.setPrototypeOf(list, prototype);
        return list;
      };
      Object.defineProperty(prototype, 0, {
        get: () => {
          inheritedReads++;
          return holed();
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 1000 });

      cache.set('a', holed());

      expect(cache.get('a')).toBeDefined();
      expect(cache.byteSize).toBe(40);
      expect(inheritedReads).toBe(0);
    });

    test('charges an entry whose read throws the fallback estimate', () => {
      const value = new Proxy([1, 2], {
        get: (target, key, receiver) => {
          if (key === '0') {
            throw new Error('unreadable entry');
          }
          return Reflect.get(target, key, receiver);
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      cache.set('a', value);

      expect(cache.get('a')).toBe(value);
      // 40 for the array, 1000 for the entry that throws, 8 for the number after it.
      expect(cache.byteSize).toBe(1048);
    });

    test("sizes an Array subclass's and another realm's array by their own entries", () => {
      class List extends Array<unknown> {}
      const subclass = new List();
      subclass.push('ab', 1);
      subclass.length = 3;
      const otherRealm = runInNewContext(
        'const list = ["ab", 1]; list.length = 3; list',
      ) as unknown[];
      const cache = new LRUCache<string, unknown>(5, { maxSize: 1000 });

      cache.set('subclass', subclass);
      // 40 for the array, 4 for its string, 8 for its number; the hole counts for nothing.
      expect(cache.byteSize).toBe(52);

      cache.set('other realm', otherRealm);
      expect(cache.byteSize).toBe(104);
    });

    test('counts an entry whose read throws as held, so the holes after it are walked as deepClone walks them', () => {
      let ownKeysCalls = 0;
      const target: unknown[] = [];
      for (let index = 0; index < 2000; index++) {
        target[index] = index;
      }
      target[72_000] = 1;
      const value = new Proxy(target, {
        get: (array, key, receiver) => {
          if (typeof key === 'string' && Number(key) < 2000) {
            throw new Error('unreadable entry');
          }
          return Reflect.get(array, key, receiver) as unknown;
        },
        ownKeys: (array) => {
          ownKeysCalls++;
          return Reflect.ownKeys(array);
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 10_000_000 });

      cache.set('a', value);

      // 40 for the array, 1000 for each entry that throws, 8 for the number past the holes.
      expect(cache.byteSize).toBe(40 + 2000 * 1000 + 8);
      // 70,000 holes, short of 64 per entry held: walked, not listed.
      expect(ownKeysCalls).toBe(0);
    });

    test('takes the fallback, not a failing set(), for an array whose prototype stops reading once its prototypes are listed', () => {
      let wasListed = false;
      const prototype = new Proxy(Object.create(Array.prototype) as object, {
        ownKeys: (target) => {
          wasListed = true;
          return Reflect.ownKeys(target);
        },
      });
      const value = new Proxy([1, 2, 3], {
        getPrototypeOf: () => {
          if (wasListed) {
            throw new Error('prototype trap');
          }
          return prototype;
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 10_000_000 });

      expect(() => cache.set('a', value)).not.toThrow();
      // 40 for the array, then the fallback once its first index cannot be told.
      expect(cache.byteSize).toBe(40 + 1000);
    });

    test("catches a Proxy prototype that answers for holes only past the first checked indices, reading at most a gap's worth", () => {
      let inheritedReads = 0;
      const value: unknown[] = new (class List extends Array<unknown> {})();
      for (let index = 0; index < 5000; index++) {
        value.push(1);
      }
      value.length = 2 ** 32 - 1;
      Object.setPrototypeOf(
        value,
        new Proxy(Object.getPrototypeOf(value) as object, {
          has: (target, key) =>
            Number(key) >= 5000 ? true : Reflect.has(target, key),
          get: (target, key, receiver) => {
            if (typeof key === 'string' && Number(key) >= 5000) {
              inheritedReads++;
              return 'inherited-value';
            }
            return Reflect.get(target, key, receiver) as unknown;
          },
        }),
      );
      const cache = new LRUCache<string, unknown>(5, { maxSize: 1_000_000 });

      cache.set('a', value);

      // 40 for the array and 8 for each of its own numbers: sized again once caught.
      expect(cache.byteSize).toBe(40 + 5000 * 8);
      expect(inheritedReads).toBeLessThanOrEqual(128);
    });

    test('counts in full again the arrays a pass sized before it was caught and sized again', () => {
      const inner = Array.from({ length: 1000 }, () => 'x'.repeat(10));
      const value: unknown[] = [inner];
      value.length = 2;
      Object.setPrototypeOf(
        value,
        new Proxy(Object.create(Array.prototype) as object, {
          has: () => true,
        }),
      );
      const cache = new LRUCache<string, unknown>(5, { maxSize: 1_000_000 });

      cache.set('a', value);

      // 40 for each array and 20 bytes for each ten-character string, not 8 for an inner
      // array already met.
      expect(cache.byteSize).toBe(40 + 40 + 1000 * 20);
    });

    test("neither reads nor walks the holes a Proxy prototype's has answers for", () => {
      let inheritedReads = 0;
      const prototype = new Proxy(Object.create(Array.prototype) as object, {
        // Unheld at every 4096th index, held at every other.
        has: (_target, key) => Number(key) % 4096 !== 0,
        get: (target, key, receiver) => {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            inheritedReads++;
            return 'inherited-value';
          }
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const sparse: unknown[] = ['abc'];
      sparse.length = 2 ** 32 - 1;
      Object.setPrototypeOf(sparse, prototype);
      const short: unknown[] = ['ab'];
      short.length = 2;
      Object.setPrototypeOf(short, prototype);
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      cache.set('sparse', sparse);
      // 40 for the array and 2 bytes per UTF-16 unit of its one string.
      expect(cache.byteSize).toBe(46);

      cache.set('short', short);
      expect(cache.byteSize).toBe(46 + 44);
      expect(inheritedReads).toBe(0);
    });

    test('reads by Object.hasOwn once an entry swaps in a prototype that answers for holes', () => {
      let inheritedReads = 0;
      const value: unknown[] = [];
      Object.defineProperty(value, 0, {
        enumerable: true,
        get: () => {
          Object.setPrototypeOf(
            value,
            new Proxy(Object.create(Array.prototype) as object, {
              has: () => true,
              get: (target, key, receiver) => {
                if (typeof key === 'string' && /^\d+$/.test(key)) {
                  inheritedReads++;
                }
                return Reflect.get(target, key, receiver) as unknown;
              },
            }),
          );
          return 'abc';
        },
      });
      value.length = 2 ** 32 - 1;
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      cache.set('a', value);

      expect(cache.byteSize).toBe(46);
      expect(inheritedReads).toBe(0);
    });

    test('charges the fallback once and stops when whether an index is held cannot be told', () => {
      let hasCalls = 0;
      const value = new Proxy(['abc'], {
        get: (target, key, receiver) =>
          key === 'length' ? 1_000_000 : Reflect.get(target, key, receiver),
        has: (target, key) => {
          if (key !== '0') {
            hasCalls++;
            throw new Error('unknowable');
          }
          return Reflect.has(target, key);
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      cache.set('a', value);

      expect(cache.get('a')).toBe(value);
      // 40 for the array, 6 for its one string, 1000 for the rest.
      expect(cache.byteSize).toBe(40 + 6 + 1000);
      expect(hasCalls).toBe(1);
    });

    test('charges a throwing entry the fallback and keeps the entries measured before it', () => {
      const huge = 'x'.repeat(50_000);
      const value: unknown[] = [huge];
      Object.defineProperty(value, 1, {
        enumerable: true,
        get() {
          throw new Error('unreadable');
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 1_000_000 });

      cache.set('a', value);

      expect(cache.get('a')).toBe(value);
      // 40 for the array, 2 bytes per UTF-16 unit of the string, 1000 for the entry.
      expect(cache.byteSize).toBe(40 + 100_000 + 1000);
    });

    test('fails set() when sizing an entry it read fails, as sizing the value itself does', () => {
      const unsizable = new Proxy([1], {
        getPrototypeOf: () => {
          throw new Error('proto');
        },
      });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 100_000 });

      expect(() => cache.set('top', unsizable)).toThrow('proto');
      expect(() => cache.set('nested', [unsizable])).toThrow('proto');
      expect(cache.size).toBe(0);
    });

    test("estimates an array value's size by index, not through its own reduce", () => {
      const value = ['abc'];
      Object.defineProperty(value, 'reduce', { value: () => 1_000_000 });
      const cache = new LRUCache<string, unknown>(5, { maxSize: 1000 });

      cache.set('a', value);

      // 40 for the array and 2 bytes per UTF-16 unit of its one string.
      expect(cache.byteSize).toBe(46);
    });

    test('should reject invalid custom TTL values', () => {
      const cache = new LRUCache<string, string>(1);

      expect(() => cache.set('key', 'value', -1)).toThrow(
        'customTtl must be a non-negative finite number',
      );
    });

    test('should reject invalid custom size calculator results', () => {
      const cache = new LRUCache<string, string>(1, {
        sizeCalculator: () => Number.NaN,
      });

      expect(() => cache.set('key', 'value')).toThrow(
        'sizeCalculator must return a non-negative integer byte count',
      );
    });

    test('should reject non-integer custom size calculator results', () => {
      const cache = new LRUCache<string, string>(1, {
        sizeCalculator: () => 1.5,
      });

      expect(() => cache.set('key', 'value')).toThrow(
        'sizeCalculator must return a non-negative integer byte count',
      );
    });
  });
});
