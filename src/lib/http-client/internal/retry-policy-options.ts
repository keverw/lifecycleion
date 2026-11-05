import { RetryPolicy } from '../../retry-utils';
import type {
  RetryPolicyOptionsStrategyExponential,
  RetryPolicyOptionsStrategyFixed,
  RetryPolicyOptions,
} from '../../retry-utils';
import {
  assertKnownFields,
  assertOptionsObject,
  fieldNames,
} from '../../internal/known-fields';
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

/**
 * Validate once at the public configuration boundary and retain plain policy data. A
 * refusal names `label`, the API the policy was handed to.
 */
export function snapshotRetryPolicyOptions(
  options: RetryPolicyOptions,
  label: string,
): RetryPolicyOptions {
  if (validatedSnapshots.has(options)) {
    return options;
  }
  // A function is no options object, though `RetryPolicy` would read it as one, nor is an
  // array: refused as any other value that is not one, as their fields could not be checked.
  assertOptionsObject(options, label);
  // A misspelled field (`maxRetryAttemps: 5`, meant to raise the limit), or the other
  // strategy's (`delayMS` on an exponential policy), would be read as absent and the
  // default applied. Both are refused before a value is checked, so they are named ahead
  // of a bad value beside it, against the fields of the strategy `strategy` names. The
  // keys are taken before any getter runs - a `strategy` getter's included, which could
  // remove one - and judged once the strategy is read.
  const shape = keyShape(options);
  // Read once - a getter's included - as the one value `RetryPolicy` is then handed.
  let strategy: unknown;
  try {
    strategy = options.strategy;
  } catch (error) {
    // A misspelling is still named ahead of the getter's own failure.
    assertKnownFields(shape, ANY_STRATEGY_FIELDS, label);
    throw error;
  }

  if (strategy !== 'fixed' && strategy !== 'exponential') {
    // Named ahead of the strategy's refusal: one there before the getter ran, and one it
    // added.
    assertKnownFields(shape, ANY_STRATEGY_FIELDS, label);
    assertKnownFields(options, ANY_STRATEGY_FIELDS, label);
    // `RetryPolicy` refuses the strategy, handed it as a plain value so a getter is not
    // read again: this never returns.
    return Object.freeze(
      new RetryPolicy({ strategy } as unknown as RetryPolicyOptions).policyInfo,
    );
  }

  const fields = retryPolicyFields(strategy);
  assertKnownFields(shape, fields, label);

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
  assertKnownFields(options, fields, label);

  const snapshot = Object.freeze(
    new RetryPolicy(plain as unknown as RetryPolicyOptions).policyInfo,
  );
  // Normalized policies contain only primitive fields. Brand only our frozen
  // copies, so inheritance can reuse them without trusting mutable caller data.
  validatedSnapshots.add(snapshot);
  return snapshot;
}
