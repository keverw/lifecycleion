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

/**
 * The fields of the strategy `options` names as an own data value, or `undefined` for one
 * it does not: a getter is left unread here, for `RetryPolicy` to read once.
 */
function declaredStrategyFields(
  options: RetryPolicyOptions,
): readonly string[] | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'strategy');
  const strategy: unknown =
    descriptor !== undefined && 'value' in descriptor
      ? descriptor.value
      : undefined;

  return strategy === 'fixed' || strategy === 'exponential'
    ? retryPolicyFields(strategy)
    : undefined;
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
  // default applied. Both are refused first, before a value is read, so they are named
  // ahead of a bad value beside it: against the strategy's fields where `strategy` is an
  // own data value one names, which the refusal then lists, and otherwise against those
  // either strategy takes.
  const declaredFields = declaredStrategyFields(options);
  assertKnownFields(
    options,
    declaredFields ?? ANY_STRATEGY_FIELDS,
    'HTTPClient retryPolicy',
  );
  const snapshot = Object.freeze(new RetryPolicy(options).policyInfo);
  // Otherwise - a getter's `strategy`, or none - the other strategy's fields are refused
  // once `RetryPolicy` has resolved it, so the getter is read once.
  if (declaredFields === undefined) {
    assertKnownFields(
      options,
      retryPolicyFields(snapshot.strategy),
      'HTTPClient retryPolicy',
    );
  }
  // Normalized policies contain only primitive fields. Brand only our frozen
  // copies, so inheritance can reuse them without trusting mutable caller data.
  validatedSnapshots.add(snapshot);
  return snapshot;
}
