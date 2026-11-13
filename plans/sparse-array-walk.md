# Plan: one sparse-array walk that a leading gap cannot push onto key listing

Status: partly done in PR #34. Step 3 is in: a walk past enough holes samples the rest at random - each index held only when `in` and `Object.hasOwn` both say so - and samples again after each further run of holes (`walksOnByIndex` in `src/lib/internal/array-indices.ts`), so the gap-then-dense shape below is walked by index. Steps 1 and 2 are not started; do them on a new branch after PR #35 merges. It changes how fast some arrays are read, not what is read, so it needs a changelog line only for the speed.

## What it is now

Three walks read an array's own indices and, past enough holes, list its own keys instead of walking the rest:

| Walk                                                                     | File                                | Switches to listing when                                                      |
| ------------------------------------------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------- |
| `forEachOwnIndex` (`copyArrayValue`, the cookie jar's `set-cookie` read) | `src/lib/internal/array-indices.ts` | `holes > SPARSE_RUN && holes > entries`                                       |
| `ArrayFrame.step`                                                        | `src/lib/deep-clone.ts`             | `isMostlyHoles(holes, entries)`: `holes > SPARSE_RUN && holes > entries * 64` |
| `calculateSize`                                                          | `src/lib/lru-cache/index.ts`        | its own copy of the same rule                                                 |

Each counts holes, lists the rest with `indicesFrom`, and checks each listed index again with `Object.hasOwn`.

The decision uses only what has been walked so far. A run of 65,537 leading holes trips it while `entries` is still 0, so an array that is dense after the gap is listed in full. Measured on Bun with a 70,000-index gap followed by 4,000,000 entries:

|                  | Gap, then dense | Dense |
| ---------------- | --------------- | ----- |
| `copyArrayValue` | 2,446 ms        | 37 ms |
| `deepClone`      | 2,957 ms        | 33 ms |

A review measured about 1.3 GB of memory for `deepClone` at 8,000,000 entries. Listing an entry costs about 600 ns on Bun, against about 9 ns for each index walked: around 65 times as much. So the premise in `forEachOwnIndex`'s doc, that a hole walked costs "about what listing and checking an entry does", does not hold, and its `holes > entries` rule lists far too early. `copyArrayValue` caps a length at 2^24, so the worst case there is about 10 s. `deepClone` has no cap.

## Why it is not a review fix

- **Whatever rule is chosen, some input defeats it, unless the rule uses randomness.** Listing costs about 65 times the number of own entries, and that number is unknown until the keys are listed. Walking costs the length that is left. Any rule that decides from the indices it has already walked can be met by an array that is holes up to the decision point and dense after it. A probe window only moves the decision point.
- **Read order is pinned.** The `deepClone` tests under "read order and sparse tails", and the LRU size tests, pin which `has` and `get` traps a `Proxy` array sees, in order. Probing ahead changes that order.
- **Three copies.** The same fix would be made three times, which is the reuse finding.

## Approach, if done

1. **One walk.** Add a resumable iterator to `array-indices.ts`, for example `class OwnIndexWalk { next(): number | undefined }`, with `deepClone`'s frame-by-frame stepping in mind. Use it from `forEachOwnIndex`, `ArrayFrame` and `calculateSize`. Keep `holdsCopiedIndex` versus `holdsOwnIndex` a parameter, since `forEachOwnIndex` deliberately keeps an own entry that a `Proxy`'s `has` hides.
2. **One cost rule.** Use `isMostlyHoles` everywhere, with the factor taken from a measurement on Node and Bun rather than assumed. Fix `forEachOwnIndex`'s doc to match.
3. **Decide from the part not yet walked.** When the rule trips, sample a fixed number of indices (for example 64) spread across `[index, length)` with `Math.random`. List only if the sample says the rest has fewer than about 1 entry in 64. Otherwise keep walking, and sample again the next time the hole count doubles. A random sample cannot be gamed by where the gap ends, and it costs 64 checks.
   - Before choosing this, decide whether a `Proxy` array may see `has` calls out of order and more than once. If not, sample only arrays whose prototype is this realm's `Array.prototype` and that are not Proxies as far as `Array.isArray` and the prototype tell, and keep today's rule for the rest.
4. **Tests.** Add the gap-then-dense shape to each caller's tests, timed against the dense array with a generous ratio, not a fixed number of milliseconds (CI runners vary). Keep the existing sparse tests: one entry at index 100,000,000, one every 1,000 indices, and a length of 2^32 - 1.
