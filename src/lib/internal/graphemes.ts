/** One lazily constructed grapheme segmenter for every string boundary operation. */
let cachedSegmenter: Intl.Segmenter | undefined | null = null;

function graphemeSegmenter(): Intl.Segmenter | undefined {
  if (cachedSegmenter === null) {
    // Mark the probe complete before invoking host code. A broken host implementation
    // or a hostile global getter should cost one failed probe, not one throw per rendered
    // or masked leaf.
    cachedSegmenter = undefined;

    try {
      const ctor = (
        globalThis.Intl as { Segmenter?: typeof Intl.Segmenter } | undefined
      )?.Segmenter;

      if (typeof ctor === 'function') {
        cachedSegmenter = new ctor(undefined, { granularity: 'grapheme' });
      }
    } catch {
      // Callers retain their code-point-safe fallback when Segmenter is unavailable or
      // unusable. The read is inside the guard because host globals can be accessors.
    }
  }

  return cachedSegmenter;
}

/** Split into user-perceived characters, or code points on older runtimes. */
export function splitGraphemes(value: string): string[] {
  const segmenter = graphemeSegmenter();

  if (segmenter === undefined) {
    return Array.from(value);
  }

  try {
    return Array.from(segmenter.segment(value), ({ segment }) => segment);
  } catch {
    // A partially implemented or replaced Segmenter must not make masking fail. Retire it
    // for later calls as well; repeatedly invoking known-broken host code is both noisy
    // and unexpectedly expensive on a logging path.
    cachedSegmenter = undefined;

    return Array.from(value);
  }
}

/**
 * Return the nearest complete grapheme boundary at or before `limit`.
 *
 * `undefined` asks the caller to use its portable fallback. This is only used when a
 * string is actually being cut, so normal rendering does not pay segmentation cost.
 */
export function graphemeBoundaryAtOrBefore(
  value: string,
  limit: number,
): number | undefined {
  const segmenter = graphemeSegmenter();

  if (segmenter === undefined) {
    return undefined;
  }

  try {
    let boundary = 0;

    for (const { index, segment } of segmenter.segment(value)) {
      const end = index + segment.length;

      if (end > limit) {
        return index;
      }

      boundary = end;

      if (end === limit) {
        return end;
      }
    }

    return boundary;
  } catch {
    cachedSegmenter = undefined;

    return undefined;
  }
}
