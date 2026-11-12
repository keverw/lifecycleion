import { safeHandleCallback } from '../safe-handle-callback';
import { copyArrayValue, readArrayLength } from '../internal/array-copy';
import {
  holdsOwnIndex,
  indexFreePrototype,
  indicesFrom,
  isMostlyHoles,
} from '../internal/array-indices';

/**
 * The index below which every entry `in` reports held on an Array subclass's or another
 * realm's array is checked with `Object.hasOwn` by the default size estimate (see
 * `calculateSize`); past it, one at random every so often.
 */
const CHECKED_LEAD = 4096;

/** The widest gap between later checks, each drawn at random up to it. */
const CHECK_GAP = 128;

/**
 * How deep the default size estimate follows arrays nested in arrays: one nested deeper
 * takes the fallback estimate, so a value nested 200,000 deep does not overflow the stack.
 */
const MAX_SIZED_ARRAY_DEPTH = 1000;

/** The arrays one default size estimate has met (see `calculateSize`). */
interface ArraySizing {
  /** Arrays being sized now, so one met inside itself is a cycle. */
  readonly visiting: WeakSet<object>;
  /** Arrays already sized, so one met again counts as a reference to it. */
  readonly sized: WeakSet<object>;
  /**
   * {@link sized} in the order they were sized, so an array sized again from the start
   * forgets the arrays its abandoned pass sized - each counted in a total that was thrown
   * away - and counts them in full again.
   */
  readonly sizedOrder: object[];
}

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

type CacheEntry<V> = {
  value: V;
  expires?: number;
  size: number;
};

export type LRUCacheChangeEvent<K, V> =
  | {
      reason: 'evict' | 'expired' | 'delete' | 'clear';
      key: K;
      value: V;
    }
  | {
      reason: 'set';
      key: K;
      newValue: V;
      oldValue?: V;
    }
  | {
      reason: 'skip';
      key: K;
      newValue: V;
      currentValue?: V;
      cause: 'maxSize';
    };

// Extract the reason string union from the event type so it stays in sync.
export type LRUCacheChangeReason = LRUCacheChangeEvent<
  unknown,
  unknown
>['reason'];

const VALID_CHANGE_REASONS: ReadonlySet<LRUCacheChangeReason> = new Set([
  'evict',
  'expired',
  'delete',
  'clear',
  'set',
  'skip',
]);

export class LRUCache<K, V> {
  private maxEntries: number;
  private maxSize?: number; // Optional maximum size in bytes
  private defaultTtl?: number; // Optional default TTL in milliseconds
  private lastCleanup = Date.now();
  private cleanupInterval = 60 * 1000; // Run cleanup once per minute at most
  private currentSize = 0; // Track current total size in bytes
  private expirableEntryCount = 0; // Track how many entries currently have expirations
  private sizeCalculator?: (value: V) => number; // Optional function to calculate item size
  private onChange?: (event: LRUCacheChangeEvent<K, V>) => void | Promise<void>;
  private onChangeReasons?: ReadonlySet<LRUCacheChangeReason>;

  // Store values with their expiration time and size
  private map = new Map<K, CacheEntry<V>>();

  /**
   * Create a new LRU cache
   * @param maxEntries Maximum number of entries to store
   * @param options Configuration options
   * @param options.defaultTtl Default time to live in milliseconds for all entries
   * @param options.maxSize Maximum total size in bytes
   * @param options.sizeCalculator Function to calculate the size of a value
   * @param options.onChange Callback invoked for cache changes
   * @param options.onChangeReasons Optional list of change reasons that should trigger onChange
   */

  constructor(
    maxEntries: number,
    options?: {
      defaultTtl?: number;
      maxSize?: number;
      sizeCalculator?: (value: V) => number;
      onChange?: (event: LRUCacheChangeEvent<K, V>) => void | Promise<void>;
      onChangeReasons?: LRUCacheChangeReason[];
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

    if (
      options?.onChange !== undefined &&
      typeof options.onChange !== 'function'
    ) {
      throw new TypeError('onChange must be a function');
    }

    // Read once and copied by index (see `copyArrayValue`), so the reasons checked are
    // the reasons kept: not through the list's own iterator, which could yield others on
    // each pass. A hole reads as `undefined`, refused as any other reason it is not.
    const givenReasons: unknown = options?.onChangeReasons;
    let onChangeReasons: LRUCacheChangeReason[] | undefined;

    if (givenReasons !== undefined) {
      if (!Array.isArray(givenReasons)) {
        throw new TypeError('onChangeReasons must be an array');
      }

      const reasons = copyArrayValue(
        givenReasons as unknown[],
        'onChangeReasons',
      );

      // eslint-disable-next-line unicorn/no-for-loop -- every index, holes included
      for (let index = 0; index < reasons.length; index++) {
        const reason = reasons[index];

        if (!VALID_CHANGE_REASONS.has(reason as LRUCacheChangeReason)) {
          throw new RangeError(`Invalid onChange reason: ${String(reason)}`);
        }
      }

      onChangeReasons = reasons as LRUCacheChangeReason[];
    }

    this.maxEntries = maxEntries;
    this.defaultTtl = options?.defaultTtl;
    this.maxSize = options?.maxSize;
    this.sizeCalculator = options?.sizeCalculator;
    this.onChange = options?.onChange;
    this.onChangeReasons = onChangeReasons
      ? new Set(onChangeReasons)
      : undefined;
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
        const changeEvents = this.createLocalChangeQueue();
        this.removeEntry(key, 'expired', changeEvents);
        this.flushLocalChangeQueue(changeEvents);
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
        const changeEvents = this.createLocalChangeQueue();
        this.removeEntry(key, 'expired', changeEvents);
        this.flushLocalChangeQueue(changeEvents);
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

    // Calculate size first so failed sizeCalculator calls do not mutate cache state.
    const size = this.calculateSize(value);
    const changeEvents = this.createLocalChangeQueue();

    // Reclaim expired entries before deciding whether this write is a fresh insert,
    // an overwrite, or a skipped oversized write.
    this.cleanupExpiredInternal(changeEvents);
    const existingEntry = this.map.get(key);

    // Oversized writes are skipped before mutating live entries so they remain a true no-op.
    if (this.maxSize !== undefined && size > this.maxSize) {
      changeEvents.push(
        existingEntry
          ? {
              reason: 'skip',
              key,
              currentValue: existingEntry.value,
              newValue: value,
              cause: 'maxSize',
            }
          : {
              reason: 'skip',
              key,
              newValue: value,
              cause: 'maxSize',
            },
      );

      this.flushLocalChangeQueue(changeEvents);
      return;
    }

    // Remove the old entry silently so an overwrite emits one `set` event,
    // not a separate removal event followed by `set`.
    if (existingEntry) {
      this.removeEntry(key);
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

    // Record the write after state is updated so observers see the final value.
    changeEvents?.push(
      existingEntry
        ? {
            reason: 'set',
            key,
            oldValue: existingEntry.value,
            newValue: value,
          }
        : {
            reason: 'set',
            key,
            newValue: value,
          },
    );

    // Evict entries if we exceed capacity (either by count or size)
    this.evictIfNeeded(changeEvents);

    // Flush this operation's queued events after all related state changes finish.
    this.flushLocalChangeQueue(changeEvents);
  }

  /**
   * Clear all entries from the cache
   */

  public clear(): void {
    const changeEvents = this.createLocalChangeQueue();
    const shouldEmitClear =
      this.onChange !== undefined &&
      (this.onChangeReasons === undefined || this.onChangeReasons.has('clear'));

    // Capture per-entry clear events before clearing the internal map.
    if (shouldEmitClear) {
      for (const [key, entry] of this.map.entries()) {
        changeEvents.push({
          reason: 'clear',
          key,
          value: entry.value,
        });
      }
    }

    this.map.clear();
    this.currentSize = 0;
    this.expirableEntryCount = 0;
    this.lastCleanup = Date.now();

    // Flush this operation's queued events after the cache has been reset.
    this.flushLocalChangeQueue(changeEvents);
  }

  /**
   * Delete a specific entry from the cache
   * @param key The key to delete
   * @returns True if the entry was deleted, false if it didn't exist
   */

  public delete(key: K): boolean {
    const changeEvents = this.createLocalChangeQueue();
    const wasDeleted = this.removeEntry(key, 'delete', changeEvents);

    // Flush this operation's queued events after the delete has been applied.
    this.flushLocalChangeQueue(changeEvents);
    return wasDeleted;
  }

  /**
   * Remove all expired entries from the cache
   * @returns The number of entries removed
   */

  public cleanupExpired(): number {
    const changeEvents = this.createLocalChangeQueue();
    const removed = this.cleanupExpiredInternal(changeEvents);

    // Flush this operation's queued events after expired entries have been removed.
    this.flushLocalChangeQueue(changeEvents);
    return removed;
  }

  private cleanupExpiredInternal(
    changeEvents: LRUCacheChangeEvent<K, V>[],
  ): number {
    let removed = 0;
    const now = Date.now();

    for (const [key, entry] of this.map.entries()) {
      if (entry.expires && now > entry.expires) {
        this.removeEntry(key, 'expired', changeEvents);
        removed++;
      }
    }

    this.lastCleanup = now;

    return removed;
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
    sizing: ArraySizing = {
      visiting: new WeakSet(),
      sized: new WeakSet(),
      sizedOrder: [],
    },
    depth = 0,
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
    const primitive = primitiveSize(value);
    if (primitive !== undefined) {
      return primitive;
    } else if (this.isBufferValue(value)) {
      return value.length; // Buffer size in bytes
    } else if (ArrayBuffer.isView(value)) {
      return value.byteLength; // TypedArray size
    } else if (value instanceof ArrayBuffer) {
      return value.byteLength; // ArrayBuffer size
    } else if (Array.isArray(value)) {
      if (sizing.visiting.has(value)) {
        return 1000; // Fallback size for circular arrays
      }

      // Met again - shared between two entries, say - it is one array, already counted:
      // walked again, `[a, a]` nested 22 deep would take half a second and count 2^22
      // copies.
      if (sizing.sized.has(value)) {
        return 8;
      }

      if (depth >= MAX_SIZED_ARRAY_DEPTH) {
        return 1000;
      }

      sizing.visiting.add(value);

      // Rough estimate for arrays: their own entries, by index, not through the array's
      // own `reduce`, which a cached value may replace - a hole, one its prototype fills
      // included, counts for nothing, and past enough of them the rest are read by the
      // array's own index keys, so a sparse array's length is not walked. What cannot be
      // read takes the fallback estimate a circular array does, rather than failing
      // `set()`: an array whose length is not one an array can have, an entry whose read
      // throws - with the entries around it still counted - and, once for the rest of the
      // array, an index whose presence cannot be told. A failure sizing an entry it did
      // read is not caught here.
      const items = value as unknown[];

      try {
        let length: number;

        try {
          length = readArrayLength(items, 'LRUCache value');
        } catch {
          return 1000;
        }

        let estimatedSize = 40;
        let holes = 0;
        let entries = 0;
        let sparseFrom: number | undefined;
        // As `deepClone`'s walk tells an index held - `in` on this realm's
        // `Array.prototype`, `Object.hasOwn` otherwise, which costs hundreds of times as
        // much per index on a large array on JavaScriptCore - save on an Array subclass's
        // or another realm's array whose prototypes list no index: that one is read by
        // `in` too, while its prototype is the one it had when sizing began. A `Proxy`
        // prototype can answer `in` for a hole whatever keys it lists, so what `in` reports
        // held is checked with `Object.hasOwn` - every one below `CHECKED_LEAD`, then one
        // at random every so often, which the prototype is never asked about and cannot
        // foresee - and one caught answering for a hole is sized again from the start by
        // `Object.hasOwn`, so its holes count for nothing and a sparse one's length is not
        // walked. An array whose prototypes answer `in` truly is sized the same every time;
        // only one that answers for a hole can be caught at a different index from one
        // `set()` to the next, its getters run up to a gap's worth of times before it is.
        let checkedPrototype = indexFreePrototype(items);
        let untilCheck = 1;
        const sizedBefore = sizing.sizedOrder.length;

        for (let index = 0; index < length; index++) {
          let isOwn: boolean;

          try {
            if (
              checkedPrototype !== undefined &&
              checkedPrototype !== Array.prototype &&
              Reflect.getPrototypeOf(items) === checkedPrototype
            ) {
              isOwn = index in items;

              if (isOwn && (index < CHECKED_LEAD || --untilCheck === 0)) {
                untilCheck = 1 + Math.floor(Math.random() * CHECK_GAP);

                if (!Object.hasOwn(items, index)) {
                  for (const nested of sizing.sizedOrder.splice(sizedBefore)) {
                    sizing.sized.delete(nested);
                  }

                  checkedPrototype = undefined;
                  estimatedSize = 40;
                  holes = 0;
                  entries = 0;
                  index = -1;
                  continue;
                }
              }
            } else {
              isOwn = holdsOwnIndex(items, index);
            }
          } catch {
            return estimatedSize + 1000;
          }

          if (!isOwn) {
            // Enough holes, as `deepClone` counts them: the rest by the array's own index
            // keys.
            if (isMostlyHoles(++holes, entries)) {
              sparseFrom = index + 1;
              break;
            }
            continue;
          }

          // Counted as held whether or not its read throws, as `deepClone` counts one.
          entries++;
          let entry: unknown;

          try {
            entry = items[index];
          } catch {
            estimatedSize += 1000;
            continue;
          }

          estimatedSize +=
            primitiveSize(entry) ??
            this.calculateSize(entry, sizing, depth + 1);
        }

        if (sparseFrom === undefined) {
          return estimatedSize;
        }

        // Keys that cannot be listed take the fallback for the rest.
        let tail: number[];

        try {
          tail = indicesFrom(items, sparseFrom, length);
        } catch {
          return estimatedSize + 1000;
        }

        for (const index of tail) {
          let isOwn: boolean;

          // Checked again, as `deepClone` checks its tail: an entry read before it can
          // have removed it.
          try {
            isOwn = Object.hasOwn(items, index);
          } catch {
            return estimatedSize + 1000;
          }

          if (!isOwn) {
            continue;
          }

          let entry: unknown;

          try {
            entry = items[index];
          } catch {
            estimatedSize += 1000;
            continue;
          }

          estimatedSize +=
            primitiveSize(entry) ??
            this.calculateSize(entry, sizing, depth + 1);
        }

        return estimatedSize;
      } finally {
        sizing.visiting.delete(value);
        sizing.sized.add(value);
        sizing.sizedOrder.push(value);
      }
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

  private evictIfNeeded(changeEvents: LRUCacheChangeEvent<K, V>[]): void {
    // First check if we need to evict based on entry count
    if (this.map.size > this.maxEntries) {
      this.evictOldest(changeEvents);
    }

    // Then check if we need to evict based on total size
    if (this.maxSize !== undefined && this.currentSize > this.maxSize) {
      // Keep evicting until we're under the size limit or the cache is empty
      while (this.currentSize > this.maxSize && this.map.size > 0) {
        this.evictOldest(changeEvents);
      }
    }
  }

  /**
   * Evict the oldest (least recently used) entry
   */

  private evictOldest(changeEvents: LRUCacheChangeEvent<K, V>[]): void {
    if (this.map.size > 0) {
      const oldest = this.map.keys().next().value as K; // Safe: map.size > 0 guarantees a key exists
      this.removeEntry(oldest, 'evict', changeEvents);
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

  // Collect changes locally so each cache operation flushes its own events in order.
  private createLocalChangeQueue(): LRUCacheChangeEvent<K, V>[] {
    return [];
  }

  private flushLocalChangeQueue(
    changeEvents: LRUCacheChangeEvent<K, V>[],
  ): void {
    if (!this.onChange || changeEvents.length === 0) {
      return;
    }

    for (const changeEvent of changeEvents) {
      if (
        this.onChangeReasons !== undefined &&
        !this.onChangeReasons.has(changeEvent.reason)
      ) {
        continue;
      }

      safeHandleCallback('LRUCache onChange', this.onChange, changeEvent);
    }
  }

  private removeEntry(
    key: K,
    reason?: 'evict' | 'expired' | 'delete',
    changeEvents?: LRUCacheChangeEvent<K, V>[],
  ): boolean {
    const entry = this.map.get(key);

    if (!entry) {
      return false;
    }

    this.currentSize -= entry.size;

    if (entry.expires !== undefined) {
      this.expirableEntryCount--;
    }

    this.map.delete(key);

    // Internal callers can omit `reason` to perform a state-only removal without
    // notifying observers, which is how overwrite handling avoids duplicate events.
    if (reason && changeEvents) {
      changeEvents.push({
        reason,
        key,
        value: entry.value,
      });
    }

    return true;
  }

  private assertNonNegativeFiniteNumber(value: number, message: string): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(message);
    }
  }
}

/**
 * The default estimate of a primitive's size, or `undefined` for an object, a function, a
 * `bigint` or a symbol: the first step of `calculateSize`'s estimate, and read inline for
 * an array's entries, which are most often primitives, so a large array is not a method
 * call per entry.
 */
function primitiveSize(value: unknown): number | undefined {
  switch (typeof value) {
    case 'number':
      return 8; // A double
    case 'string':
      return value.length * 2; // UTF-16
    case 'boolean':
      return 4;
    case 'undefined':
      return 0;
    default:
      return value === null ? 0 : undefined;
  }
}
