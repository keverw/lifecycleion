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
/** The fields a policy of `strategy` - as `RetryPolicy` resolved it - may hold. */
function retryPolicyFields(
  strategy: RetryPolicyOptions['strategy'],
): readonly string[] {
  return strategy === 'fixed' ? FIXED_FIELDS : EXPONENTIAL_FIELDS;
}

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
  // Built first, so the fields are checked against the strategy it resolved - read once,
  // a getter's included - and an unknown strategy is its to refuse.
  const snapshot = Object.freeze(new RetryPolicy(options).policyInfo);
  // A misspelled field (`maxRetryAttemps: 5`, meant to raise the limit), or the other
  // strategy's (`delayMS` on an exponential policy), would be read as absent and the
  // default applied.
  assertKnownFields(
    options,
    retryPolicyFields(snapshot.strategy),
    'HTTPClient retryPolicy',
  );
  validatedSnapshots.add(snapshot);
  return snapshot;
}
