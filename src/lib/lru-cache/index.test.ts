import { test, expect, describe, beforeEach, mock } from 'bun:test';
import { LRUCache } from '.';

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
