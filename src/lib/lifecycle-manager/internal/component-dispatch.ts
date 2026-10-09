import type { BaseComponent } from '../base-component';
import type { ComponentAccessContext } from './component-access-context';
import { raceDeadline } from '../../internal/race-deadline';
import { optionalValidatedTimerDelayMS } from '../../internal/timer-limits';
import { observeRejection } from '../../internal/intrinsics';
import { adoptPromise } from '../../internal/adopt-promise';
import { reportCallbackError } from '../../safe-handle-callback';
import type { ComponentState } from '../types';

/**
 * The steps component hook dispatch shares: every one - message, value, health check,
 * signal - reads its hook then rechecks ({@link readHookThenRecheck}), and the
 * asynchronous ones - all but the synchronous value read - then announce, recheck and
 * invoke under a deadline ({@link dispatchAnnouncedHook}). Each operation keeps its own
 * events, result shapes and refusal labels; only
 * the order of reads, rechecks and the deadline lives here, so it cannot drift between
 * them. Each operation's refusal codes stay the caller's: `recheck` answers a refusal,
 * or `undefined` while the component may still be entered. The core of that rule -
 * {@link isHookEntryBlocked} and {@link isComponentEnterable} - is shared below.
 */

/** What {@link isHookEntryBlocked} reads. */
type HookEntryContext = Pick<
  ComponentAccessContext,
  'componentStates' | 'isRawStartPending' | 'isLateStartCleanupPending'
>;

/**
 * Whether a lifecycle phase owns the component, so none of its hooks - message, value,
 * health check, signal, shutdown warning - may be entered whatever else its state
 * allows: a start or stop is in progress, a forced start that timed out is back to
 * `stalled` while its `start()` still runs, or a late start's cleanup marks it
 * `running` only to stop it. Teardown may outlive the bulk shutdown latch, so this is
 * asked of the component itself, never of the manager's latches.
 *
 * `state` is the caller's own read of the component's state, so a check that already
 * read it - and a test tracing those reads - does not read it twice.
 */
export function isHookEntryBlocked(
  context: HookEntryContext,
  name: string,
  state: ComponentState | undefined,
): boolean {
  return (
    state === 'starting' ||
    state === 'starting-timed-out' ||
    state === 'stopping' ||
    state === 'force-stopping' ||
    context.isRawStartPending(name) ||
    context.isLateStartCleanupPending(name)
  );
}

/** Select a running member for aggregate operations, excluding late-start cleanup. */
export function isComponentSelectedRunningMember(
  context: Pick<
    ComponentAccessContext,
    'isComponentRunning' | 'isLateStartCleanupPending'
  >,
  name: string,
): boolean {
  return (
    context.isComponentRunning(name) && !context.isLateStartCleanupPending(name)
  );
}

/**
 * Whether the component is running, by membership and by state: the half of
 * {@link isComponentEnterable} that is not {@link isHookEntryBlocked}, for a caller that
 * has already evaluated the block itself. `state` is the caller's own read, as there.
 */
export function isComponentRunningMember(
  context: Pick<ComponentAccessContext, 'isComponentRunning'>,
  name: string,
  state: ComponentState | undefined,
): boolean {
  return context.isComponentRunning(name) && state === 'running';
}

/**
 * Whether the component is up and its hooks may be entered: running - by membership
 * and by state - and not blocked by {@link isHookEntryBlocked}. Registration identity
 * (the instance still registered under `name`) is each caller's own check.
 *
 * `state` is required, not defaulted: a caller whose own read found no state passes
 * `undefined`, and that is the answer - a default would read the state again.
 */
export function isComponentEnterable(
  context: HookEntryContext &
    Pick<ComponentAccessContext, 'isComponentRunning'>,
  name: string,
  state: ComponentState | undefined,
): boolean {
  return (
    isComponentRunningMember(context, name, state) &&
    !isHookEntryBlocked(context, name, state)
  );
}

/** How a message, value read or health check labels a component it refuses to enter. */
export type UnavailableComponentCode = 'not_found' | 'stalled' | 'stopped';

/**
 * The label for a component an operation refuses to enter, by the shared rule (see
 * {@link isComponentEnterable}) or the caller's own: `not_found` once `isCurrent` is false
 * - the instance is no longer the one registered under `name` - otherwise `stalled` or
 * `stopped`. The label follows the stall, not what made the component unavailable, so a
 * stall whose forced `start()` is still pending is `stalled` wherever it is refused.
 */
export function unavailableComponentCode(
  context: Pick<ComponentAccessContext, 'stalledComponents'>,
  name: string,
  isCurrent: boolean,
): UnavailableComponentCode {
  if (!isCurrent) {
    return 'not_found';
  }
  return context.stalledComponents.has(name) ? 'stalled' : 'stopped';
}

/** What {@link readHookThenRecheck} found. */
type HookRead<TValue, TRefusal> =
  /** `value` is what the read returned, or `undefined` when it threw. */
  | { status: 'refused'; refusal: TRefusal; value: TValue | undefined }
  | { status: 'read_failed'; error: unknown }
  | { status: 'read'; value: TValue };

/**
 * Read a component's hook - and whatever configuration goes with it - once, guarded,
 * then recheck availability before answering anything.
 *
 * The read runs the component's code, which can stop, unregister or replace the
 * component. Answering from the read alone told a caller `no_handler` (health: healthy)
 * for a component that was already stopped, or `operation_crashed` for one that was no
 * longer registered. So availability wins over both: a read failure is still reported
 * through `reportReadFailure` - it broke the component's contract whatever happened
 * next - but the answer is the refusal when there is one.
 */
export function readHookThenRecheck<TValue, TRefusal>(
  read: () => TValue,
  reportReadFailure: (error: unknown) => void,
  recheck: () => TRefusal | undefined,
): HookRead<TValue, TRefusal> {
  let value: TValue | undefined;
  let failure: { error: unknown } | undefined;

  try {
    value = read();
  } catch (error) {
    failure = { error };
    reportReadFailure(error);
  }

  const refusal = recheck();
  if (refusal !== undefined) {
    return { status: 'refused', refusal, value };
  }
  return failure !== undefined
    ? { status: 'read_failed', error: failure.error }
    : { status: 'read', value: value as TValue };
}

/** What {@link dispatchAnnouncedHook} did. */
type HookDispatch<TRefusal> =
  | { status: 'refused'; refusal: TRefusal }
  | { status: 'settled'; value: unknown }
  | { status: 'timed_out' }
  | { status: 'threw'; error: unknown };

interface HookDispatchRequest<TRefusal> {
  name: string;
  component: BaseComponent;
  /** The handler as read once by the caller; called with `component` as receiver. */
  handler: Parameters<typeof Reflect.apply>[0];
  args: readonly unknown[];
  timeoutMS: number;
  /** Emits the operation's `*-started` / `message-sent` event. */
  announce: () => void;
  recheck: () => TRefusal | undefined;
  timeoutLog: string;
  timeoutLogParams: Record<string, unknown>;
  lateFailureMessage: string;
  lateFailureParams?: Record<string, unknown>;
}

/**
 * Announce a dispatch, recheck availability after its listeners, then call the handler
 * under its deadline.
 *
 * One microtask separates the announcement from the recheck, so the recheck follows the
 * announcement's listeners however the dispatch was reached. A dispatch made from inside
 * another manager event listener only queues its announcement behind the notification
 * being delivered; that drain is synchronous, so it has run every queued listener by the
 * time this resumes. Without the wait a listener could not prevent a nested dispatch, as
 * the event docs promise.
 *
 * The handler's result is adopted, not raced as it is (see `adoptPromise()`). A timeout
 * is logged and the still-running handler observed, so a late failure is reported rather
 * than floating; the timeout is logged through the guarded logger, which cannot throw
 * here. A synchronous throw and a rejection are both answered `threw`. A failure to
 * observe the timed-out handler is the manager's own, not the handler's: it
 * is reported on the global channel and the dispatch still answers `timed_out`.
 */
export async function dispatchAnnouncedHook<TRefusal>(
  context: Pick<
    ComponentAccessContext,
    'logger' | 'observeFailureAfterTimeout'
  >,
  request: HookDispatchRequest<TRefusal>,
): Promise<HookDispatch<TRefusal>> {
  const { name } = request;

  request.announce();
  await Promise.resolve(undefined);

  const refusal = request.recheck();
  if (refusal !== undefined) {
    return { status: 'refused', refusal };
  }

  try {
    const handlerPromise = adoptPromise<unknown>(
      Reflect.apply(request.handler, request.component, request.args),
    );
    // Zero means no timer, as for startup and signals: racing `setTimeout(..., 0)` made
    // the outcome depend on whether a handler settled before its first asynchronous turn.
    const outcome = await raceDeadline(
      handlerPromise,
      optionalValidatedTimerDelayMS(request.timeoutMS),
      // A settled handler always arrives boxed, so only the deadline answers undefined.
      () => undefined,
    );

    if (outcome === undefined) {
      context.logger.entity(name).warn(request.timeoutLog, {
        params: request.timeoutLogParams,
      });
      try {
        context.observeFailureAfterTimeout(
          handlerPromise,
          name,
          request.lateFailureMessage,
          request.lateFailureParams,
        );
      } catch (error) {
        // Not the handler's failure - it did time out - so not `threw`: the manager's,
        // reported as its other failures are. The handler is still observed, silently,
        // so a late rejection does not also go unhandled.
        observeRejection(handlerPromise, () => undefined);
        reportCallbackError(
          `lifecycle-manager late failure observation for ${name}`,
          error,
        );
      }
      return { status: 'timed_out' };
    }

    return { status: 'settled', value: outcome.value };
  } catch (error) {
    return { status: 'threw', error };
  }
}
