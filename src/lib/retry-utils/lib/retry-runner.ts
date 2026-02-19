import { PromiseProtectedResolver } from '../../promise-protected-resolver';
import { generateID } from '../../id-helpers';
import { isPromise } from '../../is-promise';
import { isString } from '../../strings';
import { isPlainObject } from '../../is-plain-object';
import { isFunction } from '../../is-function';
import { RetryPolicy } from './retry-policy';
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

export type CancelResult = 'canceled' | 'forced' | 'not-running';

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
   * Non-finite or negative values default to 1000ms. Use 0 for immediate force-cancel.
   */

  public overrideGraceCancelPeriodMS(value: number): void {
    if (!isFinite(value) || value < 0) {
      this._gracePeriodMS = 1000;
    } else {
      this._gracePeriodMS = value;
    }
  }

  public async waitForCompletion(): Promise<RunResult<T>> {
    switch (this.currentState.runnerState) {
      case 'completed':
      case 'exhausted':
      case 'fatal-error':
      case 'stopped':
        // If the operation has already completed, exhausted, encountered a fatal error, or was stopped,
        // return the last result
        return this.currentOperationResolver.promise;
      case 'running':
      case 'stopping':
        // If the operation is currently running or in the process of stopping, wait for it to complete
        return this.currentOperationResolver.promise;
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
    // Simple lock check
    if (this._isOperationLocked) {
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

      if (
        checkDisallowedStates.wasDisallowed &&
        checkDisallowedStates.runResult
      ) {
        return checkDisallowedStates.runResult;
      } else if (this.policy.shouldDoFirstTry()) {
        this.currentState.runnerState = 'running';

        // Start timing
        this.currentState.operationStartTime = Date.now();
        this.currentState.finalTimeTakenMS = null;

        // emit the operation started event
        this.emit(OPERATION_STARTED, { operationType: 'initial' });

        // Create a new resolver for the current operation
        this.currentOperationResolver = new PromiseProtectedResolver<
          RunResult<T>
        >();

        // Start the initial operation
        void this.attemptOperation(false);

        if (shouldWaitForCompletion) {
          return this.currentOperationResolver.promise;
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

  public async cancel(): Promise<CancelResult> {
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
          this.currentState.currentAttemptContext.abortController.abort();

          // Grace period: if operation doesn't acknowledge abort, force it.
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

                // Force completion after grace period expired.
                this.confirmCancellation(
                  'stopped',
                  {
                    status: 'canceled',
                  },
                  true,
                );
              }
            }
          }, this._gracePeriodMS);
        }
      }

      // return the promise
      return cancellationPromiseProtectedResolver.promise;
    } else {
      return 'not-running';
    }
  }

  public async reset(): Promise<void> {
    // If an operation is running or pending stopping, cancel it first.
    if (
      this.currentState.runnerState === 'running' ||
      this.currentState.runnerState === 'stopping'
    ) {
      // Cancel any in-flight work before resetting state.
      await this.cancel();
    }

    // Reset the internal state to its initial values.
    this.currentState = this.getEmptyCurrentState();

    // Also, reset the policy itself if needed.
    this.policy.reset();
  }

  public async resume(shouldWaitForCompletion = false): Promise<RunResult<T>> {
    if (this._isOperationLocked) {
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

      if (
        checkDisallowedStates.wasDisallowed &&
        checkDisallowedStates.runResult
      ) {
        return checkDisallowedStates.runResult;
      } else {
        if (this.currentState.runnerState !== 'stopped') {
          return {
            status: 'pre_operation_error',
            code: 'not_paused',
            error: new RetryUtilsErrRunnerNotPaused('resume'),
          };
        }

        // Resume from the paused/stopped state.
        this.currentState.runnerState = 'running';
        this.currentState.operationStartTime = Date.now();
        this.currentState.finalTimeTakenMS = null;

        // emit the operation started event
        this.emit(OPERATION_STARTED, { operationType: 'resume' });

        this.currentOperationResolver = new PromiseProtectedResolver<
          RunResult<T>
        >();

        // Restart the initial operation
        void this.attemptOperation(false);

        if (shouldWaitForCompletion) {
          return this.currentOperationResolver.promise;
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

  public async forceTry(options?: ForceTryOptions): Promise<RunResult<T>> {
    const shouldWaitForCompletion = options?.shouldWaitForCompletion ?? false;
    const shouldAbortRunning = options?.shouldAbortRunning ?? false;

    if (this._isOperationLocked) {
      return {
        status: 'pre_operation_error',
        code: 'lock_error',
        error: new RetryUtilsErrRunnerLockAcquisitionError('forceTry'),
      };
    }

    this._isOperationLocked = true;

    try {
      const checkDisallowedStates = this.checkForDisallowedPerOperationStates(
        'forceTry',
        ['completed'],
      );

      if (
        checkDisallowedStates.wasDisallowed &&
        checkDisallowedStates.runResult
      ) {
        return checkDisallowedStates.runResult;
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
        this.currentState.currentAttemptContext.abortController.abort();
      }

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
        this.currentState.operationStartTime = Date.now();
        this.currentState.finalTimeTakenMS = null;

        this.emit(OPERATION_STARTED, { operationType: 'force' });

        if (
          !this.currentOperationResolver ||
          this.currentOperationResolver.hasResolved
        ) {
          // Create a new resolver for the forced operation.
          this.currentOperationResolver = new PromiseProtectedResolver<
            RunResult<T>
          >();
        }

        void this.attemptOperation(true);

        if (shouldWaitForCompletion) {
          return this.currentOperationResolver.promise;
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
  ): {
    wasDisallowed: boolean;
    runResult?: RunResult<T>;
  } {
    // Preflight state checks to normalize errors for each entrypoint.
    for (const checkForState of disallowedStates) {
      if (
        checkForState === 'completed' &&
        this.currentState.runnerState === 'completed'
      ) {
        return {
          wasDisallowed: true,
          runResult: {
            status: 'pre_operation_error',
            code: 'already_completed',
            error: new RetryUtilsErrRunnerAlreadyCompleted(methodName),
          },
        };
      } else if (
        checkForState === 'running' &&
        this.currentState.runnerState === 'running'
      ) {
        return {
          wasDisallowed: true,
          runResult: {
            status: 'pre_operation_error',
            code: 'already_running',
            error: new RetryUtilsErrRunnerAlreadyRunning(
              methodName as 'run' | 'resume',
            ),
          },
        };
      } else if (
        checkForState === 'stopping' &&
        this.currentState.runnerState === 'stopping'
      ) {
        return {
          wasDisallowed: true,
          runResult: {
            status: 'pre_operation_error',
            code: 'cancel_pending',
            error: new RetryUtilsErrRunnerCancelPending(
              methodName as 'run' | 'resume',
            ),
          },
        };
      } else if (
        checkForState === 'stopped' &&
        this.currentState.runnerState === 'stopped'
      ) {
        return {
          wasDisallowed: true,
          runResult: {
            status: 'pre_operation_error',
            code: 'retry_canceled',
            error: new RetryUtilsErrRunnerRetryCanceled('run'),
          },
        };
      } else if (
        checkForState === 'fatal-error' &&
        this.currentState.runnerState === 'fatal-error'
      ) {
        return {
          wasDisallowed: true,
          runResult: {
            status: 'pre_operation_error',
            code: 'fatally_failed',
            error: new RetryUtilsErrRunnerLastRetryFatallyFailed(
              methodName as 'run' | 'resume',
            ),
          },
        };
      } else if (
        checkForState === 'exhausted' &&
        (this.currentState.runnerState === 'exhausted' ||
          this.policy.areAttemptsExhausted)
      ) {
        return {
          wasDisallowed: true,
          runResult: {
            status: 'pre_operation_error',
            code: 'attempts_exhausted',
            error: new RetryUtilsErrRunnerAttemptsExhausted(
              methodName as 'run' | 'resume',
            ),
          },
        };
      }
    }

    // if no disallowed states were found
    return { wasDisallowed: false };
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

  private confirmCancellation(
    runnerState: RunnerState,
    resolveInfo: ConfirmCancellationResolveInfo<T>,
    wasForced = false,
  ): void {
    // Resolve cancel promises and finalize operation state transitions.
    if (this.currentState.runnerState === 'stopping') {
      this.cleanupTimers();

      this.currentState.runnerState = runnerState;

      // resolve all cancel promises
      for (const resolver of this.cancelResolvers) {
        resolver.resolveOnce(wasForced ? 'forced' : 'canceled');
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
  }

  private handleReportResult(
    context: AttemptContext,
    status: ReportResultStatus,
    valueInfo: {
      data?: T;
      error?: unknown;
    },
  ): void {
    // Guard against multiple calls to reportResult
    if (
      // Ensure the context matches the current context
      (this.currentState.currentAttemptContext &&
        context.id !== this.currentState.currentAttemptContext.id) ||
      // Ensure the result hasn't already been handled
      context.handled
    ) {
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
            this.currentState.retryTimeoutStartTime = Date.now();
            this.currentState.retryTimeoutDelayMS = shouldRetryQuery.delayMS;
            this.currentState.retryTimeoutHandle = setTimeout(() => {
              this.currentState.retryTimeoutHandle = null;
              this.currentState.retryTimeoutStartTime = null;
              this.currentState.retryTimeoutDelayMS = null;
              void this.attemptOperation(false);
            }, shouldRetryQuery.delayMS);
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
    if (
      confirmCancellationInfo.run &&
      confirmCancellationInfo.runnerState !== null &&
      confirmCancellationInfo.resolveInfo !== null
    ) {
      this.confirmCancellation(
        confirmCancellationInfo.runnerState,
        confirmCancellationInfo.resolveInfo,
      );
    }

    // if cancellation is pending, confirm it since we're not rescheduling anything
    if (this.currentState.runnerState === 'stopping') {
      this.confirmCancellation('stopped', {
        status: null,
      });
    }
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

      // reportResult is how the operation communicates outcome of this attempt.
      // Route the value to `data` for success/skip, or `error` for error/fatal.
      const reportResult: ReportResult = (status, value) => {
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

        if (isPromise(result)) {
          await result;
        }
      } catch (error) {
        // Treat thrown errors as retryable errors by default.
        this.handleReportResult(context, 'error', {
          error: error,
        });
      }
    }
  }
}
