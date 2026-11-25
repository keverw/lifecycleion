import { safeHandleCallback } from '../safe-handle-callback';
import {
  hasBufferTagInChainFrom,
  readBinaryByteLength,
} from '../internal/binary-view';
import { copyArrayValue, readArrayLength } from '../internal/array-copy';
import {
  holdsOwnIndex,
  indicesFrom,
  isMostlyHoles,
  walksOnByIndex,
  WALKED_HOLES_PER_ENTRY,
} from '../internal/array-indices';
import type { FillCheckpoint } from '../internal/array-indices';

/**
 * How deep the default size estimate follows arrays nested in arrays: one nested deeper
 * takes the fallback estimate, so a value nested 200,000 deep does not overflow the stack.
 */
const MAX_SIZED_ARRAY_DEPTH = 1000;

/**
 * The default size estimate of what cannot be sized: a circular or too deeply nested
 * array, one whose length or an entry cannot be read, and an object `JSON.stringify`
 * throws on.
 */
const UNSIZED_VALUE_BYTES = 1000;

/**
 * What the default size estimate returns once it stops walking a value already past its
 * byte budget (see `calculateSize`). No finished estimate is ever `Infinity`, and no
 * `sizeCalculator` result can be one, so it tells a cut-short walk apart.
 */
const STOPPED_EARLY = Infinity;

/** The arrays one default size estimate has met (see `calculateSize`). */
interface ArraySizing {
  /** Arrays being sized now, so one met inside itself is a cycle. */
  readonly visiting: WeakSet<object>;
  /**
   * Arrays already sized, so one met again counts as a reference to it. Held for one
   * estimate only.
   */
  readonly sized: Set<object>;
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
  /**
   * Its place in the LRU order: higher is more recently used. The map's order says the
   * same, and both are set together, by `placeAsMostRecent` alone.
   */
  order: number;
  /** Its node in the expiry heap, for an entry that can expire. */
  expiryNode?: ExpiryNode<unknown, unknown>;
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
      /**
       * Present when the built-in estimator stopped walking the value once its estimate
       * passed `maxSize`, so there is no final size estimate for it.
       */
      sizeEstimateStoppedEarly?: true;
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

/**
 * An expirable entry in `LRUCache`'s expiry heap. Its `key` and `entry` are dropped once
 * the entry is removed, so a node left in the heap holds neither, nor the value.
 */
type ExpiryNode<K, V> = {
  key: K | undefined;
  entry: CacheEntry<V> | undefined;
  expires: number;
};

/** Adds `node` to the min-heap `heap`, ordered by `expires`. */
function pushExpiry<K, V>(
  heap: ExpiryNode<K, V>[],
  node: ExpiryNode<K, V>,
): void {
  let index = heap.push(node) - 1;

  while (index > 0) {
    const parent = (index - 1) >> 1;

    if (heap[parent].expires <= node.expires) {
      break;
    }

    heap[index] = heap[parent];
    index = parent;
  }

  heap[index] = node;
}

/** Takes the soonest-expiring node off the non-empty min-heap `heap`. */
function popExpiry<K, V>(heap: ExpiryNode<K, V>[]): ExpiryNode<K, V> {
  const top = heap[0];
  const last = heap.pop() as ExpiryNode<K, V>;

  if (heap.length > 0) {
    siftDownExpiry(heap, 0, last);
  }

  return top;
}

/**
 * Puts `node` at `start` of `heap`, or below it: moved down past each child that expires
 * sooner, where the subtrees below `start` are min-heaps already.
 */
function siftDownExpiry<K, V>(
  heap: ExpiryNode<K, V>[],
  start: number,
  node: ExpiryNode<K, V>,
): void {
  let index = start;

  for (;;) {
    const left = index * 2 + 1;

    if (left >= heap.length) {
      break;
    }

    const right = left + 1;
    const child =
      right < heap.length && heap[right].expires < heap[left].expires
        ? right
        : left;

    if (heap[child].expires >= node.expires) {
      break;
    }

    heap[index] = heap[child];
    index = child;
  }

  heap[index] = node;
}

export class LRUCache<K, V> {
  private maxEntries: number;
  private maxSize?: number; // Optional maximum size in bytes
  private defaultTtl?: number; // Optional default TTL in milliseconds
  private lastCleanup = Date.now();
  private cleanupInterval = 60 * 1000; // Run cleanup once per minute at most
  private currentSize = 0; // Track current total size in bytes
  private expirableEntryCount = 0; // Track how many entries currently have expirations
  // Every expirable entry by its expiry, soonest first, so a write reclaims the expired
  // ones without scanning the live ones. A node whose entry has since been removed or
  // replaced is stale: dropped when it reaches the top, or when the heap is rebuilt.
  private readonly expiryHeap: ExpiryNode<K, V>[] = [];
  // The next entry's `order`, given on every write and every use.
  private nextOrder = 0;
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
      // One clock read for the expiry check and the cleanup below, so an entry returned
      // is not also removed as expired by that cleanup.
      const now = Date.now();

      // Check if entry has expired
      if (entry.expires && now > entry.expires) {
        const changeEvents = this.createLocalChangeQueue();
        this.removeEntry(key, 'expired', changeEvents);
        this.flushLocalChangeQueue(changeEvents);
        return undefined;
      }

      this.map.delete(key);
      this.placeAsMostRecent(key, entry);

      // Run periodic cleanup if needed
      this.maybeCleanup(now);

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

    // Calculate size first so failed sizeCalculator calls do not mutate cache state. The
    // built-in estimate stops once it passes `maxSize`, as the write is then skipped.
    const size = this.calculateSize(value, this.maxSize ?? Infinity);
    const changeEvents = this.createLocalChangeQueue();

    // Reclaim expired entries before deciding whether this write is a fresh insert,
    // an overwrite, or a skipped oversized write: taken off the top of `expiryHeap`, so
    // the cost follows the entries that expired, not the entries held.
    this.reclaimExpired(changeEvents);
    const existingEntry = this.map.get(key);

    // Oversized writes are skipped before mutating live entries so they remain a true no-op.
    if (this.maxSize !== undefined && size > this.maxSize) {
      const skip: LRUCacheChangeEvent<K, V> = existingEntry
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
          };

      if (size === STOPPED_EARLY) {
        skip.sizeEstimateStoppedEarly = true;
      }

      changeEvents.push(skip);

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
    const entry: CacheEntry<V> = {
      value,
      expires,
      size,
      // Given below, with its place in the map.
      order: 0,
    };
    this.placeAsMostRecent(key, entry);
    this.currentSize += size;

    if (expires !== undefined) {
      this.expirableEntryCount++;
      this.trackExpiry(key, entry, expires);
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
    this.expiryHeap.length = 0;
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
    const removed = this.reclaimExpired(changeEvents);

    // Flush this operation's queued events after expired entries have been removed.
    this.flushLocalChangeQueue(changeEvents);
    return removed;
  }

  /**
   * Removes every entry `expiryHeap` shows expired, least recently used first: found by
   * expiry, then ordered by use. What every cleanup runs - a write's, the periodic one a
   * read starts, `cleanupExpired()` - so none scans the live entries. Returns how many it
   * removed. `now` is the time an entry must be past to have expired.
   */
  private reclaimExpired(
    changeEvents: LRUCacheChangeEvent<K, V>[],
    now: number = Date.now(),
  ): number {
    const heap = this.expiryHeap;
    this.lastCleanup = now;

    if (heap.length === 0) {
      return 0;
    }

    const expired: ExpiryNode<K, V>[] = [];

    while (heap.length > 0 && now > heap[0].expires) {
      const node = popExpiry(heap);

      // Stale: the entry was removed or replaced since.
      if (node.entry !== undefined) {
        expired.push(node);
      }
    }

    expired.sort(
      (a, b) =>
        (a.entry as CacheEntry<V>).order - (b.entry as CacheEntry<V>).order,
    );

    for (const { key } of expired) {
      this.removeEntry(key as K, 'expired', changeEvents);
    }

    return expired.length;
  }

  /** Adds `entry` to `expiryHeap`. */
  private trackExpiry(key: K, entry: CacheEntry<V>, expires: number): void {
    this.compactExpiryHeap();
    const node: ExpiryNode<K, V> = { key, entry, expires };
    entry.expiryNode = node;
    pushExpiry(this.expiryHeap, node);
  }

  /**
   * Rebuilds `expiryHeap` from its live nodes once stale ones make up most of it - an
   * entry overwritten again and again before it expires, or many removed - so it holds no
   * more than about twice the expirable entries. Run as a node is added or let go of, so
   * the rebuild's cost is spread over at least as many of them as it drops. The live nodes
   * are moved to the front, in place, and made a min-heap again from the bottom up.
   */
  private compactExpiryHeap(): void {
    const heap = this.expiryHeap;

    if (heap.length >= 2 * this.expirableEntryCount + 32) {
      let live = 0;

      for (const node of heap) {
        if (node.entry !== undefined) {
          heap[live++] = node;
        }
      }

      heap.length = live;

      for (let index = (live >> 1) - 1; index >= 0; index--) {
        siftDownExpiry(heap, index, heap[index]);
      }
    }
  }

  /**
   * Calculate the size of a value in bytes
   * Uses the provided sizeCalculator if available, otherwise makes a best guess
   *
   * The best guess walks an array an entry at a time, and stops once its estimate passes
   * `budget`, with indices still to walk (holes included), returning {@link STOPPED_EARLY}: a nested array
   * is given what is left of its parent's budget, so it stops too. An estimate that ends
   * at or under `budget` is always walked in full. What is sized in one step - a string,
   * a buffer, an object by `JSON.stringify` - is sized in full whatever the budget.
   */

  private calculateSize(
    value: unknown,
    budget: number,
    sizing?: ArraySizing,
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
    }

    let isArray: boolean;
    try {
      isArray = Array.isArray(value);
    } catch {
      // A revoked `Proxy`, which nothing can be read from: the fallback for what it was
      // made over - an object, or a function.
      return typeof value === 'object' ? UNSIZED_VALUE_BYTES : 100;
    }

    // A buffer or view - shared, from another realm, or one whose own `byteLength` lies -
    // measured through its internal slots. Told first by its internal slot (a view) or,
    // for what is not an array, the tag its prototypes carry (a buffer), so any other
    // object is not put through the getters, each of which throws for it. A plain object
    // is told apart by its prototype alone, without the walk. So a buffer whose prototype
    // was replaced with one carrying no buffer's tag is estimated as an object: trying the
    // getters on every object would cost several times the rest of its estimate.
    const byteLength =
      typeof value === 'object' &&
      value !== null &&
      (ArrayBuffer.isView(value) || (!isArray && mayBeBuffer(value)))
        ? readBinaryByteLength(value)
        : null;

    if (byteLength !== null) {
      return byteLength;
    } else if (isArray) {
      const items = value as unknown[];
      // Made for the outermost array only: a value with none needs none.
      sizing ??= {
        visiting: new WeakSet(),
        sized: new Set(),
      };

      if (sizing.visiting.has(items)) {
        return UNSIZED_VALUE_BYTES; // Circular
      }

      // Met again - shared between two entries, say - it is one array, already counted:
      // walked again, `[a, a]` nested 22 deep would take half a second and count 2^22
      // copies.
      if (sizing.sized.has(items)) {
        return 8;
      }

      if (depth >= MAX_SIZED_ARRAY_DEPTH) {
        return UNSIZED_VALUE_BYTES;
      }

      sizing.visiting.add(items);

      // Rough estimate for arrays: their own entries, by index, not through the array's
      // own `reduce`, which a cached value may replace - a hole, one its prototype fills
      // included, counts for nothing, and past enough of them the rest are read by the
      // array's own index keys, so a sparse array's length is not walked. What cannot be
      // read takes the fallback estimate a circular array does, rather than failing
      // `set()`: an array whose length is not one an array can have, an entry whose read
      // throws - with the entries around it still counted - and, once for the rest of the
      // array, an index whose presence cannot be told. An entry that cannot be sized - a
      // revoked `Proxy` - takes it too, as the value itself does.
      try {
        let length: number;

        try {
          length = readArrayLength(items, 'LRUCache value');
        } catch {
          return UNSIZED_VALUE_BYTES;
        }

        let estimatedSize = 40;
        let holes = 0;
        let entries = 0;
        let checkpoint: FillCheckpoint | undefined;
        let sparseFrom: number | undefined;

        // Each index is told as `deepClone`'s walk tells it (see `holdsOwnIndex`): by `in`
        // while the array's prototype is this realm's `Array.prototype`, and by
        // `Object.hasOwn` on an Array subclass's or another realm's array, whose prototype
        // can answer `in` for a hole - a `Proxy` whose `has` answers for any - so a hole
        // its prototype claims is never read as an entry, and the same array is sized the
        // same way every time. A `Proxy` array is sized as its own traps answer: one whose
        // `has` and `ownKeys` disagree can be read either way past a long run of holes
        // (see `walksOnByIndex`).
        for (let index = 0; index < length; index++) {
          if (estimatedSize > budget) {
            return STOPPED_EARLY;
          }

          let isOwn: boolean;

          try {
            isOwn = holdsOwnIndex(items, index);
          } catch {
            return estimatedSize + UNSIZED_VALUE_BYTES;
          }

          if (!isOwn) {
            // Enough holes, as `deepClone` counts them: the rest by the array's own index
            // keys.
            if (isMostlyHoles(++holes, entries)) {
              let isPlain: boolean;

              try {
                isPlain = Reflect.getPrototypeOf(items) === Array.prototype;
              } catch {
                return estimatedSize + UNSIZED_VALUE_BYTES;
              }

              // A plain array may go on by index, its holes told by `in` (see
              // `walksOnByIndex`); any other goes straight to its own index keys, as a
              // hole walked by `Object.hasOwn` costs about what listing an entry does.
              if (isPlain) {
                try {
                  checkpoint = walksOnByIndex(
                    items,
                    index + 1,
                    length,
                    holes,
                    entries,
                    checkpoint,
                    WALKED_HOLES_PER_ENTRY,
                  );
                } catch {
                  return estimatedSize + UNSIZED_VALUE_BYTES;
                }

                if (checkpoint !== undefined) {
                  continue;
                }
              }

              sparseFrom = index + 1;
              break;
            }
            continue;
          }

          // Counted as held whether or not its read throws, as `deepClone` counts one.
          entries++;
          estimatedSize += this.entrySize(
            items,
            index,
            budget - estimatedSize,
            sizing,
            depth,
          );
        }

        if (sparseFrom === undefined) {
          return estimatedSize;
        }

        // Keys that cannot be listed take the fallback for the rest.
        let tail: number[];

        try {
          tail = indicesFrom(items, sparseFrom, length);
        } catch {
          return estimatedSize + UNSIZED_VALUE_BYTES;
        }

        for (const index of tail) {
          if (estimatedSize > budget) {
            return STOPPED_EARLY;
          }

          let isOwn: boolean;

          // Checked again, as `deepClone` checks its tail: an entry read before it can
          // have removed it.
          try {
            isOwn = Object.hasOwn(items, index);
          } catch {
            return estimatedSize + UNSIZED_VALUE_BYTES;
          }

          if (!isOwn) {
            continue;
          }

          estimatedSize += this.entrySize(
            items,
            index,
            budget - estimatedSize,
            sizing,
            depth,
          );
        }

        return estimatedSize;
      } finally {
        sizing.visiting.delete(items);
        sizing.sized.add(items);
      }
    } else if (typeof value === 'object') {
      try {
        // Rough estimate based on JSON size
        const jsonSize = JSON.stringify(value).length * 2;
        return Math.max(jsonSize, 40); // At least 40 bytes for object overhead
      } catch {
        // Ignore JSON serialization errors for non-serializable objects
        return UNSIZED_VALUE_BYTES; // Not serializable
      }
    }

    return 100; // Default fallback size
  }

  /**
   * The default size estimate of `items[index]`, an entry of an array sized at `depth`,
   * within `budget` (see `calculateSize`): {@link UNSIZED_VALUE_BYTES} when its read
   * throws.
   */
  private entrySize(
    items: unknown[],
    index: number,
    budget: number,
    sizing: ArraySizing,
    depth: number,
  ): number {
    let entry: unknown;

    try {
      entry = items[index];
    } catch {
      return UNSIZED_VALUE_BYTES;
    }

    return (
      primitiveSize(entry) ??
      this.calculateSize(entry, budget, sizing, depth + 1)
    );
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

  /** The periodic cleanup a read starts, as of `now`, the time the read checked against. */
  private maybeCleanup(now: number): void {
    // Only run cleanup occasionally to avoid performance impact
    if (
      now - this.lastCleanup > this.cleanupInterval &&
      this.expirableEntryCount > 0
    ) {
      const changeEvents = this.createLocalChangeQueue();
      this.reclaimExpired(changeEvents, now);
      this.flushLocalChangeQueue(changeEvents);
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

    // Its heap node lets go of it, and of the value, rather than holding both until it
    // reaches the top.
    if (entry.expiryNode !== undefined) {
      entry.expiryNode.key = undefined;
      entry.expiryNode.entry = undefined;
      entry.expiryNode = undefined;
      this.compactExpiryHeap();
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

  /**
   * Puts `entry` under `key`, which is not in the map, at its end - the most recently used
   * place - and gives it the `order` that says so: the map's order is what eviction reads,
   * and `order` is what an expired batch is reported in (see `reclaimExpired`), so they
   * change together.
   */
  private placeAsMostRecent(key: K, entry: CacheEntry<V>): void {
    entry.order = this.nextOrder++;
    this.map.set(key, entry);
  }

  private assertNonNegativeFiniteNumber(value: number, message: string): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(message);
    }
  }
}

/**
 * The prototypes `mayBeBuffer` has found carry no buffer's tag in their chain, so the
 * instances of a class are walked once, not each time one is sized. Weak, so a class let
 * go is not kept. A chain changed after it was walked is not walked again: the answer only
 * picks how an estimate is made.
 */
const prototypesWithoutBufferTag = new WeakSet<object>();

/**
 * The prototypes whose chain `mayBeBuffer` could not walk to its end - one that throws
 * partway, or runs on past the walk's cap - so their instances are measured through their
 * slots without walking the chain again. Weak, and not walked again if the chain changes,
 * as above: the answer only picks how an estimate is made.
 */
const prototypesWithUnwalkedChain = new WeakSet<object>();

/**
 * Whether `value`, an object that is not an array or a view, may be a buffer: never a
 * plain object or one with no prototype, which carry no buffer's tag, nor an instance of
 * a prototype already found to carry none; otherwise, whether a prototype in its chain
 * carries a buffer's tag (see `hasBufferTagInChainFrom`), or that cannot be told. A
 * prototype that cannot be read answers no: the value is a `Proxy`, which has no buffer's
 * slots.
 */
function mayBeBuffer(value: object): boolean {
  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }

  if (prototype === Object.prototype || prototype === null) {
    return false;
  }

  if (prototypesWithoutBufferTag.has(prototype as object)) {
    return false;
  }

  if (prototypesWithUnwalkedChain.has(prototype as object)) {
    return true;
  }

  // Walked from the prototype read above, not read again: a `Proxy` answering another one
  // the second time cannot have this one remembered. A chain that throws partway, or runs
  // on past the walk's cap, is no answer about it: its value is measured through the
  // slots instead, which tell a buffer whatever its chain, and so is every later instance
  // of its prototype.
  const hasTag = hasBufferTagInChainFrom(prototype as object);
  if (hasTag === false) {
    prototypesWithoutBufferTag.add(prototype as object);
  } else if (hasTag === null) {
    prototypesWithUnwalkedChain.add(prototype as object);
  }

  return hasTag !== false;
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
