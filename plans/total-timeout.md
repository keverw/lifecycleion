# Plan: a total deadline for a request, retries included

Status: not started. A new feature, not a fix. Do it after PR #34 and PR #35 have merged, on a new branch from main (for example `feat-http-total-timeout`).

## What it is now

`timeout` (default 30 seconds) is per attempt: each attempt gets its own timer, and the waits between attempts - the policy's backoff and any `Retry-After` - are not counted against it. A request with `timeout: 5_000` and three retries can take far longer than 5 seconds.

The only way to bound a whole request today is a signal:

```typescript
await client.get('/report').signal(AbortSignal.timeout(10_000)).send();
```

That works, but it ends the request as a cancel (`isCancelled: true`), not a timeout. It also gives no warning ahead: a `Retry-After: 8` with 2 seconds left is waited on until the signal fires mid-wait, and the request ends as cancelled with nothing to show for the wait.

## Goal

A request option, and a client default, for the most the whole request may take: every attempt, redirect hop, backoff and `Retry-After` wait.

```typescript
const client = new HTTPClient({
  timeout: 5_000, // each attempt
  totalTimeout: 20_000, // the whole request, retries included
});
```

## Behaviour to decide

- **A retry that cannot fit ends early.** When the next retry's delay (the policy's, or a `Retry-After`) would end past the deadline, the client does not wait: it returns the answer it has, or fails with the attempt's error, as `retry_after_too_long` does now. `onAttemptEnd` reports `willRetry: false` with a new `retrySuppressedReason`, such as `'deadline_exceeded'`.
- **An attempt still running at the deadline is aborted as a timeout.** Its own timer is the earlier of `timeout` and what is left of the total, so the error says timeout (`isTimeout: true`), not cancel.
- **Should a retry need a minimum time left?** For example, not starting an attempt with 50 ms to go. Probably not: the attempt's timer already bounds it.
- **Name.** `totalTimeout`, `deadline`, or `overallTimeout`. It sits beside `timeout`, so the docs must say plainly which is which. Renaming `timeout` to `attemptTimeout` would be clearer, but it is breaking.
- **Sub-clients** inherit it as they inherit `timeout`.
- **Default.** None (unbounded, as now), so nothing changes for existing callers.

## Why two timeouts may confuse

Users will read `timeout` as the whole request. The docs should lead with a small table: `timeout` (one attempt), `totalTimeout` (everything), `maxRetryAfterMS` (one server-requested wait), and a signal (a cancel from outside). The Retry-After table in `docs/http-client.md` would gain a row: past the total deadline, stop.

## Where it goes

- The deadline is fixed when `send()` starts, on the monotonic clock (`performance.now()`), as the retry delay already is.
- `_dispatchRequestAttempts` in `src/lib/http-client/http-client.ts` makes the retry decision. The "cannot fit" check goes beside `isRetryAfterTooLong`, against the final `delayMS`.
- The per-attempt timer is set where `timeout` is resolved for each attempt.
- Redirect hops share the deadline, as they share the retry budget.

## Tests

- A retry whose delay would pass the deadline is not made, and the answer is returned with the new reason.
- An attempt running at the deadline times out, as a timeout.
- `Retry-After` within the time left is still waited on.
- Redirect hops and retries together stay within the deadline.
- No `totalTimeout`: behaviour as now.
