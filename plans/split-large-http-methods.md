# Plan: split NodeAdapter's and HTTPClient's largest methods

Status: not started. Do it after PR #34 and PR #35 have merged, on a new branch from main (for example `refactor-http-large-methods`). It changes no behaviour, so it needs no changelog entry beyond a line under internal changes, if any.

## What it is now

Three methods hold most of the HTTP client's control flow. Sizes are as of PR #34's head, with main's for comparison:

| Method                                | File                                                           | Main         | PR #34       |
| ------------------------------------- | -------------------------------------------------------------- | ------------ | ------------ |
| `NodeAdapter.send`                    | `src/lib/http-client/adapters/node-adapter.ts` (from line 516) | ~1,450 lines | ~2,640 lines |
| `HTTPClient._dispatchRequestAttempts` | `src/lib/http-client/http-client.ts` (from line 2529)          | ~1,170 lines | ~2,150 lines |
| `HTTPClient._execute`                 | `src/lib/http-client/http-client.ts` (from line 823)           | ~980 lines   | ~1,560 lines |

Each coordinates dozens of mutable flags captured by closures (`didReceiveResponse`, `isWritingBody`, `isAbandoned`, `didAdapterResolve`, `isStreamEndedFirst`, and more). Which combinations of them are valid is written down only in comments. The `catch` block of `_dispatchRequestAttempts` alone is about 600 lines of special cases whose order matters.

Review rounds on PR #34 flagged the size, the repeated sequences and the side channels several times. Each time they were left alone as too large for a review fix.

## Why

- **Easier to review.** A fix to how an upload settles today means reading the request setup, the stream wiring and the response read around it. A unit that owns one phase can be read, and tested, on its own.
- **State with an owner.** A flag written in one phase and read in another is where the ordering bugs of the review rounds came from. A class per phase holds its own flags, and what crosses between phases becomes an explicit field or argument.
- **Less captured scope.** Long-lived closures keep the whole enclosing scope alive for as long as a listener or timer holds them. A small class keeps only the fields it needs.

## Why it may not be worth it

- **Ordering is the behaviour.** Timers, abort listeners, stream events and the order promises settle in are what most of PR #34 fixed. Moving code between units can change when a listener is attached or removed without any test failing.
- **Hot paths.** Every request goes through these methods, so extra allocation per request (a class instance per phase) should be measured, not assumed free.
- **Bundle isolation.** The package builds with tsup and `splitting: false`, so a new internal module is copied into each entry point that uses it. State shared across entry points must keep using `Symbol.for` keys (see `plans/esm-only.md`).

## Approach, if done

1. **Map first.** For each method, list its phases with line ranges, every mutable variable the closures capture, which phases read and write each one, and the invariants the comments state. Confirm the split with the owner before moving code.
2. **NodeAdapter.send.** Split into units that own their state, roughly:
   - request setup and validation;
   - body writing and upload settling (the stall watchdog, `requestBodySettled`);
   - response reading and decoding (buffered and `streamResponse`);
   - teardown (abort, timeout, early answer).

   A listener or timer that outlives the response - the stall watchdog, the late
   socket-error absorbers, the source-wait grace - closes over the whole of `send` today,
   so while it stays registered it keeps the request snapshot and body bytes reachable.
   Each should take only the fields it needs.

3. **`_dispatchRequestAttempts`.** Turn the ordered special cases of its `catch` block into named handlers, tried in the same order - for example one function that reads the hidden markers and local flags once (`isFactoryCancel`, `isFactoryOwnAbort`, `isFlaggedAdapterFailure`, `didAdapterResolve`, `isAbandoned`, `didStartStream` and the rest) and returns a discriminated result (kind, answered response if any, retryable or not) the block switches on; adapters returning a tagged failure outcome instead of hidden markers is the larger design choice to weigh then - and move the retry decision (`Retry-After` included) into its own function. Retry scheduling is written twice, once for an answered attempt and once for a thrown one: each computes `nextRetryAt`, sets the tracker's three callbacks, emits `onAttemptEnd`, runs the retry-phase observers, waits out the rest of the delay and calls `settleUploadBeforeNextDispatch`. Make it one function both paths call, for example `scheduleRetry(delayMS, runObservers, uploadOutcome)`.
4. **`_execute`.** Pull out the redirect hop handling and the interceptor and observer phases. The redirect loop ends an unsent hop in about six places (`cancelledBeforeFollowing`, the sanitize failures before and after the interceptors, the interceptor failure, the unusable `Location`, the upload wait). Each builds its observer request, response, `undispatchedRedirect` and error code by hand, and all must agree that `requestURL` is the last `redirectHistory` entry and that a cross-origin URL loses its userinfo. Review fixes have had to patch these one at a time. One helper, for example `endUnsentHop({ request, requestURL, errorCode, cause })`, should own that rule.
5. **Shared result builders.** `http-client.ts` has about 15 `this._buildResponse({...})` calls and 20 `adapterResponse: null` literals, each repeating `requestID`, `wasCancelled`, `wasTimeout`, `adapterType`, `initialURL`, `requestURL` and `redirectHistory`, and the same attempt-result shape at every exit of `_execute` and `_dispatchRequestAttempts`. Add an `unsentResponse({ url, history, cancelled?, timeout?, undispatched? })` helper and an attempt-exit builder beside `emitAttemptEnd` and `endBeforeDispatch`, so a new response field is added in one place. In `_dispatchRequestAttempts`, the cut-stream answer is built twice (`endAsCutStream` and a near copy after it), differing only in where status and headers come from and in `isStreamed`: one builder taking `(status, headers, isStreamed)`, spreading `streamErrorAnswer()` (`internal/response-limit.ts`) for the answer's common fields rather than writing the literal out again.
6. **One interceptor-phase runner.** The initial, redirect and retry phases each repeat about 60 lines: run the chain, snapshot the result, `_assertRequestShapeIsSupported`, the URL check, `_copyChainResultBody`, `_assertRequestBodyFitsMethod`, then a catch that checks `cancelSignal.aborted` twice, makes a best-effort report and classifies the failure with `isBodyCopyFailure`. Make it one helper returning a discriminated result (`cancelled`; `failed` with code, cause and report; or `request`), with per-phase options for the redirect-only `Location` exemption and the retry-only held-to-hop case, so the cancel-versus-failure precedence and the `request_setup_error` / `interceptor_error` choice are written once.
7. **One abort-aware wait.** "Add a once abort listener, race it against a timer or a promise, remove the listener" is written out six times: `_cancellableDelay` and the cancel race in `settleUploadBeforeNextDispatch` (`http-client.ts`), `untilCancelled` (`interceptors.ts`), `awaitAbortable` and `sleepAbortable` (`mock-adapter.ts`), and `letGoOnAbort` (`fetch-adapter.ts`). They differ in whether the add and remove are guarded against a signal that throws, whether an already-aborted signal is checked first, and in what an abort does (`_cancellableDelay` resolves and clamps its delay; `sleepAbortable` rejects with the mock adapter's own error). Make one helper beside `internal/race-deadline.ts` for the timer and promise cases, with the guarded add and remove and the aborted check in one place, and per-site options for what an abort does. Pin each site's behaviour for a signal that throws on `addEventListener` or `removeEventListener` before moving it.
8. **Decide on the client-to-adapter side channels.** The client and the built-in adapters coordinate through `Symbol.for` hidden members read with `readUnknownMember`: `CLIENT_OWNED_BODY_KEY`, `REQUEST_BODY_SETTLED_KEY`, the `STREAM_FACTORY_*` flags, `EFFECTIVE_REQUEST_HEADERS_KEY` and others. Two behaviours, the uncopied-body mark and marking a stream as ended first on a timeout or stream failure, are gated on `isBuiltInNodeSend`, so a custom adapter or a `NodeAdapter` subclass that overrides `send` cannot opt in. Each new need adds a key and a special case in the attempt loop; an error that carried no effective headers on one cancel exit was one symptom. Weigh making these optional typed members of the `AdapterRequest` / `AdapterResponse` contract, so the client has one code path, against keeping them private to the built-ins. Record the decision either way.
9. **One step per commit**, smallest risk first. Each step keeps the full suite green on Node and Bun and changes no test, except where a test reached into a closure that no longer exists.

## Tests

The existing ~6,800 tests are the safety net, especially `adapters/node-adapter.test.ts`, `request-normalization.test.ts`, `retry-after.test.ts` and the HTTP integration tests. Run them on both runtimes after each step, since their stream timing differs. Add a test first for any ordering guarantee the map in step 1 finds that no test pins.
