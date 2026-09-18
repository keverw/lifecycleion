import { isFunction } from '../is-function';
import {
  installGlobalEventTarget,
  isGlobalEventTargetAvailable,
} from '../global-event-target';
import { reportToConsole } from './report-to-console';

/**
 * Reporting state shared by every bundled copy of Lifecycleion in this realm.
 *
 * A module-local guard only protects one copy. Code splitting, plugins, or dependency
 * duplication can load several copies that all register listeners on the same global
 * `error` channel, so they must also agree when that channel is already being dispatched.
 */
interface HostReportSharedState {
  dispatchDepth: number;
}

const HOST_REPORT_STATE_KEY = Symbol.for('lifecycleion.reportToHost.v1');
const localHostReportState: HostReportSharedState = { dispatchDepth: 0 };

/**
 * Install a fresh shared state, replacing whatever is there.
 *
 * The repair path for every way the shared object can prove unusable: a squatter under our
 * symbol whose `dispatchDepth` throws, one that silently drops the write, one that refused
 * to release a lease. Replacing it also repairs the *other* copies, which re-read the
 * global on every report - an object stuck at a nonzero depth would otherwise send every
 * later report in every copy to the emergency console rung for the life of the process.
 *
 * @returns The installed state, or `undefined` when the global itself refuses it - a frozen
 *          `globalThis`, a non-writable property - which is the only case with no repair.
 */
function installFreshHostReportState(): HostReportSharedState | undefined {
  try {
    const globalObject = globalThis as Record<symbol, unknown>;
    const state: HostReportSharedState = { dispatchDepth: 0 };

    globalObject[HOST_REPORT_STATE_KEY] = state;

    // Read back rather than trusted. A write that is *refused* throws under the module's
    // own strict mode and is caught below; one that is *ignored* - a non-writable
    // property, a setter that drops the value - returns normally and left this reporting
    // with a state nobody would ever see, so every copy believed it held the only lease.
    return globalObject[HOST_REPORT_STATE_KEY] === state ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the cross-bundle state, falling back to this copy's own when the global refuses it.
 *
 * Nothing is latched. An earlier version remembered that the shared state was unusable and
 * never looked again, which is wrong in the one direction that matters: the conditions are
 * another package's doing, not the environment's, and `installFreshHostReportState` - run
 * here or by a *different* copy releasing a stuck lease - repairs them. A copy that had
 * latched would have stayed blind to the healthy object its neighbour installed, for the
 * life of the process. The cost of asking every time is a few property reads on a path
 * that is already reporting a failure.
 */
function getHostReportState(): HostReportSharedState {
  try {
    const globalObject = globalThis as Record<symbol, unknown>;
    const existing = globalObject[HOST_REPORT_STATE_KEY];

    if (typeof existing === 'object' && existing !== null) {
      const dispatchDepth = (existing as Partial<HostReportSharedState>)
        .dispatchDepth;

      if (
        typeof dispatchDepth === 'number' &&
        Number.isSafeInteger(dispatchDepth) &&
        dispatchDepth >= 0
      ) {
        return existing as HostReportSharedState;
      }
    }
  } catch {
    // A throwing accessor under our symbol: the read itself is somebody else's code. Not
    // a reason to give up on sharing - the repair below replaces exactly that object.
  }

  return installFreshHostReportState() ?? localHostReportState;
}

/**
 * Enter the global reporting channel. A missing lease means another report owns it.
 * Every operation is guarded because this is itself part of the last-resort error path.
 */
function acquireHostReportLease(): HostReportSharedState | undefined {
  const state = getHostReportState();

  try {
    if (state.dispatchDepth > 0) {
      return undefined;
    }

    state.dispatchDepth++;

    if (state.dispatchDepth > 0) {
      return state;
    }

    // The increment was ignored rather than refused, so this object cannot hold a lease at
    // all - and unlike a refusal it says so silently, leaving every copy to believe it owns
    // a channel none of them is guarding.
  } catch {
    // A hostile value stored under our symbol can still change behaviour after the
    // guarded read in getHostReportState.
  }

  return acquireRepairedLease();
}

/**
 * Acquire from a replacement shared object, or from this copy's own guard.
 *
 * Reached when the object `getHostReportState` handed back cannot hold a lease. Replacing
 * it keeps cross-copy protection for every report after this one; `localHostReportState`
 * is the fallback for a global that will not take a replacement, and it can neither refuse
 * nor ignore the write because it is this copy's own object.
 */
function acquireRepairedLease(): HostReportSharedState | undefined {
  const state = installFreshHostReportState() ?? localHostReportState;

  try {
    if (state.dispatchDepth > 0) {
      return undefined;
    }

    state.dispatchDepth++;

    return state;
  } catch {
    // Only reachable for a replacement that went hostile between two statements. One
    // report on the console rung is the cost; the next one gets a fresh object.
    return undefined;
  }
}

/** Release a lease without allowing a hostile shared object to raise another failure. */
function releaseHostReportLease(state: HostReportSharedState): void {
  try {
    state.dispatchDepth = Math.max(0, state.dispatchDepth - 1);

    // A lease is only granted at depth `0`, so anything but `0` here means the write did
    // not take. Left alone, the lease is never released and every later report - in this
    // copy and in every other one reading the same object - takes the emergency console
    // rung and never reaches an `'error'` listener again.
    if (state.dispatchDepth === 0) {
      return;
    }
  } catch {
    // The shared object refused the write. Same outcome as an ignored one: a lease that
    // can never be put down.
  }

  if (state === localHostReportState) {
    // Ours, and it just refused a write, which should not be reachable. Reset outright
    // rather than leaving this copy unable to report for the life of the process.
    localHostReportState.dispatchDepth = 0;

    return;
  }

  // Replace the object instead of abandoning it, so the copies still reading it recover
  // too. Nothing to do when the global will not take a replacement: the next report reads
  // the stuck object, finds a lease it cannot take, and goes through the same repair.
  installFreshHostReportState();
}

/**
 * The standard global `'error'` reporting channel, and the rungs beneath it.
 *
 * Extracted so two callers can share one implementation without importing each other.
 * `safe-handle-callback` reports callback failures here; `failure-reporter` falls through
 * to it for a render or redaction failure that nobody handled. A direct import between
 * those two would be a cycle - `safe-handle-callback` renders with `errorToString`, which
 * builds a redaction reporter, which is `failure-reporter`.
 */

/**
 * Read a global without trusting it: a global can be an accessor that throws, and these
 * run on an error path that must not raise one of its own.
 */
function readGlobal(name: string): unknown {
  try {
    return (globalThis as unknown as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

/**
 * Outcome of the `ErrorEvent` dispatch rung.
 *
 * - `handled` - dispatched, and a listener called `preventDefault()`.
 * - `unhandled` - dispatched, but nothing claimed it.
 * - `unavailable` - the primitives are missing, or dispatching threw.
 */
type DispatchOutcome = 'handled' | 'unhandled' | 'unavailable';

/**
 * Dispatch `error` as a standard `'error'` `ErrorEvent` on the global object.
 *
 * `cancelable: true` is required, not decorative: `EventInit.cancelable` defaults to
 * `false`, and `preventDefault()` on an uncancelable event is a no-op that leaves
 * `dispatchEvent()` returning `true` no matter what a listener does. Without it every
 * dispatch would read as `'unhandled'` and a consumer that logs the error itself — such
 * as `logger.registerReportErrorListener()` — could not suppress the console line.
 */
function dispatchErrorEvent(error: Error): DispatchOutcome {
  // All three `EventTarget` methods, not only `dispatchEvent`. `installGlobalEventTarget`
  // leaves a `partial` environment - some methods foreign, some missing - exactly as it
  // found it, so `dispatchEvent` can be callable while nothing can register a listener
  // through it. Dispatching there hands the event to an implementation no listener of
  // ours could have reached, and a foreign `dispatchEvent` returning `false` for reasons
  // of its own then reads as `'handled'`: the report is dropped, with no console line and
  // no listener that ever saw it.
  if (!isGlobalEventTargetAvailable()) {
    return 'unavailable';
  }

  const dispatchEvent = readGlobal('dispatchEvent');
  const errorEventConstructor = readGlobal('ErrorEvent');

  if (
    !isFunction(dispatchEvent) ||
    typeof errorEventConstructor !== 'function'
  ) {
    return 'unavailable';
  }

  // A hostile message must not make an otherwise usable dispatch unavailable:
  // reportError can treat the fallback as uncaught and terminate a server process.
  let message = '';

  try {
    const value: unknown = error.message;

    if (typeof value === 'string') {
      message = value;
    }
  } catch {
    // Keep the original error available to listeners, with no message hint.
  }

  let event: Event;

  try {
    event = new (
      errorEventConstructor as new (type: string, init: ErrorEventInit) => Event
    )('error', {
      error,
      message,
      cancelable: true,
    });
  } catch {
    // The probe passed but the constructor is not one we can use, so nothing was
    // dispatched and the next rung should be tried.
    return 'unavailable';
  }

  try {
    // `.call` rather than a bare call: the polyfilled methods are already bound, but a
    // native `dispatchEvent` needs the global object as its receiver.
    return (dispatchEvent as (this: unknown, event: Event) => boolean).call(
      globalThis,
      event,
    ) === false
      ? 'handled'
      : 'unhandled';
  } catch {
    // Reported as `'unhandled'`, not `'unavailable'`: the event was constructed and
    // handed to `dispatchEvent`, so listeners may well have run. A throwing listener is
    // not what gets here — per spec a listener's exception does not propagate back into
    // `dispatchEvent`, and browsers, Bun 1.3.14 and Node 25 all honour that — but an
    // environment actively fighting us can still reject the event outright. Falling to
    // the console tail reports the error exactly once; falling to
    // `globalThis.reportError()` instead would report it a second time to whatever
    // already saw the dispatch.
    //
    // "Does not propagate" is not the same as "is harmless": outside a browser the
    // runtime treats that exception as uncaught and dies. Measured on Bun 1.3.14 and
    // Node 25.9.0, a listener that throws exits the process with code 1 while
    // `dispatchEvent` still returns normally. That is why every listener this library
    // installs catches its own failures rather than relying on the runtime to absorb
    // them; see `Logger.registerReportErrorListener`.
    return 'unhandled';
  }
}

/**
 * Report an error to the host on the standard `'error'` channel, dispatch first.
 *
 * The rungs, in order:
 *
 * 1. Dispatch `new ErrorEvent('error', { cancelable: true })` when the global object has
 *    `dispatchEvent` and `ErrorEvent`. A listener that calls `preventDefault()` owns the
 *    report and nothing further is written.
 * 2. `globalThis.reportError(error)` when dispatch is unavailable but the runtime provides
 *    the WHATWG reporting function.
 * 3. `console.error(error)`.
 *
 * Dispatch leads deliberately, rather than trying `reportError()` first as the WHATWG
 * "report an exception" algorithm would suggest:
 *
 * - Bun provides `globalThis.reportError`, but its handling is runtime-dependent:
 *   Bun 1.3.14 wrote to stderr without dispatching an `'error'` event, and Bun 1.4.0
 *   can terminate the process for an unhandled report. Dispatching first lets
 *   Lifecycleion's listeners claim callback failures before host reporting is used.
 * - In browsers, calling `reportError()` *after* a dispatch would notify the same
 *   listeners twice, since the native call dispatches an `'error'` event of its own.
 *
 * An unclaimed dispatch still falls through to `console.error`, mirroring the console
 * output a native `reportError()` produces when no listener cancels the event.
 */
export function reportToHost(
  error: Error,
  renderForConsole?: () => string,
): void {
  const lease = acquireHostReportLease();

  if (!lease) {
    // A listener or one of its sinks failed while handling an earlier report. Sending
    // this nested failure through the same listeners would re-enter every bundled logger
    // and grow combinatorially. The emergency console rung is guarded and terminates the
    // cycle while the original report continues to every listener.
    reportToConsole(renderedReport(error, renderForConsole));
    return;
  }

  try {
    // Repeating installation here costs a few typeof checks on an error path and makes
    // reporting independent of whether a bundler retained any eager setup.
    installGlobalEventTarget();

    const outcome = dispatchErrorEvent(error);

    if (outcome === 'handled') {
      return;
    }

    if (outcome === 'unavailable') {
      const reportError = readGlobal('reportError');

      if (isFunction(reportError)) {
        try {
          (reportError as (this: unknown, error: unknown) => void).call(
            globalThis,
            // Rendered, like the console rung below it, and for the same reason: this rung
            // is only reached when dispatch is unavailable, so there is no listener to hand
            // the structured failure to - only a host that will print it. Handing over the
            // wrapper would hand over its `cause`, and a runtime's error inspection prints
            // an error's own properties, so an `additionalInfo` this library exists to mask
            // would reach stderr in the clear.
            renderedReport(error, renderForConsole),
          );

          return;
        } catch {
          // Fall through to the console: a reporting function that throws has not
          // reported anything.
        }
      }
    }

    // The last reporting rung, by design, and guarded by `reportToConsole`: neither
    // `safeHandleCallback` nor `safeHandleCallbackAndWait` may throw from this path.
    // `renderedReport` guards its own rendering and falls back to the error itself.
    reportToConsole(renderedReport(error, renderForConsole));
  } finally {
    releaseHostReportLease(lease);
  }
}

/**
 * What a rung that only prints should be handed.
 *
 * Rendering happens at these rungs and not in what gets dispatched. A rung that prints has
 * no `redactFunction` of its own, so it needs the rendered form; a listener does, and
 * handing it a pre-rendered string is what stopped a consumer from applying its own
 * redaction settings to the failure.
 */
function renderedReport(
  error: Error,
  renderForConsole?: () => string,
): string | Error {
  if (!renderForConsole) {
    return error;
  }

  try {
    return renderForConsole();
  } catch {
    // Fall back to the error itself rather than reporting nothing.
    return error;
  }
}
