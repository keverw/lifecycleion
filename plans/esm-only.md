# Plan: publish ESM only and drop the CommonJS build

Status: not started. Do it after PR #34 and PR #35 have merged, on a new branch from main (for example `feat-esm-only`). It is a breaking change, so it belongs in a minor release while the package is 0.x.

## Goal

The package ships one module format, ESM:

- `dist` has no `.cjs` or `.d.cts` files;
- every `exports` entry has `types` and `import` (or `default`), with no `require`;
- tsup builds with `splitting: true`, so internal modules shared by several entry points are built once, as shared chunks.

CommonJS consumers keep working through Node's `require()` of ESM.

## Why

- **One copy of each internal module.** tsup only splits shared code for ESM, and today it runs with `splitting: false`. So each of the 40 entry points bundles its own copy of every internal module it uses. Two entry points used together, such as `lifecycleion/http-client` and `lifecycleion/http-client-node`, each have their own module state. A module-level `WeakMap` or `Symbol()` shared between them never matches in the published package, while every repo test, which imports from `src`, passes. Review round 84 on PR #34 shipped exactly this bug, the source-wait registry, and found that the older built-in adapter registry had the same flaw. Both now use `Symbol.for` keys. With splitting, an internal module is one module again.
- **No dual-package hazard.** With both formats published, an app whose code `import`s the package while a dependency `require`s it loads two copies, the ESM build and the CJS build. Their classes and `instanceof` checks don't match each other.
- **Half the output.** `dist` is about 33 MB today, half of it the CJS copy and its `.d.cts` types. The build and the published tarball get smaller.
- **CommonJS still works.** `engines.node` is `>=25`, and Node has loaded ESM through `require()` without a flag since 22.12 and 20.19. A `require('lifecycleion/http-client')` keeps working as long as the module graph has no top-level `await`. The library has none today; the only `await import` calls are inside functions in test fixtures.

## What stays

- **The `Symbol.for` keys in `src/lib/http-client/consts.ts`.** Two installed versions of the package, for example a direct dependency and a nested one, still each have their own module state. The keys are what let a client from one version and an adapter from another recognise each other.
- **The separate-bundle tests,** such as `loadSeparatelyBundledNodeAdapter()` in `node-adapter.test.ts`. They cover the two-version case above, which splitting does not remove.

## Steps

1. **tsup.config.ts:** `format: ['esm']` and `splitting: true`. Check that chunk names are stable enough for source maps and that the `dts` output still gives one `.d.ts` per entry.
2. **package.json:**
   - Remove every `require` condition from `exports`.
   - Point `main` at `./dist/index.js`, or drop it.
   - Remove the `.cjs` paths from `sideEffects`. With splitting, also check whether a shared chunk now holds side-effectful code (the logger's or `safe-handle-callback`'s registration). If it does, list the chunk, or keep that code inside its entry.
3. **Top-level await guard:** add a test or a lint rule that refuses a top-level `await` in `src` outside test fixtures. One would break every `require()` consumer with `ERR_REQUIRE_ASYNC_MODULE`.
4. **Smoke test against the packed package,** not `src`:
   - `npm pack`, then install the tarball into a scratch project.
   - Under Node 25, check that `import` and `require()` both work for the root and a few subpaths (`http-client`, `http-client-node`, `logger`).
   - Check that `HTTPClient` from `lifecycleion/http-client` and `NodeAdapter` from `lifecycleion/http-client-node` share their internal modules: a byte body is not copied for the built-in adapter, and the slow-source retry scenario from round 84 passes.
   - This could become a CI job that builds, packs and runs the checks under `node`, next to the existing `global-event-target-node` job.
5. **Docs:**
   - README install section: the package is ESM; CommonJS loads it through `require()` on Node 22.12 or later.
   - Changelog: a **BREAKING:** bullet saying the CommonJS build is gone, how `require()` still works, and that a top-level `await` will never be added.
6. **Version:** bump the minor version.

## Things to check before deciding

- **TypeScript consumers** on `moduleResolution: "node"` (node10) can't read subpath `exports` today either, so dropping CJS changes nothing for them beyond the root entry. Those on `node16`/`nodenext` with a CommonJS project get the `.d.ts` types through `require()` of ESM from TypeScript 5.8 on. Check what earlier TypeScript versions report.
- **Jest** in CommonJS mode without an ESM transform can't load ESM. Decide whether to document a `transformIgnorePatterns` entry or leave it to users.
- **React Native:** Metro reads package `exports` by default from React Native 0.79. Check this with `plans/react-native-target.md`, since that plan's test app would also cover this change.
- **Bundlers** (Vite, esbuild, webpack 5, Rollup) handle ESM-only packages; nothing to do beyond the smoke test.
