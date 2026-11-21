# Plan: publish `isPlainRecord` next to `isPlainObject`

Status: not started. Do this after PR #35 has merged, on a new branch from main (for example `feat-is-plain-record`).

## Goal

Export `isPlainRecord` from `lifecycleion/is-plain-object`, alongside `isPlainObject`, so callers can use the stricter check too.

## Why

The two answer different questions, and both are useful:

- **`isPlainObject` (loose): "can I read named keys off this?"** It accepts any object that is not `null` or an array. This fits an options bag, where `options.timeout` reads the same from a class instance. Keep it as it is: tightening it would break that use for no gain, and `tmp-dir` and `retry-runner` rely on it.
- **`isPlainRecord` (strict): "are its own properties the data?"** It accepts only an object whose prototype is `null` or a root prototype. This fits code that enumerates entries with `Object.entries` or `Object.keys`. A `Map` or `Headers` keeps its contents off its own properties, so `Object.entries` answers `[]` for it, and the data would be silently dropped.

## Design

- **Move:** move `isPlainRecord` from `src/lib/http-client/internal/plain-record.ts` into `src/lib/is-plain-object.ts`, and export it.
  - Keep the cross-realm rule: a plain object from a `vm` context has a different realm's `Object.prototype`, whose own prototype is `null`.
  - Keep `assertOptionalHeaderRecord` where it is (it is HTTP-specific). Import `isPlainRecord` from the public module there and in `http-client.ts`.
- **Revoked Proxy:** decide whether to guard it. `Reflect.getPrototypeOf` on a revoked `Proxy` throws. `isPlainContainer` (`src/lib/internal/is-plain-container.ts`) catches that and answers `false`. A public type guard probably should not throw either, so match it.
- **No package changes:** the `./is-plain-object` entry point already exists in `package.json` and `tsup.config.ts`.

## Docs

In `docs/is-plain-object.md`:

- Add `isPlainRecord` to the TOC and the API section, with examples:
  - `{}`, `Object.create(null)` and an object from another realm are `true`.
  - `new Map()`, `new Headers()`, `new Date()`, a class instance and `[]` are `false`.
- Add a short "Which one to use" section: `isPlainObject` when reading known keys, `isPlainRecord` when iterating entries.

## Tests

There is no `is-plain-object.test.ts` yet. Add one that covers both functions:

- the cases above;
- a cross-realm object, using `vm.runInNewContext('({})')`;
- a revoked `Proxy`.

## Done when

- `changelog.md` has an entry under Unreleased (an addition, not a breaking change).
- `bun test`, `npx eslint src/lib` and `npx tsc --noEmit` are all clean.
- This plan file is deleted in the same PR that implements it.
