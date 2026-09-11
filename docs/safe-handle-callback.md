# safe-handle-callback

Safely execute sync or async callbacks with automatic error reporting on the standard global `'error'` channel (`ErrorEvent` + the global `EventTarget` methods).

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [safeHandleCallback](#safehandlecallback)
  - [safeHandleCallbackAndWait](#safehandlecallbackandwait)
  - [reportCallbackError](#reportcallbackerror)
  - [runCallbackSafely](#runcallbacksafely)
- [The reporting pattern](#the-reporting-pattern)
- [Runtime Support](#runtime-support)

<!-- tocstop -->

## Usage

```typescript
import {
  safeHandleCallback,
  safeHandleCallbackAndWait,
} from 'lifecycleion/safe-handle-callback';
```

## API

### safeHandleCallback

Fire-and-forget wrapper that executes a callback (sync or async) and reports any errors as an `ErrorEvent` of type `'error'` dispatched through `globalThis.dispatchEvent`. Works in Bun, Deno, modern browsers, and Node.js 25+ (see [Runtime support](#runtime-support)). Does not return a value or wait for async completion.

```typescript
safeHandleCallback('onData', myCallback, arg1, arg2);
```

**Parameters:**

- `callbackName` - Name used in error messages for identification
- `callback` - The function to execute (sync or async)
- `...args` - Arguments forwarded to the callback

**Error handling:**

Errors are dispatched as `ErrorEvent` objects of type `'error'`. Listen for them with:

```typescript
globalThis.addEventListener('error', (event) => {
  // Claim the report: suppresses lifecycleion's console fall-through, and
  // the browser's own console line for a genuine uncaught error
  event.preventDefault();

  console.error(event.error);
});
```

Or let [logger](./logger.md) do it, which routes them to your sinks:

```typescript
logger.registerReportErrorListener();
```

### safeHandleCallbackAndWait

Async variant that waits for the callback to complete and returns a result object indicating success or failure. Also reports errors on the `'error'` channel like `safeHandleCallback`.

```typescript
const result = await safeHandleCallbackAndWait('onData', myCallback, arg1);

if (result.success) {
  console.log(result.value);
} else {
  console.error(result.error);
}
```

**Returns:** `Promise<{ success: boolean; value?: T; error?: Error }>`

- `success: true` - callback completed without throwing, and `value` holds the return value
- `success: false` - callback threw or was not a function, and `error` holds the failure

`error` is always a real `Error`, even when the callback did something like `throw null`: the value is normalized with [`toError`](./to-error.md), which keeps whatever was actually thrown on `error.cause`. Reading `result.error.message` is therefore safe against a non-`Error` throw - though see the note below about errors whose `message` accessor itself throws.

### reportCallbackError

```typescript
function reportCallbackError(callbackName: string, error: unknown): void;
```

Reports a caught callback failure through the same standard `'error'` channel and fallback chain used by `safeHandleCallback`. The dispatched wrapper identifies `callbackName` and keeps the original thrown value on `event.error.cause`.

### runCallbackSafely

```typescript
function runCallbackSafely(
  callbackName: string,
  callback: unknown,
  args: unknown[],
  onError: (error: unknown) => void,
): void;
```

Runs a callback without awaiting it, forwarding a synchronous throw, a returned promise's rejection, or a synthesized non-function error to `onError`. The `onError` callback runs on the final failure path and must not throw.

## The reporting pattern

Use `reportCallbackError()` when reporting a callback failure. If you need a different wrapper, the outline below shows the dispatch and fallback order. Lifecycleion's implementation additionally guards reads of mutable globals, event construction, dispatch, host reporting, rendering, and console output so the reporting path cannot throw; include equivalent guards when your caller requires that guarantee.

```typescript
function reportToHost(error: Error): void {
  // Rung 1: dispatch on the standard channel. `cancelable: true` is required — see below.
  if (
    typeof globalThis.dispatchEvent === 'function' &&
    typeof globalThis.ErrorEvent === 'function'
  ) {
    const event = new ErrorEvent('error', {
      error,
      message: error.message,
      cancelable: true,
    });

    // A listener that calls `preventDefault()` has claimed the report.
    if (!globalThis.dispatchEvent(event)) {
      return;
    }

    // Dispatched but unclaimed: fall through to the console, exactly as an
    // unhandled error would. Never fall on to `reportError()` here — in browsers
    // that dispatches a second event to the listeners that already saw this one.
    console.error(error);

    return;
  }

  // Rung 2: no dispatch available, but the runtime can report for us.
  if (typeof globalThis.reportError === 'function') {
    globalThis.reportError(error);

    return;
  }

  // Rung 3: last resort.
  console.error(error);
}
```

Four details are load-bearing:

**Dispatch comes first, not `reportError()`.** The WHATWG "report an exception" algorithm suggests reaching for `globalThis.reportError()` first, and in browsers that does dispatch an `'error'` event. Other runtimes do not follow it: on Bun 1.3.14 `globalThis.reportError()` exists but writes to stderr without notifying a single `addEventListener('error', ...)` listener, and it sets the process exit code to 1 as a side effect. A `reportError()`-first order would therefore make reports invisible to listeners on Bun, and would let a failed callback turn a clean run into a failing one. Dispatch-first reaches listeners on browsers, Bun, and Node alike.

**`cancelable: true` is required, not decorative.** `EventInit.cancelable` defaults to `false`, and `preventDefault()` on an uncancelable event is a silent no-op that leaves `dispatchEvent()` returning `true` no matter what a listener does. Without it, a consumer cannot claim the report and the console fall-through fires every time.

**Classify a failed dispatch as unclaimed, not unavailable.** If `dispatchEvent()` itself throws, the event was still handed over and listeners may have run, so fall through to the console rather than on to `reportError()`. Only a failure to _construct_ the event means nothing was dispatched. (A throwing listener is not what reaches this path: per spec a listener's exception does not propagate back into `dispatchEvent`, and browsers, Bun and Node all honour that. An exotic or hostile `dispatchEvent` that rejects the event outright is.)

**A listener that throws still takes the process down.** "Does not propagate" is not the same as "is harmless". A browser reports the exception to the console and carries on, but outside a browser the runtime treats it as uncaught: measured on Bun 1.3.14 and Node 25.9.0, a listener that throws exits the process with code 1 while `dispatchEvent()` still returns normally to the caller. Anything you register on the `'error'` channel should therefore catch its own failures — including whatever formatting or I/O it does with the error, since rendering a hostile error object can throw on its own. `logger.registerReportErrorListener()` does this for you, falling back to the console if its own logging fails.

**The report carries the failure on `cause`, not rendered into its message.** What is dispatched is an `Error` whose message names the callback that failed - `Error in a callback <name>` - with the value the callback actually threw on `error.cause`. Rendering it into the message instead would settle questions that belong to whoever receives the report: which masking to apply, where a redaction failure gets reported, and whether the original object is still reachable at all. `errorToString` renders `cause`, so a consumer that hands the report straight to it sees everything the pre-rendered form showed, under its own `redactFunction` and `onFormatError`. The console fall-through renders at that last rung, where there is no consumer to ask.

For the formatting itself, use the library's own renderers rather than reading the error directly: [`describeError`](./to-error.md#describeerror) for a single-line message and [`errorToString`](./error-to-string.md) for the full table. Both guard every read and never throw, which is exactly the guarantee a listener on this channel needs.

When testing code like this, dispatch against the real global `EventTarget`. A stubbed `dispatchEvent` returns whatever boolean the stub chose, so an implementation that forgot `cancelable: true` passes against it. Conversely, a test that wants to observe rung 2 has to make rung 1 genuinely unreachable first — on a runtime with a working `dispatchEvent`, the report correctly never gets that far.

## Runtime Support

Reporting uses web-standard primitives: an `ErrorEvent` of the standard `'error'` type, dispatched through the `EventTarget` methods on the global object.

> Earlier versions dispatched a custom `'reportError'` event type, which was Lifecycleion's own convention rather than a web standard. That type is no longer used or listened for; see the changelog.

Browsers, Bun, and Deno expose those primitives on `globalThis` natively. Node.js is a partial case: the `ErrorEvent` constructor is a global as of Node 25, but `globalThis` is still not an `EventTarget`, so `addEventListener` / `removeEventListener` / `dispatchEvent` are missing. Lifecycleion supplies that missing surface. Importing this module installs the three methods, backed by one shared `EventTarget`, without ever overwriting an existing implementation. See [global-event-target](./global-event-target.md) for the details and guarantees.

Node 25+ is the supported floor (`engines.node`), so `ErrorEvent` itself is never polyfilled. If an environment provides neither the native nor the polyfilled primitives, reporting falls back to `globalThis.reportError()` and then `console.error()`: errors are still caught, and `safeHandleCallbackAndWait` still returns its structured failure.
