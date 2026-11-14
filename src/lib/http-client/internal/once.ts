/**
 * `compute` run the first time the answer is asked for, and its outcome kept: the value it
 * returned, answered to every later ask, or the error it threw, thrown again to each -
 * never computed a second time. `compute` is let go of once it has run, so what it holds
 * is not kept beside its outcome. An ask made while `compute` is still running - from a
 * getter it reads that reaches the same answer - throws an error that says so, which is
 * the outcome only if `compute` lets it escape.
 */
export function once<T>(compute: () => T): () => T {
  let pending: (() => T) | undefined = compute;
  let outcome: { value: T } | { error: unknown } | undefined;

  return () => {
    if (outcome === undefined) {
      const run = pending;

      if (run === undefined) {
        throw new Error(
          'HTTPClient value read again while it was being computed',
        );
      }

      pending = undefined;
      try {
        outcome = { value: run() };
      } catch (error) {
        outcome = { error };
      }
    }

    if ('error' in outcome) {
      throw outcome.error;
    }

    return outcome.value;
  };
}
