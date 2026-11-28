/**
 * `compute(key)`, kept in `cache` for at most `maxEntries` keys, least recently used out
 * first: a hit moves to the end, and the oldest goes when a new key would pass the bound.
 * Holds no state of its own, so a copy of it in each bundle entry point is the same
 * helper; the state is the caller's `cache`.
 *
 * `shouldKeep(key)`, when given, decides whether a computed value is kept at all: one it
 * refuses is answered and let go, and evicts nothing. A `maxEntries` below 1 keeps none.
 */
export function getOrCompute<K, V>(
  cache: Map<K, V>,
  key: K,
  maxEntries: number,
  compute: (key: K) => V,
  shouldKeep?: (key: K) => boolean,
): V {
  // One lookup on a hit; `has` only tells a kept `undefined` from a miss.
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) {
    cache.delete(key);
    cache.set(key, cached as V);
    return cached as V;
  }

  const value = compute(key);

  if (maxEntries < 1 || (shouldKeep !== undefined && !shouldKeep(key))) {
    return value;
  }

  if (cache.size >= maxEntries) {
    const oldest = cache.keys().next();
    if (oldest.done !== true) {
      cache.delete(oldest.value);
    }
  }
  cache.set(key, value);

  return value;
}
