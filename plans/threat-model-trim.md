# Plan: drop the guards against a replaced or polyfilled environment

Status: not started. Do it on a new branch from main after PR #34 and PR #35 have merged
(for example `refactor-threat-model-trim`), one commit per section below.

## Why

The README's threat model defends values a caller hands the library - options, bodies,
headers, signals, callbacks, adapter results - and leaves the environment to the runtime:
a global replaced or patched, or a polyfill installed as one, is not defended against.
Several code paths still guard that environment. Node 25+, Bun, browsers and React Native
all ship the globals these paths second-guess, so a polyfilled `fetch` (node-fetch,
cross-fetch) or a misbehaving `globalThis` property can only come from replacing a global.

These paths cost about 400 lines, and they are where the PR #34 review rounds kept finding
edge cases: the surrogate pair split across text chunks, the abort wake for a stalled
`next()`, the iterator `return()` that never settles. Each fix added more of the same.

## 1. FetchAdapter: read only the runtime's own `Response`

`src/lib/http-client/adapters/fetch-adapter.ts`:

- **Polyfill stream bodies.** `readBodyWithin` reads an async-iterable body (a node-fetch
  `Readable`) besides a web stream, with text chunks encoded as UTF-8 and `heldUnit`
  holding a surrogate half across chunks (`isTextChunkAccepted`). Read `response.body`
  through its reader only; a body that is not a `ReadableStream` is read with
  `arrayBuffer()` and measured after, or refused - decide which when doing it.
- **Abort machinery.** `letGoOnAbort`, `wakeOnAbort`, `ABORTED_READ`, the hand-driven
  iterator loop and `endIteratorQuietly` exist because "a polyfill's stream need not heed
  the signal" and "a polyfill's iterator may never settle" `return()`. The runtime's
  `fetch` errors its stream on abort, so a plain read loop over the reader does. Keep the
  cancel on the size limit.
- **Guarded `Response` reads.** `readUnknownMember` on `type`, `status`, `headers`,
  `body`, `getReader` and `Symbol.asyncIterator` handle "a polyfill's or test double's
  response" with throwing getters. The `Response` comes from the global `fetch`, never the
  caller: read them plainly.
- **No `Request` or `Headers`.** The branches for "a test setup that polyfills only
  `fetch`" (around the request build and `extractFetchHeaders`) guard a runtime that does
  not exist.
- `cancelBodyQuietly`'s `destroy()` fallback for a Node `Readable`.

Keep: the handling of a caller's signal from another realm or jsdom (`isSignalRefusal`,
`_composeSignals`), Bun's method rewrite, the blocked-port and forbidden-header refusals.

## 2. XHRAdapter: only what React Native's XHR needs

`src/lib/http-client/adapters/xhr-adapter.ts`: `readResponseBody`'s realm-agnostic and
string fallbacks for "a test shim's XHR" and the `xmlhttprequest` npm package,
`abortQuietly`'s cover for a shim's `abort()` that fires no event, the re-entrancy guards
for "a shim" firing events from `load`, a shim's `lengthComputable` with a total of 0, and
a shim `location` with no origin, and the owed abort (`isInsideSend`, `isAbortOwed`,
`readyStateQuietly`) that makes again, once `send()` returns, an `abort()` a shim ignored
inside it. Check each against React Native's XHR first; some of the re-entrancy guards
may also keep event ordering safe, and those stay.

## 3. `shared-slot.ts`: share the state, stop repairing it

`src/lib/internal/shared-slot.ts` (269 lines; used by `report-to-console.ts` and
`report-to-host.ts`). Keep the purpose: bundled copies of the library in one realm share
one state under a `Symbol.for` key (see the bundle-isolation tests). Drop the repair:
reading the slot through descriptors only, re-validating it, replacing a `Proxy`, an
accessor or a state that ignores writes, and the refusal fallback for a non-extensible
global. The slot is written only by the library's own copies; anything else there is
tampering. What is left is a few lines: read the key, create the state if absent.

## 4. Small guards (optional, low value)

Each is a few lines; take them in the same pass if they are in the way, else leave them.

- `internal/report-to-host.ts`: throwing global accessors, an `ErrorEvent` that throws, a
  `dispatchEvent` that throws.
- `http-client/internal/concat-chunks.ts`: re-measuring chunks and `CHANGED_LENGTH_MESSAGE`.
  Chunks come from the runtime's streams. Keep `isWholeOfPlainBuffer`: Node's pooled
  `Buffer` slices are real.
- `internal/graphemes.ts`: retiring a "replaced Segmenter". Keep the `typeof` check.
- `internal/dom-exception.ts`: the try/catch and shape checks. Keep the absence check.
- `internal/binary-view.ts`: the branches for a host missing an intrinsic getter. Keep the
  `SharedArrayBuffer` absence check and the intrinsic reads of caller values.
- `http-client/internal/request-body-copy.ts`: the try/catch around a polyfill's `equals`.
- `http-client/utils.ts` `findBrowserPage`: the order of `window`, `globalThis`, `self`.
- `internal/report-to-console.ts`: a replaced `console`. Borderline: a test setup patching
  `console.error` to throw is common, and the try/catch is cheap. Keep it.

## Tests

Many FetchAdapter tests fake `globalThis.fetch` with a plain object rather than a
`Response`. Rewrite those to return a real `Response` over a `ReadableStream`, and delete
the ones that test only polyfill behaviour (text chunks, an iterator that never settles,
throwing `Response` getters).

## Changelog

Section 1 changes behaviour for a polyfilled `fetch` installed as the global, which
`docs/http-client.md` describes today: say what such a `fetch` now gets, and drop the
polyfill wording from the docs. Sections 2-4 change nothing a supported runtime sees: a
line under internal changes, if any.
