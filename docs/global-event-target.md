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

Nothing needs to be wired up by hand: importing `lifecycleion/safe-handle-callback` or `lifecycleion/logger` installs it. Both are listed in the package's `sideEffects`, so a bundler will not drop that installation — including for a bare `import 'lifecycleion/safe-handle-callback'`. Everything else in the package stays side-effect-free and fully tree-shakeable. Reporting also re-runs the install on its own error path, so a failure can never be swallowed for a packaging reason.

This module is exported for the cases where you want to inspect or control installation explicitly.

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

| Result                | Meaning                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------- |
| `'native'`            | The environment already provides all three methods (browser, Bun, Deno). Nothing was changed.                  |
| `'installed'`         | This call installed the polyfill.                                                                              |
| `'already-installed'` | A previous call, or another copy of Lifecycleion, installed it. The same backing target is reused.             |
| `'partial'`           | Some but not all of the methods are present and usable. Nothing was installed — see [Guarantees](#guarantees). |
| `'unsupported'`       | The methods are missing and there is no `EventTarget` constructor to back them with.                           |
| `'blocked'`           | The global object refused the definition (non-extensible, or a non-configurable property).                     |

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

- **Never overwrites.** If all three methods are already present — native or user-installed — the call is a no-op. Presence is judged independently of callability: a member holding a non-function value such as `globalThis.dispatchEvent = null` is somebody else's, so the call backs off with `'partial'` rather than clobbering it. The one exception is a member explicitly assigned `undefined`, which is how a global gets cleared and is indistinguishable from never having been set; that counts as absent.
- **Idempotent.** Repeated calls, repeated module initialization, and multiple copies of Lifecycleion share one backing target through `globalThis.__lifecycleion_global_event_target__`, so listeners registered earlier keep working. State lives on the global object in the same style as `dev-mode` and `process-signal-manager`.
- **Reports what was installed.** `isGlobalEventTargetPolyfilled()` describes the install, not what is callable at this instant: an application that replaces the global methods afterwards does not reset it.
- **No mixing.** If the environment has a partial or foreign surface (say, only `addEventListener`, a `dispatchEvent` that is not callable, or one defined as a throwing accessor), nothing is installed. Filling in the gaps from a fresh target would send dispatches somewhere the existing listeners are not; degrading quietly is safer than reporting into the void. Reporting is skipped in that case, and the helpers still return their normal results.
- **Never throws.** Installation runs during module initialization, so a throw would break the import of every dependent module. A non-extensible global (`Object.freeze(globalThis)` / `Object.preventExtensions(globalThis)`) or a non-configurable property is detected up front and returns `'blocked'`; if a definition is rejected anyway, anything already defined is rolled back so nothing is left half-installed. Probing is guarded too: reading a global runs its getter, and a getter that throws makes the member unreadable — and therefore unreplaceable — so the call returns `'partial'` and leaves the accessor alone.
- **Non-enumerable.** Installed properties are defined with `Object.defineProperty` and do not show up in `Object.keys(globalThis)`.
- **Bound.** Installed methods are bound to the backing target, so they work when destructured or passed around.
- **Browser and Bun behavior is unchanged.**
