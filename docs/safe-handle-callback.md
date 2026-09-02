# safe-handle-callback

Safely execute sync or async callbacks with automatic error reporting on the standard global `'error'` channel (`ErrorEvent` + the global `EventTarget` methods).

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [safeHandleCallback](#safehandlecallback)
  - [safeHandleCallbackAndWait](#safehandlecallbackandwait)
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
  // Claim the report: without this the error is also written to the console.
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
- `success: false` - callback threw or was not a function, and `error` holds the caught error

## The reporting pattern

This is the pattern Lifecycleion uses internally and recommends for any code that catches an error it must not rethrow — your own callback wrappers included. Reporting this way keeps errors visible without deciding the host's control flow, and anything reported through it is picked up by `logger.registerReportErrorListener()`.

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

Three details are load-bearing:

**Dispatch comes first, not `reportError()`.** The WHATWG "report an exception" algorithm suggests reaching for `globalThis.reportError()` first, and in browsers that does dispatch an `'error'` event. Other runtimes do not follow it: on Bun 1.3.14 `globalThis.reportError()` exists but writes to stderr without notifying a single `addEventListener('error', ...)` listener, and it sets the process exit code to 1 as a side effect. A `reportError()`-first order would therefore make reports invisible to listeners on Bun, and would let a failed callback turn a clean run into a failing one. Dispatch-first reaches listeners on browsers, Bun, and Node alike.

**`cancelable: true` is required, not decorative.** `EventInit.cancelable` defaults to `false`, and `preventDefault()` on an uncancelable event is a silent no-op that leaves `dispatchEvent()` returning `true` no matter what a listener does. Without it, a consumer cannot claim the report and the console fall-through fires every time.

**Classify a failed dispatch as unclaimed, not unavailable.** If `dispatchEvent()` itself throws, the event was still handed over and listeners may have run, so fall through to the console rather than on to `reportError()`. Only a failure to _construct_ the event means nothing was dispatched. (A throwing listener is not what reaches this path: per spec those are reported out of band without propagating, and Bun and browsers both honour that. An exotic or hostile `dispatchEvent` that rejects the event outright is.)

When testing code like this, dispatch against the real global `EventTarget`. A stubbed `dispatchEvent` returns whatever boolean the stub chose, so an implementation that forgot `cancelable: true` passes against it. Conversely, a test that wants to observe rung 2 has to make rung 1 genuinely unreachable first — on a runtime with a working `dispatchEvent`, the report correctly never gets that far.

## Runtime Support

Reporting uses web-standard primitives: an `ErrorEvent` of the standard `'error'` type, dispatched through the `EventTarget` methods on the global object.

> Earlier versions dispatched a custom `'reportError'` event type, which was Lifecycleion's own convention rather than a web standard. That type is no longer used or listened for; see the changelog.

Browsers, Bun, and Deno expose those primitives on `globalThis` natively. Node.js is a partial case: the `ErrorEvent` constructor is a global as of Node 25, but `globalThis` is still not an `EventTarget`, so `addEventListener` / `removeEventListener` / `dispatchEvent` are missing. Lifecycleion supplies that missing surface. Importing this module installs the three methods, backed by one shared `EventTarget`, without ever overwriting an existing implementation. See [global-event-target](./global-event-target.md) for the details and guarantees.

Node 25+ is the supported floor (`engines.node`), so `ErrorEvent` itself is never polyfilled. If an environment provides neither the native nor the polyfilled primitives, reporting falls back to `globalThis.reportError()` and then `console.error()`: errors are still caught, and `safeHandleCallbackAndWait` still returns its structured failure.
