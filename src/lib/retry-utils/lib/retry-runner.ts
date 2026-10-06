import {
  awaitBoxedPromise,
  createOwnedAbortController,
  type OwnedAbortController,
} from '../../internal/intrinsics';
import { guardAbortListeners } from '../../internal/guarded-abort-signal';
import { PromiseProtectedResolver } from '../../promise-protected-resolver';
import { reportCallbackError } from '../../safe-handle-callback';
import { generateID } from '../../id-helpers';
import { adoptResult, UnreadableReturn } from '../../internal/adopt-promise';
import { isString } from '../../strings';
import { isPlainObject } from '../../is-plain-object';
import { isFunction } from '../../is-function';
import { RetryPolicy } from './retry-policy';
import { clampTimerDelayMS, toTimerDelayMS } from '../../internal/timer-limits';
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

export type CancelResult = 'canceled' | 'forced' | 'not-running' | 'superseded';

class AttemptContext {
  public handled = false;
  public id: string;
  public startTime: number;
  /** Set before the abort is dispatched, so the operation's listeners already see it. */
  public isAborted = false;
  private readonly abortController: OwnedAbortController;

  constructor() {
    this.id = generateID('ulid');
    // From the `AbortController` captured at module initialization, never the live
    // global: an attempt is started from a floating promise, where a replaced global
    // that throws would be an unhandled rejection that leaves the runner `running`.
    this.abortController = createOwnedAbortController();
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

  /**
   * Abort this attempt's signal. Tracked here rather than read back from
   * `signal.aborted`, a getter application code can replace on `AbortSignal.prototype`;
   * the runner is the only code holding this controller.
   */
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

export interface RetryRunnerOptions<T = unknown> {
  operationLabel?: string;
  onOperationStarted?: (info: OnOperationStartedInfo) => void;
  onOperationEnded?: (info: OnOperationEndedInfo) => void;
  onAttemptStarted?: (info: OnAttemptStartedInfo) => void;
  onAttemptHandled?: (info: OnAttemptHandledInfo<T>) => void;
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
}

interface ConfirmCancellationResolveInfo<T> {
  status: RunAttemptStatusCodes | null;
  code?: RunnerErrorCode;
  data?: T;
  error?: unknown;
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
   * (`lock_error`) - reading `true` there sent callers into a refusal it promised away.
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

    return (
      this.currentState.runnerState === 'running' ||
      this.currentState.runnerState === 'exhausted' ||
      this.currentState.runnerState === 'fatal-error' ||
      this.currentState.runnerState === 'not-started' ||
      this.currentState.runnerState === 'stopping' ||
      this.currentState.runnerState === 'stopped'
    );
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
   * still settles the cancellation as `'canceled'` rather than `'forced'`.
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
        // If the operation has already completed, exhausted, encountered a fatal error, or was stopped,
        // return the last result
        return await this.currentOperationResolver.promise;
      case 'running':
      case 'stopping':
        // If the operation is currently running or in the process of stopping, wait for it to complete
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
    // An abort listener that reports fatal (or exhausts the budget) and then cancels has
    // already ended the operation, so there is nothing left to cancel and this returns
    // 'not-running' - but the forceTry({ shouldAbortRunning: true }) that dispatched the
    // abort must still not start a replacement its caller just asked to stop. A committed
    // success is the one exception: forceTry() can never revive a completed operation,
    // and it reports that more precisely as already_completed.
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
    if (
      this.currentState.runnerState === 'running' ||
      this.currentState.runnerState === 'stopping'
    ) {
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
          this.confirmCancellation('stopped', {
            status: 'canceled',
          });
        } else {
          // Signal the running attempt to abort.
          const afterAbort = this.abortAttemptAndReadOwnership(
            this.currentState.currentAttemptContext,
          );

          // Grace period: if operation doesn't acknowledge abort, force it.
          // An abort listener may call reportResult synchronously, settling this
          // cancellation before abort() returns. In that case there is no timer to arm.
          if (
            this.currentState.runnerState === 'stopping' &&
            afterAbort.isAttemptActive
          ) {
            this.currentState.cancellationTimeoutHandle = setTimeout(() => {
              if (
                this.currentState.currentAttemptContext instanceof
                  AttemptContext &&
                !this.currentState.currentAttemptContext.handled
              ) {
                if (this.currentState.runnerState === 'stopping') {
                  const context = this.currentState.currentAttemptContext;

                  // Mark handled and detach the current context
                  context.handled = true;
                  this.currentState.currentAttemptContext = null;

                  // Cleanup timers before emitting
                  this.cleanupTimers();

                  // Cache the attempt duration and emit attempt-handled for consistency
                  const attemptTimeElapsedMS = Date.now() - context.startTime;
                  this.currentState.lastAttemptTimeTakenMS =
                    attemptTimeElapsedMS;

                  this.withTerminalDispatch(true, () => {
                    this.emit(ATTEMPT_HANDLED, {
                      attemptID: context.id,
                      status: 'skip',
                      data: undefined,
                      error: undefined,
                      operationTimeElapsedMS: this.timeTakenMS,
                      attemptTimeElapsedMS,
                      wasCanceled: true,
                    } satisfies OnAttemptHandledInfo<T>);

                    // Force completion after grace period expired.
                    this.confirmCancellation(
                      'stopped',
                      {
                        status: 'canceled',
                      },
                      true,
                    );
                  });
                }
              }
            }, this._gracePeriodMS);
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
    if (
      this.currentState.runnerState === 'running' ||
      this.currentState.runnerState === 'stopping'
    ) {
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
    isAttemptActive: boolean;
    hasNewStopRequest: boolean;
  } {
    const operationResolver = this.currentOperationResolver;
    const stopRequestToken = this.stopRequestToken;
    context.abort();
    return {
      operationResolver,
      isAttemptActive:
        this.currentState.currentAttemptContext === context && !context.handled,
      hasNewStopRequest: this.stopRequestToken !== stopRequestToken,
    };
  }

  /** Claim new work, optionally retaining the result promise for existing waiters. */
  private beginOperation(
    shouldKeepPendingResolver = false,
  ): PromiseProtectedResolver<RunResult<T>> {
    this.operationToken = Symbol();
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
          error as Error,
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
      // check if in a disallowed state for this operation
      const checkDisallowedStates = this.checkForDisallowedPerOperationStates(
        'run',
        [
          'completed',
          'running',
          'stopping',
          'stopped',
          'fatal-error',
          'exhausted',
        ],
      );

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
      // check if in a disallowed state for this operation
      const checkDisallowedStates = this.checkForDisallowedPerOperationStates(
        'resume',
        ['completed', 'running', 'stopping', 'fatal-error', 'exhausted'],
      );

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
    const shouldWaitForCompletion = options?.shouldWaitForCompletion ?? false;
    const shouldAbortRunning = options?.shouldAbortRunning ?? false;

    return this.dispatchUnderLock('forceTry', () => {
      const refusal = this.checkForDisallowedPerOperationStates('forceTry', [
        'completed',
      ]);
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
      if (this.isAttemptRunning && this.currentState.currentAttemptContext) {
        const { operationResolver, hasNewStopRequest } =
          this.abortAttemptAndReadOwnership(
            this.currentState.currentAttemptContext,
          );
        // A cancel/reset requested inside abort is newer than this force request.
        // Waiting calls join its outcome; non-waiting calls report supersession
        // immediately. Neither revives work the newer request wants stopped.
        if (hasNewStopRequest) {
          return shouldWaitForCompletion
            ? operationResolver.promise
            : {
                status: 'pre_operation_error',
                code: 'force_try_superseded',
                error: new RetryUtilsErrRunnerForceTrySuperseded(),
              };
        }
        const afterAbort = this.checkForDisallowedPerOperationStates(
          'forceTry',
          ['completed'],
        );
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
        this.currentState.lastAttemptWasForceTry = true;

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
      const isContinuingOperation =
        this.currentState.runnerState === 'running' ||
        this.currentState.runnerState === 'stopping';
      if (this.currentState.runnerState === 'not-started') {
        // Treat as a first try so the policy tracks the initial attempt.
        this.policy.shouldDoFirstTry();
      } else if (
        this.currentState.runnerState === 'stopping' ||
        this.currentState.runnerState === 'stopped'
      ) {
        // Transition from stopped/stopping to running. Pending cancel() callers
        // resolve 'superseded'; nothing here runs caller code synchronously.
        this.cleanupTimers();
        this.confirmCancellation('running', {
          status: null,
        });
      }

      return this.startOperation(
        'force',
        shouldWaitForCompletion,
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
    };
  }

  private checkForDisallowedPerOperationStates(
    methodName: 'run' | 'resume' | 'forceTry',
    disallowedStates: Array<
      | 'completed'
      | 'running'
      | 'stopping'
      | 'stopped'
      | 'fatal-error'
      | 'exhausted'
    >,
  ): RunResult<T> | undefined {
    // Preflight state checks to normalize errors for each entrypoint.
    for (const checkForState of disallowedStates) {
      if (
        checkForState === 'completed' &&
        this.currentState.runnerState === 'completed'
      ) {
        return {
          status: 'pre_operation_error',
          code: 'already_completed',
          error: new RetryUtilsErrRunnerAlreadyCompleted(methodName),
        };
      } else if (
        checkForState === 'running' &&
        this.currentState.runnerState === 'running'
      ) {
        return {
          status: 'pre_operation_error',
          code: 'already_running',
          error: new RetryUtilsErrRunnerAlreadyRunning(
            methodName as 'run' | 'resume',
          ),
        };
      } else if (
        checkForState === 'stopping' &&
        this.currentState.runnerState === 'stopping'
      ) {
        return {
          status: 'pre_operation_error',
          code: 'cancel_pending',
          error: new RetryUtilsErrRunnerCancelPending(
            methodName as 'run' | 'resume',
          ),
        };
      } else if (
        checkForState === 'stopped' &&
        this.currentState.runnerState === 'stopped'
      ) {
        return {
          status: 'pre_operation_error',
          code: 'retry_canceled',
          error: new RetryUtilsErrRunnerRetryCanceled('run'),
        };
      } else if (
        checkForState === 'fatal-error' &&
        this.currentState.runnerState === 'fatal-error'
      ) {
        return {
          status: 'pre_operation_error',
          code: 'fatally_failed',
          error: new RetryUtilsErrRunnerLastRetryFatallyFailed(
            methodName as 'run' | 'resume',
          ),
        };
      } else if (
        checkForState === 'exhausted' &&
        (this.currentState.runnerState === 'exhausted' ||
          this.policy.areAttemptsExhausted)
      ) {
        return {
          status: 'pre_operation_error',
          code: 'attempts_exhausted',
          error: new RetryUtilsErrRunnerAttemptsExhausted(
            methodName as 'run' | 'resume',
          ),
        };
      }
    }

    // if no disallowed states were found
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

  private confirmCancellation(
    runnerState: RunnerState,
    resolveInfo: ConfirmCancellationResolveInfo<T>,
    wasForced = false,
  ): void {
    const isTerminal = runnerState !== 'running';
    this.withTerminalDispatch(isTerminal, () => {
      // Resolve cancel promises and finalize operation state transitions.
      if (this.currentState.runnerState === 'stopping') {
        this.cleanupTimers();

        this.currentState.runnerState = runnerState;

        // resolve all cancel promises
        for (const resolver of this.cancelResolvers) {
          resolver.resolveOnce(
            !isTerminal
              ? 'superseded'
              : runnerState !== 'stopped'
                ? 'not-running'
                : wasForced
                  ? 'forced'
                  : 'canceled',
          );
          this.cancelResolvers.delete(resolver);
        }
      } else {
        this.currentState.runnerState = runnerState;
      }

      if (runnerState !== 'running') {
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

        if (resolveInfo.status !== null) {
          if (resolveInfo.status === 'attempt_success') {
            this.currentOperationResolver.resolveOnce({
              status: 'attempt_success',
              ...(resolveInfo.data !== undefined
                ? { data: resolveInfo.data }
                : {}),
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
        }
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
      // Ensure the context is the current one. A `forceTry` abort replaces it without
      // handling it, so once its replacement settles the current context is null and
      // the aborted attempt's late report must still be discarded.
      this.currentState.currentAttemptContext !== context ||
      // Ensure the result hasn't already been handled
      context.handled
    ) {
      // Discarding is right - the attempt is over and its outcome is already recorded -
      // but it used to be silent, and `ReportResult` returns `void`, so an operation that
      // reported twice, or reported its real failure after the runner had moved on, had no
      // way to learn its outcome went nowhere. A double report is a caller bug that should
      // not have to be inferred from a missing event.
      //
      // Reported on the global `'error'` channel rather than through this runner's own
      // events, deliberately: the attempt this belongs to has been settled, so emitting
      // `attempt:handled` for it now would be inventing a lifecycle event out of order.
      //
      // Only for an attempt that was *not* aborted, which is what separates a caller bug
      // from this API's own documented flow. `forceTry({ shouldAbortRunning: true })` and
      // `cancel()`'s grace period both abort the running context and then move on, and the
      // contract tells the operation to call `reportResult('skip', 'aborted')` when it
      // notices `signal.aborted` - so the ordinary, correct, documented response to being
      // aborted was dispatching a global `'error'` `ErrorEvent` and printing a full console
      // table. In a browser that also reaches `window.onerror` and any error monitoring
      // attached to it, as a synthetic uncaught error, for an operation that did exactly
      // what it was asked. The runner's own suite reports it: "should abort running attempt
      // when shouldAbortRunning is true".
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
            valueInfo.error ??
              new Error(
                didOperationThrow
                  ? 'the operation threw after the attempt was settled'
                  : `reportResult('${status}') arrived after the attempt was settled`,
              ),
          );
        }
      }

      return; // Ensures we only handle the result once per context
    }

    // cleanup the current attempt context
    this.currentState.currentAttemptContext = null;

    // Cleanup any timers
    this.cleanupTimers();

    // Mark the context as handled
    context.handled = true;

    // Handle the result based on status
    let isSkip = false;
    let shouldQueryForRetry = false;

    let confirmCancellationInfo: {
      run: boolean;
      runnerState: RunnerState | null;
      resolveInfo: ConfirmCancellationResolveInfo<T> | null;
    } = {
      run: false,
      runnerState: null,
      resolveInfo: null,
    };

    if (status === 'success') {
      this.policy.markAsSuccessful();

      confirmCancellationInfo = {
        run: true,
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
      this.policy.shouldRetry(valueInfo.error ?? valueInfo.data, false);

      confirmCancellationInfo = {
        run: true,
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
      const shouldRetryQuery = this.policy.shouldRetry(
        valueInfo.error ?? valueInfo.data,
        isSkip,
      );

      const isCanceledOrPendingCancel =
        this.currentState.runnerState === 'stopping' ||
        this.currentState.runnerState === 'stopped';

      if (isCanceledOrPendingCancel) {
        confirmCancellationInfo = {
          run: true,
          runnerState: 'stopped',
          resolveInfo: {
            status: 'canceled',
          },
        };
      } else {
        if (shouldRetryQuery.shouldRetry) {
          // Every retry goes through a timer, never a synchronous `attemptOperation`
          // call: `attempt-handled` for this attempt is emitted below, after this
          // branch, and the next attempt must not start before it.
          //
          // Bounded again here, not only in `RetryPolicy`. `this.policy` is always a
          // `RetryPolicy` this runner built, whose delays are already finite, capped and at
          // least 1ms, so this is a backstop: a `setTimeout` past `MAX_TIMER_MS` fires on
          // the next tick, turning "wait a month" into a busy retry loop.
          // `clampTimerDelayMS` does not repair `NaN`, so that case takes `RetryPolicy`'s
          // 1ms minimum. The same value is recorded, so the remaining-time bookkeeping
          // describes the timer that actually exists.
          const delayMS = Number.isNaN(shouldRetryQuery.delayMS)
            ? 1
            : clampTimerDelayMS(shouldRetryQuery.delayMS);

          this.currentState.retryTimeoutStartTime = Date.now();
          this.currentState.retryTimeoutDelayMS = delayMS;
          this.currentState.retryTimeoutHandle = setTimeout(() => {
            this.clearRetryTimer();
            void this.attemptOperation(false);
          }, delayMS);
        } else {
          // No retry allowed: mark as exhausted.
          confirmCancellationInfo = {
            run: true,
            runnerState: 'exhausted',
            resolveInfo: {
              status: 'attempts_exhausted',
              error: valueInfo.error,
            },
          };
        }
      }
    }

    // Cache the attempt duration before emitting
    const attemptTimeElapsedMS = Date.now() - context.startTime;
    this.currentState.lastAttemptTimeTakenMS = attemptTimeElapsedMS;

    const terminalRunnerState = confirmCancellationInfo.runnerState;
    const terminalResolveInfo = confirmCancellationInfo.resolveInfo;
    const isTerminalReport =
      confirmCancellationInfo.run &&
      terminalRunnerState !== null &&
      terminalResolveInfo !== null;
    this.withTerminalDispatch(isTerminalReport, () => {
      // emit the attempt handled event
      this.emit(ATTEMPT_HANDLED, {
        attemptID: context.id,
        status,
        data: valueInfo.data,
        error: valueInfo.error,
        operationTimeElapsedMS: this.timeTakenMS,
        attemptTimeElapsedMS,
        wasCanceled:
          this.currentState.runnerState === 'stopping' ||
          this.currentState.runnerState === 'stopped',
      } satisfies OnAttemptHandledInfo<T>);

      // if a confirm cancel should run
      if (isTerminalReport) {
        this.confirmCancellation(terminalRunnerState, terminalResolveInfo);
      }
    });
  }

  private async attemptOperation(wasForced: boolean): Promise<void> {
    // make sure the operation is running still, and not pending cancellation or canceled
    if (this.currentState.runnerState === 'running') {
      this.currentState.lastAttemptWasForceTry = wasForced;

      // Create a new context for this attempt. This runs from a floating promise, so a
      // throw here would be an unhandled rejection that leaves the runner `running`: the
      // id generator reads the live `crypto` global, which application code can replace.
      // An attempt that cannot even be set up ends the operation, like a fatal attempt.
      let context: AttemptContext;
      try {
        context = new AttemptContext();
      } catch (error) {
        // A `forceTry` abort leaves the attempt it replaced current and unhandled until
        // this replacement takes over. The operation ends here instead, so that attempt
        // ends with it: left current, its late `reportResult('skip', 'aborted')` would be
        // accepted as the live attempt's outcome and arm a retry in `fatal-error`, and
        // `isAttemptRunning` would let a later `forceTry` reattach to it.
        const replacedContext = this.currentState.currentAttemptContext;
        if (replacedContext instanceof AttemptContext) {
          replacedContext.handled = true;
        }
        this.currentState.currentAttemptContext = null;

        this.policy.shouldRetry(error, false);
        this.confirmCancellation('fatal-error', {
          status: 'attempt_fatal',
          code: 'unexpected_error',
          error,
        });
        return;
      }
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
      // What the operation last handed `reportResult`, so the `catch` below can tell the
      // ordinary `catch (e) { reportResult('error', e); throw e; }` shape - which is a
      // rethrow of an outcome already recorded, not a second one - from a genuine throw
      // after a settled attempt.
      let didReport = false;
      let reportedStatus: ReportResultStatus | undefined;
      let reportedValue: unknown;

      const reportResult: ReportResult = (status, value) => {
        didReport = true;
        reportedStatus = status;
        reportedValue = value;

        if (status === 'success' || status === 'skip') {
          this.handleReportResult(context, status, {
            data: value as T,
          });
        } else {
          this.handleReportResult(context, status, {
            error: value,
          });
        }
      };

      // Whether `failure` repeats the error this attempt already reported (see the
      // `catch` below for why that is not a second outcome).
      const isReportedErrorAgain = (failure: unknown): boolean =>
        didReport &&
        context.handled &&
        (reportedStatus === 'error' || reportedStatus === 'fatal') &&
        failure === reportedValue;

      // A returned value whose `then` could not be read: a return-contract failure, kept
      // apart from a throw so a settled attempt reports it as what it is.
      let unreadableReturn: UnreadableReturn | undefined;

      try {
        const result = this.operation(reportResult, context.signal);

        // Adopted, not awaited as it is: a native promise whose own `then` is not a
        // function failed `isPromise()`, so its rejection was never awaited and went
        // unhandled, and `await` calls an own `then` on one carrying its own
        // `constructor`. Classification and adoption share one captured then read.
        const pending = adoptResult(result);
        if (pending instanceof UnreadableReturn) {
          unreadableReturn = pending;
        } else if (pending !== undefined) {
          await awaitBoxedPromise(pending);
        }
      } catch (error) {
        // A rethrow of what was already reported is not a second outcome, and reporting it
        // as one dispatched a synthetic global `'error'` `ErrorEvent` per attempt - falling
        // through to a full rendered error table on the console with nothing listening, and
        // to `window.onerror` and any error monitoring behind it in a browser - for the
        // most ordinary shape an operation can have:
        // `catch (e) { reportResult('error', e); throw e; }`. That is precisely the harm
        // the aborted case above is excluded for. A throw carrying anything else still
        // reports, which is the failure that would otherwise disappear.
        //
        // Only a rethrow of a reported *error* - `'error'` or `'fatal'` - is that shape.
        // Comparing against whatever was reported matched a throw against success data
        // too: `reportResult('success')` and `reportResult('skip')` store `undefined`, so
        // a later `throw undefined` or a bare `Promise.reject()` from a cleanup step
        // compared equal and was dropped - the runner stayed `completed`/`success` and the
        // `'error'` channel never heard of it, which is precisely the post-success failure
        // `handleReportResult` exists to keep.
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
