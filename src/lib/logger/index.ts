import { EventEmitter } from '../event-emitter';
import { ms } from '../unix-time-helpers';
import { safeHandleCallbackAndWait } from '../safe-handle-callback';
import {
  installGlobalEventTarget,
  isGlobalEventTargetAvailable,
} from '../global-event-target';
import { CurlyBrackets } from '../curly-brackets';
import { isNumber } from '../is-number';
import { isPromise } from '../is-promise';
import { describeError, isErrorValue, toError } from '../to-error';
import { readMember } from '../internal/read-member';
import { reportToConsole } from '../internal/report-to-console';
import { reportThroughHandler } from '../internal/failure-reporter';
import {
  consoleFormatHandler,
  createFormatReporter,
  type FormatErrorHandler,
  type ReportFormatFailure,
} from '../internal/format-reporter';
import type {
  LogEntry,
  LogSink,
  RedactFunction,
  LogType,
  LoggerOptions,
  LogOptions,
  BeforeExitResult,
} from './types';
import type { HandleLogOptions } from './internal-types';
import { ArraySink } from './sinks/array';
import { ConsoleSink } from './sinks/console';
import { applyRedaction, markAllRedactionFailed } from './utils/redaction';
import { snapshotList } from '../internal/redact-paths';
import { prepareErrorObjectLog } from './utils/error-object';
import { LoggerService } from './logger-service';

/**
 * Main Logger class with sink-based architecture and EventEmitter support
 */
/**
 * Whether the event was dispatched on a DOM element rather than on the global object.
 *
 * A DOM element is identified by a string `tagName`, which the global object and the
 * polyfilled backing `EventTarget` both lack. Used to tell an event belonging to the
 * page from a report meant for this library.
 */
function isElementTarget(event: Event): boolean {
  const target: unknown = readMember(event, 'target');

  if (target === null || target === undefined || typeof target !== 'object') {
    return false;
  }

  let tagName: unknown;

  try {
    tagName = (target as Record<string, unknown>).tagName;
  } catch {
    return false;
  }

  return typeof tagName === 'string';
}

/**
 * Describe an `'error'` event target when it is a failed page resource.
 *
 * A resource failure (a broken `<img>`, `<script>`, `<link>`, media element) fires an
 * `'error'` event *on the element*, which does not bubble — only a listener registered
 * with `capture: true` sees it. It is a plain `Event`: no `error`, and usually no
 * `message`, so the target is the only place a useful description can come from.
 *
 * Classification is deliberately narrow, because a capturing listener on the global
 * object sees *every* `'error'` event dispatched anywhere in the document, not just
 * resource failures. Three things are required beyond an element target:
 *
 * - The event must be trusted. Only the user agent dispatches a genuine load failure;
 *   anything an application sends through `dispatchEvent()` is untrusted without
 *   exception, and is that application's own signal.
 * - The event must be a plain `Event`. An `ErrorEvent` carries its own error, and a
 *   `CustomEvent` is an application's own signal — a component that dispatches
 *   `new CustomEvent('error', { cancelable: true })` on itself and branches on the
 *   return value must not have that answer changed by a logger.
 * - The element must actually name a resource (`src`, `href`, `currentSrc`, or `data` -
 *   the last for `<object>`, which names its resource nowhere else). An arbitrary element
 *   that happens to be an event target is not a failed load.
 *
 * Every read of the target is guarded, and so is the `instanceof` pair: the target is a
 * DOM object belonging to the page, so an accessor on it may throw, and a prototype
 * chain can be one a revoked `Proxy` refuses to walk. This runs on an error path that
 * must not raise one of its own.
 *
 * @returns A description such as `Failed to load IMG: /logo.png`, or `undefined` when
 *          the event is not a resource failure this can describe.
 */
function describeResourceTarget(event: Event): string | undefined {
  const target: unknown = readMember(event, 'target');

  if (
    target === null ||
    target === undefined ||
    (target as unknown) === globalThis ||
    typeof target !== 'object'
  ) {
    return undefined;
  }

  // A real resource failure comes from the user agent, which is the only dispatcher that
  // can produce a trusted event: `dispatchEvent()` leaves `isTrusted` `false` always. A
  // wrapper component re-announcing a failure — `<my-video src="...">` doing
  // `this.dispatchEvent(new Event('error'))` — is an element target, a bare `Event`, and
  // names a resource, so it satisfies every other test here while never having failed a
  // load this listener saw. Describing it would log a load failure that did not happen,
  // and cancelling it would change the answer its dispatcher branches on.
  //
  // Read through the guard, and compared against `true` rather than coerced: the event is
  // whatever was dispatched, so `isTrusted` may be an accessor that throws or a plain
  // property set to anything at all.
  if (readMember(event, 'isTrusted') !== true) {
    return undefined;
  }

  // A real resource failure is a bare `Event`. Anything richer belongs to whoever
  // dispatched it; claiming and cancelling it would change their semantics. Kept
  // alongside the trust check rather than replaced by it: the trust check rules out
  // everything the *page* dispatched, and this rules out a trusted event that carries its
  // own payload — an `ErrorEvent` the user agent aimed at an element describes itself
  // better than this function could.
  try {
    if (
      (typeof ErrorEvent === 'function' && event instanceof ErrorEvent) ||
      (typeof CustomEvent === 'function' && event instanceof CustomEvent)
    ) {
      return undefined;
    }
  } catch {
    // A hostile or exotic global: treat the event as not classifiable rather than
    // guessing, since guessing wrong means cancelling somebody else's event.
    return undefined;
  }

  const read = (key: string): unknown => {
    try {
      return (target as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  };

  const tagName = read('tagName');

  if (typeof tagName !== 'string') {
    // Not an element, so not a resource failure this can describe.
    return undefined;
  }

  // `data` alongside the three obvious ones: `<object data="...">` names its resource
  // there and nowhere else, so a broken `<object>` failed to classify and its load
  // failure was neither logged nor cancelled, unlike an equivalent `<img>` or `<script>`.
  for (const key of ['src', 'href', 'currentSrc', 'data']) {
    const url = read(key);

    if (typeof url === 'string' && url.length > 0) {
      return `Failed to load ${tagName}: ${url}`;
    }
  }

  // An element that names no resource did not fail to load one.
  return undefined;
}

export class Logger extends EventEmitter {
  public readonly isLoggerClass = true;

  private sinks: LogSink[];
  private redactFunction?: RedactFunction;
  private callProcessExit: boolean;
  private beforeExitCallback?: (
    exitCode: number,
    isFirstExit: boolean,
  ) => BeforeExitResult | Promise<BeforeExitResult>;
  // `void | Promise<void>`, matching the options they come from: these are invoked
  // through `reportThroughHandler`, which follows a returned promise, so an `async`
  // handler that rejects reaches the console rung instead of becoming an unhandled
  // rejection. Narrowed to `void` here, storing the caller's own option was a
  // `no-misused-promises` error.
  private onSinkError?: (
    error: Error,
    context: 'write' | 'close',
    sink: LogSink,
  ) => void | Promise<void>;
  private onEventHandlerError?: (
    error: Error,
    event: string,
  ) => void | Promise<void>;
  private onFormatError?: FormatErrorHandler;

  private _didExit = false;
  private _exitCode: number = 0;
  private _exitRequested = false;
  private _isPendingExit = false;
  private _closed = false;

  private _reportErrorListenerRegistered = false;
  private _isHandlingReportedError = false;
  private _reportErrorListener: ((event: Event) => void) | null = null;
  private _reportErrorListenerCapture = false;

  constructor(options: LoggerOptions = {}) {
    super();

    this.sinks = options.sinks || [];
    this.redactFunction = options.redactFunction;
    this.callProcessExit = options.callProcessExit ?? true;
    this.beforeExitCallback = options.beforeExitCallback;
    this.onSinkError = options.onSinkError;
    this.onEventHandlerError = options.onEventHandlerError;
    this.onFormatError = options.onFormatError;
  }

  public get didExit(): boolean {
    return this._didExit;
  }

  public get exitCode(): number {
    return this._exitCode;
  }

  public get isPendingExit(): boolean {
    return this._isPendingExit;
  }

  public get hasExitedOrPending(): boolean {
    return this._didExit || this._isPendingExit;
  }

  public get closed(): boolean {
    return this._closed;
  }

  /**
   * Exit the process with the specified code
   */
  public exit(code: number): void {
    const isFirstExit = !this._exitRequested;
    this._exitRequested = true;

    if (!this._didExit) {
      this._isPendingExit = true;
    }

    this.emit('logger', { eventType: 'exit-called', code, isFirstExit });

    if (this.beforeExitCallback) {
      safeHandleCallbackAndWait<BeforeExitResult>(
        'beforeExit',
        this.beforeExitCallback,
        code,
        isFirstExit,
      )
        .then((result) => {
          // Check if callback returned a result indicating we should wait
          if (result.success && result.value?.action === 'wait') {
            // Shutdown is already in progress, don't proceed with exit
            // The ongoing shutdown will handle the exit when it completes
            return;
          }

          // Proceed with exit (either callback returned 'proceed' or failed)
          this.processExit(code);
        })
        .catch(() => {
          // If callback throws an error, proceed with exit anyway
          // This ensures the process doesn't hang on callback failures
          this.processExit(code);
        });
    } else {
      this.processExit(code);
    }
  }

  /**
   * Set or update the beforeExit callback
   *
   * This allows setting the callback after Logger construction, which is useful
   * when the callback needs to reference objects that depend on the Logger instance.
   *
   * **Note:** This method overwrites any existing beforeExit callback (including
   * one set in the Logger constructor). Pass `undefined` to remove the callback.
   *
   * **Error Handling:** If the callback throws an error or rejects, the logger will
   * proceed with exit anyway to prevent the process from hanging. The error will be
   * reported on the standard global `'error'` channel.
   *
   * @param callback - Function to call before process exit (receives exitCode and isFirstExit).
   *                   Must return BeforeExitResult indicating whether to proceed with exit or wait.
   *                   Return `{ action: 'proceed' }` to continue with exit.
   *                   Return `{ action: 'wait' }` to prevent exit (e.g., shutdown already in progress).
   *                   If the callback throws, exit proceeds automatically.
   *
   *                   Pass undefined to remove the callback.
   *
   * @example
   * ```typescript
   * const logger = new Logger();
   * const lifecycle = new LifecycleManager({ logger });
   *
   * // Set callback after both are constructed
   * logger.setBeforeExitCallback(async (exitCode, isFirstExit) => {
   *   if (isFirstExit) {
   *     await lifecycle.stopAllComponents();
   *   }
   *   return { action: 'proceed' };
   * });
   *
   * // Later, remove the callback
   * logger.setBeforeExitCallback(undefined);
   * ```
   */
  public setBeforeExitCallback(
    callback:
      | ((
          exitCode: number,
          isFirstExit: boolean,
        ) => BeforeExitResult | Promise<BeforeExitResult>)
      | undefined,
  ): void {
    this.beforeExitCallback = callback;
  }

  /**
   * Log an error message
   */
  public error(message: string, options?: LogOptions): void {
    this.handleLog('error', message, options);
  }

  /**
   * Log an error object with optional prefix
   */
  public errorObject(
    prefix: string,
    error: unknown,
    options?: LogOptions,
  ): void {
    const message = this.renderErrorObject(prefix, error);

    this.handleLog('error', message, { ...(options ?? {}), error });
  }

  /**
   * Log an informational message
   */
  public info(message: string, options?: LogOptions): void {
    this.handleLog('info', message, options);
  }

  /**
   * Log a warning message
   */
  public warn(message: string, options?: LogOptions): void {
    this.handleLog('warn', message, options);
  }

  /**
   * Log a success message
   */
  public success(message: string, options?: LogOptions): void {
    this.handleLog('success', message, options);
  }

  /**
   * Log a notice message
   */
  public notice(message: string, options?: LogOptions): void {
    this.handleLog('notice', message, options);
  }

  /**
   * Log a debug message
   */
  public debug(message: string, options?: LogOptions): void {
    this.handleLog('debug', message, options);
  }

  /**
   * Log a raw message without any formatting
   */
  public raw(message: string, options?: LogOptions): void {
    this.handleLog('raw', message, options);
  }

  /**
   * Create a scoped logger with a service name
   */
  public service(serviceName: string): LoggerService {
    return new LoggerService(
      this.handleLog.bind(this),
      // Bound rather than passing the settings themselves, so a service logger renders an
      // error exactly as `this.errorObject` does, reading them when it is called.
      (prefix, error) => this.renderErrorObject(prefix, error),
      serviceName,
    );
  }

  /**
   * Registers a listener for the standard global `'error'` event, so errors reported by
   * Lifecycleion's callback safety net (`safe-handle-callback`) are logged to this
   * logger's sinks instead of being lost.
   *
   * The listener observes the platform channel, so in browsers it also sees genuine
   * uncaught script errors. Those can arrive without an `error` property; the event's
   * `message` is used instead. Resource-load failures are not included by default: those
   * `error` events fire on the element and do not bubble, so a non-capturing global
   * listener never sees them. Set `captureResourceErrors` to register with capture and
   * take them too.
   *
   * By default the listener calls `preventDefault()` on every event it handles, which
   * claims the report: `safe-handle-callback` skips its `console.error` fall-through, and
   * the browser suppresses its own console line. Pass `preventDefault: false` to log to
   * the sinks *and* let the error reach the console as well.
   *
   * If the listener is already registered, it returns 'already_registered'.
   * If the logger has been closed, it returns 'closed' and registers nothing: `close()`
   * unregisters the listener and `_closed` is never cleared, so a listener attached after
   * that point could never log or claim anything and would simply stay on `globalThis`.
   * If the required global event primitives are unavailable, it returns 'not_available'.
   * Otherwise, it registers the listener and returns 'success'.
   *
   * @param prefix - The prefix to use when logging the error object. Default is 'Uncaught exception'.
   * @param options - `preventDefault` (default `true`): whether to cancel the event so the
   *                  error is not also written to the console. `captureResourceErrors`
   *                  (default `false`): register with capture so browser resource-load
   *                  failures are logged too, described from the failing element and
   *                  tagged `'resource'` so a sink can route or drop them.
   * @returns 'success' if the listener is registered successfully,
   *          'already_registered' if the listener is already registered,
   *          'closed' if the logger has been closed,
   *          'not_available' if the required global event primitives are not available.
   */

  public registerReportErrorListener(
    prefix: string = 'Uncaught exception',
    options: {
      preventDefault?: boolean;
      captureResourceErrors?: boolean;
    } = {},
  ): 'success' | 'already_registered' | 'closed' | 'not_available' {
    if (this._reportErrorListenerRegistered) {
      return 'already_registered';
    }

    // A closed logger can never log again — `_closed` is never cleared — so a listener
    // registered now would sit on `globalThis` forever doing nothing, keeping this logger
    // and its sinks alive and telling the caller 'success' while capturing nothing.
    if (this._closed) {
      return 'closed';
    }

    // Node.js needs the global event methods supplied before listeners can be
    // registered; idempotent and a no-op where they already exist.
    installGlobalEventTarget();

    if (!this.isReportErrorAvailable()) {
      return 'not_available';
    }

    const shouldPreventDefault = options.preventDefault !== false;
    const useCapture = options.captureResourceErrors === true;

    this._reportErrorListener = (event: Event): void => {
      // Re-entrancy guard, for reports raised *by this listener's own logging*.
      // `handleLog` writes to every sink, and a sink is user code: one that itself drives
      // `safeHandleCallback` (or any non-`Logger` Lifecycleion emitter) with a failing
      // callback reports on this very channel, synchronously, while this listener is
      // still on the stack. Without the flag a sink that fails on every write loops.
      //
      // Failures of this logger's own `'logger'` handlers are *not* what this guards:
      // `handleEventHandlerFailure` is overridden below to keep those off the global
      // channel entirely, so they never re-enter here.
      //
      // The cost is that such a nested report is neither logged nor cancelled, so
      // `safe-handle-callback`'s console fall-through reports it once, without this
      // logger's formatting, instead of feeding it back through the failing sink.
      if (this._isHandlingReportedError) {
        return;
      }

      // A closed logger cannot record anything: `handleLog` returns early, so logging
      // here is a no-op. Cancelling the event as well would leave the error with nowhere
      // to go at all, since the cancel is what suppresses the console fall-through.
      // `close()` unregisters this listener, so reaching here means a close raced with a
      // report already in flight.
      if (this._closed) {
        return;
      }

      const resource = describeResourceTarget(event);

      // Registered with capture, this listener is in the event path of *every* `'error'`
      // event dispatched anywhere in the document, not just the ones meant for it. An
      // event targeting an element that did not classify as a resource failure above
      // belongs to whoever dispatched it — a component's own
      // `new CustomEvent('error', { cancelable: true })`, say, whose result that
      // component is about to branch on. Leave it entirely alone: not logged, and above
      // all not cancelled.
      //
      // Keyed on the target being an element rather than on it not being `globalThis`,
      // because on Node the reports meant for this listener arrive through the polyfill's
      // backing `EventTarget` and so do not target the global object either.
      if (resource === undefined && isElementTarget(event)) {
        return;
      }

      // Uncaught errors can carry a message but no `error` object, and a resource
      // failure is a plain `Event` with neither, so a value is always synthesized
      // rather than logging `undefined`. Read through the guard for the same reason the
      // target is: the event is whatever was dispatched, accessors included.
      const reported: unknown = readMember(event, 'error');

      const reportedMessage: unknown = readMember(event, 'message');

      // Emptiness is checked, not just `undefined`: `ErrorEvent`'s `message` defaults to
      // `''`, so a plain `new ErrorEvent('error')` would satisfy `??` and produce an
      // `Error` with no message at all instead of reaching the description below.
      const message: string | undefined =
        typeof reportedMessage === 'string' && reportedMessage.length > 0
          ? reportedMessage
          : undefined;

      // The shared brand check, not a bare `instanceof`, and for two reasons.
      //
      // It crosses realms. An error thrown out of an iframe, a `vm` context, or a jsdom
      // window has a different `Error` constructor and fails this realm's `instanceof`
      // while being an error in every way a consumer cares about. Wrapping it discarded
      // its identity, `stack` and `cause` and handed the wrapper to both the sink entry
      // and the `'logger'` event — the exact case `toError` documents itself as handling,
      // which this listener had quietly opted out of.
      //
      // And it is guarded, which is what the local `try` was for: the payload comes from
      // whoever dispatched the event, and `instanceof` walks a prototype chain, which a
      // revoked `Proxy` makes throw. A throw here would escape the listener, skipping the
      // `preventDefault()` below and — on Bun and Node — killing the process from inside
      // the error-reporting path.
      let error: Error;

      if (isErrorValue(reported)) {
        error = reported;
      } else {
        // The reported value is kept reachable as the cause: a browser
        // `throw { code: 'E42' }` puts that object here, and the synthesized message
        // ('Uncaught [object Object]') carries none of it.
        //
        // Passed to the constructor rather than assigned afterwards: the constructor
        // form defines `cause` non-enumerable, matching `toError` and the rest of the
        // library, so `JSON.stringify` of the logged error does not suddenly carry an
        // arbitrary — possibly large or cyclic — payload. The options object is omitted
        // entirely when there was nothing to keep, so an event that genuinely carried no
        // error does not gain a `cause: undefined`.
        //
        // `null` counts as nothing here as well as `undefined`, and that is not an
        // oversight about `throw null`. `ErrorEventInit.error` is declared `any error =
        // null` by WHATWG, so `null` is the value the platform supplies when *no* error
        // was given: `new ErrorEvent('error', { message: 'x' }).error` is `null` on Bun
        // and in browsers (Node answers `undefined`). A genuine `throw null` therefore
        // arrives indistinguishable from an event that carried no payload at all, so
        // there is no information to preserve by keeping it - only a `cause: null` on
        // every payload-less report, which is the noise the omission exists to avoid.
        // `readMember` also answers `undefined` for a read that threw, which has
        // nothing to keep either.
        error = new Error(
          resource ?? message ?? 'Unknown error reported by an error event',
          reported === undefined || reported === null
            ? undefined
            : { cause: reported },
        );
      }

      this._isHandlingReportedError = true;

      try {
        // Tagged so a custom sink can route or drop resource noise; see the logger docs.
        this.errorObject(
          prefix,
          error,
          resource === undefined ? undefined : { tags: ['resource'] },
        );
        this.emit('logger', {
          eventType: 'uncaughtException',
          error,
        });
      } catch (error_) {
        // Logging is user code all the way down: a sink, a redaction rule, or rendering
        // an error whose `stack` accessor throws can all fail here. Letting that escape
        // would leave the event uncancelled and, on Bun and Node, terminate the process
        // from a listener whose whole job is reporting a failure. The console is the only
        // rung left, as it is for a failing sink.
        //
        // Through `reportToConsole`, because `console.error` is itself a call that can
        // throw - a broken stdout, or a harness that replaced it - and a throw here defeats
        // this very guard: it escapes the listener *and* skips the `preventDefault()`
        // below, so the report is neither logged nor claimed.
        reportToConsole(describeError(error_));
      } finally {
        // Cleared in `finally` so a sink or handler that throws its way out cannot leave
        // the listener permanently deaf.
        //
        // Cleared *here*, synchronously, and not in a microtask. Deferring it bounds one
        // more case - `runCallbackSafely` reports a rejected async handler through
        // `result.catch(...)`, which lands after this body and so escapes the guard - but
        // it also holds the guard for the remainder of the current task, and every
        // *unrelated* report raised in that same task is then neither logged nor
        // cancelled. `for (const failure of failures) reportError(failure)` loses all but
        // the first, which is a far more ordinary shape than the loop it would close.
        //
        // So the bound this gives is synchronous re-entry only: a sink that reports on
        // this channel from inside its own `write()`. A reporter that answers in a later
        // microtask or turn is outside it.
        this._isHandlingReportedError = false;
      }

      if (shouldPreventDefault) {
        try {
          // Only meaningful because the event is dispatched with `cancelable: true`;
          // `preventDefault()` on an uncancelable event is a silent no-op.
          event.preventDefault();
        } catch {
          // The last statement in the listener, and the error is already logged by this
          // point, so a `preventDefault` that throws costs only the cancellation. It
          // must not cost the process, which is what an escaping throw would do here.
        }
      }
    };

    // Guarded, exactly as the matching `removeEventListener` in
    // `unregisterReportErrorListener` is. `isReportErrorAvailable()` only probes that the
    // members *read* as functions; it cannot know whether calling one throws, so a global
    // that passes the probe and refuses the call would otherwise throw out of a method
    // whose whole contract is a return code.
    //
    // The listener is dropped on failure rather than left assigned: keeping it with
    // `_reportErrorListenerRegistered` still `false` is worse than not having it, since
    // `unregisterReportErrorListener` answers `'not_registered'` on that flag, so neither
    // it nor `close()` could ever take back a listener the add may have partially
    // installed.
    try {
      globalThis.addEventListener(
        'error',
        this._reportErrorListener,
        useCapture,
      );
    } catch {
      this._reportErrorListener = null;

      return 'not_available';
    }

    this._reportErrorListenerCapture = useCapture;
    this._reportErrorListenerRegistered = true;

    return 'success';
  }

  /**
   * Unregister the global `'error'` event listener.
   *
   * If the listener is not registered, it returns 'not_registered'.
   * Otherwise, it unregister the listener and returns 'success'.
   *
   * @returns 'success' if the listener is unregistered successfully,
   *          'not_registered' if the listener is not registered.
   */

  public unregisterReportErrorListener(): 'success' | 'not_registered' {
    if (!this._reportErrorListenerRegistered || !this._reportErrorListener) {
      return 'not_registered';
    }

    // The capture flag has to match the one used to register, or the listener is not
    // the one being removed and stays attached.
    try {
      globalThis.removeEventListener(
        'error',
        this._reportErrorListener,
        this._reportErrorListenerCapture,
      );
    } catch {
      // The global was usable when the listener went on and is not now. Rethrowing buys
      // nothing and costs a great deal: this runs from `close()` *before* the sinks are
      // closed, so a throw here left every file and pipe sink holding its handle for the
      // life of the process. A listener that cannot be taken off is already inert, since
      // `close()` sets `_closed` first and the listener returns early on it, and the
      // state below is cleared either way. Guarded here rather than at `close()` so all
      // of the other callers are covered by the same fix.
    }

    this._reportErrorListener = null;
    this._reportErrorListenerRegistered = false;
    this._reportErrorListenerCapture = false;

    return 'success';
  }

  /**
   * Check if the global `'error'` event listener is registered
   *
   * @returns 'true' if the listener is registered, 'false' otherwise.
   */
  public isReportErrorListenerRegistered(): boolean {
    return this._reportErrorListenerRegistered;
  }

  /**
   * Check if the global event primitives used for error reporting are available:
   * the `EventTarget` methods on `globalThis` plus the `ErrorEvent` constructor.
   *
   * On Node.js the event methods are supplied by Lifecycleion's `global-event-target`
   * polyfill, which is installed when this module is imported.
   *
   * @returns 'true' if the required global event primitives are available, 'false' otherwise.
   */
  public isReportErrorAvailable(): boolean {
    return isGlobalEventTargetAvailable();
  }

  /**
   * Add a sink to the logger
   */
  public addSink(sink: LogSink): void {
    this.sinks.push(sink);
  }

  /**
   * Remove a sink from the logger
   * Returns true if the sink was found and removed, false otherwise
   */
  public removeSink(sink: LogSink): boolean {
    const index = this.sinks.indexOf(sink);
    if (index !== -1) {
      this.sinks.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Get a readonly copy of the current sinks
   */
  public getSinks(): readonly LogSink[] {
    return [...this.sinks];
  }

  /**
   * Close all sinks and cleanup resources
   * After closing, the logger is marked as closed and all sinks are removed
   */
  public async close(): Promise<void> {
    this._closed = true;

    // Give up the global listener rather than holding one that can no longer log: a
    // closed logger's `handleLog` is a no-op, so staying registered would claim reports
    // it cannot record and, with the default `preventDefault`, stop anything else from
    // reporting them either.
    this.unregisterReportErrorListener();

    // Close all sinks
    await Promise.all(
      this.sinks.map(async (sink) => {
        if (sink.close) {
          try {
            await sink.close();
          } catch (error) {
            this.handleSinkError(error, 'close', sink);
          }
        }
      }),
    );

    // Remove all sinks from the array after closing
    this.sinks = [];

    this.emit('logger', { eventType: 'close' });
  }

  /**
   * Create a logger optimized for testing.
   * Includes an ArraySink by default for easy log inspection.
   * Process exit is disabled to prevent tests from terminating.
   */
  public static createTestOptimizedLogger(options?: {
    sinks?: LogSink[];
    arrayLogTransformer?: (entry: LogEntry) => LogEntry | false;
    includeConsoleSink?: boolean;
    muteConsole?: boolean;
  }): { logger: Logger; arraySink: ArraySink; consoleSink?: ConsoleSink } {
    const arraySink = new ArraySink({
      transformer: options?.arrayLogTransformer,
    });

    const consoleSink = options?.includeConsoleSink
      ? new ConsoleSink({ muted: options?.muteConsole ?? true })
      : undefined;

    const sinks: LogSink[] = [arraySink];

    if (consoleSink) {
      sinks.push(consoleSink);
    }

    sinks.push(...(options?.sinks || []));

    return {
      logger: new Logger({
        sinks,
        callProcessExit: false,
      }),
      arraySink,
      consoleSink,
    };
  }

  /**
   * Create a logger optimized for frontend/browser use.
   * Includes a ConsoleSink by default for browser devtools output.
   * Process exit is disabled since browsers don't have process.exit.
   */
  public static createFrontendOptimizedLogger(options?: {
    sinks?: LogSink[];
    muteConsole?: boolean;
  }): { logger: Logger; consoleSink: ConsoleSink } {
    const consoleSink = new ConsoleSink({
      muted: options?.muteConsole ?? false,
    });

    return {
      logger: new Logger({
        sinks: [consoleSink, ...(options?.sinks || [])],
        callProcessExit: false,
      }),
      consoleSink,
    };
  }

  /**
   * Internal method to handle all log operations
   */
  protected handleLog(
    type: LogType,
    template: string,
    options?: HandleLogOptions,
  ): void {
    // Don't log if logger is closed
    if (this._closed) {
      return;
    }

    const timestamp = ms();

    // Extract options
    const exitCode = options?.exitCode;
    const serviceName = options?.serviceName?.trim() || undefined;
    const entityName = options?.entityName?.trim() || undefined;
    const params = options?.params;
    const tags = options?.tags;
    const requested = options?.redactedKeys;

    // The requested list, copied once, and everything below reads the copy.
    //
    // `redactedKeys` is caller-supplied, so neither `length` nor an element is
    // necessarily a data property - a `Proxy` can answer from a trap, and need not answer
    // the same way twice. The list is read four times over this call: to decide whether
    // to redact, inside `applyRedaction`, again by the walk, and once more when the entry
    // records what was redacted. Each read seeing something different is what let a list
    // say "one key" here and "no keys" inside `applyRedaction`, which returned `params`
    // untouched - so the values redaction was asked to hide were rendered into the
    // message and handed to every sink. The last read was outside every guard as well, so
    // a list that refused it threw straight out of the `logger.info()` call after
    // redaction had already succeeded.
    //
    // Snapshotted with `snapshotList`, not spread. A spread asks the value to iterate,
    // and a `Proxy` over an array can answer that with nothing at all while still holding
    // the entries - `{ get: (t, k) => (k === 'length' ? 0 : t[k]) }` spreads to `[]`. That
    // read as "an empty list", so this gate concluded no redaction was requested,
    // `applyRedaction` was never called, and the params went to every sink in the clear
    // with `redactedKeys` on the entry reading `undefined` and nothing reported. Every
    // guard here was built for a list that *throws*; that one lies instead.
    // `snapshotList` catches it by the one invariant a real array cannot break - an own
    // index key at or beyond its own `length` - and refuses.
    //
    // A value it refuses is passed along as it is, since spreading `'password'` would turn
    // one plainly unusable list into a list of characters and lose the `<redactedKeys>`
    // report `applyRedaction` makes of it.
    //
    // The copy is also what reaches `entry.redactedKeys`, so a sink is handed an inert
    // array of strings rather than the caller's object with its traps still attached.
    let redactedKeys = requested;

    // The copy, and only ever the copy, once it has actually been made. The entry reads
    // this rather than `redactedKeys`, which still holds the caller's object whenever the
    // copy could not be made - a non-array, or an array whose spread threw. Handing that
    // object to a sink put the traps back exactly where this copy exists to remove them:
    // a sink reading `entry.redactedKeys.length` or `.join(',')` threw inside
    // `sink.write`, and one unreadable list became an `onSinkError` for every registered
    // sink on that call.
    let inertKeys: string[] | undefined;

    // Read once, here, and `null` whenever the list cannot be trusted - not an array, a
    // read that threw, or a length that contradicts the keys.
    const snapshot = snapshotList(requested);

    if (snapshot !== null) {
      redactedKeys = snapshot as string[];

      // Strings only, and that is not the same question `snapshotList` answered.
      // `snapshotList` reports what the list *holds*, not what its elements are, so a
      // `redactedKeys: [123, { a: 1 }]` was cast straight to `string[]` and stored -
      // putting a number, and the caller's own object with its traps still attached,
      // exactly where the copy exists to remove them. A sink then does the ordinary
      // thing with the field this hands it, `.join(',')` or `.map(k => k.toUpperCase())`,
      // and throws inside `sink.write`: one bad list becomes an `onSinkError` for every
      // registered sink on that call.
      //
      // A list that is not all strings leaves this `undefined`, which is the same answer
      // an untrustworthy list already gets: `parseRedactPaths` refuses a non-string entry,
      // so redaction has already failed closed and said so through `onFormatError`, and
      // `redactedParams` carries the marker. There is nothing this field could honestly
      // name.
      if (redactedKeys.every((key) => typeof key === 'string')) {
        inertKeys = redactedKeys;
      }
    }

    // The reporter for every fail-closed path below, built on first use so an ordinary
    // log call allocates nothing for it.
    //
    // These paths were silent, which broke the promise `onFormatError` makes
    // everywhere else: a failure leaves a diagnosis and not only a marker. The other four
    // surfaces keep it - `applyRedaction` for params, `errorToString` for an error's
    // `sensitiveFieldNames`, `redactValue` and `stringifyValue` - because each builds a
    // reporter and hands every failure to it. Only these guards, which exist precisely
    // for the input nothing below them could read, dropped the cause on the floor and
    // left an operator with `(null)` or a marker and nothing to trace it with.
    //
    // One reporter shared across all of them, so the several guards a single unreadable
    // list trips report once rather than once each - the same once-per-pass bound
    // `createFormatReporter` gives every other caller. It is handed to `applyRedaction`
    // as well, so that function's own reporter nests inside this one instead of carrying a
    // second budget: the params are one pass, and one pass reports once.
    let backstopReporter: ReportFormatFailure | null = null;

    const reportBackstop = (error: unknown, key: string): void => {
      backstopReporter ??= createFormatReporter(
        'redaction',
        this.formatErrorHandler(),
      );
      backstopReporter(error, key);
    };

    // Decided from the snapshot, never from a second read of the caller's own object.
    // `length` is the wrong question for anything that is not an array - a `Set` of keys,
    // or any object without a numeric `length`, answered `undefined`, and `undefined > 0`
    // said "no redaction requested", so the params went to every sink in the clear and
    // `applyRedaction`'s fail-closed branch never ran because this gate had already
    // decided not to call it.
    //
    // A list `snapshotList` refused counts as *requested*, not as absent: something was
    // supplied, so redaction was asked for and this cannot tell what for. Treating it as
    // absent is what renders the params in the clear. It falls through to
    // `applyRedaction`, which refuses it again and reports it as `<redactedKeys>`.
    //
    // Only a snapshot that came back genuinely empty means "nothing was asked for", and
    // that is now the one reading of an empty list this can reach: a lying `Proxy` no
    // longer arrives here wearing it.
    const didRequestRedaction =
      params !== undefined &&
      requested !== undefined &&
      (snapshot === null || snapshot.length > 0);

    let redactedParams: Record<string, unknown> | undefined;

    // Process template and apply redaction.
    //
    // Guarded because `applyRedaction` calls the user's `redactFunction` and stringifies
    // caller-supplied values, neither of which this method can vouch for, and `handleLog`
    // must not throw out of a `logger.info()`. It already fails closed per key; this is
    // the backstop for a failure that escapes it entirely.
    if (
      didRequestRedaction &&
      params !== undefined &&
      redactedKeys !== undefined
    ) {
      try {
        redactedParams = applyRedaction(
          params,
          redactedKeys,
          this.redactFunction,
          // One reporter for the whole params pass, rather than one here and another
          // inside `applyRedaction`. Both are once-per-pass, so nesting them keeps that
          // bound: the several guards a single unreadable list trips report once between
          // them, which is what `createFormatReporter` promises and what two
          // independent budgets quietly broke.
          // Adapted, not handed over: `reportBackstop` is a reporter bound to
          // `'redaction'` already, and this slot takes a handler. Dropping the `kind` is
          // correct rather than lossy - every failure `applyRedaction` raises is a
          // redaction failure, which is the kind the backstop reports under.
          (error, _kind, key) => {
            reportBackstop(error, key);
          },
        );
      } catch (error) {
        // Belt and braces. `applyRedaction` guards every step it owns, its own head read
        // included, so nothing is expected to arrive here - but a logger must not throw
        // out of a `logger.info()`, and that guarantee should not rest on a promise made
        // in another file.
        reportBackstop(error, '<redactedKeys>');

        // Never fall through to the raw params below: rendering the message from those
        // would print the very values redaction was asked to hide, to every sink.
        //
        // The same helper `applyRedaction` fails closed with, rather than a second copy
        // of it here. Two spellings of "everything marked" meant a sink saw a different
        // shape depending on which layer gave up, and the copy was written here only
        // because this one is itself guarded - marking reads the unusable list again.
        redactedParams = markAllRedactionFailed(redactedKeys);
      }
    }

    const messageParams = redactedParams ?? params;

    // The logger's own handler, carried into the render. Without it this was the widest
    // silent surface in the library: every `{{...}}` in every log line goes through here,
    // and a placeholder whose value refused to be read rendered the same `(null)` a typo
    // does. The options object is built only when a handler exists, so an ordinary log
    // call allocates nothing for it.
    const message = messageParams
      ? CurlyBrackets(template, messageParams, undefined, {
          onFormatError: this.formatErrorHandler(),
        })
      : template;

    // Create log entry
    const entry: LogEntry = {
      timestamp,
      type,
      serviceName,
      entityName,
      template,
      message,
      params,
      redactedParams,
      // The decision made above, not a second read of `redactedKeys`, and the inert copy
      // rather than the caller's object. A list too hostile to copy leaves this
      // `undefined`: the redaction itself has already failed closed and said so through
      // `onFormatError`, and `redactedParams` carries the marker, so there is nothing
      // this field could honestly name.
      redactedKeys: didRequestRedaction ? inertKeys : undefined,
      error: options?.error,
      exitCode: isNumber(exitCode) ? exitCode : undefined,
      tags: tags && tags.length > 0 ? tags : undefined,
    };

    // Write to all sinks
    for (const sink of this.sinks) {
      try {
        const result = sink.write(entry);
        // Handle async errors from sinks that return promises
        if (isPromise(result)) {
          result.catch((error: unknown) => {
            this.handleSinkError(error, 'write', sink);
          });
        }
      } catch (error) {
        // Handle sync errors
        this.handleSinkError(error, 'write', sink);
      }
    }

    // Emit log event
    this.emit('logger', {
      eventType: 'log',
      logType: type,
      message,
      timestamp,
    });

    // Handle exit if requested (only if exitCode is a valid number)
    if (isNumber(exitCode)) {
      this.exit(exitCode);
    }
  }

  /**
   * Report a failure from one of this logger's own `'logger'` event handlers.
   *
   * Deliberately does **not** use the standard `'error'` channel the base class uses.
   * Logging emits a `'logger'` event, so a handler failure reported on that channel is
   * logged, which emits again, which fails again: with a handler that reliably fails
   * (an async one that always rejects is the clearest case) that is an unbounded cycle
   * rather than a stack overflow, so no re-entrancy guard can catch it. Reporting these to the
   * console instead breaks the edge that closes the loop, and matches the fall-back a
   * failing sink already gets.
   *
   * Failures from handlers on *other* Lifecycleion emitters are unaffected and still
   * reach this logger's sinks through `registerReportErrorListener()`.
   */
  protected override handleEventHandlerFailure(
    event: string,
    error: unknown,
  ): void {
    // Normalized rather than trusted: a handler is free to `throw null` or reject with a
    // string, and reading `.message` off that directly would throw a `TypeError` out of
    // the log call that emitted the event.
    const cause = toError(error);

    const failure = new Error(
      `Error in a logger event handler for ${event}: ${describeError(cause)}`,
      { cause },
    );

    // Not routed through `onSinkError`: that callback is handed the sink that failed, and
    // no sink is involved here, so there would be nothing honest to pass.
    // The shared rung, and it never broadcasts - which for this channel is the whole
    // point. A `'logger'` event is emitted *by* logging, so reporting a handler's failure
    // anywhere a logger might hear it is logged, which emits again, which fails again:
    // with a handler that reliably rejects that is an unbounded cycle rather than a stack
    // overflow, so no re-entrancy guard closes it.
    //
    // `runCallbackSafely` states the requirement this satisfies outright - "`onError` must
    // not throw: it runs on the failure path, and there is nothing above it left to catch"
    // - and this override is what it calls: a throw here escaped `emit` and left the
    // `logger.info()` that emitted the event, or, for a handler that rejected, became an
    // unhandled rejection from `result.catch(onError)`.
    //
    // `failure.message` is a plain string, built here rather than handed in.
    reportThroughHandler(
      this.onEventHandlerError === undefined
        ? undefined
        : // Returned, so an `async` handler that rejects reaches the console rung rather
          // than becoming an unhandled rejection out of a log call.
          () => this.onEventHandlerError?.(failure, event),
      () => failure.message,
    );
  }

  /**
   * The handler this logger supplies when the caller set none.
   *
   * Every format this logger performs runs *inside* a log call, so it must
   * never reach `createFailureReporter`'s default rung: that broadcasts on the global
   * `'error'` channel, `registerReportErrorListener()` would log what it hears, logging
   * renders and redacts, and rendering or redacting is what just failed. Supplying a
   * handler unconditionally is what keeps this logger off that rung - the user's handler
   * when they set one, this when they did not.
   *
   * The console, because it is the only rung that cannot re-enter what is already running.
   * A caller who wants these somewhere else sets `onFormatError` and this is never used.
   */
  private formatErrorHandler(): FormatErrorHandler {
    return this.onFormatError ?? consoleFormatHandler();
  }

  /**
   * Render an error for `errorObject`, here and in every `LoggerService` below this.
   *
   * One place, so a service or entity logger cannot drift from the logger that made it.
   */
  private renderErrorObject(prefix: string, error: unknown): string {
    return prepareErrorObjectLog(prefix, error, {
      // The logger's own masking and its failure handler, so an error rendered here masks
      // the way params do and a failure reaches `onFormatError` rather than the console.
      redactFunction: this.redactFunction,
      // Never left to the default: see `formatErrorHandler`.
      onFormatError: this.formatErrorHandler(),
    });
  }

  /**
   * Handle sink errors by calling the onSinkError callback or falling back to the console.
   *
   * Nothing here may throw. This is reached from `handleLog`'s synchronous `catch`, where
   * a throw leaves the caller's own `logger.info()`; from `result.catch(...)` on a sink
   * that returned a promise, where it becomes an unhandled rejection; and from `close()`,
   * where it would reject a shutdown. The console rung goes through `reportToConsole` for
   * that reason - `console.error` throws on a broken stdout, which is precisely the
   * condition `close()` runs under.
   */
  private handleSinkError(
    error: unknown,
    context: 'write' | 'close',
    sink: LogSink,
  ): void {
    // Normalized rather than trusted, for the same reason as a failing event handler: a
    // sink is user-supplied and free to throw or reject with any value, and reading
    // `.message` off `null` would throw a `TypeError` out of the log call that wrote to
    // it. Normalizing here also makes `onSinkError`'s declared `Error` parameter honest.
    const failure = toError(error);

    // The shared rung, so this channel cannot drift from the other three. It never
    // broadcasts, and that is structural: a sink can only fail *during* a log call, so
    // reporting anywhere a logger might hear it would be logged, and logging writes to
    // sinks - this one included.
    reportThroughHandler(
      this.onSinkError === undefined
        ? undefined
        : // Returned, for the reason `onEventHandlerError` above is.
          () => this.onSinkError?.(failure, context, sink),
      () =>
        `Error ${context === 'write' ? 'writing to' : 'closing'} sink: ${describeError(failure)}`,
    );
  }

  /**
   * Process the exit
   */
  private processExit(code: number): void {
    this._didExit = true;
    this._exitCode = code;
    this._isPendingExit = false;

    this.emit('logger', { eventType: 'exit-process', code });

    // Close sinks and then exit
    void this.close().finally(() => {
      if (this.callProcessExit) {
        if (
          typeof globalThis.process !== 'undefined' &&
          typeof globalThis.process.exit === 'function'
        ) {
          globalThis.process.exit(code);
        }
      }
    });
  }
}

// Re-export types and sinks
export * from './types';
// Exported so a sink can recognise a value whose redaction failed without hard-coding
// the literal; see the redaction section of the logger docs.
export { REDACTION_FAILED_MARKER } from './utils/redaction';
export * from './sinks';
export type { LoggerService } from './logger-service';
