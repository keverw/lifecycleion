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
 */
function extractErrorMessage(error: unknown): string {
  // Check if it's an Error instance (most common case)
  if (error instanceof Error) {
    return error.message;
  }

  // Check if it's an object with a 'message' property
  if (
    error !== null &&
    error !== undefined &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  // Check if it's an object with an 'error' property (nested error)
  if (
    error !== null &&
    error !== undefined &&
    typeof error === 'object' &&
    'error' in error
  ) {
    const nested = (error as { error: unknown }).error;

    if (nested instanceof Error) {
      return nested.message;
    } else if (
      nested !== null &&
      nested !== undefined &&
      typeof nested === 'object' &&
      'message' in nested &&
      typeof (nested as { message: unknown }).message === 'string'
    ) {
      return (nested as { message: string }).message;
    } else {
      return String(nested);
    }
  }

  // Fall back to string conversion
  return String(error);
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
