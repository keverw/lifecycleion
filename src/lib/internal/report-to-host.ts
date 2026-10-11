import { isFunction } from '../is-function';
import {
  installGlobalEventTarget,
  isGlobalEventTargetAvailable,
} from '../global-event-target';
import { isObjectLike } from './is-object-like';
import { reportToConsole } from './report-to-console';
import { SharedSlot } from './shared-slot';

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

/** A slot value with a writable own `dispatchDepth`, read without invoking an accessor. */
function isHostReportState(value: unknown): value is HostReportSharedState {
  if (!isObjectLike(value)) {
    return false;
  }
  const depth = Object.getOwnPropertyDescriptor(value, 'dispatchDepth');
  return (
    typeof depth?.value === 'number' &&
    Number.isSafeInteger(depth.value) &&
    depth.value >= 0 &&
    depth.writable === true
  );
}

/**
 * The cross-bundle lease. A shared object that proves unusable when a report takes or
 * releases it - a squatter under our symbol whose `dispatchDepth` throws, one that
 * silently drops the write, one that refuses to release a lease - is replaced in the slot
 * rather than abandoned, which also repairs the *other* copies, since every copy reads the
 * slot on every report: a lease that could not be put down would otherwise send every
 * later report in every copy to the emergency console rung for the life of the process.
 * The same guard `report-to-console` keeps for its flag; see {@link SharedSlot}, including
 * what it cannot repair.
 *
 * A lease is only taken at depth `0`, so held is depth `1` and free is `0` - what copies of
 * this module that increment and decrement it read the same way.
 */
const hostReportLease = new SharedSlot<HostReportSharedState>({
  key: HOST_REPORT_STATE_KEY,
  isValid: isHostReportState,
  create: () => ({ dispatchDepth: 0 }),
  isHeld: (state) => state.dispatchDepth > 0,
  setHeld: (state, isHeld) => {
    state.dispatchDepth = isHeld ? 1 : 0;
  },
});

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

  if (!isFunction(dispatchEvent) || !isFunction(errorEventConstructor)) {
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
    // Preserve the host receiver without reading a caller-owned call property.
    return Reflect.apply(
      dispatchEvent as (event: Event) => boolean,
      globalThis,
      [event],
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
 *
 * Public through `lifecycleion/safe-handle-callback`. Reach for it when you already hold a
 * well-formed `Error` - its own `cause` chain, its own `additionalInfo` - and want
 * listeners to see exactly that. `reportCallbackError` is the normalizer for the other
 * case: a raw thrown value (`throw 'boom'`, `throw 42`, a rejected promise carrying a
 * string), which it wraps in an `Error` whose message names the callback. Passing an
 * already-structured `Error` through that wrapper only adds a nesting level and a message
 * describing the caller's callback name rather than what actually failed.
 *
 * @param error The report to publish. Already an `Error`; normalize with `toError` first
 *              if what you hold might not be.
 * @param renderForConsole Consulted only if the report reaches the console rung
 *                         uncancelled, so a caller can control that rendering.
 */
export function reportToHost(
  error: Error,
  renderForConsole?: () => string,
): void {
  const lease = hostReportLease.acquire();

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
          Reflect.apply(reportError as (error: unknown) => void, globalThis, [
            // Rendered, like the console rung below it, and for the same reason: this rung
            // is only reached when dispatch is unavailable, so there is no listener to hand
            // the structured failure to - only a host that will print it. Handing over the
            // wrapper would hand over its `cause`, and a runtime's error inspection prints
            // an error's own properties, so an `additionalInfo` this library exists to mask
            // would reach stderr in the clear.
            renderedReport(error, renderForConsole),
          ]);

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
  } catch {
    // Anything above reading a hostile global - an `ErrorEvent` constructor, a
    // `dispatchEvent`, an installer - that throws has not reported anything. Callers
    // reach here with nothing left to catch for them: `safeHandleCallback` hands it
    // failures directly, and a throw from here would escape the one function whose
    // contract is that it never throws.
    reportToConsole(renderedReport(error, renderForConsole));
  } finally {
    hostReportLease.release(lease);
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
