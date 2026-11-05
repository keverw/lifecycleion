# Plan: size an object value in `LRUCache` without `JSON.stringify`

Status: optional, not scheduled. Do it on its own branch from main, after PR #34 and PR #35 have merged.

## What it is now

`LRUCache`'s default size estimate (`calculateSize` in `src/lib/lru-cache/index.ts`, used when no `sizeCalculator` is given) sizes a value by its kind:

- **An array:** walked by index. PR #34 made this walk safe for sparse arrays: past enough holes it lists the array's own index keys instead of walking its length.
- **Any other object:** sized as `JSON.stringify(value).length * 2`, with 1000 if that throws. This is the same as in 0.1.0.

So an array is only protected when it is the cached value itself. Inside an object, `JSON.stringify` writes `null` for every hole of a sparse array, and runs every getter and `toJSON` it reaches.

A review of PR #34 measured it on Bun:

| Call                                                                    | Result                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `cache.set('k', a)`, where `a.length = 2 ** 32 - 1` and only `a[5] = 1` | about 2 ms                                                         |
| `cache.set('k', { list: a })`                                           | about 10.7 s, then out of memory; the catch made the estimate 1000 |

## The risk

The thread blocks for seconds and memory spikes, from one cached value. It needs a caller to cache an object holding a huge sparse array, which is unusual but easy to do by mistake: an array indexed by a large ID.

## Design options

1. **A bounded walk** of plain objects and arrays, reusing the array walk for nested arrays. It needs a cycle set (which already exists for arrays, as `visitedArrays`), a depth or node budget, and a decision about getters. `JSON.stringify` runs them; a walk could read data properties only.
2. **Keep `JSON.stringify`, guarded.** Use a replacer that hands a nested array's estimate back through the array walk, for example as a placeholder string of the right length. Smaller change, but the replacer still runs on every key.
3. **Document it.** Say that `sizeCalculator` is the way to size large or unusual values, and leave the default alone.

Changing the estimate changes eviction for existing users, since the same value gets a different size. Note it in the changelog, marked **BREAKING** if the numbers move for ordinary objects.

## Steps

1. Pick an option. Option 1 is the most robust; option 3 is enough if the default estimate is only meant to be rough.
2. Tests:
   - `{ list: hugeSparseArray }` is sized in milliseconds;
   - an ordinary nested object gets about the size it does now;
   - cycles take the fallback;
   - a throwing getter takes the fallback without failing `set()`.
3. Benchmark ordinary objects against `JSON.stringify` on Bun and Node, and record the table here.
4. Changelog bullet and docs for the estimate.
