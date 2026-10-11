import { isNullish } from '../../../internal/is-nullish';
import { assertNumberOption } from '../../../internal/timer-limits';

/**
 * What a queueing sink does when it cannot write, in one place.
 *
 * `FileSink` and `NamedPipeSink` both hold entries they could not hand over yet, and both
 * answer the same three questions here: how often a failed write is retried, how large the
 * queue may grow, and how long `close()` waits by default. What legitimately differs
 * between them - how a write is attempted, what "reopen" means, what the caller is handed
 * back - stays theirs.
 */

/**
 * Entries a sink holds before it starts discarding the oldest.
 *
 * Unbounded is the wrong default for a queue that only grows when something is already
 * wrong: a full disk or a pipe with no reader turns an ordinary logging loop into
 * unbounded memory growth. Every queued entry in both sinks holds a rendered line and
 * the `LogEntry`, including the caller's params graph by reference.
 *
 * Ten thousand lines is far more than any outage worth recovering from leaves behind, and
 * small enough to be irrelevant next to the process that produced them. A caller who
 * genuinely wants no cap asks for it by name; see {@link UNLIMITED_QUEUE}.
 */
export const DEFAULT_MAX_QUEUE_SIZE = 10_000;

/**
 * `maxQueueSize: -1` - hold everything, discard nothing.
 *
 * Spelled as a negative number rather than `0` or `Infinity` because those already mean
 * something else to a reader: `0` looks like "queue nothing" and `Infinity` is awkward to
 * write in JSON config. Any negative value is accepted, since `-1` is the spelling anyone
 * reaches for and the others cannot mean anything different.
 */
export const UNLIMITED_QUEUE = -1;

/** Attempts a failed write gets before the entry is given up on. */
export const DEFAULT_MAX_RETRIES = 3;

/** How long `close()` and `flush()` wait before giving up, unless the caller says. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

/**
 * Allow the final stream flush to finish even after close's drain budget expires.
 * A zero-ms deadline can beat the asynchronous finish event of a writable stream.
 */
export const MIN_CLOSE_FLUSH_MS = 100;

/**
 * The cap a sink should enforce, or `undefined` for unlimited.
 *
 * @param requested What the caller asked for: a positive count, {@link UNLIMITED_QUEUE}
 *                  (or any negative number) for no cap, or `undefined`/`null` to take the
 *                  default. `NaN` or a non-number throws `TypeError` - see
 *                  {@link assertNumberOption}. `0` takes the default too - a sink that queues nothing at all
 *                  cannot write anything before it is initialized, so honouring it would
 *                  read as "drop everything" and is far more likely to be a mistake than
 *                  an intention.
 */
export function resolveMaxQueueSize(
  requested?: number | null,
  label = 'maxQueueSize',
): number | undefined {
  if (isNullish(requested)) {
    return DEFAULT_MAX_QUEUE_SIZE;
  }

  assertNumberOption(requested, label);

  if (requested < 0) {
    return undefined;
  }

  if (requested === 0) {
    return DEFAULT_MAX_QUEUE_SIZE;
  }

  // `Infinity` is accepted as another spelling of unlimited rather than floored into a
  // cap no queue can reach.
  //
  // Floored to at least one, because `Math.floor` would otherwise reach the very answer
  // the `requested === 0` guard above rejects: any fraction in `(0, 1)` - `0.5` - comes
  // out as `0`, and `evictQueuedEntries`' `while (occupancy > limit)` would then evict
  // every entry as it was queued. A cap of zero is refused however it is spelled.
  return Number.isFinite(requested)
    ? Math.max(1, Math.floor(requested))
    : undefined;
}

/**
 * How many attempts a failed write gets, never fewer than the one it already had.
 *
 * A negative or zero value resolves to none rather than being honoured literally: the
 * entry is still written once, it simply is not retried. `Infinity` takes
 * {@link DEFAULT_MAX_RETRIES} (see below); `NaN` or a non-number throws `TypeError` - see
 * {@link assertNumberOption}.
 */
export function resolveMaxRetries(
  requested?: number | null,
  label = 'maxRetries',
): number {
  if (isNullish(requested)) {
    return DEFAULT_MAX_RETRIES;
  }

  assertNumberOption(requested, label);

  if (requested <= 0) {
    return 0;
  }

  // `Infinity` names no usable count and lands on the default, deliberately unlike its
  // spelling in `resolveMaxQueueSize`: an unlimited *cap* is a coherent request, while an
  // unlimited retry count is a write that can never be given up on - a failing sink
  // holding the same entry at the front of its queue forever. It is treated as the
  // unusable request it is, not as "always".
  return Number.isFinite(requested)
    ? Math.floor(requested)
    : DEFAULT_MAX_RETRIES;
}
