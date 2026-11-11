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

Review rounds on PR #34 flagged the size twice. Both times it was left alone as too large for a review fix.

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
3. **`_dispatchRequestAttempts`.** Turn the ordered special cases of its `catch` block into named handlers, tried in the same order, and move the retry decision (`Retry-After` included) into its own function. Retry scheduling is written twice, once for an answered attempt and once for a thrown one: each computes `nextRetryAt`, sets the tracker's three callbacks, emits `onAttemptEnd`, runs the retry-phase observers, waits out the rest of the delay and calls `settleUploadBeforeNextDispatch`. Make it one function both paths call, for example `scheduleRetry(delayMS, runObservers, uploadOutcome)`.
4. **`_execute`.** Pull out the redirect hop handling and the interceptor and observer phases. The redirect loop ends an unsent hop in about six places (`cancelledBeforeFollowing`, the sanitize failures before and after the interceptors, the interceptor failure, the unusable `Location`, the upload wait). Each builds its observer request, response, `undispatchedRedirect` and error code by hand, and all must agree that `requestURL` is the last `redirectHistory` entry and that a cross-origin URL loses its userinfo. Review fixes have had to patch these one at a time. One helper, for example `endUnsentHop({ request, requestURL, errorCode, cause })`, should own that rule.
5. **One step per commit**, smallest risk first. Each step keeps the full suite green on Node and Bun and changes no test, except where a test reached into a closure that no longer exists.

## Tests

The existing ~6,800 tests are the safety net, especially `adapters/node-adapter.test.ts`, `request-normalization.test.ts`, `retry-after.test.ts` and the HTTP integration tests. Run them on both runtimes after each step, since their stream timing differs. Add a test first for any ordering guarantee the map in step 1 finds that no test pins.
