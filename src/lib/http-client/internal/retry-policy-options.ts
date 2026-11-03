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
/** Either strategy's: the fields checked before the strategy is known. */
const ANY_STRATEGY_FIELDS = [
  ...new Set([...FIXED_FIELDS, ...EXPONENTIAL_FIELDS]),
];

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
  // A misspelled field (`maxRetryAttemps: 5`, meant to raise the limit), or the other
  // strategy's (`delayMS` on an exponential policy), would be read as absent and the
  // default applied. One that neither strategy takes is refused first, before a value
  // is read, so a typo is named ahead of a bad value beside it.
  assertKnownFields(options, ANY_STRATEGY_FIELDS, 'HTTPClient retryPolicy');
  // Built before the other strategy's fields are refused, so they are checked against the
  // strategy it resolved - read once, a getter's included.
  const snapshot = Object.freeze(new RetryPolicy(options).policyInfo);
  assertKnownFields(
    options,
    retryPolicyFields(snapshot.strategy),
    'HTTPClient retryPolicy',
  );
  // Normalized policies contain only primitive fields. Brand only our frozen
  // copies, so inheritance can reuse them without trusting mutable caller data.
  validatedSnapshots.add(snapshot);
  return snapshot;
}
