import type {
  StartComponentOptions,
  StartupOptions,
  StopComponentOptions,
} from '../types';
import type { RestartStartSnapshot } from './component-start';
import type { IndividualStopContext } from './component-stop';
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
 * Each context is taken at most once, and only for the name it was issued for: a second
 * call with the same object, or a call for another name, is a plain call.
 */

interface RestartDispatchBase {
  /** Set once a public method took this context: the override handed the object on. */
  taken: boolean;
}

/** `restartComponent()`'s stop: its options snapshot and its call-local stop context. */
export interface RestartStopDispatch extends RestartDispatchBase {
  readonly kind: 'stop';
  readonly name: string;
  readonly stopOptions: StopOptionsSnapshot;
  readonly stopContext: IndividualStopContext;
}

/** `restartComponent()`'s start: its options snapshot and the registration it approved. */
export interface RestartStartDispatch extends RestartDispatchBase {
  readonly kind: 'start';
  readonly name: string;
  readonly startOptions: StartOptionsSnapshot;
  readonly startSnapshot: RestartStartSnapshot;
}

/** `restartAllComponents()`'s startup phase: its validated options and saved snapshots. */
export interface RestartStartupDispatch extends RestartDispatchBase {
  readonly kind: 'startup';
  readonly startupOptions: StartupOptionsSnapshot;
  readonly restartSnapshots: Map<string, RestartStartSnapshot>;
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

/** The restart stop `options` carries for `name`, taken; `undefined` for a plain stop. */
export function takeRestartStopDispatch(
  name: string,
  options: unknown,
): RestartStopDispatch | undefined {
  const dispatch = lookUp(options);
  return dispatch?.kind === 'stop' && dispatch.name === name
    ? take(options, dispatch)
    : undefined;
}

/** The restart start `options` carries for `name`, taken; `undefined` for a plain start. */
export function takeRestartStartDispatch(
  name: string,
  options: unknown,
): RestartStartDispatch | undefined {
  const dispatch = lookUp(options);
  return dispatch?.kind === 'start' && dispatch.name === name
    ? take(options, dispatch)
    : undefined;
}

/** The restart startup phase `options` carries, taken; `undefined` for a plain startup. */
export function takeRestartStartupDispatch(
  options: unknown,
): RestartStartupDispatch | undefined {
  const dispatch = lookUp(options);
  return dispatch?.kind === 'startup' ? take(options, dispatch) : undefined;
}

// `typeof` and a `WeakMap` lookup run no caller code, even for a proxy.
function lookUp(options: unknown): RestartDispatch | undefined {
  return typeof options === 'object' && options !== null
    ? dispatches.get(options)
    : undefined;
}

function take<D extends RestartDispatch>(options: unknown, dispatch: D): D {
  dispatches.delete(options as object);
  dispatch.taken = true;
  return dispatch;
}
