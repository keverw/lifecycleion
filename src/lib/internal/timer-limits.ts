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

// Internal identity lets lifecycle operations classify configuration failures without
// mistaking an unrelated TypeError or RangeError thrown by application code for one.
const timeoutValidationErrors = new WeakSet<Error>();

/** Whether this module itself rejected a timeout or delay value. */
export function isTimeoutValidationError(error: unknown): error is Error {
  return (
    typeof error === 'object' &&
    error !== null &&
    timeoutValidationErrors.has(error as Error)
  );
}

function invalidTimeoutType(label: string): TypeError {
  const error = new TypeError(`${label} must be a number other than NaN`);
  timeoutValidationErrors.add(error);
  return error;
}

function invalidTimeoutRange(label: string): RangeError {
  const error = new RangeError(`${label} must be non-negative`);
  timeoutValidationErrors.add(error);
  return error;
}

/**
 * Validate the numeric part of a duration before interpreting API-specific sentinels.
 * NaN and non-numbers are configuration mistakes, not requests for a default or an
 * unlimited wait. Callers decide whether negative values or Infinity have a meaning;
 * this helper deliberately does not erase those distinctions.
 */
export function assertDurationMS(
  requested: unknown,
  label = 'Timeout',
): asserts requested is number {
  if (typeof requested !== 'number' || Number.isNaN(requested)) {
    throw invalidTimeoutType(label);
  }
}

/**
 * Resolve an optional non-negative duration. Null and undefined select the default.
 * Invalid explicit values fail before a timer or operation is started, rather than
 * silently disabling a deadline or turning a typo into a multi-week wait. Infinity
 * and oversized finite durations retain the longest delay the runtime can enforce.
 * Zero is preserved here: each API decides whether it means immediate or disabled.
 */
export function resolveTimeoutMS(
  requested: number | null | undefined,
  defaultMS: number,
  label = 'Timeout',
): number {
  return toTimerDelayMS(requested ?? defaultMS, label);
}

/** Validate a required lifecycle duration with no implicit fallback. */
export function toTimerDelayMS(requested: number, label = 'Timeout'): number {
  assertDurationMS(requested, label);
  if (requested < 0) {
    throw invalidTimeoutRange(label);
  }
  // Math.max converts -0 to +0; downstream zero checks have one representation.
  return Math.max(0, Math.min(requested, MAX_TIMER_MS));
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
