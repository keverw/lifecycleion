import { safeHandleCallback } from '../safe-handle-callback';
import {
  hasBufferTagInChainFrom,
  readBinaryByteLength,
} from '../internal/binary-view';
import { copyArrayValue, readArrayLength } from '../internal/array-copy';
import {
  holdsOwnIndex,
  indexFreePrototype,
  indicesFrom,
  isMostlyHoles,
  walksOnByIndex,
  WALKED_HOLES_PER_ENTRY,
} from '../internal/array-indices';
import type { FillCheckpoint } from '../internal/array-indices';

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

/**
 * The default size estimate of what cannot be sized: a circular or too deeply nested
 * array, one whose length or an entry cannot be read, and an object `JSON.stringify`
 * throws on.
 */
const UNSIZED_VALUE_BYTES = 1000;

/** The arrays one default size estimate has met (see `calculateSize`). */
interface ArraySizing {
  /** Arrays being sized now, so one met inside itself is a cycle. */
  readonly visiting: WeakSet<object>;
  /**
   * Arrays already sized, so one met again counts as a reference to it. Held for one
   * estimate only.
   */
  readonly sized: Set<object>;
  /**
   * The arrays in `sized`, in the order they were sized, so an array sized again from the
   * start forgets the arrays its abandoned pass sized - each counted in a total that was
   * thrown away - and counts them in full again (see `forgetSizedAfter`).
   */
  readonly sizedOrder: object[];
}

/** Records `array` as sized; see `ArraySizing.sized`. */
function markSized(sizing: ArraySizing, array: object): void {
  sizing.sized.add(array);
  sizing.sizedOrder.push(array);
}

/**
 * Forgets every array sized after the first `count`, latest first, so a restart costs
 * the arrays it forgets rather than all those sized so far.
 */
function forgetSizedAfter(sizing: ArraySizing, count: number): void {
  while (sizing.sizedOrder.length > count) {
    sizing.sized.delete(sizing.sizedOrder.pop() as object);
  }
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
  /** Its place in the LRU order: higher is more recently used. */
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

      // Move to end of LRU (most recently used)
      this.map.delete(key);
      entry.order = this.nextOrder++;
      this.map.set(key, entry);

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

    // Calculate size first so failed sizeCalculator calls do not mutate cache state.
    const size = this.calculateSize(value);
    const changeEvents = this.createLocalChangeQueue();

    // Reclaim expired entries before deciding whether this write is a fresh insert,
    // an overwrite, or a skipped oversized write: taken off the top of `expiryHeap`, so
    // the cost follows the entries that expired, not the entries held.
    this.reclaimExpired(changeEvents);
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
    const entry: CacheEntry<V> = {
      value,
      expires,
      size,
      order: this.nextOrder++,
    };
    this.map.set(key, entry);
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
   */

  private calculateSize(
    value: unknown,
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

    // A buffer or view - shared, from another realm, or one whose own `byteLength` lies -
    // measured through its internal slots. Told first by its internal slot (a view) or,
    // for what is not an array, the tag its prototypes carry (a buffer), so any other
    // object is not put through the getters, each of which throws for it. A plain object
    // is told apart by its prototype alone, without the walk.
    const byteLength =
      typeof value === 'object' &&
      value !== null &&
      (ArrayBuffer.isView(value) ||
        (!Array.isArray(value) && mayBeBuffer(value)))
        ? readBinaryByteLength(value)
        : null;

    if (byteLength !== null) {
      return byteLength;
    } else if (Array.isArray(value)) {
      // Made for the outermost array only: a value with none needs none.
      sizing ??= {
        visiting: new WeakSet(),
        sized: new Set(),
        sizedOrder: [],
      };

      if (sizing.visiting.has(value)) {
        return UNSIZED_VALUE_BYTES; // Circular
      }

      // Met again - shared between two entries, say - it is one array, already counted:
      // walked again, `[a, a]` nested 22 deep would take half a second and count 2^22
      // copies.
      if (sizing.sized.has(value)) {
        return 8;
      }

      if (depth >= MAX_SIZED_ARRAY_DEPTH) {
        return UNSIZED_VALUE_BYTES;
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
          return UNSIZED_VALUE_BYTES;
        }

        let estimatedSize = 40;
        let holes = 0;
        let entries = 0;
        let checkpoint: FillCheckpoint | undefined;
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
                  forgetSizedAfter(sizing, sizedBefore);

                  checkedPrototype = undefined;
                  estimatedSize = 40;
                  holes = 0;
                  entries = 0;
                  checkpoint = undefined;
                  index = -1;
                  continue;
                }
              }
            } else {
              isOwn = holdsOwnIndex(items, index);
            }
          } catch {
            return estimatedSize + UNSIZED_VALUE_BYTES;
          }

          if (!isOwn) {
            // Enough holes, as `deepClone` counts them: the rest by the array's own index
            // keys.
            if (isMostlyHoles(++holes, entries)) {
              // See `walksOnByIndex`.
              try {
                // A hole is told by `in` on the checked prototype, and by
                // `holdsOwnIndex` - `in` for this realm's arrays alone - otherwise.
                const prototype = Reflect.getPrototypeOf(items);
                checkpoint = walksOnByIndex(
                  items,
                  index + 1,
                  length,
                  holes,
                  entries,
                  checkpoint,
                  prototype === Array.prototype ||
                    (checkedPrototype !== undefined &&
                      prototype === checkedPrototype)
                    ? WALKED_HOLES_PER_ENTRY
                    : 1,
                );
              } catch {
                return estimatedSize + UNSIZED_VALUE_BYTES;
              }

              if (checkpoint !== undefined) {
                continue;
              }

              sparseFrom = index + 1;
              break;
            }
            continue;
          }

          // Counted as held whether or not its read throws, as `deepClone` counts one.
          entries++;
          estimatedSize += this.entrySize(items, index, sizing, depth);
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

          estimatedSize += this.entrySize(items, index, sizing, depth);
        }

        return estimatedSize;
      } finally {
        sizing.visiting.delete(value);
        markSized(sizing, value);
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
   * The default size estimate of `items[index]`, an entry of an array sized at `depth`:
   * {@link UNSIZED_VALUE_BYTES} when its read throws.
   */
  private entrySize(
    items: unknown[],
    index: number,
    sizing: ArraySizing,
    depth: number,
  ): number {
    let entry: unknown;

    try {
      entry = items[index];
    } catch {
      return UNSIZED_VALUE_BYTES;
    }

    return primitiveSize(entry) ?? this.calculateSize(entry, sizing, depth + 1);
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
 * Whether `value`, an object that is not an array or a view, may be a buffer: never a
 * plain object or one with no prototype, which carry no buffer's tag, nor an instance of
 * a prototype already found to carry none; otherwise, whether a prototype in its chain
 * carries a buffer's tag (see `hasBufferTagInChainFrom`). A prototype that cannot be read
 * answers no, as the walk does.
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

  // Walked from the prototype read above, not read again: a `Proxy` answering another one
  // the second time cannot have this one remembered. Remembered only for a walk that
  // finished, so a chain that throws partway is no answer about it.
  const hasTag = hasBufferTagInChainFrom(prototype as object);
  if (hasTag === false) {
    prototypesWithoutBufferTag.add(prototype as object);
  }

  return hasTag === true;
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
