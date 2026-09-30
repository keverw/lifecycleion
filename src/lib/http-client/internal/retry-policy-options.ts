import { RetryPolicy } from '../../retry-utils';
import type { RetryPolicyOptions } from '../../retry-utils';

/** Validate once at the public configuration boundary and retain plain policy data. */
export function snapshotRetryPolicyOptions(
  options: RetryPolicyOptions,
): RetryPolicyOptions {
  return new RetryPolicy(options).policyInfo;
}
