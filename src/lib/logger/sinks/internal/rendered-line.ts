import { toError } from '../../../to-error';

/**
 * A log line rendered exactly once, at `write()` time, with its failure kept.
 *
 * Both queueing sinks render here rather than at flush time, and the reason is not
 * performance. `entry.redactedParams` is not a snapshot: the bag is fresh, but copies below
 * it are built only along the branches that led to a mask, so every subtree that held
 * nothing redacted is the caller's own object by reference. Serializing after an `await` -
 * after `setupLogFile` and `rotateIfNeeded`, or after a pipe outage - writes whatever the
 * caller has done to it since. Verified: a bag reused across log calls wrote a secret added
 * *after* the call, under a key named in `redactedKeys` that had masked nothing because the
 * key did not exist yet.
 *
 * A render that **threw** is kept rather than retried, and that is the half that looks like
 * an over-correction and is not. Whatever made `JSON.stringify` throw usually sits in one of
 * those shared subtrees, so the caller removing it is precisely what lets a second render
 * succeed - carrying with it anything else that changed in the meantime. Verified too: a
 * `BigInt` under `params.user`, deleted after the log call along with
 * `params.user.token = '<secret>'` set on the same shared object, wrote that token to the
 * file in clear text.
 *
 * Shared because the invariant is one rule and the two sinks had it written out twice, in
 * prose that overlapped almost sentence for sentence. What they legitimately differ on stays
 * theirs: `FileSink` keeps the `LogEntry` and an attempt count, because its public `onError`
 * hands the entry back to the caller and it retries; `NamedPipeSink` deliberately drops the
 * entry so an outage does not pin the caller's params graph, and never retries at all.
 */
export interface RenderedLine {
  /** The line to write, or `undefined` when rendering it threw. */
  formatted: string | undefined;
  /**
   * The failure from rendering, carried through the sink's ordinary failure path so
   * `onError` and the failure counters see it - but never through a retry, since a render
   * this refuses to repeat cannot come out differently on a second attempt.
   */
  formatError: Error | undefined;
}

/**
 * Render a line now, keeping a failure instead of the chance to try again.
 *
 * @param format Produces the line. Called exactly once, while the caller's stack is still
 *               held, whether the entry goes out immediately or waits in a queue.
 */
export function renderOnce(format: () => string): RenderedLine {
  try {
    return { formatted: format(), formatError: undefined };
  } catch (error) {
    // Normalized rather than trusted: a caller-supplied `formatter` is free to throw any
    // value, and the sinks declare an `Error`.
    return { formatted: undefined, formatError: toError(error) };
  }
}
