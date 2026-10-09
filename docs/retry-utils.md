# retry-utils

Simple utilities to handle retry logic with two main classes:

- **`RetryPolicy`** - Low-level class for fine-grained control over retry behavior
- **`RetryRunner`** - High-level class that executes your code with automatic retries

<!-- toc -->

- [Usage](#usage)
- [Terminology](#terminology)
- [Retry Policy Options](#retry-policy-options)
  - [Fixed Strategy](#fixed-strategy)
  - [Exponential Strategy](#exponential-strategy)
- [RetryPolicy](#retrypolicy)
  - [Constructor](#constructor)
  - [Methods](#methods)
    - [`shouldDoFirstTry()`](#shoulddofirsttry)
    - [`shouldRetry(error?, isQueryOnly?)`](#shouldretryerror-isqueryonly)
    - [`markAsSuccessful()`](#markassuccessful)
    - [`reportError(error)`](#reporterrorerror)
    - [`reset()`](#reset)
  - [Properties](#properties)
  - [Example](#example)
- [RetryRunner](#retryrunner)
  - [Constructor](#constructor-1)
  - [Runner States](#runner-states)
  - [reportResult Function](#reportresult-function)
  - [Properties](#properties-1)
  - [Methods](#methods-1)
    - [`run(shouldWaitForCompletion?: boolean)`](#runshouldwaitforcompletion-boolean)
    - [`waitForCompletion()`](#waitforcompletion)
    - [`cancel()`](#cancel)
    - [`reset()`](#reset-1)
    - [`resume(shouldWaitForCompletion?: boolean)`](#resumeshouldwaitforcompletion-boolean)
    - [`forceTry(options?)`](#forcetryoptions)
    - [`overrideGraceCancelPeriodMS(ms)`](#overridegracecancelperiodmsms)
  - [Events](#events)
  - [Custom Types](#custom-types)
  - [Complete Example](#complete-example)
- [Error Classes](#error-classes)
- [Exported Types](#exported-types)

<!-- tocstop -->

## Usage

```typescript
import {
  RetryPolicy,
  RetryRunner,
  OPERATION_STARTED,
  OPERATION_ENDED,
  ATTEMPT_STARTED,
  ATTEMPT_HANDLED,
} from 'lifecycleion/retry-utils';
```

## Terminology

- **Attempt** - Any execution of the operation, including the initial try
- **Retry** - A subsequent attempt after the initial attempt fails
- **Retry count** - Number of retries (excludes the initial attempt)
- **Attempts** - Total executions (initial attempt + retries)

Example: If the operation fails initially and retries twice, `attempts = 3` and `retryCount = 2`.

Rule of thumb: once the initial attempt has started, `retryCount = max(attempts - 1, 0)`.

## Retry Policy Options

### Fixed Strategy

Retries a fixed number of times with a fixed delay between attempts.

```typescript
{
  strategy: 'fixed';
  maxRetryAttempts?: number; // Max retries allowed (excludes initial attempt). Default: 10, Min: 1 (0 still allows one retry), floored to integer; NaN or non-number throws
  delayMS?: number | null; // Delay between retries. Default (omitted or null): 1000ms. 0 becomes 1ms; Infinity uses the timer ceiling; negative, NaN or non-number throws
}
```

### Exponential Strategy

Uses exponential backoff with jitter to calculate delays between retry attempts.

```typescript
{
  strategy: 'exponential';
  maxRetryAttempts?: number; // Max retries allowed (excludes initial attempt). Default: 10, Min: 1 (0 still allows one retry), floored to integer; NaN or non-number throws
  factor?: number; // Multiplier for exponential growth. Default: 1.5, Min: 1; NaN or non-number throws
  minTimeoutMS?: number | null; // Shortest delay between retries. Default (omitted or null): 1000ms. 0 becomes 1ms; Infinity uses the timer ceiling; negative, NaN or non-number throws
  maxTimeoutMS?: number | null; // Longest delay between retries. Default (omitted or null): 30000ms. 0 becomes 1ms; Infinity uses the timer ceiling; negative, NaN or non-number throws
  dispersion?: number; // Randomness added to delays (0 to 1 inclusive, e.g. 0.1 = 10%). Default: 0.1, clamped to [0, 1]; NaN or non-number throws
}
```

The `dispersion` property adds randomness to prevent all retries from happening at the same time (thundering herd problem). Specifically, the computed delay is adjusted by a random amount in the range `±(delay × dispersion)`, then clamped to `[minTimeoutMS, maxTimeoutMS]`. For example, a dispersion of `0.1` on a 2000ms delay produces a final delay between 1800ms and 2200ms (before clamping).

**Dispersion formula:**

```typescript
randomOffset = (Math.random() * 2 - 1) * (delay * dispersion);
finalDelay = clamp(delay + randomOffset, minTimeoutMS, maxTimeoutMS);
```

> Retry durations use their defaults when omitted, `null`, or `undefined`. Explicit `NaN` or
> non-number `delayMS`, `minTimeoutMS`, or `maxTimeoutMS` values throw `TypeError` at
> construction, and negative ones throw `RangeError` - they are not clamped. Zero keeps the
> existing 1 ms minimum; positive `Infinity` selects the timer ceiling.
> `maxRetryAttempts`, `factor` and `dispersion` also throw `TypeError` for an explicit
> `NaN` or non-number value (no coercion: `'3'` throws too, and so does `null`); only
> omitted or `undefined` uses the default. Past that check `maxRetryAttempts` and
> `factor` are each clamped to a minimum of `1` and accept `Infinity`, so
> `maxRetryAttempts: 0` (or a negative count) still allows one retry - there is no
> "no retries" value; skip the retry utilities for that. `maxRetryAttempts` is
> additionally floored to an integer after clamping. `dispersion` is clamped to
> `[0, 1]`, so `-Infinity` reads as `0` and `Infinity` as `1`. If
> `maxTimeoutMS < minTimeoutMS`, the values are swapped.

> **Delays are capped at 2,147,483,647 ms (about 24.8 days).** `delayMS`, `minTimeoutMS` and `maxTimeoutMS` are each bounded there, and so is every delay computed from them. `setTimeout` keeps its delay in a signed 32-bit integer and reads anything larger as `1` ms, so an uncapped `delayMS: 3e9` would read as "wait 34 days" and retry roughly every millisecond instead. `maxRetryAttempts` is not a duration and `Infinity` remains a supported value there.

## RetryPolicy

The `RetryPolicy` class provides low-level control over retry behavior. It tracks retry attempts, calculates delays, and decides whether to retry - but doesn't execute anything itself.

### Constructor

```typescript
new RetryPolicy(options: RetryPolicyOptions)
```

Throws `RetryUtilsErrPolicyConfigInvalidStrategy` for an invalid strategy, and
`TypeError` or `RangeError` for invalid explicit retry durations.

### Methods

#### `shouldDoFirstTry()`

Checks if the initial operation should proceed. Returns `true` on the first call, `false` on subsequent calls (until `reset()` is called).

```typescript
if (policy.shouldDoFirstTry()) {
  // Execute the initial operation
}
```

#### `shouldRetry(error?, isQueryOnly?)`

Decides if a retry should happen based on the error and policy. Records the error unless `isQueryOnly` is `true`.

When `isQueryOnly` is `true`, the `error` parameter can be omitted - no error is recorded and the method purely queries whether a retry is available.

> **Note:** Errors are recorded even after `markAsSuccessful()` has been called (unless `isQueryOnly` is `true`). In that case, `shouldRetry` will still return `false`, but the error will be tracked in the `errors` array.
>
> **Important:** Because `attempts` and `retryCount` are derived from the error list, calling `shouldRetry()` after `markAsSuccessful()` will increase those counts even though no retry will occur.

Returns `{ shouldRetry: boolean, delayMS: number }`.

```typescript
const { shouldRetry, delayMS } = policy.shouldRetry(error);

if (shouldRetry) {
  // Wait for delayMS before the next retry
}

// Query-only: just check without recording anything
const { shouldRetry: canRetry } = policy.shouldRetry(undefined, true);
```

#### `markAsSuccessful()`

Marks the operation as successful. After this, `shouldRetry()` will always return `{ shouldRetry: false }`.

#### `reportError(error)`

Records an error without checking retry eligibility. Useful when you want to track errors separately from the retry decision.

#### `reset()`

Resets the policy to its initial state, clearing all errors and attempt tracking.

### Properties

| Property                 | Type                   | Description                                                                                                  |
| ------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| `policyInfo`             | `RetryPolicyValidated` | A fresh snapshot of the validated policy settings                                                            |
| `attempts`               | `number`               | Total attempts made (initial + retries)                                                                      |
| `retryCount`             | `number`               | Number of retries (excluding initial attempt)                                                                |
| `maxRetryAttempts`       | `number`               | Maximum retry attempts allowed                                                                               |
| `areAttemptsExhausted`   | `boolean`              | Whether max attempts have been reached                                                                       |
| `wasInitialAttemptTaken` | `boolean`              | Whether the initial attempt has been made                                                                    |
| `wasSuccessful`          | `boolean`              | Whether the operation was marked successful                                                                  |
| `errors`                 | `unknown[]`            | Array of errors encountered                                                                                  |
| `mostCommonError`        | `unknown`              | Most frequent error (grouped by reference equality and message string), or `null` if no errors have occurred |
| `lastError`              | `unknown`              | Most recent error, or `null` if no errors have been recorded                                                 |

> **Note:** `mostCommonError` uses two strategies to determine frequency - reference equality (`===`) and message-string grouping - and returns whichever finds the highest count. Reference equality catches reused error objects (including those with unstable or dynamic messages). Message grouping uses the `.message` property for `Error` instances and objects, nested `.error.message` for wrapped errors, or `String()` conversion as a fallback, so distinct objects with the same message are counted together. The first instance encountered for the winning group is returned. In case of ties across strategies, the first error encountered with the maximum count is returned.

### Example

```typescript
const policy = new RetryPolicy({
  strategy: 'fixed',
  maxRetryAttempts: 3,
  delayMS: 1000,
});

if (policy.shouldDoFirstTry()) {
  try {
    await doSomething();
    policy.markAsSuccessful();
  } catch (error) {
    const result = policy.shouldRetry(error);
    if (result.shouldRetry) {
      // Schedule the next attempt after result.delayMS
    } else {
      // All attempts exhausted
    }
  }
}
```

## RetryRunner

The `RetryRunner` class is a high-level abstraction that automatically executes your code with retries. It uses `RetryPolicy` under the hood and emits events at each stage.

### Constructor

```typescript
new RetryRunner<T>(
  policy: RetryPolicyOptions,
  operation: (reportResult: ReportResult<T>, signal: AbortSignal) => void | Promise<void>,
  options?: {
    operationLabel?: string;
    onOperationStarted?: (info: OnOperationStartedInfo) => void;
    onOperationEnded?: (info: OnOperationEndedInfo) => void;
    onAttemptStarted?: (info: OnAttemptStartedInfo) => void;
    onAttemptHandled?: (info: OnAttemptHandledInfo<T>) => void;
  }
)
```

> **Note:** The `operation` function can be synchronous or asynchronous (returning `void` or `Promise<void>`). Both are fully supported.

### Runner States

The `runnerState` property reflects the current lifecycle state:

| State           | Description                                                  |
| --------------- | ------------------------------------------------------------ |
| `'not-started'` | Runner has not been started                                  |
| `'running'`     | Operation is running or retrying                             |
| `'stopping'`    | Cancel requested, waiting for current attempt to acknowledge |
| `'stopped'`     | Successfully canceled                                        |
| `'completed'`   | Operation succeeded                                          |
| `'exhausted'`   | All retry attempts used                                      |
| `'fatal-error'` | Operation reported a fatal error                             |

### reportResult Function

Your operation receives a `reportResult` function to report the outcome of each attempt:

```typescript
type ReportResult<T> = {
  (status: 'success', value?: T): void;
  (status: 'skip', value?: T): void;
  (status: 'error', value?: unknown): void;
  (status: 'fatal', value?: unknown): void;
};
```

**Statuses:**

- **`'success'`** - Attempt succeeded. `value` is returned as `data` in the result.
- **`'error'`** - Retriable failure. `value` is recorded as an `error` and a retry is scheduled if within policy.
- **`'fatal'`** - Non-retriable failure. `value` is recorded as an `error`. No retry.
- **`'skip'`** - Skip this attempt (e.g., when device knows it's offline for sure). Does not count against the retry budget, and does not increment `attempts` or `retryCount`. The `value` is available as `data` in the `attempt-handled` event payload. A retry is still scheduled using the policy delay, but since the skip does not advance the error count, the delay is the same as it would have been before the skip (i.e., exponential backoff does not advance). However, if prior `'error'` results have already exhausted the retry budget, a `'skip'` will still result in `'exhausted'` because the policy's retry count has already reached its limit.
  - **Note:** After the very first skip, `attempts` will be `1` because the initial attempt is considered taken as soon as the operation starts, even if it was skipped. Subsequent skips do not increase `attempts` or `retryCount`.

> An unrecognized runtime status ends the attempt as a fatal `TypeError`, with the reported value (when there is one) on its `cause`; it never schedules a retry.

> **CRITICAL:** `reportResult` **MUST** be called exactly once per attempt. If your operation completes without calling `reportResult` and without throwing an error, the attempt will hang indefinitely (it will wait forever, blocking any retry logic). The only exception is throwing an error, which is automatically treated as `reportResult('error', thrownError)`. A genuine second or late call is ignored by the runner and reported on the global `'error'` channel. An aborted attempt may still acknowledge cancellation with `reportResult('skip', ...)` without producing that report.

> **Important:** When `cancel()` is called, the operation receives an abort signal via the `signal` parameter. If the operation doesn't call `reportResult` within the `graceCancelPeriodMS` (default 1000ms, configurable via `overrideGraceCancelPeriodMS()`), the cancellation is forced. Always check `signal.aborted` in long-running operations to respond to cancellation requests.
>
> **Note:** If cancellation is forced, the runner will emit `attempt-handled` with a `'skip'` status and `wasCanceled: true` for the in-flight attempt before emitting `operation-ended`.
>
> **Abort listeners:** Listeners the operation adds to `signal` - with `addEventListener('abort', ...)` (a function or a `handleEvent` object) or `onabort` - run inside `cancel()` and `forceTry({ shouldAbortRunning: true })`. One that throws, or an `async` one that rejects, is reported on the global `'error'` channel as `Error in a callback RetryRunner operation abort listener`, with the thrown value on `cause`; the listeners after it still run, and the abort proceeds.

```typescript
const operation = async (reportResult, signal) => {
  try {
    const result = await doSomething();
    reportResult('success', result);
  } catch (error) {
    if (signal.aborted) {
      reportResult('skip', 'Operation canceled');
    } else if (isFatalError(error)) {
      reportResult('fatal', error);
    } else {
      reportResult('error', error);
    }
  }
};
```

> **Tip:** When `signal.aborted` is true and you acknowledge it, report `'skip'` rather than `'error'`. What happens to the report depends on what aborted the attempt:
>
> - **`cancel()`:** a `'skip'` or `'error'` report ends the operation `'stopped'`: the operation result is `{ status: 'canceled' }` and pending `cancel()` calls resolve `'canceled'`. `'error'` also records its value into `errors`, `mostCommonError`, and `lastError`, while `'skip'` keeps them clean for actual failures. A `'success'` or `'fatal'` report still wins over the pending cancellation: the operation ends `'completed'` (`attempt_success`) or `'fatal-error'` (`attempt_fatal`), and pending `cancel()` calls resolve `'not-running'` (see [`cancel()`](#cancel)). Once the grace period has forced the cancellation, a late report of any status is discarded.
> - **`forceTry({ shouldAbortRunning: true })`:** a report made after the replacement attempt has started - `'skip'` or any other status - is discarded, without the global `'error'` report a late report from an attempt that was not aborted produces. A report an abort listener makes synchronously, inside the abort, is still the attempt's outcome (see [`forceTry()`](#forcetryoptions)).
>
> The `attempt-handled` event for a report made while cancellation is pending reflects the status you passed to `reportResult`, and includes `wasCanceled: true` so you can detect that cancellation was in progress.

### Properties

| Property                 | Type                   | Description                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runnerState`            | `RunnerState`          | Current lifecycle state (see Runner States)                                                                                                                                                                                                           |
| `operationLabel`         | `string`               | The label provided in constructor options (default: `'Unnamed Operation'`)                                                                                                                                                                            |
| `attempts`               | `number`               | Total attempts made (includes initial attempt and all retries, whether successful or not)                                                                                                                                                             |
| `retryCount`             | `number`               | Number of retries made (excludes the initial attempt, counts only subsequent retry attempts)                                                                                                                                                          |
| `maxRetryAttempts`       | `number`               | Maximum retry attempts allowed                                                                                                                                                                                                                        |
| `errors`                 | `unknown[]`            | All errors encountered                                                                                                                                                                                                                                |
| `mostCommonError`        | `unknown`              | Most frequent error (grouped by reference equality and message string), or `null` if no errors have occurred                                                                                                                                          |
| `lastError`              | `unknown`              | Most recent error, or `null` if no errors have been recorded                                                                                                                                                                                          |
| `wasSuccessful`          | `boolean`              | Whether the operation succeeded                                                                                                                                                                                                                       |
| `wasInitialAttemptTaken` | `boolean`              | Whether the initial attempt was made                                                                                                                                                                                                                  |
| `areAttemptsExhausted`   | `boolean`              | Whether all attempts are used                                                                                                                                                                                                                         |
| `isRetryPending`         | `boolean`              | Whether a retry is currently scheduled                                                                                                                                                                                                                |
| `isOperationRunning`     | `boolean`              | Whether the operation is running or stopping                                                                                                                                                                                                          |
| `isAttemptRunning`       | `boolean`              | Whether an individual attempt is in progress                                                                                                                                                                                                          |
| `canForceTry`            | `boolean`              | Whether `forceTry()` would be accepted now: `false` once `completed`, during terminal publication, or while another call dispatches. Accepted can mean attaching to the in-flight attempt, even while `'stopping'` (see `forceTry()`)                 |
| `wasLastAttemptForced`   | `boolean`              | Whether the last attempt was triggered by `forceTry()`                                                                                                                                                                                                |
| `retryTimeRemaining`     | `number`               | MS until next retry, or `-1` if none pending                                                                                                                                                                                                          |
| `timeTakenMS`            | `number`               | Total operation time (includes all retries and delays). Resets when calling `run()`, `resume()`, or `forceTry()` from terminal states. Does NOT reset when `forceTry()` accelerates a pending retry. Freezes when operation ends. `-1` if not started |
| `attemptTimeTakenMS`     | `number`               | Current attempt duration in MS. While an attempt is running, shows elapsed time. When no attempt is running, shows the duration of the last completed attempt. `-1` if no attempt has run yet                                                         |
| `policyInfo`             | `RetryPolicyValidated` | A fresh snapshot of the validated policy settings (all options resolved to their defaults)                                                                                                                                                            |
| `graceCancelPeriodMS`    | `number`               | How long `cancel()` waits for the operation to respond before force-stopping (default: 1000ms)                                                                                                                                                        |

### Methods

#### `run(shouldWaitForCompletion?: boolean)`

Starts the operation with retries. Defaults to `shouldWaitForCompletion = false`.

Returns `Promise<RunResult<T>>`:

- If `shouldWaitForCompletion` is `false` (default): resolves immediately with `{ status: 'running' }`. This reports that the operation was started, not how it ends: an `operation-started` listener that calls `cancel()` or `reset()` still leaves this result `{ status: 'running' }`, and `waitForCompletion()` reports `{ status: 'canceled' }`. The same holds for `resume()` and `forceTry()` (which still includes `reattached: false`).
- If `shouldWaitForCompletion` is `true`: resolves when the operation finishes with one of:
  - `{ status: 'attempt_success', data?: T }` - succeeded
  - `{ status: 'attempts_exhausted', error? }` - retry budget exhausted (`error` is from the final attempt; a forced attempt that reports `skip` may omit it)
  - `{ status: 'attempt_fatal', error?, code? }` - fatal error, no retry; `code: 'unexpected_error'` identifies a failure while setting up an attempt, evaluating the retry policy or installing its timer
  - `{ status: 'canceled' }` - canceled during execution
- On pre-operation error: `{ status: 'pre_operation_error', code, error }` with codes:
  - `'already_running'` - operation is already in progress
  - `'already_completed'` - operation already finished (call `reset()` to start a new operation)
  - `'cancel_pending'` - a cancellation is in progress
  - `'retry_canceled'` - operation was canceled (use `resume()`, `forceTry()`, or `reset()`)
  - `'fatally_failed'` - last attempt was fatal (use `forceTry()` or `reset()`)
  - `'attempts_exhausted'` - all retries used (use `forceTry()` or `reset()`)
  - `'lock_error'` - concurrent operation call detected
  - `'terminal_dispatch_in_progress'` - called while the operation's terminal outcome is being published
  - `'unexpected_error'` - an unexpected internal error occurred

> **Note:** apart from invalid `forceTry()` options, which fail as `pre_operation_error` / `unexpected_error` (with a `TypeError` for a non-boolean value, or the getter's own error), `unexpected_error` should not occur in normal use and indicates an internal state inconsistency in the library. If you encounter it otherwise, call `reset()` before trying again and consider reporting a bug.

```typescript
// Start and wait for completion
const result = await runner.run(true);

// Start in background
void runner.run(false);
```

#### `waitForCompletion()`

Waits for the current operation to complete. Returns `Promise<RunResult<T>>` with one of:

- `{ status: 'attempt_success', data?: T }` - succeeded
- `{ status: 'attempts_exhausted', error? }` - retry budget exhausted (`error` is from the final attempt; a forced attempt that reports `skip` may omit it)
- `{ status: 'attempt_fatal', error?, code? }` - fatal error, no retry; `code: 'unexpected_error'` identifies a failure while setting up an attempt, evaluating the retry policy or installing its timer
- `{ status: 'canceled' }` - canceled during execution
- `{ status: 'not_started', code: 'not_running', error }` - runner has not been started

Behavior by state:

- If the runner is in `'not-started'` state, returns immediately with `{ status: 'not_started', code: 'not_running', error }`.
- If the runner is in a terminal state (`'completed'`, `'exhausted'`, `'fatal-error'`, `'stopped'`), returns the result from the last operation immediately.
- If the runner is in `'running'` or `'stopping'` state, waits for the operation to finish.

```typescript
void runner.run();
const result = await runner.waitForCompletion();
```

#### `cancel()`

Pending retry delays keep the Node process alive so awaited retries can finish. Call `cancel()` or `reset()` when abandoning a runner.

Cancels the current operation and any scheduled retries.

Returns `Promise<CancelResult>`:

- `'canceled'` - operation acknowledged the abort signal and stopped
- `'superseded'` - a newer forced restart took over while cancellation was pending; the runner may still be running
- `'forced'` - operation did not acknowledge within the grace period and was force-stopped
- `'not-running'` - no cancelable operation remains, including a terminal outcome already being published or success/fatal completion that wins while cancellation is pending. Use `waitForCompletion()` for that operation's result. Even then, unless the operation succeeded, the call still records stop intent: a `cancel()` from an abort listener (or a terminal listener it triggers) supersedes the `forceTry({ shouldAbortRunning: true })` that sent the abort, so that force starts no replacement - see `forceTry()`.

```typescript
const cancelResult = await runner.cancel();
```

**Cancellation grace period:** When canceling, the runner sends an abort signal to the operation and waits up to 1000ms (default) for it to call `reportResult`. If the operation doesn't respond in time, the cancel is forced. Use `overrideGraceCancelPeriodMS(ms)` to change this timeout. Invalid values throw; `0` forces cancellation on the next timer turn, and `Infinity` uses the timer ceiling.

If the cancellation grace timer cannot be installed, cancellation completes immediately as `'forced'` and reports the timer failure on the global error channel.

#### `reset()`

Resets the current operation so the runner can be used again from scratch, unless a newer operation supersedes the request while it waits. This:

1. Cancels the current operation first if the runner is in `'running'` or `'stopping'` state (awaits cancellation)
2. Unless superseded by a newer operation while waiting, resets all runner state (`runnerState` back to `'not-started'`, clears timers, etc.)
3. Unless superseded, resets the underlying retry policy (clears all tracked errors, attempt counts, and success state)

Returns `Promise<void>`.

Reset applies to the operation current when it is requested. This includes an ordinary
reset waiting for cancellation and a reset requested by a terminal event listener.
If a newer operation starts before that wait ends, reset resolves without clearing or
canceling the newer operation. Its `Promise<void>` does not distinguish this superseded
case; completion alone does not guarantee `runnerState === 'not-started'` when calls
race. Serialize reset and start/force calls if you need that guarantee.

A terminal listener's reset waits for its operation's result before clearing state.
A replacement attempt has its own cancellation acknowledgement and grace period.

```typescript
await runner.reset();
// With reset/start calls serialized, state is now 'not-started' with zero errors/attempts
await runner.run(true);
```

#### `resume(shouldWaitForCompletion?: boolean)`

Resumes a previously canceled operation. Only works when `runnerState` is `'stopped'`.

Returns `Promise<RunResult<T>>` - same completion statuses as `run()`.

On pre-operation error: `{ status: 'pre_operation_error', code, error }` with codes:

- `'already_completed'` - operation already finished (call `reset()` first)
- `'already_running'` - operation is already in progress
- `'cancel_pending'` - a cancellation is in progress
- `'fatally_failed'` - last attempt was fatal (use `forceTry()` or `reset()`)
- `'attempts_exhausted'` - all retries used (use `forceTry()` or `reset()`)
- `'not_paused'` - runner is not in `'stopped'` state
- `'lock_error'` - concurrent operation call detected
- `'terminal_dispatch_in_progress'` - called while the operation's terminal outcome is being published
- `'unexpected_error'` - an unexpected internal error occurred

```typescript
await runner.cancel();
const result = await runner.resume(true);
```

#### `forceTry(options?)`

Forces an immediate retry attempt, bypassing policy limits. Works in all states except `'completed'`.

> **Note:** `forceTry()` cannot be called from `'completed'` state. Use `reset()` first to run the operation again from scratch, which clears all errors and attempt history. This prevents accidentally mixing results from a completed operation with a new forced attempt.

- If called from `'not-started'`, it acts as the first try. If a retry delay is pending, it fires immediately.
- If called from `'stopped'`, it starts a new operation.
- If called while `'stopping'` (a cancellation is waiting for the in-flight attempt to acknowledge), the outcome depends on `shouldAbortRunning`. With the default `false`, it attaches to that attempt like any other in-flight one (`{ status: 'running', reattached: true }`, or the operation's result when waiting) and the cancellation proceeds: the runner still ends `'stopped'` and the waiting caller receives `{ status: 'canceled' }`. With `shouldAbortRunning: true`, it aborts the attempt, resolves every pending `cancel()` with `'superseded'`, and the runner returns to `'running'` with a new attempt.
- `canForceTry` reports whether a call would be accepted, not whether it starts an attempt: an accepted call may attach as described here, and `shouldAbortRunning: true` can still refuse with `force_try_in_progress` while a forced attempt is in flight.
- **Abort-listener outcomes:** If an abort listener reports success synchronously, waiting force calls return that operation's successful result; non-waiting calls return `pre_operation_error` with `code: 'already_completed'`. Neither starts a replacement. A call made after the operation has already completed still returns `already_completed`, even when waiting. A newer `cancel()` or `reset()` requested by an abort listener also wins: waiting force calls join that operation's result rather than restarting. Non-waiting calls return immediately with `pre_operation_error` / `force_try_superseded`, without claiming that cancellation has finished. A force request made after cancellation was requested can still intentionally restart it.
- **Supersession has side effects:** `force_try_superseded` is an exception to the usual pre-operation refusal: the running attempt has already received its abort signal, but no replacement was started. Keep the original `run(true)` or `waitForCompletion()` promise if you need its final outcome. Await the newer cancel/reset before deciding whether to start more work.
- **Combined outcomes:** If a listener reports success and then calls `reset()`, the newer reset takes precedence: a non-waiting force returns `force_try_superseded`, while a waiting force returns the captured operation's successful result. A `cancel()` after success is a no-op, so waiting calls retain success and non-waiting calls return `already_completed`. Neither combination starts a replacement.
- **Fatal/exhausted abort outcomes:** If the abort listener reports fatal failure or exhausts the retry budget, original waiters receive that terminal result. The accepted force request then starts a new operation, just as an explicit force from those states does. Its waiting caller receives the new operation's result. The retry budget is not reset. If the listener (or an `attempt-handled` / `operation-ended` listener during that publication) also calls `cancel()` or `reset()`, the newer stop request wins instead: no new operation starts, waiting force calls receive the fatal/exhausted result, and non-waiting calls return `force_try_superseded`. That `cancel()` itself resolves `'not-running'`, since the operation had already ended.
- **Replacing an active attempt:** If the aborted attempt did not report an outcome synchronously, it emits `attempt-handled` with `status: 'skip'`, `wasCanceled: true`, and its duration before the replacement starts. This does not spend the retry budget. A cancel/reset from that event can supersede the replacement. Force-aborting an attempt in a running operation (including pending cancellation) retains the operation's elapsed time and completion promise. It starts a new attempt without another `operation-started` event; the eventual terminal result emits the matching `operation-ended`.
- **Timer behavior:** `timeTakenMS` resets when starting a new attempt from terminal states (`'not-started'`, `'exhausted'`, `'fatal-error'`, `'stopped'`) but does NOT reset when accelerating a pending retry (operation already running, just clearing the delay timer).

Options (only booleans or `undefined` are accepted; invalid values or throwing getters resolve as `pre_operation_error` / `unexpected_error`):

- **`shouldWaitForCompletion`** (`boolean`, default: `false`) - Whether to wait for the attempt to complete before resolving.
- **`shouldAbortRunning`** (`boolean`, default: `false`) - What to do if an attempt is already in-flight. When `false`, attaches to the current operation (waiting only if `shouldWaitForCompletion` is true). When `true`, aborts the running attempt and starts a new one unless an abort listener completes it or requests cancellation/reset, as described above.

Returns `Promise<RunResult<T>>`:

- If `shouldWaitForCompletion` is `false`: normally resolves immediately with `{ status: 'running', reattached: boolean }` where `reattached` indicates whether it attached to an already-running attempt (`true`) or started a new one (`false`). The abort-listener cancellation/reset case above instead returns `pre_operation_error` / `force_try_superseded` immediately.
- If `shouldWaitForCompletion` is `true`: same completion statuses as `run()`.

On pre-operation error: `{ status: 'pre_operation_error', code, error }` with codes:

- `'already_completed'` - operation already finished (call `reset()` first)
- `'force_try_superseded'` - an abort listener requested cancel/reset after this non-waiting force request
- `'force_try_in_progress'` - a forced attempt with `shouldAbortRunning: true` is already running
- `'lock_error'` - concurrent operation call detected
- `'terminal_dispatch_in_progress'` - called while the operation's terminal outcome is being published
- `'unexpected_error'` - invalid options (a non-boolean value, or a getter that throws), or an unexpected internal error

> **Important:** `forceTry()` does not reset the policy's retry budget. If a forced attempt from `'exhausted'` reports `'error'`, the runner returns to `'exhausted'`. If a forced attempt from `'fatal-error'` reports `'error'`, the runner either schedules another retry (if the policy still has remaining budget) or transitions to `'exhausted'`. Use `reset()` to start fresh with a full retry budget.

```typescript
// Force a retry, wait for result (attaches if attempt already running)
const result = await runner.forceTry({ shouldWaitForCompletion: true });

// Force a retry and abort whatever is currently running
const result = await runner.forceTry({
  shouldWaitForCompletion: true,
  shouldAbortRunning: true,
});
```

#### `overrideGraceCancelPeriodMS(ms)`

Overrides the default 1000ms cancellation grace period. This setter requires a numeric
argument: `null`, `undefined`, an omitted argument, or `NaN` throws `TypeError`; negative
values throw `RangeError`. To restore the default, pass `1000` explicitly. `Infinity`
selects the timer ceiling. A value of `0` force-cancels on the next timer turn without waiting for the operation to acknowledge
the abort signal.

### Events

Subscribe using the `on` method or provide handlers in the constructor.

> **Note:** Event handlers should not return values. Any returned values are ignored. Both sync and async handlers are supported. Errors from either are caught and dispatched as `ErrorEvent` objects of type `'error'` via `globalThis.dispatchEvent()` (listen with `globalThis.addEventListener('error', handler)`). This reporting path is supported in Node.js 25+, Bun, Deno, and modern browsers. Errors do not propagate to the runner or interrupt its operation.

| Event               | Constant            | Payload                                                                                                                                                |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `operation-started` | `OPERATION_STARTED` | `{ operationType: 'initial' \| 'resume' \| 'force' }`                                                                                                  |
| `operation-ended`   | `OPERATION_ENDED`   | `{ runnerState: RunnerState, timeTakenMS: number }`                                                                                                    |
| `attempt-started`   | `ATTEMPT_STARTED`   | `{ attemptID: string, operationTimeElapsedMS: number, attemptTimeElapsedMS: number }`                                                                  |
| `attempt-handled`   | `ATTEMPT_HANDLED`   | `{ attemptID: string, status: ReportResultStatus, operationTimeElapsedMS: number, attemptTimeElapsedMS: number, data?, error?, wasCanceled: boolean }` |

**Time fields:**

- `operationTimeElapsedMS` - Total time since the operation started (includes all retries and delays)
- `attemptTimeElapsedMS` - Time taken by this specific attempt only (0 at `attempt-started`, actual duration at `attempt-handled`)

**Attempt ID:**

- `attemptID` - A unique [ULID](https://github.com/ulid/spec) (Universally Unique Lexicographically Sortable Identifier) generated for each attempt. ULIDs are 26-character strings that are timestamp-based and sortable by creation time (e.g., `"01ARZ3NDEKTSV4RRFFQ69G5FAV"`).

> **Event ordering:** `attempt-handled` fires before the runner transitions to its terminal state and before `operation-ended`. If you need to react to the final `runnerState`, use the `operation-ended` event. During terminal outcome publication, a re-entrant `cancel()` cannot replace the committed outcome. From an `attempt-handled` listener of a running operation - which still observes `runnerState: 'running'` and `isOperationRunning: true` - it returns `'not-running'`; from an `operation-ended` listener the state is already terminal, so it returns `'not-running'` too. While a cancellation is already pending (`'stopping'`), an `attempt-handled` listener's `cancel()` instead joins it and resolves with the same result as the earlier `cancel()` callers: `'canceled'` (or `'forced'` after the grace period) when the attempt acknowledged the abort, `'not-running'` when its success or fatal report won. `run()`, `resume()` and `forceTry()` return `terminal_dispatch_in_progress` (and `canForceTry` reads `false`), and `reset()` waits for that outcome to settle. An `operation-started` listener can call `waitForCompletion()` for the operation being announced.

> **Forcing from a non-terminal `attempt-handled` listener:** when an attempt fails and a retry is scheduled, `attempt-handled` fires with the retry timer already armed. If the attempt reported outside any `run()` / `resume()` / `forceTry()` call - asynchronously, or from an attempt the retry timer started - `forceTry()` from that listener starts the next attempt synchronously, inside the dispatch. Listeners registered after it then see the earlier attempt's `attempt-handled` only after the next attempt's `attempt-started` - and, if that attempt reports synchronously and ends the operation, after `operation-ended` too. If the attempt instead reported synchronously while the call that started it was still dispatching (an operation that calls `reportResult` before returning, on the attempt `run()`, `resume()` or `forceTry()` starts), that call still holds the operation lock: `canForceTry` reads `false`, `forceTry()` returns `lock_error`, and the retry stays on its timer. In either case, calling `forceTry()` from a `queueMicrotask()` instead runs once that dispatch has finished and released the lock, and keeps listener ordering intact.

To start more work from a terminal listener, wait for the outcome to settle first. Existing `run(true)` / `waitForCompletion()` callers still receive the original result. Guard the retry so a forced attempt that also ends `exhausted` does not trigger another one, without bound:

```typescript
let hasForced = false;

runner.on(OPERATION_ENDED, async ({ runnerState }) => {
  if (runnerState === 'exhausted' && !hasForced) {
    hasForced = true;
    await runner.waitForCompletion(); // Resolves once the outcome has settled.
    await runner.forceTry();
  }
});
```

```typescript
const runner = new RetryRunner(policy, operation, {
  operationLabel: 'My Operation',
  onOperationStarted: (info) => {
    console.log('Operation started:', info.operationType);
  },
  onOperationEnded: (info) => {
    console.log('Operation ended:', info.runnerState, `${info.timeTakenMS}ms`);
  },
  onAttemptStarted: (info) => {
    console.log('Attempt started:', info.attemptID);
  },
  onAttemptHandled: (info) => {
    console.log('Attempt handled:', info.status);
  },
});

// Or subscribe after creation (on() returns an unsubscribe function)
const unsubscribe = runner.on(OPERATION_STARTED, (data) => {
  console.log('Started:', data.operationType);
});

// Later, to remove the listener:
unsubscribe();
```

> **Note:** The `on()` and `once()` methods receive event payloads typed as `unknown`. Constructor-provided handlers (`onOperationStarted`, `onOperationEnded`, etc.) are fully typed. When using `on()`/`once()`, cast the payload to the appropriate interface (e.g., `OnOperationStartedInfo`, `OnAttemptHandledInfo<T>`) for type safety.

The runner also inherits these methods from its event emitter base class:

- **`on(event, callback)`** - Subscribe to an event. Returns an unsubscribe function.
- **`once(event, callback)`** - Subscribe to an event once. It automatically unsubscribes after the first emission. Returns an unsubscribe function.
- **`hasListener(event, callback)`** - Returns `true` if the exact callback is registered for the event. Note: for `once()` subscriptions, this checks the internal wrapper, not the original callback.
- **`hasListeners(event)`** - Returns `true` if the event has any subscribers.
- **`listenerCount(event)`** - Returns the number of subscribers for the event.
- **`clear(event?)`** - Removes all listeners for the given event, or all listeners if no event is specified.

### Custom Types

The `RetryRunner` supports generic typing for type-safe custom values. The generic type `T` applies to the `value` parameter of `reportResult` for `'success'` and `'skip'` statuses, and is surfaced as `data` in the result and event payloads. For `'error'` and `'fatal'` statuses, `value` is typed as `unknown` (since errors can be anything) and is surfaced as `error`.

```typescript
interface CustomResult {
  message: string;
  code: number;
}

const operation = (
  reportResult: ReportResult<CustomResult>,
  signal: AbortSignal,
): void => {
  try {
    const data = fetchSomething();
    reportResult('success', { message: 'Done', code: 0 });
  } catch (error) {
    reportResult('error', error);
  }
};

const runner = new RetryRunner<CustomResult>(policy, operation);
const result = await runner.run(true);

if (result.status === 'attempt_success') {
  console.log('Custom value:', result.data); // Typed as CustomResult
} else {
  console.log('Error:', result.code, result.error);
}
```

### Complete Example

```typescript
const policy: RetryPolicyOptions = {
  strategy: 'exponential',
  maxRetryAttempts: 5,
  minTimeoutMS: 1000,
  maxTimeoutMS: 10000,
};

const operation = async (reportResult, signal) => {
  try {
    const response = await fetch('https://api.example.com/data', { signal });

    if (!response.ok) {
      reportResult('error', new Error(`HTTP ${response.status}`));
      return;
    }

    const data = await response.json();
    reportResult('success', data);
  } catch (error) {
    if (error.name === 'AbortError') {
      reportResult('skip', 'Aborted');
    } else {
      reportResult('error', error);
    }
  }
};

const runner = new RetryRunner(policy, operation, {
  operationLabel: 'Fetch API Data',
});

runner.on(OPERATION_ENDED, (info) => {
  console.log(`Operation took ${info.timeTakenMS}ms`);
});

const result = await runner.run(true);

if (result.status === 'attempt_success') {
  console.log('Success:', result.data);
} else if (result.status === 'attempts_exhausted') {
  console.error('All retries exhausted:', result.error);
} else if (result.status === 'attempt_fatal') {
  console.error('Fatal error:', result.error);
}
```

## Error Classes

All error classes are exported and can be used for `instanceof` checks:

| Error Class                                     | Thrown By / Code                | Description                                                                            | Error Message                                                                                                                                                                    |
| ----------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RetryUtilsErrPolicyConfigInvalidStrategy`      | `RetryPolicy` constructor       | Invalid strategy provided                                                              | `"Invalid strategy provided."`                                                                                                                                                   |
| `RetryUtilsErrRunnerAlreadyCompleted`           | `already_completed`             | Operation already finished                                                             | `"The runner has already completed running the operation. Use the .reset() method, and .run() to run the operation again."`                                                      |
| `RetryUtilsErrRunnerAlreadyRunning`             | `already_running`               | Operation is already in progress                                                       | `"The operation is already running and cannot be started again."`                                                                                                                |
| `RetryUtilsErrRunnerCancelPending`              | `cancel_pending`                | A cancellation is in progress                                                          | `"A cancel operation is pending. The operation cannot be started again."`                                                                                                        |
| `RetryUtilsErrRunnerRetryCanceled`              | `retry_canceled`                | Operation was canceled                                                                 | `"The operation was already canceled. Use either .resume(), .forceTry() or .reset() and .run() to run the operation again."`                                                     |
| `RetryUtilsErrRunnerLastRetryFatallyFailed`     | `fatally_failed`                | Last attempt failed fatally                                                            | `"The last retry attempt failed fatally. The operation cannot be retried. Use either .reset() then .run() or .forceTry() to run the operation again."`                           |
| `RetryUtilsErrRunnerAttemptsExhausted`          | `attempts_exhausted`            | All retry attempts used                                                                | `"All attempts were exhausted. The operation cannot be retried. Use either .reset() then .run() or .forceTry() to run the operation again."`                                     |
| `RetryUtilsErrRunnerLockAcquisitionError`       | `lock_error`                    | Re-entrant call detected (e.g., calling `run()` from an event listener during setup)   | `"Failed to acquire operation lock. Cannot attempt to run the operation."`                                                                                                       |
| `RetryUtilsErrRunnerTerminalDispatchInProgress` | `terminal_dispatch_in_progress` | `run()`, `resume()` or `forceTry()` called while a terminal outcome is being published | `"The current operation is publishing its terminal outcome. Wait for it to settle (waitForCompletion()) before starting more work."`                                             |
| `RetryUtilsErrRunnerNotPaused`                  | `not_paused`                    | Runner is not in stopped state (for `resume()`)                                        | `"The runner is not in a paused state. resume() can only be called when the runner state is stopped."`                                                                           |
| `RetryUtilsErrRunnerNotRunning`                 | `not_running`                   | Runner has not been started (for `waitForCompletion`)                                  | `"The operation is not currently running."`                                                                                                                                      |
| `RetryUtilsErrRunnerUnknownState`               | Internal                        | Unknown runner state encountered (should not occur in normal usage)                    | `"An unknown runner state was encountered."`                                                                                                                                     |
| `RetryUtilsErrRunnerForceTryRetryInProgress`    | `force_try_in_progress`         | A forced attempt is already running                                                    | `"Force try retry is already in progress."`                                                                                                                                      |
| `RetryUtilsErrRunnerForceTrySuperseded`         | `force_try_superseded`          | A newer abort-listener cancel/reset prevented a non-waiting forced retry               | `"A newer cancel or reset request superseded this forced retry after abort was sent. Await that request before deciding whether to retry with forceTry() or reset() and run()."` |
| `RetryUtilsErrRunnerUnexpectedError`            | `unexpected_error`              | An unexpected internal error occurred                                                  | `"An unexpected error occurred."`                                                                                                                                                |

> **Note:** All error instances include detailed messages with guidance on how to recover (e.g., which methods to call to resolve the error state).

## Exported Types

The following types are exported for use in consuming code:

| Type                                    | Description                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RetryPolicyOptions`                    | Union of fixed and exponential strategy option interfaces                                                                                            |
| `RetryPolicyOptionsStrategyFixed`       | Options interface for the `'fixed'` strategy                                                                                                         |
| `RetryPolicyOptionsStrategyExponential` | Options interface for the `'exponential'` strategy                                                                                                   |
| `RetryPolicyValidated`                  | `RequiredNonNullable<RetryPolicyOptions>` - all options resolved (narrow on `strategy` to access strategy-specific properties)                       |
| `RetryQueryResult`                      | Return type of `RetryPolicy.shouldRetry()`: `{ shouldRetry: boolean, delayMS: number }`                                                              |
| `RunAttemptStatusCodes`                 | Union of all possible `status` values in `RunResult`                                                                                                 |
| `RunnerErrorCode`                       | Union of all possible `code` values in pre-operation errors                                                                                          |
| `RunResult<T>`                          | Return type of `run()`, `resume()`, `forceTry()`, `waitForCompletion()`. Discriminated union - narrow on `status`                                    |
| `RunResultSuccess<T>`                   | Success branch of `RunResult<T>`: `{ status: 'attempt_success', data?: T }`                                                                          |
| `RunResultNonSuccess`                   | Non-success branch of `RunResult<T>`: `{ status, code?, error?, reattached? }` (`reattached` only present for `status: 'running'` from `forceTry()`) |
| `RunnerState`                           | Union of all runner lifecycle states                                                                                                                 |
| `ReportResult<T>`                       | Type of the `reportResult` callback passed to the operation                                                                                          |
| `ReportResultStatus`                    | Union of report result statuses: `'success' \| 'error' \| 'fatal' \| 'skip'`                                                                         |
| `CancelResult`                          | Return type of `cancel()`: `'canceled' \| 'forced' \| 'not-running' \| 'superseded'`                                                                 |
| `ForceTryOptions`                       | Options for `forceTry()`                                                                                                                             |
| `RetryRunnerOptions<T>`                 | Options for the `RetryRunner` constructor (operation label and event handlers)                                                                       |
| `OnOperationStartedInfo`                | Payload for the `operation-started` event                                                                                                            |
| `OnOperationEndedInfo`                  | Payload for the `operation-ended` event                                                                                                              |
| `OnAttemptStartedInfo`                  | Payload for the `attempt-started` event                                                                                                              |
| `OnAttemptHandledInfo<T>`               | Payload for the `attempt-handled` event                                                                                                              |
| `OperationStartedType`                  | Union of operation start types: `'initial' \| 'resume' \| 'force'`                                                                                   |

The following constants are also exported:

| Constant            | Value                 | Description                      |
| ------------------- | --------------------- | -------------------------------- |
| `OPERATION_STARTED` | `'operation-started'` | Event name for operation started |
| `OPERATION_ENDED`   | `'operation-ended'`   | Event name for operation ended   |
| `ATTEMPT_STARTED`   | `'attempt-started'`   | Event name for attempt started   |
| `ATTEMPT_HANDLED`   | `'attempt-handled'`   | Event name for attempt handled   |
