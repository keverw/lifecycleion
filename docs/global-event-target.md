# global-event-target

Conservative polyfill that gives `globalThis` the `EventTarget` methods on Node.js, so Lifecycleion's `'reportError'` reporting convention works there.

<!-- toc -->

- [Why this exists](#why-this-exists)
- [Usage](#usage)
- [API](#api)
  - [installGlobalEventTarget](#installglobaleventtarget)
  - [getGlobalEventTarget](#getglobaleventtarget)
  - [isGlobalEventTargetPolyfilled](#isglobaleventtargetpolyfilled)
  - [isGlobalEventTargetAvailable](#isglobaleventtargetavailable)
- [Guarantees](#guarantees)

<!-- tocstop -->

## Why this exists

`safe-handle-callback` and `logger` report errors with Lifecycleion's `'reportError'` convention: an `ErrorEvent` dispatched through `globalThis.dispatchEvent()`, observed with `globalThis.addEventListener('reportError', handler)`. The `ErrorEvent` constructor and the `EventTarget` methods are web-standard primitives; the `'reportError'` event type itself is Lifecycleion's own convention, not a web standard.

Browsers, Bun, and Deno expose all of these on the global object. Node.js does not. As of Node 25 the `ErrorEvent` constructor **is** a global, but `globalThis` is still **not** an `EventTarget`:

```js
// node 25.x
typeof globalThis.ErrorEvent; // 'function'
typeof globalThis.dispatchEvent; // 'undefined'
typeof globalThis.addEventListener; // 'undefined'
typeof globalThis.removeEventListener; // 'undefined'
```

Lifecycleion supplies the missing global event methods, backing them with a single shared `EventTarget`. Node 25+ is the supported floor (see `engines.node`), so `ErrorEvent` itself is never polyfilled.

Nothing needs to be wired up by hand: importing `lifecycleion/safe-handle-callback` or `lifecycleion/logger` installs it. This module is exported for the cases where you want to inspect or control that explicitly.

## Usage

```typescript
import {
  installGlobalEventTarget,
  getGlobalEventTarget,
  isGlobalEventTargetPolyfilled,
  isGlobalEventTargetAvailable,
} from 'lifecycleion/global-event-target';
```

## API

### installGlobalEventTarget

Installs `addEventListener`, `removeEventListener`, and `dispatchEvent` on `globalThis` when — and only when — all three are missing.

```typescript
const result = installGlobalEventTarget();
```

**Returns:** one of

| Result                | Meaning                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `'native'`            | The environment already provides all three methods (browser, Bun, Deno). Nothing was changed.      |
| `'installed'`         | This call installed the polyfill.                                                                  |
| `'already-installed'` | A previous call, or another copy of Lifecycleion, installed it. The same backing target is reused. |
| `'partial'`           | Some but not all of the methods exist. Nothing was installed — see [Guarantees](#guarantees).      |
| `'unsupported'`       | The methods are missing and there is no `EventTarget` constructor to back them with.               |

### getGlobalEventTarget

Returns the shared `EventTarget` backing the polyfilled methods, or `null` when the polyfill is not in use (native environments, or environments where installation was skipped).

```typescript
const target = getGlobalEventTarget();
```

### isGlobalEventTargetPolyfilled

Whether the global event methods currently in place were installed by this polyfill.

```typescript
if (isGlobalEventTargetPolyfilled()) {
  // running on Node, using lifecycleion's backing EventTarget
}
```

### isGlobalEventTargetAvailable

Whether `globalThis` exposes everything the `'reportError'` convention needs: the three `EventTarget` methods plus the `ErrorEvent` constructor. This is what `logger.isReportErrorAvailable()` reports.

```typescript
if (isGlobalEventTargetAvailable()) {
  globalThis.addEventListener('reportError', handler);
}
```

## Guarantees

- **Never overwrites.** If all three methods are already present — native or user-installed — the call is a no-op.
- **Idempotent.** Repeated calls, repeated module initialization, and multiple copies of Lifecycleion share one backing target via a `Symbol.for()` key, so listeners registered earlier keep working.
- **No mixing.** If the environment has a partial or foreign surface (say, only `addEventListener`), nothing is installed. Filling in the gaps from a fresh target would send dispatches somewhere the existing listeners are not; degrading quietly is safer than reporting into the void. Reporting is skipped in that case, and the helpers still return their normal results.
- **Non-enumerable.** Installed properties are defined with `Object.defineProperty` and do not show up in `Object.keys(globalThis)`.
- **Bound.** Installed methods are bound to the backing target, so they work when destructured or passed around.
- **Browser and Bun behavior is unchanged.**
