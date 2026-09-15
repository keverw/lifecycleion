import { snapshotMembers } from '../../internal/read-member';
import type { HandleLogOptions } from '../internal-types';

/** Every member `handleLog` and its callers read off a caller-supplied options bag. */
const HANDLE_LOG_OPTION_KEYS = [
  'exitCode',
  'params',
  'tags',
  'redactedKeys',
  'serviceName',
  'entityName',
  'error',
] as const satisfies readonly (keyof HandleLogOptions)[];

/**
 * Fails to compile if `HandleLogOptions` grows a member the list above does not name.
 *
 * `satisfies readonly (keyof HandleLogOptions)[]` only checks that every listed key is
 * *valid*, not that every key is *listed* - so adding a field to `LogOptions` would
 * compile cleanly and then never reach `handleLog`, and would also be dropped from all
 * eight `LoggerService` spreads, which used to forward the bag wholesale. This assignment
 * is the other half of that check and has no runtime cost.
 */
type UnsnapshottedOption = Exclude<
  keyof HandleLogOptions,
  (typeof HANDLE_LOG_OPTION_KEYS)[number]
>;
type AssertNever<T extends never> = T;
export type NoUnsnapshottedOptions = AssertNever<UnsnapshottedOption>;

/**
 * A caller's log options, read once, into an object this module owns.
 *
 * `logger.info()` promises never to throw, and `stringifyValue` keeps that promise for the
 * *values* by snapshotting its own options bag - but the logger read its own bag
 * unguarded, above every `try`. `logger.info('pw={{password}}', { params, get
 * redactedKeys() { throw } })` threw straight out of the call and wrote nothing, and the
 * spreads in `errorObject` and `LoggerService` threw one frame earlier still, before
 * `handleLog` was even entered. A `Proxy` or a getter is all it takes, and these bags come
 * from callers.
 *
 * Reading each member once also removes the second answer: a getter that reports one list
 * to the gate and another to the walk is the shape the `snapshotList` guards below were
 * written for, and this closes the same gap one level up, on the bag rather than the list.
 *
 * `redactedKeys` fails closed rather than absent - see `snapshotMembers`' `unreadableAs`.
 * Absent means "no redaction requested", which renders the params in the clear; `null` is
 * "supplied but unusable", which is what a bag that will not answer actually is, and it
 * lands on the `<redactedKeys>` fail-closed branch `handleLog` already has.
 *
 * @param options - The caller's options bag, or `undefined`.
 * @returns A plain object holding each option, safe to read repeatedly. Never throws.
 */
export type SnapshotLogOptions = Omit<HandleLogOptions, 'redactedKeys'> & {
  /**
   * `null` when the caller's `redactedKeys` getter refused to be read: supplied, but
   * unusable. Distinct from `undefined`, which means no redaction was requested.
   */
  redactedKeys?: string[] | null;
};

export function snapshotLogOptions(
  options: SnapshotLogOptions | undefined,
): SnapshotLogOptions {
  return snapshotMembers(options, HANDLE_LOG_OPTION_KEYS, {
    redactedKeys: null,
  });
}
