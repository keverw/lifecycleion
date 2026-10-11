import type { BaseComponent } from '../base-component';
import type { ComponentAccessContext } from './component-access-context';
import { adoptPromise } from '../../internal/adopt-promise';
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
 * The warning phase of every shutdown pass - `stopAllComponents()`, a shutdown signal,
 * the logger exit hook, a restart's stop phase - but not of a single `stopComponent()`.
 * Calls onShutdownWarning() on running components, and on stalled ones the pass is
 * retrying, under one shared timeout.
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

    // A global timeout releases the manager-wide latch while this component can still
    // be stopping. Do not run its warning hook alongside stop()/onShutdownForce(),
    // alongside a timed-out forced start() that left it `stalled`, nor on a late
    // start's cleanup, which marks it `running` only to stop it: the shared rule (see
    // `isHookEntryBlocked()`). Unlike the other hooks, a `stalled` component the pass
    // retries is warned too, so this does not also require running membership.
    // Decided before the hook is read: the read runs the component's code, which has no
    // business running - nor its failure being reported - for a component never warned.
    if (
      component === undefined ||
      (state !== 'running' && state !== 'stalled') ||
      isHookEntryBlocked(context, name, state)
    ) {
      continue;
    }

    // Contained per component: the read runs the component's code, and a getter that
    // threw here used to end the whole pass as `operation_crashed` with every component
    // still running. That component just gets no warning; its stop still runs.
    let warningHook: unknown;

    try {
      warningHook = Reflect.get(component, 'onShutdownWarning');
    } catch (error) {
      reportCallbackError(
        `lifecycle-manager shutdown warning for ${name}`,
        error,
      );
    }

    // The getter may have begun teardown; the recheck before invocation skips it then.
    if (typeof warningHook === 'function') {
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

  // Each selected component gets exactly one terminal event: completed, failed,
  // skipped, or timeout. The outcome is recorded synchronously where its event is
  // emitted, so the timeout branch - which resumes some microtasks after its deadline
  // fired - never announces a component whose hook settled in that gap, and a hook that
  // settles after its timeout was announced emits nothing further (a late failure is
  // still logged).
  const outcomes = new Map<
    string,
    'completed' | 'failed' | 'skipped' | 'timeout'
  >();
  const settle = (
    name: string,
    outcome: 'completed' | 'failed' | 'skipped' | 'timeout',
  ): boolean => {
    if (outcomes.has(name)) {
      return false;
    }
    outcomes.set(name, outcome);
    return true;
  };

  // Both delivery modes share the invocation boundary. Neither awaits the outcome: the
  // timed mode races the settled promises against its deadline, and the detached mode
  // ignores them.
  const startWarning = ({
    name,
    component,
    hook,
    state: selectedState,
  }: (typeof warningTargets)[number]): Promise<void> => {
    context.lifecycleEvents.componentShutdownWarning(name);
    return (async () => {
      try {
        await Promise.resolve(undefined);
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
          if (settle(name, 'skipped')) {
            context.lifecycleEvents.componentShutdownWarningSkipped(
              name,
              current === undefined
                ? 'component_not_found'
                : current !== component
                  ? 'component_changed'
                  : 'component_not_available',
              state,
            );
          }
          return;
        }
        await adoptPromise(Reflect.apply(hook, component, []));
        if (settle(name, 'completed')) {
          context.lifecycleEvents.componentShutdownWarningCompleted(name);
        }
      } catch (error) {
        // A synchronous throw from the hook lands here too, through `Reflect.apply`.
        // After the timeout was announced the failure is only logged: the component
        // already has its terminal event.
        const isFirstOutcome = settle(name, 'failed');
        let failure: Error | undefined;
        try {
          failure = toError(error);
          context.logger
            .entity(name)
            .warn(
              isFirstOutcome
                ? 'Shutdown warning phase failed: {{error.message}}'
                : 'Shutdown warning failed after its outcome was reported: {{error.message}}',
              { params: { error: failure } },
            );
        } catch {
          // A detached warning must contain a failure in its reporting path.
        }
        if (isFirstOutcome) {
          // Event delivery contains listener failures, so this cannot escape.
          context.lifecycleEvents.componentShutdownWarningFailed(
            name,
            failure ?? new Error('Shutdown warning hook failed'),
          );
        }
      }
    })();
  };

  if (timeoutMS === 0) {
    for (const target of warningTargets) {
      void startWarning(target);
    }
    // Start warning callbacks before publishing the fire-and-forget broadcast.
    await Promise.resolve(undefined);
    context.lifecycleEvents.lifecycleManagerShutdownWarningCompleted(timeoutMS);
    return;
  }

  const warningPromises: Promise<void>[] = [];
  for (const target of warningTargets) {
    warningPromises.push(startWarning(target));
  }

  // The warning phase uses an ordinary deadline; shutdown abort hooks stay local.
  const result = await raceDeadline(
    Promise.allSettled(warningPromises).then(() => 'completed' as const),
    timeoutMS,
    () => 'timeout' as const,
  );

  if (result === 'timeout') {
    // Components whose hook already completed, failed, or was skipped are not pending.
    const pendingComponents = warningTargets.filter(({ name }) =>
      settle(name, 'timeout'),
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
