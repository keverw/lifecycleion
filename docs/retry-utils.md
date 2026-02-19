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
  maxRetryAttempts?: number; // Max retries allowed (excludes initial attempt). Default: 10, Min: 1
  delayMS?: number; // Delay between retries. Default: 1000ms, Min: 1
}
```

### Exponential Strategy

Uses exponential backoff with jitter to calculate delays between retry attempts.

```typescript
{
  strategy: 'exponential';
  maxRetryAttempts?: number; // Max retries allowed (excludes initial attempt). Default: 10, Min: 1
  factor?: number; // Multiplier for exponential growth. Default: 1.5, Min: 1
  minTimeoutMS?: number; // Shortest delay between retries. Default: 1000ms, Min: 1
  maxTimeoutMS?: number; // Longest delay between retries. Default: 30000ms, Min: 1
  dispersion?: number; // Randomness added to delays (0 to 1 inclusive, e.g. 0.1 = 10%). Default: 0.1
}
```

The `dispersion` property adds randomness to prevent all retries from happening at the same time (thundering herd problem). Specifically, the computed delay is adjusted by a random amount in the range `±(delay × dispersion)`, then clamped to `[minTimeoutMS, maxTimeoutMS]`. For example, a dispersion of `0.1` on a 2000ms delay produces a final delay between 1800ms and 2200ms (before clamping).

**Dispersion formula:**

```typescript
randomOffset = (Math.random() * 2 - 1) * (delay * dispersion);
finalDelay = clamp(delay + randomOffset, minTimeoutMS, maxTimeoutMS);
```

> All numeric options are clamped to their documented ranges. Values outside the allowed range are silently adjusted. Additionally, if `maxTimeoutMS < minTimeoutMS`, the values are automatically swapped to ensure `maxTimeoutMS >= minTimeoutMS`.

## RetryPolicy

The `RetryPolicy` class provides low-level control over retry behavior. It tracks retry attempts, calculates delays, and decides whether to retry - but doesn't execute anything itself.

### Constructor

```typescript
new RetryPolicy(options: RetryPolicyOptions)
```

Throws `RetryUtilsErrPolicyConfigInvalidStrategy` if an invalid strategy is provided.

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

When `isQueryOnly` is `true`, the `error` parameter can be omitted — no error is recorded and the method purely queries whether a retry is available.

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
| `policyInfo`             | `RetryPolicyValidated` | The validated policy settings                                                                                |
| `attempts`               | `number`               | Total attempts made (initial + retries)                                                                      |
| `retryCount`             | `number`               | Number of retries (excluding initial attempt)                                                                |
| `maxRetryAttempts`       | `number`               | Maximum retry attempts allowed                                                                               |
| `areAttemptsExhausted`   | `boolean`              | Whether max attempts have been reached                                                                       |
| `wasInitialAttemptTaken` | `boolean`              | Whether the initial attempt has been made                                                                    |
| `wasSuccessful`          | `boolean`              | Whether the operation was marked successful                                                                  |
| `errors`                 | `unknown[]`            | Array of errors encountered                                                                                  |
| `mostCommonError`        | `unknown`              | Most frequent error (grouped by reference equality and message string), or `null` if no errors have occurred |
| `lastError`              | `unknown`              | Most recent error, or `null` if no errors have been recorded                                                 |

> **Note:** `mostCommonError` uses two strategies to determine frequency — reference equality (`===`) and message-string grouping — and returns whichever finds the highest count. Reference equality catches reused error objects (including those with unstable or dynamic messages). Message grouping uses the `.message` property for `Error` instances and objects, nested `.error.message` for wrapped errors, or `String()` conversion as a fallback, so distinct objects with the same message are counted together. The first instance encountered for the winning group is returned. In case of ties across strategies, the first error encountered with the maximum count is returned.

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

> **CRITICAL:** `reportResult` **MUST** be called exactly once per attempt. If your operation completes without calling `reportResult` and without throwing an error, the attempt will hang indefinitely (it will wait forever, blocking any retry logic). The only exception is throwing an error, which is automatically treated as `reportResult('error', thrownError)`. If called more than once, subsequent calls are silently ignored.

> **Important:** When `cancel()` is called, the operation receives an abort signal via the `signal` parameter. If the operation doesn't call `reportResult` within the `graceCancelPeriodMS` (default 1000ms, configurable via `overrideGraceCancelPeriodMS()`), the cancellation is forced. Always check `signal.aborted` in long-running operations to respond to cancellation requests.
>
> **Note:** If cancellation is forced, the runner will emit `attempt-handled` with a `'skip'` status and `wasCanceled: true` for the in-flight attempt before emitting `operation-ended`.

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

> **Tip:** When `signal.aborted` is true, and acknowledged, use `reportResult('skip')` rather than `'error'`. The operation result resolves with `'canceled'` status regardless of what you report, but `'error'` still records the value into the `errors` array. Using `'skip'` keeps `errors`, `mostCommonError`, and `lastError` clean for actual failures. Note that the `attempt-handled` event still reflects the status you passed to `reportResult` (not `'canceled'`), but includes `wasCanceled: true` so you can detect that cancellation was in progress.

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
| `canForceTry`            | `boolean`              | Whether `forceTry()` can be called in the current state                                                                                                                                                                                               |
| `wasLastAttemptForced`   | `boolean`              | Whether the last attempt was triggered by `forceTry()`                                                                                                                                                                                                |
| `retryTimeRemaining`     | `number`               | MS until next retry, or `-1` if none pending                                                                                                                                                                                                          |
| `timeTakenMS`            | `number`               | Total operation time (includes all retries and delays). Resets when calling `run()`, `resume()`, or `forceTry()` from terminal states. Does NOT reset when `forceTry()` accelerates a pending retry. Freezes when operation ends. `-1` if not started |
| `attemptTimeTakenMS`     | `number`               | Current attempt duration in MS. While an attempt is running, shows elapsed time. When no attempt is running, shows the duration of the last completed attempt. `-1` if no attempt has run yet                                                         |
| `policyInfo`             | `RetryPolicyValidated` | The validated policy settings (all options resolved to their defaults)                                                                                                                                                                                |
| `graceCancelPeriodMS`    | `number`               | How long `cancel()` waits for the operation to respond before force-stopping (default: 1000ms)                                                                                                                                                        |

### Methods

#### `run(shouldWaitForCompletion?: boolean)`

Starts the operation with retries. Defaults to `shouldWaitForCompletion = false`.

Returns `Promise<RunResult<T>>`:

- If `shouldWaitForCompletion` is `false` (default): resolves immediately with `{ status: 'running' }`.
- If `shouldWaitForCompletion` is `true`: resolves when the operation finishes with one of:
  - `{ status: 'attempt_success', data?: T }` - succeeded
  - `{ status: 'attempts_exhausted', error? }` - all retries failed (`error` is from the final attempt)
  - `{ status: 'attempt_fatal', error? }` - fatal error, no retry
  - `{ status: 'canceled' }` - canceled during execution
- On pre-operation error: `{ status: 'pre_operation_error', code, error }` with codes:
  - `'already_running'` - operation is already in progress
  - `'already_completed'` - operation already finished (call `reset()` to start a new operation)
  - `'cancel_pending'` - a cancellation is in progress
  - `'retry_canceled'` - operation was canceled (use `resume()`, `forceTry()`, or `reset()`)
  - `'fatally_failed'` - last attempt was fatal (use `forceTry()` or `reset()`)
  - `'attempts_exhausted'` - all retries used (use `forceTry()` or `reset()`)
  - `'lock_error'` - concurrent operation call detected
  - `'unexpected_error'` - an unexpected internal error occurred

> **Note:** `unexpected_error` should not occur in normal use and indicates an internal state inconsistency in the library. If you encounter this, call `reset()` before trying again and consider reporting a bug.

```typescript
// Start and wait for completion
const result = await runner.run(true);

// Start in background
void runner.run(false);
```

#### `waitForCompletion()`

Waits for the current operation to complete. Returns `Promise<RunResult<T>>` with one of:

- `{ status: 'attempt_success', data?: T }` - succeeded
- `{ status: 'attempts_exhausted', error? }` - all retries failed (`error` is from the final attempt)
- `{ status: 'attempt_fatal', error? }` - fatal error, no retry
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

Cancels the current operation and any scheduled retries.

Returns `Promise<CancelResult>`:

- `'canceled'` - operation acknowledged the abort signal and stopped
- `'forced'` - operation did not acknowledge within the grace period and was force-stopped
- `'not-running'` - nothing was running

```typescript
const cancelResult = await runner.cancel();
```

**Cancellation grace period:** When canceling, the runner sends an abort signal to the operation and waits up to 1000ms (default) for it to call `reportResult`. If the operation doesn't respond in time, the cancel is forced. Use `overrideGraceCancelPeriodMS(ms)` to change this timeout.

#### `reset()`

Fully resets the runner so it can be used again from scratch. This:

1. Cancels the current operation first if the runner is in `'running'` or `'stopping'` state (awaits cancellation)
2. Resets all runner state (`runnerState` back to `'not-started'`, clears timers, etc.)
3. Resets the underlying retry policy (clears all tracked errors, attempt counts, and success state)

Returns `Promise<void>`.

```typescript
await runner.reset();
// Runner is now in 'not-started' state with zero errors/attempts
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
- `'unexpected_error'` - an unexpected internal error occurred

```typescript
await runner.cancel();
const result = await runner.resume(true);
```

#### `forceTry(options?)`

Forces an immediate retry attempt, bypassing policy limits. Works in all states except `'completed'`.

> **Note:** `forceTry()` cannot be called from `'completed'` state. Use `reset()` first to run the operation again from scratch, which clears all errors and attempt history. This prevents accidentally mixing results from a completed operation with a new forced attempt.

- If called from `'not-started'`, it acts as the first try. If a retry delay is pending, it fires immediately.
- If called while the runner is in `'stopping'` or `'stopped'` state, any pending cancel promises are resolved and the runner transitions back to `'running'`.
- **Timer behavior:** `timeTakenMS` resets when starting a new attempt from terminal states (`'not-started'`, `'exhausted'`, `'fatal-error'`, `'stopped'`) but does NOT reset when accelerating a pending retry (operation already running, just clearing the delay timer).

Options:

- **`shouldWaitForCompletion`** (`boolean`, default: `false`) - Whether to wait for the attempt to complete before resolving.
- **`shouldAbortRunning`** (`boolean`, default: `false`) - What to do if an attempt is already in-flight. When `false`, attaches to the current operation and waits for its result. When `true`, aborts the running attempt and starts a new one.

Returns `Promise<RunResult<T>>`:

- If `shouldWaitForCompletion` is `false`: resolves immediately with `{ status: 'running', reattached: boolean }` where `reattached` indicates whether it attached to an already-running attempt (`true`) or started a new one (`false`).
- If `shouldWaitForCompletion` is `true`: same completion statuses as `run()`.

On pre-operation error: `{ status: 'pre_operation_error', code, error }` with codes:

- `'already_completed'` - operation already finished (call `reset()` first)
- `'force_try_in_progress'` - a forced attempt with `shouldAbortRunning: true` is already running
- `'lock_error'` - concurrent operation call detected
- `'unexpected_error'` - an unexpected internal error occurred

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

Overrides the default 1000ms cancellation grace period. Non-finite or negative values default to 1000ms. A value of `0` will force-cancel immediately without waiting for the operation to acknowledge the abort signal.

### Events

Subscribe using the `on` method or provide handlers in the constructor.

> **Note:** Event handlers should not return values. Any returned values are ignored. Both sync and async handlers are supported. Errors from either are caught and dispatched as `ErrorEvent` objects via `globalThis.dispatchEvent()` (listen with `globalThis.addEventListener('reportError', handler)`). They do not propagate to the runner or interrupt its operation.

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

> **Event ordering:** `attempt-handled` fires before the runner transitions to its terminal state and before `operation-ended`. If you need to react to the final `runnerState`, use the `operation-ended` event.

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
- **`once(event, callback)`** - Subscribe to an event once; automatically unsubscribes after the first emission. Returns an unsubscribe function.
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

| Error Class                                  | Thrown By / Code          | Description                                                                          | Error Message                                                                                                                                          |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RetryUtilsErrPolicyConfigInvalidStrategy`   | `RetryPolicy` constructor | Invalid strategy provided                                                            | `"Invalid strategy provided."`                                                                                                                         |
| `RetryUtilsErrRunnerAlreadyCompleted`        | `already_completed`       | Operation already finished                                                           | `"The runner has already completed running the operation. Use the .reset() method, and .run() to run the operation again."`                            |
| `RetryUtilsErrRunnerAlreadyRunning`          | `already_running`         | Operation is already in progress                                                     | `"The operation is already running and cannot be started again."`                                                                                      |
| `RetryUtilsErrRunnerCancelPending`           | `cancel_pending`          | A cancellation is in progress                                                        | `"A cancel operation is pending. The operation cannot be started again."`                                                                              |
| `RetryUtilsErrRunnerRetryCanceled`           | `retry_canceled`          | Operation was canceled                                                               | `"The operation was already canceled. Use either .resume(), .forceTry() or .reset() and .run() to run the operation again."`                           |
| `RetryUtilsErrRunnerLastRetryFatallyFailed`  | `fatally_failed`          | Last attempt failed fatally                                                          | `"The last retry attempt failed fatally. The operation cannot be retried. Use either .reset() then .run() or .forceTry() to run the operation again."` |
| `RetryUtilsErrRunnerAttemptsExhausted`       | `attempts_exhausted`      | All retry attempts used                                                              | `"All attempts were exhausted. The operation cannot be retried. Use either .reset() then .run() or .forceTry() to run the operation again."`           |
| `RetryUtilsErrRunnerLockAcquisitionError`    | `lock_error`              | Re-entrant call detected (e.g., calling `run()` from an event listener during setup) | `"Failed to acquire operation lock. Cannot attempt to run the operation."`                                                                             |
| `RetryUtilsErrRunnerNotPaused`               | `not_paused`              | Runner is not in stopped state (for `resume()`)                                      | `"The runner is not in a paused state. resume() can only be called when the runner state is stopped."`                                                 |
| `RetryUtilsErrRunnerNotRunning`              | `not_running`             | Runner has not been started (for `waitForCompletion`)                                | `"The operation is not currently running."`                                                                                                            |
| `RetryUtilsErrRunnerUnknownState`            | Internal                  | Unknown runner state encountered (should not occur in normal usage)                  | `"An unknown runner state was encountered."`                                                                                                           |
| `RetryUtilsErrRunnerForceTryRetryInProgress` | `force_try_in_progress`   | A forced attempt is already running                                                  | `"Force try retry is already in progress."`                                                                                                            |
| `RetryUtilsErrRunnerUnexpectedError`         | `unexpected_error`        | An unexpected internal error occurred                                                | `"An unexpected error occurred."`                                                                                                                      |

> **Note:** All error instances include detailed messages with guidance on how to recover (e.g., which methods to call to resolve the error state).

## Exported Types

The following types are exported for use in consuming code:

| Type                                    | Description                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RetryPolicyOptions`                    | Union of fixed and exponential strategy option interfaces                                                                                            |
| `RetryPolicyOptionsStrategyFixed`       | Options interface for the `'fixed'` strategy                                                                                                         |
| `RetryPolicyOptionsStrategyExponential` | Options interface for the `'exponential'` strategy                                                                                                   |
| `RetryPolicyValidated`                  | `Required<RetryPolicyOptions>` — all options resolved (narrow on `strategy` to access strategy-specific properties)                                  |
| `RetryQueryResult`                      | Return type of `RetryPolicy.shouldRetry()`: `{ shouldRetry: boolean, delayMS: number }`                                                              |
| `RunAttemptStatusCodes`                 | Union of all possible `status` values in `RunResult`                                                                                                 |
| `RunnerErrorCode`                       | Union of all possible `code` values in pre-operation errors                                                                                          |
| `RunResult<T>`                          | Return type of `run()`, `resume()`, `forceTry()`, `waitForCompletion()`. Discriminated union — narrow on `status`                                    |
| `RunResultSuccess<T>`                   | Success branch of `RunResult<T>`: `{ status: 'attempt_success', data?: T }`                                                                          |
| `RunResultNonSuccess`                   | Non-success branch of `RunResult<T>`: `{ status, code?, error?, reattached? }` (`reattached` only present for `status: 'running'` from `forceTry()`) |
| `RunnerState`                           | Union of all runner lifecycle states                                                                                                                 |
| `ReportResult<T>`                       | Type of the `reportResult` callback passed to the operation                                                                                          |
| `ReportResultStatus`                    | Union of report result statuses: `'success' \| 'error' \| 'fatal' \| 'skip'`                                                                         |
| `CancelResult`                          | Return type of `cancel()`: `'canceled' \| 'forced' \| 'not-running'`                                                                                 |
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
