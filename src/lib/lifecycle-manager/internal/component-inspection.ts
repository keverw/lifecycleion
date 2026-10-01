import type { ComponentAccessContext } from './component-access-context';
import type { BaseComponent } from '../base-component';
import { raceDeadline } from '../../internal/race-deadline';
import { optionalValidatedTimerDelayMS } from '../../internal/timer-limits';
import { reportCallbackError } from '../../safe-handle-callback';
import type {
  HealthCheckResult,
  HealthReport,
  ComponentHealthResult,
  SignalBroadcastResult,
  ComponentSignalResult,
} from '../types';
import { applyIntrinsic, allPromises } from '../../internal/intrinsics';
import { adoptPromise } from '../../internal/adopt-promise';
import { isObjectLike } from '../../internal/is-object-like';
import { toError, describeError } from '../../to-error';
import {
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED,
  LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
} from '../constants';
import {
  toOperationTimerDelayMS,
  isOperationTimeoutValidationError,
} from './operation-policy';

export interface SignalBroadcastDescriptor {
  signal: 'reload' | 'info' | 'debug';
  // The handler as read off the component, unbound: it is called with the component
  // as its receiver through the captured `applyIntrinsic`, never through its own `bind`.
  pickHandler: (component: BaseComponent) => unknown;
  startupLog: string;
  timeoutLog: string;
  errorLog: string;
  emitStarted: (name: string) => void;
  emitCompleted: (name: string) => void;
  emitFailed: (name: string, error: Error) => void;
}

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

  // Teardown may outlive the bulk shutdown latch. Do not enter a health hook
  // while either stop phase is still using the component.
  if (!context.isComponentUp(name)) {
    const isStalled = context.stalledComponents.has(name);
    return {
      name,
      healthy: false,
      message: isStalled
        ? LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED
        : LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING,
      checkedAt: startTime,
      durationMS: Date.now() - startTime,
      error: null,
      timedOut: false,
      code: isStalled ? 'stalled' : 'stopped',
    };
  }

  // Read once, guarded, and that value is what gets called - as `onMessage` and
  // `getValue` are read.
  let healthCheckHandler: unknown;
  let timeoutMS = 0;
  let readFailureMessage = 'Health check could not be read';

  try {
    healthCheckHandler = Reflect.get(component, 'healthCheck');
    // Configuration getters are caller code too. Capture the timeout before
    // announcing the check, and distinguish its failure from the handler itself.
    // A component without a health handler does not need timeout configuration.
    if (typeof healthCheckHandler === 'function') {
      readFailureMessage = 'Health check timeout could not be read';
      timeoutMS = toOperationTimerDelayMS(
        component.healthCheckTimeoutMS,
        `${name}.healthCheckTimeoutMS`,
      );
    }
  } catch (error) {
    const err = toError(error);

    if (!isOperationTimeoutValidationError(error)) {
      reportCallbackError('lifecycle-manager checkComponentHealth', error);
    }
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
      message: isOperationTimeoutValidationError(error)
        ? describeError(error)
        : readFailureMessage,
      checkedAt: startTime,
      durationMS: Date.now() - startTime,
      error: err,
      timedOut: false,
      code: isOperationTimeoutValidationError(error)
        ? 'invalid_options'
        : 'error',
    };
  }

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

  context.lifecycleEvents.componentHealthCheckStarted(name);

  // Handler/configuration getters and started listeners may unregister this
  // instance or begin teardown. Keep the announced check paired without entering
  // a hook whose component is no longer available.
  const isCurrent = context.getComponent(name) === component;
  if (!isCurrent || !context.isComponentUp(name)) {
    const isStalled = isCurrent && context.stalledComponents.has(name);
    const message = !isCurrent
      ? LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_FOUND
      : isStalled
        ? LIFECYCLE_MANAGER_MESSAGE_COMPONENT_STALLED
        : LIFECYCLE_MANAGER_MESSAGE_COMPONENT_NOT_RUNNING;
    context.lifecycleEvents.componentHealthCheckFailed(
      name,
      new Error(message),
    );
    return {
      name,
      healthy: false,
      message,
      checkedAt: startTime,
      durationMS: Date.now() - startTime,
      error: null,
      timedOut: false,
      code: !isCurrent ? 'not_found' : isStalled ? 'stalled' : 'stopped',
    };
  }

  try {
    const timeoutResult: ComponentHealthResult = {
      healthy: false,
      message: 'Health check timed out',
    };

    // Adopted, not raced as it is: see `adoptPromise()`.
    const healthCheckPromise = adoptPromise(
      applyIntrinsic(healthCheckHandler, component, []) as ReturnType<
        NonNullable<BaseComponent['healthCheck']>
      >,
    );
    // Match startup and signal timeout semantics: zero means no timer. Racing against
    // `setTimeout(..., 0)` made the outcome depend on whether an otherwise healthy
    // check happened to settle before or after its first asynchronous turn.
    const { value: result } = await raceDeadline(
      healthCheckPromise,
      optionalValidatedTimerDelayMS(timeoutMS),
      () => timeoutResult,
    );

    // Normalize boolean to ComponentHealthResult
    const isTimedOut = result === timeoutResult;
    if (isTimedOut) {
      context.logger.entity(name).warn('Health check timed out', {
        params: { timeoutMS },
      });
      context.observeFailureAfterTimeout(
        healthCheckPromise,
        name,
        'Health check failed after it had already timed out',
      );
    }
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
  }
}

export async function checkAllHealthOperation(
  context: ComponentAccessContext,
): Promise<HealthReport> {
  const startTime = Date.now();

  // Get all running components
  const runningComponents = context.components.filter((c) =>
    context.isComponentRunning(context.nameOf(c)),
  );

  // Check health of all running components in parallel
  const healthChecks = runningComponents.map((c) =>
    context.checkComponentHealth(context.nameOf(c)),
  );

  const { value: results } = await allPromises(healthChecks);

  // Overall healthy only if all components are healthy
  const isOverallHealthy = results.every((r) => r.healthy);
  const hasTimeout = results.some((r) => r.timedOut);
  const hasError = results.some(
    (r) => r.code === 'error' || r.code === 'invalid_options',
  );
  // "no_handler" is treated as healthy by design (implicit OK).
  const hasDegraded = results.some(
    (r) =>
      r.code === 'stopped' ||
      r.code === 'stalled' ||
      (r.code !== 'no_handler' && !r.healthy),
  );
  const code = hasError
    ? 'error'
    : hasTimeout
      ? 'timeout'
      : hasDegraded
        ? 'degraded'
        : 'ok';

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
      context.componentStates.get(name) === 'running' &&
      context.runningComponents.has(name)
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
    // The handler, and its timeout when there is one, are the component's own
    // properties, so they are read here, per component: one that throws becomes that
    // component's `error` entry, before any `*-started` event for it, rather than
    // ending the broadcast for every component after it.
    let handler: unknown;
    let timeoutMS = 0;

    try {
      handler = descriptor.pickHandler(component);

      // Only when there is a handler to time: a component without one answers
      // `no_handler`, whatever its timeout getter would have done.
      if (typeof handler === 'function') {
        timeoutMS = toOperationTimerDelayMS(
          component.signalTimeoutMS,
          `${name}.signalTimeoutMS`,
        );
      }
    } catch (error) {
      const err = toError(error);

      context.logger.entity(name).error(descriptor.errorLog, {
        params: { error: err },
      });

      results.push({
        name,
        called: false,
        error: err,
        timedOut: false,
        code: isOperationTimeoutValidationError(error)
          ? 'invalid_options'
          : 'error',
      });
      continue;
    }

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

    descriptor.emitStarted(name);
    // Event listeners can synchronously begin teardown too.
    if (!canDispatch(component)) {
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
      continue;
    }

    const timeoutResult = { timedOut: true } as const;

    try {
      const handlerResult: unknown = applyIntrinsic(handler, component, []);
      // Adopted, not raced as it is: see `adoptPromise()`.
      const handlerPromise = adoptPromise(handlerResult);

      const { value: outcome } = await raceDeadline(
        handlerPromise,
        optionalValidatedTimerDelayMS(timeoutMS),
        () => timeoutResult,
      );

      if (outcome === timeoutResult) {
        context.logger.entity(name).warn(descriptor.timeoutLog, {
          params: { timeoutMS },
        });
        context.observeFailureAfterTimeout(
          handlerPromise,
          name,
          'Lifecycle handler failed after it had already timed out',
        );
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
    } catch (error) {
      const err = toError(error);

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
    }
  }

  // Called handlers, plus any component that failed before its handler could be called.
  const calledResults = results.filter(
    (result) =>
      result.called ||
      result.code === 'error' ||
      result.code === 'invalid_options' ||
      result.code === 'unavailable',
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
