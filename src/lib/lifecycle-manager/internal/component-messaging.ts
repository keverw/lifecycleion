import type { ComponentAccessContext } from './component-access-context';
import { reportCallbackError } from '../../safe-handle-callback';
import type {
  SendMessageOptions,
  MessageResult,
  BroadcastOptions,
  BroadcastResult,
  GetValueOptions,
  ValueResult,
} from '../types';
import {
  containDeferredResult,
  UnreadableReturn,
} from '../../internal/adopt-promise';
import { isObjectLike } from '../../internal/is-object-like';
import { toError } from '../../to-error';
import { LIFECYCLE_MANAGER_LOG_MESSAGE_HANDLER_FAILED } from '../constants';
import {
  resolveOperationTimeoutMS,
  isOperationOptionRefusal,
} from './operation-policy';
import {
  snapshotBroadcastOptions,
  snapshotGetValueOptions,
  snapshotSendMessageOptions,
} from './operation-options';
import {
  dispatchAnnouncedHook,
  isComponentRunningMember,
  isComponentSelectedRunningMember,
  isHookEntryBlocked,
  readHookThenRecheck,
  unavailableComponentCode,
} from './component-dispatch';

/**
 * `isCurrent` is the caller's: whether `component` is still the instance registered
 * under `componentName`. A recheck looks it up again; the first read follows the lookup
 * that found `component` with no caller code between, so it passes `true` rather than
 * repeat a lookup that scans the registry.
 */
function readAvailability(
  context: ComponentAccessContext,
  componentName: string,
  isCurrent: boolean,
  allowStopped: boolean,
  allowStalled: boolean,
) {
  // Neither override permits entering a provider the shared rule blocks - startup or
  // teardown owning it (see `isHookEntryBlocked()`); they only admit a stopped or
  // stalled component that nothing owns.
  const state = context.componentStates.get(componentName);
  const isUnavailable = isHookEntryBlocked(context, componentName, state);
  // The shared rule (see `isComponentEnterable()`), with the block just evaluated
  // rather than evaluated again: each evaluation scans the manager's pending starts.
  const isRunning =
    isCurrent &&
    !isUnavailable &&
    isComponentRunningMember(context, componentName, state);
  const isStalled = context.stalledComponents.has(componentName);
  // Labelled as `checkComponentHealth()` labels its refusals (see
  // `unavailableComponentCode()`): by the stall, not by availability, so the same
  // component does not answer `stopped` here and `stalled` there.
  const refusalCode =
    isCurrent &&
    !isUnavailable &&
    (isRunning || (isStalled ? allowStalled : allowStopped))
      ? undefined
      : unavailableComponentCode(context, componentName, isCurrent);
  return { isCurrent, isRunning, refusalCode };
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

  // Every option is read here, once, the timeout with the rest: it is validated only
  // once the availability and handler refusals below are past, but a getter behind it
  // runs now, before anything is announced.
  const messageOptions = snapshotSendMessageOptions(options);
  const allowStopped = messageOptions.includeStopped;
  const allowStalled = messageOptions.includeStalled;
  // The latest availability read, so each answer below reports what the last recheck
  // found rather than what was true before caller code ran. Even this first one looks
  // the component up again: the `options` reads above can run the caller's getters.
  let availability = readAvailability(
    context,
    componentName,
    context.getComponent(componentName) === component,
    allowStopped,
    allowStalled,
  );
  const recheck = () => {
    availability = readAvailability(
      context,
      componentName,
      context.getComponent(componentName) === component,
      allowStopped,
      allowStalled,
    );
    return availability.refusalCode;
  };
  // Nothing is announced before dispatch, so a refusal up to then has no event to pair.
  // `hasHandler` is whether the handler read found one, as `getValueInternal()` reports.
  const refuseBeforeAnnouncement = (
    code: NonNullable<ReturnType<typeof readAvailability>['refusalCode']>,
    hasHandler: boolean,
  ): MessageResult => ({
    sent: false,
    componentFound: availability.isCurrent,
    componentRunning: false,
    handlerImplemented: hasHandler,
    data: undefined,
    error: null,
    timedOut: false,
    code,
  });
  if (availability.refusalCode !== undefined) {
    return refuseBeforeAnnouncement(availability.refusalCode, false);
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
    return refuseBeforeAnnouncement(
      handlerRead.refusal,
      typeof handlerRead.value === 'function',
    );
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

  // Validated before the sent event: an invalid budget must not leave `message-sent`
  // without its pair.
  let timeoutMS: number;
  try {
    timeoutMS = resolveOperationTimeoutMS(
      messageOptions.timeout,
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

  // Read once: a getter behind any of them would otherwise run - and could answer
  // differently - on each read. `componentNames` is copied as it is read.
  const broadcastOptions = snapshotBroadcastOptions(options);
  const targetNames = broadcastOptions.componentNames;
  const hasExplicitTargets = targetNames !== undefined && targetNames.size > 0;

  const allowStopped = broadcastOptions.includeStopped;
  const allowStalled = broadcastOptions.includeStalled;
  // What each message needs: every target is sent the same values, and the shared
  // budget is validated once, here, rather than once per component.
  const messageOptions: SendMessageOptions = {
    timeout: resolveOperationTimeoutMS(
      broadcastOptions.timeout,
      context.messageTimeoutMS,
      'broadcastMessage timeout',
    ),
    includeStopped: allowStopped,
    includeStalled: allowStalled,
  };

  // The one eligibility rule for both the selection and each send: running, or a
  // non-running state the caller opted into. Deliberately coarser than the shared
  // `isComponentEnterable()`: selection is by running membership, so a running
  // component that is mid-stop is still selected and answered `stopped` in the results
  // by `sendMessageInternal()`, which applies the shared rule to every send. Only a
  // late start's cleanup is excluded here - it marks its component running only to
  // stop it, so it is not a running member the caller asked about.
  const skipCodeFor = (name: string): 'stalled' | 'stopped' | undefined => {
    if (isComponentSelectedRunningMember(context, name)) {
      return undefined;
    }
    const isStalled = context.stalledComponents.has(name);
    if (isStalled ? allowStalled : allowStopped) {
      return undefined;
    }
    return isStalled ? 'stalled' : 'stopped';
  };

  // The registry is read only now, after every option: those reads can run the caller's
  // getters, which can register or unregister components. A snapshot taken before them
  // reported a component they removed and never sent to one they added.
  let targetComponents = context.components;

  // Filter by names if specified
  if (hasExplicitTargets) {
    targetComponents = targetComponents.filter((c) =>
      targetNames.has(context.nameOf(c)),
    );
  }

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
 * What {@link answerValueRequest} last found - whether the lookup found the component,
 * and the latest availability read - so a crash partway is answered with it.
 */
interface ValueAnswerProgress {
  hasComponent: boolean;
  availability?: ReturnType<typeof readAvailability>;
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
  // Found first, so a missing component answers `not_found` without its options being
  // read - as every operation but `restartComponent()` refuses.
  const component = context.getComponent(componentName);
  // Read before the requested event, so an options getter that throws fails the call
  // before anything was announced rather than leaving `value-requested` unpaired.
  const valueOptions = component ? snapshotGetValueOptions(options) : undefined;
  const allowStopped = valueOptions?.includeStopped ?? false;
  const allowStalled = valueOptions?.includeStalled ?? false;

  context.lifecycleEvents.componentValueRequested(componentName, key, from);

  const progress: ValueAnswerProgress = { hasComponent: false };

  let result: ValueResult<T>;
  try {
    result = answerValueRequest<T>(
      context,
      componentName,
      component,
      key,
      from,
      allowStopped,
      allowStalled,
      progress,
    );
  } catch (error) {
    // Every step of the answer guards the caller's code, so this is the manager breaking
    // its own invariant - or a seam it forwards to, such as a lookup, throwing. Answered
    // and reported here rather than left to the safety net in `getValue()`, which has no
    // `value-returned` to pair with the `value-requested` already sent.
    reportCallbackError('lifecycle-manager getValue', error);
    result = {
      found: false,
      value: undefined,
      componentFound: progress.availability?.isCurrent ?? progress.hasComponent,
      componentRunning: progress.availability?.isRunning ?? false,
      handlerImplemented: false,
      requestedBy: from,
      code: 'operation_crashed',
      error: toError(error),
    };
  }

  const { error: _error, ...eventResult } = result;
  context.lifecycleEvents.componentValueReturned(
    componentName,
    key,
    from,
    eventResult,
  );
  return result;
}

/**
 * The answer {@link getValueInternal} announces, once `value-requested` has gone out.
 * `progress` is updated as the answer learns more (see {@link ValueAnswerProgress}).
 */
function answerValueRequest<T>(
  context: ComponentAccessContext,
  componentName: string,
  component: ReturnType<ComponentAccessContext['getComponent']>,
  key: string,
  from: string | null,
  allowStopped: boolean,
  allowStalled: boolean,
  progress: ValueAnswerProgress,
): ValueResult<T> {
  if (!component) {
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
  progress.hasComponent = true;

  const refuseUnavailable = (
    availability: ReturnType<typeof readAvailability>,
    hasHandler: boolean,
  ): ValueResult<T> | undefined => {
    if (availability.refusalCode === undefined) {
      return undefined;
    }
    return {
      found: false,
      value: undefined,
      componentFound: availability.isCurrent,
      componentRunning: false,
      handlerImplemented: hasHandler,
      requestedBy: from,
      code: availability.refusalCode,
    };
  };
  // The latest availability read; see `sendMessageInternal()`. Even this first one
  // looks the component up again: the options getters and `value-requested` listeners
  // have run since the lookup that found `component`.
  let availability = readAvailability(
    context,
    componentName,
    context.getComponent(componentName) === component,
    allowStopped,
    allowStalled,
  );
  progress.availability = availability;
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
        context.getComponent(componentName) === component,
        allowStopped,
        allowStalled,
      );
      progress.availability = availability;
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
    const err = toError(handlerRead.error);

    // Logged as a message handler getter that throws is, besides the global report.
    context.logger
      .entity(componentName)
      .error('getValue handler failed: {{error.message}}', {
        params: { error: err, key, from },
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

  const getValueHandler = handlerRead.value;

  // Check if handler implemented
  if (typeof getValueHandler !== 'function') {
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
    const rawResult: unknown = Reflect.apply(getValueHandler, component, [
      key,
      from,
    ]);

    if (!isObjectLike(rawResult)) {
      throw new TypeError('getValue() did not return a ComponentValueResult');
    }
    // Refuse deferred work without invoking a lazy thenable. Native rejections are
    // contained, but a refused provider must not start new work after this call returns.
    const deferred = containDeferredResult(rawResult);
    if (deferred instanceof UnreadableReturn) {
      throw deferred;
    }
    if (deferred) {
      throw new TypeError(
        'getValue() must answer synchronously; the handler returned a promise',
      );
    }

    // Read and validate the synchronous answer once.
    const wasFound: unknown = Reflect.get(rawResult, 'found');
    if (typeof wasFound !== 'boolean') {
      throw new TypeError('getValue() result.found must be a boolean');
    }
    const value: unknown = Reflect.get(rawResult, 'value');

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
