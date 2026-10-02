export type RetryPolicyOptions =
  RetryPolicyOptionsStrategyFixed | RetryPolicyOptionsStrategyExponential;

type RequiredNonNullable<T> = { [K in keyof T]-?: NonNullable<T[K]> };

export type RetryPolicyValidated = RequiredNonNullable<RetryPolicyOptions>;

export interface RetryPolicyOptionsStrategyFixed {
  strategy: 'fixed';
  maxRetryAttempts?: number;
  /** Null or undefined uses the default delay. */
  delayMS?: number | null;
}

export interface RetryPolicyOptionsStrategyExponential {
  strategy: 'exponential';
  maxRetryAttempts?: number;
  factor?: number;
  /** Null or undefined uses the default minimum delay. */
  minTimeoutMS?: number | null;
  /** Null or undefined uses the default maximum delay. */
  maxTimeoutMS?: number | null;
  dispersion?: number;
}

export interface RetryQueryResult {
  shouldRetry: boolean;
  delayMS: number;
}

export type RunAttemptStatusCodes =
  // initial state
  | 'not_started'
  // if there was an error before the operation started
  | 'pre_operation_error'
  // the retry was canceled, so you must reset before trying again
  | 'canceled'
  // the attempts are exhausted, so don't try again
  | 'attempts_exhausted'
  // Was successful, no need to retry
  | 'attempt_success'
  // something went wrong, and it's fatal, so don't retry
  | 'attempt_fatal'
  // the operation is running when waitForCompletion is false
  | 'running';

export type RunnerErrorCode =
  | 'already_completed'
  | 'already_running'
  | 'attempts_exhausted'
  | 'cancel_pending'
  | 'force_try_in_progress'
  | 'force_try_superseded'
  | 'fatally_failed'
  | 'lock_error'
  | 'not_paused'
  | 'not_running'
  | 'retry_canceled'
  | 'unexpected_error';
