# safe-handle-callback

Safely execute sync or async callbacks with automatic error reporting via the standard `reportError` event API.

<!-- toc -->

- [Usage](#usage)
- [API](#api)
  - [safeHandleCallback](#safehandlecallback)
  - [safeHandleCallbackAndWait](#safehandlecallbackandwait)

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

Fire-and-forget wrapper that executes a callback (sync or async) and reports any errors via `globalThis.dispatchEvent` using the standard `reportError` event API (available in Node.js 15+, Bun, Deno, and browsers). Does not return a value or wait for async completion.

```typescript
safeHandleCallback('onData', myCallback, arg1, arg2);
```

**Parameters:**

- `callbackName` — Name used in error messages for identification
- `callback` — The function to execute (sync or async)
- `...args` — Arguments forwarded to the callback

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

- `success: true` — callback completed without throwing; `value` holds the return value
- `success: false` — callback threw or was not a function; `error` holds the caught error
