import { RetryPolicy } from '../../retry-utils';
import type { RetryPolicyOptions } from '../../retry-utils';

const validatedSnapshots = new WeakSet<RetryPolicyOptions>();

/** Validate once at the public configuration boundary and retain plain policy data. */
export function snapshotRetryPolicyOptions(
  options: RetryPolicyOptions,
): RetryPolicyOptions {
  if (validatedSnapshots.has(options)) {
    return options;
  }
  // Normalized policies contain only primitive fields. Brand only our frozen
  // copies, so inheritance can reuse them without trusting mutable caller data.
  const snapshot = Object.freeze(new RetryPolicy(options).policyInfo);
  validatedSnapshots.add(snapshot);
  return snapshot;
}
