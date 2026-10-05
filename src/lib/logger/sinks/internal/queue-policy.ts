import { isNullish } from '../../../internal/is-nullish';

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

/** How long `close()` and `flush()` wait before giving up, unless the caller says. */
export const DEFAULT_CLOSE_TIMEOUT_MS = 30_000;

/**
 * The longest delay a timer can be given and still fire when asked.
 *
 * `setTimeout` reads a delay past `2^31 - 1` milliseconds as `1`, so `Infinity` - the
 * honest spelling of "wait as long as it takes" - fired the deadline *at once* and a
 * `close()` given it gave up on its init before the init could possibly finish.
 */
export { MAX_TIMER_MS } from '../../../internal/timer-limits';

export { resolveTimeoutMS } from '../../../internal/timer-limits';

/**
 * Refuse a count option that names no number at all.
 *
 * `NaN` and non-numbers used to take the default silently, while `closeTimeoutMS` in the
 * same options object threw for them - two validation rules in one config. A `NaN` here
 * is a parse or arithmetic mistake upstream (`Number(env.MAX_QUEUE)` on an unset
 * variable), and quietly substituting a default hides it, so these fail at construction
 * like the timeout does. Numeric sentinels (`-1`, `0`, `Infinity`) keep their documented
 * meanings; only values that are not numbers at all are refused.
 */
export function assertCountOption(
  requested: unknown,
  label: string,
): asserts requested is number {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    throw new TypeError(`${label} must be a number other than NaN`);
  }
}

/**
 * The cap a sink should enforce, or `undefined` for unlimited.
 *
 * @param requested What the caller asked for: a positive count, {@link UNLIMITED_QUEUE}
 *                  (or any negative number) for no cap, or `undefined`/`null` to take the
 *                  default. `NaN` or a non-number throws `TypeError` - see
 *                  {@link assertCountOption}. `0` takes the default too - a sink that queues nothing at all
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

  assertCountOption(requested, label);

  if (requested < 0) {
    return undefined;
  }

  if (requested === 0) {
    return DEFAULT_MAX_QUEUE_SIZE;
  }

  // `Infinity` is accepted as another spelling of unlimited rather than floored into a
  // cap no queue can reach.
  //
  // Floored to at least one, because `Math.floor` otherwise reached the very answer the
  // `requested === 0` guard above rejects: any fraction in `(0, 1)` - `0.5` - came out as
  // `0`, and `enforceQueueLimit`'s `while (queue.length > 0)` then evicted every entry as
  // it was queued. A cap of zero is refused however it is spelled.
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
 * {@link assertCountOption}.
 */
export function resolveMaxRetries(
  requested?: number | null,
  label = 'maxRetries',
): number {
  if (isNullish(requested)) {
    return DEFAULT_MAX_RETRIES;
  }

  assertCountOption(requested, label);

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
