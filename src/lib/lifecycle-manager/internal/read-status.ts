import { reportCallbackError } from '../../safe-handle-callback';
import type { ComponentStatus } from '../types';
import type { ManagerCore } from './manager-core';

/**
 * A component's status for a result or an event, read through the public
 * `getComponentStatus()` so a subclass override or an instance patch is the one that
 * runs. Read guarded: a throw from an override must not turn an operation that already
 * happened into a crash, or cost an event its delivery. Reported under `context`, and
 * left out.
 */
export function readComponentStatus(
  core: ManagerCore,
  name: string,
  context: string,
): ComponentStatus | undefined {
  try {
    return core.manager.getComponentStatus(name);
  } catch (error) {
    reportCallbackError(context, error);
    return undefined;
  }
}
