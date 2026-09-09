import { readMember, readUnknownMember } from '../../internal/read-member';
import { isErrorValue } from '../../to-error';
import { clamp } from '../../clamp';

interface ExponentialDelayParams {
  retryCount: number;
  minTimeoutMS: number;
  maxTimeoutMS: number;
  factor: number;
  dispersion: number;
  // Provide a function for randomness to make testing easier
  randomFn: () => number;
}

export function calculateExponentialDelay({
  retryCount,
  minTimeoutMS,
  maxTimeoutMS,
  factor,
  dispersion,
  randomFn,
}: ExponentialDelayParams): number {
  let delay = minTimeoutMS * Math.pow(factor, retryCount);

  if (dispersion > 0) {
    const dispersionAmount = delay * dispersion;
    // Apply dispersion jitter using the documented formula:
    // randomOffset = (Math.random() * 2 - 1) * (delay * dispersion)
    // Algebraically equivalent to: Math.random() * (dispersionAmount * 2) - dispersionAmount
    delay += randomFn() * (dispersionAmount * 2) - dispersionAmount;
  }

  // Use a clamp function to simplify bounds checking
  return clamp(delay, minTimeoutMS, maxTimeoutMS);
}

/**
 * Extracts a string message from an error value for grouping purposes.
 *
 * Every read is guarded, and the reason is what this feeds: `getMostCommonError` is
 * reached from `RetryPolicy.mostCommonError`, a public getter, holding whatever the
 * retried operation threw. `message` and `error` are ordinary properties a subclass or a
 * `Proxy` can turn into throwing accessors, `in` is a trappable operation, and `String()`
 * invokes a `toString` this module does not own - so an unguarded read here threw out of a
 * property access the caller made in order to *report* a failure, replacing the failure
 * with one of its own.
 *
 * The value is only ever a grouping key, so an unreadable member is treated as absent and
 * the value falls through to the next strategy. Two errors that both refuse to be read
 * group together under the same placeholder, which is the honest answer: nothing
 * distinguishes them from here. Reference-equality grouping runs alongside this in
 * `getMostCommonError` and is unaffected.
 */
function extractErrorMessage(error: unknown): string {
  // The shared brand check rather than a bare `instanceof`: an error from a `vm` context
  // or an iframe fails this realm's check while being an error in every respect, and the
  // guarded form also survives a revoked `Proxy`.
  if (isErrorValue(error)) {
    const message = readMember(error, 'message');

    if (typeof message === 'string') {
      return message;
    }
  }

  // An object carrying a string `message`.
  const ownMessage = readUnknownMember(error, 'message');

  if (typeof ownMessage === 'string') {
    return ownMessage;
  }

  // An object wrapping the real failure under `error`.
  const nested = readUnknownMember(error, 'error');

  if (nested !== undefined) {
    const nestedMessage = readUnknownMember(nested, 'message');

    if (typeof nestedMessage === 'string') {
      return nestedMessage;
    }

    return describeValue(nested);
  }

  // Fall back to string conversion
  return describeValue(error);
}

/** `String(value)` without letting a `toString` or `Symbol.toPrimitive` escape. */
function describeValue(value: unknown): string {
  try {
    return String(value);
  } catch {
    return '<unreadable error>';
  }
}

export function getMostCommonError(errors: unknown[]): unknown {
  if (errors.length === 0) {
    return null;
  }

  // Strategy 1: Count by reference equality (===).
  // Handles reused error objects and guards against unstable message extraction.
  const refCounts = new Map<unknown, number>();

  for (const error of errors) {
    refCounts.set(error, (refCounts.get(error) ?? 0) + 1);
  }

  // Strategy 2: Count by extracted message string.
  // Groups distinct error objects that represent the same logical error.
  const messageCounts = new Map<string, { count: number; error: unknown }>();

  for (const error of errors) {
    const message = extractErrorMessage(error);
    const existing = messageCounts.get(message);

    if (existing) {
      existing.count += 1;
    } else {
      messageCounts.set(message, { count: 1, error });
    }
  }

  // Pick the winner across both strategies (highest count wins).
  let mostCommon: unknown = null;
  let maxCount = 0;

  for (const [error, count] of refCounts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = error;
    }
  }

  for (const { count, error } of messageCounts.values()) {
    if (count > maxCount) {
      maxCount = count;
      mostCommon = error;
    }
  }

  return mostCommon;
}
