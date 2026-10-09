import type {
  StartComponentOptions,
  StartupOptions,
  StopComponentOptions,
} from '../types';
import type { RestartStartSnapshot } from './component-start';
import type { IndividualStopContext } from './component-stop';
import type { ManagerCore } from './manager-core';
import type {
  StartOptionsSnapshot,
  StartupOptionsSnapshot,
  StopOptionsSnapshot,
} from './operation-options';

/*
 * A restart stops and starts through the manager's public `stopComponent()`,
 * `startComponent()` and `startAllComponents()`, called through `core.manager`, so a
 * subclass override or an instance patch of one runs for a restart too. Those methods
 * take only the public options, and a restart carries more than they say: the options it
 * already read and validated, the registrations it approved before stopping anything,
 * and the stop claim it watches.
 *
 * That context travels with the options object the restart hands the public method.
 * The object is a frozen copy of the restart's own options, and this module keeps the
 * context against its identity: the public method's body looks the object up - an
 * identity lookup, which runs no caller code and can be made before any refusal - and
 * finds the context only for the object the restart issued. Nothing else can produce
 * one. An override that hands that object on keeps the restart's behavior; one that
 * passes a new object gets a plain start or stop of the name.
 *
 * Each context is taken at most once, only by the manager whose restart issued it, only
 * for the name it was issued for, and only while the restart's public call is still
 * pending: the restart revokes it once that call settles (`revokeRestartDispatch()`). A
 * second call with the same object, a call on another manager or for another name, or a
 * replay of a saved object after the call, is a plain call.
 */

interface RestartDispatchBase {
  /** The core of the manager whose restart issued this context: only it takes it. */
  readonly issuer: ManagerCore;
  /** Set once a public method took this context: the override handed the object on. */
  taken: boolean;
}

/**
 * `restartComponent()`'s stop: its options snapshot, its call-local stop context, and the
 * registration it approved - the stop refuses any other, as the start does.
 */
export interface RestartStopDispatch extends RestartDispatchBase {
  readonly kind: 'stop';
  readonly name: string;
  readonly stopOptions: StopOptionsSnapshot;
  readonly stopContext: IndividualStopContext;
  readonly startSnapshot: RestartStartSnapshot;
}

/** `restartComponent()`'s start: its options snapshot and the registration it approved. */
export interface RestartStartDispatch extends RestartDispatchBase {
  readonly kind: 'start';
  readonly name: string;
  readonly startOptions: StartOptionsSnapshot;
  readonly startSnapshot: RestartStartSnapshot;
  /** `stayDownRequestCount` when the restart's stop began: see `restartStartOperation()`. */
  readonly stayDownRequestCount: number;
  /** Set when the start refused because a shutdown asked to stay down meanwhile. */
  canceled: boolean;
}

/** `restartAllComponents()`'s startup phase: its validated options and saved snapshots. */
export interface RestartStartupDispatch extends RestartDispatchBase {
  readonly kind: 'startup';
  readonly startupOptions: StartupOptionsSnapshot;
  readonly restartSnapshots: Map<string, RestartStartSnapshot>;
  /** `stayDownPassCount` when the stop phase began: see `refuseCanceledRestartStartup()`. */
  readonly stayDownPassCount: number;
  /** Set when the startup refused because a shutdown asked to stay down meanwhile. */
  canceled: boolean;
}

type RestartDispatch =
  RestartStopDispatch | RestartStartDispatch | RestartStartupDispatch;

const dispatches = new WeakMap<object, RestartDispatch>();

/**
 * The options object a restart hands a public method: a frozen copy of its own options,
 * which carries `dispatch` to that method's body.
 */
export function restartDispatchOptions(
  dispatch: RestartStopDispatch,
): StopComponentOptions;
export function restartDispatchOptions(
  dispatch: RestartStartDispatch,
): StartComponentOptions;
export function restartDispatchOptions(
  dispatch: RestartStartupDispatch,
): StartupOptions;
export function restartDispatchOptions(dispatch: RestartDispatch): object {
  let options: object;
  switch (dispatch.kind) {
    case 'stop':
      options = {
        allowStopWithRunningDependents:
          dispatch.stopOptions.allowStopWithRunningDependents,
        forceImmediate: dispatch.stopOptions.forceImmediate,
        timeout: dispatch.stopOptions.timeout,
      };
      break;
    case 'start':
      options = {
        allowDuringBulkStartup: dispatch.startOptions.allowDuringBulkStartup,
        forceStalled: dispatch.startOptions.forceStalled,
        allowNonRunningDependencies:
          dispatch.startOptions.allowNonRunningDependencies,
      };
      break;
    case 'startup':
      options = {
        ignoreStalledComponents:
          dispatch.startupOptions.ignoreStalledComponents,
        timeoutMS: dispatch.startupOptions.timeoutMS,
      };
      break;
  }
  dispatches.set(Object.freeze(options), dispatch);
  return options;
}

/**
 * Ends the context `options` carries, taken or not: called by the restart once the public
 * call it handed `options` to has settled, so an override that kept the object cannot
 * replay the restart's context later.
 */
export function revokeRestartDispatch(options: object): void {
  dispatches.delete(options);
}

/**
 * The restart stop `options` carries for `name` on `core`'s manager, taken; `undefined`
 * for a plain stop.
 */
export function takeRestartStopDispatch(
  core: ManagerCore,
  name: string,
  options: unknown,
): RestartStopDispatch | undefined {
  const dispatch = lookUp(core, options);
  return dispatch?.kind === 'stop' && dispatch.name === name
    ? take(options, dispatch)
    : undefined;
}

/**
 * The restart start `options` carries for `name` on `core`'s manager, taken; `undefined`
 * for a plain start.
 */
export function takeRestartStartDispatch(
  core: ManagerCore,
  name: string,
  options: unknown,
): RestartStartDispatch | undefined {
  const dispatch = lookUp(core, options);
  return dispatch?.kind === 'start' && dispatch.name === name
    ? take(options, dispatch)
    : undefined;
}

/**
 * The restart startup phase `options` carries on `core`'s manager, taken; `undefined` for
 * a plain startup.
 */
export function takeRestartStartupDispatch(
  core: ManagerCore,
  options: unknown,
): RestartStartupDispatch | undefined {
  const dispatch = lookUp(core, options);
  return dispatch?.kind === 'startup' ? take(options, dispatch) : undefined;
}

// `typeof`, a `WeakMap` lookup and an identity comparison run no caller code, even for a
// proxy. Another manager's context is left in place for its own manager.
function lookUp(
  core: ManagerCore,
  options: unknown,
): RestartDispatch | undefined {
  const dispatch =
    typeof options === 'object' && options !== null
      ? dispatches.get(options)
      : undefined;
  return dispatch?.issuer === core ? dispatch : undefined;
}

function take<D extends RestartDispatch>(options: unknown, dispatch: D): D {
  dispatches.delete(options as object);
  dispatch.taken = true;
  return dispatch;
}
