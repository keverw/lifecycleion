import { RetryPolicy } from '../../retry-utils';
import type {
  RetryPolicyOptionsStrategyExponential,
  RetryPolicyOptionsStrategyFixed,
  RetryPolicyOptions,
} from '../../retry-utils';
import { assertKnownFields, fieldNames } from '../../internal/known-fields';
import { isObjectLike } from '../../internal/is-object-like';
import { isNullish } from '../../internal/is-nullish';
import { defineEntry } from '../../internal/define-entry';

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

/** The fields a policy of `strategy` may hold. */
function retryPolicyFields(
  strategy: RetryPolicyOptions['strategy'],
): readonly string[] {
  return strategy === 'fixed' ? FIXED_FIELDS : EXPONENTIAL_FIELDS;
}

const RETRY_POLICY_LABEL = 'HTTPClient retryPolicy';

const validatedSnapshots = new WeakSet<RetryPolicyOptions>();

/**
 * `options`' own enumerable keys as they stand now, each holding its own data value where
 * that is nullish and `true` otherwise: what `assertKnownFields` reads of them, kept
 * before any of its getters runs. A key is copied as an entry, so `__proto__` is one too.
 */
function keyShape(options: object): Record<string, true | null | undefined> {
  const shape: Record<string, true | null | undefined> = {};
  for (const key of Object.keys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    defineEntry(
      shape,
      key,
      descriptor !== undefined &&
        'value' in descriptor &&
        isNullish(descriptor.value)
        ? descriptor.value
        : true,
    );
  }
  return shape;
}

/** Validate once at the public configuration boundary and retain plain policy data. */
export function snapshotRetryPolicyOptions(
  options: RetryPolicyOptions,
): RetryPolicyOptions {
  if (validatedSnapshots.has(options)) {
    return options;
  }
  // A function is no options object, though `RetryPolicy` would read it as one: refused,
  // as its fields could not be checked.
  if (typeof options === 'function') {
    throw new TypeError(
      `${RETRY_POLICY_LABEL} must be an object (got function)`,
    );
  }
  // Any other value that is not an object: `RetryPolicy` refuses it as one, so this never
  // returns.
  if (!isObjectLike(options)) {
    return Object.freeze(new RetryPolicy(options).policyInfo);
  }
  // A misspelled field (`maxRetryAttemps: 5`, meant to raise the limit), or the other
  // strategy's (`delayMS` on an exponential policy), would be read as absent and the
  // default applied. Both are refused before a value is checked, so they are named ahead
  // of a bad value beside it, against the fields of the strategy `strategy` names. The
  // keys are taken before any getter runs - a `strategy` getter's included, which could
  // remove one - and judged once the strategy is read.
  const shape = keyShape(options);
  // Read once - a getter's included - as the one value `RetryPolicy` is then handed.
  const strategy: unknown = options.strategy;

  if (strategy !== 'fixed' && strategy !== 'exponential') {
    assertKnownFields(shape, ANY_STRATEGY_FIELDS, RETRY_POLICY_LABEL);
    // `RetryPolicy` refuses the strategy, handed it as a plain value so a getter is not
    // read again: this never returns.
    return Object.freeze(
      new RetryPolicy({ strategy } as unknown as RetryPolicyOptions).policyInfo,
    );
  }

  const fields = retryPolicyFields(strategy);
  assertKnownFields(shape, fields, RETRY_POLICY_LABEL);

  // That strategy's fields, each read once, into a plain policy `RetryPolicy` reads.
  const source = options as unknown as Record<string, unknown>;
  const plain: Record<string, unknown> = { strategy };
  for (const field of fields) {
    if (field !== 'strategy') {
      plain[field] = source[field];
    }
  }

  // And again once every getter has run: one that added a field it does not take - a
  // misspelling - is refused rather than left at the default.
  assertKnownFields(options, fields, RETRY_POLICY_LABEL);

  const snapshot = Object.freeze(
    new RetryPolicy(plain as unknown as RetryPolicyOptions).policyInfo,
  );
  // Normalized policies contain only primitive fields. Brand only our frozen
  // copies, so inheritance can reuse them without trusting mutable caller data.
  validatedSnapshots.add(snapshot);
  return snapshot;
}
