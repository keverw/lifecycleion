/**
 * TTL-aware LRU (Least Recently Used) Cache implementation
 *
 * Features:
 * - Configurable maximum entries to limit item count
 * - Optional maximum size in bytes to limit memory usage
 * - Optional TTL (Time To Live) for cache entries
 * - Lazy cleanup of expired entries during cache operations
 * - Efficient LRU eviction policy
 * - Size-aware eviction when memory limits are reached
 */

export class LRUCache<K, V> {
  private maxEntries: number;
  private maxSize?: number; // Optional maximum size in bytes
  private defaultTtl?: number; // Optional default TTL in milliseconds
  private lastCleanup = Date.now();
  private cleanupInterval = 60 * 1000; // Run cleanup once per minute at most
  private currentSize = 0; // Track current total size in bytes
  private expirableEntryCount = 0; // Track how many entries currently have expirations
  private sizeCalculator?: (value: V) => number; // Optional function to calculate item size

  // Store values with their expiration time and size
  private map = new Map<K, { value: V; expires?: number; size: number }>();

  /**
   * Create a new LRU cache
   * @param maxEntries Maximum number of entries to store
   * @param options Configuration options
   * @param options.defaultTtl Default time to live in milliseconds for all entries
   * @param options.maxSize Maximum total size in bytes
   * @param options.sizeCalculator Function to calculate the size of a value
   */

  constructor(
    maxEntries: number,
    options?: {
      defaultTtl?: number;
      maxSize?: number;
      sizeCalculator?: (value: V) => number;
    },
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new RangeError('maxEntries must be a positive integer');
    }

    if (options?.defaultTtl !== undefined) {
      this.assertNonNegativeFiniteNumber(
        options.defaultTtl,
        'defaultTtl must be a non-negative finite number',
      );
    }

    if (options?.maxSize !== undefined) {
      if (!Number.isInteger(options.maxSize) || options.maxSize <= 0) {
        throw new RangeError('maxSize must be a positive integer byte count');
      }
    }

    if (
      options?.sizeCalculator !== undefined &&
      typeof options.sizeCalculator !== 'function'
    ) {
      throw new TypeError('sizeCalculator must be a function');
    }

    this.maxEntries = maxEntries;
    this.defaultTtl = options?.defaultTtl;
    this.maxSize = options?.maxSize;
    this.sizeCalculator = options?.sizeCalculator;
  }

  /**
   * Get the current number of entries in the cache
   */

  public get size(): number {
    return this.map.size;
  }

  /**
   * Get the current total size in bytes of all cached items
   */

  public get byteSize(): number {
    return this.currentSize;
  }

  /**
   * Check if a key exists in the cache (without affecting LRU order)
   * @param key The key to check
   * @returns True if the key exists and hasn't expired
   */
  public has(key: K): boolean {
    const entry = this.map.get(key);

    if (entry) {
      // Check if entry has expired
      if (entry.expires && Date.now() > entry.expires) {
        this.delete(key);
        return false;
      }

      return true;
    }

    return false;
  }

  public get(key: K): V | undefined {
    const entry = this.map.get(key);

    if (entry) {
      // Check if entry has expired
      if (entry.expires && Date.now() > entry.expires) {
        this.delete(key);
        return undefined;
      }

      // Move to end of LRU (most recently used)
      this.map.delete(key);
      this.map.set(key, entry);

      // Run periodic cleanup if needed
      this.maybeCleanup();

      return entry.value;
    }

    return undefined;
  }

  public set(key: K, value: V, customTtl?: number): void {
    if (customTtl !== undefined) {
      this.assertNonNegativeFiniteNumber(
        customTtl,
        'customTtl must be a non-negative finite number',
      );
    }

    // Calculate the size of the new value
    const size = this.calculateSize(value);

    // Remove existing entry if present
    if (this.map.has(key)) {
      this.delete(key);
    }

    // Calculate expiration if TTL is set
    const ttl = customTtl ?? this.defaultTtl;
    const expires = ttl && ttl > 0 ? Date.now() + ttl : undefined;

    // Add new entry
    this.map.set(key, { value, expires, size });
    this.currentSize += size;

    if (expires !== undefined) {
      this.expirableEntryCount++;
    }

    // Reclaim expired entries before evicting live entries for capacity.
    this.cleanupExpired();

    // Evict entries if we exceed capacity (either by count or size)
    this.evictIfNeeded();
  }

  /**
   * Clear all entries from the cache
   */

  public clear(): void {
    this.map.clear();
    this.currentSize = 0;
    this.expirableEntryCount = 0;
    this.lastCleanup = Date.now();
  }

  /**
   * Remove all expired entries from the cache
   * @returns The number of entries removed
   */

  public cleanupExpired(): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, entry] of this.map.entries()) {
      if (entry.expires && now > entry.expires) {
        this.delete(key);
        removed++;
      }
    }

    this.lastCleanup = now;

    return removed;
  }

  /**
   * Delete a specific entry from the cache
   * @param key The key to delete
   * @returns True if the entry was deleted, false if it didn't exist
   */

  public delete(key: K): boolean {
    const entry = this.map.get(key);

    if (entry) {
      this.currentSize -= entry.size;

      if (entry.expires !== undefined) {
        this.expirableEntryCount--;
      }

      this.map.delete(key);

      return true;
    }

    return false;
  }

  private isBufferValue(value: unknown): value is { length: number } {
    const globalBuffer = (
      globalThis as {
        Buffer?: unknown;
      }
    ).Buffer;

    if (globalBuffer === undefined) {
      return false;
    }

    const bufferConstructor = globalBuffer as {
      isBuffer?: (value: unknown) => boolean;
    };

    return (
      typeof globalBuffer === 'function' &&
      typeof bufferConstructor.isBuffer === 'function' &&
      bufferConstructor.isBuffer(value)
    );
  }

  /**
   * Calculate the size of a value in bytes
   * Uses the provided sizeCalculator if available, otherwise makes a best guess
   */

  private calculateSize(
    value: unknown,
    visitedArrays = new WeakSet<object>(),
  ): number {
    // Use custom size calculator if provided (cast to V for the callback)
    if (this.sizeCalculator) {
      const size = this.sizeCalculator(value as V);

      if (!Number.isInteger(size) || size < 0) {
        throw new RangeError(
          'sizeCalculator must return a non-negative integer byte count',
        );
      }

      return size;
    }

    // Default size estimation logic
    if (value === null || value === undefined) {
      return 0;
    } else if (typeof value === 'boolean') {
      return 4; // Boolean is typically 4 bytes
    } else if (typeof value === 'number') {
      return 8; // Number is typically 8 bytes (double)
    } else if (typeof value === 'string') {
      return value.length * 2; // String is ~2 bytes per character in UTF-16
    } else if (this.isBufferValue(value)) {
      return value.length; // Buffer size in bytes
    } else if (ArrayBuffer.isView(value)) {
      return value.byteLength; // TypedArray size
    } else if (value instanceof ArrayBuffer) {
      return value.byteLength; // ArrayBuffer size
    } else if (Array.isArray(value)) {
      if (visitedArrays.has(value)) {
        return 1000; // Fallback size for circular arrays
      }

      visitedArrays.add(value);

      // Rough estimate for arrays
      const estimatedSize =
        40 +
        value.reduce(
          (acc: number, item: unknown) =>
            acc + this.calculateSize(item, visitedArrays),
          0,
        );

      visitedArrays.delete(value);

      return estimatedSize;
    } else if (typeof value === 'object') {
      try {
        // Rough estimate based on JSON size
        const jsonSize = JSON.stringify(value).length * 2;
        return Math.max(jsonSize, 40); // At least 40 bytes for object overhead
      } catch {
        // Ignore JSON serialization errors for non-serializable objects
        return 1000; // Fallback size for non-serializable objects
      }
    }

    return 100; // Default fallback size
  }

  /**
   * Evict entries if we exceed either max entries or max size
   */

  private evictIfNeeded(): void {
    // First check if we need to evict based on entry count
    if (this.map.size > this.maxEntries) {
      this.evictOldest();
    }

    // Then check if we need to evict based on total size
    if (this.maxSize !== undefined && this.currentSize > this.maxSize) {
      // Keep evicting until we're under the size limit or the cache is empty
      while (this.currentSize > this.maxSize && this.map.size > 0) {
        this.evictOldest();
      }
    }
  }

  /**
   * Evict the oldest (least recently used) entry
   */

  private evictOldest(): void {
    if (this.map.size > 0) {
      const oldest = this.map.keys().next().value as K; // Safe: map.size > 0 guarantees a key exists
      this.delete(oldest);
    }
  }

  private maybeCleanup(): void {
    const now = Date.now();

    // Only run cleanup occasionally to avoid performance impact
    if (
      now - this.lastCleanup > this.cleanupInterval &&
      this.expirableEntryCount > 0
    ) {
      this.cleanupExpired();
    }
  }

  private assertNonNegativeFiniteNumber(value: number, message: string): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(message);
    }
  }
}
