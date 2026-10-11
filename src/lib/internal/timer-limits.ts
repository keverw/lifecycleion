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
 * the logger sinks all hand numbers to the same timer, and all of them must apply the
 * same bound.
 */
export const MAX_TIMER_MS = 2_147_483_647;

// Internal identity lets lifecycle operations classify configuration failures without
// mistaking an unrelated TypeError or RangeError thrown by application code for one.
const timeoutValidationErrors = new WeakSet<Error>();

function markTimeoutValidationError(error: Error): void {
  timeoutValidationErrors.add(error);
}

/** Whether this module itself rejected a timeout or delay value. */
export function isTimeoutValidationError(error: unknown): error is Error {
  return timeoutValidationErrors.has(error as Error);
}

function invalidTimeoutRange(label: string): RangeError {
  const error = new RangeError(`${label} must be non-negative`);
  markTimeoutValidationError(error);
  return error;
}

/**
 * Refuse a numeric option that names no number at all: NaN or a non-number.
 *
 * The rule every numeric option shares, durations and counts alike. A `NaN` is a parse or
 * arithmetic mistake upstream (`Number(env.MAX_QUEUE)` on an unset variable), not a
 * request for a default, so it fails where it was configured rather than being quietly
 * replaced. Numeric sentinels (`-1`, `0`, `Infinity`) are each caller's to interpret;
 * this deliberately does not erase those distinctions.
 */
export function assertNumberOption(
  requested: unknown,
  label: string,
): asserts requested is number {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    throw new TypeError(`${label} must be a number other than NaN`);
  }
}

/**
 * Validate the numeric part of a duration before interpreting API-specific sentinels.
 * {@link assertNumberOption}, with the rejection tagged so {@link isTimeoutValidationError}
 * can tell it apart from an unrelated `TypeError` thrown by application code.
 */
export function assertDurationMS(
  requested: unknown,
  label = 'Timeout',
): asserts requested is number {
  try {
    assertNumberOption(requested, label);
  } catch (error) {
    markTimeoutValidationError(error as Error);
    throw error;
  }
}

/**
 * Resolve an optional non-negative duration. Null and undefined select the default.
 * Invalid explicit values - NaN, non-numbers, negatives - fail before a timer or
 * operation is started, rather than silently disabling a deadline. Infinity and
 * oversized finite durations are not invalid: they clamp to the longest delay the
 * runtime can enforce, {@link MAX_TIMER_MS} (about 24.8 days), rather than overflowing
 * into an immediate timer. Zero is preserved here: each API decides whether it means
 * immediate or disabled.
 */
export function resolveTimeoutMS(
  requested: number | null | undefined,
  defaultMS: number,
  label = 'Timeout',
): number {
  return toTimerDelayMS(requested ?? defaultMS, label);
}

/** Clamp a numeric delay after the caller validates and interprets its sentinels.
 * NaN is deliberately not repaired here: it fails both comparisons and passes through.
 * `<= 0` normalizes negative zero.
 */
export function clampTimerDelayMS(delayMS: number): number {
  if (delayMS > MAX_TIMER_MS) {
    return MAX_TIMER_MS;
  }
  return delayMS <= 0 ? 0 : delayMS;
}

/** Validate a required lifecycle duration with no implicit fallback. */
export function toTimerDelayMS(requested: number, label = 'Timeout'): number {
  assertDurationMS(requested, label);
  if (requested < 0) {
    throw invalidTimeoutRange(label);
  }
  return clampTimerDelayMS(requested);
}

/**
 * Map an already validated handler budget's disabled zero to no deadline. This
 * deliberately does not validate again: callers must resolve their budget before
 * invoking the handler. Sink/queue budgets keep zero as an immediate deadline.
 */
export function optionalValidatedTimerDelayMS(
  timeoutMS: number,
): number | undefined {
  return timeoutMS === 0 ? undefined : timeoutMS;
}
