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
import { describeError, toError } from '../to-error';
import {
  createRedactionReporter,
  type RedactionErrorHandler,
  type ReportRedactionFailure,
} from '../internal/redaction-reporter';
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
import { applyRedaction, REDACTION_FAILED_MARKER } from './utils/redaction';
import { prepareErrorObjectLog } from './utils/error-object';
import { LoggerService } from './logger-service';

/**
 * Main Logger class with sink-based architecture and EventEmitter support
 */
/**
 * Read a property off an event without trusting it.
 *
 * The event reaching a global `'error'` listener was dispatched by whoever chose to
 * dispatch it, and `Event` can be subclassed with accessors of its own. A throw from one
 * of these reads would escape the listener, which outside a browser means the runtime
 * treats it as uncaught and exits — from inside the code whose whole job is reporting a
 * failure.
 */
function readEventProperty(event: Event, key: string): unknown {
  try {
    return (event as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * Whether the event was dispatched on a DOM element rather than on the global object.
 *
 * A DOM element is identified by a string `tagName`, which the global object and the
 * polyfilled backing `EventTarget` both lack. Used to tell an event belonging to the
 * page from a report meant for this library.
 */
function isElementTarget(event: Event): boolean {
  const target: unknown = readEventProperty(event, 'target');

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
 * - The element must actually name a resource (`src`, `href`, or `currentSrc`). An
 *   arbitrary element that happens to be an event target is not a failed load.
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
  const target: unknown = readEventProperty(event, 'target');

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
  if (readEventProperty(event, 'isTrusted') !== true) {
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

  for (const key of ['src', 'href', 'currentSrc']) {
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
  private onSinkError?: (
    error: Error,
    context: 'write' | 'close',
    sink: LogSink,
  ) => void;
  private onEventHandlerError?: (error: Error, event: string) => void;
  private onRedactionError?: RedactionErrorHandler;

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
    this.onRedactionError = options.onRedactionError;
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
      const reported: unknown = readEventProperty(event, 'error');

      const reportedMessage: unknown = readEventProperty(event, 'message');

      // Emptiness is checked, not just `undefined`: `ErrorEvent`'s `message` defaults to
      // `''`, so a plain `new ErrorEvent('error')` would satisfy `??` and produce an
      // `Error` with no message at all instead of reaching the description below.
      const message: string | undefined =
        typeof reportedMessage === 'string' && reportedMessage.length > 0
          ? reportedMessage
          : undefined;

      // `isError` rather than a bare `instanceof`: the payload comes from whoever
      // dispatched the event, and `instanceof` walks a prototype chain, which a revoked
      // `Proxy` makes throw. A throw here would escape the listener, skipping the
      // `preventDefault()` below and — on Bun and Node — killing the process from inside
      // the error-reporting path.
      let isError: boolean;

      try {
        isError = reported instanceof Error;
      } catch {
        isError = false;
      }

      let error: Error;

      if (isError) {
        error = reported as Error;
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
        // eslint-disable-next-line no-console -- last resort on the reporting path
        console.error(describeError(error_));
      } finally {
        // Cleared in `finally` so a sink or handler that throws its way out cannot leave
        // the listener permanently deaf.
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

    globalThis.addEventListener('error', this._reportErrorListener, useCapture);
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
    // Copied only when it is an array: a non-array is passed along as it is, since
    // spreading `'password'` would turn one plainly unusable list into a list of
    // characters and lose the `<redactedKeys>` report `applyRedaction` makes of it. A
    // copy that fails leaves the original in place, where the guards below catch it.
    //
    // The copy is also what reaches `entry.redactedKeys`, so a sink is handed an inert
    // array of strings rather than the caller's object with its traps still attached.
    let redactedKeys = requested;

    try {
      if (Array.isArray(requested)) {
        redactedKeys = [...requested];
      }
    } catch {
      // Nothing usable came of it, so the original stands and fails closed below.
    }

    // Whether the caller asked for redaction. Guarded, because a list that refused to be
    // copied is still being read here.
    //
    // A read that fails counts as *requested*, not as absent. A list was supplied, so
    // redaction was asked for and this cannot tell what for; treating it as absent would
    // render the params in the clear, which is the one outcome redaction exists to
    // prevent. `params` and `redactedKeys` are both non-`undefined` whenever the read
    // throws, since the `length` access is reached only after both have been tested.
    let didRequestRedaction: boolean;

    // The reporter for every fail-closed path below, built on first use so an ordinary
    // log call allocates nothing for it.
    //
    // These paths were silent, which broke the promise `onRedactionError` makes
    // everywhere else: a failure leaves a diagnosis and not only a marker. The other four
    // surfaces keep it - `applyRedaction` for params, `errorToString` for an error's
    // `sensitiveFieldNames`, `redactValue` and `stringifyValue` - because each builds a
    // reporter and hands every failure to it. Only these guards, which exist precisely
    // for the input nothing below them could read, dropped the cause on the floor and
    // left an operator with `(null)` or a marker and nothing to trace it with.
    //
    // One reporter shared across all of them, so the several guards a single unreadable
    // list trips report once rather than once each - the same once-per-pass bound
    // `createRedactionReporter` gives every other caller. It does not double up with
    // `applyRedaction`'s own reporter either: everything in that function after the
    // reporter is built is itself guarded, so a throw that reaches the backstop came from
    // the unguarded length read above it, before anything could have been reported.
    let backstopReporter: ReportRedactionFailure | null = null;

    const reportBackstop = (error: unknown, key: string): void => {
      backstopReporter ??= createRedactionReporter(this.onRedactionError);
      backstopReporter(error, key);
    };

    try {
      didRequestRedaction =
        params !== undefined &&
        redactedKeys !== undefined &&
        redactedKeys.length > 0;
    } catch (error) {
      didRequestRedaction = true;
      reportBackstop(error, '<redactedKeys>');
    }

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
          this.onRedactionError,
        );
      } catch (error) {
        reportBackstop(error, '<redactedKeys>');

        // Never fall through to the raw params below: rendering the message from those
        // would print the very values redaction was asked to hide, to every sink.
        //
        // Guarded, for the reason `applyRedaction`'s own `allMarked()` is: this runs only
        // because something above it threw, and the way that happens is a `redactedKeys`
        // that cannot be read - a `length` accessor that throws on a later read, a
        // `Symbol.iterator` that refuses. Marking the keys reads the same list again, so
        // an unguarded `map` here fails the same way and the throw escapes `handleLog`
        // and the `logger.info()` call this backstop exists to protect. With nothing
        // nameable to mark, an empty bag is the safe answer: it carries no original value.
        try {
          redactedParams = Object.fromEntries(
            redactedKeys.map((key) => [key, REDACTION_FAILED_MARKER]),
          );
        } catch {
          redactedParams = {};
        }
      }
    }

    const messageParams = redactedParams ?? params;
    const message = messageParams
      ? CurlyBrackets(template, messageParams)
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
      // The decision made above, not a second read of `redactedKeys`.
      redactedKeys: didRequestRedaction ? redactedKeys : undefined,
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
    if (this.onEventHandlerError) {
      try {
        this.onEventHandlerError(failure, event);

        return;
      } catch {
        // Fall through to the console, as `handleSinkError` does for its own callback.
        // A handler for failures must not be able to turn one into two.
      }
    }

    // eslint-disable-next-line no-console -- reporting this any other way reopens the loop
    console.error(failure.message);
  }

  /**
   * Render an error for `errorObject`, here and in every `LoggerService` below this.
   *
   * One place, so a service or entity logger cannot drift from the logger that made it.
   */
  private renderErrorObject(prefix: string, error: unknown): string {
    return prepareErrorObjectLog(prefix, error, {
      // The logger's own masking and its failure handler, so an error rendered here masks
      // the way params do and a failure reaches `onRedactionError` rather than the console.
      redactFunction: this.redactFunction,
      onRedactionError: this.onRedactionError,
    });
  }

  /**
   * Handle sink errors by calling the onSinkError callback or falling back to console.error
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

    if (this.onSinkError) {
      try {
        this.onSinkError(failure, context, sink);
      } catch {
        // Ignore errors in the error handler to prevent infinite loops
        // eslint-disable-next-line no-console
        console.error(
          `Error in onSinkError handler: ${describeError(failure)}`,
        );
      }
    } else {
      // Fallback to console.error
      // eslint-disable-next-line no-console
      console.error(
        `Error ${context === 'write' ? 'writing to' : 'closing'} sink: ${describeError(failure)}`,
      );
    }
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
