import type { ComponentAccessContext } from './component-access-context';
import type { BaseComponent } from '../base-component';
import { reportCallbackError } from '../../safe-handle-callback';
import type {
  HealthCheckResult,
  HealthReport,
  ComponentHealthResult,
  SignalBroadcastResult,
  ComponentSignalResult,
} from '../types';
import { isObjectLike } from '../../internal/is-object-like';
import { toError, describeError } from '../../to-error';
import {
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
} from '../constants';
import {
  toOperationTimerDelayMS,
  settledFailureCode,
  takeSettledFailureCode,
} from './operation-policy';
import {
  dispatchAnnouncedHook,
  isComponentEnterable,
  isComponentSelectedRunningMember,
  readHookThenRecheck,
  unavailableComponentCode,
  type UnavailableComponentCode,
} from './component-dispatch';

/** The public method each signal broadcast is named after when it reports a crash. */
const SIGNAL_TRIGGER_OPERATIONS = {
  reload: 'triggerReload',
  info: 'triggerInfo',
  debug: 'triggerDebug',
} as const;

interface SignalBroadcastDescriptor {
  signal: 'reload' | 'info' | 'debug';
  // The handler as read off the component, unbound: it is called with the component
  // as its receiver through `Reflect.apply`, never through its own `bind`.
  pickHandler: (component: BaseComponent) => unknown;
  startupLog: string;
  timeoutLog: string;
  errorLog: string;
  emitStarted: (name: string) => void;
  emitCompleted: (name: string) => void;
  emitFailed: (name: string, error: Error) => void;
}

type HealthRefusalCode = UnavailableComponentCode;

/** What a health check that timed out is reported as having answered. */
const HEALTH_CHECK_TIMEOUT_RESULT: ComponentHealthResult = Object.freeze({
  healthy: false,
  message: 'Health check timed out',
});

/**
 * Why a health hook must not be entered now, or `undefined` if it may be: the shared
 * rule (see `isComponentEnterable()`), labelled as every refusal is (see
 * `unavailableComponentCode()`). `isCurrent` is the caller's, as `readAvailability()`
 * takes it: whether the checked instance is still the one registered under `name`.
 */
function healthRefusal(
  context: ComponentAccessContext,
  name: string,
  isCurrent: boolean,
): HealthRefusalCode | undefined {
  if (
    isCurrent &&
    isComponentEnterable(context, name, context.componentStates.get(name))
  ) {
    return undefined;
  }
  return unavailableComponentCode(context, name, isCurrent);
}

const HEALTH_REFUSAL_MESSAGES: Record<HealthRefusalCode, string> = {
  not_found: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  stalled: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  stopped: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
};

export async function checkComponentHealthOperation(
  context: ComponentAccessContext,
  name: string,
): Promise<HealthCheckResult> {
  const startTime = Date.now();

  // Check if component exists
  const component = context.getComponent(name);

  if (!component) {
    return {
      name,
      healthy: false,
      message: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
      checkedAt: startTime,
      durationMS: 0,
      error: null,
      timedOut: false,
      code: 'not_found',
    };
  }

  const refused = (code: HealthRefusalCode): HealthCheckResult => ({
    name,
    healthy: false,
    message: HEALTH_REFUSAL_MESSAGES[code],
    checkedAt: startTime,
    durationMS: Date.now() - startTime,
    error: null,
    timedOut: false,
    code,
  });
  const recheck = () =>
    healthRefusal(context, name, context.getComponent(name) === component);

  // `component` was just looked up by `name`, with no caller code since: still current.
  const initialRefusal = healthRefusal(context, name, true);
  if (initialRefusal !== undefined) {
    return refused(initialRefusal);
  }

  // Read once, guarded, and that value is what gets called - as `onMessage` and
  // `getValue` are read - then availability rechecked: the getters can stop or
  // unregister the component, which then answers its refusal, not `no_handler`
  // (counted healthy) or a crash.
  let timeoutMS = 0;
  let readFailureMessage = 'Health check could not be read';
  const handlerRead = readHookThenRecheck(
    () => {
      const handler: unknown = Reflect.get(component, 'healthCheck');
      // Configuration getters are caller code too. Capture the timeout before
      // announcing the check, and distinguish its failure from the handler itself.
      // A component without a health handler does not need timeout configuration.
      if (typeof handler === 'function') {
        readFailureMessage = 'Health check timeout could not be read';
        timeoutMS = toOperationTimerDelayMS(
          component.healthCheckTimeoutMS,
          `${name}.healthCheckTimeoutMS`,
        );
      }
      return handler;
    },
    (error) => {
      if (settledFailureCode(error) !== 'invalid_options') {
        reportCallbackError('lifecycle-manager checkComponentHealth', error);
      }
    },
    recheck,
  );

  if (handlerRead.status === 'refused') {
    return refused(handlerRead.refusal);
  }

  if (handlerRead.status === 'read_failed') {
    const { error } = handlerRead;
    const err = toError(error);
    // Read before the logger and listeners are handed the error.
    const code = takeSettledFailureCode(error);

    // Logged and announced as every other failed check is - `started` first, so a
    // listener counting checks in flight stays paired - and counted as a failure.
    context.logger
      .entity(name)
      .error('Health check failed: {{error.message}}', {
        params: { error: err },
      });
    context.lifecycleEvents.componentHealthCheckStarted(name);
    context.lifecycleEvents.componentHealthCheckFailed(name, err);

    return {
      name,
      healthy: false,
      message:
        code === 'invalid_options' ? describeError(error) : readFailureMessage,
      checkedAt: startTime,
      durationMS: Date.now() - startTime,
      error: err,
      timedOut: false,
      // A getter that throws broke the component's contract: not a failed check.
      code,
    };
  }

  const healthCheckHandler = handlerRead.value;

  // Check if component implements healthCheck
  if (typeof healthCheckHandler !== 'function') {
    // No health check implemented - assume healthy
    return {
      name,
      healthy: true,
      message: 'No health check implemented',
      checkedAt: startTime,
      durationMS: Date.now() - startTime,
      error: null,
      timedOut: false,
      code: 'no_handler',
    };
  }

  const failed = (error: unknown): HealthCheckResult => {
    const durationMS = Date.now() - startTime;
    const err = toError(error);

    context.logger
      .entity(name)
      .error('Health check failed: {{error.message}}', {
        params: { error: err },
      });

    context.lifecycleEvents.componentHealthCheckFailed(name, err);

    return {
      name,
      healthy: false,
      message: 'Health check threw error',
      checkedAt: startTime,
      durationMS,
      error: err,
      timedOut: false,
      code: 'error',
    };
  };

  // Handler/configuration getters and started listeners may unregister this
  // instance or begin teardown. Keep the announced check paired without entering
  // a hook whose component is no longer available.
  const dispatch = await dispatchAnnouncedHook(context, {
    name,
    component,
    handler: healthCheckHandler,
    args: [],
    timeoutMS,
    announce: () => {
      context.lifecycleEvents.componentHealthCheckStarted(name);
    },
    recheck,
    timeoutLog: 'Health check timed out',
    timeoutLogParams: { timeoutMS },
    lateFailureMessage: 'Health check failed after it had already timed out',
  });

  if (dispatch.status === 'refused') {
    const result = refused(dispatch.refusal);
    context.lifecycleEvents.componentHealthCheckFailed(
      name,
      new Error(result.message),
    );
    return result;
  }

  if (dispatch.status === 'threw') {
    return failed(dispatch.error);
  }

  try {
    // Normalize boolean to ComponentHealthResult
    const isTimedOut = dispatch.status === 'timed_out';
    // Typed as the hook promises; `isObjectLike()` and the type checks below are what
    // actually validate it.
    const result = isTimedOut
      ? HEALTH_CHECK_TIMEOUT_RESULT
      : (dispatch.value as Awaited<
          ReturnType<NonNullable<BaseComponent['healthCheck']>>
        >);
    // A malformed return is a contract failure, not a throw from the handler.
    // Read healthy once before validating its type: accepting truthy non-booleans
    // would let checkAllHealth report a malformed component as healthy. The other
    // fields are captured before publication too, so getters and event listeners
    // cannot make the completed event disagree with the returned snapshot.
    let isHealthy: unknown;
    let message: ComponentHealthResult['message'];
    let details: ComponentHealthResult['details'];
    let returnError: TypeError | undefined;
    try {
      isHealthy =
        typeof result === 'boolean'
          ? result
          : isObjectLike(result)
            ? result.healthy
            : undefined;
      if (typeof isHealthy === 'boolean' && typeof result !== 'boolean') {
        // Optional metadata from plain JavaScript and JSON often uses null for
        // absence. Normalize it before validation without re-reading any getter.
        message = result.message ?? undefined;
        details = result.details ?? undefined;
        if (message !== undefined && typeof message !== 'string') {
          returnError = new TypeError(
            'healthCheck() result.message must be a string or undefined',
          );
        } else if (
          details !== undefined &&
          (typeof details !== 'object' || Array.isArray(details))
        ) {
          // Details are opaque metadata. Class instances can satisfy the record
          // contract too, so validation does not require a plain prototype.
          returnError = new TypeError(
            'healthCheck() result.details must be a non-array object or undefined',
          );
        }
      }
    } catch (error) {
      // These getters belong to the returned value, not the completed invocation.
      // Keep their original failure as the cause without emitting a completed event
      // or describing the healthCheck call itself as having thrown.
      returnError = new TypeError(
        'healthCheck() returned a ComponentHealthResult whose fields could not be read',
        { cause: error },
      );
    }
    if (typeof isHealthy !== 'boolean' || returnError !== undefined) {
      const error =
        returnError ??
        new TypeError(
          'healthCheck() did not return a boolean or ComponentHealthResult',
        );
      context.logger
        .entity(name)
        .error('Health check returned an invalid result: {{error.message}}', {
          params: { error },
        });
      context.lifecycleEvents.componentHealthCheckFailed(name, error);
      return {
        name,
        healthy: false,
        message: error.message,
        checkedAt: startTime,
        durationMS: Date.now() - startTime,
        error,
        timedOut: false,
        code: 'error',
      };
    }

    const durationMS = Date.now() - startTime;
    context.lifecycleEvents.componentHealthCheckCompleted({
      name,
      healthy: isHealthy,
      message,
      details,
      durationMS,
      timedOut: isTimedOut,
    });

    return {
      name,
      healthy: isHealthy,
      message,
      details,
      checkedAt: startTime,
      durationMS,
      error: null,
      timedOut: isTimedOut,
      code: isTimedOut ? 'timeout' : 'ok',
    };
  } catch (error) {
    return failed(error);
  }
}

export async function checkAllHealthOperation(
  context: ComponentAccessContext,
): Promise<HealthReport> {
  const startTime = Date.now();

  // Running members, selected as `broadcastMessage()` selects its recipients: a late
  // start's cleanup marks its component running only to stop it, so it is not one the
  // report is about. Checked, it answered `stopped` and flipped the aggregate to
  // `degraded`. A running member that is mid-stop is still selected and answers
  // `stopped`, as a broadcast reports it.
  const runningComponents = context.components.filter((c) => {
    const name = context.nameOf(c);
    return isComponentSelectedRunningMember(context, name);
  });

  // Check health of all running components in parallel
  const healthChecks = runningComponents.map((component) => {
    const name = context.nameOf(component);
    // Earlier hook getters can replace a later selected instance before this dispatch.
    // Keep the report about its original selection, never the replacement by name.
    if (context.getComponent(name) !== component) {
      return Promise.resolve<HealthCheckResult>({
        name,
        healthy: false,
        message: LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
        checkedAt: Date.now(),
        durationMS: 0,
        error: null,
        timedOut: false,
        code: 'not_found',
      });
    }
    return context.checkComponentHealth(name);
  });

  const results = await Promise.all(healthChecks);

  // Overall healthy only if all components are healthy. "no_handler" is healthy by
  // design (implicit OK); every refusal - not_found, stopped, stalled - is not.
  const isOverallHealthy = results.every((r) => r.healthy);
  const hasTimeout = results.some((r) => r.timedOut);
  // Only an entry that failed with an error carries one: a throw, an unreadable hook or
  // timeout, an invalid result. Refusals, timeouts and an unhealthy answer fail with
  // `error: null`, and no healthy entry carries one.
  const hasError = results.some((r) => r.error !== null);
  // Any unhealthy entry without an error or a timeout leaves the report degraded.
  const code = hasError
    ? 'error'
    : hasTimeout
      ? 'timeout'
      : isOverallHealthy
        ? 'ok'
        : 'degraded';

  return {
    healthy: isOverallHealthy,
    components: results,
    checkedAt: startTime,
    durationMS: Date.now() - startTime,
    timedOut: hasTimeout,
    code,
  };
}

export async function runSignalBroadcast(
  context: ComponentAccessContext,
  descriptor: SignalBroadcastDescriptor,
): Promise<SignalBroadcastResult> {
  const results: ComponentSignalResult[] = [];

  const canDispatch = (component: BaseComponent): boolean => {
    const name = context.nameOf(component);

    return (
      context.getComponent(name) === component &&
      isComponentEnterable(context, name, context.componentStates.get(name))
    );
  };
  const targets = context.components.filter(canDispatch);

  if (context.isStarting) {
    context.logger.info(descriptor.startupLog);
  }

  for (const component of targets) {
    const name = context.nameOf(component);
    if (!canDispatch(component)) {
      continue;
    }
    const recheck = () =>
      canDispatch(component) ? undefined : ('unavailable' as const);
    // A target selected for dispatch that caller code then makes unavailable - its
    // handler or timeout getter, or a `*-started` listener - answers one `unavailable`
    // entry, announced `started` then `failed` like every other failed dispatch.
    const refuseUnavailable = (): void => {
      const error = new Error(
        `Component "${name}" became unavailable before ${descriptor.signal} dispatch`,
      );
      descriptor.emitFailed(name, error);
      results.push({
        name,
        called: false,
        error,
        timedOut: false,
        code: 'unavailable',
      });
    };
    // The handler, and its timeout when there is one, are the component's own
    // properties, so they are read here, per component: one that throws becomes that
    // component's `operation_crashed` entry - an invalid timeout its `invalid_options`
    // entry - rather than ending the broadcast for every component after it.
    let timeoutMS = 0;
    const handlerRead = readHookThenRecheck(
      () => {
        const handler = descriptor.pickHandler(component);

        // Only when there is a handler to time: a component without one answers
        // `no_handler`, whatever its timeout getter would have done.
        if (typeof handler === 'function') {
          timeoutMS = toOperationTimerDelayMS(
            component.signalTimeoutMS,
            `${name}.signalTimeoutMS`,
          );
        }
        return handler;
      },
      (error) => {
        // Reported as every other getter that throws is; an invalid timeout is an
        // expected refusal, not a crash.
        if (settledFailureCode(error) !== 'invalid_options') {
          reportCallbackError(
            `lifecycle-manager ${SIGNAL_TRIGGER_OPERATIONS[descriptor.signal]}`,
            error,
          );
        }
      },
      recheck,
    );

    // The read itself took the component down. It was already selected for this
    // dispatch, so it is reported as a started listener taking it down is - `started`
    // then `failed`, back to back, as a failed read is - whether or not the read found a
    // handler or threw (that failure was reported above; availability answers).
    if (handlerRead.status === 'refused') {
      descriptor.emitStarted(name);
      refuseUnavailable();
      continue;
    }

    if (handlerRead.status === 'read_failed') {
      const err = toError(handlerRead.error);
      // Read before the logger and listeners are handed the error.
      const code = takeSettledFailureCode(handlerRead.error);

      // Logged and announced as a health check whose configuration read fails is -
      // `started` first, so a listener counting signals in flight stays paired - and
      // counted as a failure.
      context.logger.entity(name).error(descriptor.errorLog, {
        params: { error: err },
      });
      descriptor.emitStarted(name);
      descriptor.emitFailed(name, err);

      results.push({
        name,
        called: false,
        error: err,
        timedOut: false,
        code,
      });
      continue;
    }

    const handler = handlerRead.value;

    if (typeof handler !== 'function') {
      results.push({
        name,
        called: false,
        error: null,
        timedOut: false,
        code: 'no_handler',
      });
      continue;
    }

    // Event listeners can synchronously begin teardown too; the dispatch rechecks after
    // the started event's listeners, even for a broadcast made from inside another
    // manager event listener, where `*-started` is only queued.
    const dispatch = await dispatchAnnouncedHook(context, {
      name,
      component,
      handler,
      args: [],
      timeoutMS,
      announce: () => {
        descriptor.emitStarted(name);
      },
      recheck,
      timeoutLog: descriptor.timeoutLog,
      timeoutLogParams: { timeoutMS },
      lateFailureMessage:
        'Lifecycle handler failed after it had already timed out',
    });

    if (dispatch.status === 'refused') {
      refuseUnavailable();
    } else if (dispatch.status === 'timed_out') {
      descriptor.emitFailed(
        name,
        new Error(
          `${descriptor.signal} handler timed out after ${timeoutMS}ms`,
        ),
      );
      results.push({
        name,
        called: true,
        error: null,
        timedOut: true,
        code: 'timeout',
      });
    } else if (dispatch.status === 'threw') {
      const err = toError(dispatch.error);

      context.logger.entity(name).error(descriptor.errorLog, {
        params: { error: err },
      });

      descriptor.emitFailed(name, err);

      results.push({
        name,
        called: true,
        error: err,
        timedOut: false,
        code: 'error',
      });
    } else {
      descriptor.emitCompleted(name);
      results.push({
        name,
        called: true,
        error: null,
        timedOut: false,
        code: 'called',
      });
    }
  }

  // Called handlers, plus any component that failed before its handler could be called:
  // only those carry an error without being called.
  const calledResults = results.filter(
    (result) => result.called || result.error !== null,
  );
  const hasError = calledResults.some((result) => result.error);
  const isAllError =
    calledResults.length > 0 && calledResults.every((result) => result.error);
  const hasTimeout = calledResults.some((result) => result.timedOut);
  const isAllTimeout =
    calledResults.length > 0 &&
    calledResults.every((result) => result.timedOut);
  const code = hasError
    ? isAllError
      ? 'error'
      : 'partial_error'
    : hasTimeout
      ? isAllTimeout
        ? 'timeout'
        : 'partial_timeout'
      : 'ok';

  return {
    signal: descriptor.signal,
    results,
    timedOut: hasTimeout,
    code,
  };
}
