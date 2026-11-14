# Plan: one helper for non-retryable adapter refusals, and one exact-origin matcher

Status: not started. Both came from the PR #34 review rounds as simplification findings, left out of that PR to keep its diff to fixes. Do them on a new branch from main after PR #34 merges, one commit each. Neither changes behavior, so no changelog line is needed.

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
