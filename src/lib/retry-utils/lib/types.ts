export type RetryPolicyOptions =
  | RetryPolicyOptionsStrategyFixed
  | RetryPolicyOptionsStrategyExponential;

export type RetryPolicyValidated = Required<RetryPolicyOptions>;

export interface RetryPolicyOptionsStrategyFixed {
  strategy: 'fixed';
  maxRetryAttempts?: number;
  delayMS?: number;
}

export interface RetryPolicyOptionsStrategyExponential {
  strategy: 'exponential';
  maxRetryAttempts?: number;
  factor?: number;
  minTimeoutMS?: number;
  maxTimeoutMS?: number;
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
  | 'fatally_failed'
  | 'lock_error'
  | 'not_paused'
  | 'not_running'
  | 'retry_canceled'
  | 'unexpected_error';
