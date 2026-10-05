import { awaitBoxedPromise } from '../../internal/intrinsics';
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
  public abortController: AbortController;
  public startTime: number;

  constructor() {
    this.id = generateID('ulid');
    this.abortController = new AbortController();
    this.startTime = Date.now();
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
  // force request that invoked it, even if cancellation settles synchronously.
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

  public get canForceTry(): boolean {
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
      // set the operation label
      if (isString(options.operationLabel)) {
        this._operationLabel = options.operationLabel;
      }

      // subscribe the event handlers
      if (isFunction(options.onOperationStarted)) {
        // operation started
        this.on(
          OPERATION_STARTED,
          options.onOperationStarted as (data: unknown) => void,
        );
      }

      // operation ended
      if (isFunction(options.onOperationEnded)) {
        this.on(
          OPERATION_ENDED,
          options.onOperationEnded as (data: unknown) => void,
        );
      }

      // attempt started
      if (isFunction(options.onAttemptStarted)) {
        this.on(
          ATTEMPT_STARTED,
          options.onAttemptStarted as (data: unknown) => void,
        );
      }

      // attempt handled
      if (isFunction(options.onAttemptHandled)) {
        this.on(
          ATTEMPT_HANDLED,
          options.onAttemptHandled as (data: unknown) => void,
        );
      }
    }
  }

  /**
   * Set the grace period for cancellation in milliseconds
   *
   * Overrides the default grace period of 1000ms
   * Invalid values throw. Infinity and oversized values use the runtime timer ceiling.
   * Use 0 for immediate force-cancel.
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
      this.stopRequestToken = Symbol();
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
    context.abortController.abort();
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

  // Keep the lock around synchronous dispatch, not the caller's wait for completion.
  // The public async wrapper awaits only after this method's finally released it.
  private runOperation(
    shouldWaitForCompletion: boolean,
  ): RunResult<T> | Promise<RunResult<T>> {
    // Simple lock check
    if (this._isOperationLocked || this.terminalDispatchDepth > 0) {
      return {
        status: 'pre_operation_error',
        code: 'lock_error',
        error: new RetryUtilsErrRunnerLockAcquisitionError('run'),
      };
    }

    // Lock prevents concurrent run/resume/forceTry calls from stepping on each other.
    this._isOperationLocked = true;

    try {
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
        const operationResolver = this.beginOperation();
        this.currentState.runnerState = 'running';

        // Start timing
        this.currentState.operationStartTime = Date.now();
        this.currentState.finalTimeTakenMS = null;

        this.emit(OPERATION_STARTED, { operationType: 'initial' });
        if (this.currentState.runnerState !== 'running') {
          return operationResolver.promise;
        }

        // Start the initial operation
        void this.attemptOperation(false);

        if (shouldWaitForCompletion) {
          return operationResolver.promise;
        } else {
          return { status: 'running' };
        }
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
    } catch (error) {
      // handle error unexpected when starting the operation
      return {
        status: 'pre_operation_error',
        code: 'unexpected_error',
        error: new RetryUtilsErrRunnerUnexpectedError('run', error as Error),
      };
    } finally {
      // Always release the lock.
      this._isOperationLocked = false;
    }
  }

  private resumeOperation(
    shouldWaitForCompletion: boolean,
  ): RunResult<T> | Promise<RunResult<T>> {
    if (this._isOperationLocked || this.terminalDispatchDepth > 0) {
      return {
        status: 'pre_operation_error',
        code: 'lock_error',
        error: new RetryUtilsErrRunnerLockAcquisitionError('resume'),
      };
    }

    this._isOperationLocked = true;

    try {
      // check if in a disallowed state for this operation
      const checkDisallowedStates = this.checkForDisallowedPerOperationStates(
        'resume',
        ['completed', 'running', 'stopping', 'fatal-error', 'exhausted'],
      );

      if (checkDisallowedStates) {
        return checkDisallowedStates;
      } else {
        if (this.currentState.runnerState !== 'stopped') {
          return {
            status: 'pre_operation_error',
            code: 'not_paused',
            error: new RetryUtilsErrRunnerNotPaused('resume'),
          };
        }

        // Resume from the paused/stopped state.
        const operationResolver = this.beginOperation();
        this.currentState.runnerState = 'running';
        this.currentState.operationStartTime = Date.now();
        this.currentState.finalTimeTakenMS = null;

        this.emit(OPERATION_STARTED, { operationType: 'resume' });
        if (this.currentState.runnerState !== 'running') {
          return operationResolver.promise;
        }

        // Restart the initial operation
        void this.attemptOperation(false);

        if (shouldWaitForCompletion) {
          return operationResolver.promise;
        } else {
          return { status: 'running' };
        }
      }
    } catch (error) {
      return {
        status: 'pre_operation_error',
        code: 'unexpected_error',
        error: new RetryUtilsErrRunnerUnexpectedError('resume', error as Error),
      };
    } finally {
      this._isOperationLocked = false;
    }
  }

  private forceTryOperation(
    options?: ForceTryOptions,
  ): RunResult<T> | Promise<RunResult<T>> {
    const shouldWaitForCompletion = options?.shouldWaitForCompletion ?? false;
    const shouldAbortRunning = options?.shouldAbortRunning ?? false;

    if (this._isOperationLocked || this.terminalDispatchDepth > 0) {
      return {
        status: 'pre_operation_error',
        code: 'lock_error',
        error: new RetryUtilsErrRunnerLockAcquisitionError('forceTry'),
      };
    }

    this._isOperationLocked = true;

    try {
      const refusal = this.checkForDisallowedPerOperationStates('forceTry', [
        'completed',
      ]);
      if (refusal) {
        return refusal;
      }

      // If an attempt is already running and we don't want to abort it,
      // just attach to the current operation.
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
      if (this.currentState.retryTimeoutHandle !== null) {
        clearTimeout(this.currentState.retryTimeoutHandle);
        this.currentState.retryTimeoutHandle = null;
        this.currentState.retryTimeoutStartTime = null;
        this.currentState.retryTimeoutDelayMS = null;
        this.currentState.lastAttemptWasForceTry = true;

        void this.attemptOperation(true);

        if (shouldWaitForCompletion) {
          return this.currentOperationResolver.promise;
        } else {
          return { status: 'running', reattached: false };
        }
      } else {
        // Case 2: No pending retry, start a brand-new forced attempt.
        // The abort above has already dispatched caller code. This new identity
        // makes resets from that old attempt leave the accepted restart alone.
        const isContinuingOperation =
          this.currentState.runnerState === 'running' ||
          this.currentState.runnerState === 'stopping';
        const operationResolver = this.beginOperation(true);
        if (this.currentState.runnerState === 'not-started') {
          // Treat as a first try so the policy tracks the initial attempt.
          this.policy.shouldDoFirstTry();
        } else if (
          this.currentState.runnerState === 'stopping' ||
          this.currentState.runnerState === 'stopped'
        ) {
          // Transition from stopped/stopping to running.
          this.cleanupTimers();
          this.confirmCancellation('running', {
            status: null,
          });
        }

        this.currentState.runnerState = 'running';
        if (!isContinuingOperation) {
          this.currentState.operationStartTime = Date.now();
          this.currentState.finalTimeTakenMS = null;
          this.emit(OPERATION_STARTED, { operationType: 'force' });
          // The start listener is the only caller code since the state was set.
          if (this.currentState.runnerState !== 'running') {
            return operationResolver.promise;
          }
        }

        void this.attemptOperation(true);

        if (shouldWaitForCompletion) {
          return operationResolver.promise;
        } else {
          return { status: 'running', reattached: false };
        }
      }
    } catch (error) {
      return {
        status: 'pre_operation_error',
        code: 'unexpected_error',
        error: new RetryUtilsErrRunnerUnexpectedError(
          'forceTry',
          error as Error,
        ),
      };
    } finally {
      this._isOperationLocked = false;
    }
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

  private cleanupTimers(): void {
    // Clear any pending retry or cancellation timers.
    if (this.currentState.retryTimeoutHandle) {
      clearTimeout(this.currentState.retryTimeoutHandle);
      this.currentState.retryTimeoutHandle = null;
      this.currentState.retryTimeoutStartTime = null;
      this.currentState.retryTimeoutDelayMS = null;
    }

    if (this.currentState.cancellationTimeoutHandle) {
      clearTimeout(this.currentState.cancellationTimeoutHandle);
      this.currentState.cancellationTimeoutHandle = null;
    }
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
    // Set only by the `catch` around `this.operation`, which routes a thrown error here
    // as `'error'`. It changes nothing about how a live attempt is handled and only names
    // the already-settled case correctly: an operation that reports its outcome and *then*
    // throws never called `reportResult` twice, so telling its author that a second report
    // "arrived after the attempt was settled" points at code they did not write. The
    // throw is still reported - a failure after a successful report is exactly the kind
    // that otherwise disappears - it is simply reported as what it is.
    didOperationThrow: boolean = false,
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
      let wasAborted = false;

      try {
        wasAborted = context.abortController.signal.aborted;
      } catch {
        // A context whose controller cannot be read is not one this can clear, so it falls
        // through to being reported - the safe direction, since a genuine double report is
        // what this exists to surface.
      }

      if (!wasAborted) {
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
          if (shouldRetryQuery.delayMS > 0) {
            // Bounded again here, not only in `RetryPolicy`. The delay can also arrive
            // from a caller-built policy object or an exported delay calculator given its
            // own bounds, and a `setTimeout` past `MAX_TIMER_MS` fires on the next tick -
            // so an unbounded number reaching this line turns "wait a month" into a busy
            // retry loop. The same clamped value is recorded, so the remaining-time
            // bookkeeping describes the timer that actually exists.
            const delayMS = clampTimerDelayMS(shouldRetryQuery.delayMS);

            this.currentState.retryTimeoutStartTime = Date.now();
            this.currentState.retryTimeoutDelayMS = delayMS;
            this.currentState.retryTimeoutHandle = setTimeout(() => {
              this.currentState.retryTimeoutHandle = null;
              this.currentState.retryTimeoutStartTime = null;
              this.currentState.retryTimeoutDelayMS = null;
              void this.attemptOperation(false);
            }, delayMS);
          } else {
            void this.attemptOperation(false);
          }
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
    // If there's an existing attempt that has already been handled but not yet cleaned up, return early
    if (this.currentState.currentAttemptContext instanceof AttemptContext) {
      if (this.currentState.currentAttemptContext.handled) {
        return;
      }
    }

    // make sure the operation is running still, and not pending cancellation or canceled
    if (this.currentState.runnerState === 'running') {
      this.currentState.lastAttemptWasForceTry = wasForced;

      // Create a new context for this attempt
      const context = new AttemptContext();
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
      if (context.abortController.signal.aborted) {
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

      try {
        const result = this.operation(
          reportResult,
          context.abortController.signal,
        );

        // Adopted, not awaited as it is: a native promise whose own `then` is not a
        // function failed `isPromise()`, so its rejection was never awaited and went
        // unhandled, and `await` calls an own `then` on one carrying its own
        // `constructor`. Classification and adoption share one captured then read.
        const pending = adoptResult(result);
        if (pending instanceof UnreadableReturn) {
          // Match await's rejection reason and preserve reported-error identity.
          throw pending.cause;
        }
        if (pending !== undefined) {
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
        if (
          didReport &&
          context.handled &&
          (reportedStatus === 'error' || reportedStatus === 'fatal') &&
          error === reportedValue
        ) {
          return;
        }

        // Treat thrown errors as retryable errors by default.
        this.handleReportResult(
          context,
          'error',
          {
            error: error,
          },
          true,
        );
      }
    }
  }
}
