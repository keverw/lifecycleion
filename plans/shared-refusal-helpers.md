# Plan: one helper for non-retryable adapter refusals, one exact-origin matcher, and one refusal order

Status: not started. All three came from the PR #34 review rounds as simplification findings, left out of that PR to keep its diff to fixes. Do them on a new branch from main after PR #34 merges, one commit each. None changes behavior, so no changelog line is needed.

## 1. One helper for "build an error, mark it non-retryable, throw"

- **Where:** about 21 sites. `fetch-adapter.ts` (the forbidden-method, GET/HEAD-body, rewritten-method and blocked-port refusals), `xhr-adapter.ts` (the TRACE/TRACK and GET/HEAD-body refusals), `mock-adapter.ts`, `internal/multipart.ts`, and `connectRefusal` / `unsendableBodyError` in `internal/adapter-error.ts`. NodeAdapter already has its own `optionRefusal()` for the same job.
- **Problem:** each site constructs an `Error` or `TypeError`, calls `markNonRetryableAdapterError` and throws. A new refusal that forgets the mark is retried as a transport failure, to no end.
- **Fix:** export `nonRetryableRefusal(message, ErrorType = TypeError)` from `internal/adapter-error.ts` and use it at every site, keeping each site's current error class (some are `Error`, some `TypeError`; tests and callers may check `instanceof TypeError`). Make `optionRefusal` call it.
- **Tests:** none new; the existing refusal tests check the flag. Grep afterwards that no `markNonRetryableAdapterError(` call is left beside a `new Error`/`new TypeError` in the adapters.

## 2. One exact-origin entry matcher for the CORS lists

- **Where:** `src/lib/domain-utils/domain-utils.ts`: `matchesCORSCredentialsList` (around line 2109) repeats the exact-entry branch of `matchesOriginList` (around 2029-2059): the `null` entry, the bare-domain entry, and the parsed-origin entry with its `isOpaqueHost` guard.
- **Problem:** PR #34 changed both copies in lockstep. The credentials matcher is the security-sensitive one, so a later fix made to one copy only would make the two disagree on which origins match.
- **Fix:** extract `matchesExactOriginEntry(parsedOrigin, allowed)` and call it from both; only the wildcard handling stays different.
- **Tests:** run both functions' existing tests; add one table test that feeds the same exact entries to both and expects the same answers.

## 3. One ordered refusal sequence for the adapters

- **Where:** `FetchAdapter.send` (`fetch-adapter.ts`, from the blocked-port check), `XHRAdapter.send` (`xhr-adapter.ts`, near the top of `send`) and `NodeAdapter.send` (`node-adapter.ts`, before the request is built). Each refuses a request in its own hand-written sequence: the URL (and for `FetchAdapter` a port the Fetch Standard blocks), the body type, a header refused by name, then the method and a `GET`/`HEAD` body.
- **Problem:** `docs/http-client.md` (the paragraph listing that order, in the request refusals section) states the order as a contract, but each adapter writes it out separately. Adding or reordering a refusal means editing three places in step; a miss changes which error a request with two faults reports, on one adapter only.
- **Fix:** one helper under `src/lib/http-client/internal/` that runs the checks in the documented order and throws the first refusal, given the adapter's name and which checks apply. The differences stay as parameters, not as separate sequences: `XHRAdapter` refuses no header by name, only `FetchAdapter` checks blocked ports, and each adapter keeps its own body-type and method rules. Check first that the parameters stay fewer than the lines they replace; if each adapter needs its own switch for most steps, leave the sequences as they are.
- **Tests:** the existing per-adapter refusal tests. Add one table test that sends the same request with two faults to each adapter and expects the refusal the docs name first.
