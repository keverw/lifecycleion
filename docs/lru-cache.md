# lru-cache

TTL-aware LRU (Least Recently Used) cache with optional size-based eviction and custom size calculation. The cache can also optionally emit change events for removals and writes via `onChange`.

Expiration is lazy by design. Entries are removed when accessed with `get()` or `has()`, when `set()` performs its write-time expired-entry cleanup, during occasional internal cleanup triggered by successful `get()` calls when the cache contains expirable entries, or when you explicitly call `cleanupExpired()`. There is no background timer.

That internal `get()`-triggered sweep is throttled: it runs only after a successful `get()`, only when the cache currently contains one or more entries with an expiration time, and only when more than one minute has passed since the last cleanup-timer reset. Calls to `set()`, `cleanupExpired()`, and `clear()` reset the internal cleanup timer.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [Constructor](#constructor)
  - [Methods](#methods)
  - [has](#has)
  - [get](#get)
  - [set](#set)
  - [delete](#delete)
  - [clear](#clear)
  - [cleanupExpired](#cleanupexpired)
  - [size](#size)
  - [byteSize](#bytesize)
- [Examples](#examples)
  - [Basic usage](#basic-usage)
  - [With TTL](#with-ttl)
  - [With size limits](#with-size-limits)
  - [With change events](#with-change-events)
- [Internal size calculation](#internal-size-calculation)

<!-- tocstop -->

## Usage

```typescript
import { LRUCache } from 'lifecycleion/lru-cache';
```

## API

### Constructor

```typescript
new LRUCache<K, V>(
  maxEntries: number,
  options?: {
    defaultTtl?: number;
    maxSize?: number;
    sizeCalculator?: (value: V) => number;
    onChange?: (event: LRUCacheChangeEvent<K, V>) => void | Promise<void>;
    onChangeReasons?: LRUCacheChangeReason[];
  }
)
```

- `maxEntries`: Maximum number of entries to store in the cache. Must be a positive integer. Invalid values throw `RangeError`.
- `options.defaultTtl`: (Optional) Default time-to-live in milliseconds for all cache entries. Must be a non-negative finite number. `0` disables expiration by default. Invalid values throw `RangeError`.
- `options.maxSize`: (Optional) Maximum total size in bytes for all cache entries combined. Must be a positive integer byte count. Invalid values throw `RangeError`.
- `options.sizeCalculator`: (Optional) Custom function to calculate the size of a value. If provided, it must be a function. It must return a non-negative integer byte count or byte estimate. A non-function `sizeCalculator` throws `TypeError`, and an invalid return value throws `RangeError`.
- `options.onChange`: (Optional) Callback invoked after cache mutations. If provided, it must be a function. Sync and async callbacks are supported. Errors are reported via the global `'reportError'` event rather than propagating. A non-function `onChange` throws `TypeError`.
- `options.onChangeReasons`: (Optional) Array of change reasons that should trigger `onChange`. If provided, it must be an array containing only valid change reasons. Invalid values throw `TypeError` or `RangeError`.

```typescript
type LRUCacheChangeReason =
  | 'evict'
  | 'expired'
  | 'delete'
  | 'clear'
  | 'set'
  | 'skip';

type LRUCacheChangeEvent<K, V> =
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
```

`onChange` is invoked after the cache state has been updated. Async callbacks are fired and not awaited.
`onChange` is best used for observation. Avoid mutating the same cache synchronously from inside `onChange` or from functions it calls. If you need a follow-up write, defer it with `queueMicrotask()` or `setTimeout()`.
When `onChangeReasons` is provided, only events whose `reason` appears in that list are emitted.

- `reason: 'evict'`: An entry was removed to satisfy `maxEntries` or `maxSize`.
- `reason: 'expired'`: An entry was removed when the cache discovered it had expired during lazy expiration handling.
- `reason: 'delete'`: An entry was removed by an explicit `delete(key)` call.
- `reason: 'clear'`: An entry was removed by `clear()`. `clear()` emits one event per removed entry.
- `reason: 'set'`: `set(key, value)` completed successfully. This event always includes `newValue`, and includes `oldValue` only when an existing entry for the same key was overwritten.
- `reason: 'skip'`: `set(key, value)` was intentionally skipped without changing cache state. This currently happens when a single value is larger than `maxSize`. The event includes `newValue` and `cause`, and includes `currentValue` only when the skipped write left an existing entry in place.

`byteSize` is tracked whether or not `maxSize` is configured. Likewise, `sizeCalculator` affects byte accounting even when size-based eviction is disabled. `maxSize` only enables eviction based on total stored size. Custom `sizeCalculator` results are treated as byte counts or byte estimates and must be returned as non-negative integers.

`byteSize` tracks stored value sizes only. It does not attempt to account for key storage, `Map` overhead, or other runtime-specific object overhead beyond the built-in estimator's approximations.

The built-in estimator is runtime-aware. If a Node/Bun-style global `Buffer` implementation is available, `Buffer` values use their actual byte length. In browser-only runtimes without `Buffer`, buffer-specific detection is skipped and other built-in estimation rules apply instead.

If neither `defaultTtl` nor `customTtl` is provided, entries do not expire.

If a single value is larger than `maxSize`, `set()` skips that write entirely and leaves the cache unchanged. If `onChange` is configured, the cache emits `reason: 'skip'` with `cause: 'maxSize'`.

If a value can fit individually but adding it would push the total cache size over `maxSize`, the cache accepts the write and then evicts least-recently-used entries until it is back within limits.

Every successful `set()` emits `reason: 'set'`. When the key already existed, the event also includes `oldValue` rather than emitting a separate `delete` event for the previous value. Writes skipped because they cannot fit within `maxSize` emit `reason: 'skip'` instead and do not change cache state. When a prior entry remains stored, that event includes `currentValue`.

### Methods

| Method                                            | Description                                              |
| ------------------------------------------------- | -------------------------------------------------------- |
| `has(key: K): boolean`                            | Check if key exists (does not affect LRU order)          |
| `get(key: K): V \| undefined`                     | Get a value, returning `undefined` if expired or missing |
| `set(key: K, value: V, customTtl?: number): void` | Set a value with optional per-entry TTL override         |
| `delete(key: K): boolean`                         | Delete an entry, returning `true` if it existed          |
| `clear(): void`                                   | Clear all entries and reset byte size                    |
| `cleanupExpired(): number`                        | Remove expired entries now and return the number removed |
| `size: number`                                    | Current stored entry count                               |
| `byteSize: number`                                | Current stored estimated size in bytes                   |

### has

```typescript
has(key: K): boolean
```

Checks if a key exists in the cache. Returns `false` if the key is missing or the entry has expired. Does **not** update the LRU order and does not trigger the cache's periodic full cleanup sweep.

If the key exists but is expired, `has()` removes that entry immediately before returning `false`. As a result, calling `has()` on an expired key can reduce both `size` and `byteSize`.

### get

```typescript
get(key: K): V | undefined
```

Retrieves a value from the cache. Returns `undefined` if the key is missing or the entry has expired. Marks the entry as most recently used. When the cache contains expirable entries, successful `get()` calls may also trigger the cache's occasional full cleanup sweep for other expired entries, but at most once per minute.

If the key exists but is expired, `get()` removes that entry immediately before returning `undefined`. As a result, calling `get()` on an expired key can reduce both `size` and `byteSize`.

### set

```typescript
set(key: K, value: V, customTtl?: number): void
```

Adds or updates a value. Pass `customTtl` (milliseconds) to override the default TTL for this entry. Pass `0` to explicitly disable expiration for this entry even when a `defaultTtl` is configured. `customTtl` must be a non-negative finite number.

Invalid `customTtl` values throw `RangeError`.

If `customTtl` validation fails, or size calculation throws (for example because a custom `sizeCalculator` returns an invalid value or throws), `set()` does not remove or alter any existing entry for that key.

If the key already exists, `set()` replaces the previous value, recalculates its stored size, resets its expiration based on the new TTL inputs, and makes the entry most recently used.

Every successful `set()` emits a single `reason: 'set'` event with `newValue`. When the key already existed, the event also includes `oldValue`.

If a single value is larger than `maxSize`, `set()` skips the write and leaves any existing entry for that key untouched. When `onChange` is configured, the cache emits `reason: 'skip'` with `cause: 'maxSize'`. If a previous entry remains in the cache, the event also includes `currentValue`. Otherwise `currentValue` is omitted.

TTL expiration is checked with a strict `now > expires` comparison, so an entry remains valid at the exact `createdAt + ttl` timestamp and expires immediately after that boundary is passed.

After inserting the new value, `set()` removes any expired entries currently in the cache before enforcing entry-count and size limits. This means a write can reduce `size` and `byteSize` by deleting unrelated expired entries.

### delete

```typescript
delete(key: K): boolean
```

Removes a specific entry. Returns `true` if deleted, `false` if the key didn't exist.

When an entry is deleted, both `size` and `byteSize` are updated immediately.

If `onChange` is configured, a successful delete emits `reason: 'delete'`.

### clear

```typescript
clear(): void
```

Removes all entries from the cache and resets the byte size counter.

`clear()` also resets the internal timer used by the opportunistic `get()`-triggered cleanup sweep.

If `onChange` is configured, `clear()` emits one `reason: 'clear'` event per removed entry.

### cleanupExpired

```typescript
cleanupExpired(): number
```

Immediately removes all expired entries and returns the number removed. Use this when you want deterministic cleanup without relying on future `get()`, `has()`, or `set()` calls. This also resets the internal cleanup interval used by the opportunistic `get()`-triggered sweep, even when no entries were removed.

If `onChange` is configured, each removed expired entry emits `reason: 'expired'`.

### size

```typescript
get size(): number
```

Current number of stored entries in the cache. Because expiration is lazy, this may temporarily include expired entries until they are removed by `get()`, `has()`, `set()`, or `cleanupExpired()`.

### byteSize

```typescript
get byteSize(): number
```

Current total estimated size in bytes of stored cached values. Because expiration is lazy, this may temporarily include expired entries until they are removed by `get()`, `has()`, `set()`, or `cleanupExpired()`.

This tracks cached values only, not key sizes or container overhead, and should be treated as cache accounting rather than exact process memory usage.

## Examples

### Basic usage

```typescript
import { LRUCache } from 'lifecycleion/lru-cache';

const cache = new LRUCache<string, string>(100);

cache.set('key1', 'value1');
cache.set('key2', 'value2');

cache.get('key1'); // 'value1'
cache.has('key2'); // true
cache.delete('key2'); // true
cache.size; // 1
```

### With TTL

```typescript
// Cache with 5-minute default TTL
const cache = new LRUCache<string, object>(100, {
  defaultTtl: 5 * 60 * 1000, // 5 minutes
});

cache.set('user:123', { name: 'Alice' });

// Override TTL for a specific entry
cache.set('session:abc', { token: '...' }, 60 * 60 * 1000); // 1 hour

// Explicitly disable expiration for one entry despite defaultTtl being set
cache.set('config:flags', { debug: false }, 0);

// Deterministically remove expired entries when needed
cache.cleanupExpired();
```

### With size limits

```typescript
// Limit by entry count and total byte size
const cache = new LRUCache<string, Buffer>(1000, {
  maxSize: 50 * 1024 * 1024, // 50 MB
});

// Custom size calculator for accurate accounting of complex objects
const jsonCache = new LRUCache<string, object>(500, {
  maxSize: 10 * 1024 * 1024, // 10 MB
  sizeCalculator: (value) => JSON.stringify(value).length * 2,
});
```

### With change events

```typescript
import { LRUCache, type LRUCacheChangeEvent } from 'lifecycleion/lru-cache';

const cache = new LRUCache<string, string>(2, {
  onChange: (event: LRUCacheChangeEvent<string, string>) => {
    if (event.reason === 'set') {
      console.log('wrote', event.key, event.oldValue, event.newValue);
      return;
    }

    if (event.reason === 'skip') {
      console.log(
        'skipped',
        event.key,
        event.cause,
        event.currentValue,
        event.newValue,
      );
      return;
    }

    console.log('removed', event.reason, event.key, event.value);
  },
  onChangeReasons: ['set', 'skip', 'expired'],
});

cache.set('a', 'one');
cache.set('a', 'two'); // set with overwrite
cache.delete('a'); // delete, triggers onChange with reason 'delete', but wouldn't be logged since 'delete' is not in onChangeReasons provided in the example
```

If you want to react to a change by writing back into the same cache, defer that write instead of doing it synchronously inside `onChange`:

```typescript
const cache = new LRUCache<string, string>(2, {
  onChange: (event) => {
    if (event.reason === 'expired') {
      queueMicrotask(() => {
        cache.set(event.key, 'refreshed');
      });
    }
  },
});
```

## Internal size calculation

When no `sizeCalculator` is provided the cache uses a built-in estimator:

| Type                                      | Estimated size                                   |
| ----------------------------------------- | ------------------------------------------------ |
| `null` / `undefined`                      | 0 bytes                                          |
| `boolean`                                 | 4 bytes                                          |
| `number`                                  | 8 bytes (double precision)                       |
| `string`                                  | 2 bytes per character (UTF-16)                   |
| `Buffer`                                  | Actual buffer length                             |
| `TypedArray` / `DataView` / `ArrayBuffer` | Actual byte length                               |
| `Array`                                   | 40 bytes + recursive sum of element sizes        |
| `Object`                                  | Estimated from JSON string length (min 40 bytes) |
| Non-serializable object                   | 1000 bytes (fallback)                            |
| Other non-object values                   | 100 bytes (fallback)                             |

The `Object` row applies to values that reach the object/JSON-size estimation branch. Values outside the listed branches, such as functions and symbols, fall back to the generic `Other non-object values` estimate.

These estimates are approximate. For accurate memory accounting provide a custom `sizeCalculator`.
