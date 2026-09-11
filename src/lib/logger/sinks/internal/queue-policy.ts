/**
 * What a queueing sink does when it cannot write, in one place.
 *
 * `FileSink` and `NamedPipeSink` both hold entries they could not hand over yet, and they
 * had answered the same three questions differently for no reason anyone chose. A failed
 * write was retried three times by one and not at all by the other; a queue was capped
 * only if the caller thought to ask, so the default on both was *unbounded*, which on the
 * unhealthy path is the one place a logger can least afford to grow without limit; and a
 * pipe whose stream had failed dropped every later entry on the floor while a file whose
 * stream had failed reopened it and carried on.
 *
 * The policy below is the one both now follow. What legitimately differs between them -
 * how a write is attempted, what "reopen" means, what the caller is handed back - stays
 * theirs.
 */

/**
 * Entries a sink holds before it starts discarding the oldest.
 *
 * A default, where both sinks previously had none. Unbounded is the wrong default for a
 * queue that only grows when something is already wrong: a full disk or a pipe with no
 * reader turns an ordinary logging loop into unbounded memory growth, and every queued
 * entry holds a rendered line - `FileSink`'s also holds the `LogEntry`, and with it the
 * caller's params graph by reference.
 *
 * Ten thousand lines is far more than any outage worth recovering from leaves behind, and
 * small enough to be irrelevant next to the process that produced them. A caller who
 * genuinely wants the old behaviour asks for it by name; see {@link UNLIMITED_QUEUE}.
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

/**
 * The cap a sink should enforce, or `undefined` for unlimited.
 *
 * @param requested What the caller asked for: a positive count, {@link UNLIMITED_QUEUE}
 *                  (or any negative number) for no cap, or `undefined` to take the
 *                  default. `0` takes the default too - a sink that queues nothing at all
 *                  cannot write anything before it is initialized, so honouring it would
 *                  read as "drop everything" and is far more likely to be a mistake than
 *                  an intention.
 */
export function resolveMaxQueueSize(requested?: number): number | undefined {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    return DEFAULT_MAX_QUEUE_SIZE;
  }

  if (requested < 0) {
    return undefined;
  }

  if (requested === 0) {
    return DEFAULT_MAX_QUEUE_SIZE;
  }

  // `Infinity` is accepted as another spelling of unlimited rather than floored into a
  // cap no queue can reach.
  return Number.isFinite(requested) ? Math.floor(requested) : undefined;
}

/**
 * How many attempts a failed write gets, never fewer than the one it already had.
 *
 * A negative or absurd value resolves to none rather than being honoured literally: the
 * entry is still written once, it simply is not retried.
 */
export function resolveMaxRetries(requested?: number): number {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    return DEFAULT_MAX_RETRIES;
  }

  if (requested <= 0) {
    return 0;
  }

  return Number.isFinite(requested)
    ? Math.floor(requested)
    : DEFAULT_MAX_RETRIES;
}
