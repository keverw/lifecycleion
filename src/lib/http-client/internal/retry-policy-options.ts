import { RetryPolicy } from '../../retry-utils';
import type {
  RetryPolicyOptionsStrategyExponential,
  RetryPolicyOptionsStrategyFixed,
  RetryPolicyOptions,
} from '../../retry-utils';
import { assertKnownFields, fieldNames } from '../../internal/known-fields';

/** The fields each strategy takes; any other is refused as misspelled. */
const FIXED_FIELDS = fieldNames<RetryPolicyOptionsStrategyFixed>({
  strategy: true,
  maxRetryAttempts: true,
  delayMS: true,
});
const EXPONENTIAL_FIELDS = fieldNames<RetryPolicyOptionsStrategyExponential>({
  strategy: true,
  maxRetryAttempts: true,
  factor: true,
  minTimeoutMS: true,
  maxTimeoutMS: true,
  dispersion: true,
});
/** Either strategy's, for a policy whose strategy is not an own data value. */
const ANY_STRATEGY_FIELDS = [
  ...new Set([...FIXED_FIELDS, ...EXPONENTIAL_FIELDS]),
];

/**
 * The fields `options` may hold: its strategy's, told by an own `strategy` data value - read
 * by descriptor, so a getter is left for `RetryPolicy` to read once - and otherwise either
 * strategy's, as an unknown strategy is `RetryPolicy`'s to refuse.
 */
function retryPolicyFields(options: RetryPolicyOptions): readonly string[] {
  const strategy: unknown = Object.getOwnPropertyDescriptor(
    options,
    'strategy',
  )?.value;

  return strategy === 'fixed'
    ? FIXED_FIELDS
    : strategy === 'exponential'
      ? EXPONENTIAL_FIELDS
      : ANY_STRATEGY_FIELDS;
}

const validatedSnapshots = new WeakSet<RetryPolicyOptions>();

/** Validate once at the public configuration boundary and retain plain policy data. */
export function snapshotRetryPolicyOptions(
  options: RetryPolicyOptions,
): RetryPolicyOptions {
  if (validatedSnapshots.has(options)) {
    return options;
  }
  // A misspelled field (`maxRetryAttemps: 5`, meant to raise the limit), or the other
  // strategy's (`delayMS` on an exponential policy), would be read as absent and the
  // default applied.
  assertKnownFields(
    options,
    retryPolicyFields(options),
    'HTTPClient retryPolicy',
  );
  // Normalized policies contain only primitive fields. Brand only our frozen
  // copies, so inheritance can reuse them without trusting mutable caller data.
  const snapshot = Object.freeze(new RetryPolicy(options).policyInfo);
  validatedSnapshots.add(snapshot);
  return snapshot;
}
