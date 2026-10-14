import { guardAbortListeners } from '../../internal/guarded-abort-signal';
import { PromiseProtectedResolver } from '../../promise-protected-resolver';
import { reportCallbackError } from '../../safe-handle-callback';
import { generateID } from '../../id-helpers';
import { adoptResult, UnreadableReturn } from '../../internal/adopt-promise';
import { renderName } from '../../internal/render-name';
import { isString } from '../../strings';
import { isPlainObject } from '../../is-plain-object';
import { isFunction } from '../../is-function';
import { isBoolean } from '../../is-boolean';
import { toError } from '../../to-error';
import { RetryPolicy } from './retry-policy';
import { toTimerDelayMS } from '../../internal/timer-limits';
import type {
  RetryPolicyOptions,
  RetryPolicyValidated,
  RunAttemptStatusCodes,
  RunnerErrorCode,
} from './types';
import {
  RetryUtilsErrRunnerAlreadyCompleted,
  RetryUtilsErrRunnerAlreadyRunning,
  RetryUtilsErrRunnerAttemptsExhausted,
  RetryUtilsErrRunnerCancelPending,
  RetryUtilsErrRunnerForceTryRetryInProgress,
  RetryUtilsErrRunnerForceTrySuperseded,
  RetryUtilsErrRunnerLastRetryFatallyFailed,
  RetryUtilsErrRunnerLockAcquisitionError,
  RetryUtilsErrRunnerNotPaused,
  RetryUtilsErrRunnerNotRunning,
  RetryUtilsErrRunnerRetryCanceled,
  RetryUtilsErrRunnerTerminalDispatchInProgress,
  RetryUtilsErrRunnerUnexpectedError,
  RetryUtilsErrRunnerUnknownState,
} from './retry-utils-errors';
import { EventEmitterProtected } from '../../event-emitter';

export type ReportResultStatus =
  // Was successful, no need to retry
  | 'success'
  // something went wrong, but it's not fatal, so retry if within the policy
  | 'error'
  // something went wrong, and it's fatal, so don't retry
  | 'fatal'
  // skip this attempt, like if offline and don't want to count it as a failure and reschedule the operation
  | 'skip';

export type ReportResult<T = unknown> = {
  (status: 'success', value?: T): void;
  (status: 'skip', value?: T): void;
  (status: 'error', value?: unknown): void;
  (status: 'fatal', value?: unknown): void;
};

export interface RunResultSuccess<T> {
  status: 'attempt_success';
  data?: T;
}

export interface RunResultNonSuccess {
  status: Exclude<RunAttemptStatusCodes, 'attempt_success'>;
  code?: RunnerErrorCode;
  error?: unknown;
  reattached?: boolean; // Only present when status is 'running' from forceTry()
}

export type RunResult<T> = RunResultSuccess<T> | RunResultNonSuccess;

export type CancelResult =
  'canceled' | 'abandoned' | 'not-running' | 'superseded';

class AttemptContext {
  public handled = false;
  public id: string;
  public startTime: number;
  /** Set before the abort is dispatched, so the operation's listeners already see it. */
  public isAborted = false;
  /**
   * How the attempt was settled: by its own report (or throw), or by the runner -
   * `'abandoned'` when a cancellation's grace period ran out, `'replaced'` when
   * `forceTry({ shouldAbortRunning: true })` replaced it. Names the reason a later report
   * from it is discarded (`report-discarded`).
   */
  public settledAs: 'reported' | 'abandoned' | 'replaced' | null = null;
  private readonly abortController: AbortController;

  constructor() {
    this.id = generateID('ulid');
    this.abortController = new AbortController();
    // An operation's abort listener runs inside `abort()`, where what it throws is the
    // runtime's to report - as an uncaught exception, fatal to a process with no handler.
    guardAbortListeners(
      this.abortController.signal,
      'RetryRunner operation abort listener',
    );
    this.startTime = Date.now();
  }

  public get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Abort this attempt's signal, once; the runner is the only code holding this controller. */
  public abort(): void {
    if (this.isAborted) {
      return;
    }
    this.isAborted = true;
    this.abortController.abort(undefined);
  }
}

export type OperationStartedType = 'initial' | 'resume' | 'force';

export interface OnOperationEndedInfo {
  runnerState: RunnerState;
  timeTakenMS: number;
}

export interface OnOperationStartedInfo {
  operationType: OperationStartedType;
}

export interface OnAttemptStartedInfo {
  attemptID: string;
  operationTimeElapsedMS: number;
  attemptTimeElapsedMS: number;
}

/** Why a report or throw from an attempt was discarded; see `report-discarded`. */
export type ReportDiscardedReason =
  'already-reported' | 'abandoned' | 'replaced';

export interface OnReportDiscardedInfo {
  attemptID: string;
  /**
   * The status passed to `reportResult`, `'invalid'` for a value that is not one of
   * them, or `'throw'` for a throw (or a returned value whose `then` could not be read).
   */
  status: ReportResultStatus | 'invalid' | 'throw';
  /** The reported data or error, or what was thrown. */
  value: unknown;
  reason: ReportDiscardedReason;
}

export interface OnAttemptHandledInfo<T> {
  attemptID: string;
  status: ReportResultStatus;
  operationTimeElapsedMS: number;
  attemptTimeElapsedMS: number;
  data?: T;
  error?: unknown;
  wasCanceled: boolean;
}

// Event names
export const OPERATION_STARTED = 'operation-started';
export const OPERATION_ENDED = 'operation-ended';
export const ATTEMPT_STARTED = 'attempt-started';
export const ATTEMPT_HANDLED = 'attempt-handled';
export const REPORT_DISCARDED = 'report-discarded';

export interface RetryRunnerOptions<T = unknown> {
  operationLabel?: string;
  onOperationStarted?: (info: OnOperationStartedInfo) => void;
  onOperationEnded?: (info: OnOperationEndedInfo) => void;
  onAttemptStarted?: (info: OnAttemptStartedInfo) => void;
  onAttemptHandled?: (info: OnAttemptHandledInfo<T>) => void;
  onReportDiscarded?: (info: OnReportDiscardedInfo) => void;
}

export interface ForceTryOptions {
  shouldWaitForCompletion?: boolean;
  shouldAbortRunning?: boolean;
}

export type RunnerState =
  | 'not-started'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'completed'
  | 'exhausted'
  | 'fatal-error';

interface RetryRunnerCurrentState {
  // Mutable runtime state for the currently scheduled/active operation.
  runnerState: RunnerState;
  // Tracks if the last attempt was triggered by forceTry().
  lastAttemptWasForceTry: boolean;
  // Context for the currently running attempt (null if none).
  currentAttemptContext?: AttemptContext | null;
  // Timer handle for scheduled retry delays.
  retryTimeoutHandle: ReturnType<typeof setTimeout> | null;
  // Timestamp when the retry timeout was started.
  retryTimeoutStartTime: number | null;
  // Planned delay duration for the pending retry.
  retryTimeoutDelayMS: number | null;
  // Grace period timer for cancellation acknowledgment.
  cancellationTimeoutHandle: ReturnType<typeof setTimeout> | null;
  // Timestamp when the current operation started.
  operationStartTime: number | null;
  // Frozen time taken value for terminal states (null while running).
  finalTimeTakenMS: number | null;
  // Cached duration of the last completed attempt.
  lastAttemptTimeTakenMS: number;
  // How the last settled attempt was settled (`AttemptContext.settledAs`). A cancel
  // that finds no attempt right after one was replaced without acknowledging its abort
  // resolves 'abandoned': that operation may still be running.
  lastAttemptSettledAs: AttemptContext['settledAs'];
}

interface TerminalOutcomeResolveInfo<T> {
  status: RunAttemptStatusCodes;
  code?: RunnerErrorCode;
  data?: T;
  error?: unknown;
}

/** Whether `status` is one `reportResult` accepts; a caller's value is not trusted. */
function isReportResultStatus(status: unknown): status is ReportResultStatus {
  return (
    status === 'success' ||
    status === 'error' ||
    status === 'fatal' ||
    status === 'skip'
  );
}

/**
 * The value a report carried, chosen by the key it used rather than by nullishness, so
 * a reported `null` stays `null`.
 */
function reportedValueOf(valueInfo: {
  data?: unknown;
  error?: unknown;
}): unknown {
  return 'error' in valueInfo ? valueInfo.error : valueInfo.data;
}

/** The outcome of an operation ended by a failure in the runner's own machinery. */
function unexpectedFatal<T>(error: unknown): TerminalOutcomeResolveInfo<T> {
  return { status: 'attempt_fatal', code: 'unexpected_error', error };
}

export class RetryRunner<T = unknown> extends EventEmitterProtected {
  // Human-readable label for debugging/logging purposes.
  private _operationLabel = 'Unnamed Operation';
  // Retry policy that determines retry behavior and tracks state.
  private policy: RetryPolicy;
  // Prevents concurrent run/resume/forceTry calls.
  private _isOperationLocked = false;
  // Terminal events run before their completion promise is resolved. Reentrant
  // reset/forceTry must wait until that old operation finishes publishing.
  private terminalDispatchDepth = 0;
  // A forced restart can retain the completion resolver for existing waiters.
  // Ownership therefore needs an identity independent of that shared promise.
  private operationToken = Symbol();
  // A newer stop request made by an abort listener takes precedence over the
  // force request that invoked it, even if cancellation settles synchronously
  // or the listener's own report already ended the operation.
  private stopRequestToken = Symbol();
  // Mutable runtime state for the current operation.
  private currentState: RetryRunnerCurrentState = this.getEmptyCurrentState();
  // Grace period for cancellation before we force-complete.
  private _gracePeriodMS = 1000;

  // User-provided operation to retry on failure.
  private operation: (
    reportResult: ReportResult<T>,
    signal: AbortSignal,
  ) => void | Promise<void>;

  // Resolver for the current run/resume/forceTry operation.
  private currentOperationResolver!: PromiseProtectedResolver<RunResult<T>>;
  // Resolvers for pending cancel() calls.
  private cancelResolvers = new Set<PromiseProtectedResolver<CancelResult>>();

  public get operationLabel(): string {
    return this._operationLabel;
  }

  public get runnerState(): RunnerState {
    return this.currentState.runnerState;
  }

  public get timeTakenMS(): number {
    if (this.currentState.finalTimeTakenMS !== null) {
      return this.currentState.finalTimeTakenMS;
    } else if (this.currentState.operationStartTime !== null) {
      return Date.now() - this.currentState.operationStartTime;
    }

    // -1 indicates the operation has not started.
    return -1;
  }

  public get attemptTimeTakenMS(): number {
    if (
      this.currentState.currentAttemptContext instanceof AttemptContext &&
      !this.currentState.currentAttemptContext.handled
    ) {
      return Date.now() - this.currentState.currentAttemptContext.startTime;
    }

    // Return the last completed attempt duration, or -1 if no attempt has run yet.
    return this.currentState.lastAttemptTimeTakenMS;
  }

  public get retryTimeRemaining(): number {
    if (
      this.currentState.retryTimeoutHandle !== null &&
      this.currentState.retryTimeoutStartTime !== null &&
      this.currentState.retryTimeoutDelayMS !== null
    ) {
      const elapsed = Date.now() - this.currentState.retryTimeoutStartTime;
      const remaining = this.currentState.retryTimeoutDelayMS - elapsed;
      // Clamp to 0 if elapsed time exceeded delay.
      return Math.max(0, remaining);
    } else {
      // -1 indicates no retry is pending.
      return -1;
    }
  }

  /**
   * Whether `forceTry()` would be accepted now. Refused, whatever the state, while the
   * current operation publishes its terminal outcome (`terminal_dispatch_in_progress`,
   * e.g. from an `attempt-handled` listener for a terminal report or an `operation-ended`
   * listener) or while another `run()` / `resume()` / `forceTry()` call holds the lock
   * (`lock_error`), so it never reads `true` where `forceTry()` would refuse.
   *
   * Accepted is not "starts an attempt": with an attempt in flight - including while
   * `'stopping'` - the default `forceTry()` attaches to it (`reattached: true`) and a
   * pending cancellation still ends `'stopped'`. It reads no options, so it cannot
   * foresee `shouldAbortRunning: true` refusing with `force_try_in_progress`.
   */
  public get canForceTry(): boolean {
    if (this.terminalDispatchDepth > 0 || this._isOperationLocked) {
      return false;
    }

    // The only state `forceTry()` refuses.
    return this.currentState.runnerState !== 'completed';
  }

  public get wasLastAttemptForced(): boolean {
    return this.currentState.lastAttemptWasForceTry;
  }

  public get errors(): unknown[] {
    return this.policy.errors;
  }

  public get wasInitialAttemptTaken(): boolean {
    return this.policy.wasInitialAttemptTaken;
  }

  public get areAttemptsExhausted(): boolean {
    return this.policy.areAttemptsExhausted;
  }

  public get attempts(): number {
    return this.policy.attempts;
  }

  public get mostCommonError(): unknown {
    return this.policy.mostCommonError;
  }

  public get lastError(): unknown {
    return this.policy.lastError;
  }

  public get maxRetryAttempts(): number {
    return this.policy.maxRetryAttempts;
  }

  public get policyInfo(): RetryPolicyValidated {
    return this.policy.policyInfo;
  }

  public get retryCount(): number {
    return this.policy.retryCount;
  }

  public get wasSuccessful(): boolean {
    return this.policy.wasSuccessful;
  }

  public get isRetryPending(): boolean {
    return this.currentState.retryTimeoutHandle !== null;
  }

  public get isOperationRunning(): boolean {
    return (
      this.currentState.runnerState === 'running' ||
      this.currentState.runnerState === 'stopping'
    );
  }

  public get isAttemptRunning(): boolean {
    if (this.currentState.currentAttemptContext instanceof AttemptContext) {
      return !this.currentState.currentAttemptContext.handled;
    } else {
      return false;
    }
  }

  public get graceCancelPeriodMS(): number {
    return this._gracePeriodMS;
  }

  constructor(
    policy: RetryPolicyOptions,
    operation: (
      reportResult: ReportResult<T>,
      signal: AbortSignal,
    ) => void | Promise<void>,
    options?: RetryRunnerOptions<T>,
  ) {
    super();

    this.policy = new RetryPolicy(policy);

    // Refused here, like an invalid policy, rather than every attempt's call throwing a
    // `TypeError` that is retried through the whole budget.
    if (!isFunction(operation)) {
      throw new TypeError(
        `RetryRunner operation must be a function, got: ${typeof operation}`,
      );
    }
    this.operation = operation;

    // Handle options
    if (isPlainObject(options)) {
      // Caller options may be getters. Each field is read exactly once, into a local
      // that is both checked and used: a second read could return a different value,
      // registering a non-function the check never saw.
      const operationLabel: unknown = options.operationLabel;
      if (isString(operationLabel)) {
        this._operationLabel = operationLabel;
      }

      // subscribe the event handlers. Anything that is not callable is ignored.
      const hooks: Array<[event: string, hook: unknown]> = [
        [OPERATION_STARTED, options.onOperationStarted],
        [OPERATION_ENDED, options.onOperationEnded],
        [ATTEMPT_STARTED, options.onAttemptStarted],
        [ATTEMPT_HANDLED, options.onAttemptHandled],
        [REPORT_DISCARDED, options.onReportDiscarded],
      ];

      for (const [event, hook] of hooks) {
        if (isFunction(hook)) {
          this.on(event, hook as (data: unknown) => void);
        }
      }
    }
  }

  /**
   * Set the grace period for cancellation in milliseconds
   *
   * Overrides the default grace period of 1000ms
   * Invalid values throw. Infinity and oversized values use the runtime timer ceiling.
   * Use 0 to force-cancel on the next timer turn: a zero-length timer is still armed, so an
   * attempt that acknowledges the abort before it fires (synchronously or in a microtask)
   * still settles the cancellation as `'canceled'` rather than `'abandoned'`.
   */

  public overrideGraceCancelPeriodMS(value: number): void {
    this._gracePeriodMS = toTimerDelayMS(value, 'Cancellation grace period');
  }

  public async waitForCompletion(): Promise<RunResult<T>> {
    switch (this.currentState.runnerState) {
      case 'completed':
      case 'exhausted':
      case 'fatal-error':
      case 'stopped':
      case 'running':
      case 'stopping':
        // Completed operations retain their result; active operations await it.
        return await this.currentOperationResolver.promise;
      case 'not-started':
        // If the operation has not started yet, return an appropriate result
        return {
          status: 'not_started',
          code: 'not_running',
          error: new RetryUtilsErrRunnerNotRunning('waitForCompletion'),
        };
      default:
        throw new RetryUtilsErrRunnerUnknownState(
          'waitForCompletion',
          this.currentState.runnerState,
        );
    }
  }

  public async run(shouldWaitForCompletion = false): Promise<RunResult<T>> {
    return await this.runOperation(shouldWaitForCompletion);
  }

  public async cancel(): Promise<CancelResult> {
    // Stop intent is recorded whatever this call then returns, as reset() records it.
    // Only abortAttemptAndReadOwnership() reads it, comparing the token across its own
    // synchronous abort dispatch, so outside that window the change is inert. Inside it,
    // an abort listener that reports fatal (or exhausts the budget) and then cancels has
    // already ended the operation, so there is nothing left to cancel and this returns
    // 'not-running' - but the forceTry({ shouldAbortRunning: true }) that dispatched the
    // abort must still not start a replacement its caller just asked to stop. The runner
    // is terminal there just as it is when idle, so the token changes on every call. A
    // committed success is the one exception: forceTry() can never revive a completed
    // operation, and it reports that more precisely as already_completed.
    if (!this.policy.wasSuccessful) {
      this.stopRequestToken = Symbol();
    }
    // The attempt has already chosen a terminal result, even though its handled
    // event still presents the pre-terminal state to listeners.
    if (
      this.terminalDispatchDepth > 0 &&
      this.currentState.runnerState === 'running'
    ) {
      return 'not-running';
    }
    // operation is either running or stopping (so just wait to cancel it here)
    if (this.isOperationRunning) {
      const cancellationPromiseProtectedResolver =
        new PromiseProtectedResolver<CancelResult>();

      this.cancelResolvers.add(cancellationPromiseProtectedResolver);

      // Check if cancellation is already pending to avoid multiple abort signals
      if (this.currentState.runnerState !== 'stopping') {
        this.currentState.runnerState = 'stopping';

        this.cleanupTimers();

        if (
          !this.currentState.currentAttemptContext ||
          this.currentState.currentAttemptContext.handled
        ) {
          // No active attempt, can confirm immediately.
          this.confirmStoppedWithoutAttempt();
        } else {
          // Signal the running attempt to abort.
          const context = this.currentState.currentAttemptContext;
          context.abort();

          // Grace period: if operation doesn't acknowledge abort, force it.
          // An abort listener may call reportResult synchronously, settling this
          // cancellation before abort() returns. In that case there is no timer to arm.
          if (
            this.currentState.runnerState === 'stopping' &&
            this.currentState.currentAttemptContext === context &&
            !context.handled
          ) {
            try {
              this.currentState.cancellationTimeoutHandle = setTimeout(() => {
                this.forceCancellation(context);
              }, this._gracePeriodMS);
            } catch (error) {
              // A missing timer cannot leave cancellation pending indefinitely. Reported
              // first, so listeners of the forced outcome are not ahead of its cause.
              reportCallbackError('RetryRunner cancellation timer', error);
              this.forceCancellation(context);
            }
          }
        }
      }

      // return the promise
      return await cancellationPromiseProtectedResolver.promise;
    } else {
      return 'not-running';
    }
  }

  public async reset(): Promise<void> {
    // Record stop intent before awaiting cancellation. A later operation may
    // supersede this reset, but an older force request must still yield to it.
    this.stopRequestToken = Symbol();
    const operationToken = this.operationToken;
    if (this.terminalDispatchDepth > 0) {
      await this.currentOperationResolver.promise;
      // A terminal listener's reset belongs to that operation, not a replacement
      // started while its continuation was queued.
      if (this.operationToken !== operationToken) {
        return;
      }
    }
    // If an operation is running or pending stopping, cancel it first.
    if (this.isOperationRunning) {
      // Cancel any in-flight work before resetting state.
      await this.cancel();
      if (this.operationToken !== operationToken) {
        return;
      }
    }

    // Reset the internal state to its initial values.
    this.currentState = this.getEmptyCurrentState();

    // Also, reset the policy itself if needed.
    this.policy.reset();
  }

  public async resume(shouldWaitForCompletion = false): Promise<RunResult<T>> {
    return await this.resumeOperation(shouldWaitForCompletion);
  }

  public async forceTry(options?: ForceTryOptions): Promise<RunResult<T>> {
    return await this.forceTryOperation(options);
  }

  /**
   * Abort dispatch runs caller code synchronously. Capture its operation first,
   * then read ownership after listeners finish. Consume this snapshot without
   * another callback or await; cancel and forceTry apply their own outcome rules.
   */
  private abortAttemptAndReadOwnership(context: AttemptContext): {
    operationResolver: PromiseProtectedResolver<RunResult<T>>;
    hasNewStopRequest: boolean;
  } {
    const operationResolver = this.currentOperationResolver;
    const stopRequestToken = this.stopRequestToken;
    context.abort();
    if (
      this.stopRequestToken === stopRequestToken &&
      this.currentState.currentAttemptContext === context &&
      !context.handled
    ) {
      // A silent abort still ends an attempt. Publish its accounting before its
      // replacement, without consulting retry policy or spending the retry budget.
      this.settleAbortedAttempt(context, 'replaced');
    }
    return {
      operationResolver,
      hasNewStopRequest: this.stopRequestToken !== stopRequestToken,
    };
  }

  /**
   * End a cancellation whose grace period ran out: `context` has not acknowledged its
   * abort, and is still the current attempt of a runner that is stopping.
   */
  private forceCancellation(context: AttemptContext): void {
    if (
      this.currentState.currentAttemptContext !== context ||
      context.handled ||
      this.currentState.runnerState !== 'stopping'
    ) {
      return;
    }

    // The scope covers `attempt-handled`, not only the `publishTerminalOutcome` inside it
    // (which opens its own): a listener for this forced skip must not start a
    // replacement before the `'stopped'` outcome is published.
    this.withTerminalDispatch(true, () => {
      this.settleAbortedAttempt(context, 'abandoned');
      this.publishTerminalOutcome('stopped', { status: 'canceled' }, true);
    });
  }

  /**
   * End an aborted attempt that never reported, as the forced cancellation and the
   * force-abort replacement both do: detach it, clear timers so `attempt-handled`
   * listeners see none pending (as for a reported attempt), record its duration and
   * publish it as a canceled `'skip'`. Consults no retry policy and spends no budget.
   */
  private settleAbortedAttempt(
    context: AttemptContext,
    settledAs: 'abandoned' | 'replaced',
  ): void {
    context.handled = true;
    context.settledAs = settledAs;
    this.currentState.lastAttemptSettledAs = settledAs;
    this.currentState.currentAttemptContext = null;
    this.cleanupTimers();
    const attemptTimeElapsedMS = Date.now() - context.startTime;
    this.currentState.lastAttemptTimeTakenMS = attemptTimeElapsedMS;
    this.emit(ATTEMPT_HANDLED, {
      attemptID: context.id,
      status: 'skip',
      data: undefined,
      error: undefined,
      operationTimeElapsedMS: this.timeTakenMS,
      attemptTimeElapsedMS,
      wasCanceled: true,
    } satisfies OnAttemptHandledInfo<T>);
  }

  /** Claim new work, optionally retaining the result promise for existing waiters. */
  private beginOperation(
    shouldKeepPendingResolver = false,
  ): PromiseProtectedResolver<RunResult<T>> {
    this.operationToken = Symbol();
    // How an earlier attempt settled says nothing about the attempt this operation starts
    // next (at once, for a new operation or a force-abort replacement continuing one).
    this.currentState.lastAttemptSettledAs = null;
    if (
      !shouldKeepPendingResolver ||
      !this.currentOperationResolver ||
      this.currentOperationResolver.hasResolved
    ) {
      this.currentOperationResolver = new PromiseProtectedResolver<
        RunResult<T>
      >();
    }
    return this.currentOperationResolver;
  }

  /**
   * The one admission path for run(), resume() and forceTry(). A terminal publication
   * refuses first, then the lock. The lock covers synchronous dispatch only, never the
   * caller's wait for completion: `dispatch` returns that promise without awaiting it,
   * so the public async wrappers await only after this finally released the lock.
   */
  private dispatchUnderLock(
    methodName: 'run' | 'resume' | 'forceTry',
    dispatch: () => RunResult<T> | Promise<RunResult<T>>,
  ): RunResult<T> | Promise<RunResult<T>> {
    if (this.terminalDispatchDepth > 0) {
      return this.terminalDispatchRefusal(methodName);
    }
    if (this._isOperationLocked) {
      return {
        status: 'pre_operation_error',
        code: 'lock_error',
        error: new RetryUtilsErrRunnerLockAcquisitionError(methodName),
      };
    }

    // Lock prevents concurrent run/resume/forceTry calls from stepping on each other.
    this._isOperationLocked = true;

    try {
      return dispatch();
    } catch (error) {
      // handle error unexpected when starting the operation
      return {
        status: 'pre_operation_error',
        code: 'unexpected_error',
        error: new RetryUtilsErrRunnerUnexpectedError(
          methodName,
          toError(error),
        ),
      };
    } finally {
      // Always release the lock.
      this._isOperationLocked = false;
    }
  }

  /**
   * Start the first attempt of an operation, under the caller's lock. The re-entrancy
   * recheck lives here once: an `operation-started` listener is the only caller code
   * between claiming the operation and its first attempt, and it may cancel or reset it.
   *
   * A forced restart keeps an unresolved completion promise for the callers already
   * waiting on it. Continuing an operation (forcing a replacement while it is running or
   * stopping) also keeps its start time and announces no second `operation-started`.
   *
   * A non-waiting call reports the dispatch, not the outcome, so it returns the
   * running-shaped result even when the listener has already stopped the operation: its
   * caller reads `canceled` from `waitForCompletion()` like any other outcome, and
   * `forceTry()` always carries `reattached`.
   */
  private startOperation(
    operationType: OperationStartedType,
    shouldWaitForCompletion: boolean,
    isContinuingOperation = false,
  ): RunResult<T> | Promise<RunResult<T>> {
    const wasForced = operationType === 'force';
    const operationResolver = this.beginOperation(wasForced);
    this.currentState.runnerState = 'running';
    let wasStoppedByListener = false;

    if (!isContinuingOperation) {
      // Start timing
      this.currentState.operationStartTime = Date.now();
      this.currentState.finalTimeTakenMS = null;

      this.emit(OPERATION_STARTED, { operationType });
      wasStoppedByListener = this.currentState.runnerState !== 'running';
    }

    if (!wasStoppedByListener) {
      void this.attemptOperation(wasForced);
    }

    if (shouldWaitForCompletion) {
      return operationResolver.promise;
    } else if (wasForced) {
      return { status: 'running', reattached: false };
    } else {
      return { status: 'running' };
    }
  }

  private runOperation(
    shouldWaitForCompletion: boolean,
  ): RunResult<T> | Promise<RunResult<T>> {
    return this.dispatchUnderLock('run', () => {
      assertBooleanOption(
        'run() shouldWaitForCompletion',
        shouldWaitForCompletion,
      );
      // check if in a disallowed state for this operation
      const checkDisallowedStates = this.refuseForState('run');

      if (checkDisallowedStates) {
        return checkDisallowedStates;
      } else if (this.policy.shouldDoFirstTry()) {
        return this.startOperation('initial', shouldWaitForCompletion);
      } else {
        return {
          status: 'pre_operation_error',
          code: 'unexpected_error',
          error: new RetryUtilsErrRunnerUnexpectedError(
            'run',
            new Error(
              'Not first try, but this should had been caught before this point',
            ),
          ),
        };
      }
    });
  }

  private resumeOperation(
    shouldWaitForCompletion: boolean,
  ): RunResult<T> | Promise<RunResult<T>> {
    return this.dispatchUnderLock('resume', () => {
      assertBooleanOption(
        'resume() shouldWaitForCompletion',
        shouldWaitForCompletion,
      );
      // check if in a disallowed state for this operation
      const checkDisallowedStates = this.refuseForState('resume');

      if (checkDisallowedStates) {
        return checkDisallowedStates;
      } else if (this.currentState.runnerState !== 'stopped') {
        return {
          status: 'pre_operation_error',
          code: 'not_paused',
          error: new RetryUtilsErrRunnerNotPaused('resume'),
        };
      } else {
        // Resume from the paused/stopped state.
        return this.startOperation('resume', shouldWaitForCompletion);
      }
    });
  }

  private forceTryOperation(
    options?: ForceTryOptions,
  ): RunResult<T> | Promise<RunResult<T>> {
    return this.dispatchUnderLock('forceTry', () => {
      const shouldWaitForCompletion = options?.shouldWaitForCompletion;
      const shouldAbortRunning = options?.shouldAbortRunning;
      assertBooleanOption(
        'forceTry() shouldWaitForCompletion',
        shouldWaitForCompletion,
      );
      assertBooleanOption('forceTry() shouldAbortRunning', shouldAbortRunning);
      const refusal = this.alreadyCompletedRefusal('forceTry');
      if (refusal) {
        return refusal;
      }

      // If an attempt is already running and we don't want to abort it,
      // just attach to the current operation. This includes 'stopping': the
      // pending cancellation is left to finish, so a waiting caller receives
      // its 'canceled' result.
      if (this.isAttemptRunning && !shouldAbortRunning) {
        if (shouldWaitForCompletion) {
          return this.currentOperationResolver.promise;
        } else {
          return { status: 'running', reattached: true };
        }
      }

      // Prevent double-forcing the same attempt when aborting.
      if (this.isAttemptRunning && this.currentState.lastAttemptWasForceTry) {
        return {
          status: 'pre_operation_error',
          code: 'force_try_in_progress',
          error: new RetryUtilsErrRunnerForceTryRetryInProgress('forceTry'),
        };
      }

      // If an attempt is currently running and we want to abort it, do so.
      const runningContext = this.currentState.currentAttemptContext;
      if (runningContext instanceof AttemptContext && !runningContext.handled) {
        const { operationResolver, hasNewStopRequest } =
          this.abortAttemptAndReadOwnership(runningContext);
        // A cancel/reset requested inside abort is newer than this force request.
        // Waiting calls join its outcome; non-waiting calls report supersession
        // immediately. Neither revives work the newer request wants stopped.
        if (hasNewStopRequest) {
          // Forcing during 'stopping' settled the aborted attempt, detaching it and
          // clearing the grace timer that would have finished the pending cancellation;
          // a cancel() from that settlement's attempt-handled listener only joined it.
          // Settle it here, or the cancel()/reset() calls joined to it never resolve.
          if (
            this.currentState.runnerState === 'stopping' &&
            this.currentState.currentAttemptContext === null
          ) {
            this.confirmStoppedWithoutAttempt();
          }
          return shouldWaitForCompletion
            ? operationResolver.promise
            : {
                status: 'pre_operation_error',
                code: 'force_try_superseded',
                error: new RetryUtilsErrRunnerForceTrySuperseded('forceTry'),
              };
        }
        const afterAbort = this.alreadyCompletedRefusal('forceTry');
        if (afterAbort) {
          // The call was admitted before abort completed this operation.
          // Waiting callers retain its result; no replacement is started.
          return shouldWaitForCompletion
            ? operationResolver.promise
            : afterAbort;
        }
      }

      // Branch on the live post-abort state: skip/error may have scheduled a
      // retry, while fatal/exhaustion may have settled the previous resolver.
      // Case 1: Retry is scheduled (pending timeout), force it to run now.
      // This starts a NEW ATTEMPT (attempt timer resets) but keeps the SAME OPERATION
      // (operation timer continues - we're just accelerating a scheduled retry, not starting over).
      // Only while `running`: `attemptOperation` does nothing in any other state, so
      // accelerating a timer there would report `running` for an attempt never started.
      if (
        this.currentState.runnerState === 'running' &&
        this.currentState.retryTimeoutHandle !== null
      ) {
        this.clearRetryTimer();

        // Marks the attempt forced: the runner is `running`, so it starts one.
        void this.attemptOperation(true);

        if (shouldWaitForCompletion) {
          return this.currentOperationResolver.promise;
        } else {
          return { status: 'running', reattached: false };
        }
      }

      // Every path that leaves `running` clears the retry timer, so none should exist
      // here. Clearing it anyway keeps a stray one from firing into the attempt below.
      this.clearRetryTimer();

      // Case 2: No pending retry, start a brand-new forced attempt. startOperation()
      // gives it a new identity, since the abort above has already dispatched caller
      // code: resets from that old attempt must leave the accepted restart alone.
      const isContinuingOperation = this.isOperationRunning;
      if (this.currentState.runnerState === 'not-started') {
        // Treat as a first try so the policy tracks the initial attempt.
        this.policy.shouldDoFirstTry();
      } else if (
        this.currentState.runnerState === 'stopping' ||
        this.currentState.runnerState === 'stopped'
      ) {
        this.supersedePendingCancellation();
      }

      return this.startOperation(
        'force',
        shouldWaitForCompletion ?? false,
        isContinuingOperation,
      );
    });
  }

  /**
   * Returning a fresh copy of the current state
   * to be immutable and not changed by the caller
   */

  private getEmptyCurrentState(): RetryRunnerCurrentState {
    return {
      runnerState: 'not-started',
      lastAttemptWasForceTry: false,
      currentAttemptContext: null,
      retryTimeoutHandle: null,
      retryTimeoutStartTime: null,
      retryTimeoutDelayMS: null,
      cancellationTimeoutHandle: null,
      operationStartTime: null,
      finalTimeTakenMS: null,
      lastAttemptTimeTakenMS: -1,
      lastAttemptSettledAs: null,
    };
  }

  /** The `already_completed` refusal, when the runner has completed. */
  private alreadyCompletedRefusal(
    methodName: 'run' | 'resume' | 'forceTry',
  ): RunResult<T> | undefined {
    if (this.currentState.runnerState !== 'completed') {
      return undefined;
    }
    return {
      status: 'pre_operation_error',
      code: 'already_completed',
      error: new RetryUtilsErrRunnerAlreadyCompleted(methodName),
    };
  }

  /**
   * The refusal for `run()` or `resume()` in the runner's current state, or `undefined`
   * when it may start. `resume()` is the way out of `'stopped'`, so only `run()` is
   * refused there; either is refused once the retry budget is spent, whatever the state.
   */
  private refuseForState(
    methodName: 'run' | 'resume',
  ): RunResult<T> | undefined {
    const completed = this.alreadyCompletedRefusal(methodName);
    if (completed) {
      return completed;
    }

    switch (this.currentState.runnerState) {
      case 'running':
        return {
          status: 'pre_operation_error',
          code: 'already_running',
          error: new RetryUtilsErrRunnerAlreadyRunning(methodName),
        };
      case 'stopping':
        return {
          status: 'pre_operation_error',
          code: 'cancel_pending',
          error: new RetryUtilsErrRunnerCancelPending(methodName),
        };
      case 'stopped':
        if (methodName === 'run') {
          return {
            status: 'pre_operation_error',
            code: 'retry_canceled',
            error: new RetryUtilsErrRunnerRetryCanceled(methodName),
          };
        }
        break;
      case 'fatal-error':
        return {
          status: 'pre_operation_error',
          code: 'fatally_failed',
          error: new RetryUtilsErrRunnerLastRetryFatallyFailed(methodName),
        };
    }

    if (
      this.currentState.runnerState === 'exhausted' ||
      this.policy.areAttemptsExhausted
    ) {
      return {
        status: 'pre_operation_error',
        code: 'attempts_exhausted',
        error: new RetryUtilsErrRunnerAttemptsExhausted(methodName),
      };
    }

    return undefined;
  }

  /**
   * Clear the pending retry timer, if any, and the bookkeeping that describes it.
   * Clearing a timer that has already fired is a no-op, so the timer's own callback
   * uses this too.
   */
  private clearRetryTimer(): void {
    if (this.currentState.retryTimeoutHandle !== null) {
      clearTimeout(this.currentState.retryTimeoutHandle);
    }

    this.currentState.retryTimeoutHandle = null;
    this.currentState.retryTimeoutStartTime = null;
    this.currentState.retryTimeoutDelayMS = null;
  }

  private cleanupTimers(): void {
    // Clear any pending retry or cancellation timers.
    this.clearRetryTimer();

    if (this.currentState.cancellationTimeoutHandle) {
      clearTimeout(this.currentState.cancellationTimeoutHandle);
      this.currentState.cancellationTimeoutHandle = null;
    }
  }

  /**
   * A terminal listener cannot start new work before the committed outcome settles:
   * a replacement would publish over the result existing waiters are about to receive.
   * Not a lock failure - nothing is contended - so it has its own code.
   */
  private terminalDispatchRefusal(
    methodName: 'run' | 'resume' | 'forceTry',
  ): RunResult<T> {
    return {
      status: 'pre_operation_error',
      code: 'terminal_dispatch_in_progress',
      error: new RetryUtilsErrRunnerTerminalDispatchInProgress(methodName),
    };
  }

  /** Keep terminal notifications and result publication in one reentry scope. */
  private withTerminalDispatch(
    isTerminal: boolean,
    dispatch: () => void,
  ): void {
    if (isTerminal) {
      this.terminalDispatchDepth++;
    }
    try {
      dispatch();
    } finally {
      if (isTerminal) {
        this.terminalDispatchDepth--;
      }
    }
  }

  /**
   * Move a stopping or stopped runner back to `running` for a forced restart. Pending
   * `cancel()` callers resolve `'superseded'`; nothing here runs caller code.
   */
  private supersedePendingCancellation(): void {
    this.cleanupTimers();
    this.currentState.runnerState = 'running';

    this.resolvePendingCancels('superseded');
  }

  /** Answer every pending `cancel()` call with `result`. */
  private resolvePendingCancels(result: CancelResult): void {
    for (const resolver of this.cancelResolvers) {
      resolver.resolveOnce(result);
    }
    this.cancelResolvers.clear();
  }

  /** Whether a cancellation is pending or has stopped the operation. */
  private get isCanceledOrPendingCancel(): boolean {
    return (
      this.currentState.runnerState === 'stopping' ||
      this.currentState.runnerState === 'stopped'
    );
  }

  /**
   * End a cancellation that has no attempt left to wait for. `'abandoned'` when the last
   * attempt was replaced without acknowledging its abort - a cancel() from its
   * attempt-handled listener while forceTry dispatches - since it may still be running;
   * `'canceled'` otherwise.
   */
  private confirmStoppedWithoutAttempt(): void {
    this.publishTerminalOutcome(
      'stopped',
      { status: 'canceled' },
      this.currentState.lastAttemptSettledAs === 'replaced',
    );
  }

  private publishTerminalOutcome(
    runnerState: Exclude<RunnerState, 'running'>,
    resolveInfo: TerminalOutcomeResolveInfo<T>,
    wasAbandoned = false,
  ): void {
    this.withTerminalDispatch(true, () => {
      // Resolve cancel promises and finalize operation state transitions.
      if (this.currentState.runnerState === 'stopping') {
        this.cleanupTimers();

        this.currentState.runnerState = runnerState;

        // resolve all cancel promises
        this.resolvePendingCancels(
          runnerState !== 'stopped'
            ? 'not-running'
            : wasAbandoned
              ? 'abandoned'
              : 'canceled',
        );
      } else {
        this.currentState.runnerState = runnerState;
      }

      // Freeze timeTakenMS for terminal states
      this.currentState.finalTimeTakenMS =
        this.currentState.operationStartTime !== null
          ? Date.now() - this.currentState.operationStartTime
          : -1;

      // emit the operation ended event
      this.emit(OPERATION_ENDED, {
        runnerState,
        timeTakenMS: this.timeTakenMS,
      });

      if (resolveInfo.status === 'attempt_success') {
        this.currentOperationResolver.resolveOnce({
          status: 'attempt_success',
          ...(resolveInfo.data !== undefined ? { data: resolveInfo.data } : {}),
        });
      } else {
        const nonSuccessResult: RunResultNonSuccess = {
          status: resolveInfo.status,
        };

        if (resolveInfo.code !== undefined) {
          nonSuccessResult.code = resolveInfo.code;
        }

        if (resolveInfo.error !== undefined) {
          nonSuccessResult.error = resolveInfo.error;
        }

        this.currentOperationResolver.resolveOnce(nonSuccessResult);
      }
    });
  }

  private handleReportResult(
    context: AttemptContext,
    status: ReportResultStatus,
    valueInfo: {
      data?: T;
      error?: unknown;
    },
    // Where an outcome that did not come through `reportResult` came from: `'throw'` from
    // the `catch` around `this.operation`, or the `UnreadableReturn` for a returned value
    // whose `then` could not be read. Both are routed here as `'error'`. It changes
    // nothing about how a live attempt is handled and only names the already-settled case
    // correctly: an operation that reports its outcome and *then* throws - or returns a
    // malformed thenable - never called `reportResult` twice, so telling its author that a
    // second report "arrived after the attempt was settled" points at code they did not
    // write, and a malformed return is not a throw either (the distinction
    // `safe-handle-callback` and `failure-reporter` keep with `UnreadableReturn`). The
    // failure is still reported - a failure after a successful report is exactly the kind
    // that otherwise disappears - it is simply reported as what it is.
    source: 'report' | 'throw' | UnreadableReturn = 'report',
  ): void {
    // Guard against multiple calls to reportResult
    if (
      // Ensure the context is the current one. Replaced aborted attempts have
      // already been handled; their late reports must still be discarded.
      this.currentState.currentAttemptContext !== context ||
      // Ensure the result hasn't already been handled
      context.handled
    ) {
      // Discarding is right - the attempt is over and its outcome is already recorded -
      // but not silently: `ReportResult` returns `void`, so an operation that reported
      // twice, or reported its real failure after the runner had moved on, has no other
      // way to learn its outcome went nowhere. A double report is a caller bug that should
      // not have to be inferred from a missing event.
      //
      // Reported on the global `'error'` channel rather than through this runner's
      // lifecycle events, deliberately: the attempt this belongs to has been settled, so
      // emitting `attempt-handled` for it now would be inventing a lifecycle event out of
      // order. Every discard - this reported one or the silent ones below - is also
      // published as `report-discarded`, which is not part of that lifecycle.
      //
      // Only for an attempt that was *not* aborted, which is what separates a caller bug
      // from this API's own documented flow. `forceTry({ shouldAbortRunning: true })` and
      // `cancel()`'s grace period both abort the running context and then move on, and the
      // contract tells the operation to call `reportResult('skip', 'aborted')` when it
      // notices `signal.aborted`. Reporting that would turn the ordinary, documented
      // response to being aborted into a global `'error'` `ErrorEvent` and a full console
      // table - in a browser also reaching `window.onerror` and any error monitoring
      // attached to it, as a synthetic uncaught error, for an operation that did exactly
      // what it was asked.
      const wasAborted = context.isAborted;

      if (!wasAborted) {
        if (source instanceof UnreadableReturn) {
          // The return-contract failure, worded as one, with the getter's own error kept
          // on `cause`.
          reportCallbackError(
            'RetryRunner operation returned an unreadable then after the attempt was settled',
            new Error(source.describe('RetryRunner operation'), {
              cause: source.cause,
            }),
          );
        } else {
          const didOperationThrow = source === 'throw';

          reportCallbackError(
            didOperationThrow
              ? 'RetryRunner operation threw after the attempt was settled'
              : 'RetryRunner reportResult (attempt already settled)',
            // Only a missing value gets the stand-in below: a `null` error or `throw null`
            // is reported as itself, as `report-discarded` publishes it.
            valueInfo.error !== undefined
              ? valueInfo.error
              : new Error(
                  didOperationThrow
                    ? 'the operation threw after the attempt was settled'
                    : `reportResult('${renderName(status, 'unrenderable status')}') arrived after the attempt was settled`,
                ),
          );
        }
      }

      // Every discarded report, reported above or not, so a subscriber can see what an
      // aborted attempt sent after the runner moved on - the one place a real failure in
      // cleanup code would otherwise go unseen. Silent unless someone listens.
      this.emit(REPORT_DISCARDED, {
        attemptID: context.id,
        status:
          source !== 'report'
            ? 'throw'
            : isReportResultStatus(status)
              ? status
              : 'invalid',
        // By key, so a `null` error or `throw null` is kept.
        value: reportedValueOf(valueInfo),
        reason:
          context.settledAs === 'abandoned' || context.settledAs === 'replaced'
            ? context.settledAs
            : 'already-reported',
      } satisfies OnReportDiscardedInfo);

      return; // Ensures we only handle the result once per context
    }

    if (!isReportResultStatus(status)) {
      // The reported value is kept on `cause`, so the mistake does not also lose it.
      const reportedError = reportedValueOf(valueInfo);
      status = 'fatal';
      valueInfo = {
        error: new TypeError(
          'RetryRunner reportResult status must be success, error, fatal, or skip',
          reportedError !== undefined ? { cause: reportedError } : undefined,
        ),
      };
    }

    const operationToken = this.operationToken;
    const operationResolver = this.currentOperationResolver;

    // cleanup the current attempt context
    this.currentState.currentAttemptContext = null;

    // Cleanup any timers
    this.cleanupTimers();

    // Mark the context as handled
    context.handled = true;
    context.settledAs = 'reported';
    this.currentState.lastAttemptSettledAs = 'reported';

    // Handle the result based on status
    let isSkip = false;
    let shouldQueryForRetry = false;

    // The outcome this report ends the operation with, or `null` while it continues.
    let terminal: {
      runnerState: Exclude<RunnerState, 'running'>;
      resolveInfo: TerminalOutcomeResolveInfo<T>;
    } | null = null;

    try {
      if (status === 'success') {
        this.policy.markAsSuccessful();

        terminal = {
          runnerState: 'completed',
          resolveInfo: {
            status: 'attempt_success',
            data: valueInfo.data,
          },
        };
      } else if (status === 'error') {
        shouldQueryForRetry = true;
      } else if (status === 'fatal') {
        // Fatal errors are recorded, but never retried.
        this.policy.reportError(reportedValueOf(valueInfo));

        terminal = {
          runnerState: 'fatal-error',
          resolveInfo: {
            status: 'attempt_fatal',
            error: valueInfo.error,
          },
        };
      } else {
        // Skip is treated like a non-fatal error that doesn't count as a failure.
        isSkip = true;
        shouldQueryForRetry = true;
      }

      // Handle if query for retry
      if (shouldQueryForRetry) {
        if (this.isCanceledOrPendingCancel) {
          // Recorded as `shouldRetry` records it - an error, not a skip - without
          // computing a retry delay the cancellation would throw away.
          if (!isSkip) {
            this.policy.reportError(reportedValueOf(valueInfo));
          }
          terminal = {
            runnerState: 'stopped',
            resolveInfo: {
              status: 'canceled',
            },
          };
        } else {
          const shouldRetryQuery = this.policy.shouldRetry(
            reportedValueOf(valueInfo),
            isSkip,
          );
          if (shouldRetryQuery.shouldRetry) {
            // Every retry goes through a timer, never a synchronous `attemptOperation`
            // call: `attempt-handled` for this attempt is emitted below, after this
            // branch. A listener can still force the next attempt synchronously
            // during that publication; timer-driven retries wait for dispatch to end.
            //
            // Used as given: `this.policy` is always a `RetryPolicy` this runner built, and
            // every delay it grants is finite, at least 1ms and at most `MAX_TIMER_MS`.
            const delayMS = shouldRetryQuery.delayMS;

            this.currentState.retryTimeoutStartTime = Date.now();
            this.currentState.retryTimeoutDelayMS = delayMS;
            this.currentState.retryTimeoutHandle = setTimeout(() => {
              this.clearRetryTimer();
              void this.attemptOperation(false);
            }, delayMS);
          } else {
            // No retry allowed: mark as exhausted.
            terminal = {
              runnerState: 'exhausted',
              resolveInfo: {
                status: 'attempts_exhausted',
                error: valueInfo.error,
              },
            };
          }
        }
      }
    } catch (error) {
      // Live policy/timer functions can replace or complete the operation before
      // throwing. Their failure belongs to this transition, never to its successor.
      // Reached only through a patched built-in (the policy is the runner's own), and
      // deliberately publishes nothing for this attempt: a successor's events have
      // already run, so its `attempt-handled` now would arrive out of order.
      if (
        this.operationToken !== operationToken ||
        operationResolver.hasResolved
      ) {
        reportCallbackError('RetryRunner retry scheduling', error);
        return;
      }
      // Retry policy evaluation and timer installation belong to this transition.
      // If either fails, publish an outcome instead of leaving a handled attempt
      // with no successor and no completion result.
      // Only the running path computes a delay and arms a timer; the rest records state
      // and can fail only through a patched built-in. Either way this transition ends
      // the operation fatal - a pending cancellation included, which loses its
      // 'canceled' outcome to that failure. The failure is not recorded in the policy:
      // `errors` counts attempts, and this one's error, if any, already is.
      this.cleanupTimers();
      terminal = {
        runnerState: 'fatal-error',
        resolveInfo: unexpectedFatal(error),
      };
    }

    // Cache the attempt duration before emitting
    const attemptTimeElapsedMS = Date.now() - context.startTime;
    this.currentState.lastAttemptTimeTakenMS = attemptTimeElapsedMS;

    const terminalReport = terminal;
    // Opened here rather than left to `publishTerminalOutcome`, so `attempt-handled` for a
    // terminal report is inside the reentry scope too.
    this.withTerminalDispatch(terminalReport !== null, () => {
      // emit the attempt handled event
      this.emit(ATTEMPT_HANDLED, {
        attemptID: context.id,
        status,
        data: valueInfo.data,
        error: valueInfo.error,
        operationTimeElapsedMS: this.timeTakenMS,
        attemptTimeElapsedMS,
        // An attempt a force-abort settled reads as canceled however it was settled:
        // reported from its abort listener, or silent and settled by the runner.
        wasCanceled: this.isCanceledOrPendingCancel || context.isAborted,
      } satisfies OnAttemptHandledInfo<T>);

      // if a confirm cancel should run
      if (terminalReport !== null) {
        this.publishTerminalOutcome(
          terminalReport.runnerState,
          terminalReport.resolveInfo,
        );
      }
    });
  }

  /**
   * End the operation for an attempt whose context could not be created, through the
   * same outcome as a failed retry transition. Nothing has published the attempt or run
   * caller code yet, so the runner is still `running` and no attempt is current.
   */
  private failAttemptSetup(error: unknown): void {
    this.cleanupTimers();
    this.publishTerminalOutcome('fatal-error', unexpectedFatal(error));
  }

  private async attemptOperation(wasForced: boolean): Promise<void> {
    // make sure the operation is running still, and not pending cancellation or canceled
    if (this.currentState.runnerState === 'running') {
      // Every caller discards this method's promise, so a throw while creating the
      // attempt's context must end the operation here: as a rejection it would go
      // unhandled and leave the runner `running` with nothing to settle it. `emit` itself
      // cannot throw: it contains every listener's failure.
      let context: AttemptContext;
      try {
        context = new AttemptContext();
      } catch (error) {
        this.failAttemptSetup(error);
        return;
      }
      this.currentState.lastAttemptWasForceTry = wasForced;
      this.currentState.currentAttemptContext = context;

      // emit the attempt started event
      this.emit(ATTEMPT_STARTED, {
        attemptID: context.id,
        operationTimeElapsedMS: this.timeTakenMS,
        attemptTimeElapsedMS: 0,
      });

      // An attempt-started listener can force-replace, cancel, or reset this attempt.
      // A replaced attempt is over; an aborted one is acknowledged as the operation
      // contract asks, rather than invoking the operation with an aborted signal.
      if (
        this.currentState.currentAttemptContext !== context ||
        context.handled
      ) {
        return;
      }
      if (context.isAborted) {
        this.handleReportResult(context, 'skip', { data: undefined });
        return;
      }

      // reportResult is how the operation communicates outcome of this attempt.
      // Route the value to `data` for success/skip, or `error` for error/fatal.
      // The first and the latest value the operation handed `reportResult` as an error, so
      // the `catch` below can tell the ordinary `catch (e) { reportResult('error', e);
      // throw e; }` shape - a rethrow of an outcome already recorded, or of a later report
      // already reported as late, not a second one - from a genuine throw after a settled
      // attempt. Two slots, not every value: an operation that wires a long-lived emitter
      // to `reportResult` would otherwise keep each later error alive for as long as it
      // holds the callback. Success and skip data is not held at all.
      let firstReportedError: { value: unknown } | undefined;
      let latestReportedError: { value: unknown } | undefined;

      const reportResult: ReportResult = (status, value) => {
        if (status === 'success' || status === 'skip') {
          this.handleReportResult(context, status, {
            data: value as T,
          });
        } else {
          // A report with no value records nothing: a later, unrelated `throw undefined`
          // or bare `Promise.reject()` must not read as its rethrow.
          if (value !== undefined) {
            latestReportedError = { value };
            firstReportedError ??= latestReportedError;
          }
          this.handleReportResult(context, status, {
            error: value,
          });
        }
      };

      // Whether `failure` repeats the error this attempt already reported (see the
      // `catch` below for why that is not a second outcome).
      // Any status other than success or skip routes its value as the error, an
      // unrecognized one included (it becomes a fatal `TypeError` with that value as
      // `cause`), so a rethrow of that value is the same shape.
      const isReportedErrorAgain = (failure: unknown): boolean =>
        context.handled &&
        // `Object.is`, so a reported `NaN` rethrown is still the same value.
        ((firstReportedError !== undefined &&
          Object.is(firstReportedError.value, failure)) ||
          (latestReportedError !== undefined &&
            Object.is(latestReportedError.value, failure)));

      // A returned value whose `then` could not be read: a return-contract failure, kept
      // apart from a throw so a settled attempt reports it as what it is.
      let unreadableReturn: UnreadableReturn | undefined;

      try {
        // Called without the runner as `this`, so the operation cannot reach its internals.
        const result = Reflect.apply(this.operation, undefined, [
          reportResult,
          context.signal,
        ]) as unknown;

        // Adopted, not awaited as it is: a native promise whose own `then` is not a
        // function fails `isPromise()`, so its rejection would never be awaited and would
        // go unhandled, and `await` calls an own `then` on one carrying its own
        // `constructor`. Classification and adoption share one then read.
        const pending = adoptResult(result);
        if (pending instanceof UnreadableReturn) {
          unreadableReturn = pending;
        } else if (pending !== undefined) {
          await pending;
        }
      } catch (error) {
        // A rethrow of what was already reported is not a second outcome, and reporting it
        // as one would dispatch a synthetic global `'error'` `ErrorEvent` per attempt -
        // falling through to a full rendered error table on the console with nothing
        // listening, and to `window.onerror` and any error monitoring behind it in a
        // browser - for the most ordinary shape an operation can have:
        // `catch (e) { reportResult('error', e); throw e; }`. That is precisely the harm
        // the aborted case above is excluded for. A throw carrying anything else still
        // reports, which is the failure that would otherwise disappear.
        //
        // Only a rethrow of a reported *error* - any status but success or skip - is that
        // shape.
        // Comparing against whatever was reported would match a throw against success
        // data too: `reportResult('success')` and `reportResult('skip')` store `undefined`,
        // so a later `throw undefined` or a bare `Promise.reject()` from a cleanup step
        // would compare equal and be dropped - the runner stays `completed`/`success` and
        // the `'error'` channel never hears of it, which is precisely the post-success
        // failure `handleReportResult` exists to keep.
        if (isReportedErrorAgain(error)) {
          return;
        }

        // Treat thrown errors as retryable errors by default.
        this.handleReportResult(
          context,
          'error',
          {
            error: error,
          },
          'throw',
        );
        return;
      }

      // Outside the `try`, so nothing here can be caught and handled a second time as a
      // throw. A live attempt records the getter's own error, as `await` would reject with
      // it, so its identity is preserved. A getter rethrowing the error already reported
      // is the rethrow shape above and is not a second outcome.
      if (
        unreadableReturn !== undefined &&
        !isReportedErrorAgain(unreadableReturn.cause)
      ) {
        this.handleReportResult(
          context,
          'error',
          { error: unreadableReturn.cause },
          unreadableReturn,
        );
      }
    }
  }
}

/**
 * Refuse a `run()`/`resume()`/`forceTry()` option that is provided but not a boolean:
 * thrown inside `dispatchUnderLock`, so it resolves as `unexpected_error` before any state
 * is inspected or work is started, rather than truthiness deciding a `'yes'`.
 */
function assertBooleanOption(label: string, value: unknown): void {
  if (value !== undefined && !isBoolean(value)) {
    throw new TypeError(`${label} must be a boolean when provided`);
  }
}
