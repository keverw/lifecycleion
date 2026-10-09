import { isNullish } from '../../internal/is-nullish';
import { finiteClampMin } from '../../clamp';
import {
  assertDurationMS,
  resolveTimeoutMS,
  toTimerDelayMS,
} from '../../internal/timer-limits';
import type {
  LifecycleManagerOptions,
  RepeatedShutdownRequestPolicy,
} from '../types';

/**
 * A shutdown pass's options, resolved against the manager's defaults.
 *
 * Resolved by the acceptance step rather than by the pass, so the validation that could
 * throw happens on the side of the latch where a throw costs nothing. The caller's
 * options were read before that, into a snapshot.
 */
export interface ShutdownPassOptions {
  /**
   * Already validated and clamped to a usable timer delay by `resolveOperationTimeoutMS()`
   * - the call's own value, or the constructor's `shutdownOptions.timeoutMS` (itself
   * resolved by `resolveTimeoutMS()`); `0` means no timer.
   */
  readonly timeoutMS: number;
  readonly retryStalled: boolean;
  readonly haltOnStall: boolean;
  readonly allowStopWithPendingStarts: boolean;
  readonly waitForAbandonedStarts: boolean;
  readonly abortPendingStarts: boolean;
}

/** The constructor's `repeatedShutdownRequestPolicy`, validated and defaulted. */
export interface RepeatedShutdownPolicyConfig {
  readonly forceAfterCount: number;
  readonly withinMS: number;
  readonly armedAfterFailureMS: number;
  readonly countManualRetriesTowardEscalation: boolean;
  readonly hasExplicitArmedAfterFailureMS: boolean;
  readonly onForceShutdown: RepeatedShutdownRequestPolicy['onForceShutdown'];
}

/**
 * The manager's constructor options, validated and defaulted once. Frozen: nothing
 * here changes after construction.
 */
export interface ManagerConfig {
  readonly name: string;
  readonly shutdownWarningTimeoutMS: number;
  readonly messageTimeoutMS: number;
  readonly startupTimeoutMS: number;
  readonly shutdownOptions: ShutdownPassOptions;
  readonly attachSignalsBeforeStartup: boolean;
  readonly attachSignalsOnStart: boolean;
  readonly detachSignalsOnStop: boolean;
  readonly repeatedShutdownRequestPolicy:
    RepeatedShutdownPolicyConfig | undefined;
  readonly onReloadRequested: LifecycleManagerOptions['onReloadRequested'];
  readonly onInfoRequested: LifecycleManagerOptions['onInfoRequested'];
  readonly onDebugRequested: LifecycleManagerOptions['onDebugRequested'];
}

/**
 * Validate and default the constructor's options, reading each one once, in this
 * order. `name` is resolved by the constructor first, which builds the service logger
 * from it before any of these is validated.
 *
 * Invalid configuration is refused before registering signal/exit hooks. Constructor
 * failures are synchronous and have no lifecycle result net to classify, so they use
 * the unbranded shared timer helpers: a caller can construct another manager inside a
 * component getter, and its validation error must not become this manager's refusal.
 */
export function resolveManagerConfig(
  name: string,
  options: LifecycleManagerOptions,
): ManagerConfig {
  // Warning timeouts retain their documented negative opt-out; other durations do not
  // have a negative sentinel. Null and undefined select a configured default.
  const requestedWarningTimeout = options.shutdownWarningTimeoutMS;
  const warningTimeout = requestedWarningTimeout ?? 500;
  assertDurationMS(warningTimeout, 'shutdownWarningTimeoutMS');
  const shutdownWarningTimeoutMS =
    warningTimeout < 0 ? -1 : toTimerDelayMS(warningTimeout);
  const messageTimeoutMS = resolveTimeoutMS(
    options.messageTimeoutMS,
    5000,
    'messageTimeoutMS',
  );
  const startupTimeoutMS = resolveTimeoutMS(
    options.startupTimeoutMS,
    60000,
    'startupTimeoutMS',
  );
  // Each field read once, off the caller's object itself, so inherited and
  // non-enumerable ones - a class getter's timeout - count like own fields; a spread
  // copy would drop them.
  const {
    timeoutMS: shutdownTimeoutMS,
    retryStalled: shouldRetryStalled,
    haltOnStall: shouldHaltOnStall,
    allowStopWithPendingStarts,
    waitForAbandonedStarts: shouldWaitForAbandonedStarts,
    abortPendingStarts: shouldAbortPendingStarts,
  } = options.shutdownOptions ?? {};
  // Only the literal non-default value switches an option, so untyped config such as
  // `0` or `'yes'` keeps the default instead of being stored as a non-boolean.
  const shutdownOptions: ShutdownPassOptions = Object.freeze({
    retryStalled: shouldRetryStalled !== false,
    haltOnStall: shouldHaltOnStall !== false,
    allowStopWithPendingStarts: allowStopWithPendingStarts === true,
    waitForAbandonedStarts: shouldWaitForAbandonedStarts === true,
    abortPendingStarts: shouldAbortPendingStarts === true,
    timeoutMS: resolveTimeoutMS(
      shutdownTimeoutMS,
      30000,
      'shutdownOptions.timeoutMS',
    ),
  });

  // The rest are read in property order.
  return Object.freeze({
    name,
    shutdownWarningTimeoutMS,
    messageTimeoutMS,
    startupTimeoutMS,
    shutdownOptions,
    attachSignalsBeforeStartup: options.attachSignalsBeforeStartup === true,
    attachSignalsOnStart: options.attachSignalsOnStart === true,
    detachSignalsOnStop: options.detachSignalsOnStop === true,
    repeatedShutdownRequestPolicy: resolveRepeatedShutdownPolicy(
      options.repeatedShutdownRequestPolicy,
    ),
    onReloadRequested: options.onReloadRequested,
    onInfoRequested: options.onInfoRequested,
    onDebugRequested: options.onDebugRequested,
  });
}

/** The escalation window `withinMS` defaults to. */
const DEFAULT_REPEATED_SHUTDOWN_WITHIN_MS = 2000;

function resolveRepeatedShutdownPolicy(
  policy: RepeatedShutdownRequestPolicy | null | undefined,
): RepeatedShutdownPolicyConfig | undefined {
  // Null selects the default - no policy - as it does for every other option here.
  if (isNullish(policy)) {
    return undefined;
  }

  const requestedArmedAfterFailureMS = policy.armedAfterFailureMS;
  // Require at least one follow-up request so threshold comparisons stay meaningful.
  const forceAfterCount = finiteClampMin(policy.forceAfterCount, 1, 3);
  // A zero-width window is valid and counts only same-tick requests. Invalid
  // explicit durations fail instead of changing the operator's escalation policy.
  const withinMS = resolveTimeoutMS(
    policy.withinMS,
    DEFAULT_REPEATED_SHUTDOWN_WITHIN_MS,
    'repeatedShutdownRequestPolicy.withinMS',
  );
  // Derived from the default window when `withinMS` is zero: that option only narrows
  // the active-shutdown window, and a derived `0` would be the explicit sentinel that
  // disables post-failure arming.
  const armedAfterFailureMS = resolveTimeoutMS(
    requestedArmedAfterFailureMS,
    toTimerDelayMS(
      (withinMS === 0 ? DEFAULT_REPEATED_SHUTDOWN_WITHIN_MS : withinMS) *
        forceAfterCount,
    ),
    'repeatedShutdownRequestPolicy.armedAfterFailureMS',
  );

  return Object.freeze({
    forceAfterCount,
    withinMS,
    armedAfterFailureMS,
    countManualRetriesTowardEscalation:
      policy.countManualRetriesTowardEscalation === true,
    hasExplicitArmedAfterFailureMS: !isNullish(requestedArmedAfterFailureMS),
    onForceShutdown: policy.onForceShutdown,
  });
}
