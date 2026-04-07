# lru-cache

TTL-aware LRU (Least Recently Used) cache with optional size-based eviction and custom size calculation.

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
  }
)
```

- `maxEntries`: Maximum number of entries to store in the cache. Must be a positive integer. Invalid values throw `RangeError`.
- `options.defaultTtl`: (Optional) Default time-to-live in milliseconds for all cache entries. Must be a non-negative finite number. `0` disables expiration by default. Invalid values throw `RangeError`.
- `options.maxSize`: (Optional) Maximum total size in bytes for all cache entries combined. Must be a positive integer byte count. Invalid values throw `RangeError`.
- `options.sizeCalculator`: (Optional) Custom function to calculate the size of a value. If provided, it must be a function. It must return a non-negative integer byte count or byte estimate. A non-function `sizeCalculator` throws `TypeError`, and an invalid return value throws `RangeError`.

`byteSize` is tracked whether or not `maxSize` is configured. Likewise, `sizeCalculator` affects byte accounting even when size-based eviction is disabled. `maxSize` only enables eviction based on total stored size. Custom `sizeCalculator` results are treated as byte counts or byte estimates and must be returned as non-negative integers.

`byteSize` tracks stored value sizes only. It does not attempt to account for key storage, `Map` overhead, or other runtime-specific object overhead beyond the built-in estimator's approximations.

The built-in estimator is runtime-aware. If a Node/Bun-style global `Buffer` implementation is available, `Buffer` values use their actual byte length. In browser-only runtimes without `Buffer`, buffer-specific detection is skipped and other built-in estimation rules apply instead.

If neither `defaultTtl` nor `customTtl` is provided, entries do not expire.

If a single inserted value is larger than `maxSize`, the cache still accepts the write and then evicts least-recently-used entries until it is back within limits. In that case the newly inserted entry may be evicted immediately if it cannot fit.

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

TTL expiration is checked with a strict `now > expires` comparison, so an entry remains valid at the exact `createdAt + ttl` timestamp and expires immediately after that boundary is passed.

After inserting the new value, `set()` removes any expired entries currently in the cache before enforcing entry-count and size limits. This means a write can reduce `size` and `byteSize` by deleting unrelated expired entries.

### delete

```typescript
delete(key: K): boolean
```

Removes a specific entry. Returns `true` if deleted, `false` if the key didn't exist.

When an entry is deleted, both `size` and `byteSize` are updated immediately.

### clear

```typescript
clear(): void
```

Removes all entries from the cache and resets the byte size counter.

`clear()` also resets the internal timer used by the opportunistic `get()`-triggered cleanup sweep.

### cleanupExpired

```typescript
cleanupExpired(): number
```

Immediately removes all expired entries and returns the number removed. Use this when you want deterministic cleanup without relying on future `get()`, `has()`, or `set()` calls. This also resets the internal cleanup interval used by the opportunistic `get()`-triggered sweep, even when no entries were removed.

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
