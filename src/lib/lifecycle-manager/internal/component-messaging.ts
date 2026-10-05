import type { ComponentAccessContext } from './component-access-context';
import type { BaseComponent } from '../base-component';
import { raceDeadline } from '../../internal/race-deadline';
import { optionalValidatedTimerDelayMS } from '../../internal/timer-limits';
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
import {
  adoptPromise,
  adoptResult,
  UnreadableReturn,
} from '../../internal/adopt-promise';
import { toError } from '../../to-error';
import { LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED } from '../constants';
import {
  resolveOperationTimeoutMS,
  isOperationTimeoutValidationError,
  invalidOperationOptionError,
} from './operation-policy';

function readAvailability(
  context: ComponentAccessContext,
  componentName: string,
  component: BaseComponent,
  allowStopped: boolean,
  allowStalled: boolean,
) {
  // Neither override permits entering a provider during startup or teardown - a
  // forced start that timed out is back to `stalled` while its `start()` still runs.
  const isCurrent = context.getComponent(componentName) === component;
  const state = context.componentStates.get(componentName);
  const isUnavailable =
    state === 'starting' ||
    state === 'starting-timed-out' ||
    state === 'stopping' ||
    state === 'force-stopping' ||
    context.isRawStartPending(componentName);
  const isRunning =
    isCurrent && !isUnavailable && context.isComponentRunning(componentName);
  const isStalled =
    !isUnavailable && context.stalledComponents.has(componentName);
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
  const initialAvailability = readAvailability(
    context,
    componentName,
    component,
    allowStopped,
    allowStalled,
  );
  const { isRunning } = initialAvailability;
  if (initialAvailability.refusalCode !== undefined) {
    return {
      sent: false,
      componentFound: initialAvailability.isCurrent,
      componentRunning: false,
      handlerImplemented: false,
      data: undefined,
      error: null,
      timedOut: false,
      code: initialAvailability.refusalCode,
    };
  }

  // Read once, guarded, and that value is what gets called - as `getValueInternal()`
  // reads its handler. Unguarded, a getter that threw escaped to the generic safety
  // net, and one that answered differently the second time failed as a handler error.
  let messageHandler: unknown;

  try {
    messageHandler = Reflect.get(component, 'onMessage');
  } catch (error) {
    const err = toError(error);

    reportCallbackError('lifecycle-manager sendMessageToComponent', error);
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
      componentRunning: isRunning,
      handlerImplemented: false,
      data: undefined,
    });

    return {
      sent: false,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: false,
      data: undefined,
      error: err,
      timedOut: false,
      code: 'operation_crashed',
    };
  }

  // Availability and handler refusals take precedence over an unused timeout.
  // Unlike broadcast's one shared dispatch budget, there is no operation to time
  // here until this particular recipient is available and implements the handler.
  if (typeof messageHandler !== 'function') {
    return {
      sent: false,
      componentFound: true,
      componentRunning: isRunning,
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
    if (!isOperationTimeoutValidationError(error)) {
      throw error;
    }
    return {
      sent: false,
      componentFound: true,
      componentRunning: isRunning,
      handlerImplemented: true,
      data: undefined,
      error,
      timedOut: false,
      code: 'invalid_options',
    };
  }

  // Send message
  context.lifecycleEvents.componentMessageSent({
    componentName,
    from,
    payload,
  });

  // The handler/options getters and sent listeners are caller code. Recheck the
  // same instance immediately before dispatch; even non-running overrides never
  // permit entering a handler while startup or teardown owns the component.
  const dispatchAvailability = readAvailability(
    context,
    componentName,
    component,
    allowStopped,
    allowStalled,
  );
  const { isCurrent, isRunning: isDispatchRunning } = dispatchAvailability;
  if (dispatchAvailability.refusalCode !== undefined) {
    const code = dispatchAvailability.refusalCode;
    const error = new Error(
      `Component "${componentName}" became unavailable before message dispatch`,
    );
    context.lifecycleEvents.componentMessageFailed(componentName, from, error, {
      timedOut: false,
      code,
      componentFound: isCurrent,
      componentRunning: false,
      handlerImplemented: true,
      data: undefined,
    });
    return {
      sent: false,
      componentFound: isCurrent,
      componentRunning: false,
      handlerImplemented: true,
      data: undefined,
      error: null,
      timedOut: false,
      code,
    };
  }

  const timeoutResult = { timedOut: true } as const;

  try {
    // A synchronous throw lands in the `catch` below, answered as a rejection is.
    const result: unknown = applyIntrinsic(messageHandler, component, [
      payload,
      from,
    ]);

    // Adopted, not raced as it is: see `adoptPromise()`.
    const handlerPromise = adoptPromise(result);

    const { value: outcome } = await raceDeadline(
      handlerPromise,
      optionalValidatedTimerDelayMS(timeoutMS),
      () => timeoutResult,
    );

    if (outcome === timeoutResult) {
      context.logger.entity(componentName).warn('Message handler timed out', {
        params: { from, timeoutMS },
      });
      context.observeFailureAfterTimeout(
        handlerPromise,
        componentName,
        'Message handler failed after it had already timed out',
        { from },
      );
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

    return {
      sent: true,
      componentFound: true,
      componentRunning: isDispatchRunning,
      handlerImplemented: true,
      data: outcome,
      error: null,
      timedOut: false,
      code: 'sent',
    };
  } catch (error) {
    const err = toError(error);

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
  const names = options?.componentNames ?? undefined;
  if (names !== undefined && !Array.isArray(names)) {
    throw invalidOperationOptionError(
      'broadcastMessage componentNames must be an array',
    );
  }
  const hasExplicitTargets = names !== undefined && names.length > 0;

  // Filter by names if specified
  if (hasExplicitTargets) {
    targetComponents = targetComponents.filter((c) =>
      names.includes(context.nameOf(c)),
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
    if (context.isComponentRunning(name)) {
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
      const skipCode = skipCodeFor(name);

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
        // its handler ran and failed.
        code:
          messageResult.code === 'not_found' ? 'stopped' : messageResult.code,
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
  const initialRefusal = refuseUnavailable(
    readAvailability(
      context,
      componentName,
      component,
      allowStopped,
      allowStalled,
    ),
    false,
  );
  if (initialRefusal) {
    return initialRefusal;
  }

  // Read once, and inside a guard: the read runs the component's code, and it comes
  // after `value-requested`, so a getter that threw left that event without its
  // `value-returned` pair. A throwing read is answered with `code: 'operation_crashed'`
  // if still available - a getter that throws broke the component's contract, unlike a
  // handler that throws - and reported even if the getter removed the component or
  // began teardown.
  let getValueHandler: unknown;

  try {
    getValueHandler = Reflect.get(component, 'getValue');
  } catch (error) {
    const err = toError(error);

    reportCallbackError('lifecycle-manager getValue', error);
    const availability = readAvailability(
      context,
      componentName,
      component,
      allowStopped,
      allowStalled,
    );
    const refusal = refuseUnavailable(availability, false);
    if (refusal) {
      return refusal;
    }
    const { isRunning } = availability;
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
      error: err,
    };
  }

  // The provider getter is caller code. Never invoke a captured provider after
  // it removed/replaced the registration or handed the component to teardown.
  const availability = readAvailability(
    context,
    componentName,
    component,
    allowStopped,
    allowStalled,
  );
  const dispatchRefusal = refuseUnavailable(
    availability,
    typeof getValueHandler === 'function',
  );
  if (dispatchRefusal) {
    return dispatchRefusal;
  }

  const { isRunning } = availability;

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

    const componentResult = rawResult as ReturnType<
      NonNullable<BaseComponent['getValue']>
    >;
    const wasFound = componentResult.found;
    const value = componentResult.value;

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
