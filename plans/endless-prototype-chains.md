# Plan: bound the prototype walks a caller's value can make endless

Status: optional, not scheduled. Do it on its own branch from main, after PR #34 and PR #35 have merged.

## What it is now

A `Proxy` whose `getPrototypeOf` trap answers a new `Proxy` every time has a prototype chain that never ends. Every walk up it runs for ever, including the engine's own `instanceof`, which reads the chain until it finds the prototype or reaches `null`.

PR #34 caps the walks it wrote itself at `MAX_PROTOTYPE_DEPTH` (64, in `src/lib/internal/prototype-depth.ts`): an interceptor or observer filter's fields (`callback-registry.ts`, refused with a `TypeError`), the byte checks in `binary-view.ts` (answered no) and `indexFreePrototype` in `array-indices.ts` (answered no).

`deepClone` is not capped. A review of PR #34 confirmed that `deepClone({ a: endless })` never returns. It has:

- 23 `instanceof` checks in `src/lib/deep-clone.ts`, across `cloneValue`, `cloneBuiltIn`, `cloneBoxedPrimitive` and `isError`;
- an unbounded `while (prototype !== null)` loop in `foreignBuiltInType`.

`deepClone` is a public export of its own (`lifecycleion/deep-clone`). Nothing else in the library calls it.

## The risk

The thread hangs, so a server stops answering. It needs a caller that hands over such a value, by mistake or on purpose. A proxy wrapper or membrane library could plausibly produce one.

## Scope to decide

- **`deepClone` only**, or every place a caller's value meets `instanceof`. `instanceof` also appears in `logger/index.ts` (13), `to-error.ts` (12), `lifecycle-manager.ts` (10), `error-to-string.ts`, `serialize-error` and others. List which of them take a caller's value, rather than one of the library's own.
- **What a too-deep chain means.** Either it fails with a `RangeError`, as the filter does, or it is treated as a plain object, as the byte checks answer no. For `deepClone`, failing is probably right: a silent plain-object clone of something it could not read would hide the problem.

## Design

- Add `isInChain(value, prototype)` to `prototype-depth.ts`: a bounded `instanceof` that walks at most `MAX_PROTOTYPE_DEPTH` prototypes with `Reflect.getPrototypeOf` and then throws (or answers no). It should keep `instanceof`'s other behavior: a non-object answers false, and a throwing trap propagates.
- `instanceof` also consults `Symbol.hasInstance`. Only use the helper where the right-hand side is a built-in constructor, whose `hasInstance` is the default one.
- Cap `foreignBuiltInType`'s loop the same way.
- An ESLint `no-restricted-syntax` rule on `BinaryExpression[operator='instanceof']` in the files that read caller values, as the ASCII-text rules already do, so a new `instanceof` doesn't reopen the hang.

## Steps

1. Decide the scope above, and record the list of affected sites in this plan.
2. Add the helper and its tests: an endless chain throws or answers no within 64 reads, a chain 64 deep still matches, and a throwing trap propagates.
3. Replace the `instanceof` checks in `deep-clone.ts`, and cap `foreignBuiltInType`.
4. Tests in `deep-clone.test.ts`: `deepClone({ a: endless })` fails with a `RangeError` (or as decided) rather than hanging. The test's trap should throw after 10,000 reads, so a regression fails the test instead of hanging the run.
5. Repeat for each other site in scope.
6. Changelog bullet, and a line in `deepClone`'s docs.
