import { isFunction } from '../is-function';
import {
  installGlobalEventTarget,
  isGlobalEventTargetAvailable,
} from '../global-event-target';
import { reportToConsole } from './report-to-console';

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

  let event: Event;

  try {
    event = new (
      errorEventConstructor as new (type: string, init: ErrorEventInit) => Event
    )('error', {
      error,
      message: error.message,
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
 * - Bun (measured on 1.3.14) provides `globalThis.reportError` but it writes to stderr
 *   without dispatching an `'error'` event, so a `reportError()`-first order would make
 *   Lifecycleion's own callback failures invisible to `addEventListener('error', ...)` —
 *   including `logger.registerReportErrorListener()` — on that runtime.
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
  // Also installed at module load, above. Repeating it here costs a few typeof checks on
  // an error path and makes reporting independent of whether a bundler kept that
  // top-level call, so a failure can never be swallowed for a packaging reason.
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
