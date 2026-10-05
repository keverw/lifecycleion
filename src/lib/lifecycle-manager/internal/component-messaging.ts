import type { ComponentAccessContext } from './component-access-context';
import type { BaseComponent } from '../base-component';
import { reportCallbackError } from '../../safe-handle-callback';
import type {
  SendMessageOptions,
  MessageResult,
  BroadcastOptions,
  BroadcastResult,
  GetValueOptions,
  ValueResult,
} from '../types';
import { applyIntrinsic, observeRejection } from '../../internal/intrinsics';
import { adoptResult, UnreadableReturn } from '../../internal/adopt-promise';
import { isObjectLike } from '../../internal/is-object-like';
import { toError } from '../../to-error';
import { LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED } from '../constants';
import {
  resolveOperationTimeoutMS,
  isOperationOptionRefusal,
  invalidOperationOptionError,
} from './operation-policy';
import { copyBoundedArray } from './bounded-array-copy';
import {
  dispatchAnnouncedHook,
  readHookThenRecheck,
} from './component-dispatch';

function readAvailability(
  context: ComponentAccessContext,
  componentName: string,
  component: BaseComponent,
  allowStopped: boolean,
  allowStalled: boolean,
) {
  // Neither override permits entering a provider during startup or teardown - a
  // forced start that timed out is back to `stalled` while its `start()` still runs,
  // and a late start's cleanup marks its component `running` only to stop it.
  const isCurrent = context.getComponent(componentName) === component;
  const state = context.componentStates.get(componentName);
  const isUnavailable =
    state === 'starting' ||
    state === 'starting-timed-out' ||
    state === 'stopping' ||
    state === 'force-stopping' ||
    context.isRawStartPending(componentName) ||
    context.isLateStartCleanupPending(componentName);
  const isRunning =
    isCurrent && !isUnavailable && context.isComponentRunning(componentName);
  // The label does not depend on availability: a stall whose forced `start()` is still
  // pending is refused, but it is still `stalled` - as `checkComponentHealth()` and the
  // broadcast skip both call it. Gating this on availability made the same component
  // answer `stopped` here and `stalled` there, flipping with `includeStalled`.
  const isStalled = context.stalledComponents.has(componentName);
  const refusalCode =
    isCurrent &&
    !isUnavailable &&
    (isRunning || (isStalled ? allowStalled : allowStopped))
      ? undefined
      : !isCurrent
        ? ('not_found' as const)
        : isStalled
          ? ('stalled' as const)
          : ('stopped' as const);
  return { isCurrent, isRunning, isStalled, refusalCode };
}

/**
 * Internal message sending with explicit 'from' parameter
 *
 * @param componentName - Target component name
 * @param payload - Message payload
 * @param from - Sender component name (null if external)
 */
export async function sendMessageInternal(
  context: ComponentAccessContext,
  componentName: string,
  payload: unknown,
  from: string | null,
  options?: SendMessageOptions,
): Promise<MessageResult> {
  // Find component
  const component = context.getComponent(componentName);

  if (!component) {
    return {
      sent: false,
      componentFound: false,
      componentRunning: false,
      handlerImplemented: false,
      data: undefined,
      error: null,
      timedOut: false,
      code: 'not_found',
    };
  }

  const allowStopped = options?.includeStopped === true;
  const allowStalled = options?.includeStalled === true;
  // The latest availability read, so each answer below reports what the last recheck
  // found rather than what was true before caller code ran.
  let availability = readAvailability(
    context,
    componentName,
    component,
    allowStopped,
    allowStalled,
  );
  const recheck = () => {
    availability = readAvailability(
      context,
      componentName,
      component,
      allowStopped,
      allowStalled,
    );
    return availability.refusalCode;
  };
  // Nothing is announced before dispatch, so a refusal up to then has no event to pair.
  const refuseBeforeAnnouncement = (
    code: NonNullable<ReturnType<typeof readAvailability>['refusalCode']>,
  ): MessageResult => ({
    sent: false,
    componentFound: availability.isCurrent,
    componentRunning: false,
    handlerImplemented: false,
    data: undefined,
    error: null,
    timedOut: false,
    code,
  });
  if (availability.refusalCode !== undefined) {
    return refuseBeforeAnnouncement(availability.refusalCode);
  }

  // Read once, guarded, and that value is what gets called - as `getValueInternal()`
  // reads its handler. Unguarded, a getter that threw escaped to the generic safety
  // net, and one that answered differently the second time failed as a handler error.
  const handlerRead = readHookThenRecheck(
    () => Reflect.get(component, 'onMessage') as unknown,
    (error) => {
      reportCallbackError('lifecycle-manager sendMessageToComponent', error);
    },
    recheck,
  );
  if (handlerRead.status === 'refused') {
    return refuseBeforeAnnouncement(handlerRead.refusal);
  }

  if (handlerRead.status === 'read_failed') {
    const err = toError(handlerRead.error);

    // Logged and announced as a failure, but without `message-sent`: nothing was sent -
    // the result says `sent: false` - and the event must not say otherwise. This is the
    // one `message-failed` with no `message-sent` before it; see its event docs.
    context.logger
      .entity(componentName)
      .error(LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED, {
        params: { error: err, from },
      });
    context.lifecycleEvents.componentMessageFailed(componentName, from, err, {
      timedOut: false,
      code: 'operation_crashed',
      componentFound: true,
      componentRunning: availability.isRunning,
      handlerImplemented: false,
      data: undefined,
    });

    return {
      sent: false,
      componentFound: true,
      componentRunning: availability.isRunning,
      handlerImplemented: false,
      data: undefined,
      error: err,
      timedOut: false,
      code: 'operation_crashed',
    };
  }

  const messageHandler = handlerRead.value;

  // Availability and handler refusals take precedence over an unused timeout.
  // Unlike broadcast's one shared dispatch budget, there is no operation to time
  // here until this particular recipient is available and implements the handler.
  if (typeof messageHandler !== 'function') {
    return {
      sent: false,
      componentFound: true,
      componentRunning: availability.isRunning,
      handlerImplemented: false,
      data: undefined,
      error: null,
      timedOut: false,
      code: 'no_handler',
    };
  }

  // Read before the sent event, for the reason `getValueInternal()` reads its options
  // up front: a throwing getter must not leave `message-sent` without its pair.
  let timeoutMS: number;
  try {
    timeoutMS = resolveOperationTimeoutMS(
      options?.timeout,
      context.messageTimeoutMS,
      'sendMessageToComponent timeout',
    );
  } catch (error) {
    if (!isOperationOptionRefusal(error)) {
      throw error;
    }
    return {
      sent: false,
      componentFound: true,
      componentRunning: availability.isRunning,
      handlerImplemented: true,
      data: undefined,
      error,
      timedOut: false,
      code: 'invalid_options',
    };
  }

  // The handler/options getters and sent listeners are caller code. The dispatch
  // rechecks the same instance immediately before calling it; even non-running
  // overrides never permit entering a handler while startup or teardown owns it.
  const dispatch = await dispatchAnnouncedHook(context, {
    name: componentName,
    component,
    handler: messageHandler,
    args: [payload, from],
    timeoutMS,
    announce: () => {
      context.lifecycleEvents.componentMessageSent({
        componentName,
        from,
        payload,
      });
    },
    recheck,
    timeoutLog: 'Message handler timed out',
    timeoutLogParams: { from, timeoutMS },
    lateFailureMessage: 'Message handler failed after it had already timed out',
    lateFailureParams: { from },
  });

  if (dispatch.status === 'refused') {
    const code = dispatch.refusal;
    const error = new Error(
      `Component "${componentName}" became unavailable before message dispatch`,
    );
    context.lifecycleEvents.componentMessageFailed(componentName, from, error, {
      timedOut: false,
      code,
      componentFound: availability.isCurrent,
      componentRunning: false,
      handlerImplemented: true,
      data: undefined,
    });
    return {
      sent: false,
      componentFound: availability.isCurrent,
      componentRunning: false,
      handlerImplemented: true,
      data: undefined,
      error: null,
      timedOut: false,
      code,
    };
  }

  const isDispatchRunning = availability.isRunning;

  if (dispatch.status === 'timed_out') {
    // Paired with `message-sent`, as a handler that threw or rejected is: the event
    // carries `timedOut` for exactly this, but nothing emitted it.
    context.lifecycleEvents.componentMessageFailed(
      componentName,
      from,
      new Error(`Message handler timed out after ${String(timeoutMS)}ms`),
      {
        timedOut: true,
        code: 'timeout',
        componentFound: true,
        componentRunning: isDispatchRunning,
        handlerImplemented: true,
        data: undefined,
      },
    );
    return {
      sent: true,
      componentFound: true,
      componentRunning: isDispatchRunning,
      handlerImplemented: true,
      data: undefined,
      error: null,
      timedOut: true,
      code: 'timeout',
    };
  }

  if (dispatch.status === 'threw') {
    const err = toError(dispatch.error);

    context.logger
      .entity(componentName)
      .error(LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED, {
        params: { error: err, from, timeoutMS },
      });

    context.lifecycleEvents.componentMessageFailed(componentName, from, err, {
      timedOut: false,
      code: 'error',
      componentFound: true,
      componentRunning: isDispatchRunning,
      handlerImplemented: true,
      data: undefined,
    });

    return {
      sent: true,
      componentFound: true,
      componentRunning: isDispatchRunning,
      handlerImplemented: true,
      data: undefined,
      error: err,
      timedOut: false,
      code: 'error',
    };
  }

  return {
    sent: true,
    componentFound: true,
    componentRunning: isDispatchRunning,
    handlerImplemented: true,
    data: dispatch.value,
    error: null,
    timedOut: false,
    code: 'sent',
  };
}

/**
 * The most `componentNames` a broadcast filter is read for. Far above any registry this
 * manager is meant to hold - and duplicates or unknown names only cost a set entry each -
 * yet small enough that copying a list this long cannot stall the event loop.
 */
const MAX_BROADCAST_TARGET_NAMES = 100_000;

/**
 * The broadcast's `componentNames` filter, copied once by index - with the same bounded
 * copy `tryReadDependencies()` makes of a dependency list - into a set the filter
 * consults. The array is the caller's: a subclass or proxy runs its own code for
 * `length` and `includes`, and the filter would have asked it once per registered
 * component. A non-array, or a `length` that is not a plausible list size (a proxy can
 * claim `Infinity`), refuses the whole broadcast as an invalid option before it has
 * announced itself; a read that throws fails it at the same point.
 */
function copyTargetNames(names: unknown): Set<unknown> | undefined {
  if (names === undefined) {
    return undefined;
  }
  if (!Array.isArray(names)) {
    throw invalidOperationOptionError(
      'broadcastMessage componentNames must be an array',
    );
  }
  const entries = copyBoundedArray(
    names,
    MAX_BROADCAST_TARGET_NAMES,
    (length) =>
      invalidOperationOptionError(
        `broadcastMessage componentNames has an implausible length: ${String(length)} (at most ${String(MAX_BROADCAST_TARGET_NAMES)})`,
      ),
  );
  const copy = new Set<unknown>();
  for (const name of entries) {
    copy.add(name);
  }
  return copy;
}

/**
 * Internal broadcast with explicit 'from' parameter
 *
 * @param payload - Message payload
 * @param from - Sender component name (null if external)
 * @param options - Filtering options
 */
export async function broadcastMessageInternal(
  context: ComponentAccessContext,
  payload: unknown,
  from: string | null,
  options?: BroadcastOptions,
): Promise<BroadcastResult[]> {
  const results: BroadcastResult[] = [];

  // Determine which components to broadcast to - before `broadcast-started` goes out:
  // `options` is the caller's object, and a read of it that throws must fail the
  // broadcast before it has announced itself, not leave a `broadcast-started` with no
  // `broadcast-completed` after it. From the loop on, every step is per component.
  let targetComponents = context.components;

  // Read once: a getter behind it would otherwise run - and could answer differently -
  // on each read.
  const targetNames = copyTargetNames(options?.componentNames ?? undefined);
  const hasExplicitTargets = targetNames !== undefined && targetNames.size > 0;

  // Filter by names if specified
  if (hasExplicitTargets) {
    targetComponents = targetComponents.filter((c) =>
      targetNames.has(context.nameOf(c)),
    );
  }

  const allowStopped = options?.includeStopped === true;
  const allowStalled = options?.includeStalled === true;
  // A snapshot of what each message needs, read once with the rest: every target is
  // sent the same values, and a getter on the caller's object runs once rather than
  // once per component.
  const messageOptions: SendMessageOptions = {
    timeout: resolveOperationTimeoutMS(
      options?.timeout,
      context.messageTimeoutMS,
      'broadcastMessage timeout',
    ),
    includeStopped: allowStopped,
    includeStalled: allowStalled,
  };

  // The one eligibility rule for both the selection and each send: running, or a
  // non-running state the caller opted into. Finer refusals - startup, teardown - are
  // `sendMessageInternal()`'s.
  const skipCodeFor = (name: string): 'stalled' | 'stopped' | undefined => {
    // A late start's cleanup marks its component running only to stop it.
    if (
      context.isComponentRunning(name) &&
      !context.isLateStartCleanupPending(name)
    ) {
      return undefined;
    }
    const isStalled = context.stalledComponents.has(name);
    if (isStalled ? allowStalled : allowStopped) {
      return undefined;
    }
    return isStalled ? 'stalled' : 'stopped';
  };

  // Explicit targets are all reported, eligible or not; otherwise only eligible ones.
  if (!hasExplicitTargets) {
    targetComponents = targetComponents.filter(
      (c) => skipCodeFor(context.nameOf(c)) === undefined,
    );
  }

  context.lifecycleEvents.componentBroadcastStarted(from, payload);

  // Every step in the loop is already per component, so nothing here is expected to
  // throw. If something ever does, the answers already collected are kept - and
  // `broadcast-completed` still follows `broadcast-started` - rather than all of them
  // being replaced by the outer safety net's empty result.
  try {
    // Send to each component
    for (const component of targetComponents) {
      // The recorded name, so no component's own `getName()` runs mid-broadcast.
      const name = context.nameOf(component);
      // Targets were selected as instances, but each send resolves its recipient by
      // name. An earlier recipient's handler can unregister this one and register a
      // replacement under the same name - with `includeStopped`, even one that never
      // started - which was never selected. The selected target is gone: reported as a
      // target unregistered mid-broadcast is, and the replacement is not sent to.
      const skipCode =
        context.getComponent(name) === component
          ? skipCodeFor(name)
          : ('stopped' as const);

      if (skipCode !== undefined) {
        results.push({
          name,
          sent: false,
          running: false,
          data: undefined,
          error: null,
          timedOut: false,
          code: skipCode,
        });
        continue;
      }

      // Through the per-message safety net, for the same reason as the name read above.
      const messageResult = await context.sendMessageSettled(
        name,
        payload,
        from,
        messageOptions,
      );

      results.push({
        name,
        sent: messageResult.sent,
        running: messageResult.componentRunning,
        data: messageResult.data,
        error: messageResult.error,
        timedOut: messageResult.timedOut,
        // A target unregistered mid-broadcast is no longer running; `error` would claim
        // its handler ran and failed. Each send is handed the shared timeout already
        // validated above, so a per-recipient option refusal would be the manager
        // breaking its own invariant - a crash, not the caller's options.
        code:
          messageResult.code === 'not_found'
            ? 'stopped'
            : messageResult.code === 'invalid_options'
              ? 'operation_crashed'
              : messageResult.code,
      });
    }
  } catch (error) {
    reportCallbackError('lifecycle-manager broadcastMessage', error);
  }

  context.lifecycleEvents.componentBroadcastCompleted(
    from,
    results.length,
    results,
  );

  return results;
}

/**
 * Internal getValue with explicit 'from' parameter
 *
 * @param componentName - Target component name
 * @param key - Value key
 * @param from - Requester component name (null if external)
 */
export function getValueInternal<T = unknown>(
  context: ComponentAccessContext,
  componentName: string,
  key: string,
  from: string | null,
  options?: GetValueOptions,
): ValueResult<T> {
  // Read before the requested event, so an options getter that throws fails the call
  // before anything was announced rather than leaving `value-requested` unpaired.
  const allowStopped = options?.includeStopped === true;
  const allowStalled = options?.includeStalled === true;

  context.lifecycleEvents.componentValueRequested(componentName, key, from);

  // Find component
  const component = context.getComponent(componentName);

  if (!component) {
    context.lifecycleEvents.componentValueReturned(componentName, key, from, {
      found: false,
      value: undefined,
      componentFound: false,
      componentRunning: false,
      handlerImplemented: false,
      requestedBy: from,
      code: 'not_found',
    });
    return {
      found: false,
      value: undefined,
      componentFound: false,
      componentRunning: false,
      handlerImplemented: false,
      requestedBy: from,
      code: 'not_found',
    };
  }

  const refuseUnavailable = (
    availability: ReturnType<typeof readAvailability>,
    hasHandler: boolean,
  ): ValueResult<T> | undefined => {
    if (availability.refusalCode === undefined) {
      return undefined;
    }
    const result: ValueResult<T> = {
      found: false,
      value: undefined,
      componentFound: availability.isCurrent,
      componentRunning: false,
      handlerImplemented: hasHandler,
      requestedBy: from,
      code: availability.refusalCode,
    };
    context.lifecycleEvents.componentValueReturned(
      componentName,
      key,
      from,
      result,
    );
    return result;
  };
  // The latest availability read; see `sendMessageInternal()`.
  let availability = readAvailability(
    context,
    componentName,
    component,
    allowStopped,
    allowStalled,
  );
  const initialRefusal = refuseUnavailable(availability, false);
  if (initialRefusal) {
    return initialRefusal;
  }

  // Read once, and inside a guard: the read runs the component's code, and it comes
  // after `value-requested`, so a getter that threw left that event without its
  // `value-returned` pair. A throwing read is answered with `code: 'operation_crashed'`
  // if still available - a getter that throws broke the component's contract, unlike a
  // handler that throws - and reported even if the getter removed the component or
  // began teardown. Either way the provider getter is caller code: a captured provider
  // is never invoked after it removed/replaced the registration or handed the
  // component to teardown.
  const handlerRead = readHookThenRecheck(
    () => Reflect.get(component, 'getValue') as unknown,
    (error) => {
      reportCallbackError('lifecycle-manager getValue', error);
    },
    () => {
      availability = readAvailability(
        context,
        componentName,
        component,
        allowStopped,
        allowStalled,
      );
      return availability.refusalCode === undefined ? undefined : availability;
    },
  );
  if (handlerRead.status === 'refused') {
    return refuseUnavailable(
      handlerRead.refusal,
      typeof handlerRead.value === 'function',
    ) as ValueResult<T>;
  }
  const { isRunning } = availability;

  if (handlerRead.status === 'read_failed') {
    context.lifecycleEvents.componentValueReturned(componentName, key, from, {
      found: false,
      value: undefined,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: false,
      requestedBy: from,
      code: 'operation_crashed',
    });

    return {
      found: false,
      value: undefined,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: false,
      requestedBy: from,
      code: 'operation_crashed',
      error: toError(handlerRead.error),
    };
  }

  const getValueHandler = handlerRead.value;

  // Check if handler implemented
  if (typeof getValueHandler !== 'function') {
    context.lifecycleEvents.componentValueReturned(componentName, key, from, {
      found: false,
      value: undefined,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: false,
      requestedBy: from,
      code: 'no_handler',
    });
    return {
      found: false,
      value: undefined,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: false,
      requestedBy: from,
      code: 'no_handler',
    };
  }

  // Get value
  try {
    const rawResult: unknown = applyIntrinsic(getValueHandler, component, [
      key,
      from,
    ]);

    // `getValue()` answers synchronously, so a handler that returns a promise - an
    // `async getValue` - is a contract break, not a value: read as one it came back
    // `not_found`, and a rejection it carried went unhandled. Its settlement is
    // observed, so nothing floats, and the call fails with `code: 'error'`.
    const pending = adoptResult(rawResult);
    if (pending instanceof UnreadableReturn) {
      throw pending;
    }
    if (pending !== undefined) {
      observeRejection(pending, (error: unknown) => {
        context.logger
          .entity(componentName)
          .warn('Asynchronous getValue handler rejected: {{error.message}}', {
            params: { error: toError(error), key, from },
          });
      });

      throw new TypeError(
        'getValue() must answer synchronously; the handler returned a promise',
      );
    }

    // Validated as `healthCheck()` results are: `found` is read once and must be a
    // boolean. Testing it for truthiness turned `{ found: 'no' }` into `code: 'found'`
    // - a malformed answer reported as a value. Thrown here, so it is answered as the
    // handler's own failure (`code: 'error'`), like a handler that threw.
    if (!isObjectLike(rawResult)) {
      throw new TypeError('getValue() did not return a ComponentValueResult');
    }
    const wasFound: unknown = Reflect.get(rawResult, 'found');
    if (typeof wasFound !== 'boolean') {
      throw new TypeError('getValue() result.found must be a boolean');
    }
    const value: unknown = Reflect.get(rawResult, 'value');

    context.lifecycleEvents.componentValueReturned(componentName, key, from, {
      found: wasFound,
      value,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: true,
      requestedBy: from,
      code: wasFound ? 'found' : 'not_found',
    });

    return {
      found: wasFound,
      value: value as T | undefined,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: true,
      requestedBy: from,
      code: wasFound ? 'found' : 'not_found',
    };
  } catch (error) {
    const err = toError(error);

    context.logger
      .entity(componentName)
      .error('getValue handler failed: {{error.message}}', {
        params: { error: err, key, from },
      });

    context.lifecycleEvents.componentValueReturned(componentName, key, from, {
      found: false,
      value: undefined,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: true,
      requestedBy: from,
      code: 'error',
    });

    return {
      found: false,
      value: undefined,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: true,
      requestedBy: from,
      code: 'error',
      error: err,
    };
  }
}
