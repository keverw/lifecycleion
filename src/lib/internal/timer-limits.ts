/**
 * The longest delay a timer can be given and still fire when it was asked to.
 *
 * `setTimeout` keeps its delay in a signed 32-bit integer, so anything past `2^31 - 1`
 * milliseconds (about 24.8 days) is coerced to `1` - the timer fires on the next tick
 * rather than in a month. Every "wait this long" number that reaches a timer is bounded
 * by this, because the failure is silent and inverted: the longer the wait a caller
 * writes, the sooner it happens, and a retry policy or a close deadline that reads as
 * patient becomes a busy loop.
 *
 * Held here rather than in any one module because the retry policy, the HTTP client and
 * the logger sinks all hand numbers to the same timer and had drifted to three copies of
 * the constant, only two of which were applied.
 */
export const MAX_TIMER_MS = 2_147_483_647;
