import type { BaseComponent } from '../base-component';
import type { ComponentAccessContext } from './component-access-context';
import { adoptPromise } from '../../internal/adopt-promise';
import {
  allSettledPromises,
  applyIntrinsic,
  awaitBoxedPromise,
  observePromise,
  promiseResolveIntrinsic,
} from '../../internal/intrinsics';
import { raceDeadline } from '../../internal/race-deadline';
import { reportCallbackError } from '../../safe-handle-callback';
import { toError } from '../../to-error';

export type ShutdownWarningContext = Pick<
  ComponentAccessContext,
  | 'getComponent'
  | 'componentStates'
  | 'isRawStartPending'
  | 'logger'
  | 'lifecycleEvents'
>;

/**
 * Global warning phase (stopAllComponents only)
 * Calls onShutdownWarning() on running components with a global timeout
 */
export async function runShutdownWarningPhase(
  context: ShutdownWarningContext,
  componentNames: string[],
  timeoutMS: number,
): Promise<void> {
  if (timeoutMS < 0 || componentNames.length === 0) {
    return;
  }

  // Running components and deliberately retried stalls may receive warnings.
  const warningTargets: Array<{
    name: string;
    component: BaseComponent;
    hook: () => unknown;
    state: 'running' | 'stalled';
  }> = [];

  for (const name of componentNames) {
    const component = context.getComponent(name);
    const state = context.componentStates.get(name);

    // Contained per component: the read runs the component's code, and a getter that
    // threw here used to end the whole pass as `operation_crashed` with every component
    // still running. That component just gets no warning; its stop still runs.
    let warningHook: unknown;

    try {
      warningHook =
        component === undefined
          ? undefined
          : Reflect.get(component, 'onShutdownWarning');
    } catch (error) {
      reportCallbackError(
        `lifecycle-manager shutdown warning for ${name}`,
        error,
      );
    }

    // A global timeout releases the manager-wide latch while this component can still
    // be stopping. Do not run its warning hook alongside stop()/onShutdownForce(), nor
    // alongside a timed-out forced start() that left it `stalled`.
    if (
      component !== undefined &&
      typeof warningHook === 'function' &&
      (state === 'running' || state === 'stalled') &&
      !context.isRawStartPending(name)
    ) {
      warningTargets.push({
        name,
        component,
        hook: warningHook as () => unknown,
        state,
      });
    }
  }

  if (warningTargets.length === 0) {
    return;
  }

  context.logger.info('Shutdown warning phase');
  context.lifecycleEvents.lifecycleManagerShutdownWarning(timeoutMS);

  // Both delivery modes share the invocation boundary. Returning an explicit
  // outcome lets the timed mode track rejections without starting a second
  // reporting chain; the detached mode can safely ignore the settled promise.
  const startWarning = ({
    name,
    component,
    hook,
    state: selectedState,
  }: (typeof warningTargets)[number]): Promise<
    'resolved' | 'rejected' | 'skipped'
  > => {
    context.lifecycleEvents.componentShutdownWarning(name);
    return (async () => {
      try {
        await promiseResolveIntrinsic(undefined);
        // Target selection and notifications preceded this microtask. Automatic
        // cleanup of a failed start can begin meanwhile even though public stops
        // are refused during shutdown. Require the selected state too: a running
        // target that became stalled has finished a failed teardown, whereas a
        // target selected as stalled was explicitly included for another stop try.
        const current = context.getComponent(name);
        const state = context.componentStates.get(name);
        if (current !== component || state !== selectedState) {
          context.lifecycleEvents.componentShutdownWarningSkipped(
            name,
            current !== component
              ? 'component_changed'
              : 'component_not_available',
            state,
          );
          return 'skipped' as const;
        }
        await awaitBoxedPromise(
          adoptPromise(applyIntrinsic(hook, component, [])),
        );
        context.lifecycleEvents.componentShutdownWarningCompleted(name);
        return 'resolved' as const;
      } catch (error) {
        try {
          context.logger
            .entity(name)
            .warn('Shutdown warning phase failed: {{error.message}}', {
              params: { error: toError(error) },
            });
        } catch {
          // A detached warning must contain a failure in its reporting path.
        }
        return 'rejected' as const;
      }
    })();
  };

  if (timeoutMS === 0) {
    for (const target of warningTargets) {
      void startWarning(target);
    }
    // Start warning callbacks before publishing the fire-and-forget broadcast.
    await promiseResolveIntrinsic(undefined);
    context.lifecycleEvents.lifecycleManagerShutdownWarningCompleted(timeoutMS);
    return;
  }

  const statuses = new Map<
    string,
    'pending' | 'resolved' | 'rejected' | 'skipped'
  >();
  const warningPromises: Promise<void>[] = [];
  for (const target of warningTargets) {
    statuses.set(target.name, 'pending');
    warningPromises.push(
      observePromise(startWarning(target), (status) => {
        statuses.set(target.name, status);
      }),
    );
  }

  // The warning phase uses an ordinary deadline; shutdown abort hooks stay local.
  const { value: result } = await raceDeadline(
    observePromise(
      allSettledPromises(warningPromises),
      () => 'completed' as const,
    ),
    timeoutMS,
    () => 'timeout' as const,
  );

  if (result === 'timeout') {
    const pendingComponents = warningTargets.filter(
      ({ name }) => statuses.get(name) === 'pending',
    );

    for (const { name } of pendingComponents) {
      context.logger.entity(name).warn('Shutdown warning phase timed out', {
        params: { timeoutMS },
      });

      context.lifecycleEvents.componentShutdownWarningTimeout(name, timeoutMS);
    }

    // Global timeout: proceed to graceful shutdown regardless of pending warnings.
    context.logger.warn('Shutdown warning phase timed out', {
      params: { timeoutMS, pending: pendingComponents.length },
    });

    context.lifecycleEvents.lifecycleManagerShutdownWarningTimeout(
      timeoutMS,
      pendingComponents.map(({ name }) => name),
    );

    return;
  }

  context.lifecycleEvents.lifecycleManagerShutdownWarningCompleted(timeoutMS);
}
