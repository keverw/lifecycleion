# dev-mode

Runtime-settable dev/production mode flag with auto-detection from CLI args or `NODE_ENV`.

<!-- toc -->

- [Usage](#usage)
- [Overview](#overview)
- [Global key](#global-key)
- [API](#api)
  - [`initDevMode(param?)`](#initdevmodeparam)
    - [Signatures](#signatures)
    - [Detection strategies](#detection-strategies)
    - [Strict mode](#strict-mode)
    - [First-wins semantics](#first-wins-semantics)
  - [`getDevMode(): boolean`](#getdevmode-boolean)
  - [`overrideDevMode(value: boolean | 'redetect')`](#overridedevmodevalue-boolean--redetect)
- [HTML injection pattern](#html-injection-pattern)
- [Why not `import.meta.env.DEV`?](#why-not-importmetaenvdev)

<!-- tocstop -->

## Usage

```typescript
import {
  initDevMode,
  getDevMode,
  overrideDevMode,
} from 'lifecycleion/dev-mode';
```

## Overview

Provides a runtime-settable global (`globalThis.__lifecycleion_is_dev__`) for signaling development vs production mode. It is designed to:

- Work with **any** bundler or runtime (Node.js, Bun, Deno, browsers)
- Be **set once at startup** (first-wins semantics)
- Be **injected into HTML** so client-side code always matches the server
- Avoid reliance on build-time constants like `import.meta.env.DEV`

## Global key

```
globalThis.__lifecycleion_is_dev__
```

Type: `boolean | undefined`. When `undefined`, `getDevMode()` returns `false` (safe production default).

An internal companion key `globalThis.__lifecycleion_init_param__` stores the original `initDevMode()` parameter for `overrideDevMode('redetect')`.

## API

### `initDevMode(param?)`

Sets the global **once**. If the global is already a boolean, subsequent calls are no-ops (first-wins).

#### Signatures

```typescript
// Explicit value
initDevMode(true);
initDevMode(false);

// Auto-detect from CLI arguments
initDevMode({ detect: 'cmd' });
initDevMode({ detect: 'cmd', strict: true });

// Auto-detect from NODE_ENV
initDevMode({ detect: 'node_env' });

// Both (default): cmd takes precedence when explicit, otherwise NODE_ENV
initDevMode();
initDevMode({ detect: 'both' });
```

#### Detection strategies

| Strategy     | Logic                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------- |
| `'cmd'`      | `true` if `process.argv` contains `'dev'`, `false` if it contains `'prod'`, and `false` otherwise |
| `'node_env'` | `true` if `process.env.NODE_ENV === 'development'`                                                |
| `'both'`     | cmd takes precedence when an explicit word is present and otherwise falls back to NODE_ENV        |

#### Strict mode

When `strict: true` is used with `detect: 'cmd'`, an error is thrown if neither `'dev'` nor `'prod'` is found in `process.argv`. This forces callers to be explicit about their intent.

```typescript
// Throws if argv doesn't contain "dev" or "prod"
initDevMode({ detect: 'cmd', strict: true });
```

#### First-wins semantics

```typescript
initDevMode(true);
initDevMode(false); // no-op — value stays true
```

This is critical for HTML injection: the server injects a `<script>` tag that sets the global before any module code runs. When client-side code calls `initDevMode()`, it's a no-op because the server-injected value already won.

### `getDevMode(): boolean`

Reads `globalThis.__lifecycleion_is_dev__`. Returns `false` if not yet initialized. Never throws.

```typescript
const isDev = getDevMode(); // false if not initialized
```

Safe to call anywhere - server, client, tests, libraries. No side effects.

### `overrideDevMode(value: boolean | 'redetect')`

Bypasses first-wins semantics. Always sets the global, even if already initialized.

```typescript
overrideDevMode(true); // force dev mode
overrideDevMode(false); // force production mode
overrideDevMode('redetect'); // clear and re-run detection with original args
```

Use cases:

- **Tests**: Override dev mode per-test without process restart
- **SPA debugging**: Force dev mode in a production build
- **Tools**: Override what HTML injection set

## HTML injection pattern

Frameworks (like unirend) inject a synchronous inline script into rendered HTML:

```html
<script>
  globalThis.__lifecycleion_is_dev__ = false;
</script>
```

This script:

- Runs **before** any `<script type="module">` (ES modules are deferred by spec)
- Ensures the global is set before any application code calls `getDevMode()`
- Makes client-side `initDevMode()` calls no-ops (first-wins)

## Why not `import.meta.env.DEV`?

`import.meta.env.DEV` is **statically replaced at build/transform time** by Vite's plugin system. It cannot be overridden at runtime. Additionally:

- It is `true` during Vite's SSR dev server (code is not built)
- It is `false` after a production build
- The same source file produces different values depending on execution context

`__lifecycleion_is_dev__` is runtime-settable, works across module boundaries, and is bundler-agnostic.

Users who want Vite's build-time value can pass it explicitly:

```typescript
initDevMode(import.meta.env.DEV);
```
