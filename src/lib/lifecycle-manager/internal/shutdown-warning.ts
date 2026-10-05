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
import { isHookEntryBlocked } from './component-dispatch';

export type ShutdownWarningContext = Pick<
  ComponentAccessContext,
  | 'getComponent'
  | 'componentStates'
  | 'isRawStartPending'
  | 'isLateStartCleanupPending'
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
    // be stopping. Do not run its warning hook alongside stop()/onShutdownForce(),
    // alongside a timed-out forced start() that left it `stalled`, nor on a late
    // start's cleanup, which marks it `running` only to stop it: the shared rule (see
    // `isHookEntryBlocked()`). Unlike the other hooks, a `stalled` component the pass
    // retries is warned too, so this does not also require running membership.
    if (
      component !== undefined &&
      typeof warningHook === 'function' &&
      (state === 'running' || state === 'stalled') &&
      !isHookEntryBlocked(context, name, state)
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

  // Components already announced as timed out. Their hooks keep running, but each
  // component gets one outcome: a hook that resolves after its timeout was announced
  // does not follow `component:shutdown-warning-timeout` (and the phase's own timeout)
  // with a `completed` that contradicts them.
  const timedOutNames = new Set<string>();

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
        if (
          current !== component ||
          state !== selectedState ||
          // The same state, but a phase took the component meanwhile - a late start's
          // cleanup keeps it `running` - and owns it until that phase ends.
          isHookEntryBlocked(context, name, state)
        ) {
          // Unregistered and replaced are told apart: `component_changed` for a target
          // that was simply removed sent listeners looking for a replacement.
          context.lifecycleEvents.componentShutdownWarningSkipped(
            name,
            current === undefined
              ? 'component_not_found'
              : current !== component
                ? 'component_changed'
                : 'component_not_available',
            state,
          );
          return 'skipped' as const;
        }
        await awaitBoxedPromise(
          adoptPromise(applyIntrinsic(hook, component, [])),
        );
        if (!timedOutNames.has(name)) {
          context.lifecycleEvents.componentShutdownWarningCompleted(name);
        }
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
      timedOutNames.add(name);
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
