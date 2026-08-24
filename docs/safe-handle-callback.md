# safe-handle-callback

Safely execute sync or async callbacks with automatic error reporting via Lifecycleion's `'reportError'` convention, built from web-standard primitives (`ErrorEvent` + the global `EventTarget` methods).

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [safeHandleCallback](#safehandlecallback)
  - [safeHandleCallbackAndWait](#safehandlecallbackandwait)
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

Fire-and-forget wrapper that executes a callback (sync or async) and reports any errors as an `ErrorEvent` dispatched through `globalThis.dispatchEvent` under the `'reportError'` event type. Works in Bun, Deno, modern browsers, and Node.js 25+ (see [Runtime support](#runtime-support)). Does not return a value or wait for async completion.

```typescript
safeHandleCallback('onData', myCallback, arg1, arg2);
```

**Parameters:**

- `callbackName` - Name used in error messages for identification
- `callback` - The function to execute (sync or async)
- `...args` - Arguments forwarded to the callback

**Error handling:**

Errors are dispatched as `ErrorEvent` objects with type `'reportError'`. Listen for them with:

```typescript
globalThis.addEventListener('reportError', (event) => {
  console.error(event.error);
});
```

### safeHandleCallbackAndWait

Async variant that waits for the callback to complete and returns a result object indicating success or failure. Also dispatches errors via `reportError` like `safeHandleCallback`.

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

## Runtime Support

`'reportError'` is Lifecycleion's own reporting convention, assembled from web-standard primitives: an `ErrorEvent` dispatched through the `EventTarget` methods on the global object. It is not itself a web-standard API.

Browsers, Bun, and Deno expose those primitives on `globalThis` natively. Node.js is a partial case: the `ErrorEvent` constructor is a global as of Node 25, but `globalThis` is still not an `EventTarget`, so `addEventListener` / `removeEventListener` / `dispatchEvent` are missing. Lifecycleion supplies that missing surface. Importing this module installs the three methods, backed by one shared `EventTarget`, without ever overwriting an existing implementation. See [global-event-target](./global-event-target.md) for the details and guarantees.

Node 25+ is the supported floor (`engines.node`), so `ErrorEvent` itself is never polyfilled. If an environment somehow provides neither the native nor the polyfilled primitives, reporting is skipped: errors are still caught, and `safeHandleCallbackAndWait` still returns its structured failure.
